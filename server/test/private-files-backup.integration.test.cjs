"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const { randomUUID, randomBytes } = require("node:crypto"),
  { execFile } = require("node:child_process"),
  { promisify } = require("node:util");
const { fixture } = require("./helpers.cjs");
const api = require("../../ops/private-files-backup.cjs");
async function protect(root) {
  await fs.chmod(root, 0o700);
  if (process.platform === "win32") {
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
      {
        windowsHide: true,
        env: { ...process.env, KL_TEST_PRIVATE_ROOT: root },
      },
    );
  }
}
async function directory(root, name) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { mode: 0o700 });
  await protect(dir);
  return dir;
}
test("私有文件独立加密备份：字节保全、无数据库恢复、篡改与硬链接拒绝、仅隔离解包", async (t) => {
  const f = await fixture(t, { app: false });
  const root = await fs.mkdtemp(path.join(os.homedir(), "kl-private-files-"));
  await protect(root);
  t.after(async () => {
    assert.ok(root.startsWith(path.join(os.homedir(), "kl-private-files-")));
    await fs.rm(root, { recursive: true, force: true });
  });
  const source = await directory(root, "source"),
    target = await directory(root, "offline-target");
  const contents = new Map();
  for (const area of ["tmp", "quarantine", "ready"]) {
    await directory(source, area);
    const name = randomUUID(),
      bytes = area === "tmp" ? Buffer.alloc(0) : randomBytes(1024 * 1024 + 7);
    await fs.writeFile(path.join(source, area, name), bytes, {
      flag: "wx",
      mode: 0o600,
    });
    contents.set(area + "/" + name, bytes);
  }
  const file = path.join(root, "files.klb"),
    key = randomBytes(32);
  const before = await f.db
    .collection("schema_migrations")
    .find({})
    .sort({ version: 1 })
    .toArray();
  const report = await api.backup({
    db: f.db,
    root: source,
    file,
    key,
    atlasSnapshotId: "0123456789abcdef01234567",
  });
  assert.equal(report.file_count, 3);
  assert.equal(report.database_backed_up, false);
  assert.equal(report.atlas_snapshot_verified, false);
  assert.equal(report.atlas_snapshot_linked, true);
  assert.deepEqual(await api.inspect({ file, key }), report);
  await assert.rejects(api.inspect({ file, key: randomBytes(32) }));
  await assert.rejects(
    api.backup({ db: f.db, root: source, file, key }),
    /BACKUP_ALREADY_EXISTS/,
  );
  const encrypted = await fs.readFile(file);
  const changed = Buffer.from(encrypted);
  changed[Math.floor(changed.length / 2)] ^= 1;
  const corrupt = path.join(root, "corrupt.klb");
  await fs.writeFile(corrupt, changed, { mode: 0o600 });
  await assert.rejects(
    api.stage({ file: corrupt, key, target, storageRoot: source }),
  );
  assert.deepEqual(await fs.readdir(target), []);
  const truncated = path.join(root, "truncated.klb");
  await fs.writeFile(truncated, encrypted.subarray(0, -1), { mode: 0o600 });
  await assert.rejects(api.inspect({ file: truncated, key }));
  await assert.rejects(
    api.stage({ file, key, target: source, storageRoot: source }),
  );
  const staged = await api.stage({ file, key, target, storageRoot: source });
  assert.equal(staged.delivery_enabled, false);
  assert.equal(staged.requires_rescan, true);
  assert.equal(staged.requires_database_reconciliation, true);
  for (const [name, bytes] of contents)
    assert.deepEqual(await fs.readFile(path.join(target, name)), bytes);
  await assert.rejects(
    api.stage({ file, key, target, storageRoot: source }),
    /RESTORE_TARGET_NOT_EMPTY/,
  );
  assert.deepEqual(
    await f.db
      .collection("schema_migrations")
      .find({})
      .sort({ version: 1 })
      .toArray(),
    before,
  );
  const link = path.join(source, "ready", randomUUID());
  await fs.link(path.join(source, [...contents.keys()][1]), link);
  await assert.rejects(
    api.backup({
      db: f.db,
      root: source,
      file: path.join(root, "unsafe.klb"),
      key,
    }),
    /UNSAFE_FILE/,
  );
  await fs.unlink(link);
});
