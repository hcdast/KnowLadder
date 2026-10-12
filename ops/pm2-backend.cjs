"use strict";
const { spawnSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { timing } = require("./startup-timing.cjs");
const { effectiveBudget } = require("./preflight-budget.cjs");
const {
  deploymentIdentity,
  startupMode,
} = require("./deployment-identity.cjs");
const { bounded } = require("./preflight-budget.cjs");
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
let startupControl;
function remainingBudget(maximum) {
  if (!startupControl) return maximum;
  startupControl.controller.signal.throwIfAborted();
  const ms = startupControl.until - Date.now();
  if (ms <= 0) throw failure("STARTUP_TOTAL_TIMEOUT");
  return Math.min(maximum, ms);
}
function failure(code) {
  return Object.assign(Error(code), { safeCode: code });
}
function resolvePm2Entry({
  env = process.env,
  projectRoot = root,
  execPath = process.execPath,
  platform = process.platform,
  locate = spawnSync,
  resolve = require.resolve,
} = {}) {
  let configured = env.KL_PM2_BIN;
  if (configured === undefined) {
    const file = path.join(projectRoot, "server/.env");
    try {
      if (fs.existsSync(file))
        configured = require("node:util").parseEnv(
          fs.readFileSync(file, "utf8"),
        ).KL_PM2_BIN;
    } catch {
      throw failure("INVALID_CONFIG_ENV_FILE");
    }
  }
  function entry(file, automatic) {
    try {
      if (/\.(cmd|bat|exe)$/i.test(file)) return;
      const real = fs.realpathSync(file);
      if (!fs.statSync(real).isFile() || /\.(cmd|bat|exe)$/i.test(real)) return;
      if (automatic) {
        const base = path.dirname(path.dirname(real));
        const pkg = JSON.parse(
          fs.readFileSync(path.join(base, "package.json"), "utf8"),
        );
        if (pkg.name !== "pm2" || real !== path.join(base, "bin", "pm2"))
          return;
      }
      return real;
    } catch {
      return;
    }
  }
  if (configured) {
    // Explicit bad configuration must not silently select another installation.
    const real = entry(path.resolve(projectRoot, configured), false);
    if (!real) throw failure("PM2_JAVASCRIPT_ENTRY_REQUIRED");
    return real;
  }
  const which = locate(
    platform === "win32" ? "where.exe" : "which",
    [platform === "win32" ? "pm2.cmd" : "pm2"],
    { encoding: "utf8", windowsHide: true, timeout: 5000, env },
  );
  for (const file of (which.stdout || "").split(/\r?\n/).filter(Boolean)) {
    const command = file.trim();
    const directory = path.dirname(command);
    for (const candidate of [
      command,
      path.join(directory, "node_modules", "pm2", "bin", "pm2"),
      path.join(directory, "..", "lib", "node_modules", "pm2", "bin", "pm2"),
    ]) {
      const real = entry(candidate, true);
      if (real) return real;
    }
  }
  // Local installations and the active Node prefix also work without which/PATH.
  for (const directory of [projectRoot, path.join(projectRoot, "server")]) {
    try {
      const real = entry(resolve("pm2/bin/pm2", { paths: [directory] }), true);
      if (real) return real;
    } catch {}
  }
  const nodeDirectory = path.dirname(execPath);
  for (const candidate of [
    path.join(nodeDirectory, "node_modules", "pm2", "bin", "pm2"),
    path.join(nodeDirectory, "..", "lib", "node_modules", "pm2", "bin", "pm2"),
  ]) {
    const real = entry(candidate, true);
    if (real) return real;
  }
  throw failure("PM2_NOT_FOUND");
}
function execute(entry, args, { input, timeout = 75000 } = {}) {
  const result = spawnSync(nodeBin, [entry, ...args], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    input,
    timeout: remainingBudget(timeout),
    maxBuffer: 8 * 1024 * 1024,
  });
  return result;
}
function runPm2(entry, args, options) {
  const r = execute(entry, args, options);
  if (r.error || r.status !== 0) throw failure("PM2_COMMAND_FAILED");
}
async function runPm2Start(entry, args, timeout, signal) {
  // Keep the readiness bus and process observer draining while the CLI waits.
  if (startupControl)
    signal = signal
      ? AbortSignal.any([signal, startupControl.controller.signal])
      : startupControl.controller.signal;
  timeout = remainingBudget(timeout);
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [entry, ...args], {
      cwd: root,
      env: process.env,
      windowsHide: true,
      stdio: "ignore",
    });
    let error;
    const terminate = (code) => {
      error ??= failure(code);
      child.kill("SIGKILL");
    };
    const cancel = () => terminate("PM2_START_CANCELLED");
    const timer = setTimeout(() => terminate("PM2_COMMAND_TIMEOUT"), timeout);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const dispose = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    };
    child.once("error", () => {
      dispose();
      reject(error ?? failure("PM2_COMMAND_FAILED"));
    });
    child.once("close", (code) => {
      dispose();
      if (error || code !== 0) reject(error ?? failure("PM2_COMMAND_FAILED"));
      else resolve();
    });
  });
}

function projectProcesses(entry) {
  const r = execute(entry, ["jlist"], { timeout: 10000 });
  if (r.error || r.status !== 0) throw failure("PM2_LIST_FAILED");
  try {
    const rows = JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
    return validateProjectRows(rows);
  } catch (error) {
    if (error.safeCode) throw error;
    throw failure("PM2_LIST_INVALID");
  }
}
function validateProjectRows(rows) {
  if (!Array.isArray(rows)) throw failure("PM2_LIST_INVALID");
  const apps = rows.filter((p) => projectNames.includes(p.name));
  if (apps.some((p) => path.resolve(p.pm2_env?.pm_cwd || "") !== serverRoot))
    throw failure("PM2_NAME_OWNERSHIP_CONFLICT");
  if (new Set(apps.map((p) => p.name)).size !== apps.length)
    throw failure("PM2_DUPLICATE_NAME");
  return apps;
}
function processIdentity(rows) {
  return JSON.stringify(
    rows
      .map((p) => [
        p.name,
        p.pid,
        p.pm2_env.KL_WRITER_LAUNCH_TOKEN,
        p.pm2_env.restart_time,
      ])
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}
function chooseStartAction(apps, rows, restart = false) {
  if (restart || !rows.some((p) => p.pid)) return "launch";
  if (
    rows.length !== apps.length ||
    apps.some(
      (a) =>
        !rows.some(
          (p) => p.name === a.name && p.pid && p.pm2_env.status === "online",
        ),
    )
  )
    throw failure("PARTIAL_DEPLOYMENT_RESTART_REQUIRED");
  const args = (value) =>
    JSON.stringify(
      Array.isArray(value) ? value : typeof value === "string" ? [value] : [],
    );
  for (const app of apps) {
    const p = rows.find((p) => p.name === app.name),
      e = p.pm2_env;
    if (
      e.KL_PM2_PROTOCOL !== "2" ||
      !app.env.KL_PM2_DEPLOYMENT_ID ||
      e.KL_PM2_DEPLOYMENT_ID !== app.env.KL_PM2_DEPLOYMENT_ID ||
      path.resolve(e.pm_exec_path || "") !==
        path.resolve(app.cwd, app.script) ||
      path.resolve(e.exec_interpreter || "") !==
        path.resolve(app.interpreter) ||
      args(e.node_args) !== args(app.node_args)
    )
      throw failure("DEPLOYMENT_CHANGED_RESTART_REQUIRED");
  }
  return "reuse";
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
async function preflight(verify, mode = "verify", budgetMs) {
  const configuredBudget = effectiveBudget(
    Boolean(verify),
    path.join(serverRoot, ".env"),
  );
  const childBudget = remainingBudget(
    Math.min(configuredBudget, budgetMs ?? configuredBudget),
  );
  const r = await new Promise((resolve) => {
    const child = spawn(
      nodeBin,
      [
        "--env-file-if-exists=.env",
        path.join(__dirname, "backend-preflight.cjs"),
        ...(verify ? [mode] : []),
        "--budget-ms=" + childBudget,
      ],
      {
        cwd: serverRoot,
        env: process.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "inherit"],
      },
    );
    const cancel = () => child.kill("SIGTERM");
    const signal = startupControl?.controller.signal;
    signal?.addEventListener("abort", cancel, { once: true });
    const dispose = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    };
    let stdout = "",
      error;
    const timer = setTimeout(() => {
      error = { code: "ETIMEDOUT" };
      child.kill("SIGKILL");
    }, childBudget + 5000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 32768) {
        error = { code: "OUTPUT_LIMIT" };
        child.kill();
      }
    });
    child.stdin.on("error", () => {});
    child.once("error", (e) => {
      error = e;
      dispose();
      resolve({ error, stdout, status: null });
    });
    child.once("close", (status) => {
      dispose();
      resolve({ error, stdout, status });
    });
    child.stdin.end(verify ? JSON.stringify(verify) : undefined);
  });
  remainingBudget(1);
  const result = parsePreflightResult(r);
  if (r.error || r.status !== 0 || !result.ok) {
    const stage =
      [
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
        "migration-proof",
        "database-close",
      ].includes(String(result.stage).split(".")[0]) &&
      /^[a-z][a-z.-]*$/.test(result.stage)
        ? result.stage
        : "preflight";
    const code =
      require("../server/dist/runtime/process-lifecycle").safeErrorCode(
        Error(result.code),
      );
    throw failure(
      "PREFLIGHT_" +
        stage.toUpperCase().replaceAll("-", "_").replaceAll(".", "_") +
        "_" +
        code,
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
async function waitStopped(readProcesses, timeoutMs = 10000, normalize) {
  const until = Date.now() + timeoutMs;
  do {
    const rows = await readProcesses();
    if (normalize) await normalize(rows);
    if (rows.every((p) => !p.pid && p.pm2_env.status === "stopped")) return;
    if (Date.now() >= until) {
      console.error(
        JSON.stringify({
          event: "startup.stop-timeout",
          processes: rows.map((p) => ({
            name: p.name,
            pid: p.pid,
            status: p.pm2_env.status,
          })),
        }),
      );
      throw failure("PM2_STOP_NOT_CONFIRMED");
    }
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
    ? (await preflight(identities, "identity")).registrations
    : [];
  for (const app of rows)
    if (app.pm2_env.status !== "stopped")
      runPm2(entry, ["stop", String(app.pm_id)], {
        timeout: Math.max(
          75000,
          Number(app.pm2_env.kill_timeout || 10000) + 15000,
        ),
      });
  const normalized = new Set();
  await waitStopped(
    () => projectProcesses(entry),
    10000,
    async (current) => {
      // PM2's exit handler applies the backoff status even for a deliberate stop.
      // Reissue stop only after PID=0; still require STOPPED plus DB release below.
      for (const app of current)
        if (
          !app.pid &&
          app.pm2_env.status === "waiting restart" &&
          !normalized.has(app.pm_id)
        ) {
          normalized.add(app.pm_id);
          runPm2(entry, ["stop", String(app.pm_id)], { timeout: 10000 });
        }
    },
  );
  if (launched.length) await preflight(stopProof, "stopped");
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
  {
    timeoutMs = 240000,
    readyProofs,
    proof,
    reuse = false,
    readProcesses = () => projectProcesses(entry),
    verify = preflight,
    fetchReady = fetch,
    emit,
  } = {},
) {
  const until = Date.now() + remainingBudget(timeoutMs);
  let confirmed = false,
    confirmedIdentity;
  const clock = timing("ready", emit);
  while (Date.now() < until) {
    remainingBudget(1);
    const rows = await readProcesses();
    if (
      rows.some(
        (p) =>
          ["errored", "stopped"].includes(p.pm2_env.status) ||
          (!reuse && p.pm2_env.restart_time > 0),
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
        const response = await clock.run("http-ready", () =>
          fetchReady("http://127.0.0.1:" + port + "/api/v1/health/ready", {
            signal: startupControl
              ? AbortSignal.any([
                  startupControl.controller.signal,
                  AbortSignal.timeout(
                    remainingBudget(
                      Math.max(1, Math.min(10000, until - Date.now())),
                    ),
                  ),
                ])
              : AbortSignal.timeout(
                  Math.max(1, Math.min(10000, until - Date.now())),
                ),
            redirect: "error",
          }),
        );
        await response.body?.cancel();
        if (response.status === 200) {
          const currentIdentity = processIdentity(rows);
          if (confirmed && currentIdentity !== confirmedIdentity)
            throw failure("PROCESS_CHANGED_DURING_VERIFICATION");
          const apps = rows.map((p) => ({
            name: p.name,
            pid: p.pid,
            token: p.pm2_env.KL_WRITER_LAUNCH_TOKEN,
            protocol: p.pm2_env.KL_PM2_PROTOCOL,
            writerTokens: readyProofs?.get(
              p.name + ":" + p.pid + ":" + p.pm2_env.KL_WRITER_LAUNCH_TOKEN,
            ),
          }));
          await clock.run("writer-verify", () =>
            verify(
              proof ? { verify: apps, proof, reuse } : apps,
              proof ? "verify-fast" : "verify",
              Math.max(1, until - Date.now()),
            ),
          );
          if (processIdentity(await readProcesses()) !== currentIdentity)
            throw failure("PROCESS_CHANGED_DURING_VERIFICATION");
          remainingBudget(1);
          if (confirmed) return;
          confirmedIdentity = currentIdentity;
          confirmed = true;
        } else confirmed = false;
      } catch (error) {
        remainingBudget(1);
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
      processes: (await readProcesses()).map((p) => ({
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
/** Only advance after the CLI AND this launch's real ready/writer proof. */
async function launchProcesses(
  entry,
  apps,
  bus,
  {
    mode = "serial",
    proof,
    managed = false,
    timeoutMs = apps.length * 65000 + 15000,
    entryTimeoutMs = 65000,
    runCommand = runPm2Start,
    verify = preflight,
    readProcesses = (remaining) => bus.list(remaining),
    assertUnchanged = () => {},
    emit,
  } = {},
) {
  if (!["serial", "parallel"].includes(mode))
    throw failure("INVALID_CONFIG_KL_PM2_START_MODE");
  if (
    !apps.length ||
    apps.length > 6 ||
    new Set(apps.map((a) => a.name)).size !== apps.length ||
    apps.some((a) => !projectNames.includes(a.name)) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(entryTimeoutMs) ||
    entryTimeoutMs < 1
  )
    throw failure("PM2_START_CONFIGURATION_INVALID");
  if (mode === "parallel") {
    assertUnchanged();
    return runCommand(entry, ["start", ecosystem], timeoutMs);
  }
  const overallUntil = Date.now() + remainingBudget(timeoutMs),
    clock = timing("launch", emit);
  const launched = [],
    identities = new Map();
  for (const app of apps) {
    await clock.run("process-start." + app.name, async () => {
      const until = Math.min(overallUntil, Date.now() + entryTimeoutMs);
      const remaining = () => {
        const value = remainingBudget(until - Date.now());
        if (value <= 0) throw failure("PROCESS_ENTRY_READY_TIMEOUT");
        return value;
      };
      assertUnchanged();
      const controller = new AbortController();
      let commandDone = false,
        commandError;
      const command = Promise.resolve()
        .then(() =>
          runCommand(
            entry,
            ["start", ecosystem, "--only", app.name],
            remaining(),
            controller.signal,
          ),
        )
        .then(
          () => {
            commandDone = true;
          },
          (error) => {
            commandDone = true;
            commandError = error;
          },
        );
      launched.push(app);
      let currentIdentity;
      function validate(rows) {
        if (
          !Array.isArray(rows) ||
          new Set(rows.map((p) => p.name)).size !== rows.length ||
          rows.some((p) => !launched.some((a) => a.name === p.name))
        )
          throw failure("PROCESS_UNEXPECTED_DURING_STARTUP");
        for (const previous of launched.slice(0, -1)) {
          const row = rows.find((p) => p.name === previous.name);
          if (
            !row ||
            !row.pid ||
            row.pm2_env?.status !== "online" ||
            row.pm2_env.restart_time !== 0 ||
            processIdentity([row]) !== identities.get(previous.name)
          )
            throw failure("PROCESS_CHANGED_DURING_VERIFICATION");
          chooseStartAction([previous], [row]);
        }
        const row = rows.find((p) => p.name === app.name);
        if (!row) {
          if (currentIdentity)
            throw failure("PROCESS_CHANGED_DURING_VERIFICATION");
          return;
        }
        if (
          !row.pm2_env ||
          ["errored", "stopped", "stopping"].includes(row.pm2_env.status) ||
          (row.pm2_env.restart_time ?? 0) !== 0
        )
          throw failure("PROCESS_STARTUP_FAILED");
        if (row.pid) {
          const value = processIdentity([row]);
          if (currentIdentity && value !== currentIdentity)
            throw failure("PROCESS_CHANGED_DURING_VERIFICATION");
          currentIdentity = value;
        } else if (currentIdentity)
          throw failure("PROCESS_CHANGED_DURING_VERIFICATION");
        if (row.pid && row.pm2_env.status === "online")
          chooseStartAction([app], [row]);
        return row;
      }
      try {
        while (true) {
          if (commandError) throw commandError;
          const rows = await bounded(
            readProcesses(remaining()),
            remaining(),
            "PROCESS_ENTRY_READY_TIMEOUT",
          );
          const row = validate(rows);
          if (commandError) throw commandError;
          if (commandDone && row?.pid && row.pm2_env.status === "online") {
            const key =
              row.name +
              ":" +
              row.pid +
              ":" +
              row.pm2_env.KL_WRITER_LAUNCH_TOKEN;
            if (bus.readyProofs.has(key)) {
              const tokens = bus.readyProofs.get(key),
                expected =
                  managed && app.name === "kl-api"
                    ? 0
                    : app.name === "kl-import-worker"
                      ? 2
                      : 1;
              if (
                !Array.isArray(tokens) ||
                tokens.length !== expected ||
                new Set(tokens).size !== tokens.length ||
                tokens.some((t) => typeof t !== "string" || !t.length)
              )
                throw failure("WORKER_REGISTRATION_REQUIRED");
              const writers = rows.map((p) => ({
                name: p.name,
                pid: p.pid,
                protocol: p.pm2_env.KL_PM2_PROTOCOL,
                token: p.pm2_env.KL_WRITER_LAUNCH_TOKEN,
                writerTokens: bus.readyProofs.get(
                  p.name + ":" + p.pid + ":" + p.pm2_env.KL_WRITER_LAUNCH_TOKEN,
                ),
              }));
              const beforeIdentity = processIdentity(rows);
              await verify(
                { verify: writers, proof, serial: true },
                "verify-fast",
                remaining(),
              );
              remaining();
              const after = await bounded(
                readProcesses(remaining()),
                remaining(),
                "PROCESS_ENTRY_READY_TIMEOUT",
              );
              const verified = validate(after);
              if (
                !verified?.pid ||
                verified.pm2_env.status !== "online" ||
                processIdentity(after) !== beforeIdentity
              )
                throw failure("PROCESS_CHANGED_DURING_VERIFICATION");
              assertUnchanged();
              remaining();
              identities.set(app.name, currentIdentity);
              return;
            }
          }
          await pause(Math.min(250, remaining()));
        }
      } finally {
        controller.abort();
        // Never leave a live CLI starting this entry while failure cleanup runs.
        await command;
      }
    });
  }
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
  const readyProofs = new Map(),
    busStartedAt = Date.now();
  bus.on("process:msg", (packet) => {
    const data = packet.data;
    if (
      data?.event === "kl-ready" &&
      projectNames.includes(packet.process?.name) &&
      Number.isInteger(data.pid) &&
      typeof data.token === "string"
    ) {
      const key = packet.process.name + ":" + data.pid + ":" + data.token;
      if (!readyProofs.has(key))
        console.error(
          JSON.stringify({
            event: "startup.worker-ready",
            name: packet.process.name,
            pid: data.pid,
            elapsed_since_bus_ms: Date.now() - busStartedAt,
          }),
        );
      readyProofs.set(key, data.writerTokens);
    }
  });
  return {
    readyProofs,
    async list(timeoutMs = 10000) {
      const rows = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(failure("PM2_LIST_FAILED")),
          Math.max(1, Math.min(10000, timeoutMs)),
        );
        pm2.list((error, rows) => {
          clearTimeout(timer);
          error ? reject(failure("PM2_LIST_FAILED")) : resolve(rows);
        });
      });
      return validateProjectRows(rows);
    },
    close() {
      bus.close();
      pm2.disconnect();
    },
  };
}
async function start(entry, { restart = false, announce = true } = {}) {
  remainingBudget(1);
  const clock = timing("backend", (row) => {
    console.error(JSON.stringify(row));
    if (startupControl && process.connected && row.state === "started")
      process.send?.(
        {
          kind: "stage",
          nonce: startupControl.nonce,
          stage: row.stage,
        },
        () => {},
      );
  });
  const apps = await clock.run("build-configuration", () => requireBuild());
  const identity = apps[0]?.env.KL_PM2_DEPLOYMENT_ID;
  const mode = startupMode(root);
  const assertUnchanged = () => {
    if (deploymentIdentity(root, process.env, nodeBin) !== identity)
      throw failure("DEPLOYMENT_CHANGED_DURING_STARTUP");
  };
  const rows = await clock.run("process-list", () => projectProcesses(entry));
  const action = chooseStartAction(apps, rows, restart);
  const config = await clock.run("full-preflight", () => preflight());
  assertUnchanged();
  if (action === "reuse" && config.managed)
    throw failure("MANAGED_DEPLOYMENT_RESTART_REQUIRED");
  assertStopSupported(rows);
  if (!rows.some((p) => p.name === "kl-api" && p.pid))
    await assertPortFree(config.port);
  const bus = await openReadyBus(entry);
  let switching = false;
  try {
    if (action === "reuse") {
      const initialIdentity = processIdentity(rows);
      const snapshot = await clock.run("existing-writer-identity", () =>
        preflight(
          rows.map((p) => ({
            name: p.name,
            pid: p.pid,
            protocol: p.pm2_env.KL_PM2_PROTOCOL,
            token: p.pm2_env.KL_WRITER_LAUNCH_TOKEN,
            databaseId: p.pm2_env.KL_PM2_DATABASE_ID,
          })),
          "identity",
        ),
      );
      const readyProofs = new Map(
        snapshot.registrations.map((p) => [
          p.name + ":" + p.pid + ":" + p.token,
          p.tokens,
        ]),
      );
      const read = async () => {
        const current = await bus.list();
        if (processIdentity(current) !== initialIdentity)
          throw failure("PROCESS_CHANGED_DURING_VERIFICATION");
        return current;
      };
      await clock.run("reuse-ready", () =>
        waitReady(
          entry,
          apps.map((a) => a.name),
          config.port,
          {
            readyProofs,
            proof: config.proof,
            reuse: true,
            readProcesses: read,
          },
        ),
      );
    } else {
      switching = true;
      await clock.run("stop", () => stopProject(entry, rows));
      await clock.run("delete", () =>
        deleteProject(entry, projectProcesses(entry)),
      );
      await assertPortFree(config.port);
      assertUnchanged();
      // Cold launch with no old definitions already passed the complete check.
      const finalConfig = rows.length
        ? await clock.run("post-stop-preflight", () => preflight())
        : config;
      assertUnchanged();
      await clock.run("process-start", () =>
        launchProcesses(entry, apps, bus, {
          mode,
          proof: finalConfig.proof,
          managed: config.managed,
          assertUnchanged,
        }),
      );
      await clock.run("launch-ready", () =>
        waitReady(
          entry,
          apps.map((a) => a.name),
          config.port,
          {
            readyProofs: bus.readyProofs,
            proof: finalConfig.proof,
            readProcesses: () => bus.list(),
          },
        ),
      );
    }
    assertUnchanged();
  } catch (error) {
    if (switching)
      try {
        await clock.run("failed-start-cleanup", () =>
          stopProject(entry, projectProcesses(entry)),
        );
      } catch {
        console.error("PM2_FAILED_START_CLEANUP_UNCONFIRMED");
      }
    throw error;
  } finally {
    bus.close();
  }
  remainingBudget(1);
  if (announce)
    console.log(
      (action === "reuse" ? "已验证并复用 " : "已就绪 ") +
        apps.map((a) => a.name).join("、") +
        "（本地，非生产）",
    );
  return { names: apps.map((a) => a.name), reuse: action === "reuse" };
}
async function main(command = process.argv[2] || "start") {
  const startedAt = Date.now();
  if (command === "--startup-coordinator")
    return coordinatorMain(process.argv[3]);
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
  if (command === "start" || command === "restart") {
    const options = require("./startup-options.cjs").startupOptions(root);
    return require("./startup-supervisor.cjs").supervise({
      root,
      entry,
      command,
      ...options,
      startedAt,
      node: nodeBin,
    });
  }
  if (command === "preflight") {
    requireBuild();
    const result = await preflight();
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
async function coordinatorMain(command) {
  if (
    !process.send ||
    !process.connected ||
    !["start", "restart"].includes(command)
  )
    throw failure("STARTUP_COORDINATOR_REQUIRED");
  const initialization = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(failure("STARTUP_COORDINATOR_REQUIRED")),
      5000,
    );
    process.once("message", (message) => {
      clearTimeout(timer);
      if (
        message?.kind !== "initialize" ||
        typeof message.nonce !== "string" ||
        !Number.isSafeInteger(message.until) ||
        message.until <= Date.now()
      )
        reject(failure("STARTUP_COORDINATOR_REQUIRED"));
      else resolve(message);
    });
  });
  startupControl = {
    nonce: initialization.nonce,
    until: initialization.until,
    controller: new AbortController(),
  };
  const cancel = () =>
    startupControl.controller.abort(failure("STARTUP_TOTAL_TIMEOUT"));
  process.on("message", (message) => {
    if (message?.kind === "cancel" && message.nonce === startupControl.nonce)
      cancel();
  });
  process.once("disconnect", cancel);
  try {
    const value = await start(resolvePm2Entry(), {
      restart: command === "restart",
      announce: false,
    });
    remainingBudget(1);
    await new Promise((resolve, reject) =>
      process.send(
        { kind: "success", nonce: startupControl.nonce, ...value },
        (error) =>
          error ? reject(failure("STARTUP_COORDINATOR_EXIT")) : resolve(),
      ),
    );
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{3,}$/.test(error.safeCode || "")
      ? error.safeCode
      : "BACKEND_START_FAILED";
    if (process.connected)
      await new Promise((resolve) =>
        process.send(
          { kind: "failure", nonce: startupControl.nonce, code },
          () => resolve(),
        ),
      );
    process.exitCode = 1;
  } finally {
    if (process.connected) process.disconnect();
  }
}
module.exports = {
  main,
  start,
  launchProcesses,
  chooseStartAction,
  processIdentity,
  validateProjectRows,
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
