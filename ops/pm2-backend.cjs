"use strict";
const { spawnSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const root = path.resolve(__dirname, ".."),
  serverRoot = path.join(root, "server");
const ecosystem = path.join(root, "ecosystem.config.js");
const nodeBin = process.env.KL_NODE_BIN || process.execPath;
const projectNames = [
  "kl-api",
  "kl-files-worker",
  "kl-assessment-worker",
  "kl-learning-worker",
  "kl-knowledge-worker",
  "kl-import-worker",
];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function failure(code) {
  return Object.assign(Error(code), { safeCode: code });
}
function resolvePm2Entry() {
  if (process.env.KL_PM2_BIN) {
    const p = path.resolve(process.env.KL_PM2_BIN);
    if (
      !fs.existsSync(p) ||
      !fs.statSync(p).isFile() ||
      /\.(cmd|bat|exe)$/i.test(p)
    )
      throw failure("PM2_JAVASCRIPT_ENTRY_REQUIRED");
    return p;
  }
  const which = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    [process.platform === "win32" ? "pm2.cmd" : "pm2"],
    { encoding: "utf8", windowsHide: true, timeout: 5000 },
  );
  for (const p of (which.stdout || "").split(/\r?\n/).filter(Boolean)) {
    const nearby = path.join(
      path.dirname(p.trim()),
      "node_modules",
      "pm2",
      "bin",
      "pm2",
    );
    if (fs.existsSync(nearby)) return nearby;
  }
  try {
    return require.resolve("pm2/bin/pm2");
  } catch {
    throw failure("PM2_NOT_FOUND");
  }
}
function execute(entry, args, { input, timeout = 75000 } = {}) {
  const result = spawnSync(nodeBin, [entry, ...args], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    input,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  return result;
}
function runPm2(entry, args, options) {
  const r = execute(entry, args, options);
  if (r.error || r.status !== 0) throw failure("PM2_COMMAND_FAILED");
}
async function runPm2Start(entry, args, timeout) {
  // Keep the readiness bus draining while PM2 starts each wait_ready process.
  await new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [entry, ...args], {
      cwd: root,
      env: process.env,
      windowsHide: true,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(failure("PM2_COMMAND_TIMEOUT"));
    }, timeout);
    child.once("error", () => {
      clearTimeout(timer);
      reject(failure("PM2_COMMAND_FAILED"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(failure("PM2_COMMAND_FAILED"));
    });
  });
}
function projectProcesses(entry) {
  const r = execute(entry, ["jlist"], { timeout: 10000 });
  if (r.error || r.status !== 0) throw failure("PM2_LIST_FAILED");
  try {
    const rows = JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
    if (!Array.isArray(rows)) throw Error();
    const apps = rows.filter((p) => projectNames.includes(p.name));
    for (const p of apps) {
      if (path.resolve(p.pm2_env.pm_cwd || "") !== serverRoot)
        throw failure("PM2_NAME_OWNERSHIP_CONFLICT");
    }
    if (new Set(apps.map((p) => p.name)).size !== apps.length)
      throw failure("PM2_DUPLICATE_NAME");
    return apps;
  } catch (error) {
    if (error.safeCode) throw error;
    throw failure("PM2_LIST_INVALID");
  }
}
function requireBuild() {
  if (!fs.existsSync(nodeBin)) throw failure("NODE_BIN_NOT_FOUND");
  if (!fs.existsSync(path.join(serverRoot, ".env")))
    throw failure("ENV_FILE_REQUIRED");
  // Source files newer than their emitted JavaScript require an explicit build.
  function check(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) check(file);
      else if (file.endsWith(".ts") && !file.endsWith(".d.ts")) {
        const js = path
          .join(
            serverRoot,
            "dist",
            path.relative(path.join(serverRoot, "src"), file),
          )
          .replace(/\.ts$/, ".js");
        if (
          !fs.existsSync(js) ||
          fs.statSync(js).mtimeMs < fs.statSync(file).mtimeMs
        )
          throw failure("BUILD_REQUIRED");
      }
    }
  }
  check(path.join(serverRoot, "src"));
  let apps;
  try {
    delete require.cache[require.resolve(ecosystem)];
    apps = require(ecosystem).apps;
  } catch (error) {
    const code =
      require("../server/dist/runtime/process-lifecycle").safeErrorCode(error);
    throw failure(code);
  }
  for (const app of apps)
    if (!fs.existsSync(path.join(app.cwd, app.script)))
      throw failure("BUILD_REQUIRED");
  return apps;
}
function parsePreflightResult(result) {
  if (result.error)
    throw failure(
      result.error.code === "ETIMEDOUT"
        ? "PREFLIGHT_TIMEOUT"
        : "PREFLIGHT_PROCESS_FAILED",
    );
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw failure("PREFLIGHT_FAILED");
  }
}
function preflight(verify, mode = "verify", budgetMs) {
  const r = spawnSync(
    nodeBin,
    [
      "--env-file-if-exists=.env",
      path.join(__dirname, "backend-preflight.cjs"),
      ...(verify ? [mode] : []),
    ],
    {
      cwd: serverRoot,
      env: process.env,
      encoding: "utf8",
      windowsHide: true,
      input: verify ? JSON.stringify(verify) : undefined,
      timeout: budgetMs ?? (verify ? 90000 : 120000),
      maxBuffer: 32768,
    },
  );
  const result = parsePreflightResult(r);
  if (r.error || r.status !== 0 || !result.ok) {
    const stage = [
      "node",
      "configuration",
      "database-connect",
      "topology",
      "schema",
      "operations",
      "managed-admission",
      "storage",
      "scanner",
      "worker-ready",
      "writer-stop",
    ].includes(result.stage)
      ? result.stage
      : "preflight";
    const code =
      require("../server/dist/runtime/process-lifecycle").safeErrorCode(
        Error(result.code),
      );
    throw failure(
      "PREFLIGHT_" + stage.toUpperCase().replaceAll("-", "_") + "_" + code,
    );
  }
  return result;
}
function assertStopSupported(rows) {
  if (
    process.platform === "win32" &&
    rows.some(
      (p) =>
        p.pid &&
        p.pm2_env.status !== "stopped" &&
        (p.pm2_env.shutdown_with_message !== true ||
          !["1", "2"].includes(p.pm2_env.KL_PM2_PROTOCOL)),
    )
  )
    throw failure("WINDOWS_LEGACY_SHUTDOWN_UNSUPPORTED");
}
async function waitStopped(readProcesses, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  do {
    const rows = readProcesses();
    if (rows.every((p) => !p.pid && p.pm2_env.status === "stopped")) return;
    if (Date.now() >= until) throw failure("PM2_STOP_NOT_CONFIRMED");
    await pause(Math.min(250, Math.max(1, until - Date.now())));
  } while (true);
}
async function stopProject(entry, rows) {
  assertStopSupported(rows);
  const launched = rows.filter(
    (p) => p.pid && ["1", "2"].includes(p.pm2_env.KL_PM2_PROTOCOL),
  );
  const identities = launched.map((p) => ({
    name: p.name,
    pid: p.pid,
    protocol: p.pm2_env.KL_PM2_PROTOCOL,
    token: p.pm2_env.KL_WRITER_LAUNCH_TOKEN,
    databaseId: p.pm2_env.KL_PM2_DATABASE_ID,
  }));
  const stopProof = launched.length
    ? preflight(identities, "identity").registrations
    : [];
  for (const app of rows)
    if (app.pm2_env.status !== "stopped")
      runPm2(entry, ["stop", String(app.pm_id)], {
        timeout: Math.max(
          75000,
          Number(app.pm2_env.kill_timeout || 10000) + 15000,
        ),
      });
  await waitStopped(() => projectProcesses(entry));
  if (launched.length) preflight(stopProof, "stopped");
}
function deleteProject(entry, rows) {
  for (const p of rows) runPm2(entry, ["delete", String(p.pm_id)]);
}
async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", () => reject(failure("API_PORT_UNAVAILABLE")));
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}
async function waitReady(
  entry,
  names,
  port,
  { timeoutMs = 240000, readyProofs } = {},
) {
  const until = Date.now() + timeoutMs;
  let confirmed = false;
  while (Date.now() < until) {
    const rows = projectProcesses(entry);
    if (
      rows.some(
        (p) =>
          ["errored", "stopped"].includes(p.pm2_env.status) ||
          p.pm2_env.restart_time > 0,
      )
    )
      throw failure("PROCESS_STARTUP_FAILED");
    if (
      names.every((name) =>
        rows.some(
          (p) =>
            p.name === name &&
            p.pid &&
            p.pm2_env.status === "online" &&
            (!readyProofs ||
              readyProofs.has(
                p.name + ":" + p.pid + ":" + p.pm2_env.KL_WRITER_LAUNCH_TOKEN,
              )),
        ),
      )
    ) {
      try {
        const response = await fetch(
          "http://127.0.0.1:" + port + "/api/v1/health/ready",
          {
            signal: AbortSignal.timeout(
              Math.max(1, Math.min(10000, until - Date.now())),
            ),
            redirect: "error",
          },
        );
        await response.body?.cancel();
        if (response.status === 200) {
          preflight(
            rows.map((p) => ({
              name: p.name,
              pid: p.pid,
              token: p.pm2_env.KL_WRITER_LAUNCH_TOKEN,
              protocol: p.pm2_env.KL_PM2_PROTOCOL,
              writerTokens: readyProofs?.get(
                p.name + ":" + p.pid + ":" + p.pm2_env.KL_WRITER_LAUNCH_TOKEN,
              ),
            })),
            "verify",
            Math.max(1, Math.min(90000, until - Date.now())),
          );
          if (confirmed) return;
          confirmed = true;
        } else confirmed = false;
      } catch (error) {
        if (error.safeCode && error.safeCode !== "PREFLIGHT_TIMEOUT")
          throw error;
        confirmed = false;
      }
    }
    await pause(500);
  }
  console.error(
    JSON.stringify({
      event: "startup.ready-timeout",
      processes: projectProcesses(entry).map((p) => ({
        name: p.name,
        pid: p.pid,
        status: p.pm2_env.status,
        ready_proof: !!readyProofs?.has(
          p.name + ":" + p.pid + ":" + p.pm2_env.KL_WRITER_LAUNCH_TOKEN,
        ),
      })),
    }),
  );
  throw failure("STARTUP_READY_TIMEOUT");
}
async function openReadyBus(entry) {
  let pm2;
  try {
    pm2 = require(path.dirname(path.dirname(entry)));
  } catch {
    throw failure("PM2_PACKAGE_REQUIRED");
  }
  await new Promise((resolve, reject) =>
    pm2.connect((error) =>
      error ? reject(failure("PM2_CONNECT_FAILED")) : resolve(),
    ),
  );
  let bus;
  try {
    bus = await new Promise((resolve, reject) =>
      pm2.launchBus((error, value) =>
        error ? reject(failure("PM2_BUS_FAILED")) : resolve(value),
      ),
    );
  } catch (error) {
    pm2.disconnect();
    throw error;
  }
  const readyProofs = new Map();
  bus.on("process:msg", (packet) => {
    const data = packet.data;
    if (
      data?.event === "kl-ready" &&
      projectNames.includes(packet.process?.name) &&
      Number.isInteger(data.pid) &&
      typeof data.token === "string"
    )
      readyProofs.set(
        packet.process.name + ":" + data.pid + ":" + data.token,
        data.writerTokens,
      );
  });
  return {
    readyProofs,
    close() {
      bus.close();
      pm2.disconnect();
    },
  };
}
async function start(entry) {
  const apps = requireBuild();
  const envHash = require("node:crypto")
    .createHash("sha256")
    .update(fs.readFileSync(path.join(serverRoot, ".env")))
    .digest("hex");
  const config = preflight(); // All read-only checks happen before touching existing services.
  const rows = projectProcesses(entry);
  assertStopSupported(rows);
  if (!rows.some((p) => p.name === "kl-api" && p.pid))
    await assertPortFree(config.port);
  const currentHash = require("node:crypto")
    .createHash("sha256")
    .update(fs.readFileSync(path.join(serverRoot, ".env")))
    .digest("hex");
  if (envHash !== currentHash) throw failure("ENV_CHANGED_DURING_PREFLIGHT");
  const bus = await openReadyBus(entry);
  let switching = false;
  try {
    switching = true;
    await stopProject(entry, rows);
    deleteProject(entry, projectProcesses(entry));
    await assertPortFree(config.port);
    preflight(); // Recheck gates after old writers have exited.
    await runPm2Start(entry, ["start", ecosystem], apps.length * 65000 + 15000);
    await waitReady(
      entry,
      apps.map((a) => a.name),
      config.port,
      { readyProofs: bus.readyProofs },
    );
  } catch (error) {
    // Stop only this project's newly launched processes; never restart old writers automatically.
    try {
      if (switching) await stopProject(entry, projectProcesses(entry));
    } catch {
      console.error("PM2_FAILED_START_CLEANUP_UNCONFIRMED");
    }
    throw error;
  } finally {
    bus.close();
  }
  console.log(
    "已就绪 " + apps.map((a) => a.name).join("、") + "（本地，非生产）",
  );
}
async function main(command = process.argv[2] || "start") {
  const entry = resolvePm2Entry();
  if (process.platform === "win32" && process.env.PM2_HOME) {
    let paths;
    try {
      paths = require(path.join(path.dirname(path.dirname(entry)), "paths.js"))(
        process.env.PM2_HOME,
      );
    } catch {
      throw failure("PM2_PACKAGE_REQUIRED");
    }
    const defaultHome = path.join(require("node:os").homedir(), ".pm2");
    if (
      path.resolve(process.env.PM2_HOME).toLowerCase() !==
        path.resolve(defaultHome).toLowerCase() &&
      paths.DAEMON_RPC_PORT === "\\\\.\\pipe\\rpc.sock"
    )
      throw failure("WINDOWS_PM2_HOME_NOT_ISOLATED");
  }
  if (command === "start" || command === "restart") return start(entry);
  if (command === "preflight") {
    requireBuild();
    const result = preflight();
    console.log(JSON.stringify(result));
    return;
  }
  if (command === "stop") {
    const rows = projectProcesses(entry);
    await stopProject(entry, rows);
    deleteProject(entry, projectProcesses(entry));
    console.log("本项目后端已停止");
    return;
  }
  if (command === "status") {
    runPm2(entry, ["status"]);
    console.log(
      projectProcesses(entry)
        .map((p) => p.name + ": " + p.pm2_env.status)
        .join("\n"),
    );
    return;
  }
  if (command === "logs") {
    const r = spawnSync(nodeBin, [entry, "logs", "--lines", "80"], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    if (r.status !== 0) throw failure("PM2_LOGS_FAILED");
    return;
  }
  throw failure("COMMAND_REQUIRED_START_STOP_RESTART_PREFLIGHT_STATUS_LOGS");
}
module.exports = {
  main,
  waitReady,
  assertStopSupported,
  waitStopped,
  parsePreflightResult,
  requireBuild,
  resolvePm2Entry,
};
if (require.main === module)
  main().catch((error) => {
    console.error(error.safeCode || "BACKEND_START_FAILED");
    if (error.safeCode === "WINDOWS_LEGACY_SHUTDOWN_UNSUPPORTED")
      console.error(
        "旧进程未加载IPC退出协议；保持原进程，需安排受控停写并确认退出后再启动。",
      );
    process.exitCode = 1;
  });
