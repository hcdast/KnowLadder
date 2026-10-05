import { newId } from "../database/object-id";
import { Injectable } from '@nestjs/common';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import { AuthService, Identity } from '../auth.service';
import { Database } from '../database/database';
import { ApiRequest, fail } from '../errors';
import { canonical, id, integer, object } from '../content/dto';
import { verifyPassword } from '../security/password';
import { assertLocalEnvironment } from '../operations/contracts';
import { PRIVACY_POLICY_REVISION } from './schema';
import { PrivacyReceipt, PrivacyRequest, PrivacyRequestPage, PrivacyRequestView, privacyRequestView } from './contracts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class PrivacyService {
  constructor(readonly database: Database, readonly auth: AuthService) {}

  private async identity(req: ApiRequest, session?: ClientSession): Promise<Identity> {
    const identity = await this.auth.identify(req, false, session);
    if (identity.user.must_change_password) fail(403, 'PASSWORD_CHANGE_REQUIRED', '请先修改临时密码');
    try { assertLocalEnvironment(this.database.db); }
    catch { fail(503, 'LOCAL_PRIVACY_UNAVAILABLE', '本地隐私功能在当前环境不可用'); }
    return identity;
  }

  async create(req: ApiRequest, raw: unknown): Promise<PrivacyRequestView> {
    if (Buffer.byteLength(JSON.stringify(raw) ?? '', 'utf8') > 2048) fail(413, 'PAYLOAD_TOO_LARGE', '申请正文不得超过2KiB');
    const input = object(raw, ['scope', 'policy_revision', 'current_password']);
    if (input.scope !== 'account' || input.policy_revision !== PRIVACY_POLICY_REVISION || typeof input.current_password !== 'string' || !input.current_password.length || input.current_password.length > 1024)
      fail(422, 'VALIDATION_ERROR', '请确认账号范围、隐私政策及当前密码');
    const password = input.current_password;
    const key = req.get('Idempotency-Key') ?? '';
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) fail(422, 'IDEMPOTENCY_KEY_REQUIRED', '请提供8至128字符幂等键');
    this.auth.origin(req);
    const initial = await this.identity(req);
    this.auth.csrf(req, initial.session);
    await this.auth.rate('privacy-request-ip', req.ip ?? 'unknown', 30);
    await this.auth.rate('privacy-request-user', initial.user._id, 10);
    const keyHash = digest(key);
    const requestHash = digest(canonical({ scope: input.scope, policy_revision: input.policy_revision }));
    return this.database.transaction(async session => {
      const identity = await this.identity(req, session);
      this.auth.csrf(req, identity.session);
      await this.auth.fenceUser(identity.user, session);
      const requests = this.database.db.collection<PrivacyRequest>('privacy_deletion_requests');
      const receipts = this.database.db.collection<PrivacyReceipt>('privacy_operation_receipts');
      const receipt = await receipts.findOne({ user_id: identity.user._id, key_hash: keyHash }, { session });
      if (receipt) {
        if (receipt.request_hash !== requestHash) fail(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同申请');
        const previous = await requests.findOne({ _id: receipt.request_id, user_id: identity.user._id }, { session });
        if (!previous) fail(503, 'DEPENDENCY_UNAVAILABLE', '申请回执暂不可用');
        return privacyRequestView(previous);
      }
      if (!await verifyPassword(identity.user.password_hash, password)) fail(401, 'INVALID_CREDENTIALS', '当前密码错误');
      const ongoing = await requests.findOne({ user_id: identity.user._id, status: { $nin: ['rejected', 'completed', 'completed_with_retention'] } }, { session });
      if (ongoing) fail(409, 'PRIVACY_REVISION_CONFLICT', '已有处理中申请，请查看当前状态');
      const now = new Date();
      const row: PrivacyRequest = {
        _id: newId(), user_id: identity.user._id, scope: 'account', policy_revision: PRIVACY_POLICY_REVISION,
        status: 'requested', revision: 1, plan_hash: null, actor: null, reason_code: null,
        deleted_categories: [], retained_categories: [], retention_basis: null, remaining_actions: [],
        created_at: now, updated_at: now, lease_token: null, lease_until: null, ledger_sequence: null, completed_steps: [],
      };
      await requests.insertOne(row, { session });
      await receipts.insertOne({ _id: newId(), user_id: identity.user._id, key_hash: keyHash, request_hash: requestHash, request_id: row._id, created_at: now }, { session });
      return privacyRequestView(row);
    });
  }

  async list(req: ApiRequest, raw: unknown): Promise<PrivacyRequestPage> {
    const query = object(raw, ['limit', 'cursor']);
    const limit = query.limit === undefined ? 20 : integer(typeof query.limit === 'string' && /^[1-9]\d*$/.test(query.limit) ? Number(query.limit) : query.limit, 'limit', 1, 50);
    return this.database.transaction(async session => {
      const identity = await this.identity(req, session);
      await this.auth.fenceUser(identity.user, session);
      const scope = digest(canonical({ user: identity.user._id, resource: 'privacy-deletion-requests', limit }));
      const sign = (value: string) => createHmac('sha256', this.auth.config.rateLimitKey).update(`privacy-cursor:${value}`).digest('base64url');
      let after: string | undefined;
      if (query.cursor !== undefined) {
        try {
          if (typeof query.cursor !== 'string' || query.cursor.length > 2000) throw Error();
          const parts = query.cursor.split('.');
          const actual = Buffer.from(parts[1] ?? '', 'base64url');
          const expected = Buffer.from(sign(parts[0]), 'base64url');
          if (parts.length !== 2 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error();
          const decoded = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
          if (decoded.scope !== scope) throw Error();
          after = id(decoded.after);
        } catch { fail(422, 'CURSOR_INVALID', '分页游标无效'); }
      }
      const rows = await this.database.db.collection<PrivacyRequest>('privacy_deletion_requests').find({ user_id: identity.user._id, ...(after ? { _id: { $gt: after } } : {}) }, { session }).sort({ _id: 1 }).limit(limit + 1).toArray();
      const page = rows.slice(0, limit);
      let next: string | null = null;
      if (rows.length > limit) {
        const value = Buffer.from(JSON.stringify({ scope, after: page[page.length - 1]._id })).toString('base64url');
        next = `${value}.${sign(value)}`;
      }
      return { items: page.map(privacyRequestView), next_cursor: next };
    });
  }

  async detail(req: ApiRequest, requestId: string): Promise<PrivacyRequestView> {
    const key = id(requestId);
    return this.database.transaction(async session => {
      const identity = await this.identity(req, session);
      await this.auth.fenceUser(identity.user, session);
      const row = await this.database.db.collection<PrivacyRequest>('privacy_deletion_requests').findOne({ _id: key, user_id: identity.user._id }, { session });
      if (!row) fail(404, 'NOT_FOUND', '申请不存在');
      return privacyRequestView(row);
    });
  }
}
