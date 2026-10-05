"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { fixture, status } = require("./helpers.cjs");
const { executeAdministrationOperation, inspectAdministrationOperations, recoverAdministrationOperation } = require("../dist/administration/operations.js");
const { assertAdministrationAccess } = require("../dist/administration/authorization.js");
const { runInTxn } = require("../dist/database/txn.js");
const { fenceEvidenceSubject } = require("../dist/assessment/subject-access.js");

for (const topology of ["replicaSet", "standalone"]) {
  test(`IAM ${topology}：真实目标写后故障的原子性或隔离恢复`, { timeout: 240000, concurrency: false }, async t => {
    const f = await fixture(t, { topology, env: { FILE_SCAN_ENABLED: "false" } });
    const user = await f.authenticated();
    const org = (await f.ops.createOrganization(f.context, { name: "IAM 证据组织上下文", kind: "school" })).organization_id;
    await t.test("裸非事务session不能写证据；真实事务或显式本地工作才可CAS", async () => {
      const before = await f.db.collection("users").findOne({ _id: user.user_id });
      const naked = f.client.startSession();
      try { await assert.rejects(fenceEvidenceSubject(f.db, naked, user.user_id, org)); }
      finally { await naked.endSession(); }
      assert.equal((await f.db.collection("users").findOne({ _id: user.user_id })).identity_revision, before.identity_revision);
      assert.equal(await runInTxn(f.client, session => fenceEvidenceSubject(f.db, session, user.user_id, org)), true);
      assert.equal((await f.db.collection("users").findOne({ _id: user.user_id })).identity_revision, before.identity_revision + 1);
    });
    const operation_id = randomUUID();
    const input = {
      client: f.client, db: f.db, actor: "iam-fault-operator", action: "iam.verify.disable", reason: "本地合成数据写后故障验证", operation_id,
      payload: { user_id: user.user_id, status: "disabled" }, targets: { user_ids: [user.user_id] },
      apply: async ({ session, now }) => {
        const result = await f.db.collection("users").updateOne({ _id: user.user_id, status: "active" }, { $set: { status: "disabled", updated_at: now }, $inc: { identity_revision: 1 } }, { session });
        assert.equal(result.modifiedCount, 1);
        throw new Error("IAM_INJECTED_AFTER_REAL_WRITE");
      },
    };
    await assert.rejects(executeAdministrationOperation(input));
    const target = await f.db.collection("users").findOne({ _id: user.user_id });
    const guard = await f.db.collection("administration_guard").findOne({ _id: "administration" });
    if (topology === "replicaSet") {
      assert.equal(target.status, "active");
      assert.equal(await f.db.collection("administration_operations").countDocuments({ _id: operation_id }), 0);
      assert.equal(await f.db.collection("audit_events").countDocuments({ operation_id }), 0);
      assert.equal(guard.state, "idle");
      status(await f.browser.request("/me"), 200);
      return;
    }
    assert.equal(target.status, "disabled");
    assert.equal(guard.operation_id, operation_id);
    assert.equal(guard.state, "needs_recovery");
    const before = await f.db.collection("administration_operations").findOne({ _id: operation_id });
    const inspection = await inspectAdministrationOperations(f.db, operation_id);
    assert.equal(inspection[0].status, "needs_recovery");
    assert.deepEqual(await f.db.collection("administration_operations").findOne({ _id: operation_id }), before, "inspect 必须只读");
    await assert.rejects(assertAdministrationAccess(f.db, user.user_id));
    const recovery = {
      client: f.client, db: f.db, operation_id, actor: "iam-recovery-operator", reason: "人工核对真实用户及原目标后前向完成",
      revalidate: async operation => {
        assert.equal(operation.targets.user_ids[0], user.user_id);
        const current = await f.db.collection("users").findOne({ _id: user.user_id });
        assert.equal(current.status, "disabled");
      },
      finish: async (_operation, session) => {
        await f.db.collection("auth_sessions").updateMany({ user_id: user.user_id, revoked_at: null }, { $set: { revoked_at: new Date() } }, { session });
      },
      verify: async (_operation, session) => {
        assert.equal(await f.db.collection("auth_sessions").countDocuments({ user_id: user.user_id, revoked_at: null }, { session }), 0);
        assert.equal((await f.db.collection("users").findOne({ _id: user.user_id }, { session })).status, "disabled");
      },
    };
    await recoverAdministrationOperation(recovery);
    assert.equal((await f.db.collection("administration_operations").findOne({ _id: operation_id })).status, "applied");
    assert.equal((await f.db.collection("administration_guard").findOne({ _id: "administration" })).state, "idle");
    status(await f.browser.request("/me"), 401);
  });
}
