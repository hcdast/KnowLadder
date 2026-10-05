import { Injectable, HttpException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { AssessmentContext as Context } from "../assessment/contracts";
import type { FileResource } from "../content/contracts";
import { newId } from "../database/object-id";
import { ApiRequest, fail } from "../errors";
import { FilesService } from "../files/files.service";
import {
  fileConfig,
  fileScanEnabled,
  MAX_FILE_SIZE,
  allowedFileMimes,
  assertUploadCapacity,
} from "../files/config";
import { receive } from "../files/stream";
import { assertScanner } from "../files/scanner";
import { assertOperationalAccess } from "../operations/control";
import { TrainingService } from "./training.service";
import * as v from "./validation";
const UPLOAD_LEASE_MS = 120000;
@Injectable()
export class CourseworkFilesService {
  constructor(
    readonly training: TrainingService,
    readonly delivery: FilesService,
  ) {}
  get files() {
    return this.training.db.collection<FileResource>("file_resources");
  }
  enabled() {
    if (process.env.KL_COURSEWORK_FILES_ENABLED !== "true")
      fail(503, "COURSEWORK_FILES_DISABLED", "作业附件尚未启用");
  }
  configured() {
    this.enabled();
    if (!fileScanEnabled())
      fail(503, "FILE_SCAN_DISABLED", "文件扫描已关闭，暂停新附件");
    try {
      fileConfig();
    } catch {
      fail(503, "SCANNER_NOT_CONFIGURED", "私有目录或扫描引擎未配置");
    }
  }
  revision(value: unknown) {
    return v.integer(value);
  }
  async file(ctx: Context, id: string) {
    this.enabled();
    const row = await this.files.findOne(
      { _id: v.id(id), org_id: ctx.orgId, owner_type: "coursework" as any },
      { session: ctx.session },
    );
    if (!row) fail(404, "NOT_FOUND", "附件不可访问");
    return row;
  }
  async owner(ctx: Context, file: FileResource, write = false) {
    const head = await this.training.row(
      ctx,
      "coursework_heads",
      file.owner_version_id,
    );
    const mine = head.user_id === ctx.userId && head.member_id === ctx.memberId;
    if (write || mine) this.training.require(ctx, "learning:self");
    else if(!ctx.capabilities.includes("coursework:grade")) fail(404,"NOT_FOUND","附件不可访问");
    const task = await this.training.taskAccess(
      ctx,
      head.task_id,
      !mine,
      write,
    );
    if (write && (!mine || task.target_type !== "coursework"))
      fail(404, "NOT_FOUND", "附件不可访问");
    await this.training.learnerCurrent(
      ctx,
      head.user_id,
      head.member_id,
      task.class_id,
      write,
    );
    if (write && (await this.training.access.now(ctx)) >= task.due_at)
      fail(409, "DEADLINE_PASSED", "作业已截止");
    if (!mine) {
      const bound = await this.training
        .col("coursework_submissions")
        .findOne(
          { head_id: head._id, file_ids: file._id },
          { session: ctx.session },
        );
      if (!bound) fail(404, "NOT_FOUND", "未提交的个人附件不可访问");
    }
    return head;
  }
  async touch(ctx: Context, file: FileResource, revision: number) {
    const head = await this.owner(ctx, file, true);
    const task = await this.training.taskAccess(ctx, head.task_id, false, true);
    await this.training.fenceTaskFacts(ctx, task);
    return this.training.cas(
      ctx,
      "coursework_heads",
      head,
      revision,
      {},
      task.due_at,
    );
  }
  view(file: FileResource) {
    return {
      id: file._id,
      display_name: file.display_name,
      size: file.size ?? file.declared_size,
      mime: file.mime ?? file.declared_mime,
      checksum: file.checksum ?? file.declared_checksum,
      status: file.status,
      scan_status: file.scan_status,
      error_code: file.error_code,
      upload_confirmed: file.upload_result_revision !== null,
      upload_in_progress:
        !!file.upload_lease_until &&
        file.upload_lease_until.getTime() > Date.now(),
    };
  }
  async audit(
    ctx: Context,
    file: FileResource,
    action: string,
    before: any,
    after: any,
    _reason: string,
  ) {
    await this.training.audit(ctx, "coursework", after, action);
  }
  async register(req: ApiRequest, taskId: string, input: unknown) {
    this.configured();
    const o = v.object(input, [
      "expected_revision",
      "display_name",
      "size",
      "mime",
      "checksum",
    ]);
    const display_name = v.text(o.display_name, 200);
    if (/[\x00-\x1f\x7f/\\]/.test(display_name))
      fail(422, "INVALID_FILE", "文件名无效");
    const size = v.integer(o.size);
    if (
      size > MAX_FILE_SIZE ||
      !allowedFileMimes().includes(o.mime) ||
      typeof o.checksum !== "string" ||
      !/^[a-f0-9]{64}$/.test(o.checksum)
    )
      fail(422, "INVALID_FILE", "附件大小、类型或校验和无效");
    const inputFile = {
      ...o,
      display_name,
      size,
      mime: o.mime as string,
      checksum: o.checksum as string,
    };
    return this.training.run(req, true, async (ctx) => {
      this.training.require(ctx, "learning:self");
      const task = await this.training.taskAccess(ctx, taskId, false, true);
      if (task.target_type !== "coursework")
        fail(404, "NOT_FOUND", "作业不可访问");
      const head = await this.training
        .col("coursework_heads")
        .findOne(
          {
            org_id: ctx.orgId,
            task_id: taskId,
            member_id: ctx.memberId,
            user_id: ctx.userId,
          },
          { session: ctx.session },
        );
      if (!head) fail(409, "DRAFT_REQUIRED", "请先保存作业草稿");
      return this.training.idem(
        ctx,
        req,
        "coursework.file-register",
        taskId,
        o,
        async () => {
          if ((await this.training.access.now(ctx)) >= task.due_at)
            fail(409, "DEADLINE_PASSED", "作业已截止");
          if (
            (await this.files.countDocuments(
              {
                org_id: ctx.orgId,
                owner_type: "coursework" as any,
                owner_version_id: head._id,
                deleted_at: null,
              },
              { session: ctx.session },
            )) >= 20
          )
            fail(
              409,
              "FILE_CAPACITY",
              "本作业附件登记上限20个，请安排受控清理",
            );
          await this.training.fenceTaskFacts(ctx, task);
          const owner = await this.training.cas(
            ctx,
            "coursework_heads",
            head,
            o.expected_revision,
            {},
            task.due_at,
          );
          const now = new Date();
          const input = { ...inputFile };
          const file: FileResource = {
            _id: newId(),
            org_id: ctx.orgId,
            owner_type: "coursework" as any,
            owner_version_id: head._id,
            created_by: ctx.userId,
            display_name: input.display_name,
            storage_key: randomUUID(),
            declared_size: input.size,
            declared_mime: input.mime,
            declared_checksum: input.checksum,
            size: null,
            mime: null,
            checksum: null,
            status: "pending",
            scan_status: "awaiting_upload",
            scan_attempt: 0,
            lease_token: null,
            lease_until: null,
            available_at: now,
            uploaded_at: null,
            error_code: null,
            created_at: now,
            updated_at: now,
            upload_key: null,
            upload_lease_token: null,
            upload_lease_until: null,
            upload_storage_key: null,
            upload_storage_keys: [],
            upload_owner_revision: null,
            upload_result_revision: null,
            retention_until: null,
            legal_hold: false,
            deletion_requested_at: null,
            deletion_requested_by: null,
            deletion_requested_reason: null,
            deleted_at: null,
            deletion_lease_token: null,
            deletion_lease_until: null,
            deletion_attempt: 0,
            scan_engine_version: null,
            scan_database_version: null,
            scan_database_updated_at: null,
            scanned_at: null,
          };

          await this.files.insertOne(file, { session: ctx.session });
          await this.audit(ctx, file, "file.register", head, owner, "登记");
          return {
            ...this.view(file),
            task_id: taskId,
            owner_revision: owner.revision,
          };
        },
      );
    });
  }
  async list(req: ApiRequest, taskId: string) {
    this.enabled();
    return this.training.run(req, false, async (ctx) => {
      this.training.require(ctx, "learning:self");
      await this.training.taskAccess(ctx, taskId, false);
      const head = await this.training
        .col("coursework_heads")
        .findOne(
          { org_id: ctx.orgId, task_id: taskId, member_id: ctx.memberId },
          { session: ctx.session },
        );
      if (!head) return { items: [], owner_revision: 0, upload_enabled:fileScanEnabled() };
      const rows = await this.files
        .find(
          {
            org_id: ctx.orgId,
            owner_type: "coursework" as any,
            owner_version_id: head._id,
            deleted_at: null,
          },
          { session: ctx.session },
        )
        .limit(20)
        .toArray();
      return {
        items: rows.map((r) => this.view(r)),
        owner_revision: head.revision,
        upload_enabled:fileScanEnabled(),
      };
    });
  }
  async status(req: ApiRequest, id: string) {
    return this.training.run(req, false, async (ctx) => {
      const row = await this.file(ctx, id);
      const head = await this.owner(ctx, row);
      return { ...this.view(row), owner_revision: head.revision };
    });
  }
  async download(req: ApiRequest, id: string, res: Response) {
    this.enabled();
    return this.delivery.deliverAuthorized(req, res, (prepare) =>
      this.training.run(req, false, async (ctx) => {
        const row = await this.file(ctx, id);
        await this.owner(ctx, row);
        await prepare(row);
        return row;
      }),
    );
  }
  async upload(req: ApiRequest, id: string) {
    this.configured();
    if (
      req.get("Content-Type")?.split(";")[0].trim().toLowerCase() !==
        "application/octet-stream" ||
      req.get("Content-Encoding")
    )
      fail(415, "UNSUPPORTED_MEDIA_TYPE", "仅支持未压缩原始二进制流");
    const revisionHeader = req.get("X-Owner-Revision");
    if (!revisionHeader || !/^[1-9]\d*$/.test(revisionHeader))
      fail(422, "INVALID_REVISION", "缺少有效X-Owner-Revision");
    const revision = this.revision(Number(revisionHeader));
    const key = req.get("Idempotency-Key");
    if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key))
      fail(422, "INVALID_IDEMPOTENCY_KEY", "必须提供有效幂等键");
    const token = randomUUID();
    const storageKey = randomUUID();
    const leaseMs = UPLOAD_LEASE_MS + fileConfig().timeout * 3;
    const file = await this.training.run(req, true, async (ctx) => {
      const row = await this.file(ctx, id);
      await this.owner(ctx, row, true);
      if (row.upload_key !== null && row.upload_key !== key)
        fail(409, "IDEMPOTENCY_CONFLICT", "此资源已绑定其他上传幂等键");
      const actorOrgId = ctx.platform?.actorOrgId ?? ctx.orgId;
      if (
        row.upload_key !== null &&
        ((row.upload_actor_user_id &&
          row.upload_actor_user_id !== ctx.userId) ||
          (row.upload_actor_org_id && row.upload_actor_org_id !== actorOrgId) ||
          (ctx.platform && !row.upload_actor_user_id))
      )
        fail(409, "IDEMPOTENCY_CONFLICT", "上传幂等键属于另一操作者上下文");
      if (row.status !== "pending")
        fail(
          409,
          "FILE_IMMUTABLE",
          "文件已上传或安排删除，请查询最新状态，不得覆盖",
        );
      if (row.upload_storage_keys.length >= 100)
        fail(
          409,
          "UPLOAD_ATTEMPT_LIMIT",
          "上传恢复记录已达上限，请联系管理员安排受控清理",
        );
      const owner = await this.owner(ctx, row, true);
      if (owner.revision !== revision)
        fail(409, "REVISION_CONFLICT", "归属版本已变化，请重新载入");
      const length = req.get("Content-Length");
      if (
        length &&
        (!/^\d+$/.test(length) || Number(length) !== row.declared_size)
      )
        fail(422, "FILE_INTEGRITY_MISMATCH", "Content-Length与登记不符");
      const now = new Date();
      const result = await this.files.updateOne(
        {
          _id: id,
          status: "pending",
          $or: [
            { upload_lease_until: null },
            { upload_lease_until: { $lte: now } },
          ],
        },
        {
          $set: {
            upload_key: key,
            upload_actor_user_id: ctx.userId,
            upload_actor_org_id: actorOrgId,
            upload_lease_token: token,
            upload_lease_until: new Date(now.getTime() + leaseMs),
            upload_storage_key: storageKey,
            upload_storage_keys: [...row.upload_storage_keys, storageKey],
            upload_owner_revision: revision,
            error_code: null,
            updated_at: now,
          },
        },
        { session: ctx.session },
      );
      if (result.modifiedCount !== 1)
        fail(409, "UPLOAD_IN_PROGRESS", "此资源已有上传正在进行");
      return row;
    });
    const timer = setTimeout(
      () => req.destroy(new Error("UPLOAD_TIMEOUT")),
      leaseMs - 1000,
    );
    timer.unref();
    try {
      await assertOperationalAccess(this.training.db);
      try {
        await assertScanner();
      } catch {
        fail(
          503,
          "SCANNER_UNAVAILABLE",
          "扫描引擎或有效病毒库不可用，暂停新上传",
        );
      }
      try {
        await assertUploadCapacity(file.declared_size);
      } catch {
        fail(
          503,
          "FILE_STORAGE_CAPACITY",
          "私有存储容量不足或不可用，暂停新上传",
        );
      }
      const actual = await receive(req, file, storageKey);
      return await this.training.run(req, true, async (ctx) => {
        const current = await this.file(ctx, id);
        const before = await this.owner(ctx, current, true);
        await this.owner(ctx, current, true);
        const owner = await this.touch(ctx, current, revision);
        const now = new Date();
        const updated = await this.files.updateOne(
          {
            _id: id,
            org_id: ctx.orgId,
            status: "pending",
            upload_key: key,
            upload_actor_user_id: ctx.userId,
            upload_actor_org_id: ctx.platform?.actorOrgId ?? ctx.orgId,
            upload_lease_token: token,
            upload_lease_until: { $gt: now },
          },
          {
            $set: {
              ...actual,
              storage_key: storageKey,
              status: "quarantined",
              scan_status: "queued",
              available_at: now,
              uploaded_at: now,
              updated_at: now,
              upload_lease_token: null,
              upload_lease_until: null,
              upload_result_revision: owner.revision,
            },
          },
          { session: ctx.session },
        );
        if (updated.modifiedCount !== 1)
          fail(409, "UPLOAD_LEASE_LOST", "上传租约已失效，请查询状态后恢复");
        await this.audit(
          ctx,
          current,
          "file.upload",
          before,
          owner,
          "上传附件至安全隔离区",
        );
        return {
          id,
          status: "quarantined",
          scan_status: "queued",
          owner_revision: owner.revision,
        };
      });
    } catch (error) {
      // Keep the storage key as recovery evidence; reconciliation retains metadata-owned bytes.
      await assertOperationalAccess(this.training.db);
      await this.files
        .updateOne(
          { _id: id, status: "pending", upload_lease_token: token },
          {
            $set: {
              upload_lease_token: null,
              upload_lease_until: null,
              error_code: "UPLOAD_FAILED",
              updated_at: new Date(),
            },
          },
        )
        .catch(() => undefined);
      if (
        file.upload_key !== null &&
        error instanceof HttpException &&
        error.getStatus() === 422
      )
        fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "同一上传幂等键的文件内容与登记不一致",
        );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
