import { Injectable } from '@nestjs/common';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { AssessmentAccess } from '../assessment/access';
import type { AssessmentContext, IdempotencyRecord } from '../assessment/contracts';
import { canonical } from '../content/dto';
import { ApiRequest, fail } from '../errors';
import { id, text } from '../assessment/dto';
import { RULE_VERSION } from './contracts';
import { requireEvidenceSubject } from '../assessment/subject-access';

export const LEARNING_CONFLICTS = ['content:edit', 'content:review', 'assessment:manage', 'assessment:review'];
@Injectable()
export class LearningAccess {
  constructor(readonly assessment: AssessmentAccess) {}
  run<T>(req: ApiRequest, write: boolean, work: (ctx: AssessmentContext) => Promise<T>, pureStudent = true): Promise<T> {
    let rated = false;
    return this.assessment.run(req, write, async ctx => {
      this.assessment.require(ctx, 'learning:self');
      if (pureStudent && LEARNING_CONFLICTS.some(c => ctx.capabilities.includes(c))) fail(403, 'FORBIDDEN', '兼任内容或评估管理者不能访问学生学情');
      if (!rated) { await this.assessment.auth.rate('learning', `${ctx.orgId}:${ctx.memberId}:${write ? 'write' : 'read'}`, 60); rated = true; }
      return work(ctx);
    });
  }
  now(ctx: AssessmentContext) { return this.assessment.now(ctx); }
  idempotent<T>(ctx: AssessmentContext, req: ApiRequest, operation: string, resourceId: string, payload: unknown, work: () => Promise<T>) {
    return this.idempotentKey(ctx, req.get('Idempotency-Key') ?? '', operation, resourceId, payload, work);
  }
  async idempotentKey<T>(ctx: AssessmentContext, key: string, operation: string, resourceId: string, payload: unknown, work: () => Promise<T>, responseStatus = 200): Promise<T> {
    await requireEvidenceSubject(this.assessment.database.db, ctx.session, ctx.userId);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) fail(422, 'IDEMPOTENCY_KEY_REQUIRED', '请提供8至128字符幂等键');
    const filter = { org_id: ctx.orgId, user_id: ctx.userId, operation, resource_id: resourceId, key };
    const request_hash = createHash('sha256').update(canonical(payload)).digest('hex');
    const records = this.assessment.database.db.collection<IdempotencyRecord>('idempotency_records');
    const previous = await records.findOne(filter, { session: ctx.session });
    if (previous) {
      if (previous.request_hash !== request_hash) fail(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求');
      return previous.result as T;
    }
    const result = await work(), now = await this.now(ctx);
    await records.insertOne({ _id: randomUUID(), ...filter, request_hash, response_status: responseStatus, result: result as Record<string, unknown>, created_at: now, updated_at: now }, { session: ctx.session });
    return result;
  }
  cursor(ctx: AssessmentContext, resource: string, filters: unknown, generation: string | null, rawCursor: unknown, limit: number) {
    const scope = createHash('sha256').update(canonical({ org: ctx.orgId, user: ctx.userId, member: ctx.memberId, resource, filters, limit, rule: RULE_VERSION })).digest('hex');
    const sign = (value: string) => createHmac('sha256', this.assessment.auth.config.rateLimitKey).update(`learning-cursor:${value}`).digest('base64url');
    let after: string | undefined;
    if (rawCursor !== undefined) {
      let decoded: { scope: string; generation: string | null; after: string };
      try {
        const parts = text(rawCursor, 'cursor', 2000).split('.');
        const actual = Buffer.from(parts[1] ?? '', 'base64url'), expected = Buffer.from(sign(parts[0]), 'base64url');
        if (parts.length !== 2 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error();
        decoded = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        if (decoded.scope !== scope) throw Error();
        after = id(decoded.after);
      } catch { fail(422, 'CURSOR_INVALID', '分页游标无效'); }
      if (decoded.generation !== generation) fail(409, 'PROJECTION_CHANGED', '数据已变化，请从首页重新读取');
    }
    return { after, next: (key: string) => { const value = Buffer.from(JSON.stringify({ scope, generation, after: key })).toString('base64url'); return `${value}.${sign(value)}`; } };
  }
}
