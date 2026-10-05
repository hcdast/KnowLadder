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
  "二期：v15隔离迁移、排课冲突、独立考勤/路径/证书、通知与撤权",
  { timeout: 240000 },
  async (t) => {
    const f = await setup(t, {
      KL_TRAINING_PHASE2_ENABLED: "true",
      KL_TRAINING_REPORTS_ENABLED: "true",
    });
    const caps = require("../dist/training/phase2-schema").PHASE2_CAPABILITIES;
    const teacher = await f.actor(["teacher"], [...caps]),
      reviewer = await f.actor(["teacher"], [...caps]);
    const now = new Date();
    for (const a of [teacher, reviewer])
      await f.db.collection("teaching_assignments").insertOne({
        _id: newId(),
        org_id: f.org,
        class_id: f.classId,
        member_id: a.member,
        subject_id: f.subject,
        status: "active",
        revision: 1,
        valid_from: null,
        valid_to: null,
        created_at: now,
        updated_at: now,
      });
    assert.equal(
      (await f.db.collection("schema_migrations").findOne({ version: 15 }))
        .checksum,
      require("../dist/training/phase2-schema").TRAINING_PHASE2_CHECKSUM,
    );
    const good = (a, p, b, key) => f.good(a, "/phase2" + p, b, key),
      req = (a, p, b, key) => f.req(a, "/phase2" + p, b, key);
    const location = await good(teacher, "/locations", { title: "原创培训室" });
    status(await req(f.student, "/locations", { title: "拒绝" }), 403);
    let course = await f.good(f.author, "/courses", {
      code: "phase2-original",
      title: "原创必修课程",
      subject_id: f.subject,
      version_no: 1,
      lessons: [
        {
          key: "one",
          title: "必修课",
          kind: "text",
          required: true,
          body: "原创培训材料",
          file_id: null,
          owner_version_id: null,
        },
      ],
    });
    course = await f.good(f.author, "/courses/" + course._id + "/actions", {
      action: "request-review",
      expected_revision: course.revision,
    });
    course = await f.good(f.reviewer, "/courses/" + course._id + "/actions", {
      action: "publish",
      expected_revision: course.revision,
      note: "独立审核",
    });
    await f.good(f.author, "/courses/" + course._id + "/assign", {
      class_id: f.classId,
    });
    const draft = {
      class_id: f.classId,
      subject_id: f.subject,
      title: "单次课",
      course_id: course._id,
      teacher_member_id: teacher.member,
      location_id: location._id,
      start_at: new Date(Date.now() + 600000).toISOString(),
      end_at: new Date(Date.now() + 4200000).toISOString(),
      original_session_id: null,
    };
    let lesson = await good(teacher, "/schedule", draft);
    const key = randomUUID();
    lesson = await good(
      teacher,
      "/schedule/" + lesson._id + "/actions",
      { action: "publish", expected_revision: lesson.revision },
      key,
    );
    assert.equal(lesson.status, "published");
    assert.deepEqual(lesson.recipients, [f.student.member]);
    const other = await good(teacher, "/schedule", {
      ...draft,
      title: "冲突课",
    });
    const conflict = await req(teacher, "/schedule/" + other._id + "/actions", {
      action: "publish",
      expected_revision: other.revision,
    });
    status(conflict, 409);
    assert.equal(conflict.data.error.code, "SCHEDULE_CONFLICT");
    let leave = await good(f.student, "/leave", {
      session_id: lesson._id,
      reason: "个人安排",
    });
    leave = await good(teacher, "/leave/" + leave._id + "/actions", {
      action: "approve",
      expected_revision: leave.revision,
      note: "同意",
    });
    assert.equal(leave.status, "approved");
    // Disposable timing fixture places the published original lesson in the past to exercise its real end/attendance routes.
    await f.db.collection("training_sessions").updateOne(
      { _id: lesson._id },
      {
        $set: {
          start_at: new Date(Date.now() - 7200000),
          end_at: new Date(Date.now() - 3600000),
        },
      },
    );
    lesson = await f.db
      .collection("training_sessions")
      .findOne({ _id: lesson._id });
    lesson = await good(teacher, "/schedule/" + lesson._id + "/actions", {
      action: "end",
      expected_revision: lesson.revision,
    });
    let attendance = await good(
      teacher,
      "/schedule/" + lesson._id + "/attendance",
      {
        action: "save",
        expected_revision: 0,
        entries: [{ member_id: f.student.member, status: "present" }],
      },
    );
    attendance = await good(
      teacher,
      "/schedule/" + lesson._id + "/attendance",
      { action: "request-review", expected_revision: attendance.revision },
    );
    status(
      await req(teacher, "/schedule/" + lesson._id + "/attendance", {
        action: "confirm",
        expected_revision: attendance.revision,
        note: "不得自审",
      }),
      409,
    );
    attendance = await good(
      reviewer,
      "/schedule/" + lesson._id + "/attendance",
      {
        action: "confirm",
        expected_revision: attendance.revision,
        note: "独立确认到场",
      },
    );
    assert.equal(attendance.status, "confirmed");
    let gradeTask = await f.good(f.author, "/tasks", {
      class_id: f.classId,
      subject_id: f.subject,
      title: "结业作业",
      target_type: "coursework",
      target_id: null,
      due_at: new Date(Date.now() + 86400000).toISOString(),
      body: "原创结业说明",
      rubric: [{ key: "quality", title: "质量", weight: 100 }],
    });
    gradeTask = await f.good(f.author, "/tasks/" + gradeTask._id + "/actions", {
      action: "publish",
      expected_revision: gradeTask.revision,
    });
    const submittedHead = await f.good(
      f.student,
      "/tasks/" + gradeTask._id + "/coursework",
      { action: "submit", expected_revision: 0, body: "原创结业作品" },
    );
    await f.good(f.author, "/tasks/" + gradeTask._id + "/feedback", {
      head_revision: submittedHead.revision,
      submission_id: submittedHead.current_submission_id,
      comments: "当前作品达到要求",
      scores: [{ key: "quality", score: 90 }],
      publish: true,
    });
    const publishedNotice = await f.student.browser.request(
      "/training/phase2/notifications",
      { csrf: null, origin: null, headers: { "X-Org-Id": f.org } },
    );
    status(publishedNotice, 200);
    assert.ok(
      publishedNotice.data.data.items.some(
        (x) => x.message === "教师反馈已发布",
      ),
    );
    let path = await good(teacher, "/paths", {
      class_id: f.classId,
      subject_id: f.subject,
      title: "职业学习路径",
      course_ids: [course._id],
      task_ids: [gradeTask._id],
      attendance_bp: 8000,
      grade_min: 60,
    });
    path=await good(teacher,'/paths/'+path._id+'/actions',{action:'edit',expected_revision:path.revision,title:path.title,course_ids:path.course_ids,task_ids:path.task_ids,attendance_bp:8000,grade_min:60});assert.equal(path.status,'draft');
    path = await good(teacher, "/paths/" + path._id + "/actions", {
      action: "request-review",
      expected_revision: path.revision,
    });
    path = await good(reviewer, "/paths/" + path._id + "/actions", {
      action: "publish",
      expected_revision: path.revision,
      note: "确认冻结规则",
    });
    status(await req(teacher,'/paths/'+path._id+'/actions',{action:'edit',expected_revision:path.revision,title:'不能覆盖已发布规则',course_ids:path.course_ids,task_ids:path.task_ids,attendance_bp:8000,grade_min:60}),409);
    const assignment = (await good(reviewer, "/assignments")).items[0];
    const missing = await good(reviewer, "/completions/" + assignment._id);
    assert.equal(missing.eligible, false);
    await f.good(f.student, "/courses/" + course._id + "/progress", {
      lesson_key: "one",
      complete: true,
      position: 0,
    });
    const eligible = await good(reviewer, "/completions/" + assignment._id);
    assert.equal(eligible.eligible, true);
    assert.equal(eligible.evidence.attendance_bp, 10000);
    const endedFixture = async (index, state, original = null) => {
      let row = await good(teacher, "/schedule", {
        ...draft,
        title: "边界课次" + index,
        start_at: new Date(Date.now() + (index + 1) * 86400000).toISOString(),
        end_at: new Date(
          Date.now() + (index + 1) * 86400000 + 3600000,
        ).toISOString(),
        original_session_id: original,
      });
      row = await good(teacher, "/schedule/" + row._id + "/actions", {
        action: "publish",
        expected_revision: row.revision,
      });
      await f.db
        .collection("training_sessions")
        .updateOne(
          { _id: row._id },
          {
            $set: {
              start_at: new Date(Date.now() - (index + 4) * 3600000),
              end_at: new Date(Date.now() - (index + 3) * 3600000),
            },
          },
        );
      row = await good(teacher, "/schedule/" + row._id + "/actions", {
        action: "end",
        expected_revision: row.revision,
      });
      let a = await good(teacher, "/schedule/" + row._id + "/attendance", {
        action: "save",
        expected_revision: 0,
        entries: [{ member_id: f.student.member, status: state }],
      });
      a = await good(teacher, "/schedule/" + row._id + "/attendance", {
        action: "request-review",
        expected_revision: a.revision,
      });
      await good(reviewer, "/schedule/" + row._id + "/attendance", {
        action: "confirm",
        expected_revision: a.revision,
        note: "独立核对边界",
      });
      return row;
    };
    for (let index = 0; index < 3; index++)
      await endedFixture(index, "present");
    const absentLesson = await endedFixture(3, "absent");
    const exact80 = await good(f.student, "/completions/" + assignment._id);
    assert.equal(exact80.evidence.attendance_bp, 8000);
    assert.equal(exact80.eligible, true);
    status(await req(f.stranger, "/completions/" + assignment._id), 404);
    await endedFixture(4, "present", absentLesson._id);
    await endedFixture(5, "present", absentLesson._id);
    const makeup = await good(reviewer, "/completions/" + assignment._id);
    assert.equal(makeup.evidence.minutes, 300);
    assert.equal(makeup.evidence.attended, 300);
    assert.equal(makeup.evidence.attendance_bp, 10000);
    status(
      await req(teacher, "/certificates", {
        assignment_id: assignment._id,
        note: "不能自审签发",
      }),
      403,
    );
    const issueBody = { assignment_id: assignment._id, note: "独立确认结业" };
    const issueKeys = [randomUUID(), randomUUID()];
    const issues = await Promise.all(issueKeys.map(issueKey => req(reviewer, "/certificates", issueBody, issueKey)));
    assert.deepEqual(issues.map(r => r.status).sort(), [200, 409]);
    const winner = issues.findIndex(r => r.status === 200);
    const cert = issues[winner].data.data;
    const recoveredIssue = await good(reviewer, "/receipts/query", { key: issueKeys[winner] });
    assert.equal(recoveredIssue.status, "confirmed");
    assert.deepEqual(recoveredIssue.result, cert, "丢弃首次HTTP结果后原key回执恢复同一证书及令牌");
    const replays = await Promise.all([1, 2].map(() => good(reviewer, "/certificates", issueBody, issueKeys[winner])));
    for (const replay of replays) assert.deepEqual(replay, cert);
    status(await req(reviewer, "/certificates", { ...issueBody, note: "不同正文拒绝复用" }, issueKeys[winner]), 409);
    assert.equal(await f.db.collection("training_certificates").countDocuments({assignment_id:assignment._id}), 1);
    assert.equal(await f.db.collection("training_certificate_events").countDocuments({certificate_id:cert._id}), 1);
    assert.equal(cert.status, "issued");
    assert.equal(cert.verification_token.length, 64);
    const verification = await new Browser(f.browser.base).request(
      "/training-public/verification/" + cert.verification_token,
    );
    status(verification, 200);
    assert.equal(verification.data.data.status, "valid");
    assert.deepEqual(Object.keys(verification.data.data).sort(), [
      "course",
      "issued_at",
      "organization",
      "status",
    ]);
    const receipt = await good(teacher, "/receipts/query", { key });
    assert.equal(receipt.status, "confirmed");
    assert.equal(receipt.result._id, lesson._id);
    const concurrentNotifications = await Promise.all([1, 2, 3].map(() => good(f.student, "/notifications")));
    const notifications = concurrentNotifications[0];
    const storedNotifications = await f.db.collection("training_notifications").find({user_id:f.student.user.user_id}).toArray();
    assert.equal(new Set(storedNotifications.map(n => n.event_id)).size, storedNotifications.length, "并发物化同一事件只产生一条通知");
    for (const view of concurrentNotifications) assert.deepEqual(view.items.map(n => n._id).sort(), notifications.items.map(n => n._id).sort());
    assert.ok(notifications.items.length > 0);
    const n = notifications.items[0];
    await good(f.student, "/notifications/" + n._id + "/read", {
      expected_revision: n.revision,
    });
    assert.equal(
      (await good(f.student, "/notifications")).items.length,
      notifications.items.length,
    );
    const studentCertificates = await good(f.student, "/certificates");
    assert.equal(studentCertificates.items[0].token_hash, undefined);
    assert.equal(studentCertificates.items[0].evidence_json, undefined);
    const frozenAttendance = await f.db
      .collection("training_attendance")
      .findOne({ _id: attendance._id });
    await good(teacher, "/schedule/" + lesson._id + "/attendance", {
      action: "correct",
      expected_revision: frozenAttendance.revision,
      note: "更正重新独立审核",
    });
    const pending = await new Browser(f.browser.base).request(
      "/training-public/verification/" + cert.verification_token,
    );
    status(pending, 200);
    assert.equal(pending.data.data.status, "pending_review");
    const revoked = await good(
      reviewer,
      "/certificates/" + cert._id + "/revoke",
      { expected_revision: cert.revision, note: "原创测试撤销" },
    );
    assert.equal(revoked.status, "revoked");
    const publicRevoked = await new Browser(f.browser.base).request(
      "/training-public/verification/" + cert.verification_token,
    );
    status(publicRevoked, 200);
    assert.deepEqual(publicRevoked.data.data, { status: "revoked" });
    assert.ok(
      await f.db
        .collection("training_notification_outbox")
        .countDocuments({ user_id: f.student.user.user_id }),
    );
    await f.db
      .collection("teaching_assignments")
      .updateOne(
        { member_id: reviewer.member },
        { $set: { status: "ended" }, $inc: { revision: 1 } },
      );
    assert.equal((await good(reviewer, "/schedule")).items.length, 0);
    status(await req(reviewer, "/receipts/query", {key:issueKeys[winner]}), 404);
    status(await req(reviewer, "/certificates", issueBody, issueKeys[winner]), 404);
  },
);

test(
  "二期默认关闭，不创建v15集合且接口明确拒绝",
  { timeout: 120000 },
  async (t) => {
    const f = await setup(t);
    assert.equal(
      await f.db.collection("schema_migrations").findOne({ version: 15 }),
      null,
    );
    assert.equal(
      (await f.db.listCollections({ name: "training_sessions" }).toArray())
        .length,
      0,
    );
    const r = await f.req(f.student, "/phase2/schedule");
    status(r, 503);
    assert.equal(r.data.error.code, "TRAINING_PHASE2_DISABLED");
  },
);

test(
  "二期排课并发：半开区间相邻可发布，重叠只成功一次",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t, { KL_TRAINING_PHASE2_ENABLED: "true" }),
      caps = require("../dist/training/phase2-schema").PHASE2_CAPABILITIES;
    const teacher = await f.actor(["teacher"], caps),
      now = new Date();
    await f.db.collection("teaching_assignments").insertOne({
      _id: newId(),
      org_id: f.org,
      class_id: f.classId,
      member_id: teacher.member,
      subject_id: f.subject,
      status: "active",
      revision: 1,
      valid_from: null,
      valid_to: null,
      created_at: now,
      updated_at: now,
    });
    const good = (p, b) => f.good(teacher, "/phase2" + p, b),
      req = (p, b) => f.req(teacher, "/phase2" + p, b);
    let course = await f.good(f.author, "/courses", {
      code: "race-original",
      title: "并发原创课程",
      subject_id: f.subject,
      version_no: 1,
      lessons: [
        {
          key: "one",
          title: "课节",
          kind: "text",
          required: true,
          body: "原创内容",
          file_id: null,
          owner_version_id: null,
        },
      ],
    });
    course = await f.good(f.author, "/courses/" + course._id + "/actions", {
      action: "request-review",
      expected_revision: course.revision,
    });
    course = await f.good(f.reviewer, "/courses/" + course._id + "/actions", {
      action: "publish",
      expected_revision: course.revision,
      note: "独立审核",
    });
    await f.good(f.author, "/courses/" + course._id + "/assign", {
      class_id: f.classId,
    });
    const location = await good("/locations", { title: "并发场地" }),
      start = Date.now() + 600000,
      end = start + 3600000,
      body = {
        class_id: f.classId,
        subject_id: f.subject,
        title: "并发课次",
        course_id: course._id,
        teacher_member_id: teacher.member,
        location_id: location._id,
        start_at: new Date(start).toISOString(),
        end_at: new Date(end).toISOString(),
        original_session_id: null,
      };
    const a = await good("/schedule", body),
      b = await good("/schedule", body);
    const results = await Promise.all(
      [a, b].map((row) =>
        req("/schedule/" + row._id + "/actions", {
          action: "publish",
          expected_revision: row.revision,
        }),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const adjacent = await good("/schedule", {
      ...body,
      start_at: new Date(end).toISOString(),
      end_at: new Date(end + 3600000).toISOString(),
    });
    assert.equal(
      (
        await good("/schedule/" + adjacent._id + "/actions", {
          action: "publish",
          expected_revision: adjacent.revision,
        })
      ).status,
      "published",
    );
    const publishedAdjacent = (await good("/schedule")).items.find(row => row._id === adjacent._id);
    const versionsBeforeRace = await f.db.collection("training_session_versions").countDocuments({session_id:adjacent._id});
    const actionRace = await Promise.all([
      req("/schedule/" + adjacent._id + "/actions", {action:"cancel", expected_revision:publishedAdjacent.revision, note:"并发取消"}),
      req("/schedule/" + adjacent._id + "/actions", {action:"reschedule", expected_revision:publishedAdjacent.revision, start_at:new Date(end+86400000).toISOString(), end_at:new Date(end+86400000+3600000).toISOString(), note:"并发调课"}),
    ]);
    assert.deepEqual(actionRace.map(r => r.status).sort(), [200,409], "相同修订的调课/取消只能提交一次");
    const actionWinner = actionRace.find(r => r.status === 200).data.data;
    const persisted = await f.db.collection("training_sessions").findOne({_id:adjacent._id});
    assert.equal(persisted.revision, publishedAdjacent.revision + 1);
    assert.equal(persisted.status, actionWinner.status);
    assert.equal(await f.db.collection("training_session_versions").countDocuments({session_id:adjacent._id}), versionsBeforeRace + 1, "仅成功动作增加一份版本，失败竞争不得留下半份版本");
    status(
      await req("/schedule", {
        ...body,
        end_at: new Date(start + 13 * 3600000).toISOString(),
      }),
      422,
    );
  },
);
