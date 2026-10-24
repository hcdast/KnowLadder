"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assessmentFixture, good, request } = require('./assessment-helpers.cjs');
const { newId } = require('../dist/database/object-id');

test('名称仅随已授权教材范围与合法候选题返回，不开放学科目录或无权题目', async t => {
  const f = await assessmentFixture(t);
  const options = await good(f.student, `/practice-options?textbook_edition_id=${f.book.id}`);
  assert.equal(options.subject_id, f.subject);
  assert.equal(options.subject_name, '验收学科');
  const candidates = await good(f.manager, '/admin/assessment-questions');
  assert.ok(candidates.items.length > 0);
  assert.ok(candidates.items.every(row => row.subject_id === f.subject && row.subject_name === '验收学科'));
  const hidden = newId();
  await f.db.collection('subjects').insertOne({ _id: hidden, code: 'unrelated', name: '不可通过空题目范围读取的名称', created_at: new Date(), updated_at: new Date() });
  const empty = await good(f.manager, `/admin/assessment-questions?subject_id=${hidden}`);
  assert.deepEqual(empty.items, []);
  const denied = await request(f.student, '/admin/assessment-questions');
  assert.equal(denied.status, 403);
  assert.ok(!JSON.stringify(denied.data).includes('验收学科'));
  await f.db.collection('textbook_editions').updateOne({ _id: f.book.id }, { $set: { access_revoked_at: new Date() } });
  const revoked = await request(f.student, `/practice-options?textbook_edition_id=${f.book.id}`);
  assert.ok([403, 404, 409].includes(revoked.status));
  assert.ok(!JSON.stringify(revoked.data).includes('验收学科'));
});
