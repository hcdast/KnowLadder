"use strict";
const { MongoClient } = require("mongodb");
const { guardedUri } = require("./helpers.cjs");
const { executeAdministrationOperation } = require("../dist/administration/operations.js");
(async () => {
  const [uriRaw, operation_id, user_id, cutpoint] = process.argv.slice(2);
  const uri = guardedUri(uriRaw);
  if (!/^[a-f0-9-]{36}$/.test(operation_id) || !/^[a-f0-9-]{36}$/.test(user_id) || !["intent", "guard", "target", "audit", "publish", "release"].includes(cutpoint)) throw new Error("Invalid isolated fault arguments");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const db = client.db();
  const hello = await db.command({ hello: 1 });
  if (hello.setName) throw new Error("This fault child requires isolated standalone MongoDB");
  const originalCollection = db.collection.bind(db);
  db.collection = name => {
    const collection = originalCollection(name);
    return new Proxy(collection, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key !== "insertOne" && key !== "updateOne") return typeof value === "function" ? value.bind(target) : value;
      return async (...args) => {
        const result = await value.apply(target, args);
        const [filterOrDocument, mutation] = args;
        const set = mutation?.$set;
        const reached = cutpoint === "intent" && name === "administration_operations" && key === "insertOne" && filterOrDocument._id === operation_id ||
          cutpoint === "guard" && name === "administration_guard" && set?.operation_id === operation_id && set?.state === "applying" && result.matchedCount === 1 ||
          cutpoint === "target" && name === "users" && filterOrDocument._id === user_id && result.modifiedCount === 1 ||
          cutpoint === "audit" && name === "audit_events" && key === "insertOne" && filterOrDocument.operation_id === operation_id ||
          cutpoint === "publish" && name === "administration_operations" && filterOrDocument._id === operation_id && set?.status === "applied" && result.matchedCount === 1 ||
          cutpoint === "release" && name === "administration_guard" && filterOrDocument.operation_id === operation_id && set?.state === "idle" && result.matchedCount === 1;
        if (reached) { console.log(`IAM REAL WRITE CUTPOINT ${cutpoint}`); process.exit(42); }
        return result;
      };
    } });
  };
  try {
    await executeAdministrationOperation({ client, db, operation_id, actor: "iam-process-fault", reason: "真实standalone管理进程终止", action: "iam.verify.process.disable", targets: { user_ids: [user_id] }, payload: { user_id, status: "disabled" },
      apply: async ({ session, now }) => {
        const changed = await db.collection("users").updateOne({ _id: user_id, status: "active" }, { $set: { status: "disabled", updated_at: now }, $inc: { identity_revision: 1 } }, { session });
        if (changed.modifiedCount !== 1) throw new Error("Isolated target changed");
        await db.collection("auth_sessions").updateMany({ user_id, revoked_at: null }, { $set: { revoked_at: now } }, { session });
        return { user_id };
      },
      verify: async ({ session }) => { if ((await db.collection("users").findOne({ _id: user_id }, { session })).status !== "disabled") throw new Error("Target did not reach immutable desired state"); },
    });
    throw new Error("Fault cutpoint was not reached");
  } finally { await client.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
