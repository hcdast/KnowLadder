"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const backend = require("../../ops/pm2-backend.cjs"),
  pre = require("../../ops/backend-preflight.cjs"),
  { timing } = require("../../ops/startup-timing.cjs"),
  { deploymentIdentity } = require("../../ops/deployment-identity.cjs");
function model() {
  const app = {
    name: "kl-api",
    cwd: path.resolve(__dirname, ".."),
    script: "dist/main.js",
    interpreter: process.execPath,
    node_args: "--env-file-if-exists=synthetic.env",
    env: { KL_PM2_DEPLOYMENT_ID: "test-identity" },
  };
  const row = {
    name: app.name,
    pid: 42,
    pm2_env: {
      status: "online",
      restart_time: 3,
      KL_PM2_PROTOCOL: "2",
      KL_PM2_DEPLOYMENT_ID: "test-identity",
      KL_WRITER_LAUNCH_TOKEN: "launch",
      pm_exec_path: path.join(app.cwd, app.script),
      exec_interpreter: app.interpreter,
      node_args: [app.node_args],
    },
  };
  return { app, row };
}
test("start reuses only exact healthy deployment; restart remains explicit", () => {
  const { app, row } = model();
  assert.equal(backend.chooseStartAction([app], [row]), "reuse");
  assert.equal(backend.chooseStartAction([app], [row], true), "launch");
  assert.equal(backend.chooseStartAction([app], []), "launch");
  for (const override of [
    { KL_PM2_DEPLOYMENT_ID: "old" },
    { KL_PM2_DEPLOYMENT_ID: undefined },
    { exec_interpreter: "other" },
    { pm_exec_path: "other" },
    { node_args: [] },
  ])
    assert.throws(
      () =>
        backend.chooseStartAction(
          [app],
          [{ ...row, pm2_env: { ...row.pm2_env, ...override } }],
        ),
      /DEPLOYMENT_CHANGED_RESTART_REQUIRED/,
    );
  assert.throws(
    () =>
      backend.chooseStartAction(
        [app],
        [{ ...row, pm2_env: { ...row.pm2_env, status: "waiting restart" } }],
      ),
    /PARTIAL_DEPLOYMENT_RESTART_REQUIRED/,
  );
  assert.throws(
    () =>
      backend.chooseStartAction(
        [app, { ...app, name: "kl-learning-worker" }],
        [row],
      ),
    /PARTIAL_DEPLOYMENT_RESTART_REQUIRED/,
  );
});
test("deployment fingerprint changes with bytes or effective env, never reveals secret values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kl-identity-"));
  try {
    for (const d of ["server/dist", "ops"])
      fs.mkdirSync(path.join(root, d), { recursive: true });
    for (const p of [
      "server/.env",
      "server/dist/main.js",
      "server/package-lock.json",
      "ecosystem.config.js",
      "ops/pm2-backend.cjs",
      "ops/backend-preflight.cjs",
      "ops/deployment-identity.cjs",
      "ops/startup-timing.cjs",
      "ops/preflight-budget.cjs",
    ])
      fs.writeFileSync(
        path.join(root, p),
        p === "server/.env"
          ? "S3_SECRET_ACCESS_KEY=synthetic-private\nPORT=3000\n"
          : "original",
      );
    const a = deploymentIdentity(root, {});
    assert.match(a, /^[a-f0-9]{64}$/);
    assert.equal(
      a,
      deploymentIdentity(root, {
        KL_PM2_DEPLOYMENT_ID: "generated",
        KL_WRITER_LAUNCH_TOKEN: "new",
      }),
    );
    assert.notEqual(a, deploymentIdentity(root, { PORT: "3001" }));
    fs.writeFileSync(path.join(root, "server/dist/main.js"), "new bytes");
    assert.notEqual(a, deploymentIdentity(root, {}));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("migration proof rejects missing, wrong deployment, stale or future check", () => {
  const proof = {
    deployment: "same",
    schema: "a".repeat(64),
    checked_at: 1000000,
  };
  pre.validateProof(proof, "same", 1000001);
  for (const [p, identity, now] of [
    [undefined, "same", 1000001],
    [proof, "other", 1000001],
    [proof, "same", 1900001],
    [proof, "same", 999999],
    [{ ...proof, schema: "bad" }, "same", 1000001],
  ])
    assert.throws(
      () => pre.validateProof(p, identity, now),
      /SCHEMA_PROOF_INVALID/,
    );
});
function writerDb(rows, extra = false) {
  return {
    collection: () => ({
      find: () => ({ limit: () => ({ toArray: async () => rows }) }),
      findOne: async () => (extra ? { pid: 999 } : null),
    }),
  };
}
test("batched writer proof rejects missing, extra, duplicate, wrong kind and unknown process", async () => {
  const apps = [
      { name: "kl-api", pid: 42, protocol: "2", writerTokens: ["api-token"] },
    ],
    good = { pid: 42, token: "api-token", kind: "api" };
  await pre.verifyWriters(writerDb([good]), apps, { reuse: true });
  for (const rows of [
    [],
    [good, { pid: 42, token: "extra", kind: "api" }],
    [{ ...good, token: "other" }],
    [{ ...good, kind: "files" }],
  ])
    await assert.rejects(
      pre.verifyWriters(writerDb(rows), apps, { reuse: true }),
      /WORKER_REGISTRATION_REQUIRED/,
    );
  await assert.rejects(
    pre.verifyWriters(writerDb([good], true), apps, { reuse: true }),
    /MANAGED_UNKNOWN_WRITER/,
  );
  await assert.rejects(
    pre.verifyWriters(writerDb([good]), [
      { ...apps[0], writerTokens: ["api-token", "api-token"] },
    ]),
    /WORKER_REGISTRATION_REQUIRED/,
  );
});
test("ready still requires two stable proofs and rejects mid-check process replacement", async () => {
  const { row } = model(),
    proofs = new Map([["kl-api:42:launch", ["api-token"]]]);
  let calls = 0;
  const clock = [];
  await backend.waitReady(null, ["kl-api"], 3000, {
    reuse: true,
    readyProofs: proofs,
    proof: { schema: "test" },
    readProcesses: async () => [row],
    verify: async (input, mode) => {
      assert.equal(mode, "verify-fast");
      assert.equal(input.reuse, true);
      calls++;
    },
    fetchReady: async () => ({ status: 200, body: { cancel: async () => {} } }),
    emit: (r) => clock.push(r),
    timeoutMs: 3000,
  });
  assert.equal(calls, 2);
  let reads = 0;
  await assert.rejects(
    backend.waitReady(null, ["kl-api"], 3000, {
      reuse: true,
      readyProofs: proofs,
      proof: { schema: "test" },
      readProcesses: async () => [++reads === 1 ? row : { ...row, pid: 43 }],
      verify: async () => {},
      fetchReady: async () => ({ status: 200 }),
      emit: () => {},
      timeoutMs: 3000,
    }),
    /PROCESS_CHANGED_DURING_VERIFICATION/,
  );
  assert.equal(
    clock.filter((r) => r.stage === "writer-verify" && r.state === "completed")
      .length,
    2,
  );
});
test("phase diagnostics announce pending stage and elapsed failure without exception contents", async () => {
  const rows = [],
    clock = timing("fixture", (r) => rows.push(r));
  await assert.rejects(
    clock.run("schema", async () => {
      assert.deepEqual(rows, [
        {
          event: "startup.stage",
          scope: "fixture",
          stage: "schema",
          state: "started",
        },
      ]);
      throw Error("synthetic-private-value");
    }),
  );
  assert.equal(rows[1].state, "failed");
  assert.equal(typeof rows[1].elapsed_ms, "number");
  assert.ok(!JSON.stringify(rows).includes("synthetic-private-value"));
});

test("zero-PID backoff status is normalized before strict stopped confirmation", async () => {
  let status = "waiting restart",
    normalized = 0;
  await backend.waitStopped(
    () => [{ pid: 0, pm2_env: { status } }],
    1000,
    async (rows) => {
      if (rows[0].pm2_env.status === "waiting restart") {
        normalized++;
        status = "stopped";
      }
    },
  );
  assert.equal(normalized, 1);
});
