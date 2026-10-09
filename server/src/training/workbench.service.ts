import {managedInvocation} from './managed-invocation';
import { Injectable } from "@nestjs/common";
import { ApiRequest, fail } from "../errors";
import type { AssessmentContext } from "../assessment/contracts";
import { TrainingService } from "./training.service";
import { TrainingPhase2Service } from "./phase2.service";
import * as v from "./validation";
type Row = Record<string, any>;
type Module = {
  status: "ready" | "disabled" | "unavailable";
  items: Row[];
  truncated: boolean;
};
@Injectable()
export class WorkbenchService {
  constructor(
    readonly t: TrainingService,
    readonly phase2: TrainingPhase2Service,
  ) {}
  async read(req: ApiRequest, fromInput: unknown, toInput: unknown) {
    const from = v.date(fromInput),
      to = v.date(toInput);
    if (to <= from || to.getTime() - from.getTime() > 31 * 86400000)
      fail(422, "WORKBENCH_WINDOW", "请选择最多31天时间范围");
    return this.t.run(req, false, async (actual) => {
      if (actual.platform)
        fail(403, "FORBIDDEN", "工作台仅供当前组织本人学员使用");
      this.t.require(actual, "learning:self");
      if (!actual.session.inTransaction() && !managedInvocation())
        fail(503, "TRAINING_TRANSACTION_REQUIRED", "工作台需要副本集一致读取");
      const ctx: AssessmentContext = {
          ...actual,
          capabilities: ["learning:self"],
        },
        now = await this.t.access.now(ctx);
      const options = { session: ctx.session };
      const modules: Record<string, Module> = {};
      const missing = (e: any) =>
        [403, 404].includes(e.getStatus?.() ?? e.status);
      const module = async (
        name: string,
        enabled: boolean,
        work: () => Promise<Module>,
      ) => {
        if (!enabled) {
          modules[name] = { status: "disabled", items: [], truncated: false };
          return;
        }
        try {
          modules[name] = await work();
        } catch (e) {
          if (missing(e)) throw e;
          modules[name] = {
            status: "unavailable",
            items: [],
            truncated: false,
          };
        }
      };
      const courses = new Map<string, Row>();
      await module("courses", true, async () => {
        const rows = await this.t
            .col("courses")
            .find({ org_id: ctx.orgId, status: "published" }, options)
            .sort({ _id: 1 })
            .limit(201)
            .toArray(),
          items: Row[] = [];
        for (const row of rows.slice(0, 200)) {
          try {
            await this.t.courseAccess(ctx, row._id, false);
            const progress = await this.t
              .col("course_progress")
              .find(
                {
                  org_id: ctx.orgId,
                  course_id: row._id,
                  member_id: ctx.memberId,
                  user_id: ctx.userId,
                },
                options,
              )
              .limit(101)
              .toArray();
            if (progress.length > 100)
              fail(409, "PROGRESS_LIMIT", "课程进度超限");
            const required = row.lessons.filter((l: any) => l.required),
              complete = required.filter((l: any) =>
                progress.some(
                  (p) =>
                    p.lesson_key === l.key && p.completed_at instanceof Date,
                ),
              ).length;
            const item = {
              id: row._id,
              title: row.title,
              required: required.length,
              completed: complete,
              completion: required.length ? complete === required.length : null,
            };
            courses.set(row._id, item);
            items.push(item);
          } catch (e) {
            if (!missing(e)) throw e;
          }
        }
        return { status: "ready", items, truncated: rows.length > 200 };
      });
      await module("tasks", true, async () => {
        const rows = await this.t
            .col("training_tasks")
            .find(
              {
                org_id: ctx.orgId,
                recipients: ctx.memberId,
                status: "published",
              },
              options,
            )
            .sort({ due_at: 1, _id: 1 })
            .limit(201)
            .toArray(),
          items: Row[] = [];
        for (const row of rows.slice(0, 200)) {
          try {
            await this.t.taskAccess(ctx, row._id, false);
            if (row.target_type === "course")
              await this.t.courseAccess(ctx, row.target_id, false);
            items.push({
              id: row._id,
              title: row.title,
              due_at: row.due_at,
              target_type: row.target_type,
              target_id: row.target_id,
              status:
                row.target_type === "course" &&
                courses.has(row.target_id) &&
                modules.courses.status === "ready" &&
                !modules.courses.truncated
                  ? courses.get(row.target_id)!.completion === null
                    ? "check_source"
                    : courses.get(row.target_id)!.completion === true
                      ? "course_complete"
                      : "pending"
                  : "check_source",
            });
          } catch (e) {
            if (!missing(e)) throw e;
          }
        }
        return { status: "ready", items, truncated: rows.length > 200 };
      });
      const phaseEnabled = process.env.KL_TRAINING_PHASE2_ENABLED === "true";
      await module("schedule", phaseEnabled, async () => {
        const rows = await this.t
            .col("training_sessions")
            .find(
              {
                org_id: ctx.orgId,
                recipients: ctx.memberId,
                status: { $in: ["published", "ended"] },
                start_at: { $lt: to },
                end_at: { $gt: from },
              },
              options,
            )
            .sort({ start_at: 1, _id: 1 })
            .limit(101)
            .toArray(),
          items: Row[] = [];
        for (const row of rows.slice(0, 100)) {
          try {
            await this.phase2.scope(ctx, row);
            const course = await this.t.courseAccess(ctx, row.course_id, false);
            if (course.subject_id !== row.subject_id) continue;
            items.push({
              id: row._id,
              title: row.title,
              start_at: row.start_at,
              end_at: row.end_at,
              status: row.status,
            });
          } catch (e) {
            if (!missing(e)) throw e;
          }
        }
        return { status: "ready", items, truncated: rows.length > 100 };
      });
      await module("certificates", phaseEnabled, async () => {
        const rows = await this.t
            .col("training_certificates")
            .find(
              {
                org_id: ctx.orgId,
                user_id: ctx.userId,
                member_id: ctx.memberId,
              },
              options,
            )
            .sort({ _id: 1 })
            .limit(201)
            .toArray(),
          items: Row[] = [];
        for (const row of rows.slice(0, 200)) {
          try {
            await this.phase2.scope(ctx, row);
            items.push({
              id: row._id,
              number: row.number,
              status: row.status,
              created_at: row.created_at,
            });
          } catch (e) {
            if (!missing(e)) throw e;
          }
        }
        return { status: "ready", items, truncated: rows.length > 200 };
      });
      await module("notifications", phaseEnabled, async () => {
        const rows = await this.t
            .col("training_notifications")
            .find(
              {
                org_id: ctx.orgId,
                user_id: ctx.userId,
                member_id: ctx.memberId,
              },
              options,
            )
            .sort({ created_at: -1, _id: 1 })
            .limit(51)
            .toArray(),
          items: Row[] = [];
        for (const row of rows.slice(0, 50))
          if (await this.phase2.notificationVisible(ctx, row))
            items.push({
              id: row._id,
              message: row.message,
              status: row.read_at ? "read" : "unread",
              source_type: row.source_type,
              source_id: row.source_id,
              created_at: row.created_at,
            });
        return { status: "ready", items, truncated: rows.length > 50 };
      });
      await module(
        "surveys",
        process.env.KL_TRAINING_SURVEYS_ENABLED === "true",
        async () => {
          const rows = await this.t
              .col("training_surveys")
              .find(
                {
                  org_id: ctx.orgId,
                  status: "open",
                  opens_at: { $lte: now },
                  closes_at: { $gt: now },
                },
                options,
              )
              .sort({ closes_at: 1, _id: 1 })
              .limit(51)
              .toArray(),
            items: Row[] = [];
          for (const row of rows.slice(0, 50)) {
            try {
              await this.t.courseAccess(ctx, row.course_id, false);
              const answer = await this.t
                .col("training_survey_responses")
                .findOne(
                  {
                    org_id: ctx.orgId,
                    survey_id: row._id,
                    user_id: ctx.userId,
                    member_id: ctx.memberId,
                  },
                  options,
                );
              items.push({
                id: row._id,
                title: row.title,
                course_id: row.course_id,
                closes_at: row.closes_at,
                submitted: !!answer,
              });
            } catch (e) {
              if (!missing(e)) throw e;
            }
          }
          return { status: "ready", items, truncated: rows.length > 50 };
        },
      );
      return { from, to, generated_at: now, modules };
    });
  }
}
