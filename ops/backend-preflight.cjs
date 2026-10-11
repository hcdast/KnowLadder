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
const { timing } = require("./startup-timing.cjs");
const {
  preflightBudget,
  bounded,
  deadline,
} = require("./preflight-budget.cjs");
const { deploymentIdentity } = require("./deployment-identity.cjs");
const { createHash } = require("node:crypto");
const root = require("node:path").resolve(__dirname, "..");
const kinds = {
  "kl-api": ["api"],
  "kl-files-worker": ["files"],
  "kl-assessment-worker": ["assessment"],
  "kl-learning-worker": ["learning"],
  "kl-knowledge-worker": ["learning"],
  "kl-import-worker": ["api", "learning"],
};
async function schemaSnapshot(db, signal) {
  const rows = await db
    .collection("schema_migrations")
    .find(
      {},
      {
        projection: {
          _id: 0,
          version: 1,
          status: 1,
          checksum: 1,
          started_at: 1,
          completed_at: 1,
          failed_at: 1,
        },
        maxTimeMS: 10000,
        signal,
      },
    )
    .sort({ version: 1 })
    .limit(101)
    .toArray();
  if (!rows.length || rows.length > 100) throw Error("SCHEMA_PROOF_INVALID");
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
function validateProof(proof, identity, now = Date.now()) {
  if (
    !proof ||
    proof.deployment !== identity ||
    !/^[a-f0-9]{64}$/.test(proof.schema ?? "") ||
    !Number.isSafeInteger(proof.checked_at) ||
    now < proof.checked_at ||
    now - proof.checked_at > 900000
  )
    throw Error("SCHEMA_PROOF_INVALID");
}
async function verifyWriters(
  db,
  apps,
  { managed = false, reuse = false, signal } = {},
) {
  if (
    !Array.isArray(apps) ||
    !apps.length ||
    apps.length > 6 ||
    new Set(apps.map((a) => a.name)).size !== apps.length ||
    new Set(apps.map((a) => a.pid)).size !== apps.length
  )
    throw Error("WORKER_REGISTRATION_REQUIRED");
  if (
    apps.some((a) => !kinds[a.name] || !Number.isInteger(a.pid) || a.pid <= 0)
  )
    throw Error("WORKER_REGISTRATION_REQUIRED");
  const rows = await db
    .collection("operational_writers")
    .find(
      { pid: { $in: apps.map((a) => a.pid) }, state: "running" },
      {
        projection: { _id: 0, pid: 1, token: 1, kind: 1 },
        maxTimeMS: 10000,
        signal,
      },
    )
    .limit(129)
    .toArray();
  if (rows.length > 128) throw Error("WORKER_REGISTRATION_REQUIRED");
  for (const app of apps) {
    if (managed && app.name === "kl-api") {
      if (reuse) throw Error("MANAGED_REUSE_UNSUPPORTED");
      continue;
    }
    const tokens = app.protocol === "2" ? app.writerTokens : [app.token];
    if (
      !Array.isArray(tokens) ||
      !tokens.length ||
      new Set(tokens).size !== tokens.length ||
      tokens.some((t) => typeof t !== "string" || !t.length)
    )
      throw Error("WORKER_REGISTRATION_REQUIRED");
    const own = rows.filter((r) => r.pid === app.pid);
    if (
      own.length !== tokens.length ||
      own.some((r) => !tokens.includes(r.token))
    )
      throw Error("WORKER_REGISTRATION_REQUIRED");
    if (
      reuse &&
      (app.protocol !== "2" ||
        JSON.stringify(own.map((r) => r.kind).sort()) !==
          JSON.stringify([...kinds[app.name]].sort()))
    )
      throw Error("WORKER_REGISTRATION_REQUIRED");
  }
  if (
    reuse &&
    (await db
      .collection("operational_writers")
      .findOne(
        { state: "running", pid: { $nin: apps.map((a) => a.pid) } },
        { signal },
      ))
  )
    throw Error("MANAGED_UNKNOWN_WRITER");
}
async function preflight({
  verify,
  stopped,
  identity = false,
  fast = false,
  proof,
  reuse = false,
  emit,
  signal: externalSignal,
  budgetMs,
} = {}) {
  let stage = "node",
    client;
  const clock = timing("preflight", emit);
  let control, closing;
  const run = (name, task) => {
    stage = name;
    return clock.run(name, () => control.run(task));
  };
  let result;
  try {
    const budget = budgetMs ?? preflightBudget(Boolean(verify || stopped));
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 600000)
      throw Error("INVALID_CONFIG_KL_PREFLIGHT_TIMEOUT_MS");
    control = deadline(budget, externalSignal);
    const context = { signal: control.signal, run };
    result = await (async () => {
      if (process.version !== "v22.19.0") throw Error("NODE_VERSION_REQUIRED");
      const config = await run("configuration", () => {
        const c = loadConfig();
        if (c.production) throw Error("LOCAL_PM2_NONPRODUCTION_REQUIRED");
        return c;
      });
      client = new MongoClient(config.mongoUri, {
        serverSelectionTimeoutMS: Math.min(15000, budget),
        connectTimeoutMS: Math.min(10000, budget),
        socketTimeoutMS: Math.min(10000, budget),
        waitQueueTimeoutMS: Math.min(10000, budget),
      });
      const closeOnAbort = () => {
        closing ??= client.close(true);
        closing.catch(() => {});
      };
      control.signal.addEventListener("abort", closeOnAbort, { once: true });
      if (control.signal.aborted) closeOnAbort();
      await run("database-connect", () => client.connect());
      const db = require("../server/dist/database/object-id").objectIdDatabase(
        client.db(),
      );
      if (stopped)
        return await run("writer-stop", async () => {
          const registrations = [];
          for (const app of stopped) {
            if (
              app.databaseId !==
              createHash("sha256").update(config.mongoUri).digest("hex")
            )
              throw Error("OPERATIONS_DATABASE_CHANGED_STOP_FIRST");
            if (!Number.isInteger(app.pid) || app.pid <= 0)
              throw Error("OPERATIONS_WRITER_IDENTITY_REQUIRED");
            if (identity) {
              const rows = await db
                .collection("operational_writers")
                .find(
                  app.protocol === "2"
                    ? managedApiEnabled() && app.name === "kl-api"
                      ? { kind: "api", state: "running" }
                      : { pid: app.pid, state: "running" }
                    : { token: app.token, state: "running" },
                  { projection: { token: 1, _id: 0 }, maxTimeMS: 10000 },
                )
                .toArray();
              registrations.push({ ...app, tokens: rows.map((r) => r.token) });
            } else if (
              !Array.isArray(app.tokens) ||
              (await db.collection("operational_writers").findOne({
                state: "running",
                $or: [{ token: { $in: app.tokens } }, { pid: app.pid }],
              }))
            )
              throw Error("OPERATIONS_WRITER_RELEASE_UNCONFIRMED");
          }
          return { ok: true, ...(identity ? { registrations } : {}) };
        });
      const topology = await run("topology", () => assertTopology(db, config));
      let ticket;
      if (fast) {
        await run("migration-proof", async () => {
          validateProof(proof, deploymentIdentity(root));
          if ((await schemaSnapshot(db, control.signal)) !== proof.schema)
            throw Error("SCHEMA_CHANGED_DURING_STARTUP");
        });
      } else {
        const before = await run("migration-proof", () =>
          schemaSnapshot(db, control.signal),
        );
        await run("schema", () => assertSchema(db, context));
        const after = await run("migration-proof", () =>
          schemaSnapshot(db, control.signal),
        );
        if (before !== after) throw Error("SCHEMA_CHANGED_DURING_STARTUP");
        ticket = {
          deployment: deploymentIdentity(root),
          schema: after,
          checked_at: Date.now(),
        };
      }
      await run("operations", () => assertOperationalAccess(db));
      if (managedApiEnabled())
        await run("managed-admission", async () => {
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
        });
      if (verify) {
        await run("worker-ready", () =>
          verifyWriters(db, verify, {
            managed: managedApiEnabled(),
            reuse,
            signal: control.signal,
          }),
        );
        return { ok: true };
      }
      if (fast) throw Error("SCHEMA_PROOF_INVALID");
      const scanEnabled = process.env.FILE_SCAN_ENABLED !== "false";
      if (
        scanEnabled ||
        require("../server/dist/files/storage").storageDriver() === "s3"
      )
        await run("storage", () =>
          require("../server/dist/files/config").assertStorageReady(context),
        );
      if (scanEnabled)
        await run("scanner", () =>
          require("../server/dist/files/scanner").assertScanner(context),
        );
      return {
        ok: true,
        port: config.port,
        managed: managedApiEnabled(),
        proof: ticket,
      };
    })();
  } catch (error) {
    result = { ok: false, stage, code: safeErrorCode(error) };
  } finally {
    // Abort-aware tasks must settle and scanner children must close before returning.
    const failedStage = result?.ok === false ? result.stage : "database-close";
    try {
      await clock.run("database-close", async () => {
        closing ??= client
          ? client.close(Boolean(control?.signal.aborted))
          : Promise.resolve();
        await bounded(
          Promise.allSettled([...(control?.pending ?? []), closing]).then(
            (rows) => {
              const closeResult = rows.at(-1);
              if (closeResult?.status === "rejected") throw closeResult.reason;
            },
          ),
          5000,
        );
      });
      if (control?.signal.aborted)
        result = {
          ok: false,
          stage: failedStage,
          code: safeErrorCode(control.signal.reason),
        };
    } catch (error) {
      result = {
        ok: false,
        stage: result?.ok === false ? failedStage : "database-close",
        code: result?.ok === false ? result.code : safeErrorCode(error),
        cleanup_ok: false,
        cleanup_code: safeErrorCode(error),
      };
    } finally {
      control?.dispose();
    }
  }
  return { ...result, timings_ms: clock.timings };
}
module.exports = { preflight, schemaSnapshot, validateProof, verifyWriters };
if (require.main === module)
  (async () => {
    const started = Date.now(),
      controller = new AbortController();
    const cancel = () => controller.abort(Error("PREFLIGHT_CANCELLED"));
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    let result;
    try {
      const mode = process.argv[2],
        proofMode = ["verify", "verify-fast", "stopped", "identity"].includes(
          mode,
        );
      const configured = preflightBudget(proofMode),
        argument = process.argv.find((a) => a.startsWith("--budget-ms="));
      const budget = argument
        ? Number(argument.slice("--budget-ms=".length))
        : configured;
      if (!Number.isSafeInteger(budget) || budget < 1 || budget > configured)
        throw Error("INVALID_CONFIG_KL_PREFLIGHT_TIMEOUT_MS");
      let input;
      if (proofMode) {
        const control = deadline(budget, controller.signal);
        control.signal.addEventListener(
          "abort",
          () => process.stdin.destroy(),
          { once: true },
        );
        try {
          input = await control.run(async () => {
            let text = "";
            for await (const chunk of process.stdin) {
              text += chunk;
              if (Buffer.byteLength(text) > 32768)
                throw Error("VERIFY_INPUT_LIMIT");
            }
            return JSON.parse(text);
          });
        } finally {
          control.dispose();
        }
      }
      const options =
        mode === "verify-fast"
          ? { ...input, fast: true }
          : mode === "verify"
            ? { verify: input }
            : mode === "identity" || mode === "stopped"
              ? { stopped: input, identity: mode === "identity" }
              : {};
      result = await preflight({
        ...options,
        signal: controller.signal,
        budgetMs: Math.max(1, budget - (Date.now() - started)),
      });
    } catch (error) {
      result = { ok: false, stage: "preflight", code: safeErrorCode(error) };
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
    // stdout remains a single machine-readable result, including timeout failures.
    process.stdout.write(JSON.stringify(result) + "\n", () => {
      if (!result.ok) process.exitCode = 1;
      if (result.cleanup_ok === false) process.exit(1);
    });
  })();
