"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { fixture, Browser, status, error } = require("./helpers.cjs");
const { assessmentFixture, practice, good: assessmentGood, createQuestion } = require("./assessment-helpers.cjs");
const { processOne: gradeOne } = require("../dist/assessment/worker.js");
const { processOne: learnOne, processDue } = require("../dist/learning/worker.js");

const options = { concurrency: false, timeout: 180000 };

function request(actor, path, { method = "GET", body, key = randomUUID(), headers = {} } = {}) {
  return actor.browser.request(path, {
    method,
    body,
    headers: {
      "X-Org-Id": actor.org,
      ...(method === "GET" ? {} : { "Idempotency-Key": key }),
      ...headers,
    },
  });
}

async function good(actor, path, opts, expected = 200) {
  const response = await request(actor, path, opts);
  status(response, expected);
  assert.equal(typeof response.data.request_id, "string");
  return response.data.data;
}

async function grant(f, actor, capability) {
  const member = await f.db.collection("organization_members").findOne({ _id: actor.memberId });
  await f.ops.setCapability(f.context, {
    org_id: actor.org,
    member_id: actor.memberId,
    capability,
    granted: true,
    valid_to: new Date(Date.now() + 3600000),
    expected_revision: member.authorization_revision,
  });
}

async function teachingReportFixture(t) {
  const f = await fixture(t);
  assert.equal((await f.db.collection("schema_migrations").findOne({ version: 8 })).status, "completed");
  const organization = await f.ops.createOrganization(f.context, { name: "教师报告验收组织", kind: "school" });
  f.org = organization.organization_id;
  const now = new Date();
  f.subject = randomUUID();
  f.subjectOther = randomUUID();
  await f.db.collection("subjects").insertOne({ _id: f.subject, code: "report-math", name: "报告验收数学", created_at: now, updated_at: now });
  await f.db.collection("subjects").insertOne({ _id: f.subjectOther, code: "report-eng", name: "报告验收英语", created_at: now, updated_at: now });
  f.actor = async (roles = ["student"], capabilities = [], org = f.org) => {
    const browser = new Browser(f.browser.base);
    const user = await f.authenticated(browser);
    await f.ops.setMembership(f.context, { user_id: user.user_id, org_id: org, roles });
    const member = await f.db.collection("organization_members").findOne({ org_id: org, user_id: user.user_id });
    const actor = { browser, user, org, memberId: member._id };
    for (const capability of capabilities) await grant(f, actor, capability);
    return actor;
  };
  f.assigner = await f.actor(["org_admin"], ["teaching:assign"]);
  f.teacher = await f.actor(["teacher"], ["teaching:report"]);
  f.bareTeacher = await f.actor(["teacher"]);
  f.student = await f.actor(["student"]);
  f.otherStudent = await f.actor(["student"]);
  f.stranger = await f.actor(["teacher"], ["teaching:report"]);
  return f;
}

async function grade(f, key) {
  for (let n = 0; n < 30; n++) {
    const row = await f.db.collection("submissions").findOne({ _id: key });
    if (row.grading_status === "completed") return row;
    assert.equal(await gradeOne(f.db), true);
  }
  assert.fail("真实评分未完成");
}

async function project(f) {
  for (let n = 0; n < 40; n++) {
    if (!await learnOne(f.db)) {
      await processDue(f.db);
      return;
    }
  }
  assert.fail("真实学情worker未收敛");
}

test("教师报告：无报告能力/无授课/跨班/跨科/非名册拒读", options, async t => {
  const f = await teachingReportFixture(t);
  const owned = await good(f.assigner, "/teacher/classes", { method: "POST", body: { name: "报告班A", year_label: "2026" } });
  const other = await good(f.assigner, "/teacher/classes", { method: "POST", body: { name: "报告班B", year_label: "2026" } });
  await good(f.assigner, "/teacher/assignments", {
    method: "POST",
    body: { class_id: owned.id, member_id: f.teacher.memberId, subject_id: f.subject },
  });
  await good(f.assigner, "/teacher/assignments", {
    method: "POST",
    body: { class_id: other.id, member_id: f.stranger.memberId, subject_id: f.subject },
  });
  await good(f.assigner, `/teacher/classes/${owned.id}/members`, {
    method: "POST",
    body: { expected_revision: owned.revision, member_ids: [f.student.memberId] },
  });

  const classPath = `/teacher/classes/${owned.id}/subjects/${f.subject}/report`;
  const studentPath = `/teacher/classes/${owned.id}/subjects/${f.subject}/students/${f.student.memberId}/report`;

  error(await request(f.bareTeacher, classPath), 403);
  error(await request(f.bareTeacher, studentPath), 403);
  error(await request(f.stranger, classPath), 404);
  error(await request(f.stranger, studentPath), 404);
  error(await request(f.teacher, `/teacher/classes/${other.id}/subjects/${f.subject}/report`), 404);
  error(await request(f.teacher, `/teacher/classes/${owned.id}/subjects/${f.subjectOther}/report`), 404);
  error(await request(f.teacher, `/teacher/classes/${owned.id}/subjects/${f.subjectOther}/students/${f.student.memberId}/report`), 404);
  error(await request(f.teacher, `/teacher/classes/${owned.id}/subjects/${f.subject}/students/${f.otherStudent.memberId}/report`), 404);

  const aggregate = await good(f.teacher, classPath);
  assert.equal(aggregate.status, "insufficient");
  assert.equal(aggregate.roster_count, 1);
  assert.equal(aggregate.projected_count, 0);
  assert.deepEqual(aggregate.mastery_bands, {
    insufficient_evidence: 0,
    weak: 0,
    developing: 0,
    mastered: 0,
  });
  assert.deepEqual(aggregate.weak_knowledge_points, []);

  const single = await good(f.teacher, studentPath);
  assert.equal(single.member_id, f.student.memberId);
  assert.equal(single.subject_id, f.subject);
  assert.equal(single.class_id, owned.id);
  assert.ok(["insufficient_evidence", "updating", "unavailable", "ready"].includes(single.status));
  assert.equal(single.activity, null);
  assert.deepEqual(single.mastery, []);
});

test("教师报告：单生字段⊆学生released；聚合可读投影", options, async t => {
  const f = await assessmentFixture(t);
  assert.equal((await f.db.collection("schema_migrations").findOne({ version: 8 })).status, "completed");
  const assigner = await f.actor(["org_admin"], ["teaching:assign"]);
  const teacher = await f.actor(["teacher"], ["teaching:report"]);
  const subjectOther = randomUUID();
  const now = new Date();
  await f.db.collection("subjects").insertOne({ _id: subjectOther, code: "report-other", name: "报告跨科", created_at: now, updated_at: now });

  const clazz = await assessmentGood(assigner, "/teacher/classes", { method: "POST", body: { name: "学情报告班", year_label: "2026" } });
  await assessmentGood(assigner, "/teacher/assignments", {
    method: "POST",
    body: { class_id: clazz.id, member_id: teacher.memberId, subject_id: f.subject },
  });
  await assessmentGood(assigner, `/teacher/classes/${clazz.id}/members`, {
    method: "POST",
    body: { expected_revision: clazz.revision, member_ids: [f.student.memberId] },
  });

  for (let i = 0; i < 3; i++) f.questions.push(await createQuestion(f));
  for (let i = 0; i < 5; i++) {
    const session = await practice(f, { count: 1, knowledge_point_ids: [f.knowledge] });
    const receipt = await assessmentGood(f.student, `/sessions/${session.id}/submissions`, {
      method: "POST",
      body: { expected_revision: session.revision, answers: [] },
    }, 202);
    await grade(f, receipt.submission_id);
  }
  await project(f);

  const studentSelf = await assessmentGood(f.student, `/me/reports?subject_id=${f.subject}&period=30d`);
  assert.ok(studentSelf.status === "ready" || studentSelf.status === "insufficient_evidence");

  const teacherView = await assessmentGood(
    teacher,
    `/teacher/classes/${clazz.id}/subjects/${f.subject}/students/${f.student.memberId}/report?period=30d`,
  );
  assert.equal(teacherView.member_id, f.student.memberId);
  assert.equal(teacherView.subject_id, f.subject);
  assert.equal(teacherView.status, studentSelf.status);
  assert.equal(teacherView.source_watermark, studentSelf.source_watermark);
  assert.equal(teacherView.generated_at, studentSelf.generated_at);
  assert.deepEqual(teacherView.activity, studentSelf.activity);
  assert.deepEqual(
    teacherView.mastery.map(row => ({
      knowledge_point_id: row.knowledge_point_id,
      independent_question_count: row.independent_question_count,
      numerator: row.numerator,
      denominator: row.denominator,
      mastery: row.mastery,
      status: row.status,
      last_evidence_at: row.last_evidence_at,
    })),
    studentSelf.mastery.map(row => ({
      knowledge_point_id: row.knowledge_point_id,
      independent_question_count: row.independent_question_count,
      numerator: row.numerator,
      denominator: row.denominator,
      mastery: row.mastery,
      status: row.status,
      last_evidence_at: row.last_evidence_at,
    })),
  );
  const leaked = JSON.stringify(teacherView);
  for (const key of ["projection_revision", "manifest_digest", "eligibility_revision", "semantic_digest"]) {
    assert.ok(!leaked.includes(key), key);
  }

  error(await request(teacher, `/teacher/classes/${clazz.id}/subjects/${subjectOther}/students/${f.student.memberId}/report`), 404);

  const aggregate = await assessmentGood(teacher, `/teacher/classes/${clazz.id}/subjects/${f.subject}/report`);
  assert.equal(aggregate.roster_count, 1);
  assert.equal(aggregate.projected_count, 1);
  assert.equal(aggregate.status, "ready");
  assert.ok(aggregate.submission_count_30d >= 1);
});
