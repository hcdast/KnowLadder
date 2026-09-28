"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { assessmentFixture, practice, good, request } = require("./assessment-helpers.cjs");
const { guardedUri, status } = require("./helpers.cjs");
const { processOne, processVisibility } = require("../dist/assessment/worker.js");
const { studentAssessmentEvidence } = require("../dist/assessment/student-evidence.js");

async function check(f, submissionId, change = {}) {
  const session = f.db.client.startSession();
  try {
    return await session.withTransaction(async () => {
      const submission = await f.db.collection("submissions").findOne({ _id: submissionId }, { session });
      return studentAssessmentEvidence(f.db, { orgId: f.org, userId: "system:learning", memberId: f.student.memberId,
        capabilities: ["learning:projection-worker"], requestId: randomUUID(), session, ...change }, submission, "projection_check");
    });
  } finally { await session.endSession(); }
}

test("student evidence shares strict completeness, source gates and non-disclosing background checks", { concurrency: false, timeout: 180000 }, async t => {
  guardedUri(process.env.TEST_MONGODB_URI);
  const f = await assessmentFixture(t);
  const attempt = await practice(f);
  const receipt = await good(f.student, `/sessions/${attempt.id}/submissions`, { method: "POST", body: { expected_revision: attempt.revision, answers: [] } }, 202);
  assert.equal(await processOne(f.db), true);
  const evidence = await check(f, receipt.submission_id);
  assert.equal(evidence.status, "released");
  assert.equal(evidence.results.length, 3);
  assert.equal(evidence.subjectId, f.subject);
  assert.equal(await f.db.collection("assessment_question_states").countDocuments({ org_id: f.org, answer_disclosed: true }), 0);
  assert.equal(await f.db.collection("learning_question_states").countDocuments({ org_id: f.org, user_id: f.student.user.user_id, feedback_seen: true }), 0);
  await processVisibility(f.db);
  assert.equal(await f.db.collection("assessment_question_states").countDocuments({ org_id: f.org, answer_disclosed: true }), 0);
  await assert.rejects(check(f, receipt.submission_id, { capabilities: ["learning:projection-worker", "learning:self"] }), error => error.getStatus() === 403);
  await assert.rejects(check(f, receipt.submission_id, { memberId: f.reviewer.memberId }), error => error.getStatus() === 403);

  const missing = evidence.results[0];
  await f.db.collection("grading_results").deleteOne({ _id: missing._id });
  await assert.rejects(check(f, receipt.submission_id), error => error.getStatus() === 503);
  status(await request(f.student, `/submissions/${receipt.submission_id}`), 503);
  await f.db.collection("grading_results").insertOne(missing);

  const expires = new Date(Date.now() + 3600000).toISOString();
  await f.db.collection("textbook_editions").updateOne({ _id: f.book.id }, { $set: { "license.expires_at": expires } });
  assert.equal((await check(f, receipt.submission_id)).nextCheckAt.toISOString(), expires);
  await f.db.collection("textbook_editions").updateOne({ _id: f.book.id }, [{ $set: { "license.expires_at": { $dateToString: { date: { $subtract: ["$$NOW", 1000] }, format: "%Y-%m-%dT%H:%M:%S.%LZ" } } } }]);
  assert.equal((await check(f, receipt.submission_id)).status, "withheld_access");
  assert.equal((await good(f.student, `/submissions/${receipt.submission_id}`)).release_status, "withheld_access");
  assert.equal(await f.db.collection("learning_question_states").countDocuments({ org_id: f.org, user_id: f.student.user.user_id, feedback_seen: true }), 0);
  await f.db.collection("textbook_editions").updateOne({ _id: f.book.id }, { $set: { "license.expires_at": expires } });
  assert.equal((await good(f.student, `/submissions/${receipt.submission_id}`)).release_status, "released");
  assert.equal(await f.db.collection("assessment_question_states").countDocuments({ org_id: f.org, answer_disclosed: true }), 3);
  assert.equal(await f.db.collection("learning_question_states").countDocuments({ org_id: f.org, user_id: f.student.user.user_id, feedback_seen: true }), 3);
});

test("unreleased quiz evidence exposes no results and retains its internal time boundary", { concurrency: false, timeout: 180000 }, async t => {
  guardedUri(process.env.TEST_MONGODB_URI);
  const f = await assessmentFixture(t, { publishedQuiz: true });
  const attempt = await good(f.student, `/quizzes/${f.quiz.id}/sessions`, { method: "POST", body: {} });
  const receipt = await good(f.student, `/sessions/${attempt.id}/submissions`, { method: "POST", body: { expected_revision: attempt.revision, answers: [] } }, 202);
  assert.equal(await processOne(f.db), true);
  const hidden = await check(f, receipt.submission_id);
  assert.equal(hidden.status, "pending");
  assert.equal(hidden.run, null);
  assert.deepEqual(hidden.results, []);
  assert.equal(hidden.subjectId, f.subject);
  const quiz = await f.db.collection("quizzes").findOne({ _id: f.quiz.id });
  assert.equal(hidden.nextCheckAt.getTime(), quiz.release_at.getTime());
  const view = await good(f.student, `/submissions/${receipt.submission_id}`);
  assert.equal(view.release_status, "pending");
  assert.equal(Object.hasOwn(view, "total_score"), false);
  assert.equal(await f.db.collection("learning_question_states").countDocuments({ org_id: f.org, user_id: f.student.user.user_id, feedback_seen: true }), 0);
});
