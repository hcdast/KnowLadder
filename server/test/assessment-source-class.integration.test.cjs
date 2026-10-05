"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { error } = require("./helpers.cjs");
const { assessmentFixture, request, good, grant, quizInput, createQuiz } = require("./assessment-helpers.cjs");

const options = { concurrency: false, timeout: 240000 };

async function denied(response, statusCode, code) {
  error(response, statusCode);
  assert.equal(response.data.error.code, code);
}

async function createClass(f, actor, name) {
  return good(actor, "/teacher/classes", {
    method: "POST",
    body: { name, year_label: "2026" },
  });
}

async function addMembers(f, actor, clazz, memberIds) {
  return good(actor, `/teacher/classes/${clazz.id}/members`, {
    method: "POST",
    body: { expected_revision: clazz.revision, member_ids: memberIds },
  });
}

test("TCH-04：source_class_ids 互斥、无授课拒展开、多班并集、发布后名册冻结", options, async t => {
  const f = await assessmentFixture(t);
  assert.equal((await f.db.collection("schema_migrations").findOne({ version: 8 })).status, "completed");

  f.assigner = await f.actor(["org_admin"], ["teaching:assign"]);
  const studentA = f.student;
  const studentB = await f.actor();
  const studentC = await f.actor();

  const classA = await createClass(f, f.assigner, "展开甲班");
  const classB = await createClass(f, f.assigner, "展开乙班");
  const afterA = await addMembers(f, f.assigner, classA, [studentA.memberId, studentB.memberId]);
  await addMembers(f, f.assigner, classB, [studentB.memberId, studentC.memberId]);

  const base = quizInput(f, { audience_member_ids: undefined });
  delete base.audience_member_ids;

  await denied(await request(f.manager, "/quizzes", {
    method: "POST",
    body: { ...quizInput(f), source_class_ids: [classA.id] },
  }), 422, "VALIDATION_ERROR");

  await denied(await request(f.manager, "/quizzes", {
    method: "POST",
    body: { ...base, source_class_ids: [classA.id] },
  }), 404, "NOT_FOUND");

  await grant(f, f.manager, "teaching:assign");

  const draft = await good(f.manager, "/quizzes", {
    method: "POST",
    body: { ...base, source_class_ids: [classA.id, classB.id] },
  });
  assert.deepEqual(draft.source_class_ids, [classA.id, classB.id].sort());
  const audiences = await f.db.collection("quiz_audiences").find({ quiz_id: draft.id }).sort({ member_id: 1 }).toArray();
  assert.deepEqual(
    audiences.map(row => row.member_id),
    [studentA.memberId, studentB.memberId, studentC.memberId].sort(),
  );
  const stored = await f.db.collection("quizzes").findOne({ _id: draft.id });
  assert.deepEqual(stored.source_class_ids, [classA.id, classB.id].sort());

  await good(f.reviewer, `/quizzes/${draft.id}/publish`, {
    method: "POST",
    body: { expected_revision: draft.revision, reason: "TCH-04发布冻结受众" },
  });

  await good(f.assigner, `/teacher/classes/${classA.id}/members/remove`, {
    method: "POST",
    body: { expected_revision: afterA.class.revision, member_ids: [studentA.memberId] },
  });
  assert.equal(await f.db.collection("class_members").countDocuments({
    class_id: classA.id, member_id: studentA.memberId, status: "active",
  }), 0);

  const frozen = await f.db.collection("quiz_audiences").find({ quiz_id: draft.id }).sort({ member_id: 1 }).toArray();
  assert.deepEqual(
    frozen.map(row => row.member_id),
    [studentA.memberId, studentB.memberId, studentC.memberId].sort(),
  );

  const visible = await good(studentA, `/quizzes/${draft.id}`);
  assert.equal(visible.id, draft.id);
  assert.equal(visible.status, "published");
});

test("TCH-04：归档班不可展开；授课学科绑定；成员直传仍可用", options, async t => {
  const f = await assessmentFixture(t);
  f.assigner = await f.actor(["org_admin"], ["teaching:assign"]);
  await grant(f, f.manager, "teaching:assign");

  const clazz = await createClass(f, f.assigner, "待归档班");
  const withMembers = await addMembers(f, f.assigner, clazz, [f.student.memberId]);
  await good(f.assigner, `/teacher/classes/${clazz.id}`, {
    method: "PATCH",
    body: { expected_revision: withMembers.class.revision, status: "archived" },
  });

  const base = quizInput(f);
  delete base.audience_member_ids;
  await denied(await request(f.manager, "/quizzes", {
    method: "POST",
    body: { ...base, source_class_ids: [clazz.id] },
  }), 404, "NOT_FOUND");

  const teacher = await f.actor(["teacher"], ["assessment:manage"]);
  const active = await createClass(f, f.assigner, "学科绑定班");
  await addMembers(f, f.assigner, active, [f.student.memberId]);
  await good(f.assigner, "/teacher/assignments", {
    method: "POST",
    body: { class_id: active.id, member_id: teacher.memberId, subject_id: f.subject },
  });
  const otherSubject = randomUUID();
  await f.db.collection("subjects").insertOne({
    _id: otherSubject, code: "tch04-other", name: "其它学科", created_at: new Date(), updated_at: new Date(),
  });
  await denied(await request(teacher, "/quizzes", {
    method: "POST",
    body: { ...base, subject_id: otherSubject, source_class_ids: [active.id], items: [{ question_version_id: f.questions[2].id, max_score: "7.25" }] },
  }), 404, "NOT_FOUND");

  const expanded = await good(teacher, "/quizzes", {
    method: "POST",
    body: { ...base, source_class_ids: [active.id] },
  });
  assert.deepEqual(expanded.source_class_ids, [active.id]);

  const legacy = await createQuiz(f, {}, false);
  assert.equal(legacy.source_class_ids, undefined);
  const audience = await f.db.collection("quiz_audiences").findOne({ quiz_id: legacy.id, member_id: f.student.memberId });
  assert.ok(audience);
});
