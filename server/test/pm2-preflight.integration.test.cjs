"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { fixture } = require("./helpers.cjs"),
  { FEATURE_FLAGS } = require("../dist/runtime/feature-flags"),
  { acquireWriter } = require("../dist/operations/control"),
  pre = require("../../ops/backend-preflight.cjs");
for (const topology of ["standalone", "replicaSet"])
  test(
    "preflight same-run proof invalidates migration/maintenance: " + topology,
    async (t) => {
      const f = await fixture(t, {
          app: false,
          topology,
          env: {
            ...Object.fromEntries(FEATURE_FLAGS.map((k) => [k, "false"])),
            FILE_STORAGE_DRIVER: "local",
            ALLOW_INSECURE_HTTP: "true",
            KL_MONGO_ALLOW_STANDALONE:
              topology === "standalone" ? "true" : "false",
          },
        }),
        events = [];
      const full = await pre.preflight({ emit: (r) => events.push(r) });
      assert.equal(
        full.ok,
        true,
        JSON.stringify({ stage: full.stage, code: full.code }),
      );
      assert.equal(
        events.filter((r) => r.stage === "schema" && r.state === "completed")
          .length,
        1,
      );
      assert.equal(typeof full.timings_ms["database-close"], "number");
      const writer = await acquireWriter(f.db, "api");
      try {
        const own = await f.db
            .collection("operational_writers")
            .findOne({ pid: process.pid, state: "running" }),
          apps = [
            {
              name: "kl-api",
              pid: process.pid,
              protocol: "2",
              writerTokens: [own.token],
            },
          ];
        const before = events.length,
          fast = await pre.preflight({
            verify: apps,
            proof: full.proof,
            fast: true,
            reuse: true,
            emit: (r) => events.push(r),
          });
        assert.equal(
          fast.ok,
          true,
          JSON.stringify({ stage: fast.stage, code: fast.code }),
        );
        assert.ok(!events.slice(before).some((r) => r.stage === "schema"));
        const marker = await f.db
          .collection("schema_migrations")
          .findOne({ version: 10 });
        try {
          await f.db
            .collection("schema_migrations")
            .updateOne(
              { _id: marker._id },
              { $set: { checksum: "f".repeat(64) } },
            );
          const changed = await pre.preflight({
            verify: apps,
            proof: full.proof,
            fast: true,
            emit: () => {},
          });
          assert.equal(changed.ok, false);
          assert.equal(changed.code, "SCHEMA_CHANGED_DURING_STARTUP");
        } finally {
          await f.db
            .collection("schema_migrations")
            .updateOne(
              { _id: marker._id },
              { $set: { checksum: marker.checksum } },
            );
        }
        const state = await f.db
          .collection("operational_state")
          .findOne({ _id: "environment" });
        try {
          await f.db
            .collection("operational_state")
            .updateOne(
              { _id: "environment" },
              {
                $set: {
                  mode: "draining",
                  environment_id: require("node:crypto").randomUUID(),
                },
              },
            );
          const changed = await pre.preflight({
            verify: apps,
            proof: full.proof,
            fast: true,
            emit: () => {},
          });
          assert.equal(changed.ok, false);
          assert.equal(changed.stage, "operations");
        } finally {
          await f.db
            .collection("operational_state")
            .updateOne(
              { _id: "environment" },
              {
                $set: {
                  mode: state.mode,
                  environment_id: state.environment_id,
                },
              },
            );
        }
      } finally {
        await writer.release();
      }
    },
  );
