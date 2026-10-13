"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { fixture, Browser, status, guardedUri, PASSWORD } = require("./helpers.cjs");
const { newId } = require("../dist/database/object-id.js");
const { issueEmailChallenge, tokenDigest } = require("../dist/auth-email/tokens.js");

async function recoveryIdentity(f, user) {
  const row = { _id: newId(), user_id: user.user_id, email_key: `owner-${randomUUID()}@example.test`,
    email_display: "", state: "verified", verified_at: new Date(), revision: 1, created_at: new Date(), updated_at: new Date() };
  row.email_display = row.email_key;
  await f.db.collection("auth_email_identities").insertOne(row);
  return row;
}
async function recoveryChallenge(f, identity, purpose = "reset") {
  const user = await f.db.collection("users").findOne({ _id: identity.user_id });
  const session = f.client.startSession();
  try {
    return await session.withTransaction(() => issueEmailChallenge(f.db, session, {
      purpose, userId: user._id, email: { key: identity.email_key, display: identity.email_display },
      credentialVersion: user.credential_version, emailRevision: identity.revision,
    }));
  } finally { await session.endSession(); }
}

test("邮箱恢复和已验证邮箱登录边界（真实副本集HTTP）", { concurrency: false, timeout: 600000 }, async t => {
  guardedUri(process.env.TEST_MONGODB_URI);
  await t.test("关闭SMTP发起能力仍可邮箱密码登录，me交付备用用户名且不泄露邮箱", async t => {
    const f = await fixture(t, { env: { KL_AUTH_EMAIL_ENABLED: "false", KL_PUBLIC_REGISTRATION_ENABLED: "false" } });
    const user = await f.authenticated();
    const identity = await recoveryIdentity(f, user);
    const browser = new Browser(f.browser.base);
    await browser.prepare();
    status(await browser.login(identity.email_key.toUpperCase(), PASSWORD), 200);
    await browser.prepare();
    const me = await browser.request("/me");
    status(me, 200);
    assert.equal(me.data.data.user.login_name, user.login_name);
    assert.equal(me.data.data.user.email.state, "verified");
    assert.equal(me.data.data.user.email.masked, `${identity.email_key.slice(0, 1)}***@example.test`);
    assert.equal(JSON.stringify(me.data).includes(identity.email_key), false);
    const capabilities = await browser.request("/auth/capabilities");
    status(capabilities, 200);
    assert.equal(capabilities.data.data.email_password_login, true);
    assert.equal(capabilities.data.data.email_actions, false);
  });
  await t.test("正常me不会使reset失效；异账号拒绝、同账号一次消费、旧密码及旧会话失效", async t => {
    const f = await fixture(t, { env: { KL_AUTH_EMAIL_ENABLED: "false", KL_PUBLIC_REGISTRATION_ENABLED: "false" } });
    const user = await f.authenticated();
    const identity = await recoveryIdentity(f, user);
    const challenge = await recoveryChallenge(f, identity);
    const original = await f.db.collection("users").findOne({ _id: user.user_id });
    status(await f.browser.request("/me"), 200);
    const other = new Browser(f.browser.base);
    await f.authenticated(other);
    const next = "Email-recovery-boundary-password!43";
    const mismatch = await other.request("/auth/password-reset/confirm", { method: "POST", body: { token: challenge.token, new_password: next } });
    status(mismatch, 409);
    assert.equal(mismatch.data.error.code, "AUTH_ACCOUNT_SWITCH_REQUIRED");
    const unchanged = await f.db.collection("users").findOne({ _id: user.user_id });
    assert.equal(unchanged.credential_version, original.credential_version);
    assert.equal((await f.db.collection("auth_email_challenges").findOne({ _id: challenge.id })).status, "pending");
    const oldSession = f.browser.clone();
    status(await f.browser.request("/auth/password-reset/confirm", { method: "POST", body: { token: challenge.token, new_password: next } }), 204);
    status(await oldSession.request("/me"), 401);
    const changed = await f.db.collection("users").findOne({ _id: user.user_id });
    assert.equal(changed.credential_version, original.credential_version + 1);
    assert.equal(changed.must_change_password, false);
    assert.equal((await f.db.collection("auth_email_challenges").findOne({ _id: challenge.id })).status, "consumed");
    await f.browser.prepare();
    status(await f.browser.request("/auth/password-reset/confirm", { method: "POST", body: { token: challenge.token, new_password: PASSWORD } }), 409);
    status(await f.browser.login(identity.email_key, PASSWORD), 401);
    status(await f.browser.login(identity.email_key, next), 200);
  });
  await t.test("解绑立即撤销reset和bind挑战，过期以及跨purpose令牌不能改密", async t => {
    const f = await fixture(t, { env: { KL_AUTH_EMAIL_ENABLED: "false", KL_PUBLIC_REGISTRATION_ENABLED: "false" } });
    const user = await f.authenticated();
    const identity = await recoveryIdentity(f, user);
    const reset = await recoveryChallenge(f, identity);
    const bind = await recoveryChallenge(f, identity, "bind");
    const preauth = new Browser(f.browser.base);
    await preauth.prepare();
    status(await preauth.request("/auth/password-reset/confirm", { method: "POST", body: { token: bind.token, new_password: PASSWORD } }), 409);
    await f.db.collection("auth_email_challenges").updateOne({ token_hash: tokenDigest(reset.token) }, [{ $set: { expires_at: { $subtract: ["$$NOW", 1] } } }]);
    status(await preauth.request("/auth/password-reset/confirm", { method: "POST", body: { token: reset.token, new_password: PASSWORD } }), 409);
    const fresh = await recoveryChallenge(f, identity);
    status(await f.browser.request("/auth/email-binding/remove", { method: "POST", body: { expected_user_id: user.user_id, current_password: PASSWORD } }), 204);
    assert.equal(await f.db.collection("auth_email_identities").countDocuments({ user_id: user.user_id }), 0);
    assert.equal((await f.db.collection("auth_email_challenges").findOne({ _id: fresh.id })).status, "revoked");
    assert.equal((await f.db.collection("auth_email_challenges").findOne({ _id: bind.id })).status, "revoked");
    status(await preauth.request("/auth/password-reset/confirm", { method: "POST", body: { token: fresh.token, new_password: PASSWORD } }), 409);
  });
  await t.test("并发证明同一邮箱只能绑定一人，异用户不能消费，换绑撤销旧恢复链接", async t => {
    const f = await fixture(t, { env: { KL_AUTH_EMAIL_ENABLED: "false", KL_PUBLIC_REGISTRATION_ENABLED: "false" } });
    const first = await f.authenticated();
    const firstIdentity = await recoveryIdentity(f, first);
    const oldReset = await recoveryChallenge(f, firstIdentity);
    const secondBrowser = new Browser(f.browser.base);
    const second = await f.authenticated(secondBrowser);
    const secondIdentity = await recoveryIdentity(f, second);
    const secondReset = await recoveryChallenge(f, secondIdentity);
    const target = `shared-${randomUUID()}@example.test`;
    const challenges = [];
    for (const identity of [firstIdentity, secondIdentity]) {
      const user = await f.db.collection("users").findOne({ _id: identity.user_id });
      const session = f.client.startSession();
      try {
        challenges.push(await session.withTransaction(() => issueEmailChallenge(f.db, session, {
          purpose: "bind", userId: user._id, email: { key: target, display: target },
          credentialVersion: user.credential_version, emailRevision: identity.revision,
        })));
      } finally { await session.endSession(); }
    }
    status(await secondBrowser.request("/auth/email-binding/confirm", { method: "POST", body: { token: challenges[0].token } }), 409);
    assert.equal((await f.db.collection("auth_email_challenges").findOne({ _id: challenges[0].id })).status, "pending");
    const browsers = [f.browser, secondBrowser];
    const outcomes = await Promise.all(browsers.map((browser, index) => browser.request("/auth/email-binding/confirm", {
      method: "POST", body: { token: challenges[index].token },
    })));
    assert.deepEqual(outcomes.map(row => row.status).sort(), [204, 409]);
    const owner = await f.db.collection("auth_email_identities").findOne({ email_key: target, state: "verified" });
    assert.ok([first.user_id, second.user_id].includes(owner.user_id));
    const otherId = owner.user_id === first.user_id ? second.user_id : first.user_id;
    const otherIdentity = await f.db.collection("auth_email_identities").findOne({ user_id: otherId, state: "verified" });
    assert.equal(otherIdentity.email_key, owner.user_id === first.user_id ? secondIdentity.email_key : firstIdentity.email_key);
    const invalidated = owner.user_id === first.user_id ? oldReset : secondReset;
    assert.equal((await f.db.collection("auth_email_challenges").findOne({ _id: invalidated.id })).status, "revoked");
    const preauth = new Browser(f.browser.base);
    await preauth.prepare();
    status(await preauth.request("/auth/password-reset/confirm", { method: "POST", body: { token: invalidated.token, new_password: PASSWORD } }), 409);
  });
  await t.test("挑战签发后成为审核受保护主体也不能经邮箱绕过治理重置", async t => {
    const f = await fixture(t, { env: { KL_AUTH_EMAIL_ENABLED: "false", KL_PUBLIC_REGISTRATION_ENABLED: "false" } });
    const user = await f.authenticated();
    const identity = await recoveryIdentity(f, user);
    const challenge = await recoveryChallenge(f, identity);
    const organization = await f.ops.createOrganization(f.context, { name: "邮箱恢复审核边界", kind: "school" });
    await f.ops.setMembership(f.context, {
      user_id: user.user_id, org_id: organization.organization_id, roles: ["content_reviewer"],
      reviewer_valid_to: new Date(Date.now() + 7 * 86400000),
    });
    const before = await f.db.collection("users").findOne({ _id: user.user_id });
    const browser = new Browser(f.browser.base);
    await browser.prepare();
    const response = await browser.request("/auth/password-reset/confirm", {
      method: "POST", body: { token: challenge.token, new_password: "Protected-email-reset-must-not-apply!44" },
    });
    status(response, 409);
    assert.equal(response.data.error.code, "EMAIL_ACTION_INVALID");
    const after = await f.db.collection("users").findOne({ _id: user.user_id });
    assert.equal(after.credential_version, before.credential_version);
    assert.equal(after.password_hash === before.password_hash, true);
    assert.equal((await f.db.collection("auth_email_challenges").findOne({ _id: challenge.id })).status, "pending");
  });
  await t.test("本人邮箱动作续idle但不越absolute，预认证邮箱消费不延长原会话", async t => {
    const f = await fixture(t, { env: { KL_AUTH_EMAIL_ENABLED: "false", KL_PUBLIC_REGISTRATION_ENABLED: "false" } });
    const user = await f.authenticated();
    const sessions = f.db.collection("auth_sessions");
    const filter = f.session(f.browser);
    await sessions.updateOne(filter, [{ $set: {
      last_seen_at: "$$NOW",
      idle_expires_at: { $add: ["$$NOW", 20000] },
      expires_at: { $add: ["$$NOW", 20000] },
    } }]);
    const nearIdle = await sessions.findOne(filter);
    status(await f.browser.request("/auth/email-binding/remove", { method: "POST", body: { expected_user_id: user.user_id, current_password: PASSWORD } }), 204);
    const renewed = await sessions.findOne(filter);
    assert.ok(renewed.expires_at.getTime() > nearIdle.expires_at.getTime() + 60000);
    assert.equal(renewed.idle_expires_at.getTime(), renewed.expires_at.getTime());
    assert.equal(renewed.absolute_expires_at.getTime(), nearIdle.absolute_expires_at.getTime());
    status(await f.browser.request("/me"), 200);
    await sessions.updateOne(filter, [{ $set: {
      last_seen_at: "$$NOW",
      idle_expires_at: { $add: ["$$NOW", 20000] },
      expires_at: { $add: ["$$NOW", 20000] },
      absolute_expires_at: { $add: ["$$NOW", 40000] },
    } }]);
    const nearAbsolute = await sessions.findOne(filter);
    status(await f.browser.request("/auth/email-binding/remove", { method: "POST", body: { expected_user_id: user.user_id, current_password: PASSWORD } }), 204);
    const capped = await sessions.findOne(filter);
    assert.equal(capped.expires_at.getTime(), nearAbsolute.absolute_expires_at.getTime());
    assert.equal(capped.idle_expires_at.getTime(), nearAbsolute.absolute_expires_at.getTime());
    const identity = await recoveryIdentity(f, user);
    const challenge = await recoveryChallenge(f, identity);
    const preauth = new Browser(f.browser.base);
    await preauth.prepare();
    const preauthFilter = f.session(preauth), originalPreauth = await sessions.findOne(preauthFilter);
    status(await preauth.request("/auth/password-reset/confirm", {
      method: "POST", body: { token: challenge.token, new_password: "Preauth-reset-expiry-must-not-extend!45" },
    }), 204);
    const consumedPreauth = await sessions.findOne(preauthFilter);
    assert.equal(consumedPreauth.expires_at.getTime(), originalPreauth.expires_at.getTime());
    assert.equal(consumedPreauth.idle_expires_at.getTime(), originalPreauth.idle_expires_at.getTime());
    assert.equal(consumedPreauth.absolute_expires_at.getTime(), originalPreauth.absolute_expires_at.getTime());
    assert.ok(consumedPreauth.revoked_at instanceof Date);
  });
  await t.test("另一标签页Cookie切换到同密码账号时，绑定/解绑必须拒绝旧页面expected_user_id", async t => {
    const f = await fixture(t, { env: { KL_AUTH_EMAIL_ENABLED: "false", KL_PUBLIC_REGISTRATION_ENABLED: "false" } });
    const displayed = await f.authenticated();
    const displayedIdentity = await recoveryIdentity(f, displayed);
    const switchedBrowser = new Browser(f.browser.base);
    const current = await f.authenticated(switchedBrowser);
    const currentIdentity = await recoveryIdentity(f, current);
    const recovery = await recoveryChallenge(f, currentIdentity);
    const identityBefore = await f.db.collection("auth_email_identities").findOne({ user_id: current.user_id });
    const target = `wrong-page-${randomUUID()}@example.test`;
    const bind = await switchedBrowser.request("/auth/email-binding/request", {
      method: "POST", body: { expected_user_id: displayed.user_id, email: target, current_password: PASSWORD },
    });
    status(bind, 409);
    assert.equal(bind.data.error.code, "AUTH_ACCOUNT_SWITCH_REQUIRED");
    const remove = await switchedBrowser.request("/auth/email-binding/remove", {
      method: "POST", body: { expected_user_id: displayed.user_id, current_password: PASSWORD },
    });
    status(remove, 409);
    assert.equal(remove.data.error.code, "AUTH_ACCOUNT_SWITCH_REQUIRED");
    assert.deepEqual(await f.db.collection("auth_email_identities").findOne({ user_id: current.user_id }), identityBefore);
    assert.equal((await f.db.collection("auth_email_identities").findOne({ user_id: displayed.user_id })).email_key, displayedIdentity.email_key);
    assert.equal((await f.db.collection("auth_email_challenges").findOne({ _id: recovery.id })).status, "pending");
    assert.equal(await f.db.collection("auth_email_challenges").countDocuments({ email_key: target }), 0);
    assert.equal(await f.db.collection("auth_mail_outbox").countDocuments({ user_id: current.user_id }), 0);
    status(await switchedBrowser.request("/auth/email-binding/request", {
      method: "POST", body: { email: target, current_password: PASSWORD },
    }), 422);
    status(await switchedBrowser.request("/auth/email-binding/remove", {
      method: "POST", body: { current_password: PASSWORD },
    }), 422);
    status(await switchedBrowser.request("/me"), 200);
    status(await f.browser.request("/me"), 200);
  });
});
