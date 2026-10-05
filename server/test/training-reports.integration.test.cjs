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
    ...(env.KL_TRAINING_REPORTS_ENABLED === "true"
      ? ["training:report-edit", "training:report-review"]
      : []),
    "course:edit",
    "course:assign",
    "task:manage",
    "coursework:grade",
    "ai:generate",
    "ai:manage",
  ]);
  f.reviewer = await f.actor(
    ["teacher"],
    [
      "course:review",
      ...(env.KL_TRAINING_REPORTS_ENABLED === "true"
        ? ["training:report-review"]
        : []),
    ],
  );
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

test(
  "报告：v14隔离迁移、有效事实、独立审核、事实过期、并发与撤权",
  { timeout: 120000 },
  async (t) => {
    const f = await setup(t, { KL_TRAINING_REPORTS_ENABLED: "true" });
    const {
      TRAINING_REPORT_CHECKSUM,
    } = require("../dist/training/report-schema");
    const { TRAINING_CHECKSUM } = require("../dist/training/schema");
    assert.equal(
      (await f.db.collection("schema_migrations").findOne({ version: 14 }))
        .checksum,
      TRAINING_REPORT_CHECKSUM,
    );
    assert.equal(
      (await f.db.collection("schema_migrations").findOne({ version: 11 }))
        .checksum,
      TRAINING_CHECKSUM,
    );
    const payload = {
      class_id: f.classId,
      subject_id: f.subject,
      task_id: null,
      title: "班级学习报告",
      body: "证据不足，建议先完成首次练习。",
    };
    status(await f.req(f.student, "/reports", payload), 403);
    const key = randomUUID();
    let row = await f.good(f.author, "/reports", payload, key);
    assert.equal(JSON.parse(row.facts_json).learning.status, "insufficient");
    assert.equal(JSON.parse(row.facts_json).learning.roster_count, 1);
    assert.equal(
      (await f.good(f.author, "/reports", payload, key))._id,
      row._id,
    );
    assert.equal(
      (await f.good(f.author, "/receipts/query", { key })).status,
      "confirmed",
    );
    row = await f.good(f.author, "/reports/" + row._id + "/actions", {
      action: "request-review",
      expected_revision: row.revision,
    });
    status(
      await f.req(f.author, "/reports/" + row._id + "/actions", {
        action: "publish",
        expected_revision: row.revision,
        note: "自审应拒绝",
      }),
      403,
    );
    await f.db
      .collection("class_members")
      .updateOne(
        { member_id: f.student.member },
        { $set: { status: "ended" } },
      );
    const stale = await f.req(f.reviewer, "/reports/" + row._id + "/actions", {
      action: "publish",
      expected_revision: row.revision,
      note: "不得发布过期事实",
    });
    status(stale, 409);
    assert.equal(stale.data.error.code, "REPORT_FACTS_CHANGED");
    row = await f.good(f.reviewer, "/reports/" + row._id + "/actions", {
      action: "reject",
      expected_revision: row.revision,
      note: "请刷新事实",
    });
    row = await f.good(f.author, "/reports/" + row._id + "/actions", {
      action: "refresh-facts",
      expected_revision: row.revision,
    });
    assert.equal(JSON.parse(row.facts_json).learning.roster_count, 0);
    row = await f.good(f.author, "/reports/" + row._id + "/actions", {
      action: "request-review",
      expected_revision: row.revision,
    });
    const input = {
        action: "publish",
        expected_revision: row.revision,
        note: "确认来源与证据不足说明",
      },
      publishKey = randomUUID();
    const same = await Promise.all([
      f.req(f.reviewer, "/reports/" + row._id + "/actions", input, publishKey),
      f.req(f.reviewer, "/reports/" + row._id + "/actions", input, publishKey),
    ]);
    same.forEach((r) => status(r, 200));
    row = same[0].data.data;
    assert.equal(row.status, "published");
    assert.equal(
      await f.db
        .collection("training_report_versions")
        .countDocuments({ report_id: row._id }),
      1,
    );
    const version = await f.db
      .collection("training_report_versions")
      .findOne({ report_id: row._id });
    assert.equal(version.body, payload.body);
    status(
      await f.req(f.author, "/reports/" + row._id + "/actions", {
        action: "edit",
        expected_revision: row.revision,
        title: "覆盖",
        body: "不得覆盖发布版本",
      }),
      409,
    );
    status(await f.req(f.student, "/reports/" + row._id), 403);
    await f.db
      .collection("teaching_assignments")
      .updateOne(
        { member_id: f.reviewer.member },
        { $set: { status: "ended" }, $inc: { revision: 1 } },
      );
    status(await f.req(f.reviewer, "/reports/" + row._id), 404);
    status(
      await f.req(
        f.reviewer,
        "/reports/" + row._id + "/actions",
        input,
        publishKey,
      ),
      404,
    );
    status(
      await f.req(f.reviewer, "/receipts/query", { key: publishKey }),
      404,
    );
    row = await f.good(f.author, "/reports/" + row._id + "/actions", {
      action: "retire",
      expected_revision: row.revision,
    });
    assert.equal(row.status, "retired");
    assert.equal(
      (
        await f.db
          .collection("training_report_versions")
          .findOne({ _id: version._id })
      ).body,
      version.body,
    );
    await f.migrate(f.uri);
    assert.equal(
      (await f.db.collection("schema_migrations").findOne({ version: 14 }))
        .checksum,
      TRAINING_REPORT_CHECKSUM,
    );
  },
);
test(
  "报告：默认关闭，不新增v14集合或默认权限",
  { timeout: 90000 },
  async (t) => {
    const f = await setup(t);
    status(await f.req(f.author, "/reports"), 503);
    assert.equal(
      await f.db.collection("schema_migrations").findOne({ version: 14 }),
      null,
    );
    assert.equal(
      (await f.db.listCollections({ name: "training_reports" }).toArray())
        .length,
      0,
    );
  },
);

test(
  "报告：真实评分与学情投影，未发布成绩排除，有效事实更新要求重审",
  { timeout: 180000 },
  async (t) => {
    const {
      assessmentFixture,
      practice,
      good,
    } = require("./assessment-helpers.cjs");
    const f = await assessmentFixture(t, {
      env: { KL_TRAINING_ENABLED: "true", KL_TRAINING_REPORTS_ENABLED: "true" },
    });
    const teacher = await f.actor(["teacher"], ["training:report-edit"]),
      reviewer = await f.actor(["teacher"], ["training:report-review"]);
    const now = new Date(),
      classId = newId();
    await f.db
      .collection("classes")
      .insertOne({
        _id: classId,
        org_id: f.org,
        name: "有效成绩报告班",
        year_label: "2026",
        status: "active",
        revision: 1,
        created_by: teacher.user.user_id,
        created_at: now,
        updated_at: now,
      });
    for (const a of [teacher, reviewer])
      await f.db
        .collection("teaching_assignments")
        .insertOne({
          _id: newId(),
          org_id: f.org,
          class_id: classId,
          member_id: a.memberId,
          subject_id: f.subject,
          status: "active",
          revision: 1,
          valid_from: null,
          valid_to: null,
          created_at: now,
          updated_at: now,
        });
    await f.db
      .collection("class_members")
      .insertOne({
        _id: newId(),
        org_id: f.org,
        class_id: classId,
        member_id: f.student.memberId,
        kind: "student",
        status: "active",
        valid_from: null,
        valid_to: null,
        created_at: now,
        updated_at: now,
      });
    const submit = async () => {
      const s = await practice(f, {
        count: 1,
        knowledge_point_ids: [f.knowledge],
      });
      return good(
        f.student,
        "/sessions/" + s.id + "/submissions",
        {
          method: "POST",
          body: { expected_revision: s.revision, answers: [] },
        },
        202,
      );
    };
    const settle = async () => {
      for (let i = 0; i < 20; i++)
        if (!(await require("../dist/assessment/worker").processOne(f.db)))
          break;
      for (let i = 0; i < 30; i++)
        if (!(await require("../dist/learning/worker").processOne(f.db))) {
          await require("../dist/learning/worker").processDue(f.db);
          break;
        }
    };
    await submit();
    await settle();
    let report = await good(teacher, "/training/reports", {
      method: "POST",
      body: {
        class_id: classId,
        subject_id: f.subject,
        task_id: null,
        title: "真实成绩事实报告",
        body: "依据已经发布的有效成绩。",
      },
    });
    assert.equal(
      JSON.parse(report.facts_json).learning.submission_count_30d,
      1,
    );
    assert.equal(JSON.parse(report.facts_json).learning.projected_count, 1);
    const pending = await submit();
    assert.notEqual(
      (
        await f.db
          .collection("submissions")
          .findOne({ _id: pending.submission_id })
      ).grading_status,
      "completed",
    );
    report = await good(
      teacher,
      "/training/reports/" + report._id + "/actions",
      {
        method: "POST",
        body: { action: "refresh-facts", expected_revision: report.revision },
      },
    );
    assert.equal(
      JSON.parse(report.facts_json).learning.submission_count_30d,
      1,
    );
    report = await good(
      teacher,
      "/training/reports/" + report._id + "/actions",
      {
        method: "POST",
        body: { action: "request-review", expected_revision: report.revision },
      },
    );
    await settle();
    const stale = await reviewer.browser.request(
      "/training/reports/" + report._id + "/actions",
      {
        method: "POST",
        body: {
          action: "publish",
          expected_revision: report.revision,
          note: "新评分到达后不可直接发布",
        },
        headers: { "X-Org-Id": f.org, "Idempotency-Key": randomUUID() },
      },
    );
    status(stale, 409);
    assert.equal(stale.data.error.code, "REPORT_FACTS_CHANGED");
  },
);
