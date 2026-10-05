const {newId}=require("../dist/database/object-id");
"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { assessmentFixture, practice, good, request, grant, createQuestion, createQuiz } = require('./assessment-helpers.cjs');
const { status } = require('./helpers.cjs');
const { processOne: gradeOne } = require('../dist/assessment/worker.js');
const { processOne: learnOne, processDue } = require('../dist/learning/worker.js');
async function grade(f, key) { for (let n = 0; n < 30; n++) { const row = await f.db.collection('submissions').findOne({ _id: key }); if (row.grading_status === 'completed') return row; assert.equal(await gradeOne(f.db), true); } assert.fail('真实评分未完成'); }
async function submit(f, count = 3) {
  const session = await practice(f, { count });
  const receipt = await good(f.student, `/sessions/${session.id}/submissions`, { method: 'POST', body: { expected_revision: session.revision, answers: [] } }, 202);
  return grade(f, receipt.submission_id);
}
async function project(f) { for (let n = 0; n < 40; n++) if (!await learnOne(f.db)) { await processDue(f.db);  return; } assert.fail('真实学情worker未收敛'); }
const mastery = f => `/me/mastery?subject_id=${f.subject}`;
const mistakes = f => `/me/mistakes?subject_id=${f.subject}`;
const report = f => `/me/reports?subject_id=${f.subject}&period=7d`;
function noInternal(value) { const json = JSON.stringify(value); for (const key of ['projection_revision', 'manifest_digest', 'eligibility_revision', 'requested_revision', 'semantic_digest']) assert.ok(!json.includes(key), key); }

test('S4-03 HTTP门槛、报告、签名游标、错题解析与重练原key独立于旧generation', { timeout: 180000 }, async t => {
  const f = await assessmentFixture(t);
  const empty = await good(f.student, mastery(f));
  assert.equal(empty.status, 'insufficient_evidence'); assert.equal(empty.source_watermark, null); assert.equal(empty.generated_at, null); assert.deepEqual(empty.items, []);
  assert.equal((await good(f.student, report(f))).activity, null);
  f.questions.push(await createQuestion(f)); await submit(f, 4); await project(f);
  const four = await good(f.student, mastery(f)); assert.equal(four.items[0].independent_question_count, 4); assert.equal(four.items[0].mastery, null);
  f.questions.push(await createQuestion(f)); await submit(f, 5);
  const updating = await good(f.student, mastery(f)); assert.equal(updating.status, 'updating'); assert.deepEqual(updating.items, []);
  await project(f);
  const five = await good(f.student, mastery(f)); assert.equal(five.status, 'ready'); assert.equal(five.items[0].independent_question_count, 5); assert.equal(five.items[0].mastery, '0.00'); noInternal(five);
  const summary = await good(f.student, report(f)); assert.equal(summary.activity.attempt_count, 9); assert.equal(summary.activity.unanswered_count, 9); assert.equal(summary.mastery_window_days, 90);
  const page = await good(f.student, mistakes(f) + '&limit=1'); assert.equal(page.total, 5); assert.ok(page.next_cursor); noInternal(page);
  const detail = await good(f.student, `/me/mistakes/${page.items[0].id}`); assert.equal(detail.verdict, 'unanswered'); assert.ok(detail.standard_answer); assert.equal(detail.practice_version_policy, 'current_published');
  const other = await f.actor(); status(await request(other, `/me/mistakes/${page.items[0].id}`), 404);
  status(await request(other, mistakes(f) + `&limit=1&cursor=${encodeURIComponent(page.next_cursor)}`), 422);
  status(await request(f.student, mistakes(f) + `&limit=2&cursor=${encodeURIComponent(page.next_cursor)}`), 422);
  status(await request(f.student, mistakes(f) + `&limit=1&cursor=${encodeURIComponent(page.next_cursor.slice(0, -5) + 'AAAAA')}`), 422);
  const second = await good(f.student, mistakes(f) + `&limit=1&cursor=${encodeURIComponent(page.next_cursor)}`); assert.notEqual(second.items[0].id, page.items[0].id);
  const key = randomUUID(), route = `/me/mistakes/${page.items[0].id}/practice-sessions`;
  const created = await good(f.student, route, { method: 'POST', key, body: {} }); assert.equal(created.item_count, 1);
  const retryItems = await good(f.student, `/sessions/${created.id}/items`);
  const saved = await good(f.student, `/sessions/${created.id}/answers/${retryItems.items[0].id}`, { method: 'PUT', body: { expected_revision: created.revision, answer: null } });
  assert.deepEqual(await good(f.student, route, { method: 'POST', key, body: {} }), created);
  await good(f.student, `/sessions/${created.id}/submissions`, { method: 'POST', body: { expected_revision: saved.revision, answers: [] } }, 202);
  assert.deepEqual(await good(f.student, route, { method: 'POST', key, body: {} }), created);
  const oldGeneration = five.source_watermark.split(':')[1]; await submit(f, 5); await project(f);
  status(await request(f.student, mistakes(f) + `&limit=1&cursor=${encodeURIComponent(page.next_cursor)}`), 409);
  status(await request(f.student, `/me/mistakes/${page.items[0].id}`), 409);
  await f.db.collection('mistake_entries').deleteMany({ generation: oldGeneration });
  const restored = await good(f.student, route, { method: 'POST', key, body: {} }); assert.deepEqual(restored, created);
  assert.equal(await f.db.collection('idempotency_records').countDocuments({ operation: 'learning.mistake.practice', key }), 1);
});

test('S4-03 HTTP隐藏输入稳定、教材失权、重批和滚动窗口即时隔离', { timeout: 180000 }, async t => {
  const f = await assessmentFixture(t), submission = await submit(f); await project(f);
  const before = await good(f.student, report(f));
  const hiddenQuestion = await createQuestion(f), quiz = await createQuiz(f, { items: [{ question_version_id: hiddenQuestion.id, max_score: '1' }] });
  const session = await good(f.student, `/quizzes/${quiz.id}/sessions`, { method: 'POST', body: {} });
  const hidden = await good(f.student, `/sessions/${session.id}/submissions`, { method: 'POST', body: { expected_revision: session.revision, answers: [] } }, 202);
  await grade(f, hidden.submission_id); assert.deepEqual(await good(f.student, report(f)), before); await project(f); assert.deepEqual(await good(f.student, report(f)), before);
  const current = await good(f.reviewer, `/admin/submissions/${submission._id}`);
  await good(f.reviewer, `/submissions/${submission._id}/regrades`, { method: 'POST', body: { expected_revision: current.revision, reason: '真实重批隔离验收' } }, 202);
  const regrading = await good(f.student, report(f)); assert.equal(regrading.activity, null); assert.equal(regrading.source_watermark, null);
  await grade(f, submission._id); await project(f);
  await f.db.collection('submissions').updateOne({ _id: submission._id }, { $set: { submitted_at: new Date(Date.now() - 8 * 86400000) } });
  assert.equal((await good(f.student, report(f))).status, 'updating'); await project(f);
  const aged = await good(f.student, report(f)); assert.equal(aged.activity.attempt_count, 0); assert.equal(aged.mastery[0].independent_question_count, 3);
  await grant(f, f.editor, 'content:revoke');
  const book = await good(f.editor, `/admin/textbook-editions/${f.book.id}`);
  await good(f.editor, `/admin/textbook-editions/${f.book.id}/revoke-access`, { method: 'POST', body: { expected_access_revision: book.access_revision, reason: '教材失权即时隔离验收' } });
  const revoked = await good(f.student, report(f)); assert.equal(revoked.activity, null); assert.equal(revoked.source_watermark, null); noInternal(revoked);
});

test('S4-03 HTTP跨组织、精确四能力冲突、撤销成员与输入白名单', { timeout: 180000 }, async t => {
  const f = await assessmentFixture(t);
  for (const role of ['content_editor', 'content_reviewer']) {
    const actor = await f.actor(['student', role]);
    status(await request(actor, mastery(f)), 403);
  }
  for (const capability of ['assessment:manage', 'assessment:review']) {
    const actor = await f.actor(['student'], [capability]);
    status(await request(actor, mastery(f)), 403);
  }
  const secondOrg = await f.ops.createOrganization(f.context, { name: '第二隔离组织', kind: 'school' });
  const other = await f.actor(['student'], [], secondOrg.organization_id);
  status(await request(other, mastery(f) + `&textbook_edition_id=${f.book.id}`), 404);
  status(await request(f.student, mastery(f) + `&member_id=${other.memberId}`), 422);
  status(await request(f.student, '/me/mastery'), 422);
  status(await request(f.student, `/me/reports?subject_id=${f.subject}&period=90d`), 422);
  status(await request(f.student, `/me/mastery?subject_id=${newId()}`), 404);
  const member = await f.db.collection('organization_members').findOne({ _id: f.student.memberId });
  await f.ops.setMembership(f.context, { user_id: f.student.user.user_id, org_id: f.org, roles: ['student'], status: 'disabled', expected_revision: member.authorization_revision });
  status(await request(f.student, mastery(f)), 403);
});

test('S4-03 错题重练选择当前published版本，修正依据撤销不交付旧数值', { timeout: 180000 }, async t => {
  const f = await assessmentFixture(t), submitted = await submit(f); await project(f);
  const rows = await good(f.student, mistakes(f)), original = f.questions[0];
  const entry = rows.items.find(item => item.question_id === original.question_id); assert.ok(entry);
  const newer = await createQuestion(f, { source_version_id: original.id, answer: 'B' });
  await grant(f, f.editor, 'content:retire');
  const old = await good(f.editor, `/admin/question-versions/${original.id}`);
  await good(f.editor, `/admin/question-versions/${old.id}/retire`, { method: 'POST', body: { expected_revision: old.revision, reason: '历史题停止新引用' } });
  const retried = await good(f.student, `/me/mistakes/${entry.id}/practice-sessions`, { method: 'POST', body: {} });
  const frozen = await f.db.collection('session_items').findOne({ session_id: retried.id }); assert.equal(frozen.snapshot.question_version_id, newer.id);
  const current = await good(f.reviewer, `/admin/submissions/${submitted._id}`);
  await good(f.reviewer, `/submissions/${submitted._id}/regrades`, { method: 'POST', body: { expected_revision: current.revision, reason: '修正依据可见性验收', correction_source_version_id: newer.id } }, 202);
  await grade(f, submitted._id); await project(f);
  const latest = await good(f.student, mistakes(f)), corrected = latest.items.find(item => item.question_id === original.question_id);
  assert.equal((await good(f.student, `/me/mistakes/${corrected.id}`)).standard_answer, 'B');
  await grant(f, f.editor, 'content:revoke');
  const basis = await good(f.editor, `/admin/question-versions/${newer.id}`);
  await good(f.editor, `/admin/question-versions/${basis.id}/revoke-access`, { method: 'POST', body: { expected_access_revision: basis.access_revision, reason: '修正依据授权撤回' } });
  const hidden = await good(f.student, report(f)); assert.equal(hidden.activity, null); assert.equal(hidden.source_watermark, null);
  status(await request(f.student, `/me/mistakes/${corrected.id}`), 409);
});

test('S4-03 空知识筛选、mastery分页与单题详情只登记实际贡献题反馈', { timeout: 180000 }, async t => {
  const f = await assessmentFixture(t), now = new Date(), secondPoint = newId(), emptyPoint = newId();
  await f.db.collection('knowledge_points').insertMany([secondPoint, emptyPoint].map(key => ({ _id: key, subject_id: f.subject, code: key, name: '反馈范围验收', created_at: now, updated_at: now })));
  const secondQuestion = await createQuestion(f, { knowledge_point_ids: [secondPoint], knowledge_weights: [{ knowledge_point_id: secondPoint, weight_bps: 10000 }] });
  // Include both points in the real practice scope rather than manufacturing evidence rows.
  const draft = await good(f.editor, '/admin/textbook-editions', { method: 'POST', body: { title: '反馈范围教材', textbook: { title: '反馈范围教材', stage_id: f.stage, subject_id: f.subject, source: '自主编写' }, edition_code: randomUUID(), license: { source: '原创测试教材', granted: true, expires_at: null } } });
  await good(f.editor, `/admin/textbook-editions/${draft.id}/chapters`, { method: 'PUT', body: { expected_revision: draft.revision, chapters: [{ client_key: randomUUID(), parent_id: null, position: 0, title: '混合知识', body: '原创正文', knowledge_point_ids: [f.knowledge, secondPoint], resource_ids: [] }] } });
  const edited = await good(f.editor, `/admin/textbook-editions/${draft.id}`);
  await good(f.editor, `/admin/textbook-editions/${draft.id}/submit-review`, { method: 'POST', body: { expected_revision: edited.revision } });
  const reviewed = await good(f.contentReviewer, `/admin/textbook-editions/${draft.id}`);
  await good(f.contentReviewer, `/admin/textbook-editions/${draft.id}/publish`, { method: 'POST', body: { expected_revision: reviewed.revision } });
  const session = await good(f.student, '/practice-sessions', { method: 'POST', body: { textbook_edition_id: draft.id, knowledge_point_ids: [f.knowledge, secondPoint], count: 4 } });
  const receipt = await good(f.student, `/sessions/${session.id}/submissions`, { method: 'POST', body: { expected_revision: session.revision, answers: [] } }, 202);
  await grade(f, receipt.submission_id); await project(f);
  const feedback = async () => (await f.db.collection('learning_question_states').find({ org_id: f.org, user_id: f.student.user.user_id }).toArray()).filter(row => row.feedback_seen).map(row => row.question_id).sort();
  assert.deepEqual(await feedback(), []);
  assert.deepEqual((await good(f.student, mastery(f) + `&knowledge_point_id=${emptyPoint}`)).items, []);
  assert.deepEqual(await feedback(), []);
  const page = await good(f.student, mastery(f) + '&limit=1');
  const firstPoint = page.items[0].knowledge_point_id;
  const expected = firstPoint === secondPoint ? [secondQuestion.question_id] : f.questions.map(question => question.question_id);
  assert.deepEqual(await feedback(), expected.sort());
  const untouchedQuestion = firstPoint === secondPoint ? f.questions[0].question_id : secondQuestion.question_id;
  const entry = await f.db.collection('mistake_entries').findOne({ org_id: f.org, member_id: f.student.memberId, question_id: untouchedQuestion });
  await good(f.student, `/me/mistakes/${entry._id}`);
  assert.deepEqual(await feedback(), [...new Set([...expected, untouchedQuestion])].sort());
  await good(f.student, report(f)); assert.equal((await feedback()).length, 4);
});

test('S4-03 501个隐藏pending提交不改变外部空学情状态或水位', { timeout: 180000 }, async t => {
  const f = await assessmentFixture(t), before = await good(f.student, mastery(f));
  const session = await practice(f), receipt = await good(f.student, `/sessions/${session.id}/submissions`, { method: 'POST', body: { expected_revision: session.revision, answers: [] } }, 202);
  const originalSession = await f.db.collection('sessions').findOne({ _id: session.id });
  const originalSubmission = await f.db.collection('submissions').findOne({ _id: receipt.submission_id });
  const originalRun = await f.db.collection('grading_runs').findOne({ submission_id: receipt.submission_id });
  const originalItems = await f.db.collection('session_items').find({ session_id: session.id }).toArray();
  // Real persisted pending inputs; no completed result or derived projection is fabricated.
  const sessions = [], submissions = [], runs = [], items = [];
  for (let index = 0; index < 500; index++) {
    const sid = newId(), submissionId = newId();
    sessions.push({ ...originalSession, _id: sid, submission_id: submissionId });
    submissions.push({ ...originalSubmission, _id: submissionId, session_id: sid });
    runs.push({ ...originalRun, _id: newId(), submission_id: submissionId });
    items.push(...originalItems.map(item => ({ ...item, _id: newId(), session_id: sid })));
  }
  await f.db.collection('sessions').insertMany(sessions); await f.db.collection('submissions').insertMany(submissions);
  await f.db.collection('grading_runs').insertMany(runs); await f.db.collection('session_items').insertMany(items);
  const after = await good(f.student, mastery(f)); assert.deepEqual(after, before);
  assert.equal(await f.db.collection('learning_question_states').countDocuments({ user_id: f.student.user.user_id, feedback_seen: true }), 0);
});

// Per-fixture proxies execute real MongoDB calls; only failure/pause timing is injected.
// This is not a network outage, and no successful database result is manufactured.
function interceptLearningDb(f, hook) {
  const { Database } = require('../dist/database/database.js');
  const db = f.app.get(Database).db, original = db.collection;
  db.collection = function (name, ...args) {
    const collection = original.call(this, name, ...args);
    return new Proxy(collection, { get(target, method) {
      const value = Reflect.get(target, method, target);
      if (typeof value !== 'function') return value;
      if (!['findOne', 'updateOne'].includes(method)) return value.bind(target);
      return (...parameters) => hook({ db, name, method, parameters, run: () => value.apply(target, parameters) });
    } });
  };
  return () => { db.collection = original; };
}

test('S4-03 HTTP跨submission后项反馈失败回滚前项个人账本与全局披露', { timeout: 180000 }, async t => {
  const f = await assessmentFixture(t);
  const submissions = [await submit(f), await submit(f)].sort((a, b) => a._id.localeCompare(b._id));
  await project(f);
  const personalFilter = { org_id: f.org, user_id: f.student.user.user_id };
  const globalFilter = { org_id: f.org, question_version_id: { $in: f.questions.map(row => row.id) } };
  const ledger = options => f.db.collection('learning_question_states').find(personalFilter, options).sort({ _id: 1 }).toArray();
  const disclosure = options => f.db.collection('assessment_question_states').find(globalFilter, options).sort({ _id: 1 }).toArray();
  const beforePersonal = await ledger(), beforeGlobal = await disclosure();
  assert.equal(beforePersonal.length, 3); assert.ok(beforePersonal.every(row => !row.feedback_seen));
  assert.equal(beforeGlobal.length, 3); assert.ok(beforeGlobal.every(row => !row.answer_disclosed));
  let firstFeedbackWritten = false, injected = false, insidePersonal, insideGlobal;
  const restore = interceptLearningDb(f, async ({ db, name, method, parameters, run }) => {
    if (name === 'learning_question_states' && method === 'updateOne' && parameters[1].$set?.feedback_seen === true) {
      const result = await run(); firstFeedbackWritten = true; return result;
    }
    // Projection checks have no feedback writes. This is the later submission's
    // delivery lookup, after the first one's real global and personal writes.
    if (name === 'submissions' && method === 'findOne' && parameters[0]._id === submissions[1]._id && firstFeedbackWritten) {
      injected = true;
      const options = { session: parameters[1].session };
      insidePersonal = await db.collection('learning_question_states').find(personalFilter, options).sort({ _id: 1 }).toArray();
      insideGlobal = await db.collection('assessment_question_states').find(globalFilter, options).sort({ _id: 1 }).toArray();
      throw new Error('INJECTED_LATER_SUBMISSION_FEEDBACK_FAILURE');
    }
    return run();
  });
  let response;
  try { response = await request(f.student, report(f)); }
  finally { restore(); }
  assert.equal(injected, true, '必须在后项投递处真实触发注入');
  assert.ok(insidePersonal.every(row => row.feedback_seen), '前项个人反馈写已在同一事务发生');
  assert.ok(insideGlobal.every(row => row.answer_disclosed), '前项全局披露写已在同一事务发生');
  status(response, 503); assert.equal(response.data.error.code, 'DEPENDENCY_UNAVAILABLE');
  assert.equal(response.data.data, undefined);
  assert.deepEqual(await ledger(), beforePersonal);
  assert.deepEqual(await disclosure(), beforeGlobal);
  const recovered = await good(f.student, report(f));
  assert.equal(recovered.activity.submission_count, 2); assert.equal(recovered.activity.attempt_count, 6);
  assert.ok((await ledger()).every(row => row.feedback_seen));
  assert.ok((await disclosure()).every(row => row.answer_disclosed));
});

for (const change of ['来源撤销', 'embargo']) {
  test(`S4-03 HTTP读取旧快照与${change}提交交错不泄漏失效generation`, { timeout: 180000 }, async t => {
    const f = await assessmentFixture(t);
    await submit(f); await project(f);
    const partition = { org_id: f.org, member_id: f.student.memberId, subject_id: f.subject };
    const head = await f.db.collection('learning_projection_heads').findOne(partition);
    assert.ok(head.active_generation);
    const oldMistake = await f.db.collection('mistake_entries').findOne({ ...partition, generation: head.active_generation });
    assert.ok(oldMistake);
    let book;
    if (change === '来源撤销') {
      await grant(f, f.editor, 'content:revoke');
      book = await good(f.editor, `/admin/textbook-editions/${f.book.id}`);
    }
    // Embargo is global to the question version. Use another participant so
    // publication does not wait on the paused reader's user/member fences.
    const participant = change === 'embargo' ? await f.actor() : null;
    let resume, reached, paused = false, timer;
    const released = new Promise(resolve => { resume = resolve; });
    const entered = new Promise(resolve => { reached = resolve; });
    const { AuthService } = require('../dist/auth.service.js');
    const auth = f.app.get(AuthService), organizations = auth.c.organizations;
    const originalUpdate = organizations.updateOne;
    organizations.updateOne = async function (...parameters) {
      if (!paused && parameters[0]._id === f.org) {
        paused = true;
        // Authorization already established this read's snapshot. Pause before
        // its shared organization/scope fences so the competing write can commit.
        const snapshot = await auth.database.db.collection('learning_projection_heads').findOne(partition, { session: parameters[2].session });
        reached(snapshot);
        await released;
      }
      return originalUpdate.apply(this, parameters);
    };
    const pending = request(f.student, report(f));
    let response;
    try {
      const snapshot = await Promise.race([
        entered,
        pending.then(() => { throw new Error('读取未到交错点便已结束'); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('读取未到达交错点')), 10000); }),
      ]);
      clearTimeout(timer);
      assert.equal(snapshot.active_generation, head.active_generation);
      if (change === '来源撤销') {
        await good(f.editor, `/admin/textbook-editions/${f.book.id}/revoke-access`, { method: 'POST', body: { expected_access_revision: book.access_revision, reason: '读取并发交错验收' } });
      } else {
        const quiz = await createQuiz(f, { audience_member_ids: [participant.memberId], items: [{ question_version_id: f.questions[0].id, max_score: '1' }] });
        assert.equal(quiz.status, 'published');
      }
      resume();
      response = await pending;
    } finally {
      clearTimeout(timer); resume(); organizations.updateOne = originalUpdate;
      await pending.catch(() => undefined);
    }
    status(response, 200);
    const hidden = response.data.data;
    assert.equal(hidden.status, 'insufficient_evidence');
    assert.equal(hidden.source_watermark, null); assert.equal(hidden.generated_at, null);
    assert.equal(hidden.activity, null); assert.deepEqual(hidden.mastery, []); noInternal(hidden);
    assert.equal(await f.db.collection('learning_question_states').countDocuments({ org_id: f.org, user_id: f.student.user.user_id, feedback_seen: true }), 0);
    assert.equal(await f.db.collection('assessment_question_states').countDocuments({ org_id: f.org, question_version_id: { $in: f.questions.map(row => row.id) }, answer_disclosed: true }), 0);
    const detail = await request(f.student, `/me/mistakes/${oldMistake._id}`);
    status(detail, 409); assert.equal(detail.data.error.code, 'PROJECTION_CHANGED');
    assert.equal(detail.data.data, undefined);
  });
}
