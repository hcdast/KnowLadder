import { createHash } from 'node:crypto';
import { canonical, id, integer, object, text } from '../assessment/dto';
import { fail } from '../errors';
import { ROLE_CAPABILITIES, validLogin, normalizeLogin, type RoleCode, type AdministrativeScope } from '../database/contracts';

export { canonical, id, integer, object, text };
export const boundedReason = (value: unknown) => text(value, 'reason', 512).trim();
export const currentPassword = (value: unknown) => text(value, 'current_password', 512);
export function roles(value: unknown, allowEmpty = false): RoleCode[] {
  if (!Array.isArray(value) || value.length > 6 || !allowEmpty && value.length === 0 ||
      value.some(v => typeof v !== 'string' || !Object.hasOwn(ROLE_CAPABILITIES, v)) ||
      new Set(value).size !== value.length) fail(422, 'VALIDATION_ERROR', '角色列表无效');
  return (value as RoleCode[]).slice().sort();
}
export function login(value: unknown): string {
  if (typeof value !== 'string' || !validLogin(value)) fail(422, 'VALIDATION_ERROR', '登录名无效');
  return normalizeLogin(value);
}
export function revision(value: unknown, field: string) { return integer(value, field, 1); }
export function status(value: unknown): 'active' | 'disabled' {
  if (value !== 'active' && value !== 'disabled') fail(422, 'VALIDATION_ERROR', '状态无效');
  return value;
}
export function scope(value: unknown): AdministrativeScope {
  const row = object(value, ['kind', 'organization_ids']);
  if (row.kind === 'all_organizations') {
    if (row.organization_ids !== undefined && (!Array.isArray(row.organization_ids) || row.organization_ids.length)) fail(422, 'VALIDATION_ERROR', '全组织范围不可组合组织ID');
    return { kind: 'all_organizations', organization_ids: [] };
  }
  if (row.kind !== 'organization_ids' || !Array.isArray(row.organization_ids) || !row.organization_ids.length || row.organization_ids.length > 50) fail(422, 'VALIDATION_ERROR', '组织范围无效');
  const ids = row.organization_ids.map(v => id(v));
  if (new Set(ids).size !== ids.length) fail(422, 'VALIDATION_ERROR', '组织范围不可重复');
  return { kind: 'organization_ids', organization_ids: ids.sort() };
}
export function date(value: unknown, field: string, nullable = false): Date | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail(422, 'VALIDATION_ERROR', `${field}无效`);
  return new Date(value);
}
export function page(raw: unknown, actor: string, mode: string, resource: string, filters: Record<string, unknown>) {
  const q = object(raw, ['cursor', 'limit', ...Object.keys(filters)]);
  const limit = q.limit === undefined ? 20 : integer(Number(q.limit), 'limit', 1, 50);
  const normalized = Object.fromEntries(Object.keys(filters).sort().map(k => [k, q[k] ?? null]));
  const bind = createHash('sha256').update(canonical({ actor, mode, resource, normalized, limit })).digest('hex');
  let after: string | null = null;
  if (q.cursor !== undefined) {
    try {
      const rawCursor = text(q.cursor, 'cursor', 1000);
      const parsed: unknown = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || !('bind' in parsed) || parsed.bind !== bind || !('after' in parsed)) throw Error();
      after = id(parsed.after);
    } catch { fail(422, 'CURSOR_INVALID', '分页游标无效'); }
  }
  return { q, limit, after, next: (last: string) => Buffer.from(JSON.stringify({ bind, after: last })).toString('base64url') };
}
export function safeGrant(row: Record<string, unknown>) {
  return { id: row._id, subject_member_id: row.subject_member_id ?? row.member_id, capability: row.capability, scope: row.scope ?? { kind: 'organization_ids', organization_ids: [row.org_id] }, valid_from: row.valid_from, valid_to: row.valid_to, revision: row.revision, status: row.status, delegate_capabilities: row.delegate_capabilities ?? [] };
}
export function safeUser(row: { _id: string; login_key: string; display_name: string; status: string; identity_revision: number }) { return { id: row._id, login_name: row.login_key, display_name: row.display_name, status: row.status, identity_revision: row.identity_revision }; }
