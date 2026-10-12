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
  "isolated PM2 overall deadline stops ready services and blocked coordinator; foreign service survives",
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
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "kl_pm2_deadline_")),
      entry = backend.resolvePm2Entry(),
      port = await freePort();
    const pathsFile = path.join(path.dirname(path.dirname(entry)), "paths.js"),
      prefix =
        "\\\\.\\pipe\\kl-deadline-" + require("node:crypto").randomUUID();
    const pipes = path.join(home, "pipes.cjs"),
      hooks = path.join(home, "hang.cjs");
    fs.writeFileSync(
      pipes,
      "const p=" +
        JSON.stringify(pathsFile) +
        ";const orig=require(p);require.cache[require.resolve(p)].exports=h=>{const c=orig(h);c.DAEMON_RPC_PORT=" +
        JSON.stringify(prefix + "-rpc") +
        ";c.DAEMON_PUB_PORT=" +
        JSON.stringify(prefix + "-pub") +
        ";c.INTERACTOR_RPC_PORT=" +
        JSON.stringify(prefix + "-interactor") +
        ";return c;};",
    );
    const timingPath = path.join(root, "ops/startup-timing.cjs");
    fs.writeFileSync(
      hooks,
      "if(process.argv.includes('--startup-coordinator')){const p=" +
        JSON.stringify(timingPath) +
        ";const original=require(p);require.cache[require.resolve(p)].exports={...original,timing:(scope,emit)=>{const c=original.timing(scope,emit);const run=c.run;c.run=(stage,task)=>run(stage,()=>{if(scope==='backend'&&stage===process.env.TEST_GUARD_HANG_STAGE)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);return task();});return c;}};}",
    );
    const env = {
      ...process.env,
      NODE_OPTIONS: "--require=" + pipes + " --require=" + hooks,
      PM2_HOME: home,
      KL_PM2_BIN: entry,
      PORT: String(port),
      MONGODB_URI: f.uri,
      FILE_STORAGE_DRIVER: "local",
      KL_PM2_STARTUP_TIMEOUT_MS: "30000",
      KL_PM2_TIMEOUT_STOP_GRACE_MS: "5000",
    };
    const helper = path.join(root, "ops/pm2-backend.cjs");
    const beforeDefault = process.env.PM2_HOME;
    const defaultEnv = { ...process.env };
    const defaultPid = path.join(
      beforeDefault || path.join(os.homedir(), ".pm2"),
      "pm2.pid",
    );
    const baseline = fs.existsSync(defaultPid)
      ? JSON.parse((await command(entry, ["jlist"], defaultEnv)).output).map(
          (p) => [p.name, p.pid, p.pm2_env.status],
        )
      : null;
    try {
      const sentinel = path.join(home, "sentinel.cjs");
      fs.writeFileSync(sentinel, "setInterval(()=>{},1000);");
      assert.equal(
        (
          await command(
            entry,
            ["start", sentinel, "--name", "unrelated-deadline-sentinel"],
            env,
          )
        ).code,
        0,
      );
      const foreign = JSON.parse(
        (await command(entry, ["jlist"], env)).output,
      ).find((p) => p.name === "unrelated-deadline-sentinel");
      assert.ok(foreign.pid > 0);
      const start = Date.now();
      const expired = await command(helper, ["start"], {
        ...env,
        TEST_GUARD_HANG_STAGE: "launch-ready",
      });
      if (expired.code !== 0)
        fs.writeFileSync(
          path.join(root, "ops/artifacts/pm2-206-deadline-stages.log"),
          expired.output,
        );
      assert.notEqual(expired.code, 0);
      assert.match(expired.output, /STARTUP_TOTAL_TIMEOUT/);
      assert.doesNotMatch(expired.output, /已就绪/);
      const events = expired.output
        .split(/\r?\n/)
        .filter((l) => l.startsWith('{"event":'))
        .map((l) => JSON.parse(l));
      for (const name of [
        "kl-api",
        "kl-assessment-worker",
        "kl-learning-worker",
      ])
        assert.ok(
          events.some(
            (e) =>
              e.event === "startup.stage" &&
              e.stage === "process-start." + name &&
              e.state === "completed",
          ),
          name + " must really be ready before timeout",
        );
      const final = events.findLast((e) => e.event === "startup.deadline");
      assert.equal(
        final.processes_stopped,
        true,
        expired.output.match(/[A-Z][A-Z0-9_]{3,}/g)?.join(","),
      );
      assert.equal(final.writers_released, true);
      assert.ok(Date.now() - start < 55000, "deadline plus cleanup is bounded");
      const after = JSON.parse((await command(entry, ["jlist"], env)).output);
      assert.equal(
        after.some((p) => /^kl-/.test(p.name)),
        false,
      );
      assert.equal(after.find((p) => p.name === foreign.name).pid, foreign.pid);
      assert.equal(
        await f.db
          .collection("operational_writers")
          .countDocuments({ state: "running" }),
        0,
      );
      await new Promise((r) => setTimeout(r, 1200));
      assert.equal(
        JSON.parse((await command(entry, ["jlist"], env)).output).some((p) =>
          /^kl-/.test(p.name),
        ),
        false,
        "no automatic restart",
      );
      const live = await command(helper, ["start"], env);
      assert.equal(
        live.code,
        0,
        live.output.match(/[A-Z][A-Z0-9_]{3,}/g)?.join(","),
      );
      assert.match(live.output, /已就绪/);
      const reused = await command(helper, ["start"], env);
      assert.equal(reused.code, 0);
      assert.match(reused.output, /已验证并复用/);
      const reuseExpired = await command(helper, ["start"], {
        ...env,
        TEST_GUARD_HANG_STAGE: "reuse-ready",
      });
      fs.writeFileSync(
        path.join(root, "ops/artifacts/pm2-206-reuse-deadline-stages.log"),
        reuseExpired.output,
      );
      assert.notEqual(reuseExpired.code, 0);
      assert.match(reuseExpired.output, /STARTUP_TOTAL_TIMEOUT/);
      assert.doesNotMatch(reuseExpired.output, /已验证并复用/);
      const reuseEvents = reuseExpired.output
        .split(/\r?\n/)
        .filter((l) => l.startsWith('{"event":'))
        .map((l) => JSON.parse(l));
      assert.ok(
        reuseEvents.some(
          (e) =>
            e.event === "startup.stage" &&
            e.stage === "reuse-ready" &&
            e.state === "started",
        ),
      );
      const reuseFinal = reuseEvents.findLast(
        (e) => e.event === "startup.deadline",
      );
      assert.equal(reuseFinal.processes_stopped, true);
      assert.equal(reuseFinal.writers_released, true);
      assert.equal(
        await f.db
          .collection("operational_writers")
          .countDocuments({ state: "running" }),
        0,
      );
      const reuseRows = JSON.parse(
        (await command(entry, ["jlist"], env)).output,
      );
      assert.equal(
        reuseRows.some((p) => /^kl-/.test(p.name)),
        false,
      );
      assert.equal(
        reuseRows.find((p) => p.name === foreign.name).pid,
        foreign.pid,
      );

      assert.equal((await command(helper, ["stop"], env)).code, 0);
      await t.test(
        "managed standalone timeout stops supervisor and child registration",
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
                "managed-55555555-5555-4555-a555-555555555555",
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
            TEST_GUARD_HANG_STAGE: "launch-ready",
          };
          try {
            const expired = await command(helper, ["start"], managedEnv);
            assert.notEqual(expired.code, 0);
            assert.match(expired.output, /STARTUP_TOTAL_TIMEOUT/);
            assert.doesNotMatch(expired.output, /已就绪/);
            const events = expired.output
              .split(/\r?\n/)
              .filter((l) => l.startsWith('{"event":'))
              .map((l) => JSON.parse(l));
            const final = events.findLast(
              (e) => e.event === "startup.deadline",
            );
            assert.equal(final.processes_stopped, true);
            assert.equal(final.writers_released, true);
            assert.equal(
              await g.db
                .collection("operational_writers")
                .countDocuments({ state: "running" }),
              0,
            );
            assert.equal(
              JSON.parse(
                (await command(entry, ["jlist"], managedEnv)).output,
              ).some((p) => /^kl-/.test(p.name)),
              false,
            );
          } finally {
            await command(helper, ["stop"], managedEnv);
          }
        },
      );
      if (baseline)
        assert.deepEqual(
          JSON.parse((await command(entry, ["jlist"], defaultEnv)).output).map(
            (p) => [p.name, p.pid, p.pm2_env.status],
          ),
          baseline,
        );
    } finally {
      await command(helper, ["stop"], env);
      await command(entry, ["delete", "unrelated-deadline-sentinel"], env);
      await command(entry, ["kill"], env);
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);
