import { Injectable } from "@nestjs/common";
import type { ClientSession, Filter } from "mongodb";
import type { Response } from "express";
import { AuthService } from "../auth.service";
import { Database } from "../database/database";
import { probeTopology } from "../database/topology";
import { newId } from "../database/object-id";
import { type AuthSession, type User, validPassword } from "../database/contracts";
import { ApiRequest, fail } from "../errors";
import { hashPassword, verifyPassword } from "../security/password";
import type { OperationalState } from "../operations/contracts";
import { AdministrationTargetIsolatedError, assertAdministrationAccess, assertAdministrationGlobalAccess } from "../administration/authorization";
import { protectedAccount } from "../administration/protected-account";
import { loadEmailConfig } from "./config";
import { enqueueEmail, MailDeliveryService } from "./mail";
import { emailCollections } from "./contracts";
import { consumeEmailChallenge, invalidEmailAction, issueEmailChallenge, normalizeEmail, readEmailChallenge, revokeEmailChallenges } from "./tokens";
import type { ActivateEmailDto, BindEmailDto, RegisterEmailDto } from "./dto";

const privacyActive = { $or: [{ privacy_state: "active" as const }, { privacy_state: { $exists: false } }] };
const sessionAlive: Filter<AuthSession> = {
  revoked_at: null, $expr: { $and: [
    { $gt: ["$expires_at", "$$NOW"] }, { $gt: ["$idle_expires_at", "$$NOW"] }, { $gt: ["$absolute_expires_at", "$$NOW"] },
  ] },
};
@Injectable()
export class AuthEmailService {
  constructor(readonly auth: AuthService, readonly database: Database, readonly mail: MailDeliveryService) {}

  capabilities() {
    const config = loadEmailConfig();
    return {
      email_password_login: true,
      email_actions: config.actionsEnabled,
      public_registration: config.registrationEnabled,
      invitations: config.actionsEnabled,
      terms_version: config.termsVersion || null,
      privacy_notice_version: config.privacyVersion || null,
      terms_url: config.termsUrl || null,
      privacy_notice_url: config.privacyUrl || null,
    };
  }
  async assertTransaction() {
    if ((await probeTopology(this.database.db)).mode !== "replicaSet")
      fail(503, "AUTH_TRANSACTION_REQUIRED", "邮箱操作需要副本集事务");
  }
  async assertAvailable(registration = false) {
    const config = loadEmailConfig();
    if (!config.actionsEnabled || (registration && !config.registrationEnabled))
      fail(503, "AUTH_EMAIL_UNAVAILABLE", "邮箱操作暂不可用");
    await this.assertTransaction();
    try {
      await this.mail.assertAvailable();
    } catch (error) {
      if (error instanceof Error && (error.message === "AUTH_MAIL_UNAVAILABLE" || error.message === "AUTH_EMAIL_DISABLED"))
        fail(503, "AUTH_EMAIL_UNAVAILABLE", "恢复邮件服务暂不可用，请稍后显式重试");
      throw error;
    }
  }
  async actionSession(req: ApiRequest, mode: "preauth" | "any" | "authenticated", transaction?: ClientSession): Promise<{ session: AuthSession; user: User | null }> {
    this.auth.origin(req);
    const session = await this.auth.session(req, transaction);
    if (!session) fail(403, "CSRF_REJECTED", "请先获取当前会话的安全令牌");
    this.auth.csrf(req, session);
    if (mode === "preauth" && session.kind !== "preauth")
      fail(409, "AUTH_ACCOUNT_SWITCH_REQUIRED", "请先明确退出当前账号，再继续新账号激活");
    if (mode === "authenticated" && session.kind !== "authenticated")
      fail(401, "SESSION_EXPIRED", "请先登录本人账号");
    const identity = session.kind === "authenticated" ? await this.auth.identify(req, false, transaction) : null;
    if (identity && mode === "authenticated" && identity.user.must_change_password)
      fail(403, "PASSWORD_CHANGE_REQUIRED", "请先完成首次密码修改");
    if (transaction) {
      if (!transaction.inTransaction())
        fail(503, "AUTH_TRANSACTION_REQUIRED", "邮箱操作需要副本集事务");
      const operational = await this.database.db.collection<OperationalState>("operational_state").updateOne(
        { _id: "environment", mode: { $in: ["unregistered", "active"] } },
        { $inc: { access_fence: 1 } }, { session: transaction },
      );
      if (operational.matchedCount !== 1)
        fail(503, "OPERATIONS_ACCESS_BLOCKED", "环境正在维护或隔离，当前操作未提交");
      const idleExpiry = { $min: [{ $add: ["$$NOW", this.auth.config.idleMs] }, "$absolute_expires_at"] };
      const live = await this.auth.c.sessions.updateOne({ _id: session._id, ...sessionAlive },
        [{ $set: {
          last_seen_at: "$$NOW",
          ...(session.kind === "authenticated" ? { idle_expires_at: idleExpiry, expires_at: idleExpiry } : {}),
        } }], { session: transaction });
      if (live.matchedCount !== 1) fail(401, "SESSION_EXPIRED", "会话已失效，请重新获取安全令牌");
      if (identity) {
        await this.auth.fenceUser(identity.user, transaction);
        identity.user.identity_revision += 1;
      }
    }
    return { session, user: identity?.user ?? null };
  }
  async sendRate(req: ApiRequest, emailKey: string) {
    await this.auth.rate("email-send-ip", req.ip ?? "unknown", 20, 15 * 60000, req.res);
    await this.auth.rate("email-send-address", emailKey, 5, 60 * 60000, req.res);
    await this.auth.rate("email-send-cooldown", emailKey, 1, 60000, req.res);
  }
  async confirmRate(req: ApiRequest) {
    await this.auth.rate("email-confirm-ip", req.ip ?? "unknown", 30, 15 * 60000, req.res);
  }
  admission(body: { age_band: string; accepted_terms: boolean; terms_version: string; privacy_notice_version: string }) {
    const config = loadEmailConfig();
    if (body.age_band !== "adult" || body.accepted_terms !== true)
      fail(422, "ADULT_ADMISSION_REQUIRED", "自助开户须由成年收件人明确接受条款；未成年人请联系机构受控开户");
    if (!config.termsVersion || !config.privacyVersion || body.terms_version !== config.termsVersion || body.privacy_notice_version !== config.privacyVersion)
      fail(409, "ADMISSION_POLICY_CHANGED", "条款或隐私告知版本已更新，请重新阅读确认");
    return { terms_version: config.termsVersion, privacy_notice_version: config.privacyVersion };
  }
  async createActivatedUser(req: ApiRequest, preauth: AuthSession, transaction: ClientSession, input: {
    email: { key: string; display: string }; displayName: string; passwordHash: string;
    admission: { terms_version: string; privacy_notice_version: string }; source: "public_register" | "invite_activate";
  }) {
    if (!transaction.inTransaction()) fail(503, "AUTH_TRANSACTION_REQUIRED", "邮箱操作需要副本集事务");
    if (preauth.kind !== "preauth") fail(409, "AUTH_ACCOUNT_SWITCH_REQUIRED", "请先退出当前账号");
    const currentPolicy = loadEmailConfig();
    if (!currentPolicy.termsVersion || !currentPolicy.privacyVersion ||
        input.admission.terms_version !== currentPolicy.termsVersion ||
        input.admission.privacy_notice_version !== currentPolicy.privacyVersion)
      fail(409, "ADMISSION_POLICY_CHANGED", "条款或隐私告知版本已更新，请重新阅读确认");
    if (!input.displayName.trim() || input.displayName.length > 100) fail(422, "VALIDATION_ERROR", "显示名须为1至100字符");
    const c = emailCollections(this.database.db);
    if (await c.identities.findOne({ email_key: input.email.key }, { session: transaction })) invalidEmailAction();
    const id = newId(), loginName = `u_${id}`;
    await this.auth.c.users.updateOne({ _id: id }, [{ $set: {
      login_key: loginName, display_name: { $literal: input.displayName.trim() }, status: "active", privacy_state: "active",
      password_hash: { $literal: input.passwordHash }, credential_version: 1, identity_revision: 1,
      must_change_password: false, temporary_password_expires_at: null, password_changed_at: "$$NOW", created_at: "$$NOW", updated_at: "$$NOW",
    } }], { upsert: true, session: transaction });
    await c.identities.updateOne({ _id: newId() }, [{ $set: {
      user_id: id, email_key: { $literal: input.email.key }, email_display: { $literal: input.email.display },
      state: "verified", verified_at: "$$NOW", revision: 1, created_at: "$$NOW", updated_at: "$$NOW",
    } }], { upsert: true, session: transaction });
    await c.admissions.updateOne({ _id: newId() }, [{ $set: {
      user_id: id, age_band: "adult", source: input.source, terms_version: { $literal: input.admission.terms_version },
      privacy_notice_version: { $literal: input.admission.privacy_notice_version }, accepted_at: "$$NOW", policy_basis: "adult_self_declaration",
    } }], { upsert: true, session: transaction });
    const consumed = await this.auth.c.sessions.updateOne({ _id: preauth._id, kind: "preauth", ...sessionAlive },
      [{ $set: { revoked_at: "$$NOW" } }], { session: transaction });
    if (consumed.modifiedCount !== 1) fail(403, "CSRF_REJECTED", "当前安全令牌已失效");
    const user = await this.auth.c.users.findOne({ _id: id }, { session: transaction });
    if (!user) throw new Error("EMAIL_ACTIVATION_NOT_CONFIRMED");
    const created = await this.auth.createSession("authenticated", user, transaction);
    user.identity_revision += 1;
    await this.auth.audit("auth.email_activated", id, id, req, transaction);
    return { user, created };
  }
  activationResponse(res: Response, result: { user: User; created: { token: string; session: AuthSession } }) {
    this.auth.cookie(res, result.created.token, result.created.session.absolute_expires_at);
    return { user_id: result.user._id, login_name: result.user.login_key, session_expires_at: result.created.session.expires_at };
  }
  async register(req: ApiRequest, body: RegisterEmailDto) {
    await this.actionSession(req, "preauth");
    const email = normalizeEmail(body.email);
    await this.sendRate(req, email.key);
    await this.assertAvailable(true);
    const config = loadEmailConfig();
    if (body.age_band !== "adult") fail(422, "ADULT_ADMISSION_REQUIRED", "未成年人请联系机构受控开户");
    if (body.terms_version !== config.termsVersion || body.privacy_notice_version !== config.privacyVersion)
      fail(409, "ADMISSION_POLICY_CHANGED", "请重新阅读当前条款与隐私告知");
    await this.database.transaction(async transaction => {
      await this.actionSession(req, "preauth", transaction);
      if (await emailCollections(this.database.db).identities.findOne({ email_key: email.key }, { session: transaction })) return;
      const challenge = await issueEmailChallenge(this.database.db, transaction, { purpose: "register", userId: null, email });
      await enqueueEmail(this.database.db, transaction, { challengeId: challenge.id, userId: null, invitationId: null, purpose: "register", email: email.display, token: challenge.token, expiresAt: challenge.expiresAt });
    });
    return { accepted: true };
  }
  async activate(req: ApiRequest, res: Response, body: ActivateEmailDto) {
    await this.actionSession(req, "preauth");
    await this.confirmRate(req);
    const config = loadEmailConfig();
    if (!config.actionsEnabled || !config.registrationEnabled)
      fail(503, "AUTH_EMAIL_UNAVAILABLE", "公开注册暂不可用");
    await this.assertTransaction();
    const admission = this.admission(body);
    if (!validPassword(body.new_password)) fail(422, "VALIDATION_ERROR", "新密码格式不合法");
    const passwordHash = await hashPassword(body.new_password);
    let result;
    try {
      result = await this.database.transaction(async transaction => {
        const { session } = await this.actionSession(req, "preauth", transaction);
        const challenge = await readEmailChallenge(this.database.db, transaction, body.token, "register");
        if (challenge.user_id !== null || challenge.invitation_id !== null) invalidEmailAction();
        const activated = await this.createActivatedUser(req, session, transaction, { email: { key: challenge.email_key, display: challenge.email_key }, displayName: body.display_name, passwordHash, admission, source: "public_register" });
        const attributed = await emailCollections(this.database.db).challenges.updateOne(
          { _id: challenge._id, purpose: "register", status: "pending", user_id: null },
          [{ $set: { user_id: activated.user._id, updated_at: "$$NOW" } }], { session: transaction },
        );
        if (attributed.modifiedCount !== 1) invalidEmailAction();
        await this.database.db.collection("auth_mail_outbox").updateOne(
          { challenge_id: challenge._id, user_id: null },
          [{ $set: { user_id: activated.user._id, updated_at: "$$NOW" } }], { session: transaction },
        );
        await consumeEmailChallenge(this.database.db, transaction, challenge);
        return activated;
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === 11000) invalidEmailAction();
      throw error;
    }
    return this.activationResponse(res, result);
  }
  async resetRequest(req: ApiRequest, rawEmail: string) {
    await this.actionSession(req, "any");
    const email = normalizeEmail(rawEmail);
    await this.sendRate(req, email.key);
    await this.assertAvailable();
    await this.database.transaction(async transaction => {
      await this.actionSession(req, "any", transaction);
      await assertAdministrationGlobalAccess(this.database.db, transaction);
      const c = emailCollections(this.database.db);
      const identity = await c.identities.findOne({ email_key: email.key, state: "verified" }, { session: transaction });
      if (!identity) return;
      const user = await this.auth.c.users.findOne({ _id: identity.user_id, status: "active", ...privacyActive }, { session: transaction });
      if (!user || await protectedAccount(this.database.db, user._id, transaction)) return;
      try {
        await assertAdministrationAccess(this.database.db, user._id, undefined, transaction);
      } catch (error) {
        if (error instanceof AdministrationTargetIsolatedError) return;
        throw error;
      }
      const fenced = await this.auth.c.users.updateOne({
        _id: user._id, status: "active", credential_version: user.credential_version,
        identity_revision: user.identity_revision, ...privacyActive,
      }, { $inc: { identity_revision: 1 } }, { session: transaction });
      if (fenced.modifiedCount !== 1) return;
      const challenge = await issueEmailChallenge(this.database.db, transaction, { purpose: "reset", userId: user._id, email: { key: identity.email_key, display: identity.email_display }, credentialVersion: user.credential_version, emailRevision: identity.revision });
      await enqueueEmail(this.database.db, transaction, { challengeId: challenge.id, userId: user._id, invitationId: null, purpose: "reset", email: identity.email_display, token: challenge.token, expiresAt: challenge.expiresAt });
    });
    return { accepted: true };
  }
  async resetConfirm(req: ApiRequest, res: Response, token: string, next: string) {
    await this.actionSession(req, "any");
    await this.confirmRate(req);
    await this.assertTransaction();
    if (!validPassword(next)) fail(422, "VALIDATION_ERROR", "新密码格式不合法");
    const hashed = await hashPassword(next);
    await this.database.transaction(async transaction => {
      const current = await this.actionSession(req, "any", transaction);
      const challenge = await readEmailChallenge(this.database.db, transaction, token, "reset");
      if (!challenge.user_id || challenge.invitation_id !== null) invalidEmailAction();
      if (current.user && current.user._id !== challenge.user_id)
        fail(409, "AUTH_ACCOUNT_SWITCH_REQUIRED", "请明确退出当前账号后再重置目标账号密码");
      const user = await this.auth.c.users.findOne({ _id: challenge.user_id, status: "active", credential_version: challenge.credential_version!, ...privacyActive }, { session: transaction });
      const identity = await emailCollections(this.database.db).identities.findOne({ user_id: challenge.user_id, email_key: challenge.email_key, state: "verified", revision: challenge.email_revision! }, { session: transaction });
      if (!user || !identity || await protectedAccount(this.database.db, user._id, transaction)) invalidEmailAction();
      await assertAdministrationAccess(this.database.db, user._id, undefined, transaction);
      const updated = await this.auth.c.users.updateOne({ _id: user._id, status: "active", credential_version: user.credential_version, identity_revision: user.identity_revision, ...privacyActive }, [{ $set: {
        password_hash: { $literal: hashed }, credential_version: { $add: ["$credential_version", 1] }, identity_revision: { $add: ["$identity_revision", 1] },
        must_change_password: false, temporary_password_expires_at: null, password_changed_at: "$$NOW", updated_at: "$$NOW",
      } }], { session: transaction });
      if (updated.modifiedCount !== 1) invalidEmailAction();
      await consumeEmailChallenge(this.database.db, transaction, challenge);
      await revokeEmailChallenges(this.database.db, transaction, { user_id: user._id });
      await this.auth.c.sessions.updateMany({ user_id: user._id, revoked_at: null }, [{ $set: { revoked_at: "$$NOW" } }], { session: transaction });
      if (current.session.kind === "preauth") await this.auth.c.sessions.updateOne({ _id: current.session._id, ...sessionAlive }, [{ $set: { revoked_at: "$$NOW" } }], { session: transaction });
      await this.auth.audit("auth.email_password_reset", user._id, user._id, req, transaction);
    });
    this.auth.clear(res);
  }
  async bindRequest(req: ApiRequest, body: BindEmailDto) {
    const initial = await this.actionSession(req, "authenticated");
    if (initial.user!._id !== body.expected_user_id)
      fail(409, "AUTH_ACCOUNT_SWITCH_REQUIRED", "当前账号与操作页面身份不一致，请先重新核对账号");
    const email = normalizeEmail(body.email);
    await this.sendRate(req, email.key);
    await this.assertAvailable();
    if (!(await verifyPassword(initial.user!.password_hash, body.current_password))) fail(401, "INVALID_CREDENTIALS", "当前密码错误");
    await this.database.transaction(async transaction => {
      const current = await this.actionSession(req, "authenticated", transaction);
      if (current.user!._id !== body.expected_user_id)
        fail(409, "AUTH_ACCOUNT_SWITCH_REQUIRED", "当前账号与操作页面身份不一致，请先重新核对账号");
      if (current.user!._id !== initial.user!._id || current.user!.credential_version !== initial.user!.credential_version) fail(409, "IDENTITY_CHANGED", "账号凭据已变更，请重新认证");
      const old = await emailCollections(this.database.db).identities.findOne({ user_id: current.user!._id }, { session: transaction, sort: { revision: -1 } });
      await revokeEmailChallenges(this.database.db, transaction, { user_id: current.user!._id, purpose: { $in: ["bind", "reset"] } });
      const challenge = await issueEmailChallenge(this.database.db, transaction, { purpose: "bind", userId: current.user!._id, email, credentialVersion: current.user!.credential_version, emailRevision: old?.revision ?? null });
      await enqueueEmail(this.database.db, transaction, { challengeId: challenge.id, userId: current.user!._id, invitationId: null, purpose: "bind", email: email.display, token: challenge.token, expiresAt: challenge.expiresAt });
      await this.auth.audit("auth.email_binding_requested", current.user!._id, current.user!._id, req, transaction);
    });
    return { accepted: true };
  }
  async bindConfirm(req: ApiRequest, token: string) {
    await this.actionSession(req, "authenticated");
    await this.confirmRate(req);
    await this.assertTransaction();
    try {
      await this.database.transaction(async transaction => {
        const current = await this.actionSession(req, "authenticated", transaction);
        const challenge = await readEmailChallenge(this.database.db, transaction, token, "bind");
        if (challenge.user_id !== current.user!._id || challenge.credential_version !== current.user!.credential_version || challenge.invitation_id !== null) invalidEmailAction();
        const c = emailCollections(this.database.db);
        const old = await c.identities.findOne({ user_id: current.user!._id }, { session: transaction, sort: { revision: -1 } });
        if ((old?.revision ?? null) !== challenge.email_revision) invalidEmailAction();
        const other = await c.identities.findOne({ email_key: challenge.email_key, user_id: { $ne: current.user!._id } }, { session: transaction });
        if (other) fail(409, "EMAIL_ALREADY_BOUND", "已验证的目标邮箱不可绑定到其他账号");
        await consumeEmailChallenge(this.database.db, transaction, challenge);
        await revokeEmailChallenges(this.database.db, transaction, { user_id: current.user!._id, purpose: { $in: ["bind", "reset"] } });
        await c.identities.deleteMany({ user_id: current.user!._id }, { session: transaction });
        await c.identities.updateOne({ _id: old?._id ?? newId() }, [{ $set: {
          user_id: current.user!._id, email_key: { $literal: challenge.email_key }, email_display: { $literal: challenge.email_key }, state: "verified",
          verified_at: "$$NOW", revision: (old?.revision ?? 0) + 1, created_at: old?.created_at ?? "$$NOW", updated_at: "$$NOW",
        } }], { upsert: true, session: transaction });
        await this.auth.audit("auth.email_bound", current.user!._id, current.user!._id, req, transaction);
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === 11000) fail(409, "EMAIL_ALREADY_BOUND", "已验证的目标邮箱不可绑定到其他账号");
      throw error;
    }
  }
  async remove(req: ApiRequest, currentPassword: string, expectedUserId: string) {
    const initial = await this.actionSession(req, "authenticated");
    if (initial.user!._id !== expectedUserId)
      fail(409, "AUTH_ACCOUNT_SWITCH_REQUIRED", "当前账号与操作页面身份不一致，请先重新核对账号");
    await this.confirmRate(req);
    await this.assertTransaction();
    if (!(await verifyPassword(initial.user!.password_hash, currentPassword))) fail(401, "INVALID_CREDENTIALS", "当前密码错误");
    await this.database.transaction(async transaction => {
      const current = await this.actionSession(req, "authenticated", transaction);
      if (current.user!._id !== expectedUserId)
        fail(409, "AUTH_ACCOUNT_SWITCH_REQUIRED", "当前账号与操作页面身份不一致，请先重新核对账号");
      if (current.user!._id !== initial.user!._id || current.user!.credential_version !== initial.user!.credential_version) fail(409, "IDENTITY_CHANGED", "账号凭据已变更，请重新认证");
      await revokeEmailChallenges(this.database.db, transaction, { user_id: current.user!._id, purpose: { $in: ["bind", "reset"] } });
      await emailCollections(this.database.db).identities.deleteMany({ user_id: current.user!._id }, { session: transaction });
      await this.auth.audit("auth.email_removed", current.user!._id, current.user!._id, req, transaction);
    });
  }
}
