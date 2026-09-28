"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const { assessmentFixture, practice, good, request, grant } = require("./assessment-helpers.cjs");
const { guardedUri, status } = require("./helpers.cjs");
const { processOne, processDeadlines, processVisibility, reconcile } = require("../dist/assessment/worker.js");

async function accepted(f) {
  const session = await practice(f);
  const receipt = await good(f.student, `/sessions/${session.id}/submissions`, {
    method: "POST", body: { expected_revision: session.revision, answers: [] },
  }, 202);
  return target(f, receipt.submission_id);
}
async function target(f, submissionId) {
  const submission = await f.db.collection("submissions").findOne({ _id: submissionId });
  const run = await f.db.collection("grading_runs").findOne({ submission_id: submissionId, revision: submission.requested_grading_revision });
  const event = await f.db.collection("outbox_events").findOne({ "payload.grading_run_id": run._id, target_consumer: "grading_v1" });
  assert.ok(event);
  return { submission, run, event };
}
async function noSuccess(f, current) {
  assert.equal(await f.db.collection("grading_results").countDocuments({ grading_run_id: current.run._id }), 0);
  assert.equal(await f.db.collection("consumer_receipts").countDocuments({ event_id: current.event._id }), 0);
  assert.equal(await f.db.collection("outbox_events").countDocuments({ event_type: "GradeFinalized", "payload.grading_run_id": current.run._id }), 0);
}
async function terminal(f, original, state, code, attempt) {
  const current = await target(f, original.submission._id);
  assert.equal(current.submission.grading_status, state);
  assert.equal(current.run.status, state);
  assert.equal(current.event.status, "failed");
  for (const row of [current.submission, current.run, current.event]) assert.equal(row.error_code, code);
  assert.equal(current.event.attempt, attempt);
  assert.equal(current.event.processed_at, null);
  assert.ok(current.run.completed_at instanceof Date);
  for (const field of ["lease_owner", "lease_token", "lease_until"]) assert.equal(current.event[field], null);
  assert.equal(current.submission.revision, original.submission.revision + 1);
  assert.equal(current.submission.effective_grading_revision, original.submission.effective_grading_revision);
  assert.equal(current.submission.total_score?.toString(), original.submission.total_score?.toString());
  await noSuccess(f, current);
  assert.equal(await processOne(f.db), false, "终态事件不得重新领取");
  assert.deepEqual(await target(f, original.submission._id), current);
  return current;
}
async function hidden(f, submissionId, releaseStatus) {
  for (const [actor, route] of [[f.student, `/submissions/${submissionId}`], [f.reviewer, `/admin/submissions/${submissionId}`]]) {
    const view = await good(actor, route);
    assert.equal(view.release_status, releaseStatus);
    for (const field of ["total_score", "max_score", "items", "standard_answer", "explanation"]) assert.equal(Object.hasOwn(view, field), false);
  }
  const items = await request(f.student, `/submissions/${submissionId}/items`);
  status(items, 409);
  assert.equal(items.data.error.code, "RESULT_NOT_RELEASED");
}

// The wrapper is passed only to this worker invocation. It forwards every real
// database operation unchanged; no prototype, global, failpoint or fake result.
// Throw only AFTER MongoDB has inserted all item results inside the final txn.
function failAfterResults(parent, child, f, current) {
  let enabled = true;
  let hits = 0;
  const observations = [];
  const restore = () => { enabled = false; };
  parent.after(restore);
  child.after(restore);
  const db = new Proxy(f.db, { get(targetDb, property) {
    if (property === "collection") return (name, ...args) => {
      const collection = targetDb.collection(name, ...args);
      if (name !== "grading_results") return collection;
      return new Proxy(collection, { get(targetCollection, method) {
        if (method === "insertMany") return async (documents, options) => {
          const result = await targetCollection.insertMany(documents, options);
          if (enabled && documents.every(row => row.grading_run_id === current.run._id)) {
            hits++;
            const session = options?.session;
            // Record, then assert outside processOne: its error handler must not
            // accidentally swallow an assertion failure as a simulated fault.
            observations.push({
              inTransaction: !!session?.inTransaction(),
              inserted: result.insertedCount,
              inside: await targetCollection.countDocuments({ grading_run_id: current.run._id }, { session }),
              outside: await f.db.collection(name).countDocuments({ grading_run_id: current.run._id }),
              insideSubmission: await f.db.collection("submissions").findOne({ _id: current.submission._id }, { session }),
              outsideSubmission: await f.db.collection("submissions").findOne({ _id: current.submission._id }),
            });
            throw new Error("ISOLATED_POST_WRITE_DEPENDENCY_FAILURE");
          }
          return result;
        };
        const value = Reflect.get(targetCollection, method, targetCollection);
        return typeof value === "function" ? value.bind(targetCollection) : value;
      } });
    };
    const value = Reflect.get(targetDb, property, targetDb);
    return typeof value === "function" ? value.bind(targetDb) : value;
  } });
  return { db, restore, check(expected) {
    assert.equal(hits, expected, "必须经过真实评分结果写入后注入故障");
    for (const observation of observations) {
      assert.equal(observation.inTransaction, true);
      assert.equal(observation.inserted, 3);
      assert.equal(observation.inside, 3);
      assert.equal(observation.outside, 0);
      assert.equal(observation.insideSubmission.grading_status, "completed");
      assert.equal(observation.insideSubmission.effective_grading_revision, current.run.revision);
      assert.deepEqual(observation.outsideSubmission, current.submission);
    }
  } };
}
async function waitForRetry(f, current) {
  // Respect the actual persisted retry schedule and MongoDB clock; no timestamp
  // rewriting, sleeps based on the application clock, or skipped backoff.
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await f.db.collection("outbox_events").findOne({ _id: current.event._id, status: "pending", $expr: { $lte: ["$available_at", "$$NOW"] } })) return;
    await delay(50);
  }
  assert.fail("数据库重试调度未在有界时间内到期");
}
async function pendingAfterRollback(f, current, attempt) {
  const after = await target(f, current.submission._id);
  assert.deepEqual(after.submission, current.submission);
  assert.deepEqual(after.run, current.run);
  assert.equal(after.event.status, "pending");
  assert.equal(after.event.attempt, attempt);
  assert.equal(after.event.error_code, "GRADING_DEPENDENCY_UNAVAILABLE");
  assert.equal(after.event.processed_at, null);
  assert.ok(after.event.available_at > after.event.updated_at);
  for (const field of ["lease_owner", "lease_token", "lease_until"]) assert.equal(after.event[field], null);
  await noSuccess(f, current);
}

test("S3-06 worker终态与最终评分事务原子性", { concurrency: false, timeout: 240000 }, async parent => {
  guardedUri(process.env.TEST_MONGODB_URI);
  await parent.test("S5 普通disabled仍完成已受理评分", async t => {
    const f = await assessmentFixture(t);
    const current = await accepted(f);
    await f.db.collection("users").updateOne({ _id: f.student.user.user_id }, { $set: { status: "disabled" } });
    assert.equal(await processOne(f.db), true);
    const finished = await target(f, current.submission._id);
    assert.equal(finished.submission.grading_status, "completed");
    assert.equal(finished.event.status, "processed");
    assert.equal(await f.db.collection("grading_results").countDocuments({ grading_run_id: current.run._id }), 3);
  });

  for (const privacy_state of ["erasing", "erased"]) await parent.test(`S5 ${privacy_state}保留事实不得重评分或reconcile补事件`, async t => {
    const f = await assessmentFixture(t);
    const current = await accepted(f);
    await f.db.collection("users").updateOne({ _id: f.student.user.user_id }, { $set: { privacy_state, status: "disabled" }, $inc: { identity_revision: 1, credential_version: 1 } });
    assert.equal(await processOne(f.db), true);
    const finished = await target(f, current.submission._id);
    assert.equal(finished.event.status, "failed");
    assert.equal(finished.event.error_code, "SUBJECT_ERASED");
    assert.deepEqual(finished.submission, current.submission);
    assert.deepEqual(finished.run, current.run);
    await noSuccess(f, current);
    await f.db.collection("outbox_events").deleteOne({ _id: current.event._id });
    const report = await reconcile(f.db, { apply: true, actor: "s5-isolated-test", reason: "privacy barrier" });
    assert.equal(report.repaired_events, 0);
    assert.equal(await f.db.collection("outbox_events").countDocuments({ aggregate_id: current.submission._id }), 0);
  });

  await parent.test("S5 erasing既有评分不得触发visibility与projection复活", async t => {
    const f = await assessmentFixture(t);
    const current = await accepted(f);
    assert.equal(await processOne(f.db), true);
    const before = await f.db.collection("submissions").findOne({ _id: current.submission._id });
    await f.db.collection("users").updateOne({ _id: f.student.user.user_id }, { $set: { privacy_state: "erasing", status: "disabled" }, $inc: { identity_revision: 1, credential_version: 1 } });
    await f.db.collection("student_projection_states").deleteMany({ org_id: f.org, member_id: f.student.memberId });
    await f.db.collection("outbox_events").deleteMany({ aggregate_id: current.submission._id });
    assert.equal(await processVisibility(f.db), 0);
    assert.deepEqual(await f.db.collection("submissions").findOne({ _id: before._id }), before);
    assert.equal(await f.db.collection("student_projection_states").countDocuments({ member_id: f.student.memberId }), 0);
    assert.equal(await f.db.collection("outbox_events").countDocuments({ aggregate_id: before._id }), 0);
  });

  await parent.test("S5 maintenance拒绝直接调用worker核心函数", async t => {
    const f = await assessmentFixture(t);
    const current = await accepted(f);
    const state = await f.db.collection("operational_state").findOne({ _id: "environment" });
    const previous = process.env.KL_ENVIRONMENT_ID;
    const environmentId = require("node:crypto").randomUUID();
    process.env.KL_ENVIRONMENT_ID = environmentId;
    try {
      await f.db.collection("operational_state").updateOne({ _id: "environment" }, { $set: { mode: "maintenance", environment_id: environmentId, maintenance_token: require("node:crypto").randomUUID(), owner: "s5-isolated-test" } });
      for (const invoke of [() => processOne(f.db), () => processDeadlines(f.db), () => processVisibility(f.db), () => reconcile(f.db, { apply: true, actor: "s5-test", reason: "maintenance" })]) {
        await assert.rejects(invoke, /OPERATIONS_ACCESS_BLOCKED/);
      }
      assert.deepEqual(await target(f, current.submission._id), current);
      await noSuccess(f, current);
    } finally {
      await f.db.collection("operational_state").replaceOne({ _id: "environment" }, state);
      if (previous === undefined) delete process.env.KL_ENVIRONMENT_ID; else process.env.KL_ENVIRONMENT_ID = previous;
    }
  });

  await parent.test("当前冻结规则不受支持：needs_review且无成功副作用", async t => {
    const f = await assessmentFixture(t);
    const current = await accepted(f);
    const item = await f.db.collection("session_items").findOne({ session_id: current.submission.session_id, "snapshot.question_type": "single" });
    assert.ok(item);
    // Explicit isolated corrupt/future-import evidence, NOT normal API output:
    // version/strategy enum remain validator-valid, but the frozen strategy does
    // not match its question type. Unknown enum/version cannot be stored in v4.
    const changed = await f.db.collection("session_items").updateOne({ _id: item._id }, { $set: { "snapshot.scoring_rule.strategy": "numeric_exact_decimal" } });
    assert.equal(changed.modifiedCount, 1);
    assert.equal(await processOne(f.db), true);
    await terminal(f, current, "needs_review", "UNSUPPORTED_SCORING_RULE", 1);
    await hidden(f, current.submission._id, "pending");
  });

  await parent.test("当前来源授权撤销：重批needs_review，保留旧评分但不披露", async t => {
    const f = await assessmentFixture(t);
    const initial = await accepted(f);
    assert.equal(await processOne(f.db), true);
    const history = await target(f, initial.submission._id);
    assert.equal(history.run.status, "completed");
    const historyResults = await f.db.collection("grading_results").find({ grading_run_id: history.run._id }).sort({ _id: 1 }).toArray();
    assert.equal(historyResults.length, 3);
    const historyReceipt = await f.db.collection("consumer_receipts").findOne({ event_id: history.event._id });
    const historyFinalized = await f.db.collection("outbox_events").findOne({ event_type: "GradeFinalized", "payload.grading_run_id": history.run._id });
    assert.ok(historyReceipt); assert.ok(historyFinalized);
    const admin = await good(f.reviewer, `/admin/submissions/${initial.submission._id}`);
    assert.equal(admin.release_status, "released");
    await good(f.reviewer, `/submissions/${initial.submission._id}/regrades`, { method: "POST", body: { expected_revision: admin.revision, reason: "验证当前来源撤销后的重批终态" } }, 202);
    const current = await target(f, initial.submission._id);
    await grant(f, f.editor, "content:revoke");
    const source = await good(f.editor, `/admin/question-versions/${f.questions[0].id}`);
    await good(f.editor, `/admin/question-versions/${source.id}/revoke-access`, { method: "POST", body: { expected_access_revision: source.access_revision, reason: "隔离worker授权撤销验收" } });
    assert.equal(await processOne(f.db), true);
    await terminal(f, current, "needs_review", "CONTENT_UNAVAILABLE", 1);
    await hidden(f, current.submission._id, "regrading");
    assert.deepEqual(await f.db.collection("grading_runs").findOne({ _id: history.run._id }), history.run);
    assert.deepEqual(await f.db.collection("grading_results").find({ grading_run_id: history.run._id }).sort({ _id: 1 }).toArray(), historyResults);
    assert.deepEqual(await f.db.collection("consumer_receipts").findOne({ _id: historyReceipt._id }), historyReceipt);
    assert.deepEqual(await f.db.collection("outbox_events").findOne({ _id: historyFinalized._id }), historyFinalized);
  });

  await parent.test("真实事务写入后基础设施错误：第五次才failed且无半份结果", async t => {
    const f = await assessmentFixture(t);
    const current = await accepted(f);
    const fault = failAfterResults(parent, t, f, current);
    try {
      for (let attempt = 1; attempt <= 5; attempt++) {
        if (attempt > 1) await waitForRetry(f, current);
        assert.equal(await processOne(fault.db), true);
        fault.check(attempt);
        if (attempt < 5) await pendingAfterRollback(f, current, attempt);
      }
    } finally { fault.restore(); }
    await terminal(f, current, "failed", "GRADING_DEPENDENCY_UNAVAILABLE", 5);
    await hidden(f, current.submission._id, "pending");
  });

  await parent.test("最终事务真实写入后整体回滚：恢复后完整完成且不重复", async t => {
    const f = await assessmentFixture(t);
    const current = await accepted(f);
    const projection = await f.db.collection("student_projection_states").findOne({ org_id: f.org, member_id: f.student.memberId });
    const fault = failAfterResults(parent, t, f, current);
    try {
      assert.equal(await processOne(fault.db), true);
      fault.check(1);
      await pendingAfterRollback(f, current, 1);
      assert.deepEqual(await f.db.collection("student_projection_states").findOne({ org_id: f.org, member_id: f.student.memberId }), projection);
    } finally { fault.restore(); }
    await waitForRetry(f, current);
    assert.equal(await processOne(f.db), true);
    const complete = await target(f, current.submission._id);
    assert.equal(complete.submission.grading_status, "completed");
    assert.equal(complete.submission.effective_grading_revision, current.run.revision);
    assert.equal(complete.submission.total_score.toString(), "0.00");
    assert.equal(complete.run.status, "completed");
    assert.ok(complete.run.completed_at instanceof Date);
    assert.equal(complete.event.status, "processed");
    assert.equal(complete.event.attempt, 2);
    assert.ok(complete.event.processed_at instanceof Date);
    for (const row of [complete.submission, complete.run, complete.event]) assert.equal(row.error_code, null);
    const results = await f.db.collection("grading_results").find({ grading_run_id: current.run._id }).sort({ session_item_id: 1 }).toArray();
    const items = await f.db.collection("session_items").find({ session_id: current.submission.session_id }).sort({ _id: 1 }).toArray();
    assert.deepEqual(results.map(row => row.session_item_id), items.map(row => row._id));
    for (const row of results) { assert.equal(row.verdict, "unanswered"); assert.equal(row.score.toString(), "0.00"); }
    assert.equal(await f.db.collection("consumer_receipts").countDocuments({ event_id: current.event._id }), 1);
    assert.equal(await f.db.collection("outbox_events").countDocuments({ event_type: "GradeFinalized", "payload.grading_run_id": current.run._id }), 1);
    assert.equal(await processOne(f.db), false);
    assert.deepEqual(await target(f, current.submission._id), complete);
    assert.deepEqual(await f.db.collection("grading_results").find({ grading_run_id: current.run._id }).sort({ session_item_id: 1 }).toArray(), results);
    const view = await good(f.student, `/submissions/${current.submission._id}`);
    assert.equal(view.release_status, "released"); assert.equal(view.total_score, "0.00");
    assert.equal((await good(f.student, `/submissions/${current.submission._id}/items`)).items.length, 3);
  });
});
