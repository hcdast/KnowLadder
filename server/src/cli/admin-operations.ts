import { randomUUID } from "node:crypto";
import { MongoClient, type Db, type ClientSession, type Filter } from "mongodb";
import {
  collections,
  normalizeLogin,
  validLogin,
  ROLE_CAPABILITIES,
  CONTROLLED_CAPABILITIES,
  type ControlledCapability,
  type MemberCapabilityGrant,
  type RoleCode,
  type Organization,
  type User,
} from "../database/contracts";
import { hashPassword, temporaryPassword } from "../security/password";

import { assertSchema } from "../migrations/schema";
import { assertOperationalAccess } from "../operations/control";

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
  return bounded(value, "标识", 128);
}
async function transact<T>(
  ctx: OperationContext,
  action: string,
  work: (
    session: ClientSession,
    now: Date,
  ) => Promise<{ result: T; resource: string; org?: string; evidence?: Record<string, unknown> }>,
): Promise<T> {
  await assertOperationalAccess(ctx.db);
  await assertSchema(ctx.db);
  bounded(ctx.actor, "操作者", 128);
  bounded(ctx.reason, "原因", 512);
  const session = ctx.client.startSession();
  try {
    const result = await session.withTransaction(
      async () => {
        await assertOperationalAccess(ctx.db);
        const clock = await ctx.db.command({ hello: 1 });
        if (!(clock.localTime instanceof Date))
          throw new AdminError("CLOCK_UNAVAILABLE", "数据库时间不可用");
        const { result, resource, org, evidence } = await work(session, clock.localTime);
        await collections(ctx.db).audit.insertOne(
          {
            _id: randomUUID(),
            actor_id: ctx.actor.trim(),
            org_id: org ?? null,
            action,
            resource_id: resource,
            reason: ctx.reason.trim(),
            request_id: randomUUID(),
            created_at: clock.localTime,
            ...evidence,
          },
          { session },
        );
        return result;
      },
      {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
      },
    );
    return result as T;
  } finally {
    await session.endSession();
  }
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
  return transact(ctx, "organization.create", async (session, now) => {
    const organization_id = randomUUID();
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
  return transact(ctx, "user.create", async (session, now) => {
    const user_id = randomUUID();
    await collections(ctx.db).users.insertOne(
      {
        _id: user_id,
        login_key: normalizeLogin(input.login_name),
        display_name,
        status: "active",
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
  return transact(ctx, "membership.set", async (session, now) => {
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
    const member_id = member?._id ?? randomUUID();
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
    await ctx.db.collection("member_capability_grants").deleteMany({ org_id: input.org_id, member_id }, { session });
    if (input.roles.length)
      await c.memberRoles.insertMany(
        input.roles.map((role_id) => ({
          _id: randomUUID(),
          member_id,
          org_id: input.org_id,
          role_id,
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
  return transact(ctx, "user.status", async (session, now) => {
    const c = collections(ctx.db);
    const user = await c.users.findOne({ _id: input.user_id, ...privacyActive }, { session });
    if (!user) reject("用户不存在或隐私删除已生效");
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
  return transact(ctx, "user.password.reset", async (session, now) => {
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
  return transact(ctx, "organization.status", async (session, now) => {
    const c = collections(ctx.db);
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
  return transact(ctx, "auth.restore.lock", async (session, now) => {
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
    await ctx.db.collection("member_capability_grants").deleteMany({}, { session });
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
  member_id: string; org_id: string; capability: ControlledCapability; granted: boolean; expected_revision: number;
}): Promise<{ member_id: string; authorization_revision: number }> {
  id(input.member_id); id(input.org_id);
  if (!CONTROLLED_CAPABILITIES.includes(input.capability) || typeof input.granted !== "boolean" ||
      !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1) reject("能力或成员版本不合法");
  return transact(ctx, `capability.${input.granted ? "grant" : "revoke"}.${input.capability}`, async (session, now) => {
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
    if (input.granted) await grants.updateOne(key, { $setOnInsert: { ...key, _id: randomUUID() } }, { upsert: true, session });
    else await grants.deleteOne(key, { session });
    const userFence = await c.users.updateOne({ _id: member.user_id, ...privacyActive }, { $inc: { identity_revision: 1 }, $set: { updated_at: now } }, { session });
    if (userFence.matchedCount !== 1) reject("用户不存在或隐私删除已生效");
    return { result: { member_id: member._id, authorization_revision: input.expected_revision + 1 }, resource: member._id, org: input.org_id,
      evidence: { resource_type: "member", owner_type: null, owner_version_id: null, revision_before: null, revision_after: null,
        access_revision_before: input.expected_revision, access_revision_after: input.expected_revision + 1 } };
  });
}
