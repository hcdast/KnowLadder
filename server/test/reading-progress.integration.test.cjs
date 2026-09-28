"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { status } = require("./helpers.cjs");
const { assessmentFixture, request, good } = require("./assessment-helpers.cjs");
const options = { concurrency: false, timeout: 120000 };
const input = (f, changes = {}) => ({ event_type: "reading_progress_set", event_id: randomUUID(), textbook_edition_id: f.book.id,
  chapter_id: f.chapterId, edition_revision: f.book.revision, expected_revision: 0,
  position: { kind: "text_offset", offset_utf16: 0 }, completed: false, ...changes });
const send = (f, body, actor = f.student) => request(actor, "/behavior-events", { method: "POST", body });
const read = (f, actor = f.student, extra = "") => good(actor, `/me/reading-progress?textbook_edition_id=${f.book.id}${extra}`);
async function counts(f) {
  const result = {};
  for (const name of ["behavior_events", "reading_progress", "idempotency_records", "learning_question_states", "learning_attempt_contexts", "learning_projection_heads", "outbox_events"])
    result[name] = await f.db.collection(name).countDocuments({ org_id: f.org });
  return result;
}

test("阅读真实HTTP：未开始、UTF16边界、显式完成、回读与原事件回执", options, async t => {
  const f = await assessmentFixture(t);
  // Isolated original fixture text, including a surrogate pair; no production mutation.
  await f.db.collection("chapters").updateOne({ _id: f.chapterId }, { $set: { body: "甲\ud83d\ude00乙" } });
  const initial = await read(f);
  assert.deepEqual(initial.items, [{ chapter_id: f.chapterId, edition_revision: f.book.revision, position: null, completed: null, progress_revision: 0, updated_at: null }]);
  for (const offset of [-1, 1.5, 2, 5]) status(await send(f, input(f, { position: { kind: "text_offset", offset_utf16: offset } })), 422);
  for (const changes of [{ event_type: "click" }, { event_id: "bad" }, { completed: undefined }, { surprise: true }, { position: { kind: "text_offset", offset_utf16: 0, pixels: 1 } }])
    status(await send(f, input(f, changes)), 422);
  const before = await counts(f);
  const body = input(f, { position: { kind: "text_offset", offset_utf16: 4 }, completed: true });
  const first = await send(f, body); status(first, 200);
  const replay = await send(f, body); status(replay, 200); assert.deepEqual(replay.data.data, first.data.data);
  const different = await send(f, { ...body, completed: false }); status(different, 409); assert.equal(different.data.error.code, "IDEMPOTENCY_CONFLICT");
  const backward = await send(f, input(f, { expected_revision: 1, position: { kind: "text_offset", offset_utf16: 1 }, completed: false })); status(backward, 200);
  const head = (await read(f)).items[0]; assert.equal(head.position.offset_utf16, 1); assert.equal(head.completed, false); assert.equal(head.progress_revision, 2);
  assert.deepEqual((await send(f, body)).data.data, first.data.data, "原事件恢复原结果，不把新head当原结果");
  const after = await counts(f);
  assert.equal(after.behavior_events - before.behavior_events, 2); assert.equal(after.reading_progress - before.reading_progress, 1);
  assert.equal(after.idempotency_records - before.idempotency_records, 2);
  for (const name of ["learning_question_states", "learning_attempt_contexts", "learning_projection_heads", "outbox_events"]) assert.equal(after[name], before[name], "阅读不生成mastery输入");
  const receipt = await f.db.collection("idempotency_records").findOne({ key: body.event_id });
  assert.deepEqual(Object.keys(receipt.result).sort(), ["event_id", "progress_revision", "server_received_at"]);
  const actor = f.student.browser;
  const oversized = await fetch(`${actor.base}/api/v1/behavior-events`, { method: "POST", headers: { "Content-Type": "application/json", "X-Org-Id": f.org,
    Origin: "http://127.0.0.1:5174", "X-CSRF-Token": actor.csrf, Cookie: [...actor.cookies].map(([k, v]) => `${k}=${v}`).join("; ") }, body: JSON.stringify(input(f)) + " ".repeat(2048) });
  assert.equal(oversized.status, 413); await oversized.arrayBuffer();
});

test("阅读CAS、事务回滚及权限/教材许可重新检查", options, async t => {
  const f = await assessmentFixture(t);
  const device = { ...f.student, browser: f.student.browser.clone() };
  const bodies = [input(f), input(f, { completed: true })];
  const results = await Promise.all([send(f, bodies[0]), send(f, bodies[1], device)]);
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
  assert.equal(results.find(row => row.status === 409).data.error.code, "READING_REVISION_CONFLICT");
  assert.equal(await f.db.collection("behavior_events").countDocuments({ org_id: f.org }), 1);
  const winner = bodies[results.findIndex(row => row.status === 200)];
  const before = await counts(f);
  const { Collection } = require("mongoose").mongo;
  const original = Collection.prototype.insertOne;
  let injected = false;
  Collection.prototype.insertOne = async function (...args) {
    if (this.namespace === `${f.db.databaseName}.behavior_events` && !injected) { injected = true; throw new Error("isolated-reading-rollback"); }
    return original.apply(this, args);
  };
  try {
    const failed = await send(f, input(f, { expected_revision: 1 }));
    status(failed, 503); assert.equal(failed.data.error.code, "DEPENDENCY_UNAVAILABLE");
  } finally { Collection.prototype.insertOne = original; }
  assert.ok(injected); assert.deepEqual(await counts(f), before); assert.equal((await read(f)).items[0].progress_revision, 1);
  status(await send(f, input(f), f.editor), 403);
  const editorMember = await f.db.collection("organization_members").findOne({ _id: f.editor.memberId });
  await f.ops.setMembership(f.context, { org_id: f.org, user_id: f.editor.user.user_id, roles: ["content_editor", "student"], expected_revision: editorMember.authorization_revision });
  status(await send(f, input(f), f.editor), 200, "有learning:self的管理者只可写本人阅读");
  const stranger = await f.actor(); assert.equal((await read(f, stranger)).items[0].position, null);
  status(await send(f, input(f, { chapter_id: randomUUID(), expected_revision: 1 })), 404);
  const changedContent = await send(f, input(f, { edition_revision: f.book.revision + 1, expected_revision: 1 }));
  status(changedContent, 409); assert.equal(changedContent.data.error.code, "READING_CONTENT_CHANGED");
  const member = await f.db.collection("organization_members").findOne({ _id: f.student.memberId });
  await f.ops.setMembership(f.context, { org_id: f.org, user_id: f.student.user.user_id, roles: ["org_admin"], expected_revision: member.authorization_revision });
  status(await send(f, winner), 403);
  const revokedMember = await f.db.collection("organization_members").findOne({ _id: f.student.memberId });
  await f.ops.setMembership(f.context, { org_id: f.org, user_id: f.student.user.user_id, roles: ["student"], expected_revision: revokedMember.authorization_revision });
  await f.db.collection("textbook_editions").updateOne({ _id: f.book.id }, { $set: { "license.expires_at": new Date(Date.now() - 1000).toISOString() } });
  status(await send(f, winner), 409);
  status(await request(f.student, `/me/reading-progress?textbook_edition_id=${f.book.id}`), 409);
});

test("阅读留存：90天仅删raw、180天CAS墓碑、旧事件不能复活", options, async t => {
  const f = await assessmentFixture(t);
  const { cleanupReading } = require("../dist/learning/reading-cleanup.js");
  const { MongoClient } = require("mongodb");
  const guardedClient = new MongoClient(process.env.MONGODB_URI, { monitorCommands: true });
  try {
    await guardedClient.connect();
    const commands = [];
    guardedClient.on("commandStarted", event => commands.push(event.commandName));
    // A real Db handle, never seeded or dropped: refusal must precede all I/O.
    await assert.rejects(cleanupReading(guardedClient.db("knowl_reading_guard_denied"), true), /READING_CLEANUP_ISOLATED_DATABASE_REQUIRED/);
    assert.deepEqual(commands, [], "非隔离库必须在任何查询或写入前拒绝");
  } finally { await guardedClient.close(); }
  const body = input(f, { completed: true });
  const accepted = await send(f, body); status(accepted, 200);
  const ancient = new Date(Date.now() - 181 * 86400000);
  await f.db.collection("behavior_events").updateOne({ event_id: body.event_id }, { $set: { server_received_at: ancient } });
  await f.db.collection("reading_progress").updateOne({ member_id: f.student.memberId }, { $set: { updated_at: ancient } });
  assert.deepEqual(await cleanupReading(f.db), { events: 1, progress: 1, applied: false });
  assert.deepEqual(await cleanupReading(f.db, true), { events: 1, progress: 1, applied: true });
  const cleared = (await read(f)).items[0]; assert.equal(cleared.position, null); assert.equal(cleared.completed, null); assert.equal(cleared.progress_revision, 2);
  assert.deepEqual((await send(f, body)).data.data, accepted.data.data);
  assert.equal(await f.db.collection("behavior_events").countDocuments({ event_id: body.event_id }), 0);
  status(await send(f, { ...body, completed: false }), 409);
  for (const expected_revision of [0, 1]) {
    const stale = await send(f, input(f, { expected_revision }));
    status(stale, 409); assert.equal(stale.data.error.code, "READING_REVISION_CONFLICT");
  }
  assert.deepEqual(await cleanupReading(f.db, true), { events: 0, progress: 0, applied: true });
  const fresh = await send(f, input(f, { expected_revision: 2 })); status(fresh, 200); assert.equal(fresh.data.data.progress_revision, 3);
  assert.equal(await f.db.collection("idempotency_records").countDocuments({ key: body.event_id }), 1);
});

test("阅读分页绑定身份和教材revision，无记录章也明确返回null", options, async t => {
  const f = await assessmentFixture(t);
  const chapter = await f.db.collection("chapters").findOne({ _id: f.chapterId });
  await f.db.collection("chapters").insertOne({ ...chapter, _id: randomUUID(), position: 1 });
  const page = await read(f, f.student, "&limit=1"); assert.ok(page.next_cursor); assert.equal(page.items.length, 1);
  const next = `&limit=1&cursor=${encodeURIComponent(page.next_cursor)}`;
  const page2 = await read(f, f.student, next); assert.equal(page2.items.length, 1); assert.notEqual(page2.items[0].chapter_id, page.items[0].chapter_id); assert.equal(page2.items[0].position, null);
  const other = await f.actor(); status(await request(other, `/me/reading-progress?textbook_edition_id=${f.book.id}${next}`), 422);
  await f.db.collection("textbook_editions").updateOne({ _id: f.book.id }, { $inc: { revision: 1 } });
  status(await request(f.student, `/me/reading-progress?textbook_edition_id=${f.book.id}${next}`), 409);
});

test("阅读提交确认丢失后重试commit并按原event恢复，无重复写", options, async t => {
  const f = await assessmentFixture(t);
  const { ClientSession } = require("mongoose").mongo;
  const original = ClientSession.prototype.commitTransaction;
  let injected = false;
  ClientSession.prototype.commitTransaction = async function (...args) {
    const result = await original.apply(this, args);
    if (!injected) {
      injected = true;
      const fault = new Error("isolated-commit-acknowledgement-lost");
      fault.hasErrorLabel = label => label === "UnknownTransactionCommitResult";
      throw fault;
    }
    return result;
  };
  const body = input(f);
  let accepted;
  try { accepted = await send(f, body); status(accepted, 200); } finally { ClientSession.prototype.commitTransaction = original; }
  assert.ok(injected);
  const replay = await send(f, body); status(replay, 200); assert.deepEqual(replay.data.data, accepted.data.data);
  assert.equal(await f.db.collection("behavior_events").countDocuments({ event_id: body.event_id }), 1);
  assert.equal(await f.db.collection("idempotency_records").countDocuments({ key: body.event_id }), 1);
  assert.equal((await read(f)).items[0].progress_revision, 1);
});
