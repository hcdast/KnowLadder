"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const { MongoClient } = require("mongodb");
const { guardedUri } = require("./helpers.cjs");

// Only pause real I/O. Neither driver results nor ClamAV verdicts are replaced.
(async () => {
  const [rawUri, fileId, storageKey, cutpoint] = process.argv.slice(2);
  const uri = guardedUri(rawUri);
  assert.ok(/^mongodb:\/\/(?:127\.0\.0\.1|localhost):\d+\//.test(uri), "Scan child requires localhost MongoDB");
  for (const id of [fileId, storageKey]) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(["none", "claimed", "before-rename", "after-rename"].includes(cutpoint));
  assert.equal(process.env.FILE_SCAN_ENABLED, "true");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  let paused = false;
  async function pause() {
    assert.equal(paused, false, "同一扫描只能命中一个屏障");
    paused = true;
    const { promise, resolve, reject } = Promise.withResolvers();
    const receive = message => {
      if (message?.type === "resume" && message.cutpoint === cutpoint) resolve();
    };
    process.on("message", receive);
    const timer = setTimeout(() => reject(new Error("Scan barrier was not released")), 600000);
    try {
      await new Promise((resolveSend, rejectSend) => process.send({ type: "barrier", cutpoint }, error => error ? rejectSend(error) : resolveSend()));
      await promise;
    } finally {
      clearTimeout(timer);
      process.removeListener("message", receive);
    }
  }
  const quarantine = path.resolve(process.env.FILE_STORAGE_ROOT, "quarantine", storageKey);
  const ready = path.resolve(process.env.FILE_STORAGE_ROOT, "ready", storageKey);
  const originalOpen = fs.open;
  const originalRename = fs.rename;
  let integrityOpens = 0;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (path.resolve(String(args[0])) !== quarantine) return handle;
    integrityOpens++;
    // A second quarantine integrity pass is reached only after a real clean scan.
    if (cutpoint !== "before-rename" || integrityOpens !== 2) return handle;
    return new Proxy(handle, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "close") return async (...closeArgs) => {
        const result = await value.apply(target, closeArgs);
        await pause();
        return result;
      };
      return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  fs.rename = async (...args) => {
    const result = await originalRename(...args);
    if (cutpoint === "after-rename" && path.resolve(String(args[0])) === quarantine && path.resolve(String(args[1])) === ready) await pause();
    return result;
  };
  try {
    await client.connect();
    const db = client.db();
    assert.equal((await db.command({ hello: 1 })).setName, undefined);
    const originalCollection = db.collection.bind(db);
    db.collection = (...args) => {
      const collection = originalCollection(...args);
      if (args[0] !== "file_resources") return collection;
      return new Proxy(collection, { get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "findOneAndUpdate") return async (...writeArgs) => {
          const result = await value.apply(target, writeArgs);
          if (writeArgs[1]?.$set?.scan_status === "scanning" && result) {
            assert.equal(result._id, fileId, "必须领取本场景实际上传的附件");
            if (cutpoint === "claimed") await pause();
          }
          return result;
        };
        return typeof value === "function" ? value.bind(target) : value;
      } });
    };
    const { processOne } = require("../dist/files/worker.js");
    const consumed = await processOne(db);
    if (cutpoint !== "none") assert.equal(paused, true, "真实扫描必须到达指定屏障");
    await new Promise((resolve, reject) => process.send({ type: "result", consumed }, error => error ? reject(error) : resolve()));
  } finally {
    fs.open = originalOpen;
    fs.rename = originalRename;
    await client.close();
    if (process.connected) process.disconnect();
  }
})().catch(() => {
  // Do not emit driver errors, URIs, credentials or process environment.
  console.error("IAM real scan child failed");
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
