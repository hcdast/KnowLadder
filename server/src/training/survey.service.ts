import { Injectable } from "@nestjs/common";
import type { AssessmentContext } from "../assessment/contracts";
import { ApiRequest, fail } from "../errors";
import { TrainingService } from "./training.service";
import * as v from "./validation";
import {
  surveyDraft,
  surveyAnswers,
  requireSurveyWindow,
  surveyTransition,
  surveySummary,
  type SurveyQuestion,
} from "./survey-contract";
@Injectable()
export class SurveyService {
  constructor(readonly training: TrainingService) {}
  private enabled() {
    if (process.env.KL_TRAINING_SURVEYS_ENABLED !== "true")
      fail(503, "TRAINING_SURVEYS_DISABLED", "课程反馈尚未启用");
  }
  private async access(
    ctx: AssessmentContext,
    courseId: string,
    manage: boolean,
    write = false,
  ) {
    this.training.require(ctx, manage ? "course:edit" : "learning:self");
    const course = await this.training.courseAccess(
      ctx,
      courseId,
      manage,
      write,
    );
    // Fence the course assignment even when knowledge indexing is disabled.
    if (write && !manage) {
      const links = await this.training
        .col("class_courses")
        .find(
          { org_id: ctx.orgId, course_id: courseId, status: "active" },
          { session: ctx.session },
        )
        .limit(201)
        .toArray();
      if (links.length > 200)
        fail(409, "SURVEY_SCOPE_TOO_LARGE", "课程范围超过上限");
      let fenced = false;
      for (const link of links) {
        try {
          await this.training.classAccess(
            ctx,
            link.class_id,
            course.subject_id,
            false,
            true,
          );
        } catch (e) {
          if ((e as any).getStatus?.() === 404 || (e as any).status === 404)
            continue;
          throw e;
        }
        const result = await this.training.col("class_courses").updateOne(
          {
            _id: link._id,
            org_id: ctx.orgId,
            status: "active",
            revision: link.revision,
          },
          { $inc: { revision: 1 } },
          { session: ctx.session },
        );
        if (result.modifiedCount !== 1)
          fail(409, "CONTEXT_CHANGED", "课程报名范围已变化");
        fenced = true;
        break;
      }
      if (!fenced) fail(404, "NOT_FOUND", "课程未分配到当前班级");
    }
    return course;
  }
  private audit(ctx: AssessmentContext, row: any, action: string) {
    return this.training.access.audit(
      ctx,
      "course",
      row.course_id,
      "training." + action,
      "课程反馈操作",
      { revision_after: row.revision, survey_id: row._id },
    );
  }
  private metadata(row: any) {
    return {
      _id: row._id,
      course_id: row.course_id,
      title: row.title,
      revision: row.revision,
      published_revision: row.published_revision,
      status: row.status,
      opens_at: row.opens_at,
      closes_at: row.closes_at,
    };
  }
  private response(row: any) {
    return row
      ? {
          _id: row._id,
          survey_id: row.survey_id,
          frozen_revision: row.frozen_revision,
          answers: row.answers,
          submitted_at: row.submitted_at,
        }
      : null;
  }
  async list(req: ApiRequest, courseId: string, manage: boolean) {
    this.enabled();
    return this.training.run(req, false, async (ctx) => {
      await this.access(ctx, v.id(courseId), manage);
      const rows = await this.training
        .col("training_surveys")
        .find(
          {
            org_id: ctx.orgId,
            course_id: courseId,
            ...(manage ? {} : { status: { $in: ["open", "closed"] } }),
          },
          { session: ctx.session },
        )
        .sort({ _id: 1 })
        .limit(51)
        .toArray();
      return {
        items: rows.slice(0, 50).map((r) => this.metadata(r)),
        truncated: rows.length > 50,
      };
    });
  }
  async read(req: ApiRequest, key: string, manage: boolean) {
    this.enabled();
    return this.training.run(req, false, async (ctx) => {
      const row = await this.training.row(ctx, "training_surveys", key);
      await this.access(ctx, row.course_id, manage);
      if (!manage && row.status === "draft")
        fail(404, "NOT_FOUND", "问卷不存在");
      const own = manage
        ? null
        : await this.training
            .col("training_survey_responses")
            .findOne(
              { org_id: ctx.orgId, survey_id: row._id, user_id: ctx.userId },
              { session: ctx.session },
            );
      return {
        ...this.metadata(row),
        questions: row.questions,
        response: this.response(own),
      };
    });
  }
  async create(req: ApiRequest, input: unknown) {
    this.enabled();
    const o = v.object(input, ["course_id", "draft"]),
      courseId = v.id(o.course_id),
      draft = surveyDraft(o.draft);
    return this.training.run(req, true, async (ctx) => {
      await this.access(ctx, courseId, true, true);
      return this.training.idem(
        ctx,
        req,
        "survey.create",
        courseId,
        input,
        async () => {
          const row = {
            ...(await this.training.base(ctx)),
            course_id: courseId,
            ...draft,
            published_revision: 0,
            status: "draft",
          };
          await this.training
            .col("training_surveys")
            .insertOne(row, { session: ctx.session });
          await this.audit(ctx, row, "survey.create");
          return this.metadata(row);
        },
      );
    });
  }
  async edit(req: ApiRequest, key: string, input: unknown) {
    this.enabled();
    const o = v.object(input, ["expected_revision", "draft"]),
      draft = surveyDraft(o.draft);
    v.integer(o.expected_revision);
    return this.training.run(req, true, async (ctx) => {
      const row = await this.training.row(ctx, "training_surveys", key);
      await this.access(ctx, row.course_id, true, true);
      return this.training.idem(
        ctx,
        req,
        "survey.edit",
        row._id,
        input,
        async () => {
          if (row.status !== "draft")
            fail(409, "SURVEY_FROZEN", "已发布问卷不能修改题目");
          const next = await this.training.cas(
            ctx,
            "training_surveys",
            row,
            o.expected_revision,
            { ...draft, updated_at: await this.training.access.now(ctx) },
          );
          await this.audit(ctx, next, "survey.edit");
          return this.metadata(next);
        },
      );
    });
  }
  async action(req: ApiRequest, key: string, input: unknown) {
    this.enabled();
    const o = v.object(input, ["expected_revision", "action"]);
    v.integer(o.expected_revision);
    return this.training.run(req, true, async (ctx) => {
      const row = await this.training.row(ctx, "training_surveys", key);
      await this.access(ctx, row.course_id, true, true);
      return this.training.idem(
        ctx,
        req,
        "survey.action",
        row._id,
        input,
        async () => {
          const now = await this.training.access.now(ctx),
            status = surveyTransition(row.status, o.action, row.closes_at, now);
          const next = await this.training.cas(
            ctx,
            "training_surveys",
            row,
            o.expected_revision,
            {
              status,
              updated_at: now,
              ...(status === "open"
                ? { published_revision: row.revision + 1 }
                : {}),
            },
          );
          await this.audit(ctx, next, "survey." + o.action);
          return this.metadata(next);
        },
      );
    });
  }
  async submit(req: ApiRequest, key: string, input: unknown) {
    this.enabled();
    const o = v.object(input, ["expected_revision", "answers"]);
    v.integer(o.expected_revision);
    return this.training.run(req, true, async (ctx) => {
      const row = await this.training.row(ctx, "training_surveys", key);
      await this.access(ctx, row.course_id, false, true);
      const answers = surveyAnswers(
        row.questions as SurveyQuestion[],
        o.answers,
      );
      return this.training.idem(
        ctx,
        req,
        "survey.submit",
        row._id,
        input,
        async () => {
          const now = await this.training.access.now(ctx);
          requireSurveyWindow(row.status, row.opens_at, row.closes_at, now);
          if (
            await this.training
              .col("training_survey_responses")
              .findOne(
                { org_id: ctx.orgId, survey_id: row._id, user_id: ctx.userId },
                { session: ctx.session },
              )
          )
            fail(409, "SURVEY_ALREADY_SUBMITTED", "反馈已提交，不可覆盖");
          const updated = await this.training.cas(
            ctx,
            "training_surveys",
            row,
            o.expected_revision,
            { updated_at: now },
            row.closes_at,
          );
          const response = {
            ...(await this.training.base(ctx)),
            survey_id: row._id,
            course_id: row.course_id,
            user_id: ctx.userId,
            member_id: ctx.memberId,
            frozen_revision: row.published_revision,
            answers,
            submitted_at: now,
          };
          await this.training
            .col("training_survey_responses")
            .insertOne(response, { session: ctx.session });
          await this.audit(ctx, updated, "survey.submit");
          return {
            survey_id: row._id,
            response_id: response._id,
            submitted_at: now,
          };
        },
      );
    });
  }
  async results(req: ApiRequest, key: string, cursor?: string) {
    this.enabled();
    if (cursor) v.id(cursor);
    return this.training.run(req, false, async (ctx) => {
      const row = await this.training.row(ctx, "training_surveys", key);
      await this.access(ctx, row.course_id, true);
      const filter = { org_id: ctx.orgId, survey_id: row._id };
      const responses = await this.training
        .col("training_survey_responses")
        .find(filter, { session: ctx.session })
        .limit(2001)
        .toArray();
      if (responses.length > 2000)
        fail(409, "SURVEY_RESULTS_TOO_LARGE", "反馈数量超过首版汇总上限");
      const page = await this.training
        .col("training_survey_responses")
        .find(
          { ...filter, ...(cursor ? { _id: { $gt: cursor } } : {}) },
          { session: ctx.session },
        )
        .sort({ _id: 1 })
        .limit(51)
        .toArray();
      return {
        summary: surveySummary(
          row.questions as SurveyQuestion[],
          responses.map((r) => r.answers),
        ),
        items: page.slice(0, 50).map((r) => ({
          _id: r._id,
          member_id: r.member_id,
          answers: r.answers.filter((a: any) =>
            row.questions.some(
              (q: any) => q.id === a.question_id && q.kind === "text",
            ),
          ),
          submitted_at: r.submitted_at,
        })),
        next_cursor: page.length > 50 ? page[49]._id : null,
      };
    });
  }
  async receipt(req: ApiRequest, input: unknown) {
    this.enabled();
    const o = v.object(input, ["key", "operation", "resource_id"]),
      key = v.text(o.key, 128),
      resource = v.id(o.resource_id);
    if (
      !/^[A-Za-z0-9_-]{8,128}$/.test(key) ||
      ![
        "survey.create",
        "survey.edit",
        "survey.action",
        "survey.submit",
      ].includes(o.operation)
    )
      fail(422, "INVALID_INPUT", "回执范围无效");
    return this.training.run(req, false, async (ctx) => {
      const row = await this.training.col("training_idempotency").findOne(
        {
          org_id: ctx.orgId,
          user_id: ctx.userId,
          operation: o.operation,
          resource_id: resource,
          key,
        },
        { session: ctx.session },
      );
      if (!row) {
        if (o.operation === "survey.create")
          await this.access(ctx, resource, true);
        else {
          const survey = await this.training.row(
            ctx,
            "training_surveys",
            resource,
          );
          await this.access(
            ctx,
            survey.course_id,
            o.operation !== "survey.submit",
          );
        }
        return { status: "not_found" };
      }
      const result = JSON.parse(row.result_json),
        survey = await this.training.row(
          ctx,
          "training_surveys",
          o.operation === "survey.create" ? result._id : resource,
        );
      await this.access(ctx, survey.course_id, o.operation !== "survey.submit");
      return { status: "applied", result };
    });
  }
}
