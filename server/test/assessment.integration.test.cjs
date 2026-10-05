"use strict";
const {newId}=require("../dist/database/object-id");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { error, status, guardedUri } = require("./helpers.cjs");
const { assessmentFixture, request, good, grant, createQuiz, quizInput, practice } = require("./assessment-helpers.cjs");

function noFeedback(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!["snapshot", "explanation", "scoring_rule", "knowledge_weights", "standard_answer", "correct", "verdict", "score", "total_score", "storage_key", "storage_path", "answers_hash", "request_hash"].includes(key), `未发布投影不能包含 ${key}`);
    noFeedback(child);
  }
}
function studentItem(item) {
  const allowed = ["id", "position", "question_type", "title", "prompt", "options", "resource_ids", "max_score", "answer"];
  assert.deepEqual(Object.keys(item).sort(), allowed.sort());
  assert.ok(item.answer === null || typeof item.answer === "object", "answer只能是本人作答，不能是标准答案字符串");
  noFeedback(item);
}
async function items(f, session) {
  return good(f.student, `/sessions/${session.id}/items`);
}
async function submit(f, session, answers = [], key = randomUUID()) {
  return good(f.student, `/sessions/${session.id}/submissions`, { method: "POST", key,
    body: { expected_revision: session.revision, answers } }, 202);
}
async function grade(f, submissionId) {
  const { processOne } = require("../dist/assessment/worker.js");
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = await f.db.collection("submissions").findOne({ _id: submissionId });
    if (current.grading_status === "completed") return current;
    assert.ok(["pending", "running"].includes(current.grading_status), "真实评分不能把失败当完成");
    await processOne(f.db);
  }
  assert.fail("真实worker未在有界消费内完成目标提交");
}
async function counts(f) {
  const result = {};
  for (const name of ["sessions", "session_items", "answers", "submissions", "grading_runs", "outbox_events", "idempotency_records", "assessment_resource_references", "attempt_counters"])
    result[name] = await f.db.collection(name).countDocuments({ org_id: f.org });
  return result;
}

test("A04b 开考窗口CAS后跨越关场仍以CAS数据库时间计时且计次原子提交", { concurrency: false, timeout: 120000 }, async (t) => {
  guardedUri(process.env.TEST_MONGODB_URI);
  const f = await assessmentFixture(t, { publishedQuiz: true });
  const before = await counts(f);
  // Change only isolated fixture policy; the CAS and the wait both use real Mongo $$NOW.
  await f.db.collection("quizzes").updateOne({ _id: f.quizId }, [{ $set: {
    closes_at: { $dateAdd: { startDate: "$$NOW", unit: "second", amount: 3 } },
  } }]);
  // Nest's Database uses Mongoose's MongoClient, which may resolve a nested driver copy.
  const { Collection } = require("mongoose").mongo;
  const original = Collection.prototype.findOneAndUpdate;
  let fenced, crossedClose = false;
  Collection.prototype.findOneAndUpdate = async function (...args) {
    const result = await original.apply(this, args);
    if (this.namespace === `${f.db.databaseName}.quizzes` && String(args[0]._id) === f.quizId &&
        args[0].$expr && args[2]?.session && result && !fenced) {
      assert.equal(args[2].session.inTransaction(), true);
      fenced = result;
      assert.ok(fenced.updated_at < fenced.closes_at, "窗口CAS必须发生在关场之前");
      assert.deepEqual(await counts(f), before, "未提交事务不能泄漏会话、题项或计次");
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        if (await f.db.collection("quizzes").findOne({ _id: f.quizId,
          $expr: { $lte: ["$closes_at", "$$NOW"] } })) {
          crossedClose = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(crossedClose, "恢复CAS返回前，真实Mongo时间必须已越过关场");
    }
    return result;
  };
  const key = randomUUID();
  let session;
  try {
    session = await good(f.student, `/quizzes/${f.quizId}/sessions`, { method: "POST", body: {}, key });
  } finally {
    Collection.prototype.findOneAndUpdate = original;
  }
  assert.ok(fenced && crossedClose, "必须实际经过驱动返回屏障");
  const persisted = await f.db.collection("sessions").findOne({ _id: session.id });
  assert.equal(persisted.started_at.getTime(), fenced.updated_at.getTime(), "开考时间必须等于窗口CAS的数据库时间，不能二次取时");
  const deadline = Math.min(fenced.updated_at.getTime() + fenced.duration_seconds * 1000, fenced.closes_at.getTime());
  assert.equal(persisted.deadline_at.getTime(), deadline);
  assert.ok(persisted.started_at < persisted.deadline_at);
  assert.equal(new Date(session.started_at).getTime(), fenced.updated_at.getTime());
  assert.equal(new Date(session.deadline_at).getTime(), deadline);
  assert.equal(await f.db.collection("sessions").countDocuments({ quiz_id: f.quizId }), 1);
  assert.equal(await f.db.collection("session_items").countDocuments({ session_id: session.id }), persisted.item_count);
  const counters = await f.db.collection("attempt_counters").find({ quiz_id: f.quizId, member_id: f.student.memberId }).toArray();
  assert.equal(counters.length, 1);
  assert.equal(counters[0].allocated, 1);
  assert.equal(counters[0].created_at.getTime(), fenced.updated_at.getTime());
  const receipts = await f.db.collection("idempotency_records").find({ org_id: f.org, operation: "quiz.start", resource_id: f.quizId, key }).toArray();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].result.id, session.id);
  assert.deepEqual(await good(f.student, `/quizzes/${f.quizId}/sessions`, { method: "POST", body: {}, key }), session);
  assert.equal((await f.db.collection("attempt_counters").findOne({ _id: counters[0]._id })).allocated, 1);
  assert.equal(await f.db.collection("sessions").countDocuments({ quiz_id: f.quizId }), 1);
});

// Real replica-set migration, authentication, HTTP and worker; no mock or skip fallback.
test("阶段三：真实HTTP练习、考试和结果事务", { concurrency: false, timeout: 600000 }, async (t) => {
  guardedUri(process.env.TEST_MONGODB_URI);

  await t.test("A01 练习题单一次冻结、白名单及幂等恢复，题量不足整体回滚", async (t) => {
    const f = await assessmentFixture(t);
    const key = randomUUID();
    const session = await practice(f, {}, key);
    assert.deepEqual(await practice(f, {}, key), session);
    assert.equal(session.mode, "practice"); assert.equal(session.item_count, 3); assert.equal(session.deadline_at, null);
    const first = await items(f, session);
    assert.equal(first.session_revision, session.revision); assert.equal(first.items.length, 3);
    first.items.forEach(studentItem);
    assert.deepEqual(await items(f, session), first);
    const frozen = await f.db.collection("session_items").find({ session_id: session.id }).toArray();
    assert.equal(new Set(frozen.map((row) => row.snapshot.question_id)).size, 3);
    assert.ok(frozen.every((row) => typeof row.snapshot.answer === "string" && row.snapshot.scoring_rule.version === 1));
    error(await request(f.student, "/practice-sessions", { method: "POST", key, body: {
      textbook_edition_id: f.book.id, chapter_id: f.chapterId, knowledge_point_ids: [f.knowledge], count: 2,
    } }), 409);
    const before = await counts(f);
    error(await request(f.student, "/practice-sessions", { method: "POST", body: {
      textbook_edition_id: f.book.id, knowledge_point_ids: [f.knowledge], count: 4,
    } }), 409);
    assert.deepEqual(await counts(f), before);
    const recovered = await good(f.student, `/me/idempotency-requests?operation=practice.create&resource_id=new&key=${key}`);
    assert.equal(recovered.status, "resolved"); assert.equal(recovered.response_status, 200); assert.deepEqual(recovered.result, session); noFeedback(recovered);
    const other = await f.actor();
    const hidden = await good(other, `/me/idempotency-requests?operation=practice.create&resource_id=new&key=${key}`);
    assert.deepEqual(hidden, { status: "unknown" });
    error(await request(other, `/sessions/${session.id}/items`), 404);
    error(await request(f.student, "/practice-sessions", { method: "POST", body: {
      textbook_edition_id: f.book.id, knowledge_point_ids: [f.knowledge], count: 1, student_id: other.user.user_id,
    } }), 422);
  });

  await t.test("A01b 教材退役仍可幂等恢复既有练习，新建及撤销后恢复均拒绝", async (t) => {
    const f = await assessmentFixture(t);
    const key = randomUUID();
    const body = { textbook_edition_id: f.book.id, chapter_id: f.chapterId, knowledge_point_ids: [f.knowledge], count: 3 };
    const session = await good(f.student, "/practice-sessions", { method: "POST", key, body });
    await grant(f, f.editor, "content:retire");
    await grant(f, f.editor, "content:revoke");
    await good(f.editor, `/admin/textbook-editions/${f.book.id}/retire`, { method: "POST", body: {
      expected_revision: f.book.revision, reason: "原创教材停止新使用，保留既有会话许可",
    } });
    const before = await counts(f);
    assert.deepEqual(await good(f.student, "/practice-sessions", { method: "POST", key, body }), session);
    assert.deepEqual(await counts(f), before);
    const conflict = await request(f.student, "/practice-sessions", { method: "POST", key, body: { ...body, count: 2 } });
    error(conflict, 409);
    assert.equal(conflict.data.error.code, "IDEMPOTENCY_CONFLICT");
    const fresh = await request(f.student, "/practice-sessions", { method: "POST", key: randomUUID(), body });
    error(fresh, 409);
    assert.equal(fresh.data.error.code, "CONTENT_UNAVAILABLE");
    assert.deepEqual(await counts(f), before);
    const retired = await good(f.editor, `/admin/textbook-editions/${f.book.id}`);
    await good(f.editor, `/admin/textbook-editions/${f.book.id}/revoke-access`, { method: "POST", body: {
      expected_access_revision: retired.access_revision, reason: "原创教材既有授权撤销",
    } });
    const afterRevocation = await counts(f);
    const revoked = await request(f.student, "/practice-sessions", { method: "POST", key, body });
    error(revoked, 409);
    assert.equal(revoked.data.error.code, "CONTENT_UNAVAILABLE");
    assert.deepEqual(await counts(f), afterRevocation);
  });

  await t.test("A02 双设备CAS唯一成功，非法/清空答案与最终补丁事务回滚", async (t) => {
    const f = await assessmentFixture(t);
    let session = await practice(f);
    const page = await items(f, session);
    const single = page.items.find((row) => row.question_type === "single");
    const multiple = page.items.find((row) => row.question_type === "multiple");
    const numeric = page.items.find((row) => row.question_type === "numeric");
    const savePath = `/sessions/${session.id}/answers/${single.id}`;
    const races = await Promise.all(["A", "B"].map((choice) => request(f.student, savePath, { method: "PUT", body: {
      expected_revision: session.revision, answer: { selected_option_ids: [choice] },
    } })));
    assert.deepEqual(races.map((row) => row.status).sort(), [200, 409]);
    session = await good(f.student, `/sessions/${session.id}`);
    assert.equal(session.revision, page.session_revision + 1);
    const persisted = await f.db.collection("answers").findOne({ session_item_id: single.id });
    assert.deepEqual(persisted.answer, (await items(f, session)).items.find((row) => row.id === single.id).answer);
    for (const [item, answer] of [[single, { selected_option_ids: ["A", "B"] }], [multiple, { selected_option_ids: ["A", "A"] }],
      [multiple, { selected_option_ids: ["Z"] }], [numeric, { value: "NaN" }], [numeric, { value: "1e101" }], [numeric, { value: "2", score: "100" }]]) {
      const before = await counts(f);
      error(await request(f.student, `/sessions/${session.id}/answers/${item.id}`, { method: "PUT", body: { expected_revision: session.revision, answer } }), 422);
      assert.deepEqual(await counts(f), before);
      assert.equal((await good(f.student, `/sessions/${session.id}`)).revision, session.revision);
    }
    const before = await counts(f);
    error(await request(f.student, `/sessions/${session.id}/submissions`, { method: "POST", body: {
      expected_revision: session.revision, answers: [{ session_item_id: single.id, answer: { selected_option_ids: ["A"] } },
        { session_item_id: numeric.id, answer: { value: "Infinity" } }],
    } }), 422);
    assert.deepEqual(await counts(f), before);
    assert.deepEqual((await f.db.collection("answers").findOne({ session_item_id: single.id })).answer, persisted.answer);
    const saved = await good(f.student, `/sessions/${session.id}/answers/${multiple.id}`, { method: "PUT", body: {
      expected_revision: session.revision, answer: { selected_option_ids: ["B", "A"] },
    } });
    assert.deepEqual((await f.db.collection("answers").findOne({ session_item_id: multiple.id })).answer, { selected_option_ids: ["A", "B"] });
    const cleared = await good(f.student, `/sessions/${session.id}/answers/${single.id}`, { method: "PUT", body: { expected_revision: saved.revision, answer: null } });
    assert.equal((await f.db.collection("answers").findOne({ session_item_id: single.id })).answer, null);
    session = { ...session, revision: cleared.revision };
    const key = randomUUID();
    const patches = [{ session_item_id: single.id, answer: { selected_option_ids: ["A"] } }, { session_item_id: numeric.id, answer: { value: "2.00e0" } }];
    const accepted = await submit(f, session, patches, key);
    assert.equal(accepted.session_status, "submitted"); assert.equal(accepted.report_status, "not_available"); noFeedback(accepted);
    assert.deepEqual(await submit(f, session, patches, key), accepted);
    const terminal = await Promise.all(Array.from({ length: 10 }, () => submit(f, session)));
    assert.ok(terminal.every((row) => row.submission_id === accepted.submission_id));
    assert.equal(await f.db.collection("submissions").countDocuments({ session_id: session.id }), 1);
    assert.equal(await f.db.collection("grading_runs").countDocuments({ submission_id: accepted.submission_id }), 1);
    assert.equal(await f.db.collection("outbox_events").countDocuments({ aggregate_id: accepted.submission_id, event_type: "SubmissionAccepted" }), 1);
    await grade(f, accepted.submission_id);
    const result = await good(f.student, `/submissions/${accepted.submission_id}`);
    assert.equal(result.total_score, "6.75"); assert.equal(result.release_status, "released");
    assert.equal((await good(f.student, `/submissions/${accepted.submission_id}/items`)).items.length, 3);
  });

  await t.test("A03 独立评估管理选题与受众、草稿替换CAS和非作者发布", async (t) => {
    const f = await assessmentFixture(t);
    const candidates = await good(f.manager, `/admin/assessment-questions?subject_id=${f.subject}&limit=2`);
    assert.equal(candidates.items.length, 2); noFeedback(candidates);
    const candidate = await good(f.manager, `/admin/assessment-questions/${f.questions[0].id}`);
    assert.equal(candidate.answer, "A");
    error(await request(f.manager, `/admin/question-versions/${f.questions[0].id}`), 403);
    const members = await good(f.manager, "/admin/assessment-members");
    assert.ok(members.items.some((row) => row.id === f.student.memberId));
    assert.ok(!members.items.some((row) => [f.manager.memberId, f.reviewer.memberId, f.editor.memberId].includes(row.id)));
    for (const row of members.items) assert.deepEqual(Object.keys(row).sort(), ["display_name", "id"]);
    let quiz = await createQuiz(f, {}, false);
    await grant(f, f.manager, "assessment:review");
    error(await request(f.manager, `/quizzes/${quiz.id}/publish`, { method: "POST", body: { expected_revision: quiz.revision, reason: "不得自审" } }), 403);
    const replacement = quizInput(f, { title: "完整替换试卷", items: [{ question_version_id: f.questions[0].id, max_score: "9.50" }], expected_revision: quiz.revision });
    quiz = await good(f.manager, `/quizzes/${quiz.id}`, { method: "PATCH", body: replacement });
    error(await request(f.manager, `/quizzes/${quiz.id}`, { method: "PATCH", body: replacement }), 409);
    const detail = await good(f.reviewer, `/admin/quizzes/${quiz.id}`);
    assert.equal(detail.items.length, 1); assert.equal(detail.items[0].question_version_id, f.questions[0].id);
    assert.deepEqual(detail.audience_member_ids, [f.student.memberId]);
    await good(f.reviewer, `/quizzes/${quiz.id}/publish`, { method: "POST", body: { expected_revision: quiz.revision, reason: "独立通过" } });
    const published = await good(f.reviewer, `/admin/quizzes/${quiz.id}`);
    assert.equal(published.status, "published");
    const storedQuiz = await f.db.collection("quizzes").findOne({ _id: published.id, org_id: f.org });
    assert.ok(storedQuiz?.published_paper_id, "发布必须持久化冻结试卷引用");
    const paper = await f.db.collection("papers").findOne({ _id: storedQuiz.published_paper_id, quiz_id: published.id, org_id: f.org });
    assert.ok(paper, "发布引用必须指向本考试的试卷");
    assert.equal(paper.status, "frozen");
    error(await request(f.manager, `/quizzes/${quiz.id}`, { method: "PATCH", body: { ...replacement, expected_revision: published.revision } }), 409);
    const outsider = await f.actor();
    error(await request(outsider, `/quizzes/${quiz.id}`), 404);
    error(await request(outsider, `/quizzes/${quiz.id}/sessions`, { method: "POST", body: {} }), 404);
    noFeedback(await good(f.student, `/quizzes/${quiz.id}`));
    error(await request(f.editor, "/admin/submissions"), 403);
  });

  await t.test("A04 窗口检查、并发启动及同key恢复不重复扣次", async (t) => {
    const f = await assessmentFixture(t, { publishedQuiz: true });
    const path = `/quizzes/${f.quizId}/sessions`;
    const before = await counts(f);
    await f.db.collection("quizzes").updateOne({ _id: f.quizId }, [{ $set: { opens_at: { $dateAdd: { startDate: "$$NOW", unit: "minute", amount: 1 } } } }]);
    error(await request(f.student, path, { method: "POST", body: {} }), 409);
    assert.deepEqual(await counts(f), before);
    await f.db.collection("quizzes").updateOne({ _id: f.quizId }, [{ $set: { opens_at: { $dateSubtract: { startDate: "$$NOW", unit: "minute", amount: 1 } } } }]);
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 5 }, () => request(f.student, path, { method: "POST", body: {}, key })));
    responses.forEach((row) => status(row, 200));
    const session = responses[0].data.data;
    responses.forEach((row) => assert.deepEqual(row.data.data, session));
    const counter = await f.db.collection("attempt_counters").findOne({ quiz_id: f.quizId, member_id: f.student.memberId });
    assert.equal(counter.allocated, 1);
    assert.equal(await f.db.collection("sessions").countDocuments({ quiz_id: f.quizId }), 1);
    assert.ok(new Date(session.deadline_at) <= new Date(f.quiz.closes_at));
    const otherKeys = await Promise.all(Array.from({ length: 5 }, () => request(f.student, path, { method: "POST", body: {} })));
    otherKeys.forEach((row) => error(row, 409));
    await submit(f, session);
    const exhausted = await request(f.student, path, { method: "POST", body: {} });
    error(exhausted, 409); assert.equal(exhausted.data.error.code, "ATTEMPT_LIMIT_REACHED");
    assert.equal((await f.db.collection("attempt_counters").findOne({ _id: counter._id })).allocated, 1);
  });

  await t.test("A05 成绩整卷发布守卫、保密练习阻断与真实重批修订", async (t) => {
    const f = await assessmentFixture(t, { publishedQuiz: true });
    const { processVisibility } = require("../dist/assessment/worker.js");
    const fingerprint = (state) => createHash("sha256").update(state).digest("hex");
    const projection = () => f.db.collection("student_projection_states").findOne({ org_id: f.org, member_id: f.student.memberId });
    const visibilityEvents = () => f.db.collection("outbox_events").countDocuments({ org_id: f.org, event_type: "AssessmentVisibilityChanged" });
    async function visibilityTransition(state) {
      const before = await projection();
      const events = await visibilityEvents();
      assert.equal(await processVisibility(f.db), 1);
      const row = await f.db.collection("submissions").findOne({ _id: accepted.submission_id });
      assert.equal(row.visibility_fingerprint, fingerprint(state));
      assert.equal((await projection()).projection_revision, before.projection_revision + 1);
      assert.equal(await visibilityEvents(), events + 1);
      assert.equal(await processVisibility(f.db), 0);
      assert.deepEqual(await f.db.collection("submissions").findOne({ _id: row._id }), row);
      assert.equal((await projection()).projection_revision, before.projection_revision + 1);
      assert.equal(await visibilityEvents(), events + 1);
    }
    const session = await good(f.student, `/quizzes/${f.quizId}/sessions`, { method: "POST", body: {} });
    const item = (await items(f, session)).items[0]; studentItem(item); assert.equal(item.max_score, "7.25");
    const accepted = await submit(f, session, [{ session_item_id: item.id, answer: { value: "2" } }]);
    await grade(f, accepted.submission_id);
    await visibilityTransition("pending");
    let result = await good(f.student, `/submissions/${accepted.submission_id}`);
    assert.equal(result.grading_status, "completed"); assert.equal(result.release_status, "pending"); noFeedback(result);
    const blocked = await request(f.student, `/submissions/${accepted.submission_id}/items`);
    error(blocked, 409); noFeedback(blocked.data);
    const practiceSession = await practice(f, { count: 2 });
    assert.ok((await f.db.collection("session_items").find({ session_id: practiceSession.id }).toArray()).every((row) => row.snapshot.question_version_id !== f.questions[2].id));
    // Only isolated persisted policy dates move; all authorization/time decisions still use real Mongo $$NOW.
    await f.db.collection("quizzes").updateOne({ _id: f.quizId }, [{ $set: {
      closes_at: { $dateSubtract: { startDate: "$$NOW", unit: "second", amount: 2 } },
      release_at: { $dateSubtract: { startDate: "$$NOW", unit: "second", amount: 1 } },
    } }]);
    await visibilityTransition("released");
    assert.equal((await f.db.collection("assessment_question_states").findOne({ org_id: f.org, question_version_id: f.questions[2].id })).answer_disclosed, false);
    result = await good(f.student, `/submissions/${accepted.submission_id}`);
    assert.equal(result.release_status, "released"); assert.equal(result.total_score, "7.25");
    assert.equal((await f.db.collection("assessment_question_states").findOne({ org_id: f.org, question_version_id: f.questions[2].id })).answer_disclosed, true);
    const oldPage = await good(f.student, `/submissions/${accepted.submission_id}/items`);
    assert.equal(oldPage.items.length, 1); assert.equal(oldPage.grading_revision, result.effective_grading_revision);
    const admin = await good(f.reviewer, `/admin/submissions/${accepted.submission_id}`);
    const regradeKey = randomUUID();
    const body = { expected_revision: admin.revision, reason: "独立复核原始评分代码" };
    const beforeRegrade = await projection();
    const beforeRegradeEvents = await visibilityEvents();
    const reviewerProjection = await f.db.collection("student_projection_states").findOne({ org_id: f.org, member_id: f.reviewer.memberId });
    const regrade = await good(f.reviewer, `/submissions/${accepted.submission_id}/regrades`, { method: "POST", key: regradeKey, body }, 202);
    assert.deepEqual(await good(f.reviewer, `/submissions/${accepted.submission_id}/regrades`, { method: "POST", key: regradeKey, body }, 202), regrade);
    assert.equal((await projection()).projection_revision, beforeRegrade.projection_revision + 1);
    assert.deepEqual(await f.db.collection("student_projection_states").findOne({ org_id: f.org, member_id: f.reviewer.memberId }), reviewerProjection);
    assert.equal(await visibilityEvents(), beforeRegradeEvents + 1);
    const queued = await f.db.collection("submissions").findOne({ _id: accepted.submission_id });
    assert.equal(queued.visibility_fingerprint, fingerprint("regrading"));
    assert.equal(await processVisibility(f.db), 0);
    assert.deepEqual(await f.db.collection("submissions").findOne({ _id: queued._id }), queued);
    result = await good(f.student, `/submissions/${accepted.submission_id}`);
    assert.equal(result.release_status, "regrading"); noFeedback(result);
    const pending = await good(f.reviewer, `/admin/submissions/${accepted.submission_id}`);
    error(await request(f.reviewer, `/submissions/${accepted.submission_id}/regrades`, { method: "POST", body: { expected_revision: pending.revision, reason: "并发重批不得重排" } }), 409);
    await grade(f, accepted.submission_id);
    await visibilityTransition("released");
    result = await good(f.student, `/submissions/${accepted.submission_id}`);
    assert.equal(result.total_score, "7.25"); assert.equal(result.effective_grading_revision, queued.requested_grading_revision);
    assert.equal(await f.db.collection("grading_runs").countDocuments({ submission_id: accepted.submission_id }), 2);
    await grant(f, f.editor, "content:revoke");
    const source = await good(f.editor, `/admin/question-versions/${f.questions[2].id}`);
    await good(f.editor, `/admin/question-versions/${source.id}/revoke-access`, { method: "POST", body: { expected_access_revision: source.access_revision, reason: "原创验收授权撤销" } });
    await visibilityTransition("withheld_access");
    const withheld = await good(f.student, `/submissions/${accepted.submission_id}`);
    assert.equal(withheld.release_status, "withheld_access"); noFeedback(withheld);
    error(await request(f.student, `/submissions/${accepted.submission_id}/items`), 409);
    assert.equal((await f.db.collection("submissions").findOne({ _id: accepted.submission_id })).total_score.toString(), "7.25");
  });

  await t.test("A08 无人读取的可见性事件不披露；真实反馈永久阻止后发布", async (t) => {
    const f = await assessmentFixture(t);
    const { processVisibility } = require("../dist/assessment/worker.js");
    const session = await practice(f);
    const accepted = await submit(f, session);
    await grade(f, accepted.submission_id);
    assert.equal(await processVisibility(f.db), 1);
    assert.equal(await processVisibility(f.db), 0);
    assert.equal(await f.db.collection("outbox_events").countDocuments({ org_id: f.org, event_type: "AssessmentVisibilityChanged" }), 1);
    assert.equal(await f.db.collection("assessment_question_states").countDocuments({ org_id: f.org, answer_disclosed: true }), 0);

    // An unread result must not burn its source question: a real later publication is still legal.
    // Put the embargo last in the guard's sorted order to catch partial disclosure of earlier items.
    const embargoVersion = f.questions.map(question => question.id).sort().at(-1);
    const quiz = await createQuiz(f, { items: [{ question_version_id: embargoVersion, max_score: "7.25" }] });
    assert.equal(quiz.status, "published");
    assert.equal(await processVisibility(f.db), 1);
    const withheld = await good(f.student, `/submissions/${accepted.submission_id}`);
    assert.equal(withheld.release_status, "withheld_embargo");
    noFeedback(withheld);
    error(await request(f.student, `/submissions/${accepted.submission_id}/items`), 409);
    assert.equal(await f.db.collection("assessment_question_states").countDocuments({ org_id: f.org, answer_disclosed: true }), 0);

    await f.db.collection("quizzes").updateOne({ _id: quiz.id }, [{ $set: {
      closes_at: { $dateSubtract: { startDate: "$$NOW", unit: "second", amount: 2 } },
      release_at: { $dateSubtract: { startDate: "$$NOW", unit: "second", amount: 1 } },
    } }]);
    assert.equal(await processVisibility(f.db), 1);
    assert.equal(await f.db.collection("assessment_question_states").countDocuments({ org_id: f.org, answer_disclosed: true }), 0);
    const page = await good(f.student, `/submissions/${accepted.submission_id}/items`);
    assert.equal(page.items.length, 3);
    assert.equal(await f.db.collection("assessment_question_states").countDocuments({ org_id: f.org, answer_disclosed: true }), 3);
    assert.equal(await processVisibility(f.db), 0);
    assert.equal(await f.db.collection("assessment_question_states").countDocuments({ org_id: f.org, answer_disclosed: true }), 3);
    const next = await createQuiz(f, {}, false);
    error(await request(f.reviewer, `/quizzes/${next.id}/publish`, { method: "POST", body: { expected_revision: next.revision, reason: "已披露来源不得重新保密" } }), 409);
    assert.equal((await good(f.reviewer, `/admin/quizzes/${next.id}`)).status, "draft");
  });

  await t.test("A09 真实结果读取与考试发布竞争不能同时放行", async (t) => {
    const f = await assessmentFixture(t);
    const session = await practice(f);
    const accepted = await submit(f, session);
    await grade(f, accepted.submission_id);
    const quiz = await createQuiz(f, {}, false);
    const [feedback, published] = await Promise.all([
      request(f.student, `/submissions/${accepted.submission_id}/items`),
      request(f.reviewer, `/quizzes/${quiz.id}/publish`, { method: "POST", body: { expected_revision: quiz.revision, reason: "反馈竞争验收" } }),
    ]);
    assert.equal([feedback, published].filter(response => response.status === 200).length, 1);
    const state = await f.db.collection("assessment_question_states").findOne({ org_id: f.org, question_version_id: f.questions[2].id });
    if (feedback.status === 200) {
      assert.equal(feedback.data.data.items.length, 3);
      error(published, 409);
      assert.equal(state.answer_disclosed, true);
      assert.equal(state.embargo_quiz_id, null);
    } else {
      status(published, 200);
      error(feedback, 409);
      noFeedback(feedback.data);
      assert.equal(state.answer_disclosed, false);
      assert.equal(state.embargo_quiz_id, quiz.id);
      assert.equal(await f.db.collection("assessment_question_states").countDocuments({ org_id: f.org, answer_disclosed: true }), 0);
    }
  });

  await t.test("A06 错配事件失败不得污染 payload 指向的评分目标", async (t) => {
    const f = await assessmentFixture(t);
    const session = await practice(f);
    const accepted = await submit(f, session);
    const submission = await f.db.collection("submissions").findOne({ _id: accepted.submission_id });
    const run = await f.db.collection("grading_runs").findOne({ submission_id: submission._id });
    const original = await f.db.collection("outbox_events").findOne({ aggregate_id: submission._id, event_type: "SubmissionAccepted" });
    const invalid = { ...original, _id: newId(), aggregate_id: newId(), available_at: new Date(0) };
    await f.db.collection("outbox_events").insertOne(invalid);
    const { processOne } = require("../dist/assessment/worker.js");
    assert.equal(await processOne(f.db), true);
    const failed = await f.db.collection("outbox_events").findOne({ _id: invalid._id });
    assert.equal(failed.status, "failed");
    assert.equal(failed.error_code, "INVALID_FROZEN_EVIDENCE");
    assert.deepEqual(await f.db.collection("submissions").findOne({ _id: submission._id }), submission);
    assert.deepEqual(await f.db.collection("grading_runs").findOne({ _id: run._id }), run);
    await grade(f, submission._id);
  });

  await t.test("A07 reconcile正式审计修复缺失事件，CLI once完成评分和可见性", async (t) => {
    const f = await assessmentFixture(t);
    const session = await practice(f);
    const accepted = await submit(f, session);
    await f.db.collection("outbox_events").deleteOne({ aggregate_id: accepted.submission_id, event_type: "SubmissionAccepted" });
    const { reconcile } = require("../dist/assessment/worker.js");
    const dry = await reconcile(f.db);
    assert.equal(dry.missing_events, 1);
    assert.equal(dry.repaired_events, 0);
    const repaired = await reconcile(f.db, { apply: true, actor: f.reviewer.memberId, reason: "隔离验收补发丢失评分事件" });
    assert.equal(repaired.repaired_events, 1);
    assert.equal(await f.db.collection("audit_events").countDocuments({ action: "assessment.reconcile", resource_id: accepted.submission_id }), 1);
    assert.equal((await reconcile(f.db, { apply: true, actor: f.reviewer.memberId, reason: "确认幂等" })).repaired_events, 0);
    const execFile = require("node:util").promisify(require("node:child_process").execFile);
    const worker = require.resolve("../dist/assessment/worker.js");
    const options = { env: { ...process.env, MONGODB_URI: f.uri }, timeout: 30000 };
    const first = await execFile(process.execPath, [worker, "once"], options);
    assert.deepEqual(JSON.parse(first.stdout.trim()), { processed: true, deadlines: 0, visible: 1 });
    const row = await f.db.collection("submissions").findOne({ _id: accepted.submission_id });
    assert.equal(row.grading_status, "completed");
    assert.match(row.visibility_fingerprint, /^[a-f0-9]{64}$/);
    const second = await execFile(process.execPath, [worker, "once"], options);
    assert.deepEqual(JSON.parse(second.stdout.trim()), { processed: false, deadlines: 0, visible: 0 });
    assert.deepEqual(await f.db.collection("submissions").findOne({ _id: row._id }), row);
  });
});

test("A10 连续显式勘误累积、同题替换、撤销拒绝及原标准重算", { concurrency: false, timeout: 120000 }, async (t) => {
  guardedUri(process.env.TEST_MONGODB_URI);
  const { createQuestion } = require("./assessment-helpers.cjs");
  const f = await assessmentFixture(t);
  const quiz = await createQuiz(f, { items: [
    { question_version_id: f.questions[0].id, max_score: "1.00" },
    { question_version_id: f.questions[2].id, max_score: "7.25" },
  ] });
  const session = await good(f.student, `/quizzes/${quiz.id}/sessions`, { method: "POST", body: {} });
  const paper = (await items(f, session)).items;
  const frozen = await f.db.collection("session_items").find({ session_id: session.id }).sort({ position: 1 }).toArray();
  assert.notEqual(frozen[0].snapshot.question_id, frozen[1].snapshot.question_id);
  const accepted = await submit(f, session, [
    { session_item_id: paper[0].id, answer: { selected_option_ids: ["B"] } },
    { session_item_id: paper[1].id, answer: { value: "3" } },
  ]);
  const original = await grade(f, accepted.submission_id);
  assert.equal(original.total_score.toString(), "0.00");
  const correctionA = await createQuestion(f, { source_version_id: f.questions[0].id, answer: "B" });
  const correctionB = await createQuestion(f, { source_version_id: f.questions[2].id,
    title: f.questions[2].title, question_type: "numeric", prompt: f.questions[2].prompt, options: [], answer: "3",
    scoring_rule: { version: 1, strategy: "numeric_exact_decimal", max_score: "99" } });
  const replacementA = await createQuestion(f, { source_version_id: correctionA.id, answer: "A" });
  const history = async () => ({
    runs: await f.db.collection("grading_runs").find({ submission_id: original._id }).sort({ revision: 1 }).toArray(),
    results: await f.db.collection("grading_results").find({ org_id: f.org, session_item_id: { $in: paper.map(item => item.id) } }).sort({ grading_run_id: 1, session_item_id: 1 }).toArray(),
  });
  const regrade = async (correction, expectedScore, versions) => {
    const before = await history();
    const current = await good(f.reviewer, `/admin/submissions/${original._id}`);
    const body = { expected_revision: current.revision, reason: "连续勘误隔离验收",
      ...(correction ? { correction_source_version_id: correction.id } : {}) };
    const key = randomUUID();
    const receipt = await good(f.reviewer, `/submissions/${original._id}/regrades`, { method: "POST", key, body }, 202);
    assert.deepEqual(await good(f.reviewer, `/submissions/${original._id}/regrades`, { method: "POST", key, body }, 202), receipt);
    const graded = await grade(f, original._id);
    assert.equal(graded.total_score.toString(), expectedScore);
    assert.equal(graded.effective_grading_revision, before.runs.length + 1);
    assert.equal(graded.answers_hash, original.answers_hash);
    const run = await f.db.collection("grading_runs").findOne({ _id: receipt.grading_run_id });
    assert.deepEqual(run.corrections.map(c => c.snapshot.question_version_id).sort(), [...versions].sort());
    assert.equal(new Set(run.corrections.map(c => c.session_item_id)).size, versions.length);
    const after = await history();
    assert.deepEqual(after.runs.slice(0, before.runs.length), before.runs);
    assert.deepEqual(after.results.filter(result => before.runs.some(old => old._id === result.grading_run_id)), before.results);
    assert.deepEqual(await f.db.collection("session_items").find({ session_id: session.id }).sort({ position: 1 }).toArray(), frozen);
    const visible = await good(f.reviewer, `/admin/submissions/${original._id}`);
    assert.equal(visible.total_score, expectedScore);
  };
  await regrade(correctionA, "1.00", [correctionA.id]);
  await regrade(correctionB, "8.25", [correctionA.id, correctionB.id]);
  await regrade(replacementA, "7.25", [replacementA.id, correctionB.id]);
  await grant(f, f.editor, "content:revoke");
  const source = await good(f.editor, `/admin/question-versions/${correctionB.id}`);
  await good(f.editor, `/admin/question-versions/${source.id}/revoke-access`, { method: "POST", body: {
    expected_access_revision: source.access_revision, reason: "撤销继承勘误依据",
  } });
  const before = await history();
  const beforeCounts = await counts(f);
  const current = await f.db.collection("submissions").findOne({ _id: original._id });
  const denied = await request(f.reviewer, `/submissions/${original._id}/regrades`, { method: "POST", body: {
    expected_revision: current.revision, reason: "继承依据已撤销必须拒绝", correction_source_version_id: correctionA.id,
  } });
  error(denied, 409);
  assert.equal(denied.data.error.code, "CONTENT_UNAVAILABLE");
  assert.deepEqual(await history(), before);
  assert.deepEqual(await counts(f), beforeCounts);
  assert.deepEqual(await f.db.collection("submissions").findOne({ _id: original._id }), current);
  await regrade(null, "0.00", []);
});
