import { newId } from "../database/object-id";
import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { AuthService } from '../auth.service';
import { Database } from '../database/database';
import { collections } from '../database/contracts';
import { canonical } from '../content/dto';
import { resourceIdPattern } from '../content/access';
import { ApiRequest, fail } from '../errors';
import type { AssessmentContext, IdempotencyRecord } from './contracts';
import { assertOperationalAccess } from '../operations/control';
import { requireEvidenceSubject } from './subject-access';
import { beginSessionWork, commitSessionWork, abortSessionWork } from '../database/txn';
import type { MongoTopologyMode } from '../database/topology';

import { PlatformBusinessAccess, platformBusinessModule } from '../administration/platform-access';
import { scopedBusinessCapabilities } from '../administration/authorization';
@Injectable()
export class AssessmentAccess {
  constructor(readonly database: Database, readonly auth: AuthService, readonly platform: PlatformBusinessAccess) {}
  async run<T>(req: ApiRequest, write: boolean, work: (ctx: AssessmentContext) => Promise<T>): Promise<T> {
    await assertOperationalAccess(this.database.db);
    if (write) this.auth.origin(req);
    const orgId = req.get('X-Org-Id');
    if (!orgId || !resourceIdPattern.test(orgId)) fail(422, 'ORG_REQUIRED', '请选择有效组织');
    const deadline = performance.now() + 15000;
    const session = this.database.client.startSession();
    const labeled = (error: unknown, label: string) => !!error && typeof error === 'object' && 'hasErrorLabel' in error && typeof error.hasErrorLabel === 'function' && error.hasErrorLabel(label);
    // Authorization/source fences intentionally serialize competing requests. Retry
    // against fresh snapshots for the whole budget, not a fixed number of collisions.
    const retry = async (attempt: number) => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return false;
      await delay(Math.min(remaining, Math.min(250, 10 * 2 ** Math.min(attempt, 5)) + Math.random() * 25));
      return performance.now() < deadline;
    };
    let rateChecked = false;
    try {
      for (let attempt = 0; ; attempt++) {
        const mode: MongoTopologyMode = await beginSessionWork(session, this.database.db, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary', maxCommitTimeMS: 3000 });
        let result: T;
        try {
          const identity = await this.auth.identify(req, true, session);
          if (write) this.auth.csrf(req, identity.session);
          const delegated = platformBusinessModule(req) ? await this.platform.authorize(req, identity, session, 'assessment') : null;
          if (!delegated && req.get('X-Target-Org-Id')) fail(403, 'FORBIDDEN', '目标组织只可由平台业务入口选择');
          const capabilities = delegated?.capabilities ?? await this.auth.authorize(identity, orgId, 'account:read', session);
          if (identity.user._id.startsWith('system:') || capabilities.some(c => c === 'assessment:worker' || c === 'learning:projection-worker')) fail(403, 'FORBIDDEN', '内部能力不得用于HTTP');
          const member = delegated ? null : await collections(this.database.db).members.findOne({ org_id: orgId, user_id: identity.user._id, status: 'active' }, { session });
          if (!delegated && !member) fail(403, 'FORBIDDEN', '组织成员无效');
          if (!rateChecked) { await this.auth.rate('assessment', `${delegated?.actorOrgId ?? orgId}:${delegated?.orgId ?? orgId}:${delegated?.actorMemberId ?? member!._id}:${write ? 'write' : 'read'}`, write ? 120 : 240); rateChecked = true; }
          const targetOrg = delegated?.orgId ?? orgId;
          const conflicts = ['content:edit', 'content:review', 'assessment:manage', 'assessment:review', ...(process.env.KL_TRAINING_ENABLED === 'true' ? ['course:edit','course:review','coursework:grade','ai:generate'] : [])];
          const studentConflict = !delegated && capabilities.includes('learning:self') &&
            (capabilities.some(cap => conflicts.includes(cap)) ||
              (await scopedBusinessCapabilities(this.database.db, identity.user._id, targetOrg, session))
                .some(cap => conflicts.includes(cap)));
          result = await work({ orgId: targetOrg, userId: identity.user._id, memberId: delegated?.actorMemberId ?? member!._id, capabilities, session, requestId: req.requestId, ...(delegated ? { platform: delegated } : { studentConflict }) });
          if (delegated) await this.platform.assertCurrent(delegated);
        } catch (error) {
          await abortSessionWork(session, mode);
          const duplicate = !!error && typeof error === 'object' && 'code' in error && error.code === 11000;
          if ((duplicate || (mode === 'replicaSet' && labeled(error, 'TransientTransactionError'))) && await retry(attempt)) continue;
          if (duplicate) fail(409, 'ASSESSMENT_CONFLICT', '并发请求冲突，请使用原幂等键重试');
          throw error;
        }
        let unknown = false;
        for (;;) {
          try { await commitSessionWork(session, mode); return result; }
          catch (error) {
            if (mode === 'replicaSet' && labeled(error, 'UnknownTransactionCommitResult')) {
              unknown = true;
              if (await retry(attempt)) continue;
              fail(503, 'COMMIT_OUTCOME_UNKNOWN', '提交结果尚未确认，请保留原幂等键查询');
            }
            if (unknown) fail(503, 'COMMIT_OUTCOME_UNKNOWN', '提交结果尚未确认，请保留原幂等键查询');
            if (mode === 'replicaSet' && labeled(error, 'TransientTransactionError') && await retry(attempt)) break;
            throw error;
          }
        }
      }
    } finally { await session.endSession(); }
  }
  require(ctx: AssessmentContext, capability: string): void {
    if (capability === 'learning:self' && ctx.studentConflict) fail(403, 'FORBIDDEN', '兼任内容或评估管理者不能访问学生业务');
    if (!ctx.capabilities.includes(capability)) fail(403, 'FORBIDDEN', '未获评估操作能力');
  }
  async now(ctx: AssessmentContext): Promise<Date> {
    const row = await this.database.db.aggregate<{ now: Date }>([{ $documents: [{}] }, { $project: { _id: 0, now: '$$NOW' } }], { session: ctx.session }).next();
    if (!(row?.now instanceof Date)) fail(503, 'DATABASE_TIME_UNAVAILABLE', '数据库时间不可用');
    return row.now;
  }
  async idempotent<T>(ctx: AssessmentContext, req: ApiRequest, operation: string, resourceId: string, payload: unknown, work: () => Promise<T>, responseStatus = 200): Promise<T> {
    await requireEvidenceSubject(this.database.db, ctx.session, ctx.userId, ctx.orgId);
    const key = req.get('Idempotency-Key');
    if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) fail(422, 'IDEMPOTENCY_KEY_REQUIRED', '请提供8至128字符幂等键');
    const filter = { org_id: ctx.orgId, user_id: ctx.userId, operation: ctx.platform ? `${ctx.platform.actorOrgId}:${operation}` : operation, resource_id: resourceId, key };
    const request_hash = createHash('sha256').update(canonical(payload)).digest('hex');
    const records = this.database.db.collection<IdempotencyRecord>('idempotency_records');
    const previous = await records.findOne(filter, { session: ctx.session });
    if (previous) {
      if (previous.request_hash !== request_hash) fail(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求');
      return previous.result as T;
    }
    const result = await work();
    const now = await this.now(ctx);
    await records.insertOne({ _id: newId(), ...filter, request_hash, response_status: responseStatus, result: result as Record<string, unknown>, created_at: now, updated_at: now }, { session: ctx.session });
    return result;
  }
  async audit(ctx: AssessmentContext, resourceType: string, resourceId: string, action: string, reason: string, evidence: object = {}): Promise<void> {
    const proofCapability = action === 'assessment.quiz.publish' || action === 'assessment.submission.regrade' ? 'assessment:review'
      : action === 'assessment.quiz.create' || action === 'assessment.quiz.edit' ? 'assessment:manage' : null;
    const proof = ctx.platform?.grants.find(grant => proofCapability === null ||
      grant.capability === proofCapability);
    if (ctx.platform && !proof) fail(403, 'FORBIDDEN', '评估操作授权依据无效');
    const revisions: Record<string, number | null> = {};
    for (const key of ['revision_before', 'revision_after', 'access_revision_before', 'access_revision_after']) {
      revisions[key] = null;
      const value = (evidence as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) revisions[key] = value;
    }
    await collections(this.database.db).audit.insertOne({ _id: newId(), org_id: ctx.orgId, actor_id: ctx.userId, ...(ctx.platform ? { actor_org_id: ctx.platform.actorOrgId, target_org_id: ctx.orgId, grant_id: proof!.id, grant_ids: ctx.platform.grantIds, grant_revision: proof!.revision } : {}), resource_type: resourceType, resource_id: resourceId, owner_type: null, owner_version_id: null, action, reason, request_id: ctx.requestId, created_at: await this.now(ctx), ...revisions }, { session: ctx.session });
  }
}
