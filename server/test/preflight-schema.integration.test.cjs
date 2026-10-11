"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { fixture } = require("./helpers.cjs"),
  { FEATURE_FLAGS } = require("../dist/runtime/feature-flags"),
  { assertSchema } = require("../dist/migrations/schema"),
  { rawDatabase } = require("../dist/database/object-id"),
  pre = require("../../ops/backend-preflight.cjs"),
  { spawn } = require("node:child_process"),
  path = require("node:path");
for (const topology of ["standalone", "replicaSet"])
  test(
    "batched markers, complete schema and actual preflight cancellation: " +
      topology,
    { timeout: 120000 },
    async (t) => {
      const f = await fixture(t, {
        app: false,
        topology,
        env: {
          ...Object.fromEntries(FEATURE_FLAGS.map((k) => [k, "false"])),
          ALLOW_INSECURE_HTTP: "true",
          KL_MONGO_ALLOW_STANDALONE:
            topology === "standalone" ? "true" : "false",
          FILE_STORAGE_DRIVER: "local",
          KL_STANDALONE_RECOVERY_ENABLED:
            topology === "standalone" ? "true" : "false",
          KL_TRAINING_ENABLED: "true",
          KL_COURSEWORK_FILES_ENABLED:
            topology === "replicaSet" ? "true" : "false",
          KL_AI_POLICY_ENABLED: topology === "replicaSet" ? "true" : "false",
          KL_TRAINING_REPORTS_ENABLED:
            topology === "replicaSet" ? "true" : "false",
          KL_TRAINING_PHASE2_ENABLED:
            topology === "replicaSet" ? "true" : "false",
          KL_AI_LEARNING_REPORTS_ENABLED:
            topology === "replicaSet" ? "true" : "false",
          KL_KNOWLEDGE_ENABLED: topology === "replicaSet" ? "true" : "false",
        },
      });
      const db = rawDatabase(f.db),
        markers = await db.collection("schema_migrations").find({}).toArray();
      let batches = 0,
        individual = 0,
        override;
      const counted = new Proxy(db, {
        get(target, key) {
          if (key === "collection")
            return (name) => {
              const c = target.collection(name);
              if (name !== "schema_migrations") return c;
              return new Proxy(c, {
                get(col, key) {
                  if (key === "find")
                    return (...args) => {
                      batches++;
                      return override
                        ? { limit: () => ({ toArray: async () => override }) }
                        : col.find(...args);
                    };
                  if (key === "findOne")
                    return (...args) => {
                      individual++;
                      return col.findOne(...args);
                    };
                  const v = Reflect.get(col, key, col);
                  return typeof v === "function" ? v.bind(col) : v;
                },
              });
            };
          const v = Reflect.get(target, key, target);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      await assertSchema(counted);
      assert.equal(batches, 1);
      assert.equal(individual, 0);
      for (const version of topology === "standalone"
        ? [11, 21]
        : [11, 12, 13, 14, 15, 16, 17]) {
        override = markers.filter((r) => r.version !== version);
        await assert.rejects(assertSchema(counted), new RegExp("v" + version));
        override = markers.map((r) =>
          r.version === version ? { ...r, checksum: "wrong" } : r,
        );
        await assert.rejects(assertSchema(counted), new RegExp("v" + version));
      }
      override = [...markers, markers.find((r) => r.version === 10)];
      await assert.rejects(
        assertSchema(counted),
        /SCHEMA_MIGRATION_RECORDS_INVALID/,
      );
      override = markers.map((r) =>
        r.version === 10 ? { ...r, completed_at: null } : r,
      );
      await assert.rejects(assertSchema(counted), /v10/);
      override = undefined;
      await db.createCollection("unexpected_preflight_test");
      try {
        await assert.rejects(assertSchema(db), /UNKNOWN_COLLECTION/);
      } finally {
        await db.collection("unexpected_preflight_test").drop();
      }
      const info = (await db.listCollections({ name: "roles" }).toArray())[0];
      await db.command({ collMod: "roles", validationAction: "warn" });
      try {
        await assert.rejects(assertSchema(db), /validator mismatch/);
      } finally {
        await db.command({
          collMod: "roles",
          validationAction: info.options.validationAction,
        });
      }
      const indexes = await db.collection("roles").listIndexes().toArray(),
        index = indexes.find((i) => i.name !== "_id_");
      assert.ok(index);
      await db.collection("roles").dropIndex(index.name);
      try {
        await assert.rejects(assertSchema(db), /index mismatch/);
      } finally {
        const { v, ns, ...spec } = index;
        await db.collection("roles").createIndexes([spec]);
      }
      const events = [],
        controller = new AbortController();
      const cancelled = await pre.preflight({
        signal: controller.signal,
        emit: (r) => {
          events.push(r);
          if (r.stage === "schema.indexes" && r.state === "started")
            controller.abort();
        },
      });
      assert.equal(cancelled.ok, false);
      assert.equal(cancelled.code, "PREFLIGHT_CANCELLED");
      assert.notEqual(cancelled.cleanup_ok, false);
      assert.equal(cancelled.stage, "schema.indexes");
      const timed = await pre.preflight({ budgetMs: 1, emit: () => {} });
      assert.equal(timed.ok, false);
      assert.equal(timed.code, "PREFLIGHT_TIMEOUT");
      assert.notEqual(timed.cleanup_ok, false);
      const full = await pre.preflight({ emit: () => {} });
      assert.equal(
        full.ok,
        true,
        JSON.stringify({ stage: full.stage, code: full.code }),
      );
      const cli = await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [path.resolve(__dirname, "../../ops/backend-preflight.cjs")],
          {
            env: { ...process.env },
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let out = "",
          err = "";
        const timer = setTimeout(() => {
          child.kill();
          reject(Error("CLI_TIMEOUT"));
        }, 15000);
        child.stdout.on("data", (c) => (out += c));
        child.stderr.on("data", (c) => (err += c));
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ out, err, code });
        });
      });
      assert.equal(cli.code, 0);
      assert.equal(cli.out.trim().split("\n").length, 1);
      assert.equal(JSON.parse(cli.out).ok, true);
      assert.ok(cli.err.includes("schema.indexes"));
    },
  );
