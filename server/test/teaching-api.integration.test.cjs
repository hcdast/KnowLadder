"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { fixture, Browser, status, error } = require("./helpers.cjs");

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

async function teachingFixture(t) {
  const f = await fixture(t);
  assert.equal((await f.db.collection("schema_migrations").findOne({ version: 8 })).status, "completed");
  const organization = await f.ops.createOrganization(f.context, { name: "教师API验收组织", kind: "school" });
  f.org = organization.organization_id;
  const now = new Date();
  f.subject = randomUUID();
  f.subjectOther = randomUUID();
  await f.db.collection("subjects").insertOne({ _id: f.subject, code: "teaching-math", name: "教师验收数学", created_at: now, updated_at: now });
  await f.db.collection("subjects").insertOne({ _id: f.subjectOther, code: "teaching-eng", name: "教师验收英语", created_at: now, updated_at: now });
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
  f.teacher = await f.actor(["teacher"]);
  f.rosterTeacher = await f.actor(["teacher"], ["teaching:roster"]);
  f.student = await f.actor(["student"]);
  f.stranger = await f.actor(["teacher"]);
  return f;
}

test("教师API：创建班级/授课、名册CAS、可见性与越权", options, async t => {
  const f = await teachingFixture(t);
  const created = await good(f.assigner, "/teacher/classes", {
    method: "POST",
    body: { name: "初一(1)班", year_label: "2026" },
  });
  assert.equal(created.name, "初一(1)班");
  assert.equal(created.status, "active");
  assert.equal(created.revision, 1);

  error(await request(f.teacher, "/teacher/classes", { method: "POST", body: { name: "越权班", year_label: "2026" } }), 403);

  const assignment = await good(f.assigner, "/teacher/assignments", {
    method: "POST",
    body: { class_id: created.id, member_id: f.teacher.memberId, subject_id: f.subject },
  });
  assert.equal(assignment.status, "active");
  assert.equal(assignment.class_id, created.id);
  assert.equal(assignment.member_id, f.teacher.memberId);

  error(await request(f.assigner, "/teacher/assignments", {
    method: "POST",
    body: { class_id: created.id, member_id: f.student.memberId, subject_id: f.subject },
  }), 422);

  const listed = await good(f.teacher, "/teacher/classes");
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].id, created.id);
  assert.deepEqual((await good(f.stranger, "/teacher/classes")).items, []);

  const add = await good(f.assigner, `/teacher/classes/${created.id}/members`, {
    method: "POST",
    body: { expected_revision: created.revision, member_ids: [f.student.memberId] },
  });
  assert.equal(add.added, 1);
  assert.equal(add.class.revision, 2);

  error(await request(f.assigner, `/teacher/classes/${created.id}/members`, {
    method: "POST",
    body: { expected_revision: created.revision, member_ids: [f.student.memberId] },
  }), 409);

  const roster = await good(f.teacher, `/teacher/classes/${created.id}/roster`);
  assert.equal(roster.items.length, 1);
  assert.equal(roster.items[0].member_id, f.student.memberId);
  assert.equal(typeof roster.items[0].display_name, "string");
  error(await request(f.stranger, `/teacher/classes/${created.id}/roster`), 404);

  await good(f.assigner, `/teacher/classes/${created.id}/members/remove`, {
    method: "POST",
    body: { expected_revision: add.class.revision, member_ids: [f.student.memberId] },
  });
  const archived = await f.db.collection("classes").findOne({ _id: created.id, org_id: f.org });
  assert.equal(archived.status, "archived");
  error(await request(f.teacher, `/teacher/classes/${created.id}/roster`), 404);
});

test("教师API：roster 教师仅限自己授课班；归档拒绝写名册", options, async t => {
  const f = await teachingFixture(t);
  const owned = await good(f.assigner, "/teacher/classes", { method: "POST", body: { name: "授课班", year_label: "2026" } });
  const foreign = await good(f.assigner, "/teacher/classes", { method: "POST", body: { name: "他班", year_label: "2026" } });
  await good(f.assigner, "/teacher/assignments", {
    method: "POST",
    body: { class_id: owned.id, member_id: f.rosterTeacher.memberId, subject_id: f.subject },
  });

  await good(f.rosterTeacher, `/teacher/classes/${owned.id}/members`, {
    method: "POST",
    body: { expected_revision: owned.revision, member_ids: [f.student.memberId] },
  });
  error(await request(f.rosterTeacher, `/teacher/classes/${foreign.id}/members`, {
    method: "POST",
    body: { expected_revision: foreign.revision, member_ids: [f.student.memberId] },
  }), 404);

  const archived = await good(f.assigner, `/teacher/classes/${owned.id}`, {
    method: "PATCH",
    body: { expected_revision: 2, status: "archived" },
  });
  assert.equal(archived.status, "archived");
  const rejected = await request(f.assigner, `/teacher/classes/${owned.id}/members`, {
    method: "POST",
    body: { expected_revision: archived.revision, member_ids: [f.student.memberId] },
  });
  status(rejected, 409);
  assert.equal(rejected.data.error.code, "CLASS_ARCHIVED");
  assert.deepEqual((await good(f.rosterTeacher, "/teacher/classes")).items, []);
});

test("教师API：班级上限200与结束授课后不可见", options, async t => {
  const f = await teachingFixture(t);
  const clazz = await good(f.assigner, "/teacher/classes", { method: "POST", body: { name: "满员班", year_label: "2026" } });
  const assignment = await good(f.assigner, "/teacher/assignments", {
    method: "POST",
    body: { class_id: clazz.id, member_id: f.teacher.memberId, subject_id: f.subject },
  });

  const now = new Date();
  const fillers = Array.from({ length: 200 }, () => ({
    _id: randomUUID(),
    org_id: f.org,
    class_id: clazz.id,
    member_id: randomUUID(),
    kind: "student",
    status: "active",
    valid_from: null,
    valid_to: null,
    created_at: now,
    updated_at: now,
  }));
  await f.db.collection("class_members").insertMany(fillers);
  await f.db.collection("classes").updateOne({ _id: clazz.id }, { $set: { revision: 2, updated_at: now } });

  const extra = await f.actor(["student"]);
  const overflow = await request(f.assigner, `/teacher/classes/${clazz.id}/members`, {
    method: "POST",
    body: { expected_revision: 2, member_ids: [extra.memberId] },
  });
  status(overflow, 422);
  assert.equal(overflow.data.error.code, "CLASS_TOO_LARGE");

  const ended = await good(f.assigner, `/teacher/assignments/${assignment.id}/end`, {
    method: "POST",
    body: { expected_revision: assignment.revision },
  });
  assert.equal(ended.status, "ended");
  assert.deepEqual((await good(f.teacher, "/teacher/classes")).items, []);
  error(await request(f.teacher, `/teacher/classes/${clazz.id}/roster`), 404);
});
