import { provenanceRecord } from "./import-provenance";
import { Injectable } from "@nestjs/common";
import { Database } from "../database/database";
import { newId } from "../database/object-id";
import { ContentAccess, type ContentContext } from "../content/access";
import { ContentService } from "../content/content.service";
import { licensed, type FileResource } from "../content/contracts";
import { object, id, integer, text, license } from "../content/dto";
import { ApiRequest, fail } from "../errors";
import {
  importDocumentsEnabled,
  fileScanEnabled,
  DOCX_FILE_MIME,
} from "../files/config";
import type { Document } from "mongodb";

export type ImportJob = Document & {
  _id: string;
  org_id: string;
  user_id: string;
  member_id: string;
  owner_id: string;
  file_id: string;
  source_revision: number;
  source_hash: string;
  revision: number;
  generation: number;
  status: string;
  expires_at: Date;
  lease_token: string | null;
  lease_until: Date | null;
};
export function requireImports() {
  if (!importDocumentsEnabled() || !fileScanEnabled())
    fail(503, "IMPORT_DISABLED", "素材导入或文件扫描未启用");
}

export async function importSource(
  database: Database,
  access: ContentAccess,
  ctx: ContentContext,
  job: ImportJob,
) {
  requireImports();
  access.require(ctx, "edit");
  if (job.org_id !== ctx.orgId || job.user_id !== ctx.userId)
    fail(404, "NOT_FOUND", "导入任务不存在");
  const owner = await access.owner(ctx, "textbook", job.owner_id, "edit");
  if (!licensed(owner)) fail(404, "NOT_FOUND", "教材许可不可用");
  if (owner.revision !== job.source_revision)
    fail(409, "IMPORT_SOURCE_CHANGED", "教材已变化，请重新创建导入任务");
  await access.fenceOwner(ctx, "textbook", owner._id);
  const file = await database.db
    .collection<FileResource>("file_resources")
    .findOne(
      {
        _id: job.file_id,
        org_id: ctx.orgId,
        owner_type: "textbook",
        owner_version_id: owner._id,
      },
      { session: ctx.session },
    );
  if (
    !file ||
    file.status !== "ready" ||
    file.scan_status !== "clean" ||
    !file.scanned_at ||
    file.deleted_at ||
    file.deletion_requested_at ||
    file.checksum !== job.source_hash ||
    !["application/pdf", DOCX_FILE_MIME].includes(file.mime!)
  )
    fail(409, "IMPORT_FILE_UNAVAILABLE", "文件未扫描通过或来源已变化");
  const touched = await database.db
    .collection<Document & { _id: string }>("file_resources")
    .updateOne(
      {
        _id: file._id,
        org_id: ctx.orgId,
        status: "ready",
        scan_status: "clean",
        checksum: job.source_hash,
        deletion_requested_at: null,
        deleted_at: null,
      },
      { $set: { updated_at: new Date() } },
      { session: ctx.session },
    );
  if (touched.matchedCount !== 1)
    fail(409, "IMPORT_FILE_UNAVAILABLE", "文件已变化");
  if (job.expires_at <= new Date())
    fail(409, "IMPORT_PREVIEW_EXPIRED", "导入预览已过期");
  return { owner, file };
}

@Injectable()
export class ImportService {
  async provenance(req: ApiRequest, ownerId: string) {
    requireImports();
    return this.access.run(req, false, async (ctx) => {
      if (
        !ctx.capabilities.some((cap) =>
          ["content:edit", "content:review"].includes(cap),
        )
      )
        fail(403, "FORBIDDEN", "来源证明需要内容编辑或独立审核权限");
      await this.access.owner(ctx, "textbook", id(ownerId), "manage");
      await this.access.fenceOwner(ctx, "textbook", ownerId);
      const rows = await this.database.db
        .collection("knowledge_import_provenance")
        .find(
          { org_id: ctx.orgId, owner_id: ownerId },
          { session: ctx.session },
        )
        .sort({ applied_revision: -1, _id: 1 })
        .limit(51)
        .toArray();
      return {
        items: rows.slice(0, 50).map((r) => ({
          id: r._id,
          file_id: r.file_id,
          applied_revision: r.applied_revision,
          chapter_ids: r.chapter_ids,
          ...JSON.parse(r.license_json),
          created_at: r.created_at,
        })),
        truncated: rows.length > 50,
      };
    });
  }

  async receipt(req: ApiRequest, ownerId: string, key: string) {
    requireImports();
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key))
      fail(422, "VALIDATION_ERROR", "请求编号无效");
    return this.access.run(req, false, async (ctx) => {
      this.access.require(ctx, "edit");
      const owner = await this.access.owner(
        ctx,
        "textbook",
        id(ownerId),
        "manage",
      );
      if (!licensed(owner)) fail(404, "NOT_FOUND", "来源许可不可用");
      await this.access.fenceOwner(ctx, "textbook", owner._id);
      const names = [
        "textbook.import-create",
        "textbook.import-cancel",
        "textbook.import-apply",
      ].map((x) => (ctx.platform ? `${ctx.platform.actorOrgId}:${x}` : x));
      const rows = await this.database.db
        .collection("content_idempotency")
        .find(
          {
            org_id: ctx.orgId,
            user_id: ctx.userId,
            resource_id: ownerId,
            key,
            operation: { $in: names },
          },
          { session: ctx.session },
        )
        .limit(2)
        .toArray();
      if (rows.length > 1)
        fail(409, "IDEMPOTENCY_AMBIGUOUS", "请求编号存在多个操作");
      if (!rows.length) return { status: "unknown", result: null };
      const r = rows[0].result;
      return {
        status: "resolved",
        result: { id: r.id, status: r.status, revision: r.revision },
      };
    });
  }
  constructor(
    readonly database: Database,
    readonly access: ContentAccess,
    readonly content: ContentService,
  ) {}
  private jobs() {
    return this.database.db.collection<ImportJob>("knowledge_import_jobs");
  }
  private metadata(job: ImportJob) {
    return {
      id: job._id,
      owner_id: job.owner_id,
      file_id: job.file_id,
      status: job.status,
      revision: job.revision,
      error_code: job.error_code,
      expires_at: job.expires_at,
      format: job.format,
      applied_revision: job.applied_revision,
      created_at: job.created_at,
    };
  }
  async create(req: ApiRequest, ownerId: string, raw: unknown) {
    requireImports();
    const ownerKey = id(ownerId),
      body = object(raw, ["file_id", "expected_revision"]),
      fileId = id(body.file_id),
      revision = integer(body.expected_revision, "expected_revision");
    return this.access.run(req, true, async (ctx) => {
      this.access.require(ctx, "edit");
      const member = await this.database.db
        .collection<Document & { _id: string }>("organization_members")
        .findOne(
          { org_id: ctx.orgId, user_id: ctx.userId, status: "active" },
          { session: ctx.session },
        );
      if (!member) fail(403, "FORBIDDEN", "组织成员不可用");
      const file = await this.database.db
        .collection<FileResource>("file_resources")
        .findOne({ _id: fileId, org_id: ctx.orgId }, { session: ctx.session });
      const now = new Date();
      const job: ImportJob = {
        _id: newId(),
        org_id: ctx.orgId,
        user_id: ctx.userId,
        member_id: member._id as string,
        owner_id: ownerKey,
        file_id: fileId,
        source_revision: revision,
        source_hash: file?.checksum ?? "",
        revision: 1,
        generation: 1,
        status: "queued",
        lease_token: null,
        lease_until: null,
        error_code: "",
        expires_at: new Date(now.getTime() + 86400000),
        created_at: now,
        updated_at: now,
        preview: [],
        warnings: [],
        format: file?.mime === DOCX_FILE_MIME ? "docx" : "pdf",
        applied_revision: null,
        chapter_ids: [],
        license_json: "",
      };
      await importSource(this.database, this.access, ctx, job);
      return this.access.idempotent(
        ctx,
        req,
        "textbook.import-create",
        ownerKey,
        body,
        async () => {
          await this.jobs().insertOne(job, { session: ctx.session });
          await this.audit(ctx, ownerKey, "创建素材导入");
          return this.metadata(job);
        },
      );
    });
  }
  async list(req: ApiRequest, ownerId: string) {
    requireImports();
    return this.access.run(req, false, async (ctx) => {
      await this.access.owner(ctx, "textbook", id(ownerId), "edit");
      const jobs = await this.jobs()
        .find(
          { org_id: ctx.orgId, user_id: ctx.userId, owner_id: ownerId },
          { session: ctx.session },
        )
        .sort({ created_at: -1 })
        .limit(51)
        .toArray();
      return {
        items: jobs.slice(0, 50).map((j) => this.metadata(j)),
        truncated: jobs.length > 50,
      };
    });
  }
  async read(req: ApiRequest, ownerId: string, jobId: string) {
    requireImports();
    return this.access.run(req, false, async (ctx) => {
      const job = await this.find(ctx, ownerId, jobId);
      if (job.status === "applied") {
        await this.access.owner(ctx, "textbook", job.owner_id, "manage");
        this.access.require(ctx, "edit");
        return this.metadata(job);
      }
      await importSource(this.database, this.access, ctx, job);
      return {
        ...this.metadata(job),
        preview: job.status === "preview-ready" ? job.preview : [],
        warnings: job.status === "preview-ready" ? job.warnings : [],
      };
    });
  }
  private async find(ctx: ContentContext, ownerId: string, jobId: string) {
    const job = await this.jobs().findOne(
      {
        _id: id(jobId),
        owner_id: id(ownerId),
        org_id: ctx.orgId,
        user_id: ctx.userId,
      },
      { session: ctx.session },
    );
    if (!job) fail(404, "NOT_FOUND", "导入任务不存在");
    return job;
  }
  async cancel(req: ApiRequest, ownerId: string, jobId: string, raw: unknown) {
    requireImports();
    const body = object(raw, ["job_revision"]),
      revision = integer(body.job_revision, "job_revision");
    return this.access.run(req, true, async (ctx) => {
      this.access.require(ctx, "edit");
      await this.access.owner(ctx, "textbook", id(ownerId), "manage");
      return this.access.idempotent(
        ctx,
        req,
        "textbook.import-cancel",
        ownerId,
        { ...body, job_id: jobId },
        async () => {
          const job = await this.find(ctx, ownerId, jobId);
          if (job.status === "applied" || job.revision !== revision)
            fail(409, "IMPORT_JOB_CHANGED", "导入任务已变化");
          await this.jobs().updateOne(
            { _id: job._id, revision },
            {
              $set: {
                status: "cancelled",
                preview: [],
                warnings: [],
                lease_token: null,
                lease_until: null,
                updated_at: new Date(),
              },
              $inc: { revision: 1, generation: 1 },
            },
            { session: ctx.session },
          );
          await this.audit(ctx, ownerId, "取消素材导入");
          return { id: job._id, status: "cancelled", revision: revision + 1 };
        },
      );
    });
  }
  async apply(req: ApiRequest, ownerId: string, jobId: string, raw: unknown) {
    requireImports();
    const body = object(raw, [
      "job_revision",
      "expected_revision",
      "chapters",
      "license",
      "rights_type",
      "proof_reference",
      "usage_restrictions",
    ]);
    const revision = integer(body.job_revision, "job_revision"),
      ownerRevision = integer(body.expected_revision, "expected_revision"),
      permission = license(body.license);
    const rights = text(body.rights_type, "rights_type", 32),
      proof = text(body.proof_reference, "proof_reference", 1000),
      restrictions = text(
        body.usage_restrictions,
        "usage_restrictions",
        1000,
        true,
      );
    if (
      !["original", "authorized", "public-domain"].includes(rights) ||
      !permission.granted ||
      !permission.source.trim()
    )
      fail(422, "IMPORT_LICENSE_REQUIRED", "请登记有效来源许可");
    return this.access.run(req, true, (ctx) => {
      this.access.require(ctx, "edit");
      return this.access.idempotent(
        ctx,
        req,
        "textbook.import-apply",
        id(ownerId),
        { ...body, job_id: id(jobId) },
        async () => {
          const job = await this.find(ctx, ownerId, jobId);
          await importSource(this.database, this.access, ctx, job);
          if (
            job.status !== "preview-ready" ||
            job.revision !== revision ||
            job.source_revision !== ownerRevision
          )
            fail(409, "IMPORT_JOB_CHANGED", "预览或教材已变化");
          if (
            !Array.isArray(body.chapters) ||
            !body.chapters.length ||
            body.chapters.reduce(
              (n: number, ch: any) =>
                n + [...(typeof ch?.body === "string" ? ch.body : "")].length,
              0,
            ) > 80000
          )
            fail(422, "IMPORT_TEXT_LIMIT", "导入章节总量无效");
          const result = await this.content.importChaptersInside(
            ctx,
            ownerId,
            { expected_revision: ownerRevision, chapters: body.chapters },
            permission,
            job.file_id,
          );
          const shared = provenanceRecord(
            job,
            result.revision,
            result.chapter_ids,
            JSON.stringify({
              license: permission,
              rights_type: rights,
              proof_reference: proof,
              usage_restrictions: restrictions,
            }),
            new Date(),
          );
          await this.database.db
            .collection("knowledge_import_provenance")
            .insertOne(shared, { session: ctx.session });
          const changed = await this.jobs().updateOne(
            { _id: job._id, status: "preview-ready", revision },
            {
              $set: {
                status: "applied",
                preview: [],
                warnings: [],
                lease_token: null,
                lease_until: null,
                applied_revision: result.revision,
                chapter_ids: result.chapter_ids,
                license_json: JSON.stringify({
                  license: permission,
                  rights_type: rights,
                  proof_reference: proof,
                  usage_restrictions: restrictions,
                }),
                updated_at: new Date(),
              },
              $inc: { revision: 1 },
            },
            { session: ctx.session },
          );
          if (changed.matchedCount !== 1)
            fail(409, "IMPORT_JOB_CHANGED", "导入任务已变化");
          return {
            id: job._id,
            status: "applied",
            revision: revision + 1,
            owner_revision: result.revision,
            chapter_count: result.chapter_ids.length,
          };
        },
      );
    });
  }
  private async audit(ctx: ContentContext, ownerId: string, reason: string) {
    await this.content.importAuditInside(ctx, ownerId, reason);
  }
}
