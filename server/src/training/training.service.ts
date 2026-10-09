
import {managedApiEnabled,assertManagedInvocation} from './managed-invocation';
import {AssignmentRecoveryRunner} from './assignment-recovery-runner';
import {rawDatabase} from '../database/object-id';
import { enqueueKnowledge } from "./knowledge-events";
import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Document } from "mongodb";
import { TeachingAccess } from "../teaching/access";
import { currentlyValid } from "../teaching/contracts";
import { AssessmentContext as Context } from "../assessment/contracts";
import { scopedBusinessCapabilities } from "../administration/authorization";
import { requireEvidenceSubject } from "../assessment/subject-access";
import { canonical } from "../content/dto";
import { licensed, type BaseVersion } from "../content/contracts";
import { newId } from "../database/object-id";
import { ApiRequest, fail } from "../errors";
import * as v from "./validation";
type Row = Document & { _id: string; org_id: string; revision: number };
@Injectable()
export class TrainingService {
  constructor(readonly access: TeachingAccess) {}
  get db() {
    return this.access.assessment.database.db;
  }
  col(name: string) {
    return this.db.collection<Row>(name);
  }
  async run<T>(
    req: ApiRequest,
    write: boolean,
    work: (ctx: Context) => Promise<T>,
  ) {
    if (process.env.KL_TRAINING_ENABLED !== "true")
      fail(503, "TRAINING_DISABLED", "培训扩展尚未启用");
    return this.access.run(req, write, async (ctx) => {
      if (write && !ctx.session.inTransaction())
        fail(503, "TRAINING_TRANSACTION_REQUIRED", "培训写入需要副本集事务");
      return work(ctx);
    });
  }
  require(ctx: Context, cap: string) {
    this.access.assessment.require(ctx, cap);
  }
  async row(ctx: Context, name: string, key: string) {
    const r = await this.col(name).findOne(
      { _id: v.id(key), org_id: ctx.orgId },
      { session: ctx.session },
    );
    if (!r) fail(404, "NOT_FOUND", "资源不存在");
    return r;
  }
  async base(ctx: Context) {
    const now = await this.access.now(ctx);
    return {
      _id: newId(),
      org_id: ctx.orgId,
      revision: 1,
      created_at: now,
      updated_at: now,
    };
  }
  async idem<T>(
    ctx: Context,
    req: ApiRequest,
    operation: string,
    resource: string,
    input: unknown,
    work: () => Promise<T>,
  ): Promise<T> {
    await requireEvidenceSubject(this.db, ctx.session, ctx.userId, ctx.orgId);
    const key = req.get("Idempotency-Key");
    if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key))
      fail(422, "IDEMPOTENCY_KEY_REQUIRED", "请提供8至128字符幂等键");
    const filter = {
      org_id: ctx.orgId,
      user_id: ctx.userId,
      operation,
      resource_id: resource,
      key,
    };
    const hash = createHash("sha256").update(canonical(input)).digest("hex");
    const old = await this.col("training_idempotency").findOne(filter, {
      session: ctx.session,
    });
    if (old) {
      if (old.request_hash !== hash)
        fail(409, "IDEMPOTENCY_CONFLICT", "请求编号已用于其他内容");
      return JSON.parse(old.result_json) as T;
    }
    const result = await work();
    const result_json = JSON.stringify(result);
    if (result_json.length > 65536)
      fail(422, "RESPONSE_TOO_LARGE", "请求结果超出上限");
    await this.col("training_idempotency").insertOne(
      { ...(await this.base(ctx)), ...filter, request_hash: hash, result_json },
      { session: ctx.session },
    );
    return result;
  }
  async audit(ctx: Context, name: string, row: Row, action: string) {
    if(name === "course") await enqueueKnowledge(this.db,ctx,"course",row._id);
    await this.access.audit(
      ctx,
      name,
      row._id,
      "training." + action,
      "培训工作台操作",
      { revision_after: row.revision },
    );
  }
  async cas(
    ctx: Context,
    name: string,
    row: Row,
    expected: unknown,
    set: Document,
    deadline?: Date,
  ) {
    if (row.revision !== v.integer(expected))
      fail(409, "REVISION_CONFLICT", "记录已更新，请重新加载");
    const result = await this.col(name).updateOne(
      {
        _id: row._id,
        org_id: ctx.orgId,
        revision: row.revision,
        ...(deadline ? { $expr: { $lt: ["$$NOW", deadline] } } : {}),
      },
      {
        $set: { ...set, updated_at: await this.access.now(ctx) },
        $inc: { revision: 1 },
      },
      { session: ctx.session },
    );
    if (
      result.modifiedCount !== 1 &&
      deadline &&
      (await this.access.now(ctx)) >= deadline
    )
      fail(409, "DEADLINE_PASSED", "已截止，请联系教师安排补交任务");
    if (result.modifiedCount !== 1)
      fail(409, "REVISION_CONFLICT", "记录已更新");
    return { ...row, ...set, revision: row.revision + 1 } as Row;
  }
  async teacherSubject(ctx: Context, subject: string, write = false) {
    const now = await this.access.now(ctx);
    const rows = await this.col("teaching_assignments")
      .find(
        {
          org_id: ctx.orgId,
          member_id: ctx.memberId,
          subject_id: subject,
          status: "active",
        },
        { session: ctx.session },
      )
      .limit(200)
      .toArray();
    for (const a of rows) {
      if (!currentlyValid(a as any, now)) continue;
      const c = await this.col("classes").findOne(
        { _id: a.class_id, org_id: ctx.orgId, status: "active" },
        { session: ctx.session },
      );
      if (c) {
        if (write) {
          await this.col("teaching_assignments").updateOne(
            { _id: a._id },
            { $inc: { revision: 1 } },
            { session: ctx.session },
          );
          await this.col("classes").updateOne(
            { _id: c._id },
            { $inc: { revision: 1 } },
            { session: ctx.session },
          );
        }
        return;
      }
    }
    fail(404, "NOT_FOUND", "学科未分配给当前教师");
  }
  async classAccess(
    ctx: Context,
    classId: string,
    subject: string,
    teacher: boolean,
    write = false,
  ) {
    if (teacher) {
      const { clazz, assignment } = await this.access.requireAssignment(
        ctx,
        classId,
        subject,
      );
      if (write) {
        await this.col("classes").updateOne(
          { _id: clazz._id },
          { $inc: { revision: 1 } },
          { session: ctx.session },
        );
        await this.col("teaching_assignments").updateOne(
          { _id: assignment._id },
          { $inc: { revision: 1 } },
          { session: ctx.session },
        );
      }
      return;
    }
    this.require(ctx, "learning:self");
    const now = await this.access.now(ctx);
    const c = await this.col("classes").findOne(
      { _id: classId, org_id: ctx.orgId, status: "active" },
      { session: ctx.session },
    );
    const m = await this.col("class_members").findOne(
      {
        org_id: ctx.orgId,
        class_id: classId,
        member_id: ctx.memberId,
        status: "active",
      },
      { session: ctx.session },
    );
    if (!c || !m || !currentlyValid(m as any, now))
      fail(404, "NOT_FOUND", "当前班级不可访问");
    if (write) {
      await this.col("classes").updateOne(
        { _id: c._id },
        { $inc: { revision: 1 } },
        { session: ctx.session },
      );
      await this.col("class_members").updateOne(
        { _id: m._id },
        { $set: { updated_at: now } },
        { session: ctx.session },
      );
    }
  }
  async courseAccess(
    ctx: Context,
    key: string,
    teacher: boolean,
    write = false,
  ) {
    const course = await this.row(ctx, "courses", key);
    if (teacher) {
      await this.teacherSubject(ctx, course.subject_id, write);
      await this.resources(ctx, course.lessons, write);
      return course;
    }
    if (course.status !== "published") fail(404, "NOT_FOUND", "课程不可访问");
    const links = await this.col("class_courses")
      .find(
        { org_id: ctx.orgId, course_id: key, status: "active" },
        { session: ctx.session },
      )
      .limit(200)
      .toArray();
    for (const link of links) {
      try {
        await this.classAccess(
          ctx,
          link.class_id,
          course.subject_id,
          false,
          write,
        );
        await this.resources(ctx, course.lessons, write);
        if(write && process.env.KL_KNOWLEDGE_ENABLED === "true"){
          const fenced=await this.col("class_courses").updateOne(
            {_id:link._id,org_id:ctx.orgId,status:"active",revision:link.revision},
            {$inc:{revision:1}},{session:ctx.session});
          if(fenced.modifiedCount !== 1)fail(409,"CONTEXT_CHANGED","课程分配已变化");
        }
        return course;
      } catch (e) {
        if ((e as any).status !== 404) throw e;
      }
    }
    fail(404, "NOT_FOUND", "课程未分配到当前班级");
  }
  async resources(ctx: Context, lessons: any[], write = false) {
    for (const lesson of lessons) {
      if (lesson.kind === "text") continue;
      const file = await this.col("file_resources").findOne(
        {
          _id: lesson.file_id,
          org_id: ctx.orgId,
          owner_type: "textbook",
          owner_version_id: lesson.owner_version_id,
          status: "ready",
          scan_status: "clean",
          deleted_at: null,
          deletion_requested_at: null,
          mime:
            lesson.kind === "pdf"
              ? "application/pdf"
              : lesson.kind === "video"
                ? "video/mp4"
                : "audio/mpeg",
        },
        { session: ctx.session },
      );
      const owner = await this.col("textbook_editions").findOne(
        {
          _id: lesson.owner_version_id,
          org_id: ctx.orgId,
          status: "published",
        },
        { session: ctx.session },
      );
      if (
        !file ||
        !owner ||
        !licensed(
          owner as BaseVersion,
          (await this.access.now(ctx)).getTime(),
        ) ||
        !owner.resource_ids.includes(lesson.file_id)
      )
        fail(404, "NOT_FOUND", "媒体资源不可访问");
      if (write) {
        await this.col("textbook_editions").updateOne(
          { _id: owner._id, access_revision: owner.access_revision },
          { $inc: { access_revision: 1 } },
          { session: ctx.session },
        );
        await this.col("file_resources").updateOne(
          { _id: file._id, updated_at: file.updated_at },
          { $set: { updated_at: await this.access.now(ctx) } },
          { session: ctx.session },
        );
      }
    }
  }
  async catalog(req: ApiRequest) {
    return this.run(req, false, async (ctx) => {
      const now = await this.access.now(ctx);
      const assigned = await this.col("teaching_assignments")
        .find(
          { org_id: ctx.orgId, member_id: ctx.memberId, status: "active" },
          { session: ctx.session },
        )
        .limit(200)
        .toArray();
      const classes = [],
        subjects = [],
        quizIds = [];
      const seenClasses = new Set<string>(),
        seenSubjects = new Set<string>();
      for (const a of assigned) {
        if (!currentlyValid(a as any, now)) continue;
        const c = await this.col("classes").findOne(
          { _id: a.class_id, org_id: ctx.orgId, status: "active" },
          { session: ctx.session },
        );
        if (!c) continue;
        if (!seenClasses.has(c._id)) {
          classes.push({ id: c._id, name: c.name });
          seenClasses.add(c._id);
        }
        if (!seenSubjects.has(a.subject_id)) {
          const subject = await this.col("subjects").findOne(
            { _id: a.subject_id },
            { session: ctx.session },
          );
          subjects.push({
            id: a.subject_id,
            name: subject?.name || "学科 " + a.subject_id,
          });
          seenSubjects.add(a.subject_id);
        }
        quizIds.push({ class_id: c._id, subject_id: a.subject_id });
      }
      const quizzes = await this.col("quizzes")
        .find(
          {
            org_id: ctx.orgId,
            status: "published",
            $or: quizIds.length
              ? quizIds.map((x) => ({
                  source_class_ids: x.class_id,
                  subject_id: x.subject_id,
                }))
              : [{ _id: "000000000000000000000000" }],
          },
          {
            session: ctx.session,
            projection: {
              _id: 1,
              title: 1,
              subject_id: 1,
              source_class_ids: 1,
            },
          },
        )
        .limit(200)
        .toArray();
      return { classes, subjects, assignments: quizIds, quizzes, surveys_enabled: process.env.KL_TRAINING_SURVEYS_ENABLED === "true", knowledge_enabled: process.env.KL_KNOWLEDGE_ENABLED === 'true', phase2_enabled: process.env.KL_TRAINING_PHASE2_ENABLED === 'true' };
    });
  }
  async listCourses(req: ApiRequest) {
    return this.run(req, false, async (ctx) => {
      const teacher = ctx.capabilities.some((x) =>
        [
          "training:schedule-manage",
        "training:path-edit",
        "training:path-review",
        "training:certificate-issue",
        "course:edit",
          "course:review",
          "course:assign",
          "task:manage",
          "coursework:grade",
          "ai:generate",
        ].includes(x),
      );
      if (!teacher) this.require(ctx, "learning:self");
      const rows = await this.col("courses")
        .find(
          { org_id: ctx.orgId, ...(!teacher ? { status: "published" } : {}) },
          { session: ctx.session },
        )
        .sort({ updated_at: -1 })
        .limit(200)
        .toArray();
      const out = [];
      for (const r of rows) {
        try {
          await this.courseAccess(ctx, r._id, teacher);
          out.push({
            id: r._id,
            title: r.title,
            status: r.status,
            revision: r.revision,
            subject_id: r.subject_id,
            version_no: r.version_no,
            lesson_count: r.lessons.length,
          });
        } catch (e) {
          if ((e as any).status !== 404) throw e;
        }
      }
      return { items: out, limit: 200 };
    });
  }
  async course(req: ApiRequest, key: string, learner=false) {
    return this.run(req, false, async (ctx) => {
      if(learner)this.require(ctx,"learning:self");
      const teacher = !learner && ctx.capabilities.some((x) =>
        [
          "training:schedule-manage",
        "training:path-edit",
        "training:path-review",
        "training:certificate-issue",
        "course:edit",
          "course:review",
          "course:assign",
          "task:manage",
          "coursework:grade",
          "ai:generate",
        ].includes(x),
      );
      const c = await this.courseAccess(ctx, key, teacher);
      return {
        ...c,
        progress: teacher
          ? []
          : await this.col("course_progress")
              .find(
                { org_id: ctx.orgId, member_id: ctx.memberId, course_id: key },
                { session: ctx.session },
              )
              .toArray(),
      };
    });
  }
  lessons(input: unknown) {
    if (!Array.isArray(input) || !input.length || input.length > 100)
      fail(422, "INVALID_LESSONS", "课程须有1至100个课节");
    const rows = input.map((x) => {
      const o = v.object(x, [
        "key",
        "title",
        "kind",
        "required",
        "body",
        "file_id",
        "owner_version_id",
      ]);
      const key = v.text(o.key, 64);
      if (!/^[a-z0-9_-]+$/.test(key) || typeof o.required !== "boolean")
        fail(422, "INVALID_LESSONS", "课节标识或必修字段无效");
      if (!["text", "pdf", "video", "audio"].includes(o.kind))
        fail(422, "MEDIA_NOT_SUPPORTED", "课节类型无效");
      if (
        o.kind === "text" &&
        (o.file_id !== null || o.owner_version_id !== null)
      )
        fail(422, "INVALID_FILE_REFERENCE", "文本课节不能绑定附件");
      return {
        key,
        title: v.text(o.title),
        kind: o.kind,
        required: o.required,
        body: v.text(o.body, 16000, o.kind !== "text"),
        file_id: o.kind !== "text" ? v.id(o.file_id) : null,
        owner_version_id: o.kind !== "text" ? v.id(o.owner_version_id) : null,
      };
    });
    if (
      new Set(rows.map((x) => x.key)).size !== rows.length ||
      JSON.stringify(rows).length > 40000
    )
      fail(422, "INVALID_LESSONS", "课节重复或课程过大");
    return rows;
  }
  async receipt(req: ApiRequest, input: unknown) {
    const o = v.object(input, ["key"]);
    const key = v.text(o.key, 128);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key))
      fail(422, "INVALID_KEY", "请求编号无效");
    return this.run(req, true, async (ctx) => {
      const records = await this.col("training_idempotency")
        .find(
          { org_id: ctx.orgId, user_id: ctx.userId, key },
          { session: ctx.session },
        )
        .limit(2)
        .toArray();
      if (records.length > 1)
        fail(409, "AMBIGUOUS_RECEIPT", "请求编号关联多个资源，请按原资源核对");
      const row = records[0];
      if (!row) return { status: "not_found" };
      const result = JSON.parse(row.result_json),
        operation = row.operation as string;
      if (operation.startsWith("course.")) {
        this.require(
          ctx,
          operation === "course.progress"
            ? "learning:self"
            : operation === "course.assign"
              ? "course:assign"
              : ["course.publish", "course.reject", "course.retire"].includes(
                    operation,
                  )
                ? "course:review"
                : "course:edit",
        );
        await this.courseAccess(
          ctx,
          operation === "course.create" ? result._id : row.resource_id,
          operation !== "course.progress",
        );
        if(operation === "course.assign"){const course=await this.row(ctx,"courses",row.resource_id);await this.classAccess(ctx,v.id(result.class_id),course.subject_id,true);}
      } else if (operation.startsWith("report.")) {
        if(process.env.KL_TRAINING_REPORTS_ENABLED!=='true')fail(503,'TRAINING_REPORTS_DISABLED','报告发布尚未启用');
        this.require(ctx,['report.publish','report.reject'].includes(operation)?'training:report-review':'training:report-edit');
        const report=await this.row(ctx,'training_reports',result._id);
        await this.classAccess(ctx,report.class_id,report.subject_id,true);
      } else if (operation.startsWith("task.")) {
        this.require(ctx, "task:manage");
        await this.taskAccess(
          ctx,
          operation === "task.create" ? result._id : row.resource_id,
          true,
        );
      } else if (operation.startsWith("coursework.")) {
        this.require(
          ctx,
          operation === "coursework.feedback"
            ? "coursework:grade"
            : "learning:self",
        );
        const task = await this.taskAccess(
          ctx,
          result.task_id,
          operation === "coursework.feedback",
        );
        if (operation === "coursework.feedback") {
          const submission = await this.row(
            ctx,
            "coursework_submissions",
            result.submission_id,
          );
          await this.learnerCurrent(
            ctx,
            submission.user_id,
            submission.member_id,
            task.class_id,
          );
        }
      } else if (operation === "knowledge.rebuild") {
        if(process.env.KL_KNOWLEDGE_ENABLED !== "true")fail(503,"KNOWLEDGE_DISABLED","知识库尚未启用");
        this.require(ctx,"ai:manage");
      } else if (operation === "ai.configure") {
        this.require(ctx, "ai:manage");
      } else if (operation.startsWith("ai.")) {
        const job = await this.row(
          ctx,
          "ai_jobs",
          operation === "ai.create" ? result.id : row.resource_id,
        );
        this.require(
          ctx,
          operation === "ai.recover"
            ? "ai:manage"
            : job.kind === "assist"
              ? "ai:assist"
              : "ai:generate",
        );
        if (job.user_id !== ctx.userId && operation !== "ai.recover")
          fail(404, "NOT_FOUND", "回执不可访问");
        if (operation !== "ai.recover") {
          if (job.kind === "learning-report") {
            if(process.env.KL_AI_LEARNING_REPORTS_ENABLED !== "true" || process.env.KL_AI_POLICY_ENABLED !== "true") fail(503,"AI_LEARNING_REPORTS_DISABLED","AI学情解读尚未启用");
            this.require(ctx,"training:report-edit");
            const report = await this.row(ctx,"training_reports",job.context_id);
            await this.classAccess(ctx,report.class_id,report.subject_id,true);
            // Receipts confirm acceptance only; generated output must pass the live AI source check through GET.
            if(operation !== "ai.accept-report") return {status:"confirmed",result:{id:job._id,kind:job.kind,context_id:job.context_id,status:job.status,revision:job.revision,output:"",citations:[],error_code:job.error_code,created_at:job.created_at}};
          } else if (job.kind === "report")
            await this.taskAccess(ctx, job.context_id, true);
          else
            await this.courseAccess(ctx, job.context_id, job.kind !== "assist");
          if(job.knowledge_scope) return {status:"confirmed",result:{id:job._id,kind:job.kind,
            context_id:job.context_id,status:job.status,revision:job.revision,output:"",citations:[],
            error_code:job.error_code,created_at:job.created_at}};
        }
        if (operation === "ai.accept" || operation === "ai.accept-question") {
          const source =
            job.kind === "report"
              ? await this.taskAccess(ctx, job.context_id, true)
              : await this.courseAccess(ctx, job.context_id, true);
          if (
            source.status !== "published" ||
            source.revision !== job.context_revision
          )
            fail(404, "NOT_FOUND", "采纳来源已不可访问");
          if (operation === "ai.accept") {
            this.require(ctx, "course:edit");
            await this.courseAccess(ctx, result._id, true);
          } else {
            this.require(ctx, "content:edit");
            const target = await this.row(ctx, "question_versions", result.id);
            if (
              target.access_revoked_at !== null ||
              target.status === "retired" ||
              target.created_by !== ctx.userId
            )
              fail(404, "NOT_FOUND", "题目草稿不可访问");
            await this.teacherSubject(ctx, target.subject_id);
          }
        }
      } else if (operation.startsWith("site.")) {
        this.require(
          ctx,
          operation === "site.publish"
            ? "site:review"
            : operation === "site.lead-status"
              ? "site:lead-read"
              : "site:edit",
        );
        if (ctx.orgId !== process.env.KL_SITE_ORG_ID)
          fail(404, "NOT_FOUND", "回执不可访问");
      } else fail(404, "NOT_FOUND", "回执不可访问");
      return { status: "confirmed", result };
    });
  }
  async createCourse(req: ApiRequest, input: unknown) {
    const o = v.object(input, [
      "code",
      "title",
      "subject_id",
      "version_no",
      "lessons",
    ]);
    const payload = {
      code: v.text(o.code, 100),
      title: v.text(o.title),
      subject_id: v.id(o.subject_id),
      version_no: v.integer(o.version_no),
      lessons: this.lessons(o.lessons),
    };
    return this.run(req, true, async (ctx) => {
      this.require(ctx, "course:edit");
      await this.teacherSubject(ctx, payload.subject_id, true);
      await this.resources(ctx, payload.lessons, true);
      return this.idem(
        ctx,
        req,
        "course.create",
        payload.subject_id,
        payload,
        async () => {
          const r = {
            ...(await this.base(ctx)),
            ...payload,
            status: "draft",
            author_id: ctx.userId,
            contributors: [ctx.userId],
            reviewer_id: null,
            review_note: "",
          };
          await this.col("courses").insertOne(r, { session: ctx.session });
          await this.audit(ctx, "course", r, "course.create");
          return r;
        },
      );
    });
  }
  async changeCourse(req: ApiRequest, key: string, input: unknown) {
    const o = v.object(input, [
      "expected_revision",
      "action",
      "title",
      "lessons",
      "note",
    ]);
    const action = v.text(o.action, 30);
    if (
      !["edit", "request-review", "publish", "reject", "retire"].includes(
        action,
      )
    )
      fail(422, "INVALID_ACTION", "课程操作无效");
    return this.run(req, true, async (ctx) => {
      this.require(
        ctx,
        ["publish", "reject", "retire"].includes(action)
          ? "course:review"
          : "course:edit",
      );
      const c = await this.courseAccess(ctx, key, true, true);
      return this.idem(ctx, req, "course." + action, key, o, async () => {
        let set: Document = {};
        if (
          ["request-review", "publish"].includes(action) &&
          !c.lessons.some((l: any) => l.required)
        )
          fail(422, "REQUIRED_LESSON_MISSING", "至少需要一个必修课节");
        if (action === "edit") {
          if (c.status !== "draft" || c.author_id !== ctx.userId)
            fail(409, "INVALID_STATE", "仅作者可编辑草稿");
          set = { title: v.text(o.title), lessons: this.lessons(o.lessons) };
        }
        if (action === "request-review") {
          if (c.status !== "draft" || c.author_id !== ctx.userId)
            fail(409, "INVALID_STATE", "仅作者可提交草稿审核");
          set = { status: "review" };
        }
        if (["publish", "reject"].includes(action)) {
          if (c.status !== "review" || c.contributors.includes(ctx.userId))
            fail(403, "INDEPENDENT_REVIEW_REQUIRED", "课程需要独立审核人");
          set = {
            status: action === "publish" ? "published" : "draft",
            reviewer_id: ctx.userId,
            review_note: v.text(o.note, 4000, true),
          };
        }
        if (action === "retire") {
          if (c.status !== "published")
            fail(409, "INVALID_STATE", "仅已发布课程可退役");
          set = { status: "retired", review_note: v.text(o.note, 4000) };
        }
        if (set.lessons) await this.resources(ctx, set.lessons, true);
        const r = await this.cas(ctx, "courses", c, o.expected_revision, set);
        await this.audit(ctx, "course", r, "course." + action);
        return r;
      });
    });
  }
  async previewAssignments(req:ApiRequest,key:string,input:unknown){
    const o=v.object(input,["class_ids"]);if(!Array.isArray(o.class_ids)||!o.class_ids.length||o.class_ids.length>20)fail(422,"BATCH_LIMIT","请选择1至20个班级");const ids=o.class_ids.map(v.id);if(new Set(ids).size!==ids.length)fail(422,"DUPLICATE_CLASSES","班级编号不能重复");
    return this.run(req,false,async ctx=>{this.require(ctx,"course:assign");const course=await this.courseAccess(ctx,key,true);if(course.status!=="published")fail(409,"INVALID_STATE","仅可分配已发布课程");const items=[];
      for(const id of ids){try{await this.classAccess(ctx,id,course.subject_id,true);const clazz=await this.row(ctx,"classes",id);const link=await this.col("class_courses").findOne({org_id:ctx.orgId,class_id:id,course_id:key},{session:ctx.session});items.push({class_id:id,name:clazz.name,status:link?(link.status==="active"?"already_assigned":"conflict"):"ready"});}catch(e){const status=(e as any).getStatus?.()??(e as any).status;if(![403,404].includes(status))throw e;items.push({class_id:id,status:"forbidden"});}}
      return {course_id:key,items};});
  }
  async assignCourse(req: ApiRequest, key: string, input: unknown) {
    const o = v.object(input, ["class_id"]);
    const classId = v.id(o.class_id);
    if(managedApiEnabled())return this.assignManaged(req,key,classId);
    return this.run(req, true, async (ctx) => {
      this.require(ctx, "course:assign");
      const c = await this.courseAccess(ctx, key, true, true);
      await this.classAccess(ctx, classId, c.subject_id, true, true);
      if (c.status !== "published")
        fail(409, "INVALID_STATE", "仅可分配已发布版本");
      return this.idem(ctx, req, "course.assign", key, o, async () => {
        const existing=await this.col("class_courses").findOne({org_id:ctx.orgId,class_id:classId,course_id:key},{session:ctx.session});
        if(existing){if(existing.status!=="active")fail(409,"ASSIGNMENT_ENDED","已结束的课程分配不能自动恢复");return {course_id:key,class_id:classId,status:"already_assigned"};}

        const r = {
          ...(await this.base(ctx)),
          class_id: classId,
          course_id: key,
          subject_id: c.subject_id,
          status: "active",
        };
        await this.col("class_courses").updateOne(
          { org_id: ctx.orgId, class_id: classId, course_id: key },
          { $setOnInsert: r },
          { upsert: true, session: ctx.session },
        );
        await this.audit(ctx, "course", c, "course.assign");
        return { course_id: key, class_id: classId, status:"assigned" };
      });
    });
  }
  private async assignManaged(req:ApiRequest,key:string,classId:string){
    if(process.env.KL_TRAINING_ENABLED!=='true')fail(503,'TRAINING_DISABLED','培训扩展尚未启用');
    await assertManagedInvocation(this.db);
    const idem=req.get('Idempotency-Key');if(!idem||!/^[A-Za-z0-9_-]{8,128}$/.test(idem))fail(422,'IDEMPOTENCY_KEY_REQUIRED','请提供8至128字符幂等键');
    return this.access.run(req,true,async ctx=>{
      if(ctx.platform)fail(503,'STANDALONE_MODULE_UNAVAILABLE','单例分配暂不支持平台委派入口');
      this.require(ctx,'course:assign');
      const course=await this.courseAccess(ctx,key,true);await this.classAccess(ctx,classId,course.subject_id,true);
      if(course.status!=='published')fail(409,'INVALID_STATE','仅可分配已发布课程');
      const old=await this.col('class_courses').findOne({org_id:ctx.orgId,class_id:classId,course_id:key});
      if(old&&old.status!=='active')fail(409,'ASSIGNMENT_ENDED','已结束的课程分配不能自动恢复');
      const plan={orgId:ctx.orgId,userId:ctx.userId,memberId:ctx.memberId,courseId:key,classId,subjectId:course.subject_id,courseRevision:course.revision,key:idem,timestamp:await this.access.now(ctx)};
      const verify=()=>this.access.run(req,true,async fresh=>{
        await assertManagedInvocation(this.db);
        if(fresh.platform||fresh.userId!==plan.userId||fresh.memberId!==plan.memberId||fresh.orgId!==plan.orgId)fail(403,'FORBIDDEN','当前身份已变化');
        this.require(fresh,'course:assign');const current=await this.courseAccess(fresh,key,true);
        if(current.status!=='published'||current.revision!==plan.courseRevision||current.subject_id!==plan.subjectId)fail(409,'CONTEXT_CHANGED','课程版本已变化');
        await this.classAccess(fresh,classId,plan.subjectId,true);
      });
      try{return await new AssignmentRecoveryRunner(this.db,rawDatabase(this.db)).run(plan,verify,process.env.KL_KNOWLEDGE_ENABLED==='true');}
      catch(error){if(error instanceof Error&&/^ASSIGNMENT_(PLAN_CONFLICT|RECOVERY_CONFLICT|RECOVERY_CHANGED|ENDED|RECEIPT_CONFLICT)$/.test(error.message))fail(409,'ASSIGNMENT_CONFLICT','原请求或关联状态已变化');throw error;}
    });
  }
  async progress(req: ApiRequest, key: string, input: unknown) {
    const o = v.object(input, ["lesson_key", "position", "complete"]);
    const lesson_key = v.text(o.lesson_key, 64),
      position = v.integer(o.position, 0, 86400);
    if (typeof o.complete !== "boolean")
      fail(422, "INVALID_INPUT", "完成标志无效");
    return this.run(req, true, async (ctx) => {
      this.require(ctx, "learning:self");
      const c = await this.courseAccess(ctx, key, false, true);
      if (!c.lessons.some((l: any) => l.key === lesson_key))
        fail(404, "NOT_FOUND", "课节不存在");
      return this.idem(ctx, req, "course.progress", key, o, async () => {
        const f = {
          org_id: ctx.orgId,
          member_id: ctx.memberId,
          course_id: key,
          lesson_key,
        };
        const old = await this.col("course_progress").findOne(f, {
          session: ctx.session,
        });
        const now = await this.access.now(ctx);
        if (old) {
          await this.col("course_progress").updateOne(
            { _id: old._id },
            {
              $set: {
                position,
                completed_at: old.completed_at ?? (o.complete ? now : null),
                updated_at: now,
              },
              $inc: { revision: 1 },
            },
            { session: ctx.session },
          );
        } else
          await this.col("course_progress").insertOne(
            {
              ...(await this.base(ctx)),
              ...f,
              user_id: ctx.userId,
              position,
              completed_at: o.complete ? now : null,
            },
            { session: ctx.session },
          );
        return {
          lesson_key,
          position,
          completed: !!old?.completed_at || o.complete,
        };
      });
    });
  }
  async taskAccess(ctx: Context, key: string, teacher: boolean, write = false) {
    const t = await this.row(ctx, "training_tasks", key);
    await this.classAccess(ctx, t.class_id, t.subject_id, teacher, write);
    if (
      !teacher &&
      (t.status !== "published" || !t.recipients.includes(ctx.memberId))
    )
      fail(404, "NOT_FOUND", "任务不可访问");
    return t;
  }
  async tasks(req: ApiRequest) {
    return this.run(req, false, async (ctx) => {
      const teacher =
        ctx.capabilities.includes("task:manage") ||
        ctx.capabilities.includes("coursework:grade") ||
        ctx.capabilities.includes("ai:generate");
      if (!teacher) this.require(ctx, "learning:self");
      const rows = await this.col("training_tasks")
        .find(
          {
            org_id: ctx.orgId,
            ...(!teacher
              ? { recipients: ctx.memberId, status: "published" }
              : {}),
          },
          { session: ctx.session },
        )
        .sort({ due_at: 1 })
        .limit(200)
        .toArray();
      const items = [];
      for (const r of rows) {
        try {
          await this.taskAccess(ctx, r._id, teacher);
          items.push(r);
        } catch (e) {
          if ((e as any).status !== 404) throw e;
        }
      }
      return { items, limit: 200 };
    });
  }
  async createTask(req: ApiRequest, input: unknown) {
    const o = v.object(input, [
      "class_id",
      "subject_id",
      "title",
      "target_type",
      "target_id",
      "due_at",
      "body",
      "rubric",
    ]);
    const payload = {
      class_id: v.id(o.class_id),
      subject_id: v.id(o.subject_id),
      title: v.text(o.title),
      target_type: v.text(o.target_type, 20),
      target_id: o.target_id === null ? null : v.id(o.target_id),
      due_at: v.date(o.due_at),
      body: v.text(o.body, 16000, true),
      rubric: o.target_type === "coursework" ? v.rubric(o.rubric) : [],
    };
    if (!["course", "coursework", "quiz"].includes(payload.target_type))
      fail(422, "INVALID_TARGET", "任务类型无效");
    return this.run(req, true, async (ctx) => {
      this.require(ctx, "task:manage");
      await this.classAccess(
        ctx,
        payload.class_id,
        payload.subject_id,
        true,
        true,
      );
      if (payload.due_at <= (await this.access.now(ctx)))
        fail(422, "INVALID_DEADLINE", "截止时间须在未来");
      if (payload.target_type === "coursework" && payload.target_id !== null)
        fail(422, "INVALID_TARGET", "作业任务不引用其他资源");
      if (payload.target_type === "course") {
        const c = await this.courseAccess(
          ctx,
          v.id(payload.target_id),
          true,
          true,
        );
        const link = await this.col("class_courses").findOne(
          {
            org_id: ctx.orgId,
            class_id: payload.class_id,
            course_id: c._id,
            status: "active",
          },
          { session: ctx.session },
        );
        if (
          c.status !== "published" ||
          c.subject_id !== payload.subject_id ||
          !link
        )
          fail(422, "INVALID_TARGET", "课程版本须已分配给班级");
      }
      if (payload.target_type === "quiz") {
        const q = await this.row(ctx, "quizzes", v.id(payload.target_id));
        if (
          q.status !== "published" ||
          q.subject_id !== payload.subject_id ||
          !q.source_class_ids?.includes(payload.class_id)
        )
          fail(422, "INVALID_TARGET", "考试须已发布且来源为该班级");
      }
      return this.idem(
        ctx,
        req,
        "task.create",
        payload.class_id,
        o,
        async () => {
          const r = {
            ...(await this.base(ctx)),
            ...payload,
            status: "draft",
            created_by: ctx.userId,
            recipients: [],
            published_at: null,
          };
          await this.col("training_tasks").insertOne(r, {
            session: ctx.session,
          });
          await this.audit(ctx, "task", r, "task.create");
          return r;
        },
      );
    });
  }
  async changeTask(req: ApiRequest, key: string, input: unknown) {
    const o = v.object(input, ["expected_revision", "action"]);
    if (!["publish", "cancel"].includes(o.action))
      fail(422, "INVALID_ACTION", "任务操作无效");
    return this.run(req, true, async (ctx) => {
      this.require(ctx, "task:manage");
      const t = await this.taskAccess(ctx, key, true, true);
      return this.idem(ctx, req, "task." + o.action, key, o, async () => {
        const now = await this.access.now(ctx);
        let set: Document = { status: "cancelled" };
        if (o.action === "publish") {
          if (t.status !== "draft" || t.due_at <= now)
            fail(409, "INVALID_STATE", "任务不能发布");
          if (t.target_type === "course") {
            const c = await this.courseAccess(ctx, t.target_id, true, true);
            const link = await this.col("class_courses").findOne(
              {
                org_id: ctx.orgId,
                class_id: t.class_id,
                course_id: c._id,
                status: "active",
              },
              { session: ctx.session },
            );
            if (
              c.status !== "published" ||
              c.subject_id !== t.subject_id ||
              !link
            )
              fail(409, "INVALID_TARGET", "课程目标已不可用");
          }
          if (t.target_type === "quiz") {
            const q = await this.row(ctx, "quizzes", t.target_id);
            if (
              q.status !== "published" ||
              q.subject_id !== t.subject_id ||
              !q.source_class_ids?.includes(t.class_id)
            )
              fail(409, "INVALID_TARGET", "考试目标已不可用");
          }
          const rows = await this.col("class_members")
            .find(
              { org_id: ctx.orgId, class_id: t.class_id, status: "active" },
              { session: ctx.session },
            )
            .limit(201)
            .toArray();
          if (rows.length > 200) fail(422, "ROSTER_LIMIT", "班级超过200人");
          const recipients = [];
          for (const r of rows) {
            if (!currentlyValid(r as any, now)) continue;
            const m = await this.col("organization_members").findOne(
              { _id: r.member_id, org_id: ctx.orgId, status: "active" },
              { session: ctx.session },
            );
            if (!m) continue;
            const u = await this.col("users").findOne(
              { _id: m.user_id, status: "active", privacy_state: "active" },
              { session: ctx.session },
            );
            if (!u || u.must_change_password) continue;
            if (
              r.kind !== "student" ||
              !(await this.col("member_roles").findOne(
                {
                  org_id: ctx.orgId,
                  member_id: r.member_id,
                  role_id: "student",
                },
                { session: ctx.session },
              ))
            )
              continue;
            const conflicts = [
              "content:edit",
              "content:review",
              "assessment:manage",
              "assessment:review",
              "training:schedule-manage",
        "training:path-edit",
        "training:path-review",
        "training:certificate-issue",
        "course:edit",
              "course:review",
              "coursework:grade",
              "ai:generate",
            ];
            const roles = await this.col("member_roles")
              .find(
                { org_id: ctx.orgId, member_id: r.member_id },
                { session: ctx.session },
              )
              .toArray();
            const roleCaps = await this.col("roles")
              .find(
                { _id: { $in: roles.map((x) => x.role_id) } },
                { session: ctx.session },
              )
              .toArray();
            if (
              roleCaps.some((x) =>
                x.capabilities.some((cap: string) => conflicts.includes(cap)),
              )
            )
              continue;
            if (
              await this.col("member_capability_grants").findOne(
                {
                  org_id: ctx.orgId,
                  member_id: r.member_id,
                  capability: { $in: conflicts },
                  status: "active",
                  valid_from: { $lte: now },
                  $or: [{ valid_to: null }, { valid_to: { $gt: now } }],
                },
                { session: ctx.session },
              )
            )
              continue;
            if (
              (
                await scopedBusinessCapabilities(
                  this.db,
                  m.user_id,
                  ctx.orgId,
                  ctx.session,
                )
              ).some((cap) => conflicts.includes(cap))
            )
              continue;
            await requireEvidenceSubject(
              this.db,
              ctx.session,
              m.user_id,
              ctx.orgId,
            );
            recipients.push(r.member_id);
          }
          if (!recipients.length) fail(422, "EMPTY_ROSTER", "班级没有有效学员");
          set = { status: "published", published_at: now, recipients };
        } else if (t.status === "cancelled")
          fail(409, "INVALID_STATE", "任务已经取消");
        const r = await this.cas(
          ctx,
          "training_tasks",
          t,
          o.expected_revision,
          set,
        );
        await this.audit(ctx, "task", r, "task." + o.action);
        await this.phase2TaskNotification(ctx,r,o.action==='publish'?'新的学习任务已发布':'学习任务已取消',r.recipients);
        return r;
      });
    });
  }
  async phase2TaskNotification(ctx:Context,task:Row,message:string,recipients:string[]){
    if(process.env.KL_TRAINING_PHASE2_ENABLED!=='true')return;
    for(const memberId of [...new Set(recipients)]){const member=await this.col('organization_members').findOne({_id:memberId,org_id:ctx.orgId,status:'active'},{session:ctx.session});if(!member)continue;await requireEvidenceSubject(this.db,ctx.session,member.user_id,ctx.orgId);await this.col('training_notification_outbox').insertOne({...await this.base(ctx),user_id:member.user_id,member_id:memberId,source_type:'task',source_id:task._id,message,status:'pending',lease_token:null,lease_until:null},{session:ctx.session});}
  }
  async fenceTaskFacts(ctx: Context, task: Row) {
    const result = await this.col("training_tasks").updateOne(
      { _id: task._id, org_id: ctx.orgId, revision: task.revision },
      {
        $inc: { revision: 1 },
        $set: { updated_at: await this.access.now(ctx) },
      },
      { session: ctx.session },
    );
    if (result.modifiedCount !== 1)
      fail(409, "REVISION_CONFLICT", "任务事实已变化");
  }
  async coursework(req: ApiRequest, key: string) {
    return this.run(req, false, async (ctx) => {
      this.require(ctx, "learning:self");
      const task = await this.taskAccess(ctx, key, false);
      const head = await this.col("coursework_heads").findOne(
        { org_id: ctx.orgId, task_id: key, member_id: ctx.memberId },
        { session: ctx.session },
      );
      const submissions = await this.col("coursework_submissions")
        .find(
          { org_id: ctx.orgId, task_id: key, member_id: ctx.memberId },
          { session: ctx.session },
        )
        .sort({ submission_no: -1 })
        .limit(100)
        .toArray();
      const feedback = head?.current_feedback_id
        ? await this.col("coursework_feedback")
            .find(
              {
                _id: head.current_feedback_id,
                org_id: ctx.orgId,
                submission_id: head.current_submission_id,
                status: "published",
              },
              { session: ctx.session },
            )
            .toArray()
        : [];
      return {
        task,
        head,
        submissions,
        feedback,
        server_now: await this.access.now(ctx),
        attachments_enabled: process.env.KL_COURSEWORK_FILES_ENABLED === "true",
      };
    });
  }
  async writeCoursework(req: ApiRequest, key: string, input: unknown) {
    const o = v.object(input, [
      "expected_revision",
      "action",
      "body",
      "file_ids",
    ]);
    const fileIds = o.file_ids === undefined ? undefined : o.file_ids;
    if (
      fileIds !== undefined &&
      (process.env.KL_COURSEWORK_FILES_ENABLED !== "true" ||
        !Array.isArray(fileIds) ||
        fileIds.length > 5 ||
        new Set(fileIds).size !== fileIds.length ||
        fileIds.some(
          (id: unknown) => typeof id !== "string" || !/^[0-9a-f]{24}$/.test(id),
        ))
    )
      fail(422, "INVALID_FILES", "附件编号须唯一且最多5个");
    if (!["save", "submit"].includes(o.action))
      fail(422, "INVALID_ACTION", "作业操作无效");
    const body = v.text(o.body, 16000, o.action === "save");
    const expected = v.integer(o.expected_revision, 0);
    return this.run(req, true, async (ctx) => {
      this.require(ctx, "learning:self");
      const task = await this.taskAccess(ctx, key, false, true);
      if (task.target_type !== "coursework")
        fail(409, "INVALID_STATE", "任务不是作业");
      return this.idem(ctx, req, "coursework." + o.action, key, o, async () => {
        if ((await this.access.now(ctx)) >= task.due_at)
          fail(409, "DEADLINE_PASSED", "已截止，请联系教师安排补交任务");
        const filter = {
          org_id: ctx.orgId,
          member_id: ctx.memberId,
          task_id: key,
        };
        let head = await this.col("coursework_heads").findOne(filter, {
          session: ctx.session,
        });
        if ((head?.revision ?? 0) !== expected)
          fail(409, "REVISION_CONFLICT", "作业已被其他窗口修改");
        if (!head) {
          head = {
            ...(await this.base(ctx)),
            ...filter,
            user_id: ctx.userId,
            draft: "",
            current_submission_id: null,
            current_feedback_id: null,
            submission_no: 0,
          };
          await this.col("coursework_heads").insertOne(head, {
            session: ctx.session,
          });
        }
        const selectedFiles = fileIds ?? head.file_ids ?? [];
        if (selectedFiles.length) {
          for (const id of selectedFiles) {
            const file = await this.col("file_resources").findOne(
              {
                _id: id,
                org_id: ctx.orgId,
                owner_type: "coursework",
                owner_version_id: head._id,
                created_by: ctx.userId,
                status: "ready",
                scan_status: "clean",
                deleted_at: null,
                deletion_requested_at: null,
              },
              { session: ctx.session },
            );
            if (!file)
              fail(409, "FILE_NOT_READY", "附件尚未通过扫描或归属不符");
            const fenced = await this.col("file_resources").updateOne(
              {
                _id: id,
                status: "ready",
                scan_status: "clean",
                deleted_at: null,
                deletion_requested_at: null,
                updated_at: file.updated_at,
              },
              { $set: { updated_at: await this.access.now(ctx) } },
              { session: ctx.session },
            );
            if (fenced.matchedCount !== 1)
              fail(409, "FILE_CONFLICT", "附件状态已变化");
          }
        }
        const set: Document = {
          draft: body,
          ...(process.env.KL_COURSEWORK_FILES_ENABLED === "true"
            ? { file_ids: selectedFiles }
            : {}),
        };
        if (o.action === "submit") {
          const submission = {
            ...(await this.base(ctx)),
            ...filter,
            user_id: ctx.userId,
            head_id: head._id,
            submission_no: head.submission_no + 1,
            body,
            ...(process.env.KL_COURSEWORK_FILES_ENABLED === "true"
              ? { file_ids: selectedFiles }
              : {}),
            submitted_at: await this.access.now(ctx),
          };
          await this.col("coursework_submissions").insertOne(submission, {
            session: ctx.session,
          });
          set.current_submission_id = submission._id;
          set.current_feedback_id = null;
          set.submission_no = submission.submission_no;
          await this.audit(ctx, "coursework", submission, "coursework.submit");
        }
        await this.fenceTaskFacts(ctx, task);
        return this.cas(
          ctx,
          "coursework_heads",
          head,
          head.revision,
          set,
          task.due_at,
        );
      });
    });
  }
  async learnerCurrent(
    ctx: Context,
    userId: string,
    memberId: string,
    classId: string,
    write = false,
  ) {
    const now = await this.access.now(ctx);
    const user = await this.col("users").findOne(
      { _id: userId, status: "active", privacy_state: "active" },
      { session: ctx.session },
    );
    const member = await this.col("organization_members").findOne(
      { _id: memberId, user_id: userId, org_id: ctx.orgId, status: "active" },
      { session: ctx.session },
    );
    const link = await this.col("class_members").findOne(
      {
        org_id: ctx.orgId,
        class_id: classId,
        member_id: memberId,
        status: "active",
        kind: "student",
      },
      { session: ctx.session },
    );
    if (!user || !member || !link || !currentlyValid(link as any, now))
      fail(404, "NOT_FOUND", "学员当前不可访问");
    if (write)
      await this.col("class_members").updateOne(
        { _id: link!._id },
        { $set: { updated_at: now } },
        { session: ctx.session },
      );
  }
  async submissions(req: ApiRequest, key: string) {
    return this.run(req, false, async (ctx) => {
      this.require(ctx, "coursework:grade");
      const task = await this.taskAccess(ctx, key, true);
      const heads = await this.col("coursework_heads")
        .find({ org_id: ctx.orgId, task_id: key }, { session: ctx.session })
        .limit(200)
        .toArray();
      const items = [];
      for (const h of heads) {
        if (!h.current_submission_id) continue;
        try {
          await this.learnerCurrent(ctx, h.user_id, h.member_id, task.class_id);
        } catch (e) {
          if ((e as any).status === 404) continue;
          throw e;
        }
        items.push({
          head: h,
          submission: await this.row(
            ctx,
            "coursework_submissions",
            h.current_submission_id,
          ),
          feedback: await this.col("coursework_feedback")
            .find(
              { org_id: ctx.orgId, submission_id: h.current_submission_id },
              { session: ctx.session },
            )
            .toArray(),
        });
      }
      return { items };
    });
  }
  async feedback(req: ApiRequest, key: string, input: unknown) {
    const o = v.object(input, [
      "head_revision",
      "submission_id",
      "comments",
      "scores",
      "publish",
    ]);
    const submissionId = v.id(o.submission_id),
      comments = v.text(o.comments, 8000, true);
    if (
      !Array.isArray(o.scores) ||
      o.scores.length > 20 ||
      typeof o.publish !== "boolean"
    )
      fail(422, "INVALID_INPUT", "评分字段无效");
    const scores = o.scores.map((s: unknown) => {
      const x = v.object(s, ["key", "score"]);
      return { key: v.text(x.key, 64), score: v.integer(x.score, 0, 100) };
    });
    return this.run(req, true, async (ctx) => {
      this.require(ctx, "coursework:grade");
      const task = await this.taskAccess(ctx, key, true, true);
      const sub = await this.row(ctx, "coursework_submissions", submissionId);
      if (sub.task_id !== key) fail(404, "NOT_FOUND", "提交不属于该任务");
      const head = await this.row(ctx, "coursework_heads", sub.head_id);
      await this.learnerCurrent(
        ctx,
        sub.user_id,
        sub.member_id,
        task.class_id,
        true,
      );
      return this.idem(
        ctx,
        req,
        "coursework.feedback",
        submissionId,
        o,
        async () => {
          if (head.current_submission_id !== submissionId)
            fail(409, "STALE_SUBMISSION", "学员已重新提交，请重新批阅");
          if (
            scores.length !== task.rubric.length ||
            new Set(scores.map((s: any) => s.key)).size !== scores.length ||
            scores.some(
              (s: any) => !task.rubric.some((r: any) => r.key === s.key),
            )
          )
            fail(422, "INVALID_SCORES", "请填写全部评分维度");
          await requireEvidenceSubject(
            this.db,
            ctx.session,
            sub.user_id,
            ctx.orgId,
          );
          const score = Math.round(
            task.rubric.reduce(
              (sum: number, r: any) =>
                sum +
                r.weight * scores.find((s: any) => s.key === r.key)!.score,
              0,
            ) / 100,
          );
          const row = {
            ...(await this.base(ctx)),
            task_id: key,
            submission_id: submissionId,
            author_id: ctx.userId,
            status: o.publish ? "published" : "draft",
            comments,
            scores,
            score,
            published_at: o.publish ? await this.access.now(ctx) : null,
          };
          await this.fenceTaskFacts(ctx, task);
          await this.cas(
            ctx,
            "coursework_heads",
            head,
            o.head_revision,
            o.publish ? { current_feedback_id: row._id } : {},
          );
          await this.col("coursework_feedback").insertOne(row, {
            session: ctx.session,
          });
          await this.audit(
            ctx,
            "feedback",
            row,
            o.publish ? "feedback.publish" : "feedback.draft",
          );
          if(o.publish)await this.phase2TaskNotification(ctx,task,'教师反馈已发布',[sub.member_id]);
          return row;
        },
      );
    });
  }
}
