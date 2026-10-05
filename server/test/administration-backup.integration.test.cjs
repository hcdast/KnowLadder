"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { fixture } = require("./helpers.cjs");
const { backup, restore, verifyRestore } = require("../../ops/system-backup.cjs");

test("IAM standalone：全业务备份、隔离恢复及恢复确认均拒绝且不触碰目标", { timeout: 180000 }, async t => {
  const f = await fixture(t, { topology: "standalone", app: false, env: { FILE_SCAN_ENABLED: "false" } });
  const db = f.client.db(`kl_restore_${randomUUID().replaceAll("-", "")}`);
  const file = `C:/kl_test_absent_${randomUUID()}.klb`, key = randomBytes(32);
  const before = { users: await f.db.collection("users").countDocuments(), markers: await f.db.collection("schema_migrations").countDocuments(), guard: await f.db.collection("administration_guard").findOne({ _id: "administration" }) };
  for (const work of [
    () => backup({ client: f.client, db: f.db, file, key, root: "C:/", maintenanceToken: randomUUID() }),
    () => restore({ client: f.client, db, file, key, root: "C:/" }),
    () => verifyRestore({ db, file, key, root: "C:/", restoreId: randomUUID(), apply: true }),
  ]) await assert.rejects(work(), /LOCAL_REPLICA_SET_REQUIRED/);
  assert.equal((await db.listCollections().toArray()).length, 0);
  assert.equal(await f.db.collection("users").countDocuments(), before.users);
  assert.equal(await f.db.collection("schema_migrations").countDocuments(), before.markers);
  assert.deepEqual(await f.db.collection("administration_guard").findOne({ _id: "administration" }), before.guard);
});
