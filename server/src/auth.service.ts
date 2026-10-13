import { newId, objectIdPattern } from "./database/object-id";
import { Injectable } from "@nestjs/common";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Response } from "express";
import type { ClientSession, Filter } from "mongodb";
import { Database } from "./database/database";
import {
  collections,
  AuthSession,
  User,
  normalizeLogin,
  validPassword,
} from "./database/contracts";
import { loadConfig } from "./config";
import { ApiRequest, fail } from "./errors";
import { dummyHash, hashPassword, verifyPassword } from "./security/password";
import { assertOperationalAccess } from "./operations/control";
import { activeMemberGrants, activeMemberRoles, assertAdministrationAccess, scopedBusinessCapabilities } from "./administration/authorization";
import { emailCollections } from "./auth-email/contracts";
import { maskedEmail, normalizeEmail } from "./auth-email/tokens";

const privacyActive: Filter<User> = {
  $or: [{ privacy_state: "active" }, { privacy_state: { $exists: false } }],
};
const studentConflictCapabilities: Readonly<Record<string, true | undefined>> = {
  "content:edit": true, "content:review": true, "assessment:manage": true, "assessment:review": true,
};

const alive = {
  revoked_at: null,
  $expr: {
    $and: [
      { $gt: ["$expires_at", "$$NOW"] },
      { $gt: ["$idle_expires_at", "$$NOW"] },
      { $gt: ["$absolute_expires_at", "$$NOW"] },
    ],
  },
};
const temporaryValid = {
  $or: [
    { $eq: ["$must_change_password", false] },
    { $gt: ["$temporary_password_expires_at", "$$NOW"] },
  ],
};
const secret = () => randomBytes(32).toString("base64url");
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export interface Identity {
  session: AuthSession;
  user: User;
}
@Injectable()
export class AuthService {
  readonly config = loadConfig();
  readonly c;
  readonly cookieName = this.config.secureCookie
    ? "__Host-kl_session"
    : "kl_dev_session";
  constructor(readonly database: Database) {
    this.c = collections(database.db);
  }
  origin(req: ApiRequest) {
    if (req.get("Origin") !== this.config.origin)
      fail(403, "ORIGIN_REJECTED", "请求来源无效");
  }
  csrf(req: ApiRequest, session: AuthSession) {
    const value = req.get("X-CSRF-Token");
    if (
      !value ||
      !/^[A-Za-z0-9_-]{43}$/.test(value) ||
      !timingSafeEqual(Buffer.from(value), Buffer.from(session.csrf_token))
    )
      fail(403, "CSRF_REJECTED", "安全令牌无效，请重新获取");
  }
  cookie(res: Response, token: string, expires: Date) {
    res.cookie(this.cookieName, token, {
      httpOnly: true,
      secure: this.config.secureCookie,
      sameSite: "lax",
      path: "/",
      expires,
    });
  }
  clear(res: Response) {
    res.clearCookie(this.cookieName, {
      httpOnly: true,
      secure: this.config.secureCookie,
      sameSite: "lax",
      path: "/",
    });
  }
  async session(req: ApiRequest, transaction?: ClientSession) {
    await assertOperationalAccess(this.database.db);
    const token: unknown = req.cookies?.[this.cookieName];
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
      return null;
    return this.c.sessions.findOne(
      { token_hash: digest(token), ...alive } as Filter<AuthSession>,
      { session: transaction },
    );
  }
  async rate(scope: string, key: string, limit: number, windowMs = 300000, response?: Response) {
    if (!Number.isSafeInteger(windowMs) || windowMs < 1000 || windowMs > 3600000) throw new Error("RATE_WINDOW_INVALID");
    await assertOperationalAccess(this.database.db);
    const id = createHmac("sha256", this.config.rateLimitKey)
      .update(`${scope}:${key}`)
      .digest("hex");
    const collection = this.database.db.collection("auth_rate_limits");
    const fresh = {
      $lte: [{ $ifNull: ["$expires_at", new Date(0)] }, "$$NOW"],
    };
    const pipeline = [
      {
        $set: {
          count: { $cond: [fresh, 1, { $add: ["$count", 1] }] },
          window_start: { $cond: [fresh, "$$NOW", "$window_start"] },
          expires_at: {
            $cond: [fresh, { $add: ["$$NOW", windowMs] }, "$expires_at"],
          },
        },
      },
    ];
    let row;
    try {
      row = await collection.findOneAndUpdate({ _id: id as never }, pipeline, {
        upsert: true,
        returnDocument: "after",
      });
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === 11000
      ))
        throw error;
      row = await collection.findOneAndUpdate({ _id: id as never }, pipeline, {
        returnDocument: "after",
      });
    }
    if (!row || row.count > limit) {
      if (response && row?.expires_at instanceof Date) {
        const clock = await this.database.db.aggregate<{ now: Date }>([
          { $documents: [{}] }, { $project: { _id: 0, now: "$$NOW" } },
        ]).next();
        if (!(clock?.now instanceof Date)) throw new Error("RATE_CLOCK_UNAVAILABLE");
        response.setHeader("Retry-After", String(Math.max(1, Math.ceil((row.expires_at.getTime() - clock.now.getTime()) / 1000))));
      }
      fail(429, "RATE_LIMITED", "尝试过于频繁，请稍后再试");
    }
  }
  async audit(
    action: string,
    actor: string,
    resource: string,
    req: ApiRequest,
    transaction?: ClientSession,
  ) {
    await assertOperationalAccess(this.database.db);
    const id = newId();
    await this.c.audit.updateOne(
      { _id: id },
      [
        {
          $set: {
            actor_id: actor,
            org_id: null,
            action,
            resource_id: resource,
            reason: "认证操作",
            request_id: req.requestId,
            created_at: "$$NOW",
          },
        },
      ],
      { upsert: true, session: transaction },
    );
  }
  async createSession(
    kind: AuthSession["kind"],
    user: User | null,
    transaction?: ClientSession,
  ): Promise<{ token: string; session: AuthSession }> {
    await assertOperationalAccess(this.database.db);
    if (user) {
      await assertAdministrationAccess(this.database.db, user._id, undefined, transaction);
      if (!transaction)
        return this.database.transaction((session) => this.createSession(kind, user, session));
      const fenced = await this.c.users.updateOne(
        { _id: user._id, status: "active", credential_version: user.credential_version, ...privacyActive, $expr: temporaryValid },
        { $inc: { identity_revision: 1 } },
        { session: transaction },
      );
      if (fenced.modifiedCount !== 1)
        fail(401, "SESSION_EXPIRED", "会话已失效，请重新登录");
    }
    const token = secret();
    const id = newId();
    const duration =
      kind === "preauth" ? this.config.preauthMs : this.config.idleMs;
    const absolute = kind === "preauth" ? duration : this.config.absoluteMs;
    await this.c.sessions.updateOne(
      { _id: id },
      [
        {
          $set: {
            token_hash: digest(token),
            kind,
            user_id: user?._id ?? null,
            credential_version: user?.credential_version ?? null,
            csrf_token: secret(),
            created_at: "$$NOW",
            last_seen_at: "$$NOW",
            idle_expires_at: { $add: ["$$NOW", duration] },
            absolute_expires_at: { $add: ["$$NOW", absolute] },
            expires_at: { $add: ["$$NOW", duration] },
            revoked_at: null,
          },
        },
      ],
      { upsert: true, session: transaction },
    );
    const session = await this.c.sessions.findOne(
      { _id: id },
      { session: transaction },
    );
    if (!session) throw new Error("会话写入未确认");
    return { token, session };
  }
  async getCsrf(req: ApiRequest, res: Response) {
    const origin = req.get("Origin");
    if (
      (origin && origin !== this.config.origin) ||
      req.get("Sec-Fetch-Site") === "cross-site"
    )
      fail(403, "ORIGIN_REJECTED", "请求来源无效");
    await this.rate("csrf", req.ip ?? "unknown", 60);
    let current = await this.session(req);
    if (current?.kind === "authenticated") {
      const user = await this.c.users.findOne({
        _id: current.user_id!,
        ...privacyActive,
        status: "active",
        credential_version: current.credential_version!,
        $expr: temporaryValid,
      });
      if (!user) current = null;
    }
    if (!current) {
      const created = await this.createSession("preauth", null);
      current = created.session;
      this.cookie(res, created.token, current.absolute_expires_at);
    }
    return { csrf_token: current.csrf_token, expires_at: current.expires_at };
  }
  async login(
    req: ApiRequest,
    res: Response,
    loginName: string,
    password: string,
  ) {
    this.origin(req);
    const preauth = await this.session(req);
    if (!preauth || preauth.kind !== "preauth")
      fail(403, "CSRF_REJECTED", "请先获取登录安全令牌");
    this.csrf(req, preauth);
    const email = loginName.includes("@") ? normalizeEmail(loginName) : null;
    const key = email?.key ?? normalizeLogin(loginName);
    await this.rate("login-ip", req.ip ?? "unknown", 30);
    await this.rate("login-user", key, 10);
    const emailIdentity = email
      ? await emailCollections(this.database.db).identities.findOne({ email_key: key, state: "verified" })
      : null;
    const user = email
      ? emailIdentity && await this.c.users.findOne({ _id: emailIdentity.user_id, ...privacyActive })
      : await this.c.users.findOne({ login_key: key, ...privacyActive });
    const matched = await verifyPassword(
      user?.password_hash ?? (await dummyHash()),
      password,
    );
    if (!user || !matched || user.status !== "active") {
      await this.audit("auth.login_failed", "anonymous", "authentication", req);
      fail(401, "INVALID_CREDENTIALS", "登录名或密码错误");
    }
    await assertAdministrationAccess(this.database.db, user._id);
    const created = await this.database.transaction(async (transaction) => {
      await assertAdministrationAccess(this.database.db, user._id, undefined, transaction);
      if (emailIdentity) {
        const currentEmail = await emailCollections(this.database.db).identities.findOne({
          _id: emailIdentity._id, user_id: user._id, email_key: key,
          state: "verified", revision: emailIdentity.revision,
        }, { session: transaction });
        if (!currentEmail) fail(401, "INVALID_CREDENTIALS", "登录名或密码错误");
      }
      const fence = await this.c.users.updateOne(
        {
          _id: user._id,
          ...privacyActive,
          identity_revision: user.identity_revision,
          credential_version: user.credential_version,
          status: "active",
          $expr: temporaryValid,
        },
        { $inc: { identity_revision: 1 } },
        { session: transaction },
      );
      if (fence.modifiedCount !== 1)
        fail(401, "INVALID_CREDENTIALS", "登录名或密码错误");
      const consumed = await this.c.sessions.updateOne(
        { _id: preauth._id, ...alive } as Filter<AuthSession>,
        [{ $set: { revoked_at: "$$NOW" } }],
        { session: transaction },
      );
      if (consumed.modifiedCount !== 1)
        fail(403, "CSRF_REJECTED", "登录令牌已失效");
      const result = await this.createSession(
        "authenticated",
        user,
        transaction,
      );
      await this.audit(
        "auth.login",
        user._id,
        result.session._id,
        req,
        transaction,
      );
      return result;
    });
    this.cookie(res, created.token, created.session.absolute_expires_at);
    return {
      user_id: user._id,
      must_change_password: user.must_change_password,
      session_expires_at: created.session.expires_at,
    };
  }
  async identify(
    req: ApiRequest,
    touch = true,
    transaction?: ClientSession,
  ): Promise<Identity> {
    if (touch && !transaction)
      return this.database.transaction((session) => this.identify(req, touch, session));
    const session = await this.session(req, transaction);
    if (!session || session.kind !== "authenticated")
      fail(401, "SESSION_EXPIRED", "会话已失效，请重新登录");
    const user = await this.c.users.findOne(
      {
        _id: session.user_id!,
        ...privacyActive,
        credential_version: session.credential_version!,
        status: "active",
        $expr: temporaryValid,
      },
      { session: transaction },
    );
    if (!user) fail(401, "SESSION_EXPIRED", "会话已失效，请重新登录");
    await assertAdministrationAccess(this.database.db, user._id, undefined, transaction);
    if (touch) {
      await this.touch(session, false, transaction);
      user.identity_revision += 1;
    }
    return { session, user };
  }
  async touch(
    session: AuthSession,
    force: boolean,
    transaction?: ClientSession,
  ): Promise<AuthSession> {
    await assertOperationalAccess(this.database.db);
    if (!transaction)
      return this.database.transaction((transaction) => this.touch(session, force, transaction));
    if (session.kind === "authenticated") {
      const fenced = await this.c.users.updateOne(
        { _id: session.user_id!, status: "active", credential_version: session.credential_version!, ...privacyActive, $expr: temporaryValid },
        { $inc: { identity_revision: 1 } },
        { session: transaction },
      );
      if (fenced.modifiedCount !== 1)
        fail(401, "SESSION_EXPIRED", "会话已失效，请重新登录");
    }
    const filter: Filter<AuthSession> = {
      _id: session._id,
      ...alive,
    } as Filter<AuthSession>;
    if (!force)
      filter.$and = [
        {
          $expr: {
            $lte: [
              "$last_seen_at",
              { $subtract: ["$$NOW", this.config.touchMs] },
            ],
          },
        },
      ];
    const next = {
      $min: [{ $add: ["$$NOW", this.config.idleMs] }, "$absolute_expires_at"],
    };
    const changed = await this.c.sessions.findOneAndUpdate(
      filter,
      [
        {
          $set: {
            last_seen_at: "$$NOW",
            idle_expires_at: next,
            expires_at: next,
          },
        },
      ],
      { returnDocument: "after", session: transaction },
    );
    if (force && !changed)
      fail(401, "SESSION_EXPIRED", "会话已失效，请重新登录");
    return changed ?? session;
  }
  async refresh(req: ApiRequest) {
    this.origin(req);
    return this.database.transaction(async (transaction) => {
      const identity = await this.identify(req, false, transaction);
      this.csrf(req, identity.session);
      await this.fenceUser(identity.user, transaction);
      const updated = await this.touch(identity.session, true, transaction);
      return { session_expires_at: updated.expires_at };
    });
  }
  async logout(req: ApiRequest, res: Response) {
    this.origin(req);
    try {
      await this.database.transaction(async (transaction) => {
        const session = await this.session(req, transaction);
        if (!session) return;
        this.csrf(req, session);
        await this.c.sessions.updateOne(
          { _id: session._id, ...alive } as Filter<AuthSession>,
          [{ $set: { revoked_at: "$$NOW" } }],
          { session: transaction },
        );
        await this.audit(
          "auth.logout",
          session.user_id ?? "anonymous",
          session._id,
          req,
          transaction,
        );
      });
    } catch (error) {
      if (error && typeof error === "object" && "getStatus" in error)
        throw error;
      fail(503, "AUTH_STATE_UNCONFIRMED", "服务端退出状态未确认，请稍后重试");
    }
    this.clear(res);
  }
  async changePassword(
    req: ApiRequest,
    res: Response,
    current: string,
    next: string,
  ) {
    this.origin(req);
    const identity = await this.identify(req, false);
    this.csrf(req, identity.session);
    await this.rate("password", identity.user._id, 5);
    if (!validPassword(next))
      fail(422, "VALIDATION_ERROR", "新密码须为6至128字符且不超过512字节");
    if (!(await verifyPassword(identity.user.password_hash, current)))
      fail(401, "INVALID_CREDENTIALS", "当前密码错误");
    if (current === next)
      fail(422, "VALIDATION_ERROR", "新密码不能与当前密码相同");
    const hashed = await hashPassword(next);
    await this.database.transaction(async (transaction) => {
      const live = await this.session(req, transaction);
      if (!live || live._id !== identity.session._id)
        fail(401, "SESSION_EXPIRED", "会话已失效");
      const user = identity.user;
      const changed = await this.c.users.updateOne(
        {
          _id: user._id,
          ...privacyActive,
          credential_version: user.credential_version,
          identity_revision: user.identity_revision,
          status: "active",
          $expr: temporaryValid,
        },
        [
          {
            $set: {
              password_hash: { $literal: hashed },
              credential_version: { $add: ["$credential_version", 1] },
              identity_revision: { $add: ["$identity_revision", 1] },
              must_change_password: false,
              temporary_password_expires_at: null,
              password_changed_at: "$$NOW",
              updated_at: "$$NOW",
            },
          },
        ],
        { session: transaction },
      );
      if (changed.modifiedCount !== 1)
        fail(409, "IDENTITY_CHANGED", "账号状态已变化，请重新认证");
      await this.c.sessions.updateMany(
        { user_id: user._id, revoked_at: null },
        [{ $set: { revoked_at: "$$NOW" } }],
        { session: transaction },
      );
      await this.audit(
        "auth.password_changed",
        user._id,
        user._id,
        req,
        transaction,
      );
    });
    this.clear(res);
  }
  async fenceUser(user: User, transaction: ClientSession) {
    await assertOperationalAccess(this.database.db);
    await assertAdministrationAccess(this.database.db, user._id, undefined, transaction);
    const result = await this.c.users.updateOne(
      {
        _id: user._id,
        ...privacyActive,
        status: "active",
        identity_revision: user.identity_revision,
        credential_version: user.credential_version,
        $expr: temporaryValid,
      },
      { $inc: { identity_revision: 1 } },
      { session: transaction },
    );
    if (result.modifiedCount !== 1)
      fail(409, "IDENTITY_CHANGED", "账号状态已变化，请重试");
  }
  async authorize(
    identity: Identity,
    orgId: string,
    capability: string,
    transaction: ClientSession,
  ): Promise<string[]> {
    if (identity.user.must_change_password)
      fail(403, "PASSWORD_CHANGE_REQUIRED", "请先修改临时密码");
    if (!objectIdPattern.test(orgId))
      fail(403, "FORBIDDEN", "无权访问该组织");
    await assertAdministrationAccess(this.database.db, identity.user._id, orgId, transaction);
    const member = await this.c.members.findOne(
      { org_id: orgId, user_id: identity.user._id, status: "active" },
      { session: transaction },
    );
    const org = await this.c.organizations.findOne(
      { _id: orgId, status: "active" },
      { session: transaction },
    );
    if (!member || !org) fail(403, "FORBIDDEN", "无权访问该组织");
    const assignments = await activeMemberRoles(
      this.database.db, { org_id: orgId, member_id: member._id }, transaction,
    );
    const roles = await this.c.roles
      .find(
        { _id: { $in: assignments.map((r) => r.role_id) } },
        { session: transaction },
      )
      .toArray();
    const grants = await activeMemberGrants(
      this.database.db, { org_id: orgId, member_id: member._id }, transaction,
    );
    const capabilities = [
      ...new Set([...roles.flatMap((r) => r.capabilities), ...grants.map(grant => grant.capability as string)]),
    ].sort();
    if (identity.user._id.startsWith('system:') || capabilities.some(c => c === 'assessment:worker' || c === 'learning:projection-worker'))
      fail(403, 'FORBIDDEN', '内部身份及能力不得用于HTTP');
    if (!capabilities.includes(capability))
      fail(403, "FORBIDDEN", "无权执行该操作");
    await this.fenceUser(identity.user, transaction);
    const fenced = await this.c.members.updateOne(
      {
        _id: member._id,
        org_id: orgId,
        status: "active",
        authorization_revision: member.authorization_revision,
      },
      { $inc: { authorization_revision: 1 } },
      { session: transaction },
    );
    if (fenced.modifiedCount !== 1)
      fail(409, "AUTHORIZATION_CHANGED", "组织权限已变化，请重试");
    await this.c.organizations.updateOne(
      { _id: orgId, status: "active" },
      [{ $set: { updated_at: "$$NOW" } }],
      { session: transaction },
    );
    return capabilities;
  }
  async me(req: ApiRequest) {
    return this.database.transaction(async (transaction) => {
      const identity = await this.identify(req, true, transaction);
      const emailIdentity = await emailCollections(this.database.db).identities.findOne(
        { user_id: identity.user._id }, { session: transaction, sort: { revision: -1 } },
      );
      const admission = await emailCollections(this.database.db).admissions.findOne(
        { user_id: identity.user._id }, { session: transaction },
      );
      const user = {
        id: identity.user._id,
        display_name: identity.user.display_name,
        login_name: identity.user.login_key,
        email: {
          state: emailIdentity?.state ?? "unbound",
          masked: emailIdentity ? maskedEmail(emailIdentity.email_display) : null,
        },
        admission: {
          state: admission ? "adult_self_declared" : "not_recorded",
          age_band: admission?.age_band ?? null,
          source: admission?.source ?? null,
          terms_version: admission?.terms_version ?? null,
          privacy_notice_version: admission?.privacy_notice_version ?? null,
          accepted_at: admission?.accepted_at ?? null,
        },
      };
      if (identity.user.must_change_password)
        return {
          user,
          organizations: [],
          context: null,
          must_change_password: true,
        };
      const members = await this.c.members
        .find(
          { user_id: identity.user._id, status: "active" },
          { session: transaction },
        )
        .toArray();
      const orgs = await this.c.organizations
        .find(
          { _id: { $in: members.map((m) => m.org_id) }, status: "active" },
          { session: transaction },
        )
        .toArray();
      const orgId = req.get("X-Org-Id");
      let context = null;
      if (orgId) {
        const capabilities = await this.authorize(identity, orgId, "account:read", transaction);
        // The active organization list is already proven in this transaction's snapshot.
        // Without a platform membership there can be no scoped platform grant; standalone
        // has no snapshot, so it retains the full current authorization path.
        const scoped = transaction.inTransaction() && !orgs.some(org => org.kind === "platform")
          ? []
          : await scopedBusinessCapabilities(this.database.db, identity.user._id, orgId, transaction);
        context = {
          org_id: orgId,
          capabilities,
          student_conflict: capabilities.some(capability => studentConflictCapabilities[capability] === true) ||
            scoped.some(capability => studentConflictCapabilities[capability] === true),
        };
      }
      return {
        user,
        organizations: orgs.map((o) => ({
          id: o._id,
          name: o.name,
          kind: o.kind,
        })),
        context,
        must_change_password: false,
      };
    });
  }
}
