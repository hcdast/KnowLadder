"use strict";
const assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  { execFile } = require("node:child_process"),
  { promisify } = require("node:util");
const { createS3Fixture } = require("./s3-fixture.cjs");
const config = require("../../dist/files/config");
async function setup(t) {
  const saved = { ...process.env },
    f = await createS3Fixture(),
    root = await fs.mkdtemp(path.join(os.homedir(), "kl-s3-test-"));
  await protect(root);
  Object.assign(process.env, {
    FILE_STORAGE_DRIVER: "s3",
    FILE_SPOOL_ROOT: root,
    S3_ENDPOINT: f.endpoint,
    S3_BUCKET: "test-bucket",
    S3_PREFIX: "isolated",
    S3_REGION: "us-east-1",
    S3_FORCE_PATH_STYLE: "true",
    S3_ACCESS_KEY_ID: f.access,
    S3_SECRET_ACCESS_KEY: f.secret,
    S3_CA_BUNDLE: f.ca,
  });
  delete process.env.FILE_STORAGE_ROOT;
  await config.storageRoot();
  t.after(async () => {
    await f.close();
    assert.ok(
      path.resolve(root).startsWith(path.join(os.homedir(), "kl-s3-test-")),
    );
    await fs.rm(root, { recursive: true, force: true });
    for (const k of Object.keys(process.env))
      if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  return { ...f, root };
}

async function protect(root) {
  if (process.platform === "win32") {
    const ps = `$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')));Set-Acl -LiteralPath $env:KL_S3_TEST_ROOT -AclObject $acl`;
    await promisify(execFile)(
      path.join(
        process.env.SystemRoot,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(ps, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        env: {
          ...process.env,
          PSModulePath: path.join(
            process.env.SystemRoot,
            "System32/WindowsPowerShell/v1.0/Modules",
          ),
          KL_S3_TEST_ROOT: root,
        },
      },
    );
  }
}
module.exports = { setup, protect };
