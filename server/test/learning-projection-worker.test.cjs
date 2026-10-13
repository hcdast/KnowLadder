"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { assessmentFixture, practice, good, grant, createQuestion } = require("./assessment-helpers.cjs");
const { guardedUri } = require("./helpers.cjs");
const { processOne: gradeOne } = require("../dist/assessment/worker.js");
const { processOne, processDue, reconcile, cleanup } = require("../dist/learning/worker.js");

const CONSUMER = "learning_projection_v1";
const DAY_MS = 86400000;
const derived = ["learning_projection_inputs", "mastery_evidence", "mastery_snapshots", "mistake_entries", "report_snapshots"];
const scope = f => ({ org_id: f.org, member_id: f.student.memberId, subject_id: f.subject });
const head = f => f.db.collection("learning_projection_heads").findOne({ ...scope(f), rule_version: "learning_v1" });
const member = f => ({ org_id: f.org, member_id: f.student.memberId });

async function setup(t) {
  const f = await assessmentFixture(t);
  assert.equal((await f.db.collection("schema_migrations").findOne({ version: 10 })).status, "completed");
  return f;
}
async function submit(f, answerFor = () => null) {
  const session = await practice(f);
  const items = await f.db.collection("session_items").find({ session_id: session.id }).sort({ position: 1 }).toArray();
  const answers = items.map(item => ({ session_item_id: item._id, answer: answerFor(item) })).filter(row => row.answer !== null);
  const receipt = await good(f.student, `/sessions/${session.id}/submissions`, {
    method: "POST", body: { expected_revision: session.revision, answers },
  }, 202);
  return { id: receipt.submission_id, items };
}
async function grade(f, id) {
  for (let n = 0; n < 20; n++) {
    const row = await f.db.collection("submissions").findOne({ _id: id });
    if (row.grading_status === "completed") return row;
    assert.ok(["pending", "running"].includes(row.grading_status));
    assert.equal(await gradeOne(f.db), true);
  }
  assert.fail("真实评分队列未完成提交");
}
async function ready(f) {
  await f.db.collection("outbox_events").updateMany({ target_consumer: CONSUMER, status: "pending" }, [
    { $set: { available_at: "$$NOW" } },
  ]);
  await f.db.collection("learning_projection_heads").updateMany({ ...scope(f), error_code: { $ne: null } }, [
    { $set: { next_check_at: "$$NOW" } },
  ]);
}
async function drain(f) {
  for (let n = 0; n < 40; n++) {
    await ready(f);
    if (!await processOne(f.db)) {
      assert.equal(await f.db.collection("outbox_events").countDocuments({ target_consumer: CONSUMER, status: { $ne: "processed" } }), 0);
      const current = await head(f);
      assert.ok(current?.active_generation, "真实worker必须发布完整generation");
      assert.equal(current.error_code, null);
      return current;
    }
  }
  assert.fail("学情队列未收敛");
}
async function activeRows(f, name, current = null) {
  current ??= await head(f);
  return f.db.collection(name).find({ ...scope(f), generation: current.active_generation }).toArray();
}
async function replay(f, event) {
  await f.db.collection("outbox_events").updateOne({ _id: event._id }, [
    { $set: { status: "pending", available_at: "$$NOW", processed_at: null, error_code: null, lease_owner: null, lease_token: null, lease_until: null } },
  ]);
}
async function learningEvent(f, submissionId) {
  const event = await f.db.collection("outbox_events").findOne({ target_consumer: CONSUMER, event_type: "GradeFinalized", "payload.submission_id": submissionId });
  assert.ok(event);
  return event;
}
async function forceDue(f) {
  await f.db.collection("learning_projection_heads").updateOne({ ...scope(f), rule_version: "learning_v1" }, { $set: { rebuild_requested: true } });
  assert.equal(await processDue(f.db), 1);
  const current = await head(f);
  assert.equal(current.error_code, null);
  return current;
}

// Per-invocation proxies forward actual MongoDB calls and actual results. Hooks
// only inject failures, pause a call, or alter operational lease/clock fixtures.
// No global patch, synthetic evidence, grading result or successful DB response.
function intercept(db, hook) {
  return new Proxy(db, { get(target, property) {
    if (property === "collection") return (name, ...args) => {
      const collection = target.collection(name, ...args);
      return new Proxy(collection, { get(inner, method) {
        const value = Reflect.get(inner, method, inner);
        if (typeof value !== "function") return value;
        if (!["findOne", "insertMany", "updateOne"].includes(method)) return value.bind(inner);
        return async (...parameters) => {
          await hook("before", name, method, parameters);
          const result = await value.apply(inner, parameters);
          await hook("after", name, method, parameters, result);
          return result;
        };
      } });
    };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

test("S4-02 学情worker真实Mongo流水线与发布安全", { concurrency: false, timeout: 600000 }, async parent => {
  guardedUri(process.env.TEST_MONGODB_URI);

  for (const scenario of ["slow-refresh", "expired-license"]) await parent.test(`发布区分定期检查与真实到期：${scenario}`, { timeout: 100000 }, async t => {
    const f = await setup(t);
    const submitted = await submit(f);
    await grade(f, submitted.id);
    const event = await learningEvent(f, submitted.id);
    let paused = false;
    const db = intercept(f.db, async (phase, name, method, args) => {
      // This read occurs between transactions, so lease renewals keep running.
      if (paused || phase !== "after" || name !== "learning_projection_heads" || method !== "findOne" || args[1]?.session) return;
      paused = true;
      if (scenario === "slow-refresh") await new Promise(resolve => setTimeout(resolve, 61000));
      else await f.db.collection("question_versions").updateOne({ _id: f.questions[0].id }, {
        $set: { "license.expires_at": new Date(Date.now() - 1000).toISOString() },
      });
    });
    assert.equal(await processOne(db), true);
    assert.equal(paused, true);
    const current = await head(f);
    const consumed = await f.db.collection("outbox_events").findOne({ _id: event._id });
    if (scenario === "slow-refresh") {
      assert.ok(current.active_generation);
      assert.equal(current.error_code, null);
      assert.equal(consumed.status, "processed");
      assert.equal((await activeRows(f, "mastery_evidence", current)).length, 3);
    } else {
      assert.equal(current.active_generation, null);
      assert.equal(current.error_code, "INPUT_CHANGED");
      assert.equal(consumed.status, "pending");
      assert.equal(await f.db.collection("consumer_receipts").countDocuments({ event_id: event._id }), 0);
    }
  });

  for (const privacy_state of ["erasing", "erased"]) await parent.test(`S5 ${privacy_state}旧评分事件和reconcile不得重建`, async t => {
    const f = await setup(t);
    const submitted = await submit(f);
    await grade(f, submitted.id);
    const event = await learningEvent(f, submitted.id);
    await f.db.collection("users").updateOne({ _id: f.student.user.user_id }, { $set: { privacy_state, status: "disabled" }, $inc: { identity_revision: 1, credential_version: 1 } });
    assert.equal(await processOne(f.db), true);
    const finished = await f.db.collection("outbox_events").findOne({ _id: event._id });
    assert.equal(finished.status, "failed");
    assert.equal(finished.error_code, "SUBJECT_ERASED");
    assert.equal((await reconcile(f.db, { apply: true, actor: "s5-isolated-test", reason: "privacy barrier" })).requested, 0);
    assert.equal(await processDue(f.db), 0);
    assert.equal(await head(f), null);
    for (const name of [...derived, "learning_projection_builds", "consumer_receipts"]) {
      assert.equal(await f.db.collection(name).countDocuments(name === "consumer_receipts" ? { event_id: event._id } : member(f)), 0, name);
    }
  });

  await parent.test("S5 manifest读取后隐私freeze禁止后续build和批次写回", async t => {
    const f = await setup(t);
    const submitted = await submit(f);
    await grade(f, submitted.id);
    const event = await learningEvent(f, submitted.id);
    let frozen = false;
    const raced = intercept(f.db, async (phase, name, method, parameters) => {
      // The rebuild's reuse lookup is outside its completed manifest transaction.
      // Freeze using a real independent Mongo write, never a mocked query result.
      if (frozen || phase !== "before" || name !== "learning_projection_heads" || method !== "findOne" || parameters[1]?.session) return;
      frozen = true;
      await f.db.collection("users").updateOne({ _id: f.student.user.user_id }, { $set: { privacy_state: "erasing", status: "disabled" }, $inc: { identity_revision: 1, credential_version: 1 } });
    });
    assert.equal(await processOne(raced), true);
    assert.equal(frozen, true, "必须确实命中manifest之后的竞态窗口");
    assert.equal(await head(f), null);
    for (const name of [...derived, "learning_projection_builds"]) assert.equal(await f.db.collection(name).countDocuments(member(f)), 0, name);
    assert.equal(await f.db.collection("consumer_receipts").countDocuments({ event_id: event._id }), 0);
    assert.equal((await f.db.collection("outbox_events").findOne({ _id: event._id })).error_code, "SUBJECT_ERASED");
  });

  await parent.test("S5 maintenance拒绝直接学情worker写入", async t => {
    const f = await setup(t);
    const submitted = await submit(f);
    await grade(f, submitted.id);
    const event = await learningEvent(f, submitted.id);
    const state = await f.db.collection("operational_state").findOne({ _id: "environment" });
    const previous = process.env.KL_ENVIRONMENT_ID, environmentId = randomUUID();
    process.env.KL_ENVIRONMENT_ID = environmentId;
    try {
      await f.db.collection("operational_state").updateOne({ _id: "environment" }, { $set: { mode: "maintenance", environment_id: environmentId, maintenance_token: randomUUID(), owner: "s5-isolated-test" } });
      for (const invoke of [() => processOne(f.db), () => processDue(f.db), () => cleanup(f.db), () => reconcile(f.db, { apply: true, actor: "s5-test", reason: "maintenance" })]) await assert.rejects(invoke, /OPERATIONS_ACCESS_BLOCKED/);
      assert.deepEqual(await f.db.collection("outbox_events").findOne({ _id: event._id }), event);
      assert.equal(await head(f), null);
    } finally {
      await f.db.collection("operational_state").replaceOne({ _id: "environment" }, state);
      if (previous === undefined) delete process.env.KL_ENVIRONMENT_ID; else process.env.KL_ENVIRONMENT_ID = previous;
    }
  });


  await parent.test("真实练习首答、评分及发布；重投和乱序事件复用语义generation", async t => {
    const f = await setup(t);
    const first = await submit(f);
    await grade(f, first.id);
    const firstEvent = await learningEvent(f, first.id);
    const initial = await drain(f);
    const evidence = await activeRows(f, "mastery_evidence", initial);
    assert.equal(evidence.length, 3);
    assert.ok(evidence.every(row => row.qualification === "first" && row.verdict === "unanswered"));
    assert.equal((await activeRows(f, "mistake_entries", initial)).length, 3);
    const mastery = await activeRows(f, "mastery_snapshots", initial);
    assert.equal(mastery.length, 1);
    assert.equal(mastery[0].independent_question_count, 3);
    assert.equal(mastery[0].mastery, null);
    const build = await f.db.collection("learning_projection_builds").findOne({ generation: initial.active_generation });
    assert.equal(build.status, "complete");
    assert.deepEqual(build.actual_counts, build.expected_counts);
    assert.deepEqual(build.actual_counts, { inputs: 1, evidence: 3, mastery: 1, mistakes: 3, reports: 2 });
    assert.equal(await f.db.collection("learning_question_states").countDocuments({ user_id: f.student.user.user_id, feedback_seen: true }), 0, "后台投影不能制造学生反馈曝光");

    await replay(f, firstEvent);
    assert.equal((await drain(f)).active_generation, initial.active_generation);
    assert.equal(await f.db.collection("consumer_receipts").countDocuments({ consumer_name: CONSUMER, event_id: firstEvent._id }), 1);
    const second = await submit(f);
    await grade(f, second.id);
    const newer = await drain(f);
    assert.notEqual(newer.active_generation, initial.active_generation);
    await replay(f, firstEvent);
    assert.equal((await drain(f)).active_generation, newer.active_generation);
    const report = (await activeRows(f, "report_snapshots")).find(row => row.period === "7d");
    assert.equal(report.submission_count, 2);
    assert.equal(report.attempt_count, 6);
    assert.equal(report.independent_question_count, 3);
    assert.equal((await activeRows(f, "mastery_evidence")).filter(row => row.qualification === "repeated").length, 3);
  });

  await parent.test("来源撤销后旧事件不能重新带回隐藏证据，空generation保持稳定", async t => {
    const f = await setup(t);
    const submission = await submit(f);
    await grade(f, submission.id);
    const event = await learningEvent(f, submission.id);
    const original = await drain(f);
    await grant(f, f.editor, "content:revoke");
    const question = await good(f.editor, `/admin/question-versions/${f.questions[0].id}`);
    await good(f.editor, `/admin/question-versions/${question.id}/revoke-access`, { method: "POST", body: { expected_access_revision: question.access_revision, reason: "学情隐藏证据验收" } });
    const hidden = await forceDue(f);
    assert.notEqual(hidden.active_generation, original.active_generation);
    for (const name of derived.slice(0, 4)) assert.equal((await activeRows(f, name, hidden)).length, 0);
    const reports = await activeRows(f, "report_snapshots", hidden);
    assert.equal(reports.length, 2);
    assert.ok(reports.every(row => row.attempt_count === 0 && row.denominator === "0"));
    await replay(f, event);
    assert.equal((await drain(f)).active_generation, hidden.active_generation);
  });

  await parent.test("重评中的旧证据排除，勘误后同提交只保留新有效评分", async t => {
    const f = await setup(t);
    const submission = await submit(f, item => item.snapshot.question_type === "single" ? { selected_option_ids: ["B"] } : null);
    const original = await grade(f, submission.id);
    const initial = await drain(f);
    const item = submission.items.find(row => row.snapshot.question_type === "single");
    assert.equal((await activeRows(f, "mastery_evidence", initial)).find(row => row.session_item_id === item._id).verdict, "incorrect");
    const correction = await createQuestion(f, { source_version_id: f.questions[0].id, answer: "B" });
    const admin = await good(f.reviewer, `/admin/submissions/${submission.id}`);
    const accepted = await good(f.reviewer, `/submissions/${submission.id}/regrades`, { method: "POST", body: {
      expected_revision: admin.revision, reason: "学情同提交勘误替换", correction_source_version_id: correction.id,
    } }, 202);
    const pending = await drain(f);
    assert.equal((await activeRows(f, "mastery_evidence", pending)).length, 0);
    await grade(f, submission.id);
    await drain(f);
    const evidence = await activeRows(f, "mastery_evidence");
    assert.equal(evidence.length, 3);
    assert.ok(evidence.every(row => row.grading_run_id === accepted.grading_run_id && row.grading_revision === original.effective_grading_revision + 1));
    assert.equal(evidence.find(row => row.session_item_id === item._id).verdict, "correct");
    const report = (await activeRows(f, "report_snapshots")).find(row => row.period === "7d");
    assert.equal(report.submission_count, 1);
    assert.equal(report.attempt_count, 3);
    assert.equal(report.correct_count, 1);
    assert.equal(report.independent_question_count, 3);
    assert.equal((await activeRows(f, "mistake_entries")).some(row => row.question_id === item.snapshot.question_id), false);
  });

  await parent.test("活跃成员租约阻止抢占且不消耗重试，过期成员及事件租约可回收", async t => {
    const f = await setup(t);
    const submission = await submit(f);
    await grade(f, submission.id);
    const event = await learningEvent(f, submission.id);
    await f.db.collection("student_projection_states").updateOne(member(f), [{ $set: {
      lease_owner: "integration-holder", lease_token: randomUUID(), lease_until: { $add: ["$$NOW", 60000] },
    } }]);
    await ready(f);
    assert.equal(await processOne(f.db), true);
    assert.equal(await head(f), null);
    const contended = await f.db.collection("outbox_events").findOne({ _id: event._id });
    assert.equal(contended.status, "pending");
    assert.equal(contended.attempt, event.attempt);
    await f.db.collection("student_projection_states").updateOne(member(f), [{ $set: { lease_until: { $subtract: ["$$NOW", 1000] } } }]);
    await f.db.collection("outbox_events").updateOne({ _id: event._id }, [{ $set: {
      status: "running", lease_owner: "integration-crashed", lease_token: randomUUID(), lease_until: { $subtract: ["$$NOW", 1000] },
    } }]);
    await drain(f);
    assert.equal(await f.db.collection("consumer_receipts").countDocuments({ consumer_name: CONSUMER, event_id: event._id }), 1);
    assert.equal((await f.db.collection("student_projection_states").findOne(member(f))).lease_token, null);
  });

  await parent.test("两个并发消费者串行发布同成员，最终只有一份相同语义generation", async t => {
    const f = await setup(t);
    const first = await submit(f);
    await grade(f, first.id);
    const second = await submit(f);
    await grade(f, second.id);
    await ready(f);
    await Promise.all([processOne(f.db), processOne(f.db)]);
    const current = await drain(f);
    assert.equal(await f.db.collection("learning_projection_builds").countDocuments({ ...scope(f), status: "complete" }), 1);
    assert.equal((await activeRows(f, "mastery_evidence", current)).length, 6);
    assert.equal(await f.db.collection("consumer_receipts").countDocuments({ org_id: f.org, consumer_name: CONSUMER }), await f.db.collection("outbox_events").countDocuments({ org_id: f.org, target_consumer: CONSUMER }));
  });

  for (const expired of ["event", "member"]) await parent.test(`构建途中${expired}租约过期阻止旧持有者发布及确认`, async t => {
    const f = await setup(t);
    const submission = await submit(f);
    await grade(f, submission.id);
    let hits = 0;
    let eventId;
    const db = intercept(f.db, async (phase, name, method, args) => {
      if (phase !== "after" || name !== "mastery_evidence" || method !== "insertMany" || hits) return;
      hits++;
      const event = await f.db.collection("outbox_events").findOne({ target_consumer: CONSUMER, status: "running" });
      eventId = event._id;
      await f.db.collection(expired === "event" ? "outbox_events" : "student_projection_states").updateOne(expired === "event" ? { _id: eventId } : member(f), [
        { $set: { lease_until: { $subtract: ["$$NOW", 1000] } } },
      ], { session: args[1]?.session });
    });
    await ready(f);
    assert.equal(await processOne(db), true);
    assert.equal(hits, 1);
    assert.equal((await head(f))?.active_generation ?? null, null);
    assert.equal(await f.db.collection("consumer_receipts").countDocuments({ consumer_name: CONSUMER, event_id: eventId }), 0);
    await f.db.collection("student_projection_states").updateOne(member(f), [{ $set: { lease_until: { $subtract: ["$$NOW", 1000] } } }]);
    await f.db.collection("outbox_events").updateMany({ target_consumer: CONSUMER, status: "running" }, [{ $set: { lease_until: { $subtract: ["$$NOW", 1000] } } }]);
    await drain(f);
    assert.equal((await activeRows(f, "mastery_evidence")).length, 3);
  });

  await parent.test("批次写入后中断回滚该批但留下building孤儿；重启另建完整generation", async t => {
    const f = await setup(t);
    const submission = await submit(f);
    await grade(f, submission.id);
    let inserted = 0;
    const db = intercept(f.db, async (phase, name, method, args, result) => {
      if (phase === "after" && name === "mastery_evidence" && method === "insertMany") {
        inserted += result.insertedCount;
        throw new Error("ISOLATED_BUILD_WRITE_INTERRUPTION");
      }
      if (phase === "before" && name === "learning_projection_builds" && method === "updateOne" && Array.isArray(args[1])) throw new Error("ISOLATED_CRASH_BEFORE_ABANDON");
    });
    await ready(f);
    assert.equal(await processOne(db), true);
    assert.equal(inserted, 3);
    const orphan = await f.db.collection("learning_projection_builds").findOne({ ...scope(f), status: "building" });
    assert.ok(orphan);
    assert.equal(await f.db.collection("mastery_evidence").countDocuments({ generation: orphan.generation }), 0, "失败批次必须随subject fence事务一起回滚");
    assert.equal((await head(f)).active_generation, null);
    assert.equal(await f.db.collection("consumer_receipts").countDocuments({ org_id: f.org, consumer_name: CONSUMER }), 0);
    const recovered = await drain(f);
    assert.notEqual(recovered.active_generation, orphan.generation);
    assert.equal((await activeRows(f, "mastery_evidence", recovered)).length, 3);
  });

  await parent.test("最终事务回滚同时撤销head、complete状态和receipt，保留旧active", async t => {
    const f = await setup(t);
    const first = await submit(f);
    await grade(f, first.id);
    const original = await drain(f);
    const second = await submit(f);
    await grade(f, second.id);
    const observations = [];
    const db = intercept(f.db, async (phase, name, method, args) => {
      if (phase !== "after" || name !== "consumer_receipts" || method !== "updateOne") return;
      const session = args[2]?.session;
      observations.push({
        transaction: !!session?.inTransaction(),
        inside: await f.db.collection("learning_projection_heads").findOne(scope(f), { session }),
        outside: await head(f),
        eventId: args[0].event_id,
        receipts: await f.db.collection("consumer_receipts").countDocuments(args[0], { session }),
      });
      throw new Error("ISOLATED_FINAL_TX_POST_RECEIPT_FAILURE");
    });
    await ready(f);
    assert.equal(await processOne(db), true);
    assert.equal(observations.length, 1);
    const observation = observations[0];
    assert.equal(observation.transaction, true);
    assert.equal(observation.receipts, 1);
    assert.notEqual(observation.inside.active_generation, original.active_generation);
    assert.equal(observation.outside.active_generation, original.active_generation);
    assert.equal((await head(f)).active_generation, original.active_generation);
    assert.equal(await f.db.collection("consumer_receipts").countDocuments({ consumer_name: CONSUMER, event_id: observation.eventId }), 0);
    assert.equal(await f.db.collection("learning_projection_builds").countDocuments({ generation: observation.inside.active_generation, status: "complete" }), 0);
    assert.equal((await activeRows(f, "mastery_evidence")).length, 3);
    const recovered = await drain(f);
    assert.notEqual(recovered.active_generation, original.active_generation);
    assert.equal((await activeRows(f, "mastery_evidence")).length, 6);
  });

  for (const recovery of ["audit", "scope"]) await parent.test(`持久失败预算跨event/due共享五次且不可旁路，${recovery}恢复新预算`, async t => {
    const f = await setup(t);
    const submission = await submit(f);
    await grade(f, submission.id);
    const event = await learningEvent(f, submission.id);
    let writes = 0;
    const insertedCounts = [];
    const failing = intercept(f.db, async (phase, name, method, args, result) => {
      if (phase !== "after" || name !== "mastery_evidence" || method !== "insertMany") return;
      writes++;
      insertedCounts.push(result.insertedCount);
      throw new Error("ISOLATED_PERSISTENT_PROJECTION_FAILURE");
    });
    const expireBackoff = async () => {
      await f.db.collection("learning_projection_heads").updateMany(scope(f), [{ $set: {
        next_check_at: { $subtract: ["$$NOW", 1000] }, rebuild_requested: true,
      } }]);
      await ready(f);
    };
    for (let attempt = 1; attempt <= 5; attempt++) {
      await expireBackoff();
      if (attempt % 2 === 1) {
        await replay(f, event);
        assert.equal(await processOne(failing), true);
      } else {
        assert.equal(await processDue(failing), 0);
      }
      const failed = await head(f);
      assert.equal(writes, attempt, "每次失败必须经过真实证据写入");
      assert.deepEqual(insertedCounts, Array(attempt).fill(3));
      assert.equal(failed.failure_attempts, attempt, "event和due共用持久失败计数");
      assert.match(failed.retry_signature, /^[a-f0-9]{64}$/);
      assert.equal(failed.active_generation, null);
    }
    const exhausted = await head(f);
    const buildCount = await f.db.collection("learning_projection_builds").countDocuments(scope(f));
    assert.equal(buildCount, 5);
    // Administrative due flags and redelivery are not new learning input.
    // Neither may bypass an exhausted semantic-input budget.
    await expireBackoff();
    assert.equal(await processDue(failing), 0);
    await replay(f, event);
    await ready(f);
    await processOne(failing);
    assert.equal(writes, 5);
    assert.equal(await f.db.collection("learning_projection_builds").countDocuments(scope(f)), buildCount);
    assert.equal((await head(f)).failure_attempts, 5);
    assert.equal((await head(f)).retry_signature, exhausted.retry_signature);
    assert.equal(await f.db.collection("consumer_receipts").countDocuments({ consumer_name: CONSUMER, event_id: event._id }), 0);

    if (recovery === "audit") {
      const inspected = await reconcile(f.db);
      assert.equal(inspected.requested, 0);
      assert.equal((await head(f)).failure_attempts, 5, "只读检查不得重置预算");
      const repaired = await reconcile(f.db, { apply: true, actor: "integration-budget", reason: "确认依赖恢复后重开失败预算" });
      assert.equal(repaired.requested, 1);
      assert.equal((await head(f)).failure_attempts, 0);
      const audit = await f.db.collection("audit_events").findOne({ action: "learning.reconcile", actor_id: "integration-budget", resource_id: f.student.memberId });
      assert.equal(audit.reason, "确认依赖恢复后重开失败预算");
      assert.equal(await processDue(f.db), 1);
      assert.equal((await activeRows(f, "mastery_evidence")).length, 3);
    } else {
      const scopeFilter = { org_id: f.org, subject_id: f.subject };
      const before = await f.db.collection("learning_scope_states").findOne(scopeFilter);
      await grant(f, f.editor, "content:revoke");
      const question = await good(f.editor, `/admin/question-versions/${f.questions[0].id}`);
      await good(f.editor, `/admin/question-versions/${question.id}/revoke-access`, { method: "POST", body: {
        expected_access_revision: question.access_revision, reason: "真实scope变更开启新的投影预算",
      } });
      const changed = await f.db.collection("learning_scope_states").findOne(scopeFilter);
      assert.ok(changed.eligibility_revision > before.eligibility_revision);
      await expireBackoff();
      assert.equal(await processDue(f.db), 1, "新scope无需人工reconcile即可恢复构建");
      assert.equal((await activeRows(f, "mastery_evidence")).length, 0);
      assert.equal((await activeRows(f, "report_snapshots")).length, 2);
      assert.equal(await f.db.collection("audit_events").countDocuments({ action: "learning.reconcile" }), 0);
    }
    const recovered = await head(f);
    assert.ok(recovered.active_generation);
    assert.equal(recovered.failure_attempts, 0);
    assert.equal(recovered.error_code, null);
    assert.equal(await f.db.collection("learning_projection_builds").countDocuments(scope(f)), buildCount + 1);
  });

  await parent.test("真实已评分提交跨7/30/90天退出窗口，processDue无需新事件更新", async t => {
    const f = await setup(t);
    const submission = await submit(f);
    await grade(f, submission.id);
    await drain(f);
    // Only age the real submission clock. Frozen contexts, answers and grading
    // results remain the actual output of HTTP submission and grading workers.
    for (const [days, seven, thirty, evidenceCount] of [[6, 3, 3, 3], [8, 0, 3, 3], [31, 0, 0, 3], [91, 0, 0, 0]]) {
      await f.db.collection("submissions").updateOne({ _id: submission.id }, [{ $set: { submitted_at: { $subtract: ["$$NOW", days * DAY_MS] } } }]);
      await forceDue(f);
      const reports = await activeRows(f, "report_snapshots");
      assert.equal(reports.find(row => row.period === "7d").attempt_count, seven);
      assert.equal(reports.find(row => row.period === "30d").attempt_count, thirty);
      assert.equal((await activeRows(f, "mastery_evidence")).length, evidenceCount);
      assert.equal((await activeRows(f, "mistake_entries")).length, evidenceCount);
    }
  });

  await parent.test("reconcile默认只读，apply要求操作者原因并原子审计；cleanup保留active", async t => {
    const f = await setup(t);
    const first = await submit(f);
    await grade(f, first.id);
    const names = ["learning_projection_heads", "learning_projection_builds", "student_projection_states", "audit_events"];
    const snapshot = async () => Promise.all(names.map(name => f.db.collection(name).find({}).sort({ _id: 1 }).toArray()));
    const before = await snapshot();
    const report = await reconcile(f.db);
    assert.equal(report.apply, false);
    assert.equal(report.missing_heads, 1);
    assert.equal(report.requested, 0);
    assert.deepEqual(await snapshot(), before);
    await assert.rejects(reconcile(f.db, { apply: true }), /RECONCILE_ACTOR_REASON_REQUIRED/);
    assert.deepEqual(await snapshot(), before);
    const applied = await reconcile(f.db, { apply: true, actor: "integration-learning", reason: "恢复丢失head" });
    assert.equal(applied.requested, 1);
    const audit = await f.db.collection("audit_events").findOne({ action: "learning.reconcile", resource_id: f.student.memberId });
    assert.equal(audit.actor_id, "integration-learning");
    assert.equal(audit.reason, "恢复丢失head");
    assert.equal((await head(f)).rebuild_requested, true);
    assert.equal(await processDue(f.db), 1);
    const old = await drain(f);
    const second = await submit(f);
    await grade(f, second.id);
    const current = await drain(f);
    assert.notEqual(current.active_generation, old.active_generation);
    // Retention age is operational metadata; do not manufacture build success.
    await f.db.collection("learning_projection_builds").updateMany(scope(f), [{ $set: {
      created_at: { $subtract: ["$$NOW", 9 * DAY_MS] }, updated_at: { $subtract: ["$$NOW", 8 * DAY_MS] },
    } }]);
    assert.equal(await cleanup(f.db), 0, "旧build刚退休时仍需保留完整七天");
    assert.equal(await f.db.collection("learning_projection_retirements").countDocuments({ generation: old.active_generation }), 1);
    await f.db.collection("learning_projection_retirements").updateOne({ generation: old.active_generation }, [{ $set: {
      retired_at: { $subtract: ["$$NOW", 8 * DAY_MS] },
    } }]);
    assert.equal(await cleanup(f.db), 1);
    assert.equal(await f.db.collection("learning_projection_builds").countDocuments({ generation: old.active_generation }), 0);
    assert.equal(await f.db.collection("learning_projection_builds").countDocuments({ generation: current.active_generation }), 1);
    for (const name of derived) assert.equal(await f.db.collection(name).countDocuments({ generation: old.active_generation }), 0);
    assert.equal((await head(f)).active_generation, current.active_generation);
    assert.equal((await activeRows(f, "mastery_evidence")).length, 6);
  });
});
