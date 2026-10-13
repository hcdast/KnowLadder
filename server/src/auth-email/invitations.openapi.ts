import type { OpenAPIObject, SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
const string: SchemaObject = { type: 'string' };
const id: SchemaObject = { type: 'string', pattern: '^[0-9a-f]{24}$' };
const time: SchemaObject = { type: 'string', format: 'date-time' };
const trace: SchemaObject = { type: 'string', format: 'uuid' };
const object = (properties: Record<string, SchemaObject>): SchemaObject => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const token: SchemaObject = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$', writeOnly: true };
const routes = [
  { name: 'inspect', body: object({ token }), result: object({ invitation_id: id, organization: object({ id, name: string }), state: { type: 'string', enum: ['pending'] }, expires_at: time, action: { type: 'string', enum: ['accept', 'activate'] } }), description: '有效preauth或authenticated会话及该会话自己的CSRF；只读、不消费令牌，不返回邮箱和角色。' },
  { name: 'accept', body: object({ token }), result: object({ member_id: id, authorization_revision: { type: 'integer', minimum: 1 } }), description: '已认证且验证邮箱匹配固定受益人；仅新增组织关联，已有active或disabled成员返回409 MEMBER_EXISTS，须使用现有成员管理，不替换既有角色/grant。同事务重核当前操作者、独立审批、组织/角色期限、payload与修订，消费单次邀请。正常身份复核不使链接失效，真正撤权/改密/停用仍拒绝。' },
  { name: 'activate', body: object({ token, age_band: { type: 'string', enum: ['adult'] }, accepted_terms: { type: 'boolean', enum: [true] }, terms_version: { type: 'string', maxLength: 100 }, privacy_notice_version: { type: 'string', maxLength: 100 }, display_name: { type: 'string', minLength: 1, maxLength: 100 }, new_password: { type: 'string', minLength: 6, maxLength: 128, format: 'password', writeOnly: true } }), result: object({ user_id: id, login_name: string, session_expires_at: time }), description: '仅preauth；最终收件人声明成年并接受当前政策，新账号/邮箱/准入/非敏感成员与新会话同事务。已登录浏览器必须明确退出切换，不覆盖原账号密码。' },
];
export function extendInvitationsOpenApi(document: OpenAPIObject): OpenAPIObject {
  for (const route of routes) {
    const operation = document.paths[`/api/v1/auth/invitations/${route.name}`]?.post;
    if (!operation) throw new Error(`Invitation route is not registered: ${route.name}`);
    operation.tags = ['邮箱认证']; operation.description = route.description; operation.security = [{ session: [] }];
    operation.parameters = [{ in: 'header', name: 'Origin', required: true, schema: string }, { in: 'header', name: 'X-CSRF-Token', required: true, schema: string }];
    operation.requestBody = { required: true, content: { 'application/json': { schema: route.body } } };
    operation.responses = { '200': { description: '已确认结果；提交未知先只读确认，不自动重放令牌。', headers: { 'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } } }, content: { 'application/json': { schema: object({ data: route.result, request_id: trace }) } } } };
    for (const code of ['401', '403', '409', '422', '429', '503']) operation.responses[code] = { description: 'EMAIL_ACTION_INVALID / INVITATION_UNAVAILABLE / PROTECTED_ACCOUNT / AUTH_ACCOUNT_SWITCH_REQUIRED / ADULT_ADMISSION_REQUIRED / AUTH_TRANSACTION_REQUIRED；不可自动重放。', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } };
  }
  return document;
}
