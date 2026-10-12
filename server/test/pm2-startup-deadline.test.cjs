"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { startupOptions } = require("../../ops/startup-options.cjs"),
  {
    select,
    acquireLock,
    supervise,
  } = require("../../ops/startup-supervisor.cjs"),
  tree = require("../../ops/process-tree.cjs");
function temporary() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kl-deadline-unit-"));
}
test("strict overall/grace options, defaults, env precedence and boundaries", () => {
  const root = temporary();
  try {
    fs.mkdirSync(path.join(root, "server"));
    fs.writeFileSync(
      path.join(root, "server/.env"),
      "KL_PM2_STARTUP_TIMEOUT_MS=90000\nKL_PM2_TIMEOUT_STOP_GRACE_MS=4000\n",
    );
    assert.deepEqual(startupOptions(root, {}), {
      timeoutMs: 90000,
      graceMs: 4000,
    });
    assert.equal(
      startupOptions(root, { KL_PM2_STARTUP_TIMEOUT_MS: "30000" }).timeoutMs,
      30000,
    );
    fs.writeFileSync(path.join(root, "server/.env"), "");
    assert.deepEqual(startupOptions(root, {}), {
      timeoutMs: 180000,
      graceMs: 30000,
    });
    for (const [key, values] of [
      ["KL_PM2_STARTUP_TIMEOUT_MS", ["", "29999", "1800001", "1e5", "NaN"]],
      ["KL_PM2_TIMEOUT_STOP_GRACE_MS", ["", "999", "120001", "30.5"]],
    ])
      for (const value of values)
        assert.throws(
          () => startupOptions(root, { [key]: value }),
          new RegExp("INVALID_CONFIG_" + key),
        );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("ownership requires known name, protocol, cwd and exact script; other projects are ignored", () => {
  const root = path.resolve(__dirname, "../..");
  const row = {
    name: "kl-api",
    pid: 10,
    pm_id: 0,
    pm2_env: {
      KL_PM2_PROTOCOL: "2",
      pm_cwd: path.join(root, "server"),
      pm_exec_path: path.join(root, "server/dist/main.js"),
    },
  };
  assert.deepEqual(select([row, { name: "other-app", pid: 20 }], root), [row]);
  for (const env of [
    { pm_cwd: os.tmpdir() },
    { pm_exec_path: path.join(root, "server/dist/other.js") },
    { KL_PM2_PROTOCOL: undefined },
  ])
    assert.throws(
      () => select([{ ...row, pm2_env: { ...row.pm2_env, ...env } }], root),
      /OWNERSHIP_CONFLICT/,
    );
  assert.throws(() => select([row, row], root), /OWNERSHIP_CONFLICT/);
});
test("Linux stat parsing handles parentheses and records start ticks; excluded daemon descendants remain untouched", () => {
  const fields = ["S", "7", ...Array(17).fill("0"), "12345"];
  assert.deepEqual(tree.parseStat(42, "42 (a (b) c) " + fields.join(" ")), {
    pid: 42,
    ppid: 7,
    start: "12345",
    state: "S",
  });
  assert.throws(() => tree.parseStat(42, "broken"), /IDENTITY_UNCONFIRMED/);
  const rows = [
    { pid: 10, ppid: 1 },
    { pid: 11, ppid: 10 },
    { pid: 20, ppid: 10 },
    { pid: 21, ppid: 20 },
    { pid: 30, ppid: 20 },
    { pid: 31, ppid: 30 },
  ];
  assert.deepEqual(
    tree.descendants(rows, [10, 30], new Set([20])).map((p) => p.pid),
    [10, 11, 30, 31],
  );
});
test("force kill rechecks start identity, never kills reused PID, zombie or self", async () => {
  const row = { pid: 900001, start: "old", state: "R" };
  let kills = [];
  await tree.killVerified(
    row,
    "SIGKILL",
    async () => [row],
    (p, s) => kills.push([p, s]),
  );
  assert.deepEqual(kills, [[row.pid, "SIGKILL"]]);
  kills = [];
  await assert.rejects(
    tree.killVerified(
      row,
      "SIGKILL",
      async () => [{ ...row, start: "new" }],
      (p) => kills.push(p),
    ),
    /IDENTITY_CHANGED/,
  );
  assert.deepEqual(kills, []);
  await tree.killVerified(
    row,
    "SIGKILL",
    async () => [{ ...row, state: "Z" }],
    (p) => kills.push(p),
  );
  assert.deepEqual(kills, []);
  await assert.rejects(
    tree.killVerified(
      { ...row, pid: process.pid },
      "SIGKILL",
      async () => [{ ...row, pid: process.pid }],
      (p) => kills.push(p),
    ),
    /IDENTITY_UNCONFIRMED/,
  );
});
test("exclusive startup lock rejects live and stale owners, releases only matching owner", async () => {
  const root = temporary(),
    home = path.join(root, "home"),
    take = async () => [
      { pid: process.pid, ppid: 1, start: "own", state: "R" },
    ];
  try {
    const release = await acquireLock(root, home, "one", take);
    await assert.rejects(
      acquireLock(root, home, "two", take),
      /ALREADY_RUNNING/,
    );
    release();
    const again = await acquireLock(root, home, "three", take);
    const file = path.join(home, fs.readdirSync(home)[0]);
    fs.writeFileSync(
      file,
      JSON.stringify({ pid: process.pid, start: "different" }),
    );
    assert.throws(again, /IDENTITY_CHANGED/);
    await assert.rejects(
      acquireLock(root, home, "four", take),
      /RECOVERY_REQUIRED/,
    );
    assert.equal(fs.existsSync(file), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
async function scenario(t, body, options = {}) {
  const root = temporary(),
    before = process.env.PM2_HOME;
  process.env.PM2_HOME = path.join(root, "home");
  const file = path.join(root, "coordinator.cjs");
  fs.writeFileSync(
    file,
    'const fs=require("node:fs");process.once("message",m=>{' + body + "});",
  );
  const calls = [],
    events = [];
  let closed = false;
  const client = {
    list: async () => [],
    stop: async (id) => calls.push(id),
    delete: async () => {},
    close: () => {
      closed = true;
    },
  };
  try {
    const value = await supervise({
      root,
      entry: "unused",
      command: "start",
      timeoutMs: 7000,
      graceMs: 2000,
      checkMs: 5000,
      coordinator: file,
      clientFactory: async () => client,
      writerCheck: async () => true,
      emit: (r) => events.push(r),
      ...options,
    });
    return { value, calls, events, closed };
  } catch (error) {
    return { error, calls, events, closed };
  } finally {
    process.env.PM2_HOME = before;
    if (before === undefined) delete process.env.PM2_HOME;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test(
  "successful authenticated handshake disarms independent deadline and preserves two-phase ownership",
  { timeout: 15000 },
  async (t) => {
    const r = await scenario(
      t,
      'process.send({kind:"success",nonce:m.nonce,names:["kl-api"],reuse:false},()=>process.disconnect());',
    );
    assert.equal(r.error, undefined);
    assert.equal(r.events.at(-1).state, "completed");
    assert.deepEqual(r.calls, []);
    assert.equal(r.closed, true);
  },
);
test(
  "ordinary authenticated failure preserves services; unexpected coordinator loss enters cleanup",
  { timeout: 25000 },
  async (t) => {
    const r = await scenario(
      t,
      'process.send({kind:"failure",nonce:m.nonce,code:"DEPLOYMENT_CHANGED_RESTART_REQUIRED"},()=>{process.disconnect();process.exitCode=1;});',
    );
    assert.match(r.error.message, /DEPLOYMENT_CHANGED/);
    assert.deepEqual(r.calls, []);
    assert.equal(
      r.events.some((e) => e.state === "stopping"),
      false,
    );
    const gone = await scenario(t, "process.exit(2);");
    assert.match(gone.error.message, /COORDINATOR_EXIT/);
    assert.ok(gone.events.some((e) => e.state === "stopping"));
  },
);
test(
  "independent deadline survives synchronous coordinator block, force stops its child and ignores forged success",
  { timeout: 20000 },
  async (t) => {
    const marker = path.join(
      os.tmpdir(),
      "kl-deadline-child-" + require("node:crypto").randomUUID(),
    );
    const body =
      'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{windowsHide:true,stdio:"ignore"});fs.writeFileSync(' +
      JSON.stringify(marker) +
      ',String(c.pid));process.send({kind:"success",nonce:"wrong",names:["kl-api"]});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);';
    try {
      const r = await scenario(t, body);
      assert.match(r.error.message, /STARTUP_TOTAL_TIMEOUT/);
      assert.equal(
        r.events.some((e) => e.state === "completed"),
        false,
      );
      assert.ok(r.events.some((e) => e.state === "stopping"));
      assert.equal(r.events.at(-1).processes_stopped, true);
      assert.equal(r.events.at(-1).writers_released, true);
      const pid = Number(fs.readFileSync(marker, "utf8"));
      const live = (await tree.snapshot()).find(
        (p) => p.pid === pid && tree.alive(p),
      );
      assert.equal(
        live,
        undefined,
        "tracked coordinator descendant must have exited",
      );
    } finally {
      fs.rmSync(marker, { force: true });
    }
  },
);

test(
  "deadline requests all six stops concurrently; failed DB proof never claims writer release",
  { timeout: 18000 },
  async (t) => {
    const root = temporary(),
      home = path.join(root, "home"),
      before = process.env.PM2_HOME;
    process.env.PM2_HOME = home;
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, "pm2.pid"), "50");
    const file = path.join(root, "coordinator.cjs");
    fs.writeFileSync(
      file,
      'process.once("message",m=>{process.on("message",v=>{if(v.kind==="cancel")process.exit(0);});});',
    );
    const { scripts } = require("../../ops/startup-supervisor.cjs");
    let services = Object.entries(scripts).map(([name, script], i) => ({
      name,
      pm_id: i,
      pid: 900001 + i,
      pm2_env: {
        KL_PM2_PROTOCOL: "2",
        KL_PM2_DATABASE_ID: "a".repeat(64),
        KL_WRITER_LAUNCH_TOKEN: "test" + i,
        pm_cwd: path.join(root, "server"),
        pm_exec_path: path.join(root, "server", script),
        status: "online",
      },
    }));
    const events = [],
      requests = [],
      completions = [];
    const take = async () => {
      const physical = await tree.snapshot();
      return physical.concat(
        services
          .filter((p) => p.pid)
          .map((p) => ({
            pid: p.pid,
            ppid: 50,
            start: "test" + p.pid,
            state: "R",
          })),
      );
    };
    const client = {
      list: async () => structuredClone(services),
      stop: (id) => {
        requests.push(id);
        return new Promise((resolve) =>
          setTimeout(() => {
            completions.push({
              id,
              requested: requests.length,
              at: Date.now(),
            });
            const row = services.find((p) => p.pm_id === id);
            if (row) {
              row.pid = 0;
              row.pm2_env.status = "stopped";
            }
            resolve();
          }, 100),
        );
      },
      delete: async (id) => {
        services = services.filter((p) => p.pm_id !== id);
      },
      close: () => {},
    };
    const began = Date.now();
    try {
      await assert.rejects(
        supervise({
          root,
          entry: "unused",
          command: "start",
          coordinator: file,
          timeoutMs: 6000,
          graceMs: 2000,
          checkMs: 5000,
          take,
          clientFactory: async () => client,
          writerCheck: async () => false,
          emit: (e) => events.push(e),
        }),
        /STARTUP_TOTAL_TIMEOUT/,
      );
      assert.deepEqual([...new Set(requests)].sort(), [0, 1, 2, 3, 4, 5]);
      assert.ok(
        completions[0].requested >= 6,
        "all stops must be sent before the first completion",
      );
      assert.ok(
        completions[0].at -
          (events.find((e) => e.state === "stopping").elapsed_ms + began) <
          2000,
        "parallel stop begins inside short grace period",
      );
      assert.equal(events.at(-1).processes_stopped, true);
      assert.equal(events.at(-1).writers_released, false);
      assert.equal(events.at(-1).state, "unconfirmed");
    } finally {
      if (before === undefined) delete process.env.PM2_HOME;
      else process.env.PM2_HOME = before;
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("writer release requires a nonempty, exact database identity proof", () => {
  const { knownDatabase } = require("../../ops/startup-stop-proof.cjs");
  const id = "a".repeat(64);
  assert.equal(knownDatabase([id, id], id), true);
  for (const ids of [
    [],
    undefined,
    ["b".repeat(64)],
    [id, "b".repeat(64)],
    [null],
  ])
    assert.equal(knownDatabase(ids, id), false);
  assert.equal(knownDatabase(["invalid"], "invalid"), false);
});

test(
  "success handshake cannot outlive overall deadline while monitoring drains",
  { timeout: 25000 },
  async (t) => {
    let reads = 0;
    const r = await scenario(
      t,
      'setTimeout(()=>process.send({kind:"success",nonce:m.nonce,names:["kl-api"]},()=>process.disconnect()),2500);',
      { take: () => (++reads >= 3 ? new Promise(() => {}) : tree.snapshot()) },
    );
    assert.match(r.error.message, /STARTUP_TOTAL_TIMEOUT/);
    assert.equal(
      r.events.some((e) => e.state === "completed"),
      false,
    );
    assert.ok(r.events.some((e) => e.state === "stopping"));
    assert.equal(
      r.events.at(-1).processes_stopped,
      false,
      "unknown OS snapshot must remain unconfirmed",
    );
  },
);

test("PM2 SDK resolves actual package behind an aliased JavaScript entry", async () => {
  const root = temporary(),
    pkg = path.join(root, "package"),
    alias = path.join(root, "global-bin");
  try {
    fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "bin/pm2"), "");
    fs.writeFileSync(
      path.join(pkg, "index.js"),
      "module.exports={connect:cb=>cb(null),disconnect:()=>{},list:cb=>cb(null,[]),Client:{executeRemote:(m,a,cb)=>cb(null)}};",
    );
    fs.symlinkSync(path.join(pkg, "bin"), alias, "junction");
    const { connect } = require("../../ops/startup-supervisor.cjs");
    const client = await connect(path.join(alias, "pm2"), 1000);
    assert.deepEqual(await client.list(), []);
    client.close();
  } finally {
    assert.ok(
      path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep),
    );
    fs.rmSync(root, { recursive: true, force: true });
  }
});
