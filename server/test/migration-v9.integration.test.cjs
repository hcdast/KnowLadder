"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { fixture, status } = require("./helpers.cjs");
const { hashPassword } = require("../dist/security/password.js");
const { migrateVersion8, migrate, inspectMigration } = require("../dist/migrations/schema.js");

async function capture(db) {
  const result = {};
  for (const { name, options } of await db.listCollections().toArray()) {
    result[name] = { options, indexes: await db.collection(name).listIndexes().toArray(), rows: await db.collection(name).find().sort({ _id: 1 }).toArray() };
  }
  return result;
}
for (const topology of ["replicaSet", "standalone"]) {
  test(`IAM ${topology}：v8升级保全旧marker与授权，不给存量身份管理权`, { timeout: 240000, concurrency: false }, async t => {
    const f = await fixture(t, { migrated: false, app: false, topology, env: { FILE_SCAN_ENABLED: "false" } });
    await migrateVersion8(f.uri);
    const now = new Date();
    const userId = randomUUID(), memberId = randomUUID(), orgId = randomUUID(), grantId = randomUUID();
    const password = `${randomUUID()}-${randomUUID()}`;
    await f.db.collection("organizations").insertOne({ _id: orgId, name: "IAM v8隔离组织", kind: "school", status: "active", created_at: now, updated_at: now });
    await f.db.collection("users").insertOne({ _id: userId, login_key: "iam_legacy", display_name: "IAM v8隔离用户", status: "active", privacy_state: "active", password_hash: await hashPassword(password), credential_version: 1, identity_revision: 1, must_change_password: false, temporary_password_expires_at: null, password_changed_at: now, created_at: now, updated_at: now });
    await f.db.collection("organization_members").insertOne({ _id: memberId, user_id: userId, org_id: orgId, status: "active", authorization_revision: 1, created_at: now, updated_at: now });
    await f.db.collection("member_roles").insertOne({ _id: randomUUID(), member_id: memberId, org_id: orgId, role_id: "teacher" });
    await f.db.collection("member_capability_grants").insertOne({ _id: grantId, org_id: orgId, member_id: memberId, capability: "assessment:manage" });
    const markers = await f.db.collection("schema_migrations").find().sort({ version: 1 }).toArray();
    const before = await capture(f.db);
    await inspectMigration(f.uri);
    assert.deepEqual(await capture(f.db), before, "v9 inspect 不得写数据、索引或validator");
    await migrate(f.uri);
    assert.deepEqual(await f.db.collection("schema_migrations").find({ version: { $lte: 8 } }).sort({ version: 1 }).toArray(), markers, "旧迁移marker不得改写");
    const grant = await f.db.collection("member_capability_grants").findOne({ _id: grantId });
    assert.equal(grant.status, "active");
    assert.equal(grant.valid_to, null);
    assert.equal(await f.db.collection("administrative_grants").countDocuments(), 0);
    Object.assign(f, await f.start());
    await f.browser.prepare();
    status(await f.browser.login("iam_legacy", password), 200);
    await f.browser.prepare();
    const headers = { "X-Org-Id": orgId };
    status(await f.browser.request("/admin/quizzes", { headers }), 200);
    status(await f.browser.request("/console/users", { headers }), 403);
    const identity = await f.browser.request("/me", { headers });
    status(identity, 200);
    for (const capability of ["account:manage", "account:platform-manage", "platform:govern", "authorization:delegate"]) assert.equal(identity.data.data.context.capabilities.includes(capability), false);
  });
}
