"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { fixture } = require("./helpers.cjs"),
  { setup, protect } = require("./fixtures/s3-setup.cjs"),
  storage = require("../dist/files/storage"),
  control = require("../dist/operations/control");
const api = require("../../ops/system-backup.cjs"),
  archive = require("../../ops/system-backup-archive.cjs");
test(
  "S3全业务加密备份与离线恢复隔离，不把恢复写入在线桶",
  { timeout: 180000 },
  async (t) => {
    const f = await fixture(t, {
        app: false,
        env: { FILE_SCAN_ENABLED: "false" },
      }),
      remote = await setup(t),
      environment = crypto.randomUUID(),
      controlName = "kl_control_s3_" + environment.replaceAll("-", "");
    const primary = path.join(remote.root, "ledger"),
      mirror = path.join(remote.root, "mirror");
    for (const p of [primary, mirror]) {
      await fs.mkdir(p, { mode: 0o700 });
      await protect(p);
    }
    Object.assign(process.env, {
      KL_ENVIRONMENT_ID: environment,
      KL_CONTROL_MONGODB_URI: f.uri.replace(
        /\/kl_test_[^?]+/,
        "/" + controlName,
      ),
      KL_SAFETY_LEDGER_ROOT: primary,
      KL_SAFETY_LEDGER_MIRROR_ROOT: mirror,
      KL_SAFETY_LEDGER_KEY: crypto.randomBytes(32).toString("hex"),
    });
    t.after(() => dropDatabase(f.uri, controlName));
    // S3 read preflight still runs when new scanning is disabled.
    const beforePreflight = remote.requests.length;
    const preflight =
      await require("../../ops/backend-preflight.cjs").preflight();
    assert.equal(preflight.ok, true, JSON.stringify(preflight));
    const preflightRequests = remote.requests.slice(beforePreflight);
    assert.ok(preflightRequests.some((r) => r.method === "HEAD"));
    assert.ok(
      preflightRequests.every((r) => ["HEAD", "GET"].includes(r.method)),
    );

    await control.registerEnvironment(f.client, f.db, {
      environmentId: environment,
      fileRoot: null,
      actor: "s3-backup-test",
      reason: "原创隔离材料",
    });
    const gate = await control.enterMaintenance(f.client, f.db, {
      actor: "s3-backup-test",
      reason: "全写进程停止",
      expectedRevision: (
        await f.db
          .collection("operational_state")
          .findOne({ _id: "environment" })
      ).revision,
    });
    const key = crypto.randomUUID(),
      bytes = Buffer.from("Original isolated encrypted archive material\n");
    await storage.putStorageBytes("quarantine", key, bytes);
    const file = path.join(remote.root, "system.klb"),
      secret = crypto.randomBytes(32),
      result = await api.backup({
        client: f.client,
        db: f.db,
        file,
        key: secret,
        root: remote.root,
        maintenanceToken: gate.token,
      });
    assert.equal(result.registered, true);
    assert.equal(result.files, 1);
    const handle = await archive.openFile(file);
    const plaintext = [];
    let proof;
    try {
      proof = await api.authenticate(
        handle,
        secret,
        undefined,
        async (_record, chunk) => plaintext.push(chunk),
      );
    } finally {
      await handle.close();
    }
    assert.deepEqual(Buffer.concat(plaintext), bytes);
    assert.equal(
      proof.manifest.source_root_hash,
      archive.hash(storage.storageIdentity()),
    );
    const target = path.join(remote.root, "offline");
    await fs.mkdir(target, { mode: 0o700 });
    await protect(target);
    const restoreName = "kl_restore_s3_" + environment.replaceAll("-", "");
    t.after(() => dropDatabase(f.uri, restoreName));
    const requests = remote.requests.length;
    const restored = await api.restore({
      client: f.client,
      db: f.client.db(restoreName),
      file,
      key: secret,
      root: target,
    });
    assert.equal(restored.status, "quarantined");
    assert.deepEqual(
      await fs.readFile(path.join(target, "quarantine", key)),
      bytes,
    );
    assert.equal(remote.requests.length, requests, "离线恢复不访问/修改在线S3");
    assert.equal(
      (
        await require("../dist/database/object-id")
          .objectIdDatabase(f.client.db(restoreName))
          .collection("operational_state")
          .findOne({ _id: "environment" })
      ).mode,
      "restore_quarantined",
    );
  },
);

async function dropDatabase(uri, name) {
  assert.match(name, /^kl_(control|restore)_s3_[a-f0-9]+$/);
  const client = new (require("mongodb").MongoClient)(uri);
  try {
    await client.connect();
    await client.db(name).dropDatabase();
  } finally {
    await client.close();
  }
}
