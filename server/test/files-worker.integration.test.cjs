"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { mkdtemp, rm, mkdir, writeFile, readFile, utimes, lstat } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { fixture, guardedUri } = require("./helpers.cjs");
const { processDeletion, reconcile, usage } = require("../dist/files/worker.js");
const { storageRoot } = require("../dist/files/config.js");
const { bootstrapOperations } = require("../dist/operations/control.js");
const exec = promisify(execFile);

async function setup(t) {
  const root = await mkdtemp(join(process.env.TEST_FILE_STORAGE_PARENT || tmpdir(), "knowladder-worker-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:KL_TEST_PRIVATE_ROOT -AclObject $acl`;
    await exec(join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { env: { ...process.env, KL_TEST_PRIVATE_ROOT: root }, windowsHide: true, timeout: 10000 });
  }
  // These tests exercise real transactions and filesystem failures, not schema migration or
  // malware verdicts. No scanner function is replaced or called by these maintenance paths.
  const f = await fixture(t, { migrated: false, app: false, env: {
    FILE_STORAGE_ROOT: root,
  } });
  // Install the production operational validators/indexes and explicit unregistered state.
  // The deliberately partial domain fixture still exercises malformed references and real I/O.
  await bootstrapOperations(f.db);
  for (const name of ["file_resources", "textbook_editions", "textbooks", "education_stages", "subjects", "learning_scope_states", "question_versions", "chapters", "audit_events"]) await f.db.createCollection(name);
  await f.db.collection("learning_scope_states").createIndex({ org_id: 1, subject_id: 1 }, { unique: true });
  await storageRoot();
  f.root = root;
  f.files = f.db.collection("file_resources");
  const now = new Date(), author = randomUUID(), org = randomUUID();
  const stage = randomUUID(), subject = randomUUID(), textbook = randomUUID();
  await f.db.collection("education_stages").insertOne({ _id: stage, code: "file-worker-stage", name: "文件验收学段", created_at: now, updated_at: now });
  await f.db.collection("subjects").insertOne({ _id: subject, code: "file-worker-subject", name: "文件验收学科", created_at: now, updated_at: now });
  await f.db.collection("textbooks").insertOne({ _id: textbook, org_id: org, title: "文件清理原创教材", stage_id: stage, subject_id: subject, source: "worker行为测试自有材料", created_at: now, updated_at: now });
  f.owner = { _id: randomUUID(), org_id: org, textbook_id: textbook, edition_code: "cleanup-test", title: "文件清理原创版本", revision: 4, access_revision: 0, status: "draft", resource_ids: [], access_revoked_at: null,
    access_revoked_by: null, access_revoked_reason: null, retired_at: null, retired_by: null, retired_reason: null,
    created_by: author, contributors: [author], created_at: now, updated_at: now, submitted_by: null, submitted_at: null,
    published_by: null, published_at: null, source_version_id: null, notes: "",
    license: { source: "worker行为测试自有材料", granted: true, expires_at: null } };
  await f.db.collection("textbook_editions").insertOne(f.owner);
  f.file = async (changes = {}) => {
    const past = new Date(Date.now() - 60000);
    const bytes = Buffer.from("实际清理测试文件\n");
    const row = { _id: randomUUID(), org_id: f.owner.org_id, owner_type: "textbook", owner_version_id: f.owner._id,
      created_by: randomUUID(), display_name: "worker.txt", storage_key: randomUUID(), declared_size: bytes.length, declared_mime: "text/plain",
      declared_checksum: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, mime: "text/plain", checksum: createHash("sha256").update(bytes).digest("hex"),
      status: "pending", scan_status: "awaiting_upload", scan_attempt: 0, lease_token: null, lease_until: null,
      available_at: past, uploaded_at: null, error_code: null, created_at: past, updated_at: past,
      retention_until: past, legal_hold: false, deletion_requested_at: past, deletion_requested_by: randomUUID(), deletion_requested_reason: "清理测试自有文件",
      deleted_at: null, deletion_lease_token: null, deletion_lease_until: null, deletion_attempt: 0,
      upload_key: null, upload_lease_token: null, upload_lease_until: null, upload_storage_key: null, upload_storage_keys: [], upload_owner_revision: null, upload_result_revision: null,
      scan_engine_version: null, scan_database_version: null, scan_database_updated_at: null, scanned_at: null, ...changes };
    await f.files.insertOne(row);
    return row;
  };
  return f;
}

// Run with --test-concurrency=1, matching the repository's environment-mutating fixtures.
// Missing MongoDB infrastructure fails explicitly; it is never silently skipped.
test("文件worker：删除租约、墓碑、保全与孤儿保护", { concurrency: false, timeout: 180000 }, async t => {
  guardedUri(process.env.TEST_MONGODB_URI);

  await t.test("删除失败不写deleted_at，真实I/O恢复后重试保留墓碑与审计", async t => {
    const f = await setup(t);
    const row = await f.file({ upload_storage_key: randomUUID(), upload_storage_keys: [randomUUID()] });
    const blocked = join(f.root, "quarantine", row.storage_key);
    await mkdir(blocked); // unlink(directory) reliably fails, including under privileged test users.
    await writeFile(join(f.root, "tmp", row.upload_storage_key), "待清理临时文件");
    await writeFile(join(f.root, "quarantine", row.upload_storage_keys[0]), "旧上传遗留隔离文件");
    assert.equal(await processDeletion(f.db), true);
    const failed = await f.files.findOne({ _id: row._id });
    assert.equal(failed.status, "deleting");
    assert.equal(failed.deleted_at, null);
    assert.equal(failed.error_code, "FILE_DELETE_FAILED");
    assert.equal(failed.deletion_attempt, 1);
    assert.equal(failed.deletion_lease_token, null);
    assert.ok(failed.available_at > new Date());
    assert.equal(await processDeletion(f.db), false, "退避期间不重复删除");
    assert.equal(await f.db.collection("audit_events").countDocuments({ resource_id: row._id, action: "file.deletion.retry" }), 1);
    await rm(blocked, { recursive: true });
    await f.files.updateOne({ _id: row._id }, { $set: { available_at: new Date(0) } });
    assert.equal(await processDeletion(f.db), true);
    const tombstone = await f.files.findOne({ _id: row._id });
    assert.equal(tombstone.status, "deleting");
    assert.ok(tombstone.deleted_at instanceof Date);
    assert.equal(tombstone.deletion_attempt, 2);
    assert.equal(tombstone.error_code, null);
    await assert.rejects(lstat(join(f.root, "tmp", row.upload_storage_key)), { code: "ENOENT" });
    await assert.rejects(lstat(join(f.root, "quarantine", row.upload_storage_keys[0])), { code: "ENOENT" });
    assert.equal(await processDeletion(f.db), false);
    assert.equal(await f.files.countDocuments({ _id: row._id }), 1, "不移除资源墓碑");
    const events = await f.db.collection("audit_events").find({ resource_id: row._id }).toArray();
    assert.equal(events.filter(event => event.action === "file.deletion.completed").length, 1);
    assert.equal(events.filter(event => event.action === "file.deletion.claim").length, 2);
    for (const event of events) {
      assert.equal(event.owner_version_id, f.owner._id);
      assert.equal(event.resource_type, "file");
      assert.equal(event.revision_before, 4);
      assert.equal(event.revision_after, 4);
      assert.ok(!JSON.stringify(event).includes(f.root), "审计不暴露存储路径");
    }
    assert.equal((await f.db.collection("textbook_editions").findOne({ _id: f.owner._id })).access_revision, 2);
  });

  await t.test("hold、未到期、无显式申请和有效独立租约均禁止删除", async t => {
    const f = await setup(t);
    const future = new Date(Date.now() + 3600000);
    for (const changes of [
      { legal_hold: true }, { retention_until: future }, { retention_until: null }, { deletion_requested_at: null },
      { upload_lease_token: randomUUID(), upload_lease_until: future },
      { lease_token: randomUUID(), lease_until: future, status: "quarantined", scan_status: "scanning" },
      { status: "deleting", deletion_lease_token: randomUUID(), deletion_lease_until: future },
    ]) await f.file(changes);
    assert.equal(await processDeletion(f.db), false);
    assert.equal(await f.files.countDocuments({ deleted_at: { $type: "date" } }), 0);
    assert.equal(await f.db.collection("audit_events").countDocuments(), 0);
    assert.equal((await f.db.collection("textbook_editions").findOne({ _id: f.owner._id })).access_revision, 0);
  });

  await t.test("所有版本和章节引用均阻断删除，包括其他组织及retired记录", async t => {
    const f = await setup(t);
    for (const collection of ["textbook_editions", "question_versions", "chapters"]) {
      const row = await f.file();
      await f.db.collection(collection).insertOne({ _id: randomUUID(), org_id: randomUUID(), status: "retired", resource_ids: [row._id] });
    }
    assert.equal(await processDeletion(f.db), false);
    assert.equal(await f.files.countDocuments({ status: "deleting" }), 0);
  });

  await t.test("中断删除租约到期可重领，两个worker仅一个完成，缺失文件视为成功", async t => {
    const f = await setup(t);
    const row = await f.file({ status: "deleting", deletion_attempt: 1, deletion_lease_token: randomUUID(), deletion_lease_until: new Date(0) });
    const results = await Promise.all([processDeletion(f.db), processDeletion(f.db)]);
    assert.equal(results.filter(Boolean).length, 1);
    const deleted = await f.files.findOne({ _id: row._id });
    assert.equal(deleted.status, "deleting");
    assert.ok(deleted.deleted_at instanceof Date);
    assert.equal(deleted.deletion_attempt, 2);
    assert.equal(await f.db.collection("audit_events").countDocuments({ action: "file.deletion.completed", resource_id: row._id }), 1);
  });

  await t.test("孤儿清理保留登记、有效上传/扫描租约及失败文件，只清理24小时外真正孤儿", async t => {
    const f = await setup(t);
    const future = new Date(Date.now() + 3600000);
    const old = new Date(Date.now() - 48 * 3600000);
    const uploading = await f.file({ upload_storage_key: randomUUID(), upload_storage_keys: [randomUUID()], upload_lease_token: randomUUID(), upload_lease_until: future });
    const scanning = await f.file({ status: "quarantined", scan_status: "scanning", lease_token: randomUUID(), lease_until: future });
    const registered = await f.file();
    const failed = await f.file({ status: "quarantined", scan_status: "failed" });
    const protectedFiles = [
      join(f.root, "tmp", uploading.upload_storage_key), join(f.root, "quarantine", scanning.storage_key),
      join(f.root, "tmp", registered.storage_key), join(f.root, "quarantine", failed.storage_key),
      join(f.root, "quarantine", uploading.upload_storage_keys[0]),
    ];
    for (const filename of protectedFiles) { await writeFile(filename, "保护中的实际文件"); await utimes(filename, old, old); }
    const orphan = join(f.root, "tmp", randomUUID());
    const young = join(f.root, "tmp", randomUUID());
    await writeFile(orphan, "可清理孤儿"); await utimes(orphan, old, old);
    await writeFile(young, "新临时文件");
    const result = await reconcile(f.db);
    assert.equal(result.removed, 1);
    for (const filename of [...protectedFiles, young]) assert.ok((await readFile(filename)).length > 0);
    await assert.rejects(lstat(orphan), { code: "ENOENT" });
    assert.equal((await f.files.findOne({ _id: scanning._id })).lease_token, scanning.lease_token);
    const measured = await usage(f.db);
    assert.equal(measured.areas.tmp.count, 3);
    assert.equal(measured.areas.quarantine.count, 3);
    assert.ok(BigInt(measured.areas.tmp.bytes) > 0n);
    assert.ok(BigInt(measured.disk.total_bytes) > 0n);
    assert.equal(measured.resources.reduce((sum, value) => sum + value.count, 0), 4);
    assert.ok(!JSON.stringify(measured).includes(f.root));
  });
  await t.test("rename后提交中断只重新排队扫描，过期token不得复活文件", async t => {
    const f = await setup(t);
    const bytes = Buffer.from("实际清理测试文件\n");
    const row = await f.file({ status: "quarantined", scan_status: "scanning", scan_attempt: 1,
      lease_token: randomUUID(), lease_until: new Date(Date.now() - 1000), retention_until: null, deletion_requested_at: null });
    // Actual ready-area bytes model a rename that committed before the DB transaction failed.
    await writeFile(join(f.root, "ready", row.storage_key), bytes);
    assert.equal((await reconcile(f.db)).repaired, 1);
    const recovered = await f.files.findOne({ _id: row._id });
    assert.equal(recovered.status, "quarantined");
    assert.equal(recovered.scan_status, "queued");
    assert.equal(recovered.lease_token, null);
    assert.equal(recovered.error_code, "SCAN_INTERRUPTED");
    assert.deepEqual(await readFile(join(f.root, "quarantine", row.storage_key)), bytes);
    await assert.rejects(lstat(join(f.root, "ready", row.storage_key)), { code: "ENOENT" });
    const stale = await f.files.updateOne({ _id: row._id, status: "quarantined", scan_status: "scanning",
      lease_token: row.lease_token, lease_until: { $gt: new Date() } }, { $set: { status: "ready", scan_status: "clean" } });
    assert.equal(stale.modifiedCount, 0);
    assert.equal((await reconcile(f.db)).repaired, 0);
  });

  await t.test("损坏ready与扫描重试耗尽均保持不可交付，活跃扫描不被恢复", async t => {
    const f = await setup(t);
    const bytes = Buffer.from("实际清理测试文件\n");
    const exhausted = await f.file({ status: "quarantined", scan_status: "scanning", scan_attempt: 3,
      lease_token: randomUUID(), lease_until: new Date(Date.now() - 1000) });
    const active = await f.file({ status: "quarantined", scan_status: "scanning", scan_attempt: 1,
      lease_token: randomUUID(), lease_until: new Date(Date.now() + 60000) });
    const damaged = await f.file({ status: "ready", scan_status: "clean" });
    await writeFile(join(f.root, "ready", exhausted.storage_key), bytes);
    await writeFile(join(f.root, "ready", active.storage_key), bytes);
    await writeFile(join(f.root, "ready", damaged.storage_key), "tampered");
    assert.equal((await reconcile(f.db)).repaired, 2);
    assert.equal((await f.files.findOne({ _id: exhausted._id })).scan_status, "failed");
    const protectedRow = await f.files.findOne({ _id: active._id });
    assert.equal(protectedRow.scan_status, "scanning");
    assert.equal(protectedRow.lease_token, active.lease_token);
    assert.deepEqual(await readFile(join(f.root, "ready", active.storage_key)), bytes);
    const corrupt = await f.files.findOne({ _id: damaged._id });
    assert.equal(corrupt.status, "quarantined");
    assert.equal(corrupt.scan_status, "failed");
    assert.equal(corrupt.error_code, "READY_FILE_MISSING_OR_CORRUPT");
  });
});
