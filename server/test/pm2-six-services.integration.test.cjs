"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { randomUUID } = require("node:crypto"),
  { spawn, execFile } = require("node:child_process"),
  { promisify } = require("node:util"),
  { createServer } = require("node:net");
const { fixture } = require("./helpers.cjs"),
  { FEATURE_FLAGS } = require("../dist/runtime/feature-flags"),
  backend = require("../../ops/pm2-backend.cjs");
const root = path.resolve(__dirname, "../..");
function command(entry, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("TEST_COMMAND_TIMEOUT"));
    }, 180000);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}
async function protect(dir) {
  const script =
    "$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule);Set-Acl -LiteralPath $env:KL_TEST_PRIVATE_ROOT -AclObject $acl";
  await promisify(execFile)(
    path.join(
      process.env.SystemRoot,
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { windowsHide: true, env: { ...process.env, KL_TEST_PRIVATE_ROOT: dir } },
  );
}
test(
  "隔离Windows六服务：真实扫描依赖、导入双writer、原定义重启及优雅退出",
  { timeout: 240000 },
  async (t) => {
    assert.equal(process.platform, "win32");
    assert.ok(
      process.env.TEST_CLAMSCAN_PATH && process.env.TEST_CLAMAV_DATABASE,
      "real installed ClamAV required",
    );
    const storage = fs.mkdtempSync(path.join(os.homedir(), "kl-six-storage-"));
    await protect(storage);
    for (const area of ["tmp", "quarantine", "ready"]) {
      fs.mkdirSync(path.join(storage, area));
      await protect(path.join(storage, area));
    }
    t.after(() => {
      assert.ok(storage.startsWith(path.join(os.homedir(), "kl-six-storage-")));
      fs.rmSync(storage, { recursive: true, force: true });
    });
    const f = await fixture(t, {
      app: false,
      env: {
        ...Object.fromEntries(FEATURE_FLAGS.map((key) => [key, "false"])),
        ALLOW_INSECURE_HTTP: "true",
        KL_TRAINING_ENABLED: "true",
        KL_KNOWLEDGE_ENABLED: "true",
        KL_KNOWLEDGE_IMPORT_ENABLED: "true",
        FILE_STORAGE_DRIVER: "local",
        FILE_SCAN_ENABLED: "true",
        FILE_STORAGE_ROOT: storage,
        CLAMSCAN_PATH: process.env.TEST_CLAMSCAN_PATH,
        CLAMAV_DATABASE: process.env.TEST_CLAMAV_DATABASE,
        SCAN_DATABASE_MAX_AGE_HOURS: "48",
        SCAN_TIMEOUT_MS: "60000",
      },
    });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "kl_six_pm2_")),
      entry = backend.resolvePm2Entry(),
      prefix = "\\\\.\\pipe\\kl-six-" + randomUUID();
    const preload = path.join(home, "pipes.cjs"),
      paths = path.join(path.dirname(path.dirname(entry)), "paths.js");
    fs.writeFileSync(
      preload,
      "const p=" +
        JSON.stringify(paths) +
        ";const original=require(p);require.cache[require.resolve(p)].exports=(h)=>{const c=original(h);c.DAEMON_RPC_PORT=" +
        JSON.stringify(prefix + "-rpc") +
        ";c.DAEMON_PUB_PORT=" +
        JSON.stringify(prefix + "-pub") +
        ";c.INTERACTOR_RPC_PORT=" +
        JSON.stringify(prefix + "-other") +
        ";return c;};",
    );

    const server = createServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    await new Promise((r) => server.close(r));
    const env = {
      ...process.env,
      PM2_HOME: home,
      NODE_OPTIONS: "--require=" + preload,
      KL_PM2_BIN: entry,
      PORT: String(port),
      MONGODB_URI: f.uri,
    };
    const helper = path.join(root, "ops/pm2-backend.cjs");
    const rows = async () =>
      JSON.parse((await command(entry, ["jlist"], env)).output);
    const beforeDefault = await command(entry, ["jlist"], { ...process.env });
    const summary = (r) =>
      JSON.parse(r.output).map((p) => ({
        name: p.name,
        pid: p.pid,
        status: p.pm2_env.status,
      }));
    try {
      assert.equal((await command(entry, ["jlist"], env)).code, 0);
      const start = await command(helper, ["start"], env);
      if (start.code !== 0) {
        for (const p of await rows()) {
          const file = p.pm2_env.pm_err_log_path;
          if (file && fs.existsSync(file))
            for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
              try {
                const e = JSON.parse(line.slice(line.indexOf("{")));
                if (e.event === "isolated.failure")
                  t.diagnostic(JSON.stringify(e));
              } catch {}
            }
        }
      }
      assert.equal(
        start.code,
        0,
        (start.output.match(/[A-Z][A-Z0-9_]{3,}/g) || []).join(","),
      );
      assert.match(start.output, /已就绪/);
      const initial = await rows();
      assert.equal(initial.length, 6);
      assert.ok(
        initial.every(
          (p) =>
            p.pid &&
            p.pm2_env.status === "online" &&
            p.pm2_env.restart_time === 0,
        ),
      );
      const initialWriters = await f.db
        .collection("operational_writers")
        .find({ state: "running" })
        .toArray();
      assert.equal(initialWriters.length, 7);
      const imports = initial.find((p) => p.name === "kl-import-worker");
      assert.equal(
        initialWriters.filter((w) => w.pid === imports.pid).length,
        2,
      );
      const repeated = await command(helper, ["start"], env);
      assert.equal(
        repeated.code,
        0,
        (repeated.output.match(/[A-Z][A-Z0-9_]{3,}/g) || []).join(","),
      );
      assert.match(repeated.output, /已验证并复用/);
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
          .map((w) => w.token)
          .sort(),
        initialWriters.map((w) => w.token).sort(),
        "six-service reuse preserves all seven writers including imports",
      );
      const restart = await command(
        entry,
        ["restart", ...initial.map((p) => p.name)],
        env,
      );
      assert.equal(restart.code, 0);
      const until = Date.now() + 60000;
      let restarted;
      while (Date.now() < until) {
        restarted = await rows();
        if (
          restarted.length === 6 &&
          restarted.every(
            (p) =>
              p.pm2_env.status === "online" &&
              p.pid !== initial.find((old) => old.name === p.name).pid,
          )
        )
          break;
        await new Promise((r) => setTimeout(r, 300));
      }
      assert.ok(
        restarted.every(
          (p) =>
            p.pm2_env.status === "online" &&
            p.pid !== initial.find((old) => old.name === p.name).pid,
        ),
      );
      const next = await f.db
        .collection("operational_writers")
        .find({ state: "running" })
        .toArray();
      assert.equal(next.length, 7);
      assert.ok(
        next.every((w) => !initialWriters.some((old) => old.token === w.token)),
      );
      for (const p of restarted)
        assert.equal(
          p.pm2_env.KL_WRITER_LAUNCH_TOKEN,
          initial.find((old) => old.name === p.name).pm2_env
            .KL_WRITER_LAUNCH_TOKEN,
        );
      const response = await fetch(
        "http://127.0.0.1:" + port + "/api/v1/health/ready",
      );
      assert.equal(response.status, 200);
      await response.body.cancel();
      const stop = await command(helper, ["stop"], env);
      assert.equal(
        stop.code,
        0,
        (stop.output.match(/[A-Z][A-Z0-9_]{3,}/g) || []).join(","),
      );
      assert.equal(
        await f.db
          .collection("operational_writers")
          .countDocuments({ state: "running" }),
        0,
      );
    } finally {
      await command(helper, ["stop"], env);
      await command(entry, ["kill"], env);
      assert.deepEqual(
        summary(await command(entry, ["jlist"], { ...process.env })),
        summary(beforeDefault),
      );
      assert.ok(
        path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep),
      );
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);
