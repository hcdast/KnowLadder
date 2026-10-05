"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { newId } = require("../dist/database/object-id");
const {
  assessmentFixture,
  good,
  quizInput,
} = require("./assessment-helpers.cjs");
test(
  "二期测验条件：真实交卷评分、未释放拒计分、释放通过与重批待核验",
  { timeout: 240000 },
  async (t) => {
    const f = await assessmentFixture(t, {
        env: {
          KL_TRAINING_ENABLED: "true",
          KL_TRAINING_PHASE2_ENABLED: "true",
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
        ],
      ),
      reviewer = await f.actor(["teacher"], [...caps, "course:review"]),
      classId = newId(),
      now = new Date();
    await f.db
      .collection("classes")
      .insertOne({
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
    const training = (a, p, b) =>
      good(
        a,
        "/training" + p,
        b === undefined ? undefined : { method: "POST", body: b },
      );
    let course = await training(teacher, "/courses", {
      code: "quiz-path",
      title: "原创测验路径课程",
      subject_id: f.subject,
      version_no: 1,
      lessons: [
        {
          key: "one",
          title: "课节",
          kind: "text",
          required: true,
          body: "原创正文",
          file_id: null,
          owner_version_id: null,
        },
      ],
    });
    course = await training(teacher, "/courses/" + course._id + "/actions", {
      action: "request-review",
      expected_revision: course.revision,
    });
    course = await training(reviewer, "/courses/" + course._id + "/actions", {
      action: "publish",
      expected_revision: course.revision,
      note: "独立审核",
    });
    await training(teacher, "/courses/" + course._id + "/assign", {
      class_id: classId,
    });
    await training(f.student, "/courses/" + course._id + "/progress", {
      lesson_key: "one",
      complete: true,
      position: 0,
    });
    const input = quizInput(f);
    delete input.audience_member_ids;
    input.source_class_ids = [classId];
    const quiz = await good(teacher, "/quizzes", {
      method: "POST",
      body: input,
    });
    await good(f.reviewer, "/quizzes/" + quiz.id + "/publish", {
      method: "POST",
      body: { expected_revision: quiz.revision, reason: "独立发布原创试卷" },
    });
    let task = await training(teacher, "/tasks", {
      class_id: classId,
      subject_id: f.subject,
      title: "结业测验",
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
    const delivered = await f.student.browser.request(
      "/training/phase2/notifications",
      { csrf: null, origin: null, headers: { "X-Org-Id": f.org } },
    );
    require("./helpers.cjs").status(delivered, 200);
    assert.ok(
      delivered.data.data.items.some((x) => x.message === "新的学习任务已发布"),
    );
    assert.equal(
      delivered.data.data.items.some((x) => Object.hasOwn(x, "score")),
      false,
    );
    let path = await training(teacher, "/phase2/paths", {
      class_id: classId,
      subject_id: f.subject,
      title: "测验成绩路径",
      course_ids: [course._id],
      task_ids: [task._id],
      attendance_bp: 8000,
      grade_min: 60,
    });
    path = await training(teacher, "/phase2/paths/" + path._id + "/actions", {
      action: "request-review",
      expected_revision: path.revision,
    });
    await training(reviewer, "/phase2/paths/" + path._id + "/actions", {
      action: "publish",
      expected_revision: path.revision,
      note: "独立冻结规则",
    });
    const assignment = (await training(reviewer, "/phase2/assignments"))
      .items[0];
    const session = await good(f.student, "/quizzes/" + quiz.id + "/sessions", {
        method: "POST",
        body: {},
      }),
      item = (await good(f.student, "/sessions/" + session.id + "/items"))
        .items[0],
      submitted = await good(
        f.student,
        "/sessions/" + session.id + "/submissions",
        {
          method: "POST",
          body: {
            expected_revision: session.revision,
            answers: [{ session_item_id: item.id, answer: { value: "2" } }],
          },
        },
        202,
      );
    const grade = async () => {
      for (let i = 0; i < 10; i++) {
        if (
          (
            await f.db
              .collection("submissions")
              .findOne({ _id: submitted.submission_id })
          ).grading_status === "completed"
        )
          return;
        await require("../dist/assessment/worker").processOne(f.db);
      }
      assert.fail("真实评分未完成");
    };
    await grade();
    let result = await training(
      reviewer,
      "/phase2/completions/" + assignment._id,
    );
    assert.ok(result.evidence.missing.includes("测验当前有效发布成绩不足"));
    assert.equal(result.evidence.sources.find((x) => x[0] === "quiz")[4], null);
    await f.db
      .collection("quizzes")
      .updateOne({ _id: quiz.id }, [
        {
          $set: {
            closes_at: {
              $dateSubtract: { startDate: "$$NOW", unit: "second", amount: 2 },
            },
            release_at: {
              $dateSubtract: { startDate: "$$NOW", unit: "second", amount: 1 },
            },
          },
        },
      ]);
    result = await training(reviewer, "/phase2/completions/" + assignment._id);
    assert.equal(
      result.evidence.missing.includes("测验当前有效发布成绩不足"),
      false,
    );
    assert.equal(
      result.evidence.sources.find((x) => x[0] === "quiz")[4].passed,
      true,
    );
    const admin = await good(
      f.reviewer,
      "/admin/submissions/" + submitted.submission_id,
    );
    await good(
      f.reviewer,
      "/submissions/" + submitted.submission_id + "/regrades",
      {
        method: "POST",
        body: { expected_revision: admin.revision, reason: "独立重批原卷" },
      },
      202,
    );
    result = await training(reviewer, "/phase2/completions/" + assignment._id);
    assert.ok(result.evidence.missing.includes("测验当前有效发布成绩不足"));
    await grade();
    result = await training(reviewer, "/phase2/completions/" + assignment._id);
    assert.equal(
      result.evidence.missing.includes("测验当前有效发布成绩不足"),
      false,
    );
  },
);
