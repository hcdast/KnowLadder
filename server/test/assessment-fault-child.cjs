"use strict";
// Test-only IPC barrier AFTER a real atomic MongoDB claim, before processOne
// receives it. No production hooks, fake claims, scores, or successful writes.
const assert = require("node:assert/strict");
const { MongoClient } = require("mongodb");
const { guardedUri } = require("./helpers.cjs");

async function main() {
  assert.equal(process.env.TEST_MONGODB_FAILPOINTS, "true");
  assert.ok(process.send, "故障辅助必须由测试 fork 创建");
  const uri = guardedUri(process.env.TEST_FAULT_URI);
  const client = new MongoClient(uri, {
    appName: process.env.TEST_FAULT_APP_NAME,
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 15000,
  });
  const watchdog = setTimeout(() => process.exit(2), 150000);
  let resume;
  const barrier = new Promise((resolve) => { resume = resolve; });
  process.on("message", (message) => {
    if (message?.type === "resume") resume();
  });
  try {
    await client.connect();
    const hello = await client.db("admin").command({ hello: 1 });
    assert.equal(hello.setName, "kl-test-faults");
    const db = client.db();
    const collection = db.collection.bind(db);
    let paused = false;
    db.collection = (name, ...args) => {
      const real = collection(name, ...args);
      if (name !== "outbox_events") return real;
      return new Proxy(real, {
        get(target, property) {
          if (property === "findOneAndUpdate") return async (...arguments_) => {
            const result = await target.findOneAndUpdate(...arguments_);
            const row = result?.value || result;
            if (!paused && row?.status === "running" && row.lease_token) {
              paused = true;
              process.send({ type: "claimed", id: row._id, token: row.lease_token });
              await barrier;
            }
            return result;
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    const { processOne } = require("../dist/assessment/worker.js");
    await processOne(db);
    assert.ok(paused, "真实 worker 必须领取评分事件");
    process.send({ type: "done" });
  } finally {
    clearTimeout(watchdog);
    await client.close();
    if (process.connected) process.disconnect();
  }
}
main().catch(() => {
  // Never emit Mongo errors containing URI, credentials, or student material.
  if (process.connected) process.send({ type: "failed" });
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
