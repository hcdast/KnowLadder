"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { fixture, guardedUri } = require("./helpers.cjs");
const { migrateVersion1, migrateVersion2, migrateVersion3, inspectMigration, assertSchema } = require("../dist/migrations/schema.js");
const { setCapability, createOrganization, createUser, setMembership } = require("../dist/cli/admin-operations.js");

async function legacyQuestion(db) {
  const now = new Date();
  const org = randomUUID(), subject = randomUUID(), root = randomUUID(), author = randomUUID();
  await db.collection("organizations").insertOne({ _id: org, name: "迁移原创测试", kind: "school", status: "active", created_at: now, updated_at: now });
  await db.collection("subjects").insertOne({ _id: subject, code: "migration", name: "原创科目", created_at: now, updated_at: now });
  await db.collection("questions").insertOne({ _id: root, org_id: org, next_version_no: 2, created_at: now, updated_at: now });
  const question = { _id: randomUUID(), org_id: org, question_id: root, version_no: 1, subject_id: subject,
    title: "原创旧题", status: "published", revision: 4, created_by: author, contributors: [author],
    created_at: now, updated_at: now, submitted_by: author, submitted_at: now, published_by: randomUUID(), published_at: now,
    source_version_id: null, license: { source: "原创迁移验证", granted: true, expires_at: null }, resource_ids: [], notes: "",
    question_type: "numeric", prompt: "一加一", options: [], answer: "2", explanation: "原创说明", knowledge_point_ids: [], difficulty: "基础" };
  await db.collection("question_versions").insertOne(question);
  return question;
}

test("v3安全升级、只读统计及独立能力", { concurrency: false, timeout: 180000 }, async t => {
  guardedUri(process.env.TEST_MONGODB_URI);
  await t.test("v1可升级且历史marker不变", async t => {
    const f = await fixture(t, { migrated: false, app: false });
    await migrateVersion1(f.uri);
    const original = await f.db.collection("schema_migrations").findOne({ version: 1 });
    await f.migrate(f.uri);
    assert.deepEqual(await f.db.collection("schema_migrations").findOne({ version: 1 }), original);
    await assertSchema(f.db);
  });
  await t.test("v2旧题不编造规则，默认值安全且重复迁移保留决策", async t => {
    const f = await fixture(t, { migrated: false, app: false });
    await migrateVersion2(f.uri);
    const question = await legacyQuestion(f.db);
    const fileId = randomUUID(), uploadKey = randomUUID(), now = new Date();
    await f.db.collection("file_resources").insertOne({ _id: fileId, org_id: question.org_id, owner_type: "question", owner_version_id: question._id,
      created_by: question.created_by, display_name: "original.txt", storage_key: randomUUID(), declared_size: 1, declared_mime: "text/plain",
      declared_checksum: "0".repeat(64), size: null, mime: null, checksum: null, status: "pending", scan_status: "awaiting_upload",
      scan_attempt: 0, lease_token: null, lease_until: null, available_at: now, uploaded_at: null, error_code: null, created_at: now, updated_at: now });
    // A partially completed upgrade may already have a single upload key, but not its history array.
    await f.db.collection("file_resources").updateOne({ _id: fileId }, { $set: { upload_storage_key: uploadKey } }, { bypassDocumentValidation: true });
    const markers = await f.db.collection("schema_migrations").find().sort({ version: 1 }).toArray();
    const roles = await f.db.collection("roles").find().sort({ _id: 1 }).toArray();
    const report = await inspectMigration(f.uri);
    assert.equal(report.collections.question_versions.needs_defaults, 1);
    assert.equal(report.incomplete_questions, 1);
    assert.equal(report.invalid_references, 0);
    assert.deepEqual(await f.db.collection("question_versions").findOne({ _id: question._id }), question);
    assert.deepEqual(await f.db.collection("schema_migrations").find().sort({ version: 1 }).toArray(), markers);
    await f.migrate(f.uri);
    const migrated = await f.db.collection("question_versions").findOne({ _id: question._id });
    assert.equal(migrated.scoring_rule, null); assert.deepEqual(migrated.knowledge_weights, []); assert.equal(migrated.difficulty_basis, "");
    assert.equal(migrated.revision, 4); assert.equal(migrated.answer, "2"); assert.equal(migrated.status, "published");
    assert.equal(migrated.access_revision, 0);
    const file = await f.db.collection("file_resources").findOne({ _id: fileId });
    assert.equal(file.retention_until, null); assert.equal(file.legal_hold, false); assert.equal(file.deleted_at, null);
    assert.equal(file.deletion_lease_token, null); assert.equal(file.scan_engine_version, null);
    assert.deepEqual(file.upload_storage_keys, [uploadKey]);
    await f.db.collection("question_versions").updateOne({ _id: question._id }, { $set: { access_revision: 1,
      access_revoked_at: new Date(), access_revoked_by: question.created_by, access_revoked_reason: "撤销测试" } });
    const revoked = await f.db.collection("question_versions").findOne({ _id: question._id });
    await f.migrate(f.uri);
    assert.deepEqual(await f.db.collection("question_versions").findOne({ _id: question._id }), revoked);
    assert.deepEqual(await f.db.collection("schema_migrations").find({ version: { $in: [1, 2] } }).sort({ version: 1 }).toArray(), markers);
    assert.deepEqual(await f.db.collection("roles").find().sort({ _id: 1 }).toArray(), roles);
    assert.equal(await f.db.collection("member_capability_grants").countDocuments(), 0);
    await assert.rejects(f.db.collection("question_versions").updateOne({ _id: question._id }, { $set: { access_revision: -1 } }), error => error.code === 121);
    await assertSchema(f.db);
  });
  for (const defect of ["type", "reference"]) await t.test(`异常${defect}在写marker前阻断`, async t => {
    const f = await fixture(t, { migrated: false, app: false });
    await migrateVersion2(f.uri);
    const question = await legacyQuestion(f.db);
    await f.db.collection("question_versions").updateOne({ _id: question._id }, { $set: defect === "type" ? { access_revision: "wrong" } : { question_id: randomUUID() } }, { bypassDocumentValidation: true });
    const before = await f.db.collection("question_versions").findOne({ _id: question._id });
    const markers = await f.db.collection("schema_migrations").find().sort({ version: 1 }).toArray();
    const report = await inspectMigration(f.uri);
    assert.ok(defect === "type" ? report.collections.question_versions.invalid_types : report.invalid_references);
    await assert.rejects(f.migrate(f.uri), /invalid types or references/);
    assert.deepEqual(await f.db.collection("schema_migrations").find().sort({ version: 1 }).toArray(), markers);
    assert.deepEqual(await f.db.collection("question_versions").findOne({ _id: question._id }), before);
  });
  for (const defect of ["subject", "counter"]) await t.test(`异常${defect}引用在写marker前阻断`, async t => {
    const f = await fixture(t, { migrated: false, app: false }); await migrateVersion2(f.uri);
    const question = await legacyQuestion(f.db);
    if (defect === "subject") {
      const subject = randomUUID(), point = randomUUID(), now = new Date();
      await f.db.collection("subjects").insertOne({ _id: subject, code: "other", name: "另一原创科目", created_at: now, updated_at: now });
      await f.db.collection("knowledge_points").insertOne({ _id: point, code: "other", name: "另一学科知识点", subject_id: subject, created_at: now, updated_at: now });
      await f.db.collection("question_versions").updateOne({ _id: question._id }, { $set: { knowledge_point_ids: [point] } });
    } else await f.db.collection("questions").updateOne({ _id: question.question_id }, { $set: { next_version_no: question.version_no } });
    const before = await f.db.collection("question_versions").findOne({ _id: question._id });
    const markers = await f.db.collection("schema_migrations").find().sort({ version: 1 }).toArray();
    const report = await inspectMigration(f.uri);
    assert.ok(defect === "subject" ? report.invalid_references : report.collections.questions.invalid_types);
    await assert.rejects(f.migrate(f.uri), /invalid types or references/);
    assert.deepEqual(await f.db.collection("schema_migrations").find().sort({ version: 1 }).toArray(), markers);
    assert.deepEqual(await f.db.collection("question_versions").findOne({ _id: question._id }), before);
  });
  await t.test("validator已升级但新增索引未完成仍可恢复", async t => {
    const f = await fixture(t, { migrated: false, app: false });
    await migrateVersion3(f.uri);
    await f.db.collection("schema_migrations").updateOne({ version: 3 }, { $set: {
      status: "failed", completed_at: null, failed_at: new Date(), lease_token: null, lease_until: null,
    } });
    await f.db.collection("audit_events").dropIndex("audit_events_owner_page");
    await f.migrate(f.uri);
    await assertSchema(f.db);
    assert.equal((await f.db.collection("schema_migrations").findOne({ version: 3 })).status, "completed");
  });
  await t.test("受控能力CAS、审计、角色变更清除", async t => {
    const f = await fixture(t, { app: false });
    const ctx = { client: f.client, db: f.db, actor: "migration-test", reason: "原创能力验证" };
    const org = await createOrganization(ctx, { name: "原创能力组织", kind: "school" });
    const user = await createUser(ctx, { login_name: "capability_test", display_name: "测试人" });
    const member = await setMembership(ctx, { user_id: user.user_id, org_id: org.organization_id, roles: ["content_editor"] });
    const input = { member_id: member.member_id, org_id: org.organization_id, capability: "content:revoke", granted: true, expected_revision: member.authorization_revision };
    const granted = await setCapability(ctx, input);
    assert.equal(await f.db.collection("member_capability_grants").countDocuments(), 1);
    await assert.rejects(setCapability(ctx, input), error => error.code === "REVISION_CONFLICT");
    const event = await f.db.collection("audit_events").findOne({ action: "capability.grant.content:revoke" });
    assert.equal(event.access_revision_before, input.expected_revision);
    assert.equal(event.access_revision_after, granted.authorization_revision);
    await setMembership(ctx, { user_id: user.user_id, org_id: org.organization_id, roles: ["content_editor"], expected_revision: granted.authorization_revision });
    assert.equal(await f.db.collection("member_capability_grants").countDocuments(), 0);
  });
});
