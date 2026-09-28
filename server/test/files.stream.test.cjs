"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, readFile, readdir } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { Readable } = require("node:stream");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { receive } = require("../dist/files/stream");

test("真实上传流完成、完整性失败与断流均释放句柄并清理临时文件", { timeout: 30000 }, async t => {
  const previous = process.env.FILE_STORAGE_ROOT;
  const root = await mkdtemp(join(process.env.TEST_FILE_STORAGE_PARENT || tmpdir(), "kl-stream-"));
  t.after(async () => { if (previous === undefined) delete process.env.FILE_STORAGE_ROOT; else process.env.FILE_STORAGE_ROOT = previous; await rm(root, { recursive: true, force: true }); });
  process.env.FILE_STORAGE_ROOT = root;
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:KL_STREAM_ROOT -AclObject $acl`;
    await promisify(execFile)(join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env: { ...process.env, KL_STREAM_ROOT: root } });
  }
  const bytes = Buffer.from("原创文件流验收正文\n");
  const declaration = { declared_size: bytes.length, declared_mime: "text/plain", declared_checksum: createHash("sha256").update(bytes).digest("hex") };
  const key = randomUUID();
  const result = await receive(Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]), declaration, key);
  assert.equal(result.checksum, declaration.declared_checksum);
  assert.deepEqual(await readFile(join(root, "quarantine", key)), bytes);
  assert.deepEqual(await readdir(join(root, "tmp")), []);
  await assert.rejects(receive(Readable.from([bytes]), { ...declaration, declared_checksum: "0".repeat(64) }, randomUUID()), e => e.getResponse().code === "FILE_INTEGRITY_MISMATCH");
  await assert.rejects(receive(Readable.from([bytes]), { ...declaration, declared_mime: "application/pdf" }, randomUUID()), e => e.getResponse().code === "FILE_TYPE_MISMATCH");
  await assert.rejects(receive(Readable.from((async function* () { yield bytes.subarray(0, 4); throw new Error("transport disconnected"); })()), declaration, randomUUID()), /transport disconnected/);
  assert.deepEqual(await readdir(join(root, "tmp")), []);
  assert.deepEqual(await readdir(join(root, "quarantine")), [key]);
  // Removing the output immediately also checks that no live stream retains its fd on Windows.
  await rm(join(root, "quarantine", key));
});
