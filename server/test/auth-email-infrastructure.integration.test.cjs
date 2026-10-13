"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { fixture } = require("./helpers.cjs");
const { newId, rawDatabase } = require("../dist/database/object-id.js");
const { migrateAuthEmail } = require("../dist/migrations/auth-email-v22.js");
const { assertSchema, OBJECT_ID_CHECKSUM } = require("../dist/migrations/schema.js");
const { enqueueEmail, MailDeliveryService } = require("../dist/auth-email/mail.js");
const { issueEmailChallenge } = require("../dist/auth-email/tokens.js");
const { acquireWriter } = require("../dist/operations/control.js");
const enabledEnv = {
  KL_AUTH_EMAIL_ENABLED: "true", KL_PUBLIC_REGISTRATION_ENABLED: "false", SMTP_HOST: "localhost",
  SMTP_PORT: "465", SMTP_SECURE: "true", SMTP_USER: "isolated-test", SMTP_PASSWORD: "isolated-test-only",
  SMTP_FROM: "isolated@knowladder.test", AUTH_MAIL_ENCRYPTION_KEY: "ab".repeat(32), AUTH_MAIL_ENCRYPTION_KEY_ID: "isolated_test",
  AUTH_TERMS_VERSION: "test_terms", AUTH_PRIVACY_VERSION: "test_privacy",
  AUTH_TERMS_URL: "https://policy.knowladder.test/terms", AUTH_PRIVACY_URL: "https://policy.knowladder.test/privacy",
};
async function queued(f, purpose = "register") {
  const session = f.client.startSession();
  const address = `${newId()}@knowladder.test`;
  let queueId, challenge;
  try {
    await session.withTransaction(async () => {
      challenge = await issueEmailChallenge(f.db, session, { purpose, userId: null,
        email: { key: address, display: address } });
      queueId = await enqueueEmail(f.db, session, { challengeId: challenge.id, userId: null, invitationId: null,
        purpose, email: address, token: challenge.token, expiresAt: challenge.expiresAt });
    });
  } finally { await session.endSession(); }
  return { queueId, challenge };
}
async function delivery(f, db = f.db) {
  const writer = await acquireWriter(f.db, "api");
  const worker = new MailDeliveryService({ db, client: f.client, ready: () => assertSchema(f.db),
    writerStopRequested: writer.stopRequested, writerRegistrationId: () => writer.id });
  f.apps.push({ close: async () => { await worker.onModuleDestroy(); await writer.release(); } });
  return worker;
}

test("v22 strict identities reject malformed rows and enforce verified address ownership", async t => {
  const f = await fixture(t, { app: false, env: { KL_AUTH_EMAIL_ENABLED: "false", KL_PUBLIC_REGISTRATION_ENABLED: "false" } });
  const userA = await f.user(), userB = await f.user(), now = new Date();
  const base = { _id: newId(), user_id: userA.user_id, email_key: "shared@knowladder.test", email_display: "Shared@knowladder.test",
    state: "verified", verified_at: now, revision: 1, created_at: now, updated_at: now };
  const identities = f.db.collection("auth_email_identities");
  await identities.insertOne(base);
  await assert.rejects(identities.insertOne({ ...base, _id: newId(), user_id: userB.user_id }), e => e.code === 11000);
  await assert.rejects(identities.insertOne({ ...base, _id: newId(), email_key: "other@knowladder.test", verified_at: null }), e => e.code === 121);
  await assert.rejects(identities.insertOne({ ...base, _id: newId(), state: "needs_reverify", verified_at: null, revision: 0 }), e => e.code === 121);
  await assert.rejects(identities.insertOne({ ...base, _id: newId(), state: "needs_reverify", verified_at: null, secret: "not-allowed" }), e => e.code === 121);
  await identities.insertOne({ ...base, _id: newId(), user_id: userB.user_id, state: "needs_reverify", verified_at: null });
  const marker = await f.db.collection("schema_migrations").findOne({ version: 22 });
  await f.db.collection("schema_migrations").deleteOne({ version: 22 });
  await assert.rejects(assertSchema(f.db), /v22 migration incomplete/);
  await f.db.collection("schema_migrations").insertOne(marker);
  await assertSchema(f.db);
});

test("v22 migration resumes its expired lease without changing historical checksum", async t => {
  const f = await fixture(t, { app: false, env: { KL_AUTH_EMAIL_ENABLED: "false", KL_PUBLIC_REGISTRATION_ENABLED: "false" } });
  const old = await f.db.collection("schema_migrations").findOne({ version: 10 });
  await f.db.collection("auth_mail_outbox").dropIndex("auth_mail_claim");
  await f.db.collection("schema_migrations").updateOne({ version: 22 }, { $set: {
    status: "running", lease_token: randomUUID(), lease_until: new Date(0), completed_at: null,
  } });
  await migrateAuthEmail(f.db, OBJECT_ID_CHECKSUM);
  await assertSchema(f.db);
  assert.deepEqual(await f.db.collection("schema_migrations").findOne({ version: 10 }), old);
  await migrateAuthEmail(f.db, OBJECT_ID_CHECKSUM);
  const now = new Date();
  await f.db.collection("schema_migrations").updateOne({ version: 22 }, { $set: {
    status: "running", lease_token: randomUUID(), lease_until: new Date(now.getTime() + 120000), completed_at: null,
  } });
  await assert.rejects(migrateAuthEmail(f.db, OBJECT_ID_CHECKSUM), /MIGRATION_BUSY/);
});

test("v22 migration closes admission before DDL and keeps failures isolated until explicit recovery", async t => {
  const f = await fixture(t, { app: false, env: { KL_AUTH_EMAIL_ENABLED: "false", KL_PUBLIC_REGISTRATION_ENABLED: "false" } });
  const writer = await acquireWriter(f.db, "api");
  try {
    // An already-completed v22 check is read-only and remains available with writers.
    await migrateAuthEmail(f.db, OBJECT_ID_CHECKSUM);
    await f.db.collection("schema_migrations").updateOne({ version: 22 }, {
      $set: { status: "failed", failed_at: new Date(), completed_at: null },
    });
    await assert.rejects(migrateAuthEmail(f.db, OBJECT_ID_CHECKSUM), /AUTH_EMAIL_WRITERS_RUNNING/);
  } finally { await writer.release(); }
  let reached, release;
  const atDdl = new Promise(resolve => { reached = resolve; });
  const proceed = new Promise(resolve => { release = resolve; });
  const raw = rawDatabase(f.db);
  let paused = false;
  const intercepted = new Proxy(raw, { get(target, key) {
    if (key === "command") return async (command, ...options) => {
      if (command.createIndexes && !paused) {
        paused = true; reached();
        await proceed;
        throw Error("INJECTED_DDL_INTERRUPTION");
      }
      return target.command(command, ...options);
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const migration = migrateAuthEmail(intercepted, OBJECT_ID_CHECKSUM);
  const failed = assert.rejects(migration, /INJECTED_DDL_INTERRUPTION/);
  await atDdl;
  try {
    assert.equal((await f.db.collection("operational_state").findOne({ _id: "environment" })).mode, "draining");
    await assert.rejects(acquireWriter(f.db, "api"), /OPERATIONS_ACCESS_BLOCKED/);
    assert.equal(await f.db.collection("operational_writers").countDocuments({ state: "running" }), 0);
  } finally { release(); }
  await failed;
  const isolated = await f.db.collection("operational_state").findOne({ _id: "environment" });
  assert.equal(isolated.mode, "draining");
  assert.match(isolated.owner, /^auth-email-v22:unregistered:/);
  await assert.rejects(acquireWriter(f.db, "api"), /OPERATIONS_ACCESS_BLOCKED/);
  await migrateAuthEmail(f.db, OBJECT_ID_CHECKSUM);
  await assertSchema(f.db);
  const restored = await f.db.collection("operational_state").findOne({ _id: "environment" });
  assert.equal(restored.mode, "unregistered"); assert.equal(restored.environment_id, null);
  const resumedWriter = await acquireWriter(f.db, "api");
  await resumedWriter.release();
});

test("v22 upgrade preserves a released active restore origin", async t => {
  const f = await fixture(t, { app: false, env: { KL_AUTH_EMAIL_ENABLED: "false", KL_PUBLIC_REGISTRATION_ENABLED: "false" } });
  const restoreId = newId(), environmentId = randomUUID();
  await f.db.collection("operational_state").updateOne({ _id: "environment" }, { $set: {
    mode: "active", environment_id: environmentId, restore_id: restoreId, owner: null,
  } });
  await f.db.collection("schema_migrations").updateOne({ version: 22 }, { $set: {
    status: "failed", failed_at: new Date(), completed_at: null,
  } });
  await migrateAuthEmail(f.db, OBJECT_ID_CHECKSUM);
  await assertSchema(f.db);
  const state = await f.db.collection("operational_state").findOne({ _id: "environment" });
  assert.equal(state.mode, "active"); assert.equal(state.restore_id, restoreId); assert.equal(state.environment_id, environmentId);
});

test("outbox seals same-transaction payload, rejects tampering and never retries uncertain delivery", async t => {
  const f = await fixture(t, { app: false, env: enabledEnv });
  const session = f.client.startSession();
  let rolledBackChallenge, rolledBackQueue;
  try {
    session.startTransaction();
    const address = `${newId()}@knowladder.test`;
    rolledBackChallenge = await issueEmailChallenge(f.db, session, { purpose: "register", userId: null, email: { key: address, display: address } });
    rolledBackQueue = await enqueueEmail(f.db, session, { challengeId: rolledBackChallenge.id, userId: null, invitationId: null,
      purpose: "register", email: address, token: rolledBackChallenge.token, expiresAt: rolledBackChallenge.expiresAt });
    await session.abortTransaction();
  } finally { await session.endSession(); }
  assert.equal(await f.db.collection("auth_email_challenges").findOne({ _id: rolledBackChallenge.id }), null);
  assert.equal(await f.db.collection("auth_mail_outbox").findOne({ _id: rolledBackQueue }), null);
  const a = await queued(f), b = await queued(f), c = await queued(f);
  const outbox = f.db.collection("auth_mail_outbox");
  const original = await outbox.findOne({ _id: a.queueId });
  // Valid AES-GCM bytes from another queue must fail because AAD binds the original queue ID.
  await outbox.updateOne({ _id: b.queueId }, { $set: { encrypted_payload: original.encrypted_payload } });
  const bytes = Buffer.from(original.encrypted_payload, "base64"); bytes[bytes.length - 1] ^= 1;
  await outbox.updateOne({ _id: a.queueId }, { $set: { encrypted_payload: bytes.toString("base64") } });
  const worker = await delivery(f);
  const writerRow = await f.db.collection("operational_writers").findOne({ state: "running", kind: "api" });
  const abandonedTransport = randomUUID();
  await outbox.updateOne({ _id: c.queueId }, { $set: { status: "sending", lease_token: randomUUID(), lease_until: new Date(0),
    transport_token: abandonedTransport, transport_writer_id: writerRow._id } });
  await worker.runOnce();
  for (const id of [a.queueId, b.queueId]) {
    const row = await outbox.findOne({ _id: id });
    assert.equal(row.status, "failed"); assert.equal(row.safe_error_code, "MAIL_CIPHERTEXT_INVALID");
    assert.equal(row.encrypted_payload, null); assert.equal(row.lease_token, null); assert.equal(row.lease_until, null);
    assert.equal(row.transport_token, null); assert.equal(row.transport_writer_id, null);
    assert.ok(row.transport_closed_at instanceof Date);
  }
  const uncertain = await outbox.findOne({ _id: c.queueId });
  assert.equal(uncertain.status, "uncertain"); assert.equal(uncertain.encrypted_payload, null);
  assert.equal(uncertain.transport_token, abandonedTransport);
  assert.equal(uncertain.transport_closed_at, null);
  await worker.runOnce();
  assert.deepEqual(await outbox.findOne({ _id: c.queueId }), uncertain);
  await worker.onModuleDestroy();
});

test("consumed challenge cancels delivery and nontransaction sessions cannot enqueue email", async t => {
  const f = await fixture(t, { app: false, env: enabledEnv });
  const a = await queued(f);
  await f.db.collection("auth_email_challenges").updateOne({ _id: a.challenge.id }, {
    $set: { status: "consumed", consumed_at: new Date() },
  });
  const worker = await delivery(f); await worker.runOnce();
  const row = await f.db.collection("auth_mail_outbox").findOne({ _id: a.queueId });
  assert.equal(row.status, "cancelled"); assert.equal(row.encrypted_payload, null);
  const session = f.client.startSession();
  try {
    await assert.rejects(enqueueEmail(f.db, session, { challengeId: newId(), userId: null, invitationId: null,
      purpose: "register", email: "isolated@knowladder.test", token: randomBytes(32).toString("base64url"), expiresAt: new Date(Date.now() + 60000) }), /AUTH_TRANSACTION_REQUIRED/);
  } finally { await session.endSession(); await worker.onModuleDestroy(); }
});

test("standalone installs v22 structure but rejects enabled email transaction readiness", async t => {
  const f = await fixture(t, { app: false, topology: "standalone", env: {
    ...enabledEnv, KL_AUTH_EMAIL_ENABLED: "false", KL_PUBLIC_REGISTRATION_ENABLED: "false",
  } });
  await assertSchema(f.db);
  const marker = await f.db.collection("schema_migrations").findOne({ version: 22 });
  assert.equal(marker.status, "completed");
  Object.assign(process.env, enabledEnv);
  await assert.rejects(assertSchema(f.db), /AUTH_TRANSACTION_REQUIRED/);
  const session = f.client.startSession();
  try {
    await assert.rejects(enqueueEmail(f.db, session, { challengeId: newId(), userId: null, invitationId: null,
      purpose: "register", email: "isolated@knowladder.test", token: randomBytes(32).toString("base64url"),
      expiresAt: new Date(Date.now() + 60000) }), /AUTH_TRANSACTION_REQUIRED/);
  } finally { await session.endSession(); }
});

test("closed transport ACK survives terminal status and acknowledgement database faults without retransmission", async t => {
  const f = await fixture(t, { app: false, env: enabledEnv });
  const queuedMail = await queued(f), outbox = f.db.collection("auth_mail_outbox");
  const original = await outbox.findOne({ _id: queuedMail.queueId });
  const bytes = Buffer.from(original.encrypted_payload, "base64"); bytes[28] ^= 1;
  await outbox.updateOne({ _id: queuedMail.queueId }, { $set: { encrypted_payload: bytes.toString("base64") } });
  let terminalFailed = false, ackFailed = false;
  const faultDb = new Proxy(f.db, { get(target, key) {
    if (key === "collection") return name => {
      const real = target.collection(name);
      if (name !== "auth_mail_outbox") return real;
      return new Proxy(real, { get(collection, method) {
        if (method === "updateOne") return async (filter, update, options) => {
          const changes = update?.[0]?.$set;
          if (changes?.status === "failed" && !terminalFailed) {
            terminalFailed = true; throw Error("INJECTED_TERMINAL_WRITE_FAILURE");
          }
          if (changes?.transport_closed_at === "$$NOW" && !ackFailed) {
            ackFailed = true; throw Error("INJECTED_ACK_WRITE_FAILURE");
          }
          return collection.updateOne(filter, update, options);
        };
        const value = Reflect.get(collection, method);
        return typeof value === "function" ? value.bind(collection) : value;
      } });
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const worker = await delivery(f, faultDb);
  await assert.rejects(worker.runOnce(), /INJECTED_ACK_WRITE_FAILURE/);
  const held = await outbox.findOne({ _id: queuedMail.queueId });
  assert.equal(held.status, "sending"); assert.notEqual(held.transport_token, null);
  assert.equal(terminalFailed, true); assert.equal(ackFailed, true);
  await outbox.updateOne({ _id: queuedMail.queueId }, { $set: { lease_until: new Date(0) } });
  await worker.runOnce();
  const closed = await outbox.findOne({ _id: queuedMail.queueId });
  assert.equal(closed.status, "uncertain");
  assert.equal(closed.transport_token, null); assert.equal(closed.transport_writer_id, null);
  assert.ok(closed.transport_closed_at instanceof Date); assert.equal(closed.encrypted_payload, null);
  await worker.onModuleDestroy();
});
