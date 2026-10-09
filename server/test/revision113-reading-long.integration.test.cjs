"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { assessmentFixture, good, request } = require("./assessment-helpers.cjs");
test("长正文非零位置与跨设备冲突不覆盖服务器进度", { timeout: 120000 }, async t => {
  const f = await assessmentFixture(t);
  const text = "原创长文段落：循序阅读并核对理解。\n".repeat(400) + "甲😀乙";
  await f.db.collection("chapters").updateOne({ _id: f.chapterId }, { $set: { body: text } });
  const device = { ...f.student, browser: f.student.browser.clone() };
  const body = (revision, offset, completed = false) => ({ event_type: "reading_progress_set", event_id: randomUUID(), textbook_edition_id: f.book.id,
    chapter_id: f.chapterId, edition_revision: f.book.revision, expected_revision: revision, position: { kind: "text_offset", offset_utf16: offset }, completed });
  const write = (actor, value) => request(actor, "/behavior-events", { method: "POST", body: value });
  const first = body(0, 1500);
  assert.equal((await write(f.student, first)).status, 200);
  const stale = await write(device, body(0, 3000, true));
  assert.equal(stale.status, 409); assert.equal(stale.data.error.code, "READING_REVISION_CONFLICT");
  const head = async () => (await good(f.student, `/me/reading-progress?textbook_edition_id=${f.book.id}`)).items[0];
  assert.equal((await head()).position.offset_utf16, 1500);
  assert.equal((await head()).completed, false);
  // Explicitly use the current revision after comparing another device's head.
  assert.equal((await write(device, body(1, 3000, true))).status, 200);
  assert.equal((await head()).position.offset_utf16, 3000);
  assert.equal((await head()).progress_revision, 2);
  assert.equal((await head()).completed, true);
  // Recovering the old event must return its old receipt without reverting the head.
  const replay = await write(f.student, first);
  assert.equal(replay.status, 200); assert.equal(replay.data.data.progress_revision, 1);
  assert.equal((await head()).position.offset_utf16, 3000);
  const surrogateMiddle = text.length - 2;
  assert.equal((await write(device, body(2, surrogateMiddle))).status, 422);
  assert.equal((await head()).progress_revision, 2);
  assert.equal(await f.db.collection("behavior_events").countDocuments({ org_id: f.org }), 2);
});
