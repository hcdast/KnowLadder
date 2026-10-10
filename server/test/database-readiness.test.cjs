"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { Database } = require("../dist/database/database");
const control = require("../dist/operations/control");
const topology = require("../dist/database/topology");
const config = require("../dist/config");
const schema = require("../dist/migrations/schema");
test("concurrent readiness probes share validation, reject together and retry after failure", async (t) => {
  const original = {
    access: control.assertOperationalAccess,
    probe: topology.probeTopology,
    clear: topology.clearTopologyCache,
    config: config.loadConfig,
    schema: schema.assertSchema,
  };
  t.after(() => {
    control.assertOperationalAccess = original.access;
    topology.probeTopology = original.probe;
    topology.clearTopologyCache = original.clear;
    config.loadConfig = original.config;
    schema.assertSchema = original.schema;
  });
  let access = 0,
    probes = 0,
    schemas = 0,
    settle;
  control.assertOperationalAccess = async () => {
    access++;
  };
  topology.clearTopologyCache = () => {};
  topology.probeTopology = async () => {
    probes++;
    return { writable: true, mode: "replicaSet" };
  };
  config.loadConfig = () => ({
    production: false,
    mongoAllowStandalone: false,
  });
  schema.assertSchema = () => {
    schemas++;
    return new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
  };
  const db = Object.create(Database.prototype);
  db.db = {};
  db.checkedAt = 0;
  const a = db.ready(),
    b = db.ready();
  assert.equal(a, b);
  while (!settle) await new Promise((resolve) => setImmediate(resolve));
  const failed = Promise.allSettled([a, b]);
  settle.reject(Error("SCHEMA_INDEX_MISMATCH"));
  for (const r of await failed) {
    assert.equal(r.status, "rejected");
    assert.equal(r.reason.message, "SCHEMA_INDEX_MISMATCH");
  }
  assert.equal(db.checkedAt, 0);
  assert.equal(access, 1);
  assert.equal(probes, 1);
  assert.equal(schemas, 1);
  settle = undefined;
  const retry = db.ready();
  while (!settle) await new Promise((resolve) => setImmediate(resolve));
  settle.resolve();
  await retry;
  assert.equal(schemas, 2);
  assert.ok(db.checkedAt > 0);
  await db.ready();
  assert.equal(schemas, 2);
  assert.equal(access, 3);
  assert.equal(probes, 3);
  topology.probeTopology = async () => ({
    writable: false,
    mode: "replicaSet",
  });
  await assert.rejects(db.ready(), /数据库未就绪/);
});
