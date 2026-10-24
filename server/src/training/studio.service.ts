import { growthEnabled } from "./growth-schema";
import { growthNotify } from "./growth-events";
import { currentWork } from "./work-context";
import { Injectable } from "@nestjs/common";
import type { Document } from "mongodb";
import { ApiRequest, fail } from "../errors";
import { currentlyValid } from "../teaching/contracts";
import { LearningService } from "../learning/learning.service";
import { KnowledgeSourceService } from "./knowledge-source.service";
import { TrainingService } from "./training.service";
import { discoveryCursor } from "./discovery";
import { studioEnabled } from "./studio-schema";
import { fenceCourseSource } from "./course-metadata";
import * as v from "./validation";
type Context = Parameters<TrainingService["courseAccess"]>[0];
type Row = Awaited<ReturnType<TrainingService["row"]>>;
const tables = { notes: "learning_source_notes", questions: "learning_questions", meetups: "learning_meetups" } as const;
type Kind = keyof typeof tables;
const absent = (): never => fail(404, "NOT_FOUND", "内容不可访问");
function day(raw: unknown): string | null {
  if (raw === null) return null;
  const value = v.text(raw, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(new Date(value).getTime()) || new Date(value).toISOString().slice(0, 10) !== value)
    fail(422, "INVALID_DATE", "复习日期无效");
  return value;
}
@Injectable()
export class LearningStudioService {
  constructor(readonly training: TrainingService, readonly sources: KnowledgeSourceService, readonly learning: LearningService) {}
  run<T>(req: ApiRequest, write: boolean, work: (ctx: Context) => Promise<T>) {
    if (!studioEnabled()) fail(503, "STUDIO_DISABLED", "学习拓展尚未启用");
    return this.training.run(req, write, work);
  }
  private kind(value: string): Kind {
    if (!(value in tables) || !Object.hasOwn(tables, value)) fail(404, "NOT_FOUND", "学习功能不存在");
    return value as Kind;
  }
  private staff(ctx: Context, capability: string) { this.training.require(ctx, capability); }
  private async scope(ctx: Context, row: Document, teacher: boolean, write = false) {
    if (teacher) this.staff(ctx, row.meetup_id || row.capacity ? "task:manage" : "coursework:grade");
    else this.training.require(ctx, "learning:self");
    await this.training.classAccess(ctx, row.class_id, row.subject_id, teacher, write);
    if (row.course_id) {
      const course = await this.training.courseAccess(ctx, row.course_id, teacher, write);
      if (write) await fenceCourseSource(this.training, ctx, course._id);
      if (course.subject_id !== row.subject_id) absent();
      if (!teacher && !await this.training.col("class_courses").findOne({ org_id: ctx.orgId, class_id: row.class_id, course_id: course._id, status: "active" }, { session: ctx.session })) absent();
    }
  }
  private mine(ctx: Context, row: Row) { if (row.user_id !== ctx.userId || row.member_id !== ctx.memberId) absent(); }
  private async record(ctx: Context, kind: "note" | "question" | "meetup", row: Row, action: string, subject: string | null = null) {
    await this.training.col("learning_studio_events").insertOne({ ...await this.training.base(ctx), user_id: ctx.userId, member_id: ctx.memberId,
      resource_kind: kind, resource_id: row._id, action, revision_after: row.revision, subject_member_id: subject }, { session: ctx.session });
    if (growthEnabled() && kind === "question" && ["create","reply","reopen"].includes(action)) {
      let recipients = [row.member_id];
      if (row.user_id === ctx.userId) {
        const now = await this.training.access.now(ctx);
        const assigned = await this.training.col("teaching_assignments").find({org_id:ctx.orgId,class_id:row.class_id,subject_id:row.subject_id,status:"active"},{session:ctx.session}).limit(201).toArray();
        if(assigned.length>200) fail(422,"ROSTER_LIMIT","授课安排超过200条");
        recipients = assigned.filter(a=>currentlyValid(a as any,now)).map(a=>a.member_id);
      }
      await growthNotify(this.training,ctx,"question",row._id,row.revision,recipients.filter(id=>id!==ctx.memberId));
    }
    if (growthEnabled() && kind === "meetup" && ["cancel","complete","enroll","attended","absent"].includes(action)) {
      const members = subject ? [subject] : (await this.training.col("learning_meetup_members").find({org_id:ctx.orgId,meetup_id:row._id,status:{$ne:"cancelled"}},{session:ctx.session}).limit(200).toArray()).map(m=>m.member_id);
      await growthNotify(this.training,ctx,"meetup",row._id,row.revision,members);
    }
    return row;
  }
  private async source(ctx: Context, row: Document, write = false) {
    this.training.require(ctx, "learning:self");
    if (row.source_kind === "mistake") {
      const mistake = await this.learning.mistakeInContext(ctx, row.source_id);
      return { kind: "mistake", id: mistake.id, title: mistake.question.title, revision: mistake.grading_revision };
    }
    if (row.source_kind === "chapter") {
      const source = await this.sources.read(ctx, { kind: "chapter", id: row.source_id }, write);
      return { kind: "chapter", id: row.source_id, edition_id: source.owner_id, title: source.title, revision: source.revision };
    }
    const course = await this.training.courseAccess(ctx, row.source_id, false, write);
    if (write) await fenceCourseSource(this.training, ctx, course._id);
    const lesson = course.lessons.find((l: Document) => l.key === row.lesson_key);
    if (!lesson) absent();
    return { kind: "course", id: course._id, lesson_key: lesson.key, title: lesson.title, revision: course.revision };
  }
  async catalog(req: ApiRequest) {
    return this.run(req, false, async ctx => {
      const learner = ctx.capabilities.includes("learning:self"), teacher = ctx.capabilities.some(c => ["task:manage", "coursework:grade"].includes(c));
      if (!learner && !teacher) fail(403, "FORBIDDEN", "没有学习协作权限");
      const now = await this.training.access.now(ctx), pairs: Document[] = [];
      // Join the current user's scope before the limit, avoiding a global first-200 window.
      const rows = await this.training.col("teaching_assignments").aggregate([
        { $match: { org_id: ctx.orgId, status: "active", $and: [
          { $or: [{ valid_from: null }, { valid_from: { $lte: now } }] },
          { $or: [{ valid_to: null }, { valid_to: { $gte: now } }] },
        ] } },
        { $lookup: { from: "class_members", localField: "class_id", foreignField: "class_id", pipeline: [{ $match: {
          org_id: ctx.orgId, member_id: ctx.memberId, status: "active", $and: [
            { $or: [{ valid_from: null }, { valid_from: { $lte: now } }] }, { $or: [{ valid_to: null }, { valid_to: { $gte: now } }] },
          ],
        } }], as: "_mine" } },
        { $match: { $or: [...(teacher ? [{ member_id: ctx.memberId }] : []), ...(learner ? [{ "_mine.0": { $exists: true } }] : [])] } },
        { $group: { _id: { class_id: "$class_id", subject_id: "$subject_id" } } }, { $sort: { "_id.class_id": 1, "_id.subject_id": 1 } }, { $limit: 201 },
      ], { session: ctx.session, maxTimeMS: 3000 }).toArray();
      for (const row of rows.slice(0, 200)) {
        const c = await this.training.col("classes").findOne({ _id: row._id.class_id, org_id: ctx.orgId, status: "active" }, { session: ctx.session });
        const subject = await this.training.col("subjects").findOne({ _id: row._id.subject_id }, { session: ctx.session });
        if (c && subject) pairs.push({ class_id: c._id, class_name: c.name, subject_id: subject._id, subject_name: subject.name });
      }
      return { pairs, learner, teacher, truncated: rows.length > 200 };
    });
  }
  async list(req: ApiRequest, value: string, raw: unknown) {
    const kind = this.kind(value), q = v.object(raw, ["cursor", "limit", "mode", "q"]);
    const teacher = q.mode === "staff", limit = q.limit === undefined ? 20 : v.integer(Number(v.text(q.limit, 2)), 1, 50);
    if (q.mode !== undefined && !["learner", "staff"].includes(q.mode)) fail(422, "INVALID_INPUT", "查看方式无效");
    const term = q.q === undefined ? "" : v.text(q.q, 100, true).trim();
    if (kind === "notes" && teacher) fail(422, "INVALID_INPUT", "笔记仅本人可见");
    return this.run(req, false, async ctx => {
      if (teacher) this.staff(ctx, kind === "questions" ? "coursework:grade" : "task:manage");
      else this.training.require(ctx, "learning:self");
      const page = discoveryCursor(this.training.access.assessment.auth.config.rateLimitKey, ["studio", kind, ctx.orgId, ctx.userId, ctx.memberId, teacher, limit, term], q.cursor);
      const match: Document = { org_id: ctx.orgId,
        ...(kind === "notes" ? { user_id: ctx.userId, member_id: ctx.memberId, deleted_at: null } :
          kind === "questions" && !teacher ? { user_id: ctx.userId, member_id: ctx.memberId } :
          kind === "meetups" && !teacher ? { status: { $ne: "draft" } } : {}),
        ...(page.after ? { _id: { $lt: page.after } } : {}),
        ...(term ? { title: { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } } : {}),
      };
      const candidates = await this.training.col(tables[kind]).find(match, { session: ctx.session, maxTimeMS: 3000 }).sort({ _id: -1 }).limit(201).toArray();
      const items: Document[] = []; let scanned = 0; const deadline = performance.now() + 5000;
      for (const row of candidates.slice(0, 200)) {
        if (scanned && performance.now() > deadline) break;
        ++scanned;
        try {
          if (kind === "notes") { const source = await this.source(ctx, row); items.push({ ...row, source, source_changed: source.revision !== row.source_revision }); }
          else {
            await this.scope(ctx, row, teacher);
            if (kind === "meetups") items.push(await this.meetupView(ctx, row, false));
            else { await this.questionInContext(ctx,row._id); items.push({ _id: row._id, title: row.title, status: row.status, revision: row.revision, updated_at: row.updated_at }); }
          }
        } catch (e) { if (![403, 404, 409].includes((e as any).getStatus?.() ?? (e as any).status)) throw e; }
        if (items.length === limit) break;
      }
      return { items, next_cursor: scanned < candidates.length ? page.next(candidates[scanned - 1]!._id) : null };
    });
  }
  async createNote(req: ApiRequest, raw: unknown) {
    const o = v.object(raw, ["title", "body", "source_kind", "source_id", "lesson_key", "due_on"]);
    const input = { title: v.text(o.title, 120), body: v.text(o.body, 4000, true), source_kind: v.text(o.source_kind, 10),
      source_id: v.id(o.source_id), lesson_key: o.lesson_key === undefined ? "" : v.text(o.lesson_key, 64, true), due_on: day(o.due_on) };
    if (!["course", "chapter", "mistake"].includes(input.source_kind) || (input.source_kind !== "course" && input.lesson_key)) fail(422, "INVALID_INPUT", "笔记来源无效");
    return this.run(req, true, async ctx => {
      const source = await this.source(ctx, input, true);
      return this.training.idem(ctx, req, "studio.note.create", input.source_id, input, async () => {
        const row = { ...await this.training.base(ctx), ...input, user_id: ctx.userId, member_id: ctx.memberId,
          source_revision: source.revision, review_count: 0, review_history: [], deleted_at: null };
        await this.training.col(tables.notes).insertOne(row, { session: ctx.session });
        return this.record(ctx, "note", row, "create");
      });
    });
  }
  async noteAction(req: ApiRequest, id: string, raw: unknown) {
    const o = v.object(raw, ["action", "expected_revision", "title", "body", "due_on", "note"]);
    if (!["edit", "review", "refresh-source", "delete"].includes(o.action)) fail(422, "INVALID_ACTION", "笔记操作无效");
    return this.run(req, true, async ctx => {
      this.training.require(ctx, "learning:self");
      const row = await this.training.row(ctx, tables.notes, id); this.mine(ctx, row);
      const source = o.action === "delete" ? null : await this.source(ctx, row, true);
      return this.training.idem(ctx, req, "studio.note." + o.action, id, o, async () => {
        if (row.deleted_at) fail(409, "INVALID_STATE", "笔记已删除");
        const now = await this.training.access.now(ctx);
        const set = o.action === "delete" ? { deleted_at: now, body: "", title: "已删除", review_history: [] } :
          o.action === "edit" ? { title: v.text(o.title, 120), body: v.text(o.body, 4000, true), due_on: day(o.due_on) } :
          o.action === "refresh-source" ? { source_revision: source!.revision } :
          { review_count: row.review_count + 1, review_history: [...row.review_history, { at: now, note: v.text(o.note, 1000, true) }].slice(-100), due_on: day(o.due_on) };
        return this.record(ctx, "note", await this.training.cas(ctx, tables.notes, row, o.expected_revision, set), o.action);
      });
    });
  }
  async createQuestion(req: ApiRequest, raw: unknown) {
    const o = v.object(raw, ["class_id", "subject_id", "course_id", "title", "body", "submission_id"]);
    const input = { class_id: v.id(o.class_id), subject_id: v.id(o.subject_id), course_id: o.course_id == null ? null : v.id(o.course_id),
      title: v.text(o.title), body: v.text(o.body, 4000) };
    const submissionId = o.submission_id == null ? null : v.id(o.submission_id);
    if(submissionId && !growthEnabled()) fail(503,"GROWTH_DISABLED","作品关联答疑尚未启用");
    return this.run(req, true, async ctx => {
      await this.scope(ctx, input, false, true);
      const work = submissionId ? await currentWork(this.training,ctx,submissionId,false,true) : null;
      if(work && (work.task.class_id!==input.class_id || work.task.subject_id!==input.subject_id)) absent();
      const assignments = await this.training.col("teaching_assignments").find({ org_id: ctx.orgId, class_id: input.class_id, subject_id: input.subject_id, status: "active" }, { session: ctx.session }).toArray();
      const now = await this.training.access.now(ctx);
      if (!assignments.some(a => currentlyValid(a as any, now))) fail(422, "TEACHER_UNAVAILABLE", "该班级学科暂无授课安排");
      return this.training.idem(ctx, req, "studio.question.create", input.class_id, submissionId ? {...input,submission_id:submissionId} : input, async () => {
        const row = { ...await this.training.base(ctx), ...input, user_id: ctx.userId, member_id: ctx.memberId,
          status: "open", message_count: 0, answered_by: null };
        await this.training.col(tables.questions).insertOne(row, { session: ctx.session });
        if(work) await this.training.col("learning_work_questions").insertOne({...await this.training.base(ctx),user_id:ctx.userId,member_id:ctx.memberId,question_id:row._id,task_id:work.task._id,submission_id:work.sub._id},{session:ctx.session});
        return this.record(ctx, "question", row, "create");
      });
    });
  }
  private async question(ctx: Context, id: string, write = false) {
    const row = await this.training.row(ctx, tables.questions, id), mine = row.user_id === ctx.userId && row.member_id === ctx.memberId;
    if (!mine && !ctx.capabilities.includes("coursework:grade")) absent();
    await this.scope(ctx, row, !mine, write);
    if (!mine) await this.training.learnerCurrent(ctx, row.user_id, row.member_id, row.class_id, write);
    const link = await this.training.col("learning_work_questions").findOne({org_id:ctx.orgId,question_id:row._id},{session:ctx.session});
    if(link) {
      if(!growthEnabled()) absent();
      const work = await currentWork(this.training,ctx,link.submission_id,!mine,write);
      if(work.sub.user_id!==row.user_id || work.sub.member_id!==row.member_id || work.task._id!==link.task_id || work.task.class_id!==row.class_id || work.task.subject_id!==row.subject_id) absent();
    }
    return { row, mine, link };
  }
  async questionInContext(ctx: Context, id: string) { return (await this.question(ctx,id)).row; }
  async questionDetail(req: ApiRequest, id: string) {
    return this.run(req, false, async ctx => {
      const { row, link } = await this.question(ctx, id);
      return { ...row, ...(link ? {work_context:{task_id:link.task_id,submission_id:link.submission_id}} : {}), messages: await this.training.col("learning_question_messages").find({ org_id: ctx.orgId, question_id: id }, { session: ctx.session }).sort({ _id: 1 }).limit(100).toArray() };
    });
  }
  async questionAction(req: ApiRequest, id: string, raw: unknown) {
    const o = v.object(raw, ["action", "expected_revision", "body"]);
    if (!["reply", "close", "reopen"].includes(o.action)) fail(422, "INVALID_ACTION", "答疑操作无效");
    return this.run(req, true, async ctx => {
      const { row, mine } = await this.question(ctx, id, true);
      return this.training.idem(ctx, req, "studio.question." + o.action, id, o, async () => {
        if (o.action === "reply" && row.status === "closed" || o.action === "close" && row.status === "closed" || o.action === "reopen" && row.status !== "closed")
          fail(409, "INVALID_STATE", "答疑状态已变化");
        const set: Document = o.action === "reply" ? { status: mine ? "open" : "answered", message_count: row.message_count + 1,
          answered_by: mine ? row.answered_by : ctx.userId } : { status: o.action === "close" ? "closed" : "open" };
        if (o.action === "reply") {
          if (row.message_count >= 100) fail(409, "THREAD_LIMIT", "本次答疑已达到100条回复，请新建问题");
          await this.training.col("learning_question_messages").insertOne({ ...await this.training.base(ctx), question_id: id,
            user_id: ctx.userId, member_id: ctx.memberId, role: mine ? "learner" : "teacher", body: v.text(o.body, 4000) }, { session: ctx.session });
        }
        return this.record(ctx, "question", await this.training.cas(ctx, tables.questions, row, o.expected_revision, set), o.action, row.member_id);
      });
    });
  }
  async createMeetup(req: ApiRequest, raw: unknown) {
    const o = v.object(raw, ["class_id", "subject_id", "title", "body", "location", "starts_at", "ends_at", "enrollment_closes_at", "capacity"]);
    const input = { class_id: v.id(o.class_id), subject_id: v.id(o.subject_id), title: v.text(o.title), body: v.text(o.body, 4000),
      location: v.text(o.location), starts_at: v.date(o.starts_at), ends_at: v.date(o.ends_at), enrollment_closes_at: v.date(o.enrollment_closes_at), capacity: v.integer(o.capacity, 1, 200) };
    return this.run(req, true, async ctx => {
      this.staff(ctx, "task:manage"); await this.training.classAccess(ctx, input.class_id, input.subject_id, true, true);
      if (input.starts_at <= await this.training.access.now(ctx) || input.ends_at <= input.starts_at || input.enrollment_closes_at > input.starts_at || input.enrollment_closes_at <= await this.training.access.now(ctx))
        fail(422, "INVALID_DATE", "报名截止须在未来且不晚于开始时间，结束须晚于开始");
      return this.training.idem(ctx, req, "studio.meetup.create", input.class_id, o, async () => {
        const row = { ...await this.training.base(ctx), ...input, created_by: ctx.userId, status: "draft" };
        await this.training.col(tables.meetups).insertOne(row, { session: ctx.session }); return this.record(ctx, "meetup", row, "create");
      });
    });
  }
  private async meetupView(ctx: Context, row: Row, roster: boolean) {
    const query = { org_id: ctx.orgId, meetup_id: row._id, status: { $ne: "cancelled" } };
    const count = await this.training.col("learning_meetup_members").countDocuments(query, { session: ctx.session });
    const enrollment = await this.training.col("learning_meetup_members").findOne({ org_id: ctx.orgId, meetup_id: row._id, user_id: ctx.userId, member_id: ctx.memberId }, { session: ctx.session });
    const members: Document[] = [];
    if (roster) for (const member of await this.training.col("learning_meetup_members").find(query, { session: ctx.session }).sort({ _id: 1 }).limit(200).toArray()) {
      try {
        await this.training.learnerCurrent(ctx, member.user_id, member.member_id, row.class_id);
        const user = await this.training.col("users").findOne({ _id: member.user_id }, { session: ctx.session, projection: { display_name: 1 } });
        members.push({ ...member, name: user?.display_name || "学习者" });
      } catch (e) { if (![403, 404].includes((e as any).getStatus?.() ?? (e as any).status)) throw e; }
    }
    return { ...row, enrolled_count: count, enrollment, ...(roster ? { members } : {}) };
  }
  async meetupDetail(req: ApiRequest, id: string, raw: unknown) {
    const q = v.object(raw, ["mode"]), teacher = q.mode === "staff";
    if (q.mode !== undefined && !["learner", "staff"].includes(q.mode)) fail(422, "INVALID_INPUT", "查看方式无效");
    return this.run(req, false, async ctx => {
      const row = await this.training.row(ctx, tables.meetups, id); await this.scope(ctx, row, teacher);
      if (!teacher && row.status === "draft") absent();
      return this.meetupView(ctx, row, teacher);
    });
  }
  async meetupAction(req: ApiRequest, id: string, raw: unknown) {
    const o = v.object(raw, ["action", "expected_revision", "enrollment_id", "enrollment_revision", "reflection"]);
    if (!["publish", "cancel", "complete", "enroll", "withdraw", "attended", "absent", "reflect"].includes(o.action)) fail(422, "INVALID_ACTION", "活动操作无效");
    const teacher = ["publish", "cancel", "complete", "attended", "absent"].includes(o.action);
    return this.run(req, true, async ctx => {
      const row = await this.training.row(ctx, tables.meetups, id); await this.scope(ctx, row, teacher, true);
      return this.training.idem(ctx, req, "studio.meetup." + o.action, id, o, async () => {
        const now = await this.training.access.now(ctx), c = this.training.col("learning_meetup_members");
        if (teacher && ["publish", "cancel", "complete"].includes(o.action)) {
          if (o.action === "publish" && (row.status !== "draft" || row.enrollment_closes_at <= now) ||
            o.action === "cancel" && !["draft", "published"].includes(row.status) ||
            o.action === "complete" && (row.status !== "published" || row.ends_at > now)) fail(409, "INVALID_STATE", "活动状态或时间不允许此操作");
          return this.record(ctx, "meetup", await this.training.cas(ctx, tables.meetups, row, o.expected_revision, { status: { publish: "published", cancel: "cancelled", complete: "completed" }[o.action as "publish"] }), o.action);
        }
        if (row.status !== "published" && !(row.status === "completed" && ["attended", "absent", "reflect"].includes(o.action))) fail(409, "INVALID_STATE", "活动当前不能操作");
        let member = teacher ? await this.training.row(ctx, "learning_meetup_members", v.id(o.enrollment_id)) : await c.findOne({ org_id: ctx.orgId, meetup_id: id, member_id: ctx.memberId, user_id: ctx.userId }, { session: ctx.session });
        if (member && member.meetup_id !== id) absent();
        if (["enroll", "withdraw"].includes(o.action)) {
          if (row.enrollment_closes_at <= now) fail(409, "ENROLLMENT_CLOSED", "报名与取消时间已截止");
          if (o.action === "enroll") {
            if (member && member.status !== "cancelled") fail(409, "ALREADY_ENROLLED", "已经报名");
            const count = await c.countDocuments({ org_id: ctx.orgId, meetup_id: id, status: { $ne: "cancelled" } }, { session: ctx.session });
            if (count >= row.capacity) fail(409, "MEETUP_FULL", "活动名额已满");
            if (member) member = await this.training.cas(ctx, "learning_meetup_members", member, o.enrollment_revision, { status: "enrolled", reflection: "", recorded_by: null, recorded_at: null });
            else { member = { ...await this.training.base(ctx), meetup_id: id, user_id: ctx.userId, member_id: ctx.memberId, status: "enrolled", reflection: "", recorded_by: null, recorded_at: null }; await c.insertOne(member, { session: ctx.session }); }
          } else {
            if (!member || member.status !== "enrolled") fail(409, "INVALID_STATE", "没有可取消的报名");
            await this.training.cas(ctx, "learning_meetup_members", member, o.enrollment_revision, { status: "cancelled" });
          }
        } else {
          if (!member || member.status === "cancelled") absent();
          const participant = member!;
          if (teacher) {
            if (row.starts_at > now) fail(409, "MEETUP_NOT_STARTED", "活动开始后才能记录参与");
            await this.training.learnerCurrent(ctx, participant.user_id, participant.member_id, row.class_id, true);
          } else if (participant.status !== "attended") fail(409, "ATTENDANCE_REQUIRED", "参加确认后才能提交实践回顾");
          await this.training.cas(ctx, "learning_meetup_members", participant, o.enrollment_revision, teacher ? { status: o.action, recorded_by: ctx.userId, recorded_at: now } : { reflection: v.text(o.reflection, 2000) });
        }
        // Every enrollment or attendance mutation fences the parent; concurrent requests cannot oversell capacity.
        return this.record(ctx, "meetup", await this.training.cas(ctx, tables.meetups, row, o.expected_revision, {}), o.action, member?.member_id ?? ctx.memberId);
      });
    });
  }
  async receipt(req: ApiRequest, raw: unknown) {
    const o = v.object(raw, ["key"]), key = v.text(o.key, 128);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) fail(422, "INVALID_KEY", "请求编号无效");
    return this.run(req, false, async ctx => {
      const records = await this.training.col("training_idempotency").find({ org_id: ctx.orgId, user_id: ctx.userId, key }, { session: ctx.session }).limit(2).toArray();
      if (records.length > 1) fail(409, "AMBIGUOUS_RECEIPT", "请求编号不唯一");
      const receipt = records[0]; if (!receipt) return { status: "not_found" };
      if (!receipt.operation.startsWith("studio.")) absent();
      const result = JSON.parse(receipt.result_json), id = v.id(result._id);
      if (receipt.operation.startsWith("studio.note.")) {
        const row = await this.training.row(ctx, tables.notes, id); this.mine(ctx, row);
        this.training.require(ctx, "learning:self"); if (!row.deleted_at) await this.source(ctx, row);
      } else if (receipt.operation.startsWith("studio.question.")) await this.question(ctx, id);
      else {
        const row = await this.training.row(ctx, tables.meetups, id);
        await this.scope(ctx, row, ["create", "publish", "cancel", "complete", "attended", "absent"].includes(receipt.operation.split(".")[2]!));
      }
      // Confirm only acceptance; current detail must be re-read through its own authorization.
      return { status: "confirmed", resource_id: id };
    });
  }
}
