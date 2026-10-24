import { runInTxn } from "../database/txn";
import { assertOperationalAccess } from "../operations/control";
import { Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import type { AssessmentContext as Context } from "../assessment/contracts";
import { ApiRequest, fail } from "../errors";
import { currentlyValid } from "../teaching/contracts";
import { requireEvidenceSubject } from "../assessment/subject-access";
import { scopedBusinessCapabilities } from "../administration/authorization";
import { canonical } from "../content/dto";
import { TrainingService } from "./training.service";
import { studentAssessmentEvidence } from "../assessment/student-evidence";
import { scoreCents } from "../assessment/scoring";
import type { Submission } from "../assessment/contracts";
import { PHASE2_CAPABILITIES } from "./phase2-schema";
import * as v from "./validation";
import { discoveryCursor, discoveryQuery } from "./discovery";
type Row = any;
const digest = (x: unknown) =>
  createHash("sha256")
    .update(canonical(JSON.parse(JSON.stringify(x))))
    .digest("hex");
@Injectable()
export class TrainingPhase2Service {
  constructor(readonly t: TrainingService) {}
  private enabled() {
    if (process.env.KL_TRAINING_PHASE2_ENABLED !== "true")
      fail(503, "TRAINING_PHASE2_DISABLED", "教务扩展尚未启用");
  }
  run<T>(req: ApiRequest, write: boolean, work: (ctx: Context) => Promise<T>) {
    this.enabled();
    return this.t.run(req, write, async (ctx) => {
      if (!ctx.session.inTransaction())
        fail(
          503,
          "TRAINING_TRANSACTION_REQUIRED",
          "教务扩展需要真实副本集事务",
        );
      return work(ctx);
    });
  }
  private staff(ctx: Context) {
    return ctx.capabilities.some((x) =>
      (PHASE2_CAPABILITIES as readonly string[]).includes(x),
    );
  }
  async scope(ctx: Context, row: Row, write = false) {
    await this.t.classAccess(
      ctx,
      row.class_id,
      row.subject_id,
      this.staff(ctx),
      write,
    );
    if (
      !this.staff(ctx) &&
      row.recipients &&
      !row.recipients.includes(ctx.memberId)
    )
      fail(404, "NOT_FOUND", "当前课次不可访问");
  }
  private async members(ctx: Context, classId: string) {
    const now = await this.t.access.now(ctx),
      links = await this.t
        .col("class_members")
        .find(
          {
            org_id: ctx.orgId,
            class_id: classId,
            status: "active",
            kind: "student",
          },
          { session: ctx.session },
        )
        .limit(201)
        .toArray();
    if (links.length > 200) fail(422, "ROSTER_LIMIT", "班级超过200人");
    const members: Row[] = [];
    for (const link of links) {
      if (!currentlyValid(link as any, now)) continue;
      const m = await this.t
        .col("organization_members")
        .findOne(
          { _id: link.member_id, org_id: ctx.orgId, status: "active" },
          { session: ctx.session },
        );
      if (!m) continue;
      const roles = await this.t
        .col("member_roles")
        .find({ org_id: ctx.orgId, member_id: m._id }, { session: ctx.session })
        .toArray();
      const defs = await this.t
        .col("roles")
        .find(
          { _id: { $in: roles.map((x) => x.role_id) } },
          { session: ctx.session },
        )
        .toArray();
      const grants = await this.t
        .col("member_capability_grants")
        .find(
          {
            org_id: ctx.orgId,
            member_id: m._id,
            status: "active",
            valid_from: { $lte: now },
            $or: [{ valid_to: null }, { valid_to: { $gt: now } }],
          },
          { session: ctx.session },
        )
        .toArray();
      const caps = [
        ...defs.flatMap((x) => x.capabilities),
        ...grants.map((x) => x.capability),
        ...(await scopedBusinessCapabilities(
          this.t.db,
          m.user_id,
          ctx.orgId,
          ctx.session,
        )),
      ];
      if (
        !caps.includes("learning:self") ||
        caps.some((x) =>
          [
            "course:edit",
            "course:review",
            "course:assign",
            "task:manage",
            "coursework:grade",
            "ai:generate",
            "assessment:manage",
            "content:edit",
            "content:review",
            ...PHASE2_CAPABILITIES,
          ].includes(x as any),
        )
      )
        continue;
      await requireEvidenceSubject(
        this.t.db,
        ctx.session,
        m.user_id,
        ctx.orgId,
      );
      members.push(m);
    }
    return members;
  }
  private async notify(
    ctx: Context,
    row: Row,
    type: string,
    message: string,
    memberIds: string[],
  ) {
    for (const memberId of [...new Set(memberIds)]) {
      const member = await this.t
        .col("organization_members")
        .findOne(
          { _id: memberId, org_id: ctx.orgId, status: "active" },
          { session: ctx.session },
        );
      if (!member) continue;
      await this.t.col("training_notification_outbox").insertOne(
        {
          ...(await this.t.base(ctx)),
          user_id: member.user_id,
          member_id: memberId,
          source_type: type,
          source_id: row._id,
          message,
          status: "pending",
          lease_token: null,
          lease_until: null,
        },
        { session: ctx.session },
      );
    }
  }
  private async version(ctx: Context, name: string, row: Row, field: string) {
    const { created_at, updated_at, ...payload } = row;
    await this.t.col(name).insertOne(
      {
        ...(await this.t.base(ctx)),
        class_id: row.class_id,
        subject_id: row.subject_id,
        [field]: row._id,
        ...(name === "training_attendance_versions"
          ? { session_id: row.session_id }
          : {}),
        payload_json: JSON.stringify(payload),
        author_id: ctx.userId,
      },
      { session: ctx.session },
    );
  }
  async list(req: ApiRequest, kind: string) {
    return this.run(req, false, async (ctx) => {
      if (kind === "notifications") await this.deliver(ctx);
      const names: Record<string, string> = {
        locations: "training_locations",
        schedule: "training_sessions",
        attendance: "training_attendance",
        leave: "training_leave_requests",
        paths: "training_paths",
        assignments: "training_path_assignments",
        certificates: "training_certificates",
        notifications: "training_notifications",
      };
      const name = names[kind];
      if (!name) fail(404, "NOT_FOUND", "页面不存在");
      if (kind === "locations") this.t.require(ctx, "training:schedule-manage");
      const filter: Row = { org_id: ctx.orgId };
      if (
        ["leave", "assignments", "certificates"].includes(kind) &&
        !this.staff(ctx)
      )
        filter.user_id = ctx.userId;
      if (kind === "notifications") filter.user_id = ctx.userId;
      const rows = await this.t
          .col(name)
          .find(filter, { session: ctx.session })
          .sort({ updated_at: -1 })
          .limit(201)
          .toArray(),
        items = [];
      for (const row of rows.slice(0, 200)) {
        try {
          if (kind !== "locations" && kind !== "notifications")
            await this.scope(ctx, row);
          if (
            !this.staff(ctx) &&
            ["schedule", "paths"].includes(kind) &&
            !["published", "ended"].includes(row.status)
          )
            continue;
          if (
            kind === "notifications" &&
            !(await this.notificationVisible(ctx, row))
          )
            continue;
          if (kind === "attendance" && !this.staff(ctx)) {
            items.push({
              ...row,
              entries: row.entries.filter(
                (x: Row) => x.member_id === ctx.memberId,
              ),
            });
            continue;
          }
          if (kind === "certificates") {
            const { token_hash, evidence_json, evidence_hash, ...safe } = row;
            items.push(safe);
          } else items.push(row);
        } catch (e) {
          if ((e as any).status !== 404) throw e;
        }
      }
      return { items, truncated: rows.length > 200 };
    });
  }
  private async learnerPath(ctx: Context, id: string) {
    this.t.require(ctx, "learning:self");
    const assignment = await this.t.row(ctx, "training_path_assignments", id);
    if (assignment.user_id !== ctx.userId || assignment.member_id !== ctx.memberId)
      fail(404, "NOT_FOUND", "路径指派不可访问");
    const path = await this.t.row(ctx, "training_paths", assignment.path_id);
    if (path.status !== "published" || path.class_id !== assignment.class_id || path.subject_id !== assignment.subject_id)
      fail(404, "NOT_FOUND", "路径当前不可访问");
    // Always use learner access, including accounts with other scoped capabilities.
    await this.t.classAccess(ctx, path.class_id, path.subject_id, false);
    const rules = JSON.parse(assignment.rules_json);
    return { assignment, rules, courseIds: this.idList(rules.course_ids, 1), taskIds: this.idList(rules.task_ids) };
  }
  async discoverPaths(req: ApiRequest, raw: unknown) {
    const input = v.object(raw, ["q", "sort", "limit", "cursor"]), q = discoveryQuery(input);
    return this.run(req, false, async ctx => {
      this.t.require(ctx, "learning:self");
      const page = discoveryCursor(this.t.access.assessment.auth.config.rateLimitKey,
        ["learner-paths-v1", ctx.orgId, ctx.userId, ctx.memberId, q.term, q.sort, q.limit], q.cursor);
      const candidates = await this.t.col("training_path_assignments").aggregate([
        { $match: { org_id: ctx.orgId, user_id: ctx.userId, member_id: ctx.memberId,
          ...(page.after ? { _id: { [q.sort === "newest" ? "$lt" : "$gt"]: page.after } } : {}) } },
        { $sort: { _id: q.sort === "newest" ? -1 : 1 } },
        { $lookup: { from: "training_paths", localField: "path_id", foreignField: "_id",
          pipeline: [{ $match: { org_id: ctx.orgId, status: "published",
            ...(q.term ? { title: { $regex: q.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } } : {}) } }], as: "_path" } },
        { $match: { "_path.0": { $exists: true } } }, { $project: { _id: 1 } }, { $limit: 201 },
      ], { session: ctx.session, maxTimeMS: 3000 }).toArray();
      const items = []; let scanned = 0; const deadline = performance.now() + 5000;
      for (const row of candidates.slice(0, 200)) {
        if (scanned && performance.now() > deadline) break;
        ++scanned;
        try {
          const { assignment, rules, courseIds, taskIds } = await this.learnerPath(ctx, row._id);
          items.push({ id: assignment._id, title: rules.title, path_revision: rules.path_revision,
            course_count: courseIds.length, task_count: taskIds.length, assigned_at: assignment.created_at });
        } catch (error) { if ((error as any).status !== 404) throw error; }
        if (items.length === q.limit) break;
      }
      return { items, limit: q.limit, next_cursor: scanned < candidates.length ? page.next(candidates[scanned - 1]!._id) : null };
    });
  }
  async discoverPath(req: ApiRequest, id: string) {
    return this.run(req, false, async ctx => {
      const { assignment, rules, courseIds, taskIds } = await this.learnerPath(ctx, id);
      const courses = [];
      for (const courseId of courseIds) {
        const c = await this.t.courseAccess(ctx, courseId, false);
        if (c.subject_id !== assignment.subject_id || !await this.t.col("class_courses").findOne({
          org_id: ctx.orgId, class_id: assignment.class_id, course_id: courseId, status: "active",
        }, { session: ctx.session })) fail(404, "NOT_FOUND", "路径来源当前不可访问");
        const required = c.lessons.filter((l: Row) => l.required).map((l: Row) => l.key);
        const progress = await this.t.col("course_progress").find({ org_id: ctx.orgId, user_id: ctx.userId,
          member_id: ctx.memberId, course_id: courseId, lesson_key: { $in: required }, completed_at: { $ne: null },
        }, { session: ctx.session }).limit(100).toArray();
        courses.push({ id: c._id, title: c.title, version_no: c.version_no, lesson_count: c.lessons.length,
          required_lesson_count: required.length, confirmed_required_count: new Set(progress.map(p => p.lesson_key)).size });
      }
      return { id: assignment._id, title: rules.title, path_revision: rules.path_revision,
        assigned_at: assignment.created_at, courses, task_count: taskIds.length,
        attendance_bp: rules.attendance_bp, grade_min: rules.grade_min };
    });
  }
  async createLocation(req: ApiRequest, input: unknown) {
    const b = v.object(input, ["title"]);
    return this.run(req, true, async (ctx) => {
      this.t.require(ctx, "training:schedule-manage");
      return this.t.idem(
        ctx,
        req,
        "phase2.location-create",
        ctx.orgId,
        b,
        async () => {
          const row = {
            ...(await this.t.base(ctx)),
            title: v.text(b.title),
            status: "active",
          };
          await this.t
            .col("training_locations")
            .insertOne(row, { session: ctx.session });
          await this.t.audit(
            ctx,
            "training_phase2",
            row,
            "phase2.location-create",
          );
          return row;
        },
      );
    });
  }
  private async validateSchedule(ctx: Context, row: Row) {
    if (
      row.end_at <= row.start_at ||
      row.end_at.getTime() - row.start_at.getTime() > 12 * 3600000 ||
      row.start_at.getUTCFullYear() < 2020 ||
      row.start_at.getUTCFullYear() > 2100
    )
      fail(
        422,
        "INVALID_SCHEDULE_TIME",
        "课次须在2020至2100年且时长不超过12小时",
      );
    const location = await this.t.row(
      ctx,
      "training_locations",
      row.location_id,
    );
    if (location.status !== "active")
      fail(409, "LOCATION_RETIRED", "场地已停用");
    await this.t
      .col("training_locations")
      .updateOne(
        { _id: location._id, revision: location.revision },
        { $inc: { revision: 1 } },
        { session: ctx.session },
      );
    const course = await this.t.courseAccess(ctx, row.course_id, true, true);
    if (
      course.status !== "published" ||
      course.subject_id !== row.subject_id ||
      !(await this.t.col("class_courses").findOne(
        {
          org_id: ctx.orgId,
          class_id: row.class_id,
          course_id: row.course_id,
          status: "active",
        },
        { session: ctx.session },
      ))
    )
      fail(409, "COURSE_UNAVAILABLE", "课次课程未发布或未分配");
    const assignment = await this.t.col("teaching_assignments").findOne(
      {
        org_id: ctx.orgId,
        class_id: row.class_id,
        subject_id: row.subject_id,
        member_id: row.teacher_member_id,
        status: "active",
      },
      { session: ctx.session },
    );
    const now = await this.t.access.now(ctx);
    if (!assignment || !currentlyValid(assignment as any, now))
      fail(409, "TEACHER_UNAVAILABLE", "授课教师无有效关系");
    const teacher = await this.t.row(
      ctx,
      "organization_members",
      row.teacher_member_id,
    );
    await requireEvidenceSubject(
      this.t.db,
      ctx.session,
      teacher.user_id,
      ctx.orgId,
    );
    await this.t
      .col("teaching_assignments")
      .updateOne(
        { _id: assignment._id, revision: assignment.revision },
        { $inc: { revision: 1 } },
        { session: ctx.session },
      );
  }
  private async lockSchedule(ctx: Context, row: Row) {
    const days = [];
    for (
      let at = Date.UTC(
        row.start_at.getUTCFullYear(),
        row.start_at.getUTCMonth(),
        row.start_at.getUTCDate(),
      );
      at < row.end_at.getTime();
      at += 86400000
    )
      days.push(new Date(at).toISOString().slice(0, 10));
    const keys = [];
    for (const [kind, id] of [
      ["class", row.class_id],
      ["teacher", row.teacher_member_id],
      ["location", row.location_id],
    ])
      for (const day of days) keys.push(kind + ":" + id + ":" + day);
    for (const key of keys.sort())
      await this.t.col("training_schedule_locks").updateOne(
        { org_id: ctx.orgId, resource_key: key },
        {
          $set: { updated_at: await this.t.access.now(ctx) },
          $inc: { revision: 1 },
          $setOnInsert: {
            _id: (await this.t.base(ctx))._id,
            org_id: ctx.orgId,
            resource_key: key,
            created_at: await this.t.access.now(ctx),
          },
        },
        { upsert: true, session: ctx.session },
      );
  }
  async createSchedule(req: ApiRequest, input: unknown) {
    const b = v.object(input, [
      "class_id",
      "subject_id",
      "title",
      "course_id",
      "teacher_member_id",
      "location_id",
      "start_at",
      "end_at",
      "original_session_id",
    ]);
    return this.run(req, true, async (ctx) => {
      this.t.require(ctx, "training:schedule-manage");
      const data = {
        class_id: v.id(b.class_id),
        subject_id: v.id(b.subject_id),
        title: v.text(b.title),
        course_id: v.id(b.course_id),
        teacher_member_id: v.id(b.teacher_member_id),
        location_id: v.id(b.location_id),
        start_at: v.date(b.start_at),
        end_at: v.date(b.end_at),
        original_session_id:
          b.original_session_id == null ? null : v.id(b.original_session_id),
      };
      await this.scope(ctx, data, true);
      return this.t.idem(
        ctx,
        req,
        "phase2.schedule-create",
        data.class_id,
        b,
        async () => {
          await this.validateSchedule(ctx, data);
          if (data.original_session_id) {
            const original = await this.t.row(
              ctx,
              "training_sessions",
              data.original_session_id,
            );
            await this.scope(ctx, original, true);
            if (
              original.original_session_id ||
              original.class_id !== data.class_id ||
              original.course_id !== data.course_id ||
              !["ended", "cancelled"].includes(original.status)
            )
              fail(409, "INVALID_MAKEUP", "补课须关联同班同课程的原课");
          }
          const row = {
            ...(await this.t.base(ctx)),
            ...data,
            author_id: ctx.userId,
            contributors: [ctx.userId],
            reviewer_id: null,
            recipients: [],
            status: "draft",
            note: "",
          };
          await this.t
            .col("training_sessions")
            .insertOne(row, { session: ctx.session });
          await this.t.audit(
            ctx,
            "training_phase2",
            row,
            "phase2.schedule-create",
          );
          return row;
        },
      );
    });
  }
  async scheduleAction(req: ApiRequest, id: string, input: unknown) {
    const b = v.object(input, [
      "action",
      "expected_revision",
      "start_at",
      "end_at",
      "note",
    ]);
    return this.run(req, true, async (ctx) => {
      this.t.require(ctx, "training:schedule-manage");
      const row = await this.t.row(ctx, "training_sessions", id);
      await this.scope(ctx, row, true);
      return this.t.idem(
        ctx,
        req,
        "phase2.schedule-" + b.action,
        id,
        b,
        async () => {
          const now = await this.t.access.now(ctx);
          let set: Row = { note: v.text(b.note ?? "", 2000, true) };
          if (b.action === "publish") {
            if (row.status !== "draft" || row.start_at <= now)
              fail(409, "INVALID_STATE", "课次不能发布");
            await this.validateSchedule(ctx, row);
            set.status = "published";
            set.recipients = (await this.members(ctx, row.class_id)).map(
              (x) => x._id,
            );
          } else if (b.action === "reschedule") {
            if (row.status !== "published" || row.start_at <= now)
              fail(409, "INVALID_STATE", "仅未开始课次可调课");
            set.start_at = v.date(b.start_at);
            set.end_at = v.date(b.end_at);
            if (set.start_at <= now)
              fail(422, "INVALID_SCHEDULE_TIME", "新课次必须在未来");
            await this.validateSchedule(ctx, { ...row, ...set });
          } else if (b.action === "cancel") {
            if (!["draft", "published"].includes(row.status))
              fail(409, "INVALID_STATE", "课次不能取消");
            set.status = "cancelled";
          } else if (b.action === "end") {
            if (row.status !== "published" || row.end_at > now)
              fail(409, "INVALID_STATE", "课次尚未结束");
            set.status = "ended";
          } else fail(422, "INVALID_ACTION", "课次操作无效");
          await this.lockSchedule(ctx, row);
          if (set.start_at) await this.lockSchedule(ctx, { ...row, ...set });
          if (["publish", "reschedule"].includes(b.action)) {
            const target = { ...row, ...set };
            const conflict = await this.t.col("training_sessions").findOne(
              {
                org_id: ctx.orgId,
                _id: { $ne: id },
                status: { $in: ["published", "ended"] },
                start_at: { $lt: target.end_at },
                end_at: { $gt: target.start_at },
                $or: [
                  { class_id: target.class_id },
                  { teacher_member_id: target.teacher_member_id },
                  { location_id: target.location_id },
                ],
              },
              { session: ctx.session },
            );
            if (conflict)
              fail(409, "SCHEDULE_CONFLICT", "教师、班级或场地时间冲突");
          }
          if (
            b.action === "reschedule" &&
            (await this.t
              .col("training_attendance")
              .findOne({ session_id: id }, { session: ctx.session }))
          )
            fail(409, "ATTENDANCE_EXISTS", "已有考勤的课次不可调课");
          const updated = await this.t.cas(
            ctx,
            "training_sessions",
            row,
            b.expected_revision,
            set,
          );
          await this.version(
            ctx,
            "training_session_versions",
            updated,
            "session_id",
          );
          await this.notify(
            ctx,
            updated,
            "schedule",
            b.action === "cancel" ? "课次已取消" : "课次安排已更新",
            updated.recipients,
          );
          await this.t.audit(
            ctx,
            "training_phase2",
            updated,
            "phase2.schedule-" + b.action,
          );
          return updated;
        },
      );
    });
  }

  async attendance(req: ApiRequest, id: string, input: unknown) {
    const b = v.object(input, [
      "action",
      "expected_revision",
      "entries",
      "note",
    ]);
    return this.run(req, true, async (ctx) => {
      const action = v.text(b.action, 30);
      this.t.require(
        ctx,
        action === "confirm" || action === "reject"
          ? "training:attendance-review"
          : "training:attendance-edit",
      );
      const lesson = await this.t.row(ctx, "training_sessions", id);
      await this.scope(ctx, lesson, true);
      return this.t.idem(
        ctx,
        req,
        "phase2.attendance-" + action,
        id,
        b,
        async () => {
          if (
            !["published", "ended"].includes(lesson.status) ||
            lesson.start_at > (await this.t.access.now(ctx))
          )
            fail(409, "INVALID_STATE", "课次尚未开始或已取消");
          await this.t
            .col("training_sessions")
            .updateOne(
              { _id: id, revision: lesson.revision },
              { $inc: { revision: 1 } },
              { session: ctx.session },
            );
          let row = await this.t
            .col("training_attendance")
            .findOne(
              { org_id: ctx.orgId, session_id: id },
              { session: ctx.session },
            );
          if (!row) {
            if (action !== "save" || b.expected_revision !== 0)
              fail(409, "REVISION_CONFLICT", "考勤尚未创建");
            row = {
              ...(await this.t.base(ctx)),
              class_id: lesson.class_id,
              subject_id: lesson.subject_id,
              session_id: id,
              author_id: ctx.userId,
              contributors: [ctx.userId],
              reviewer_id: null,
              status: "draft",
              entries: [],
              note: "",
            };
            await this.t
              .col("training_attendance")
              .insertOne(row, { session: ctx.session });
            b.expected_revision = 1;
          }
          let set: Row = { note: v.text(b.note ?? "", 2000, true) };
          if (action === "save") {
            if (row.status !== "draft")
              fail(409, "INVALID_STATE", "考勤非草稿");
            if (
              !Array.isArray(b.entries) ||
              b.entries.length !== lesson.recipients.length ||
              new Set(b.entries.map((x: Row) => x.member_id)).size !==
                b.entries.length
            )
              fail(422, "INVALID_ATTENDANCE", "须登记完整冻结名单");
            const entries = [];
            for (const value of b.entries) {
              const x = v.object(value, ["member_id", "status"]);
              if (
                !lesson.recipients.includes(v.id(x.member_id)) ||
                !["present", "late", "absent", "excused"].includes(x.status)
              )
                fail(422, "INVALID_ATTENDANCE", "考勤成员或状态无效");
              if (
                x.status === "excused" &&
                !(await this.t.col("training_leave_requests").findOne(
                  {
                    org_id: ctx.orgId,
                    session_id: id,
                    member_id: x.member_id,
                    status: "approved",
                  },
                  { session: ctx.session },
                ))
              )
                fail(422, "LEAVE_NOT_APPROVED", "请假尚未批准");
              entries.push({ member_id: x.member_id, status: x.status });
            }
            set.entries = entries;
            set.contributors = [...new Set([...row.contributors, ctx.userId])];
          } else if (action === "request-review") {
            if (
              row.status !== "draft" ||
              row.entries.length !== lesson.recipients.length
            )
              fail(409, "INVALID_STATE", "考勤不能送审");
            set.status = "review";
          } else if (["confirm", "reject"].includes(action)) {
            if (
              row.status !== "review" ||
              row.contributors.includes(ctx.userId)
            )
              fail(
                409,
                "INDEPENDENT_REVIEW_REQUIRED",
                "考勤须由独立审核人处理",
              );
            set.note = v.text(b.note, 2000);
            set.status = action === "confirm" ? "confirmed" : "draft";
            set.reviewer_id = ctx.userId;
          } else if (action === "correct") {
            if (row.status !== "confirmed")
              fail(409, "INVALID_STATE", "仅已确认考勤可更正");
            set.note = v.text(b.note, 2000);
            await this.version(
              ctx,
              "training_attendance_versions",
              row,
              "attendance_id",
            );
            set.status = "draft";
            set.contributors = [ctx.userId];
            set.author_id = ctx.userId;
            set.reviewer_id = null;
          } else fail(422, "INVALID_ACTION", "考勤操作无效");
          const updated = await this.t.cas(
            ctx,
            "training_attendance",
            row,
            b.expected_revision,
            set,
          );
          if (action === "confirm")
            await this.version(
              ctx,
              "training_attendance_versions",
              updated,
              "attendance_id",
            );
          await this.notify(
            ctx,
            lesson,
            "attendance",
            "考勤记录已更新",
            lesson.recipients,
          );
          await this.t.audit(
            ctx,
            "training_phase2",
            updated,
            "phase2.attendance-" + action,
          );
          return updated;
        },
      );
    });
  }
  async createLeave(req: ApiRequest, input: unknown) {
    const b = v.object(input, ["session_id", "reason"]);
    return this.run(req, true, async (ctx) => {
      this.t.require(ctx, "learning:self");
      const row = await this.t.row(
        ctx,
        "training_sessions",
        v.id(b.session_id),
      );
      await this.t.classAccess(ctx, row.class_id, row.subject_id, false, true);
      if (!row.recipients.includes(ctx.memberId))
        fail(404, "NOT_FOUND", "课次不可访问");
      return this.t.idem(
        ctx,
        req,
        "phase2.leave-create",
        row._id,
        b,
        async () => {
          if (
            row.status !== "published" ||
            row.start_at <= (await this.t.access.now(ctx))
          )
            fail(409, "INVALID_STATE", "课次不能申请请假");
          await this.t
            .col("training_sessions")
            .updateOne(
              { _id: row._id, revision: row.revision },
              { $inc: { revision: 1 } },
              { session: ctx.session },
            );
          const leave = {
            ...(await this.t.base(ctx)),
            class_id: row.class_id,
            subject_id: row.subject_id,
            session_id: row._id,
            user_id: ctx.userId,
            member_id: ctx.memberId,
            status: "requested",
            reason: v.text(b.reason, 500),
            note: "",
          };
          if (
            await this.t.col("training_leave_requests").findOne(
              {
                org_id: ctx.orgId,
                session_id: row._id,
                member_id: ctx.memberId,
              },
              { session: ctx.session },
            )
          )
            fail(409, "LEAVE_EXISTS", "已存在请假申请");
          await this.t
            .col("training_leave_requests")
            .insertOne(leave, { session: ctx.session });
          await this.notify(ctx, leave, "leave", "收到课次请假申请", [
            row.teacher_member_id,
          ]);
          await this.t.audit(
            ctx,
            "training_phase2",
            leave,
            "phase2.leave-create",
          );
          return leave;
        },
      );
    });
  }
  async leaveAction(req: ApiRequest, id: string, input: unknown) {
    const b = v.object(input, ["action", "expected_revision", "note"]);
    return this.run(req, true, async (ctx) => {
      const row = await this.t.row(ctx, "training_leave_requests", id),
        lesson = await this.t.row(ctx, "training_sessions", row.session_id);
      if (b.action === "cancel") {
        this.t.require(ctx, "learning:self");
        if (row.user_id !== ctx.userId) fail(404, "NOT_FOUND", "请假不可访问");
        await this.t.classAccess(
          ctx,
          row.class_id,
          row.subject_id,
          false,
          true,
        );
      } else {
        this.t.require(ctx, "training:attendance-edit");
        await this.scope(ctx, row, true);
      }
      return this.t.idem(
        ctx,
        req,
        "phase2.leave-" + b.action,
        id,
        b,
        async () => {
          if (
            row.status !== "requested" ||
            lesson.status !== "published" ||
            lesson.start_at <= (await this.t.access.now(ctx))
          )
            fail(409, "INVALID_STATE", "请假不能变更");
          const status =
            b.action === "approve"
              ? "approved"
              : b.action === "reject"
                ? "rejected"
                : b.action === "cancel"
                  ? "cancelled"
                  : null;
          if (!status) fail(422, "INVALID_ACTION", "请假操作无效");
          await this.t
            .col("training_sessions")
            .updateOne(
              { _id: lesson._id, revision: lesson.revision },
              { $inc: { revision: 1 } },
              { session: ctx.session },
            );
          const result = await this.t.cas(
            ctx,
            "training_leave_requests",
            row,
            b.expected_revision,
            { status, note: v.text(b.note ?? "", 2000, true) },
          );
          await this.notify(ctx, row, "leave", "请假申请状态已更新", [
            row.member_id,
          ]);
          await this.t.audit(
            ctx,
            "training_phase2",
            result,
            "phase2.leave-" + b.action,
          );
          return result;
        },
      );
    });
  }
  private idList(input: unknown, min = 0) {
    if (
      !Array.isArray(input) ||
      input.length < min ||
      input.length > 30 ||
      new Set(input).size !== input.length
    )
      fail(422, "INVALID_INPUT", "目标列表须唯一且不超过30项");
    return input.map((x) => v.id(x));
  }
  private async pathTargets(ctx: Context, row: Row) {
    for (const id of row.course_ids) {
      const course = await this.t.courseAccess(ctx, id, true, true);
      if (
        course.subject_id !== row.subject_id ||
        course.status !== "published" ||
        !(await this.t.col("class_courses").findOne(
          {
            org_id: ctx.orgId,
            class_id: row.class_id,
            course_id: id,
            status: "active",
          },
          { session: ctx.session },
        ))
      )
        fail(409, "INVALID_TARGET", "路径课程须已发布并分配");
    }
    for (const id of row.task_ids) {
      const task = await this.t.row(ctx, "training_tasks", id);
      if (
        task.class_id !== row.class_id ||
        task.subject_id !== row.subject_id ||
        task.status !== "published" ||
        !["coursework", "quiz"].includes(task.target_type)
      )
        fail(422, "INVALID_TARGET", "成绩条件须引用同班同学科已发布作业或测验");
      await this.t
        .col("training_tasks")
        .updateOne(
          { _id: id, revision: task.revision },
          { $inc: { revision: 1 } },
          { session: ctx.session },
        );
    }
  }
  async createPath(req: ApiRequest, input: unknown) {
    const b = v.object(input, [
      "class_id",
      "subject_id",
      "title",
      "course_ids",
      "task_ids",
      "attendance_bp",
      "grade_min",
    ]);
    return this.run(req, true, async (ctx) => {
      this.t.require(ctx, "training:path-edit");
      const data = {
        class_id: v.id(b.class_id),
        subject_id: v.id(b.subject_id),
        title: v.text(b.title),
        course_ids: this.idList(b.course_ids, 1),
        task_ids: this.idList(b.task_ids ?? []),
        attendance_bp: v.integer(b.attendance_bp ?? 8000, 8000, 10000),
        grade_min: v.integer(b.grade_min ?? 60, 0, 100),
      };
      await this.scope(ctx, data, true);
      return this.t.idem(
        ctx,
        req,
        "phase2.path-create",
        data.class_id,
        b,
        async () => {
          await this.pathTargets(ctx, data);
          const row = {
            ...(await this.t.base(ctx)),
            ...data,
            author_id: ctx.userId,
            contributors: [ctx.userId],
            reviewer_id: null,
            status: "draft",
            note: "",
          };
          await this.t
            .col("training_paths")
            .insertOne(row, { session: ctx.session });
          await this.t.audit(ctx, "training_phase2", row, "phase2.path-create");
          return row;
        },
      );
    });
  }
  async pathAction(req: ApiRequest, id: string, input: unknown) {
    const b = v.object(input, ["action", "expected_revision", "note", "title", "course_ids", "task_ids", "attendance_bp", "grade_min"]);
    return this.run(req, true, async (ctx) => {
      this.t.require(
        ctx,
        ["publish", "reject"].includes(b.action)
          ? "training:path-review"
          : "training:path-edit",
      );
      const row = await this.t.row(ctx, "training_paths", id);
      await this.scope(ctx, row, true);
      return this.t.idem(
        ctx,
        req,
        "phase2.path-" + b.action,
        id,
        b,
        async () => {
          let set: Row = { note: v.text(b.note ?? "", 2000, true) };
          if(b.action==='edit'){
            if(row.status!=='draft')fail(409,'INVALID_STATE','只能编辑路径草稿');
            set={...set,title:v.text(b.title,200),course_ids:this.idList(b.course_ids,1),task_ids:this.idList(b.task_ids??[]),attendance_bp:v.integer(b.attendance_bp??8000,8000,10000),grade_min:v.integer(b.grade_min??60,0,100),contributors:[...new Set([...row.contributors,ctx.userId])],reviewer_id:null};
            await this.pathTargets(ctx,{...row,...set});
          }else if (b.action === "request-review") {
            if (row.status !== "draft")
              fail(409, "INVALID_STATE", "路径不能送审");
            await this.pathTargets(ctx, row);
            set.status = "review";
          } else if (["publish", "reject"].includes(b.action)) {
            if (
              row.status !== "review" ||
              row.contributors.includes(ctx.userId)
            )
              fail(409, "INDEPENDENT_REVIEW_REQUIRED", "路径须独立审核");
            set.status = b.action === "publish" ? "published" : "draft";
            set.reviewer_id = ctx.userId;
            set.note = v.text(b.note, 2000);
            await this.pathTargets(ctx, row);
          } else if (b.action === "retire") {
            if (row.status !== "published")
              fail(409, "INVALID_STATE", "路径不能撤回");
            set.status = "retired";
          } else fail(422, "INVALID_ACTION", "路径操作无效");
          const updated = await this.t.cas(
            ctx,
            "training_paths",
            row,
            b.expected_revision,
            set,
          );
          if (b.action === "publish") {
            await this.version(
              ctx,
              "training_path_versions",
              updated,
              "path_id",
            );
            for (const m of await this.members(ctx, row.class_id)) {
              const assignment = {
                ...(await this.t.base(ctx)),
                class_id: row.class_id,
                subject_id: row.subject_id,
                path_id: id,
                user_id: m.user_id,
                member_id: m._id,
                rules_json: JSON.stringify({
                  course_ids: row.course_ids,
                  task_ids: row.task_ids,
                  attendance_bp: row.attendance_bp,
                  grade_min: row.grade_min,
                  path_revision: updated.revision,
                  contributors: row.contributors,
                  title: row.title,
                }),
              };
              await this.t
                .col("training_path_assignments")
                .insertOne(assignment, { session: ctx.session });
              await this.notify(ctx, updated, "path", "已指派新的学习路径", [
                m._id,
              ]);
            }
          }
          await this.t.audit(
            ctx,
            "training_phase2",
            updated,
            "phase2.path-" + b.action,
          );
          return updated;
        },
      );
    });
  }

  private async qualification(ctx: Context, assignment: Row) {
    const path = await this.t.row(ctx, "training_paths", assignment.path_id);
    await this.scope(ctx, path, true);
    await requireEvidenceSubject(
      this.t.db,
      ctx.session,
      assignment.user_id,
      ctx.orgId,
    );
    const rules = JSON.parse(assignment.rules_json),
      missing: string[] = [],
      sources: Row[] = [];
    if (path.status !== "published") missing.push("学习路径已撤回");
    if (
      !(await this.t.col("class_members").findOne(
        {
          org_id: ctx.orgId,
          class_id: path.class_id,
          member_id: assignment.member_id,
          status: "active",
          $and: [
            {
              $or: [
                { valid_from: null },
                { valid_from: { $lte: await this.t.access.now(ctx) } },
              ],
            },
            {
              $or: [
                { valid_to: null },
                { valid_to: { $gt: await this.t.access.now(ctx) } },
              ],
            },
          ],
        },
        { session: ctx.session },
      ))
    )
      missing.push("学员当前班级关系失效");
    await this.t
      .col("training_paths")
      .updateOne(
        { _id: path._id, revision: path.revision },
        { $inc: { revision: 1 } },
        { session: ctx.session },
      );
    for (const id of rules.course_ids) {
      const c = await this.t.courseAccess(ctx, id, this.staff(ctx), true);
      if (c.status !== "published") missing.push("课程已撤回");
      const required = c.lessons
          .filter((x: Row) => x.required)
          .map((x: Row) => x.key),
        progress = await this.t
          .col("course_progress")
          .find(
            {
              org_id: ctx.orgId,
              course_id: id,
              member_id: assignment.member_id,
              completed_at: { $ne: null },
            },
            { session: ctx.session },
          )
          .limit(101)
          .toArray();
      const completed = required.filter((key: string) =>
        progress.some((x) => x.lesson_key === key),
      );
      if (!required.length || completed.length !== required.length)
        missing.push("必修课节未全部完成");
      sources.push(["course", id, c.status, required, completed]);
    }
    const lessons = await this.t
      .col("training_sessions")
      .find(
        {
          org_id: ctx.orgId,
          class_id: path.class_id,
          subject_id: path.subject_id,
          course_id: { $in: rules.course_ids },
          status: "ended",
          recipients: assignment.member_id,
        },
        { session: ctx.session },
      )
      .sort({ start_at: 1 })
      .limit(501)
      .toArray();
    if (lessons.length > 500)
      fail(409, "QUALIFICATION_CAPACITY", "课次超过资格计算上限");
    const chains = new Map<string, { minutes: number; attended: number }>();
    for (const lesson of lessons) {
      const original = lesson.original_session_id
        ? await this.t.row(ctx, "training_sessions", lesson.original_session_id)
        : lesson;
      const chain = original._id;
      const minutes = Math.floor(
        (original.end_at.getTime() - original.start_at.getTime()) / 60000,
      );
      const current = chains.get(chain) ?? { minutes, attended: 0 };
      const attendance = await this.t
        .col("training_attendance")
        .findOne(
          { org_id: ctx.orgId, session_id: lesson._id, status: "confirmed" },
          { session: ctx.session },
        );
      const entry = attendance?.entries.find(
        (x: Row) => x.member_id === assignment.member_id,
      );
      if (entry && ["present", "late"].includes(entry.status))
        current.attended = Math.max(
          current.attended,
          Math.min(
            minutes,
            Math.floor(
              (lesson.end_at.getTime() - lesson.start_at.getTime()) / 60000,
            ),
          ),
        );
      chains.set(chain, current);
      await this.t
        .col("training_sessions")
        .updateOne(
          { _id: lesson._id, revision: lesson.revision },
          { $inc: { revision: 1 } },
          { session: ctx.session },
        );
      if (attendance)
        await this.t
          .col("training_attendance")
          .updateOne(
            { _id: attendance._id, revision: attendance.revision },
            { $inc: { revision: 1 } },
            { session: ctx.session },
          );
      sources.push([
        "attendance",
        lesson._id,
        lesson.start_at,
        lesson.end_at,
        lesson.status,
        attendance?.status ?? null,
        entry?.status ?? null,
      ]);
    }
    const minutes = [...chains.values()].reduce((a, x) => a + x.minutes, 0),
      attended = [...chains.values()].reduce((a, x) => a + x.attended, 0);
    if (!minutes) missing.push("缺少已结束必修课次证据");
    else if (attended * 10000 < minutes * rules.attendance_bp)
      missing.push("到场课时比例不足");
    for (const id of rules.task_ids) {
      const task = await this.t.row(ctx, "training_tasks", id);
      if (task.target_type === "quiz") {
        const candidates = await this.t
          .col("submissions")
          .find(
            {
              org_id: ctx.orgId,
              member_id: assignment.member_id,
              user_id: assignment.user_id,
              quiz_id: task.target_id,
            },
            { session: ctx.session },
          )
          .sort({ submitted_at: -1, _id: -1 })
          .limit(51)
          .toArray();
        if (candidates.length > 50)
          fail(409, "EVIDENCE_CAPACITY", "测验尝试超过核验上限");
        const studentCtx: Context = {
          ...ctx,
          userId: assignment.user_id,
          memberId: assignment.member_id,
          capabilities: ["learning:self"],
          platform: undefined,
        };
        let accepted: Row | null = null;
        for (const candidate of candidates) {
          const evidence = await studentAssessmentEvidence(
            this.t.db,
            studentCtx,
            candidate as Submission,
            "projection_check",
          );
          if (
            evidence.status === "released" &&
            evidence.subjectId === assignment.subject_id
          ) {
            const earned = evidence.results.reduce(
                (sum, x) => sum + scoreCents(x.score),
                0n,
              ),
              maximum = evidence.results.reduce(
                (sum, x) => sum + scoreCents(x.max_score),
                0n,
              );
            accepted = {
              id: candidate._id,
              revision: candidate.effective_grading_revision,
              passed:
                maximum > 0n &&
                earned * 100n >= maximum * BigInt(rules.grade_min),
              earned: earned.toString(),
              maximum: maximum.toString(),
            };
            break;
          }
        }
        if (
          task.status !== "published" ||
          !accepted?.passed ||
          !task.recipients.includes(assignment.member_id)
        )
          missing.push("测验当前有效发布成绩不足");
        sources.push(["quiz", id, task.status, task.target_id, accepted]);
      } else {
        const head = await this.t
          .col("coursework_heads")
          .findOne(
            { org_id: ctx.orgId, task_id: id, member_id: assignment.member_id },
            { session: ctx.session },
          );
        const feedback = head?.current_feedback_id
          ? await this.t.col("coursework_feedback").findOne(
              {
                _id: head.current_feedback_id,
                org_id: ctx.orgId,
                status: "published",
                submission_id: head.current_submission_id,
              },
              { session: ctx.session },
            )
          : null;
        if (
          task.status !== "published" ||
          !feedback ||
          feedback.score < rules.grade_min ||
          !task.recipients.includes(assignment.member_id)
        )
          missing.push("作业有效发布成绩不足");
        if (head)
          await this.t
            .col("coursework_heads")
            .updateOne(
              { _id: head._id, revision: head.revision },
              { $inc: { revision: 1 } },
              { session: ctx.session },
            );
        sources.push([
          "task",
          id,
          task.status,
          head?.current_submission_id ?? null,
          feedback?._id ?? null,
          feedback?.score ?? null,
        ]);
      }
      await this.t
        .col("training_tasks")
        .updateOne(
          { _id: id, revision: task.revision },
          { $inc: { revision: 1 } },
          { session: ctx.session },
        );
    }
    const evidence = {
      rules,
      minutes,
      attended,
      attendance_bp: minutes ? Math.floor((attended * 10000) / minutes) : 0,
      missing,
      sources,
    };
    if (JSON.stringify(evidence).length > 16000)
      fail(409, "EVIDENCE_CAPACITY", "结业证据超过单次核验上限");
    return {
      eligible: missing.length === 0,
      evidence,
      evidence_hash: digest(evidence),
    };
  }
  async completion(req: ApiRequest, id: string) {
    return this.run(req, false, async (ctx) => {
      if (!this.staff(ctx) && !ctx.capabilities.includes("learning:self"))
        fail(403, "FORBIDDEN", "需要教务或证书权限");
      const assignment = await this.t.row(ctx, "training_path_assignments", id);
      if (
        !this.staff(ctx) &&
        (assignment.user_id !== ctx.userId ||
          assignment.member_id !== ctx.memberId)
      )
        fail(404, "NOT_FOUND", "结业指派不可访问");
      return this.qualification(ctx, assignment);
    });
  }
  async issueCertificate(req: ApiRequest, input: unknown) {
    const b = v.object(input, ["assignment_id", "note"]);
    return this.run(req, true, async (ctx) => {
      this.t.require(ctx, "training:certificate-issue");
      const assignment = await this.t.row(
        ctx,
        "training_path_assignments",
        v.id(b.assignment_id),
      );
      await this.scope(ctx, assignment, true);
      const rules = JSON.parse(assignment.rules_json);
      if (rules.contributors.includes(ctx.userId))
        fail(403, "INDEPENDENT_REVIEW_REQUIRED", "路径贡献者不能签发证书");
      return this.t.idem(
        ctx,
        req,
        "phase2.certificate-issue",
        assignment._id,
        b,
        async () => {
          const result = await this.qualification(ctx, assignment);
          if (!result.eligible)
            fail(409, "CERTIFICATE_INELIGIBLE", "结业条件未满足，请查看缺项");
          if (
            await this.t
              .col("training_certificates")
              .findOne(
                { assignment_id: assignment._id },
                { session: ctx.session },
              )
          )
            fail(409, "CERTIFICATE_EXISTS", "该指派已签发证书");
          const token = randomBytes(32).toString("hex"),
            base = await this.t.base(ctx);
          const row = {
            ...base,
            class_id: assignment.class_id,
            subject_id: assignment.subject_id,
            path_id: assignment.path_id,
            assignment_id: assignment._id,
            user_id: assignment.user_id,
            member_id: assignment.member_id,
            issuer_id: ctx.userId,
            number: "KL-" + base._id,
            token_hash: digest(token),
            evidence_json: JSON.stringify(result.evidence),
            evidence_hash: result.evidence_hash,
            status: "issued",
            note: v.text(b.note, 2000),
          };
          await this.t
            .col("training_certificates")
            .insertOne(row, { session: ctx.session });
          await this.t.col("training_certificate_events").insertOne(
            {
              ...(await this.t.base(ctx)),
              class_id: row.class_id,
              subject_id: row.subject_id,
              certificate_id: row._id,
              user_id: row.user_id,
              actor_id: ctx.userId,
              action: "issued",
              note: row.note,
            },
            { session: ctx.session },
          );
          await this.notify(ctx, row, "certificate", "结业证书已签发", [
            row.member_id,
          ]);
          await this.t.audit(
            ctx,
            "training_phase2",
            row,
            "phase2.certificate-issue",
          );
          const { token_hash, evidence_json, evidence_hash, ...safe } = row;
          return { ...safe, verification_token: token };
        },
      );
    });
  }
  async revokeCertificate(req: ApiRequest, id: string, input: unknown) {
    const b = v.object(input, ["expected_revision", "note"]);
    return this.run(req, true, async (ctx) => {
      this.t.require(ctx, "training:certificate-revoke");
      const row = await this.t.row(ctx, "training_certificates", id);
      await this.scope(ctx, row, true);
      return this.t.idem(
        ctx,
        req,
        "phase2.certificate-revoke",
        id,
        b,
        async () => {
          if (row.status !== "issued") fail(409, "INVALID_STATE", "证书已撤销");
          const updated = await this.t.cas(
            ctx,
            "training_certificates",
            row,
            b.expected_revision,
            { status: "revoked", note: v.text(b.note, 2000) },
          );
          await this.t.col("training_certificate_events").insertOne(
            {
              ...(await this.t.base(ctx)),
              class_id: row.class_id,
              subject_id: row.subject_id,
              certificate_id: id,
              user_id: row.user_id,
              actor_id: ctx.userId,
              action: "revoked",
              note: updated.note,
            },
            { session: ctx.session },
          );
          await this.notify(ctx, row, "certificate", "结业证书已撤销", [
            row.member_id,
          ]);
          await this.t.audit(
            ctx,
            "training_phase2",
            updated,
            "phase2.certificate-revoke",
          );
          return { id, status: "revoked", revision: updated.revision };
        },
      );
    });
  }
  async readNotification(req: ApiRequest, id: string, input: unknown) {
    const b = v.object(input, ["expected_revision"]);
    return this.run(req, true, async (ctx) => {
      const row = await this.t.row(ctx, "training_notifications", id);
      if (
        row.user_id !== ctx.userId ||
        row.member_id !== ctx.memberId ||
        !(await this.notificationVisible(ctx, row))
      )
        fail(404, "NOT_FOUND", "通知不可访问");
      return this.t.idem(ctx, req, "phase2.notification-read", id, b, () =>
        this.t.cas(ctx, "training_notifications", row, b.expected_revision, {
          read_at: row.read_at ?? new Date(),
        }),
      );
    });
  }
  async overview(req: ApiRequest) {
    return this.run(req, false, async (ctx) => {
      this.t.require(ctx, "training:operations-read");
      const links = await this.t
        .col("teaching_assignments")
        .find(
          { org_id: ctx.orgId, member_id: ctx.memberId, status: "active" },
          { session: ctx.session },
        )
        .limit(201)
        .toArray();
      const classes = [
          ...new Set(
            links
              .filter((x) => currentlyValid(x as any, new Date()))
              .map((x) => x.class_id),
          ),
        ].map((id) => ({ id })),
        items = [];
      for (const clazz of classes) {
        const roster = await this.members(ctx, clazz.id);
        if (roster.length < 5) {
          items.push({ class_id: clazz.id, status: "insufficient" });
          continue;
        }
        const filter = { org_id: ctx.orgId, class_id: clazz.id };
        items.push({
          class_id: clazz.id,
          status: "ready",
          member_count: roster.length,
          scheduled_count: await this.t
            .col("training_sessions")
            .countDocuments(
              { ...filter, status: "published" },
              { session: ctx.session },
            ),
          issued_count: await this.t
            .col("training_certificates")
            .countDocuments(
              { ...filter, status: "issued" },
              { session: ctx.session },
            ),
        });
      }
      return { items };
    });
  }
  async notificationVisible(ctx: Context, row: Row) {
    if (row.user_id !== ctx.userId || row.member_id !== ctx.memberId)
      return false;
    const table: Record<string, string> = {
      schedule: "training_sessions",
      leave: "training_leave_requests",
      attendance: "training_sessions",
      path: "training_paths",
      certificate: "training_certificates",
      task: "training_tasks",
    };
    try {
      const source = await this.t.row(
        ctx,
        table[row.source_type],
        row.source_id,
      );
      if (row.source_type === "task") {
        await this.t.taskAccess(ctx, source._id, this.staff(ctx));
        if (source.status !== "published") return false;
      } else await this.scope(ctx, source);
      return true;
    } catch (e) {
      if ((e as any).status === 404) return false;
      throw e;
    }
  }
  async deliver(ctx: Context) {
    await requireEvidenceSubject(this.t.db, ctx.session, ctx.userId, ctx.orgId);
    const jobs = await this.t
      .col("training_notification_outbox")
      .find(
        {
          org_id: ctx.orgId,
          user_id: ctx.userId,
          member_id: ctx.memberId,
          status: "pending",
        },
        { session: ctx.session },
      )
      .sort({ created_at: 1 })
      .limit(50)
      .toArray();
    for (const job of jobs) {
      if (await this.notificationVisible(ctx, job)) {
        await this.t.col("training_notifications").updateOne(
          { event_id: job._id },
          {
            $setOnInsert: {
              ...(await this.t.base(ctx)),
              user_id: ctx.userId,
              member_id: ctx.memberId,
              event_id: job._id,
              source_type: job.source_type,
              source_id: job.source_id,
              message: job.message,
              read_at: null,
            },
          },
          { upsert: true, session: ctx.session },
        );
      }
      await this.t.col("training_notification_outbox").updateOne(
        { _id: job._id, status: "pending" },
        {
          $set: {
            status: "delivered",
            updated_at: await this.t.access.now(ctx),
          },
          $inc: { revision: 1 },
        },
        { session: ctx.session },
      );
    }
  }
  async verifyCertificate(token: string) {
    this.enabled();
    if (!/^[a-f0-9]{64}$/.test(token)) return { status: "not_found" };
    await assertOperationalAccess(this.t.db);
    return runInTxn(
      this.t.db.client,
      async (session) => {
        const cert = await this.t
          .col("training_certificates")
          .findOne({ token_hash: digest(token) }, { session });
        if (!cert) return { status: "not_found" };
        if (cert.status === "revoked") return { status: "revoked" };
        const issuer = await this.t
          .col("organization_members")
          .findOne(
            { user_id: cert.issuer_id, org_id: cert.org_id, status: "active" },
            { session },
          );
        if (!issuer) return { status: "pending_review" };
        const ctx: Context = {
          orgId: cert.org_id,
          userId: cert.issuer_id,
          memberId: issuer._id,
          capabilities: ["training:certificate-issue"],
          session,
          requestId: "certificate-verification",
        };
        try {
          const assignment = await this.t.row(
            ctx,
            "training_path_assignments",
            cert.assignment_id,
          );
          const q = await this.qualification(ctx, assignment);
          if (!q.eligible || q.evidence_hash !== cert.evidence_hash)
            return { status: "pending_review" };
          const org = await this.t
            .col("organizations")
            .findOne({ _id: cert.org_id, status: "active" }, { session });
          if (!org) return { status: "pending_review" };
          return {
            status: "valid",
            organization: org.name,
            course: JSON.parse(assignment.rules_json).title,
            issued_at: cert.created_at,
          };
        } catch (e) {
          if ([403, 404, 409].includes((e as any).status))
            return { status: "pending_review" };
          throw e;
        }
      },
      { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } },
    );
  }

  async receipt(req: ApiRequest, input: unknown) {
    const b = v.object(input, ["key"]);
    const key = v.text(b.key, 128);
    return this.run(req, true, async (ctx) => {
      const rows = await this.t
        .col("training_idempotency")
        .find(
          { org_id: ctx.orgId, user_id: ctx.userId, key },
          { session: ctx.session },
        )
        .limit(2)
        .toArray();
      if (!rows.length) return { status: "not_found" };
      if (rows.length !== 1)
        fail(409, "AMBIGUOUS_RECEIPT", "请求编号关联多个资源");
      const receipt = rows[0];
      if (!receipt.operation.startsWith("phase2."))
        fail(404, "NOT_FOUND", "回执不可访问");
      const result = JSON.parse(receipt.result_json);
      const suffix = receipt.operation.slice(7),
        type = suffix.split("-")[0];
      const tables: Record<string, string> = {
        location: "training_locations",
        schedule: "training_sessions",
        attendance: "training_attendance",
        leave: "training_leave_requests",
        path: "training_paths",
        certificate: "training_certificates",
        notification: "training_notifications",
      };
      const table = tables[type];
      if (!table) fail(404, "NOT_FOUND", "回执不可访问");
      const live = await this.t.row(ctx, table, result._id ?? result.id);
      if (type === "location") this.t.require(ctx, "training:schedule-manage");
      else if (type === "notification") {
        if (
          live.user_id !== ctx.userId ||
          !(await this.notificationVisible(ctx, live))
        )
          fail(404, "NOT_FOUND", "通知不可访问");
      } else {
        await this.scope(ctx, live);
        const required =
          type === "schedule"
            ? "training:schedule-manage"
            : type === "attendance"
              ? ["confirm", "reject"].includes(
                  suffix.split("-").slice(1).join("-"),
                )
                ? "training:attendance-review"
                : "training:attendance-edit"
              : type === "path"
                ? ["publish", "reject"].includes(
                    suffix.split("-").slice(1).join("-"),
                  )
                  ? "training:path-review"
                  : "training:path-edit"
                : type === "certificate"
                  ? suffix === "certificate-issue"
                    ? "training:certificate-issue"
                    : "training:certificate-revoke"
                  : suffix === "leave-create" || suffix === "leave-cancel"
                    ? "learning:self"
                    : "training:attendance-edit";
        this.t.require(ctx, required);
        if (
          type === "leave" &&
          required === "learning:self" &&
          live.user_id !== ctx.userId
        )
          fail(404, "NOT_FOUND", "请假回执不可访问");
      }
      return { status: "confirmed", result };
    });
  }

  async catalog(req: ApiRequest) {
    return this.run(req, false, async (ctx) => {
      const now = await this.t.access.now(ctx),
        rows = await this.t
          .col("teaching_assignments")
          .find(
            { org_id: ctx.orgId, status: "active" },
            { session: ctx.session },
          )
          .limit(1001)
          .toArray();
      if (rows.length > 1000) fail(409, "CATALOG_CAPACITY", "授课目录超过上限");
      const teachers = [];
      for (const row of rows) {
        if (!currentlyValid(row as any, now)) continue;
        try {
          await this.t.classAccess(ctx, row.class_id, row.subject_id, true);
          const m = await this.t.row(
            ctx,
            "organization_members",
            row.member_id,
          );
          const user = await this.t
            .col("users")
            .findOne(
              { _id: m.user_id, status: "active", privacy_state: "active" },
              { session: ctx.session },
            );
          if (user)
            teachers.push({
              class_id: row.class_id,
              subject_id: row.subject_id,
              member_id: m._id,
              name: user.display_name,
            });
        } catch (e) {
          if ((e as any).status !== 404) throw e;
        }
      }
      const tasks = [];
      for (const row of await this.t
        .col("training_tasks")
        .find(
          {
            org_id: ctx.orgId,
            status: "published",
            target_type: { $in: ["coursework", "quiz"] },
          },
          { session: ctx.session },
        )
        .limit(201)
        .toArray()) {
        try {
          await this.scope(ctx, row);
          tasks.push({
            id: row._id,
            title: row.title,
            class_id: row.class_id,
            subject_id: row.subject_id,
            target_type: row.target_type,
          });
        } catch (e) {
          if ((e as any).status !== 404) throw e;
        }
      }
      return { teachers, tasks };
    });
  }
}
