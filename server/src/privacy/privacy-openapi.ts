const traceUuid = { type: "string" as const, format: "uuid" };
import type { OpenAPIObject, ParameterObject, ReferenceObject, SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { PRIVACY_POLICY_REVISION, PRIVACY_STATUSES } from './schema';

type Schema = SchemaObject | ReferenceObject;
const text: SchemaObject = { type: 'string' };
const resourceId: SchemaObject = { type: 'string', pattern: "^[0-9a-f]{24}$" };
const choice = (...values: string[]): SchemaObject => ({ type: 'string', enum: values });
const object = (properties: Record<string, Schema>): SchemaObject => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const ref = (name: string): ReferenceObject => ({ $ref: `#/components/schemas/${name}` });
const strings: SchemaObject = { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string', maxLength: 512 } };

export function privacyOpenApi(document: OpenAPIObject): void {
  document.components ??= {};
  document.components.schemas ??= {};
  Object.assign(document.components.schemas, {
    PrivacyDeletionInput: object({ scope: choice('account'), policy_revision: choice(PRIVACY_POLICY_REVISION), current_password: { type: 'string', minLength: 1, maxLength: 1024, writeOnly: true, format: 'password' } }),
    PrivacyRequestView: object({
      id: resourceId, scope: choice('account'), policy_revision: choice(PRIVACY_POLICY_REVISION), status: choice(...PRIVACY_STATUSES),
      revision: { type: 'integer', minimum: 1 }, created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' },
      deleted_categories: strings, retained_categories: strings, retention_basis: { type: 'string', nullable: true, enum: ['local_minimal_provenance', 'local_hold_and_provenance', null] },
      remaining_actions: { type: 'array', uniqueItems: true, items: choice('resume_erasure', 'review_policy', 'review_retention') },
    }),
    PrivacyRequestPage: object({ items: { type: 'array', maxItems: 50, items: ref('PrivacyRequestView') }, next_cursor: { type: 'string', nullable: true } }),
  });
  const base = '/api/v1/privacy/deletion-requests';
  for (const route of [
    { path: base, method: 'post' as const, schema: 'PrivacyRequestView', status: '202', summary: '登记本人全局账号删除申请，不执行删除' },
    { path: base, method: 'get' as const, schema: 'PrivacyRequestPage', status: '200', summary: '分页读取本人全局账号删除申请' },
    { path: `${base}/{id}`, method: 'get' as const, schema: 'PrivacyRequestView', status: '200', summary: '读取本人删除申请安全状态' },
  ]) {
    const operation = document.paths[route.path]?.[route.method];
    if (!operation) throw new Error(`Missing privacy API route: ${route.path}`);
    operation.summary = route.summary;
    operation.description = '仅本地原始/合成环境；全局本人账号，不要求X-Org-Id。202只表示申请已登记。正文最多2KiB且不接受未知字段。首次提交验证当前密码；同key重放仍须当前有效身份，但密码不进入规范hash或持久回执。处理中申请不能重复登记。游标签名绑定本人和分页大小。身份冻结后原会话不可查询或重放，无匿名查询后门。';
    operation.security = [{ session: [] }];
    const parameters: ParameterObject[] = [];
    if (route.method === 'post') {
      for (const name of ['Origin', 'X-CSRF-Token', 'Idempotency-Key']) parameters.push({ in: 'header', name, required: true, schema: name === 'Idempotency-Key' ? { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' } : text });
      operation.requestBody = { required: true, content: { 'application/json': { schema: ref('PrivacyDeletionInput') } } };
    } else if (route.path.endsWith('{id}')) parameters.push({ in: 'path', name: 'id', required: true, schema: resourceId });
    else parameters.push({ in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }, { in: 'query', name: 'cursor', schema: { type: 'string', maxLength: 2000 } });
    operation.parameters = parameters;
    operation.responses = {
      [route.status]: { description: route.summary, headers: { 'Cache-Control': { schema: choice('private, no-store') }, 'X-Request-Id': { schema: traceUuid } }, content: { 'application/json': { schema: object({ data: ref(route.schema), request_id: traceUuid }) } } },
    };
    const errors = {
      '401': 'SESSION_EXPIRED / INVALID_CREDENTIALS',
      '403': 'ORIGIN_REJECTED / CSRF_REJECTED / PASSWORD_CHANGE_REQUIRED',
      '404': 'NOT_FOUND；非本人对象不可枚举',
      '409': 'IDEMPOTENCY_CONFLICT / PRIVACY_REVISION_CONFLICT / IDENTITY_CHANGED',
      '413': 'PAYLOAD_TOO_LARGE',
      '422': 'VALIDATION_ERROR / IDEMPOTENCY_KEY_REQUIRED / CURSOR_INVALID',
      '429': 'RATE_LIMITED',
      '503': 'LOCAL_PRIVACY_UNAVAILABLE / DEPENDENCY_UNAVAILABLE / AUTH_BUSY / MAINTENANCE_ACTIVE / RESTORE_QUARANTINED；未知提交须保留原key',
    };
    for (const [status, description] of Object.entries(errors)) operation.responses[status] = { description, content: { 'application/json': { schema: ref('ApiError') } }, ...(status === '429' ? { headers: { 'Retry-After': { schema: text } } } : {}) };
  }
}
