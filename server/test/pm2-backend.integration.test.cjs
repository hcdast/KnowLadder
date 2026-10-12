"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fixture } = require("./helpers.cjs");
const { spawn } = require("node:child_process");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { createServer } = require("node:net");
const { FEATURE_FLAGS } = require("../dist/runtime/feature-flags");
const backend = require("../../ops/pm2-backend.cjs");
const root = path.resolve(__dirname, "../..");
async function freePort() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const p = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return p;
}
function command(entry, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (s) => (output += s));
    child.stderr.on("data", (s) => (output += s));
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("TEST_COMMAND_TIMEOUT"));
    }, 150000);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}
test(
  "isolated Windows PM2: read-only preflight, real API/workers ready, validation preserves processes, IPC releases writers",
  { timeout: 240000 },
  async (t) => {
    const flags = Object.fromEntries(
      FEATURE_FLAGS.map((key) => [key, "false"]),
    );
    const f = await fixture(t, {
      app: false,
      topology: "standalone",
      env: {
        ...flags,
        ALLOW_INSECURE_HTTP: "true",
        KL_MONGO_ALLOW_STANDALONE: "true",
        KL_MONGO_TOPOLOGY: "standalone",
      },
    });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "kl_pm2_isolated_"));
    const entry = backend.resolvePm2Entry(),
      port = await freePort();
    const preload = path.join(home, "isolated-pipes.cjs");
    const pathsFile = path.join(path.dirname(path.dirname(entry)), "paths.js");
    const prefix =
      "\\\\.\\pipe\\kl-test-" +
      require("node:crypto")
        .createHash("sha256")
        .update(home)
        .digest("hex")
        .slice(0, 24);
    fs.writeFileSync(
      preload,
      "const p=" +
        JSON.stringify(pathsFile) +
        ";const original=require(p);require.cache[require.resolve(p)].exports=(home)=>{const config=original(home);config.DAEMON_RPC_PORT=" +
        JSON.stringify(prefix + "-rpc") +
        ";config.DAEMON_PUB_PORT=" +
        JSON.stringify(prefix + "-pub") +
        ";config.INTERACTOR_RPC_PORT=" +
        JSON.stringify(prefix + "-interactor") +
        ";return config;};",
    );
    const env = {
      ...process.env,
      NODE_OPTIONS: "--require=" + preload,
      PM2_HOME: home,
      KL_PM2_BIN: entry,
      PORT: String(port),
      MONGODB_URI: f.uri,
      FILE_STORAGE_DRIVER: "local",
      KL_PM2_START_MODE: "serial",
    };
    const helper = path.join(root, "ops/pm2-backend.cjs");
    async function rows() {
      const result = await command(entry, ["jlist"], env);
      assert.equal(result.code, 0);
      return JSON.parse(result.output).filter((p) => /^kl-/.test(p.name));
    }
    const defaultHome = process.env.PM2_HOME || path.join(os.homedir(), ".pm2");
    const defaultPidFile = path.join(defaultHome, "pm2.pid");
    const defaultSnapshot = fs.existsSync(defaultPidFile)
      ? await command(entry, ["jlist"], { ...process.env })
      : null;
    let historicalRunning = 0;
    try {
      const verifyEntry = path.join(home, "verify-pipes.cjs");
      fs.writeFileSync(
        verifyEntry,
        "const c=require(" +
          JSON.stringify(pathsFile) +
          ")(process.env.PM2_HOME);if(c.DAEMON_RPC_PORT!==" +
          JSON.stringify(prefix + "-rpc") +
          "||c.DAEMON_PUB_PORT!==" +
          JSON.stringify(prefix + "-pub") +
          ")process.exitCode=1;",
      );
      assert.equal(
        (await command(verifyEntry, [], env)).code,
        0,
        "RPC and PUB must both be unique",
      );
      const isolatedPaths = await command(entry, ["jlist"], env);
      assert.equal(isolatedPaths.code, 0, "isolated daemon starts");
      assert.ok(
        fs.existsSync(path.join(home, "pm2.pid")),
        "daemon must belong to the dedicated home",
      );
      const before = await f.db
        .collection("operational_writers")
        .countDocuments({});
      const pre = await command(helper, ["preflight"], env);
      assert.equal(
        pre.code,
        0,
        "read-only preflight passes: " +
          (pre.output.match(/[A-Z][A-Z0-9_]{3,}/g) || []).join(","),
      );
      assert.equal(
        await f.db.collection("operational_writers").countDocuments({}),
        before,
        "preflight must not register writer",
      );
      const startupAt = Date.now();
      const started = await command(helper, ["start"], env);
      assert.equal(
        started.code,
        0,
        "backend start must confirm readiness: " +
          (started.output.match(/[A-Z][A-Z0-9_]{3,}/g) || []).join(","),
      );
      assert.match(started.output, /已就绪/);
      const launchStages = started.output
        .split(/\r?\n/)
        .filter((line) => line.startsWith('{"event":"startup.stage"'))
        .map((line) => JSON.parse(line))
        .filter(
          (e) =>
            e.scope === "launch" && ["started", "completed"].includes(e.state),
        );
      assert.deepEqual(
        launchStages.map((e) => [e.stage, e.state]),
        ["kl-api", "kl-assessment-worker", "kl-learning-worker"].flatMap(
          (name) => [
            ["process-start." + name, "started"],
            ["process-start." + name, "completed"],
          ],
        ),
        "each real entry is verified before the next starts",
      );
      for (const name of [
        "kl-api",
        "kl-assessment-worker",
        "kl-learning-worker",
      ]) {
        const events = started.output
          .split(/\r?\n/)
          .filter((line) => line.startsWith('{"event":"startup.'))
          .map((line) => JSON.parse(line));
        const readyIndex = events.findIndex(
          (e) => e.event === "startup.worker-ready" && e.name === name,
        );
        const completedIndex = events.findIndex(
          (e) =>
            e.scope === "launch" &&
            e.stage === "process-start." + name &&
            e.state === "completed",
        );
        assert.ok(
          readyIndex >= 0 && completedIndex > readyIndex,
          "real ready log must exist and precede entry completion",
        );
      }

      assert.ok(
        Date.now() - startupAt < 45000,
        "ready IPC must precede PM2 listen timeout",
      );
      const initial = await rows();
      assert.equal(initial.length, 3);
      assert.ok(initial.every((p) => p.pm2_env.status === "online"));
      assert.equal(
        await f.db
          .collection("operational_writers")
          .countDocuments({ state: "running" }),
        3,
      );
      const writersBeforeReuse = await f.db
        .collection("operational_writers")
        .find({ state: "running" })
        .toArray();
      const reuseAt = Date.now(),
        reused = await command(helper, ["start"], env);
      assert.equal(
        reused.code,
        0,
        "healthy exact start reuses: " +
          (reused.output.match(/[A-Z][A-Z0-9_]{3,}/g) || []).join(","),
      );
      assert.match(reused.output, /已验证并复用/);
      assert.deepEqual(
        (await rows()).map((p) => p.pid),
        initial.map((p) => p.pid),
      );
      assert.deepEqual(
        (
          await f.db
            .collection("operational_writers")
            .find({ state: "running" })
            .toArray()
        )
          .map((r) => r.token)
          .sort(),
        writersBeforeReuse.map((r) => r.token).sort(),
      );
      const stages = reused.output
        .split(/\r?\n/)
        .filter((line) => line.startsWith('{"event":"startup.stage"'))
        .map((line) => JSON.parse(line));
      assert.equal(
        stages.filter(
          (r) =>
            r.scope === "preflight" &&
            r.stage === "schema" &&
            r.state === "started",
        ).length,
        1,
        "only initial full schema remains",
      );
      assert.equal(
        stages.filter(
          (r) =>
            r.scope === "ready" &&
            r.stage === "writer-verify" &&
            r.state === "completed",
        ).length,
        2,
      );
      assert.ok(
        !stages.some(
          (r) =>
            r.scope === "backend" &&
            ["stop", "delete", "process-start"].includes(r.stage),
        ),
      );
      console.log(
        JSON.stringify({
          event: "isolated.start.timings",
          cold_ms: reuseAt - startupAt,
          reuse_ms: Date.now() - reuseAt,
        }),
      );
      const changed = await command(helper, ["start"], {
        ...env,
        PORT: String(port + 1),
      });
      assert.notEqual(changed.code, 0);
      assert.match(changed.output, /DEPLOYMENT_CHANGED_RESTART_REQUIRED/);
      assert.deepEqual(
        (await rows()).map((p) => p.pid),
        initial.map((p) => p.pid),
      );
      const ready = await fetch(
        "http://127.0.0.1:" + port + "/api/v1/health/ready",
      );
      assert.equal(ready.status, 200);
      await ready.body.cancel();
      for (const invalid of [
        { KL_TRAINING_ENABLED: "tru" },
        { KL_TRAINING_ENABLED: "true" },
        { MONGODB_URI: f.uri.replace(/127\.0\.0\.1:\d+/, "127.0.0.1:1") },
      ]) {
        const failed = await command(helper, ["restart"], {
          ...env,
          ...invalid,
        });
        assert.notEqual(failed.code, 0);
        assert.doesNotMatch(failed.output, /已就绪|mongodb:\/\//);
        assert.deepEqual(
          (await rows()).map((p) => p.pid),
          initial.map((p) => p.pid),
          "invalid flag/schema must preserve old processes",
        );
      }
      const wrongDb = await command(helper, ["stop"], {
        ...env,
        MONGODB_URI: f.uri.replace(
          /kl_test_[^/?]+/,
          "kl_test_pm2_wrong_database",
        ),
      });
      assert.notEqual(wrongDb.code, 0);
      assert.deepEqual(
        (await rows()).map((p) => p.pid),
        initial.map((p) => p.pid),
        "stop with changed database preserves old processes",
      );

      // Reuse the same PM2 definition: the previous regression only delete/start'ed it.
      const launchTokens = initial.map((p) => p.pm2_env.KL_WRITER_LAUNCH_TOKEN);
      const priorWriters = await f.db
        .collection("operational_writers")
        .find({ state: "running" })
        .toArray();
      assert.equal(
        (
          await command(
            entry,
            ["restart", "kl-api", "kl-assessment-worker", "kl-learning-worker"],
            env,
          )
        ).code,
        0,
      );
      const deadline = Date.now() + 45000;
      let replacement;
      do {
        replacement = await rows();
        if (
          replacement.length === 3 &&
          replacement.every(
            (p) =>
              p.pm2_env.status === "online" &&
              !initial.some((old) => old.pid === p.pid),
          ) &&
          (await f.db
            .collection("operational_writers")
            .countDocuments({ state: "running" })) === 3
        )
          break;
        await new Promise((r) => setTimeout(r, 250));
      } while (Date.now() < deadline);
      assert.ok(
        replacement.every(
          (p) =>
            p.pm2_env.status === "online" &&
            !initial.some((old) => old.pid === p.pid),
        ),
        "same-definition restart reaches ready with new PIDs",
      );
      assert.deepEqual(
        replacement.map((p) => p.pm2_env.KL_WRITER_LAUNCH_TOKEN),
        launchTokens,
        "deployment identities remain stable",
      );
      const newWriters = await f.db
        .collection("operational_writers")
        .find({ state: "running" })
        .toArray();
      assert.equal(newWriters.length, 3);
      assert.ok(
        newWriters.every(
          (row) => !priorWriters.some((old) => old.token === row.token),
        ),
        "each restart gets fresh writer identities",
      );
      assert.equal(
        await f.db.collection("operational_writers").countDocuments({
          _id: { $in: priorWriters.map((r) => r._id) },
          state: "stopped",
        }),
        3,
      );

      const crashed = replacement.find(
        (p) => p.name === "kl-assessment-worker",
      );
      const oldOwner = await f.db
        .collection("operational_writers")
        .findOne({ pid: crashed.pid, state: "running" });
      process.kill(crashed.pid, "SIGKILL"); // Only this dedicated-pipe fixture's child.
      const crashDeadline = Date.now() + 45000;
      let recovered;
      do {
        recovered = (await rows()).find((p) => p.name === crashed.name);
        if (
          recovered?.pm2_env.status === "online" &&
          recovered.pid !== crashed.pid &&
          (await f.db
            .collection("operational_writers")
            .findOne({ pid: recovered.pid, state: "running" }))
        )
          break;
        await new Promise((r) => setTimeout(r, 250));
      } while (Date.now() < crashDeadline);
      assert.ok(
        recovered?.pm2_env.status === "online" && recovered.pid !== crashed.pid,
        "PM2 automatically recovers a raw Windows crash",
      );
      assert.equal(
        recovered.pm2_env.restart_time,
        crashed.pm2_env.restart_time + 1,
      );
      assert.equal(
        recovered.pm2_env.KL_WRITER_LAUNCH_TOKEN,
        crashed.pm2_env.KL_WRITER_LAUNCH_TOKEN,
      );
      assert.ok(
        await f.db.collection("operational_writers").findOne({
          _id: oldOwner._id,
          token: oldOwner.token,
          state: "running",
        }),
        "crashed owner is preserved, never silently marked stopped",
      );
      historicalRunning = 1;
      const stopped = await command(helper, ["stop"], env);
      if (stopped.code !== 0)
        console.log(
          stopped.output
            .split(/\r?\n/)
            .filter(
              (line) =>
                line.startsWith('{"event":"startup.') || /^[A-Z_]+$/.test(line),
            )
            .join("\n"),
        );
      assert.equal(
        stopped.code,
        0,
        "IPC stop must confirm writer release: " +
          (stopped.output.match(/[A-Z][A-Z0-9_]{3,}/g) || []).join(","),
      );
      assert.equal((await rows()).length, 0);
      assert.equal(
        await f.db
          .collection("operational_writers")
          .countDocuments({ state: "running" }),
        historicalRunning,
        "real API and both workers release registrations before exit",
      );
      const unknownOwner = await command(helper, ["start"], env);
      assert.notEqual(
        unknownOwner.code,
        0,
        "serial rejects the preserved raw-crash owner",
      );
      assert.match(unknownOwner.output, /MANAGED_UNKNOWN_WRITER/);
      assert.equal(
        (await rows()).filter((p) => p.pid).length,
        0,
        "failed serial prefix is cleaned",
      );
      assert.ok(
        !unknownOwner.output.includes(
          '"scope":"launch","stage":"process-start.kl-assessment-worker","state":"started"',
        ),
        "unknown writer stops before next entry",
      );
      assert.equal(
        await f.db
          .collection("operational_writers")
          .countDocuments({ state: "running" }),
        historicalRunning,
        "old owner is neither deleted nor silently released",
      );
      // Keep the abandoned owner evidence in its original DB. Other scenarios use a new guarded fixture.
      const clean = await fixture(t, {
        app: false,
        topology: "standalone",
        env: {
          ...flags,
          ALLOW_INSECURE_HTTP: "true",
          KL_MONGO_ALLOW_STANDALONE: "true",
          KL_MONGO_TOPOLOGY: "standalone",
        },
      });
      env.MONGODB_URI = clean.uri;
      const restarted = await command(helper, ["start"], env);
      assert.equal(restarted.code, 0, "fresh start after clean shutdown");
      const finalStop = await command(helper, ["stop"], env);
      assert.equal(finalStop.code, 0);
      assert.equal(
        await clean.db
          .collection("operational_writers")
          .countDocuments({ state: "running" }),
        0,
      );
      assert.equal(
        await f.db
          .collection("operational_writers")
          .countDocuments({ state: "running" }),
        historicalRunning,
      );
      const parallelEnv = { ...env, KL_PM2_START_MODE: "parallel" };
      const parallel = await command(helper, ["start"], parallelEnv);
      assert.equal(
        parallel.code,
        0,
        "explicit parallel retains all-entry path",
      );
      assert.ok(!parallel.output.includes('"scope":"launch"'));
      assert.equal(
        (await command(helper, ["start"], parallelEnv)).code,
        0,
        "parallel deployment can be reused",
      );
      const modeChanged = await command(helper, ["start"], env);
      assert.notEqual(modeChanged.code, 0);
      assert.match(modeChanged.output, /DEPLOYMENT_CHANGED_RESTART_REQUIRED/);
      assert.equal((await command(helper, ["stop"], parallelEnv)).code, 0);
      const invalidMode = await command(helper, ["start"], {
        ...env,
        KL_PM2_START_MODE: "invalid",
      });
      assert.notEqual(invalidMode.code, 0);
      assert.match(invalidMode.output, /INVALID_CONFIG_KL_PM2_START_MODE/);
      await t.test(
        "serial managed standalone API: real supervisor ready, child writer and strict stop",
        async (managedT) => {
          const g = await fixture(managedT, {
            app: false,
            topology: "standalone",
            env: {
              ...flags,
              ALLOW_INSECURE_HTTP: "true",
              KL_MONGO_ALLOW_STANDALONE: "true",
              KL_MONGO_TOPOLOGY: "standalone",
              KL_TRAINING_ENABLED: "true",
              KL_STANDALONE_RECOVERY_ENABLED: "true",
              KL_STANDALONE_MANAGED_API_ENABLED: "true",
              KL_MANAGED_WRITER_OWNER:
                "managed-44444444-4444-4444-a444-444444444444",
            },
          });
          const managedEnv = {
            ...env,
            ...flags,
            MONGODB_URI: g.uri,
            ALLOW_INSECURE_HTTP: "true",
            KL_MONGO_ALLOW_STANDALONE: "true",
            KL_TRAINING_ENABLED: "true",
            KL_STANDALONE_RECOVERY_ENABLED: "true",
            KL_STANDALONE_MANAGED_API_ENABLED: "true",
            KL_MANAGED_WRITER_OWNER: process.env.KL_MANAGED_WRITER_OWNER,
          };
          try {
            const managedStart = await command(helper, ["start"], managedEnv);
            assert.equal(
              managedStart.code,
              0,
              (managedStart.output.match(/[A-Z][A-Z0-9_]{3,}/g) || []).join(
                ",",
              ),
            );
            const managedRows = JSON.parse(
              (await command(entry, ["jlist"], managedEnv)).output,
            );
            assert.deepEqual(
              managedRows.map((p) => p.name),
              ["kl-api"],
            );
            assert.match(
              managedStart.output,
              /"scope":"launch","stage":"process-start.kl-api","state":"completed"/,
            );
            assert.equal(
              await g.db
                .collection("operational_writers")
                .countDocuments({ state: "running" }),
              1,
              "managed child retains its API registration; supervisor has no tokens",
            );
            assert.equal(
              await g.db
                .collection("operational_writers")
                .countDocuments({ state: "running", pid: managedRows[0].pid }),
              0,
            );
            const response = await fetch(
              "http://127.0.0.1:" + port + "/api/v1/health/ready",
            );
            assert.equal(response.status, 200);
            await response.body.cancel();
            assert.equal((await command(helper, ["stop"], managedEnv)).code, 0);
            assert.equal(
              await g.db
                .collection("operational_writers")
                .countDocuments({ state: "running" }),
              0,
              "controlled exit releases the managed child writer",
            );
            assert.equal(
              JSON.parse((await command(entry, ["jlist"], managedEnv)).output)
                .length,
              0,
            );
          } finally {
            await command(helper, ["stop"], managedEnv);
          }
        },
      );
      const poison = path.join(home, "startup-failure.cjs");
      fs.writeFileSync(poison, "if(process.env.pm_exec_path)process.exit(1);");
      const postLaunchFailure = await command(helper, ["start"], {
        ...env,
        NODE_OPTIONS: env.NODE_OPTIONS + " --require=" + poison,
      });
      assert.notEqual(
        postLaunchFailure.code,
        0,
        "post-preflight process failure returns nonzero",
      );
      assert.doesNotMatch(postLaunchFailure.output, /已就绪/);
      assert.equal(
        (await rows()).filter((p) => p.pid).length,
        0,
        "failed launch stops this project processes",
      );
      assert.equal(
        await f.db
          .collection("operational_writers")
          .countDocuments({ state: "running" }),
        historicalRunning,
      );
      assert.equal(
        await clean.db
          .collection("operational_writers")
          .countDocuments({ state: "running" }),
        0,
        "failed new launch releases the fresh fixture writers",
      );
      const occupied = createServer();
      await new Promise((resolve) =>
        occupied.listen(port, "127.0.0.1", resolve),
      );
      try {
        const failed = await command(helper, ["start"], env);
        assert.notEqual(failed.code, 0);
        assert.match(failed.output, /API_PORT_UNAVAILABLE/);
        assert.equal((await rows()).filter((p) => p.pid).length, 0);
      } finally {
        await new Promise((resolve) => occupied.close(resolve));
      }
      const fake = path.join(home, "fail-pm2.cjs");
      fs.writeFileSync(
        fake,
        "if(process.argv[2]==='jlist')console.log('[]');else process.exitCode=1;",
      );
      // start failures in the PM2 command/package path return nonzero without claiming ready.
      const failed = await command(helper, ["start"], {
        ...env,
        KL_PM2_BIN: fake,
      });
      assert.notEqual(failed.code, 0);
      assert.doesNotMatch(failed.output, /已就绪/);
    } finally {
      assert.ok(
        env.NODE_OPTIONS.includes(preload),
        "cleanup must retain pipe isolation preload",
      );
      await command(entry, ["kill"], env); // Unique RPC/PUB pipes, not PM2_HOME alone.
      if (defaultSnapshot) {
        const after = await command(entry, ["jlist"], { ...process.env });
        const summary = (output) =>
          JSON.parse(output.trim().split(/\r?\n/).at(-1)).map((p) => ({
            name: p.name,
            pid: p.pid,
            status: p.pm2_env.status,
          }));
        assert.deepEqual(
          summary(after.output),
          summary(defaultSnapshot.output),
          "default business PM2 processes must be unchanged",
        );
      }
      const resolved = path.resolve(home);
      assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  },
);
