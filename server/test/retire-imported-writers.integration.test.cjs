"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { randomUUID } = require("node:crypto");
const { ObjectId } = require("mongodb"),
  { fixture } = require("./helpers.cjs"),
  { rawDatabase } = require("../dist/database/object-id");
const api = require("../../ops/retire-imported-writers.cjs");
test("旧库writer处置：明确停写声明、准确快照、事务审计和保留记录", async (t) => {
  const f = await fixture(t, {
      app: false,
      env: { FILE_SCAN_ENABLED: "false" },
    }),
    db = rawDatabase(f.db),
    user = await f.user();
  const now = new Date(Date.now() - 3600000),
    id = new ObjectId();
  await db
    .collection("operational_writers")
    .insertOne({
      _id: id,
      environment_id: null,
      kind: "api",
      token: randomUUID(),
      pid: 12345,
      state: "running",
      started_at: now,
      heartbeat_at: now,
      stopped_at: null,
      shutdown_nonce: null,
    });
  const snapshot = await api.inspect(db),
    input = {
      database: db.databaseName,
      snapshotHash: snapshot.writer_snapshot_hash,
      count: 1,
      revision: snapshot.environment_revision,
      actor: user.user_id,
      reason: "Test operator attests all original source hosts are stopped",
      allHostsStopped: true,
    };
  await assert.rejects(
    api.retire(db, { ...input, allHostsStopped: false }),
    /ALL_HOSTS_STOPPED_REQUIRED/,
  );
  assert.equal(
    (await db.collection("operational_writers").findOne({ _id: id })).state,
    "running",
  );
  await assert.rejects(
    api.retire(db, { ...input, snapshotHash: "0".repeat(64) }),
    /WRITER_SNAPSHOT_CHANGED/,
  );
  await db
    .collection("operational_writers")
    .updateOne({ _id: id }, { $set: { heartbeat_at: new Date() } });
  await assert.rejects(api.retire(db, input), /WRITER_SNAPSHOT_CHANGED/);
  const next = await api.inspect(db);
  const result = await api.retire(db, {
    ...input,
    snapshotHash: next.writer_snapshot_hash,
  });
  assert.equal(result.retired, 1);
  assert.equal(result.deleted, 0);
  const row = await db.collection("operational_writers").findOne({ _id: id });
  assert.equal(row.state, "stopped");
  assert.ok(row.stopped_at instanceof Date);
  assert.equal(row.token.length, 36);
  assert.equal(
    await db
      .collection("audit_events")
      .countDocuments({ action: "operations.retire-imported-writers" }),
    1,
  );
  await assert.rejects(api.retire(db, input), /REVISION_CONFLICT/);
});
