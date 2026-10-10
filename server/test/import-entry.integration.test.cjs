"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { fork, execFile } = require("node:child_process"),
  { promisify } = require("node:util"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  { randomUUID } = require("node:crypto");
const { fixture } = require("./helpers.cjs"),
  { FEATURE_FLAGS } = require("../dist/runtime/feature-flags");
test(
  "导入实际CLI入口完成双writer初始化、ready及once退出",
  { timeout: 45000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.homedir(), "kl-import-entry-"));
    const script =
      "$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule);Set-Acl -LiteralPath $env:KL_TEST_PRIVATE_ROOT -AclObject $acl";
    for (const dir of [
      root,
      ...["tmp", "quarantine", "ready"].map((a) => path.join(root, a)),
    ]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir);
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
        {
          windowsHide: true,
          env: { ...process.env, KL_TEST_PRIVATE_ROOT: dir },
        },
      );
    }
    t.after(() => {
      assert.ok(root.startsWith(path.join(os.homedir(), "kl-import-entry-")));
      fs.rmSync(root, { recursive: true, force: true });
    });
    const f = await fixture(t, {
      app: false,
      env: {
        ...Object.fromEntries(FEATURE_FLAGS.map((k) => [k, "false"])),
        ALLOW_INSECURE_HTTP: "true",
        KL_TRAINING_ENABLED: "true",
        KL_KNOWLEDGE_ENABLED: "true",
        KL_KNOWLEDGE_IMPORT_ENABLED: "true",
        FILE_SCAN_ENABLED: "true",
        FILE_STORAGE_ROOT: root,
        CLAMSCAN_PATH: process.env.TEST_CLAMSCAN_PATH,
        CLAMAV_DATABASE: process.env.TEST_CLAMAV_DATABASE,
        SCAN_DATABASE_MAX_AGE_HOURS: "48",
      },
    });
    function diagnostic() {
      const lc = require(process.env.KL_TEST_LIFECYCLE),
        report = lc.reportFailure;
      lc.reportFailure = (component, e) => {
        report(component, e);
        const message =
          typeof e?.message === "string" &&
          /^Cannot read properties of undefined/.test(e.message)
            ? e.message
            : undefined;
        const frames = (e?.stack || "")
          .split(String.fromCharCode(10))
          .slice(1)
          .map((line) =>
            line
              .replaceAll(String.fromCharCode(92), "/")
              .match(
                /[/](dist[/][A-Za-z0-9_./-]+[.]js|node_modules[/]@nestjs[/][A-Za-z0-9_./-]+[.]js):([0-9]+):([0-9]+)/,
              ),
          )
          .filter(Boolean)
          .slice(0, 4)
          .map((m) => ({ file: m[1], line: Number(m[2]) }));
        console.error(
          JSON.stringify({
            event: "isolated.failure",
            type: e?.name,
            message,
            dependency: /resolve dependencies/.test(e?.message || ""),
            provider: e?.message?.match(
              /dependencies of the ([A-Za-z][A-Za-z0-9]{0,70})/,
            )?.[1],
            dependency_index: e?.context?.index,
            dependency_names: e?.context?.dependencies?.map((d) =>
              typeof d === "function"
                ? d.name
                : typeof d === "string" && /^[A-Z][A-Za-z]{1,50}$/.test(d)
                  ? d
                  : "unresolved",
            ),
            circular: /circular dependency/.test(e?.message || ""),
            missing_module: /Cannot find module/.test(e?.message || ""),
            frames,
          }),
        );
      };
    }
    const preload = path.join(root, "diagnostic.cjs");
    fs.writeFileSync(preload, "(" + diagnostic.toString() + ")();");
    let ready;
    const diagnostics = [];
    const child = fork(
      path.resolve(__dirname, "../dist/training/import-worker.js"),
      ["once"],
      {
        windowsHide: true,
        execArgv: ["--require", preload],
        env: {
          ...process.env,
          MONGODB_URI: f.uri,
          KL_PM2_PROTOCOL: "2",
          KL_WRITER_LAUNCH_TOKEN: randomUUID(),
          KL_TEST_LIFECYCLE: path.resolve(
            __dirname,
            "../dist/runtime/process-lifecycle.js",
          ),
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    let stderr = "";
    child.stderr.on("data", (b) => {
      stderr += b;
      for (const line of stderr.split(/\r?\n/)) {
        try {
          const e = JSON.parse(line);
          if (e.event === "isolated.failure") diagnostics.push(e);
        } catch {}
      }
    });
    child.on("message", (m) => {
      if (m?.data?.event === "kl-ready") ready = m.data;
    });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        for (const item of diagnostics) t.diagnostic(JSON.stringify(item));
        reject(Error("IMPORT_ENTRY_EXIT_TIMEOUT"));
      }, 15000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      child.once("error", reject);
    });
    for (const item of diagnostics) t.diagnostic(JSON.stringify(item));
    assert.equal(code, 0);
    assert.equal(ready?.writerTokens?.length, 2);
    assert.equal(
      await f.db
        .collection("operational_writers")
        .countDocuments({ state: "running" }),
      0,
    );
  },
);
