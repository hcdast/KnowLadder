"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  { spawn } = require("node:child_process"),
  { randomUUID, createHash } = require("node:crypto");
const tree = require("./process-tree.cjs"),
  { bounded } = require("./preflight-budget.cjs");
const scripts = {
  "kl-api": "dist/main.js",
  "kl-files-worker": "dist/files/worker.js",
  "kl-assessment-worker": "dist/assessment/worker.js",
  "kl-learning-worker": "dist/learning/worker.js",
  "kl-knowledge-worker": "dist/training/knowledge-worker.js",
  "kl-import-worker": "dist/training/import-worker.js",
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const failure = (code) => Object.assign(Error(code), { safeCode: code });
function owned(row, root) {
  const env = row.pm2_env;
  return (
    !!scripts[row.name] &&
    Number.isInteger(row.pm_id) &&
    !!env &&
    ["1", "2"].includes(env.KL_PM2_PROTOCOL) &&
    path.resolve(env.pm_cwd || "") === path.join(root, "server") &&
    path.resolve(env.pm_exec_path || "") ===
      path.join(root, "server", scripts[row.name])
  );
}
function select(rows, root) {
  if (!Array.isArray(rows)) throw failure("PM2_LIST_INVALID");
  const known = rows.filter((p) => Object.hasOwn(scripts, p.name));
  if (
    known.some((p) => !owned(p, root)) ||
    new Set(known.map((p) => p.name)).size !== known.length
  )
    throw failure("PM2_NAME_OWNERSHIP_CONFLICT");
  return known;
}
async function acquireLock(root, home, nonce, take = tree.snapshot) {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(
    home,
    ".kl-start-" +
      createHash("sha256").update(root).digest("hex").slice(0, 24) +
      ".lock",
  );
  const self = (await take()).find((p) => p.pid === process.pid);
  if (!self) throw failure("PROCESS_IDENTITY_UNCONFIRMED");
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (e) {
    if (e.code !== "EEXIST") throw failure("STARTUP_LOCK_UNAVAILABLE");
    let owner;
    try {
      owner = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw failure("STARTUP_LOCK_RECOVERY_REQUIRED");
    }
    const current = (await take()).find((p) => p.pid === owner.pid);
    throw failure(
      tree.same(owner, current) && tree.alive(current)
        ? "STARTUP_ALREADY_RUNNING"
        : "STARTUP_LOCK_RECOVERY_REQUIRED",
    );
  }
  const value = JSON.stringify({ ...self, nonce });
  try {
    fs.writeFileSync(fd, value);
  } catch {
    fs.closeSync(fd);
    fs.unlinkSync(file);
    throw failure("STARTUP_LOCK_UNAVAILABLE");
  }
  fs.closeSync(fd);
  return () => {
    if (fs.readFileSync(file, "utf8") !== value)
      throw failure("STARTUP_LOCK_IDENTITY_CHANGED");
    fs.unlinkSync(file);
  };
}
async function connect(entry, budgetMs) {
  const pm2 = require(path.dirname(path.dirname(fs.realpathSync(entry))));
  try {
    await bounded(
      new Promise((resolve, reject) =>
        pm2.connect((e) =>
          e ? reject(failure("PM2_CONNECT_FAILED")) : resolve(),
        ),
      ),
      budgetMs,
      "PM2_CONNECT_TIMEOUT",
    );
  } catch (e) {
    pm2.disconnect();
    throw e;
  }
  const call = (method, arg, ms = 3000) =>
    bounded(
      new Promise((resolve, reject) =>
        pm2.Client.executeRemote(method, arg, (e, v) =>
          e ? reject(failure("PM2_COMMAND_FAILED")) : resolve(v),
        ),
      ),
      ms,
      "PM2_COMMAND_TIMEOUT",
    );
  return {
    list: () =>
      bounded(
        new Promise((resolve, reject) =>
          pm2.list((e, v) =>
            e ? reject(failure("PM2_LIST_FAILED")) : resolve(v),
          ),
        ),
        3000,
        "PM2_LIST_TIMEOUT",
      ),
    stop: (id, ms = 15000) => call("stopProcessId", id, ms),
    delete: (id) => call("deleteProcessId", id, 3000),
    close: () => pm2.disconnect(),
  };
}
function writerProof(root, node, databaseIds, budgetMs) {
  return new Promise((resolve) => {
    const child = spawn(
      node,
      [
        "--env-file-if-exists=server/.env",
        path.join(root, "ops/startup-stop-proof.cjs"),
      ],
      { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
    );
    let output = "",
      failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill("SIGKILL");
    }, budgetMs);
    child.stdout.on("data", (s) => {
      output += s;
      if (output.length > 8192) {
        failed = true;
        child.kill("SIGKILL");
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ databaseIds, budgetMs }));
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(!failed && code === 0 && output === '{"ok":true}');
    });
  });
}
async function supervise({
  root,
  entry,
  command,
  timeoutMs,
  graceMs,
  startedAt = Date.now(),
  node = process.execPath,
  coordinator = path.join(root, "ops/pm2-backend.cjs"),
  checkMs = 15000,
  emit = (row) => console.error(JSON.stringify(row)),
  take = tree.snapshot,
  clientFactory = connect,
  writerCheck = writerProof,
}) {
  const until = startedAt + timeoutMs,
    nonce = randomUUID(),
    home = process.env.PM2_HOME || path.join(os.homedir(), ".pm2");
  let unlock,
    client,
    child,
    result,
    closed = false,
    watch,
    heartbeat,
    monitor,
    pendingRefresh,
    unsafe = false,
    phase = "configuration";
  const tracked = new Map(),
    databaseIds = new Set(),
    stops = new Map(),
    safeStopIds = new Set();
  let stopUntil;
  let rows = [];
  const log = (state, more = {}) =>
    emit({
      event: "startup.deadline",
      state,
      stage: phase,
      elapsed_ms: Date.now() - startedAt,
      ...more,
    });
  const markUnsafe = (code) => {
    if (!unsafe) log("unconfirmed", { code });
    unsafe = true;
  };
  const remaining = () => {
    const ms = until - Date.now();
    if (ms <= 0) throw failure("STARTUP_TOTAL_TIMEOUT");
    return ms;
  };
  const daemonPid = () => {
    try {
      return Number(fs.readFileSync(path.join(home, "pm2.pid"), "utf8").trim());
    } catch {
      return 0;
    }
  };
  async function refresh() {
    if (pendingRefresh) return pendingRefresh;
    pendingRefresh = (async () => {
      const [all, pms] = await Promise.all([
        take(),
        client ? client.list() : Promise.resolve([]),
      ]);
      rows = select(pms, root);
      for (const p of rows)
        if (p.pm2_env.KL_PM2_DATABASE_ID)
          databaseIds.add(p.pm2_env.KL_PM2_DATABASE_ID);
      safeStopIds.clear();
      const roots = [];
      const daemon = daemonPid();
      tracked.delete(daemon);
      tracked.delete(process.pid);
      for (const row of rows) {
        const identity = all.find((p) => p.pid === row.pid);
        const prior = tracked.get(row.pid);
        // PM2 may still report the old PID after an observed process exits.
        // Keep the recorded descendants and retry; never signal an absent PID.
        if (row.pid > 0 && !identity) {
          if (!prior) markUnsafe("STOP_PID_IDENTITY_UNCONFIRMED");
          continue;
        }
        if (
          row.pid > 0 &&
          (identity.ppid !== daemon ||
            (prior && !tree.same(prior, identity)) ||
            pms.filter((p) => p.pid === row.pid).length !== 1)
        ) {
          markUnsafe("STOP_PID_IDENTITY_UNCONFIRMED");
          continue;
        }
        safeStopIds.add(row.pm_id);
        if (row.pid > 0) roots.push(row.pid);
      }
      if (child && !closed) roots.push(child.pid);
      const excluded = new Set([process.pid, daemonPid()]);
      for (const p of tree.descendants(all, roots, excluded)) {
        const prior = tracked.get(p.pid);
        if (prior && !tree.same(prior, p)) {
          markUnsafe("STOP_PID_IDENTITY_CHANGED");
          continue;
        }
        tracked.set(p.pid, p);
      }
      return all;
    })().finally(() => {
      pendingRefresh = undefined;
    });
    return pendingRefresh;
  }
  function requestStops() {
    for (const p of rows) {
      if (!safeStopIds.has(p.pm_id)) continue;
      const key =
        p.pm_id + ":" + p.pid + ":" + p.pm2_env.KL_WRITER_LAUNCH_TOKEN;
      if (!stops.has(key)) {
        const work = client.stop(p.pm_id, Math.max(1, stopUntil - Date.now()));
        work.catch(() => {});
        stops.set(key, work);
      }
    }
  }
  async function cleanup(code) {
    log("stopping", { code });
    const graceUntil = Date.now() + graceMs,
      checkUntil = graceUntil + checkMs;
    stopUntil = checkUntil;
    // Capture descendants before cancellation can orphan them.
    try {
      await bounded(
        refresh(),
        Math.min(3000, graceMs),
        "PROCESS_STOP_UNCONFIRMED",
      );
      requestStops();
    } catch {
      markUnsafe("STOP_TREE_READ_UNCONFIRMED");
    }
    if (child?.connected) child.send({ kind: "cancel", nonce }, () => {});
    let all = [],
      processesStopped = false;
    do {
      const graceLeft = graceUntil - Date.now();
      if (graceLeft < 3000) {
        if (graceLeft > 0) await pause(graceLeft);
        break;
      }
      try {
        all = await bounded(
          refresh(),
          Math.max(1, Math.min(3000, graceUntil - Date.now())),
          "PROCESS_STOP_UNCONFIRMED",
        );
        requestStops();
      } catch {
        markUnsafe("STOP_GRACE_READ_UNCONFIRMED");
      }
      const live = all.some(
        (p) => tree.alive(p) && tree.same(tracked.get(p.pid), p),
      );
      if (
        !live &&
        rows.every((p) => !p.pid && p.pm2_env.status === "stopped")
      ) {
        processesStopped = true;
        break;
      }
      if (Date.now() >= graceUntil) break;
      await pause(Math.min(500, graceUntil - Date.now()));
    } while (true);
    try {
      all = await bounded(
        refresh(),
        Math.max(1, Math.min(3000, checkUntil - Date.now())),
        "PROCESS_STOP_UNCONFIRMED",
      );
      requestStops();
      const kills = [...tracked.values()].reverse();
      for (const p of kills)
        if (tree.alive(all.find((a) => tree.same(a, p))))
          await tree.killVerified(p, "SIGKILL", async () => all);
      do {
        all = await bounded(
          refresh(),
          Math.max(1, Math.min(3000, checkUntil - Date.now())),
          "PROCESS_STOP_UNCONFIRMED",
        );
        for (const p of rows)
          if (!p.pid)
            await bounded(
              client.delete(p.pm_id),
              Math.max(1, Math.min(3000, checkUntil - Date.now())),
              "PM2_STOP_NOT_CONFIRMED",
            );
        const live = all.some(
          (p) => tree.alive(p) && tree.same(tracked.get(p.pid), p),
        );
        processesStopped = !live && rows.every((p) => !p.pid);
        if (processesStopped) {
          const after = select(
            await bounded(
              client.list(),
              Math.max(1, Math.min(3000, checkUntil - Date.now())),
              "PM2_STOP_NOT_CONFIRMED",
            ),
            root,
          );
          if (after.length) {
            processesStopped = false;
            requestStops();
          } else break;
        }
        if (Date.now() >= checkUntil) break;
        await pause(200);
      } while (true);
    } catch {
      markUnsafe("STOP_FINAL_VERIFY_UNCONFIRMED");
      processesStopped = false;
    }
    const releaseMs = checkUntil - Date.now();
    const writersReleased =
      releaseMs > 0 &&
      (await writerCheck(
        root,
        node,
        [...databaseIds],
        Math.min(5000, releaseMs),
      ));
    const ok = processesStopped && !unsafe;
    log(ok && writersReleased ? "stopped" : "unconfirmed", {
      processes_stopped: ok,
      writers_released: !!writersReleased,
    });
    if (!ok || !writersReleased) console.error("STARTUP_STOP_UNCONFIRMED");
    return { processesStopped: ok, writersReleased: !!writersReleased };
  }
  let cancel;
  const cancelled = new Promise((resolve) => {
    cancel = resolve;
  });
  const onSignal = () => cancel("STARTUP_CANCELLED");
  try {
    watch = setTimeout(() => cancel("STARTUP_TOTAL_TIMEOUT"), remaining());
    unlock = await bounded(
      acquireLock(root, home, nonce, take),
      remaining(),
      "STARTUP_TOTAL_TIMEOUT",
    );
    remaining();
    client = await clientFactory(entry, Math.min(5000, remaining()));
    await bounded(
      refresh(),
      Math.min(5000, remaining()),
      "PROCESS_IDENTITY_UNCONFIRMED",
    );
    remaining();
    child = spawn(node, [coordinator, "--startup-coordinator", command], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const completion = new Promise((resolve, reject) => {
      child.on("message", (message) => {
        if (message?.nonce !== nonce) return;
        if (message.kind === "stage" && /^[a-z][a-z.-]*$/.test(message.stage))
          phase = message.stage;
        if (message.kind === "success" || message.kind === "failure")
          result = message;
      });
      child.once("error", () => reject(failure("STARTUP_COORDINATOR_FAILED")));
      child.once("close", (code) => {
        closed = true;
        if (result?.kind === "success" && code === 0) resolve(result);
        else if (result?.kind === "failure")
          reject(
            failure(
              /^[A-Z][A-Z0-9_]{3,}$/.test(result.code || "")
                ? result.code
                : "BACKEND_START_FAILED",
            ),
          );
        else reject(failure("STARTUP_COORDINATOR_EXIT"));
      });
    });
    child.send({ kind: "initialize", nonce, until });
    monitor = setInterval(() => {
      void refresh().catch(() => {
        markUnsafe("STOP_MONITOR_READ_UNCONFIRMED");
      });
    }, 2000);
    monitor.unref();
    heartbeat = setInterval(
      () => log("waiting", { remaining_ms: Math.max(0, until - Date.now()) }),
      5000,
    );
    heartbeat.unref();
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    const winner = await Promise.race([
      completion,
      cancelled.then((code) => {
        throw failure(code);
      }),
    ]);
    remaining();
    if (
      !Array.isArray(winner.names) ||
      !winner.names.length ||
      winner.names.some((n) => !Object.hasOwn(scripts, n))
    )
      throw failure("STARTUP_COORDINATOR_FAILED");
    clearInterval(monitor);
    if (pendingRefresh)
      await bounded(
        pendingRefresh.catch(() => {}),
        remaining(),
        "STARTUP_TOTAL_TIMEOUT",
      );
    remaining();
    clearTimeout(watch);
    log("completed");
    console.log(
      (winner.reuse ? "已验证并复用 " : "已就绪 ") +
        winner.names.join("、") +
        "（本地，非生产）",
    );
    return winner;
  } catch (error) {
    const code =
      error.safeCode ||
      (error.message === "STARTUP_TOTAL_TIMEOUT"
        ? "STARTUP_TOTAL_TIMEOUT"
        : "BACKEND_START_FAILED");
    clearTimeout(watch);
    clearInterval(monitor);
    clearInterval(heartbeat);
    if (
      client &&
      (code === "STARTUP_TOTAL_TIMEOUT" ||
        code === "STARTUP_CANCELLED" ||
        code === "STARTUP_COORDINATOR_EXIT" ||
        code === "STARTUP_COORDINATOR_FAILED")
    )
      await cleanup(code);
    throw failure(code);
  } finally {
    clearTimeout(watch);
    clearInterval(monitor);
    clearInterval(heartbeat);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    client?.close();
    if (unlock) unlock();
  }
}
module.exports = { supervise, select, owned, acquireLock, connect, scripts };
