"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { assessmentFixture, practice, good } = require("./assessment-helpers.cjs");
const { executeAdministrationOperation, recoverAdministrationOperation } = require("../dist/administration/operations.js");
const { processOne: gradeOne } = require("../dist/assessment/worker.js");

test("IAM standalone：待恢复主体不评分、不消耗失败次数，人工解除后恢复消费", { timeout: 360000, concurrency: false }, async t => {
  const f = await assessmentFixture(t, { topology: "standalone", env: { FILE_SCAN_ENABLED: "false" } });
  const session = await practice(f, { count: 1, knowledge_point_ids: [f.knowledge] });
  const accepted = await good(f.student, `/sessions/${session.id}/submissions`, { method: "POST", body: { expected_revision: session.revision, answers: [] } }, 202);
  const submissionId = accepted.submission_id, operation_id = randomUUID();
  await assert.rejects(executeAdministrationOperation({
    client: f.client, db: f.db, operation_id, actor: "iam-worker-fault", reason: "合成主体管理中断", action: "iam.verify.identity",
    targets: { user_ids: [f.student.user.user_id] }, payload: { user_id: f.student.user.user_id },
    apply: async ({ session }) => {
      await f.db.collection("users").updateOne({ _id: f.student.user.user_id }, { $inc: { identity_revision: 1 } }, { session });
      throw new Error("IAM_INJECTED_TARGET_WRITE");
    },
  }));
  const before = await f.db.collection("submissions").findOne({ _id: submissionId });
  const eventsBefore = await f.db.collection("outbox_events").find({ "payload.submission_id": submissionId }).sort({ _id: 1 }).toArray();
  assert.equal(await gradeOne(f.db), false);
  assert.deepEqual(await f.db.collection("submissions").findOne({ _id: submissionId }), before);
  assert.deepEqual(await f.db.collection("outbox_events").find({ "payload.submission_id": submissionId }).sort({ _id: 1 }).toArray(), eventsBefore, "隔离等待不得耗尽评分attempt或将事件失败");
  await recoverAdministrationOperation({ client: f.client, db: f.db, operation_id, actor: "iam-worker-recovery", reason: "人工核对仅身份fence变更",
    revalidate: async op => { assert.equal(op.targets.user_ids[0], f.student.user.user_id); },
    finish: async (_op, session) => {
      const current = await f.db.collection("users").findOne({ _id: f.student.user.user_id }, { session });
      assert.equal(current.status, "active");
      assert.equal(current.privacy_state, "active");
    },
    verify: async (_op, session) => { assert.equal((await f.db.collection("users").findOne({ _id: f.student.user.user_id }, { session })).status, "active"); },
  });
  assert.equal(await gradeOne(f.db), true);
  assert.equal((await f.db.collection("submissions").findOne({ _id: submissionId })).grading_status, "completed");
});
