"use strict";
const {newId}=require("../dist/database/object-id");
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

test("学情追踪：真实HTTP首见、事务与授权撤销", { concurrency: false, timeout: 600000 }, async t => {
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
  await t.test("事务回滚不占首见；legacy账号题组合与旧题项保持unknown", async t => {
    const f = await assessmentFixture(t);
    const { reserveLearningContexts } = require("../dist/learning/tracking.js");
    const session = await practice(f);
    const items = await frozen(f, session);
    const fresh = await f.actor();
    const tx = f.db.client.startSession();
    try {
      await assert.rejects(tx.withTransaction(async () => {
        await reserveLearningContexts(f.db, { orgId: f.org, userId: fresh.user.user_id, memberId: fresh.memberId, capabilities: ["learning:self"], requestId: randomUUID(), session: tx }, items.map(row => ({ ...row, _id: newId() })));
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
