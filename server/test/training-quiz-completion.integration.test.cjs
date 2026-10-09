"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { newId } = require("../dist/database/object-id");
const {
  assessmentFixture,
  good,
  quizInput,
} = require("./assessment-helpers.cjs");
const { status } = require("./helpers.cjs");
for (const topology of ["replicaSet"])
  test("测验任务完成统计 " + topology, { timeout: 240000 }, async (t) => {
    const f = await assessmentFixture(t, {
        topology,
        env: {
          KL_TRAINING_ENABLED: "true",
          KL_TRAINING_PHASE2_ENABLED: "true",
          KL_TRAINING_REPORTS_ENABLED: "true",
        },
      }),
      caps = require("../dist/training/phase2-schema").PHASE2_CAPABILITIES;
    const teacher = await f.actor(
        ["teacher"],
        [
          ...caps,
          "course:edit",
          "course:assign",
          "task:manage",
          "assessment:manage",
          "training:report-edit",
        ],
      ),
      reviewer = await f.actor(["teacher"], [...caps, "course:review"]),
      classId = newId(),
      now = new Date();
    await f.db.collection("classes").insertOne({
      _id: classId,
      org_id: f.org,
      name: "测验结业班",
      year_label: "2026",
      status: "active",
      revision: 1,
      created_by: teacher.user.user_id,
      created_at: now,
      updated_at: now,
    });
    for (const a of [teacher, reviewer])
      await f.db.collection("teaching_assignments").insertOne({
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
    await f.db.collection("class_members").insertOne({
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
    const training = (a, p, b) =>
      good(
        a,
        "/training" + p,
        b === undefined ? undefined : { method: "POST", body: b },
      );

    const input = quizInput(f, { max_attempts: 3 });
    delete input.audience_member_ids;
    input.source_class_ids = [classId];
    const quiz = await good(teacher, "/quizzes", {
      method: "POST",
      body: input,
    });
    await good(f.reviewer, "/quizzes/" + quiz.id + "/publish", {
      method: "POST",
      body: {
        expected_revision: quiz.revision,
        reason: "独立发布原创测验统计",
      },
    });
    let task = await training(teacher, "/tasks", {
      class_id: classId,
      subject_id: f.subject,
      title: "原创提交完成统计",
      target_type: "quiz",
      target_id: quiz.id,
      due_at: new Date(Date.now() + 86400000).toISOString(),
      body: "原创说明",
      rubric: [],
    });
    task = await training(teacher, "/tasks/" + task._id + "/actions", {
      action: "publish",
      expected_revision: task.revision,
    });
    const report = () =>
      training(teacher, "/reports", {
        class_id: classId,
        subject_id: f.subject,
        task_id: task._id,
        title: "原创测验完成报告",
        body: "提交完成与掌握程度分开",
      });
    const count = (row) => JSON.parse(row.facts_json).training.completion_count;
    const empty = await report();
    assert.equal(count(empty), 0);
    const accept = async () => {
      const s = await good(f.student, "/quizzes/" + quiz.id + "/sessions", {
        method: "POST",
        body: {},
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
    const first = await accept();
    const pending = await report();
    assert.equal(count(pending), 1);
    assert.notEqual(pending.source_watermark, empty.source_watermark);
    const rejected = await teacher.browser.request(
      "/training/reports/" + empty._id + "/actions",
      {
        method: "POST",
        headers: {
          "X-Org-Id": f.org,
          "Idempotency-Key": require("node:crypto").randomUUID(),
        },
        body: { action: "request-review", expected_revision: empty.revision },
      },
    );
    status(rejected, 409);
    assert.equal(rejected.data.error.code, "REPORT_FACTS_CHANGED");
    await f.db.collection("submissions").updateOne(
      { _id: first.submission_id },
      {
        $set: {
          grading_status: "failed",
          error_code: "ORIGINAL_SYNTHETIC_FAILURE",
        },
      },
    );
    assert.equal(count(await report()), 1);
    await accept();
    assert.equal(count(await report()), 1);
    const overdue = await good(f.student, "/quizzes/" + quiz.id + "/sessions", {
      method: "POST",
      body: {},
    });
    await f.db
      .collection("sessions")
      .updateOne(
        { _id: overdue.id },
        { $set: { deadline_at: new Date(Date.now() - 1000) } },
      );
    assert.equal(
      await require("../dist/assessment/worker").processDeadlines(f.db),
      1,
    );
    const automatic = await f.db
      .collection("submissions")
      .findOne({ session_id: overdue.id });
    assert.equal(automatic.reason, "deadline");
    assert.equal(count(await report()), 1);
    const { quizTaskCompletion } = require("../dist/training/quiz-completion");
    const session = f.client.startSession();
    const {
      beginSessionWork,
      abortSessionWork,
    } = require("../dist/database/txn");
    const mode = await beginSessionWork(session, f.db);
    try {
      const ctx = {
        orgId: f.org,
        userId: teacher.user.user_id,
        memberId: teacher.memberId,
        capabilities: ["training:report-edit"],
        session,
        requestId: "original-synthetic-completion",
      };
      assert.equal(
        (
          await quizTaskCompletion(
            f.db,
            ctx,
            quiz.id,
            f.subject,
            [],
            new Date(),
          )
        ).count,
        0,
      );
      await assert.rejects(
        quizTaskCompletion(
          f.db,
          { ...ctx, orgId: newId() },
          quiz.id,
          f.subject,
          [f.student.memberId],
          new Date(),
        ),
      );
      const counted = () =>
        quizTaskCompletion(
          f.db,
          ctx,
          quiz.id,
          f.subject,
          [f.student.memberId],
          new Date(),
        );
      await f.db
        .collection("users")
        .updateOne(
          { _id: f.student.user.user_id },
          { $set: { status: "disabled" } },
          { session },
        );
      assert.equal((await counted()).count, 0);
      await f.db
        .collection("users")
        .updateOne(
          { _id: f.student.user.user_id },
          { $set: { status: "active" } },
          { session },
        );
      assert.equal((await counted()).count, 1);
      await f.db
        .collection("quiz_audiences")
        .deleteMany({ quiz_id: quiz.id, org_id: f.org }, { session });
      assert.equal((await counted()).count, 0);
    } finally {
      await abortSessionWork(session, mode);
      await session.endSession();
    }
    // Each malformed-evidence scenario is a real database mutation in a transaction,
    // rolled back afterwards; unrelated accepted attempts cannot mask an error.
    async function boundary(name, mutate, expected) {
      await t.test(name, async () => {
        const isolated = f.client.startSession();
        const work = await beginSessionWork(isolated, f.db);
        try {
          const ctx = {
            orgId: f.org,
            userId: teacher.user.user_id,
            memberId: teacher.memberId,
            capabilities: ["training:report-edit"],
            session: isolated,
            requestId: "original-boundary",
          };
          await mutate(isolated);
          const read = () =>
            quizTaskCompletion(
              f.db,
              ctx,
              quiz.id,
              f.subject,
              [f.student.memberId],
              new Date(),
            );
          if (typeof expected === "number")
            assert.equal((await read()).count, expected);
          else
            await assert.rejects(
              read(),
              (error) => error.getResponse?.().code === expected,
            );
        } finally {
          await abortSessionWork(isolated, work);
          await isolated.endSession();
        }
      });
    }
    await boundary(
      "其他测验会话不计",
      (s) =>
        f.db
          .collection("sessions")
          .updateMany(
            { quiz_id: quiz.id },
            { $set: { quiz_id: newId() } },
            { session: s },
          ),
      0,
    );
    await boundary(
      "错误冻结试卷不计",
      (s) =>
        f.db
          .collection("sessions")
          .updateMany(
            { quiz_id: quiz.id },
            { $set: { paper_id: newId() } },
            { session: s },
          ),
      0,
    );
    await boundary(
      "已提交缺少真实提交记录必须报错",
      (s) =>
        f.db
          .collection("submissions")
          .deleteOne({ _id: first.submission_id }, { session: s }),
      "INVALID_STUDENT_EVIDENCE",
    );
    await boundary(
      "提交与会话时间不一致必须报错",
      (s) =>
        f.db
          .collection("submissions")
          .updateOne(
            { _id: first.submission_id },
            { $set: { submitted_at: new Date(0) } },
            { session: s },
          ),
      "INVALID_STUDENT_EVIDENCE",
    );
    await boundary(
      "题项缺失必须报错",
      (s) =>
        f.db
          .collection("session_items")
          .deleteMany({ session_id: first.session_id }, { session: s }),
      "INVALID_STUDENT_EVIDENCE",
    );
    await boundary(
      "题项身份与当前题版本不一致必须报错",
      (s) =>
        f.db
          .collection("session_items")
          .updateMany(
            { session_id: first.session_id },
            { $set: { "snapshot.question_id": newId() } },
            { session: s },
          ),
      "INVALID_STUDENT_EVIDENCE",
    );
    await boundary(
      "超过600个匹配会话必须明确拒绝",
      async (s) => {
        const original = await f.db
          .collection("sessions")
          .findOne({ _id: first.session_id }, { session: s });
        await f.db.collection("sessions").insertMany(
          Array.from({ length: 601 }, () => ({
            ...original,
            _id: newId(),
            submission_id: newId(),
          })),
          { session: s },
        );
        assert.ok(
          (await f.db
            .collection("sessions")
            .countDocuments({ quiz_id: quiz.id }, { session: s })) > 600,
        );
      },
      "REPORT_FACTS_CAPACITY",
    );
    const reviewCandidate = await report();
    const underReview = await training(
      teacher,
      "/reports/" + reviewCandidate._id + "/actions",
      {
        action: "request-review",
        expected_revision: reviewCandidate.revision,
      },
    );
    const reviewerMember = await f.db
      .collection("organization_members")
      .findOne({ _id: reviewer.memberId });
    await f.ops.setCapability(f.context, {
      org_id: f.org,
      member_id: reviewer.memberId,
      capability: "training:report-review",
      granted: true,
      expected_revision: reviewerMember.authorization_revision,
      valid_to: new Date(Date.now() + 3600000),
    });
    await t.test(
      "独立连接撤销发生在发布事实快照后，事务重试拒绝旧事实",
      async () => {
        const { MongoClient } = require("mongodb");
        const { objectIdDatabase } = require("../dist/database/object-id");
        const {
          AssessmentSources,
        } = require("../dist/content/assessment-sources");
        const writer = new MongoClient(process.env.MONGODB_URI);
        let release,
          reach,
          timeout,
          publishing,
        hits = 0,
        transientConflicts = 0;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        const reached = new Promise((resolve) => {
          reach = resolve;
        });
        const originalQuestion = AssessmentSources.prototype.question;
        AssessmentSources.prototype.question = async function (
          ctx,
          version,
          ...args
        ) {
          if (
            !hits &&
            version === f.questions[2].id &&
            ctx.userId === f.student.user.user_id
          ) {
            hits++;
            reach();
            await gate;
          }
        try { return await originalQuestion.call(this, ctx, version, ...args); }
        catch (error) {
          if (error.hasErrorLabel?.("TransientTransactionError")) transientConflicts++;
          throw error;
        }
        };
        try {
          await writer.connect();
          const independent = objectIdDatabase(writer.db());
          assert.equal(independent.databaseName, f.db.databaseName);
          assert.match(independent.databaseName, /^kl_test_/);
          publishing = reviewer.browser.request(
            "/training/reports/" + underReview._id + "/actions",
            {
              method: "POST",
              headers: {
                "X-Org-Id": f.org,
                "Idempotency-Key": require("node:crypto").randomUUID(),
              },
              body: {
                action: "publish",
                expected_revision: underReview.revision,
                note: "并发来源复核",
              },
            },
          );
          await Promise.race([
            reached,
            new Promise((_, reject) => {
              timeout = setTimeout(
                () => reject(Error("COMPLETION_GATE_NOT_REACHED")),
                10000,
              );
            }),
          ]);
          clearTimeout(timeout);
          assert.equal(hits, 1);
          assert.equal(
            await independent
              .collection("training_report_versions")
              .countDocuments({ report_id: underReview._id }),
            0,
          );
          const revoked = await independent
            .collection("question_versions")
            .updateOne(
              { _id: f.questions[2].id },
              {
                $set: { access_revoked_at: new Date() },
                $inc: { access_revision: 1 },
              },
            );
          assert.equal(revoked.modifiedCount, 1);
          release();
          const result = await publishing;
          status(result, 409);
          assert.equal(result.data.error.code, "REPORT_FACTS_CHANGED");
        assert.ok(transientConflicts > 0, "必须观察到真实事务冲突后重新核验，不能仅以最终409推断并发重试");
        } finally {
          clearTimeout(timeout);
          release();
          AssessmentSources.prototype.question = originalQuestion;
          if (publishing) await publishing.catch(() => undefined);
          await writer.close();
        }
      },
    );
    assert.equal(count(await report()), 0);
    const stalePublish = await reviewer.browser.request(
      "/training/reports/" + underReview._id + "/actions",
      {
        method: "POST",
        headers: {
          "X-Org-Id": f.org,
          "Idempotency-Key": require("node:crypto").randomUUID(),
        },
        body: {
          action: "publish",
          expected_revision: underReview.revision,
          note: "来源撤销后不得发布旧统计",
        },
      },
    );
    status(stalePublish, 409);
    assert.equal(stalePublish.data.error.code, "REPORT_FACTS_CHANGED");
    assert.equal(
      (
        await f.db
          .collection("training_reports")
          .findOne({ _id: underReview._id })
      ).status,
      "review",
    );
    assert.equal(
      await f.db
        .collection("training_report_versions")
        .countDocuments({ report_id: underReview._id }),
      0,
    );
  });
