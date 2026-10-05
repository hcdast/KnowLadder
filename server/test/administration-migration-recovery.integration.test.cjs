"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { fixture } = require("./helpers.cjs");
const { assessmentFixture } = require("./assessment-helpers.cjs");
const { migrate, migrateVersion8, inspectMigration, assertSchema } = require("../dist/migrations/schema.js");
const { ADMINISTRATION_V9_CHECKSUM } = require("../dist/migrations/administration-v9.js");

for (const topology of ["replicaSet", "standalone"]) {
  test(`IAM ${topology}：v9 已转换旧grant和审核角色但marker未完成可只读预检及正式恢复`, { timeout: 240000 }, async t => {
    const f = await fixture(t, { migrated: false, app: false, topology, env: { FILE_SCAN_ENABLED: "false" } });
    await migrateVersion8(f.uri);
    const now = new Date(), userId = randomUUID(), orgId = randomUUID(), memberId = randomUUID(), grantId = randomUUID(), roleId = randomUUID();
    await f.db.collection("users").insertOne({ _id: userId, login_key: `iam_${userId.replaceAll("-", "")}`, display_name: "IAM v8旧审核员", status: "active", privacy_state: "active", password_hash: await require("../dist/security/password.js").hashPassword(`${randomUUID()}-${randomUUID()}`), credential_version: 1, identity_revision: 1, must_change_password: false, temporary_password_expires_at: null, password_changed_at: now, created_at: now, updated_at: now });
    await f.db.collection("organizations").insertOne({ _id: orgId, name: "IAM 旧权限中断组织", kind: "school", status: "active", created_at: now, updated_at: now });
    await f.db.collection("organization_members").insertOne({ _id: memberId, user_id: userId, org_id: orgId, status: "active", authorization_revision: 1, created_at: now, updated_at: now });
    await f.db.collection("member_roles").insertOne({ _id: roleId, member_id: memberId, org_id: orgId, role_id: "content_reviewer" });
    await f.db.collection("member_capability_grants").insertOne({ _id: grantId, org_id: orgId, member_id: memberId, capability: "assessment:manage" });
    const prior = await f.db.collection("schema_migrations").findOne({ version: 8 });
    await f.db.collection("schema_migrations").insertOne({ ...prior, _id: randomUUID(), version: 9, checksum: ADMINISTRATION_V9_CHECKSUM, status: "running", lease_token: randomUUID(), lease_until: new Date(0), started_at: now, completed_at: null, failed_at: null });
    await f.db.collection("member_capability_grants").updateOne({ _id: grantId }, { $set: { status: "active", revision: 1, valid_from: new Date(0), valid_to: null, operation_id: null, authority: "legacy", created_at: now, updated_at: now } }, { bypassDocumentValidation: true });
    await f.db.collection("member_roles").updateOne({ _id: roleId }, { $set: { status: "active", valid_from: new Date(0), valid_to: null, operation_id: null, approval_id: null, authority: "legacy" } }, { bypassDocumentValidation: true });
    const before = { grant: await f.db.collection("member_capability_grants").findOne({ _id: grantId }), role: await f.db.collection("member_roles").findOne({ _id: roleId }), marker: await f.db.collection("schema_migrations").findOne({ version: 9 }) };
    const impact = await inspectMigration(f.uri);
    assert.equal(impact.invalid_references, 0); assert.equal(impact.invalid_indexes, 0);
    assert.equal(impact.collections.member_capability_grants.invalid_types, 0);
    assert.equal(impact.collections.member_roles.invalid_types, 0);
    assert.deepEqual(await f.db.collection("member_capability_grants").findOne({ _id: grantId }), before.grant);
    assert.deepEqual(await f.db.collection("member_roles").findOne({ _id: roleId }), before.role);
    assert.deepEqual(await f.db.collection("schema_migrations").findOne({ version: 9 }), before.marker);
    await migrate(f.uri); await assertSchema(f.db);
    assert.equal((await f.db.collection("schema_migrations").findOne({ version: 9 })).status, "completed");
    assert.deepEqual(await f.db.collection("member_capability_grants").findOne({ _id: grantId }), before.grant);
    assert.deepEqual(await f.db.collection("member_roles").findOne({ _id: roleId }), before.role);
  });
}

test("IAM v9只读预检识别内容孤儿、缺唯一索引与跨组织行政授权", { timeout: 240000 }, async t => {
  const f = await assessmentFixture(t);
  const snapshot = async () => ({ markers: await f.db.collection("schema_migrations").find().sort({ version: 1 }).toArray(), owners: await f.db.collection("textbook_editions").find().sort({ _id: 1 }).toArray() });
  const clean = await inspectMigration(f.uri);
  assert.equal(clean.invalid_references, 0);
  const book = await f.db.collection("textbook_editions").findOne({ _id: f.book.id });
  await f.db.collection("textbook_editions").updateOne({ _id: book._id }, { $set: { textbook_id: randomUUID() } });
  const orphanBefore = await snapshot(), orphan = await inspectMigration(f.uri);
  assert.ok(orphan.invalid_references > 0);
  assert.deepEqual(await snapshot(), orphanBefore, "孤儿预检不得修复原文或marker");
  await assert.rejects(migrate(f.uri));
  await f.db.collection("textbook_editions").updateOne({ _id: book._id }, { $set: { textbook_id: book.textbook_id } });
  const platform = (await f.ops.createOrganization(f.context, { name: "IAM 孤儿授权平台", kind: "platform" })).organization_id;
  const governor = await f.ops.createUser(f.context, { login_name: `iam_${randomUUID().replaceAll("-", "")}`, display_name: "IAM 治理引用验收" });
  const member = await f.ops.setMembership(f.context, { user_id: governor.user_id, org_id: platform, roles: ["platform_ops"] });
  await f.ops.bootstrapGovernance(f.context, { user_id: governor.user_id, org_id: platform, expected_revision: member.authorization_revision });
  const grant = await f.db.collection("administrative_grants").findOne({ subject_member_id: member.member_id, capability: "platform:govern" });
  await f.db.collection("administrative_grants").updateOne({ _id: grant._id }, { $set: { subject_member_id: randomUUID() } });
  const invalidGrant = await inspectMigration(f.uri);
  assert.ok(invalidGrant.unbound_grants > 0);
  assert.ok(invalidGrant.invalid_references > 0);
  await f.db.collection("administrative_grants").updateOne({ _id: grant._id }, { $set: { subject_member_id: member.member_id } });
  await f.db.collection("administration_operations").dropIndex("administration_operations_actor_key");
  const missing = await inspectMigration(f.uri);
  assert.ok(missing.invalid_indexes > 0);
  await assert.rejects(assertSchema(f.db));
});
