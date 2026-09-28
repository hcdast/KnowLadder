"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { Decimal128 } = require("mongodb");
const { assessmentFixture, practice, good, createQuestion } = require("./assessment-helpers.cjs");
const { guardedUri } = require("./helpers.cjs");
const { processOne: gradeOne } = require("../dist/assessment/worker.js");
const { scoreCents, scoreText } = require("../dist/assessment/scoring.js");
const { processOne, processDue } = require("../dist/learning/worker.js");

const CONSUMER = "learning_projection_v1";
const collections = {
  inputs: "learning_projection_inputs", evidence: "mastery_evidence",
  mastery: "mastery_snapshots", mistakes: "mistake_entries", reports: "report_snapshots",
};
const scope = f => ({ org_id: f.org, member_id: f.student.memberId, subject_id: f.subject });
const sumScore = (rows, field) => Decimal128.fromString(scoreText(rows.reduce((sum, row) => sum + scoreCents(row[field]), 0n)));

// Only this seed uses real HTTP submission and the real grading worker. Clones
// below are explicitly synthetic capacity facts, NOT HTTP concurrency evidence.
async function template(t) {
  const f = await assessmentFixture(t);
  assert.equal((await f.db.collection("schema_migrations").findOne({ version: 5 })).status, "completed");
  for (let n = f.questions.length; n < 11; n++) f.questions.push(await createQuestion(f, { title: `容量模板题 ${n}` }));
  const created = await practice(f, { count: 11 });
  const items = await f.db.collection("session_items").find({ session_id: created.id }).sort({ position: 1 }).toArray();
  assert.equal(items.length, 11);
  const receipt = await good(f.student, `/sessions/${created.id}/submissions`, {
    method: "POST", body: { expected_revision: created.revision, answers: items.map(item => ({
      session_item_id: item._id,
      answer: item.snapshot.question_type === "numeric" ? { value: "999" } : { selected_option_ids: ["B"] },
    })) },
  }, 202);
  let submission;
  for (let n = 0; n < 20; n++) {
    submission = await f.db.collection("submissions").findOne({ _id: receipt.submission_id });
    if (submission.grading_status === "completed") break;
    assert.ok(["pending", "running"].includes(submission.grading_status));
    assert.equal(await gradeOne(f.db), true);
  }
  assert.equal(submission.grading_status, "completed", "HTTP模板必须由真实评分worker完成");
  const session = await f.db.collection("sessions").findOne({ _id: created.id });
  const run = await f.db.collection("grading_runs").findOne({ submission_id: submission._id, revision: submission.effective_grading_revision });
  const answers = await f.db.collection("answers").find({ session_id: session._id }).toArray();
  const results = await f.db.collection("grading_results").find({ grading_run_id: run._id }).toArray();
  const attempts = await f.db.collection("learning_attempt_contexts").find({ submission_id: submission._id }).toArray();
  assert.equal(answers.length, 11);
  assert.equal(results.length, 11);
  assert.ok(results.every(row => row.verdict === "incorrect"));
  assert.equal(attempts.length, 11);
  assert.ok(attempts.every(row => row.qualification === "first"));
  assert.deepEqual(run.corrections, []);
  const event = await f.db.collection("outbox_events").findOne({ target_consumer: CONSUMER, event_type: "GradeFinalized", "payload.submission_id": submission._id });
  assert.ok(event);
  return { f, session, submission, run, items, answers, results, attempts, event };
}

async function insertSyntheticSubmission(seed, count) {
  const { f } = seed;
  const sessionId = randomUUID(), submissionId = randomUUID(), runId = randomUUID();
  const selected = seed.items.slice(0, count);
  const ids = new Map(selected.map(item => [item._id, randomUUID()]));
  const items = selected.map((item, position) => ({ ...item, _id: ids.get(item._id), session_id: sessionId, position,
    learning_context: { ...item.learning_context, qualification: "repeated", reason: "repeated" } }));
  const answers = selected.map(item => ({ ...seed.answers.find(row => row.session_item_id === item._id),
    _id: randomUUID(), session_id: sessionId, session_item_id: ids.get(item._id) }));
  const results = selected.map(item => ({ ...seed.results.find(row => row.session_item_id === item._id),
    _id: randomUUID(), grading_run_id: runId, session_item_id: ids.get(item._id) }));
  const attempts = selected.map(item => ({ ...seed.attempts.find(row => row.session_item_id === item._id),
    _id: randomUUID(), submission_id: submissionId, session_item_id: ids.get(item._id), qualification: "repeated", reason: "repeated" }));
  const answersHash = createHash("sha256").update(JSON.stringify(items.map((item, index) => [item._id, answers[index].answer]))).digest("hex");
  const rows = {
    sessions: [{ ...seed.session, _id: sessionId, submission_id: submissionId, item_count: count }],
    session_items: items, answers,
    submissions: [{ ...seed.submission, _id: submissionId, session_id: sessionId, answers_hash: answersHash,
      total_score: sumScore(results, "score"), max_score: sumScore(items, "max_score"), visibility_fingerprint: null }],
    grading_runs: [{ ...seed.run, _id: runId, submission_id: submissionId }],
    grading_results: results, learning_attempt_contexts: attempts,
  };
  // Each synthetic submission is atomic. Preserve BSON Decimal128, frozen
  // source identity, ownership and the seed's coherent timestamps; no validator
  // bypass, mocked results, invented first attempts or production tuning.
  const tx = f.db.client.startSession();
  try {
    await tx.withTransaction(async () => {
      for (const [name, values] of Object.entries(rows)) await f.db.collection(name).insertMany(values, { session: tx });
      const changed = await f.db.collection("student_projection_states").updateOne(
        { org_id: f.org, member_id: f.student.memberId },
        { $inc: { projection_revision: 1 } }, { session: tx },
      );
      assert.equal(changed.matchedCount, 1);
    });
  } finally { await tx.endSession(); }
}

async function capacityFixture(t, submissionCount, itemCount) {
  const seed = await template(t);
  let remaining = itemCount - seed.items.length;
  for (let n = 1; n < submissionCount; n++) {
    const count = Math.min(10, remaining - (submissionCount - n - 1));
    assert.ok(count >= 1 && count <= 10);
    await insertSyntheticSubmission(seed, count);
    remaining -= count;
  }
  assert.equal(remaining, 0);
  const { f } = seed;
  for (const name of ["submissions", "sessions", "grading_runs"]) assert.equal(await f.db.collection(name).countDocuments({ org_id: f.org }), submissionCount);
  for (const name of ["session_items", "answers", "grading_results", "learning_attempt_contexts"]) assert.equal(await f.db.collection(name).countDocuments({ org_id: f.org }), itemCount);
  assert.equal(await f.db.collection("learning_attempt_contexts").countDocuments({ org_id: f.org, qualification: "first" }), 11);
  assert.equal(await f.db.collection("learning_attempt_contexts").countDocuments({ org_id: f.org, qualification: "repeated" }), itemCount - 11);
  const sources = await f.db.collection("session_items").distinct("snapshot.question_version_id", { org_id: f.org });
  assert.equal(sources.length, 11);
  await f.db.collection("outbox_events").updateOne({ _id: seed.event._id }, [{ $set: { available_at: "$$NOW" } }]);
  return seed;
}

async function measuredProcess(t, seed, submissionCount, itemCount) {
  const started = performance.now();
  let claimed;
  try { claimed = await processOne(seed.f.db); }
  finally { t.diagnostic(`真实processOne容量实验：submissions=${submissionCount}, items=${itemCount}, elapsed_ms=${(performance.now() - started).toFixed(1)}；合成事实夹具，不是HTTP并发证明`); }
  assert.equal(claimed, true);
  return seed.f.db.collection("learning_projection_heads").findOne({ ...scope(seed.f), rule_version: "learning_v1" });
}

test("S4-02 显式容量实验：真实Mongo strict v5、500提交/5000题项及越界拒绝", {
  concurrency: false, timeout: 900000,
  skip: process.env.TEST_LEARNING_CAPACITY !== "true" ? "容量实验未运行；须显式设置 TEST_LEARNING_CAPACITY=true，不计为默认容量验证通过" : false,
}, async parent => {
  guardedUri(process.env.TEST_MONGODB_URI);
  await parent.test("边界内500提交/5000题项完整发布", async t => {
    const seed = await capacityFixture(t, 500, 5000);
    const { f } = seed;
    const head = await measuredProcess(t, seed, 500, 5000);
    assert.ok(head?.active_generation, `容量内必须发布完整generation；安全失败仍不算通过：${head?.error_code ?? "missing_head"}`);
    assert.equal(head.error_code, null);
    const build = await f.db.collection("learning_projection_builds").findOne({ ...scope(f), generation: head.active_generation });
    assert.equal(build.status, "complete");
    const expected = { inputs: 500, evidence: 5000, mastery: 1, mistakes: 11, reports: 2 };
    assert.deepEqual(build.expected_counts, expected);
    assert.deepEqual(build.actual_counts, expected);
    for (const [key, name] of Object.entries(collections)) assert.equal(await f.db.collection(name).countDocuments({ ...scope(f), generation: head.active_generation }), expected[key]);
    const active = { ...scope(f), generation: head.active_generation };
    assert.equal(await f.db.collection("mastery_evidence").countDocuments({ ...active, qualification: "repeated" }), 4989);
    assert.equal(await f.db.collection("mistake_entries").countDocuments({ ...active, status: "active" }), 11);
    const reports = await f.db.collection("report_snapshots").find(active).toArray();
    assert.deepEqual(reports.map(row => row.period).sort(), ["30d", "7d"]);
    for (const report of reports) {
      assert.equal(report.submission_count, 500);
      assert.equal(report.attempt_count, 5000);
      assert.equal(report.incorrect_count, 5000);
      assert.equal(report.independent_question_count, 11);
    }
    assert.equal((await f.db.collection("outbox_events").findOne({ _id: seed.event._id })).status, "processed");
    assert.equal(await f.db.collection("consumer_receipts").countDocuments({ consumer_name: CONSUMER, event_id: seed.event._id }), 1);
  });
  for (const [submissionCount, itemCount] of [[501, 5000], [500, 5001]]) {
    await parent.test(`越界${submissionCount}提交/${itemCount}题项拒绝发布`, async t => {
      const seed = await capacityFixture(t, submissionCount, itemCount);
      const { f } = seed;
      const head = await measuredProcess(t, seed, submissionCount, itemCount);
      assert.ok(head, "越界必须留下明确安全失败诊断");
      assert.equal(head.active_generation, null);
      assert.equal(head.error_code, "INPUT_LIMIT_EXCEEDED");
      assert.equal(head.rebuild_requested, true);
      assert.equal(await f.db.collection("learning_projection_builds").countDocuments({ ...scope(f), status: "complete" }), 0);
      for (const name of Object.values(collections)) assert.equal(await f.db.collection(name).countDocuments(scope(f)), 0, "不得写入或发布部分报告");
      const event = await f.db.collection("outbox_events").findOne({ _id: seed.event._id });
      assert.equal(event.error_code, "INPUT_LIMIT_EXCEEDED");
      assert.notEqual(event.status, "processed");
      assert.equal(await f.db.collection("consumer_receipts").countDocuments({ consumer_name: CONSUMER, event_id: seed.event._id }), 0);
    });
  }
});

test("S4-05 HTTP合法500/501知识点边界、隐藏输入及非first计数语义", { timeout: 240000 }, async t => {
  const seed = await template(t), { f } = seed;
  const partition = scope(f);
  const routes = [
    `/me/mastery?subject_id=${f.subject}`,
    `/me/mistakes?subject_id=${f.subject}`,
    `/me/reports?subject_id=${f.subject}&period=7d`,
  ];
  // Synthetic capacity metadata on genuinely HTTP-submitted, worker-graded facts.
  // Every frozen question stays within strict v4/v5 maxItems=100, sums to 10000,
  // uses unique existing point UUIDs, and retains its real score/source identity.
  const now = new Date(), pointIds = Array.from({ length: 501 }, () => randomUUID());
  await f.db.collection("knowledge_points").insertMany(pointIds.map((_id, index) => ({
    _id, code: `capacity-point-${index}`, name: `容量知识点 ${index}`, subject_id: f.subject, created_at: now, updated_at: now,
  })));
  const weights = ids => ids.map(knowledge_point_id => ({ knowledge_point_id, weight_bps: 10000 / ids.length }));
  const setPoints = async (item, ids) => {
    assert.ok(ids.length <= 100);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(weights(ids).reduce((sum, row) => sum + row.weight_bps, 0), 10000);
    assert.equal((await f.db.collection("session_items").updateOne({ _id: item._id }, { $set: {
      "snapshot.knowledge_point_ids": ids, "snapshot.knowledge_weights": weights(ids),
    } })).matchedCount, 1);
  };
  const bump = () => f.db.collection("student_projection_states").updateOne(
    { org_id: f.org, member_id: f.student.memberId }, { $inc: { projection_revision: 1 } },
  );
  const due = async () => {
    // Advance only the scheduler wake-up, never fabricate a projection result.
    await f.db.collection("learning_projection_heads").updateOne(partition, [{ $set: { next_check_at: "$$NOW" } }]);
    return processDue(f.db);
  };
  const feedback = async () => ({
    personal: await f.db.collection("learning_question_states").find({ org_id: f.org, user_id: f.student.user.user_id }).sort({ _id: 1 }).toArray(),
    global: await f.db.collection("assessment_question_states").find({ org_id: f.org }, { projection: { _id: 1, answer_disclosed: 1 } }).sort({ _id: 1 }).toArray(),
  });
  for (let index = 0; index < seed.items.length; index++) {
    await setPoints(seed.items[index], index < 5 ? pointIds.slice(index * 100, index * 100 + 100) : [pointIds[0]]);
  }
  await bump();
  assert.equal(await processOne(f.db), true);
  const baseline = await good(f.student, routes[2]);
  assert.equal(baseline.mastery.length, 500);
  assert.equal(baseline.activity.attempt_count, 11);
  assert.ok(baseline.source_watermark);
  const originalGeneration = baseline.source_watermark.split(":")[1];

  // A sixth legal question adds exactly one new point; no question has 501 weights.
  await setPoints(seed.items[5], [pointIds[500]]);
  await bump();
  const beforeFeedback = await feedback();
  const unavailable = async () => {
    for (let index = 0; index < routes.length; index++) {
      const response = await good(f.student, routes[index]);
      assert.equal(response.status, "unavailable", "超限必须即时unavailable而不是永久updating");
      assert.equal(response.source_watermark, null);
      assert.equal(response.generated_at, null);
      if (index === 2) { assert.equal(response.activity, null); assert.deepEqual(response.mastery, []); }
      else { assert.deepEqual(response.items, []); assert.equal(response.next_cursor, null); }
      if (index === 1) assert.equal(response.total, 0);
    }
    assert.deepEqual(await feedback(), beforeFeedback, "不可交付旧值或登记任何新反馈");
  };
  await unavailable(); // Fails against old dist before any rejecting worker runs.
  assert.equal(await due(), 0);
  const rejected = await f.db.collection("learning_projection_heads").findOne(partition);
  assert.equal(rejected.error_code, "INPUT_LIMIT_EXCEEDED");
  assert.equal(rejected.active_generation, originalGeneration);
  assert.equal(await f.db.collection("learning_projection_builds").countDocuments({ ...partition, status: "complete" }), 1);
  await unavailable();

  // Changed valid facts must recover despite the prior head error.
  await setPoints(seed.items[5], [pointIds[0]]);
  await bump();
  // Restoring identical semantic facts can immediately reuse the complete generation.
  const recovered = await good(f.student, routes[2]);
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.source_watermark, baseline.source_watermark);
  assert.equal(recovered.mastery.length, 500);
  assert.equal(await due(), 1);
  const restored = await good(f.student, routes[2]);
  assert.equal(restored.mastery.length, 500);
  assert.equal(restored.activity.attempt_count, 11);
  assert.equal((await f.db.collection("learning_projection_heads").findOne(partition)).error_code, null);

  // The clone is explicitly synthetic and repeated; its original point is not
  // among the 500 first-attempt points. Hidden facts must not affect any DTO.
  await insertSyntheticSubmission(seed, 1);
  const clone = await f.db.collection("submissions").findOne({ org_id: f.org, _id: { $ne: seed.submission._id } });
  await f.db.collection("submissions").updateOne({ _id: clone._id }, { $set: { grading_status: "pending" } });
  const hiddenBefore = await Promise.all(routes.map(route => good(f.student, route)));
  const hiddenItem = await f.db.collection("session_items").findOne({ session_id: clone.session_id });
  await setPoints(hiddenItem, pointIds.slice(400, 500).map((id, index) => index === 0 ? pointIds[500] : id));
  await bump();
  assert.deepEqual(await Promise.all(routes.map(route => good(f.student, route))), hiddenBefore);
  await f.db.collection("submissions").updateOne({ _id: clone._id }, { $set: { grading_status: "completed" } });
  await bump();
  assert.equal((await good(f.student, routes[2])).status, "updating");
  assert.equal(await due(), 1);
  const repeated = await good(f.student, routes[2]);
  assert.equal(repeated.mastery.length, 500, "非first行的新知识点不占掌握度上限");
  assert.equal(repeated.activity.attempt_count, 12);
});
