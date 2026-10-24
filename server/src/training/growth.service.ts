import { Injectable } from "@nestjs/common";
import type { Document } from "mongodb";
import { ApiRequest, fail } from "../errors";
import { currentlyValid } from "../teaching/contracts";
import { scopedBusinessCapabilities } from "../administration/authorization";
import { requireEvidenceSubject } from "../assessment/subject-access";
import { TrainingService } from "./training.service";
import { LearningStudioService } from "./studio.service";
import { growthEnabled } from "./growth-schema";
import { currentWork } from "./work-context";
import { discoveryCursor } from "./discovery";
import * as v from "./validation";
type Context = Parameters<TrainingService["courseAccess"]>[0];
type Row = Awaited<ReturnType<TrainingService["row"]>>;
const hidden = (): never => fail(404, "NOT_FOUND", "记录当前不可访问");
const isHidden = (e: any) =>
  [403, 404, 409].includes(e.status ?? e.getStatus?.());
const tables = {
  work: "coursework_submissions",
  course: "course_progress",
  meetup: "learning_meetup_members",
} as const;
@Injectable()
export class LearningGrowthService {
  constructor(
    readonly t: TrainingService,
    readonly studio: LearningStudioService,
  ) {}
  run<T>(req: ApiRequest, write: boolean, fn: (ctx: Context) => Promise<T>) {
    if (!growthEnabled()) fail(503, "GROWTH_DISABLED", "成长档案尚未启用");
    return this.studio.run(req, write, fn);
  }
  private page(
    ctx: Context,
    group: string,
    raw: unknown,
    extra: string[] = [],
  ) {
    const q = v.object(raw, ["cursor", "limit", ...extra]);
    const limit =
      q.limit === undefined ? 20 : v.integer(Number(v.text(q.limit, 2)), 1, 50);
    const fingerprint = extra.map((key) => q[key] ?? null);
    const page = discoveryCursor(
      this.t.access.assessment.auth.config.rateLimitKey,
      [
        "growth",
        group,
        ctx.orgId,
        ctx.userId,
        ctx.memberId,
        limit,
        ...fingerprint,
      ],
      q.cursor,
    );
    return { q, limit, ...page };
  }
  private async batch(
    ctx: Context,
    table: string,
    match: Document,
    page: ReturnType<LearningGrowthService["page"]>,
    render: (r: Row) => Promise<Document>,
  ) {
    const candidates = await this.t
      .col(table)
      .find(
        {
          org_id: ctx.orgId,
          ...match,
          ...(page.after ? { _id: { $lt: page.after } } : {}),
        },
        { session: ctx.session, maxTimeMS: 3000 },
      )
      .sort({ _id: -1 })
      .limit(201)
      .toArray();
    const items: Document[] = [];
    let scanned = 0;
    const deadline = performance.now() + 5000;
    for (const row of candidates.slice(0, 200)) {
      if (scanned && performance.now() > deadline) break;
      ++scanned;
      try {
        items.push(await render(row));
      } catch (e) {
        if (!isHidden(e)) throw e;
      }
      if (items.length === page.limit) break;
    }
    return {
      items,
      next_cursor:
        scanned < candidates.length
          ? page.next(candidates[scanned - 1]!._id)
          : null,
    };
  }
  private async workView(ctx: Context, id: string, teacher = false) {
    const { sub, task, feedback } = await currentWork(this.t, ctx, id, teacher);
    return {
      id: sub._id,
      kind: "work",
      source_id: task._id,
      title: task.title,
      class_id: task.class_id,
      subject_id: task.subject_id,
      at: sub.submitted_at,
      verification: feedback ? "teacher_feedback" : "submitted",
      submission_no: sub.submission_no,
      body: sub.body,
      feedback: feedback
        ? {
            comments: feedback.comments,
            score: feedback.score,
            at: feedback.published_at,
          }
        : null,
    };
  }
  async portfolio(req: ApiRequest, raw: unknown) {
    return this.run(req, false, (ctx) => this.portfolioInContext(ctx, raw));
  }
  private async portfolioInContext(ctx: Context, raw: unknown) {
    this.t.require(ctx, "learning:self");
    const page = this.page(ctx, "portfolio", raw, [
      "kind",
      "from",
      "to",
      "subject_id",
    ]);
    const kind = (page.q.kind ?? "work") as keyof typeof tables;
    if (!Object.hasOwn(tables, kind))
      fail(422, "INVALID_INPUT", "档案类型无效");
    const dates: Document = {};
    for (const key of ["from", "to"] as const)
      if (page.q[key] !== undefined) {
        const value = v.text(page.q[key], 10);
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          !Number.isFinite(new Date(value).getTime()) ||
          new Date(value).toISOString().slice(0, 10) !== value
        )
          fail(422, "INVALID_DATE", "时期日期无效");
        dates[key === "from" ? "$gte" : "$lt"] = new Date(
          new Date(value).getTime() + (key === "to" ? 86400000 : 0),
        );
      }
    if (dates.$gte && dates.$lt && dates.$gte >= dates.$lt)
      fail(422, "INVALID_DATE", "结束日期须不早于开始日期");
    const subject =
      page.q.subject_id === undefined ? null : v.id(page.q.subject_id);
    return this.batch(
      ctx,
      tables[kind],
      {
        user_id: ctx.userId,
        member_id: ctx.memberId,
        ...(Object.keys(dates).length ? { created_at: dates } : {}),
      },
      page,
      async (row) => {
        let item: Document;
        if (kind === "work") item = await this.workView(ctx, row._id);
        else if (kind === "course") {
          const course = await this.t.courseAccess(ctx, row.course_id, false);
          const lesson = course.lessons.find(
            (l: Document) => l.key === row.lesson_key,
          );
          if (!lesson) hidden();
          item = {
            id: row._id,
            kind,
            source_id: course._id,
            lesson_key: row.lesson_key,
            title: `${course.title} · ${lesson.title}`,
            subject_id: course.subject_id,
            at: row.completed_at ?? row.updated_at,
            verification: row.completed_at ? "self_confirmed" : "in_progress",
            body: "",
            feedback: null,
          };
        } else {
          const meetup = await this.t.row(
            ctx,
            "learning_meetups",
            row.meetup_id,
          );
          await this.t.classAccess(
            ctx,
            meetup.class_id,
            meetup.subject_id,
            false,
          );
          if (
            row.status !== "attended" ||
            meetup.status === "cancelled" ||
            meetup.status === "draft"
          )
            hidden();
          item = {
            id: row._id,
            kind,
            source_id: meetup._id,
            title: meetup.title,
            subject_id: meetup.subject_id,
            at: row.recorded_at,
            verification: "teacher_recorded",
            body: row.reflection,
            feedback: null,
          };
        }
        if (subject && item.subject_id !== subject) hidden();
        const label = await this.t
          .col("subjects")
          .findOne(
            { _id: item.subject_id },
            { session: ctx.session, projection: { name: 1 } },
          );
        return {
          ...item,
          subject_name: label?.name ?? "学习领域",
          organization_id: ctx.orgId,
        };
      },
    );
  }
  async exportPortfolio(req: ApiRequest, raw: unknown) {
    const filters = v.object(raw, ["kind", "from", "to", "subject_id"]);
    return this.run(req, false, async (ctx) => {
      const items: Document[] = [];
      let cursor: string | null = null;
      const deadline = performance.now() + 8000;
      for (let page = 0; page < 40; page++) {
        if (performance.now() > deadline)
          fail(422, "EXPORT_LIMIT", "记录较多，请缩小筛选范围后导出");
        const result = await this.portfolioInContext(ctx, {
          ...filters,
          limit: "50",
          ...(cursor ? { cursor } : {}),
        });
        items.push(...result.items);
        cursor = result.next_cursor;
        if (!cursor)
          return {
            items,
            filters,
            count: items.length,
            exported_at: await this.t.access.now(ctx),
          };
      }
      fail(422, "EXPORT_LIMIT", "记录较多，请缩小筛选范围后导出");
    });
  }
  async recipients(req: ApiRequest, raw: unknown) {
    const q = v.object(raw, ["submission_id"]),
      id = v.id(q.submission_id);
    return this.run(req, false, async (ctx) => {
      const { task } = await currentWork(this.t, ctx, id);
      const rows = await this.t
        .col("teaching_assignments")
        .find(
          {
            org_id: ctx.orgId,
            class_id: task.class_id,
            subject_id: task.subject_id,
            status: "active",
          },
          { session: ctx.session, maxTimeMS: 3000 },
        )
        .sort({ _id: 1 })
        .limit(201)
        .toArray();
      const items: Document[] = [],
        now = await this.t.access.now(ctx),
        seen = new Set<string>();
      for (const row of rows.slice(0, 200)) {
        if (seen.has(row.member_id) || !currentlyValid(row as any, now))
          continue;
        seen.add(row.member_id);
        const member = await this.t
          .col("organization_members")
          .findOne(
            { _id: row.member_id, org_id: ctx.orgId, status: "active" },
            { session: ctx.session },
          );
        if (!member || member.user_id === ctx.userId) continue;
        try {
          const caps = await this.memberCaps(ctx, member);
          if (!caps.includes("coursework:grade")) continue;
          await requireEvidenceSubject(
            this.t.db,
            ctx.session,
            member.user_id,
            ctx.orgId,
          );
          const user = await this.t
            .col("users")
            .findOne(
              { _id: member.user_id },
              { session: ctx.session, projection: { display_name: 1 } },
            );
          items.push({
            member_id: member._id,
            name: user?.display_name || "授课教师",
          });
        } catch (e) {
          if (!isHidden(e)) throw e;
        }
      }
      return { items, truncated: rows.length > 200 };
    });
  }
  private async memberCaps(ctx: Context, member: Row) {
    const roles = await this.t
      .col("member_roles")
      .find(
        { org_id: ctx.orgId, member_id: member._id },
        { session: ctx.session },
      )
      .toArray();
    const definitions = await this.t
      .col("roles")
      .find(
        { _id: { $in: roles.map((r) => r.role_id) } },
        { session: ctx.session },
      )
      .toArray();
    const now = await this.t.access.now(ctx);
    const grants = await this.t
      .col("member_capability_grants")
      .find(
        {
          org_id: ctx.orgId,
          member_id: member._id,
          status: "active",
          valid_from: { $lte: now },
          $or: [{ valid_to: null }, { valid_to: { $gt: now } }],
        },
        { session: ctx.session },
      )
      .toArray();
    return [
      ...new Set([
        ...definitions.flatMap((r) => r.capabilities),
        ...grants.map((r) => r.capability),
        ...(await scopedBusinessCapabilities(
          this.t.db,
          member.user_id,
          ctx.orgId,
          ctx.session,
        )),
      ]),
    ] as string[];
  }
  private async recipientContext(ctx: Context, memberId: string) {
    const member = await this.t.row(ctx, "organization_members", memberId);
    if (member.status !== "active") hidden();
    await requireEvidenceSubject(
      this.t.db,
      ctx.session,
      member.user_id,
      ctx.orgId,
    );
    const capabilities = await this.memberCaps(ctx, member);
    if (!capabilities.includes("coursework:grade")) hidden();
    return {
      ...ctx,
      userId: member.user_id,
      memberId: member._id,
      capabilities,
    };
  }
  async createShare(req: ApiRequest, raw: unknown) {
    const o = v.object(raw, [
      "label",
      "recipient_member_id",
      "submission_ids",
      "expires_at",
    ]);
    if (
      !Array.isArray(o.submission_ids) ||
      o.submission_ids.length < 1 ||
      o.submission_ids.length > 20
    )
      fail(422, "INVALID_INPUT", "请选择1至20件当前作品");
    const input = {
      label: v.text(o.label, 120),
      recipient_member_id: v.id(o.recipient_member_id),
      submission_ids: o.submission_ids.map(v.id),
      expires_at: v.date(o.expires_at),
    };
    if (new Set(input.submission_ids).size !== input.submission_ids.length)
      fail(422, "INVALID_INPUT", "作品不可重复");
    return this.run(req, true, async (ctx) => {
      this.t.require(ctx, "learning:self");
      if (input.recipient_member_id === ctx.memberId)
        fail(422, "INVALID_INPUT", "请选择其他授课教师");
      const receiver = await this.recipientContext(
          ctx,
          input.recipient_member_id,
        ),
        now = await this.t.access.now(ctx);
      if (
        input.expires_at <= now ||
        input.expires_at.getTime() > now.getTime() + 30 * 86400000
      )
        fail(422, "INVALID_DATE", "分享有效期须在未来30天以内");
      for (const id of input.submission_ids) {
        await currentWork(this.t, ctx, id, false, true);
        await currentWork(this.t, receiver, id, true, true);
      }
      return this.t.idem(
        ctx,
        req,
        "growth.share.create",
        ctx.memberId,
        input,
        async () => {
          const row = {
            ...(await this.t.base(ctx)),
            ...input,
            user_id: ctx.userId,
            member_id: ctx.memberId,
            recipient_user_id: receiver.userId,
            revoked_at: null,
            access_fence: 0,
          };
          await this.t
            .col("learning_portfolio_shares")
            .insertOne(row, { session: ctx.session });
          return row;
        },
      );
    });
  }
  private async shareAccess(ctx: Context, id: string) {
    const row = await this.t.row(ctx, "learning_portfolio_shares", id);
    const mine = row.user_id === ctx.userId && row.member_id === ctx.memberId;
    if (
      !mine &&
      (row.recipient_user_id !== ctx.userId ||
        row.recipient_member_id !== ctx.memberId)
    )
      hidden();
    if (row.revoked_at || row.expires_at <= (await this.t.access.now(ctx)))
      hidden();
    this.t.require(ctx, mine ? "learning:self" : "coursework:grade");
    const recipient = mine
      ? await this.recipientContext(ctx, row.recipient_member_id)
      : ctx;
    const items = [];
    for (const subId of row.submission_ids) {
      const { sub } = await currentWork(this.t, recipient, subId, true);
      if (sub.user_id !== row.user_id || sub.member_id !== row.member_id)
        hidden();
      if (mine) await currentWork(this.t, ctx, subId);
      items.push(await this.workView(ctx, subId, !mine));
    }
    // A read conflicts with revoke/expiry-sensitive writes; it never returns a frozen copy.
    const result = await this.t
      .col("learning_portfolio_shares")
      .updateOne(
        {
          _id: row._id,
          org_id: ctx.orgId,
          revision: row.revision,
          revoked_at: null,
          $expr: { $gt: ["$expires_at", "$$NOW"] },
        },
        { $inc: { access_fence: 1 } },
        { session: ctx.session },
      );
    if (result.modifiedCount !== 1) hidden();
    return { share: row, items };
  }
  async shares(req: ApiRequest, raw: unknown) {
    return this.run(req, false, async (ctx) => {
      const page = this.page(ctx, "shares", raw);
      return this.batch(
        ctx,
        "learning_portfolio_shares",
        {
          $or: [
            { user_id: ctx.userId, member_id: ctx.memberId },
            {
              recipient_user_id: ctx.userId,
              recipient_member_id: ctx.memberId,
            },
          ],
        },
        page,
        async (row) => {
          const mine =
            row.user_id === ctx.userId && row.member_id === ctx.memberId;
          // The owner keeps the ability to revoke an expired/unavailable selection.
          if (!mine) await this.shareAccess(ctx, row._id);
          else this.t.require(ctx, "learning:self");
          return { ...row, perspective: mine ? "owner" : "recipient" };
        },
      );
    });
  }
  async shareDetail(req: ApiRequest, id: string) {
    return this.run(req, false, (ctx) => this.shareAccess(ctx, id));
  }
  async revokeShare(req: ApiRequest, id: string, raw: unknown) {
    const o = v.object(raw, ["expected_revision"]);
    return this.run(req, true, async (ctx) => {
      this.t.require(ctx, "learning:self");
      const row = await this.t.row(ctx, "learning_portfolio_shares", id);
      if (row.user_id !== ctx.userId || row.member_id !== ctx.memberId)
        hidden();
      return this.t.idem(ctx, req, "growth.share.revoke", id, o, async () =>
        this.t.cas(ctx, "learning_portfolio_shares", row, o.expected_revision, {
          revoked_at: await this.t.access.now(ctx),
        }),
      );
    });
  }
  private async notificationView(ctx: Context, row: Row) {
    if (row.user_id !== ctx.userId || row.member_id !== ctx.memberId) hidden();
    let message = "",
      target: Document;
    if (row.event_kind === "question") {
      const question = await this.studio.questionInContext(ctx, row.source_id);
      message =
        question.user_id === ctx.userId &&
        question.member_id === ctx.memberId &&
        question.status === "answered"
          ? "教师已答复你的问题"
          : "答疑会话有新动态";
      target = { kind: "question", id: question._id };
    } else if (row.event_kind === "feedback") {
      const source = await this.t.row(
        ctx,
        "coursework_feedback",
        row.source_id,
      );
      const { task, feedback } = await currentWork(
        this.t,
        ctx,
        source.submission_id,
      );
      if (!feedback || feedback._id !== source._id) hidden();
      message = "当前作品的教师反馈已发布";
      target = { kind: "work", id: task._id };
    } else {
      const meetup = await this.t.row(ctx, "learning_meetups", row.source_id);
      this.t.require(ctx, "learning:self");
      await this.t.classAccess(ctx, meetup.class_id, meetup.subject_id, false);
      const member = await this.t
        .col("learning_meetup_members")
        .findOne(
          {
            org_id: ctx.orgId,
            meetup_id: meetup._id,
            user_id: ctx.userId,
            member_id: ctx.memberId,
            status: { $ne: "cancelled" },
          },
          { session: ctx.session },
        );
      if (!member || meetup.status === "draft") hidden();
      message =
        meetup.status === "cancelled"
          ? "已报名的共学活动已取消"
          : meetup.status === "completed"
            ? "共学活动已结束，可查看参与记录"
            : "共学报名或参与记录已更新";
      target = { kind: "meetup", id: meetup._id };
    }
    return {
      _id: row._id,
      revision: row.revision,
      created_at: row.created_at,
      read_at: row.read_at,
      event_kind: row.event_kind,
      message,
      target,
    };
  }
  async notifications(req: ApiRequest, raw: unknown) {
    return this.run(req, false, async (ctx) => {
      const page = this.page(ctx, "inbox", raw, ["unread"]);
      if (
        page.q.unread !== undefined &&
        !["true", "false"].includes(page.q.unread)
      )
        fail(422, "INVALID_INPUT", "未读筛选无效");
      return this.batch(
        ctx,
        "learning_growth_notifications",
        {
          user_id: ctx.userId,
          member_id: ctx.memberId,
          ...(page.q.unread === "true" ? { read_at: null } : {}),
        },
        page,
        (row) => this.notificationView(ctx, row),
      );
    });
  }
  async readNotification(req: ApiRequest, id: string, raw: unknown) {
    const o = v.object(raw, ["expected_revision"]);
    return this.run(req, true, async (ctx) => {
      const row = await this.t.row(ctx, "learning_growth_notifications", id);
      await this.notificationView(ctx, row);
      return this.t.idem(ctx, req, "growth.inbox.read", id, o, async () => {
        const updated = await this.t.cas(
          ctx,
          "learning_growth_notifications",
          row,
          o.expected_revision,
          { read_at: await this.t.access.now(ctx) },
        );
        return {
          _id: updated._id,
          revision: updated.revision,
          read_at: updated.read_at,
        };
      });
    });
  }
  async preferences(req: ApiRequest) {
    return this.run(req, false, async (ctx) => {
      const row = await this.t
        .col("learning_growth_preferences")
        .findOne(
          { org_id: ctx.orgId, user_id: ctx.userId, member_id: ctx.memberId },
          { session: ctx.session },
        );
      return {
        revision: row?.revision ?? 0,
        question: row?.question ?? true,
        feedback: row?.feedback ?? true,
        meetup: row?.meetup ?? true,
      };
    });
  }
  async savePreferences(req: ApiRequest, raw: unknown) {
    const o = v.object(raw, [
      "expected_revision",
      "question",
      "feedback",
      "meetup",
    ]);
    for (const key of ["question", "feedback", "meetup"])
      if (typeof o[key] !== "boolean")
        fail(422, "INVALID_INPUT", "请选择通知偏好");
    const expected = v.integer(o.expected_revision, 0);
    return this.run(req, true, async (ctx) => {
      const row = await this.t
        .col("learning_growth_preferences")
        .findOne(
          { org_id: ctx.orgId, user_id: ctx.userId, member_id: ctx.memberId },
          { session: ctx.session },
        );
      return this.t.idem(
        ctx,
        req,
        "growth.preferences",
        ctx.memberId,
        o,
        async () => {
          const fields = {
            question: o.question,
            feedback: o.feedback,
            meetup: o.meetup,
          };
          if (row)
            return this.t.cas(
              ctx,
              "learning_growth_preferences",
              row,
              expected,
              fields,
            );
          if (expected !== 0) fail(409, "REVISION_CONFLICT", "通知偏好已变化");
          const created = {
            ...(await this.t.base(ctx)),
            user_id: ctx.userId,
            member_id: ctx.memberId,
            ...fields,
          };
          await this.t
            .col("learning_growth_preferences")
            .insertOne(created, { session: ctx.session });
          return created;
        },
      );
    });
  }
  async receipt(req: ApiRequest, raw: unknown) {
    const o = v.object(raw, ["key"]),
      key = v.text(o.key, 128);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key))
      fail(422, "INVALID_KEY", "请求编号无效");
    return this.run(req, false, async (ctx) => {
      const rows = await this.t
        .col("training_idempotency")
        .find(
          { org_id: ctx.orgId, user_id: ctx.userId, key },
          { session: ctx.session },
        )
        .limit(2)
        .toArray();
      if (!rows.length) return { status: "not_found" };
      if (rows.length !== 1) fail(409, "AMBIGUOUS_RECEIPT", "请求编号不唯一");
      const row = rows[0]!;
      if (!row.operation.startsWith("growth.")) hidden();
      const result = JSON.parse(row.result_json);
      if (row.operation.startsWith("growth.share.")) {
        const live = await this.t.row(
          ctx,
          "learning_portfolio_shares",
          result._id,
        );
        if (live.user_id !== ctx.userId || live.member_id !== ctx.memberId)
          hidden();
        this.t.require(ctx, "learning:self");
      } else if (row.operation === "growth.inbox.read")
        await this.notificationView(
          ctx,
          await this.t.row(ctx, "learning_growth_notifications", result._id),
        );
      else if (row.operation !== "growth.preferences") hidden();
      return { status: "confirmed" };
    });
  }
}
