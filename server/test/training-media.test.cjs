"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, readFile, readdir } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { Readable } = require("node:stream");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { receive } = require("../dist/files/stream");
test(
  "培训媒体：真实分块落盘仅到隔离区、格式/开关/摘要拒绝",
  { timeout: 60000 },
  async (t) => {
    const previous = {
      root: process.env.FILE_STORAGE_ROOT,
      training: process.env.KL_TRAINING_ENABLED,
    };
    const root = await mkdtemp(
      path.join(
        process.env.TEST_FILE_STORAGE_PARENT || tmpdir(),
        "kl-training-media-",
      ),
    );
    process.env.FILE_STORAGE_ROOT = root;
    process.env.KL_TRAINING_ENABLED = "true";
    t.after(async () => {
      for (const [key, value] of [
        ["FILE_STORAGE_ROOT", previous.root],
        ["KL_TRAINING_ENABLED", previous.training],
      ]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      assert.equal(
        path.dirname(path.resolve(root)),
        path.resolve(process.env.TEST_FILE_STORAGE_PARENT || tmpdir()),
      );
      assert.ok(path.basename(root).startsWith("kl-training-media-"));
      await rm(root, { recursive: true, force: true });
    });
    if (process.platform === "win32") {
      const script = `$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:KL_MEDIA_ROOT -AclObject $acl`;
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
        { windowsHide: true, env: { ...process.env, KL_MEDIA_ROOT: root } },
      );
    }
    const mp4 = Buffer.alloc(64);
    mp4.writeUInt32BE(24, 0);
    mp4.write("ftyp", 4);
    mp4.write("isom", 8);
    mp4.write("mp41", 16);
    mp4.write("isom", 20);
    mp4.writeUInt32BE(40, 24);
    mp4.write("mdat", 28);
    const mp3 = Buffer.alloc(64);
    mp3.write("ID3", 0);
    mp3[3] = 4;
    mp3[10] = 255;
    mp3[11] = 251;
    mp3[12] = 144;
    const declared = (bytes, mime) => ({
      declared_size: bytes.length,
      declared_mime: mime,
      declared_checksum: createHash("sha256").update(bytes).digest("hex"),
    });
    const samples = [[mp4, "video/mp4"], [mp3, "audio/mpeg"]];
    if (process.env.KL_TEST_ORIGINAL_MEDIA_PATH) {
      const expectedPath = path.resolve(__dirname, "../../ops/artifacts/training-validation/revision103-original-video.mp4");
      assert.equal(path.resolve(process.env.KL_TEST_ORIGINAL_MEDIA_PATH), expectedPath);
      const original = await readFile(expectedPath);
      const metadata = JSON.parse(await readFile(expectedPath + ".json", "utf8"));
      assert.equal(createHash("sha256").update(original).digest("hex"), metadata.sha256);
      assert.equal(original.length, metadata.bytes);
      assert.equal(metadata.scan_status, "not_scanned");
      samples.push([original, "video/mp4"]);
    }
    for (const [bytes, mime] of samples) {
      const key = randomUUID();
      await receive(
        Readable.from([bytes.subarray(0, 7), bytes.subarray(7)]),
        declared(bytes, mime),
        key,
      );
      assert.deepEqual(
        await readFile(path.join(root, "quarantine", key)),
        bytes,
      );
      assert.equal((await readdir(path.join(root, "ready"))).length, 0);
      await assert.rejects(
        receive(
          Readable.from([Buffer.alloc(64)]),
          declared(Buffer.alloc(64), mime),
          randomUUID(),
        ),
        (e) => e.getResponse().code === "FILE_TYPE_MISMATCH",
      );
      process.env.KL_TRAINING_ENABLED = "false";
      await assert.rejects(
        receive(Readable.from([bytes]), declared(bytes, mime), randomUUID()),
        (e) => e.getResponse().code === "FILE_TYPE_MISMATCH",
      );
      process.env.KL_TRAINING_ENABLED = "true";
      await assert.rejects(
        receive(
          Readable.from([bytes]),
          { ...declared(bytes, mime), declared_checksum: "0".repeat(64) },
          randomUUID(),
        ),
        (e) => e.getResponse().code === "FILE_INTEGRITY_MISMATCH",
      );
    }
    assert.equal((await readdir(path.join(root, "tmp"))).length, 0);
  },
);
