"use strict";
const {newId,objectIdDatabase,rawDatabase}=require("../dist/database/object-id");
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { fixture } = require('./helpers.cjs');
const backupApi = require('../../ops/system-backup.cjs');
const archiveApi = require('../../ops/system-backup-archive.cjs');
const control = require('../dist/operations/control.js');
const ledger = require('../dist/operations/ledger.js');
async function protectPrivateRoot(root) {
  await fs.chmod(root, 0o700);
  if (process.platform === 'win32') {
    const script = "$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule);Set-Acl -LiteralPath $env:KL_TEST_PRIVATE_ROOT -AclObject $acl";
    await promisify(execFile)(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')], { windowsHide:true, env: { ...process.env, KL_TEST_PRIVATE_ROOT: root } });
  }
}
async function privateRoot(t) {
  const root = await fs.mkdtemp(path.join(process.env.TEST_FILE_STORAGE_PARENT || os.homedir(), 'kl-system-backup-'));
  await protectPrivateRoot(root);
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
async function child(root, name) { const dir = path.join(root, name); await fs.mkdir(dir, { mode: 0o700 }); await protectPrivateRoot(dir); return dir; }
async function verifyFile(file, key) { const handle = await archiveApi.openFile(file); try { return await backupApi.authenticate(handle, key); } finally { await handle.close(); } }
async function dropTestDatabase(uri, name) {
  assert.match(name, /^kl_(control|restore)_[\w-]+$/);
  const { MongoClient } = require('mongodb'); const client = new MongoClient(uri);
  try { await client.connect(); await client.db(name).dropDatabase(); } finally { await client.close(); }
}
test('全业务加密备份：真实DB与文件、双遍认证、隔离恢复及旧包最新账本抑制', async t => {
  const original = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original); });
  const f = await fixture(t, { app: false }); const user = await f.user();
  const root = await privateRoot(t), source = await child(root, 'source');
  for (const area of ['tmp','quarantine','ready']) await child(source, area);
  const environmentId = randomUUID(), controlName = 'kl_control_' + randomUUID().replaceAll('-', '');
  process.env.KL_CONTROL_MONGODB_URI = f.uri.replace(/\/kl_test_[^?]+/, '/' + controlName);
  process.env.KL_ENVIRONMENT_ID = environmentId;
  process.env.KL_SAFETY_LEDGER_ROOT = await child(root, 'ledger');
  process.env.KL_SAFETY_LEDGER_MIRROR_ROOT = await child(root, 'mirror');
  process.env.KL_SAFETY_LEDGER_KEY = randomBytes(32).toString('hex');
  t.after(() => dropTestDatabase(f.uri, controlName));
  const beforeRegistration = await control.getOperationalState(f.db);
  assert.equal((await f.db.collection('schema_migrations').findOne({ version: 22 })).status, 'completed');
  assert.equal(beforeRegistration.mode, 'unregistered'); assert.ok(beforeRegistration.revision > 0);
  await control.registerEnvironment(f.client, f.db, { environmentId, actor: 'system-backup-test', reason: 'synthetic backup test', fileRoot: source });
  const state = await f.db.collection('operational_state').findOne({ _id: 'environment' });
  assert.equal(state.mode, 'active'); assert.ok(state.revision > beforeRegistration.revision);
  let gate = await control.enterMaintenance(f.client, f.db, { actor: 'system-backup-test', reason: 'synthetic backup test', expectedRevision: state.revision });
  const expireWindow = () => f.db.collection('operational_state').updateOne({ _id: 'environment', mode: 'maintenance', maintenance_token: gate.token }, [{ $set: { updated_at: { $dateSubtract: { startDate: '$$NOW', unit: 'minute', amount: 31 } } } }]);
  const newWindow = async () => {
    await control.leaveMaintenance(f.client, f.db, { token: gate.token, actor: 'system-backup-test', reason: 'explicit expired-window recovery' });
    const current = await f.db.collection('operational_state').findOne({ _id: 'environment' });
    gate = await control.enterMaintenance(f.client, f.db, { actor: 'system-backup-test', reason: 'new bounded window', expectedRevision: current.revision });
  };
  await expireWindow();
  const expiredFile = path.join(root, 'expired-window.klb');
  await assert.rejects(backupApi.backup({ client: f.client, db: f.db, file: expiredFile, key: randomBytes(32), root: source, maintenanceToken: gate.token }), /BACKUP_MAINTENANCE_TIMEOUT/);
  await assert.rejects(fs.stat(expiredFile), { code: 'ENOENT' }); assert.equal((await ledger.readLatestCompletedBackup(f.db)).status, 'not_recorded');
  const expiredState = await f.db.collection('operational_state').findOne({ _id: 'environment' });
  assert.equal(expiredState.mode, 'maintenance'); assert.equal(expiredState.maintenance_token, gate.token);
  await newWindow();
  const contents = new Map();
  for (const area of ['tmp','quarantine','ready']) { const key = randomUUID(); const bytes = randomBytes(1024 * 1024 + 7); await fs.writeFile(path.join(source, area, key), bytes, { mode: 0o600, flag: 'wx' }); contents.set(area + '/' + key, bytes); }
  const file = path.join(root, 'whole-business.klb'), key = randomBytes(32);
  const oversized = path.join(source, 'tmp', randomUUID());
  await fs.writeFile(oversized, Buffer.alloc(10 * 1024 * 1024 + 1), { flag: 'wx', mode: 0o600 });
  await assert.rejects(backupApi.backup({ client: f.client, db: f.db, file, key, root: source, maintenanceToken: gate.token }), /BACKUP_LIMIT_EXCEEDED/);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' }); await fs.unlink(oversized);
  const linkedSource = path.join(source, [...contents.keys()][0]), hardlink = path.join(source, 'tmp', randomUUID());
  await fs.link(linkedSource, hardlink);
  await assert.rejects(backupApi.backup({ client: f.client, db: f.db, file, key, root: source, maintenanceToken: gate.token }), /UNSAFE_FILE/);
  await fs.unlink(hardlink);
  const report = await backupApi.backup({ client: f.client, db: f.db, file, key, root: source, maintenanceToken: gate.token });
  assert.equal(report.files, 3); assert.equal(report.unresolved, 3);
  const publishedBytes = await fs.readFile(file);
  const registered = await ledger.readLatestCompletedBackup(f.db);
  assert.equal(registered.status, 'recorded'); assert.equal(registered.backupId, report.backup_id); assert.equal(registered.manifestHash, report.manifest_hash); assert.equal(registered.createdAt.toISOString(), report.created_at);
  const repeated = await backupApi.backup({ client: f.client, db: f.db, file, key, root: source, maintenanceToken: gate.token });
  assert.equal(repeated.backup_id, report.backup_id); assert.equal(repeated.manifest_hash, report.manifest_hash); assert.equal(repeated.created_at, report.created_at); assert.equal(repeated.registered, true); assert.equal(repeated.replayed, true); assert.equal(report.replayed, false);
  assert.deepEqual(await fs.readFile(file), publishedBytes);
  const registeredAgain = await ledger.readLatestCompletedBackup(f.db);
  assert.equal(registeredAgain.backupId, registered.backupId); assert.equal(registeredAgain.completedAt.getTime(), registered.completedAt.getTime());
  await expireWindow();
  await assert.rejects(backupApi.backup({ client: f.client, db: f.db, file, key, root: source, maintenanceToken: gate.token }), /BACKUP_MAINTENANCE_TIMEOUT/);
  assert.equal((await ledger.readLatestCompletedBackup(f.db)).completedAt.getTime(), registered.completedAt.getTime());
  assert.deepEqual(await fs.readFile(file), publishedBytes);
  await newWindow();
  await assert.rejects(verifyFile(file, randomBytes(32)));
  const encrypted = await fs.readFile(file);
  for (const variant of ['tampered','truncated']) { const copy = Buffer.from(encrypted); if (variant === 'tampered') copy[Math.floor(copy.length / 2)] ^= 1; const filename = path.join(root, variant + '.klb'); await fs.writeFile(filename, variant === 'truncated' ? copy.subarray(0, copy.length - 1) : copy, { mode: 0o600 }); await assert.rejects(verifyFile(filename, key)); }
  const inspectScript = path.resolve(__dirname, '../../ops/system-backup.cjs');
  const inspectEnvironment = { ...process.env, SYSTEM_BACKUP_KEY: key.toString('hex'), MONGODB_URI: 'intentionally-invalid-no-database-connection', KL_CONTROL_MONGODB_URI: 'intentionally-invalid-no-control-connection' };
  delete inspectEnvironment.FILE_STORAGE_ROOT;
  const inspectCli = (filename, encryptionKey = key, extra = []) => promisify(execFile)(process.execPath, [inspectScript, 'inspect', '--file', filename, ...extra], { env: { ...inspectEnvironment, SYSTEM_BACKUP_KEY: encryptionKey.toString('hex') }, timeout: 30000 });
  const inspected = JSON.parse((await inspectCli(file)).stdout);
  assert.equal(inspected.command, 'inspect'); assert.equal(inspected.manifest_hash, report.manifest_hash); assert.equal(inspected.file_count, 3); assert.equal(inspected.latest_ledger_verified, false);
  assert.equal(Object.hasOwn(inspected, 'source_database'), false); assert.equal(Object.hasOwn(inspected, 'files'), false);
  await assert.rejects(inspectCli(file, randomBytes(32)), error => error.stdout === '');
  await assert.rejects(inspectCli(path.join(root, 'truncated.klb')), error => error.stdout === '');
  await assert.rejects(inspectCli(file, key, ['--restore-id', randomUUID()]), error => /INVALID_COMMAND_OPTIONS/.test(error.stderr));
  const restoredName = 'kl_restore_' + randomUUID().replaceAll('-', ''); const db = objectIdDatabase(f.client.db(restoredName));
  t.after(() => dropTestDatabase(f.uri, restoredName)); const target = await child(root, 'target');
  process.env.KL_ENVIRONMENT_ID = randomUUID();
  await assert.rejects(backupApi.restore({ client: f.client, db, file, key, root: target }), /ENVIRONMENT_MISMATCH/);
  assert.equal((await db.listCollections().toArray()).length, 0);
  process.env.KL_ENVIRONMENT_ID = environmentId;
  await ledger.reserveSafetyIntent(f.db, { operationId: randomUUID(), action: 'subject.erase', subjectId: user.user_id });
  await assert.rejects(backupApi.restore({ client: f.client, db, file, key, root: target }), error => error instanceof Error && error.message === 'PRIVACY_POLICY_UNKNOWN');
  const quarantinedState = await db.collection('operational_state').findOne({ _id: 'environment' });
  assert.equal(quarantinedState.mode, 'restore_quarantined');
  assert.equal(await db.collection('backup_restore_runs').countDocuments({ status: { $in: ['ready','released'] } }), 0);
  const restoredUser = await db.collection('users').findOne({ _id: user.user_id });
  assert.equal(restoredUser.status, 'disabled'); assert.notEqual(restoredUser.privacy_state, 'active');
  assert.equal(await db.collection('member_roles').countDocuments({}), 0);
  for (const [relative, bytes] of contents) assert.deepEqual(await fs.readFile(path.join(target, relative)), bytes);
  await assert.rejects(backupApi.verifyRestore({ db, file, key, root: target, restoreId: quarantinedState.restore_id, apply: true }), /RESTORE_QUARANTINED/);
  await assert.rejects(backupApi.restore({ client: f.client, db, file, key, root: target }), /RESTORE_TARGET_NOT_EMPTY/);
  delete process.env.KL_SAFETY_LEDGER_KEY;
  await assert.rejects(backupApi.restore({ client: f.client, db: f.client.db('kl_restore_missing_ledger'), file, key, root: await child(root, 'missing-ledger-target') }));
});

test('完整ready附件恢复后显式release，旧会话失效且重新授权后真实HTTP读取相同字节', async t => {
  const { Browser, status, PASSWORD } = require('./helpers.cjs');
  const { createHash } = require('node:crypto');
  const { executeAdministrationOperation } = require('../dist/administration/operations.js');
  const previous = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  const f = await fixture(t, { app: false });
  const root = await privateRoot(t), source = await child(root, 'clean-source');
  for (const area of ['tmp','quarantine','ready']) await child(source, area);
  const sourceUri = f.uri, environmentId = randomUUID(), controlName = 'kl_control_' + randomUUID().replaceAll('-', '');
  t.after(() => dropTestDatabase(sourceUri, controlName));
  Object.assign(process.env, { KL_ENVIRONMENT_ID: environmentId, KL_CONTROL_MONGODB_URI: sourceUri.replace(/\/kl_test_[^?]+/, '/' + controlName), KL_SAFETY_LEDGER_ROOT: await child(root, 'clean-ledger'), KL_SAFETY_LEDGER_MIRROR_ROOT: await child(root, 'clean-mirror'), KL_SAFETY_LEDGER_KEY: randomBytes(32).toString('hex'), FILE_STORAGE_ROOT: source });
  const user = await f.user(); const org = (await f.ops.createOrganization(f.context, { name: '恢复隔离原创组织', kind: 'school' })).organization_id;
  await f.ops.setMembership(f.context, { user_id: user.user_id, org_id: org, roles: ['content_editor'] });
  const administrator = await f.user();
  await f.ops.setMembership(f.context, { user_id: administrator.user_id, org_id: org, roles: ['org_admin'] });
  const editor = await f.db.collection('organization_members').findOne({ user_id: user.user_id, org_id: org });
  await f.ops.setCapability(f.context, { member_id: editor._id, org_id: org, capability: 'content:retire',
    granted: true, valid_to: new Date(Date.now() + 3600000), expected_revision: editor.authorization_revision });
  const editorMember = await f.db.collection('organization_members').findOne({ _id: editor._id });
  const memberGrant = await f.db.collection('member_capability_grants').findOne({ member_id: editor._id, capability: 'content:retire' });
  const adminMember = await f.db.collection('organization_members').findOne({ user_id: administrator.user_id, org_id: org });
  const adminScope = { kind: 'organization_ids', organization_ids: [org] };
  const administrativeGrantId = newId(), pendingRequestId = newId();
  await executeAdministrationOperation({
    client: f.client, db: f.db, actor: f.context.actor, reason: 'Explicit local administrative grant for restore evidence',
    action: 'capability.grant.account:manage',
    targets: { user_ids: [administrator.user_id], member_ids: [adminMember._id], org_ids: [org] },
    before: {}, payload: { grant_id: administrativeGrantId, member_id: adminMember._id, capability: 'account:manage', scope: adminScope },
    audit: { org_id: org, resource_id: administrativeGrantId },
    apply: async ({ session, operation_id, now }) => {
      const role = await f.db.collection('member_roles').findOne({ member_id: adminMember._id, role_id: 'org_admin' }, { session });
      assert.ok(role, 'Only an actual org_admin may receive account:manage');
      await f.db.collection('administrative_grants').insertOne({
        _id: administrativeGrantId, subject_member_id: adminMember._id, actor_org_id: org,
        capability: 'account:manage', scope: adminScope,
        scope_key: createHash('sha256').update(JSON.stringify(adminScope)).digest('hex'),
        delegate_capabilities: [], status: 'active', revision: 1, valid_from: now,
        valid_to: null, operation_id, authority: 'cli', approval_id: null, created_at: now, updated_at: now,
      }, { session });
      await f.db.collection('organization_members').updateOne({ _id: adminMember._id, status: 'active' },
        { $inc: { authorization_revision: 1 }, $set: { updated_at: now } }, { session });
      await f.db.collection('users').updateOne({ _id: administrator.user_id, status: 'active', privacy_state: 'active' },
        { $inc: { identity_revision: 1 }, $set: { updated_at: now } }, { session });
      return { grant_id: administrativeGrantId };
    },
  });
  const requesterMember = await f.db.collection('organization_members').findOne({ _id: adminMember._id });
  const requesterIdentity = await f.db.collection('users').findOne({ _id: administrator.user_id });
  const editorIdentity = await f.db.collection('users').findOne({ _id: user.user_id });
  const grantAt = new Date();
  const pendingPayload = { user_id: user.user_id, member_id: editorMember._id, org_id: org,
    roles: ['content_editor', 'content_reviewer'], status: 'active', expected_revision: editorMember.authorization_revision,
    valid_to: new Date(Date.now() + 3600000).toISOString() };
  await f.db.collection('authorization_requests').insertOne({
    _id: pendingRequestId, requester_user_id: administrator.user_id, requester_member_id: adminMember._id,
    beneficiary_user_id: user.user_id, subject_member_id: editorMember._id, action: 'member.update',
    payload: pendingPayload, payload_hash: createHash('sha256').update(JSON.stringify(pendingPayload)).digest('hex'),
    expected_grant_revision: editorMember.authorization_revision, requester_permission_revision: requesterMember.authorization_revision, requester_credential_version: requesterIdentity.credential_version,
    target_credential_version: editorIdentity.credential_version, target_identity_revision: editorIdentity.identity_revision,
    reason: 'Synthetic unapproved authorization must never replay after restore', status: 'pending', revision: 1,
    approver_user_id: null, approver_credential_version: null, approved_at: null, operation_id: null, created_at: grantAt, updated_at: grantAt,
  });
  const now = new Date(), stage = newId(), subject = newId(), textbook = newId(), edition = newId(), resource = newId(), storageKey = randomUUID();
  await f.db.collection('education_stages').insertOne({ _id: stage, code: 'restore-stage', name: '恢复测试学段', created_at: now, updated_at: now });
  await f.db.collection('subjects').insertOne({ _id: subject, code: 'restore-subject', name: '恢复测试学科', created_at: now, updated_at: now });
  await f.db.collection('textbooks').insertOne({ _id: textbook, org_id: org, title: '原创恢复教材', stage_id: stage, subject_id: subject, source: '原创合成', created_at: now, updated_at: now });
  await f.db.collection('textbook_editions').insertOne({ _id: edition, org_id: org, textbook_id: textbook, edition_code: 'restore-edition', title: '原创恢复版本', revision: 1, access_revision: 0, status: 'draft', resource_ids: [resource], access_revoked_at: null, access_revoked_by: null, access_revoked_reason: null, retired_at: null, retired_by: null, retired_reason: null, created_by: user.user_id, contributors: [user.user_id], created_at: now, updated_at: now, submitted_by: null, submitted_at: null, published_by: null, published_at: null, source_version_id: null, notes: '', license: { source: '原创合成', granted: true, expires_at: null } });
  const bytes = Buffer.from('原创隔离恢复附件\n'.repeat(100)), checksum = createHash('sha256').update(bytes).digest('hex');
  await f.db.collection('file_resources').insertOne({ _id: resource, org_id: org, owner_type: 'textbook', owner_version_id: edition, created_by: user.user_id, display_name: 'original.txt', storage_key: storageKey, declared_size: bytes.length, declared_mime: 'text/plain', declared_checksum: checksum, size: bytes.length, mime: 'text/plain', checksum, status: 'ready', scan_status: 'clean', scan_attempt: 1, lease_token: null, lease_until: null, available_at: now, uploaded_at: now, error_code: null, created_at: now, updated_at: now, retention_until: null, legal_hold: false, deletion_requested_at: null, deletion_requested_by: null, deletion_requested_reason: null, deleted_at: null, deletion_lease_token: null, deletion_lease_until: null, deletion_attempt: 0, upload_key: null, upload_lease_token: null, upload_lease_until: null, upload_storage_key: null, upload_storage_keys: [], upload_owner_revision: null, upload_result_revision: null, scan_engine_version: 'synthetic-fixture-record', scan_database_version: 'synthetic-fixture-record', scan_database_updated_at: now, scanned_at: now });
  await fs.writeFile(path.join(source, 'ready', storageKey), bytes, { flag: 'wx', mode: 0o600 });
  const laterDeletedResource = newId(), laterDeletedKey = randomUUID();
  const originalFile = await f.db.collection('file_resources').findOne({ _id: resource });
  await f.db.collection('file_resources').insertOne({ ...originalFile, _id: laterDeletedResource, storage_key: laterDeletedKey });
  await f.db.collection('textbook_editions').updateOne({ _id: edition }, { $set: { resource_ids: [resource, laterDeletedResource] } });
  await fs.writeFile(path.join(source, 'ready', laterDeletedKey), bytes, { flag: 'wx', mode: 0o600 });
  const emailKey = `restore-${randomUUID()}@example.test`, emailIdentityId = newId();
  await f.db.collection('auth_email_identities').insertOne({ _id: emailIdentityId, user_id: user.user_id, email_key: emailKey, email_display: emailKey,
    state: 'verified', verified_at: now, revision: 4, created_at: now, updated_at: now });
  await f.db.collection('auth_admissions').insertOne({ _id: newId(), user_id: user.user_id, age_band: 'adult', source: 'invite_activate',
    terms_version: 'backup-test-terms', privacy_notice_version: 'backup-test-privacy', accepted_at: now, policy_basis: 'adult_self_declaration' });
  const invitationId = newId(), inviteExpiry = new Date(Date.now() + 7 * 86400000);
  const invitePayload = { invitation_id: invitationId, org_id: org, actor_org_id: org, actor_member_id: adminMember._id,
    actor_credential_version: (await f.db.collection('users').findOne({ _id: administrator.user_id })).credential_version,
    actor_authorization_revision: (await f.db.collection('organization_members').findOne({ _id: adminMember._id })).authorization_revision,
    target_user_id: user.user_id, email_key: emailKey, roles: ['student'], valid_to: null, expires_at: inviteExpiry.toISOString(),
    member_id: editorMember._id, target_member_revision: editorMember.authorization_revision, target_credential_version: 1 };
  await f.db.collection('auth_invitations').insertOne({ _id: invitationId, org_id: org, actor_user_id: administrator.user_id, target_user_id: user.user_id,
    email_key: emailKey, roles: ['student'], valid_to: null, payload: invitePayload, payload_hash: createHash('sha256').update(require('../dist/administration/dto.js').canonical(invitePayload)).digest('hex'),
    revision: 1, state: 'pending', expires_at: inviteExpiry, accepted_user_id: null, accepted_at: null, approval_id: null, operation_id: null, created_at: now, updated_at: now });
  const challengeSession = f.client.startSession();
  try {
    await challengeSession.withTransaction(async () => {
      const challenge = await require('../dist/auth-email/tokens.js').issueEmailChallenge(f.db, challengeSession, {
        purpose: 'invite', userId: user.user_id, email: { key: emailKey, display: emailKey }, invitationId, invitationRevision: 1,
        credentialVersion: 1, emailRevision: 4, durationMs: 7 * 86400000 });
      await f.db.collection('auth_mail_outbox').insertOne({ _id: newId(), challenge_id: challenge.id, user_id: user.user_id, invitation_id: invitationId, purpose: 'invite',
        recipient_key_hash: createHash('sha256').update(emailKey).digest('hex'), actor_user_id: administrator.user_id,
        transport_token: null, transport_writer_id: null, transport_closed_at: now,
        status: 'sent', encrypted_payload: null, key_id: 'backup-test', expires_at: challenge.expiresAt, lease_token: null, lease_until: null,
        safe_error_code: '', created_at: now, updated_at: now }, { session: challengeSession });
    });
  } finally { await challengeSession.endSession(); }
  await control.registerEnvironment(f.client, f.db, { environmentId, actor: 'restore-test', reason: 'original synthetic fixture', fileRoot: source });
  const started = await f.start(); const browser = started.browser;
  await browser.prepare(); status(await browser.login(user.login_name, user.secret), 200); await browser.prepare();
  status(await browser.request('/auth/change-password', { method: 'POST', body: { current_password: user.secret, new_password: PASSWORD } }), 204);
  await browser.prepare(); status(await browser.login(user.login_name, PASSWORD), 200);
  const oldCookies = new Map(browser.cookies); await started.app.close();
  const state = await f.db.collection('operational_state').findOne({ _id: 'environment' });
  const gate = await control.enterMaintenance(f.client, f.db, { actor: 'restore-test', reason: 'snapshot', expectedRevision: state.revision });
  const archive = path.join(root, 'clean.klb'), key = randomBytes(32);
  await f.db.createCollection('unexpected_backup_collection');
  await assert.rejects(backupApi.backup({ client: f.client, db: f.db, file: archive, key, root: source, maintenanceToken: gate.token }), /UNKNOWN_COLLECTION/);
  await rawDatabase(f.db).collection('unexpected_backup_collection').drop();
  const result = await backupApi.backup({ client: f.client, db: f.db, file: archive, key, root: source, maintenanceToken: gate.token }); assert.equal(result.unresolved, 0);
  const archivedAuthorization = await verifyFile(archive, key);
  assert.equal(archivedAuthorization.manifest.counts.administrative_grants, 1);
  assert.equal(archivedAuthorization.manifest.counts.authorization_requests, 1);
  assert.equal(archivedAuthorization.manifest.counts.member_capability_grants, 1);
  assert.equal(archivedAuthorization.manifest.counts.auth_email_identities, 1); assert.equal(archivedAuthorization.manifest.counts.auth_admissions, 1);
  for (const name of ['auth_email_challenges', 'auth_invitations', 'auth_mail_outbox']) {
    assert.equal(Object.hasOwn(archivedAuthorization.manifest.counts, name), false);
    assert.ok(await f.db.collection(name).countDocuments({}) > 0);
  }
  await f.db.collection('member_capability_grants').updateOne({ _id: memberGrant._id }, { $set: { status: 'revoked', updated_at: new Date() }, $inc: { revision: 1 } });
  await f.db.collection('administrative_grants').updateOne({ _id: administrativeGrantId }, { $set: { status: 'revoked', updated_at: new Date() }, $inc: { revision: 1 } });
  const retainUntil = new Date(Date.now() + 86400000);
  const hold = await ledger.reserveSafetyIntent(f.db, { operationId: randomUUID(), action: 'file.hold', resourceType: 'file', resourceId: resource, hold: true });
  await f.db.collection('file_resources').updateOne({ _id: resource }, { $set: { legal_hold: true } }); await ledger.confirmSafetyIntent(f.db, hold);
  const retention = await ledger.reserveSafetyIntent(f.db, { operationId: randomUUID(), action: 'file.retention', resourceType: 'file', resourceId: resource, retentionUntil: retainUntil });
  await f.db.collection('file_resources').updateOne({ _id: resource }, { $set: { retention_until: retainUntil } }); await ledger.confirmSafetyIntent(f.db, retention);
  const restoredName = 'kl_restore_' + randomUUID().replaceAll('-', ''), db = objectIdDatabase(f.client.db(restoredName)), target = await child(root, 'clean-target');
  t.after(() => dropTestDatabase(sourceUri, restoredName));
  const restore = await backupApi.restore({ client: f.client, db, file: archive, key, root: target });
  for (const name of ['member_capability_grants', 'administrative_grants', 'authorization_requests', 'administration_operations', 'auth_email_challenges', 'auth_invitations', 'auth_mail_outbox'])
    assert.equal(await db.collection(name).countDocuments({}), 0, `${name} from archive must not regain effect`);
  const restoredEmail = await db.collection('auth_email_identities').findOne({ _id: emailIdentityId });
  assert.equal(restoredEmail.state, 'needs_reverify'); assert.equal(restoredEmail.verified_at, null); assert.equal(restoredEmail.revision, 5);
  assert.equal((await db.collection('auth_admissions').findOne({ user_id: user.user_id })).terms_version, 'backup-test-terms');
  const restoreGuard = await db.collection('administration_guard').findOne({ _id: 'administration' });
  assert.equal(restoreGuard.state, 'idle'); assert.equal(restoreGuard.recovery_token, null);
  assert.deepEqual(restoreGuard.blocked_targets, { user_ids: [], member_ids: [], org_ids: [], global: false });
  const restoredResource = await db.collection('file_resources').findOne({ _id: resource });
  assert.equal(restoredResource.legal_hold, true); assert.equal(restoredResource.retention_until.getTime(), retainUntil.getTime());
  const input = { db, file: archive, key, root: target, restoreId: restore.restore_id, apply: true };
  await fs.writeFile(path.join(target, 'ready', storageKey), bytes.subarray(0, 5));
  assert.equal((await backupApi.verifyRestore(input)).status, 'quarantined');
  await fs.unlink(path.join(target, 'ready', storageKey));
  assert.equal((await backupApi.verifyRestore(input)).status, 'quarantined');
  await fs.writeFile(path.join(target, 'ready', storageKey), bytes, { flag: 'wx', mode: 0o600 });
  const proof = await backupApi.verifyRestore(input); assert.equal(proof.status, 'ready'); assert.deepEqual(await fs.readFile(path.join(target, 'ready', storageKey)), bytes);
  process.env.FILE_STORAGE_ROOT = target;
  await control.releaseRestoredLocal(f.client, db, { restoreId: restore.restore_id, actor: 'restore-test', reason: 'verified local recovery', expectedRevision: proof.environment_revision, manifestHash: proof.manifest_hash, ledgerSequence: proof.ledger_sequence });
  assert.equal(await db.collection('member_roles').countDocuments({}), 0);
  process.env.MONGODB_URI = sourceUri.replace(/\/kl_test_[^?]+/, '/' + restoredName); process.env.FILE_STORAGE_ROOT = target;
  const restoredApp = await f.start(); const old = new Browser(restoredApp.browser.base); old.cookies = oldCookies;
  assert.equal((await old.request('/me')).status, 401);
  const context = { ...f.context, db };
  const reset = await f.ops.resetPassword(context, { user_id: user.user_id });
  await f.ops.setUserStatus(context, { user_id: user.user_id, status: 'active' });
  const member = await db.collection('organization_members').findOne({ user_id: user.user_id, org_id: org });
  await f.ops.setMembership(context, { user_id: user.user_id, org_id: org, roles: ['content_editor'], status: 'active', expected_revision: member.authorization_revision });
  const fresh = restoredApp.browser; await fresh.prepare(); status(await fresh.login(user.login_name, reset.secret), 200); await fresh.prepare();
  status(await fresh.request('/auth/change-password', { method: 'POST', body: { current_password: reset.secret, new_password: PASSWORD } }), 204);
  await fresh.prepare(); status(await fresh.login(user.login_name, PASSWORD), 200);
  const emailBrowser = new Browser(fresh.base); await emailBrowser.prepare(); status(await emailBrowser.login(emailKey, PASSWORD), 401);
  const response = await fetch(fresh.base + '/api/v1/admin/files/' + resource + '/content', { headers: { 'X-Org-Id': org, Cookie: [...fresh.cookies].map(([k,v]) => k + '=' + v).join('; ') } });
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  await restoredApp.app.close();
  // A later source deletion is not evidence that the older target lacks references.
  process.env.MONGODB_URI = sourceUri; process.env.FILE_STORAGE_ROOT = source;
  await f.db.collection('textbook_editions').updateOne({ _id: edition }, { $set: { resource_ids: [resource] }, $inc: { access_revision: 1 } });
  const { fileReferenced } = require('../dist/files/references.js');
  assert.equal(await fileReferenced(f.db, laterDeletedResource, undefined), false);
  const past = new Date(Date.now() - 60000);
  const expiry = await ledger.reserveSafetyIntent(f.db, { operationId: randomUUID(), action: 'file.retention', resourceType: 'file', resourceId: laterDeletedResource, retentionUntil: past });
  await f.db.collection('file_resources').updateOne({ _id: laterDeletedResource }, { $set: { retention_until: past } }); await ledger.confirmSafetyIntent(f.db, expiry);
  const deletion = await ledger.reserveSafetyIntent(f.db, { operationId: randomUUID(), action: 'file.deleted', resourceType: 'file', resourceId: laterDeletedResource });
  await fs.unlink(path.join(source, 'ready', laterDeletedKey));
  await f.db.collection('file_resources').updateOne({ _id: laterDeletedResource }, { $set: { status: 'deleting', deletion_requested_at: past, deletion_requested_by: user.user_id, deletion_requested_reason: 'synthetic source lawful deletion', deleted_at: new Date(), updated_at: new Date() } });
  await ledger.confirmSafetyIntent(f.db, deletion);
  const referencedName = 'kl_restore_' + randomUUID().replaceAll('-', ''), referencedDb = objectIdDatabase(f.client.db(referencedName)), referencedRoot = await child(root, 'old-referenced-target');
  t.after(() => dropTestDatabase(sourceUri, referencedName));
  const referencedRestore = await backupApi.restore({ client: f.client, db: referencedDb, file: archive, key, root: referencedRoot });
  const blocked = await backupApi.verifyRestore({ db: referencedDb, file: archive, key, root: referencedRoot, restoreId: referencedRestore.restore_id, apply: true });
  assert.equal(blocked.status, 'quarantined'); assert.equal(blocked.checks.files, false);
  assert.equal(blocked.blocked_references, 1); assert.ok(blocked.remaining_actions.includes('FILE_REFERENCE_RECONCILIATION_REQUIRED'));
  assert.equal(await fileReferenced(referencedDb, laterDeletedResource, undefined), true);
  assert.deepEqual(await fs.readFile(path.join(referencedRoot, 'ready', laterDeletedKey)), bytes);
  assert.equal((await referencedDb.collection('file_resources').findOne({ _id: laterDeletedResource })).deleted_at, null);
  await referencedDb.dropDatabase(); await db.dropDatabase(); await f.client.db(controlName).dropDatabase();
  for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name]; Object.assign(process.env, previous);
});

test('旧包无隐私申请：源真实审批执行后亡源，仅独立最新签名账本即可恢复擦除', async t => {
  const privacy = require('../dist/privacy/execution.js');
  const { PRIVACY_POLICY_REVISION } = require('../dist/privacy/schema.js');
  const previous = { ...process.env };
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name]; Object.assign(process.env, previous); });
  const f = await fixture(t, { app: false }); const user = await f.user();
  const org = (await f.ops.createOrganization(f.context, { name: '亡源恢复合成组织', kind: 'school' })).organization_id;
  await f.ops.setMembership(f.context, { user_id: user.user_id, org_id: org, roles: ['student'] });
  const member = await f.db.collection('organization_members').findOne({ user_id: user.user_id, org_id: org });
  await f.db.collection('reading_progress').insertOne({ _id: newId(), org_id: org, member_id: member._id, chapter_id: newId(), edition_id: newId(), edition_revision: 1, position: { kind: 'text_offset', offset_utf16: 0 }, completed: false, revision: 1, updated_at: new Date(), cleared_at: null });
  const emailAt = new Date(), emailKey = `erased-${randomUUID()}@example.test`;
  await f.db.collection('auth_email_identities').insertOne({ _id: newId(), user_id: user.user_id, email_key: emailKey, email_display: emailKey,
    state: 'verified', verified_at: emailAt, revision: 1, created_at: emailAt, updated_at: emailAt });
  await f.db.collection('auth_admissions').insertOne({ _id: newId(), user_id: user.user_id, age_band: 'adult', source: 'public_register',
    terms_version: 'backup-erasure-terms', privacy_notice_version: 'backup-erasure-privacy', accepted_at: emailAt, policy_basis: 'adult_self_declaration' });
  const root = await privateRoot(t), source = await child(root, 'erasure-source');
  for (const area of ['tmp','quarantine','ready']) await child(source, area);
  const controlName = 'kl_control_' + randomUUID().replaceAll('-', ''), environmentId = randomUUID();
  t.after(() => dropTestDatabase(f.uri, controlName));
  Object.assign(process.env, { KL_ENVIRONMENT_ID: environmentId, KL_CONTROL_MONGODB_URI: f.uri.replace(/\/kl_test_[^?]+/, '/' + controlName), KL_SAFETY_LEDGER_ROOT: await child(root, 'erasure-ledger'), KL_SAFETY_LEDGER_MIRROR_ROOT: await child(root, 'erasure-mirror'), KL_SAFETY_LEDGER_KEY: randomBytes(32).toString('hex'), FILE_STORAGE_ROOT: source });
  const operator = { actor: 'source-loss-test', reason: 'original synthetic committed erasure proof' };
  await control.registerEnvironment(f.client, f.db, { environmentId, fileRoot: source, ...operator });
  const state = await f.db.collection('operational_state').findOne({ _id: 'environment' });
  const gate = await control.enterMaintenance(f.client, f.db, { expectedRevision: state.revision, ...operator });
  const file = path.join(root, 'before-request.klb'), key = randomBytes(32);
  await backupApi.backup({ client: f.client, db: f.db, file, key, root: source, maintenanceToken: gate.token });
  const archived = await verifyFile(file, key); assert.equal(archived.manifest.counts.privacy_deletion_requests, 0);
  await control.leaveMaintenance(f.client, f.db, { token: gate.token, ...operator });
  const now = new Date(), requestId = newId();
  await f.db.collection('privacy_deletion_requests').insertOne({ _id: requestId, user_id: user.user_id, scope: 'account', policy_revision: PRIVACY_POLICY_REVISION, status: 'requested', revision: 0, plan_hash: null, actor: null, reason_code: null, deleted_categories: [], retained_categories: [], retention_basis: null, remaining_actions: [], created_at: now, updated_at: now, lease_token: null, lease_until: null, ledger_sequence: null, completed_steps: [] });
  const plan = await privacy.inspectPrivacyRequest(f.db, requestId);
  await privacy.approvePrivacyRequest(f.client, f.db, { requestId, expectedRevision: plan.revision, planHash: plan.plan_hash, retentionBasis: 'local_minimal_provenance', ...operator });
  await privacy.executePrivacyRequest(f.client, f.db, { requestId, ...operator });
  const safety = await ledger.readSafetyLedger(environmentId, 0), committed = safety.entries.find(entry => entry.privacyRequestId === requestId && entry.state === 'committed');
  assert.equal(safety.pending, false); assert.equal(committed.state, 'committed');
  assert.equal(committed.privacyPolicyRevision, PRIVACY_POLICY_REVISION); assert.equal(committed.privacyRetentionBasis, 'local_minimal_provenance');
  assert.equal((await f.db.collection('users').findOne({ _id: user.user_id })).privacy_state, 'erased');
  await f.db.dropDatabase(); // Source requests/rows are genuinely unavailable, not mocked out.
  assert.equal((await f.db.listCollections().toArray()).length, 0);
  const targetName = 'kl_restore_' + randomUUID().replaceAll('-', ''), db = objectIdDatabase(f.client.db(targetName)), target = await child(root, 'erasure-target');
  t.after(() => dropTestDatabase(f.uri, targetName));
  const restored = await backupApi.restore({ client: f.client, db, file, key, root: target });
  assert.equal(restored.pending, false);
  const restoredUser = await db.collection('users').findOne({ _id: user.user_id });
  assert.equal(restoredUser.privacy_state, 'erased'); assert.equal(restoredUser.status, 'disabled');
  assert.equal(await db.collection('reading_progress').countDocuments({ member_id: member._id }), 0);
  assert.equal(await db.collection('auth_email_identities').countDocuments({ user_id: user.user_id }), 0);
  assert.equal(await db.collection('auth_admissions').countDocuments({ user_id: user.user_id }), 0);
  assert.equal((await db.collection('privacy_tombstones').findOne({ user_id: user.user_id })).state, 'erased');
  const restoredRequest = await db.collection('privacy_deletion_requests').findOne({ _id: requestId });
  assert.ok(['completed','completed_with_retention'].includes(restoredRequest.status));
  const proof = await backupApi.verifyRestore({ db, file, key, root: target, restoreId: restored.restore_id, apply: true });
  assert.equal(proof.status, 'ready'); process.env.FILE_STORAGE_ROOT = target;
  await control.releaseRestoredLocal(f.client, db, { restoreId: restored.restore_id, expectedRevision: proof.environment_revision, manifestHash: proof.manifest_hash, ledgerSequence: proof.ledger_sequence, ...operator });
  await assert.rejects(f.ops.setUserStatus({ ...f.context, db }, { user_id: user.user_id, status: 'active' }));
});

test('legacy真实v1备份可verify，v3扩展审计不产出自我不可读包', async t => {
  const f = await fixture(t, { app: false, migrated: false });
  const { migrateVersion1, migrateVersion3 } = require('../dist/migrations/schema.js');
  await migrateVersion1(f.uri);
  const root = await privateRoot(t), key = randomBytes(32).toString('hex');
  const script = path.resolve(__dirname, '../../ops/auth-backup.cjs');
  const run = (command, file) => promisify(execFile)(process.execPath, [script, command, '--file', file], { env: { ...process.env, MONGODB_URI: f.uri, AUTH_BACKUP_KEY: key }, timeout: 60000 });
  const supported = path.join(root, 'legacy-readable.klb');
  const written = await run('backup', supported); assert.equal(JSON.parse(written.stdout).command, 'backup');
  const inspected = await run('verify', supported); assert.equal(JSON.parse(inspected.stdout).format, 'legacy-auth-v1');
  await migrateVersion3(f.uri);
  await f.db.collection('audit_events').insertOne({ _id: randomUUID(), actor_id: 'legacy-format-test', org_id: null, action: 'content.synthetic', resource_id: randomUUID(), reason: 'original synthetic extended audit', request_id: randomUUID(), created_at: new Date(), resource_type: 'textbook', owner_type: 'textbook', owner_version_id: randomUUID(), revision_before: null, revision_after: 1, access_revision_before: null, access_revision_after: 0 });
  const unsupported = path.join(root, 'legacy-incompatible.klb');
  await assert.rejects(run('backup', unsupported), error => /LEGACY_BACKUP_UNSUPPORTED_DATA/.test(error.stderr));
  await assert.rejects(fs.stat(unsupported), { code: 'ENOENT' });
});

test('精确pre-v22全业务包白名单保留双遍验证并补当前邮箱空schema，不接受改checksum的近似registry', async t => {
  const { BSON } = require('mongodb'), schema = require('../dist/migrations/schema.js');
  const previous = { ...process.env };
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name]; Object.assign(process.env, previous); });
  const f = await fixture(t, { app: false, env: { KL_TRAINING_ENABLED: 'false', KL_COURSEWORK_FILES_ENABLED: 'false', KL_AI_POLICY_ENABLED: 'false',
    KL_TRAINING_REPORTS_ENABLED: 'false', KL_TRAINING_PHASE2_ENABLED: 'false', KL_AI_LEARNING_REPORTS_ENABLED: 'false', KL_KNOWLEDGE_ENABLED: 'false',
    KL_KNOWLEDGE_IMPORT_ENABLED: 'false', KL_TRAINING_SURVEYS_ENABLED: 'false', KL_STANDALONE_RECOVERY_ENABLED: 'false', KL_STANDALONE_MANAGED_API_ENABLED: 'false',
    KL_AUTH_EMAIL_ENABLED: 'false', KL_PUBLIC_REGISTRATION_ENABLED: 'false' } }), user = await f.user();
  const root = await privateRoot(t), source = await child(root, 'legacy-registry-source');
  for (const area of ['tmp', 'quarantine', 'ready']) await child(source, area);
  const environmentId = randomUUID(), controlName = 'kl_control_' + randomUUID().replaceAll('-', '');
  t.after(() => dropTestDatabase(f.uri, controlName));
  Object.assign(process.env, { KL_ENVIRONMENT_ID: environmentId, KL_CONTROL_MONGODB_URI: f.uri.replace(/\/kl_test_[^?]+/, '/' + controlName),
    KL_SAFETY_LEDGER_ROOT: await child(root, 'legacy-registry-ledger'), KL_SAFETY_LEDGER_MIRROR_ROOT: await child(root, 'legacy-registry-mirror'),
    KL_SAFETY_LEDGER_KEY: randomBytes(32).toString('hex'), FILE_STORAGE_ROOT: source });
  const operator = { actor: 'legacy-email-registry-test', reason: '合成精确旧registry恢复' };
  await control.registerEnvironment(f.client, f.db, { environmentId, fileRoot: source, ...operator });
  const state = await f.db.collection('operational_state').findOne({ _id: 'environment' });
  await control.enterMaintenance(f.client, f.db, { expectedRevision: state.revision, ...operator });
  const legacy = schema.supportedSystemBackupRegistries()[0], key = randomBytes(32);
  assert.equal(legacy.version, 10);
  const documents = [];
  for (const name of legacy.collections.filter(name => !legacy.excluded.includes(name))) {
    for await (const row of rawDatabase(f.db).collection(name).find({}, { promoteValues: false, promoteLongs: false })) {
      if (name === 'schema_migrations' && Number(row.version) === 22) continue;
      documents.push({ name, row });
    }
  }
  async function archive(file, registry, changedMarker = false) {
    const frames = documents.map(({ name, row }) => ({ name, bytes: BSON.serialize(changedMarker && name === 'schema_migrations' && Number(row.version) === 10 ? { ...row, checksum: '0'.repeat(64) } : row) }));
    const counts = Object.fromEntries(registry.collections.filter(name => !registry.excluded.includes(name)).map(name => [name, 0]));
    const manifest = { format: 1, backup_id: randomUUID(), environment_id: environmentId, source_database: f.db.databaseName,
      source_cluster_hash: await ledger.readDatabaseClusterIdentity(f.db), source_root_hash: archiveApi.hash(await fs.realpath(source)), created_at: new Date().toISOString(),
      registry, ledger_sequence: (await ledger.readSafetyLedger(environmentId, 0)).sequence, db_bytes: frames.reduce((sum, frame) => sum + frame.bytes.length, 0), counts, files: [], missing: [] };
    for (const frame of frames) counts[frame.name]++;
    const writer = await archiveApi.createArchive(file, key);
    try {
      await writer.frame({ kind: 'header', manifest });
      const indexes = Object.fromEntries(Object.keys(counts).map(name => [name, 0]));
      for (const frame of frames) {
        assert.ok(frame.bytes.length <= archiveApi.CHUNK);
        await writer.frame({ kind: 'db', collection: frame.name, index: indexes[frame.name]++, part: 0, last: true, data: frame.bytes.toString('base64') });
      }
      await writer.publish(manifest);
    } catch (error) { await writer.abort(); throw error; }
  }
  const file = path.join(root, 'pre-v22.klb'); await archive(file, legacy);
  const authenticated = await verifyFile(file, key); assert.equal(authenticated.manifest.registry.version, 10);
  const invalidRegistryFile = path.join(root, 'near-registry.klb');
  await archive(invalidRegistryFile, { ...legacy, checksums: { ...legacy.checksums, '10': '0'.repeat(64) } });
  await assert.rejects(verifyFile(invalidRegistryFile, key), /BACKUP_REGISTRY_UNSUPPORTED/);
  const invalidMarkerFile = path.join(root, 'bad-marker.klb'); await archive(invalidMarkerFile, legacy, true);
  await assert.rejects(verifyFile(invalidMarkerFile, key), /BACKUP_SCHEMA_MARKER_INVALID/);
  const targetName = 'kl_restore_' + randomUUID().replaceAll('-', ''), db = objectIdDatabase(f.client.db(targetName)), target = await child(root, 'legacy-registry-target');
  t.after(() => dropTestDatabase(f.uri, targetName));
  await assert.rejects(backupApi.restore({ client: f.client, db, file: invalidRegistryFile, key, root: target }), /BACKUP_REGISTRY_UNSUPPORTED/);
  assert.equal((await db.listCollections().toArray()).length, 0);
  const restored = await backupApi.restore({ client: f.client, db, file, key, root: target });
  const marker = await db.collection('schema_migrations').findOne({ version: 22 });
  assert.equal(marker.status, 'completed'); assert.equal(marker.checksum, schema.AUTH_EMAIL_CHECKSUM);
  assert.equal((await db.collection('users').findOne({ _id: user.user_id })).status, 'disabled');
  for (const name of ['auth_email_identities', 'auth_admissions', 'auth_email_challenges', 'auth_invitations', 'auth_mail_outbox'])
    assert.equal(await db.collection(name).countDocuments({}), 0);
  await schema.assertSchema(db);
  const proof = await backupApi.verifyRestore({ db, file, key, root: target, restoreId: restored.restore_id, apply: true });
  assert.equal(proof.status, 'ready'); assert.equal(proof.checks.identities, true); assert.equal(proof.checks.ledger, true);
});
