"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path"),
  fs = require("node:fs"),
  os = require("node:os");
const { launchProcesses } = require("../../ops/pm2-backend.cjs"),
  { startupMode } = require("../../ops/deployment-identity.cjs"),
  { verifyWriters } = require("../../ops/backend-preflight.cjs");
const names = ["kl-api", "kl-assessment-worker", "kl-learning-worker"];
function harness(selected = names) {
  const apps = selected.map((name) => ({
    name,
    cwd: path.resolve(__dirname, ".."),
    script: "dist/" + name + ".js",
    interpreter: process.execPath,
    node_args: "--env-file-if-exists=synthetic.env",
    env: { KL_PM2_DEPLOYMENT_ID: "deployment" },
  }));
  const state = {
    rows: [],
    calls: [],
    events: [],
    verified: [],
    beforeRead: () => {},
    beforeVerify: () => {},
  };
  const bus = { readyProofs: new Map() };
  const row = (app) => ({
    name: app.name,
    pid: 100 + apps.indexOf(app),
    pm2_env: {
      status: "online",
      restart_time: 0,
      KL_PM2_PROTOCOL: "2",
      KL_PM2_DEPLOYMENT_ID: "deployment",
      KL_WRITER_LAUNCH_TOKEN: "private-launch-" + app.name,
      pm_exec_path: path.resolve(app.cwd, app.script),
      exec_interpreter: app.interpreter,
      node_args: [app.node_args],
    },
  });
  const ready = (p, tokens) =>
    bus.readyProofs.set(
      p.name + ":" + p.pid + ":" + p.pm2_env.KL_WRITER_LAUNCH_TOKEN,
      tokens ??
        Array.from(
          { length: p.name === "kl-import-worker" ? 2 : 1 },
          (_, i) => "private-writer-" + p.name + i,
        ),
    );
  const options = {
    entryTimeoutMs: 1200,
    timeoutMs: 6000,
    emit: (r) => state.events.push(r),
    readProcesses: async () => {
      await new Promise((r) => setImmediate(r));
      await state.beforeRead();
      return structuredClone(state.rows);
    },
    runCommand: async (entry, args) => {
      const app = apps.find((a) => a.name === args.at(-1));
      state.calls.push(args);
      const p = row(app);
      state.rows.push(p);
      ready(p);
    },
    verify: async (input, mode, budget) => {
      assert.equal(mode, "verify-fast");
      assert.equal(input.serial, true);
      assert.ok(budget > 0);
      state.verified.push(input.verify.map((p) => p.name));
      await state.beforeVerify(input);
    },
  };
  return {
    apps,
    bus,
    state,
    row,
    ready,
    options,
    run: () => launchProcesses("synthetic-pm2", apps, bus, options),
  };
}
test("mode defaults, strict values and env precedence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kl-mode-"));
  try {
    fs.mkdirSync(path.join(dir, "server"));
    fs.writeFileSync(path.join(dir, "server/.env"), "");
    assert.equal(startupMode(dir, {}), "serial");
    fs.writeFileSync(
      path.join(dir, "server/.env"),
      "KL_PM2_START_MODE=parallel\n",
    );
    assert.equal(startupMode(dir, {}), "parallel");
    assert.equal(startupMode(dir, { KL_PM2_START_MODE: "serial" }), "serial");
    for (const value of ["", "Serial", "invalid", "1"])
      assert.throws(
        () => startupMode(dir, { KL_PM2_START_MODE: value }),
        /INVALID_CONFIG_KL_PM2_START_MODE/,
      );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("serial verifies full prefix before launching next and logs no launch/writer secrets", async () => {
  const h = harness();
  let active = 0,
    max = 0;
  const launch = h.options.runCommand;
  h.options.runCommand = async (...args) => {
    active++;
    max = Math.max(max, active);
    await launch(...args);
    active--;
  };
  await h.run();
  assert.equal(max, 1);
  assert.deepEqual(h.state.verified, [[names[0]], names.slice(0, 2), names]);
  assert.deepEqual(
    h.state.calls.map((a) => a.at(-1)),
    names,
  );
  assert.ok(h.state.calls.every((a) => a.at(-2) === "--only"));
  const stages = h.state.events.filter(
    (e) => e.state === "started" || e.state === "completed",
  );
  assert.deepEqual(
    stages.map((e) => [e.stage, e.state]),
    names.flatMap((n) => [
      ["process-start." + n, "started"],
      ["process-start." + n, "completed"],
    ]),
  );
  assert.ok(!JSON.stringify(h.state.events).includes("private-"));
});
test("CLI completion alone cannot advance without this PID/token ready", async () => {
  const h = harness();
  h.options.entryTimeoutMs = 50;
  h.options.runCommand = async (entry, args) => {
    const app = h.apps.find((a) => a.name === args.at(-1));
    h.state.calls.push(args);
    const p = h.row(app);
    h.state.rows.push(p);
    h.bus.readyProofs.set(p.name + ":999:old", ["stale"]);
  };
  await assert.rejects(h.run(), /PROCESS_ENTRY_READY_TIMEOUT/);
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.state.verified.length, 0);
  assert.equal(h.state.events.at(-1).state, "failed");
});
test("ready IPC before CLI completion cannot advance", async () => {
  const h = harness();
  const original = h.options.runCommand;
  let finished = false;
  h.options.runCommand = async (...args) => {
    await original(...args);
    await new Promise((r) => setTimeout(r, 35));
    finished = true;
  };
  h.options.verify = async () => assert.equal(finished, true);
  await h.run();
  assert.equal(h.state.calls.length, 3);
});
test("PID replacement while CLI is pending cancels it before returning failure", async () => {
  const h = harness();
  let reads = 0,
    closed = false;
  h.options.runCommand = async (entry, args, budget, signal) => {
    h.state.calls.push(args);
    h.state.rows.push(h.row(h.apps[0]));
    await new Promise((resolve) =>
      signal.addEventListener(
        "abort",
        () =>
          setTimeout(() => {
            closed = true;
            resolve();
          }, 5),
        { once: true },
      ),
    );
  };
  h.state.beforeRead = () => {
    if (++reads === 2) h.state.rows[0].pid++;
  };
  await assert.rejects(h.run(), /PROCESS_CHANGED_DURING_VERIFICATION/);
  assert.equal(closed, true);
  assert.equal(h.state.calls.length, 1);
});
test("observed entry disappearing stops immediately instead of waiting for the full budget", async () => {
  const h = harness();
  let reads = 0;
  h.options.runCommand = async (entry, args, budget, signal) => {
    h.state.calls.push(args);
    h.state.rows.push(h.row(h.apps[0]));
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
  };
  h.state.beforeRead = () => {
    if (++reads === 2) h.state.rows = [];
  };
  await assert.rejects(h.run(), /PROCESS_CHANGED_DURING_VERIFICATION/);
  assert.equal(reads, 2);
  assert.equal(h.state.calls.length, 1);
});

test("previous ready entry changing during next launch stops progression", async () => {
  const h = harness();
  const original = h.options.runCommand;
  h.options.runCommand = async (...args) => {
    await original(...args);
    if (h.state.calls.length === 2) h.state.rows[0].pid++;
  };
  await assert.rejects(h.run(), /PROCESS_CHANGED_DURING_VERIFICATION/);
  assert.equal(h.state.calls.length, 2);
});
test("terminal/restarted/wrong deployment entries never advance", async () => {
  for (const change of [
    { status: "stopped" },
    { restart_time: 1 },
    { KL_PM2_DEPLOYMENT_ID: "wrong" },
  ]) {
    const h = harness();
    const original = h.options.runCommand;
    h.options.runCommand = async (...args) => {
      await original(...args);
      Object.assign(h.state.rows[0].pm2_env, change);
    };
    await assert.rejects(
      h.run(),
      /PROCESS_STARTUP_FAILED|DEPLOYMENT_CHANGED_RESTART_REQUIRED/,
    );
    assert.equal(h.state.calls.length, 1);
  }
});
test("unexpected future entry and invalid writer proof cannot advance", async () => {
  for (const bad of ["future", "missing", "duplicate", "wrong-import"]) {
    const h = harness(
      bad === "wrong-import" ? ["kl-import-worker", names[2]] : names,
    );
    const original = h.options.runCommand;
    h.options.runCommand = async (...args) => {
      await original(...args);
      if (bad === "future") h.state.rows.push(h.row(h.apps[1]));
      else
        h.ready(h.state.rows[0], bad === "duplicate" ? ["same", "same"] : []);
    };
    await assert.rejects(
      h.run(),
      /PROCESS_UNEXPECTED_DURING_STARTUP|WORKER_REGISTRATION_REQUIRED/,
    );
    assert.equal(h.state.calls.length, 1);
  }
});
test("command failure or writer rejection prevents remaining entries", async () => {
  for (const source of ["command", "verify"]) {
    const h = harness();
    const original = h.options.runCommand;
    if (source === "command")
      h.options.runCommand = async (...args) => {
        await original(...args);
        throw Error("PM2_COMMAND_FAILED");
      };
    else
      h.options.verify = async () => {
        throw Error("WORKER_REGISTRATION_REQUIRED");
      };
    await assert.rejects(
      h.run(),
      /PM2_COMMAND_FAILED|WORKER_REGISTRATION_REQUIRED/,
    );
    assert.equal(h.state.calls.length, 1);
  }
});
test("managed single API requires real ready but accepts exactly zero writer tokens", async () => {
  const h = harness(["kl-api"]);
  h.options.managed = true;
  const original = h.options.runCommand;
  h.options.runCommand = async (...args) => {
    await original(...args);
    h.ready(h.state.rows[0], []);
  };
  await h.run();
  assert.equal(h.state.calls.length, 1);
  assert.deepEqual(h.state.verified, [["kl-api"]]);
});
test("explicit parallel performs one all-entry CLI command; invalid mode starts nothing", async () => {
  const h = harness();
  h.options.mode = "parallel";
  h.options.runCommand = async (entry, args, budget) => {
    h.state.calls.push(args);
    assert.ok(budget > 0);
  };
  await h.run();
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.state.calls[0].includes("--only"), false);
  assert.equal(h.state.verified.length, 0);
  h.options.mode = "invalid";
  await assert.rejects(h.run(), /INVALID_CONFIG_KL_PM2_START_MODE/);
  assert.equal(h.state.calls.length, 1);
});
test("shared total budget cannot reset for every entry", async () => {
  const h = harness();
  h.options.timeoutMs = 40;
  h.options.verify = async () => new Promise((r) => setTimeout(r, 60));
  await assert.rejects(h.run(), /PROCESS_ENTRY_READY_TIMEOUT/);
  assert.equal(h.state.calls.length, 1);
});
test("serial DB proof enforces ordinary kinds/extra writers and preserves managed child admission", async () => {
  let rows = [],
    unknown = null;
  const db = {
    collection: () => ({
      find: () => ({ limit: () => ({ toArray: async () => rows }) }),
      findOne: async () => unknown,
    }),
  };
  const app = {
    name: "kl-api",
    pid: 1,
    protocol: "2",
    writerTokens: ["token"],
  };
  rows = [{ pid: 1, kind: "api", token: "token" }];
  await verifyWriters(db, [app], { serial: true });
  rows[0].kind = "learning";
  await assert.rejects(
    verifyWriters(db, [app], { serial: true }),
    /WORKER_REGISTRATION_REQUIRED/,
  );
  rows[0].kind = "api";
  unknown = { pid: 2 };
  await assert.rejects(
    verifyWriters(db, [app], { serial: true }),
    /MANAGED_UNKNOWN_WRITER/,
  );
  // A managed supervisor has no own tokens; the API child has a different PID.
  unknown = { pid: 2, kind: "api" };
  rows = [];
  await verifyWriters(db, [{ ...app, writerTokens: [] }], {
    serial: true,
    managed: true,
  });
  rows = [{ pid: 1, kind: "api", token: "token" }];
  await assert.rejects(
    verifyWriters(db, [app], { serial: true, managed: true }),
    /MANAGED_UNKNOWN_WRITER/,
  );
});
