const { newId } = require("../dist/database/object-id");
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { administrationFixture, administrativeGrant, consoleRequest, status } = require("./administration-helpers.cjs");
const { error } = require("./helpers.cjs");
const { executeAdministrationOperation, AdministrationNeedsRecovery } = require("../dist/administration/operations.js");

const emptyPage = { items: [], next_cursor: null };
const beforeAllUsers = "000000000000000000000000";
const projection = { _id: 1, login_key: 1, display_name: 1, status: 1, identity_revision: 1 };
function lookup(actor, loginName, extra = {}) {
  return consoleRequest(actor, `/users?${new URLSearchParams({ login_name: loginName, ...extra })}`);
}
// The pre-query cursor protocol has sorted root keys and an empty normalized object.
// Construct it independently of page(), so adding a null filter cannot rewrite history.
function userCursor(actor, mode, after, loginName) {
  const value = { actor: actor.user.user_id, limit: 1, mode: `${actor.org}:${mode}`,
    normalized: loginName === undefined ? {} : { login_name: loginName }, resource: "users" };
  const bind = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return Buffer.from(JSON.stringify({ bind, after })).toString("base64url");
}
function planNodes(node) {
  if (!node || typeof node !== "object") return [];
  return [node, ...Object.values(node).flatMap(planNodes)];
}

for (const topology of ["replicaSet", "standalone"]) {
  test(`IAM ${topology}：精确登录名目录查询`, { timeout: 480000, concurrency: false }, async t => {
    const f = await administrationFixture(t, topology);
    await t.test("规范化精确匹配、最小响应与组织归属不泄漏", async () => {
      const name = f.studentA.user.login_name;
      const detail = await consoleRequest(f.accounts, `/users/${f.studentA.user.user_id}`);
      status(detail, 200);
      const { protected_account: protectedAccount, ...directoryUser } = detail.data.data;
      assert.equal(protectedAccount, false);
      const expected = { items: [directoryUser], next_cursor: null };
      for (const actor of [f.accounts, f.organizationAdmin]) {
        const found = await lookup(actor, `  ${name.toUpperCase()}  `, { limit: "1" });
        status(found, 200);
        assert.deepEqual(found.data.data, expected);
        assert.deepEqual(Object.keys(found.data.data.items[0]).sort(), ["display_name", "id", "identity_revision", "login_name", "status"]);
        const prefix = await lookup(actor, name.slice(0, -1));
        status(prefix, 200);
        assert.deepEqual(prefix.data.data, emptyPage, "不支持前缀或模糊匹配");
      }
      const foreign = await lookup(f.organizationAdmin, f.studentB.user.login_name);
      const missing = await lookup(f.organizationAdmin, `missing_${randomUUID().replaceAll("-", "")}`);
      status(foreign, 200); status(missing, 200);
      assert.deepEqual(foreign.data.data, emptyPage);
      assert.deepEqual(foreign.data.data, missing.data.data, "别组织存在与不存在的账号输出相同");
      const global = await lookup(f.accounts, f.studentB.user.login_name);
      status(global, 200);
      assert.deepEqual(global.data.data.items.map(row => row.id), [f.studentB.user.user_id]);
    });
    await t.test("停用账号和成员仍可管理，隐私退役主体不进入目录", async () => {
      const target = await f.ops.createUser(f.context, { login_name: `lookup_${randomUUID().replaceAll("-", "")}`, display_name: "IAM 精确查询状态边界" });
      await f.ops.setMembership(f.context, { user_id: target.user_id, org_id: f.schoolA, roles: ["student"], status: "disabled" });
      const users = f.db.collection("users");
      await f.ops.setUserStatus(f.context, { user_id: target.user_id, status: "disabled" });
      const row = await users.findOne({ _id: target.user_id });
      for (const actor of [f.accounts, f.organizationAdmin]) {
        const result = await lookup(actor, row.login_key);
        status(result, 200);
        assert.deepEqual(result.data.data, { items: [{ id: row._id, login_name: row.login_key, display_name: row.display_name,
          status: "disabled", identity_revision: row.identity_revision }], next_cursor: null });
      }
      for (const privacy_state of ["erasing", "erased"]) {
        await users.updateOne({ _id: target.user_id }, { $set: { privacy_state } });
        for (const actor of [f.accounts, f.organizationAdmin]) {
          const result = await lookup(actor, row.login_key);
          status(result, 200);
          assert.deepEqual(result.data.data, emptyPage);
          error(await consoleRequest(actor, `/users/${target.user_id}`), 404);
        }
      }
      await users.updateOne({ _id: target.user_id }, { $unset: { privacy_state: "" } }, { bypassDocumentValidation: true });
      const legacy = await lookup(f.organizationAdmin, row.login_key);
      status(legacy, 200);
      assert.deepEqual(legacy.data.data.items.map(user => user.id), [target.user_id], "兼容旧主体缺省 privacy_state");
      await users.updateOne({ _id: target.user_id }, { $set: { privacy_state: "active" } });
    });
    await t.test("纯治理、业务和普通身份不得通过精确名获得目录", async () => {
      await administrativeGrant(f, f.business, "report:read", [f.schoolA]);
      const businessContext = await consoleRequest(f.business, "/context");
      status(businessContext, 200);
      assert.ok(businessContext.data.data.grants.some(grant => grant.capability === "report:read" && grant.scope.organization_ids.includes(f.schoolA)));
      for (const actor of [f.governor, f.approver, f.business, f.studentA]) {
        error(await lookup(actor, f.studentA.user.login_name), 403);
        error(await lookup(actor, "invalid.name"), 403);
      }
      status(await consoleRequest(f.governor, `/users/${f.studentA.user.user_id}`), 200);
    });
    await t.test("详情真实区分普通主体与未来生效敏感授权，不扩大可见范围", async () => {
      const ordinary = await consoleRequest(f.organizationAdmin, `/users/${f.studentA.user.user_id}`);
      status(ordinary, 200);
      assert.equal(ordinary.data.data.protected_account, false);
      const future = await f.actor(f.platform, ["student"]);
      const before = await consoleRequest(f.accounts, `/users/${future.user.user_id}`);
      status(before, 200);
      assert.equal(before.data.data.protected_account, false);
      await administrativeGrant(f, future, "report:read", [f.schoolA],
        { validFrom: new Date(Date.now() + 60000), validTo: new Date(Date.now() + 3600000) });
      for (const actor of [f.accounts, f.governor]) {
        const detail = await consoleRequest(actor, `/users/${future.user.user_id}`);
        status(detail, 200);
        assert.equal(detail.data.data.protected_account, true);
        assert.deepEqual(Object.keys(detail.data.data).sort(), ["display_name", "id", "identity_revision", "login_name", "protected_account", "status"]);
      }
      error(await consoleRequest(f.organizationAdmin, `/users/${future.user.user_id}`), 404);
      error(await consoleRequest(f.accounts, `/users/${newId()}`), 404);
      const directory = await lookup(f.accounts, future.user.login_name);
      status(directory, 200);
      assert.deepEqual(Object.keys(directory.data.data.items[0]).sort(), ["display_name", "id", "identity_revision", "login_name", "status"], "保护状态仅进入当前详情");
    });
    await t.test("旧无筛选游标兼容，规范化筛选绑定及 after/limit 生效", async () => {
      for (const [actor, mode] of [[f.accounts, "platform"], [f.organizationAdmin, "organization"]]) {
        const first = await consoleRequest(actor, "/users?limit=1");
        status(first, 200);
        assert.equal(first.data.data.items.length, 1);
        assert.equal(typeof first.data.data.next_cursor, "string");
        const legacy = userCursor(actor, mode, first.data.data.items[0].id);
        const continuation = await consoleRequest(actor, `/users?${new URLSearchParams({ limit: "1", cursor: legacy })}`);
        status(continuation, 200);
        const candidates = await f.db.collection("users").find({ $or: [{ privacy_state: "active" }, { privacy_state: { $exists: false } }] }).sort({ _id: 1 }).toArray();
        const members = await f.db.collection("organization_members").find({ org_id: actor.org }).toArray();
        const eligible = candidates.filter(user => mode === "platform" || members.some(member => member.user_id === user._id));
        const next = eligible.find(user => user._id > first.data.data.items[0].id);
        assert.deepEqual(continuation.data.data.items.map(user => user.id), [next._id]);
        error(await lookup(actor, f.studentA.user.login_name, { limit: "1", cursor: legacy }), 422);
        const normalized = f.studentA.user.login_name;
        const cursor = userCursor(actor, mode, beforeAllUsers, normalized);
        const found = await lookup(actor, ` ${normalized.toUpperCase()} `, { limit: "1", cursor });
        status(found, 200);
        assert.deepEqual(found.data.data.items.map(user => user.id), [f.studentA.user.user_id]);
        error(await lookup(actor, f.studentB.user.login_name, { limit: "1", cursor }), 422);
        error(await consoleRequest(actor, `/users?${new URLSearchParams({ limit: "1", cursor })}`), 422);
        error(await lookup(actor, normalized, { limit: "2", cursor }), 422);
        const afterTarget = userCursor(actor, mode, f.studentA.user.user_id, normalized);
        const passed = await lookup(actor, normalized, { limit: "1", cursor: afterTarget });
        status(passed, 200);
        assert.deepEqual(passed.data.data, emptyPage);
      }
      for (const query of ["login_name=", "login_name=ab", "login_name=invalid.name", "login_name=a&login_name=b", "limit=0", "limit=51", "limit=1.5", "limit=1&limit=2", "display_name=anything", "cursor=invalid"]) {
        error(await consoleRequest(f.accounts, `/users?${query}`), 422);
      }
      const invalidAfter = userCursor(f.accounts, "platform", "not-a-uuid", f.studentA.user.login_name);
      error(await lookup(f.accounts, f.studentA.user.login_name, { limit: "1", cursor: invalidAfter }), 422);
    });
    await t.test("真实查询计划复用登录名唯一索引，不引入全表扫描", async () => {
      for (const after of [undefined, beforeAllUsers]) {
        const query = { login_key: f.studentA.user.login_name,
          $or: [{ privacy_state: "active" }, { privacy_state: { $exists: false } }],
          ...(after ? { _id: { $gt: after } } : {}) };
        const explained = await f.db.collection("users").find(query, { projection }).limit(1).explain("executionStats");
        const nodes = planNodes(explained.queryPlanner.winningPlan);
        assert.ok(nodes.some(node => node.indexName === "users_login_key_unique"), "不使用 hint 的实际获胜计划命中已有唯一索引");
        assert.equal(nodes.some(node => node.stage === "COLLSCAN"), false);
        assert.equal(explained.executionStats.nReturned, 1);
        assert.ok(explained.executionStats.totalDocsExamined <= 1);
        assert.ok(explained.executionStats.totalKeysExamined <= 1);
      }
    });
    if (topology === "standalone") await t.test("操作者真实写后隔离仍阻止精确目录读取", async () => {
      const operation_id = newId(), userId = f.accounts.user.user_id;
      await assert.rejects(executeAdministrationOperation({ client: f.client, db: f.db, operation_id,
        actor: "iam-lookup-isolation", reason: "合成账号真实 fence 写后中断", action: "iam.verify.lookup-fence",
        targets: { user_ids: [userId] }, payload: { user_id: userId },
        apply: async ({ session }) => {
          const written = await f.db.collection("users").updateOne({ _id: userId }, { $inc: { identity_revision: 1 } }, { session });
          assert.equal(written.modifiedCount, 1);
          throw new Error("IAM_LOOKUP_AFTER_REAL_FENCE_ACK");
        },
      }), failure => failure instanceof AdministrationNeedsRecovery && failure.operation_id === operation_id);
      const guard = await f.db.collection("administration_guard").findOne({ _id: "administration" });
      assert.equal(guard.state, "needs_recovery");
      assert.equal(guard.operation_id, operation_id);
      const denied = await lookup(f.accounts, f.studentA.user.login_name);
      error(denied, 503);
      assert.equal(denied.data.data, undefined);
      const local = await lookup(f.organizationAdmin, f.studentA.user.login_name);
      status(local, 200);
      assert.deepEqual(local.data.data.items.map(user => user.id), [f.studentA.user.user_id], "无关组织操作者不被扩大隔离");
    });
  });
}
