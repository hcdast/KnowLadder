"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { setup } = require("./training-isolated-helpers.cjs");
const { status } = require("./helpers.cjs");
const { newId } = require("../dist/database/object-id");
test("批量预检查/分配和本人工作台真实HTTP", { timeout: 180000 }, async (t) => {
  const f = await setup(t, { KL_TRAINING_PHASE2_ENABLED: "true" });
  const now = new Date();
  const base = () => ({
    _id: newId(),
    org_id: f.org,
    revision: 1,
    created_at: now,
    updated_at: now,
  });
  let c = await f.good(f.author, "/courses", {
    code: "batch-workbench",
    title: "原创批量课程",
    subject_id: f.subject,
    version_no: 1,
    lessons: [
      {
        key: "lesson",
        title: "基础",
        kind: "text",
        required: true,
        body: "原创正文",
        file_id: null,
        owner_version_id: null,
      },
    ],
  });
  c = await f.good(f.author, "/courses/" + c._id + "/actions", {
    action: "request-review",
    expected_revision: c.revision,
  });
  c = await f.good(f.reviewer, "/courses/" + c._id + "/actions", {
    action: "publish",
    expected_revision: c.revision,
    note: "独立检查",
  });
  const second = newId(),
    forbidden = newId();
  await f.db.collection("classes").insertOne({
    ...base(),
    _id: second,
    name: "第二班",
    year_label: "2026",
    status: "active",
    created_by: f.author.user.user_id,
  });
  await f.db.collection("teaching_assignments").insertOne({
    ...base(),
    class_id: second,
    member_id: f.author.member,
    subject_id: f.subject,
    status: "active",
    valid_from: null,
    valid_to: null,
  });
  const preview = await f.good(
    f.author,
    "/courses/" + c._id + "/assignments/preview",
    { class_ids: [f.classId, second, forbidden] },
  );
  assert.deepEqual(
    preview.items.map((x) => x.status),
    ["ready", "ready", "forbidden"],
  );
  assert.equal(preview.items[2].name, undefined);
  assert.equal(await f.db.collection("class_courses").countDocuments(), 0);
  status(
    await f.req(f.author, "/courses/" + c._id + "/assignments/preview", {
      class_ids: [second, second],
    }),
    422,
  );
  status(
    await f.req(f.author, "/courses/" + c._id + "/assignments/preview", {
      class_ids: Array.from({ length: 21 }, newId),
    }),
    422,
  );
  status(
    await f.req(f.student, "/courses/" + c._id + "/assignments/preview", {
      class_ids: [f.classId],
    }),
    403,
  );
  const key = randomUUID(),
    body = { class_id: f.classId };
  const assigned = await f.good(
    f.author,
    "/courses/" + c._id + "/assign",
    body,
    key,
  );
  assert.equal(assigned.status, "assigned");
  const repeat = await f.good(f.author, "/courses/" + c._id + "/assign", body);
  assert.equal(repeat.status, "already_assigned");
  assert.equal(
    await f.db
      .collection("audit_events")
      .countDocuments({ resource_id: c._id, action: "training.course.assign" }),
    1,
  );
  // Pause a real HTTP write after course authorization and before target-class fencing.
  const service = f.app.get(
      require("../dist/training/training.service").TrainingService,
    ),
    original = service.classAccess.bind(service);
  let release, entered;
  const pause = new Promise((resolve) => (release = resolve)),
    started = new Promise((resolve) => (entered = resolve));
  let intercepted = false,
    targetAttempts = 0;
  service.classAccess = async (
    ctx,
    classId,
    subject,
    teacher,
    write = false,
  ) => {
    if (classId === second && teacher && write) targetAttempts++;
    if (classId === second && teacher && write && !intercepted) {
      intercepted = true;
      entered();
      await pause;
    }
    return original(ctx, classId, subject, teacher, write);
  };
  const concurrent = f.req(f.author, "/courses/" + c._id + "/assign", {
    class_id: second,
  });
  await started;
  try {
    await f.db
      .collection("teaching_assignments")
      .updateOne(
        { class_id: second, member_id: f.author.member },
        { $set: { status: "ended" } },
        { maxTimeMS: 5000 },
      );
  } finally {
    release();
  }
  try {
    status(await concurrent, 404);
    assert.equal(intercepted, true);
    assert.ok(targetAttempts >= 2, "真实事务冲突后必须重新核查当前授权");
  } finally {
    service.classAccess = original;
  }
  await f.db
    .collection("teaching_assignments")
    .updateOne(
      { class_id: second, member_id: f.author.member },
      { $set: { status: "ended" } },
    );
  status(
    await f.req(f.author, "/courses/" + c._id + "/assign", {
      class_id: second,
    }),
    404,
  );
  assert.equal(await f.db.collection("class_courses").countDocuments(), 1);
  await f.db
    .collection("class_courses")
    .updateOne(
      { class_id: f.classId, course_id: c._id },
      { $set: { status: "ended" } },
    );
  status(await f.req(f.author, "/courses/" + c._id + "/assign", body), 409);
  const endedPreview = await f.good(
    f.author,
    "/courses/" + c._id + "/assignments/preview",
    { class_ids: [f.classId] },
  );
  assert.equal(endedPreview.items[0].status, "conflict");
  await f.db
    .collection("class_courses")
    .updateOne(
      { class_id: f.classId, course_id: c._id },
      { $set: { status: "active" } },
    );
  await f.good(f.student, "/courses/" + c._id + "/progress", {
    lesson_key: "lesson",
    position: 0,
    complete: true,
  });
  const due = new Date(Date.now() + 86400000),
    taskId = newId();
  await f.db.collection("training_tasks").insertOne({
    ...base(),
    _id: taskId,
    class_id: f.classId,
    subject_id: f.subject,
    created_by: f.author.user.user_id,
    title: "本人课程任务",
    target_type: "course",
    target_id: c._id,
    due_at: due,
    status: "published",
    body: "原创任务",
    rubric: [],
    published_at: now,
    recipients: [f.student.member],
  });
  const sessionId = newId();
  await f.db.collection("training_sessions").insertOne({
    ...base(),
    _id: sessionId,
    class_id: f.classId,
    subject_id: f.subject,
    author_id: f.author.user.user_id,
    contributors: [],
    reviewer_id: null,
    title: "本人课次",
    course_id: c._id,
    teacher_member_id: f.author.member,
    location_id: newId(),
    start_at: new Date(now.getTime() + 3600000),
    end_at: new Date(now.getTime() + 7200000),
    original_session_id: null,
    recipients: [f.student.member],
    status: "published",
    note: "",
  });
  const cert = (actor) => ({
    ...base(),
    class_id: f.classId,
    subject_id: f.subject,
    path_id: newId(),
    assignment_id: newId(),
    user_id: actor.user.user_id,
    member_id: actor.member,
    issuer_id: f.author.user.user_id,
    number: "CERT-" + newId(),
    token_hash: newId().repeat(2) + "a".repeat(16),
    evidence_json: "{}",
    evidence_hash: "a".repeat(64),
    status: "issued",
    note: "",
  });
  await f.db
    .collection("training_certificates")
    .insertMany([cert(f.student), cert(f.stranger)]);
  const note = (actor) => ({
    ...base(),
    user_id: actor.user.user_id,
    member_id: actor.member,
    event_id: newId(),
    source_type: "task",
    source_id: taskId,
    message: actor === f.student ? "本人通知" : "不可泄露通知",
    read_at: null,
  });
  await f.db
    .collection("training_notifications")
    .insertMany([note(f.student), note(f.stranger)]);
  const uri =
    "/workbench?from=" +
    encodeURIComponent(new Date(now.getTime() - 3600000).toISOString()) +
    "&to=" +
    encodeURIComponent(new Date(now.getTime() + 86400000).toISOString());
  let w = await f.good(f.student, uri);
  assert.equal(w.modules.courses.items[0].completed, 1);
  assert.equal(w.modules.tasks.items[0].status, "course_complete");
  assert.equal(w.modules.schedule.items.length, 1);
  assert.equal(w.modules.certificates.items.length, 1);
  assert.equal(w.modules.notifications.items.length, 1);
  assert.equal(w.modules.notifications.items[0].message, "本人通知");
  assert.equal(w.modules.surveys.status, "disabled");
  assert.ok(!JSON.stringify(w).includes("token_hash"));
  assert.ok(!JSON.stringify(w).includes("evidence_json"));
  // Teacher + learner role must still use the learner branch and current personal enrollment.
  const beforeMembership = await f.db
    .collection("organization_members")
    .findOne({ _id: f.student.member });
  await f.ops.setMembership(f.context, {
    expected_revision: beforeMembership.authorization_revision,
    user_id: f.student.user.user_id,
    org_id: f.org,
    roles: ["student", "teacher"],
  });
  const member = await f.db
    .collection("organization_members")
    .findOne({ _id: f.student.member });
  await f.ops.setCapability(f.context, {
    org_id: f.org,
    member_id: f.student.member,
    capability: "training:schedule-manage",
    granted: true,
    expected_revision: member.authorization_revision,
    valid_to: new Date(Date.now() + 3600000),
  });
  w = await f.good(f.student, uri);
  const learnerSource = await f.good(
    f.student,
    "/courses/" + c._id + "?mode=learner",
  );
  assert.equal(learnerSource.progress.length, 1);
  assert.equal(w.modules.certificates.items.length, 1);
  assert.equal(w.modules.schedule.items.length, 1);
  assert.equal(w.modules.courses.items.length, 1);
  const overflow = Array.from({ length: 100 }, (_, i) => ({
    ...base(),
    user_id: f.student.user.user_id,
    member_id: f.student.member,
    course_id: c._id,
    lesson_key: "orphan-" + i,
    position: 0,
    completed_at: null,
  }));
  await f.db.collection("course_progress").insertMany(overflow);
  const unavailable = await f.good(f.student, uri);
  assert.equal(unavailable.modules.courses.status, "unavailable");
  assert.equal(unavailable.modules.tasks.items[0].status, "check_source");
  await f.db
    .collection("course_progress")
    .deleteMany({ _id: { $in: overflow.map((x) => x._id) } });
  const storedCourse = await f.db.collection("courses").findOne({ _id: c._id });
  const extra = Array.from({ length: 201 }, () => ({
    ...storedCourse,
    _id: newId(),
    code: "capacity-" + newId(),
  }));
  await f.db.collection("courses").insertMany(extra);
  const capped = await f.good(f.student, uri);
  assert.equal(capped.modules.courses.truncated, true);
  assert.ok(capped.modules.courses.items.length <= 200);
  assert.equal(capped.modules.tasks.items[0].status, "check_source");
  await f.db
    .collection("courses")
    .deleteMany({ _id: { $in: extra.map((x) => x._id) } });
  const stranger = await f.good(f.stranger, uri);
  assert.equal(stranger.modules.courses.items.length, 0);
  assert.equal(stranger.modules.schedule.items.length, 0);
  assert.equal(stranger.modules.certificates.items.length, 0);
  status(await f.req(f.student, "/workbench?from=bad&to=bad"), 422);
  status(
    await f.req(
      f.student,
      "/workbench?from=2026-01-01T00:00:00Z&to=2026-03-01T00:00:00Z",
    ),
    422,
  );
  await f.db
    .collection("class_members")
    .updateOne({ member_id: f.student.member }, { $set: { status: "ended" } });
  w = await f.good(f.student, uri);
  for (const name of [
    "courses",
    "tasks",
    "schedule",
    "certificates",
    "notifications",
  ])
    assert.equal(w.modules[name].items.length, 0);
  await f.db
    .collection("teaching_assignments")
    .updateOne(
      { class_id: f.classId, member_id: f.author.member },
      { $set: { status: "ended" } },
    );
  await f.db
    .collection("teaching_assignments")
    .updateOne(
      { class_id: second, member_id: f.author.member },
      { $set: { status: "active" } },
    );
  status(await f.req(f.author, "/receipts/query", { key }), 404);
  const mixed = await f.db
    .collection("organization_members")
    .findOne({ _id: f.student.member });
  await f.ops.setCapability(f.context, {
    org_id: f.org,
    member_id: f.student.member,
    capability: "course:edit",
    granted: true,
    expected_revision: mixed.authorization_revision,
    valid_to: new Date(Date.now() + 3600000),
  });
  status(await f.req(f.student, uri), 403);
  status(await f.req(f.student, "/courses/" + c._id + "?mode=learner"), 403);

  const contract = await fetch(f.browser.base + "/api/openapi.json");
  assert.equal(contract.status, 200);
  const exported=await contract.json();const modes=exported.paths["/api/v1/training/courses/{id}"].get.parameters.filter(p=>p.name==="mode");assert.equal(modes.length,1);assert.equal(modes[0].required,false);
  require("node:fs").writeFileSync(
    require("node:path").join(
      __dirname,
      "../../ops/artifacts/training-validation/revision150-batch-workbench-openapi.json",
    ),
    JSON.stringify(exported, null, 2),
  );
});

test(
  "工作台开放反馈只按当前本人报名和提交展示，关闭模块保持disabled",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t, {
      KL_KNOWLEDGE_ENABLED: "true",
      KL_KNOWLEDGE_IMPORT_ENABLED: "true",
      KL_TRAINING_SURVEYS_ENABLED: "true",
    });
    let c = await f.good(f.author, "/courses", {
      code: "feedback-workbench",
      title: "原创反馈工作台",
      subject_id: f.subject,
      version_no: 1,
      lessons: [
        {
          key: "text",
          title: "学习",
          kind: "text",
          required: true,
          body: "原创正文",
          file_id: null,
          owner_version_id: null,
        },
      ],
    });
    c = await f.good(f.author, "/courses/" + c._id + "/actions", {
      action: "request-review",
      expected_revision: c.revision,
    });
    c = await f.good(f.reviewer, "/courses/" + c._id + "/actions", {
      action: "publish",
      expected_revision: c.revision,
      note: "独立审核",
    });
    await f.good(f.author, "/courses/" + c._id + "/assign", {
      class_id: f.classId,
    });
    const now = new Date(),
      draft = {
        title: "本人反馈",
        opens_at: new Date(now.getTime() - 60000).toISOString(),
        closes_at: new Date(now.getTime() + 3600000).toISOString(),
        questions: [
          { id: "text", title: "意见", kind: "text", required: true },
        ],
      };
    let survey = await f.good(f.author, "/surveys", {
      course_id: c._id,
      draft,
    });
    survey = await f.good(f.author, "/surveys/" + survey._id + "/actions", {
      action: "publish",
      expected_revision: survey.revision,
    });
    const uri =
      "/workbench?from=" +
      encodeURIComponent(now.toISOString()) +
      "&to=" +
      encodeURIComponent(new Date(now.getTime() + 86400000).toISOString());
    let w = await f.good(f.student, uri);
    assert.equal(w.modules.surveys.items.length, 1);
    assert.equal(w.modules.surveys.items[0].submitted, false);
    for (const name of ["schedule", "certificates", "notifications"])
      assert.equal(w.modules[name].status, "disabled");
    assert.equal(
      (await f.good(f.stranger, uri)).modules.surveys.items.length,
      0,
    );
    await f.good(f.student, "/surveys/" + survey._id + "/responses", {
      expected_revision: survey.revision,
      answers: [{ question_id: "text", value: "原创个人反馈正文" }],
    });
    w = await f.good(f.student, uri);
    assert.equal(w.modules.surveys.items[0].submitted, true);
    assert.ok(!JSON.stringify(w).includes("原创个人反馈正文"));
    await f.db
      .collection("training_surveys")
      .updateOne(
        { _id: survey._id },
        { $set: { closes_at: new Date(now.getTime() - 1) } },
      );
    assert.equal(
      (await f.good(f.student, uri)).modules.surveys.items.length,
      0,
    );
  },
);
