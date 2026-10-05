"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { fixture, Browser, status } = require("./helpers.cjs");
const { assertAdministrationAccess } = require("../dist/administration/authorization.js");
const { recoverAdministrationOperation, voidAdministrationOperation } = require("../dist/administration/operations.js");

async function terminatedChild(uri, operationId, userId, cutpoint) {
  const child = spawn(process.execPath, [path.join(__dirname, "administration-fault-child.cjs"), uri, operationId, userId, cutpoint], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const timer = setTimeout(() => child.kill(), 30000);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(code, 42, `子进程必须在真实写ack后终止；诊断：${stderr}`);
    assert.ok(stdout.includes(`IAM REAL WRITE CUTPOINT ${cutpoint}`));
  } finally { clearTimeout(timer); }
}

test("IAM standalone：管理进程在六个真实写切点退出后的隔离与恢复", { timeout: 480000, concurrency: false }, async t => {
  const f = await fixture(t, { topology: "standalone", env: { FILE_SCAN_ENABLED: "false" } });
  for (const cutpoint of ["intent", "guard", "target", "audit", "publish", "release"]) await t.test(cutpoint, async () => {
    const browser = new Browser(f.browser.base), user = await f.authenticated(browser), operation_id = randomUUID();
    const before = await f.db.collection("users").findOne({ _id: user.user_id });
    await terminatedChild(f.uri, operation_id, user.user_id, cutpoint);
    const op = await f.db.collection("administration_operations").findOne({ _id: operation_id });
    const guard = await f.db.collection("administration_guard").findOne({ _id: "administration" });
    if (cutpoint === "release") {
      assert.equal(op.status, "applied");
      assert.equal(guard.operation_id, null);
      status(await browser.request("/me"), 401);
      return;
    }
    await assert.rejects(assertAdministrationAccess(f.db, user.user_id));
    if (cutpoint === "intent" || cutpoint === "guard") {
      await voidAdministrationOperation({ client: f.client, db: f.db, operation_id, actor: "iam-manual-void", reason: "人工证实仅有意图、没有任何目标写",
        verifyNoEffect: async (_operation, session) => {
          const current = await f.db.collection("users").findOne({ _id: user.user_id }, { session });
          assert.equal(current.status, "active");
          assert.equal(current.identity_revision, before.identity_revision);
          assert.equal(current.credential_version, before.credential_version);
          assert.equal(await f.db.collection("audit_events").countDocuments({ operation_id }, { session }), 0);
        },
      });
      assert.equal((await f.db.collection("administration_operations").findOne({ _id: operation_id })).status, "void");
      status(await browser.request("/me"), 200);
    } else {
      await recoverAdministrationOperation({ client: f.client, db: f.db, operation_id, actor: "iam-manual-recovery", reason: "按不可变停用目标核对实际状态前向完成",
        revalidate: async operation => { assert.equal(operation.targets.user_ids[0], user.user_id); },
        finish: async (_operation, session) => {
          assert.notEqual(cutpoint, "publish", "已发布但guard滞留不能重复应用");
          await f.db.collection("auth_sessions").updateMany({ user_id: user.user_id, revoked_at: null }, { $set: { revoked_at: new Date() } }, { session });
        },
        verify: async (_operation, session) => {
          const current = await f.db.collection("users").findOne({ _id: user.user_id }, { session });
          assert.equal(current.status, "disabled");
          assert.equal(current.credential_version, before.credential_version);
          assert.equal(await f.db.collection("auth_sessions").countDocuments({ user_id: user.user_id, revoked_at: null }, { session }), 0);
        },
      });
      assert.equal((await f.db.collection("administration_operations").findOne({ _id: operation_id })).status, "applied");
      status(await browser.request("/me"), 401);
    }
    assert.equal((await f.db.collection("administration_guard").findOne({ _id: "administration" })).state, "idle");
  });
});
