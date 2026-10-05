import { newId } from "../database/object-id";
import { randomUUID } from "node:crypto";
import { MongoClient, type Db, type ClientSession, type Filter, type Document } from "mongodb";
import {
  collections,
  normalizeLogin,
  validLogin,
  ROLE_CAPABILITIES,
  CONTROLLED_CAPABILITIES,
  type ControlledCapability,
  type AdministrationGuard,
  type AuditEvent,
  type Member,
  type MemberRole,
  type MemberCapabilityGrant,
  type AdministrationTargets,
  type AdministrativeGrant,
  type RoleCode,
  type Organization,
  type User,
} from "../database/contracts";
import { hashPassword, temporaryPassword } from "../security/password";

import { assertSchema } from "../migrations/schema";
import { assertOperationalAccess } from "../operations/control";
import { executeAdministrationOperation, inspectAdministrationOperations, recoverAdministrationOperation,
  voidAdministrationOperation, cancelAdministrationOperation, releaseInvalidatedAdministration,
  type OperationAudit } from "../administration/operations";
import { MEMBER_CAPABILITY_CATALOG, scopeFingerprint } from "../administration/catalog";
import { assertRetainsGovernance } from "../administration/authorization";
import { recoverApprovedAdministrationOperation } from "../administration/administration.service";

const privacyActive: Filter<User> = {
  $or: [{ privacy_state: "active" }, { privacy_state: { $exists: false } }],
};
export interface OperationContext {
  client: MongoClient;
  db: Db;
  actor: string;
  reason: string;
  temporaryPasswordMs?: number;
}
export class AdminError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function reject(message: string): never {
  throw new AdminError("INVALID_OPERATION", message);
}
function bounded(value: string, label: string, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    reject(`${label}不合法`);
  return value.trim();
}
function id(value: string): string {
  const result = bounded(value, "标识", 24);
  if (!/^[0-9a-f]{24}$/.test(result)) reject("标识须为24位ObjectId");
  return result;
}
async function transact<T>(
  ctx: OperationContext,
  action: string,
  targets: Partial<AdministrationTargets>,
  desired: Document,
  work: (session: ClientSession, now: Date, operationId: string) =>
    Promise<{ result: T; resource: string; org?: string; evidence?: Record<string, unknown> }>,
  before: Document = {},
): Promise<T> {
  await assertOperationalAccess(ctx.db);
  await assertSchema(ctx.db);
  bounded(ctx.actor, "操作者", 128);
  bounded(ctx.reason, "原因", 512);
  const initial: Document = Object.keys(before).length ? before : await (async () => {
    if (targets.global) return { global: true,
      users_count: await ctx.db.collection("users").countDocuments({}),
      members_count: await ctx.db.collection("organization_members").countDocuments({}) };
    const memberFilter: Filter<Member>[] = [];
    if (targets.member_ids?.length) memberFilter.push({ _id: { $in: targets.member_ids } });
    if (targets.user_ids?.length) memberFilter.push({ user_id: { $in: targets.user_ids } });
    const [users, members, organizations] = await Promise.all([
      ctx.db.collection<User>("users").find({ _id: { $in: targets.user_ids ?? [] } },
        { projection: { _id: 1, status: 1, identity_revision: 1, credential_version: 1, privacy_state: 1 } }).toArray(),
      memberFilter.length ? ctx.db.collection<Member>("organization_members").find({ $or: memberFilter },
        { projection: { _id: 1, org_id: 1, user_id: 1, status: 1, authorization_revision: 1 } }).toArray() : Promise.resolve([]),
      ctx.db.collection<Organization>("organizations").find({ _id: { $in: targets.org_ids ?? [] } },
        { projection: { _id: 1, kind: 1, status: 1 } }).toArray(),
    ]);
    const memberIds = members.map(member => member._id);
    const [roles, grants] = await Promise.all([
      ctx.db.collection<MemberRole>("member_roles").find({ member_id: { $in: memberIds } },
        { projection: { _id: 1, member_id: 1, role_id: 1, status: 1, valid_from: 1, valid_to: 1, operation_id: 1, approval_id: 1, authority: 1 } }).toArray(),
      ctx.db.collection<MemberCapabilityGrant>("member_capability_grants").find({ member_id: { $in: memberIds } },
        { projection: { _id: 1, member_id: 1, capability: 1, status: 1, revision: 1, valid_to: 1, operation_id: 1 } }).toArray(),
    ]);
    return { users, members, organizations, roles, grants };
  })();
  let completed: { resource: string; org?: string; evidence?: Record<string, unknown> } | undefined;
  const receipt = await executeAdministrationOperation({
    client: ctx.client, db: ctx.db, actor: ctx.actor.trim(), reason: ctx.reason.trim(),
    action, targets, payload: desired, before: initial,
    audit: { org_id: targets.org_ids?.[0] ?? null,
      resource_id: targets.member_ids?.[0] ?? targets.user_ids?.[0] ?? targets.org_ids?.[0] ?? "auth" },
    auditResult: () => ({
      resource_id: completed!.resource, org_id: completed!.org ?? null,
      ...(completed!.evidence as Partial<OperationAudit> | undefined),
    }),
    apply: async ({ session, now, operation_id }) => {
      await assertOperationalAccess(ctx.db);
      for (const prior of initial.users ?? []) {
        const current = await ctx.db.collection<User>("users").findOne({ _id: prior._id },
          { session, projection: { identity_revision: 1, credential_version: 1 } });
        if (!current || current.identity_revision !== prior.identity_revision ||
            current.credential_version !== prior.credential_version)
          reject("目标身份在受理操作前已变化，须重新核对版本");
      }
      const response = await work(session, now, operation_id);
      completed = response;
      return response.result;
    },
  });
  if (receipt.result === null) reject("CLI操作不应重放，必须独立inspect后人工恢复");
  return receipt.result;
}
function expiry(ctx: OperationContext, now: Date): Date {
  const duration = ctx.temporaryPasswordMs ?? 86400000;
  if (
    !Number.isSafeInteger(duration) ||
    duration < 1000 ||
    duration > 604800000
  )
    reject("临时密码有效期不合法");
  return new Date(now.getTime() + duration);
}
export async function createOrganization(
  ctx: OperationContext,
  input: { name: string; kind: Organization["kind"] },
): Promise<{ organization_id: string }> {
  const name = bounded(input.name, "组织名称", 120);
  if (!["school", "personal", "platform"].includes(input.kind))
    reject("组织类型不合法");
  const organization_id = newId();
  return transact(ctx, "organization.create", { org_ids: [organization_id] },
    { organization_id, name, kind: input.kind, status: "active" }, async (session, now) => {
    await collections(ctx.db).organizations.insertOne(
      {
        _id: organization_id,
        name,
        kind: input.kind,
        status: "active",
        created_at: now,
        updated_at: now,
      },
      { session },
    );
    return {
      result: { organization_id },
      resource: organization_id,
      org: organization_id,
    };
  });
}
export async function createUser(
  ctx: OperationContext,
  input: { login_name: string; display_name: string },
): Promise<{ user_id: string; secret: string }> {
  if (typeof input.login_name !== "string" || !validLogin(input.login_name))
    reject("登录名须为3至64位字母、数字、下划线或连字符");
  const display_name = bounded(input.display_name, "显示名称", 100);
  const secret = temporaryPassword();
  const password_hash = await hashPassword(secret);
  const user_id = newId();
  return transact(ctx, "user.create", { user_ids: [user_id] },
    { user_id, login_key: normalizeLogin(input.login_name), display_name, status: "active", credential_version: 1 },
    async (session, now) => {
    await collections(ctx.db).users.insertOne(
      {
        _id: user_id,
        login_key: normalizeLogin(input.login_name),
        display_name,
        status: "disabled",
        privacy_state: "active",
        password_hash,
        credential_version: 1,
        identity_revision: 1,
        must_change_password: true,
        temporary_password_expires_at: expiry(ctx, now),
        password_changed_at: now,
        created_at: now,
        updated_at: now,
      },
      { session },
    );
    const enabled = await collections(ctx.db).users.updateOne({ _id: user_id, status: "disabled" },
      { $set: { status: "active", updated_at: now } }, { session });
    if (enabled.matchedCount !== 1) reject("创建账号后无法启用，保持隔离");
    return { result: { user_id, secret }, resource: user_id };
  });
}
export async function setMembership(
  ctx: OperationContext,
  input: {
    user_id: string;
    org_id: string;
    roles: RoleCode[];
    status?: "active" | "disabled";
    expected_revision?: number;
    reviewer_valid_to?: Date;
  },
): Promise<{ member_id: string; authorization_revision: number }> {
  id(input.user_id);
  id(input.org_id);
  const status = input.status ?? "active";
  if (
    !["active", "disabled"].includes(status) ||
    !Array.isArray(input.roles) ||
    input.roles.length > 5 ||
    new Set(input.roles).size !== input.roles.length ||
    input.roles.some((role) => !Object.hasOwn(ROLE_CAPABILITIES, role))
  )
    reject("成员状态或角色不合法");
  if (status === "active" && input.roles.length === 0)
    reject("启用成员必须显式指定角色");
  if (
    input.expected_revision !== undefined &&
    (!Number.isSafeInteger(input.expected_revision) ||
      input.expected_revision < 1)
  )
    reject("成员版本不合法");
  if (input.roles.includes("content_reviewer") &&
      (!(input.reviewer_valid_to instanceof Date) || !Number.isFinite(input.reviewer_valid_to.getTime())))
    reject("新content_reviewer角色须明确 --valid-to");
  if (!input.roles.includes("content_reviewer") && input.reviewer_valid_to !== undefined)
    reject("仅content_reviewer角色可使用 --valid-to");
  return transact(ctx, "membership.set", { user_ids: [input.user_id], org_ids: [input.org_id] },
    { user_id: input.user_id, org_id: input.org_id, roles: input.roles, status,
      reviewer_valid_to: input.reviewer_valid_to?.toISOString() ?? null, expected_revision: input.expected_revision ?? null },
    async (session, now, operationId) => {
    const c = collections(ctx.db);
    const org = await c.organizations.findOne(
      { _id: input.org_id },
      { session },
    );
    const user = await c.users.findOne({ _id: input.user_id, ...privacyActive }, { session });
    if (
      !org ||
      !user ||
      (status === "active" &&
        (org.status !== "active" || user.status !== "active"))
    )
      reject("组织或用户不存在或已禁用");
    if (input.reviewer_valid_to && input.reviewer_valid_to <= now)
      reject("content_reviewer角色期限必须晚于数据库当前时间");
    if (input.roles.includes("platform_ops") && org.kind !== "platform")
      reject("平台运维角色只能授予平台组织成员");
    if (
      (await c.roles.countDocuments(
        { _id: { $in: input.roles } },
        { session },
      )) !== input.roles.length
    )
      reject("角色目录未初始化");
    const member = await c.members.findOne(
      { user_id: input.user_id, org_id: input.org_id },
      { session },
    );
    if (member && member.authorization_revision !== input.expected_revision)
      throw new AdminError("REVISION_CONFLICT", "变更现有成员必须提供当前版本");
    if (!member && input.expected_revision !== undefined) reject("成员不存在");
    if (member) await assertRetainsGovernance(ctx.db, now, session, { member_id: member._id });
    const member_id = member?._id ?? newId();
    const authorization_revision = (member?.authorization_revision ?? 0) + 1;
    if (member)
      await c.members.updateOne(
        { _id: member_id },
        { $set: { status, authorization_revision, updated_at: now } },
        { session },
      );
    else
      await c.members.insertOne(
        {
          _id: member_id,
          org_id: input.org_id,
          user_id: input.user_id,
          status,
          authorization_revision,
          created_at: now,
          updated_at: now,
        },
        { session },
      );
    await c.memberRoles.deleteMany({ member_id }, { session });
    // Changing membership never silently retains privileged exception grants.
    await ctx.db.collection("member_capability_grants").updateMany({ org_id: input.org_id, member_id, status: "active" },
      { $set: { status: "revoked", updated_at: now }, $inc: { revision: 1 } }, { session });
    await ctx.db.collection<AdministrativeGrant>("administrative_grants").updateMany(
      { subject_member_id: member_id, status: "active" },
      { $set: { status: "revoked", updated_at: now }, $inc: { revision: 1 } }, { session });
    if (input.roles.length)
      await c.memberRoles.insertMany(
        input.roles.map((role_id) => ({
          _id: newId(),
          member_id,
          org_id: input.org_id,
          role_id,
          ...(role_id === "content_reviewer" ? { status: "active" as const,
            valid_from: now, valid_to: input.reviewer_valid_to!, operation_id: operationId,
            approval_id: null, authority: "cli" as const } : {}),
        })),
        { session },
      );
    const userFence = await c.users.updateOne(
      { _id: input.user_id, ...privacyActive },
      { $inc: { identity_revision: 1 }, $set: { updated_at: now } },
      { session },
    );
    if (userFence.matchedCount !== 1) reject("用户不存在或隐私删除已生效");
    await c.organizations.updateOne(
      { _id: input.org_id },
      { $set: { updated_at: now } },
      { session },
    );
    return {
      result: { member_id, authorization_revision },
      resource: member_id,
      org: input.org_id,
    };
  });
}
export async function setUserStatus(
  ctx: OperationContext,
  input: { user_id: string; status: "active" | "disabled" },
): Promise<{ user_id: string }> {
  id(input.user_id);
  if (!["active", "disabled"].includes(input.status)) reject("用户状态不合法");
  return transact(ctx, "user.status", { user_ids: [input.user_id] },
    { user_id: input.user_id, status: input.status }, async (session, now) => {
    const c = collections(ctx.db);
    const user = await c.users.findOne({ _id: input.user_id, ...privacyActive }, { session });
    if (!user) reject("用户不存在或隐私删除已生效");
    if (input.status === "disabled")
      await assertRetainsGovernance(ctx.db, now, session, { user_id: input.user_id });
    if (
      input.status === "active" &&
      user.must_change_password &&
      (!user.temporary_password_expires_at ||
        user.temporary_password_expires_at <= now)
    )
      reject("必须先重置有效的临时密码");
    const changed = await c.users.updateOne(
      { _id: input.user_id, ...privacyActive },
      {
        $set: { status: input.status, updated_at: now },
        $inc: { identity_revision: 1, credential_version: 1 },
      },
      { session },
    );
    if (changed.matchedCount !== 1) reject("用户不存在或隐私删除已生效");
    await c.sessions.updateMany(
      { user_id: input.user_id, revoked_at: null },
      { $set: { revoked_at: now } },
      { session },
    );
    return { result: { user_id: input.user_id }, resource: input.user_id };
  });
}
export async function resetPassword(
  ctx: OperationContext,
  input: { user_id: string },
): Promise<{ user_id: string; secret: string }> {
  id(input.user_id);
  const secret = temporaryPassword();
  const password_hash = await hashPassword(secret);
  return transact(ctx, "user.password.reset", { user_ids: [input.user_id] },
    { user_id: input.user_id, action: "reset_and_revoke_sessions" }, async (session, now) => {
    const c = collections(ctx.db);
    const changed = await c.users.updateOne(
      { _id: input.user_id, ...privacyActive },
      {
        $set: {
          password_hash,
          must_change_password: true,
          temporary_password_expires_at: expiry(ctx, now),
          password_changed_at: now,
          updated_at: now,
        },
        $inc: { credential_version: 1, identity_revision: 1 },
      },
      { session },
    );
    if (!changed.matchedCount) reject("用户不存在或隐私删除已生效");
    await c.sessions.updateMany(
      { user_id: input.user_id, revoked_at: null },
      { $set: { revoked_at: now } },
      { session },
    );
    return {
      result: { user_id: input.user_id, secret },
      resource: input.user_id,
    };
  });
}
export async function setOrganizationStatus(
  ctx: OperationContext,
  input: { org_id: string; status: "active" | "disabled" },
): Promise<{ organization_id: string }> {
  id(input.org_id);
  if (!["active", "disabled"].includes(input.status)) reject("组织状态不合法");
  return transact(ctx, "organization.status", { org_ids: [input.org_id] },
    { org_id: input.org_id, status: input.status }, async (session, now) => {
    const c = collections(ctx.db);
    if (input.status === "disabled")
      await assertRetainsGovernance(ctx.db, now, session, { org_id: input.org_id });
    const changed = await c.organizations.updateOne(
      { _id: input.org_id },
      { $set: { status: input.status, updated_at: now } },
      { session },
    );
    if (!changed.matchedCount) reject("组织不存在");
    if (input.status === "disabled")
      await c.members.updateMany(
        { org_id: input.org_id },
        {
          $set: { status: "disabled", updated_at: now },
          $inc: { authorization_revision: 1 },
        },
        { session },
      );
    return {
      result: { organization_id: input.org_id },
      resource: input.org_id,
      org: input.org_id,
    };
  });
}
export async function lockRestoredAuth(
  ctx: OperationContext,
  input: { confirmation: string },
): Promise<{ users_locked: number; members_locked: number }> {
  if (input.confirmation !== "LOCK_RESTORED_AUTH")
    reject("必须显式确认 LOCK_RESTORED_AUTH");
  return transact(ctx, "auth.restore.lock", { global: true },
    { action: "lock_all_users_members_and_sessions" }, async (session, now) => {
    const c = collections(ctx.db);
    const users = await c.users.updateMany(
      {},
      {
        $set: {
          status: "disabled",
          must_change_password: true,
          temporary_password_expires_at: new Date(0),
          updated_at: now,
        },
        $inc: { credential_version: 1, identity_revision: 1 },
      },
      { session },
    );
    const members = await c.members.updateMany(
      {},
      {
        $set: { status: "disabled", updated_at: now },
        $inc: { authorization_revision: 1 },
      },
      { session },
    );
    await c.memberRoles.deleteMany({}, { session });
    await ctx.db.collection("member_capability_grants").updateMany({ status: { $ne: "revoked" } },
      { $set: { status: "revoked", updated_at: now }, $inc: { revision: 1 } }, { session });
    await ctx.db.collection("administrative_grants").updateMany({ status: { $ne: "revoked" } },
      { $set: { status: "revoked", updated_at: now }, $inc: { revision: 1 } }, { session });
    await ctx.db.collection("authorization_requests").updateMany({ status: { $in: ["pending", "approved", "applying", "needs_recovery"] } },
      { $set: { status: "rejected", updated_at: now }, $inc: { revision: 1 } }, { session });
    await c.sessions.updateMany(
      { revoked_at: null },
      { $set: { revoked_at: now } },
      { session },
    );
    return {
      result: {
        users_locked: users.modifiedCount,
        members_locked: members.modifiedCount,
      },
      resource: "auth",
    };
  });
}

/** Database-operator command, not an HTTP capability escalation endpoint. */
export async function setCapability(ctx: OperationContext, input: {
  member_id: string; org_id: string; capability: ControlledCapability; granted: boolean; expected_revision: number; valid_to?: Date;
}): Promise<{ member_id: string; authorization_revision: number }> {
  id(input.member_id); id(input.org_id);
  if (!CONTROLLED_CAPABILITIES.includes(input.capability) || typeof input.granted !== "boolean" ||
      !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1) reject("能力或成员版本不合法");
  if (input.granted && MEMBER_CAPABILITY_CATALOG[input.capability].sensitivity === "sensitive" &&
      (!(input.valid_to instanceof Date) || !Number.isFinite(input.valid_to.getTime())))
    reject("敏感授权必须指定明确 --valid-to 到期时间");
  return transact(ctx, `capability.${input.granted ? "grant" : "revoke"}.${input.capability}`,
    { member_ids: [input.member_id], org_ids: [input.org_id] },
    { member_id: input.member_id, org_id: input.org_id, capability: input.capability,
      granted: input.granted, valid_to: input.valid_to?.toISOString() ?? null, expected_revision: input.expected_revision },
    async (session, now, operationId) => {
    const c = collections(ctx.db);
    const member = await c.members.findOne({ _id: input.member_id, org_id: input.org_id }, { session });
    if (!member) reject("成员不存在");
    if (input.granted && (member.status !== "active" ||
      !await c.users.findOne({ _id: member.user_id, status: "active", ...privacyActive }, { session }) ||
      !await c.organizations.findOne({ _id: input.org_id, status: "active" }, { session }))) reject("仅可向有效组织成员授予能力");
    const result = await c.members.updateOne({ _id: member._id, org_id: input.org_id, authorization_revision: input.expected_revision },
      { $inc: { authorization_revision: 1 }, $set: { updated_at: now } }, { session });
    if (result.matchedCount !== 1) throw new AdminError("REVISION_CONFLICT", "成员权限已变化");
    const grants = ctx.db.collection<MemberCapabilityGrant>("member_capability_grants");
    const key = { org_id: input.org_id, member_id: input.member_id, capability: input.capability };
    if (input.granted) {
      if (input.valid_to && input.valid_to <= now) reject("授权期限必须晚于数据库当前时间");
      const existing = await grants.findOne(key, { session });
      if (existing) {
        const result = await grants.updateOne({ _id: existing._id, revision: existing.revision },
          { $set: { status: "active", valid_from: now, valid_to: input.valid_to ?? null,
            operation_id: operationId, authority: "cli", updated_at: now }, $inc: { revision: 1 } }, { session });
        if (result.matchedCount !== 1) reject("授权版本发生变化");
      } else await grants.insertOne({ ...key, _id: newId(), status: "active", revision: 1,
        valid_from: now, valid_to: input.valid_to ?? null, operation_id: operationId,
        authority: "cli", created_at: now, updated_at: now }, { session });
    } else await grants.updateOne({ ...key, status: "active" },
      { $set: { status: "revoked", updated_at: now }, $inc: { revision: 1 } }, { session });
    const userFence = await c.users.updateOne({ _id: member.user_id, ...privacyActive }, { $inc: { identity_revision: 1 }, $set: { updated_at: now } }, { session });
    if (userFence.matchedCount !== 1) reject("用户不存在或隐私删除已生效");
    return { result: { member_id: member._id, authorization_revision: input.expected_revision + 1 }, resource: member._id, org: input.org_id,
      evidence: { resource_type: "member", owner_type: null, owner_version_id: null, revision_before: null, revision_after: null,
        access_revision_before: input.expected_revision, access_revision_after: input.expected_revision + 1 } };
  });
}

/** Exactly the first two independent governance users can be initialized by CLI. */
export async function bootstrapGovernance(ctx: OperationContext, input: {
  user_id: string; org_id: string; expected_revision: number;
}): Promise<{ member_id: string; grant_id: string }> {
  id(input.user_id); id(input.org_id);
  if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1) reject("成员版本不合法");
  return transact(ctx, "governance.bootstrap", { user_ids: [input.user_id], org_ids: [input.org_id] },
    { user_id: input.user_id, org_id: input.org_id, expected_revision: input.expected_revision, capability: "platform:govern" },
    async (session, now, operationId) => {
      const c = collections(ctx.db);
      const org = await c.organizations.findOne({ _id: input.org_id, kind: "platform", status: "active" }, { session });
      const user = await c.users.findOne({ _id: input.user_id, status: "active", privacy_state: "active" }, { session });
      const member = await c.members.findOne({ user_id: input.user_id, org_id: input.org_id,
        status: "active", authorization_revision: input.expected_revision }, { session });
      if (!org || !user || !member || !await c.memberRoles.findOne({ member_id: member._id, org_id: org._id, role_id: "platform_ops" }, { session }))
        reject("治理初始化须有效平台组织与独立platform_ops账号");
      const existingGrants = await ctx.db.collection<AdministrativeGrant>("administrative_grants").find({
        capability: "platform:govern", status: { $ne: "revoked" },
      }, { session, projection: { subject_member_id: 1 } }).toArray();
      const subjectIds = [...new Set(existingGrants.map(grant => grant.subject_member_id))];
      const establishedMembers = await c.members.find({ _id: { $in: subjectIds } },
        { session, projection: { _id: 1, user_id: 1 } }).toArray();
      if (establishedMembers.length !== subjectIds.length) reject("存量治理授权指向不存在的成员，拒绝初始化");
      const establishedUsers = new Set(establishedMembers.map(row => row.user_id));
      if (establishedUsers.size >= 2 || establishedUsers.has(input.user_id))
        reject("初始CLI最多建立两位独立治理账号；后续走独立审批");
      const grant_id = newId();
      const scope = { kind: "organization_ids" as const, organization_ids: [input.org_id] };
      await ctx.db.collection<AdministrativeGrant>("administrative_grants").insertOne({
        _id: grant_id, subject_member_id: member._id, actor_org_id: input.org_id, capability: "platform:govern",
        scope, scope_key: scopeFingerprint(scope), delegate_capabilities: [], status: "active", revision: 1,
        valid_from: now, valid_to: null, operation_id: operationId, authority: "cli", approval_id: null,
        created_at: now, updated_at: now,
      }, { session });
      const fence = await c.members.updateOne({ _id: member._id, authorization_revision: input.expected_revision },
        { $inc: { authorization_revision: 1 }, $set: { updated_at: now } }, { session });
      if (fence.matchedCount !== 1) reject("成员权限版本已变化");
      await c.users.updateOne({ _id: input.user_id, ...privacyActive },
        { $inc: { identity_revision: 1 }, $set: { updated_at: now } }, { session });
      return { result: { member_id: member._id, grant_id }, resource: grant_id, org: org._id };
    });
}

/** Inspection never registers an operational writer or attempts a repair. */
export async function inspectAdministration(db: Db, operationId?: string) {
  if (operationId) id(operationId);
  const [guard, operations] = await Promise.all([
    db.collection<AdministrationGuard>("administration_guard").findOne({ _id: "administration" }),
    inspectAdministrationOperations(db, operationId),
  ]);
  return { guard, operations };
}

/** Explicit local recovery. The original operation's immutable intent is checked by
 * the core before any callback; unknown or inapplicable actions remain isolated. */
export async function recoverCliAdministration(ctx: OperationContext, input: {
  operation_id: string; mode: "forward" | "void" | "invalidate" | "release"; previous_recovery_token?: string;
}): Promise<Record<string, unknown>> {
  await assertSchema(ctx.db);
  await assertOperationalAccess(ctx.db);
  id(input.operation_id);
  bounded(ctx.actor, "操作者", 128);
  bounded(ctx.reason, "原因", 512);
  const operation = (await inspectAdministrationOperations(ctx.db, input.operation_id))[0];
  if (!operation) reject("操作ID不存在");
  if (operation.action.startsWith("approval.") || typeof operation.desired.actorOrgId === "string") {
    if (input.mode === "void") reject("网页申请只能经独立审批恢复的invalidate流程作废");
    return recoverApprovedAdministrationOperation({ db: ctx.db, client: ctx.client,
      operation_id: input.operation_id, actor: ctx.actor, reason: ctx.reason,
      previous_recovery_token: input.previous_recovery_token,
      mode: input.mode });
  }
  const c = collections(ctx.db);
  const params = { db: ctx.db, client: ctx.client, operation_id: input.operation_id,
    actor: ctx.actor, reason: ctx.reason, previous_recovery_token: input.previous_recovery_token };
  const desired = operation.desired;
  const userId = typeof desired.user_id === "string" ? id(desired.user_id) : undefined;
  const orgId = typeof desired.org_id === "string" ? id(desired.org_id) : undefined;
  const isCapability = /^capability\.(grant|revoke)\./.test(operation.action);
  const recognized = ["organization.create", "user.create", "membership.set", "user.status",
    "user.password.reset", "organization.status", "auth.restore.lock", "governance.bootstrap"].includes(operation.action) || isCapability;
  if (!recognized) reject("该操作不属于可恢复的本地CLI命令；保持隔离");
  const verifySafe = async (_op: typeof operation, session: ClientSession) => {
    if (await ctx.db.collection("administrative_grants").findOne({ operation_id: operation._id, status: { $in: ["active", "pending"] } }, { session }) ||
        await ctx.db.collection("member_capability_grants").findOne({ operation_id: operation._id, status: { $in: ["active", "pending"] } }, { session }) ||
        await ctx.db.collection("member_roles").findOne({ operation_id: operation._id, status: { $in: ["active", "pending"] } }, { session }))
      reject("残留授权尚未撤销，不能解除隔离");
    if (["user.create", "user.password.reset"].includes(operation.action) && userId &&
        await c.users.findOne({ _id: userId, status: "active" }, { session }))
      reject("凭据相关目标尚未安全禁用，不能解除隔离");
    if (operation.action === "membership.set" && userId && orgId &&
        await c.members.findOne({ user_id: userId, org_id: orgId, status: "active" }, { session }))
      reject("部分变更成员尚未禁用，不能解除隔离");
    if (operation.action === "organization.create" && desired.organization_id &&
        await c.organizations.findOne({ _id: desired.organization_id, status: "active" }, { session }))
      reject("部分创建组织尚未安全禁用");
    if (operation.action === "organization.status" && desired.status === "active" &&
        (operation.before.organizations as Document[] | undefined)?.some(row => row._id === orgId && row.status === "disabled") &&
        await c.organizations.findOne({ _id: orgId, status: "active" }, { session }))
      reject("原禁用组织仍被意外启用");
    if (operation.action === "user.status" && desired.status === "active" &&
        (operation.before.users as Document[] | undefined)?.some(row => row._id === userId && row.status === "disabled") &&
        await c.users.findOne({ _id: userId, status: "active" }, { session }))
      reject("原禁用账号仍被意外启用");
    if (operation.action === "auth.restore.lock") reject("全局恢复锁定不能中途失效释放，须前向核实完成");
  };
  if (input.mode === "release") {
    if (!input.previous_recovery_token) reject("人工解除隔离需显式previous-recovery-token");
    return releaseInvalidatedAdministration({ ...params,
      previous_recovery_token: input.previous_recovery_token, verifySafe });
  }
  if (input.mode === "void" && operation.step === "intent") {
    await voidAdministrationOperation({ ...params, verifyNoEffect: async (_op, session) => {
      if (await ctx.db.collection<AuditEvent>("audit_events").findOne({ operation_id: operation._id }, { session }) ||
          await ctx.db.collection("administrative_grants").findOne({ operation_id: operation._id }, { session }) ||
          await ctx.db.collection("member_capability_grants").findOne({ operation_id: operation._id }, { session }) ||
          await ctx.db.collection("member_roles").findOne({ operation_id: operation._id }, { session }))
        reject("操作已产生目标或审计证据，不能作废未执行意图");
      if (operation.action === "user.create" && userId && await c.users.findOne({ _id: userId }, { session }))
        reject("账号已创建，不能作为未执行意图作废");
      if (operation.action === "organization.create" && desired.organization_id &&
          await c.organizations.findOne({ _id: desired.organization_id }, { session }))
        reject("组织已创建，不能作为未执行意图作废");
    } });
    return { operation_id: operation._id, status: "void", isolated: false };
  }
  if (operation.action === "auth.restore.lock" && (input.mode === "invalidate" || input.mode === "void"))
    reject("全局恢复锁定必须前向完成并人工复核，不可解除部分锁定");
  if (input.mode === "invalidate" || input.mode === "void") {
    return cancelAdministrationOperation({ ...params, invalidate: async (_op, session) => {
      const now = new Date();
      for (const collection of ["administrative_grants", "member_capability_grants", "member_roles"]) {
        await ctx.db.collection(collection).updateMany({ operation_id: operation._id, status: { $in: ["active", "pending"] } },
          { $set: { status: "revoked", ...(collection !== "member_roles" ? { updated_at: now } : {}) },
            ...(collection !== "member_roles" ? { $inc: { revision: 1 } } : {}) }, { session });
      }
      if (operation.action === "organization.create") {
        if (desired.organization_id) await c.organizations.updateOne({ _id: desired.organization_id },
          { $set: { status: "disabled", updated_at: now } }, { session });
      } else if (operation.action === "organization.status" && desired.status === "active" && orgId &&
          (operation.before.organizations as Document[] | undefined)?.some(row => row._id === orgId && row.status === "disabled")) {
        await c.organizations.updateOne({ _id: orgId }, { $set: { status: "disabled", updated_at: now } }, { session });
      } else if (operation.action === "membership.set" && userId && orgId) {
        const member = await c.members.findOne({ user_id: userId, org_id: orgId }, { session });
        if (member) {
          await assertRetainsGovernance(ctx.db, now, session, { member_id: member._id });
          await c.members.updateOne({ _id: member._id }, { $set: { status: "disabled", updated_at: now },
            $inc: { authorization_revision: 1 } }, { session });
        }
      } else if (["user.create", "user.password.reset"].includes(operation.action) && userId) {
        await assertRetainsGovernance(ctx.db, now, session, { user_id: userId });
        await c.users.updateOne({ _id: userId, ...privacyActive },
          { $set: { status: "disabled", updated_at: now }, $inc: { identity_revision: 1 } }, { session });
      }
      if (operation.action === "user.status" && desired.status === "active" && userId &&
          (operation.before.users as Document[] | undefined)?.some(row => row._id === userId && row.status === "disabled")) {
        await assertRetainsGovernance(ctx.db, now, session, { user_id: userId });
        await c.users.updateOne({ _id: userId, ...privacyActive },
          { $set: { status: "disabled", updated_at: now }, $inc: { credential_version: 1, identity_revision: 1 } }, { session });
      }
      if (userId) await c.sessions.updateMany({ user_id: userId, revoked_at: null },
        { $set: { revoked_at: now } }, { session });
    }, verifySafe });
  }
  if (input.mode !== "forward") reject("未知恢复模式");
  const result = await recoverAdministrationOperation<{ secret?: string }>({ ...params,
    revalidate: async (_op, session) => {
      if (operation.status === "applied" && (!operation.audit_id ||
          !await c.audit.findOne({ _id: operation.audit_id, operation_id: operation._id }, { session })))
        reject("已发布操作缺失匹配审计，拒绝解除隔离");
      const [dbClock] = await ctx.db.aggregate<{ now: Date }>([
        { $documents: [{}] }, { $project: { _id: 0, now: "$$NOW" } },
      ], { session }).toArray();
      if (!(dbClock?.now instanceof Date)) reject("数据库时钟不可用");
      if (operation.action === "membership.set" && Array.isArray(desired.roles) &&
          desired.roles.includes("content_reviewer") &&
          (!(typeof desired.reviewer_valid_to === "string") ||
            new Date(desired.reviewer_valid_to) <= dbClock.now))
        reject("审核角色期限已失效，必须失效旧操作后重新审批");
      if (isCapability && desired.granted === true && desired.valid_to &&
          new Date(String(desired.valid_to)) <= dbClock.now)
        reject("敏感授权期限已失效，禁止发布旧授权");
      if (userId && !await c.users.findOne({ _id: userId, ...privacyActive }, { session }) &&
          operation.action !== "user.create")
        reject("目标身份已不存在或隐私删除，保持隔离");
    },
    finish: async (_op, session) => {
      const now = new Date();
      if (operation.action === "user.create") {
        const uid = id(desired.user_id), loginKey = String(desired.login_key), displayName = String(desired.display_name);
        if (!validLogin(loginKey) || !displayName.trim()) reject("原账号操作意图不可核验");
        const secret = temporaryPassword(), password_hash = await hashPassword(secret);
        const existing = await c.users.findOne({ _id: uid }, { session });
        if (existing && (existing.login_key !== loginKey || existing.display_name !== displayName ||
            existing.privacy_state !== "active" || existing.credential_version !== 1))
          reject("原账号状态与意图不符，拒绝自动修复");
        if (!existing) await c.users.insertOne({ _id: uid, login_key: loginKey, display_name: displayName,
          status: "disabled", privacy_state: "active", password_hash, credential_version: 1,
          identity_revision: 1, must_change_password: true, temporary_password_expires_at: expiry(ctx, now),
          password_changed_at: now, created_at: now, updated_at: now }, { session });
        await c.users.updateOne({ _id: uid, ...privacyActive },
          { $set: { password_hash, status: "active", must_change_password: true,
            temporary_password_expires_at: expiry(ctx, now), password_changed_at: now, updated_at: now } }, { session });
        await c.sessions.updateMany({ user_id: uid, revoked_at: null }, { $set: { revoked_at: now } }, { session });
        return { secret };
      }
      if (operation.action === "user.password.reset") {
        const secret = temporaryPassword(), password_hash = await hashPassword(secret);
        const changed = await c.users.updateOne({ _id: id(desired.user_id), ...privacyActive },
          { $set: { password_hash, must_change_password: true, temporary_password_expires_at: expiry(ctx, now),
            password_changed_at: now, updated_at: now }, $inc: { credential_version: 1, identity_revision: 1 } }, { session });
        if (!changed.matchedCount) reject("目标不可重置");
        await c.sessions.updateMany({ user_id: id(desired.user_id), revoked_at: null }, { $set: { revoked_at: now } }, { session });
        return { secret };
      }
      if (operation.action === "organization.create") {
        const org = await c.organizations.findOne({ _id: desired.organization_id }, { session });
        if (org && (org.name !== desired.name || org.kind !== desired.kind || org.status !== "active"))
          reject("组织目标已被不同状态占用");
        if (!org) await c.organizations.insertOne({ _id: id(desired.organization_id), name: String(desired.name),
          kind: desired.kind as Organization["kind"], status: "active", created_at: now, updated_at: now }, { session });
      } else if (operation.action === "organization.status") {
        const org = await c.organizations.findOne({ _id: id(desired.org_id) }, { session });
        if (!org) reject("目标组织已不存在");
        if (desired.status === "disabled") await assertRetainsGovernance(ctx.db, now, session, { org_id: org._id });
        await c.organizations.updateOne({ _id: org._id }, { $set: { status: desired.status, updated_at: now } }, { session });
        if (desired.status === "disabled") await c.members.updateMany({ org_id: org._id, status: "active" },
          { $set: { status: "disabled", updated_at: now }, $inc: { authorization_revision: 1 } }, { session });
      } else if (operation.action === "user.status") {
        const user = await c.users.findOne({ _id: id(desired.user_id), ...privacyActive }, { session });
        if (!user) reject("目标用户已不存在");
        if (desired.status === "disabled") await assertRetainsGovernance(ctx.db, now, session, { user_id: user._id });
        if (desired.status === "active" && user.must_change_password &&
            (!user.temporary_password_expires_at || user.temporary_password_expires_at <= now))
          reject("目标临时凭据已到期，不得自动启用");
        if (user.status !== desired.status) await c.users.updateOne({ _id: user._id, ...privacyActive },
          { $set: { status: desired.status, updated_at: now }, $inc: { identity_revision: 1, credential_version: 1 } }, { session });
        await c.sessions.updateMany({ user_id: user._id, revoked_at: null }, { $set: { revoked_at: now } }, { session });
      } else if (operation.action === "membership.set") {
        const roles = desired.roles as RoleCode[];
        const validTo = desired.reviewer_valid_to ? new Date(String(desired.reviewer_valid_to)) : null;
        if (!Array.isArray(roles) || roles.some(role => !Object.hasOwn(ROLE_CAPABILITIES, role))) reject("角色意图不合法");
        const user = await c.users.findOne({ _id: id(desired.user_id), ...privacyActive }, { session });
        const org = await c.organizations.findOne({ _id: id(desired.org_id) }, { session });
        if (!user || !org) reject("成员归属失效");
        let member = await c.members.findOne({ user_id: user._id, org_id: org._id }, { session });
        const previous = desired.expected_revision;
        if (member && (previous === null && member.created_at < operation.created_at ||
            typeof previous === "number" && ![previous, previous + 1].includes(member.authorization_revision)))
          reject("目标成员版本与原意图冲突");
        if (!member && previous !== null) reject("目标成员已被移除");
        if (member) await assertRetainsGovernance(ctx.db, now, session, { member_id: member._id });
        const memberId = member?._id ?? newId();
        if (!member) {
          await c.members.insertOne({ _id: memberId, user_id: user._id, org_id: org._id,
            status: desired.status, authorization_revision: 1, created_at: now, updated_at: now }, { session });
        } else if (member.authorization_revision === previous)
          await c.members.updateOne({ _id: memberId, authorization_revision: previous },
            { $set: { status: desired.status, updated_at: now }, $inc: { authorization_revision: 1 } }, { session });
        await c.memberRoles.deleteMany({ member_id: memberId }, { session });
        if (roles.length) await c.memberRoles.insertMany(roles.map(role_id => ({
          _id: newId(), org_id: org._id, member_id: memberId, role_id,
          ...(role_id === "content_reviewer" ? { status: "active" as const, valid_from: now,
            valid_to: validTo!, operation_id: operation._id, approval_id: null, authority: "cli" as const } : {}),
        })), { session });
        await ctx.db.collection("member_capability_grants").updateMany({ member_id: memberId, status: "active" },
          { $set: { status: "revoked", updated_at: now }, $inc: { revision: 1 } }, { session });
        await ctx.db.collection("administrative_grants").updateMany({ subject_member_id: memberId, status: "active" },
          { $set: { status: "revoked", updated_at: now }, $inc: { revision: 1 } }, { session });
        await c.users.updateOne({ _id: user._id, ...privacyActive }, { $inc: { identity_revision: 1 } }, { session });
      } else if (isCapability) {
        const member = await c.members.findOne({ _id: id(desired.member_id), org_id: id(desired.org_id) }, { session });
        if (!member) reject("目标成员不存在");
        const expected = Number(desired.expected_revision);
        if (member.authorization_revision !== expected && member.authorization_revision !== expected + 1)
          reject("成员权限版本与原意图冲突");
        if (member.authorization_revision === expected)
          await c.members.updateOne({ _id: member._id, authorization_revision: expected },
            { $inc: { authorization_revision: 1 }, $set: { updated_at: now } }, { session });
        const grants = ctx.db.collection<MemberCapabilityGrant>("member_capability_grants");
        const key = { org_id: member.org_id, member_id: member._id, capability: desired.capability as ControlledCapability };
        if (desired.granted === true) {
          const old = await grants.findOne(key, { session });
          if (old) await grants.updateOne({ _id: old._id }, { $set: { status: "active",
            valid_from: now, valid_to: desired.valid_to ? new Date(String(desired.valid_to)) : null,
            operation_id: operation._id, authority: "cli", updated_at: now }, $inc: { revision: 1 } }, { session });
          else await grants.insertOne({ ...key, _id: newId(), status: "active", revision: 1, valid_from: now,
            valid_to: desired.valid_to ? new Date(String(desired.valid_to)) : null, operation_id: operation._id,
            authority: "cli", created_at: now, updated_at: now }, { session });
        } else await grants.updateOne({ ...key, status: "active" },
          { $set: { status: "revoked", updated_at: now }, $inc: { revision: 1 } }, { session });
        await c.users.updateOne({ _id: member.user_id, ...privacyActive }, { $inc: { identity_revision: 1 } }, { session });
      } else if (operation.action === "governance.bootstrap") {
        const member = await c.members.findOne({ user_id: id(desired.user_id), org_id: id(desired.org_id), status: "active" }, { session });
        const org = await c.organizations.findOne({ _id: id(desired.org_id), kind: "platform", status: "active" }, { session });
        if (!member || !org || !await c.memberRoles.findOne({ member_id: member._id, role_id: "platform_ops" }, { session }))
          reject("平台治理目标已失效");
        const expected = Number(desired.expected_revision);
        if (![expected, expected + 1].includes(member.authorization_revision)) reject("治理成员版本已变化");
        const grants = ctx.db.collection<AdministrativeGrant>("administrative_grants");
        if (!await grants.findOne({ operation_id: operation._id, subject_member_id: member._id, capability: "platform:govern" }, { session })) {
          const scope = { kind: "organization_ids" as const, organization_ids: [org._id] };
          await grants.insertOne({ _id: newId(), subject_member_id: member._id, actor_org_id: org._id,
            capability: "platform:govern", scope, scope_key: scopeFingerprint(scope), delegate_capabilities: [],
            status: "active", revision: 1, valid_from: now, valid_to: null, operation_id: operation._id,
            approval_id: null, authority: "cli", created_at: now, updated_at: now }, { session });
        }
        if (member.authorization_revision === expected) await c.members.updateOne({ _id: member._id },
          { $inc: { authorization_revision: 1 }, $set: { updated_at: now } }, { session });
        await c.users.updateOne({ _id: member.user_id, ...privacyActive }, { $inc: { identity_revision: 1 } }, { session });
      } else if (operation.action === "auth.restore.lock") {
        await c.users.updateMany({ $or: [{ status: "active" }, { must_change_password: false },
          { temporary_password_expires_at: { $ne: new Date(0) } }] },
          { $set: { status: "disabled", must_change_password: true,
            temporary_password_expires_at: new Date(0), updated_at: now },
            $inc: { identity_revision: 1, credential_version: 1 } }, { session });
        await c.members.updateMany({ status: "active" }, { $set: { status: "disabled", updated_at: now },
          $inc: { authorization_revision: 1 } }, { session });
        await c.memberRoles.deleteMany({}, { session });
        for (const name of ["member_capability_grants", "administrative_grants"])
          await ctx.db.collection(name).updateMany({ status: { $ne: "revoked" } },
            { $set: { status: "revoked", updated_at: now }, $inc: { revision: 1 } }, { session });
        await ctx.db.collection("authorization_requests").updateMany({ status: { $in: ["pending", "approved", "applying", "needs_recovery"] } },
          { $set: { status: "rejected", updated_at: now }, $inc: { revision: 1 } }, { session });
        await c.sessions.updateMany({ revoked_at: null }, { $set: { revoked_at: now } }, { session });
      }
      return {};
    },
    verify: async (_op, session) => {
      if (operation.action === "user.create" && !await c.users.findOne({
        _id: desired.user_id, status: "active", must_change_password: true, privacy_state: "active" }, { session }))
        reject("账号未达到原意图，不可发布");
      if (operation.action === "organization.create" && !await c.organizations.findOne({
        _id: desired.organization_id, name: desired.name, kind: desired.kind, status: "active" }, { session }))
        reject("组织创建结果与原目标不符");
      if (operation.action === "user.password.reset" && await c.sessions.findOne({
        user_id: desired.user_id, revoked_at: null }, { session }))
        reject("旧会话仍有效，不可发布");
      if (operation.action === "user.password.reset" && !await c.users.findOne({
        _id: desired.user_id, must_change_password: true, ...privacyActive }, { session }))
        reject("密码重置目标未完成强制改密");
      if (operation.action === "user.status" && !await c.users.findOne({
        _id: desired.user_id, status: desired.status }, { session })) reject("账号状态未达目标");
      if (operation.action === "user.status" && await c.sessions.findOne({
        user_id: desired.user_id, revoked_at: null }, { session })) reject("账号旧会话尚未撤销");
      if (operation.action === "organization.status" && !await c.organizations.findOne({
        _id: desired.org_id, status: desired.status }, { session })) reject("组织状态未达目标");
      if (operation.action === "organization.status" && desired.status === "disabled" &&
          await c.members.findOne({ org_id: desired.org_id, status: "active" }, { session }))
        reject("组织仍存在活跃成员");
      if (operation.action === "membership.set") {
        const member = await c.members.findOne({ user_id: desired.user_id, org_id: desired.org_id,
          status: desired.status }, { session });
        if (!member || member.authorization_revision !== Number(desired.expected_revision ?? 0) + 1)
          reject("成员目标状态或版本尚未核实");
        const actual = await c.memberRoles.find({ member_id: member._id }, { session }).toArray();
        if (JSON.stringify(actual.map(row => row.role_id).sort()) !== JSON.stringify((desired.roles as string[]).slice().sort()))
          reject("成员角色不符合原意图");
        const reviewer = actual.find(row => row.role_id === "content_reviewer");
        if (reviewer && (reviewer.operation_id !== operation._id || reviewer.authority !== "cli" ||
            reviewer.valid_to?.toISOString() !== desired.reviewer_valid_to))
          reject("受控审核角色期限/操作依据不符");
      }
      if (isCapability && desired.granted === true && !await ctx.db.collection("member_capability_grants").findOne({
        member_id: desired.member_id, capability: desired.capability, status: "active",
        operation_id: operation._id }, { session })) reject("未核实操作关联的生效授权");
      if (isCapability && desired.granted === false && await ctx.db.collection("member_capability_grants").findOne({
        member_id: desired.member_id, capability: desired.capability, status: "active" }, { session }))
        reject("受控能力尚未撤销");
      if (operation.action === "governance.bootstrap" && !await ctx.db.collection("administrative_grants").findOne({
        operation_id: operation._id, capability: "platform:govern", status: "active" }, { session }))
        reject("治理授权未达目标");
      if (operation.action === "auth.restore.lock" &&
          (await c.users.findOne({ status: "active" }, { session }) ||
            await c.members.findOne({ status: "active" }, { session }) ||
            await c.memberRoles.findOne({}, { session }) ||
            await ctx.db.collection("member_capability_grants").findOne({ status: "active" }, { session }) ||
            await ctx.db.collection("administrative_grants").findOne({ status: "active" }, { session }) ||
            await ctx.db.collection("authorization_requests").findOne({ status: { $in: ["pending", "approved", "applying", "needs_recovery"] } }, { session }) ||
            await c.sessions.findOne({ revoked_at: null }, { session })))
        reject("恢复锁定未覆盖全部身份/会话/授权");
    },
  });
  return { operation_id: result.operation_id, status: result.status,
    ...(result.result?.secret ? { secret: result.result.secret } :
      ["user.create", "user.password.reset"].includes(operation.action) ? { password_not_replayable: true } : {}) };
}
