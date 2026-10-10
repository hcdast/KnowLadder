"use strict";
const { MongoClient } = require("../server/node_modules/mongodb");
const { loadConfig } = require("../server/dist/config");
const { assertTopology } = require("../server/dist/database/topology");
const { assertSchema } = require("../server/dist/migrations/schema");
const {
  assertOperationalAccess,
} = require("../server/dist/operations/control");
const {
  managedApiEnabled,
} = require("../server/dist/training/managed-invocation");
const {
  assertRecoveryConfiguration,
  assertRecoveryQuiescent,
} = require("../server/dist/training/standalone-recovery-lifecycle");
const { safeErrorCode } = require("../server/dist/runtime/process-lifecycle");
async function preflight({ verify, stopped, identity = false } = {}) {
  let stage = "node",
    client;
  try {
    if (process.version !== "v22.19.0") throw Error("NODE_VERSION_REQUIRED");
    stage = "configuration";
    const config = loadConfig();
    if (config.production) throw Error("LOCAL_PM2_NONPRODUCTION_REQUIRED");
    stage = "database-connect";
    client = new MongoClient(config.mongoUri, {
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 10000,
    });
    await client.connect();
    const db = require("../server/dist/database/object-id").objectIdDatabase(
      client.db(),
    );
    if (stopped) {
      const registrations = [];
      for (const app of stopped) {
        if (app.databaseId !== require("node:crypto").createHash("sha256").update(config.mongoUri).digest("hex"))
          return { ok: false, stage: "writer-stop", code: "OPERATIONS_DATABASE_CHANGED_STOP_FIRST" };
        if (!Number.isInteger(app.pid) || app.pid <= 0)
          throw Error("OPERATIONS_WRITER_IDENTITY_REQUIRED");
        if (identity) {
          const rows = await db.collection("operational_writers").find(
            app.protocol === "2" ? (managedApiEnabled() && app.name === "kl-api" ? {kind: "api", state: "running"} : { pid: app.pid, state: "running" }) : { token: app.token, state: "running" },
            { projection: { token: 1, _id: 0 } },
          ).toArray();
          registrations.push({ ...app, tokens: rows.map(row => row.token) });
        } else {
          if (!Array.isArray(app.tokens) || await db.collection("operational_writers").findOne({
            state: "running", $or: [{ token: { $in: app.tokens } }, { pid: app.pid }],
          }))
            return { ok: false, stage: "writer-stop", code: "OPERATIONS_WRITER_RELEASE_UNCONFIRMED" };
        }
      }
      return { ok: true, ...(identity ? { registrations } : {}) };
    }
    stage = "topology";
    const topology = await assertTopology(db, config);
    stage = "schema";
    await assertSchema(db);
    stage = "operations";
    await assertOperationalAccess(db);
    if (managedApiEnabled()) {
      stage = "managed-admission";
      assertRecoveryConfiguration();
      if (topology.mode !== "standalone")
        throw Error("MANAGED_STANDALONE_REQUIRED");
      await assertRecoveryQuiescent(db);
      if (
        !verify &&
        (await db
          .collection("operational_writers")
          .findOne({ state: "running" }))
      )
        throw Error("MANAGED_UNKNOWN_WRITER");
    }
    if (verify) {
      stage = "worker-ready";
      for (const app of verify) {
        if (managedApiEnabled() && app.name === "kl-api") continue;
        const tokens = app.protocol === "2" ? app.writerTokens : [app.token];
        if (!Array.isArray(tokens) || !tokens.length || new Set(tokens).size !== tokens.length)
          throw Error("WORKER_REGISTRATION_REQUIRED");
        for (const token of tokens) {
          if (typeof token !== "string" || !await db.collection("operational_writers").findOne({ pid: app.pid, token, state: "running" }))
            throw Error("WORKER_REGISTRATION_REQUIRED");
        }
        // A late or orphaned registration in this PID must not be omitted from proof.
        if (await db.collection("operational_writers").countDocuments({pid: app.pid, state: "running"}) !== tokens.length)
          throw Error("WORKER_REGISTRATION_REQUIRED");
      }
      return { ok: true };
    }
    const scanEnabled = process.env.FILE_SCAN_ENABLED !== "false";
    if (scanEnabled || require("../server/dist/files/storage").storageDriver()==="s3") {
      stage = "storage";
      await require("../server/dist/files/config").assertStorageReady();
    }
    if (scanEnabled) {
      stage = "scanner";
      await require("../server/dist/files/scanner").assertScanner();
    }
    return { ok: true, port: config.port, managed: managedApiEnabled() };
  } catch (error) {
    // Never return raw Mongo/config errors, stacks, URI, paths, keys or credentials.
    return { ok: false, stage, code: safeErrorCode(error) };
  } finally {
    await client?.close();
  }
}
module.exports = { preflight };
if (require.main === module)
  (async () => {
    let verify, stopped;
    if (["verify", "stopped", "identity"].includes(process.argv[2])) {
      let input = "";
      for await (const chunk of process.stdin) {
        input += chunk;
        if (input.length > 32768) throw Error("VERIFY_INPUT_LIMIT");
      }
      if (process.argv[2] !== "verify") stopped = JSON.parse(input);
      else verify = JSON.parse(input);
    }
    const result = await preflight({
      verify,
      stopped,
      identity: process.argv[2] === "identity",
    });
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  })().catch(() => {
    console.error(
      JSON.stringify({
        ok: false,
        stage: "preflight",
        code: "PREFLIGHT_FAILED",
      }),
    );
    process.exitCode = 1;
  });
