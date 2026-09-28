"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { error, status, guardedUri } = require("./helpers.cjs");
const { assessmentFixture, request, good, createQuiz, createQuestion } = require("./assessment-helpers.cjs");

async function expire(f, session) {
  // Move only persisted fixture policy; HTTP and worker still arbitrate against Mongo $$NOW.
  await f.db.collection("sessions").updateOne({ _id: session.id }, [{ $set: {
    deadline_at: { $dateSubtract: { startDate: "$$NOW", unit: "second", amount: 1 } },
  } }]);
}
async function grade(f, submissionId) {
  const { processOne } = require("../dist/assessment/worker.js");
  for (let attempt = 0; attempt < 10; attempt++) {
    const row = await f.db.collection("submissions").findOne({ _id: submissionId });
    if (row.grading_status === "completed") return row;
    assert.ok(["pending", "running"].includes(row.grading_status), "评分失败不能充当验收成功");
    await processOne(f.db);
  }
  assert.fail("真实worker未在有界消费内完成提交");
}
async function uniqueSubmission(f, session, reason) {
  const submissions = await f.db.collection("submissions").find({ session_id: session.id }).toArray();
  assert.equal(submissions.length, 1);
  const submission = submissions[0];
  assert.equal(submission.reason, reason);
  const frozen = await f.db.collection("sessions").findOne({ _id: session.id });
  assert.equal(frozen.submission_id, submission._id);
  assert.equal(frozen.status, reason === "deadline" ? "expired" : "submitted");
  assert.equal(frozen.revision, session.revision + 1);
  assert.equal(await f.db.collection("grading_runs").countDocuments({ submission_id: submission._id }), 1);
  assert.equal(await f.db.collection("outbox_events").countDocuments({ aggregate_id: submission._id, event_type: "SubmissionAccepted" }), 1);
  assert.equal(await f.db.collection("sessions").countDocuments({ quiz_id: frozen.quiz_id }), 1);
  const counters = await f.db.collection("attempt_counters").find({ quiz_id: frozen.quiz_id, member_id: f.student.memberId }).toArray();
  assert.equal(counters.length, 1);
  assert.equal(counters[0].allocated, 1);
  return submission;
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
      timer = setTimeout(() => reject(new Error("截止竞争未在有界时间内到达屏障")), 15000);
    })]);
  } finally { clearTimeout(timer); }
}
async function nearDeadline(f, session) {
  // Only this isolated fixture's policy changes; eligibility still uses real Mongo $$NOW.
  await f.db.collection("sessions").updateOne({ _id: session.id }, [{ $set: {
    deadline_at: { $dateAdd: { startDate: "$$NOW", unit: "second", amount: 3 } },
  } }]);
}
async function waitForDeadline(f, session) {
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    if (await f.db.collection("sessions").findOne({ _id: session.id,
      $expr: { $lte: ["$deadline_at", "$$NOW"] } })) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("Mongo数据库时间未到达隔离fixture截止时间");
}
// Forward every call and result unchanged. Match only the isolated database/session.
function pauseDriverWrite(f, session, { collection, method, after, id }, reached, resume) {
  const { Collection } = require("mongoose").mongo;
  const original = Collection.prototype[method];
  const target = id ?? session.id;
  let paused = false;
  Collection.prototype[method] = async function (...args) {
    const options = args[method === "findOne" ? 1 : 2];
    const matches = this.namespace === `${f.db.databaseName}.${collection}` &&
      (args[0]._id === target || args[0].session_id === target) && options?.session;
    const stop = matches && !paused;
    if (stop) {
      paused = true;
      assert.equal(options.session.inTransaction(), true);
      if (!after) { reached.release(); await bounded(resume.promise); }
    }
    const result = await original.apply(this, args);
    if (stop && after) { reached.release(); await bounded(resume.promise); }
    return result;
  };
  return () => { Collection.prototype[method] = original; };
}

// The worker may collide on the source fence before reaching the session CAS.
function observeWorkerConflict(db, conflict) {
  return new Proxy(db, { get(target, key) {
    if (key === "collection") return (...args) => {
      const collection = target.collection(...args);
      return new Proxy(collection, { get(c, method) {
        if (["updateOne", "findOneAndUpdate"].includes(method)) return async (...input) => {
          try { return await c[method](...input); }
          catch (error) {
            if (error.code === 112 && error.hasErrorLabel?.("TransientTransactionError")) conflict.release();
            throw error;
          }
        };
        const value = Reflect.get(c, method);
        return typeof value === "function" ? value.bind(c) : value;
      } });
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

// MongoDB's legacy runtimeConstants binds the command's real $$NOW evaluator.
// This does not freeze wall time: query/update/results and production clock
// aggregates stay unchanged. Only this fixture's session commands are controlled.
function commandClock(f, now) {
  const { Timestamp } = require("mongodb");
  const { dirname, join } = require("node:path");
  const runtimeConstants = { localNow: now, clusterTime: new Timestamp({ t: 1, i: 1 }) };
  const roots = [require.resolve("mongodb"), require.resolve("mongodb", { paths: [require.resolve("mongoose")] })];
  const prototypes = new Set(roots.map(root => require(join(dirname(root), "cmap/connection.js")).Connection.prototype));
  const restores = [], writes = [];
  for (const prototype of prototypes) {
    const original = prototype.command;
    prototype.command = async function (ns, command, options, responseType) {
      const matches = ns.db === f.db.databaseName &&
        (command.find === "sessions" || command.findAndModify === "sessions");
      if (!matches) return original.call(this, ns, command, options, responseType);
      assert.equal(command.runtimeConstants, undefined);
      const result = await original.call(this, ns, { ...command, runtimeConstants }, options, responseType);
      if (command.findAndModify === "sessions") {
        assert.equal(options.session.inTransaction(), true);
        const reply = typeof result.toObject === "function" ? result.toObject() : result;
        writes.push({ id: command.query._id, matched: reply.lastErrorObject.n, value: reply.value });
      }
      return result;
    };
    restores.push(() => { prototype.command = original; });
  }
  return { writes, restore() { for (const restore of restores.reverse()) restore(); } };
}

test("阶段三：真实截止竞争及勘误评分依据", { concurrency: false, timeout: 600000 }, async (t) => {
  guardedUri(process.env.TEST_MONGODB_URI);

  for (const operation of ["save", "manual", "deadline"]) for (const offset of [-1, 0, 1]) {
    await t.test(`D00 精确命令时钟 ${operation}：数据库NOW相对deadline ${offset}ms`, async (t) => {
      const f = await assessmentFixture(t);
      const quiz = await createQuiz(f, { items: [{ question_version_id: f.questions[0].id }] });
      let session = await good(f.student, `/quizzes/${quiz.id}/sessions`, { method: "POST", body: {} });
      const item = (await good(f.student, `/sessions/${session.id}/items`)).items[0];
      const saved = await good(f.student, `/sessions/${session.id}/answers/${item.id}`, { method: "PUT", body: {
        expected_revision: session.revision, answer: { selected_option_ids: ["A"] },
      } });
      session = { ...session, revision: saved.revision };
      // Keep controlled CAS times after the persisted session/answer creation.
      // Let real database time pass the deadline for unchanged error classification.
      await nearDeadline(f, session);
      await waitForDeadline(f, session);
      const before = await f.db.collection("sessions").findOne({ _id: session.id });
      const deadline = before.deadline_at;
      const answers = await f.db.collection("answers").find({ session_id: session.id }).toArray();
      const now = new Date(deadline.getTime() + offset);
      const clock = commandClock(f, now);
      try {
        // Observe a real server-evaluated $$NOW, not merely the injected option.
        const probe = await f.db.collection("sessions").findOne({ _id: session.id }, {
          projection: { _id: 0, deadline_at: 1, observed: "$$NOW" },
        });
        assert.equal(probe.observed.getTime() - probe.deadline_at.getTime(), offset);
        const wins = operation === "deadline" ? offset >= 0 : offset < 0;
        if (operation === "deadline") {
          const { processDeadlines } = require("../dist/assessment/worker.js");
          assert.equal(await processDeadlines(f.db), wins ? 1 : 0);
        } else {
          const response = await request(f.student, operation === "save"
            ? `/sessions/${session.id}/answers/${item.id}` : `/sessions/${session.id}/submissions`, {
            method: operation === "save" ? "PUT" : "POST", body: operation === "save"
              ? { expected_revision: session.revision, answer: { selected_option_ids: ["B"] } }
              : { expected_revision: session.revision, answers: [
                { session_item_id: item.id, answer: { selected_option_ids: ["B"] } },
              ] },
          });
          if (wins) status(response, operation === "save" ? 200 : 202);
          else {
            error(response, 409);
            assert.equal(response.data.error.code, "SESSION_DEADLINE_PASSED");
          }
        }
        const writes = clock.writes.filter(write => write.id === session.id);
        if (operation === "deadline" && !wins) assert.equal(writes.length, 0);
        else {
          assert.equal(writes.length, 1, "必须经过正式路径的真实会话CAS");
          assert.equal(writes[0].matched, wins ? 1 : 0);
          if (wins) assert.equal(writes[0].value.updated_at.getTime(), now.getTime());
          else assert.equal(writes[0].value, null);
        }
        if (!wins) {
          assert.deepEqual(await f.db.collection("sessions").findOne({ _id: session.id }), before);
          assert.deepEqual(await f.db.collection("answers").find({ session_id: session.id }).toArray(), answers);
          for (const name of ["submissions", "grading_runs", "outbox_events"]) {
            assert.equal(await f.db.collection(name).countDocuments(), 0);
          }
        } else if (operation === "save") {
          const after = await f.db.collection("sessions").findOne({ _id: session.id });
          assert.equal(after.status, "in_progress");
          assert.equal(after.revision, session.revision + 1);
          const answer = await f.db.collection("answers").findOne({ session_id: session.id });
          assert.deepEqual(answer.answer, { selected_option_ids: ["B"] });
          assert.equal(answer.saved_at.getTime(), now.getTime());
        } else {
          const submission = await uniqueSubmission(f, session, operation);
          assert.equal(submission.submitted_at.getTime(), now.getTime());
          const expected = operation === "deadline" ? "A" : "B";
          assert.equal(submission.answers_hash, createHash("sha256").update(JSON.stringify([
            [item.id, { selected_option_ids: [expected] }],
          ])).digest("hex"));
        }
      } finally { clock.restore(); }
    });
  }

  await t.test("D01 截止拒绝迟到保存和最终补丁，仅保全已保存答案与未答空值", async (t) => {
    const f = await assessmentFixture(t);
    const quiz = await createQuiz(f, { items: f.questions.map((question) => ({ question_version_id: question.id })) });
    let session = await good(f.student, `/quizzes/${quiz.id}/sessions`, { method: "POST", body: {} });
    const page = await good(f.student, `/sessions/${session.id}/items`);
    const single = page.items.find((item) => item.question_type === "single");
    const numeric = page.items.find((item) => item.question_type === "numeric");
    const saved = await good(f.student, `/sessions/${session.id}/answers/${single.id}`, { method: "PUT", body: {
      expected_revision: session.revision, answer: { selected_option_ids: ["A"] },
    } });
    session = { ...session, revision: saved.revision };
    const answers = await f.db.collection("answers").find({ session_id: session.id }).toArray();
    await expire(f, session);
    const lateSave = await request(f.student, `/sessions/${session.id}/answers/${single.id}`, { method: "PUT", body: {
      expected_revision: session.revision, answer: { selected_option_ids: ["B"] },
    } });
    error(lateSave, 409);
    assert.equal(lateSave.data.error.code, "SESSION_DEADLINE_PASSED");
    const lateBody = { expected_revision: session.revision, answers: [
      { session_item_id: single.id, answer: { selected_option_ids: ["B"] } },
      { session_item_id: numeric.id, answer: { value: "2" } },
    ] };
    const lateSubmit = await request(f.student, `/sessions/${session.id}/submissions`, { method: "POST", body: lateBody });
    error(lateSubmit, 409);
    assert.equal(lateSubmit.data.error.code, "SESSION_DEADLINE_PASSED");
    const staleSubmit = await request(f.student, `/sessions/${session.id}/submissions`, { method: "POST", body: { ...lateBody, expected_revision: session.revision - 1 } });
    error(staleSubmit, 409);
    assert.equal(staleSubmit.data.error.code, "REVISION_CONFLICT");
    assert.deepEqual(await f.db.collection("answers").find({ session_id: session.id }).toArray(), answers);
    assert.equal(await f.db.collection("submissions").countDocuments({ session_id: session.id }), 0);
    assert.equal((await good(f.student, `/sessions/${session.id}`)).revision, session.revision);
    const { processDeadlines } = require("../dist/assessment/worker.js");
    assert.equal(await processDeadlines(f.db), 1);
    const submission = await uniqueSubmission(f, session, "deadline");
    const expectedHash = createHash("sha256").update(JSON.stringify(page.items.map((item) => [
      item.id, item.id === single.id ? { selected_option_ids: ["A"] } : null,
    ]))).digest("hex");
    assert.equal(submission.answers_hash, expectedHash);
    const recovered = await good(f.student, `/sessions/${session.id}/submissions`, { method: "POST", body: lateBody }, 202);
    assert.equal(recovered.submission_id, submission._id);
    assert.equal(recovered.session_status, "expired");
    assert.deepEqual(await f.db.collection("answers").find({ session_id: session.id }).toArray(), answers);
    assert.equal(await processDeadlines(f.db), 0);
    await uniqueSubmission(f, session, "deadline");
    const graded = await grade(f, submission._id);
    assert.equal(graded.total_score.toString(), "1.00");
    assert.equal(graded.max_score.toString(), "6.75");
    const run = await f.db.collection("grading_runs").findOne({ submission_id: submission._id });
    const results = await f.db.collection("grading_results").find({ grading_run_id: run._id }).toArray();
    assert.equal(results.length, 3);
    for (const result of results) assert.equal(result.score.toString(), result.session_item_id === single.id ? "1.00" : "0.00");
  });

  await t.test("D02 手动请求与多截止worker竞争，终结、事件及计次始终唯一", async (t) => {
    const f = await assessmentFixture(t, { publishedQuiz: true });
    const { processDeadlines } = require("../dist/assessment/worker.js");
    const session = await good(f.student, `/quizzes/${f.quizId}/sessions`, { method: "POST", body: {} });
    const item = (await good(f.student, `/sessions/${session.id}/items`)).items[0];
    await expire(f, session);
    const body = { expected_revision: session.revision, answers: [{ session_item_id: item.id, answer: { value: "2" } }] };
    const [responses] = await Promise.all([
      Promise.all(Array.from({ length: 10 }, () => request(f.student, `/sessions/${session.id}/submissions`, { method: "POST", body }))),
      ...Array.from({ length: 3 }, () => processDeadlines(f.db)),
    ]);
    const submission = await uniqueSubmission(f, session, "deadline");
    for (const response of responses) {
      if (response.status === 202) assert.equal(response.data.data.submission_id, submission._id);
      else error(response, 409);
    }
    assert.equal(await f.db.collection("answers").countDocuments({ session_id: session.id }), 0);
    assert.equal(await processDeadlines(f.db), 0);
    assert.equal((await grade(f, submission._id)).total_score.toString(), "0.00");
    // Cover the other order: a manual winner stays submitted when deadline workers later race retries.
    const secondQuiz = await createQuiz(f, { items: [{ question_version_id: f.questions[0].id }] });
    const manualSession = await good(f.student, `/quizzes/${secondQuiz.id}/sessions`, { method: "POST", body: {} });
    const accepted = await good(f.student, `/sessions/${manualSession.id}/submissions`, { method: "POST", body: {
      expected_revision: manualSession.revision, answers: [],
    } }, 202);
    await expire(f, manualSession);
    await Promise.all([processDeadlines(f.db), processDeadlines(f.db), ...Array.from({ length: 3 }, async () => {
      const response = await request(f.student, `/sessions/${manualSession.id}/submissions`, { method: "POST", body: {
        expected_revision: manualSession.revision, answers: [],
      } });
      status(response, 202);
      assert.equal(response.data.data.submission_id, accepted.submission_id);
    })]);
    assert.equal((await uniqueSubmission(f, manualSession, "manual"))._id, accepted.submission_id);
  });

  await t.test("D02a 十个首次手动HTTP提交同时竞争，终结及结果引用唯一", async (t) => {
    const f = await assessmentFixture(t, { publishedQuiz: true });
    const session = await good(f.student, `/quizzes/${f.quizId}/sessions`, { method: "POST", body: {} });
    const { Collection } = require("mongoose").mongo;
    const original = Collection.prototype.findOne;
    const reached = gate(), resume = gate();
    const transactions = new Set();
    // Rendezvous before authorization/source write fences serialize these requests.
    Collection.prototype.findOne = async function (...args) {
      if (this.namespace === `${f.db.databaseName}.users` &&
          args[1]?.session && transactions.size < 10) {
        assert.equal(args[1].session.inTransaction(), true);
        transactions.add(args[1].session);
        if (transactions.size === 10) reached.release();
        await bounded(resume.promise);
      }
      return original.apply(this, args);
    };
    let pending;
    try {
      pending = Promise.all(Array.from({ length: 10 }, () => request(f.student,
        `/sessions/${session.id}/submissions`, { method: "POST", body: {
          expected_revision: session.revision, answers: [],
        } }))).then(value => ({ value }), error => ({ error }));
      await bounded(reached.promise);
      assert.equal(transactions.size, 10);
      assert.equal(await f.db.collection("submissions").countDocuments({ session_id: session.id }), 0);
      resume.release();
      const outcome = await bounded(pending);
      if (outcome.error) throw outcome.error;
      const submission = await uniqueSubmission(f, session, "manual");
      for (const response of outcome.value) {
        status(response, 202);
        assert.equal(response.data.data.submission_id, submission._id);
        assert.equal(response.data.data.session_id, session.id);
        assert.equal(response.data.data.revision, session.revision + 1);
      }
      const run = await f.db.collection("grading_runs").findOne({ submission_id: submission._id });
      const event = await f.db.collection("outbox_events").findOne({ aggregate_id: submission._id, event_type: "SubmissionAccepted" });
      assert.equal(event.payload.submission_id, submission._id);
      assert.equal(event.payload.grading_run_id, run._id);
      const graded = await grade(f, submission._id);
      assert.equal(graded.effective_grading_revision, run.revision);
      const results = await f.db.collection("grading_results").find({ grading_run_id: run._id }).toArray();
      assert.equal(results.length, (await f.db.collection("session_items").countDocuments({ session_id: session.id })));
      const items = await f.db.collection("session_items").find({ session_id: session.id }).toArray();
      assert.deepEqual(results.map(row => row.session_item_id).sort(), items.map(row => row._id).sort());
    } finally {
      resume.release();
      try { if (pending) await bounded(pending); }
      finally { Collection.prototype.findOne = original; }
    }
  });

  for (const saveFirst of [true, false]) {
    await t.test(`D01a 真实事务交错：${saveFirst ? "保存先赢，截止重试保全答案" : "截止先赢，迟到保存整体回滚"}`, async (t) => {
      const f = await assessmentFixture(t);
      const quiz = await createQuiz(f, { items: [{ question_version_id: f.questions[0].id }] });
      let session = await good(f.student, `/quizzes/${quiz.id}/sessions`, { method: "POST", body: {} });
      const item = (await good(f.student, `/sessions/${session.id}/items`)).items[0];
      const saved = await good(f.student, `/sessions/${session.id}/answers/${item.id}`, { method: "PUT", body: {
        expected_revision: session.revision, answer: { selected_option_ids: ["A"] },
      } });
      session = { ...session, revision: saved.revision };
      const before = await f.db.collection("answers").find({ session_id: session.id }).toArray();
      await nearDeadline(f, session);
      const reached = gate(), resume = gate(), conflict = gate();
      // Deadline-first pauses before the request's identity touch takes the user
      // fence, so the paused transaction holds no write lock while the worker
      // wins; save-first pauses after the real session CAS has acquired the
      // winner's write lock.
      const restore = pauseDriverWrite(f, session, saveFirst
        ? { collection: "sessions", method: "findOneAndUpdate", after: true }
        : { collection: "users", method: "updateOne", after: false, id: f.student.user.user_id }, reached, resume);
      const { processDeadlines } = require("../dist/assessment/worker.js");
      let pending, worker;
      try {
        pending = request(f.student, `/sessions/${session.id}/answers/${item.id}`, { method: "PUT", body: {
          expected_revision: session.revision, answer: { selected_option_ids: ["B"] },
        } }).then(value => ({ value }), error => ({ error }));
        await bounded(reached.promise);
        await waitForDeadline(f, session);
        worker = processDeadlines(observeWorkerConflict(f.db, conflict)).then(value => ({ value }), error => ({ error }));
        if (saveFirst) await bounded(conflict.promise);
        else assert.deepEqual(await bounded(worker), { value: 1 });
        resume.release();
        const outcome = await bounded(pending);
        if (outcome.error) throw outcome.error;
        if (saveFirst) {
          status(outcome.value, 200);
          session = { ...session, revision: outcome.value.data.data.revision };
        } else error(outcome.value, 409);
        assert.deepEqual(await bounded(worker), { value: 1 });
        const submission = await uniqueSubmission(f, session, "deadline");
        const answers = await f.db.collection("answers").find({ session_id: session.id }).toArray();
        if (saveFirst) {
          assert.equal(answers.length, 1);
          assert.deepEqual(answers[0].answer, { selected_option_ids: ["B"] });
          const frozen = await f.db.collection("sessions").findOne({ _id: session.id });
          assert.ok(answers[0].saved_at < frozen.deadline_at);
        } else assert.deepEqual(answers, before);
        assert.equal(submission.answers_hash, createHash("sha256").update(JSON.stringify([
          [item.id, { selected_option_ids: [saveFirst ? "B" : "A"] }],
        ])).digest("hex"));
        assert.equal(await processDeadlines(f.db), 0);
      } finally {
        resume.release();
        try { await bounded(Promise.all([pending, worker].filter(Boolean))); }
        finally { restore(); }
      }
    });
  }

  await t.test("D01b 最终补丁已写入事务后跨越数据库截止，整笔回滚保全确认答案", async (t) => {
    const f = await assessmentFixture(t);
    const quiz = await createQuiz(f, { items: [{ question_version_id: f.questions[0].id }] });
    let session = await good(f.student, `/quizzes/${quiz.id}/sessions`, { method: "POST", body: {} });
    const item = (await good(f.student, `/sessions/${session.id}/items`)).items[0];
    const saved = await good(f.student, `/sessions/${session.id}/answers/${item.id}`, { method: "PUT", body: {
      expected_revision: session.revision, answer: { selected_option_ids: ["A"] },
    } });
    session = { ...session, revision: saved.revision };
    const before = await f.db.collection("answers").find({ session_id: session.id }).toArray();
    await nearDeadline(f, session);
    const reached = gate(), resume = gate();
    const restore = pauseDriverWrite(f, session, { collection: "answers", method: "updateOne", after: true }, reached, resume);
    let pending;
    try {
      pending = request(f.student, `/sessions/${session.id}/submissions`, { method: "POST", body: {
        expected_revision: session.revision, answers: [{ session_item_id: item.id, answer: { selected_option_ids: ["B"] } }],
      } }).then(value => ({ value }), error => ({ error }));
      await bounded(reached.promise);
      await waitForDeadline(f, session);
      resume.release();
      const outcome = await bounded(pending);
      if (outcome.error) throw outcome.error;
      error(outcome.value, 409);
      assert.equal(outcome.value.data.error.code, "SESSION_DEADLINE_PASSED");
      assert.deepEqual(await f.db.collection("answers").find({ session_id: session.id }).toArray(), before);
      const unchanged = await f.db.collection("sessions").findOne({ _id: session.id });
      assert.equal(unchanged.status, "in_progress");
      assert.equal(unchanged.revision, session.revision);
      assert.equal(unchanged.submission_id, null);
      for (const name of ["submissions", "grading_runs", "outbox_events"]) assert.equal(await f.db.collection(name).countDocuments(), 0);
      const { processDeadlines } = require("../dist/assessment/worker.js");
      assert.equal(await processDeadlines(f.db), 1);
      const submission = await uniqueSubmission(f, session, "deadline");
      assert.equal(submission.answers_hash, createHash("sha256").update(JSON.stringify([
        [item.id, { selected_option_ids: ["A"] }],
      ])).digest("hex"));
    } finally {
      resume.release();
      try { if (pending) await bounded(pending); }
      finally { restore(); }
    }
  });

  await t.test("D03 勘误须同身份同题面，重批采用新答案但保留冻结满分与历史结果", async (t) => {
    const f = await assessmentFixture(t, { publishedQuiz: true });
    const session = await good(f.student, `/quizzes/${f.quizId}/sessions`, { method: "POST", body: {} });
    const item = (await good(f.student, `/sessions/${session.id}/items`)).items[0];
    const frozen = await f.db.collection("session_items").findOne({ _id: item.id });
    const accepted = await good(f.student, `/sessions/${session.id}/submissions`, { method: "POST", body: {
      expected_revision: session.revision, answers: [{ session_item_id: item.id, answer: { value: "3" } }],
    } }, 202);
    const original = await grade(f, accepted.submission_id);
    assert.equal(original.total_score.toString(), "0.00");
    const originalRun = await f.db.collection("grading_runs").findOne({ submission_id: original._id, revision: 1 });
    const originalResults = await f.db.collection("grading_results").find({ grading_run_id: originalRun._id }).toArray();
    const numeric = { title: f.questions[2].title, question_type: "numeric", prompt: f.questions[2].prompt, options: [], answer: "3",
      scoring_rule: { version: 1, strategy: "numeric_exact_decimal", max_score: "99" } };
    const wrongIdentity = await createQuestion(f, numeric);
    const changedPrompt = await createQuestion(f, { ...numeric, source_version_id: f.questions[2].id, prompt: "不同的题面" });
    const changedType = await createQuestion(f, { source_version_id: f.questions[2].id });
    const correction = await createQuestion(f, { ...numeric, source_version_id: f.questions[2].id });
    assert.equal(correction.question_id, f.questions[2].question_id);
    assert.notEqual(wrongIdentity.question_id, f.questions[2].question_id);
    for (const invalid of [wrongIdentity, changedPrompt, changedType]) {
      const response = await request(f.reviewer, `/submissions/${original._id}/regrades`, { method: "POST", body: {
        expected_revision: original.revision, reason: "不匹配依据必须拒绝", correction_source_version_id: invalid.id,
      } });
      error(response, 422);
      assert.equal(response.data.error.code, "CORRECTION_MISMATCH");
      assert.deepEqual(await f.db.collection("submissions").findOne({ _id: original._id }), original);
      assert.equal(await f.db.collection("grading_runs").countDocuments({ submission_id: original._id }), 1);
      assert.equal(await f.db.collection("outbox_events").countDocuments({ aggregate_id: original._id, event_type: "RegradeRequested" }), 0);
    }
    await good(f.reviewer, `/submissions/${original._id}/regrades`, { method: "POST", body: {
      expected_revision: original.revision, reason: "原创答案勘误，满分不得随来源变化", correction_source_version_id: correction.id,
    } }, 202);
    const revised = await grade(f, original._id);
    assert.equal(revised.effective_grading_revision, 2);
    assert.equal(revised.total_score.toString(), "7.25");
    assert.equal(revised.max_score.toString(), "7.25");
    assert.equal(revised.answers_hash, original.answers_hash);
    assert.deepEqual(await f.db.collection("session_items").findOne({ _id: item.id }), frozen);
    assert.deepEqual(await f.db.collection("grading_results").find({ grading_run_id: originalRun._id }).toArray(), originalResults);
    const revisedRun = await f.db.collection("grading_runs").findOne({ submission_id: original._id, revision: 2 });
    assert.equal(revisedRun.corrections.length, 1);
    assert.equal(revisedRun.corrections[0].snapshot.question_version_id, correction.id);
    const result = await f.db.collection("grading_results").findOne({ grading_run_id: revisedRun._id, session_item_id: item.id });
    assert.equal(result.score.toString(), "7.25");
    assert.equal(result.max_score.toString(), "7.25");
    await f.db.collection("quizzes").updateOne({ _id: f.quizId }, [{ $set: {
      closes_at: { $dateSubtract: { startDate: "$$NOW", unit: "second", amount: 2 } },
      release_at: { $dateSubtract: { startDate: "$$NOW", unit: "second", amount: 1 } },
    } }]);
    const visible = await good(f.student, `/submissions/${original._id}`);
    assert.equal(visible.total_score, "7.25");
    assert.equal(visible.max_score, "7.25");
    const page = await good(f.student, `/submissions/${original._id}/items`);
    assert.equal(page.grading_revision, 2);
    assert.equal(page.items[0].standard_answer, "3");
    assert.equal(page.items[0].max_score, "7.25");
    assert.equal(page.items[0].score, "7.25");
  });
});
