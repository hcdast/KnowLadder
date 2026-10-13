import { newId } from "../database/object-id";
import { Injectable } from '@nestjs/common';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { ClientSession, Db, Document, Filter, MongoClient } from 'mongodb';
import { AuthService, type Identity } from '../auth.service';
import { Database } from '../database/database';
import { resolvedTxnMode } from '../database/topology';
import { collections, ROLE_CAPABILITIES, type Member, type RoleCode, type User, type AuthorizationRequest, type AdministrationOperation, type AdministrationGuard, type AuditEvent, type AdministrativeScope, type AdministrativeGrant, type MemberCapabilityGrant, type AdministrativeCapability, type ControlledCapability, type GrantStatus } from '../database/contracts';
import { ApiRequest, fail } from '../errors';
import { hashPassword, temporaryPassword, verifyPassword } from '../security/password';
import { ADMINISTRATIVE_CATALOG, MEMBER_CAPABILITY_CATALOG, DELEGABLE_CAPABILITIES, assertGrantPolicy, scopeFingerprint } from './catalog';
import { activeMemberGrants, activeMemberRoles, effectiveAdministrativeGrants, assertAdministrationAccess, assertRetainsGovernance } from './authorization';
import { executeAdministrationOperation, recoverAdministrationOperation, cancelAdministrationOperation, releaseInvalidatedAdministration } from './operations';
import { canonical, currentPassword, boundedReason, date, id, login, object, page, revision, roles, safeGrant, safeUser, scope, status, text } from './dto';
import { protectedAccount } from './protected-account';
import { emailCollections, type AuthInvitation, type EmailChallenge, type EmailIdentity } from '../auth-email/contracts';
import { issueEmailChallenge, normalizeEmail, revokeEmailChallenges } from '../auth-email/tokens';
import { enqueueEmail } from '../auth-email/mail';
import { AuthEmailService } from '../auth-email/service';

const privacyActive: Filter<User> = { $or: [{ privacy_state: 'active' }, { privacy_state: { $exists: false } }] };
const sensitive: Record<string, true> = { 'platform:govern': true, 'account:platform-manage': true, 'authorization:delegate': true,
  'content:review': true, 'assessment:review': true, 'teaching:report': true, 'report:read': true,
  'content:retire': true, 'content:revoke': true, 'file:delete': true };
const adminCapabilities: Record<string, true> = { 'platform:govern': true, 'account:platform-manage': true,
  'account:manage': true, 'authorization:delegate': true };
const platformBusiness: Record<string, true> = Object.fromEntries(Object.keys(ADMINISTRATIVE_CATALOG)
  .filter(capability => !Object.hasOwn(adminCapabilities, capability)).map(capability => [capability, true])) as Record<string, true>;
const permissionHash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const validAtDatabaseTime: Document = { $and: [
  { $lte: ['$valid_from', '$$NOW'] },
  { $or: [{ $eq: ['$valid_to', null] }, { $gt: ['$valid_to', '$$NOW'] }] },
] };
type ActorPolicy = { identity: Pick<Identity, 'user'>; member: Member; orgId: string; roles: RoleCode[]; capabilities: string[]; grants: Document[]; admin: Document[]; organizationKind: string };
type Actor = ActorPolicy & { identity: Identity };
type Approval = AuthorizationRequest;
type GrantRecord = AdministrativeGrant | MemberCapabilityGrant;
function isAdministrativeCapability(value: string): value is AdministrativeCapability {
  return Object.hasOwn(ADMINISTRATIVE_CATALOG, value);
}
function isControlledCapability(value: string): value is ControlledCapability {
  return Object.hasOwn(MEMBER_CAPABILITY_CATALOG, value);
}

/** Management-role proof for callbacks that own the administration guard. */
async function currentManagementRoles(db: Db, memberId: string, orgId: string, session?: ClientSession): Promise<RoleCode[]> {
  const rows = await collections(db).memberRoles.find({ member_id: memberId, org_id: orgId,
    role_id: { $in: ['platform_ops', 'org_admin'] }, $expr: { $and: [
      { $eq: [{ $ifNull: ['$status', 'active'] }, 'active'] },
      { $lte: [{ $ifNull: ['$valid_from', new Date(0)] }, '$$NOW'] },
      { $or: [{ $eq: [{ $ifNull: ['$valid_to', null] }, null] }, { $gt: ['$valid_to', '$$NOW'] }] },
    ] } }, { session }).toArray();
  const roles: RoleCode[] = [];
  for (const row of rows) {
    if (row.operation_id && !await db.collection<AdministrationOperation>('administration_operations').findOne({ _id: row.operation_id, status: 'applied' }, { session, projection: { _id: 1 } })) continue;
    roles.push(row.role_id);
  }
  return roles;
}
/** Used by HTTP approval and explicit CLI recovery; reads current authority, never the request snapshot as authority. */
async function assertRequesterCurrent(db: Db, request: Approval, session?: ClientSession) {
  const c = collections(db);
  const user = await c.users.findOne({ _id: request.requester_user_id, status: 'active', ...privacyActive }, { session });
  const member = await c.members.findOne({ _id: request.requester_member_id, user_id: request.requester_user_id, status: 'active' }, { session });
  if (!user || !member || user.must_change_password || user.credential_version !== request.requester_credential_version)
    fail(409, 'REQUESTER_CHANGED', '申请人身份或凭据已变化');
  const org = await c.organizations.findOne({ _id: member.org_id, status: 'active' }, { session });
  const roleIds = await currentManagementRoles(db, member._id, member.org_id, session);
  if (!org) fail(409, 'REQUESTER_CHANGED', '申请人组织已失效');
  const relevant: AdministrativeCapability[] = request.action === 'invitation.create' ? ['platform:govern'] :
    request.action.startsWith('grant.') ? ['platform:govern', 'authorization:delegate'] : ['account:platform-manage', 'account:manage', 'platform:govern'];
  const grants = await db.collection<AdministrativeGrant>('administrative_grants').find({ subject_member_id: member._id, actor_org_id: member.org_id, capability: { $in: relevant },
    status: 'active', $expr: validAtDatabaseTime }, { session }).toArray();
  for (const grant of grants) {
    if (!grant.operation_id || !await db.collection<AdministrationOperation>('administration_operations').findOne({ _id: grant.operation_id, status: 'applied' }, { session })) continue;
    if (grant.capability === 'platform:govern' || grant.capability === 'account:platform-manage') {
      if (org.kind !== 'platform' || !roleIds.includes('platform_ops') ||
          grant.scope?.kind !== 'organization_ids' || !grant.scope.organization_ids.includes(member.org_id)) continue;
    } else if (!roleIds.includes('org_admin') || grant.scope?.kind !== 'organization_ids' || !grant.scope.organization_ids.includes(member.org_id)) continue;
    if (request.action.startsWith('grant.') && grant.capability === 'authorization:delegate' &&
        (request.action !== 'grant.create' || request.payload.org_id !== member.org_id ||
          !Array.isArray(grant.delegate_capabilities) || !grant.delegate_capabilities.includes(request.payload.capability))) continue;
    if (grant.capability === 'account:manage' && request.payload.org_id !== member.org_id && request.action !== 'user.password.reset') continue;
    if (grant.capability === 'account:manage' && request.action === 'user.password.reset') {
      const owners = await c.members.find({ user_id: request.beneficiary_user_id }, { session, projection: { org_id: 1 } }).limit(2).toArray();
      if (owners.length !== 1 || owners[0]!.org_id !== member.org_id) continue;
    }
    return;
  }
  fail(409, 'REQUESTER_CHANGED', '申请人当前已不具备申请权限');
}
@Injectable()
export class AdministrationService {
  constructor(readonly database: Database, readonly auth: AuthService, readonly email: AuthEmailService) {}
  private get c() { return collections(this.database.db); }
  private get db() { return this.database.db; }
  private async actor(req: ApiRequest, session?: ClientSession): Promise<Actor> {
    const identity = await this.auth.identify(req, false, session);
    if (identity.user.must_change_password) fail(403, 'PASSWORD_CHANGE_REQUIRED', '请先修改临时密码');
    const orgId = id(req.get('X-Org-Id'));
    const [member, org] = await Promise.all([
      this.c.members.findOne({ user_id: identity.user._id, org_id: orgId, status: 'active' }, { session }),
      this.c.organizations.findOne({ _id: orgId, status: 'active' }, { session }),
    ]);
    if (!member || !org) fail(403, 'FORBIDDEN', '当前组织无管理权限');
    await assertAdministrationAccess(this.db, identity.user._id, orgId, session);
    const roleRows = await activeMemberRoles(this.db, { member_id: member._id, org_id: orgId }, session);
    const roles = roleRows.map(r => r.role_id);
    const [grants, admin] = await Promise.all([
      activeMemberGrants(this.db, { member_id: member._id, org_id: orgId }, session),
      effectiveAdministrativeGrants(this.db, member._id, session),
    ]);
    const capabilities = [...new Set([...roles.flatMap(role => ROLE_CAPABILITIES[role]), ...grants.map(g => g.capability), ...admin.map(g => g.capability as string)])];
    if (identity.user._id.startsWith('system:') || capabilities.includes('assessment:worker') || capabilities.includes('learning:projection-worker')) fail(403, 'FORBIDDEN', '内部身份不可使用控制台');
    return { identity, member, orgId, roles, grants, admin, capabilities, organizationKind: org.kind };
  }
  private require(actor: ActorPolicy, capability: string): void {
    if (!actor.capabilities.includes(capability)) fail(403, 'FORBIDDEN', '没有相应管理职责');
    if ((capability === 'platform:govern' || capability === 'account:platform-manage') && (actor.organizationKind !== 'platform' || !actor.roles.includes('platform_ops'))) fail(403, 'FORBIDDEN', '需要平台职责');
    if (capability === 'account:manage' && !actor.roles.includes('org_admin')) fail(403, 'FORBIDDEN', '需要组织管理职责');
  }
  private canAccounts(actor: ActorPolicy, orgId?: string): void {
    if (actor.capabilities.includes('account:platform-manage') && actor.organizationKind === 'platform' && actor.roles.includes('platform_ops')) return;
    this.require(actor, 'account:manage');
    if (orgId && actor.orgId !== orgId) fail(404, 'NOT_FOUND', '目标不在当前组织范围');
  }
  private isPlatformAccounts(actor: ActorPolicy) { return actor.organizationKind === 'platform' && actor.roles.includes('platform_ops') && actor.capabilities.includes('account:platform-manage'); }
  private protectedAccount(userId: string, session?: ClientSession): Promise<boolean> {
    return protectedAccount(this.db, userId, session);
  }
  private async writeActor(req: ApiRequest, body: Record<string, unknown>): Promise<Actor> {
    this.auth.origin(req);
    const actor = await this.actor(req);
    this.auth.csrf(req, actor.identity.session);
    await this.auth.rate('administration-password', actor.identity.user._id, 15);
    if (!(await verifyPassword(actor.identity.user.password_hash, currentPassword(body.current_password)))) fail(401, 'INVALID_CREDENTIALS', '当前密码错误');
    if (!req.get('Idempotency-Key')?.match(/^[A-Za-z0-9_-]{8,128}$/)) fail(422, 'IDEMPOTENCY_KEY_REQUIRED', '请提供有效幂等键');
    return actor;
  }
  private async assertActorUnchanged(actor: ActorPolicy, session: ClientSession, capability: AdministrativeCapability, delegatedCapability?: string) {
    const user = await this.c.users.findOne({ _id: actor.identity.user._id, credential_version: actor.identity.user.credential_version, status: 'active', ...privacyActive }, { session });
    const member = await this.c.members.findOne({ _id: actor.member._id, user_id: actor.identity.user._id, org_id: actor.orgId, status: 'active' }, { session });
    const org = await this.c.organizations.findOne({ _id: actor.orgId, status: 'active' }, { session });
    if (!user || !member || !org || user.must_change_password) fail(409, 'AUTHORIZATION_CHANGED', '操作者身份已改变');
    const roleIds = await currentManagementRoles(this.db, member._id, actor.orgId, session);
    if (capability === 'account:manage' && !roleIds.includes('org_admin') ||
        ['platform:govern', 'account:platform-manage'].includes(capability) && (org.kind !== 'platform' || !roleIds.includes('platform_ops'))) fail(403, 'FORBIDDEN', '操作者角色已失效');
    // Guard intentionally remains active; only this exact operation callback reads raw grant rows.
    const admins = await this.db.collection<AdministrativeGrant>('administrative_grants').find({ subject_member_id: member._id, actor_org_id: actor.orgId, capability,
      status: 'active', $expr: validAtDatabaseTime }, { session }).toArray();
    for (const grant of admins) {
      if (grant.operation_id && !await this.db.collection<AdministrationOperation>('administration_operations').findOne({ _id: grant.operation_id, status: 'applied' }, { session })) continue;
      if (grant.scope?.kind !== 'organization_ids' || !grant.scope.organization_ids.includes(actor.orgId)) continue;
      if (capability === 'authorization:delegate' &&
          (!delegatedCapability || !Array.isArray(grant.delegate_capabilities) || !grant.delegate_capabilities.includes(delegatedCapability))) continue;
      return;
    }
    fail(403, 'FORBIDDEN', '操作者管理授权已失效');
  }
  private async target(userId: string, session?: ClientSession) {
    const target = await this.c.users.findOne({ _id: userId, ...privacyActive }, { session });
    if (!target) fail(404, 'NOT_FOUND', '目标账号不存在');
    return target;
  }
  private reviewerExpiry(raw: unknown, desired: RoleCode[], addingReviewer: boolean): Date | null | undefined {
    const value = raw === undefined ? undefined : date(raw, 'valid_to', true);
    if (value && !desired.includes('content_reviewer')) fail(422, 'VALIDATION_ERROR', '只有内容审核角色可指定期限');
    if (value && value <= new Date()) fail(422, 'VALIDATION_ERROR', '审核角色期限必须在未来');
    if (addingReviewer && !value) fail(422, 'REVIEWER_EXPIRY_REQUIRED', '新增或续期内容审核角色必须设置期限');
    return value;
  }
  private async roleDecision(actor: ActorPolicy, desired: RoleCode[], existing: RoleCode[], targetUser: string, orgId: string) {
    if (desired.includes('platform_ops') && (!actor.capabilities.includes('platform:govern') || actor.organizationKind !== 'platform')) fail(403, 'FORBIDDEN', '平台身份只能由治理管理员申请');
    if (desired.includes('platform_ops') && orgId !== actor.orgId) fail(422, 'VALIDATION_ERROR', '平台身份必须属于当前平台组织');
    const gained = desired.filter(role => !existing.includes(role)).flatMap(role => ROLE_CAPABILITIES[role]);
    const sensitiveGained = gained.some(c => Object.hasOwn(sensitive, c)) || desired.includes('platform_ops') && !existing.includes('platform_ops');
    if (targetUser === actor.identity.user._id && (gained.length > 0 || sensitiveGained)) fail(403, 'SELF_ESCALATION', '不可给自己扩大角色权限');
    if (!this.isPlatformAccounts(actor) && !actor.capabilities.includes('platform:govern')) {
      this.canAccounts(actor, orgId);
      if (gained.some(c => c !== 'account:read' && c !== 'learning:self' && c !== 'teaching:class' && c !== 'organization:admin' && c !== 'content:edit' && !Object.hasOwn(sensitive, c))) fail(403, 'FORBIDDEN', '不可授予未获委派的角色能力');
    }
    return sensitiveGained;
  }
  private async invitationActor(payload: AuthInvitation['payload'], session: ClientSession): Promise<ActorPolicy> {
    const member = await this.c.members.findOne({ _id: payload.actor_member_id, org_id: payload.actor_org_id, status: 'active' }, { session });
    const issuer = member && await this.c.users.findOne({ _id: member.user_id, status: 'active',
      credential_version: payload.actor_credential_version, ...privacyActive }, { session });
    const org = await this.c.organizations.findOne({ _id: payload.actor_org_id, status: 'active' }, { session });
    if (!issuer || !member || !org || issuer.must_change_password) fail(409, 'INVITATION_UNAVAILABLE', '邀请操作者身份或权限已变化');
    await assertAdministrationAccess(this.db, issuer._id, org._id, session);
    const roleRows = await activeMemberRoles(this.db, { member_id: member._id, org_id: org._id }, session);
    const [grants, admin] = await Promise.all([activeMemberGrants(this.db, { member_id: member._id, org_id: org._id }, session),
      effectiveAdministrativeGrants(this.db, member._id, session)]);
    const roleIds = roleRows.map(row => row.role_id);
    const capabilities = [...new Set([...roleIds.flatMap(role => ROLE_CAPABILITIES[role]), ...grants.map(grant => grant.capability), ...admin.map(grant => grant.capability)])];
    return { identity: { user: issuer }, member, orgId: org._id, roles: roleIds, capabilities, grants, admin, organizationKind: org.kind };
  }
  private async persistInvitation(payload: AuthInvitation['payload'], session: ClientSession, now: Date, operationId: string, approvalId: string | null) {
    const expiresAt = date(payload.expires_at, 'expires_at')!, validTo = date(payload.valid_to, 'valid_to', true);
    if (expiresAt <= now || validTo && validTo <= now) fail(409, 'INVITATION_UNAVAILABLE', '邀请或角色期限已过期');
    if (!await this.c.organizations.findOne({ _id: payload.org_id, status: 'active' }, { session }))
      fail(409, 'INVITATION_UNAVAILABLE', '目标组织已失效');
    const member = payload.target_user_id ? await this.c.members.findOne({ user_id: payload.target_user_id, org_id: payload.org_id }, { session }) : null;
    if (member) fail(409, 'MEMBER_EXISTS', '目标已关联本组织，请使用现有成员管理，不通过邀请替换角色');
    if (payload.target_member_revision !== null) fail(409, 'TARGET_CHANGED', '邀请不是新的组织关联');
    let identity: EmailIdentity | null = null;
    if (payload.target_user_id) {
      identity = await emailCollections(this.db).identities.findOne({ user_id: payload.target_user_id, email_key: payload.email_key, state: 'verified' }, { session });
      if (!identity || !await this.c.users.findOne({ _id: payload.target_user_id, credential_version: payload.target_credential_version!, status: 'active', ...privacyActive }, { session }))
        fail(409, 'TARGET_CHANGED', '目标账号或验证邮箱已变化');
      if (!approvalId && await this.protectedAccount(payload.target_user_id, session)) fail(403, 'PROTECTED_ACCOUNT', '目标已受保护，必须重新申请独立治理审批');
      const targetFence = await this.c.users.updateOne({ _id: payload.target_user_id, credential_version: payload.target_credential_version!, status: 'active', ...privacyActive },
        { $inc: { identity_revision: 1 } }, { session });
      const emailFence = await emailCollections(this.db).identities.updateOne({ _id: identity._id, revision: identity.revision, state: 'verified' }, { $set: { updated_at: now } }, { session });
      if (!targetFence.modifiedCount || !emailFence.matchedCount) fail(409, 'TARGET_CHANGED', '目标账号或邮箱已变化');
    } else if (await emailCollections(this.db).identities.findOne({ email_key: payload.email_key, state: 'verified' }, { session })) {
      fail(409, 'TARGET_CHANGED', '邮箱已有确定账号，请重新邀请');
    }
    const issuer = await this.c.members.findOne({ _id: payload.actor_member_id, org_id: payload.actor_org_id, status: 'active' }, { session });
    if (!issuer) fail(409, 'AUTHORIZATION_CHANGED', '操作者权限已变化');
    const actorFence = await this.c.users.updateOne({ _id: issuer.user_id, credential_version: payload.actor_credential_version, status: 'active', ...privacyActive },
      { $inc: { identity_revision: 1 } }, { session });
    const permissionFence = await this.c.members.updateOne({ _id: issuer._id, authorization_revision: issuer.authorization_revision, status: 'active' }, { $set: { updated_at: now } }, { session });
    if (!actorFence.modifiedCount || !permissionFence.matchedCount) fail(409, 'AUTHORIZATION_CHANGED', '操作者身份或权限已变化');
    await emailCollections(this.db).invitations.insertOne({ _id: payload.invitation_id, org_id: payload.org_id, actor_user_id: issuer.user_id,
      target_user_id: payload.target_user_id, email_key: payload.email_key, roles: payload.roles, valid_to: validTo,
      payload, payload_hash: permissionHash(payload), revision: 1, state: 'pending', expires_at: expiresAt,
      accepted_user_id: null, accepted_at: null, approval_id: approvalId, operation_id: operationId, created_at: now, updated_at: now }, { session });
    const challenge = await issueEmailChallenge(this.db, session, { purpose: 'invite', userId: payload.target_user_id,
      email: { key: payload.email_key, display: payload.email_key }, invitationId: payload.invitation_id, invitationRevision: 1,
      credentialVersion: payload.target_credential_version, emailRevision: identity?.revision ?? null,
      durationMs: Math.min(7 * 86400000, expiresAt.getTime() - now.getTime()) });
    await enqueueEmail(this.db, session, { challengeId: challenge.id, userId: payload.target_user_id, invitationId: payload.invitation_id,
      purpose: 'invite', email: payload.email_key, token: challenge.token, expiresAt: challenge.expiresAt });
    return { invitation_id: payload.invitation_id, invitation_state: 'pending', invitation_revision: 1, delivery_status: 'accepted' };
  }
  async createInvitation(req: ApiRequest, orgIdRaw: string, raw: unknown) {
    const body = object(raw, ['email', 'roles', 'valid_to', 'reason', 'current_password']);
    const actor = await this.writeActor(req, body), orgId = id(orgIdRaw), desired = roles(body.roles), reason = boundedReason(body.reason);
    const email = normalizeEmail(text(body.email, 'email', 254)), validTo = this.reviewerExpiry(body.valid_to, desired, desired.includes('content_reviewer'));
    if (!actor.capabilities.includes('platform:govern')) this.canAccounts(actor, orgId);
    const invitationId = await this.stableId(actor, req.get('Idempotency-Key')!, 'invitation.create', 'invitation');
    const requestPayload = { invitation_id: invitationId, org_id: orgId, email_key: email.key, roles: desired, valid_to: validTo?.toISOString() ?? null };
    const directReplay = await this.replay(actor, req, 'invitation.create', requestPayload);
    if (directReplay) return { ...directReplay, ...await this.invitationReceipt(invitationId) };
    const previousApproval = await this.db.collection<AdministrationOperation>('administration_operations').findOne({
      actor_id: actor.identity.user._id, key: req.get('Idempotency-Key'), action: 'approval.request.invitation.create' });
    if (previousApproval) {
      const original = previousApproval.desired.payload;
      if (canonical(requestPayload) !== canonical({ invitation_id: original?.invitation_id, org_id: original?.org_id, email_key: original?.email_key,
        roles: original?.roles, valid_to: original?.valid_to })) fail(409, 'IDEMPOTENCY_CONFLICT', '原key对应不同邀请');
      const { actorOrgId: _org, ...intent } = previousApproval.desired;
      return this.replay(actor, req, previousApproval.action, intent, true);
    }
    await this.email.sendRate(req, email.key);
    await this.email.assertAvailable();
    const identity = await emailCollections(this.db).identities.findOne({ email_key: email.key, state: 'verified' });
    const target = identity ? await this.target(identity.user_id) : null;
    if (target && (target.status !== 'active' || target.must_change_password)) fail(409, 'INVITATION_UNAVAILABLE', '目标账号不可接受邀请');
    const member = target ? await this.c.members.findOne({ user_id: target._id, org_id: orgId }) : null;
    if (member) fail(409, 'MEMBER_EXISTS', '目标已关联本组织，请使用现有成员管理，不通过邀请替换角色');
    const memberId = await this.stableId(actor, req.get('Idempotency-Key')!, 'invitation.create', 'member');
    const sensitiveRoles = await this.roleDecision(actor, desired, [], target?._id ?? invitationId, orgId);
    const protectedTarget = target ? await this.protectedAccount(target._id) : false;
    if (!target && (sensitiveRoles || desired.some(role => role === 'platform_ops' || role === 'content_reviewer')))
      fail(403, 'PROTECTED_ACCOUNT', '未固定身份的邮箱只能邀请非敏感角色');
    const payload: AuthInvitation['payload'] = { ...requestPayload, actor_org_id: actor.orgId, actor_member_id: actor.member._id,
      actor_credential_version: actor.identity.user.credential_version, actor_authorization_revision: actor.member.authorization_revision,
      target_user_id: target?._id ?? null, expires_at: new Date(Date.now() + 7 * 86400000).toISOString(), member_id: memberId,
      target_member_revision: null, target_credential_version: target?.credential_version ?? null };
    if (protectedTarget || sensitiveRoles) {
      this.require(actor, 'platform:govern');
      if (!target || target._id === actor.identity.user._id) fail(403, 'SELF_ESCALATION', '治理邀请需要独立的确定受益人');
      return this.approval(actor, req, 'invitation.create', payload, target._id, null, target, null, reason);
    }
    this.canAccounts(actor, orgId);
    const receipt = await this.execute(req, actor, 'invitation.create', reason, requestPayload,
      { user_ids: target ? [target._id] : [], member_ids: [], org_ids: [orgId] }, invitationId,
      async (session, now, operationId) => {
        await this.assertActorUnchanged(actor, session, this.isPlatformAccounts(actor) ? 'account:platform-manage' : 'account:manage');
        return this.persistInvitation(payload, session, now, operationId, null);
      });
    return { ...receipt, ...await this.invitationReceipt(invitationId) };
  }
  private async invitationReceipt(invitationId: string) {
    const invitation = await emailCollections(this.db).invitations.findOne({ _id: invitationId });
    if (!invitation) return { invitation_id: invitationId };
    const outbox = await this.db.collection('auth_mail_outbox').findOne({ invitation_id: invitationId }, { sort: { created_at: -1 }, projection: { status: 1 } });
    return { invitation_id: invitationId, invitation_state: invitation.state, invitation_revision: invitation.revision,
      delivery_status: outbox?.status === 'pending' || outbox?.status === 'sending' ? 'accepted' : outbox?.status ?? 'unavailable' };
  }
  async invitations(req: ApiRequest, orgIdRaw: string, raw: unknown) {
    const actor = await this.actor(req), orgId = id(orgIdRaw);
    if (!actor.capabilities.includes('platform:govern')) this.canAccounts(actor, orgId);
    const p = page(raw, actor.identity.user._id, `${actor.orgId}:${orgId}`, 'invitations', {});
    const rows = await emailCollections(this.db).invitations.find({ org_id: orgId, ...(p.after ? { _id: { $gt: p.after } } : {}) })
      .sort({ _id: 1 }).limit(p.limit + 1).toArray();
    return { items: await Promise.all(rows.slice(0, p.limit).map(async row => ({ id: row._id, org_id: row.org_id, state: row.expires_at <= new Date() && row.state === 'pending' ? 'expired' : row.state,
      revision: row.revision, expires_at: row.expires_at, roles: row.roles, valid_to: row.valid_to, target_user_id: row.target_user_id,
      approval_id: row.approval_id, delivery_status: (await this.invitationReceipt(row._id)).delivery_status ?? 'unavailable' }))),
      next_cursor: rows.length > p.limit ? p.next(rows[p.limit - 1]!._id) : null };
  }
  async revokeInvitation(req: ApiRequest, invitationIdRaw: string, raw: unknown) {
    const body = object(raw, ['expected_revision', 'reason', 'current_password']);
    const actor = await this.writeActor(req, body), invitationId = id(invitationIdRaw), expected = revision(body.expected_revision, 'expected_revision'), reason = boundedReason(body.reason);
    const row = await emailCollections(this.db).invitations.findOne({ _id: invitationId });
    if (!row) fail(404, 'NOT_FOUND', '邀请不存在');
    if (!actor.capabilities.includes('platform:govern')) this.canAccounts(actor, row.org_id);
    const payload = { invitation_id: invitationId, org_id: row.org_id, expected_revision: expected };
    const replay = await this.replay(actor, req, 'invitation.revoke', payload);
    if (replay) return { ...replay, ...await this.invitationReceipt(invitationId) };
    if (await resolvedTxnMode(this.db, this.auth.config) !== 'replicaSet') fail(503, 'AUTH_TRANSACTION_REQUIRED', '邮箱邀请需要副本集事务');
    if (row.revision !== expected || row.state !== 'pending') fail(409, 'REVISION_CONFLICT', '邀请已变化或不能撤销');
    const receipt = await this.execute(req, actor, 'invitation.revoke', reason, payload,
      { user_ids: row.target_user_id ? [row.target_user_id] : [], org_ids: [row.org_id] }, invitationId, async (session, now) => {
        await this.assertActorUnchanged(actor, session, actor.capabilities.includes('platform:govern') ? 'platform:govern' : this.isPlatformAccounts(actor) ? 'account:platform-manage' : 'account:manage');
        const changed = await emailCollections(this.db).invitations.updateOne({ _id: invitationId, revision: expected, state: 'pending' },
          { $set: { state: 'revoked', updated_at: now }, $inc: { revision: 1 } }, { session });
        if (changed.modifiedCount !== 1) fail(409, 'REVISION_CONFLICT', '邀请已变化');
        await revokeEmailChallenges(this.db, session, { invitation_id: invitationId });
        return { invitation_id: invitationId, invitation_state: 'revoked', invitation_revision: expected + 1, delivery_status: 'cancelled' };
      });
    return { ...receipt, ...await this.invitationReceipt(invitationId) };
  }
  async invitationForChallenge(challenge: EmailChallenge, session: ClientSession) {
    const invitation = await emailCollections(this.db).invitations.findOne({ _id: challenge.invitation_id!, state: 'pending', revision: challenge.invitation_revision!,
      email_key: challenge.email_key, $expr: { $and: [{ $gt: ['$expires_at', '$$NOW'] },
        { $or: [{ $eq: ['$valid_to', null] }, { $gt: ['$valid_to', '$$NOW'] }] }] } }, { session });
    if (!invitation || invitation.payload_hash !== permissionHash(invitation.payload) ||
      invitation.org_id !== invitation.payload.org_id || invitation.target_user_id !== invitation.payload.target_user_id ||
      invitation.target_user_id !== challenge.user_id ||
      invitation.target_user_id !== null && challenge.credential_version !== invitation.payload.target_credential_version ||
      invitation.email_key !== invitation.payload.email_key || canonical(invitation.roles) !== canonical(invitation.payload.roles) ||
      invitation.valid_to?.toISOString() !== (invitation.payload.valid_to ?? undefined) ||
      invitation.expires_at.toISOString() !== invitation.payload.expires_at || invitation._id !== invitation.payload.invitation_id ||
      !invitation.operation_id || !await this.db.collection<AdministrationOperation>('administration_operations').findOne({ _id: invitation.operation_id, status: 'applied' }, { session }))
      fail(409, 'INVITATION_UNAVAILABLE', '邀请无效、已变化或尚未发布');
    if (invitation.target_user_id) {
      const identity = await emailCollections(this.db).identities.findOne({ user_id: invitation.target_user_id, email_key: invitation.email_key, state: 'verified', revision: challenge.email_revision! }, { session });
      const target = await this.c.users.findOne({ _id: invitation.target_user_id, credential_version: challenge.credential_version!, status: 'active', ...privacyActive }, { session });
      if (!identity || !target || target.must_change_password) fail(409, 'INVITATION_UNAVAILABLE', '邀请目标已失效');
    }
    if (!await this.c.organizations.findOne({ _id: invitation.org_id, status: 'active' }, { session }))
      fail(409, 'INVITATION_UNAVAILABLE', '邀请组织已失效');
    return invitation;
  }
  async applyInvitation(req: ApiRequest, challenge: EmailChallenge, userId: string, session: ClientSession, newAccount = false) {
    const invitation = await this.invitationForChallenge(challenge, session), p = invitation.payload;
    const guard = await this.db.collection<AdministrationGuard>('administration_guard').updateOne({ _id: 'administration', state: 'idle', operation_id: null },
      { $inc: { revision: 1 }, $set: { updated_at: new Date() } }, { session });
    if (guard.modifiedCount !== 1) fail(409, 'INVITATION_UNAVAILABLE', '当前管理状态不能接受邀请');
    await assertAdministrationAccess(this.db, userId, invitation.org_id, session);
    const identity = await emailCollections(this.db).identities.findOne({ user_id: userId, email_key: invitation.email_key, state: 'verified' }, { session });
    if (!identity || invitation.target_user_id && invitation.target_user_id !== userId ||
      newAccount && invitation.target_user_id) fail(409, 'INVITATION_UNAVAILABLE', '当前账号不能接受该邀请');
    const actor = await this.invitationActor(p, session);
    if (actor.identity.user._id !== invitation.actor_user_id) fail(409, 'INVITATION_UNAVAILABLE', '邀请操作者已变化');
    const member = await this.c.members.findOne({ user_id: userId, org_id: invitation.org_id }, { session });
    if (member) fail(409, 'MEMBER_EXISTS', '当前账号已关联本组织，请使用成员管理，不通过接受邀请替换既有角色');
    if (p.target_member_revision !== null) fail(409, 'INVITATION_UNAVAILABLE', '邀请不是新的组织关联');
    const desired = roles(invitation.roles), sensitiveRoles = await this.roleDecision(actor, desired, [], userId, invitation.org_id);
    const protectedTarget = await this.protectedAccount(userId, session);
    if (invitation.approval_id) {
      this.require(actor, 'platform:govern');
      const approval = await this.db.collection<Approval>('authorization_requests').findOne({ _id: invitation.approval_id, status: 'applied', action: 'invitation.create',
        operation_id: invitation.operation_id, beneficiary_user_id: userId }, { session });
      if (!approval || approval.payload_hash !== permissionHash(approval.payload) || canonical(approval.payload) !== canonical(p) ||
        approval.requester_user_id !== actor.identity.user._id || approval.requester_user_id === approval.approver_user_id ||
        approval.requester_user_id === userId || approval.approver_user_id === userId)
        fail(409, 'INVITATION_UNAVAILABLE', '邀请独立审批已失效');
      await assertRequesterCurrent(this.db, approval, session);
      await assertApproverCurrent(this.db, approval, session);
      if (approval.approver_user_id) {
        const fenced = await this.c.users.updateOne({ _id: approval.approver_user_id, credential_version: approval.approver_credential_version!, status: 'active', ...privacyActive }, { $inc: { identity_revision: 1 } }, { session });
        if (!fenced.modifiedCount) fail(409, 'INVITATION_UNAVAILABLE', '审批人身份已变化');
      }
    } else {
      this.canAccounts(actor, invitation.org_id);
      if (protectedTarget || sensitiveRoles) fail(403, 'PROTECTED_ACCOUNT', '目标已受保护或需要独立治理审批，请重新申请');
    }
    const clock = await this.db.aggregate<{ now: Date }>([{ $documents: [{}] }, { $project: { _id: 0, now: '$$NOW' } }], { session }).next();
    if (!(clock?.now instanceof Date)) fail(503, 'DEPENDENCY_UNAVAILABLE', '数据库时钟暂不可用');
    const now = clock.now;
    const issuerFence = await this.c.users.updateOne({ _id: actor.identity.user._id, credential_version: p.actor_credential_version, status: 'active', ...privacyActive },
      { $inc: { identity_revision: 1 } }, { session });
    const memberFence = await this.c.members.updateOne({ _id: p.actor_member_id, authorization_revision: actor.member.authorization_revision, status: 'active' }, { $set: { updated_at: now } }, { session });
    if (!issuerFence.modifiedCount || !memberFence.matchedCount) fail(409, 'INVITATION_UNAVAILABLE', '邀请操作者已变化');
    const result = await this.applyMembership({ session, now }, userId, invitation.org_id, p.member_id, desired, 'active', null,
      invitation.valid_to ?? undefined, invitation.operation_id!, invitation.approval_id ?? undefined);
    const changed = await emailCollections(this.db).invitations.updateOne({ _id: invitation._id, state: 'pending', revision: invitation.revision,
      $expr: { $gt: ['$expires_at', '$$NOW'] } }, { $set: { state: 'accepted', accepted_user_id: userId, accepted_at: now, updated_at: now }, $inc: { revision: 1 } }, { session });
    if (changed.modifiedCount !== 1) fail(409, 'INVITATION_UNAVAILABLE', '邀请已被使用或撤销');
    if (challenge.user_id === null) {
      const subject = await emailCollections(this.db).challenges.updateOne({ _id: challenge._id, purpose: 'invite', status: 'pending', user_id: null },
        { $set: { user_id: userId, updated_at: now } }, { session });
      if (subject.modifiedCount !== 1) fail(409, 'INVITATION_UNAVAILABLE', '邀请挑战归属已变化');
      await this.db.collection('auth_mail_outbox').updateMany({ challenge_id: challenge._id, user_id: null },
        { $set: { user_id: userId, updated_at: now } }, { session });
    }
    await this.auth.audit('invitation.accept', userId, invitation._id, req, session);
    return result;
  }
  async context(req: ApiRequest) {
    const actor = await this.actor(req);
    const accounts = this.isPlatformAccounts(actor) || actor.capabilities.includes('account:manage');
    const govern = actor.capabilities.includes('platform:govern');
    const business = actor.admin.some(g => Object.hasOwn(platformBusiness, g.capability as string));
    const delegated = new Set(actor.admin.filter(g => g.capability === 'authorization:delegate' && Array.isArray(g.delegate_capabilities))
      .flatMap(g => g.delegate_capabilities as string[]));
    const catalog = govern ? [
      ...Object.entries(ADMINISTRATIVE_CATALOG).map(([capability, policy]) => ({ capability, storage_kind: policy.storage_kind, required_roles: policy.required_role === 'platform_member' || policy.required_role === 'organization_member' ? [] : [policy.required_role],
        allowed_scopes: policy.scope === 'self' ? ['organization_ids'] : ['organization_ids', 'all_organizations'], sensitive: policy.sensitivity !== 'ordinary',
        delegatable: policy.delegable, delegate_capabilities: capability === 'authorization:delegate' ? [...DELEGABLE_CAPABILITIES] : [] })),
      ...Object.entries(MEMBER_CAPABILITY_CATALOG).map(([capability, policy]) => ({ capability, storage_kind: policy.storage_kind,
        required_roles: policy.required_role === 'platform_member' || policy.required_role === 'organization_member' ? [] : [policy.required_role], allowed_scopes: ['organization_ids'],
        sensitive: policy.sensitivity !== 'ordinary', delegatable: policy.delegable, delegate_capabilities: [] })),
    ] : [...delegated].filter(capability => Object.hasOwn(MEMBER_CAPABILITY_CATALOG, capability)).map(capability => {
      const policy = MEMBER_CAPABILITY_CATALOG[capability as keyof typeof MEMBER_CAPABILITY_CATALOG];
      return { capability, storage_kind: policy.storage_kind, required_roles: [], allowed_scopes: ['organization_ids'],
        sensitive: policy.sensitivity !== 'ordinary', delegatable: true, delegate_capabilities: [] as string[] };
    });
    const organizationPage = accounts || govern || business ? await this.organizations(req, { limit: 20 }) : { items: [], next_cursor: null };
    return { actor_org_id: actor.orgId, actor_member_id: actor.member._id, roles: actor.roles, capabilities: actor.capabilities, grants: actor.admin.map(safeGrant),
      menus: [...(accounts ? ['users'] : []), ...(accounts || govern || business ? ['organizations'] : []),
        ...(govern || delegated.size ? ['authorizations'] : []), ...(accounts || govern || delegated.size ? ['approvals'] : []),
        ...(accounts || govern ? ['audit'] : []), ...(business ? ['business'] : [])],
      catalog, target_organizations: organizationPage, database_mode: await resolvedTxnMode(this.db, this.auth.config) };
  }
  async users(req: ApiRequest, raw: unknown) {
    const actor = await this.actor(req); this.canAccounts(actor);
    const q = object(raw, ['cursor', 'limit', 'login_name']);
    const loginName = q.login_name === undefined ? undefined : login(q.login_name);
    // Omitted filters retain the pre-login-query cursor binding.
    const p = page(loginName === undefined ? q : { ...q, login_name: loginName }, actor.identity.user._id,
      `${actor.orgId}:${this.isPlatformAccounts(actor) ? 'platform' : 'organization'}`, 'users',
      loginName === undefined ? {} : { login_name: loginName });
    if (loginName !== undefined) {
      const user = await this.c.users.findOne({ login_key: loginName, ...privacyActive,
        ...(p.after ? { _id: { $gt: p.after } } : {}) },
        { projection: { _id: 1, login_key: 1, display_name: 1, status: 1, identity_revision: 1 } });
      if (!user || !this.isPlatformAccounts(actor) &&
          !await this.c.members.findOne({ user_id: user._id, org_id: actor.orgId }, { projection: { _id: 1 } }))
        return { items: [], next_cursor: null };
      return { items: [safeUser(user)], next_cursor: null };
    }
    if (this.isPlatformAccounts(actor)) {
      const rows = await this.c.users.find({ ...privacyActive, ...(p.after ? { _id: { $gt: p.after } } : {}) },
        { projection: { _id: 1, login_key: 1, display_name: 1, status: 1, identity_revision: 1 } }).sort({ _id: 1 }).limit(p.limit + 1).toArray();
      return { items: rows.slice(0, p.limit).map(safeUser), next_cursor: rows.length > p.limit ? p.next(rows[p.limit - 1]!._id) : null };
    }
    const rows = await this.c.members.find({ org_id: actor.orgId, ...(p.after ? { user_id: { $gt: p.after } } : {}) },
      { projection: { user_id: 1 } }).sort({ user_id: 1 }).limit(p.limit + 1).toArray();
    const selected = rows.slice(0, p.limit);
    const users = await this.c.users.find({ _id: { $in: selected.map(r => r.user_id) }, ...privacyActive },
      { projection: { _id: 1, login_key: 1, display_name: 1, status: 1, identity_revision: 1 } }).toArray();
    const byId = new Map(users.map(u => [u._id, u]));
    return { items: selected.flatMap(m => byId.has(m.user_id) ? [safeUser(byId.get(m.user_id)!)] : []),
      next_cursor: rows.length > p.limit ? p.next(rows[p.limit - 1]!.user_id) : null };
  }
  async user(req: ApiRequest, userId: string) {
    const actor = await this.actor(req);
    const targetId = id(userId);
    if (!actor.capabilities.includes('platform:govern')) this.canAccounts(actor);
    if (!this.isPlatformAccounts(actor) && !actor.capabilities.includes('platform:govern') &&
        !await this.c.members.findOne({ user_id: targetId, org_id: actor.orgId })) fail(404, 'NOT_FOUND', '账号不存在');
    const user = await this.target(targetId);
    return { ...safeUser(user), protected_account: await this.protectedAccount(targetId) };
  }
  async organizations(req: ApiRequest, raw: unknown) {
    const actor = await this.actor(req);
    if (!actor.capabilities.some(c => ['platform:govern', 'account:platform-manage', 'account:manage'].includes(c)) && !actor.admin.some(g => Object.hasOwn(platformBusiness, g.capability as string))) fail(403, 'FORBIDDEN', '无组织目录权限');
    const full = this.isPlatformAccounts(actor) || actor.capabilities.includes('platform:govern') ||
      actor.admin.some(g => Object.hasOwn(platformBusiness, g.capability as string) && g.scope?.kind === 'all_organizations');
    const visible = new Set<string>([actor.orgId]);
    if (!full) for (const grant of actor.admin) {
      if (!Object.hasOwn(platformBusiness, grant.capability as string) || grant.scope?.kind !== 'organization_ids' || !Array.isArray(grant.scope.organization_ids)) continue;
      for (const orgId of grant.scope.organization_ids) if (typeof orgId === 'string') visible.add(orgId);
    }
    const mode = `${actor.orgId}:${full ? 'all' : [...visible].sort().join(',')}`;
    const p = page(raw, actor.identity.user._id, mode, 'organizations', {});
    const rows = await this.c.organizations.find({ status: 'active', ...(!full ? { _id: { $in: [...visible], ...(p.after ? { $gt: p.after } : {}) } } :
      p.after ? { _id: { $gt: p.after } } : {}) }, { projection: { _id: 1, name: 1, kind: 1, status: 1 } }).sort({ _id: 1 }).limit(p.limit + 1).toArray();
    return { items: rows.slice(0, p.limit).map(o => ({ id: o._id, name: o.name, kind: o.kind, status: o.status })),
      next_cursor: rows.length > p.limit ? p.next(rows[p.limit - 1]!._id) : null };
  }
  async members(req: ApiRequest, orgId: string, raw: unknown) {
    const actor = await this.actor(req); const org = id(orgId);
    if (!actor.capabilities.includes('platform:govern')) this.canAccounts(actor, org);
    if (!await this.c.organizations.findOne({ _id: org, status: 'active' })) fail(404, 'NOT_FOUND', '组织不存在');
    const p = page(raw, actor.identity.user._id, `${actor.orgId}:${org}`, 'members', {});
    const rows = await this.c.members.find({ org_id: org, ...(p.after ? { _id: { $gt: p.after } } : {}) }).sort({ _id: 1 }).limit(p.limit + 1).toArray();
    const current = rows.slice(0, p.limit);
    const users = await this.c.users.find({ _id: { $in: current.map(m => m.user_id) }, ...privacyActive }, { projection: { _id: 1, display_name: 1 } }).toArray();
    const names = new Map(users.map(u => [u._id, u.display_name]));
    const valid = current.filter(m => names.has(m.user_id));
    const roleRows = await activeMemberRoles(this.db, { member_id: { $in: valid.map(m => m._id) } });
    return { items: valid.map(m => {
      const assignments = roleRows.filter(r => r.member_id === m._id);
      return { id: m._id, user_id: m.user_id, display_name: names.get(m.user_id), status: m.status,
        authorization_revision: m.authorization_revision, roles: assignments.map(r => r.role_id),
        role_assignments: assignments.map(r => ({ role_id: r.role_id, valid_from: r.valid_from ?? null, valid_to: r.valid_to ?? null })) };
    }), next_cursor: rows.length > p.limit ? p.next(rows[p.limit - 1]!._id) : null };
  }
  async userMembers(req: ApiRequest, userId: string, raw: unknown) {
    const actor = await this.actor(req);
    if (!actor.capabilities.includes('platform:govern')) this.canAccounts(actor);
    const targetId = id(userId);
    if (!this.isPlatformAccounts(actor) && !actor.capabilities.includes('platform:govern') &&
      !await this.c.members.findOne({ user_id: targetId, org_id: actor.orgId })) fail(404, 'NOT_FOUND', '账号不存在');
    await this.target(targetId);
    const p = page(raw, actor.identity.user._id, `${actor.orgId}:${targetId}`, 'user-members', {});
    const rows = await this.c.members.find({ user_id: targetId, ...(!this.isPlatformAccounts(actor) && !actor.capabilities.includes('platform:govern') ? { org_id: actor.orgId } : {}), ...(p.after ? { _id: { $gt: p.after } } : {}) }).sort({ _id: 1 }).limit(p.limit + 1).toArray();
    const slice = rows.slice(0, p.limit);
    const orgs = await this.c.organizations.find({ _id: { $in: slice.map(m => m.org_id) } }, { projection: { name: 1 } }).toArray();
    const names = new Map(orgs.map(o => [o._id, o.name]));
    const assignments = await activeMemberRoles(this.db, { member_id: { $in: slice.map(m => m._id) } });
    return { items: slice.map(m => {
      const matching = assignments.filter(r => r.member_id === m._id);
      return { id: m._id, org_id: m.org_id, organization_name: names.get(m.org_id), status: m.status,
        roles: matching.map(r => r.role_id), role_assignments: matching.map(r => ({
          role_id: r.role_id, valid_from: r.valid_from ?? null, valid_to: r.valid_to ?? null,
        })), authorization_revision: m.authorization_revision };
    }), next_cursor: rows.length > p.limit ? p.next(rows[p.limit - 1]!._id) : null };
  }
  private async lastGovernor(userId: string, now: Date, session: ClientSession) {
    try {
      await assertRetainsGovernance(this.db, now, session, { user_id: userId });
    } catch (error) {
      if (error instanceof Error && error.message === 'Cannot remove the final active governance administrator')
        fail(409, 'LAST_GOVERNOR', '不可移除最后一位可用治理管理员');
      throw error;
    }
  }
  private async applyMembership(ctx: { session: ClientSession; now: Date }, targetUser: string, orgId: string, memberId: string, desiredRoles: RoleCode[], memberStatus: 'active' | 'disabled',
    expectedRevision: number | null, reviewerValidTo?: Date | null, operationId?: string, approvalId?: string) {
    const org = await this.c.organizations.findOne({ _id: orgId, status: 'active' }, { session: ctx.session });
    const user = await this.c.users.findOne({ _id: targetUser, ...privacyActive }, { session: ctx.session });
    if (!org || !user || user.status !== 'active' && !(user.status === 'disabled' && expectedRevision === null && user.must_change_password)) fail(409, 'TARGET_CHANGED', '用户或组织已失效');
    if (desiredRoles.includes('platform_ops') && org.kind !== 'platform') fail(422, 'VALIDATION_ERROR', '平台身份必须属于平台组织');
    const existing = await this.c.members.findOne({ user_id: targetUser, org_id: orgId }, { session: ctx.session });
    if ((existing?.authorization_revision ?? null) !== expectedRevision || existing && existing._id !== memberId) fail(409, 'REVISION_CONFLICT', '成员权限已变化');
    const oldRoles = await this.c.memberRoles.find({ member_id: memberId }, { session: ctx.session }).toArray();
    const oldReviewer = oldRoles.find(r => r.role_id === 'content_reviewer' && r.status !== 'revoked');
    const reviewerRenewed = desiredRoles.includes('content_reviewer') && reviewerValidTo !== undefined &&
      (!oldReviewer || !oldReviewer.valid_to || oldReviewer.valid_to.getTime() !== reviewerValidTo?.getTime());
    const reviewerExpired = oldReviewer?.valid_to instanceof Date && oldReviewer.valid_to <= ctx.now;
    const newReviewer = desiredRoles.includes('content_reviewer') && (!oldReviewer || reviewerExpired || reviewerRenewed);
    if (newReviewer && (!reviewerValidTo || reviewerValidTo <= ctx.now || !operationId || !approvalId)) fail(422, 'REVIEWER_EXPIRY_REQUIRED', '新增或续期审核角色须独立审批并明确有效期限');
    if (oldRoles.some(r => r.role_id === 'platform_ops') && (memberStatus === 'disabled' || !desiredRoles.includes('platform_ops'))) await this.lastGovernor(targetUser, ctx.now, ctx.session);
    if (existing) {
      const changed = await this.c.members.updateOne({ _id: memberId, authorization_revision: expectedRevision!, org_id: orgId }, { $set: { status: memberStatus, updated_at: ctx.now }, $inc: { authorization_revision: 1 } }, { session: ctx.session });
      if (!changed.matchedCount) fail(409, 'REVISION_CONFLICT', '成员权限已变化');
    } else await this.c.members.insertOne({ _id: memberId, user_id: targetUser, org_id: orgId, status: memberStatus, authorization_revision: 1, created_at: ctx.now, updated_at: ctx.now }, { session: ctx.session });
    const retained = oldRoles.filter(r => desiredRoles.includes(r.role_id) && r.status !== 'revoked' && !(r.role_id === 'content_reviewer' && newReviewer));
    const removed = oldRoles.filter(r => !retained.includes(r));
    if (removed.length) await this.c.memberRoles.deleteMany({ _id: { $in: removed.map(r => r._id) } }, { session: ctx.session });
    const newRoles = desiredRoles.filter(role_id => !retained.some(r => r.role_id === role_id));
    if (newRoles.length) await this.c.memberRoles.insertMany(newRoles.map(role_id => ({
      _id: newId(), member_id: memberId, org_id: orgId, role_id,
      ...(role_id === 'content_reviewer' ? { status: 'active' as const, valid_from: ctx.now, valid_to: reviewerValidTo!,
        operation_id: operationId!, approval_id: approvalId!, authority: 'approval' as const } : {}),
    })), { session: ctx.session });
    if (oldRoles.some(r => !desiredRoles.includes(r.role_id)) || memberStatus === 'disabled') {
      const active = await this.db.collection<AdministrativeGrant>('administrative_grants').find({ subject_member_id: memberId, status: { $in: ['pending', 'active'] } }, { session: ctx.session }).toArray();
      for (const grant of active) {
        const policy = ADMINISTRATIVE_CATALOG[grant.capability as keyof typeof ADMINISTRATIVE_CATALOG];
        if (memberStatus === 'active' && policy?.required_role === 'platform_member' && org.kind === 'platform' ||
          memberStatus === 'active' && policy?.required_role !== 'platform_member' && policy?.required_role !== 'organization_member' &&
            desiredRoles.includes(policy.required_role)) continue;
        await this.db.collection<AdministrativeGrant>('administrative_grants').updateOne({ _id: grant._id, revision: grant.revision, status: grant.status },
          { $set: { status: 'revoked', updated_at: ctx.now }, $inc: { revision: 1 } }, { session: ctx.session });
      }
    }
    const fenced = await this.c.users.updateOne({ _id: targetUser, ...privacyActive }, { $inc: { identity_revision: 1 }, $set: { updated_at: ctx.now } }, { session: ctx.session });
    if (!fenced.matchedCount) fail(409, 'TARGET_CHANGED', '用户身份已变化');
    return { member_id: memberId, authorization_revision: (expectedRevision ?? 0) + 1 };
  }
  private async stableId(actor: Actor, key: string, action: string, purpose: string): Promise<string> {
    const key_hash = createHmac('sha256', this.auth.config.rateLimitKey).update(canonical({key, action, purpose})).digest('hex');
    const filter = { actor_id: actor.identity.user._id, key_hash, action, purpose };
    const records = this.db.collection<{_id:string}>('object_id_allocations');
    try {
      const row = await records.findOneAndUpdate(filter, {$setOnInsert:{_id:newId(),...filter,created_at:new Date()}}, {upsert:true,returnDocument:'after'});
      return row!._id;
    } catch (error: any) {
      if(error.code!==11000)throw error;
      const row=await records.findOne(filter);if(!row)throw error;return row._id;
    }
  }
  private async replay(actor: Actor, req: ApiRequest, action: string, payload: Document, approval = false) {
    const row = await this.db.collection<AdministrationOperation>('administration_operations').findOne({
      actor_id: actor.identity.user._id, action, key: req.get('Idempotency-Key'),
    });
    if (!row) return null;
    if (row.payload_hash !== permissionHash({ before: row.before, desired: row.desired }))
      fail(503, 'OPERATION_STATE_CHANGED', '既有操作意图校验失败，需要人工核对');
    if (typeof req.body?.reason !== 'string' || row.reason !== boundedReason(req.body.reason))
      fail(409, 'IDEMPOTENCY_CONFLICT', '幂等键与此前申请理由不一致');
    if (action === 'member.add' && !this.isPlatformAccounts(actor) ||
        action === 'member.update' && !this.isPlatformAccounts(actor) &&
          !(actor.capabilities.includes('account:manage') && payload.org_id === actor.orgId) ||
        action === 'user.status' && !this.isPlatformAccounts(actor) ||
        action === 'user.password.reset' && !this.isPlatformAccounts(actor) && !actor.capabilities.includes('account:manage') ||
        action.startsWith('grant.') && !actor.capabilities.includes('platform:govern') &&
          !actor.capabilities.includes('authorization:delegate'))
      fail(403, 'FORBIDDEN', '重放时操作者已失去该操作的当前职责');
    if (action.startsWith('invitation.') || action === 'approval.request.invitation.create') {
      const invitationOrg = payload.org_id ?? payload.payload?.org_id;
      if (action === 'approval.request.invitation.create') this.require(actor, 'platform:govern');
      else if (!actor.capabilities.includes('platform:govern')) this.canAccounts(actor, invitationOrg);
    }
    const desired = { ...payload, actorOrgId: actor.orgId };
    if (canonical(row.desired) !== canonical(desired)) fail(409, 'IDEMPOTENCY_CONFLICT', '幂等键对应不同请求内容');
    if (row.status !== 'applied') fail(503, 'OPERATION_NEEDS_RECOVERY', '操作结果尚未确认，请按操作编号核对');
    const guard = await this.db.collection<AdministrationGuard>('administration_guard').findOne({ _id: 'administration' });
    if (!guard || guard.state !== 'idle' || guard.operation_id || row.mode !== await resolvedTxnMode(this.db, this.auth.config)) fail(503, 'OPERATION_NEEDS_RECOVERY', '当前存在待恢复管理操作');
    if (approval) {
      const approvalEvidence = await this.db.collection<AuditEvent>('audit_events').findOne({ operation_id: row._id, approval_id: { $exists: true } });
      const request = approvalEvidence?.approval_id
        ? await this.db.collection<Approval>('authorization_requests').findOne({ _id: approvalEvidence.approval_id }) : null;
      if (!request) fail(503, 'APPROVAL_NEEDS_RECOVERY', '申请结果待确认');
      return { operation_id: row._id, status: request.status, approval_id: request._id, replayed: true,
        ...(request.action === 'invitation.create' ? await this.invitationReceipt(id(request.payload.invitation_id)) : {}) };
    }
    if (action === 'approval.approve' || action === 'approval.reject') {
      const evidence = await this.db.collection<AuditEvent>('audit_events').findOne({ operation_id: row._id, approval_id: { $type: 'objectId' } },
        { projection: { approval_id: 1 } });
      if (!evidence?.approval_id) fail(503, 'APPROVAL_NEEDS_RECOVERY', '审批结果证据待核实');
      const decision = await this.db.collection<Approval>('authorization_requests').findOne({ _id: evidence.approval_id });
      if (!decision) fail(503, 'APPROVAL_NEEDS_RECOVERY', '审批当前结果待核实');
      return { operation_id: row._id, status: decision.status, replayed: true, approval_id: evidence.approval_id,
        ...(decision.action === 'invitation.create' ? await this.invitationReceipt(id(decision.payload.invitation_id)) : {}),
        ...(action === 'approval.approve' && decision.status === 'applied' ? { password_not_replayable: true } : {}) };
    }
    return { operation_id: row._id, status: 'applied', replayed: true,
      ...(['user.create', 'user.password.reset', 'approval.approve'].includes(action) ? { password_not_replayable: true } : {}) };
  }
  private async approval(actor: Actor, req: ApiRequest, action: string, payload: Document, targetId: string, memberId: string | null, target: User | null, expected: number | null, reason: string) {
    const key = req.get('Idempotency-Key')!;
    const desired = { action, payload, targetId, memberId, expected, requester: actor.identity.user._id, actorOrgId: actor.orgId };
    const previous = await this.replay(actor, req, `approval.request.${action}`, desired, true);
    if (previous) return previous;
    const approvalId = await this.stableId(actor, key, `approval.request.${action}`, 'approval');
    const payloadHash = permissionHash(payload);
    const result = await executeAdministrationOperation({
      client: this.database.client, db: this.db, actor: actor.identity.user._id, action: `approval.request.${action}`, reason, key,
      targets: { user_ids: [targetId], member_ids: memberId ? [memberId] : [], org_ids: [] },
      payload: desired,
      audit: { actor_org_id: actor.orgId, org_id: actor.orgId, target_org_id: typeof payload.org_id === 'string' ? payload.org_id : undefined,
        resource_id: approvalId, approval_id: approvalId, request_id: req.requestId },
      apply: async ({ session, now, operation_id }) => {
        await this.assertActorUnchanged(actor, session, actor.capabilities.includes('platform:govern') ? 'platform:govern' : this.isPlatformAccounts(actor) ? 'account:platform-manage' : 'account:manage');
        await this.db.collection<AuthorizationRequest>('authorization_requests').insertOne({
          _id: approvalId, requester_user_id: actor.identity.user._id, requester_member_id: actor.member._id,
          beneficiary_user_id: targetId, subject_member_id: memberId,
          action, payload, payload_hash: payloadHash, expected_grant_revision: expected,
          requester_permission_revision: actor.member.authorization_revision, requester_credential_version: actor.identity.user.credential_version,
          target_credential_version: target?.credential_version ?? 0, target_identity_revision: target?.identity_revision ?? 0,
          reason, status: 'pending', revision: 1, approver_user_id: null, approver_credential_version: null,
          approved_at: null, operation_id,
          created_at: now, updated_at: now,
        }, { session });
        return { approval_id: approvalId };
      },
    });
    if (result.replayed) {
      const receipt = await this.replay(await this.actor(req), req, `approval.request.${action}`, desired, true);
      if (!receipt) fail(503, 'APPROVAL_NEEDS_RECOVERY', '原申请回执未确认，请按操作编号核对');
      return receipt;
    }
    return { status: 'pending', operation_id: result.operation_id, ...(result.result ?? {}) };
  }
  private async execute<T>(req: ApiRequest, actor: Actor, action: string, reason: string, payload: Document, targets: { user_ids?: string[]; member_ids?: string[]; org_ids?: string[] }, resource: string,
    apply: (session: ClientSession, now: Date, operation_id: string) => Promise<T>, verify?: (session: ClientSession, now: Date, operation_id: string) => Promise<void>,
    prior?: Document) {
    const outcome = await executeAdministrationOperation({ db: this.db, client: this.database.client, actor: actor.identity.user._id,
      action, reason, targets, payload: { ...payload, actorOrgId: actor.orgId }, before: {
        actorCredentialVersion: actor.identity.user.credential_version, actorMemberId: actor.member._id, ...prior,
      }, key: req.get('Idempotency-Key')!,
      audit: { actor_org_id: actor.orgId, target_org_id: targets.org_ids?.[0], org_id: targets.org_ids?.[0],
        resource_id: resource, request_id: req.requestId },
      apply: async ctx => apply(ctx.session, ctx.now, ctx.operation_id),
      verify: verify ? async ctx => verify(ctx.session, ctx.now, ctx.operation_id) : undefined });
    return { operation_id: outcome.operation_id, status: outcome.status, ...(outcome.replayed ? { replayed: true, ...(action === 'user.create' || action === 'user.password.reset' ? { password_not_replayable: true } : {}) } : outcome.result) };
  }
  async createUser(req: ApiRequest, raw: unknown) {
    const body = object(raw, ['login_name', 'display_name', 'org_id', 'roles', 'valid_to', 'reason', 'current_password']);
    const actor = await this.writeActor(req, body);
    const orgId = id(body.org_id), desired = roles(body.roles), reason = boundedReason(body.reason);
    if (!(desired.includes('platform_ops') && actor.capabilities.includes('platform:govern') && actor.orgId === orgId))
      this.canAccounts(actor, orgId);
    const loginName = login(body.login_name), displayName = text(body.display_name, 'display_name', 100).trim();
    const reviewerValidTo = this.reviewerExpiry(body.valid_to, desired, desired.includes('content_reviewer'));
    const org = await this.c.organizations.findOne({ _id: orgId, status: 'active' });
    if (!org || desired.includes('platform_ops') && org.kind !== 'platform') fail(422, 'VALIDATION_ERROR', '组织或角色无效');
    const userId = await this.stableId(actor, req.get('Idempotency-Key')!, 'user.create', 'user');
    const memberId = await this.stableId(actor, req.get('Idempotency-Key')!, 'user.create', 'member');
    const requiresApproval = await this.roleDecision(actor, desired, [], userId, orgId);
    const payload = { user_id: userId, member_id: memberId, login_name: loginName, display_name: displayName, org_id: orgId, roles: desired,
      valid_to: reviewerValidTo?.toISOString() ?? null };
    if (requiresApproval) return this.approval(actor, req, 'user.create', payload, userId, memberId, null, null, reason);
    const directPayload = { login_name: loginName, display_name: displayName, org_id: orgId, roles: desired, valid_to: reviewerValidTo?.toISOString() ?? null };
    const replay = await this.replay(actor, req, 'user.create', directPayload);
    if (replay) return replay;
    const secret = temporaryPassword(), hashed = await hashPassword(secret);
    return this.execute(req, actor, 'user.create', reason, directPayload,
      { user_ids: [userId], member_ids: [memberId], org_ids: [orgId] }, userId, async (session, now) => {
        await this.assertActorUnchanged(actor, session, this.isPlatformAccounts(actor) ? 'account:platform-manage' : 'account:manage');
        if (await this.c.users.findOne({ login_key: loginName }, { session })) fail(409, 'LOGIN_EXISTS', '登录名已存在');
        await this.c.users.insertOne({ _id: userId, login_key: loginName, display_name: displayName, status: 'disabled', privacy_state: 'active', password_hash: hashed, credential_version: 1, identity_revision: 1,
          must_change_password: true, temporary_password_expires_at: new Date(now.getTime() + 86400000), password_changed_at: now, created_at: now, updated_at: now }, { session });
        await this.applyMembership({ session, now }, userId, orgId, memberId, desired, 'active', null);
        const activated = await this.c.users.updateOne({ _id: userId, status: 'disabled' }, { $set: { status: 'active' } }, { session });
        if (!activated.matchedCount) fail(409, 'TARGET_CHANGED', '创建账号未完成');
        return { user_id: userId, member_id: memberId, temporary_password: secret };
      });
  }
  async addMember(req: ApiRequest, orgIdRaw: string, raw: unknown) {
    const body = object(raw, ['user_id', 'roles', 'valid_to', 'reason', 'current_password']);
    const actor = await this.writeActor(req, body);
    const orgId = id(orgIdRaw), targetId = id(body.user_id);
    if (!this.isPlatformAccounts(actor) && !actor.capabilities.includes('platform:govern')) fail(403, 'FORBIDDEN', '关联组织成员需要平台管理职责');
    const target = await this.target(targetId), desired = roles(body.roles), reason = boundedReason(body.reason);
    const reviewerValidTo = this.reviewerExpiry(body.valid_to, desired, desired.includes('content_reviewer'));
    const memberId = await this.stableId(actor, req.get('Idempotency-Key')!, 'member.add', 'member');
    const sensitiveRole = await this.roleDecision(actor, desired, [], targetId, orgId);
    const payload = { user_id: targetId, member_id: memberId, org_id: orgId, roles: desired, valid_to: reviewerValidTo?.toISOString() ?? null };
    const oldReceipt = await this.replay(actor, req, 'approval.request.member.add',
      { action: 'member.add', payload, targetId, memberId, expected: null, requester: actor.identity.user._id }, true);
    if (oldReceipt) return oldReceipt;
    const replay = await this.replay(actor, req, 'member.add', payload);
    if (replay) return replay;
    const protectedTarget = await this.protectedAccount(targetId);
    if (protectedTarget && !actor.capabilities.includes('platform:govern')) fail(403, 'PROTECTED_ACCOUNT', '受保护身份须治理审批');
    if (protectedTarget || sensitiveRole) return this.approval(actor, req, 'member.add', payload, targetId, memberId, target, null, reason);
    this.require(actor, 'account:platform-manage');
    if (await this.c.members.findOne({ user_id: targetId, org_id: orgId })) fail(409, 'MEMBER_EXISTS', '组织成员已存在');
    return this.execute(req, actor, 'member.add', reason, payload, { user_ids: [targetId], member_ids: [memberId], org_ids: [orgId] }, memberId,
      async (session, now) => {
        await this.assertActorUnchanged(actor, session, 'account:platform-manage');
        if (await this.protectedAccount(targetId, session)) fail(403, 'PROTECTED_ACCOUNT', '目标已受保护');
        if (!await this.c.users.findOne({ _id: targetId, credential_version: target.credential_version, status: 'active', ...privacyActive }, { session }))
          fail(409, 'TARGET_CHANGED', '目标凭据在关联前已变化');
        return this.applyMembership({ session, now }, targetId, orgId, memberId, desired, 'active', null);
      });
  }
  async updateMember(req: ApiRequest, memberIdRaw: string, raw: unknown) {
    const body = object(raw, ['roles', 'status', 'expected_revision', 'valid_to', 'reason', 'current_password']);
    const actor = await this.writeActor(req, body), memberId = id(memberIdRaw);
    const targetMember = await this.c.members.findOne({ _id: memberId });
    if (!targetMember) fail(404, 'NOT_FOUND', '成员不存在');
    if (!actor.capabilities.includes('platform:govern')) this.canAccounts(actor, targetMember.org_id);
    const target = await this.target(targetMember.user_id), expected = revision(body.expected_revision, 'expected_revision');
    const nextStatus = status(body.status), desired = roles(body.roles, nextStatus === 'disabled'), reason = boundedReason(body.reason);
    const reviewerValidTo = this.reviewerExpiry(body.valid_to, desired, false);
    const payload = { user_id: target._id, member_id: memberId, org_id: targetMember.org_id, roles: desired, status: nextStatus,
      expected_revision: expected, valid_to: reviewerValidTo?.toISOString() ?? null };
    const oldReceipt = await this.replay(actor, req, 'approval.request.member.update',
      { action: 'member.update', payload, targetId: target._id, memberId, expected, requester: actor.identity.user._id }, true);
    if (oldReceipt) return oldReceipt;
    const ordinaryReceipt = await this.replay(actor, req, 'member.update', payload);
    if (ordinaryReceipt) return ordinaryReceipt;
    if (targetMember.authorization_revision !== expected) fail(409, 'REVISION_CONFLICT', '成员权限已变化');
    const beforeAssignments = await activeMemberRoles(this.db, { member_id: memberId });
    const before = beforeAssignments.map(r => r.role_id);
    const priorReviewer = beforeAssignments.find(r => r.role_id === 'content_reviewer');
    const renewal = desired.includes('content_reviewer') && reviewerValidTo !== undefined &&
      (!priorReviewer || !priorReviewer.valid_to || priorReviewer.valid_to.getTime() !== reviewerValidTo?.getTime());
    if (desired.includes('content_reviewer') && (!priorReviewer || renewal)) this.reviewerExpiry(body.valid_to, desired, true);
    const protectedTarget = await this.protectedAccount(target._id);
    if (target._id === actor.identity.user._id && (nextStatus === 'disabled' || !before.every(r => desired.includes(r)))) fail(403, 'SELF_ESCALATION', '不可停用或降权自己');
    const sensitiveRole = await this.roleDecision(actor, desired, before, target._id, targetMember.org_id) || renewal;
    if (protectedTarget && !actor.capabilities.includes('platform:govern')) fail(403, 'PROTECTED_ACCOUNT', '受保护身份必须走治理审批');
    if (protectedTarget || sensitiveRole) {
      if (protectedTarget) this.require(actor, 'platform:govern');
      if (target._id === actor.identity.user._id) fail(403, 'SELF_ESCALATION', '治理操作不得由受益人申请');
      return this.approval(actor, req, 'member.update', payload, target._id, memberId, target, expected, reason);
    }
    this.canAccounts(actor, targetMember.org_id);
    return this.execute(req, actor, 'member.update', reason, payload, { user_ids: [target._id], member_ids: [memberId], org_ids: [targetMember.org_id] }, memberId,
      async (session, now) => {
        await this.assertActorUnchanged(actor, session, this.isPlatformAccounts(actor) ? 'account:platform-manage' : 'account:manage');
        if (await this.protectedAccount(target._id, session)) fail(403, 'PROTECTED_ACCOUNT', '目标已受保护');
        if (!await this.c.users.findOne({ _id: target._id, credential_version: target.credential_version, status: 'active', ...privacyActive }, { session }))
          fail(409, 'TARGET_CHANGED', '目标凭据在变更前已变化');
        return this.applyMembership({ session, now }, target._id, targetMember.org_id, memberId, desired, nextStatus, expected, reviewerValidTo);
      });
  }
  async userStatus(req: ApiRequest, userIdRaw: string, raw: unknown) {
    const body = object(raw, ['status', 'expected_identity_revision', 'reason', 'current_password']);
    const actor = await this.writeActor(req, body);
    if (!this.isPlatformAccounts(actor) && !actor.capabilities.includes('platform:govern')) fail(403, 'FORBIDDEN', '仅平台账号职责可变更全局状态');
    const targetId = id(userIdRaw), target = await this.target(targetId);
    const desired = status(body.status), expected = revision(body.expected_identity_revision, 'expected_identity_revision'), reason = boundedReason(body.reason);
    const payload = { user_id: targetId, status: desired, expected_identity_revision: expected };
    const oldReceipt = await this.replay(actor, req, 'approval.request.user.status',
      { action: 'user.status', payload, targetId, memberId: null, expected: null, requester: actor.identity.user._id }, true);
    if (oldReceipt) return oldReceipt;
    const ordinaryReceipt = await this.replay(actor, req, 'user.status', payload);
    if (ordinaryReceipt) return ordinaryReceipt;
    if (target.identity_revision !== expected) fail(409, 'IDENTITY_CHANGED', '目标身份版本已变化');
    if (actor.identity.user._id === targetId) fail(403, 'SELF_ESCALATION', '不可修改自己全局状态');
    if (desired === 'active' && target.status === 'disabled' && target.must_change_password && (!target.temporary_password_expires_at || target.temporary_password_expires_at <= new Date())) fail(409, 'PASSWORD_EXPIRED', '临时密码已过期');
    const protectedTarget = await this.protectedAccount(targetId);
    if (protectedTarget && !actor.capabilities.includes('platform:govern')) fail(403, 'PROTECTED_ACCOUNT', '受保护账号必须经过治理审批');
    if (protectedTarget) return this.approval(actor, req, 'user.status', payload, targetId, null, target, null, reason);
    this.require(actor, 'account:platform-manage');
    return this.execute(req, actor, 'user.status', reason, payload, { user_ids: [targetId] }, targetId,
      async (session, now) => {
        await this.assertActorUnchanged(actor, session, 'account:platform-manage');
        if (await this.protectedAccount(targetId, session)) fail(403, 'PROTECTED_ACCOUNT', '目标已受保护');
        if (desired === 'disabled') await this.lastGovernor(targetId, now, session);
        const updated = await this.c.users.updateOne({ _id: targetId, identity_revision: expected, credential_version: target.credential_version, ...privacyActive },
          { $set: { status: desired, updated_at: now }, $inc: { identity_revision: 1, credential_version: 1 } }, { session });
        if (!updated.matchedCount) fail(409, 'IDENTITY_CHANGED', '账号已变化');
        await this.c.sessions.updateMany({ user_id: targetId, revoked_at: null }, { $set: { revoked_at: now } }, { session });
        return { user_id: targetId };
      }, undefined, { targetCredentialVersion: target.credential_version });
  }
  async passwordReset(req: ApiRequest, userIdRaw: string, raw: unknown) {
    const body = object(raw, ['expected_identity_revision', 'reason', 'current_password']);
    const actor = await this.writeActor(req, body);
    const targetId = id(userIdRaw), target = await this.target(targetId), expected = revision(body.expected_identity_revision, 'expected_identity_revision'), reason = boundedReason(body.reason);
    const payload = { user_id: targetId, expected_identity_revision: expected };
    const oldReceipt = await this.replay(actor, req, 'approval.request.user.password.reset',
      { action: 'user.password.reset', payload, targetId, memberId: null, expected: null, requester: actor.identity.user._id }, true);
    if (oldReceipt) return oldReceipt;
    const ordinaryReceipt = await this.replay(actor, req, 'user.password.reset', payload);
    if (ordinaryReceipt) return ordinaryReceipt;
    if (expected !== target.identity_revision) fail(409, 'IDENTITY_CHANGED', '目标身份版本已变化');
    if (targetId === actor.identity.user._id) fail(403, 'SELF_ESCALATION', '管理员不得重置本人管理身份');
    if (!this.isPlatformAccounts(actor) && !actor.capabilities.includes('platform:govern')) {
      this.require(actor, 'account:manage');
      const members = await this.c.members.find({ user_id: targetId }).limit(2).toArray();
      if (members.length !== 1 || members[0]!.org_id !== actor.orgId) fail(403, 'FORBIDDEN', '只能重置唯一归属本组织用户');
    }
    const protectedTarget = await this.protectedAccount(targetId);
    if (protectedTarget && !actor.capabilities.includes('platform:govern')) fail(403, 'PROTECTED_ACCOUNT', '不可接管受保护账号');
    if (protectedTarget) return this.approval(actor, req, 'user.password.reset', payload, targetId, null, target, null, reason);
    if (!this.isPlatformAccounts(actor) && !actor.capabilities.includes('account:manage')) fail(403, 'FORBIDDEN', '治理职责不包含普通账号重置');
    const secret = temporaryPassword(), hashed = await hashPassword(secret);
    return this.execute(req, actor, 'user.password.reset', reason, payload, { user_ids: [targetId] }, targetId,
      async (session, now) => {
        await this.assertActorUnchanged(actor, session, this.isPlatformAccounts(actor) ? 'account:platform-manage' : 'account:manage');
        if (await this.protectedAccount(targetId, session)) fail(403, 'PROTECTED_ACCOUNT', '目标已受保护');
        const result = await this.c.users.updateOne({ _id: targetId, identity_revision: expected, credential_version: target.credential_version, ...privacyActive },
          { $set: { password_hash: hashed, must_change_password: true, temporary_password_expires_at: new Date(now.getTime() + 86400000), password_changed_at: now, updated_at: now },
            $inc: { credential_version: 1, identity_revision: 1 } }, { session });
        if (!result.matchedCount) fail(409, 'IDENTITY_CHANGED', '目标身份版本已变化');
        await this.c.sessions.updateMany({ user_id: targetId, revoked_at: null }, { $set: { revoked_at: now } }, { session });
        return { user_id: targetId, temporary_password: secret };
      }, undefined, { targetCredentialVersion: target.credential_version });
  }
  async grants(req: ApiRequest, raw: unknown) {
    const actor = await this.actor(req);
    if (!actor.capabilities.some(c => ['platform:govern', 'account:platform-manage', 'account:manage', 'authorization:delegate'].includes(c))) fail(403, 'FORBIDDEN', '无授权查看职责');
    const p = page(raw, actor.identity.user._id, `${actor.orgId}:${this.isPlatformAccounts(actor) || actor.capabilities.includes('platform:govern') ? 'global' : 'self'}`, 'grants', { subject_member_id: null, status: null });
    const targetMember = p.q.subject_member_id === undefined ? null : id(p.q.subject_member_id);
    let grantStatus: GrantStatus | undefined;
    if (p.q.status === undefined) grantStatus = undefined;
    else if (p.q.status === 'pending' || p.q.status === 'active' || p.q.status === 'revoked')
      grantStatus = p.q.status;
    else fail(422, 'VALIDATION_ERROR', '授权状态无效');
    if (!targetMember) return { items: [], next_cursor: null };
    const member = await this.c.members.findOne({ _id: targetMember });
    if (!member || !this.isPlatformAccounts(actor) && !actor.capabilities.includes('platform:govern') && member.org_id !== actor.orgId) fail(404, 'NOT_FOUND', '目标成员不可见');
    const query: Pick<Filter<MemberCapabilityGrant>, '_id' | 'status'> = { ...(p.after ? { _id: { $gt: p.after } } : {}),
      ...(grantStatus !== undefined ? { status: grantStatus } : {}) };
    const [local, admin] = await Promise.all([
      this.db.collection<MemberCapabilityGrant>('member_capability_grants').find({ member_id: targetMember, ...query }).sort({ _id: 1 }).limit(p.limit + 1).toArray(),
      this.db.collection<AdministrativeGrant>('administrative_grants').find({ subject_member_id: targetMember, ...query }).sort({ _id: 1 }).limit(p.limit + 1).toArray(),
    ]);
    const all = [...local, ...admin].sort((a, b) => String(a._id).localeCompare(String(b._id))).slice(0, p.limit + 1);
    return { items: all.slice(0, p.limit).map(safeGrant), next_cursor: all.length > p.limit ? p.next(all[p.limit - 1]!._id as string) : null };
  }
  private async grantDetails(memberId: string, capability: string, grantScope: AdministrativeScope, delegates: string[], requesterUserId: string, session?: ClientSession) {
    const member = await this.c.members.findOne({ _id: memberId, status: 'active' }, { session });
    if (!member) fail(404, 'NOT_FOUND', '目标成员不存在');
    const [user, org, assignments] = await Promise.all([
      this.c.users.findOne({ _id: member.user_id, status: 'active', ...privacyActive }, { session }),
      this.c.organizations.findOne({ _id: member.org_id, status: 'active' }, { session }),
      this.c.memberRoles.find({ member_id: member._id }, { session }).toArray(),
    ]);
    if (!user || !org) fail(404, 'NOT_FOUND', '目标成员不可用');
    if (grantScope.kind === 'organization_ids') {
      const count = await this.c.organizations.countDocuments({ _id: { $in: grantScope.organization_ids }, status: 'active' }, { session });
      if (count !== grantScope.organization_ids.length) fail(422, 'INVALID_SCOPE', '授权组织无效');
    }
    // The directory, not the caller-provided capability label, decides its storage and scope.
    const adminPolicy = ADMINISTRATIVE_CATALOG[capability as keyof typeof ADMINISTRATIVE_CATALOG];
    const localPolicy = MEMBER_CAPABILITY_CATALOG[capability as keyof typeof MEMBER_CAPABILITY_CATALOG];
    if (!adminPolicy && !localPolicy) fail(422, 'INVALID_CAPABILITY', '不在授权目录');
    const kind = adminPolicy && org.kind === 'platform' || adminPolicy && Object.hasOwn(adminCapabilities, capability) ? 'administrative' : 'member';
    const policy = kind === 'administrative' ? adminPolicy : localPolicy;
    if (!policy) fail(422, 'INVALID_CAPABILITY', '当前成员不符合能力类型');
    const targetRoles = assignments.map(a => a.role_id);
    if (kind === 'administrative') {
      try { assertGrantPolicy(capability as keyof typeof ADMINISTRATIVE_CATALOG, grantScope, targetRoles, org.kind, delegates); }
      catch { fail(422, 'INVALID_GRANT', '目标角色或授权范围不符合目录'); }
      if (policy.scope === 'self' && grantScope.organization_ids[0] !== member.org_id) fail(422, 'INVALID_SCOPE', '本组织能力不可跨组织');
    } else {
      if (grantScope.kind !== 'organization_ids' || grantScope.organization_ids.length !== 1 || grantScope.organization_ids[0] !== member.org_id || delegates.length) fail(422, 'INVALID_SCOPE', '成员能力必须精确本组织');
      if (policy.required_role !== 'organization_member' && policy.required_role !== 'platform_member' &&
          !targetRoles.includes(policy.required_role)) fail(422, 'INVALID_ROLE', '目标成员缺少必需角色');
    }
    if (member.user_id === requesterUserId) fail(403, 'SELF_ESCALATION', '不可给自己新增授权');
    return { member, user, org, kind, policy, targetRoles };
  }
  async createGrant(req: ApiRequest, raw: unknown) {
    const body = object(raw, ['subject_member_id', 'capability', 'scope', 'delegate_capabilities', 'valid_from', 'valid_to', 'expected_revision', 'reason', 'current_password']);
    const actor = await this.writeActor(req, body), memberId = id(body.subject_member_id), capability = text(body.capability, 'capability', 80);
    const grantScope = scope(body.scope), validFrom = date(body.valid_from, 'valid_from')!, validTo = date(body.valid_to, 'valid_to', true);
    const expected = revision(body.expected_revision, 'expected_revision'), reason = boundedReason(body.reason);
    if (validTo && validFrom >= validTo) fail(422, 'INVALID_PERIOD', '授权有效期无效');
    if (!Array.isArray(body.delegate_capabilities) && body.delegate_capabilities !== undefined) fail(422, 'VALIDATION_ERROR', '委派清单无效');
    const delegates = body.delegate_capabilities === undefined ? [] : (body.delegate_capabilities as unknown[]).map(v => text(v, 'delegate_capabilities', 80));
    if (delegates.length > 16 || new Set(delegates).size !== delegates.length) fail(422, 'VALIDATION_ERROR', '委派清单无效');
    const member = await this.c.members.findOne({ _id: memberId, status: 'active' });
    if (!member) fail(404, 'NOT_FOUND', '目标成员不可用');
    const org = await this.c.organizations.findOne({ _id: member.org_id, status: 'active' });
    if (!org) fail(404, 'NOT_FOUND', '目标组织不可用');
    const existingLocal = org.kind !== 'platform' && isControlledCapability(capability)
      ? await this.db.collection<MemberCapabilityGrant>('member_capability_grants').findOne({
          org_id: member.org_id, member_id: memberId, capability,
        }) : null;
    const priorIntent = await this.db.collection<AdministrationOperation>('administration_operations').findOne({
      actor_id: actor.identity.user._id, action: { $in: ['grant.create', 'approval.request.grant.create'] },
      key: req.get('Idempotency-Key'),
    });
    if (priorIntent && priorIntent.payload_hash !== permissionHash({ before: priorIntent.before, desired: priorIntent.desired }))
      fail(503, 'OPERATION_STATE_CHANGED', '既有授权申请意图校验失败');
    const previousGrantRevision = priorIntent
      ? priorIntent.action === 'grant.create' ? priorIntent.desired.previous_grant_revision :
        priorIntent.desired.payload.previous_grant_revision
      : existingLocal?.revision ?? null;
    const grantId = existingLocal?._id ?? await this.stableId(actor, req.get('Idempotency-Key')!, 'grant.create', 'grant');
    const payload = { grant_id: grantId, member_id: memberId, user_id: member.user_id, org_id: member.org_id, capability, scope: grantScope,
      delegate_capabilities: delegates, valid_from: validFrom.toISOString(), valid_to: validTo?.toISOString() ?? null,
      expected_revision: expected, previous_grant_revision: previousGrantRevision };
    if (!actor.capabilities.includes('platform:govern') && !actor.capabilities.includes('authorization:delegate')) fail(403, 'FORBIDDEN', '没有可委派权限');
    const oldReceipt = await this.replay(actor, req, 'approval.request.grant.create',
      { action: 'grant.create', payload, targetId: member.user_id, memberId, expected, requester: actor.identity.user._id }, true);
    if (oldReceipt) return oldReceipt;
    const ordinaryReceipt = await this.replay(actor, req, 'grant.create', payload);
    if (ordinaryReceipt) return ordinaryReceipt;
    if (existingLocal?.status === 'pending') fail(409, 'GRANT_NEEDS_RECOVERY', '既有授权正在隔离恢复，不可重新授予');
    const details = await this.grantDetails(memberId, capability, grantScope, delegates, actor.identity.user._id);
    if (details.member.authorization_revision !== expected) fail(409, 'REVISION_CONFLICT', '目标授权版本已变化');
    const governance = actor.capabilities.includes('platform:govern') && actor.organizationKind === 'platform';
    let delegated = false;
    if (!governance) {
      this.require(actor, 'authorization:delegate');
      if (actor.orgId !== details.member.org_id || grantScope.kind !== 'organization_ids' || grantScope.organization_ids.length !== 1 || grantScope.organization_ids[0] !== actor.orgId ||
        details.kind !== 'member' || !(DELEGABLE_CAPABILITIES as readonly string[]).includes(capability)) fail(403, 'DELEGATION_DENIED', '不在允许的委派能力/组织范围');
      delegated = actor.admin.some(g => g.capability === 'authorization:delegate' && Array.isArray(g.delegate_capabilities) && g.delegate_capabilities.includes(capability));
      if (!delegated) fail(403, 'DELEGATION_DENIED', '当前有效委派清单不含该能力');
    }
    const sensitiveGrant = details.kind === 'administrative' && (details.policy.sensitivity !== 'ordinary' || grantScope.kind === 'all_organizations' || details.member.org_id !== actor.orgId) || details.policy.sensitivity !== 'ordinary';
    if (sensitiveGrant && !validTo && capability !== 'platform:govern') fail(422, 'VALID_TO_REQUIRED', '敏感权限必须明确有效期限');
    if (sensitiveGrant) return this.approval(actor, req, 'grant.create', payload, details.user._id, memberId, details.user, expected, reason);
    return this.execute(req, actor, 'grant.create', reason, payload, { user_ids: [details.user._id], member_ids: [memberId], org_ids: [details.member.org_id] }, grantId,
      async (session, now, operation_id) => {
        await this.assertActorUnchanged(actor, session, delegated ? 'authorization:delegate' : 'platform:govern', delegated ? capability : undefined);
        const fenced = await this.c.members.updateOne({ _id: memberId, authorization_revision: expected, status: 'active' }, { $inc: { authorization_revision: 1 }, $set: { updated_at: now } }, { session });
        if (!fenced.matchedCount) fail(409, 'REVISION_CONFLICT', '目标成员权限已变化');
        await this.insertGrant(payload, operation_id, now, session, 'delegation', null);
        const changedUser = await this.c.users.updateOne({ _id: details.user._id, credential_version: details.user.credential_version, status: 'active', ...privacyActive },
          { $inc: { identity_revision: 1 } }, { session });
        if (!changedUser.matchedCount) fail(409, 'TARGET_CHANGED', '目标凭据在授予前已变化');
        return { grant_id: grantId };
      }, async (session, now) => {
        await this.assertActorUnchanged(actor, session, delegated ? 'authorization:delegate' : 'platform:govern', delegated ? capability : undefined);
        await this.activateGrant(grantId, session, now);
      });
  }
  private async insertGrant(payload: Document, operationId: string, now: Date, session: ClientSession, authority: 'approval' | 'delegation', approvalId: string | null) {
    const memberId = id(payload.member_id), capability = text(payload.capability, 'capability', 80);
    const grantScope = scope(payload.scope), validFrom = date(payload.valid_from, 'valid_from')!, validTo = date(payload.valid_to, 'valid_to', true);
    const grantId = id(payload.grant_id);
    if (validTo && validTo <= now) fail(409, 'GRANT_EXPIRED', '授权申请已经过期');
    const member = await this.c.members.findOne({ _id: memberId, status: 'active' }, { session });
    if (!member) fail(409, 'TARGET_CHANGED', '授权目标已失效');
    const fields = { _id: grantId, status: 'pending' as const, revision: 1, valid_from: validFrom, valid_to: validTo, operation_id: operationId, authority,
      created_at: now, updated_at: now };
    if (payload.scope && member.org_id !== payload.org_id) fail(409, 'TARGET_CHANGED', '成员组织已变化');
    const org = await this.c.organizations.findOne({ _id: member.org_id, status: 'active' }, { session });
    if (!org) fail(409, 'TARGET_CHANGED', '目标组织已失效');
    const administrative = Object.hasOwn(adminCapabilities, capability) || org.kind === 'platform' && Object.hasOwn(ADMINISTRATIVE_CATALOG, capability);
    if (administrative) {
      if (!isAdministrativeCapability(capability)) fail(422, 'INVALID_CAPABILITY', '行政能力不在授权目录');
      await this.db.collection<AdministrativeGrant>('administrative_grants').insertOne({ ...fields, capability,
        subject_member_id: memberId, actor_org_id: member.org_id, scope: grantScope,
        scope_key: scopeFingerprint(grantScope), delegate_capabilities: payload.delegate_capabilities ?? [], approval_id: approvalId }, { session });
    } else {
      if (!isControlledCapability(capability)) fail(422, 'INVALID_CAPABILITY', '组织能力不在授权目录');
      const grants = this.db.collection<MemberCapabilityGrant>('member_capability_grants');
      const key = { org_id: member.org_id, member_id: memberId, capability };
      const existing = await grants.findOne(key, { session });
      const previousRevision = payload.previous_grant_revision === null ? null :
        revision(payload.previous_grant_revision, 'previous_grant_revision');
      if (existing) {
        if (existing._id !== grantId || existing.revision !== previousRevision || existing.status === 'pending')
          fail(409, 'GRANT_CHANGED', '既有授权元组已变化，需要重新申请');
        const updated = await grants.updateOne({ ...key, _id: grantId, revision: previousRevision!, status: existing.status },
          { $set: { status: 'pending', valid_from: validFrom, valid_to: validTo, operation_id: operationId,
            authority, updated_at: now }, $inc: { revision: 1 } }, { session });
        if (!updated.matchedCount) fail(409, 'GRANT_CHANGED', '既有授权元组并发变化');
      } else {
        if (previousRevision !== null) fail(409, 'GRANT_CHANGED', '既有授权元组已消失');
        await grants.insertOne({ ...fields, ...key }, { session });
      }
    }
  }
  private async activateGrant(grantId: string, session: ClientSession, now: Date) {
    const administrative = this.db.collection<AdministrativeGrant>('administrative_grants');
    const member = this.db.collection<MemberCapabilityGrant>('member_capability_grants');
    const [a, m] = await Promise.all([administrative.findOne({ _id: grantId, status: 'pending' }, { session }),
      member.findOne({ _id: grantId, status: 'pending' }, { session })]);
    const grant = a ?? m;
    if (!grant || grant.valid_to && grant.valid_to <= now) fail(409, 'GRANT_EXPIRED', '待生效授权已过期');
    const collection = this.db.collection<GrantRecord>(a ? 'administrative_grants' : 'member_capability_grants');
    const changed = await collection.updateOne({ _id: grantId, status: 'pending', revision: grant.revision },
      { $set: { status: 'active', updated_at: now }, $inc: { revision: 1 } }, { session });
    if (!changed.matchedCount) fail(409, 'GRANT_CHANGED', '授权状态发生变化');
  }
  async revokeGrant(req: ApiRequest, grantIdRaw: string, raw: unknown) {
    const body = object(raw, ['expected_revision', 'reason', 'current_password']);
    const actor = await this.writeActor(req, body), grantId = id(grantIdRaw), expected = revision(body.expected_revision, 'expected_revision'), reason = boundedReason(body.reason);
    const [admin, local] = await Promise.all([this.db.collection<AdministrativeGrant>('administrative_grants').findOne({ _id: grantId }), this.db.collection<MemberCapabilityGrant>('member_capability_grants').findOne({ _id: grantId })]);
    const grant = admin ?? local;
    if (!grant) fail(404, 'NOT_FOUND', '授权不存在');
    const memberId = id(grant.subject_member_id ?? grant.member_id), member = await this.c.members.findOne({ _id: memberId });
    if (!member) fail(404, 'NOT_FOUND', '目标成员不存在');
    const governance = actor.capabilities.includes('platform:govern') && actor.organizationKind === 'platform';
    if (!governance) this.require(actor, 'authorization:delegate');
    const payload = { grant_id: grantId, member_id: memberId, expected_revision: expected };
    const prior = await this.replay(actor, req, 'grant.revoke', payload);
    if (prior) return prior;
    if (grant.status !== 'active') fail(404, 'NOT_FOUND', '当前有效授权不存在');
    if (grant.revision !== expected) fail(409, 'REVISION_CONFLICT', '授权版本已变化');
    if (member.user_id === actor.identity.user._id) fail(403, 'SELF_ESCALATION', '不可撤销自己的管理权限');
    if (!governance) {
      this.require(actor, 'authorization:delegate');
      if (admin || member.org_id !== actor.orgId || !(DELEGABLE_CAPABILITIES as readonly string[]).includes(grant.capability) ||
        !actor.admin.some(g => g.capability === 'authorization:delegate' && Array.isArray(g.delegate_capabilities) && g.delegate_capabilities.includes(grant.capability))) fail(403, 'DELEGATION_DENIED', '不在可撤销的委派清单');
    }
    return this.execute(req, actor, 'grant.revoke', reason, payload, { user_ids: [member.user_id], member_ids: [memberId], org_ids: [member.org_id] }, grantId,
      async (session, now) => {
        await this.assertActorUnchanged(actor, session, governance ? 'platform:govern' : 'authorization:delegate', governance ? undefined : grant.capability);
        if (grant.capability === 'platform:govern') await this.lastGovernor(member.user_id, now, session);
        const collection = this.db.collection<GrantRecord>(admin ? 'administrative_grants' : 'member_capability_grants');
        const result = await collection.updateOne({ _id: grantId, revision: expected, status: 'active' },
          { $set: { status: 'revoked', updated_at: now }, $inc: { revision: 1 } }, { session });
        if (!result.matchedCount) fail(409, 'REVISION_CONFLICT', '授权已变化');
        await this.c.members.updateOne({ _id: memberId }, { $inc: { authorization_revision: 1 } }, { session });
        await this.c.users.updateOne({ _id: member.user_id }, { $inc: { identity_revision: 1 } }, { session });
        await this.c.sessions.updateMany({ user_id: member.user_id, revoked_at: null }, { $set: { revoked_at: now } }, { session });
        return { grant_id: grantId };
      });
  }
  private requesterAuthorized(request: Approval, session?: ClientSession) {
    return assertRequesterCurrent(this.db, request, session);
  }
  private async approvalTargetUnchanged(request: Approval, session?: ClientSession) {
    const target = await this.c.users.findOne({ _id: request.beneficiary_user_id, ...privacyActive }, { session });
    if (request.action === 'user.create') {
      if (target) fail(409, 'TARGET_CHANGED', '申请目标已被占用');
    } else if (!target || request.action !== 'invitation.create' && target.identity_revision !== request.target_identity_revision || target.credential_version !== request.target_credential_version) {
      fail(409, 'TARGET_CHANGED', '申请以来目标身份或凭据已变化，请重新申请');
    }
    if (request.subject_member_id && request.action !== 'user.create' && request.action !== 'member.add') {
      const member = await this.c.members.findOne({ _id: request.subject_member_id }, { session });
      if (!member || member.authorization_revision !== request.expected_grant_revision || member.user_id !== request.beneficiary_user_id) fail(409, 'TARGET_CHANGED', '申请以来目标成员已变化');
    }
    return target;
  }
  private approvalView(row: Approval) {
    return { id: row._id, action: row.action, requester_id: row.requester_user_id, target_user_id: row.beneficiary_user_id,
      target_member_id: row.subject_member_id, payload: row.payload, payload_hash: row.payload_hash, reason: row.reason,
      status: row.status, revision: row.revision, approver_id: row.approver_user_id,
      created_at: row.created_at, updated_at: row.updated_at };
  }
  async approvalDetail(req: ApiRequest, approvalId: string) {
    const actor = await this.actor(req);
    if (!actor.capabilities.some(capability => ['platform:govern', 'account:platform-manage', 'account:manage', 'authorization:delegate'].includes(capability)))
      fail(403, 'FORBIDDEN', '无审批读取职责');
    const row = await this.db.collection<Approval>('authorization_requests').findOne({
      _id: id(approvalId), ...(actor.capabilities.includes('platform:govern') ? {} :
        { requester_user_id: actor.identity.user._id }),
    });
    if (!row) fail(404, 'NOT_FOUND', '申请不存在');
    return this.approvalView(row);
  }
  async approvals(req: ApiRequest, raw: unknown) {
    const actor = await this.actor(req);
    if (!actor.capabilities.some(c => ['platform:govern', 'account:platform-manage', 'account:manage', 'authorization:delegate'].includes(c))) fail(403, 'FORBIDDEN', '无审批列表权限');
    const p = page(raw, actor.identity.user._id, `${actor.orgId}:${actor.capabilities.includes('platform:govern') ? 'govern' : 'own'}`, 'approvals', { status: null });
    const approvalStatus = p.q.status;
    if (approvalStatus !== undefined && approvalStatus !== 'pending' && approvalStatus !== 'approved' &&
        approvalStatus !== 'rejected' && approvalStatus !== 'applying' && approvalStatus !== 'applied' &&
        approvalStatus !== 'needs_recovery') fail(422, 'VALIDATION_ERROR', '审批状态无效');
    const rows = await this.db.collection<Approval>('authorization_requests').find({ ...(actor.capabilities.includes('platform:govern') ? {} : { requester_user_id: actor.identity.user._id }),
      ...(approvalStatus ? { status: approvalStatus } : {}), ...(p.after ? { _id: { $gt: p.after } } : {}) }).sort({ _id: 1 }).limit(p.limit + 1).toArray();
    return { items: rows.slice(0, p.limit).map(row => this.approvalView(row)),
      next_cursor: rows.length > p.limit ? p.next(rows[p.limit - 1]!._id) : null };
  }
  async decide(req: ApiRequest, approvalIdRaw: string, raw: unknown) {
    const body = object(raw, ['decision', 'expected_revision', 'reason', 'current_password']);
    const actor = await this.writeActor(req, body); this.require(actor, 'platform:govern');
    if (body.decision !== 'approve' && body.decision !== 'reject') fail(422, 'VALIDATION_ERROR', '审批决定无效');
    const approvalId = id(approvalIdRaw), expected = revision(body.expected_revision, 'expected_revision'), reason = boundedReason(body.reason);
    const request = await this.db.collection<Approval>('authorization_requests').findOne({ _id: approvalId });
    if (!request) fail(404, 'NOT_FOUND', '申请不存在');
    const previous = await this.replay(actor, req, `approval.${body.decision}`, { approval_id: approvalId, decision: body.decision, expected_revision: expected });
    if (previous) return previous;
    if (request.status !== 'pending' || request.revision !== expected) fail(409, 'APPROVAL_CHANGED', '申请已变化，不能继续审批');
    if (actor.identity.user._id === request.requester_user_id || actor.identity.user._id === request.beneficiary_user_id ||
        request.requester_user_id === request.beneficiary_user_id) fail(403, 'APPROVAL_INDEPENDENCE', '申请人、审批人和受益人必须两两独立');
    if (request.payload_hash !== permissionHash(request.payload)) fail(409, 'PAYLOAD_CHANGED', '申请内容已经变化');
    if (body.decision === 'approve') {
      await this.requesterAuthorized(request);
      await this.approvalTargetUnchanged(request);
    }
    const applicantMember = await this.c.members.findOne({ _id: request.requester_member_id }, { projection: { org_id: 1 } });
    const secret = body.decision === 'approve' && ['user.create', 'user.password.reset'].includes(request.action) ? temporaryPassword() : null;
    const hashed = secret ? await hashPassword(secret) : null;
    const receipt = await executeAdministrationOperation({
      client: this.database.client, db: this.db, actor: actor.identity.user._id, action: `approval.${body.decision}`, reason,
      key: req.get('Idempotency-Key')!, payload: { approval_id: approvalId, decision: body.decision, expected_revision: expected, actorOrgId: actor.orgId },
      targets: { user_ids: [request.beneficiary_user_id], member_ids: request.subject_member_id ? [request.subject_member_id] : [], org_ids: [] },
      audit: { actor_org_id: actor.orgId, org_id: applicantMember?.org_id ?? null,
        target_org_id: applicantMember?.org_id ?? null, resource_id: approvalId, approval_id: approvalId, request_id: req.requestId },
      apply: async ({ session, now, operation_id }) => {
        await this.assertActorUnchanged(actor, session, 'platform:govern');
        const pending = await this.db.collection<Approval>('authorization_requests').findOne({ _id: approvalId, status: 'pending', revision: expected }, { session });
        if (!pending || pending.payload_hash !== permissionHash(pending.payload) || pending.requester_user_id !== request.requester_user_id ||
          pending.beneficiary_user_id !== request.beneficiary_user_id) fail(409, 'APPROVAL_CHANGED', '申请内容已变化');
        if (body.decision === 'approve') {
          await this.requesterAuthorized(pending, session);
          await this.approvalTargetUnchanged(pending, session);
        }
        const changed = await this.db.collection<AuthorizationRequest>('authorization_requests').updateOne({ _id: approvalId, status: 'pending', revision: expected },
          { $set: { status: body.decision === 'approve' ? 'approved' : 'rejected', approver_user_id: actor.identity.user._id,
            approver_credential_version: actor.identity.user.credential_version,
            approved_at: now, updated_at: now, operation_id }, $inc: { revision: 1 } }, { session });
        if (!changed.matchedCount) fail(409, 'APPROVAL_CHANGED', '申请已被其他审批人处理');
        if (body.decision === 'reject') return { approval_id: approvalId, status: 'rejected' };
        await this.db.collection<AuthorizationRequest>('authorization_requests').updateOne({ _id: approvalId, status: 'approved' }, { $set: { status: 'applying', updated_at: now } }, { session });
        const effect = await this.applyApproved(pending, session, now, operation_id, hashed, secret);
        return { approval_id: approvalId, status: 'applied', ...effect };
      },
      verify: async ({ session, now }) => {
        if (body.decision !== 'approve') return;
        await this.assertActorUnchanged(actor, session, 'platform:govern');
        await this.requesterAuthorized(request, session);
        if (request.action === 'grant.create') await this.activateGrant(id(request.payload.grant_id), session, now);
        const finalized = await this.db.collection<AuthorizationRequest>('authorization_requests').updateOne({ _id: approvalId, status: 'applying',
          approver_user_id: actor.identity.user._id }, { $set: { status: 'applied', updated_at: now }, $inc: { revision: 1 } }, { session });
        if (!finalized.matchedCount) fail(409, 'APPROVAL_CHANGED', '审批结果未能发布');
      },
    });
    return { operation_id: receipt.operation_id, status: receipt.replayed ? 'applied' : receipt.result?.status ?? 'applied',
      ...(receipt.result ?? {}), ...(receipt.replayed && secret ? { password_not_replayable: true } : {}) };
  }
  private async applyApproved(request: Approval, session: ClientSession, now: Date, operationId: string, hashed: string | null, secret: string | null) {
    const p = request.payload;
    if (request.action === 'invitation.create') {
      if (p.target_user_id !== request.beneficiary_user_id) fail(409, 'APPROVAL_INVALID', '邀请受益人已变化');
      return this.persistInvitation(p as AuthInvitation['payload'], session, now, operationId, request._id);
    }
    if (request.action === 'user.create') {
      const userId = id(p.user_id), memberId = id(p.member_id), orgId = id(p.org_id), desired = roles(p.roles);
      if (!hashed || !secret || userId !== request.beneficiary_user_id || memberId !== request.subject_member_id) fail(409, 'APPROVAL_INVALID', '申请目标不一致');
      const loginName = login(p.login_name), displayName = text(p.display_name, 'display_name', 100);
      if (await this.c.users.findOne({ login_key: loginName }, { session })) fail(409, 'LOGIN_EXISTS', '登录名已被使用');
      await this.c.users.insertOne({ _id: userId, login_key: loginName, display_name: displayName, status: 'disabled', privacy_state: 'active',
        password_hash: hashed, credential_version: 1, identity_revision: 1, must_change_password: true,
        temporary_password_expires_at: new Date(now.getTime() + 86400000), password_changed_at: now, created_at: now, updated_at: now }, { session });
      await this.applyMembership({ session, now }, userId, orgId, memberId, desired, 'active', null,
        p.valid_to === null ? undefined : date(p.valid_to, 'valid_to', true), operationId, request._id);
      await this.c.users.updateOne({ _id: userId, status: 'disabled' }, { $set: { status: 'active' } }, { session });
      return { user_id: userId, member_id: memberId, temporary_password: secret };
    }
    if (request.action === 'member.add' || request.action === 'member.update') {
      const orgId = id(p.org_id), memberId = id(p.member_id), userId = id(p.user_id);
      const desired = roles(p.roles, request.action === 'member.update' && p.status === 'disabled');
      if (userId !== request.beneficiary_user_id || memberId !== request.subject_member_id) fail(409, 'APPROVAL_INVALID', '成员目标不一致');
      return this.applyMembership({ session, now }, userId, orgId, memberId, desired, request.action === 'member.add' ? 'active' : status(p.status),
        request.action === 'member.add' ? null : revision(p.expected_revision, 'expected_revision'),
        p.valid_to === null ? undefined : date(p.valid_to, 'valid_to', true), operationId, request._id);
    }
    if (request.action === 'grant.create') {
      const memberId = id(p.member_id), capability = text(p.capability, 'capability', 80), desiredScope = scope(p.scope);
      const owner = await this.c.members.findOne({ _id: memberId, status: 'active', authorization_revision: request.expected_grant_revision! }, { session });
      if (!owner || owner.user_id !== request.beneficiary_user_id) fail(409, 'TARGET_CHANGED', '目标授权版本已变化');
      const delegates = Array.isArray(p.delegate_capabilities) ? p.delegate_capabilities.map((v: unknown) => text(v, 'delegate_capabilities', 80)) : [];
      await this.grantDetails(memberId, capability, desiredScope, delegates, request.requester_user_id, session);
      const fenced = await this.c.members.updateOne({ _id: memberId, authorization_revision: request.expected_grant_revision!, status: 'active' }, { $inc: { authorization_revision: 1 } }, { session });
      if (!fenced.matchedCount) fail(409, 'TARGET_CHANGED', '目标授权版本已变化');
      await this.insertGrant(p, operationId, now, session, 'approval', request._id);
      await this.c.users.updateOne({ _id: request.beneficiary_user_id }, { $inc: { identity_revision: 1 } }, { session });
      return { grant_id: id(p.grant_id) };
    }
    if (request.action === 'user.status' || request.action === 'user.password.reset') {
      const userId = id(p.user_id), expected = revision(p.expected_identity_revision, 'expected_identity_revision');
      if (userId !== request.beneficiary_user_id) fail(409, 'APPROVAL_INVALID', '身份目标不一致');
      if (request.action === 'user.status' && p.status === 'disabled') await this.lastGovernor(userId, now, session);
      const filter = { _id: userId, identity_revision: expected, credential_version: request.target_credential_version, ...privacyActive };
      let result;
      if (request.action === 'user.status') {
        result = await this.c.users.updateOne(filter, { $set: { status: status(p.status), updated_at: now },
          $inc: { identity_revision: 1, credential_version: 1 } }, { session });
      } else {
        if (!hashed || !secret) fail(409, 'APPROVAL_INVALID', '密码交付未准备');
        result = await this.c.users.updateOne(filter, { $set: { password_hash: hashed, must_change_password: true,
          temporary_password_expires_at: new Date(now.getTime() + 86400000), password_changed_at: now, updated_at: now },
          $inc: { identity_revision: 1, credential_version: 1 } }, { session });
      }
      if (!result.matchedCount) fail(409, 'TARGET_CHANGED', '身份已改变');
      await this.c.sessions.updateMany({ user_id: userId, revoked_at: null }, { $set: { revoked_at: now } }, { session });
      return request.action === 'user.password.reset' ? { user_id: userId, temporary_password: secret! } : { user_id: userId };
    }
    fail(422, 'APPROVAL_INVALID', '申请动作不在安全目录');
  }
  async operations(req: ApiRequest, raw: unknown) {
    const actor = await this.actor(req);
    if (!actor.capabilities.some(c => ['platform:govern', 'account:platform-manage', 'account:manage', 'authorization:delegate'].includes(c))) fail(403, 'FORBIDDEN', '无操作回执权限');
    const q = object(raw, ['key']);
    const key = text(q.key, 'key', 128);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) fail(422, 'VALIDATION_ERROR', '操作键无效');
    const rows = await this.db.collection<AdministrationOperation>('administration_operations').find({
      actor_id: actor.identity.user._id, key, 'desired.actorOrgId': actor.orgId,
    }).sort({ created_at: -1, _id: -1 }).limit(25).toArray();
    const events = await this.db.collection<AuditEvent>('audit_events').find({ operation_id: { $in: rows.map(row => row._id) },
      approval_id: { $type: 'objectId' } }, { projection: { operation_id: 1, approval_id: 1 } }).limit(25).toArray();
    const approvalIds = [...new Set(events.map(event => event.approval_id as string))];
    const approvals = await this.db.collection<Approval>('authorization_requests').find({ _id: { $in: approvalIds } },
      { projection: { _id: 1, status: 1, action: 1, 'payload.invitation_id': 1 } }).toArray();
    const states = new Map(approvals.map(item => [item._id, item.status]));
    const byOperation = new Map(events.map(event => [event.operation_id, event.approval_id]));
    const approvalById = new Map(approvals.map(item => [item._id, item]));
    return { items: await Promise.all(rows.map(async row => {
      if (row.action.startsWith('invitation.') && !actor.capabilities.includes('platform:govern')) this.canAccounts(actor, row.desired.org_id);
      const approvalId = byOperation.get(row._id) ?? null;
      const invitationId = row.desired.invitation_id ?? row.desired.payload?.invitation_id ?? approvalById.get(approvalId!)?.payload?.invitation_id;
      return { id: row._id, operation_id: row._id, action: row.action, status: row.status,
        approval_id: approvalId, approval_status: states.get(approvalId!) ?? null,
        ...(typeof invitationId === 'string' ? await this.invitationReceipt(invitationId) : {}), created_at: row.created_at };
    })), next_cursor: null };
  }
  async operation(req: ApiRequest, operationId: string) {
    const actor = await this.actor(req);
    const row = await this.db.collection<AdministrationOperation>('administration_operations').findOne({ _id: id(operationId) });
    if (!row || row.actor_id !== actor.identity.user._id && !actor.capabilities.includes('platform:govern')) fail(404, 'NOT_FOUND', '操作不存在');
    const [guard, event] = await Promise.all([
      actor.capabilities.includes('platform:govern')
        ? this.db.collection<AdministrationGuard>('administration_guard').findOne({ _id: 'administration', operation_id: row._id }) : Promise.resolve(null),
      this.db.collection<AuditEvent>('audit_events').findOne({ operation_id: row._id, approval_id: { $type: 'objectId' } },
        { projection: { approval_id: 1 } }),
    ]);
    const approval = event?.approval_id ? await this.db.collection<Approval>('authorization_requests').findOne({ _id: event.approval_id },
      { projection: { status: 1, 'payload.invitation_id': 1 } }) : null;
    if (row.action.startsWith('invitation.') && !actor.capabilities.includes('platform:govern')) this.canAccounts(actor, row.desired.org_id);
    const invitationId = row.desired.invitation_id ?? row.desired.payload?.invitation_id ?? approval?.payload?.invitation_id;
    return { id: row._id, operation_id: row._id, action: row.action, status: row.status, step: row.step,
      approval_id: event?.approval_id ?? null, approval_status: approval?.status ?? null,
      ...(typeof invitationId === 'string' ? await this.invitationReceipt(invitationId) : {}),
      ...(guard ? { recovery: { state: guard.state, recovery_token: guard.recovery_token } } : {}),
      created_at: row.created_at, updated_at: row.updated_at };
  }
  async audit(req: ApiRequest, raw: unknown) {
    const actor = await this.actor(req);
    if (!actor.capabilities.some(c => ['platform:govern', 'account:platform-manage', 'account:manage'].includes(c))) fail(403, 'FORBIDDEN', '无审计读取职责');
    const global = actor.capabilities.includes('platform:govern') || this.isPlatformAccounts(actor);
    const p = page(raw, actor.identity.user._id, `${actor.orgId}:${global ? 'global' : 'local'}`, 'audit', {});
    const rows = await this.c.audit.find({ ...(global ? {} : { $or: [{ org_id: actor.orgId }, { actor_org_id: actor.orgId }] }), ...(p.after ? { _id: { $gt: p.after } } : {}) },
      { projection: { _id: 1, actor_id: 1, org_id: 1, actor_org_id: 1, target_org_id: 1, action: 1, resource_id: 1, reason: 1, request_id: 1, operation_id: 1, approval_id: 1, grant_id: 1, created_at: 1 } })
      .sort({ _id: 1 }).limit(p.limit + 1).toArray();
    return { items: rows.slice(0, p.limit).map(r => ({ id: r._id, actor_id: r.actor_id, org_id: r.org_id, actor_org_id: r.actor_org_id ?? null, target_org_id: r.target_org_id ?? null,
      action: r.action, resource_id: r.resource_id, reason: r.reason, request_id: r.request_id, operation_id: r.operation_id ?? null, approval_id: r.approval_id ?? null,
      grant_id: r.grant_id ?? null, created_at: r.created_at })), next_cursor: rows.length > p.limit ? p.next(rows[p.limit - 1]!._id) : null };
  }
}

function unchangedPriorMemberGrant(grant: GrantRecord, payload: Document, operationId: string): boolean {
  return grant.operation_id !== operationId &&
    typeof payload.previous_grant_revision === 'number' && Number.isSafeInteger(payload.previous_grant_revision) &&
    payload.previous_grant_revision > 0 && grant.revision === payload.previous_grant_revision &&
    grant._id === payload.grant_id && grant.capability === payload.capability &&
    'member_id' in grant && grant.member_id === payload.member_id &&
    'org_id' in grant && grant.org_id === payload.org_id && grant.status !== 'pending';
}
function assertGrantPublished(grant: GrantRecord, payload: Document, operationId: string): void {
  const expectedRevision = payload.previous_grant_revision === null ? 2 :
    revision(payload.previous_grant_revision, 'previous_grant_revision') + 2;
  if (grant.operation_id !== operationId || grant.status !== 'active' ||
      grant.revision !== expectedRevision || grant.capability !== payload.capability ||
      grant.valid_from.toISOString() !== payload.valid_from ||
      grant.valid_to?.toISOString() !== (payload.valid_to ?? undefined) ||
      ('member_id' in grant && (grant.member_id !== payload.member_id || grant.org_id !== payload.org_id)) ||
      ('subject_member_id' in grant && (grant.subject_member_id !== payload.member_id ||
        canonical(grant.scope) !== canonical(payload.scope))))
    fail(409, 'GRANT_NOT_PUBLISHED', '授权元组、期限或版本未按批准内容发布');
}

async function recoveryApproval(db: Db, operation: AdministrationOperation, session?: ClientSession): Promise<Approval> {
  if (operation.action !== 'approval.approve') fail(422, 'RECOVERY_ACTION_INVALID', '该恢复入口只处理已经批准的独立审批');
  const approvalId = id(operation.desired.approval_id);
  const request = await db.collection<Approval>('authorization_requests').findOne({ _id: approvalId }, { session });
  if (!request || request.payload_hash !== permissionHash(request.payload) ||
      request.beneficiary_user_id !== operation.targets.user_ids[0] ||
      (request.approver_user_id !== operation.actor_id && !(request.approver_user_id === null &&
        ['intent', 'invalidated'].includes(operation.step) && ['pending', 'rejected'].includes(request.status))) ||
      (request.operation_id !== operation._id && !(request.approver_user_id === null &&
        ['intent', 'invalidated'].includes(operation.step) && ['pending', 'rejected'].includes(request.status))))
    fail(409, 'APPROVAL_INVALID', '审批证据、目标或操作已发生变化');
  if (request.requester_user_id === request.approver_user_id || request.requester_user_id === request.beneficiary_user_id ||
      request.approver_user_id === request.beneficiary_user_id) fail(403, 'APPROVAL_INDEPENDENCE', '独立审批三方身份不满足');
  return request;
}

async function assertApproverCurrent(db: Db, request: Approval, session: ClientSession) {
  const c = collections(db);
  const user = await c.users.findOne({ _id: request.approver_user_id!, status: 'active', ...privacyActive }, { session });
  if (!user || user.must_change_password || user.credential_version !== request.approver_credential_version)
    fail(409, 'APPROVER_CHANGED', '审批人当前身份或凭据已变化');
  const members = await c.members.find({ user_id: user._id, status: 'active' }, { session }).toArray();
  for (const member of members) {
    const org = await c.organizations.findOne({ _id: member.org_id, status: 'active', kind: 'platform' }, { session });
    if (!org || !(await currentManagementRoles(db, member._id, member.org_id, session)).includes('platform_ops')) continue;
    const grants = await db.collection<AdministrativeGrant>('administrative_grants').find({ subject_member_id: member._id, actor_org_id: org._id,
      capability: 'platform:govern', status: 'active', $expr: validAtDatabaseTime }, { session }).toArray();
    for (const grant of grants) if (grant.operation_id && grant.scope?.kind === 'organization_ids' &&
      grant.scope.organization_ids.includes(org._id) &&
      await db.collection<AdministrationOperation>('administration_operations').findOne({ _id: grant.operation_id, status: 'applied' }, { session })) return;
  }
  fail(409, 'APPROVER_CHANGED', '审批人已失去当前治理权限');
}

async function assertApprovedResult(db: Db, operation: AdministrationOperation, request: Approval, session: ClientSession) {
  if (request.status !== 'applied' || request.operation_id !== operation._id ||
      !await db.collection<AuditEvent>('audit_events').findOne({ operation_id: operation._id, action: 'approval.approve' }, { session }))
    fail(409, 'APPROVAL_NOT_PUBLISHED', '审批申请或审计尚未完整发布');
  const c = collections(db), p = request.payload, targetId = request.beneficiary_user_id;
  const user = await c.users.findOne({ _id: targetId, ...privacyActive }, { session });
  if (!user) fail(409, 'TARGET_CHANGED', '审批目标已失效');
  if (request.action === 'invitation.create') {
    const invitation = await emailCollections(db).invitations.findOne({ _id: id(p.invitation_id), approval_id: request._id, operation_id: operation._id }, { session });
    if (!invitation || invitation.payload_hash !== request.payload_hash || canonical(invitation.payload) !== canonical(p))
      fail(409, 'INVITATION_NOT_PUBLISHED', '批准邀请登记证据未确认');
    return;
  }
  if (request.action === 'grant.create') {
    const grantId = id(p.grant_id);
    const grant = await db.collection<AdministrativeGrant>('administrative_grants').findOne({ _id: grantId, operation_id: operation._id }, { session }) ??
      await db.collection<MemberCapabilityGrant>('member_capability_grants').findOne({ _id: grantId, operation_id: operation._id }, { session });
    if (!grant) fail(409, 'GRANT_NOT_PUBLISHED', '目标授权尚未发布');
    assertGrantPublished(grant, p, operation._id);
    return;
  }
  if (request.action === 'member.add' || request.action === 'member.update' || request.action === 'user.create') {
    const member = await c.members.findOne({ _id: id(p.member_id), user_id: targetId, org_id: id(p.org_id) }, { session });
    if (!member || member.status !== (request.action === 'member.update' ? p.status : 'active') ||
        member.authorization_revision !== (request.expected_grant_revision ?? 0) + 1)
      fail(409, 'MEMBER_NOT_PUBLISHED', '目标成员最终状态未核实');
    const roleRows = await c.memberRoles.find({ member_id: member._id }, { session }).toArray();
    const actual = roleRows.filter(row => row.status !== 'revoked').map(row => row.role_id).sort();
    if (canonical(actual) !== canonical(roles(p.roles, request.action === 'member.update' && p.status === 'disabled')))
      fail(409, 'ROLE_NOT_PUBLISHED', '实际角色与批准内容不同');
    if (actual.includes('content_reviewer') && p.valid_to) {
      const reviewer = roleRows.find(row => row.role_id === 'content_reviewer');
      if (!reviewer || !(reviewer.valid_to instanceof Date) || reviewer.valid_to.toISOString() !== p.valid_to ||
          reviewer.operation_id !== operation._id || reviewer.approval_id !== request._id)
        fail(409, 'REVIEWER_NOT_PUBLISHED', '审核角色审批期限未发布');
    }
    if (request.action === 'user.create' && (user.login_key !== p.login_name || user.status !== 'active' || !user.must_change_password))
      fail(409, 'USER_NOT_PUBLISHED', '新账号尚未完成激活及强制改密');
    return;
  }
  if (request.action === 'user.status') {
    if (user.status !== p.status || user.credential_version !== request.target_credential_version + 1)
      fail(409, 'STATUS_NOT_PUBLISHED', '全局状态或会话fence尚未确认');
  } else if (request.action === 'user.password.reset') {
    if (!user.must_change_password || user.credential_version !== request.target_credential_version + 1)
      fail(409, 'RESET_NOT_PUBLISHED', '密码重置尚未完整确认');
  } else fail(422, 'RECOVERY_ACTION_INVALID', '不认识审批动作');
  const alive = await c.sessions.findOne({ user_id: targetId, revoked_at: null, $expr: { $gt: ['$expires_at', '$$NOW'] } }, { session });
  if (alive) fail(409, 'SESSIONS_NOT_REVOKED', '目标旧会话仍然有效');
}

async function assertOrdinaryActor(db: Db, operation: AdministrationOperation, session: ClientSession) {
  const c = collections(db), orgId = id(operation.desired.actorOrgId), memberId = id(operation.before.actorMemberId);
  const user = await c.users.findOne({ _id: operation.actor_id, status: 'active', credential_version: operation.before.actorCredentialVersion,
    ...privacyActive }, { session });
  const member = await c.members.findOne({ _id: memberId, user_id: operation.actor_id, org_id: orgId, status: 'active' }, { session });
  const org = await c.organizations.findOne({ _id: orgId, status: 'active' }, { session });
  if (!user || !member || !org || user.must_change_password) fail(409, 'ACTOR_CHANGED', '原操作者当前身份或凭据已变化');
  const roleIds = await currentManagementRoles(db, memberId, orgId, session);
  const action = operation.action, targetOrg = operation.targets.org_ids[0];
  let relevant: AdministrativeCapability[];
  if (action.startsWith('grant.')) relevant = ['platform:govern', 'authorization:delegate'];
  else if (action === 'member.add' || action === 'user.status') relevant = ['account:platform-manage'];
  else if (action === 'member.update' || action === 'user.create' || action === 'user.password.reset') relevant = ['account:platform-manage', 'account:manage'];
  else if (action.startsWith('invitation.')) relevant = ['account:platform-manage', 'account:manage', ...(action === 'invitation.revoke' ? ['platform:govern' as const] : [])];
  else fail(422, 'RECOVERY_ACTION_INVALID', '不认识普通管理操作');
  const targetGrant = action === 'grant.revoke' ? await db.collection<MemberCapabilityGrant>('member_capability_grants').findOne({
    _id: id(operation.desired.grant_id), member_id: id(operation.desired.member_id),
  }, { session }) : null;
  const delegatedCapability = action === 'grant.revoke' ? targetGrant?.capability : operation.desired.capability;
  const grants = await db.collection<AdministrativeGrant>('administrative_grants').find({ subject_member_id: memberId, actor_org_id: orgId,
    capability: { $in: relevant }, status: 'active', $expr: validAtDatabaseTime }, { session }).toArray();
  for (const grant of grants) {
    if (!grant.operation_id || !await db.collection<AdministrationOperation>('administration_operations').findOne({ _id: grant.operation_id, status: 'applied' }, { session })) continue;
    if (grant.capability === 'account:platform-manage' || grant.capability === 'platform:govern') {
      if (org.kind !== 'platform' || !roleIds.includes('platform_ops') ||
          grant.scope?.kind !== 'organization_ids' || !grant.scope.organization_ids.includes(orgId)) continue;
    } else if (!roleIds.includes('org_admin') || grant.scope?.kind !== 'organization_ids' || !grant.scope.organization_ids.includes(orgId)) continue;
    if (grant.capability === 'account:manage' && targetOrg !== orgId && action !== 'user.password.reset') continue;
    if (grant.capability === 'account:manage' && action === 'user.password.reset') {
      const owners = await c.members.find({ user_id: operation.targets.user_ids[0] }, { session }).limit(2).toArray();
      if (owners.length !== 1 || owners[0]!.org_id !== orgId) continue;
    }
    if (grant.capability === 'authorization:delegate' && (targetOrg !== orgId ||
      action === 'grant.revoke' && (!targetGrant || targetGrant.org_id !== orgId) ||
      action === 'grant.create' && (operation.desired.scope?.kind !== 'organization_ids' ||
        operation.desired.scope.organization_ids.length !== 1 || operation.desired.scope.organization_ids[0] !== orgId) ||
      !(DELEGABLE_CAPABILITIES as readonly string[]).includes(delegatedCapability) ||
      !Array.isArray(grant.delegate_capabilities) || !grant.delegate_capabilities.includes(delegatedCapability))) continue;
    return;
  }
  fail(409, 'ACTOR_CHANGED', '原操作者当前管理权限或组织范围已失效');
}

async function assertOrdinaryPublished(db: Db, operation: AdministrationOperation, session: ClientSession) {
  if (!await db.collection<AuditEvent>('audit_events').findOne({ operation_id: operation._id, action: operation.action }, { session }))
    fail(409, 'OPERATION_NOT_AUDITED', '操作审计尚未发布');
  const c = collections(db), p = operation.desired;
  if (operation.action.startsWith('invitation.')) {
    const invitation = await emailCollections(db).invitations.findOne({ _id: id(p.invitation_id), org_id: id(p.org_id) }, { session });
    if (!invitation || invitation.payload_hash !== permissionHash(invitation.payload)) fail(409, 'INVITATION_NOT_PUBLISHED', '邀请登记证据未确认');
    if (operation.action === 'invitation.create' && (invitation.operation_id !== operation._id ||
      invitation.email_key !== p.email_key || canonical(invitation.roles) !== canonical(p.roles) ||
      invitation.valid_to?.toISOString() !== (p.valid_to ?? undefined))) fail(409, 'INVITATION_NOT_PUBLISHED', '邀请内容与原操作不同');
    if (operation.action === 'invitation.revoke') await assertInvitationRevoked(db, invitation._id, session);
    return;
  }
  if (operation.action.startsWith('grant.')) {
    const grantId = id(p.grant_id);
    const grant = await db.collection<AdministrativeGrant>('administrative_grants').findOne({ _id: grantId }, { session }) ??
      await db.collection<MemberCapabilityGrant>('member_capability_grants').findOne({ _id: grantId }, { session });
    if (!grant) fail(409, 'GRANT_CHANGED', '目标授权不存在');
    if (operation.action === 'grant.create') assertGrantPublished(grant, p, operation._id);
    if (operation.action === 'grant.revoke' && (grant.status !== 'revoked' || grant.revision !== p.expected_revision + 1))
      fail(409, 'GRANT_NOT_REVOKED', '授权撤销状态未确认');
    return;
  }
  const targetId = operation.targets.user_ids[0];
  const user = await c.users.findOne({ _id: targetId, ...privacyActive }, { session });
  if (!user) fail(409, 'TARGET_CHANGED', '操作目标身份不存在');
  if (operation.action === 'user.create' || operation.action === 'member.add' || operation.action === 'member.update') {
    const member = await c.members.findOne({ _id: operation.targets.member_ids[0], user_id: targetId,
      org_id: id(p.org_id) }, { session });
    const expected = operation.action === 'member.update' ? p.expected_revision + 1 : 1;
    if (!member || member.authorization_revision !== expected ||
        member.status !== (operation.action === 'member.update' ? p.status : 'active'))
      fail(409, 'MEMBER_CHANGED', '成员关联状态与原操作不符');
    const rows = await c.memberRoles.find({ member_id: member._id }, { session }).toArray();
    if (canonical(rows.filter(r => r.status !== 'revoked').map(r => r.role_id).sort()) !==
      canonical(roles(p.roles, operation.action === 'member.update' && p.status === 'disabled')))
      fail(409, 'ROLE_CHANGED', '角色状态与原操作不符');
    if (operation.action === 'user.create' && (user.login_key !== p.login_name || user.status !== 'active' || !user.must_change_password))
      fail(409, 'USER_NOT_PUBLISHED', '创建账号尚未完成');
    return;
  }
  if (operation.action === 'user.status') {
    if (user.status !== p.status || user.credential_version !== operation.before.targetCredentialVersion + 1)
      fail(409, 'STATUS_CHANGED', '全局账号状态未确认');
  } else if (operation.action === 'user.password.reset') {
    if (!user.must_change_password || user.credential_version !== operation.before.targetCredentialVersion + 1)
      fail(409, 'PASSWORD_CHANGED', '密码重置状态未确认');
  } else fail(422, 'RECOVERY_ACTION_INVALID', '不认识普通账号动作');
  const alive = await c.sessions.findOne({ user_id: targetId, revoked_at: null, $expr: { $gt: ['$expires_at', '$$NOW'] } }, { session });
  if (alive) fail(409, 'SESSIONS_NOT_REVOKED', '旧会话尚未撤销');
}

async function recoverOrdinaryAdministrationOperation(input: {
  db: Db; client: MongoClient; operation_id: string; actor: string; reason: string; previous_recovery_token?: string;
  mode: 'forward' | 'invalidate' | 'release';
}, operation: AdministrationOperation) {
  const c = collections(input.db);
  if (input.mode === 'forward') {
    if (operation.status !== 'applied') fail(409, 'OPERATION_NEEDS_INVALIDATION', '未完成管理变更不得凭旧意图自动重放');
    return recoverAdministrationOperation({
      ...input, revalidate: async (row, session) => {
        await assertOrdinaryActor(input.db, row, session);
        await assertOrdinaryPublished(input.db, row, session);
      },
      finish: async () => null,
      verify: async (row, session) => { await assertOrdinaryPublished(input.db, row, session); },
    });
  }
  async function verifySafe(row: AdministrationOperation, session: ClientSession) {
    const audit = await input.db.collection<AuditEvent>('audit_events').findOne({ operation_id: row._id, action: 'administration.recovery.no_effect' }, { session });
    const p = row.desired;
    if (row.action.startsWith('invitation.')) {
      await assertInvitationRevoked(input.db, id(p.invitation_id), session);
      return;
    }
    if (row.action === 'grant.create') {
      const grant = await input.db.collection<AdministrativeGrant>('administrative_grants').findOne({ _id: id(p.grant_id) }, { session }) ??
        await input.db.collection<MemberCapabilityGrant>('member_capability_grants').findOne({ _id: id(p.grant_id) }, { session });
      if (grant && !unchangedPriorMemberGrant(grant, p, row._id) &&
          (grant.operation_id !== row._id || grant.status !== 'revoked'))
        fail(409, 'GRANT_NOT_REVOKED', '残留授权未安全撤销');
    } else if (row.action === 'grant.revoke' || audit) {
      // A previously-held grant remaining active is not an expansion; no-effect intent is externally auditable.
    } else {
      const user = await c.users.findOne({ _id: row.targets.user_ids[0], ...privacyActive }, { session });
      if (user && user.status !== 'disabled') fail(409, 'TARGET_NOT_ISOLATED', '账号仍然可用');
      if (user && await c.sessions.findOne({ user_id: user._id, revoked_at: null,
        $expr: { $gt: ['$expires_at', '$$NOW'] } }, { session })) fail(409, 'SESSIONS_NOT_REVOKED', '旧会话仍可用');
      if (row.targets.member_ids.length &&
          await c.members.findOne({ _id: row.targets.member_ids[0], status: 'active' }, { session }))
        fail(409, 'MEMBER_NOT_ISOLATED', '残留成员仍可用');
    }
  }
  if (input.mode === 'release') {
    if (!input.previous_recovery_token) fail(422, 'RECOVERY_TOKEN_REQUIRED', '释放隔离需要恢复令牌');
    return releaseInvalidatedAdministration({ ...input, previous_recovery_token: input.previous_recovery_token, verifySafe });
  }
  if (input.mode !== 'invalidate') fail(422, 'RECOVERY_MODE_INVALID', '恢复模式无效');
  return cancelAdministrationOperation({
    ...input,
    invalidate: async (row, session) => {
      const p = row.desired, now = new Date();
      if (row.action.startsWith('invitation.')) {
        await invalidateInvitation(input.db, id(p.invitation_id), session);
        return;
      }
      if (row.action === 'grant.create') {
        for (const name of ['administrative_grants', 'member_capability_grants']) {
          const grant = await input.db.collection<GrantRecord>(name).findOne({ _id: id(p.grant_id) }, { session });
          if (!grant) continue;
          if (grant.operation_id !== row._id) {
            if (unchangedPriorMemberGrant(grant, p, row._id)) continue;
            fail(409, 'GRANT_CHANGED', '授权归属不是原操作');
          }
          if (grant.status !== 'revoked') await input.db.collection<GrantRecord>(name).updateOne({ _id: grant._id, status: grant.status },
            { $set: { status: 'revoked', updated_at: now }, $inc: { revision: 1 } }, { session });
        }
      } else if (row.step === 'intent') {
        await input.db.collection<AuditEvent>('audit_events').insertOne({ _id: newId(), actor_id: input.actor, org_id: null,
          action: 'administration.recovery.no_effect', resource_id: row._id, reason: input.reason,
          request_id: randomUUID(), operation_id: row._id, created_at: now }, { session });
      } else if (row.action !== 'grant.revoke') {
        const user = await c.users.findOne({ _id: row.targets.user_ids[0], ...privacyActive }, { session });
        if (user) {
          const members = await c.members.find({ user_id: user._id }, { session }).toArray();
          if (await input.db.collection<AdministrativeGrant>('administrative_grants').findOne({ subject_member_id: { $in: members.map(m => m._id) },
            capability: 'platform:govern', status: 'active' }, { session }))
            fail(409, 'LAST_GOVERNOR_RISK', '治理账号不可自动禁用，继续隔离待人工核对');
          if (row.targets.member_ids.length) await c.members.updateOne({ _id: row.targets.member_ids[0], user_id: user._id },
            { $set: { status: 'disabled', updated_at: now }, $inc: { authorization_revision: 1 } }, { session });
          await c.users.updateOne({ _id: user._id, ...privacyActive }, { $set: { status: 'disabled', updated_at: now },
            $inc: { identity_revision: 1, credential_version: 1 } }, { session });
          await c.sessions.updateMany({ user_id: user._id, revoked_at: null }, { $set: { revoked_at: now } }, { session });
        }
      }
    },
    verifySafe,
  });
}

async function recoverApprovalRegistration(input: {
  db: Db; client: MongoClient; operation_id: string; actor: string; reason: string; previous_recovery_token?: string;
  mode: 'forward' | 'invalidate' | 'release';
}, operation: AdministrationOperation) {
  const requests = input.db.collection<Approval>('authorization_requests');
  const requestId = operation.action === 'approval.reject' ? id(operation.desired.approval_id) : null;
  async function affectedRequest(session: ClientSession) {
    return requestId ? requests.findOne({ _id: requestId }, { session }) :
      requests.findOne({ operation_id: operation._id }, { session });
  }
  async function verifySafe(_row: AdministrationOperation, session: ClientSession) {
    const request = await affectedRequest(session);
    if (request && request.status !== 'rejected') fail(409, 'APPROVAL_NOT_INVALIDATED', '申请仍可继续审批');
  }
  if (input.mode === 'forward') {
    if (operation.status !== 'applied') fail(409, 'APPROVAL_NEEDS_INVALIDATION', '申请/拒绝未完整发布，不可重放');
    return recoverAdministrationOperation({
      ...input,
      revalidate: async (row, session) => {
        const request = await affectedRequest(session);
        if (!request || !await input.db.collection<AuditEvent>('audit_events').findOne({ operation_id: row._id, action: row.action }, { session }))
          fail(409, 'APPROVAL_NOT_AUDITED', '申请或拒绝未审计发布');
        if (row.action.startsWith('approval.request.')) {
          if (request.payload_hash !== permissionHash(request.payload) || request.status !== 'pending' ||
              request.requester_user_id !== row.actor_id || canonical(request.payload) !== canonical(row.desired.payload))
            fail(409, 'APPROVAL_CHANGED', '申请内容和当前操作不一致');
          await assertRequesterCurrent(input.db, request, session);
        } else if (request.status !== 'rejected' || request.approver_user_id !== row.actor_id) {
          fail(409, 'APPROVAL_CHANGED', '拒绝决定和当前操作不一致');
        } else await assertApproverCurrent(input.db, request, session);
      },
      finish: async () => null,
      verify: async (row, session) => {
        if (!await input.db.collection<AuditEvent>('audit_events').findOne({ operation_id: row._id, action: row.action }, { session }))
          fail(409, 'APPROVAL_NOT_AUDITED', '决定审计不存在');
      },
    });
  }
  if (input.mode === 'release') {
    if (!input.previous_recovery_token) fail(422, 'RECOVERY_TOKEN_REQUIRED', '释放隔离需要恢复令牌');
    return releaseInvalidatedAdministration({ ...input, previous_recovery_token: input.previous_recovery_token, verifySafe });
  }
  if (input.mode !== 'invalidate') fail(422, 'RECOVERY_MODE_INVALID', '恢复模式无效');
  return cancelAdministrationOperation({
    ...input,
    invalidate: async (_row, session) => {
      const request = await affectedRequest(session);
      if (!request) return;
      if (request.status === 'applied' || request.status === 'applying')
        fail(409, 'APPROVAL_ALREADY_APPLYING', '申请已进入扩权应用，请改用批准操作号处理');
      if (request.status !== 'rejected') await requests.updateOne({ _id: request._id, status: request.status },
        { $set: { status: 'rejected', updated_at: new Date() }, $inc: { revision: 1 } }, { session });
    },
    verifySafe,
  });
}

export async function recoverApprovedAdministrationOperation(input: {
  db: Db; client: MongoClient; operation_id: string; actor: string; reason: string;
  previous_recovery_token?: string; mode: 'forward' | 'invalidate' | 'release';
}) {
  const operationId = id(input.operation_id);
  const operation = await input.db.collection<AdministrationOperation>('administration_operations').findOne({ _id: operationId });
  if (!operation) fail(404, 'NOT_FOUND', '恢复目标操作不存在');
  if ((operation.action.startsWith('approval.request.') || operation.action === 'approval.reject') &&
      typeof operation.desired.actorOrgId === 'string')
    return recoverApprovalRegistration(input, operation);
  if (['user.create', 'member.add', 'member.update', 'user.status', 'user.password.reset', 'grant.create', 'grant.revoke', 'invitation.create', 'invitation.revoke'].includes(operation.action) &&
      typeof operation.desired.actorOrgId === 'string')
    return recoverOrdinaryAdministrationOperation(input, operation);
  const request = await recoveryApproval(input.db, operation);
  if (input.mode === 'forward') {
    // No stale approval, password or partial write is ever replayed. Only an already-published receipt may shed a stranded guard.
    if (operation.status !== 'applied') fail(409, 'APPROVAL_NEEDS_INVALIDATION', '未完成扩权需先失效旧批，重新独立审批');
    return recoverAdministrationOperation({
      ...input, revalidate: async (row, session) => {
        await assertRequesterCurrent(input.db, request, session);
        await assertApproverCurrent(input.db, request, session);
        await assertApprovedResult(input.db, row, request, session);
      },
      finish: async () => null,
      verify: async (row, session) => { await assertApprovedResult(input.db, row, request, session); },
    });
  }
  async function verifyInvalidated(row: AdministrationOperation, session: ClientSession) {
    const evidence = await recoveryApproval(input.db, row, session);
    if (evidence.status !== 'rejected') fail(409, 'APPROVAL_NOT_INVALIDATED', '旧批准尚未失效');
    if (evidence.action === 'invitation.create') {
      await assertInvitationRevoked(input.db, id(evidence.payload.invitation_id), session);
      return;
    }
    if (evidence.action === 'grant.create') {
      const grantId = id(evidence.payload.grant_id);
      const grant = await input.db.collection<AdministrativeGrant>('administrative_grants').findOne({ _id: grantId }, { session }) ??
        await input.db.collection<MemberCapabilityGrant>('member_capability_grants').findOne({ _id: grantId }, { session });
      if (grant && !unchangedPriorMemberGrant(grant, evidence.payload, row._id) &&
          (grant.operation_id !== row._id || grant.status !== 'revoked'))
        fail(409, 'GRANT_NOT_REVOKED', '残留授权未被安全撤销');
    } else if (evidence.approver_user_id !== null) {
      const c = collections(input.db);
      const user = await c.users.findOne({ _id: evidence.beneficiary_user_id, ...privacyActive }, { session });
      if (user?.status !== 'disabled' && (evidence.action !== 'user.create' || user)) fail(409, 'TARGET_NOT_ISOLATED', '目标身份仍可使用旧批准');
      if (user && await c.sessions.findOne({ user_id: user._id, revoked_at: null,
        $expr: { $gt: ['$expires_at', '$$NOW'] } }, { session })) fail(409, 'SESSIONS_NOT_REVOKED', '目标旧会话仍然有效');
      if (evidence.subject_member_id && await c.members.findOne({ _id: evidence.subject_member_id, status: 'active' }, { session }))
        fail(409, 'MEMBER_NOT_ISOLATED', '目标成员仍处于可用状态');
      if (evidence.subject_member_id && await c.memberRoles.findOne({ member_id: evidence.subject_member_id,
        role_id: 'content_reviewer', operation_id: row._id, status: 'active' }, { session }))
        fail(409, 'REVIEWER_NOT_REVOKED', '旧审核角色仍可在以后恢复');
    }
  }
  if (input.mode === 'release') {
    if (!input.previous_recovery_token) fail(422, 'RECOVERY_TOKEN_REQUIRED', '释放隔离需要最新恢复令牌');
    return releaseInvalidatedAdministration({
      ...input, previous_recovery_token: input.previous_recovery_token,
      verifySafe: verifyInvalidated,
    });
  }
  if (input.mode !== 'invalidate') fail(422, 'RECOVERY_MODE_INVALID', '恢复模式无效');
  return cancelAdministrationOperation({
    ...input,
    invalidate: async (row, session) => {
      const evidence = await recoveryApproval(input.db, row, session);
      const c = collections(input.db), now = new Date();
      if (evidence.action === 'invitation.create') {
        await invalidateInvitation(input.db, id(evidence.payload.invitation_id), session);
      } else if (evidence.action === 'grant.create') {
        const grantId = id(evidence.payload.grant_id);
        for (const name of ['administrative_grants', 'member_capability_grants']) {
          const grant = await input.db.collection<GrantRecord>(name).findOne({ _id: grantId }, { session });
          if (!grant) continue;
          if (grant.operation_id !== row._id) {
            if (unchangedPriorMemberGrant(grant, evidence.payload, row._id)) continue;
            fail(409, 'GRANT_CHANGED', '残留授权归属不是原操作');
          }
          if (grant.status !== 'revoked') await input.db.collection<GrantRecord>(name).updateOne({ _id: grantId, status: grant.status },
            { $set: { status: 'revoked', updated_at: now }, $inc: { revision: 1 } }, { session });
        }
      } else if (row.step !== 'intent') {
        const user = await c.users.findOne({ _id: evidence.beneficiary_user_id, ...privacyActive }, { session });
        if (user) {
          if (await input.db.collection<AdministrativeGrant>('administrative_grants').findOne({ subject_member_id: { $in: (await c.members.find({ user_id: user._id }, { session }).toArray()).map(m => m._id) },
              capability: 'platform:govern', status: 'active' }, { session }))
            fail(409, 'LAST_GOVERNOR_RISK', '治理主体不得自动禁用，需人工核对并保留隔离');
          if (evidence.subject_member_id) {
            await c.members.updateOne({ _id: evidence.subject_member_id, user_id: user._id },
              { $set: { status: 'disabled', updated_at: now }, $inc: { authorization_revision: 1 } }, { session });
            await c.memberRoles.updateMany({ member_id: evidence.subject_member_id, operation_id: row._id, role_id: 'content_reviewer',
              status: 'active' }, { $set: { status: 'revoked' } }, { session });
            await c.memberRoles.deleteMany({ member_id: evidence.subject_member_id, role_id: 'platform_ops' }, { session });
          }
          await c.users.updateOne({ _id: user._id, ...privacyActive }, { $set: { status: 'disabled', updated_at: now },
            $inc: { identity_revision: 1, credential_version: 1 } }, { session });
          await c.sessions.updateMany({ user_id: user._id, revoked_at: null }, { $set: { revoked_at: now } }, { session });
        }
      }
      const changed = await input.db.collection<AuthorizationRequest>('authorization_requests').updateOne({ _id: evidence._id, status: { $in: ['pending', 'approved', 'applying', 'needs_recovery', 'applied'] } },
        { $set: { status: 'rejected', updated_at: now }, $inc: { revision: 1 } }, { session });
      if (!changed.matchedCount) fail(409, 'APPROVAL_CHANGED', '申请无法安全失效');
    },
    verifySafe: verifyInvalidated,
  });
}

async function assertInvitationRevoked(db: Db, invitationId: string, session: ClientSession) {
  const invitation = await emailCollections(db).invitations.findOne({ _id: invitationId }, { session });
  if (invitation && invitation.state !== 'revoked') fail(409, 'INVITATION_NOT_REVOKED', '邀请未安全撤销');
  if (await emailCollections(db).challenges.findOne({ invitation_id: invitationId, status: 'pending' }, { session, projection: { _id: 1 } }) ||
    await db.collection('auth_mail_outbox').findOne({ invitation_id: invitationId, $or: [{ status: { $in: ['pending', 'sending'] } }, { encrypted_payload: { $ne: null } }, { lease_token: { $ne: null } }] }, { session, projection: { _id: 1 } }))
    fail(409, 'INVITATION_NOT_REVOKED', '邀请挑战或邮件密文仍然有效');
}

async function invalidateInvitation(db: Db, invitationId: string, session: ClientSession) {
  const invitation = await emailCollections(db).invitations.findOne({ _id: invitationId }, { session });
  if (invitation?.state === 'accepted') fail(409, 'INVITATION_ALREADY_ACCEPTED', '邀请已被接受，成员变更须另走当前授权流程');
  if (invitation && invitation.state !== 'revoked') {
    const changed = await emailCollections(db).invitations.updateOne({ _id: invitationId, state: invitation.state, revision: invitation.revision },
      { $set: { state: 'revoked', updated_at: new Date() }, $inc: { revision: 1 } }, { session });
    if (changed.modifiedCount !== 1) fail(409, 'INVITATION_CHANGED', '邀请已变化');
  }
  await revokeEmailChallenges(db, session, { invitation_id: invitationId });
  await db.collection('auth_mail_outbox').updateMany({ invitation_id: invitationId },
    { $set: { status: 'cancelled', encrypted_payload: null, lease_token: null, lease_until: null, safe_error_code: 'INVITATION_REVOKED', updated_at: new Date() } }, { session });
}
