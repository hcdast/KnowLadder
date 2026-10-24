import { Injectable } from "@nestjs/common";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ClientSession, Document } from "mongodb";
import { Database } from "../database/database";
import { newId } from "../database/object-id";
import { collections } from "../database/contracts";
import { AuthService, type Identity } from "../auth.service";
import { type ApiRequest, fail } from "../errors";
import { canonical, id, ids, integer, object, text } from "../content/dto";
import {
  ACTIVITY_KINDS,
  FIELDS,
  STAGES,
  SUPPORT_SCOPES,
  lifelongEnabled,
} from "./schema";
import { LIFELONG_TEMPLATES } from "./templates";
import {
  LEARNING_COURSES,
  courseMarker,
  courseSummary,
  unitOperation,
  type LearningCourse,
} from "./courses";

type Context = {
  req: ApiRequest;
  session: ClientSession;
  identity: Identity;
  user: string;
  now: Date;
};
type PersonalRow = Document & { _id: string };
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function choice(
  value: unknown,
  values: readonly string[],
  name: string,
): string {
  if (typeof value !== "string" || !values.includes(value))
    fail(422, "VALIDATION_ERROR", `${name}无效`);
  return value;
}
function day(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  const result = text(value, "日期", 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(result) ||
    !Number.isFinite(Date.parse(result)) ||
    new Date(result).toISOString().slice(0, 10) !== result
  )
    fail(422, "VALIDATION_ERROR", "日期无效");
  return result;
}
function instant(value: unknown): Date {
  const result = text(value, "有效期", 30);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(result) ||
    !Number.isFinite(Date.parse(result))
  )
    fail(422, "VALIDATION_ERROR", "有效期无效");
  return new Date(result);
}
function missing(): never {
  return fail(404, "NOT_FOUND", "记录不存在或已不可访问");
}
function conflict(): never {
  return fail(409, "REVISION_CONFLICT", "记录已变化，请重新读取后修改");
}
const goalView = (r: Document) => ({
  id: r._id,
  title: r.title,
  stage: r.stage,
  field: r.field,
  outcome: r.outcome,
  due_on: r.due_on,
  state: r.state,
  template_id: r.template_id,
  revision: r.revision,
  created_at: r.created_at,
  updated_at: r.updated_at,
});
const activityView = (r: Document) => ({
  id: r._id,
  goal_id: r.goal_id,
  title: r.title,
  kind: r.kind,
  note: r.note,
  reflection: r.reflection,
  occurred_on: r.occurred_on,
  minutes: r.minutes,
  evidence: "self_reported" as const,
  revision: r.revision,
  created_at: r.created_at,
  updated_at: r.updated_at,
});
const feedbackView = (r: Document) => ({
  id: r._id,
  relation_id: r.relation_id,
  activity_id: r.activity_id,
  note: r.note,
  evidence: "supporter_feedback" as const,
  revision: r.revision,
  created_at: r.created_at,
});
@Injectable()
export class LifelongService {
  constructor(
    readonly database: Database,
    readonly auth: AuthService,
  ) {}
  private c(name: string) {
    return this.database.db.collection<PersonalRow>(`lifelong_${name}`);
  }
  private async run<T>(
    req: ApiRequest,
    write: boolean,
    work: (ctx: Context) => Promise<T>,
  ): Promise<T> {
    if (!lifelongEnabled())
      fail(503, "LIFELONG_CLOSED", "个人学习空间尚未在当前环境开放");
    if (write) this.auth.origin(req);
    return this.database.transaction(async (session) => {
      if (!session.inTransaction())
        fail(503, "LIFELONG_TRANSACTION_REQUIRED", "个人空间需要事务数据库");
      const identity = await this.auth.identify(req, false, session);
      if (identity.user.must_change_password)
        fail(403, "PASSWORD_CHANGE_REQUIRED", "请先修改临时密码");
      if (write) this.auth.csrf(req, identity.session);
      await this.auth.fenceUser(identity.user, session);
      identity.user.identity_revision += 1;
      const row = await this.database.db
        .aggregate([{ $documents: [{}] }, { $project: { now: "$$NOW" } }], {
          session,
        })
        .next();
      return work({
        req,
        session,
        identity,
        user: identity.user._id,
        now: row!.now as Date,
      });
    });
  }
  async capabilities(req: ApiRequest) {
    const identity = await this.auth.identify(req, false);
    if (identity.user.must_change_password)
      fail(403, "PASSWORD_CHANGE_REQUIRED", "请先修改临时密码");
    const admission = await this.database.db
      .collection("auth_admissions")
      .findOne({ user_id: identity.user._id, age_band: "adult" });
    return {
      enabled: lifelongEnabled(),
      adult_admitted: !!admission,
      support_basis: "explicit_selected_records",
      guardian_basis: "independent_institutional_review",
      templates: lifelongEnabled() ? LIFELONG_TEMPLATES : [],
    };
  }
  private course(courseId: string) {
    const course = LEARNING_COURSES.find((c) => c.id === courseId);
    if (!course) missing();
    return course;
  }
  private async courseLearning(ctx: Context, course: LearningCourse) {
    const goal = await this.c("goals").findOne(
      {
        user_id: ctx.user,
        deleted_at: null,
        template_id: courseMarker(course),
      },
      { session: ctx.session },
    );
    if (!goal) return null;
    // Completion receipts are durable domain events, never TTL-cleaned. They contain no response text.
    const operations = await this.c("receipts").distinct(
      "operation",
      {
        user_id: ctx.user,
        resource_id: goal._id,
        operation: { $in: course.units.map((u) => unitOperation(course, u)) },
      },
      { session: ctx.session },
    );
    const completed = course.units
      .filter((u) => operations.includes(unitOperation(course, u)))
      .map((u) => u.id);
    return {
      goal_id: goal._id,
      revision: goal.revision,
      completed_unit_ids: completed,
      next_unit_id:
        course.units.find((u) => !completed.includes(u.id))?.id ?? null,
      state: completed.length === course.units.length ? "completed" : "active",
    };
  }
  async courses(req: ApiRequest, raw: unknown) {
    const q = object(raw, ["stage", "field", "q"]);
    const stage =
      q.stage === undefined ? null : choice(q.stage, STAGES, "学习方向");
    const field =
      q.field === undefined ? null : choice(q.field, FIELDS, "学习领域");
    const search =
      q.q === undefined
        ? ""
        : text(q.q, "关键词", 120, true).trim().toLocaleLowerCase();
    return this.run(req, false, async (ctx) => {
      const items = [];
      for (const c of LEARNING_COURSES.filter(
        (c) =>
          (!stage || c.stage === stage) &&
          (!field || c.field === field) &&
          (!search ||
            `${c.title} ${c.summary} ${c.outcome}`
              .toLocaleLowerCase()
              .includes(search)),
      ))
        items.push({
          ...courseSummary(c),
          learning: await this.courseLearning(ctx, c),
        });
      return { items };
    });
  }
  async courseDetail(req: ApiRequest, courseId: string) {
    return this.run(req, false, async (ctx) => {
      const course = this.course(courseId);
      return {
        ...courseSummary(course),
        units: course.units.map(({ answer, ...u }) => u),
        learning: await this.courseLearning(ctx, course),
      };
    });
  }
  private studyView(row: PersonalRow) {
    const course = LEARNING_COURSES.find(
      (c) => c.id === row.course_id && c.version === row.course_version,
    );
    const unit = course?.units.find((u) => u.id === row.unit_id);
    return {
      id: row._id,
      title: row.title,
      note: row.note,
      bookmarked: row.bookmarked,
      course_id: row.course_id,
      course_version: row.course_version,
      unit_id: row.unit_id,
      source_available: row.course_id === null || !!unit,
      source_title: unit && course ? `${course.title} · ${unit.title}` : null,
      due_on: row.due_on,
      reviewed_on: row.reviewed_on,
      review_count: row.review_count,
      review_note: row.review_note,
      suggested_interval_days: [1, 3, 7, 14, 30][Math.min(row.review_count, 4)]!,
      revision: row.revision,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
  async studyItems(req: ApiRequest, raw: unknown) {
    const q = object(raw, ["cursor", "limit", "filter", "as_of", "q"]);
    const filter =
      q.filter === undefined
        ? "all"
        : choice(q.filter, ["all", "bookmarked", "due"], "筛选");
    const search =
      q.q === undefined ? "" : text(q.q, "关键词", 120, true).trim();
    const asOf = q.as_of === undefined ? null : day(q.as_of);
    if (filter === "due" && !asOf)
      fail(422, "VALIDATION_ERROR", "请选择复习日期");
    return this.run(req, false, async (ctx) => {
      const where: Document = { user_id: ctx.user, deleted_at: null };
      if (filter === "bookmarked") where.bookmarked = true;
      if (filter === "due") where.due_on = { $type: "string", $lte: asOf };
      if (search) {
        const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        where.$or = ["title", "note", "review_note"].map((k) => ({
          [k]: { $regex: escaped, $options: "i" },
        }));
      }
      const page = this.paging(
        ctx,
        {
          ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
          ...(q.limit === undefined ? {} : { limit: q.limit }),
        },
        "study-items",
        where,
      );
      const rows = await this.c("study_items")
        .find(page.query, { session: ctx.session })
        .sort({ _id: -1 })
        .limit(page.limit + 1)
        .toArray();
      const items = rows.slice(0, page.limit);
      return {
        items: items.map((row) => this.studyView(row)),
        next_cursor:
          rows.length > page.limit ? page.next(items.at(-1)!._id) : null,
      };
    });
  }
  async saveStudyItem(req: ApiRequest, raw: unknown, recordId?: string) {
    const b = object(raw, [
      "title",
      "note",
      "bookmarked",
      "course_id",
      "course_version",
      "unit_id",
      "due_on",
      ...(recordId ? ["revision"] : []),
    ]);
    if (typeof b.bookmarked !== "boolean")
      fail(422, "VALIDATION_ERROR", "收藏状态无效");
    const fields = {
      title: text(b.title, "标题", 120).trim(),
      note: text(b.note, "笔记", 4000, true),
      bookmarked: b.bookmarked,
      course_id: b.course_id === null ? null : text(b.course_id, "课程", 80),
      course_version:
        b.course_version === null
          ? null
          : integer(b.course_version, "课程版本"),
      unit_id: b.unit_id === null ? null : text(b.unit_id, "单元", 80),
      due_on: day(b.due_on, true),
    };
    if (
      [fields.course_id, fields.course_version, fields.unit_id].some(
        (v) => v === null,
      ) &&
      [fields.course_id, fields.course_version, fields.unit_id].some(
        (v) => v !== null,
      )
    )
      fail(422, "VALIDATION_ERROR", "课程、版本和单元必须一同指定");
    if (recordId) integer(b.revision, "revision");
    return this.run(req, true, (ctx) =>
      this.operation(
        ctx,
        recordId ? "study.update" : "study.create",
        { id: recordId ?? null, ...b },
        async () => {
          const previous = recordId
            ? await this.owned(ctx, "study_items", recordId)
            : null;
          if (previous && previous.revision !== b.revision) conflict();
          // A withdrawn reference may be retained while editing personal text, never rebound to an unavailable source.
          const sameSource =
            previous &&
            ["course_id", "course_version", "unit_id"].every(
              (k) => previous[k] === fields[k as keyof typeof fields],
            );
          if (fields.course_id !== null && !sameSource) {
            const source = LEARNING_COURSES.find(
              (c) =>
                c.id === fields.course_id &&
                c.version === fields.course_version,
            );
            if (!source?.units.some((u) => u.id === fields.unit_id))
              fail(409, "STUDY_SOURCE_UNAVAILABLE", "原课程版本或单元已不可用");
          }
          const row: PersonalRow = {
            _id: previous?._id ?? newId(),
            user_id: ctx.user,
            ...fields,
            reviewed_on: previous?.reviewed_on ?? null,
            review_count: previous?.review_count ?? 0,
            review_note: previous?.review_note ?? "",
            revision: (previous?.revision ?? 0) + 1,
            deleted_at: null,
            created_at: previous?.created_at ?? ctx.now,
            updated_at: ctx.now,
          };
          if (previous)
            await this.c("study_items").replaceOne(
              { _id: previous._id, revision: previous.revision },
              row,
              { session: ctx.session },
            );
          else
            await this.c("study_items").insertOne(row, {
              session: ctx.session,
            });
          return { id: row._id, revision: row.revision };
        },
      ),
    );
  }
  async reviewStudyItem(req: ApiRequest, recordId: string, raw: unknown) {
    const b = object(raw, [
      "revision",
      "reviewed_on",
      "next_due_on",
      "note",
      "answer",
    ]);
    integer(b.revision, "revision");
    if (b.answer !== null) integer(b.answer, "复习选项", 0, 2);
    const reviewedOn = day(b.reviewed_on)!,
      nextDue = day(b.next_due_on, true),
      note = text(b.note, "复习回顾", 4000);
    if (nextDue && nextDue <= reviewedOn)
      fail(422, "VALIDATION_ERROR", "下次复习日期应晚于本次日期");
    return this.run(req, true, (ctx) =>
      this.operation(ctx, "study.review", { id: recordId, ...b }, async () => {
        const row = await this.owned(ctx, "study_items", recordId);
        if (row.revision !== b.revision) conflict();
        if (!row.due_on || row.due_on > reviewedOn)
          fail(409, "STUDY_NOT_DUE", "该项尚未到复习日期");
        if (row.reviewed_on && reviewedOn < row.reviewed_on)
          fail(422, "VALIDATION_ERROR", "复习日期不能早于上次记录");
        if (!this.studyView(row).source_available)
          fail(
            409,
            "STUDY_SOURCE_UNAVAILABLE",
            "原课程版本已不可用，请先处理来源",
          );
        const source = LEARNING_COURSES.find(
          (c) => c.id === row.course_id && c.version === row.course_version,
        )?.units.find((u) => u.id === row.unit_id);
        if (source && b.answer !== source.answer)
          fail(
            422,
            "STUDY_PRACTICE_RETRY",
            `请再想一想：${source.explanation}`,
          );
        if (!source && b.answer !== null)
          fail(422, "VALIDATION_ERROR", "独立笔记不需要课程作答");
        await this.c("review_events").insertOne({
          _id: newId(), user_id: ctx.user, study_item_id: row._id,
          reviewed_on: reviewedOn, next_due_on: nextDue, note,
          ordinal: row.review_count + 1, created_at: ctx.now,
        }, { session: ctx.session });
        await this.c("study_items").updateOne(
          { _id: row._id, revision: row.revision },
          {
            $set: {
              reviewed_on: reviewedOn,
              due_on: nextDue,
              review_note: note,
              updated_at: ctx.now,
            },
            $inc: { revision: 1, review_count: 1 },
          },
          { session: ctx.session },
        );
        return { id: row._id, revision: row.revision + 1 };
      }),
    );
  }
  async removeStudyItem(req: ApiRequest, recordId: string, raw: unknown) {
    const b = object(raw, ["revision"]);
    integer(b.revision, "revision");
    return this.run(req, true, (ctx) =>
      this.operation(ctx, "study.remove", { id: recordId, ...b }, async () => {
        const row = await this.owned(ctx, "study_items", recordId);
        if (row.revision !== b.revision) conflict();
        await this.c("review_events").deleteMany(
          { user_id: ctx.user, study_item_id: row._id }, { session: ctx.session },
        );
        // Clear personal text and references in the current store, preserve only the deletion marker and receipt.
        await this.c("study_items").updateOne(
          { _id: row._id, revision: row.revision },
          {
            $set: {
              title: "已移除",
              note: "",
              review_note: "",
              bookmarked: false,
              course_id: null,
              course_version: null,
              unit_id: null,
              due_on: null,
              reviewed_on: null,
              review_count: 0,
              deleted_at: ctx.now,
              updated_at: ctx.now,
            },
            $inc: { revision: 1 },
          },
          { session: ctx.session },
        );
        return { id: row._id, revision: row.revision + 1 };
      }),
    );
  }
  async reviewHistory(req: ApiRequest, raw: unknown, studyId?: string) {
    return this.run(req, false, async (ctx) => {
      const where: Document = { user_id: ctx.user };
      if (studyId) {
        where.study_item_id = (await this.owned(ctx, "study_items", studyId))._id;
      }
      const page = this.paging(ctx, raw, "review-history", where);
      const rows = await this.c("review_events").find(page.query, { session: ctx.session })
        .sort({ _id: -1 }).limit(page.limit + 1).toArray();
      return {
        items: rows.slice(0, page.limit).map(({ _id, user_id, ...row }) => ({ id: _id, ...row })),
        next_cursor: rows.length > page.limit ? page.next(rows[page.limit - 1]!._id) : null,
      };
    });
  }
  private weekRange(value: unknown) {
    const start = day(value)!;
    const date = new Date(start);
    if (date.getUTCDay() !== 1) fail(422, "VALIDATION_ERROR", "请选择周一作为一周的起点");
    date.setUTCDate(date.getUTCDate() + 6);
    const end = date.toISOString().slice(0, 10);
    if (end.length !== 10 || end < start) fail(422, "VALIDATION_ERROR", "周日期超出范围");
    return { start, end };
  }
  private async agendaSource(ctx: Context, row: Document) {
    if (row.source_kind === "none") return { source_available: true, source_title: null };
    if (row.source_kind === "course") {
      const course = LEARNING_COURSES.find(c => c.id === row.source_id && c.version === row.source_version);
      const unit = course?.units.find(u => u.id === row.unit_id);
      return { source_available: !!unit, source_title: unit && course ? `${course.title} · ${unit.title}` : null };
    }
    const source = await this.c(row.source_kind === "goal" ? "goals" : "study_items")
      .findOne({ _id: row.source_id, user_id: ctx.user, deleted_at: null }, { session: ctx.session });
    return { source_available: !!source && (row.source_kind !== "study" || this.studyView(source).source_available), source_title: source?.title ?? null };
  }
  private async agendaView(ctx: Context, row: PersonalRow) {
    const { _id, user_id, deleted_at, ...fields } = row;
    return { id: _id, ...fields, ...await this.agendaSource(ctx, row), evidence: "self_reported" };
  }
  async agenda(req: ApiRequest, raw: unknown) {
    const q = object(raw, ["week_start", "cursor", "limit"]);
    const range = q.week_start === undefined ? null : this.weekRange(q.week_start);
    return this.run(req, false, async ctx => {
      const where: Document = { user_id: ctx.user, deleted_at: null };
      if (range) where.scheduled_on = { $gte: range.start, $lte: range.end };
      const page = this.paging(ctx, {
        ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
        ...(q.limit === undefined ? {} : { limit: q.limit }),
      }, "agenda", where);
      const rows = await this.c("agenda").find(page.query, { session: ctx.session })
        .sort({ _id: -1 }).limit(page.limit + 1).toArray();
      const items = [];
      for (const row of rows.slice(0, page.limit)) items.push(await this.agendaView(ctx, row));
      return { items, next_cursor: rows.length > page.limit ? page.next(rows[page.limit - 1]!._id) : null };
    });
  }
  async saveAgenda(req: ApiRequest, raw: unknown, recordId?: string) {
    const b = object(raw, ["title", "note", "scheduled_on", "planned_minutes", "kind", "source_kind", "source_id", "source_version", "unit_id", ...(recordId ? ["revision"] : [])]);
    const fields = {
      title: text(b.title, "计划标题", 120), note: text(b.note, "安排说明", 4000, true),
      scheduled_on: day(b.scheduled_on)!, planned_minutes: integer(b.planned_minutes, "预计分钟", 0, 1440),
      kind: choice(b.kind, ["reading", "course", "review", "practice", "project"], "活动类型"),
      source_kind: choice(b.source_kind, ["none", "goal", "course", "study"], "关联来源"),
      source_id: b.source_id === null ? null : text(b.source_id, "来源", 80),
      source_version: b.source_version === null ? null : integer(b.source_version, "来源版本"),
      unit_id: b.unit_id === null ? null : text(b.unit_id, "单元", 80),
    };
    if (recordId) integer(b.revision, "revision");
    if (fields.source_kind === "none") {
      if (fields.source_id !== null || fields.source_version !== null || fields.unit_id !== null)
        fail(422, "VALIDATION_ERROR", "独立安排不应包含来源");
    } else if (fields.source_kind === "course") {
      if (!fields.source_id || !fields.source_version || !fields.unit_id)
        fail(422, "VALIDATION_ERROR", "课程来源需要版本和单元");
    } else {
      id(fields.source_id);
      if (fields.source_version !== null || fields.unit_id !== null) fail(422, "VALIDATION_ERROR", "此来源不需要课程版本");
    }
    return this.run(req, true, ctx => this.operation(ctx, recordId ? "agenda.update" : "agenda.create", { id: recordId ?? null, ...b }, async () => {
      const previous = recordId ? await this.owned(ctx, "agenda", recordId) : null;
      if (previous && previous.revision !== b.revision) conflict();
      if (previous?.state === "completed" || previous?.state === "cancelled") fail(409, "AGENDA_STATE", "已完成或取消的安排不能修改，请新建安排");
      const sameSource = previous && ["source_kind", "source_id", "source_version", "unit_id"].every(k => previous[k] === fields[k as keyof typeof fields]);
      if (!sameSource && !(await this.agendaSource(ctx, fields)).source_available)
        fail(404, "AGENDA_SOURCE_UNAVAILABLE", "关联来源不存在或已不可访问");
      const date = new Date(fields.scheduled_on);
      date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
      const range = this.weekRange(date.toISOString().slice(0, 10));
      const count = await this.c("agenda").countDocuments({ user_id: ctx.user, deleted_at: null,
        scheduled_on: { $gte: range.start, $lte: range.end }, ...(previous ? { _id: { $ne: previous._id } } : {}),
      }, { session: ctx.session, limit: 200 });
      if (count >= 200) fail(409, "AGENDA_WEEK_LIMIT", "本周安排已达200项，请先整理");
      const row: PersonalRow = { _id: previous?._id ?? newId(), user_id: ctx.user, ...fields,
        state: previous?.state ?? "planned", completion_note: "", completed_on: null,
        revision: (previous?.revision ?? 0) + 1, deleted_at: null,
        created_at: previous?.created_at ?? ctx.now, updated_at: ctx.now };
      if (previous) await this.c("agenda").replaceOne({ _id: previous._id, revision: previous.revision }, row, { session: ctx.session });
      else await this.c("agenda").insertOne(row, { session: ctx.session });
      return { id: row._id, revision: row.revision };
    }));
  }
  async agendaState(req: ApiRequest, recordId: string, raw: unknown) {
    const b = object(raw, ["revision", "state", "note", "completed_on"]);
    integer(b.revision, "revision");
    const state = choice(b.state, ["planned", "completed", "paused", "cancelled"], "安排状态");
    const note = text(b.note, "完成记录", 4000, state !== "completed"), completedOn = day(b.completed_on, true);
    if ((state === "completed") !== (completedOn !== null)) fail(422, "VALIDATION_ERROR", "仅完成安排时填写完成日期");
    return this.run(req, true, ctx => this.operation(ctx, "agenda.state", { id: recordId, ...b }, async () => {
      const row = await this.owned(ctx, "agenda", recordId);
      if (row.revision !== b.revision) conflict();
      if (["completed", "cancelled"].includes(row.state)) fail(409, "AGENDA_STATE", "该安排已结束");
      if (state === "completed" && !(await this.agendaSource(ctx, row)).source_available)
        fail(409, "AGENDA_SOURCE_UNAVAILABLE", "来源不可用，请先调整或解除关联");
      await this.c("agenda").updateOne({ _id: row._id, revision: row.revision }, {
        $set: { state, completion_note: state === "completed" ? note : "", completed_on: completedOn, updated_at: ctx.now },
        $inc: { revision: 1 },
      }, { session: ctx.session });
      return { id: row._id, revision: row.revision + 1 };
    }));
  }
  async removeAgenda(req: ApiRequest, recordId: string, raw: unknown) {
    const b = object(raw, ["revision"]); integer(b.revision, "revision");
    return this.run(req, true, ctx => this.operation(ctx, "agenda.remove", { id: recordId, ...b }, async () => {
      const row = await this.owned(ctx, "agenda", recordId);
      if (row.revision !== b.revision) conflict();
      await this.c("agenda").updateOne({ _id: row._id, revision: row.revision }, {
        $set: { title: "已移除", note: "", source_kind: "none", source_id: null, source_version: null, unit_id: null,
          completion_note: "", completed_on: null, deleted_at: ctx.now, updated_at: ctx.now }, $inc: { revision: 1 },
      }, { session: ctx.session });
      return { id: row._id, revision: row.revision + 1 };
    }));
  }
  async weekOverview(req: ApiRequest, raw: unknown) {
    const q = object(raw, ["week_start", "as_of"]), range = this.weekRange(q.week_start), asOf = day(q.as_of)!;
    return this.run(req, false, async ctx => {
      const rows = await this.c("agenda").find({ user_id: ctx.user, deleted_at: null,
        scheduled_on: { $gte: range.start, $lte: range.end } }, { session: ctx.session }).limit(201).toArray();
      const truncated = rows.length > 200, items = rows.slice(0, 200);
      const review = await this.c("week_reviews").findOne({ user_id: ctx.user, week_start: range.start, deleted_at: null }, { session: ctx.session });
      const { _id, user_id, deleted_at, ...fields } = (review ?? {}) as Document;
      return { week_start: range.start, week_end: range.end, as_of: asOf, truncated,
        total: items.length, completed: items.filter(r => r.state === "completed").length,
        paused: items.filter(r => r.state === "paused").length,
        cancelled: items.filter(r => r.state === "cancelled").length,
        overdue: items.filter(r => r.state === "planned" && r.scheduled_on < asOf).length,
        planned_minutes: items.filter(r => r.state !== "cancelled").reduce((sum, r) => sum + r.planned_minutes, 0),
        review: review ? { id: _id, ...fields } : null,
      };
    });
  }
  async weekReviews(req: ApiRequest, raw: unknown) {
    return this.run(req, false, async ctx => {
      const page = this.paging(ctx, raw, "week-reviews", { user_id: ctx.user, deleted_at: null });
      const rows = await this.c("week_reviews").find(page.query, { session: ctx.session }).sort({ _id: -1 }).limit(page.limit + 1).toArray();
      return { items: rows.slice(0, page.limit).map(({ _id, user_id, deleted_at, ...r }) => ({ id: _id, ...r })),
        next_cursor: rows.length > page.limit ? page.next(rows[page.limit - 1]!._id) : null };
    });
  }
  async saveWeekReview(req: ApiRequest, raw: unknown) {
    const b = object(raw, ["week_start", "revision", "highlights", "challenges", "adjustment"]), range = this.weekRange(b.week_start);
    integer(b.revision, "revision", 0);
    const fields = { highlights: text(b.highlights, "本周收获", 4000, true), challenges: text(b.challenges, "遇到的困难", 4000, true), adjustment: text(b.adjustment, "下周调整", 4000, true) };
    if (!Object.values(fields).some(v => v.trim())) fail(422, "VALIDATION_ERROR", "请填写至少一项周回顾");
    return this.run(req, true, ctx => this.operation(ctx, "week.review", b, async () => {
      const previous = await this.c("week_reviews").findOne({ user_id: ctx.user, week_start: range.start }, { session: ctx.session });
      if ((previous?.deleted_at ? 0 : previous?.revision ?? 0) !== b.revision) conflict();
      const row: PersonalRow = { _id: previous?._id ?? newId(), user_id: ctx.user, week_start: range.start, ...fields,
        revision: (previous?.revision ?? 0) + 1, created_at: previous?.created_at ?? ctx.now, updated_at: ctx.now, deleted_at: null };
      if (previous) await this.c("week_reviews").replaceOne({ _id: previous._id, revision: previous.revision }, row, { session: ctx.session });
      else await this.c("week_reviews").insertOne(row, { session: ctx.session });
      return { id: row._id, revision: row.revision };
    }));
  }
  async removeWeekReview(req: ApiRequest, recordId: string, raw: unknown) {
    const b = object(raw, ["revision"]); integer(b.revision, "revision");
    return this.run(req, true, ctx => this.operation(ctx, "week.review.remove", { id: recordId, ...b }, async () => {
      const row = await this.owned(ctx, "week_reviews", recordId);
      if (row.revision !== b.revision) conflict();
      await this.c("week_reviews").updateOne({ _id: row._id, revision: row.revision }, {
        $set: { highlights: "", challenges: "", adjustment: "", deleted_at: ctx.now, updated_at: ctx.now },
        $inc: { revision: 1 },
      }, { session: ctx.session });
      return { id: row._id, revision: row.revision + 1 };
    }));
  }
  async enrollCourse(req: ApiRequest, courseId: string, raw: unknown) {
    const b = object(raw, ["version"]);
    integer(b.version, "version");
    return this.run(req, true, (ctx) => {
      const course = this.course(courseId);
      if (b.version !== course.version)
        fail(409, "COURSE_VERSION_CHANGED", "课程版本已变化，请重新读取详情");
      return this.operation(
        ctx,
        `course.enroll:${course.id}:v${course.version}`,
        b,
        async () => {
          const existing = await this.courseLearning(ctx, course);
          if (existing)
            return { id: existing.goal_id, revision: existing.revision };
          const goal = {
            _id: newId(),
            user_id: ctx.user,
            revision: 1,
            deleted_at: null,
            created_at: ctx.now,
            updated_at: ctx.now,
            title: course.title,
            stage: course.stage,
            field: course.field,
            outcome: course.outcome,
            due_on: null,
            state: "active",
            template_id: courseMarker(course),
          };
          await this.c("goals").insertOne(goal, { session: ctx.session });
          return { id: goal._id, revision: 1 };
        },
      );
    });
  }
  async completeCourseUnit(
    req: ApiRequest,
    courseId: string,
    unitId: string,
    raw: unknown,
  ) {
    const b = object(raw, [
      "version",
      "goal_id",
      "revision",
      "answer",
      "practice",
      "reflection",
    ]);
    integer(b.version, "version");
    integer(b.revision, "revision");
    const goalId = id(b.goal_id),
      answer = integer(b.answer, "answer", 0, 2);
    const practice = text(b.practice, "实践记录", 2000).trim(),
      reflection = text(b.reflection, "学习回顾", 1000).trim();
    if (!practice || !reflection)
      fail(422, "VALIDATION_ERROR", "请填写实践记录和学习回顾");
    return this.run(req, true, (ctx) => {
      const course = this.course(courseId),
        unit = course.units.find((u) => u.id === unitId);
      if (!unit) missing();
      if (b.version !== course.version)
        fail(409, "COURSE_VERSION_CHANGED", "课程版本已变化，请重新读取详情");
      return this.operation(ctx, unitOperation(course, unit), b, async () => {
        const learning = await this.courseLearning(ctx, course);
        if (!learning || learning.goal_id !== goalId) missing();
        if (learning.completed_unit_ids.includes(unit.id))
          return { id: goalId, revision: learning.revision };
        if (learning.revision !== b.revision) conflict();
        if (learning.next_unit_id !== unit.id)
          fail(409, "COURSE_UNIT_ORDER", "请先完成前面的学习单元");
        if (answer !== unit.answer)
          fail(422, "COURSE_PRACTICE_RETRY", `再想一想：${unit.explanation}`);
        await this.c("activities").insertOne(
          {
            _id: newId(),
            user_id: ctx.user,
            goal_id: goalId,
            revision: 1,
            deleted_at: null,
            created_at: ctx.now,
            updated_at: ctx.now,
            kind: "course",
            title: `${course.title} · ${unit.title}`,
            note: `课程v${course.version} / ${unit.id}\n练习回答：${unit.options[answer]}\n实践记录：${practice}`,
            reflection,
            occurred_on: ctx.now.toISOString().slice(0, 10),
            minutes: 0,
            evidence: "self_reported",
          },
          { session: ctx.session },
        );
        const result = await this.c("goals").updateOne(
          {
            _id: goalId,
            user_id: ctx.user,
            revision: learning.revision,
            deleted_at: null,
          },
          {
            $set: {
              state:
                learning.completed_unit_ids.length + 1 === course.units.length
                  ? "completed"
                  : "active",
              updated_at: ctx.now,
            },
            $inc: { revision: 1 },
          },
          { session: ctx.session },
        );
        if (result.modifiedCount !== 1) conflict();
        return { id: goalId, revision: learning.revision + 1 };
      });
    });
  }
  private async adult(ctx: Context, user = ctx.user) {
    if (
      !(await this.database.db
        .collection("auth_admissions")
        .findOne(
          { user_id: user, age_band: "adult" },
          { session: ctx.session },
        ))
    )
      fail(
        403,
        "ADULT_ADMISSION_REQUIRED",
        "此操作需要已有成年账号准入记录；不能由学习阶段或组织角色推定",
      );
  }
  private async subject(ctx: Context, user: string) {
    if (user === ctx.user) return;
    const subject = await collections(this.database.db).users.findOne(
      {
        _id: user,
        status: "active",
        privacy_state: { $nin: ["erasing", "erased"] },
      },
      { session: ctx.session },
    );
    if (!subject) missing();
    await this.auth.fenceUser(subject, ctx.session);
  }
  private async operation(
    ctx: Context,
    operation: string,
    payload: unknown,
    perform: () => Promise<{ id: string; revision: number }>,
  ) {
    const key = text(
      ctx.req.headers["idempotency-key"],
      "Idempotency-Key",
      128,
    );
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key))
      fail(422, "IDEMPOTENCY_REQUIRED", "需要合法的请求编号");
    const keyHash = hash(key),
      requestHash = hash(canonical({ operation, payload }));
    const old = await this.c("receipts").findOne(
      { user_id: ctx.user, key_hash: keyHash },
      { session: ctx.session },
    );
    if (old) {
      if (old.operation === "cancelled")
        fail(
          409,
          "OPERATION_CANCELLED",
          "原请求已终止，请重新确认后发起新请求",
        );
      if (old.request_hash !== requestHash)
        fail(409, "IDEMPOTENCY_CONFLICT", "请求编号已用于不同内容");
      return {
        operation_id: old._id,
        resource_id: old.resource_id,
        revision: old.revision,
      };
    }
    const result = await perform(),
      operationId = newId();
    await this.c("receipts").insertOne(
      {
        _id: operationId,
        user_id: ctx.user,
        key_hash: keyHash,
        request_hash: requestHash,
        operation,
        resource_id: result.id,
        revision: result.revision,
        created_at: ctx.now,
      },
      { session: ctx.session },
    );
    return {
      operation_id: operationId,
      resource_id: result.id,
      revision: result.revision,
    };
  }
  async receipt(req: ApiRequest, key: string) {
    return this.run(req, false, async (ctx) => {
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(key))
        fail(422, "VALIDATION_ERROR", "请求编号无效");
      const row = await this.c("receipts").findOne(
        { user_id: ctx.user, key_hash: hash(key) },
        { session: ctx.session },
      );
      if (!row) missing();
      return {
        state: row.operation === "cancelled" ? "cancelled" : "applied",
        operation_id: row._id,
        resource_id: row.resource_id,
        revision: row.revision,
      };
    });
  }
  async cancel(req: ApiRequest, key: string, raw: unknown) {
    object(raw, []);
    return this.run(req, true, async (ctx) => {
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(key))
        fail(422, "VALIDATION_ERROR", "请求编号无效");
      const old = await this.c("receipts").findOne(
        { user_id: ctx.user, key_hash: hash(key) },
        { session: ctx.session },
      );
      if (old)
        return {
          state: old.operation === "cancelled" ? "cancelled" : "applied",
          operation_id: old._id,
          resource_id: old.resource_id,
          revision: old.revision,
        };
      const operationId = newId();
      await this.c("receipts").insertOne(
        {
          _id: operationId,
          user_id: ctx.user,
          key_hash: hash(key),
          request_hash: hash("cancelled"),
          operation: "cancelled",
          resource_id: ctx.user,
          revision: 1,
          created_at: ctx.now,
        },
        { session: ctx.session },
      );
      return {
        state: "cancelled",
        operation_id: operationId,
        resource_id: ctx.user,
        revision: 1,
      };
    });
  }
  private paging(
    ctx: Context,
    raw: unknown,
    resource: string,
    filter: Document = {},
  ) {
    const q = object(raw, ["cursor", "limit"]),
      limit =
        q.limit === undefined ? 20 : integer(Number(q.limit), "limit", 1, 50);
    const scope = hash(canonical({ user: ctx.user, resource, limit, filter }));
    const sign = (value: string) =>
      createHmac("sha256", this.auth.config.rateLimitKey)
        .update(value)
        .digest("base64url");
    let after: string | undefined;
    if (q.cursor !== undefined) {
      try {
        const cursor = text(q.cursor, "cursor", 1000),
          [value, signature, extra] = cursor.split(".");
        const expected = sign(value!);
        if (
          !signature ||
          extra ||
          signature.length !== expected.length ||
          !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
        )
          throw Error();
        const parsed = JSON.parse(Buffer.from(value!, "base64url").toString());
        if (parsed.scope !== scope) throw Error();
        after = id(parsed.after);
      } catch {
        fail(422, "CURSOR_INVALID", "分页游标无效");
      }
    }
    return {
      limit,
      query: { ...filter, ...(after ? { _id: { $lt: after } } : {}) },
      next: (last: string) => {
        const value = Buffer.from(
          JSON.stringify({ scope, after: last }),
        ).toString("base64url");
        return `${value}.${sign(value)}`;
      },
    };
  }
  async list(
    req: ApiRequest,
    kind: "goals" | "activities" | "feedback",
    raw: unknown,
  ) {
    return this.run(req, false, async (ctx) => {
      const page = this.paging(ctx, raw, kind, {
        user_id: ctx.user,
        deleted_at: null,
      });
      const rows = await this.c(kind)
        .find(page.query, { session: ctx.session })
        .sort({ _id: -1 })
        .limit(page.limit + 1)
        .toArray();
      const more = rows.length > page.limit,
        items = rows.slice(0, page.limit);
      const view =
        kind === "goals"
          ? goalView
          : kind === "activities"
            ? activityView
            : feedbackView;
      return {
        items: items.map((r) => view(r)),
        next_cursor: more ? page.next(items.at(-1)!._id) : null,
      };
    });
  }
  private async owned(ctx: Context, kind: string, recordId: unknown) {
    const row = await this.c(kind).findOne(
      { _id: id(recordId), user_id: ctx.user, deleted_at: null },
      { session: ctx.session },
    );
    if (!row) missing();
    return row;
  }
  async saveGoal(req: ApiRequest, raw: unknown, recordId?: string) {
    const b = object(raw, [
      "title",
      "stage",
      "field",
      "outcome",
      "due_on",
      "state",
      "template_id",
      ...(recordId ? ["revision"] : []),
    ]);
    const templateId =
      b.template_id === null ? null : text(b.template_id, "原创活动", 80);
    if (templateId && !LIFELONG_TEMPLATES.some((t) => t.id === templateId))
      fail(422, "VALIDATION_ERROR", "原创活动不存在");
    const fields = {
      title: text(b.title, "目标", 120).trim(),
      stage: b.stage === null ? null : choice(b.stage, STAGES, "学习方向"),
      field: choice(b.field, FIELDS, "学习领域"),
      outcome: text(b.outcome, "预期成果", 4000, true),
      due_on: day(b.due_on, true),
      state: choice(b.state, ["active", "completed", "paused"], "状态"),
      template_id: templateId,
    };
    if (recordId) integer(b.revision, "revision");
    return this.run(req, true, (ctx) =>
      this.operation(
        ctx,
        recordId ? "goal.update" : "goal.create",
        { id: recordId ?? null, ...b },
        async () => {
          const previous = recordId
            ? await this.owned(ctx, "goals", recordId)
            : null;
          if (previous?.template_id?.startsWith("course:"))
            fail(
              422,
              "COURSE_GOAL_MANAGED",
              "课程目标的完成状态由学习单元维护，请从课程继续学习",
            );
          if (previous && previous.revision !== b.revision) conflict();
          const record = {
            _id: previous?._id ?? newId(),
            user_id: ctx.user,
            ...fields,
            revision: (previous?.revision ?? 0) + 1,
            deleted_at: null,
            created_at: previous?.created_at ?? ctx.now,
            updated_at: ctx.now,
          };
          if (previous)
            await this.c("goals").replaceOne(
              { _id: previous._id, revision: previous.revision },
              record,
              { session: ctx.session },
            );
          else
            await this.c("goals").insertOne(record, { session: ctx.session });
          return { id: record._id, revision: record.revision };
        },
      ),
    );
  }
  async saveActivity(req: ApiRequest, raw: unknown, recordId?: string) {
    const b = object(raw, [
      "goal_id",
      "kind",
      "title",
      "note",
      "reflection",
      "occurred_on",
      "minutes",
      ...(recordId ? ["revision"] : []),
    ]);
    const fields = {
      goal_id: b.goal_id === null ? null : id(b.goal_id),
      kind: choice(b.kind, ACTIVITY_KINDS, "活动形式"),
      title: text(b.title, "活动", 120).trim(),
      note: text(b.note, "过程记录", 4000, true),
      reflection: text(b.reflection, "回顾", 4000, true),
      occurred_on: day(b.occurred_on),
      minutes: integer(b.minutes, "minutes", 0, 1440),
      evidence: "self_reported",
    };
    if (recordId) integer(b.revision, "revision");
    return this.run(req, true, (ctx) =>
      this.operation(
        ctx,
        recordId ? "activity.update" : "activity.create",
        { id: recordId ?? null, ...b },
        async () => {
          if (fields.goal_id) await this.owned(ctx, "goals", fields.goal_id);
          if (fields.occurred_on! > ctx.now.toISOString().slice(0, 10))
            fail(422, "VALIDATION_ERROR", "已完成活动不能记录为未来日期");
          const previous = recordId
            ? await this.owned(ctx, "activities", recordId)
            : null;
          if (previous && previous.revision !== b.revision) conflict();
          const record = {
            _id: previous?._id ?? newId(),
            user_id: ctx.user,
            ...fields,
            revision: (previous?.revision ?? 0) + 1,
            deleted_at: null,
            created_at: previous?.created_at ?? ctx.now,
            updated_at: ctx.now,
          };
          if (previous)
            await this.c("activities").replaceOne(
              { _id: previous._id, revision: previous.revision },
              record,
              { session: ctx.session },
            );
          else
            await this.c("activities").insertOne(record, {
              session: ctx.session,
            });
          return { id: record._id, revision: record.revision };
        },
      ),
    );
  }
  async remove(
    req: ApiRequest,
    kind: "goals" | "activities" | "feedback",
    recordId: string,
    raw: unknown,
  ) {
    const b = object(raw, ["revision"]);
    integer(b.revision, "revision");
    return this.run(req, true, (ctx) =>
      this.operation(
        ctx,
        `${kind}.delete`,
        { id: id(recordId), ...b },
        async () => {
          const row = await this.owned(ctx, kind, recordId);
          if (row.revision !== b.revision) conflict();
          await this.c(kind).updateOne(
            { _id: row._id, revision: row.revision },
            {
              $set: { deleted_at: ctx.now, updated_at: ctx.now },
              $inc: { revision: 1 },
            },
            { session: ctx.session },
          );
          if (kind === "goals")
            await this.c("activities").updateMany(
              { user_id: ctx.user, goal_id: row._id, deleted_at: null },
              {
                $set: { goal_id: null, updated_at: ctx.now },
                $inc: { revision: 1 },
              },
              { session: ctx.session },
            );
          if (kind === "activities")
            await this.c("feedback").updateMany(
              { user_id: ctx.user, activity_id: row._id, deleted_at: null },
              {
                $set: { deleted_at: ctx.now, updated_at: ctx.now },
                $inc: { revision: 1 },
              },
              { session: ctx.session },
            );
          return { id: row._id, revision: row.revision + 1 };
        },
      ),
    );
  }
  private supportView(ctx: Context, row: Document) {
    return {
      id: row._id,
      label: row.label,
      perspective: row.user_id === ctx.user ? "owner" : "supporter",
      scopes: row.scopes,
      goal_ids: row.goal_ids,
      activity_ids: row.activity_ids,
      basis: row.basis,
      state:
        row.expires_at <= ctx.now ||
        (row.state === "pending" && row.invite_expires_at <= ctx.now)
          ? "expired"
          : row.state,
      expires_at: row.expires_at,
      invite_expires_at: row.invite_expires_at,
      revision: row.revision,
    };
  }
  private inviteCode(row: Document) {
    return createHmac("sha256", this.auth.config.rateLimitKey)
      .update(`lifelong-invite:${row._id}:${row.user_id}`)
      .digest("base64url");
  }
  private async participant(ctx: Context, recordId: string, active = false) {
    const row = await this.c("supports").findOne(
      {
        _id: id(recordId),
        $or: [{ user_id: ctx.user }, { supporter_user_id: ctx.user }],
      },
      { session: ctx.session },
    );
    if (!row) missing();
    if (active) {
      if (row.state !== "active" || row.expires_at <= ctx.now) missing();
      await this.subject(ctx, row.user_id);
      await this.subject(ctx, row.supporter_user_id);
      if (row.basis === "verified_guardian")
        await this.assurance(
          ctx,
          row.assurance_id,
          row.user_id,
          row.supporter_user_id,
        );
      // Revoke, expiry checks and feedback/read share a transaction conflict fence.
      await this.c("supports").updateOne(
        { _id: row._id, revision: row.revision, state: "active" },
        { $inc: { access_fence: 1 } },
        { session: ctx.session },
      );
    }
    return row;
  }
  async supports(req: ApiRequest, raw: unknown) {
    return this.run(req, false, async (ctx) => {
      const page = this.paging(ctx, raw, "supports", {
        $or: [{ user_id: ctx.user }, { supporter_user_id: ctx.user }],
      });
      const rows = await this.c("supports")
        .find(page.query, { session: ctx.session })
        .sort({ _id: -1 })
        .limit(page.limit + 1)
        .toArray();
      return {
        items: rows.slice(0, page.limit).map((r) => this.supportView(ctx, r)),
        next_cursor:
          rows.length > page.limit
            ? page.next(rows[page.limit - 1]!._id)
            : null,
      };
    });
  }
  async invitationCode(req: ApiRequest, recordId: string) {
    return this.run(req, false, async (ctx) => {
      const row = await this.participant(ctx, recordId);
      if (
        row.user_id !== ctx.user ||
        row.state !== "pending" ||
        row.invite_expires_at <= ctx.now ||
        row.expires_at <= ctx.now
      )
        missing();
      await this.adult(ctx);
      return { invitation_code: this.inviteCode(row) };
    });
  }
  async createSupport(req: ApiRequest, raw: unknown) {
    const b = object(raw, [
      "label",
      "scopes",
      "goal_ids",
      "activity_ids",
      "expires_at",
      "assurance_id",
    ]);
    const label = text(b.label, "支持关系名称", 120),
      goalIds = ids(b.goal_ids, "goal_ids"),
      activityIds = ids(b.activity_ids, "activity_ids");
    if (
      !Array.isArray(b.scopes) ||
      !b.scopes.length ||
      b.scopes.length > 3 ||
      new Set(b.scopes).size !== b.scopes.length
    )
      fail(422, "VALIDATION_ERROR", "请选择支持范围");
    const scopes = b.scopes.map((v) => choice(v, SUPPORT_SCOPES, "支持范围")),
      expiresAt = instant(b.expires_at);
    const assuranceId = b.assurance_id === null ? null : id(b.assurance_id);
    if (
      (!scopes.includes("goals") && goalIds.length) ||
      (!scopes.includes("activities") && activityIds.length) ||
      (scopes.includes("feedback") && !scopes.includes("activities")) ||
      !(goalIds.length + activityIds.length)
    )
      fail(
        422,
        "VALIDATION_ERROR",
        "仅可分享明确选择的目标或活动，反馈需要活动读取范围",
      );
    return this.run(req, true, async (ctx) => {
      let assurance: Document | undefined;
      if (assuranceId)
        assurance = await this.assurance(ctx, assuranceId, ctx.user);
      else await this.adult(ctx);
      if (
        expiresAt <= ctx.now ||
        expiresAt.getTime() > ctx.now.getTime() + 90 * 86400000 ||
        (assurance && expiresAt > assurance.expires_at)
      )
        fail(
          422,
          "VALIDATION_ERROR",
          "有效期须在90天内，且不超过监护核验或成年转段期限",
        );
      for (const recordId of goalIds) await this.owned(ctx, "goals", recordId);
      for (const recordId of activityIds)
        await this.owned(ctx, "activities", recordId);
      const result = await this.operation(
        ctx,
        "support.create",
        b,
        async () => {
          const row = {
            _id: newId(),
            user_id: ctx.user,
            supporter_user_id: assurance?.guardian_user_id ?? null,
            label,
            scopes,
            goal_ids: goalIds,
            activity_ids: activityIds,
            token_hash: "",
            invite_expires_at: new Date(
              Math.min(expiresAt.getTime(), ctx.now.getTime() + 86400000),
            ),
            expires_at: expiresAt,
            state: assurance ? "active" : "pending",
            basis: assurance ? "verified_guardian" : "adult_self_consent",
            assurance_id: assuranceId,
            accepted_at: assurance ? ctx.now : null,
            revoked_at: null,
            revision: 1,
            access_fence: 1,
            created_at: ctx.now,
            updated_at: ctx.now,
          };
          row.token_hash = hash(this.inviteCode(row));
          await this.c("supports").insertOne(row, { session: ctx.session });
          return { id: row._id, revision: 1 };
        },
      );
      const current = await this.c("supports").findOne(
        { _id: result.resource_id, user_id: ctx.user },
        { session: ctx.session },
      );
      if (!current) missing();
      return {
        ...result,
        invitation_code:
          current.state === "pending" &&
          current.invite_expires_at > ctx.now &&
          current.expires_at > ctx.now
            ? this.inviteCode(current)
            : null,
      };
    });
  }
  async invitation(req: ApiRequest, raw: unknown, accept: boolean) {
    const b = object(raw, ["code"]),
      code = text(b.code, "邀请代码", 43);
    if (!/^[A-Za-z0-9_-]{43}$/.test(code))
      fail(422, "VALIDATION_ERROR", "邀请代码无效");
    return this.run(req, true, async (ctx) => {
      await this.auth.rate("lifelong-invite", ctx.user, 30);
      await this.adult(ctx);
      const row = await this.c("supports").findOne(
        { token_hash: hash(code) },
        { session: ctx.session },
      );
      if (
        !row ||
        row.user_id === ctx.user ||
        row.expires_at <= ctx.now ||
        row.invite_expires_at <= ctx.now ||
        !(
          row.state === "pending" ||
          (accept &&
            row.state === "active" &&
            row.supporter_user_id === ctx.user)
        )
      )
        missing();
      await this.subject(ctx, row.user_id);
      if (!accept)
        return {
          label: row.label,
          scopes: row.scopes,
          basis: row.basis,
          expires_at: row.expires_at,
          selected_goal_count: row.goal_ids.length,
          selected_activity_count: row.activity_ids.length,
        };
      return this.operation(
        ctx,
        "support.accept",
        { code_hash: hash(code) },
        async () => {
          if (row.state !== "pending") conflict();
          await this.c("supports").updateOne(
            { _id: row._id, state: "pending", revision: row.revision },
            {
              $set: {
                state: "active",
                supporter_user_id: ctx.user,
                accepted_at: ctx.now,
                updated_at: ctx.now,
              },
              $inc: { revision: 1, access_fence: 1 },
            },
            { session: ctx.session },
          );
          return { id: row._id, revision: row.revision + 1 };
        },
      );
    });
  }
  async revoke(req: ApiRequest, recordId: string, raw: unknown) {
    const b = object(raw, ["revision"]);
    integer(b.revision, "revision");
    return this.run(req, true, async (ctx) => {
      const row = await this.participant(ctx, recordId);
      return this.operation(
        ctx,
        "support.revoke",
        { id: recordId, ...b },
        async () => {
          if (row.revision !== b.revision || row.state === "revoked")
            conflict();
          await this.c("supports").updateOne(
            { _id: row._id, revision: row.revision },
            {
              $set: {
                state: "revoked",
                revoked_at: ctx.now,
                updated_at: ctx.now,
              },
              $inc: { revision: 1, access_fence: 1 },
            },
            { session: ctx.session },
          );
          return { id: row._id, revision: row.revision + 1 };
        },
      );
    });
  }
  async shared(req: ApiRequest, recordId: string) {
    return this.run(req, false, async (ctx) => {
      const row = await this.participant(ctx, recordId, true);
      const filter = { user_id: row.user_id, deleted_at: null };
      const goals = row.scopes.includes("goals")
        ? await this.c("goals")
            .find(
              { ...filter, _id: { $in: row.goal_ids } },
              { session: ctx.session },
            )
            .toArray()
        : [];
      const activities = row.scopes.includes("activities")
        ? await this.c("activities")
            .find(
              { ...filter, _id: { $in: row.activity_ids } },
              { session: ctx.session },
            )
            .toArray()
        : [];
      const feedback = row.scopes.includes("feedback")
        ? await this.c("feedback")
            .find(
              {
                ...filter,
                relation_id: row._id,
                activity_id: { $in: activities.map((a) => a._id) },
              },
              { session: ctx.session },
            )
            .sort({ _id: -1 })
            .limit(101)
            .toArray()
        : [];
      return {
        relation: this.supportView(ctx, row),
        goals: goals.map(goalView),
        activities: activities.map((a) => ({
          ...activityView(a),
          goal_id: row.goal_ids.includes(a.goal_id) ? a.goal_id : null,
        })),
        feedback: feedback.slice(0, 100).map(feedbackView),
        feedback_truncated: feedback.length > 100,
      };
    });
  }
  async feedback(req: ApiRequest, recordId: string, raw: unknown) {
    const b = object(raw, ["activity_id", "note"]),
      activityId = id(b.activity_id),
      note = text(b.note, "支持反馈", 4000);
    return this.run(req, true, async (ctx) => {
      const relation = await this.participant(ctx, recordId, true);
      if (
        relation.supporter_user_id !== ctx.user ||
        !relation.scopes.includes("feedback") ||
        !relation.activity_ids.includes(activityId)
      )
        missing();
      if (
        !(await this.c("activities").findOne(
          { _id: activityId, user_id: relation.user_id, deleted_at: null },
          { session: ctx.session },
        ))
      )
        missing();
      return this.operation(
        ctx,
        "feedback.create",
        { relation_id: recordId, ...b },
        async () => {
          const record = {
            _id: newId(),
            user_id: relation.user_id,
            actor_user_id: ctx.user,
            relation_id: recordId,
            activity_id: activityId,
            note,
            revision: 1,
            deleted_at: null,
            created_at: ctx.now,
            updated_at: ctx.now,
          };
          await this.c("feedback").insertOne(record, { session: ctx.session });
          return { id: record._id, revision: 1 };
        },
      );
    });
  }
  private async assurance(
    ctx: Context,
    assuranceId: string,
    user: string,
    guardian?: string,
  ) {
    if (
      await this.database.db
        .collection("auth_admissions")
        .findOne({ user_id: user, age_band: "adult" }, { session: ctx.session })
    )
      missing();
    const row = await this.c("assurances").findOne(
      {
        _id: id(assuranceId),
        user_id: user,
        ...(guardian ? { guardian_user_id: guardian } : {}),
        state: "approved",
        expires_at: { $gt: ctx.now },
        transition_at: { $gt: ctx.now },
      },
      { session: ctx.session },
    );
    if (
      !row ||
      !(await this.database.db
        .collection<PersonalRow>("organizations")
        .findOne(
          { _id: row.org_id, status: "active" },
          { session: ctx.session },
        ))
    )
      missing();
    await this.subject(ctx, row.guardian_user_id);
    // Institution-backed access also ends when either party leaves that school.
    for (const userId of [row.user_id, row.guardian_user_id]) {
      const member = await this.database.db
        .collection("organization_members")
        .findOne(
          { org_id: row.org_id, user_id: userId, status: "active" },
          { session: ctx.session },
        );
      if (!member) missing();
      await this.database.db.collection("organization_members").updateOne(
        {
          _id: member._id,
          authorization_revision: member.authorization_revision,
        },
        { $inc: { authorization_revision: 1 } },
        { session: ctx.session },
      );
    }
    await this.c("assurances").updateOne(
      { _id: row._id, revision: row.revision, state: "approved" },
      { $set: { updated_at: ctx.now } },
      { session: ctx.session },
    );
    return row;
  }
  private assuranceView(row: Document, reviewer = false) {
    return {
      id: row._id,
      state: row.state,
      expires_at: row.expires_at,
      transition_at: row.transition_at,
      revision: row.revision,
      ...(reviewer
        ? {
            user_id: row.user_id,
            guardian_user_id: row.guardian_user_id,
            org_id: row.org_id,
            proposer_user_id: row.proposer_user_id,
            reviewer_user_id: row.reviewer_user_id,
            evidence_reference: row.evidence_reference,
            policy_version: row.policy_version,
          }
        : {}),
    };
  }
  async assurances(req: ApiRequest, raw: unknown) {
    return this.run(req, false, async (ctx) => {
      const page = this.paging(ctx, raw, "assurances", { user_id: ctx.user });
      const rows = await this.c("assurances")
        .find(page.query, { session: ctx.session })
        .sort({ _id: -1 })
        .limit(page.limit + 1)
        .toArray();
      return {
        items: rows.slice(0, page.limit).map((r) => this.assuranceView(r)),
        next_cursor:
          rows.length > page.limit
            ? page.next(rows[page.limit - 1]!._id)
            : null,
      };
    });
  }
  private async institution(ctx: Context, orgId: string) {
    await this.auth.authorize(
      ctx.identity,
      orgId,
      "organization:admin",
      ctx.session,
    );
    ctx.identity.user.identity_revision += 1;
    if (
      !(await this.database.db
        .collection<PersonalRow>("organizations")
        .findOne(
          { _id: orgId, kind: "school", status: "active" },
          { session: ctx.session },
        ))
    )
      missing();
  }
  private async members(
    ctx: Context,
    orgId: string,
    learner: string,
    guardian: string,
  ) {
    if (learner === guardian || [learner, guardian].includes(ctx.user))
      fail(403, "INDEPENDENT_REVIEW_REQUIRED", "核验人员不得同时是关系当事人");
    if (
      await this.database.db
        .collection("auth_admissions")
        .findOne(
          { user_id: learner, age_band: "adult" },
          { session: ctx.session },
        )
    )
      fail(
        403,
        "ADULT_SELF_CONSENT_REQUIRED",
        "已有成年准入记录的学习者须自行授权支持关系",
      );
    for (const user of [learner, guardian]) {
      await this.subject(ctx, user);
      const member = await this.database.db
        .collection("organization_members")
        .findOne(
          { org_id: orgId, user_id: user, status: "active" },
          { session: ctx.session },
        );
      if (!member) missing();
      await this.database.db.collection("organization_members").updateOne(
        {
          _id: member._id,
          authorization_revision: member.authorization_revision,
        },
        { $inc: { authorization_revision: 1 } },
        { session: ctx.session },
      );
    }
    await this.adult(ctx, guardian);
  }
  async proposeAssurance(req: ApiRequest, raw: unknown) {
    const b = object(raw, [
      "org_id",
      "user_id",
      "guardian_user_id",
      "evidence_reference",
      "policy_version",
      "transition_at",
      "expires_at",
    ]);
    const orgId = id(b.org_id),
      learner = id(b.user_id),
      guardian = id(b.guardian_user_id),
      transition = instant(b.transition_at),
      expiry = instant(b.expires_at);
    const evidence = text(b.evidence_reference, "核验凭证索引", 120),
      policy = text(b.policy_version, "核验政策版本", 120);
    return this.run(req, true, async (ctx) => {
      await this.institution(ctx, orgId);
      await this.members(ctx, orgId, learner, guardian);
      if (
        transition <= ctx.now ||
        transition.getTime() > ctx.now.getTime() + 18 * 366 * 86400000 ||
        expiry <= ctx.now ||
        expiry > transition ||
        expiry.getTime() > ctx.now.getTime() + 90 * 86400000
      )
        fail(
          422,
          "VALIDATION_ERROR",
          "核验有效期须在90天内且不超过成年转段，转段时间须由机构核实",
        );
      return this.operation(ctx, "assurance.propose", b, async () => {
        const row = {
          _id: newId(),
          user_id: learner,
          guardian_user_id: guardian,
          org_id: orgId,
          proposer_user_id: ctx.user,
          reviewer_user_id: null,
          evidence_reference: evidence,
          policy_version: policy,
          transition_at: transition,
          expires_at: expiry,
          state: "pending",
          revision: 1,
          created_at: ctx.now,
          updated_at: ctx.now,
        };
        await this.c("assurances").insertOne(row, { session: ctx.session });
        return { id: row._id, revision: 1 };
      });
    });
  }
  async reviewQueue(req: ApiRequest, orgId: string, raw: unknown) {
    return this.run(req, false, async (ctx) => {
      await this.institution(ctx, id(orgId));
      const page = this.paging(ctx, raw, `assurance-review:${orgId}`, {
        org_id: orgId,
      });
      const rows = await this.c("assurances")
        .find(page.query, { session: ctx.session })
        .sort({ _id: -1 })
        .limit(page.limit + 1)
        .toArray();
      return {
        items: rows
          .slice(0, page.limit)
          .map((r) => this.assuranceView(r, true)),
        next_cursor:
          rows.length > page.limit
            ? page.next(rows[page.limit - 1]!._id)
            : null,
      };
    });
  }
  async participants(req: ApiRequest, orgId: string, raw: unknown) {
    return this.run(req, false, async (ctx) => {
      await this.institution(ctx, id(orgId));
      const page = this.paging(ctx, raw, `institution-participants:${orgId}`, {
        org_id: orgId,
        status: "active",
      });
      const rows = await this.database.db
        .collection<PersonalRow>("organization_members")
        .find(page.query, { session: ctx.session })
        .sort({ _id: -1 })
        .limit(page.limit + 1)
        .toArray();
      const items = [];
      for (const member of rows.slice(0, page.limit)) {
        const user = await collections(this.database.db).users.findOne(
          {
            _id: member.user_id,
            status: "active",
            privacy_state: { $nin: ["erasing", "erased"] },
          },
          { session: ctx.session },
        );
        if (!user) continue;
        const admission = await this.database.db
          .collection("auth_admissions")
          .findOne(
            { user_id: user._id, age_band: "adult" },
            { session: ctx.session },
          );
        items.push({
          user_id: user._id,
          display_name: user.display_name,
          adult_admitted: !!admission,
        });
      }
      return {
        items,
        next_cursor:
          rows.length > page.limit
            ? page.next(rows[page.limit - 1]!._id)
            : null,
      };
    });
  }
  async reviewAssurance(req: ApiRequest, recordId: string, raw: unknown) {
    const b = object(raw, ["revision", "decision"]),
      revision = integer(b.revision, "revision");
    const decision = choice(
      b.decision,
      ["approved", "rejected", "revoked"],
      "审核决定",
    );
    return this.run(req, true, async (ctx) => {
      const row = await this.c("assurances").findOne(
        { _id: id(recordId) },
        { session: ctx.session },
      );
      if (!row) missing();
      await this.institution(ctx, row.org_id);
      if (
        row.proposer_user_id === ctx.user ||
        [row.user_id, row.guardian_user_id].includes(ctx.user)
      )
        fail(403, "INDEPENDENT_REVIEW_REQUIRED", "需要独立审核人员核验");
      await this.members(ctx, row.org_id, row.user_id, row.guardian_user_id);
      return this.operation(
        ctx,
        "assurance.review",
        { id: recordId, ...b },
        async () => {
          if (
            row.revision !== revision ||
            (decision === "revoked"
              ? row.state !== "approved"
              : row.state !== "pending")
          )
            conflict();
          if (
            decision === "approved" &&
            (row.expires_at <= ctx.now || row.transition_at <= ctx.now)
          )
            conflict();
          await this.c("assurances").updateOne(
            { _id: row._id, revision },
            {
              $set: {
                state: decision,
                reviewer_user_id: ctx.user,
                updated_at: ctx.now,
              },
              $inc: { revision: 1 },
            },
            { session: ctx.session },
          );
          return { id: row._id, revision: revision + 1 };
        },
      );
    });
  }
}
