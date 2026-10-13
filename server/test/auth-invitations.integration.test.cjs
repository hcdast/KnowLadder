"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { administrationFixture, consoleRequest, PASSWORD, status } = require('./administration-helpers.cjs');
const { Browser } = require('./helpers.cjs');
const { newId } = require('../dist/database/object-id.js');
const { canonical } = require('../dist/administration/dto.js');
const { executeAdministrationOperation } = require('../dist/administration/operations.js');
const { issueEmailChallenge } = require('../dist/auth-email/tokens.js');

async function verifiedEmail(f, actor) {
  const now = new Date(), email = `invited-${randomUUID()}@example.test`;
  const identity = { _id: newId(), user_id: actor.user.user_id, email_key: email, email_display: email,
    state: 'verified', verified_at: now, revision: 1, created_at: now, updated_at: now };
  await f.db.collection('auth_email_identities').insertOne(identity);
  return identity;
}
// Arrange a previously audited invitation while SMTP initiation is disabled.
// These tests exercise consumption/authority transitions, not fake delivery.
async function invitation(f, target, identity, extras = {}) {
  const issuer = extras.issuer ?? f.accounts;
  const user = await f.db.collection('users').findOne({ _id: target.user.user_id });
  const actorUser = await f.db.collection('users').findOne({ _id: issuer.user.user_id });
  const actorMember = await f.db.collection('organization_members').findOne({ _id: issuer.memberId });
  const member = await f.db.collection('organization_members').findOne({ user_id: user._id, org_id: f.schoolA });
  const id = newId(), expiresAt = new Date(Date.now() + 7 * 86400000), key = randomUUID();
  const payload = { invitation_id: id, org_id: f.schoolA, actor_org_id: issuer.org, actor_member_id: issuer.memberId,
    actor_credential_version: actorUser.credential_version, actor_authorization_revision: actorMember.authorization_revision,
    target_user_id: user._id, email_key: identity.email_key, roles: ['student'], valid_to: null, expires_at: expiresAt.toISOString(),
    member_id: member?._id ?? newId(), target_member_revision: member?.authorization_revision ?? null, target_credential_version: user.credential_version };
  let challenge;
  const operation = await executeAdministrationOperation({ db: f.db, client: f.client, actor: issuer.user.user_id, action: 'invitation.create', reason: '合成邀请消费边界', key,
    before: { actorCredentialVersion: actorUser.credential_version, actorMemberId: issuer.memberId },
    payload: { invitation_id: id, org_id: f.schoolA, email_key: identity.email_key, roles: ['student'], valid_to: null, actorOrgId: issuer.org },
    targets: { user_ids: [user._id], org_ids: [f.schoolA] }, audit: { actor_org_id: issuer.org, org_id: f.schoolA, resource_id: id },
    apply: async ({ session, now, operation_id }) => {
      await f.db.collection('auth_invitations').insertOne({ _id: id, org_id: f.schoolA, actor_user_id: issuer.user.user_id,
        target_user_id: user._id, email_key: identity.email_key, roles: ['student'], valid_to: null, payload,
        payload_hash: createHash('sha256').update(canonical(payload)).digest('hex'), revision: 1, state: 'pending', expires_at: expiresAt,
        accepted_user_id: null, accepted_at: null, approval_id: null, operation_id, created_at: now, updated_at: now }, { session });
      challenge = await issueEmailChallenge(f.db, session, { purpose: 'invite', userId: user._id,
        email: { key: identity.email_key, display: identity.email_display }, invitationId: id, invitationRevision: 1,
        credentialVersion: user.credential_version, emailRevision: identity.revision, durationMs: 7 * 86400000 });
      return { invitation_id: id };
    },
  });
  return { id, key, operationId: operation.operation_id, token: challenge.token, challengeId: challenge.id, payload };
}
const post = (browser, action, body, extra = {}) => browser.request(`/auth/invitations/${action}`, { method: 'POST', body, ...extra });

test('邀请消费与原key恢复安全边界（真实副本集HTTP）', { concurrency: false, timeout: 600000 }, async t => {
  await t.test('当前CSRF矩阵、跨设备固定邮箱账号、单次消费和无secret原key回执', async t => {
    const f = await administrationFixture(t, 'replicaSet', { env: { KL_AUTH_EMAIL_ENABLED: 'false', KL_PUBLIC_REGISTRATION_ENABLED: 'false' } });
    const identity = await verifiedEmail(f, f.studentB), invitationRow = await invitation(f, f.studentB, identity);
    const anonymous = new Browser(f.browser.base); await anonymous.prepare();
    status(await post(anonymous, 'accept', { token: invitationRow.token }), 401);
    status(await post(anonymous, 'inspect', { token: invitationRow.token }, { csrf: 'wrong-csrf' }), 403);
    const inspected = await post(anonymous, 'inspect', { token: invitationRow.token }); status(inspected, 200);
    assert.equal(inspected.data.data.action, 'accept');
    assert.deepEqual(Object.keys(inspected.data.data).sort(), ['action', 'expires_at', 'invitation_id', 'organization', 'state']);
    assert.equal((await f.db.collection('auth_email_challenges').findOne({ _id: invitationRow.challengeId })).status, 'pending');
    status(await post(f.studentA.browser, 'accept', { token: invitationRow.token }), 409);
    assert.equal(await f.db.collection('organization_members').countDocuments({ user_id: f.studentB.user.user_id, org_id: f.schoolA }), 0);
    // Normal authenticated activity changes identity_revision, not challenge validity.
    status(await f.studentB.browser.request('/me'), 200);
    const issuerBefore = await f.db.collection('organization_members').findOne({ _id: f.accounts.memberId });
    status(await f.accounts.browser.request('/me', { headers: { 'X-Org-Id': f.accounts.org } }), 200);
    status(await consoleRequest(f.accounts, '/context'), 200);
    const issuerAfter = await f.db.collection('organization_members').findOne({ _id: f.accounts.memberId });
    assert.ok(issuerAfter.authorization_revision > issuerBefore.authorization_revision);
    const otherDevice = new Browser(f.browser.base); await otherDevice.prepare();
    status(await otherDevice.login(identity.email_key, PASSWORD), 200); await otherDevice.prepare();
    const accepted = await post(otherDevice, 'accept', { token: invitationRow.token }); status(accepted, 200);
    const member = await f.db.collection('organization_members').findOne({ _id: accepted.data.data.member_id });
    assert.equal(member.user_id, f.studentB.user.user_id); assert.equal(member.org_id, f.schoolA); assert.equal(member.status, 'active');
    assert.deepEqual((await f.db.collection('member_roles').find({ member_id: member._id }).toArray()).map(row => row.role_id), ['student']);
    status(await post(otherDevice, 'accept', { token: invitationRow.token }), 409);
    const recovered = await consoleRequest(f.accounts, `/operations?key=${invitationRow.key}`); status(recovered, 200);
    assert.equal(recovered.data.data.items[0].invitation_state, 'accepted');
    assert.equal(recovered.data.data.items[0].invitation_id, invitationRow.id);
    assert.equal(JSON.stringify(recovered.data).includes(invitationRow.token), false);
    assert.equal(await f.db.collection('auth_mail_outbox').countDocuments({ invitation_id: invitationRow.id }), 0);
  });
  await t.test('关闭SMTP仍可撤销，原key恢复不重新签发，旧链接立即失效', async t => {
    const f = await administrationFixture(t, 'replicaSet', { env: { KL_AUTH_EMAIL_ENABLED: 'false', KL_PUBLIC_REGISTRATION_ENABLED: 'false' } });
    const identity = await verifiedEmail(f, f.studentB), invitationRow = await invitation(f, f.studentB, identity), key = randomUUID();
    const request = { method: 'POST', key, body: { expected_revision: 1, reason: '撤销合成邀请', current_password: PASSWORD } };
    const revoked = await consoleRequest(f.accounts, `/invitations/${invitationRow.id}/revoke`, request); status(revoked, 200);
    assert.equal(revoked.data.data.invitation_state, 'revoked');
    const again = await consoleRequest(f.accounts, `/invitations/${invitationRow.id}/revoke`, request); status(again, 200);
    assert.equal(again.data.data.operation_id, revoked.data.data.operation_id); assert.equal(again.data.data.replayed, true);
    assert.equal((await f.db.collection('auth_email_challenges').findOne({ _id: invitationRow.challengeId })).status, 'revoked');
    status(await post(f.studentB.browser, 'accept', { token: invitationRow.token }), 409);
    assert.equal(await f.db.collection('organization_members').countDocuments({ user_id: f.studentB.user.user_id, org_id: f.schoolA }), 0);
  });
  await t.test('等待期间变成受保护账号、操作者撤权、邀请payload变化均不能授予成员', async t => {
    const f = await administrationFixture(t, 'replicaSet', { env: { KL_AUTH_EMAIL_ENABLED: 'false', KL_PUBLIC_REGISTRATION_ENABLED: 'false' } });
    const identity = await verifiedEmail(f, f.studentB), invitationRow = await invitation(f, f.studentB, identity);
    const member = await f.db.collection('organization_members').findOne({ _id: f.studentB.memberId });
    const now = new Date(), pendingId = newId();
    await f.db.collection('member_capability_grants').insertOne({ _id: pendingId, org_id: member.org_id, member_id: member._id, capability: 'assessment:review',
      status: 'pending', revision: 1, valid_from: now, valid_to: new Date(Date.now() + 3600000), operation_id: null, authority: 'legacy', created_at: now, updated_at: now });
    const protectedResult = await post(f.studentB.browser, 'accept', { token: invitationRow.token }); status(protectedResult, 403);
    assert.equal(protectedResult.data.error.code, 'PROTECTED_ACCOUNT');
    await f.db.collection('member_capability_grants').deleteOne({ _id: pendingId });
    await f.db.collection('auth_invitations').updateOne({ _id: invitationRow.id }, { $set: { roles: ['teacher'] } });
    status(await post(f.studentB.browser, 'accept', { token: invitationRow.token }), 409);
    await f.db.collection('auth_invitations').updateOne({ _id: invitationRow.id }, { $set: { roles: ['student'] } });
    await f.db.collection('administrative_grants').updateMany({ subject_member_id: f.accounts.memberId, capability: 'account:platform-manage' }, { $set: { status: 'revoked', updated_at: new Date() }, $inc: { revision: 1 } });
    status(await post(f.studentB.browser, 'accept', { token: invitationRow.token }), 403);
    assert.equal((await f.db.collection('auth_email_challenges').findOne({ _id: invitationRow.challengeId })).status, 'pending');
    assert.equal((await f.db.collection('auth_invitations').findOne({ _id: invitationRow.id })).state, 'pending');
    assert.equal(await f.db.collection('organization_members').countDocuments({ user_id: f.studentB.user.user_id, org_id: f.schoolA }), 0);
  });
  await t.test('既有本组织成员接受邀请不能替换教师角色或撤销原grant', async t => {
    const f = await administrationFixture(t, 'replicaSet', { env: { KL_AUTH_EMAIL_ENABLED: 'false', KL_PUBLIC_REGISTRATION_ENABLED: 'false' } });
    const identity = await verifiedEmail(f, f.studentA);
    const target = await f.db.collection('organization_members').findOne({ _id: f.studentA.memberId });
    await f.ops.setMembership(f.context, { user_id: f.studentA.user.user_id, org_id: f.schoolA, roles: ['teacher'], expected_revision: target.authorization_revision });
    const teacher = await f.db.collection('organization_members').findOne({ _id: f.studentA.memberId });
    await f.ops.setCapability(f.context, { member_id: teacher._id, org_id: f.schoolA, capability: 'assessment:manage', granted: true, expected_revision: teacher.authorization_revision });
    const invitationRow = await invitation(f, f.studentA, identity);
    const before = await f.db.collection('organization_members').findOne({ _id: teacher._id });
    const roles = await f.db.collection('member_roles').find({ member_id: teacher._id }).toArray();
    const grants = await f.db.collection('member_capability_grants').find({ member_id: teacher._id }).toArray();
    const response = await post(f.studentA.browser, 'accept', { token: invitationRow.token }); status(response, 409);
    assert.equal(response.data.error.code, 'MEMBER_EXISTS');
    assert.deepEqual(await f.db.collection('organization_members').findOne({ _id: teacher._id }), before);
    assert.deepEqual(await f.db.collection('member_roles').find({ member_id: teacher._id }).toArray(), roles);
    assert.deepEqual(await f.db.collection('member_capability_grants').find({ member_id: teacher._id }).toArray(), grants);
    assert.equal((await f.db.collection('auth_email_challenges').findOne({ _id: invitationRow.challengeId })).status, 'pending');
  });
  await t.test('组织账号管理员可真实SMTP邀请已有个人账号，仅本人主动接受后关联；旧单方addMember仍拒绝', async t => {
    const { fork } = require('node:child_process'), { join } = require('node:path'), { createTlsSmtpFixture } = require('./smtp-fixture.cjs');
    const smtp = await createTlsSmtpFixture(); t.after(() => smtp.stop());
    const f = await administrationFixture(t, 'replicaSet', { env: { KL_AUTH_EMAIL_ENABLED: 'false', KL_PUBLIC_REGISTRATION_ENABLED: 'false' } });
    const personal = { browser: new Browser(f.browser.base) };
    personal.user = await f.authenticated(personal.browser);
    const identity = await verifiedEmail(f, personal);
    assert.equal(await f.db.collection('organization_members').countDocuments({ user_id: personal.user.user_id }), 0);
    for (const app of f.apps.splice(0)) await app.close();
    const api = fork(join(__dirname, 'shared-api-child.cjs'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env,
      KL_AUTH_EMAIL_ENABLED: 'true', KL_PUBLIC_REGISTRATION_ENABLED: 'false', SMTP_HOST: smtp.host, SMTP_PORT: String(smtp.port),
      SMTP_SECURE: 'true', SMTP_USER: smtp.user, SMTP_PASSWORD: smtp.password, SMTP_FROM: smtp.from,
      AUTH_MAIL_ENCRYPTION_KEY: 'ab'.repeat(32), AUTH_MAIL_ENCRYPTION_KEY_ID: 'invite-consent-test',
      AUTH_TERMS_VERSION: 'test-terms', AUTH_PRIVACY_VERSION: 'test-privacy', AUTH_TERMS_URL: 'https://example.test/terms', AUTH_PRIVACY_URL: 'https://example.test/privacy',
      NODE_EXTRA_CA_CERTS: smtp.caPath, MONGODB_URI: f.uri } });
    const exited = new Promise((resolve, reject) => { api.once('error', () => reject(Error('INVITE_API_START_FAILED'))); api.once('exit', code => resolve(code)); });
    const ready = new Promise((resolve, reject) => { api.on('message', message => {
      if (message?.ready) resolve(message.base); else if (message?.error) reject(Error('INVITE_API_START_FAILED'));
    }); });
    let stopping = false;
    const stopApi = async () => {
      if (!stopping && api.connected) { stopping = true; api.send({ stop: true }); }
      assert.equal(await exited, 0);
    };
    f.apps.push({ close: stopApi });
    let timer;
    try {
      const base = await Promise.race([ready, exited.then(() => { throw Error('INVITE_API_EARLY_EXIT'); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('INVITE_API_START_TIMEOUT')), 45000); })]);
      clearTimeout(timer);
      const actor = { ...f.organizationAdmin, browser: f.organizationAdmin.browser.clone(base) }, receiver = personal.browser.clone(base);
      status(await consoleRequest(actor, `/organizations/${f.schoolA}/members`, { method: 'POST',
        body: { user_id: personal.user.user_id, roles: ['student'], reason: '旧单方成员关联仍受限', current_password: PASSWORD } }), 403);
      const invited = await consoleRequest(actor, `/organizations/${f.schoolA}/invitations`, { method: 'POST',
        body: { email: identity.email_key, roles: ['student'], reason: '已有个人账号主动同意入校', current_password: PASSWORD } });
      status(invited, 200); assert.equal(invited.data.data.status, 'applied');
      assert.equal(await f.db.collection('organization_members').countDocuments({ user_id: personal.user.user_id, org_id: f.schoolA }), 0);
      const message = await smtp.waitForMessage(message => message.to.includes(identity.email_key), 25000);
      const parts = message.data.split(/\r?\n\r?\n/), headers = parts.shift(), body = parts.join('\r\n\r\n');
      const text = /Content-Transfer-Encoding:\s*base64/i.test(headers) ? Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8') :
        body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
      const token = /\/accept-invitation#token=([A-Za-z0-9_-]{43})/.exec(text)?.[1]; assert.ok(token);
      const accepted = await post(receiver, 'accept', { token }); status(accepted, 200);
      const member = await f.db.collection('organization_members').findOne({ _id: accepted.data.data.member_id });
      assert.equal(member.user_id, personal.user.user_id); assert.equal(member.org_id, f.schoolA); assert.equal(member.status, 'active');
      assert.deepEqual((await f.db.collection('member_roles').find({ member_id: member._id }).toArray()).map(row => row.role_id), ['student']);
    } finally {
      clearTimeout(timer);
      try { await stopApi(); } finally { await smtp.stop(); }
    }
  });
});
