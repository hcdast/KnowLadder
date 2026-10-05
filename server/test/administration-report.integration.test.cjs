"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { assessmentFixture, practice, good } = require("./assessment-helpers.cjs");
const { administrativeGrant, consoleRequest } = require("./administration-helpers.cjs");
const { status, error } = require("./helpers.cjs");
const { processOne: gradeOne } = require("../dist/assessment/worker.js");
const { processOne: learnOne, processDue } = require("../dist/learning/worker.js");

async function learningSnapshot(db) {
  const result = {};
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
    if (/^(learning_|student_projection_|mastery_|mistake_|reading_|recommendation)/.test(name)) result[name] = await db.collection(name).find().sort({ _id: 1 }).toArray();
  }
  return result;
}
for (const topology of ["replicaSet", "standalone"]) {
  test(`IAM ${topology}：平台报告只读已发布证据、不触发投影重建`, { timeout: 480000, concurrency: false }, async t => {
    const f = await assessmentFixture(t, { topology, env: { FILE_SCAN_ENABLED: "false" } });
    const platform = (await f.ops.createOrganization(f.context, { name: "IAM 报告平台", kind: "platform" })).organization_id;
    const reader = await f.actor(["platform_ops"], [], platform);
    await administrativeGrant(f, reader, "report:read", [f.org]);
    const assigner = await f.actor(["org_admin"], ["teaching:assign"]);
    const clazz = await good(assigner, "/teacher/classes", { method: "POST", body: { name: "IAM 只读报告班", year_label: "2026" } });
    await good(assigner, `/teacher/classes/${clazz.id}/members`, { method: "POST", body: { expected_revision: clazz.revision, member_ids: [f.student.memberId] } });
    const teacher = await f.actor(["teacher"]);
    await good(assigner, "/teacher/assignments", { method: "POST", body: { class_id: clazz.id, member_id: teacher.memberId, subject_id: f.subject } });
    const path = `/business/reports/classes/${clazz.id}/subjects/${f.subject}`;
    const options = { headers: { "X-Target-Org-Id": f.org } };
    const emptyBefore = await learningSnapshot(f.db);
    const empty = await consoleRequest(reader, path, options);
    status(empty, 200);
    assert.equal(empty.data.data.status, "insufficient");
    assert.equal(empty.data.data.mastery_bands, null);
    assert.deepEqual(await learningSnapshot(f.db), emptyBefore, "无投影时平台读取不得创建学生状态或排队");
    error(await consoleRequest(reader, `${path}/students/${reader.memberId}`, options), 404);
    error(await reader.browser.request(`/teacher/classes/${clazz.id}/subjects/${f.subject}/report`, { headers: { "X-Org-Id": f.org } }), 403);

    const session = await practice(f, { count: 1, knowledge_point_ids: [f.knowledge] });
    const submitted = await good(f.student, `/sessions/${session.id}/submissions`, { method: "POST", body: { expected_revision: session.revision, answers: [] } }, 202);
    for (let n = 0; n < 30; n++) {
      const submission = await f.db.collection("submissions").findOne({ _id: submitted.submission_id });
      if (submission.grading_status === "completed") break;
      assert.equal(await gradeOne(f.db), true);
    }
    for (let n = 0; n < 40; n++) {
      if (!await learnOne(f.db)) { await processDue(f.db); break; }
    }
    const self = await good(f.student, `/me/reports?subject_id=${f.subject}&period=30d`);
    assert.ok(["ready", "insufficient_evidence"].includes(self.status));
    const publishedBefore = await learningSnapshot(f.db);
    const single = await consoleRequest(reader, `${path}/students/${f.student.memberId}?period=30d`, options);
    status(single, 200);
    assert.equal(single.data.data.status, self.status);
    assert.equal(single.data.data.source_watermark, self.source_watermark);
    assert.deepEqual(single.data.data.activity, self.activity);
    assert.deepEqual(await learningSnapshot(f.db), publishedBefore, "已发布报告读取不得修改projection fence、重建标志、反馈或阅读");

    await f.db.collection("learning_projection_heads").updateOne({ org_id: f.org, member_id: f.student.memberId, subject_id: f.subject }, { $set: { rebuild_requested: true } });
    const staleBefore = await learningSnapshot(f.db);
    const stale = await consoleRequest(reader, `${path}/students/${f.student.memberId}`, options);
    status(stale, 200);
    assert.ok(["stale", "updating", "unavailable"].includes(stale.data.data.status));
    assert.equal(stale.data.data.activity, null);
    assert.deepEqual(stale.data.data.mastery, []);
    assert.deepEqual(await learningSnapshot(f.db), staleBefore, "过期报告只返回状态，不自行修复/排队/写投影");
    assert.equal(await f.db.collection("audit_events").countDocuments({ actor_id: reader.user.user_id, action: "report.student.read", target_org_id: f.org }), 2);
    const { Collection } = require("mongoose").mongo;
    const actualInsert = Collection.prototype.insertOne;
    const auditCount = await f.db.collection("audit_events").countDocuments({ actor_id: reader.user.user_id, action: "report.class.read" });
    Collection.prototype.insertOne = async function (...args) {
      if (this.namespace === `${f.db.databaseName}.audit_events` && args[0]?.action === "report.class.read")
        throw Object.assign(new Error("isolated audit write unavailable"), { code: 91 });
      return actualInsert.apply(this, args);
    };
    try {
      const denied = await consoleRequest(reader, path, options);
      error(denied, 503);
      assert.equal(denied.data.data, undefined, "审计写入不可确认时不得交付班级学情");
    } finally { Collection.prototype.insertOne = actualInsert; }
    assert.equal(await f.db.collection("audit_events").countDocuments({ actor_id: reader.user.user_id, action: "report.class.read" }), auditCount);
    assert.deepEqual(await learningSnapshot(f.db), staleBefore, "敏感审计故障不能顺带修改学生投影");
  });
}
