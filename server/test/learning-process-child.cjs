"use strict";
// Test-only barrier after an acknowledged real detail write, before publication.
const assert = require("node:assert/strict");
const { MongoClient } = require("mongodb");
const { guardedUri } = require("./helpers.cjs");

async function main() {
  assert.ok(process.send, "必须通过 fork 启动学情故障夹具");
  const client = new MongoClient(guardedUri(process.env.TEST_LEARNING_PROCESS_URI), {
    readPreference: "primary", writeConcern: { w: "majority" },
    serverSelectionTimeoutMS: 10000, socketTimeoutMS: 15000,
  });
  const watchdog = setTimeout(() => process.exit(2), 90000);
  process.once("disconnect", () => process.exit(3));
  try {
    await client.connect();
    const hello = await client.db("admin").command({ hello: 1 });
    assert.ok(hello.setName);
    assert.equal(hello.hosts.length, 3);
    const db = client.db();
    const collection = db.collection.bind(db);
    let armed = false, paused = false, generation = null;
    db.collection = (name, ...args) => {
      const real = collection(name, ...args);
      // Reports are the final detail batch (7d/30d fallback guarantees rows).
      // Once their insert resolves, the next organization_members read belongs
      // to the publication transaction's lock: pausing there leaves every
      // detail batch committed while the killed transaction holds no locks,
      // never a fabricated or uncommitted detail row.
      if (name === "report_snapshots") return new Proxy(real, {
        get(target, property) {
          if (property === "insertMany") return async (...arguments_) => {
            const result = await target.insertMany(...arguments_);
            assert.ok(result.acknowledged && result.insertedCount > 0);
            generation = arguments_[0][0].generation;
            armed = true;
            return result;
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      if (name === "organization_members") return new Proxy(real, {
        get(target, property) {
          if (property === "findOne") return async (...arguments_) => {
            if (armed && !paused) {
              paused = true;
              assert.ok(arguments_[1]?.session?.inTransaction?.(), "发布屏障必须位于真实事务内");
              process.send({ type: "details-written", generation });
              // Never resume or fabricate a return value: the parent kills this process.
              await new Promise(() => {});
            }
            return target.findOne(...arguments_);
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return real;
    };
    const { processOne } = require("../dist/learning/worker.js");
    await processOne(db);
    throw new Error("WORKER_DID_NOT_REACH_BARRIER");
  } finally {
    clearTimeout(watchdog);
    await client.close();
  }
}
main().catch(() => {
  // Do not print URI, driver diagnostics, or student evidence.
  if (process.connected) process.send({ type: "failed" }, () => process.exit(1));
  else process.exit(1);
});
