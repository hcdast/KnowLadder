"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { fixture, Browser, status } = require("./helpers.cjs");
const { newId } = require("../dist/database/object-id");
async function setup(t, env = {}, authorRoles = ["teacher"]) {
  const f = await fixture(t, { env: { KL_TRAINING_ENABLED: "true", ...env } });
  f.org = (
    await f.ops.createOrganization(f.context, {
      name: "职业培训隔离验收",
      kind: "school",
    })
  ).organization_id;
  const now = new Date();
  f.subject = newId();
  await f.db.collection("subjects").insertOne({
    _id: f.subject,
    code: "training-" + f.subject,
    name: "职业沟通",
    created_at: now,
    updated_at: now,
  });
  f.actor = async (roles, caps = []) => {
    const browser = new Browser(f.browser.base),
      user = await f.authenticated(browser);
    await f.ops.setMembership(f.context, {
      user_id: user.user_id,
      org_id: f.org,
      roles,
    });
    const member = await f.db
      .collection("organization_members")
      .findOne({ user_id: user.user_id, org_id: f.org });
    for (const capability of caps) {
      const m = await f.db
        .collection("organization_members")
        .findOne({ _id: member._id });
      await f.ops.setCapability(f.context, {
        org_id: f.org,
        member_id: member._id,
        capability,
        granted: true,
        expected_revision: m.authorization_revision,
        valid_to: new Date(Date.now() + 3600000),
      });
    }
    return { browser, user, member: member._id };
  };
  f.author = await f.actor(authorRoles, [
    "course:edit",
    "course:assign",
    "task:manage",
    "coursework:grade",
    "ai:generate",
    "ai:manage",
  ]);
  f.reviewer = await f.actor(["teacher"], ["course:review"]);
  f.student = await f.actor(["student"], ["ai:assist"]);
  f.stranger = await f.actor(["student"]);
  f.classId = newId();
  await f.db.collection("classes").insertOne({
    _id: f.classId,
    org_id: f.org,
    name: "培训班",
    year_label: "2026",
    status: "active",
    revision: 1,
    created_by: f.author.user.user_id,
    created_at: now,
    updated_at: now,
  });
  for (const actor of [f.author, f.reviewer])
    await f.db.collection("teaching_assignments").insertOne({
      _id: newId(),
      org_id: f.org,
      class_id: f.classId,
      member_id: actor.member,
      subject_id: f.subject,
      status: "active",
      revision: 1,
      valid_from: null,
      valid_to: null,
      created_at: now,
      updated_at: now,
    });
  await f.db.collection("class_members").insertOne({
    _id: newId(),
    org_id: f.org,
    class_id: f.classId,
    member_id: f.student.member,
    kind: "student",
    status: "active",
    valid_from: null,
    valid_to: null,
    created_at: now,
    updated_at: now,
  });
  f.req = (a, p, b, key = randomUUID()) =>
    a.browser.request("/training" + p, {
      method: b === undefined ? "GET" : "POST",
      body: b,
      headers: { "X-Org-Id": f.org, "Idempotency-Key": key },
    });
  f.good = async (a, p, b, key) => {
    const r = await f.req(a, p, b, key);
    status(r, 200);
    return r.data.data;
  };
  return f;
}
const lesson = {
  key: "lesson-1",
  title: "沟通基础",
  kind: "text",
  required: true,
  body: JSON.stringify(require("../../ops/ai-evaluation/choice-cases.json").cases.map(({question_type,prompt,options})=>({question_type,prompt,options}))),
  file_id: null,
  owner_version_id: null,
};
async function course(f, sourceBody = lesson.body) {
  let c = await f.good(f.author, "/courses", {
    code: "communication",
    title: "职业沟通",
    subject_id: f.subject,
    version_no: 1,
    lessons: [{...lesson, body: sourceBody}],
  });
  c = await f.good(f.author, "/courses/" + c._id + "/actions", {
    action: "request-review",
    expected_revision: c.revision,
  });
  c = await f.good(f.reviewer, "/courses/" + c._id + "/actions", {
    action: "publish",
    expected_revision: c.revision,
    note: "确认来源与适用范围",
  });
  await f.good(f.author, "/courses/" + c._id + "/assign", {
    class_id: f.classId,
  });
  return c;
}
module.exports={setup,course};
