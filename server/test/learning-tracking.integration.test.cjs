"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { assessmentFixture, practice, good, grant, createQuiz } = require("./assessment-helpers.cjs");
const { guardedUri } = require("./helpers.cjs");

async function frozen(f, session) {
  return f.db.collection("session_items").find({ session_id: session.id }).sort({ position: 1 }).toArray();
}
async function submit(f, session) {
  return good(f.student, `/sessions/${session.id}/submissions`, { method: "POST", body: { expected_revision: session.revision, answers: [] } }, 202);
}
async function grade(f, submissionId) {
  const { processOne } = require("../dist/assessment/worker.js");
  for (let n = 0; n < 20; n++) {
    const row = await f.db.collection("submissions").findOne({ _id: submissionId });
    if (row.grading_status === "completed") return;
    assert.ok(["pending", "running"].includes(row.grading_status));
    await processOne(f.db);
  }
  assert.fail("评分worker未完成真实提交");
}

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("追踪并发屏障未到达")), 10000);
    })]);
  } finally { clearTimeout(timer); }
}

test("学情追踪：真实HTTP首见、事务与曝光", { concurrency: false, timeout: 600000 }, async t => {
  guardedUri(process.env.TEST_MONGODB_URI);
  await t.test("同账号并发会话及原key恢复至多一个首次；提交后反馈不改封存", async t => {
    const f = await assessmentFixture(t);
    const key = randomUUID();
    const [a, b] = await Promise.all([practice(f, {}, key), practice(f)]);
    const entries = [...await frozen(f, a), ...await frozen(f, b)];
    for (const question of f.questions) assert.equal(entries.filter(row => row.snapshot.question_id === question.question_id && row.learning_context.qualification === "first").length, 1);
    const before = await f.db.collection("learning_question_states").find({ user_id: f.student.user.user_id }).sort({ question_id: 1 }).toArray();
    assert.deepEqual(await practice(f, {}, key), a);
    assert.deepEqual(await f.db.collection("learning_question_states").find({ user_id: f.student.user.user_id }).sort({ question_id: 1 }).toArray(), before);
    const accepted = await submit(f, a);
    const contexts = await f.db.collection("learning_attempt_contexts").find({ submission_id: accepted.submission_id }).sort({ session_item_id: 1 }).toArray();
    assert.equal(contexts.length, 3);
    await grade(f, accepted.submission_id);
    const result = await good(f.student, `/submissions/${accepted.submission_id}`);
    assert.equal(result.release_status, "released");
    assert.equal(await f.db.collection("learning_question_states").countDocuments({ user_id: f.student.user.user_id, feedback_seen: true }), 3);
    assert.deepEqual(await f.db.collection("learning_attempt_contexts").find({ submission_id: accepted.submission_id }).sort({ session_item_id: 1 }).toArray(), contexts);
    assert.ok((await frozen(f, await practice(f))).every(row => row.learning_context.qualification === "repeated"));
  });
  await t.test("管理员本人预览使未终结首次变exposed，但不禁止自主练习", async t => {
    const f = await assessmentFixture(t);
    const session = await practice(f);
    await grant(f, f.student, "assessment:manage");
    const question = f.questions[0];
    await good(f.student, `/admin/assessment-questions/${question.id}`);
    const accepted = await submit(f, session);
    const context = await f.db.collection("learning_attempt_contexts").findOne({ submission_id: accepted.submission_id, question_id: question.question_id });
    assert.equal(context.qualification, "exposed");
    assert.equal(context.reason, "prior_feedback");
    assert.ok((await practice(f)).id);
  });
  for (const previewFirst of [true, false]) {
    await t.test(`本人预览与practice终结真实HTTP交错：${previewFirst ? "曝光先提交封存exposed" : "终结先提交封存first"}`, async t => {
      const f = await assessmentFixture(t);
      const session = await practice(f);
      const items = await frozen(f, session);
      assert.ok(items.every(item => item.learning_context.qualification === "first"));
      await grant(f, f.student, "assessment:manage");
      const question = f.questions[0];
      const scope = { org_id: f.org, user_id: f.student.user.user_id };
      const states = () => f.db.collection("learning_question_states").find(scope).sort({ question_id: 1 }).toArray();
      const contexts = () => f.db.collection("learning_attempt_contexts").find(scope).sort({ session_item_id: 1 }).toArray();
      const before = await states();
      const originalSession = await f.db.collection("sessions").findOne({ _id: session.id });
      const key = randomUUID();
      const preview = () => good(f.student, `/admin/assessment-questions/${question.id}`);
      const finish = () => good(f.student, `/sessions/${session.id}/submissions`, {
        method: "POST", key, body: { expected_revision: session.revision, answers: [] },
      }, 202);
      const { Collection } = require("mongoose").mongo;
      const method = previewFirst ? "updateOne" : "insertOne";
      const originalWrite = Collection.prototype[method];
      const originalFind = Collection.prototype.findOne;
      const written = gate(), commit = gate(), contenderReached = gate(), contenderResume = gate();
      let winnerTransaction, contenderTransaction;
      // Pause only AFTER a real transactional write: feedback, or the complete
      // submission/context/run/outbox bundle. Never replace a driver result.
      Collection.prototype[method] = async function (...args) {
        const result = await originalWrite.apply(this, args);
        const matches = previewFirst
          ? this.namespace === `${f.db.databaseName}.learning_question_states` &&
            args[0]._id === before.find(row => row.question_id === question.question_id)._id && args[1].$set?.feedback_seen === true
          : this.namespace === `${f.db.databaseName}.outbox_events` &&
            args[0].org_id === f.org && args[0].event_type === "SubmissionAccepted";
        if (matches && !winnerTransaction) {
          winnerTransaction = args[previewFirst ? 2 : 1].session;
          assert.equal(winnerTransaction.inTransaction(), true);
          written.release();
          await bounded(commit.promise);
        }
        return result;
      };
      // The second HTTP request must enter the real transaction before the
      // first may commit; park before authorization write fences to avoid a
      // lock-dependent winner or sleep-based scheduling.
      Collection.prototype.findOne = async function (...args) {
        if (winnerTransaction && !contenderTransaction &&
            this.namespace === `${f.db.databaseName}.users` &&
            args[1]?.session && args[1].session !== winnerTransaction) {
          contenderTransaction = args[1].session;
          assert.equal(contenderTransaction.inTransaction(), true);
          contenderReached.release();
          await bounded(contenderResume.promise);
        }
        return originalFind.apply(this, args);
      };
      const pending = [];
      const launch = action => {
        const promise = action().then(value => ({ value }), error => ({ error }));
        pending.push(promise);
        return promise;
      };
      const unwrap = async promise => {
        const result = await bounded(promise);
        if (result.error) throw result.error;
        return result.value;
      };
      try {
        const winner = launch(previewFirst ? preview : finish);
        await bounded(written.promise);
        const contender = launch(previewFirst ? finish : preview);
        await bounded(contenderReached.promise);
        assert.notEqual(winnerTransaction, contenderTransaction);
        assert.deepEqual(await states(), before, "未commit曝光/封存不得泄漏半份题目账本");
        assert.deepEqual(await contexts(), []);
        assert.deepEqual(await f.db.collection("sessions").findOne({ _id: session.id }), originalSession);
        for (const name of ["submissions", "grading_runs", "outbox_events"])
          assert.equal(await f.db.collection(name).countDocuments({ org_id: f.org }), 0);
        commit.release();
        const first = await unwrap(winner);
        const firstContexts = await contexts();
        assert.equal(firstContexts.length, previewFirst ? 0 : items.length);
        contenderResume.release();
        const second = await unwrap(contender);
        const accepted = previewFirst ? second : first;
        const sealed = await contexts();
        assert.equal(sealed.length, items.length);
        for (const item of items) {
          const rows = sealed.filter(row => row.session_item_id === item._id);
          assert.equal(rows.length, 1);
          assert.equal(rows[0].submission_id, accepted.submission_id);
          const exposed = previewFirst && item.snapshot.question_id === question.question_id;
          assert.equal(rows[0].qualification, exposed ? "exposed" : "first");
          assert.equal(rows[0].reason, exposed ? "prior_feedback" : "first_seen");
        }
        if (!previewFirst) assert.deepEqual(sealed, firstContexts, "后提交曝光不得追溯改变终结封存");
        for (const row of await states()) {
          assert.equal(row.sealed_submission_id, accepted.submission_id);
          assert.equal(row.first_session_item_id, items.find(item => item.snapshot.question_id === row.question_id)._id);
          assert.equal(row.feedback_seen, row.question_id === question.question_id);
        }
        await preview();
        const afterPreview = await states();
        assert.deepEqual(await finish(), accepted, "原key恢复同一提交而非再次申请首次资格");
        assert.deepEqual(await contexts(), sealed);
        assert.deepEqual(await states(), afterPreview);
        const terminal = await f.db.collection("sessions").findOne({ _id: session.id });
        assert.equal(terminal.status, "submitted");
        assert.equal(terminal.submission_id, accepted.submission_id);
        assert.equal(terminal.revision, session.revision + 1);
        assert.equal(await f.db.collection("submissions").countDocuments({ session_id: session.id }), 1);
        const runs = await f.db.collection("grading_runs").find({ submission_id: accepted.submission_id }).toArray();
        assert.equal(runs.length, 1);
        const events = await f.db.collection("outbox_events").find({ aggregate_id: accepted.submission_id, event_type: "SubmissionAccepted" }).toArray();
        assert.equal(events.length, 1);
        assert.equal(events[0].payload.grading_run_id, runs[0]._id);
        assert.equal(events[0].payload.submission_id, accepted.submission_id);
        assert.equal(await f.db.collection("idempotency_records").countDocuments({ org_id: f.org, operation: "session.submit", resource_id: session.id, key }), 1);
      } finally {
        commit.release();
        contenderResume.release();
        try { await bounded(Promise.allSettled(pending)); }
        finally {
          Collection.prototype[method] = originalWrite;
          Collection.prototype.findOne = originalFind;
        }
      }
    });
  }
  await t.test("事务回滚不占首见；legacy账号题组合与旧题项保持unknown", async t => {
    const f = await assessmentFixture(t);
    const { reserveLearningContexts } = require("../dist/learning/tracking.js");
    const session = await practice(f);
    const items = await frozen(f, session);
    const fresh = await f.actor();
    const tx = f.db.client.startSession();
    try {
      await assert.rejects(tx.withTransaction(async () => {
        await reserveLearningContexts(f.db, { orgId: f.org, userId: fresh.user.user_id, memberId: fresh.memberId, capabilities: ["learning:self"], requestId: randomUUID(), session: tx }, items.map(row => ({ ...row, _id: randomUUID() })));
        throw new Error("intentional transaction abort");
      }), /intentional transaction abort/);
    } finally { await tx.endSession(); }
    assert.equal(await f.db.collection("learning_question_states").countDocuments({ user_id: fresh.user.user_id }), 0);
    const settings = await f.db.collection("learning_tracking_config").findOne({ _id: "tracking" });
    const legacyDate = new Date(settings.cutover_at.getTime() - 1000);
    await f.db.collection("users").updateOne({ _id: fresh.user.user_id }, { $set: { created_at: legacyDate } });
    await f.db.collection("questions").updateMany({ org_id: f.org }, { $set: { created_at: legacyDate } });
    const legacy = await practice({ ...f, student: fresh });
    assert.ok((await frozen(f, legacy)).every(row => row.learning_context.qualification === "unknown"));
    await f.db.collection("session_items").updateMany({ session_id: session.id }, { $unset: { learning_context: "" } });
    const accepted = await submit(f, session);
    assert.equal(await f.db.collection("learning_attempt_contexts").countDocuments({ submission_id: accepted.submission_id, qualification: "unknown" }), 3);
  });
  await t.test("内容撤销和考试保密建立原子推进scope，日常管理读取不推进语义revision", async t => {
    const f = await assessmentFixture(t);
    const scope = () => f.db.collection("learning_scope_states").findOne({ org_id: f.org, subject_id: f.subject });
    const before = await scope();
    await good(f.editor, `/admin/question-versions/${f.questions[0].id}`);
    const read = await scope();
    assert.equal(read.eligibility_revision, before.eligibility_revision);
    const quiz = await createQuiz(f);
    assert.ok(quiz.id);
    const embargo = await scope();
    assert.ok(embargo.eligibility_revision > read.eligibility_revision);
    await grant(f, f.editor, "content:revoke");
    const question = await good(f.editor, `/admin/question-versions/${f.questions[0].id}`);
    await good(f.editor, `/admin/question-versions/${question.id}/revoke-access`, { method: "POST", body: { expected_access_revision: question.access_revision, reason: "隔离测试撤回" } });
    assert.ok((await scope()).eligibility_revision > embargo.eligibility_revision);
  });
});
