"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { randomUUID, createHash } = require("node:crypto");
const { fixture } = require("./helpers.cjs"),
  { setup: s3Setup } = require("./fixtures/s3-setup.cjs");
const {
    processOne,
    processDeletion,
    reconcile,
  } = require("../dist/files/worker"),
  { storageRoot } = require("../dist/files/config"),
  { bootstrapOperations } = require("../dist/operations/control"),
  { newId } = require("../dist/database/object-id");
const storage = require("../dist/files/storage");
async function setup(t) {
  const f = await fixture(t, { migrated: false, app: false });
  const remote = await s3Setup(t);
  const root = remote.root;
  f.remote = remote;
  await bootstrapOperations(f.db);
  const {
    ADMINISTRATION_V9_SCHEMAS,
  } = require("../dist/migrations/administration-v9.js");
  await f.db.createCollection("administration_guard", {
    validator: ADMINISTRATION_V9_SCHEMAS.administration_guard.validator,
    validationLevel: "strict",
    validationAction: "error",
  });
  await f.db.collection("administration_guard").insertOne({
    _id: "administration",
    revision: 1,
    state: "idle",
    operation_id: null,
    recovery_token: null,
    blocked_targets: {
      user_ids: [],
      member_ids: [],
      org_ids: [],
      global: false,
    },
    affected_orgs: [],
    updated_at: new Date(),
  });
  for (const name of [
    "file_resources",
    "textbook_editions",
    "textbooks",
    "education_stages",
    "subjects",
    "learning_scope_states",
    "question_versions",
    "chapters",
    "audit_events",
  ])
    await f.db.createCollection(name);
  await f.db
    .collection("learning_scope_states")
    .createIndex({ org_id: 1, subject_id: 1 }, { unique: true });
  await storageRoot();
  f.root = root;
  f.files = f.db.collection("file_resources");
  const now = new Date(),
    author = newId(),
    org = newId();
  const stage = newId(),
    subject = newId(),
    textbook = newId();
  await f.db.collection("education_stages").insertOne({
    _id: stage,
    code: "file-worker-stage",
    name: "文件验收学段",
    created_at: now,
    updated_at: now,
  });
  await f.db.collection("subjects").insertOne({
    _id: subject,
    code: "file-worker-subject",
    name: "文件验收学科",
    created_at: now,
    updated_at: now,
  });
  await f.db.collection("textbooks").insertOne({
    _id: textbook,
    org_id: org,
    title: "文件清理原创教材",
    stage_id: stage,
    subject_id: subject,
    source: "worker行为测试自有材料",
    created_at: now,
    updated_at: now,
  });
  f.owner = {
    _id: newId(),
    org_id: org,
    textbook_id: textbook,
    edition_code: "cleanup-test",
    title: "文件清理原创版本",
    revision: 4,
    access_revision: 0,
    status: "draft",
    resource_ids: [],
    access_revoked_at: null,
    access_revoked_by: null,
    access_revoked_reason: null,
    retired_at: null,
    retired_by: null,
    retired_reason: null,
    created_by: author,
    contributors: [author],
    created_at: now,
    updated_at: now,
    submitted_by: null,
    submitted_at: null,
    published_by: null,
    published_at: null,
    source_version_id: null,
    notes: "",
    license: {
      source: "worker行为测试自有材料",
      granted: true,
      expires_at: null,
    },
  };
  await f.db.collection("textbook_editions").insertOne(f.owner);
  f.file = async (changes = {}) => {
    const past = new Date(Date.now() - 60000);
    const bytes = Buffer.from("实际清理测试文件\n");
    const row = {
      _id: newId(),
      org_id: f.owner.org_id,
      owner_type: "textbook",
      owner_version_id: f.owner._id,
      created_by: newId(),
      display_name: "worker.txt",
      storage_key: randomUUID(),
      declared_size: bytes.length,
      declared_mime: "text/plain",
      declared_checksum: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      mime: "text/plain",
      checksum: createHash("sha256").update(bytes).digest("hex"),
      status: "pending",
      scan_status: "awaiting_upload",
      scan_attempt: 0,
      lease_token: null,
      lease_until: null,
      available_at: past,
      uploaded_at: null,
      error_code: null,
      created_at: past,
      updated_at: past,
      retention_until: past,
      legal_hold: false,
      deletion_requested_at: past,
      deletion_requested_by: newId(),
      deletion_requested_reason: "清理测试自有文件",
      deleted_at: null,
      deletion_lease_token: null,
      deletion_lease_until: null,
      deletion_attempt: 0,
      upload_key: null,
      upload_lease_token: null,
      upload_lease_until: null,
      upload_storage_key: null,
      upload_storage_keys: [],
      upload_owner_revision: null,
      upload_result_revision: null,
      scan_engine_version: null,
      scan_database_version: null,
      scan_database_updated_at: null,
      scanned_at: null,
      ...changes,
    };
    await f.files.insertOne(row);
    return row;
  };
  return f;
}

test(
  "S3 worker真实Mongo删除和中断恢复",
  { concurrency: false, timeout: 180000 },
  async (t) => {
    const f = await setup(t);
    const bytes = Buffer.from("实际清理测试文件\n");

    await t.test("真实ClamAV扫描S3隔离字节，经Mongo确认才ready", async () => {
      assert.ok(
        process.env.TEST_CLAMSCAN_PATH &&
          process.env.TEST_CLAMAV_DATABASE &&
          process.env.TEST_SCAN_DATABASE_MAX_AGE_HOURS,
        "需要显式提供真实官方扫描引擎及签名库",
      );
      const saved = {
        FILE_SCAN_ENABLED: process.env.FILE_SCAN_ENABLED,
        CLAMSCAN_PATH: process.env.CLAMSCAN_PATH,
        CLAMAV_DATABASE: process.env.CLAMAV_DATABASE,
        SCAN_DATABASE_MAX_AGE_HOURS: process.env.SCAN_DATABASE_MAX_AGE_HOURS,
      };
      Object.assign(process.env, {
        FILE_SCAN_ENABLED: "true",
        CLAMSCAN_PATH: process.env.TEST_CLAMSCAN_PATH,
        CLAMAV_DATABASE: process.env.TEST_CLAMAV_DATABASE,
        SCAN_DATABASE_MAX_AGE_HOURS:
          process.env.TEST_SCAN_DATABASE_MAX_AGE_HOURS,
      });
      try {
        const row = await f.file({
          status: "quarantined",
          scan_status: "queued",
          deletion_requested_at: null,
        });
        await storage.putStorageBytes("quarantine", row.storage_key, bytes);
        assert.equal(await processOne(f.db), true);
        const clean = await f.files.findOne({ _id: row._id });
        assert.equal(clean.status, "ready");
        assert.equal(clean.scan_status, "clean");
        assert.ok(clean.scanned_at instanceof Date);
        assert.ok(clean.scan_engine_version);
        assert.deepEqual(
          await storage.readStorageBytes("ready", row.storage_key),
          bytes,
        );
        assert.equal(
          await f.db
            .collection("audit_events")
            .countDocuments({
              resource_id: row._id,
              action: "file.scan.clean",
            }),
          1,
        );
        for (const area of storage.STORAGE_AREAS)
          await storage.deleteStorageObject(area, row.storage_key);
        await f.files.deleteOne({ _id: row._id });
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });
    await t.test(
      "403不等于物理删除，恢复后清除各区域与上传遗留键并保留墓碑审计",
      async () => {
        const row = await f.file({ upload_storage_keys: [randomUUID()] });
        for (const area of storage.STORAGE_AREAS) {
          await storage.putStorageBytes(area, row.storage_key, bytes);
          await storage.putStorageBytes(
            area,
            row.upload_storage_keys[0],
            bytes,
          );
        }
        f.remote.modes.deny = true;
        try {
          assert.equal(await processDeletion(f.db), true);
        } finally {
          f.remote.modes.deny = false;
        }
        const failed = await f.files.findOne({ _id: row._id });
        assert.equal(failed.deleted_at, null);
        assert.equal(failed.error_code, "FILE_DELETE_FAILED");
        assert.equal(f.remote.objects.size, 6);
        await f.files.updateOne(
          { _id: row._id },
          { $set: { available_at: new Date(0) } },
        );
        assert.equal(await processDeletion(f.db), true);
        const deleted = await f.files.findOne({ _id: row._id });
        assert.ok(deleted.deleted_at instanceof Date);
        assert.equal(f.remote.objects.size, 0);
        assert.equal(
          await f.db.collection("audit_events").countDocuments({
            resource_id: row._id,
            action: "file.deletion.completed",
          }),
          1,
        );
      },
    );
    await t.test(
      "法律保全禁止云端删字节；发布中断重新排队而非假定扫描通过",
      async () => {
        const held = await f.file({ legal_hold: true });
        await storage.putStorageBytes("ready", held.storage_key, bytes);
        assert.equal(await processDeletion(f.db), false);
        assert.deepEqual(
          await storage.readStorageBytes("ready", held.storage_key),
          bytes,
        );
        const interrupted = await f.file({
          status: "quarantined",
          scan_status: "scanning",
          scan_attempt: 1,
          lease_token: randomUUID(),
          lease_until: new Date(0),
          deletion_requested_at: null,
        });
        await storage.putStorageBytes("ready", interrupted.storage_key, bytes);
        await reconcile(f.db);
        const pending = await f.files.findOne({ _id: interrupted._id });
        assert.equal(pending.status, "quarantined");
        assert.equal(pending.scan_status, "queued");
        assert.equal(pending.error_code, "SCAN_INTERRUPTED");
        assert.deepEqual(
          await storage.readStorageBytes("quarantine", interrupted.storage_key),
          bytes,
        );
        assert.equal(
          await f.db.collection("audit_events").countDocuments({
            resource_id: interrupted._id,
            action: "file.scan.clean",
          }),
          0,
        );
      },
    );
    await t.test(
      "完整分页清理24小时外孤儿，保留登记键和其他应用前缀",
      async () => {
        const orphan = randomUUID(),
          other = randomUUID(),
          old = new Date(Date.now() - 90000000);
        f.remote.objects.set("isolated/quarantine/" + orphan, {
          bytes,
          modified: old,
        });
        f.remote.objects.set("other-app/ready/" + other, {
          bytes,
          modified: old,
        });
        const result = await reconcile(f.db);
        assert.equal(result.removed, 1);
        assert.equal(
          f.remote.objects.has("isolated/quarantine/" + orphan),
          false,
        );
        assert.equal(f.remote.objects.has("other-app/ready/" + other), true);
      },
    );
  },
);
