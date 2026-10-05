"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join, normalize } = require("node:path");
const { tmpdir, homedir } = require("node:os");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { fileConfig, fileScanEnabled, storageRoot, storagePath, assertUploadCapacity, MAX_FILE_SIZE } = require("../dist/files/config");

test("扫描开关严格解析，关闭时不读取扫描配置或产生成功扫描结果", async (t) => {
  const before = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key]; Object.assign(process.env, before); });
  assert.equal(fileScanEnabled({}), true);
  assert.equal(fileScanEnabled({ FILE_SCAN_ENABLED: "true" }), true);
  assert.equal(fileScanEnabled({ FILE_SCAN_ENABLED: "false" }), false);
  for (const value of ["", "0", "1", "FALSE", "yes", " true "]) {
    assert.throws(() => fileScanEnabled({ FILE_SCAN_ENABLED: value }), /FILE_SCAN_ENABLED/);
  }
  process.env.FILE_SCAN_ENABLED = "false";
  process.env.FILE_STORAGE_ROOT = "";
  process.env.CLAMSCAN_PATH = "invalid-relative-path";
  process.env.CLAMAV_DATABASE = "";
  process.env.SCAN_DATABASE_MAX_AGE_HOURS = "invalid";
  process.env.SCAN_TIMEOUT_MS = "invalid";
  const { assertScanner, scanWithHealth } = require("../dist/files/scanner");
  await assert.rejects(assertScanner(), { message: "FILE_SCAN_DISABLED" });
  await assert.rejects(scanWithHealth("nonexistent-file"), { message: "FILE_SCAN_DISABLED" });
  assert.throws(() => fileConfig(), { message: "FILE_SCAN_DISABLED" });
  process.env.FILE_SCAN_ENABLED = "true";
  assert.throws(() => fileConfig(), /FILE_STORAGE_ROOT/);
  process.env.FILE_SCAN_ENABLED = "invalid";
  await assert.rejects(scanWithHealth("nonexistent-file"), /FILE_SCAN_ENABLED/);
  for (const command of ["run", "once", "reconcile", "cleanup", "usage"]) {
    await assert.rejects(
      promisify(execFile)(process.execPath, [join(__dirname, "../dist/files/worker.js"), command],
        { env: { ...process.env }, timeout: 5000, encoding: "utf8" }),
      error => error.code === 1 && /FILE_SCAN_ENABLED/.test(error.stderr),
    );
  }
});

test("文件配置、磁盘阈值与请求内路径复用安全边界", async (t) => {
  const before = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key]; Object.assign(process.env, before); });
  const parent = await fs.realpath(process.env.TEST_FILE_STORAGE_PARENT || (process.platform === "win32" ? homedir() : tmpdir()));
  const root = await fs.realpath(await fs.mkdtemp(join(parent, "kl-config-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  process.env.FILE_SCAN_ENABLED = "true";
  process.env.FILE_STORAGE_ROOT = root;
  process.env.CLAMSCAN_PATH = process.execPath;
  process.env.CLAMAV_DATABASE = root;
  delete process.env.SCAN_DATABASE_MAX_AGE_HOURS;
  assert.throws(() => fileConfig(), /SCAN_DATABASE_MAX_AGE_HOURS/);
  for (const invalid of ["", "0", "-1", "NaN", "Infinity", "8761"]) {
    process.env.SCAN_DATABASE_MAX_AGE_HOURS = invalid;
    assert.throws(() => fileConfig(), /SCAN_DATABASE_MAX_AGE_HOURS/);
  }
  process.env.SCAN_DATABASE_MAX_AGE_HOURS = "48";
  assert.equal(fileConfig().databaseMaxAgeHours, 48);
  process.env.CLAMSCAN_PATH = process.execPath.replace(/\\/g, "/");
  process.env.CLAMAV_DATABASE = root.replace(/\\/g, "/");
  assert.equal(fileConfig().scanner, normalize(process.execPath));
  assert.equal(fileConfig().database, normalize(root));
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:KL_CONFIG_ROOT -AclObject $acl`;
    await promisify(execFile)(join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { env: { ...process.env, KL_CONFIG_ROOT: root } });
  }
  // Storage reads/cleanup do not require a healthy scanner or freshness policy.
  delete process.env.SCAN_DATABASE_MAX_AGE_HOURS;
  const verified = await storageRoot();
  const key = randomUUID();
  assert.equal(await storagePath("tmp", key, verified), join(root, "tmp", key));
  await assert.rejects(storagePath("tmp", "../escape", verified), /存储标识/);
  await assert.rejects(storagePath("invalid", key, verified), /存储区域/);
  await assert.rejects(storagePath("tmp", key, join(root, "other")), /安全上下文/);
  const capacity = t.mock.method(fs, "statfs", async () => ({ bavail: 110n, bsize: 1n }));
  process.env.FILE_MIN_FREE_BYTES = "100";
  await assertUploadCapacity(10, verified);
  await assert.rejects(assertUploadCapacity(11, verified), /可用空间不足/);
  await assert.rejects(assertUploadCapacity(MAX_FILE_SIZE + 1, verified), /上传大小/);
  process.env.FILE_MIN_FREE_BYTES = "-1";
  await assert.rejects(assertUploadCapacity(1, verified), /FILE_MIN_FREE_BYTES/);
  capacity.mock.restore();
  if (process.platform === "win32") {
    const child = join(root, "quarantine");
    const changeAcl = async (allow) => {
      const script = `$ErrorActionPreference='Stop'
$path=$env:KL_CONFIG_CHILD
$acl=Get-Acl -LiteralPath $path
$sid=New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')
${allow ? '$acl.AddAccessRule($rule)' : '$acl.RemoveAccessRuleSpecific($rule)'}
Set-Acl -LiteralPath $path -AclObject $acl`;
      await promisify(execFile)(join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { env: { ...process.env, KL_CONFIG_CHILD: child } });
    };
    await changeAcl(true);
    try {
      await assert.rejects(storageRoot(), /Windows目录/);
      await assert.rejects(storagePath("quarantine", key, verified), /Windows目录/);
    } finally { await changeAcl(false); }
    assert.equal(await storagePath("quarantine", key, verified), join(root, "quarantine", key));
  } else {
    // No sticky-/tmp exception: test storage itself must have a trusted ancestor chain.
    await fs.chmod(root, 0o1777);
    try {
      await assert.rejects(storageRoot(), /可信用户|禁止组/);
      await assert.rejects(storagePath("tmp", key, verified), /可信用户|禁止组/);
    } finally { await fs.chmod(root, 0o700); }
    await fs.chmod(join(root, "quarantine"), 0o770);
    try { await assert.rejects(storagePath("quarantine", key, verified), /可信用户|禁止组/); }
    finally { await fs.chmod(join(root, "quarantine"), 0o700); }
  }
  // Replacing a child after the root check must not survive request-local reuse.
  await fs.rename(join(root, "tmp"), join(root, "saved-tmp"));
  await fs.symlink(join(root, "ready"), join(root, "tmp"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(storagePath("tmp", key, verified), /符号链接|junction|真实路径|Windows目录/);
});
