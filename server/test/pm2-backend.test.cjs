"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveFeatureFlags,
  FEATURE_FLAGS,
} = require("../dist/runtime/feature-flags");
const { safeErrorCode } = require("../dist/runtime/process-lifecycle");
const backend = require("../../ops/pm2-backend.cjs");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { createServer } = require("node:http");
test("flags reject malformed values and unsafe combinations without echoing values", () => {
  for (const key of FEATURE_FLAGS)
    for (const value of ["tru", "TRUE", "", "1", "mongodb://secret"])
      assert.throws(
        () => resolveFeatureFlags({ [key]: value }),
        (error) => error.message === "INVALID_FLAG_" + key,
      );
  assert.equal(resolveFeatureFlags({}).FILE_SCAN_ENABLED, "true");
  assert.throws(
    () =>
      resolveFeatureFlags({
        KL_TRAINING_SURVEYS_ENABLED: "true",
        KL_TRAINING_ENABLED: "true",
      }),
    /FEATURE_SURVEY_IMPORT_REQUIRED/,
  );
  assert.throws(
    () => resolveFeatureFlags({ KL_STANDALONE_MANAGED_API_ENABLED: "true" }),
    /FEATURE_RECOVERY_REQUIRED/,
  );
  assert.equal(
    safeErrorCode(Error("mongodb://user:secret@host/database")),
    "RUNTIME_CHECK_FAILED",
  );
  assert.equal(
    safeErrorCode(Object.assign(Error("private path"), { code: "EADDRINUSE" })),
    "EADDRINUSE",
  );
});
test(
  "Windows refuses legacy live processes before stopping",
  { skip: process.platform !== "win32" },
  () => {
    assert.throws(
      () =>
        backend.assertStopSupported([
          {
            pid: 123,
            pm2_env: { status: "online", shutdown_with_message: false },
          },
        ]),
      /WINDOWS_LEGACY_SHUTDOWN_UNSUPPORTED/,
    );
    backend.assertStopSupported([
      {
        pid: 123,
        pm2_env: {
          status: "online",
          shutdown_with_message: true,
          KL_PM2_PROTOCOL: "1",
        },
      },
    ]);
  },
);
test("PM2 entry rejects a cmd shim instead of passing it to Node", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kl_pm2_entry_"));
  const old = process.env.KL_PM2_BIN;
  try {
    const file = path.join(dir, "pm2.cmd");
    fs.writeFileSync(file, "@echo off");
    process.env.KL_PM2_BIN = file;
    assert.throws(
      () => backend.resolvePm2Entry(),
      /PM2_JAVASCRIPT_ENTRY_REQUIRED/,
    );
  } finally {
    if (old === undefined) delete process.env.KL_PM2_BIN;
    else process.env.KL_PM2_BIN = old;
    fs.rmSync(path.join(dir, "pm2.cmd"));
    fs.rmdirSync(dir);
  }
});
test("PM2 online and HTTP 200 do not pass without this launch ready proof", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kl_pm2_ready_")),
    entry = path.join(dir, "mock.cjs");
  fs.writeFileSync(
    entry,
    "console.log(" +
      JSON.stringify(
        JSON.stringify([
          {
            name: "kl-api",
            pm_id: 0,
            pid: 12,
            pm2_env: {
              status: "online",
              restart_time: 0,
              pm_cwd: path.resolve(__dirname, ".."),
            },
          },
        ]),
      ) +
      ");",
  );
  try {
    await assert.rejects(
      backend.waitReady(entry, ["kl-api"], server.address().port, {
        timeoutMs: 600,
        readyProofs: new Set(),
      }),
      /STARTUP_READY_TIMEOUT/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(entry);
    fs.rmdirSync(dir);
  }
});

test("storage preflight never creates a missing private root", async () => {
  const old = process.env.FILE_STORAGE_ROOT;
  const missing = path.join(
    os.tmpdir(),
    "kl_missing_" + require("node:crypto").randomUUID(),
  );
  process.env.FILE_STORAGE_ROOT = missing;
  try {
    await assert.rejects(require("../dist/files/config").assertStorageReady());
    assert.equal(fs.existsSync(missing), false);
  } finally {
    if (old === undefined) delete process.env.FILE_STORAGE_ROOT;
    else process.env.FILE_STORAGE_ROOT = old;
  }
});

test("IPC shutdown is idempotent and disconnects after asynchronous cleanup", async () => {
  const { fork } = require("node:child_process");
  const { once } = require("node:events");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kl_shutdown_")),
    entry = path.join(dir, "child.cjs");
  const runtime = path.resolve(
    __dirname,
    "../dist/runtime/process-lifecycle.js",
  );
  fs.writeFileSync(
    entry,
    "const {installShutdown,notifyReady}=require(" +
      JSON.stringify(runtime) +
      ');let count=0;const timer=setInterval(()=>{},1000);const dispose=installShutdown(async()=>{count++;await new Promise(r=>setTimeout(r,40));process.send({event:"cleaned",count},()=>{clearInterval(timer);dispose();});});notifyReady();',
  );
  const child = fork(entry, [], {
    execArgv: [],
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...process.env, KL_PM2_PROTOCOL: "1" },
  });
  let cleanCount = 0;
  child.on("message", (value) => {
    if (value?.event === "cleaned") cleanCount = value.count;
  });
  const closed = once(child, "close");
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("CHILD_READY_TIMEOUT")),
        5000,
      );
      child.on("message", (value) => {
        if (value === "ready") {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    child.send("shutdown");
    child.send("shutdown");
    const [code] = await closed;
    assert.equal(code, 0);
    assert.equal(cleanCount, 1);
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(entry);
    fs.rmdirSync(dir);
  }
});

test(
  "Windows custom PM2_HOME with default pipes is rejected before stop",
  { skip: process.platform !== "win32" },
  async () => {
    const old = process.env.PM2_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "kl_unsafe_pm2_"));
    process.env.PM2_HOME = home;
    try {
      await assert.rejects(
        backend.main("stop"),
        /WINDOWS_PM2_HOME_NOT_ISOLATED/,
      );
    } finally {
      if (old === undefined) delete process.env.PM2_HOME;
      else process.env.PM2_HOME = old;
      fs.rmdirSync(home);
    }
  },
);

test("numeric Mongo diagnostics never expose document keys or credentials", () => {
  for (const [code, expected] of [
    [11000, "MONGO_DUPLICATE_KEY"],
    [13, "MONGO_NOT_AUTHORIZED"],
    [121, "MONGO_DOCUMENT_VALIDATION_FAILED"],
  ]) {
    assert.equal(
      safeErrorCode({ code, message: "private token and connection data" }),
      expected,
    );
    assert.equal(safeErrorCode(Error(expected)), expected);
  }
});
test("Mongo URI must name the application database explicitly", () => {
  const { loadConfig } = require("../dist/config");
  const base = {
    APP_ORIGIN: "http://localhost:5173",
    ALLOW_INSECURE_HTTP: "true",
    AUTH_RATE_LIMIT_KEY: "test-only-key-at-least-thirty-two-bytes",
  };
  assert.throws(
    () =>
      loadConfig({
        ...base,
        MONGODB_URI: "mongodb+srv://example.invalid/?appName=test",
      }),
    /显式指定数据库名/,
  );
  assert.equal(
    loadConfig({
      ...base,
      MONGODB_URI: "mongodb+srv://example.invalid/knowladder?appName=test",
    }).mongoTopology,
    "replicaSet",
  );
});

test("fatal startup with leaked sockets exits 78 and withholds raw error details", async () => {
  const { fork } = require("node:child_process");
  const { once } = require("node:events");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kl_fatal_lifecycle_"));
  const entry = path.join(dir, "failed.cjs");
  fs.writeFileSync(
    entry,
    "const {finishRuntimeFailure}=require(" +
      JSON.stringify(
        path.resolve(__dirname, "../dist/runtime/process-lifecycle.js"),
      ) +
      ");const server=require('node:net').createServer();server.listen(0,'127.0.0.1',()=>finishRuntimeFailure('fixture',Error('do-not-log-private-value')));",
  );
  const child = fork(entry, [], {
    execArgv: [],
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, KL_PM2_PROTOCOL: "2" },
  });
  let diagnostic = "";
  child.stderr.on("data", (chunk) => (diagnostic += chunk));
  const started = Date.now();
  try {
    const [code] = await once(child, "close");
    assert.equal(code, 78);
    assert.ok(Date.now() - started < 8000);
    assert.match(diagnostic, /RUNTIME_CHECK_FAILED/);
    assert.ok(!diagnostic.includes("do-not-log-private-value"));
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(entry);
    fs.rmdirSync(dir);
  }
});
