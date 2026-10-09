import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { AssessmentContext } from "../assessment/contracts";
import { ApiRequest, fail } from "../errors";
import { canonical } from "../content/dto";
import { TeachingService } from "../teaching/teaching.service";
import { currentLearningManifest } from "../learning/manifest";
import { TrainingService } from "./training.service";
import * as v from "./validation";
import {sanitizeAiLearningFacts} from "./ai-learning-source";
import { quizTaskCompletion } from "./quiz-completion";
@Injectable()
export class TrainingReportService {
  constructor(
    readonly training: TrainingService,
    readonly teaching: TeachingService,
  ) {}
  private enabled() {
    if (process.env.KL_TRAINING_REPORTS_ENABLED !== "true")
      fail(503, "TRAINING_REPORTS_DISABLED", "报告发布尚未启用");
  }
  private async access(ctx: AssessmentContext, row: any, write = false) {
    if (
      !ctx.capabilities.some((c) =>
        [
          "training:report-edit",
          "training:report-review",
          "teaching:report",
        ].includes(c),
      )
    )
      fail(403, "FORBIDDEN", "无报告权限");
    await this.training.classAccess(
      ctx,
      row.class_id,
      row.subject_id,
      true,
      write,
    );
  }
  private async facts(
    ctx: AssessmentContext,
    classId: string,
    subjectId: string,
    taskId: string | null,
  ) {
    const data = await this.teaching.classSubjectReportFacts(
      ctx,
      classId,
      subjectId,
    );
    const dates = await this.training
      .col("class_members")
      .find(
        { org_id: ctx.orgId, class_id: classId, status: "active" },
        { session: ctx.session },
      )
      .limit(201)
      .toArray();
    if (dates.length > 200) fail(409, "CLASS_TOO_LARGE", "名册超过上限");
    const factNow = await this.training.access.now(ctx);
    for (const link of dates)
      for (const date of [link.valid_from, link.valid_to])
        if (date instanceof Date && date > factNow && date < data.validUntil)
          data.validUntil = date;
    const assignment = await this.training.access.requireAssignment(
      ctx,
      classId,
      subjectId,
    );
    if (
      assignment.assignment.valid_to &&
      assignment.assignment.valid_to < data.validUntil
    )
      data.validUntil = assignment.assignment.valid_to;
    // Each student's semantic manifest includes only released, currently effective evidence.
    const semantics = [];
    for (const entry of data.source) {
      const memberId = (entry as any[])[0];
      const member = await this.training
        .col("organization_members")
        .findOne(
          { _id: memberId, org_id: ctx.orgId, status: "active" },
          { session: ctx.session },
        );
      if (!member) fail(409, "REPORT_FACTS_CHANGED", "报告来源已变化");
      const state = await this.training
        .col("student_projection_states")
        .findOne(
          { org_id: ctx.orgId, member_id: memberId },
          { session: ctx.session },
        );
      const manifest = await currentLearningManifest(
        this.training.db,
        {
          orgId: ctx.orgId,
          memberId,
          userId: member.user_id,
          capabilities: ["learning:self"],
          session: ctx.session,
          requestId: ctx.requestId,
        },
        subjectId,
        "",
        state?.projection_revision ?? 0,
      );
      semantics.push([
        memberId,
        manifest.digest,
        manifest.eligibility,
        manifest.catalog,
      ]);
      if (manifest.next < data.validUntil) data.validUntil = manifest.next;
    }
    let task: any = null;
    if (taskId) {
      task = await this.training.row(ctx, "training_tasks", taskId);
      if (
        task.class_id !== classId ||
        task.subject_id !== subjectId ||
        task.status !== "published"
      )
        fail(404, "NOT_FOUND", "培训任务不可访问");
    }
    const rosterIds = data.source.map((x) => (x as any[])[0]);
    const recipients = task
      ? task.recipients.filter((x: string) => rosterIds.includes(x))
      : [];
    let completed = 0;
    let quizSource: unknown = null;
    if (task?.target_type === "quiz") {
      const completion = await quizTaskCompletion(this.training.db, ctx, task.target_id,
        subjectId, recipients, factNow);
      completed = completion.count;
      quizSource = completion.source;
      if (completion.next && completion.next < data.validUntil) data.validUntil = completion.next;
    }
    if (task?.target_type === "coursework")
      completed = await this.training.col("coursework_heads").countDocuments(
        {
          org_id: ctx.orgId,
          task_id: taskId,
          member_id: { $in: recipients },
          current_submission_id: { $ne: null },
        },
        { session: ctx.session },
      );
    else if (task?.target_type === "course") {
      const course = await this.training.row(ctx, "courses", task.target_id);
      const required = course.lessons
        .filter((x: any) => x.required)
        .map((x: any) => x.key);
      const progress = await this.training
        .col("course_progress")
        .find(
          {
            org_id: ctx.orgId,
            course_id: task.target_id,
            member_id: { $in: recipients },
            lesson_key: { $in: required },
            completed_at: { $ne: null },
          },
          { session: ctx.session },
        )
        .limit(20001)
        .toArray();
      if (progress.length > 20000)
        fail(409, "REPORT_FACTS_CAPACITY", "报告事实超过上限");
      for (const recipient of recipients)
        if (
          required.length &&
          required.every((key: string) =>
            progress.some(
              (x) => x.member_id === recipient && x.lesson_key === key,
            ),
          )
        )
          completed++;
    }
    const facts = {
      learning: data.report,
      training: task
        ? {
            title: task.title,
            target_type: task.target_type,
            completion_count: completed,
            completion_status: "available",
            completion_is_mastery: false,
          }
        : null,
    };
    const watermark = createHash("sha256")
      .update(
        canonical([
          data.source,
          semantics,
          facts,
          quizSource,
          task ? { revision: task.revision, status: task.status } : null,
        ]),
      )
      .digest("hex");
    return {
      facts_json: JSON.stringify(facts),
      source_watermark: watermark,
      facts_at: await this.training.access.now(ctx),
      valid_until: data.validUntil,
    };
  }
  async aiContext(ctx: AssessmentContext, key: string, write = false) {
    this.enabled();
    if (process.env.KL_AI_LEARNING_REPORTS_ENABLED !== "true" || process.env.KL_AI_POLICY_ENABLED !== "true")
      fail(503, "AI_LEARNING_REPORTS_DISABLED", "AI学情解读尚未启用");
    this.training.require(ctx, "ai:generate");
    this.training.require(ctx, "training:report-edit");
    const row = await this.training.row(ctx, "training_reports", key);
    await this.access(ctx, row, write);
    if (row.status !== "draft") fail(409, "REPORT_STATE_CONFLICT", "AI解读仅用于报告草稿");
    const current = await this.facts(ctx, row.class_id, row.subject_id, row.task_id);
    if (current.source_watermark !== row.source_watermark || current.valid_until <= await this.training.access.now(ctx))
      fail(409, "REPORT_FACTS_CHANGED", "事实已变化，请刷新报告事实");
    const sanitized = sanitizeAiLearningFacts(JSON.parse(current.facts_json));
    if (!sanitized.eligible || !sanitized.source.mastery_bands)
      fail(422, "AI_LEARNING_EVIDENCE_INSUFFICIENT", "有效证据或可公开聚合不足，暂不能生成AI解读");
    return { ...row, ai_source: sanitized.source, ai_watermark: current.source_watermark, ai_valid_until: current.valid_until };
  }
  async acceptAi(ctx: AssessmentContext, row: any, expected: unknown, body: string, validUntil: Date) {
    if (!row.contributors.includes(ctx.userId) && row.contributors.length >= 100)
      fail(422, "REPORT_CONTRIBUTOR_LIMIT", "报告贡献者超过上限");
    const result = await this.training.cas(ctx, "training_reports", row, expected, {
      body: v.text(body, 12000),
      contributors: [...new Set([...row.contributors, ctx.userId])],
    }, validUntil);
    await this.training.audit(ctx, "training_report", result, "report.accept-ai");
    return result;
  }
  async list(req: ApiRequest) {
    this.enabled();
    return this.training.run(req, false, async (ctx) => {
      if (
        !ctx.capabilities.some((c) =>
          [
            "training:report-edit",
            "training:report-review",
            "teaching:report",
          ].includes(c),
        )
      )
        fail(403, "FORBIDDEN", "无报告权限");
      const rows = await this.training
        .col("training_reports")
        .find({ org_id: ctx.orgId }, { session: ctx.session })
        .sort({ updated_at: -1 })
        .limit(201)
        .toArray();
      const items = [];
      for (const row of rows.slice(0, 200)) {
        try {
          await this.access(ctx, row);
          if (
            row.status === "published" ||
            ctx.capabilities.some((c) =>
              ["training:report-edit", "training:report-review"].includes(c),
            )
          )
            items.push(row);
        } catch (e) {
          if ((e as any).status !== 404) throw e;
        }
      }
      return { items, truncated: rows.length > 200 };
    });
  }
  async get(req: ApiRequest, id: string) {
    this.enabled();
    return this.training.run(req, false, async (ctx) => {
      const row = await this.training.row(ctx, "training_reports", id);
      await this.access(ctx, row);
      if (
        row.status !== "published" &&
        !ctx.capabilities.some((c) =>
          ["training:report-edit", "training:report-review"].includes(c),
        )
      )
        fail(404, "NOT_FOUND", "报告尚未发布");
      return row;
    });
  }
  async create(req: ApiRequest, input: unknown) {
    this.enabled();
    const b = v.object(input, [
      "class_id",
      "subject_id",
      "task_id",
      "title",
      "body",
    ]);
    const classId = v.id(b.class_id),
      subjectId = v.id(b.subject_id),
      taskId = b.task_id == null ? null : v.id(b.task_id),
      title = v.text(b.title),
      body = v.text(b.body, 12000, true);
    return this.training.run(req, true, async (ctx) => {
      this.training.require(ctx, "training:report-edit");
      await this.training.classAccess(ctx, classId, subjectId, true, true);
      return this.training.idem(
        ctx,
        req,
        "report.create",
        classId,
        b,
        async () => {
          const row = {
            ...(await this.training.base(ctx)),
            class_id: classId,
            subject_id: subjectId,
            task_id: taskId,
            title,
            body,
            author_id: ctx.userId,
            contributors: [ctx.userId],
            reviewer_id: null,
            review_note: "",
            published_version_id: null,
            status: "draft",
            ...(await this.facts(ctx, classId, subjectId, taskId)),
          };
          await this.training
            .col("training_reports")
            .insertOne(row, { session: ctx.session });
          await this.training.audit(
            ctx,
            "training_report",
            row,
            "report.create",
          );
          return row;
        },
      );
    });
  }
  async action(req: ApiRequest, id: string, input: unknown) {
    this.enabled();
    const b = v.object(input, [
      "action",
      "expected_revision",
      "title",
      "body",
      "note",
    ]);
    const action = v.text(b.action, 30);
    v.integer(b.expected_revision);
    if (
      ![
        "edit",
        "refresh-facts",
        "request-review",
        "reject",
        "publish",
        "retire",
      ].includes(action)
    )
      fail(422, "INVALID_ACTION", "报告操作无效");
    return this.training.run(req, true, async (ctx) => {
      this.training.require(
        ctx,
        ["publish", "reject"].includes(action)
          ? "training:report-review"
          : "training:report-edit",
      );
      const before = await this.training.row(ctx, "training_reports", id);
      await this.access(ctx, before, true);
      // Access is rechecked before replay; a receipt does not bypass current authorization.
      return this.training.idem(
        ctx,
        req,
        "report." + action,
        id,
        b,
        async () => {
          let set: any = {};
          if (
            ["edit", "refresh-facts", "request-review"].includes(action) &&
            before.status !== "draft"
          )
            fail(409, "REPORT_STATE_CONFLICT", "报告须处于草稿状态");
          if (
            action === "edit" &&
            !before.contributors.includes(ctx.userId) &&
            before.contributors.length >= 100
          )
            fail(422, "REPORT_CONTRIBUTOR_LIMIT", "报告贡献者超过上限");
          if (action === "edit")
            set = {
              title: v.text(b.title),
              body: v.text(b.body, 12000, true),
              contributors: [...new Set([...before.contributors, ctx.userId])],
            };
          if (action === "refresh-facts")
            set = await this.facts(
              ctx,
              before.class_id,
              before.subject_id,
              before.task_id,
            );
          if (["request-review", "publish"].includes(action)) {
            const current = await this.facts(
              ctx,
              before.class_id,
              before.subject_id,
              before.task_id,
            );
            if (current.source_watermark !== before.source_watermark)
              fail(
                409,
                "REPORT_FACTS_CHANGED",
                "事实已变化，请刷新事实后重新送审",
              );
            if (current.valid_until <= (await this.training.access.now(ctx)))
              fail(409, "REPORT_FACTS_CHANGED", "事实时间窗口已变化");
            set.valid_until = current.valid_until;
            if (action === "request-review") {
              if (!before.body.trim())
                fail(422, "REPORT_BODY_REQUIRED", "请填写报告正文");
              set = {
                status: "review",
                review_note: "",
                valid_until: current.valid_until,
              };
            }
          }
          if (["reject", "publish"].includes(action)) {
            if (before.status !== "review")
              fail(409, "REPORT_STATE_CONFLICT", "报告不在审核状态");
            if (
              before.author_id === ctx.userId ||
              before.contributors.includes(ctx.userId)
            )
              fail(403, "REPORT_SELF_REVIEW", "作者或贡献者不能审核自己的报告");
            const note = v.text(b.note, 2000);
            set = {
              ...set,
              status: action === "publish" ? "published" : "draft",
              reviewer_id: ctx.userId,
              review_note: note,
            };
            if (action === "publish") {
              const version: any = {
                ...before,
                _id: (await this.training.base(ctx))._id,
                report_id: id,
                reviewer_id: ctx.userId,
                review_note: note,
                published_at: await this.training.access.now(ctx),
              };
              delete version.status;
              delete version.published_version_id;
              await this.training
                .col("training_report_versions")
                .insertOne(version, { session: ctx.session });
              set.published_version_id = version._id;
            }
          }
          if (action === "retire") {
            if (before.status !== "published")
              fail(409, "REPORT_STATE_CONFLICT", "仅已发布报告可撤回");
            set = { status: "retired" };
          }
          const row = await this.training.cas(
            ctx,
            "training_reports",
            before,
            b.expected_revision,
            set,
            ["request-review", "publish"].includes(action)
              ? (set.valid_until ??
                  (
                    await this.facts(
                      ctx,
                      before.class_id,
                      before.subject_id,
                      before.task_id,
                    )
                  ).valid_until)
              : undefined,
          );
          await this.training.audit(
            ctx,
            "training_report",
            row,
            "report." + action,
          );
          return row;
        },
      );
    });
  }
}
