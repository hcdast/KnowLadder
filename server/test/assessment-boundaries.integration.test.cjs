"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { error, guardedUri } = require("./helpers.cjs");
const { assessmentFixture, request, good, grant, createQuestion, createQuiz, quizInput } = require("./assessment-helpers.cjs");

function denied(response, status, code) {
  error(response, status);
  assert.equal(response.data.error.code, code);
}
async function studentOnly(f, actor, capability) {
  if (capability) {
    const member = await f.db.collection("organization_members").findOne({ _id: actor.memberId });
    await f.ops.setCapability(f.context, { org_id: actor.org, member_id: actor.memberId,
      capability, granted: false, expected_revision: member.authorization_revision });
  }
  const member = await f.db.collection("organization_members").findOne({ _id: actor.memberId });
  await f.ops.setMembership(f.context, { org_id: actor.org, user_id: actor.user.user_id,
    roles: ["student"], expected_revision: member.authorization_revision });
}
async function apiProcess(f) {
  const child = fork(require.resolve("./assessment-api-child.cjs"), [], {
    env: { ...process.env, MONGODB_URI: guardedUri(f.uri) },
    stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  });
  const exited = new Promise(resolve => child.once("close", resolve));
  // Retain a listener after readiness so an IPC shutdown race cannot become an unhandled error.
  child.on("error", () => {});
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 10000);
    let exitTimer;
    try {
      if (child.connected) child.send("stop", () => {}); else child.kill("SIGKILL");
      await Promise.race([exited, new Promise((_, reject) => {
        exitTimer = setTimeout(() => reject(new Error("独立API进程未在期限内退出")), 15000);
      })]);
    } finally { clearTimeout(killTimer); clearTimeout(exitTimer); }
  };
  // Fixture closes children before dropping its isolated database.
  f.apps.push({ close: stop });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("独立API启动超时")), 30000);
    const failed = () => finish(new Error("独立API启动失败"));
    const message = value => {
      if (value?.type === "ready" && /^http:\/\/127\.0\.0\.1:\d+$/.test(value.base)) finish(null, value.base);
      else if (value?.type === "failed") failed();
    };
    function finish(err, value) {
      clearTimeout(timer);
      child.off("error", failed); child.off("exit", failed); child.off("message", message);
      if (err) reject(err); else resolve(value);
    }
    child.once("error", failed); child.once("exit", failed); child.on("message", message);
  });
  return { base, stop };
}

test("阶段三：真实HTTP组织、职责与持久计时边界", { concurrency: false, timeout: 600000 }, async t => {
  await t.test("B01 跨组织会话、考试与受众不可访问且拒绝写入", async t => {
    const f = await assessmentFixture(t, { publishedQuiz: true });
    const other = await f.ops.createOrganization(f.context, { name: "边界验收另一组织", kind: "school" });
    // The same user has valid memberships in both orgs: this isolates org scoping from ownership/authentication.
    await f.ops.setMembership(f.context, { user_id: f.student.user.user_id, org_id: other.organization_id, roles: ["student"] });
    const member = await f.db.collection("organization_members").findOne({ org_id: other.organization_id, user_id: f.student.user.user_id });
    const foreign = { ...f.student, org: other.organization_id, memberId: member._id };
    const session = await good(f.student, `/quizzes/${f.quizId}/sessions`, { method: "POST", body: {} });
    const item = (await good(f.student, `/sessions/${session.id}/items`)).items[0];
    for (const path of [`/sessions/${session.id}`, `/sessions/${session.id}/items`, `/quizzes/${f.quizId}`])
      denied(await request(foreign, path), 404, "NOT_FOUND");
    denied(await request(foreign, `/quizzes/${f.quizId}/sessions`, { method: "POST", body: {} }), 404, "NOT_FOUND");
    denied(await request(foreign, `/sessions/${session.id}/answers/${item.id}`, { method: "PUT", body: {
      expected_revision: session.revision, answer: { value: "2" },
    } }), 404, "NOT_FOUND");
    denied(await request(foreign, `/sessions/${session.id}/submissions`, { method: "POST", body: {
      expected_revision: session.revision, answers: [],
    } }), 404, "NOT_FOUND");
    assert.deepEqual((await good(foreign, "/me/sessions")).items, []);
    assert.deepEqual((await good(foreign, "/quizzes")).items, []);
    const before = await f.db.collection("quizzes").countDocuments({ org_id: f.org });
    denied(await request(f.manager, "/quizzes", { method: "POST", body: quizInput(f, {
      audience_member_ids: [foreign.memberId],
    }) }), 422, "PARTICIPANT_INVALID");
    assert.equal(await f.db.collection("quizzes").countDocuments({ org_id: f.org }), before);
    assert.equal(await f.db.collection("answers").countDocuments({ session_id: session.id }), 0);
    assert.equal(await f.db.collection("submissions").countDocuments({ session_id: session.id }), 0);
    assert.equal((await good(f.student, `/sessions/${session.id}`)).revision, session.revision);
  });

  await t.test("B02 四类content/assessment双职责不得选为受众或继续正式考试", async t => {
    const f = await assessmentFixture(t);
    for (const capability of ["content:edit", "content:review", "assessment:manage", "assessment:review"]) {
      const actor = await f.actor();
      const question = await createQuestion(f, { title: `双职责隔离 ${capability}`, question_type: "numeric", options: [], answer: "2",
        scoring_rule: { version: 1, strategy: "numeric_exact_decimal", max_score: "1" } });
      const quiz = await createQuiz(f, { audience_member_ids: [actor.memberId], items: [{ question_version_id: question.id, max_score: "1" }] });
      const session = await good(actor, `/quizzes/${quiz.id}/sessions`, { method: "POST", body: {} });
      const item = (await good(actor, `/sessions/${session.id}/items`)).items[0];
      if (capability.startsWith("content:")) {
        const member = await f.db.collection("organization_members").findOne({ _id: actor.memberId });
        await f.ops.setMembership(f.context, { org_id: actor.org, user_id: actor.user.user_id,
          roles: ["student", capability === "content:edit" ? "content_editor" : "content_reviewer"],
          expected_revision: member.authorization_revision });
      } else await grant(f, actor, capability);
      assert.ok(!(await good(f.manager, "/admin/assessment-members")).items.some(row => row.id === actor.memberId));
      denied(await request(f.manager, "/quizzes", { method: "POST", body: quizInput(f, {
        audience_member_ids: [actor.memberId],
      }) }), 422, "PARTICIPANT_INVALID");
      for (const path of [`/quizzes/${quiz.id}`, `/sessions/${session.id}/items`])
        denied(await request(actor, path), 422, "PARTICIPANT_INVALID");
      denied(await request(actor, `/quizzes/${quiz.id}/sessions`, { method: "POST", body: {} }), 422, "PARTICIPANT_INVALID");
      denied(await request(actor, `/sessions/${session.id}/answers/${item.id}`, { method: "PUT", body: {
        expected_revision: session.revision, answer: { value: "2" },
      } }), 422, "PARTICIPANT_INVALID");
      denied(await request(actor, `/sessions/${session.id}/submissions`, { method: "POST", body: {
        expected_revision: session.revision, answers: [],
      } }), 422, "PARTICIPANT_INVALID");
      assert.equal(await f.db.collection("answers").countDocuments({ session_id: session.id }), 0);
      assert.equal(await f.db.collection("submissions").countDocuments({ session_id: session.id }), 0);
      assert.equal((await f.db.collection("attempt_counters").findOne({ quiz_id: quiz.id, member_id: actor.memberId })).allocated, 1);
    }
  });

  await t.test("B03 题目作者、独立贡献者与审核人转为纯学生仍有历史冲突", async t => {
    const f = await assessmentFixture(t);
    const contributor = await f.actor(["content_editor"]);
    const draft = await good(f.editor, "/admin/question-versions", { method: "POST", body: {
      title: "历史职责题", subject_id: f.subject, question_type: "numeric", prompt: "一加一", options: [], answer: "2",
      explanation: "原创解析", knowledge_point_ids: [f.knowledge], knowledge_weights: [{ knowledge_point_id: f.knowledge, weight_bps: 10000 }],
      difficulty: "基础", difficulty_basis: "整数运算", scoring_rule: { version: 1, strategy: "numeric_exact_decimal", max_score: "1" },
      license: { source: "阶段三原创隔离材料", granted: true, expires_at: null },
    } });
    const edited = await good(contributor, `/admin/question-versions/${draft.id}`, { method: "PATCH", body: {
      expected_revision: draft.revision, explanation: "独立贡献者补充原创解析",
    } });
    await good(f.editor, `/admin/question-versions/${draft.id}/submit-review`, { method: "POST", body: { expected_revision: edited.revision } });
    const pending = await good(f.contentReviewer, `/admin/question-versions/${draft.id}`);
    await good(f.contentReviewer, `/admin/question-versions/${draft.id}/publish`, { method: "POST", body: { expected_revision: pending.revision } });
    const published = await good(f.editor, `/admin/question-versions/${draft.id}`);
    assert.equal(published.created_by, f.editor.user.user_id);
    assert.ok(published.contributors.includes(contributor.user.user_id));
    assert.notEqual(published.created_by, contributor.user.user_id);
    assert.equal(published.published_by, f.contentReviewer.user.user_id);
    for (const actor of [f.editor, contributor, f.contentReviewer]) await studentOnly(f, actor);
    const candidates = await good(f.manager, "/admin/assessment-members");
    for (const actor of [f.editor, contributor, f.contentReviewer]) {
      assert.ok(candidates.items.some(row => row.id === actor.memberId), "一般受众资格已恢复，拒绝须来自历史职责");
      denied(await request(f.manager, "/quizzes", { method: "POST", body: quizInput(f, {
        items: [{ question_version_id: draft.id, max_score: "1" }], audience_member_ids: [actor.memberId],
      }) }), 422, "PARTICIPANT_CONFLICT");
    }
    const quiz = await createQuiz(f, { items: [{ question_version_id: draft.id, max_score: "1" }] });
    await studentOnly(f, f.manager, "assessment:manage");
    await studentOnly(f, f.reviewer, "assessment:review");
    // HTTP correctly prevents conflicted audiences. Only seed audience membership in
    // the isolated fixture to independently test the start-time historical guard.
    for (const actor of [f.editor, contributor, f.contentReviewer, f.manager, f.reviewer]) {
      const now = new Date();
      await f.db.collection("quiz_audiences").insertOne({ _id: randomUUID(), org_id: f.org, quiz_id: quiz.id,
        member_id: actor.memberId, created_at: now, updated_at: now });
      denied(await request(actor, `/quizzes/${quiz.id}/sessions`, { method: "POST", body: {} }), 422, "PARTICIPANT_CONFLICT");
      assert.equal(await f.db.collection("attempt_counters").countDocuments({ quiz_id: quiz.id, member_id: actor.memberId }), 0);
    }
    assert.equal(await f.db.collection("sessions").countDocuments({ quiz_id: quiz.id }), 0);
  });

  await t.test("B04 独立API进程重启保留权威计时与答案，客户端不能覆盖deadline", async t => {
    const f = await assessmentFixture(t, { publishedQuiz: true });
    const first = await apiProcess(f);
    let actor = { ...f.student, browser: f.student.browser.clone(first.base) };
    const path = `/quizzes/${f.quizId}/sessions`;
    const forged = new Date(Date.now() + 86400000).toISOString();
    denied(await request(actor, path, { method: "POST", body: { deadline_at: forged } }), 422, "VALIDATION_ERROR");
    assert.equal(await f.db.collection("attempt_counters").countDocuments({ quiz_id: f.quizId }), 0);
    const key = randomUUID();
    const session = await good(actor, path, { method: "POST", body: {}, key });
    const item = (await good(actor, `/sessions/${session.id}/items`)).items[0];
    const saved = await good(actor, `/sessions/${session.id}/answers/${item.id}`, { method: "PUT", body: {
      expected_revision: session.revision, answer: { value: "2" },
    } });
    const persisted = await f.db.collection("sessions").findOne({ _id: session.id });
    const answer = await f.db.collection("answers").findOne({ session_id: session.id });
    await first.stop();
    const second = await apiProcess(f);
    actor = { ...actor, browser: actor.browser.clone(second.base) };
    const resumed = await good(actor, `/sessions/${session.id}`);
    assert.equal(resumed.started_at, session.started_at);
    assert.equal(resumed.deadline_at, session.deadline_at);
    assert.equal(resumed.revision, saved.revision);
    assert.deepEqual((await good(actor, `/sessions/${session.id}/items`)).items[0].answer, { value: "2" });
    assert.deepEqual(await good(actor, path, { method: "POST", body: {}, key }), session);
    denied(await request(actor, `/sessions/${session.id}/answers/${item.id}`, { method: "PUT", body: {
      expected_revision: saved.revision, answer: { value: "999" }, deadline_at: forged,
    } }), 422, "VALIDATION_ERROR");
    denied(await request(actor, `/sessions/${session.id}/submissions`, { method: "POST", body: {
      expected_revision: saved.revision, answers: [], deadline_at: forged,
    } }), 422, "VALIDATION_ERROR");
    assert.deepEqual(await f.db.collection("sessions").findOne({ _id: session.id }), persisted);
    assert.deepEqual(await f.db.collection("answers").findOne({ session_id: session.id }), answer);
    assert.equal(await f.db.collection("sessions").countDocuments({ quiz_id: f.quizId }), 1);
    assert.equal((await f.db.collection("attempt_counters").findOne({ quiz_id: f.quizId, member_id: actor.memberId })).allocated, 1);
    await second.stop();
  });
});
