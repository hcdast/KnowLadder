"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { newId } = require("../dist/database/object-id.js");
const {
  fixture,
  Browser,
  status,
  error,
  guardedUri,
  PASSWORD,
} = require("./helpers.cjs");

// One sequential suite: process.env is global, each child owns a fresh guarded database.
test(
  "阶段一：真实 MongoDB 副本集 HTTP 与 CLI 行为",
  { concurrency: false, timeout: 600000 },
  async (t) => {
    guardedUri(process.env.TEST_MONGODB_URI);

    await t.test("F01 两个真实迁移执行器并发仍只有一份完成版本", async (t) => {
      const f = await fixture(t, { migrated: false, app: false });
      const { assertSchema } = require("../dist/migrations/schema.js");
      const outcomes = await Promise.allSettled([
        f.migrate(f.uri),
        f.migrate(f.uri),
      ]);
      assert.ok(
        outcomes.some((outcome) => outcome.status === "fulfilled"),
        "至少一个执行器应完成迁移",
      );
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          assert.equal(
            outcome.reason?.message,
            "ObjectId initializer busy",
            "竞争失败只能是明确的租约冲突",
          );
        }
      }
      // A late executor may legitimately observe completed and succeed idempotently.
      await f.migrate(f.uri);
      await assertSchema(f.db);
      const rows = await f.db.collection("schema_migrations").find().toArray();
      for (const row of rows) {
        assert.equal(row.status, "completed");
        assert.equal(row.lease_token, null);
        assert.equal(row.lease_until, null);
        assert.ok(row.completed_at instanceof Date);
      }
    });

    await t.test(
      "F01 活跃租约拒绝抢占、过期租约可恢复、checksum漂移拒绝",
      async (t) => {
        const f = await fixture(t, { migrated: false, app: false });
        const { assertSchema, OBJECT_ID_SCHEMAS, OBJECT_ID_CHECKSUM } = require("../dist/migrations/schema.js");
        const { initializeObjectId } = require("../dist/migrations/object-id-v10.js");
        const { ROLE_CAPABILITIES } = require("../dist/database/contracts.js");
        const initializeBase = () => initializeObjectId(f.uri, OBJECT_ID_SCHEMAS, OBJECT_ID_CHECKSUM, ROLE_CAPABILITIES);
        await initializeBase();
        const migrations = f.db.collection("schema_migrations");
        const original = await migrations.findOne({ version: 10, status: "completed" });
        assert.ok(original);
        const leaseToken = randomUUID();
        await migrations.updateOne({ _id: original._id }, [
          {
            $set: {
              status: "running",
              lease_token: leaseToken,
              lease_until: { $add: ["$$NOW", 120000] },
              started_at: "$$NOW",
              completed_at: null,
              failed_at: null,
            },
          },
        ]);
        const held = await migrations.findOne({ _id: original._id });
        await assert.rejects(initializeBase());
        assert.deepEqual(
          await migrations.findOne({ _id: original._id }),
          held,
          "被拒绝的执行器不得篡改持有者状态",
        );
        await migrations.updateOne(
          { _id: original._id, lease_token: leaseToken },
          [
            {
              $set: {
                started_at: { $subtract: ["$$NOW", 2000] },
                lease_until: { $subtract: ["$$NOW", 1000] },
              },
            },
          ],
        );
        await initializeBase();
        const recovered = await migrations.findOne({ _id: original._id });
        assert.equal(recovered.status, "completed");
        assert.equal(recovered.lease_token, null);
        assert.equal(recovered.lease_until, null);
        assert.equal(await migrations.countDocuments({ version: 10 }), 1);
        await f.migrate(f.uri);
        await assertSchema(f.db);
        const alteredChecksum = `${original.checksum[0] === "0" ? "1" : "0"}${original.checksum.slice(1)}`;
        await migrations.updateOne(
          { _id: original._id },
          { $set: { checksum: alteredChecksum } },
        );
        await assert.rejects(assertSchema(f.db));
        await assert.rejects(f.migrate(f.uri));
        assert.equal(
          (await migrations.findOne({ _id: original._id })).checksum,
          alteredChecksum,
          "迁移不得自动覆盖checksum漂移",
        );
      },
    );

    await t.test(
      "F01 迁移可重复且数据库格式与唯一约束仍生效",
      async (t) => {
        const f = await fixture(t, { app: false });
        await f.migrate(f.uri);
        for (const name of [
          "users",
          "organizations",
          "organization_members",
          "member_roles",
          "auth_sessions",
          "audit_events",
        ]) {
          await assert.rejects(
            f.db
              .collection(name)
              .insertOne({ _id: newId(), unexpected: true }),
            (e) => e.code === 121,
          );
        }
        const user = await f.user();
        await assert.rejects(
          f.ops.createUser(f.context, {
            login_name: ` ${user.login_name.toUpperCase()} `,
            display_name: "重复用户",
          }),
        );
        assert.equal(await f.db.collection("users").countDocuments(), 1);
      },
    );

    await t.test("F01 未迁移和关键唯一索引缺失时不就绪", async (t) => {
      const f = await fixture(t, { migrated: false, app: false });
      await assert.rejects(f.createApp());
      await f.migrate(f.uri);
      const indexes = await f.db.collection("users").listIndexes().toArray();
      const loginIndex = indexes.find(
        (index) => index.unique && index.key.login_key === 1,
      );
      assert.ok(loginIndex, "登录名必须有数据库唯一索引");
      await f.db.collection("users").dropIndex(loginIndex.name);
      await assert.rejects(f.createApp());
      await assert.rejects(f.migrate(f.uri));
      await f.db
        .collection("users")
        .createIndex(loginIndex.key, { name: loginIndex.name, unique: true });
      await f.start();
    });

    await t.test(
      "F02/F03 首次改密、cookie轮换、禁止旧密码、身份不泄露",
      async (t) => {
        const f = await fixture(t);
        const b = f.browser;
        const user = await f.user();
        const org = await f.ops.createOrganization(f.context, {
          name: "首次改密组织",
          kind: "school",
        });
        await f.ops.setMembership(f.context, {
          user_id: user.user_id,
          org_id: org.organization_id,
          roles: ["student"],
        });
        const csrf = await b.prepare();
        assert.ok(
          csrf.headers
            .getSetCookie()
            .some(
              (value) => /HttpOnly/i.test(value) && /SameSite=Lax/i.test(value),
            ),
          "开发Cookie仍须HttpOnly和SameSite",
        );
        const preauth = b.clone();
        const login = await b.login(user.login_name, user.secret);
        status(login, 200);
        assert.equal(login.data.data.must_change_password, true);
        assert.ok(
          b.cookies.get("kl_dev_session") !==
            preauth.cookies.get("kl_dev_session"),
          "登录必须轮换cookie",
        );
        const restricted = await b.request("/me");
        status(restricted, 200);
        assert.deepEqual(restricted.data.data.organizations, []);
        assert.equal(restricted.data.data.context, null);
        const restrictedOrg = await b.request("/me", {
          headers: { "X-Org-Id": org.organization_id },
        });
        status(restrictedOrg, 200);
        assert.equal(restrictedOrg.data.data.context, null);
        assert.deepEqual(restrictedOrg.data.data.organizations, []);
        error(await preauth.login(user.login_name, user.secret), 403);
        await b.prepare();
        const oldSession = b.clone();
        status(
          await b.request("/auth/change-password", {
            method: "POST",
            body: { current_password: user.secret, new_password: PASSWORD },
          }),
          204,
        );
        error(await oldSession.request("/me"), 401);
        await b.prepare();
        error(await b.login(user.login_name, user.secret), 401);
        status(await b.login(user.login_name, PASSWORD), 200);
        await b.prepare();
        const me = await b.request("/me", {
          headers: { "X-Org-Id": org.organization_id },
        });
        status(me, 200);
        assert.equal(me.data.data.user.id, user.user_id);
        assert.equal(me.data.data.must_change_password, false);
        assert.ok(me.data.data.context.capabilities.includes("learning:self"));
        const serialized = JSON.stringify(me.data);
        for (const secret of [
          user.secret,
          PASSWORD,
          "password_hash",
          "token_hash",
        ])
          assert.ok(!serialized.includes(secret), "身份响应不得包含凭据");
        const stored = await f.db
          .collection("auth_sessions")
          .findOne(f.session(b));
        assert.ok(stored);
        assert.ok(
          !JSON.stringify(stored).includes(b.cookies.get("kl_dev_session")),
          "Mongo不得保存原始会话token",
        );
      },
    );

    await t.test(
      "F04 API重启保留会话，退出不恢复，重新登录使用新会话",
      async (t) => {
        const f = await fixture(t);
        const user = await f.authenticated();
        const original = f.browser.clone();
        await f.app.close();
        f.apps.splice(f.apps.indexOf(f.app), 1);
        const restarted = await f.start();
        const b = original.clone(restarted.browser.base);
        status(await b.request("/me"), 200);
        status(await b.request("/auth/logout", { method: "POST" }), 204);
        error(await original.clone(b.base).request("/me"), 401);
        await b.prepare();
        status(await b.login(user.login_name, PASSWORD), 200);
        assert.ok(
          b.cookies.get("kl_dev_session") !==
            original.cookies.get("kl_dev_session"),
        );
        assert.equal(
          await f.db.collection("users").countDocuments(),
          1,
          "重启不得生成默认账户",
        );
      },
    );

    await t.test(
      "F02/F05/F06 两组织隔离、实时角色替换与成员禁用",
      async (t) => {
        const f = await fixture(t);
        const user = await f.authenticated();
        const b = f.browser;
        const a = await f.ops.createOrganization(f.context, {
          name: "学校A",
          kind: "school",
        });
        const other = await f.ops.createOrganization(f.context, {
          name: "学校B",
          kind: "school",
        });
        const membership = await f.ops.setMembership(f.context, {
          user_id: user.user_id,
          org_id: a.organization_id,
          roles: ["content_editor"],
        });
        const headers = { "X-Org-Id": a.organization_id };
        let me = await b.request("/me", { headers });
        status(me, 200);
        assert.ok(me.data.data.context.capabilities.includes("content:edit"));
        error(
          await b.request("/me", {
            headers: { "X-Org-Id": other.organization_id },
          }),
          403,
        );
        const current = await f.db
          .collection("organization_members")
          .findOne({ _id: membership.member_id });
        await f.ops.setMembership(f.context, {
          user_id: user.user_id,
          org_id: a.organization_id,
          roles: ["content_reviewer"],
          reviewer_valid_to: new Date(Date.now() + 7 * 86400000),
          expected_revision: current.authorization_revision,
        });
        me = await b.request("/me", { headers });
        status(me, 200);
        assert.ok(me.data.data.context.capabilities.includes("content:review"));
        assert.ok(!me.data.data.context.capabilities.includes("content:edit"));
        const latest = await f.db
          .collection("organization_members")
          .findOne({ _id: membership.member_id });
        await f.ops.setMembership(f.context, {
          user_id: user.user_id,
          org_id: a.organization_id,
          roles: ["content_reviewer"],
          reviewer_valid_to: new Date(Date.now() + 7 * 86400000),
          status: "disabled",
          expected_revision: latest.authorization_revision,
        });
        error(await b.request("/me", { headers }), 403);
        me = await b.request("/me");
        status(me, 200);
        assert.ok(
          !me.data.data.organizations.some(
            (org) => org.id === a.organization_id,
          ),
        );
        for (const invalidOrgId of ['{"$ne":null}', randomUUID(), "ABCDEF0123456789ABCDEF01", "not-an-id"]) {
          const denied = await b.request("/me", { headers: { "X-Org-Id": invalidOrgId } });
          error(denied, 403);
          assert.equal(denied.data.error.code, "FORBIDDEN");
        }
      },
    );

    await t.test("F06 Origin/CSRF与NoSQL、超长、未知DTO字段拒绝", async (t) => {
      const f = await fixture(t);
      const user = await f.user();
      const b = f.browser;
      await b.prepare();
      const body = { login_name: user.login_name, password: user.secret };
      for (const options of [
        { origin: null },
        { origin: "https://attacker.invalid" },
        { csrf: null },
        { csrf: "forged" },
      ]) {
        error(
          await b.request("/auth/login", { method: "POST", body, ...options }),
          403,
        );
      }
      for (const invalid of [
        { login_name: { $ne: null }, password: user.secret },
        { ...body, password: { $gt: "" } },
        { ...body, login_name: "x".repeat(10000) },
        { ...body, admin: true },
      ]) {
        error(
          await b.request("/auth/login", { method: "POST", body: invalid }),
          422,
        );
      }
      status(await b.login(user.login_name, user.secret), 200);
    });

    await t.test("F07 未知账号与错密统一401，无敏感回显", async (t) => {
      const f = await fixture(t);
      const user = await f.user();
      const b = f.browser;
      await b.prepare();
      const wrong = await b.login(
        user.login_name,
        "wrong-password-integration",
      );
      const missing = await b.login(
        "unknown_integration_user",
        "wrong-password-integration",
      );
      error(wrong, 401);
      error(missing, 401);
      assert.deepEqual(wrong.data.error, missing.data.error);
      for (const result of [wrong, missing]) {
        const text = JSON.stringify(result.data);
        assert.ok(
          !text.includes(user.login_name) &&
            !text.includes("wrong-password-integration") &&
            !text.includes(user.secret),
          "认证错误不回显输入",
        );
      }
    });

    await t.test("F07 Mongo限流跨两个API实例共享而非内存计数", async (t) => {
      const f = await fixture(t);
      const second = await f.start();
      const a = f.browser;
      await a.prepare();
      const b = a.clone(second.browser.base);
      for (let i = 0; i < 10; i++)
        error(
          await (i % 2 ? a : b).login("same_unknown_account", PASSWORD),
          401,
        );
      const limited = await b.login("same_unknown_account", PASSWORD);
      error(limited, 429);
      assert.ok(
        Number(limited.headers.get("retry-after")) > 0,
        "429须返回正数Retry-After",
      );
    });
    await t.test("F07 更换用户名仍受跨实例IP总额度约束", async (t) => {
      const f = await fixture(t);
      const second = await f.start();
      await f.browser.prepare();
      const b = f.browser.clone(second.browser.base);
      for (let i = 0; i < 30; i++)
        error(
          await (i % 2 ? b : f.browser).login(`unknown_account_${i}`, PASSWORD),
          401,
        );
      const limited = await b.login("another_unknown_account", PASSWORD);
      error(limited, 429);
      assert.ok(Number(limited.headers.get("retry-after")) > 0);
    });

    await t.test(
      "F07 CSRF频率在两个实例共享，不能经新cookie绕过",
      async (t) => {
        const f = await fixture(t);
        const second = await f.start();
        for (let i = 0; i < 60; i++)
          status(
            await (i % 2 ? f.browser : second.browser).request("/auth/csrf"),
            200,
          );
        const limited = await new Browser(second.browser.base).request(
          "/auth/csrf",
        );
        error(limited, 429);
        assert.ok(Number(limited.headers.get("retry-after")) > 0);
      },
    );

    await t.test("F07 改密失败次数按账户共享，不能跨实例绕过", async (t) => {
      const f = await fixture(t);
      await f.authenticated();
      const second = await f.start();
      const b = f.browser.clone(second.browser.base);
      const body = {
        current_password: "incorrect-current-password",
        new_password: PASSWORD,
      };
      // authenticated()已经成功改密一次，该操作也计入每五分钟五次额度。
      for (let i = 0; i < 4; i++)
        error(
          await (i % 2 ? b : f.browser).request("/auth/change-password", {
            method: "POST",
            body,
          }),
          401,
        );
      const limited = await b.request("/auth/change-password", {
        method: "POST",
        body,
      });
      error(limited, 429);
      assert.ok(Number(limited.headers.get("retry-after")) > 0);
    });

    await t.test("F05 同一预认证并发登录最多产生一个成功会话", async (t) => {
      const f = await fixture(t);
      const user = await f.user();
      await f.browser.prepare();
      const browsers = [f.browser.clone(), f.browser.clone()];
      const results = await Promise.all(
        browsers.map((b) => b.login(user.login_name, user.secret)),
      );
      assert.equal(results.filter((result) => result.status === 200).length, 1);
      assert.ok(
        results.every((result) => [200, 401, 403, 409].includes(result.status)),
        "竞争失败不能伪装为503",
      );
      const live = await f.db.collection("auth_sessions").countDocuments({
        user_id: user.user_id,
        revoked_at: null,
        kind: "authenticated",
      });
      assert.equal(live, 1);
    });

    await t.test("F05 并发禁用和旧密码登录不会复活身份", async (t) => {
      const f = await fixture(t);
      const user = await f.authenticated();
      const existing = f.browser.clone();
      const contender = new Browser(f.browser.base);
      await contender.prepare();
      const [login] = await Promise.all([
        contender.login(user.login_name, PASSWORD),
        f.ops.setUserStatus(f.context, {
          user_id: user.user_id,
          status: "disabled",
        }),
      ]);
      assert.ok([200, 401, 403, 409].includes(login.status));
      error(await existing.request("/me"), 401);
      error(await contender.request("/me"), 401);
      await contender.prepare();
      error(await contender.login(user.login_name, PASSWORD), 401);
    });

    await t.test(
      "F05 并发重置与旧密码登录：已签发会话也即时失效",
      async (t) => {
        const f = await fixture(t);
        const user = await f.authenticated();
        const existing = f.browser.clone();
        const contender = new Browser(f.browser.base);
        await contender.prepare();
        const before = await f.db.collection("users").findOne({ _id: user.user_id });
        const [loginAttempt, resetAttempt] = await Promise.allSettled([
          contender.login(user.login_name, PASSWORD),
          f.ops.resetPassword(f.context, { user_id: user.user_id }),
        ]);
        assert.equal(loginAttempt.status, "fulfilled");
        const login = loginAttempt.value;
        let reset;
        if (resetAttempt.status === "rejected") {
          // A concurrent login may win the identity fence. A rejected reset must
          // leave credentials unchanged; a new, explicitly requested reset reads
          // the current identity instead of replaying the rejected operation.
          assert.equal(resetAttempt.reason.code, "INVALID_OPERATION");
          const unchanged = await f.db.collection("users").findOne({ _id: user.user_id });
          assert.equal(unchanged.credential_version, before.credential_version);
          reset = await f.ops.resetPassword(f.context, { user_id: user.user_id });
        } else reset = resetAttempt.value;
        const changed = await f.db.collection("users").findOne({ _id: user.user_id });
        assert.equal(changed.credential_version, before.credential_version + 1);
        assert.ok([200, 401, 403, 409].includes(login.status));
        error(await existing.request("/me"), 401);
        error(await contender.request("/me"), 401);
        await contender.prepare();
        error(await contender.login(user.login_name, PASSWORD), 401);
        status(await contender.login(user.login_name, reset.secret), 200);
        const me = await contender.request("/me");
        status(me, 200);
        assert.equal(me.data.data.must_change_password, true);
      },
    );

    await t.test("S5 隐私屏障阻止旧登录、会话续期和改密", async (t) => {
      const f = await fixture(t);
      for (const privacy_state of ["erasing", "erased"]) {
        const user = await f.authenticated();
        const stale = f.browser.clone();
        const sessionFilter = f.session(stale);
        const before = await f.db.collection("auth_sessions").findOne(sessionFilter);
        const sessionCount = await f.db.collection("auth_sessions").countDocuments({ user_id: user.user_id });
        // Keep status and credential versions unchanged: the privacy barrier itself must reject access.
        await f.db.collection("users").updateOne({ _id: user.user_id }, { $set: { privacy_state } });
        error(await stale.request("/me"), 401);
        error(await stale.request("/auth/refresh", { method: "POST" }), 401);
        error(await stale.request("/auth/change-password", {
          method: "POST",
          body: { current_password: PASSWORD, new_password: `${PASSWORD}-new` },
        }), 401);
        const contender = new Browser(f.browser.base);
        await contender.prepare();
        error(await contender.login(user.login_name, PASSWORD), 401);
        assert.deepEqual(await f.db.collection("auth_sessions").findOne(sessionFilter), before);
        assert.equal(await f.db.collection("auth_sessions").countDocuments({ user_id: user.user_id }), sessionCount);
      }
    });

    await t.test("S5 erasing/erased 用户不可经管理员密码、启用、成员或能力操作复活", async (t) => {
      const f = await fixture(t, { app: false });
      const user = await f.user();
      const org = await f.ops.createOrganization(f.context, { name: "隐私屏障组织", kind: "school" });
      const other = await f.ops.createOrganization(f.context, { name: "新成员目标组织", kind: "school" });
      const member = await f.ops.setMembership(f.context, {
        user_id: user.user_id, org_id: org.organization_id, roles: ["student"],
      });
      for (const privacy_state of ["erasing", "erased"]) {
        await f.db.collection("users").updateOne({ _id: user.user_id }, { $set: { privacy_state } });
        const beforeUser = await f.db.collection("users").findOne({ _id: user.user_id });
        const beforeMember = await f.db.collection("organization_members").findOne({ _id: member.member_id });
        const beforeRoles = await f.db.collection("member_roles").find({ member_id: member.member_id }).toArray();
        const auditCount = await f.db.collection("audit_events").countDocuments();
        const actions = [
          () => f.ops.resetPassword(f.context, { user_id: user.user_id }),
          () => f.ops.setUserStatus(f.context, { user_id: user.user_id, status: "active" }),
          () => f.ops.setMembership(f.context, {
            user_id: user.user_id, org_id: other.organization_id, roles: ["org_admin"],
          }),
          () => f.ops.setMembership(f.context, {
            user_id: user.user_id, org_id: org.organization_id, roles: ["org_admin"],
            expected_revision: member.authorization_revision,
          }),
          () => f.ops.setCapability(f.context, {
            member_id: member.member_id, org_id: org.organization_id, capability: "content:revoke",
            granted: true, valid_to: new Date(Date.now() + 3600000), expected_revision: member.authorization_revision,
          }),
        ];
        for (const action of actions) await assert.rejects(action, { code: "INVALID_OPERATION" });
        assert.deepEqual(await f.db.collection("users").findOne({ _id: user.user_id }), beforeUser);
        assert.deepEqual(await f.db.collection("organization_members").findOne({ _id: member.member_id }), beforeMember);
        assert.deepEqual(await f.db.collection("member_roles").find({ member_id: member.member_id }).toArray(), beforeRoles);
        assert.equal(await f.db.collection("organization_members").countDocuments({ user_id: user.user_id }), 1);
        assert.equal(await f.db.collection("member_capability_grants").countDocuments({ member_id: member.member_id }), 0);
        assert.equal(await f.db.collection("audit_events").countDocuments(), auditCount);
      }
    });

    await t.test("S5 普通 disabled 用户仍可重置临时密码并显式启用", async (t) => {
      const f = await fixture(t);
      const user = await f.user();
      await f.ops.setUserStatus(f.context, { user_id: user.user_id, status: "disabled" });
      const reset = await f.ops.resetPassword(f.context, { user_id: user.user_id });
      const disabled = await f.db.collection("users").findOne({ _id: user.user_id });
      assert.equal(disabled.status, "disabled");
      assert.equal(disabled.privacy_state, "active");
      await f.browser.prepare();
      error(await f.browser.login(user.login_name, reset.secret), 401);
      await f.ops.setUserStatus(f.context, { user_id: user.user_id, status: "active" });
      status(await f.browser.login(user.login_name, reset.secret), 200);
    });

    await t.test("S5 maintenance 禁止绕过 CLI 入口直接执行管理员写入", async (t) => {
      const environmentId = randomUUID();
      const f = await fixture(t, { app: false, env: { KL_ENVIRONMENT_ID: environmentId } });
      const user = await f.user();
      const before = await f.db.collection("users").findOne({ _id: user.user_id });
      const auditCount = await f.db.collection("audit_events").countDocuments();
      // Seed a validated maintenance state; this case exercises business admission, not the maintenance lifecycle.
      await f.db.collection("operational_state").updateOne({ _id: "environment" }, {
        $set: { environment_id: environmentId, mode: "maintenance", maintenance_token: randomUUID(), owner: "synthetic-test", updated_at: new Date() },
        $inc: { revision: 1 },
      });
      await assert.rejects(() => f.ops.resetPassword(f.context, { user_id: user.user_id }), /OPERATIONS_ACCESS_BLOCKED/);
      await assert.rejects(() => f.ops.setUserStatus(f.context, { user_id: user.user_id, status: "disabled" }), /OPERATIONS_ACCESS_BLOCKED/);
      await assert.rejects(() => f.ops.createOrganization(f.context, { name: "禁止新增", kind: "school" }), /OPERATIONS_ACCESS_BLOCKED/);
      assert.deepEqual(await f.db.collection("users").findOne({ _id: user.user_id }), before);
      assert.equal(await f.db.collection("organizations").countDocuments(), 0);
      assert.equal(await f.db.collection("audit_events").countDocuments(), auditCount);
    });

    await t.test("F08 TTL未删除时仍拒绝空闲及绝对过期会话", async (t) => {
      const f = await fixture(t);
      await f.authenticated();
      const other = new Browser(f.browser.base);
      await f.authenticated(other);
      // Per-test database only: defer TTL cleanup without bypassing document validators.
      await f.db.command({
        collMod: "auth_sessions",
        index: { name: "auth_sessions_expires_ttl", expireAfterSeconds: 3600 },
      });
      for (const [index, browser] of [f.browser, other].entries()) {
        const filter = f.session(browser);
        await f.db.collection("auth_sessions").updateOne(filter, [
          {
            $set: {
              created_at: { $subtract: ["$$NOW", 3000] },
              last_seen_at: { $subtract: ["$$NOW", 2000] },
              idle_expires_at: { $subtract: ["$$NOW", 1000] },
              expires_at: { $subtract: ["$$NOW", 1000] },
              absolute_expires_at:
                index === 0
                  ? { $add: ["$$NOW", 600000] }
                  : { $subtract: ["$$NOW", 1000] },
            },
          },
        ]);
        error(await browser.request("/me"), 401);
        assert.ok(
          await f.db.collection("auth_sessions").findOne(filter),
          "记录仍在库中，拒绝不能依赖TTL删除",
        );
      }
    });

    await t.test("F08 临时密码过期与预认证到期不依赖TTL", async (t) => {
      const f = await fixture(t);
      const user = await f.user();
      await f.browser.prepare();
      await f.db.collection("users").updateOne({ _id: user.user_id }, [
        {
          $set: {
            created_at: { $subtract: ["$$NOW", 3000] },
            password_changed_at: { $subtract: ["$$NOW", 2000] },
            temporary_password_expires_at: { $subtract: ["$$NOW", 1000] },
            updated_at: "$$NOW",
          },
        },
      ]);
      error(await f.browser.login(user.login_name, user.secret), 401);
      const valid = await f.user();
      await f.db.command({
        collMod: "auth_sessions",
        index: { name: "auth_sessions_expires_ttl", expireAfterSeconds: 3600 },
      });
      const preauth = f.session(f.browser);
      await f.db.collection("auth_sessions").updateOne(preauth, [
        {
          $set: {
            created_at: { $subtract: ["$$NOW", 3000] },
            last_seen_at: { $subtract: ["$$NOW", 2000] },
            idle_expires_at: { $subtract: ["$$NOW", 1000] },
            absolute_expires_at: { $subtract: ["$$NOW", 1000] },
            expires_at: { $subtract: ["$$NOW", 1000] },
          },
        },
      ]);
      error(await f.browser.login(valid.login_name, valid.secret), 403);
      assert.ok(
        await f.db.collection("auth_sessions").findOne(preauth),
        "过期预认证仍在Mongo中",
      );
    });

    await t.test(
      "F08 refresh不超过绝对期限，logout竞争不能复活会话",
      async (t) => {
        const f = await fixture(t);
        await f.authenticated();
        const b = f.browser;
        const filter = f.session(b);
        const absolute = new Date(Date.now() + 60000);
        await f.db.collection("auth_sessions").updateOne(filter, {
          $set: {
            absolute_expires_at: absolute,
            idle_expires_at: absolute,
            expires_at: absolute,
          },
        });
        const refreshed = await b.request("/auth/refresh", { method: "POST" });
        status(refreshed, 200);
        assert.ok(
          Date.parse(refreshed.data.data.session_expires_at) <=
            absolute.getTime(),
        );
        const after = await f.db.collection("auth_sessions").findOne(filter);
        assert.ok(
          after.idle_expires_at.getTime() <=
            after.absolute_expires_at.getTime(),
        );
        const stale = b.clone();
        const competing = b.clone();
        const [refresh, logout] = await Promise.all([
          competing.request("/auth/refresh", { method: "POST" }),
          b.request("/auth/logout", { method: "POST" }),
        ]);
        status(logout, 204);
        assert.ok(
          [200, 401, 403, 409].includes(refresh.status),
          "正常撤销竞争不应返回503",
        );
        error(await stale.request("/me"), 401);
        error(await competing.request("/me"), 401);
        assert.ok(
          [401, 403].includes(
            (await stale.request("/auth/refresh", { method: "POST" })).status,
          ),
        );
      },
    );

    await t.test(
      "F10 真实数据库连接丢失时logout返回503而非假成功",
      async (t) => {
        const f = await fixture(t);
        await f.authenticated();
        const { getConnectionToken } = require("@nestjs/mongoose");
        await f.app.get(getConnectionToken()).close();
        error(await f.browser.request("/auth/logout", { method: "POST" }), 503);
      },
    );

    await t.test(
      "F01 standalone拒绝迁移（可选独立服务）",
      { skip: !process.env.TEST_STANDALONE_MONGODB_URI },
      async () => {
        const uri = guardedUri(process.env.TEST_STANDALONE_MONGODB_URI);
        const { migrate } = require("../dist/migrations/schema.js");
        await assert.rejects(migrate(uri));
      },
    );
  },
);
