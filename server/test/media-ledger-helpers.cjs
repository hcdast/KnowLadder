"use strict";
const assert=require("node:assert/strict");const {randomUUID}=require("node:crypto");
async function setupCourseworkLedger(t) {
  const { mkdtemp, mkdir, rm, realpath } = require("node:fs/promises");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const { MongoClient } = require("mongodb");
  const { randomBytes } = require("node:crypto");
  const { guardedUri } = require("./helpers.cjs");
  const exec = require("node:util").promisify(
    require("node:child_process").execFile,
  );
  const source = guardedUri(process.env.TEST_MONGODB_URI);
  const controlName = `kl_control_privacy_${randomUUID().replaceAll("-", "")}`;
  const controlUri = source.replace(
    /(mongodb(?:\+srv)?:\/\/[^/]+\/)[^?]+/,
    `$1${controlName}`,
  );
  const parent = await realpath(
    process.env.TEST_FILE_STORAGE_PARENT || tmpdir(),
  );
  const root = await mkdtemp(join(parent, "knowladder-privacy-ledger-"));
  const primary = join(root, "primary"),
    mirror = join(root, "mirror");
  const control = new MongoClient(controlUri, {
    serverSelectionTimeoutMS: 5000,
  });
  let connected = false;
  t.after(async () => {
    try {
      if (connected) {
        assert.equal(control.db().databaseName, controlName);
        assert.match(controlName, /^kl_control_privacy_[a-f0-9]{32}$/);
        await control.db().dropDatabase();
      }
    } finally {
      await control.close();
      assert.equal(require("node:path").dirname(require("node:path").resolve(root)), parent);
      assert.ok(require("node:path").basename(root).startsWith("knowladder-privacy-ledger-"));
      await rm(root, { recursive: true, force: true });
    }
  });
  await mkdir(primary, { mode: 0o700 });
  await mkdir(mirror, { mode: 0o700 });
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($path in @($env:KL_TEST_PRIVATE_ROOT,$env:KL_TEST_PRIVATE_PRIMARY,$env:KL_TEST_PRIVATE_MIRROR)) {
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
}`;
    await exec(
      join(
        process.env.SystemRoot || "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        env: {
          ...process.env,
          KL_TEST_PRIVATE_ROOT: root,
          KL_TEST_PRIVATE_PRIMARY: primary,
          KL_TEST_PRIVATE_MIRROR: mirror,
        },
        windowsHide: true,
        timeout: 10000,
      },
    );
    const {
      assertWindowsPrivateDirectory,
    } = require("../dist/security/private-directory.js");
    await assertWindowsPrivateDirectory(primary);
    await assertWindowsPrivateDirectory(mirror);
  }
  await control.connect();
  connected = true;
  assert.ok(
    (await control.db("admin").command({ hello: 1 })).setName,
    "control 必须是真实副本集",
  );
  return {
    KL_ENVIRONMENT_ID: randomUUID(),
    KL_CONTROL_MONGODB_URI: controlUri,
    KL_SAFETY_LEDGER_ROOT: primary,
    KL_SAFETY_LEDGER_MIRROR_ROOT: mirror,
    KL_SAFETY_LEDGER_KEY: randomBytes(32).toString("hex"),
  };
}
async function courseworkPrivateChild(env, name) {
  const fs = require("node:fs/promises"),
    path = require("node:path");
  const folder = path.join(path.dirname(env.KL_SAFETY_LEDGER_ROOT), name);
  await fs.mkdir(folder, { mode: 0o700 });
  if (process.platform === "win32") {
    const script =
      "$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')));Set-Acl -LiteralPath $env:KL_TEST_FILES_PRIVATE -AclObject $acl";
    await require("node:util").promisify(
      require("node:child_process").execFile,
    )(
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
        env: { ...process.env, KL_TEST_FILES_PRIVATE: folder },
        windowsHide: true,
      },
    );
  }
  return folder;
}

module.exports={setupCourseworkLedger,courseworkPrivateChild};
