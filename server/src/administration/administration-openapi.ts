const traceUuid = { type: "string" as const, format: "uuid" };
import type { OpenAPIObject, SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
const string: SchemaObject = { type: 'string' };
const resourceId: SchemaObject = { type: 'string', pattern: "^[0-9a-f]{24}$" };
const time: SchemaObject = { type: 'string', format: 'date-time' };
const integer: SchemaObject = { type: 'integer', minimum: 1 };
const object = (properties: Record<string, SchemaObject>, required = Object.keys(properties)): SchemaObject => ({ type: 'object', properties, required, additionalProperties: false });
const array = (items: SchemaObject): SchemaObject => ({ type: 'array', items });
const nullable = (shape: SchemaObject): SchemaObject => ({ ...shape, nullable: true });
const values = (...items: string[]): SchemaObject => ({ type: 'string', enum: items });
const scope = object({ kind: values('organization_ids', 'all_organizations'), organization_ids: array(resourceId) });
const password: SchemaObject = { type: 'string', format: 'password', writeOnly: true, maxLength: 512 };
const reason: SchemaObject = { type: 'string', minLength: 1, maxLength: 512 };
const roles = array(values('student', 'teacher', 'content_editor', 'content_reviewer', 'org_admin', 'platform_ops'));
const receipt = object({ operation_id: resourceId, status: values('pending', 'applied', 'rejected', 'needs_recovery'), approval_id: resourceId, temporary_password: { ...password, readOnly: true, writeOnly: false }, replayed: { type: 'boolean' }, password_not_replayable: { type: 'boolean' }, user_id: resourceId, member_id: resourceId, grant_id: resourceId }, ['operation_id', 'status']);
const user = object({ id: resourceId, login_name: string, display_name: string, status: values('active', 'disabled'), identity_revision: integer });
const userDetail = object({ ...user.properties, protected_account: { type: 'boolean' } });
const member = object({ id: resourceId, user_id: resourceId, display_name: string, status: values('active', 'disabled'), roles,
  role_assignments: array(object({ role_id: string, valid_from: nullable(time), valid_to: nullable(time) })), authorization_revision: integer });
const grant = object({ id: resourceId, subject_member_id: resourceId, capability: string, scope, valid_from: time, valid_to: nullable(time), revision: integer, status: values('pending', 'active', 'revoked'), delegate_capabilities: array(string) });
const approval = object({ id: resourceId, action: string, requester_id: resourceId, target_user_id: resourceId, target_member_id: nullable(resourceId), payload: { type: 'object' }, payload_hash: string, reason, status: values('pending', 'approved', 'rejected', 'applying', 'applied', 'needs_recovery'), revision: integer, approver_id: nullable(resourceId), created_at: time, updated_at: time });
const operation = object({ id: resourceId, operation_id: resourceId, action: string, status: string, step: string,
  approval_id: nullable(resourceId), approval_status: nullable(string),
  recovery: object({ state: string, recovery_token: nullable(string) }), created_at: time, updated_at: time },
  ['id', 'operation_id', 'action', 'status', 'created_at']);
const audit = object({ id: resourceId, actor_id: resourceId, org_id: nullable(resourceId), actor_org_id: nullable(resourceId), target_org_id: nullable(resourceId), action: string, resource_id: string, reason, request_id: traceUuid, operation_id: nullable(resourceId), approval_id: nullable(resourceId), grant_id: nullable(resourceId), created_at: time });
const list = (item: SchemaObject): SchemaObject => object({ items: array(item), next_cursor: nullable(string) });
const page = [{ in: 'query' as const, name: 'limit', required: false, schema: { type: 'integer' as const, minimum: 1, maximum: 50, default: 20 } }, { in: 'query' as const, name: 'cursor', required: false, schema: string }];
const content = (body: SchemaObject) => ({ required: true, content: { 'application/json': { schema: body } } });
const common = { reason, current_password: password };
const idempotency = [{ in: 'header' as const, name: 'Origin', required: true, schema: string }, { in: 'header' as const, name: 'X-CSRF-Token', required: true, schema: string }, { in: 'header' as const, name: 'Idempotency-Key', required: true, schema: { type: 'string' as const, pattern: '^[A-Za-z0-9_-]{8,128}$' } }];
const routes = [
  { path: 'context', method: 'get', data: object({ actor_org_id: resourceId, actor_member_id: resourceId, roles, capabilities: array(string), grants: array(grant), menus: array(string), catalog: array(object({ capability: string, storage_kind: string, required_roles: array(string), allowed_scopes: array(string), sensitive: { type: 'boolean' }, delegatable: { type: 'boolean' }, delegate_capabilities: array(string) })), target_organizations: list(object({ id: resourceId, name: string, kind: string, status: string })), database_mode: values('replicaSet', 'standalone') }) },
  { path: 'users', method: 'get', data: list(user), params: [...page,
    { in: 'query' as const, name: 'login_name', required: false, schema: string,
      description: '精确登录名；按现有登录规则去除首尾空格并转为小写。仅账号目录权限可查询，组织管理员仅返回当前组织成员；游标绑定规范化条件。' }] },
  { path: 'users/{userId}', method: 'get', data: userDetail },
  { path: 'users/{userId}/members', method: 'get', data: list(object({ id: resourceId, user_id: resourceId, display_name: string, status: values('active', 'disabled'), roles,
    role_assignments: array(object({ role_id: string, valid_from: nullable(time), valid_to: nullable(time) })), authorization_revision: integer, org_id: resourceId, organization_name: string })) , params: page },
  { path: 'users', method: 'post', data: receipt, body: object({ ...common, login_name: string, display_name: string, org_id: resourceId, roles, valid_to: nullable(time) },
    ['reason', 'current_password', 'login_name', 'display_name', 'org_id', 'roles']) },
  { path: 'organizations', method: 'get', data: list(object({ id: resourceId, name: string, kind: string, status: string })), params: page },
  { path: 'organizations/{orgId}/members', method: 'get', data: list(member), params: page },
  { path: 'organizations/{orgId}/members', method: 'post', data: receipt, body: object({ ...common, user_id: resourceId, roles, valid_to: nullable(time) },
    ['reason', 'current_password', 'user_id', 'roles']) },
  { path: 'members/{memberId}', method: 'put', data: receipt, body: object({ ...common, roles, status: values('active', 'disabled'), expected_revision: integer, valid_to: nullable(time) },
    ['reason', 'current_password', 'roles', 'status', 'expected_revision']) },
  { path: 'users/{userId}/status', method: 'put', data: receipt, body: object({ ...common, status: values('active', 'disabled'), expected_identity_revision: integer }) },
  { path: 'users/{userId}/password-reset', method: 'post', data: receipt, body: object({ ...common, expected_identity_revision: integer }) },
  { path: 'grants', method: 'get', data: list(grant), params: [...page, { in: 'query' as const, name: 'subject_member_id', required: false, schema: resourceId }, { in: 'query' as const, name: 'status', required: false, schema: values('active', 'pending', 'revoked') }] },
  { path: 'grants', method: 'post', data: receipt, body: object({ ...common, subject_member_id: resourceId, capability: string, scope, delegate_capabilities: array(string), valid_from: time, valid_to: nullable(time), expected_revision: integer }, ['reason', 'current_password', 'subject_member_id', 'capability', 'scope', 'valid_from', 'valid_to', 'expected_revision']) },
  { path: 'grants/{grantId}/revoke', method: 'post', data: receipt, body: object({ ...common, expected_revision: integer }) },
  { path: 'approvals', method: 'get', data: list(approval), params: [...page, { in: 'query' as const, name: 'status', required: false, schema: values('pending', 'approved', 'rejected', 'applying', 'applied', 'needs_recovery') }] },
  { path: 'approvals/{approvalId}', method: 'get', data: approval },
  { path: 'approvals/{approvalId}/decision', method: 'post', data: receipt, body: object({ ...common, decision: values('approve', 'reject'), expected_revision: integer }) },
  { path: 'operations', method: 'get', data: list(operation), params: [{ in: 'query' as const, name: 'key', required: true, schema: string }] },
  { path: 'operations/{operationId}', method: 'get', data: operation },
  { path: 'audit', method: 'get', data: list(audit), params: page },
] as const;
export function extendAdministrationOpenApi(document: OpenAPIObject): OpenAPIObject {
  for (const route of routes) {
    const path = `/api/v1/console/${route.path}`;
    const operation = document.paths[path]?.[route.method];
    if (!operation) throw new Error(`Console OpenAPI route is not registered: ${route.method} ${path}`);
    operation.tags = ['管理控制台'];
    operation.security = [{ session: [] }];
    operation.parameters = [
      { in: 'header', name: 'X-Org-Id', required: true, schema: resourceId },
      ...Array.from(route.path.matchAll(/\{([^}]+)\}/g), match => ({ in: 'path' as const, name: match[1]!, required: true, schema: resourceId })),
      ...('params' in route ? route.params : []),
      ...('body' in route ? idempotency : []),
    ];
    if ('body' in route) operation.requestBody = content(route.body);
    const schema = object({ data: route.data, request_id: traceUuid });
    operation.responses = { '200': { description: '请求成功；密码仅首次确认响应中交付，重放不交付', headers: { 'Cache-Control': { schema: values('no-store') }, 'X-Request-Id': { schema: traceUuid } }, content: { 'application/json': { schema } } },
      ...('body' in route ? { '202': { description: '需要独立审批，尚未生效', content: { 'application/json': { schema } } } } : {}) };
    for (const code of ['401', '403', '404', '409', '422', '429', '503']) operation.responses[code] = { description: '安全错误；写请求不得自动重放', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } };
  }
  return document;
}
