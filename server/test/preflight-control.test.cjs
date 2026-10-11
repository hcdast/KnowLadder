"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  { spawn } = require("node:child_process");
const {
    preflightBudget,
    effectiveBudget,
    deadline,
    bounded,
  } = require("../../ops/preflight-budget.cjs"),
  { timing } = require("../../ops/startup-timing.cjs");
test("budget defaults, strict range and env precedence", () => {
  assert.equal(preflightBudget(false, {}), 120000);
  assert.equal(preflightBudget(true, {}), 90000);
  for (const v of [
    "",
    "9999",
    "600001",
    "12.2",
    "Infinity",
    "secret",
    "120000x",
  ])
    assert.throws(
      () => preflightBudget(false, { KL_PREFLIGHT_TIMEOUT_MS: v }),
      /^Error: INVALID_CONFIG_KL_PREFLIGHT_TIMEOUT_MS$/,
    );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kl-budget-")),
    f = path.join(dir, ".env");
  try {
    fs.writeFileSync(f, "KL_PREFLIGHT_TIMEOUT_MS=25000\n");
    assert.equal(effectiveBudget(false, f, {}), 25000);
    assert.equal(
      effectiveBudget(false, f, { KL_PREFLIGHT_TIMEOUT_MS: "30000" }),
      30000,
    );
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
test("deadline cancels work and tracks it until actual cleanup", async () => {
  const d = deadline(25);
  let cleaned = false;
  try {
    await assert.rejects(
      d.run(
        () =>
          new Promise((resolve) =>
            d.signal.addEventListener(
              "abort",
              () =>
                setTimeout(() => {
                  cleaned = true;
                  resolve();
                }, 20),
              { once: true },
            ),
          ),
      ),
      /PREFLIGHT_TIMEOUT/,
    );
    assert.equal(cleaned, false);
    await bounded(Promise.allSettled([...d.pending]), 500);
    assert.equal(cleaned, true);
    assert.equal(d.pending.size, 0);
  } finally {
    d.dispose();
  }
  await assert.rejects(
    bounded(new Promise(() => {}), 20),
    /PREFLIGHT_CLEANUP_TIMEOUT/,
  );
});
test("external cancel and settled work cannot later report timeout", async () => {
  const controller = new AbortController(),
    d = deadline(100, controller.signal);
  controller.abort();
  try {
    await assert.rejects(
      d.run(() => assert.fail("must not execute")),
      /PREFLIGHT_CANCELLED/,
    );
  } finally {
    d.dispose();
  }
});
test("waiting heartbeat clears after completion and contains no task values", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const rows = [];
  let finish;
  const clock = timing("test", (r) => rows.push(r)),
    work = clock.run("schema.indexes", () => new Promise((r) => (finish = r)));
  t.mock.timers.tick(5000);
  assert.equal(rows.at(-1).state, "waiting");
  assert.equal(typeof rows.at(-1).elapsed_ms, "number");
  finish("private value");
  await work;
  const count = rows.length;
  t.mock.timers.tick(20000);
  assert.equal(rows.length, count);
  assert.ok(!JSON.stringify(rows).includes("private value"));
});
test("independent CLI bounds pending stdin and prints exactly one stdout failure", async () => {
  const r = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.resolve(__dirname, "../../ops/backend-preflight.cjs"),
        "verify",
        "--budget-ms=40",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, KL_PREFLIGHT_TIMEOUT_MS: "10000" },
        windowsHide: true,
      },
    );
    let stdout = "",
      stderr = "";
    const guard = setTimeout(() => {
      child.kill();
      reject(Error("CLI_NOT_BOUNDED"));
    }, 6000);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(guard);
      resolve({ code, stdout, stderr });
    });
  });
  assert.equal(r.code, 1);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    ok: false,
    stage: "preflight",
    code: "PREFLIGHT_TIMEOUT",
  });
});

test(
  "independent CLI cancels a real nonresponding Mongo socket",
  { timeout: 8000 },
  async () => {
    const net = require("node:net"),
      { FEATURE_FLAGS } = require("../dist/runtime/feature-flags"),
      sockets = new Set(),
      server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const result = await new Promise((resolve, reject) => {
        const env = {
          ...process.env,
          ...Object.fromEntries(FEATURE_FLAGS.map((k) => [k, "false"])),
          NODE_ENV: "test",
          MONGODB_URI:
            "mongodb://127.0.0.1:" +
            server.address().port +
            "/kl_test_stalled_preflight",
          APP_ORIGIN: "http://127.0.0.1:5174",
          AUTH_RATE_LIMIT_KEY: "original-test-only-auth-key-at-least-32-bytes",
          ALLOW_INSECURE_HTTP: "true",
          KL_MONGO_ALLOW_STANDALONE: "true",
          KL_MONGO_TOPOLOGY: "standalone",
          KL_PREFLIGHT_TIMEOUT_MS: "10000",
        };
        const child = spawn(
          process.execPath,
          [
            path.resolve(__dirname, "../../ops/backend-preflight.cjs"),
            "--budget-ms=100",
          ],
          { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        let out = "",
          err = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(Error("CLI_NOT_BOUNDED"));
        }, 5000);
        child.stdout.on("data", (c) => (out += c));
        child.stderr.on("data", (c) => (err += c));
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ out, err, code });
        });
      });
      assert.equal(result.code, 1);
      const row = JSON.parse(result.out);
      assert.equal(row.ok, false);
      assert.equal(row.code, "PREFLIGHT_TIMEOUT");
      assert.equal(row.stage, "database-connect");
      assert.notEqual(row.cleanup_ok, false);
      assert.ok(result.err.includes("database-close"));
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((r) => server.close(r));
    }
  },
);
