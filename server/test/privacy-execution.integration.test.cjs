"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, randomBytes, createHash } = require("node:crypto");
const { mkdtemp, mkdir, rm, realpath } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { MongoClient } = require("mongodb");
const { fixture, guardedUri } = require("./helpers.cjs");
const { assessmentFixture, good, practice } = require("./assessment-helpers.cjs");
const { newId, rawDatabase, objectIdDatabase } = require("../dist/database/object-id");
const privacy = require("../dist/privacy/execution.js");
const { PRIVACY_POLICY_REVISION } = require("../dist/privacy/schema.js");
const { registerEnvironment, quarantineRestore, enterMaintenance, leaveMaintenance } = require("../dist/operations/control.js");
const { readSafetyLedger, reserveSafetyIntent, reconcileSafetyIntent, safetyOperationId } = require("../dist/operations/ledger.js");
const { V3_DEFAULTS } = require("../dist/migrations/content-v3.js");
const { executeAdministrationOperation } = require("../dist/administration/operations.js");
const exec = promisify(execFile);
const operator = { actor: "privacy-integration", reason: "本地隐私生命周期真实副本集验收" };
async function grantAccountManagement(f, memberId, orgId) {
  const member = await f.db.collection("organization_members").findOne({ _id: memberId, org_id: orgId, status: "active" });
  assert.ok(member);
  const scope = { kind: "organization_ids", organization_ids: [orgId] }, grantId = newId();
  const receipt = await executeAdministrationOperation({
    client: f.client, db: f.db, actor: f.context.actor, reason: "Explicit local account management authorization",
    action: "capability.grant.account:manage", key: randomUUID(),
    targets: { user_ids: [member.user_id], member_ids: [memberId], org_ids: [orgId] },
    before: {}, payload: { grant_id: grantId, member_id: memberId, capability: "account:manage", scope },
    audit: { org_id: orgId, resource_id: grantId },
    apply: async ({ session, operation_id, now }) => {
      const role = await f.db.collection("member_roles").findOne({ member_id: memberId, org_id: orgId, role_id: "org_admin" }, { session });
      assert.ok(role, "Account management requires a real org_admin role");
      await f.db.collection("administrative_grants").insertOne({
        _id: grantId, subject_member_id: memberId, actor_org_id: orgId, capability: "account:manage",
        scope, scope_key: createHash("sha256").update(JSON.stringify(scope)).digest("hex"),
        delegate_capabilities: [], status: "active", revision: 1, valid_from: now, valid_to: null,
        operation_id, authority: "cli", approval_id: null, created_at: now, updated_at: now,
      }, { session });
      await f.db.collection("organization_members").updateOne({ _id: memberId, status: "active" },
        { $inc: { authorization_revision: 1 }, $set: { updated_at: now } }, { session });
      await f.db.collection("users").updateOne({ _id: member.user_id, status: "active", privacy_state: "active" },
        { $inc: { identity_revision: 1 }, $set: { updated_at: now } }, { session });
      return { grant_id: grantId };
    },
  });
  return { grantId, operationId: receipt.operation_id };
}

// Isolated real control MongoDB and encrypted mirrored ledger, never a success mock.
// Like the other integration fixtures, run with --test-concurrency=1 (process.env).
async function setupLedger(t) {
  const source = guardedUri(process.env.TEST_MONGODB_URI);
  const controlName = `kl_control_privacy_${randomUUID().replaceAll("-", "")}`;
  const controlUri = source.replace(/(mongodb(?:\+srv)?:\/\/[^/]+\/)[^?]+/, `$1${controlName}`);
  const parent = await realpath(process.env.TEST_FILE_STORAGE_PARENT || tmpdir());
  const root = await mkdtemp(join(parent, "knowladder-privacy-ledger-"));
  const primary = join(root, "primary"), mirror = join(root, "mirror");
  const control = new MongoClient(controlUri, { serverSelectionTimeoutMS: 5000 });
  let connected = false;
  t.after(async () => {
    try {
      if (connected) {
        assert.equal(control.db().databaseName, controlName);
        assert.match(controlName, /^kl_control_privacy_[a-f0-9]{32}$/);
        await control.db().dropDatabase();
      }
    } finally {
      await control.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  await mkdir(primary, { mode: 0o700 });
  await mkdir(mirror, { mode: 0o700 });
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($path in @($env:KL_TEST_PRIVATE_ROOT,$env:KL_TEST_PRIVATE_PRIMARY,$env:KL_TEST_PRIVATE_MIRROR)) {
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
}`;
    await exec(join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { env: { ...process.env, KL_TEST_PRIVATE_ROOT: root, KL_TEST_PRIVATE_PRIMARY: primary, KL_TEST_PRIVATE_MIRROR: mirror }, windowsHide: true, timeout: 10000 });
    const { assertWindowsPrivateDirectory } = require("../dist/security/private-directory.js");
    await assertWindowsPrivateDirectory(primary);
    await assertWindowsPrivateDirectory(mirror);
  }
  await control.connect();
  connected = true;
  assert.ok((await control.db("admin").command({ hello: 1 })).setName, "control 必须是真实副本集");
  return { KL_ENVIRONMENT_ID: randomUUID(), KL_CONTROL_MONGODB_URI: controlUri,
    KL_SAFETY_LEDGER_ROOT: primary, KL_SAFETY_LEDGER_MIRROR_ROOT: mirror,
    KL_SAFETY_LEDGER_KEY: randomBytes(32).toString("hex") };
}
async function setup(t, assessment = false) {
  const env = await setupLedger(t);
  const f = assessment ? await assessmentFixture(t, { env }) : await fixture(t, { app: false, env });
  f.environmentId = env.KL_ENVIRONMENT_ID;
  f.register = async () => {
    // Registration requires all real API writer leases to have been released.
    for (const app of f.apps.splice(0)) await app.close();
    await registerEnvironment(f.client, f.db, { environmentId: f.environmentId, fileRoot: null, ...operator });
    assert.equal((await f.db.collection("operational_state").findOne({ _id: "environment" })).mode, "active");
  };
  return f;
}
async function deletionRequest(f, userId) {
  const now = new Date();
  const row = { _id: newId(), user_id: userId, scope: "account", policy_revision: PRIVACY_POLICY_REVISION,
    status: "requested", revision: 0, plan_hash: null, actor: null, reason_code: null,
    deleted_categories: [], retained_categories: [], retention_basis: null, remaining_actions: [],
    created_at: now, updated_at: now, lease_token: null, lease_until: null, ledger_sequence: null, completed_steps: [] };
  await f.db.collection("privacy_deletion_requests").insertOne(row);
  return row;
}
async function approve(f, row) {
  const plan = await privacy.inspectPrivacyRequest(f.db, row._id);
  await privacy.approvePrivacyRequest(f.client, f.db, { requestId: row._id, expectedRevision: plan.revision,
    planHash: plan.plan_hash, retentionBasis: plan.assessment_held ? "local_hold_and_provenance" : "local_minimal_provenance", ...operator });
  return plan;
}
const execute = (f, row) => privacy.executePrivacyRequest(f.client, f.db, { requestId: row._id, ...operator });
async function capture(db, names) {
  const result = {};
  const collections = (await db.listCollections().toArray()).filter(row => !names || names.includes(row.name)).sort((a, b) => a.name.localeCompare(b.name));
  for (const { name, options } of collections) result[name] = { options,
    indexes: await rawDatabase(db).collection(name).listIndexes().toArray(), rows: await rawDatabase(db).collection(name).find().sort({ _id: 1 }).toArray() };
  return result;
}
async function learningRow(f, actor = f.student) {
  const row = { _id: newId(), org_id: actor.org, member_id: actor.memberId, chapter_id: f.chapterId,
    edition_id: f.book.id, edition_revision: f.book.revision, position: { kind: "text_offset", offset_utf16: 0 },
    completed: false, revision: 1, updated_at: new Date(), cleared_at: null };
  await f.db.collection("reading_progress").insertOne(row);
  return row;
}
async function assessed(f) {
  const session = await practice(f);
  const submitted = await good(f.student, `/sessions/${session.id}/submissions`, { method: "POST",
    body: { expected_revision: session.revision, answers: [] } }, 202);
  const { processOne } = require("../dist/assessment/worker.js");
  for (let attempt = 0; attempt < 10; attempt++) {
    const row = await f.db.collection("submissions").findOne({ _id: submitted.submission_id });
    if (row.grading_status === "completed") return session;
    assert.ok(["pending", "running"].includes(row.grading_status));
    await processOne(f.db);
  }
  assert.fail("真实评分 worker 未完成，不得伪造成功");
}
async function assertFrozen(f, userId, state) {
  const user = await f.db.collection("users").findOne({ _id: userId });
  assert.equal(user.privacy_state, state);
  assert.equal(user.status, "disabled");
  const members = await f.db.collection("organization_members").find({ user_id: userId }).toArray();
  assert.ok(members.length > 0);
  assert.ok(members.every(row => row.status === "disabled"));
  assert.equal(await f.db.collection("auth_sessions").countDocuments({ user_id: userId }), 0);
  const tombstone = await f.db.collection("privacy_tombstones").findOne({ user_id: userId });
  assert.ok(tombstone);
  assert.equal(tombstone.state, state === "erased" ? "erased" : "blocking");
}
async function assertSingleIntent(f, row) {
  const ledger = await readSafetyLedger(f.environmentId, 0);
  const intents = ledger.entries.filter(entry => entry.privacyRequestId === row._id);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].action, "subject.erase");
  assert.equal(intents[0].subjectId, row.user_id);
  assert.equal(intents[0].state, "committed");
  assert.equal(ledger.pending, false);
  return ledger;
}
const graphNames = ["sessions", "session_items", "submissions", "answers", "grading_runs", "grading_results",
  "outbox_events", "consumer_receipts", "assessment_resource_references", "attempt_counters", "quiz_audiences"];

test("隐私本地执行：真实 Mongo、外部加密 ledger、恢复闭环", { concurrency: false, timeout: 1200000 }, async t => {
  await t.test("inspect 在未登记环境只读，未知集合拒绝且不产生任何DDL或状态", async t => {
    const f = await fixture(t, { app: false });
    const user = await f.user(), row = await deletionRequest(f, user.user_id);
    const before = await capture(f.db);
    const plan = await privacy.inspectPrivacyRequest(f.db, row._id);
    assert.equal(plan.revision, 0);
    assert.match(plan.plan_hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(await capture(f.db), before);
    await f.db.createCollection("unclassified_privacy_data");
    const unknown = await capture(f.db);
    await assert.rejects(privacy.inspectPrivacyRequest(f.db, row._id), /PRIVACY_UNKNOWN_DATASET/);
    assert.deepEqual(await capture(f.db), unknown);
  });

  await t.test("批准、拒绝校验revision和plan，执行前再次拒绝过期plan", async t => {
    const f = await setup(t);
    const user = await f.user(), row = await deletionRequest(f, user.user_id);
    await f.register();
    const plan = await privacy.inspectPrivacyRequest(f.db, row._id);
    const input = { requestId: row._id, expectedRevision: row.revision, planHash: plan.plan_hash,
      retentionBasis: "local_minimal_provenance", ...operator };
    for (const change of [{ expectedRevision: 1 }, { planHash: "0".repeat(64) }])
      await assert.rejects(privacy.approvePrivacyRequest(f.client, f.db, { ...input, ...change }), /PRIVACY_PLAN_STALE/);
    await assert.rejects(privacy.rejectPrivacyRequest(f.client, f.db, { requestId: row._id, expectedRevision: 1, ...operator }), /PRIVACY_REVISION_CONFLICT/);
    assert.deepEqual(await f.db.collection("privacy_deletion_requests").findOne({ _id: row._id }), row);
    await privacy.approvePrivacyRequest(f.client, f.db, input);
    await assert.rejects(privacy.rejectPrivacyRequest(f.client, f.db, { requestId: row._id, expectedRevision: 0, ...operator }), /PRIVACY_REVISION_CONFLICT/);
    const now = new Date();
    await f.db.collection("content_idempotency").insertOne({ _id: newId(), org_id: newId(), user_id: user.user_id,
      operation: "privacy-stale-plan-fixture", resource_id: newId(), key: randomUUID(), request_hash: "a".repeat(64), result: {}, created_at: now });
    await assert.rejects(execute(f, row), /PRIVACY_PLAN_STALE/);
    assert.equal(await f.db.collection("privacy_tombstones").countDocuments({ user_id: user.user_id }), 0);
    assert.equal((await f.db.collection("users").findOne({ _id: user.user_id })).privacy_state, "active");
    const rejected = await deletionRequest(f, user.user_id);
    const result = await privacy.rejectPrivacyRequest(f.client, f.db, { requestId: rejected._id, expectedRevision: 0, ...operator });
    assert.equal(result.status, "rejected");
    await assert.rejects(execute(f, rejected), /PRIVACY_APPROVAL_REQUIRED/);
    assert.equal((await readSafetyLedger(f.environmentId, 0)).entries.length, 0);
    const refreshed = await approve(f, row);
    assert.notEqual(refreshed.plan_hash, plan.plan_hash);
    assert.equal((await execute(f, row)).status, "completed_with_retention");
    assert.equal(await f.db.collection("content_idempotency").countDocuments({ user_id: user.user_id }), 0);
    await assertSingleIntent(f, row);
  });

  await t.test("多组织整账户删除保留共享内容及其他用户，身份不可重新启用", async t => {
    const f = await setup(t, true), userId = f.student.user.user_id;
    const org = await f.ops.createOrganization(f.context, { name: "第二隐私组织", kind: "school" });
    const second = await f.ops.setMembership(f.context, { user_id: userId, org_id: org.organization_id, roles: ["student"] });
    await learningRow(f);
    await learningRow(f, { org: org.organization_id, memberId: second.member_id });
    const survivor = await f.actor(["student", "org_admin"]);
    const survivorProgress = await learningRow(f, survivor);
    await assessed(f);
    const targetMember = await f.db.collection("organization_members").findOne({ _id: f.student.memberId });
    const survivorMember = await f.db.collection("organization_members").findOne({ _id: survivor.memberId });
    const adminOrg = await f.ops.createOrganization(f.context, { name: "待删除用户独立管理组织", kind: "school" });
    const targetAdmin = await f.ops.setMembership(f.context, { user_id: userId, org_id: adminOrg.organization_id, roles: ["org_admin"] });
    const targetGrant = await grantAccountManagement(f, targetAdmin.member_id, adminOrg.organization_id);
    const survivorGrant = await grantAccountManagement(f, survivorMember._id, survivor.org);
    const appliedOpId = targetGrant.operationId;
    const targetIdentity = await f.db.collection("users").findOne({ _id: userId });
    const requesterMember = await f.db.collection("organization_members").findOne({ _id: survivorMember._id });
    const requesterIdentity = await f.db.collection("users").findOne({ _id: survivor.user.user_id });
    const at = new Date();
    const voidOpId = newId(), voidBefore = { display_name: "erasure-sensitive-before" };
    const voidDesired = { display_name: "erasure-sensitive-after" };
    await f.db.collection("administration_operations").insertOne({
      _id: voidOpId, actor_id: survivor.user.user_id, action: "user.update", reason: "erasure-sensitive-reason",
      targets: { user_ids: [userId], member_ids: [targetMember._id], org_ids: [f.org], global: false },
      payload_hash: createHash("sha256").update(JSON.stringify({ before: voidBefore, desired: voidDesired })).digest("hex"),
      before: voidBefore, desired: voidDesired, key: randomUUID(), mode: "replicaSet",
      status: "void", step: "voided", revision: 2, audit_id: null, created_at: at, updated_at: at,
    });
    const pendingId = newId(), requested = {
      user_id: userId, org_id: f.org, member_id: targetMember._id, roles: ["student", "content_reviewer"],
      status: "active", expected_revision: targetMember.authorization_revision,
      valid_to: new Date(Date.now() + 7 * 86400000).toISOString(),
    };
    await f.db.collection("authorization_requests").insertOne({
      _id: pendingId, requester_user_id: survivor.user.user_id, requester_member_id: survivor.memberId,
      beneficiary_user_id: userId, subject_member_id: targetMember._id, action: "member.update",
      payload: requested, payload_hash: createHash("sha256").update(JSON.stringify(requested)).digest("hex"),
      expected_grant_revision: targetMember.authorization_revision,
      requester_permission_revision: requesterMember.authorization_revision,
      requester_credential_version: requesterIdentity.credential_version,
      target_credential_version: targetIdentity.credential_version,
      target_identity_revision: targetIdentity.identity_revision,
      reason: "敏感内容审核角色须独立审批", status: "pending", revision: 1,
      approver_user_id: null, approver_credential_version: null, approved_at: null, operation_id: null, created_at: at, updated_at: at,
    });
    const row = await deletionRequest(f, userId);
    await f.register();
    const shared = await capture(f.db, ["questions", "question_versions", "textbooks", "textbook_editions", "file_resources"]);
    const other = await f.db.collection("users").findOne({ _id: survivor.user.user_id });
    const oldUser = await f.db.collection("users").findOne({ _id: userId });
    const plan = await approve(f, row);
    assert.equal(plan.categories.reading_progress, 2);
    assert.ok(plan.categories.grading_results > 0);
    assert.equal(plan.categories.authorization_requests, 1);
    assert.equal(plan.categories.administrative_grants, 1);
    assert.equal((await execute(f, row)).status, "completed_with_retention");
    await assertFrozen(f, userId, "erased");
    const erased = await f.db.collection("users").findOne({ _id: userId });
    assert.equal(erased.login_key, `deleted_${userId}`);
    assert.equal(erased.display_name, "已删除账户");
    assert.notEqual(erased.password_hash, oldUser.password_hash);
    const after = await privacy.inspectPrivacyRequest(f.db, row._id);
    assert.ok(Object.values(after.categories).every(count => count === 0));
    assert.equal(await f.db.collection("authorization_requests").countDocuments({ _id: pendingId }), 0);
    assert.equal(await f.db.collection("administrative_grants").countDocuments({ subject_member_id: targetAdmin.member_id }), 0);
    assert.equal(await f.db.collection("administrative_grants").countDocuments({ _id: survivorGrant.grantId, status: "active", operation_id: survivorGrant.operationId }), 1);
    const provenance = await f.db.collection("administration_operations").findOne({ _id: appliedOpId });
    assert.equal(provenance.status, "applied");
    assert.equal(provenance.reason, "[redacted]");
    assert.deepEqual(provenance.before, {});
    assert.deepEqual(provenance.desired, {});
    assert.equal(provenance.key, null);
    const voidProvenance = await f.db.collection("administration_operations").findOne({ _id: voidOpId });
    assert.equal(voidProvenance.status, "void");
    assert.equal(voidProvenance.reason, "[redacted]");
    assert.deepEqual(voidProvenance.before, {});
    assert.deepEqual(voidProvenance.desired, {});
    assert.equal(voidProvenance.key, null);
    const { effectiveAdministrativeGrants } = require("../dist/administration/authorization.js");
    assert.ok((await effectiveAdministrativeGrants(f.db, survivorMember._id)).some(grant => grant._id === survivorGrant.grantId));
    assert.deepEqual(await capture(f.db, Object.keys(shared)), shared);
    assert.deepEqual(await f.db.collection("users").findOne({ _id: other._id }), other);
    assert.deepEqual(await f.db.collection("reading_progress").findOne({ _id: survivorProgress._id }), survivorProgress);
    await assert.rejects(f.ops.setUserStatus(f.context, { user_id: userId, status: "active" }));
    await assert.rejects(f.ops.resetPassword(f.context, { user_id: userId }));
    const member = await f.db.collection("organization_members").findOne({ _id: second.member_id });
    await assert.rejects(f.ops.setMembership(f.context, { user_id: userId, org_id: org.organization_id, roles: ["student"], status: "active", expected_revision: member.authorization_revision }));
    await assertFrozen(f, userId, "erased");
    await assertSingleIntent(f, row);
  });

  await t.test("operations privacy-execute真实子进程正常退出，完成删除并清理writer与ledger锁", async t => {
    const f = await setup(t);
    const user = await f.user();
    const org = await f.ops.createOrganization(f.context, { name: "受控隐私CLI组织", kind: "school" });
    await f.ops.setMembership(f.context, { user_id: user.user_id, org_id: org.organization_id, roles: ["student"] });
    const row = await deletionRequest(f, user.user_id);
    await f.register();
    await approve(f, row);
    const before = await f.db.collection("operational_writers").find({}, { projection: { _id: 1 } }).toArray();
    // execFile rejects nonzero supervisor exits; the supervisor also reports the owned child's exit code.
    const result = await exec(process.execPath, [join(__dirname, "../dist/operations/cli.js"), "privacy-execute",
      "--request-id", row._id, "--actor", operator.actor, "--reason", operator.reason],
      { env: { ...process.env, MONGODB_URI: f.uri }, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
    const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    assert.ok(output.some(value => value.exit_code === 0), "supervisor必须观察到owned child成功退出");
    assert.ok(output.some(value => value.request_id === row._id && value.status === "completed_with_retention"));
    assert.equal(result.stderr.trim(), "");
    const completed = await f.db.collection("privacy_deletion_requests").findOne({ _id: row._id });
    assert.equal(completed.status, "completed_with_retention");
    assert.equal(completed.lease_token, null);
    assert.equal(completed.lease_until, null);
    await assertFrozen(f, user.user_id, "erased");
    const launched = await f.db.collection("operational_writers").find({ _id: { $nin: before.map(writer => writer._id) }, kind: "privacy" }).toArray();
    assert.ok(launched.length > 0, "真实子进程必须登记writer，不能以空集合伪造清理成功");
    assert.ok(launched.every(writer => writer.pid !== process.pid && writer.state === "stopped" && writer.stopped_at instanceof Date));
    assert.equal(new Set(launched.map(writer => writer.token)).size, 1, "同一owned child使用相同launch token");
    assert.equal(await f.db.collection("operational_writers").countDocuments({ state: "running" }), 0);
    await assertSingleIntent(f, row);
    const control = new MongoClient(process.env.KL_CONTROL_MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    try {
      await control.connect();
      const head = await control.db().collection("safety_ledger_heads").findOne({ ledger_key: f.environmentId });
      assert.ok(head);
      assert.equal(head.lock, null, "owned child退出后external ledger锁必须释放");
    } finally { await control.close(); }
  });

  await t.test("freeze前真实ledger故障后，failed重试仍校验源图并允许重批", async t => {
    const f = await setup(t);
    const user = await f.user(), row = await deletionRequest(f, user.user_id);
    await f.register();
    await approve(f, row);
    const key = process.env.KL_SAFETY_LEDGER_KEY;
    process.env.KL_SAFETY_LEDGER_KEY = "invalid-key";
    try {
      await assert.rejects(execute(f, row), /SAFETY_LEDGER_UNAVAILABLE/);
    } finally {
      process.env.KL_SAFETY_LEDGER_KEY = key;
    }
    const failed = await f.db.collection("privacy_deletion_requests").findOne({ _id: row._id });
    assert.equal(failed.status, "failed");
    assert.equal(failed.ledger_sequence, null);
    assert.equal(failed.lease_token, null);
    assert.equal(await f.db.collection("privacy_tombstones").countDocuments({ user_id: user.user_id }), 0);
    assert.equal((await f.db.collection("users").findOne({ _id: user.user_id })).privacy_state, "active");
    await f.db.collection("content_idempotency").insertOne({ _id: newId(), org_id: newId(), user_id: user.user_id,
      operation: "privacy-failed-plan-fixture", resource_id: newId(), key: randomUUID(), request_hash: "b".repeat(64), result: {}, created_at: new Date() });
    await assert.rejects(execute(f, row), /PRIVACY_PLAN_STALE/);
    assert.equal((await readSafetyLedger(f.environmentId, 0)).entries.length, 0);
    await approve(f, row);
    assert.equal((await execute(f, row)).status, "completed_with_retention");
    await assertSingleIntent(f, row);
  });

  await t.test("真实pending阻止重批；维护abort后不同保留依据生成新intent并完成", async t => {
    const f = await setup(t);
    const user = await f.user(), row = await deletionRequest(f, user.user_id);
    await f.register();
    const initial = await approve(f, row);
    const firstIntent = { operationId: safetyOperationId(JSON.stringify([row._id, initial.plan_hash, PRIVACY_POLICY_REVISION, "local_minimal_provenance", 0])),
      action: "subject.erase", subjectId: user.user_id, privacyRequestId: row._id,
      privacyPolicyRevision: PRIVACY_POLICY_REVISION, privacyRetentionBasis: "local_minimal_provenance" };
    // Real durable reservation, then a real source mutation; no timing-dependent race or mocked success.
    const reservation = await reserveSafetyIntent(f.db, firstIntent);
    assert.deepEqual(await reserveSafetyIntent(f.db, firstIntent), reservation, "pending reservation重试必须稳定");
    await f.db.collection("content_idempotency").insertOne({ _id: newId(), org_id: newId(), user_id: user.user_id,
      operation: "privacy-pending-plan-fixture", resource_id: newId(), key: randomUUID(), request_hash: "c".repeat(64), result: {}, created_at: new Date() });
    await f.db.collection("users").updateOne({ _id: user.user_id }, { $inc: { identity_revision: 1 }, $set: { updated_at: new Date() } });
    await assert.rejects(execute(f, row), /PRIVACY_PLAN_STALE/);
    assert.equal(await f.db.collection("privacy_tombstones").countDocuments({ user_id: user.user_id }), 0);
    assert.equal((await f.db.collection("users").findOne({ _id: user.user_id })).privacy_state, "active");
    const fresh = await privacy.inspectPrivacyRequest(f.db, row._id);
    const reapproval = { requestId: row._id, expectedRevision: fresh.revision, planHash: fresh.plan_hash,
      retentionBasis: "local_hold_and_provenance", ...operator };
    await assert.rejects(privacy.approvePrivacyRequest(f.client, f.db, reapproval), /PRIVACY_PENDING_INTENT_REQUIRES_RECONCILIATION/);
    const pending = await readSafetyLedger(f.environmentId, 0);
    assert.equal(pending.pending, true);
    assert.equal(pending.entries.filter(entry => entry.privacyRequestId === row._id).length, 1);
    assert.equal(pending.entries.find(entry => entry.operationId === firstIntent.operationId).state, "pending");
    const state = await f.db.collection("operational_state").findOne({ _id: "environment" });
    const maintenance = await enterMaintenance(f.client, f.db, { expectedRevision: state.revision, ...operator });
    await assert.rejects(leaveMaintenance(f.client, f.db, { token: maintenance.token, ...operator }), /OPERATIONS_PENDING_LEDGER/);
    await reconcileSafetyIntent(f.db, { operationId: firstIntent.operationId, decision: "abort", maintenanceToken: maintenance.token, ...operator });
    await leaveMaintenance(f.client, f.db, { token: maintenance.token, ...operator });
    await privacy.approvePrivacyRequest(f.client, f.db, reapproval);
    assert.equal((await execute(f, row)).status, "completed_with_retention");
    const final = await readSafetyLedger(f.environmentId, 0);
    const attempts = final.entries.filter(entry => entry.privacyRequestId === row._id);
    assert.equal(final.pending, false);
    assert.equal(attempts.length, 2);
    const aborted = attempts.find(entry => entry.operationId === firstIntent.operationId);
    const committed = attempts.find(entry => entry.state === "committed");
    assert.equal(aborted.state, "aborted");
    assert.equal(aborted.privacyRetentionBasis, "local_minimal_provenance");
    assert.ok(committed);
    assert.notEqual(committed.operationId, aborted.operationId);
    assert.equal(committed.privacyRetentionBasis, "local_hold_and_provenance");
    assert.ok(committed.sequence > aborted.sequence);
    assert.equal((await f.db.collection("users").findOne({ _id: user.user_id })).privacy_state, "erased");
    assert.equal(await f.db.collection("content_idempotency").countDocuments({ user_id: user.user_id }), 0);
    await execute(f, row);
    assert.deepEqual(await readSafetyLedger(f.environmentId, 0), final, "committed重试不得追加或改写intent");
  });

  for (const hold of ["legal_hold", "retention_until"]) await t.test(`${hold}保留完整评估依赖图，但仍删除学习证据并冻结身份`, async t => {
    const f = await setup(t, true), userId = f.student.user.user_id;
    const session = await assessed(f);
    await learningRow(f);
    const item = await f.db.collection("session_items").findOne({ session_id: session.id });
    const now = new Date(), fileId = newId();
    // Historical pending resource: no fake scan result or file-delivery success.
    const file = { _id: fileId, org_id: f.org, created_at: now, updated_at: now, ...V3_DEFAULTS.file_resources,
      owner_type: "question", owner_version_id: item.snapshot.question_version_id, created_by: f.editor.user.user_id,
      display_name: "retained-pending.txt", storage_key: randomUUID(), declared_size: 1, declared_mime: "text/plain", declared_checksum: "0".repeat(64),
      size: null, mime: null, checksum: null, status: "pending", scan_status: "awaiting_upload", scan_attempt: 0,
      lease_token: null, lease_until: null, available_at: now, uploaded_at: null, error_code: null,
      [hold]: hold === "legal_hold" ? true : new Date(now.getTime() + 86400000) };
    await f.db.collection("file_resources").insertOne(file);
    await f.db.collection("session_items").updateOne({ _id: item._id }, { $addToSet: { "snapshot.resource_ids": fileId } });
    await f.db.collection("assessment_resource_references").insertOne({ _id: newId(), org_id: f.org, created_at: now, updated_at: now,
      reference_type: "session_item", reference_id: item._id, file_id: fileId, owner_type: "question", owner_version_id: item.snapshot.question_version_id });
    const row = await deletionRequest(f, userId);
    await f.register();
    const graph = await capture(f.db, graphNames);
    const plan = await privacy.inspectPrivacyRequest(f.db, row._id);
    assert.equal(plan.assessment_held, true);
    await assert.rejects(privacy.approvePrivacyRequest(f.client, f.db, { requestId: row._id, expectedRevision: plan.revision,
      planHash: plan.plan_hash, retentionBasis: "local_minimal_provenance", ...operator }), /PRIVACY_RETENTION_BASIS_REQUIRED/);
    await approve(f, row);
    await execute(f, row);
    await assertFrozen(f, userId, "erased");
    assert.deepEqual(await capture(f.db, graphNames), graph);
    assert.deepEqual(await f.db.collection("file_resources").findOne({ _id: fileId }), file);
    assert.equal(await f.db.collection("reading_progress").countDocuments({ member_id: f.student.memberId }), 0);
    const completed = await f.db.collection("privacy_deletion_requests").findOne({ _id: row._id });
    assert.ok(completed.retained_categories.includes("held_assessment_facts"));
    assert.deepEqual(completed.remaining_actions, []);
    await assertSingleIntent(f, row);
  });

  await t.test("真实事务中途失败保持冻结，resume不重复删除计数和外部intent", async t => {
    const f = await setup(t, true), userId = f.student.user.user_id;
    await assessed(f);
    await learningRow(f);
    const row = await deletionRequest(f, userId);
    await f.register();
    const plan = await approve(f, row);
    assert.ok(plan.categories.grading_runs > 0);
    const options = (await f.db.listCollections({ name: "privacy_step_receipts" }).next()).options;
    await f.db.command({ collMod: "privacy_step_receipts", validator: { $and: [options.validator, { step: { $ne: "grading_runs" } }] }, validationLevel: "strict", validationAction: "error" });
    try {
      await assert.rejects(execute(f, row), error => error.code === 121);
    } finally {
      await f.db.command({ collMod: "privacy_step_receipts", validator: options.validator, validationLevel: "strict", validationAction: "error" });
    }
    await assertFrozen(f, userId, "erasing");
    const failed = await f.db.collection("privacy_deletion_requests").findOne({ _id: row._id });
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.remaining_actions, ["resume_erasure"]);
    assert.equal(failed.lease_token, null);
    const receipts = await f.db.collection("privacy_step_receipts").find({ request_id: row._id }).sort({ step: 1 }).toArray();
    assert.ok(receipts.some(receipt => receipt.step === "reading_progress" && receipt.deleted_count === 1));
    assert.equal(await f.db.collection("grading_runs").countDocuments({}), plan.categories.grading_runs, "失败batch必须回滚删除");
    const ledger = await assertSingleIntent(f, row);
    await execute(f, row);
    await assertFrozen(f, userId, "erased");
    for (const receipt of receipts) assert.deepEqual(await f.db.collection("privacy_step_receipts").findOne({ _id: receipt._id }), receipt);
    const finalReceipts = await f.db.collection("privacy_step_receipts").find({ request_id: row._id }).toArray();
    assert.equal(new Set(finalReceipts.map(receipt => receipt.step)).size, finalReceipts.length);
    for (const receipt of finalReceipts) assert.equal(receipt.deleted_count, plan.categories[receipt.step]);
    assert.deepEqual(await assertSingleIntent(f, row), ledger);
    const businessNames = (await f.db.listCollections({}, { nameOnly: true }).toArray())
      .map(item => item.name).filter(name => !["operational_state", "operational_writers"].includes(name));
    const final = await capture(f.db, businessNames);
    await execute(f, row);
    assert.deepEqual(await capture(f.db, businessNames), final, "终态重试业务及隐私状态必须完全幂等");
    assert.equal(await f.db.collection("operational_writers").countDocuments({ kind: "privacy", state: "running" }), 0);
    assert.deepEqual(await assertSingleIntent(f, row), ledger);
  });

  await t.test("源库已丢失且旧快照无request时，外部已提交proof仍恢复删除而不伤其他用户", async t => {
    const f = await setup(t, true), userId = f.student.user.user_id;
    await assessed(f);
    await learningRow(f);
    const survivor = await f.actor();
    const survivorProgress = await learningRow(f, survivor);
    await f.register();
    const archive = await capture(f.db);
    assert.equal(archive.privacy_deletion_requests.rows.length, 0);
    assert.equal(archive.privacy_tombstones.rows.length, 0);
    const row = await deletionRequest(f, userId);
    await approve(f, row);
    await execute(f, row);
    const ledger = await assertSingleIntent(f, row);
    const proof = ledger.entries.find(entry => entry.privacyRequestId === row._id);
    assert.equal(proof.privacyPolicyRevision, PRIVACY_POLICY_REVISION);
    assert.equal(proof.privacyRetentionBasis, "local_minimal_provenance");
    const targetName = `kl_restore_privacy_${randomUUID().replaceAll("-", "")}`;
    // Independent lifecycle: fixture cleanup may close f.client before this hook.
    const restoreClient = new MongoClient(f.uri, { serverSelectionTimeoutMS: 5000 });
    let connected = false;
    t.after(async () => {
      try {
        if (connected) {
          assert.match(targetName, /^kl_restore_privacy_[a-f0-9]{32}$/);
          await restoreClient.db(targetName).dropDatabase();
        }
      } finally { await restoreClient.close(); }
    });
    await restoreClient.connect();
    connected = true;
    const target = objectIdDatabase(restoreClient.db(targetName));
    const { initializeRestoreSchema } = require("../dist/migrations/schema.js");
    await initializeRestoreSchema(target);
    await quarantineRestore(target, { environmentId: f.environmentId, restoreId: newId() });
    const isolatedState = await target.collection("operational_state").findOne({ _id: "environment" });
    // This test restores logical Mongo snapshots; encrypted archive I/O is covered separately.
    for (const [name, saved] of Object.entries(archive)) {
      if (["operational_state", "operational_writers", "backup_restore_runs", "administration_guard", "administration_operations", "administrative_grants", "authorization_requests", "member_roles", "member_capability_grants"].includes(name)) continue;
      if (saved.rows.length) await rawDatabase(target).collection(name).insertMany(saved.rows);
    }
    assert.deepEqual(await target.collection("operational_state").findOne({ _id: "environment" }), isolatedState);
    assert.equal(isolatedState.mode, "restore_quarantined");
    assert.equal(await target.collection("privacy_deletion_requests").countDocuments({}), 0);
    assert.ok(await target.collection("sessions").countDocuments({ user_id: userId }) > 0);
    const survivorBefore = await target.collection("users").findOne({ _id: survivor.user.user_id });
    const sharedNames = ["questions", "question_versions", "textbooks", "textbook_editions", "file_resources"];
    const shared = await capture(target, sharedNames);
    guardedUri(f.uri);
    await f.db.dropDatabase();
    assert.equal((await f.db.listCollections({}, { nameOnly: true }).toArray()).length, 0);
    await privacy.suppressRestoredSubject(target, userId, row._id, proof.sequence);
    await assertFrozen({ db: target }, userId, "erased");
    const restored = await target.collection("privacy_deletion_requests").findOne({ _id: row._id });
    assert.equal(restored.user_id, userId);
    assert.equal(restored.status, "completed_with_retention");
    assert.equal(restored.policy_revision, PRIVACY_POLICY_REVISION);
    assert.equal(restored.retention_basis, "local_minimal_provenance");
    assert.equal(restored.ledger_sequence, proof.sequence);
    assert.deepEqual(restored.remaining_actions, []);
    assert.ok(restored.retained_categories.includes("identity_tombstone"));
    const inspected = await privacy.inspectPrivacyRequest(target, row._id);
    assert.ok(Object.values(inspected.categories).every(count => count === 0));
    assert.deepEqual(await target.collection("users").findOne({ _id: survivor.user.user_id }), survivorBefore);
    assert.deepEqual(await target.collection("reading_progress").findOne({ _id: survivorProgress._id }), survivorProgress);
    assert.deepEqual(await capture(target, sharedNames), shared);
    assert.equal((await target.collection("operational_state").findOne({ _id: "environment" })).mode, "restore_quarantined");
    assert.deepEqual(await readSafetyLedger(f.environmentId, 0), ledger, "亡源重放不得追加新intent");
    assert.equal((await f.db.listCollections({}, { nameOnly: true }).toArray()).length, 0, "不得重建或依赖源库");
  });

  await t.test("restore旧requested没有保留依据时先冻结，再阻止删除并要求review_retention", async t => {
    const f = await setup(t, true), userId = f.student.user.user_id;
    await assessed(f);
    const row = await deletionRequest(f, userId);
    await f.register();
    await f.db.collection("operational_state").updateOne({ _id: "environment" }, { $set: { mode: "restore_quarantined", restore_id: newId() } });
    const graph = await capture(f.db, graphNames);
    const ledger = await readSafetyLedger(f.environmentId, 0);
    await assert.rejects(privacy.suppressRestoredSubject(f.db, userId, row._id, 0), /PRIVACY_RETENTION_BASIS_REQUIRED/);
    await assertFrozen(f, userId, "erasing");
    const blocked = await f.db.collection("privacy_deletion_requests").findOne({ _id: row._id });
    assert.equal(blocked.status, "blocking");
    assert.equal(blocked.retention_basis, null);
    assert.deepEqual(blocked.remaining_actions, ["review_retention"]);
    assert.equal((await f.db.collection("operational_state").findOne({ _id: "environment" })).mode, "restore_quarantined");
    assert.deepEqual(await capture(f.db, graphNames), graph);
    assert.deepEqual(await readSafetyLedger(f.environmentId, 0), ledger);
  });

  await t.test("restore仅隔离态可重放，未知历史policy保持隔离且冻结而不误删", async t => {
    const f = await setup(t, true), userId = f.student.user.user_id;
    await assessed(f);
    const row = await deletionRequest(f, userId);
    await f.register();
    const original = await capture(f.db);
    await assert.rejects(privacy.suppressRestoredSubject(f.db, userId, row._id, 1), /PRIVACY_RESTORE_QUARANTINE_REQUIRED/);
    assert.deepEqual(await capture(f.db), original);
    // Deliberately simulate a restored future/historical policy absent from current validator.
    await f.db.collection("privacy_deletion_requests").updateOne({ _id: row._id }, { $set: { policy_revision: "unknown_historical_policy" } }, { bypassDocumentValidation: true });
    await f.db.collection("operational_state").updateOne({ _id: "environment" }, { $set: { mode: "restore_quarantined", restore_id: newId() } });
    const graph = await capture(f.db, graphNames);
    const ledger = await readSafetyLedger(f.environmentId, 0);
    await assert.rejects(privacy.suppressRestoredSubject(f.db, userId, row._id, 0), /PRIVACY_POLICY_UNKNOWN/);
    await assertFrozen(f, userId, "erasing");
    assert.equal((await f.db.collection("operational_state").findOne({ _id: "environment" })).mode, "restore_quarantined");
    assert.deepEqual(await capture(f.db, graphNames), graph);
    assert.equal((await f.db.collection("privacy_deletion_requests").findOne({ _id: row._id })).policy_revision, "unknown_historical_policy");
    assert.deepEqual(await readSafetyLedger(f.environmentId, 0), ledger, "restore不得追加源环境删除intent");
  });
});
