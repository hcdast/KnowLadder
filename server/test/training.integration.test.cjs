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
  body: "先确认需求，再提供可执行建议。",
  file_id: null,
  owner_version_id: null,
};
async function course(f) {
  let c = await f.good(f.author, "/courses", {
    code: "communication",
    title: "职业沟通",
    subject_id: f.subject,
    version_no: 1,
    lessons: [lesson],
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
test(
  "培训：隔离迁移、独立审核、课程分配、进度、撤权与幂等重放",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t);
    assert.equal(
      (await f.db.collection("schema_migrations").findOne({ version: 11 }))
        .status,
      "completed",
    );
    const c = await course(f);
    assert.equal((await f.good(f.student, "/courses")).items.length, 1);
    assert.equal((await f.good(f.stranger, "/courses")).items.length, 0);
    status(await f.req(f.stranger, "/courses/" + c._id), 404);
    const key = randomUUID(),
      body = { lesson_key: "lesson-1", position: 20, complete: true };
    await f.good(f.student, "/courses/" + c._id + "/progress", body, key);
    await f.good(f.student, "/courses/" + c._id + "/progress", body, key);
    assert.equal(
      (await f.good(f.student, "/receipts/query", { key })).status,
      "confirmed",
    );
    status(await f.req(f.stranger, "/receipts/query", { key }), 200);
    assert.equal(
      await f.db
        .collection("course_progress")
        .countDocuments({ course_id: c._id }),
      1,
    );
    status(
      await f.req(
        f.student,
        "/courses/" + c._id + "/progress",
        { ...body, position: 30 },
        key,
      ),
      409,
    );
    await f.db
      .collection("class_members")
      .updateOne(
        { member_id: f.student.member },
        { $set: { status: "ended" } },
      );
    status(
      await f.req(f.student, "/courses/" + c._id + "/progress", body, key),
      404,
    );
    status(await f.req(f.student, "/receipts/query", { key }), 404);
    status(await f.req(f.student, "/courses", { title: "越权" }), 422);
  },
);
test(
  "培训：任务快照、作业重交、旧反馈拒绝、截止及AI未配置",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t);
    const c = await course(f);
    let task = await f.good(f.author, "/tasks", {
      class_id: f.classId,
      subject_id: f.subject,
      title: "沟通实践作业",
      target_type: "coursework",
      target_id: null,
      due_at: new Date(Date.now() + 60000).toISOString(),
      body: "写出需求确认话术",
      rubric: [{ key: "accuracy", title: "准确性", weight: 100 }],
    });
    task = await f.good(f.author, "/tasks/" + task._id + "/actions", {
      action: "publish",
      expected_revision: task.revision,
    });
    assert.deepEqual(task.recipients, [f.student.member]);
    status(await f.req(f.stranger, "/tasks/" + task._id + "/coursework"), 404);
    let head = await f.good(f.student, "/tasks/" + task._id + "/coursework", {
      expected_revision: 0,
      action: "submit",
      body: "请确认您的目标与约束。",
    });
    const old = head;
    head = await f.good(f.student, "/tasks/" + task._id + "/coursework", {
      expected_revision: head.revision,
      action: "submit",
      body: "请确认目标、时限和资源约束。",
    });
    status(
      await f.req(f.author, "/tasks/" + task._id + "/feedback", {
        head_revision: old.revision,
        submission_id: old.current_submission_id,
        comments: "旧批改",
        scores: [{ key: "accuracy", score: 80 }],
        publish: true,
      }),
      409,
    );
    const feedback = await f.good(
      f.author,
      "/tasks/" + task._id + "/feedback",
      {
        head_revision: head.revision,
        submission_id: head.current_submission_id,
        comments: "可以增加复述确认。",
        scores: [{ key: "accuracy", score: 90 }],
        publish: true,
      },
    );
    assert.equal(feedback.score, 90);
    assert.equal(
      (await f.good(f.student, "/tasks/" + task._id + "/coursework")).feedback
        .length,
      1,
    );
    assert.equal(
      await f.db
        .collection("coursework_submissions")
        .countDocuments({ task_id: task._id }),
      2,
    );
    await f.db
      .collection("training_tasks")
      .updateOne(
        { _id: task._id },
        { $set: { due_at: new Date(Date.now() - 1) } },
      );
    status(
      await f.req(f.student, "/tasks/" + task._id + "/coursework", {
        expected_revision: head.revision + 1,
        action: "submit",
        body: "迟交",
      }),
      409,
    );
    status(
      await f.req(f.student, "/ai/jobs", {
        kind: "assist",
        context_id: c._id,
        prompt: "如何确认需求？",
      }),
      503,
    );
    assert.equal(await f.db.collection("ai_usage_ledger").countDocuments(), 0);
  },
);

test(
  "AI：预算并发、引用检查、教师采纳与禁止自动发布（受控传输夹具，非模型质量验收）",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t, {
      KL_AI_ENDPOINT: "https://provider.invalid/chat",
      KL_AI_MODEL: "transport-test",
      KL_AI_API_KEY: "transport-test-value",
    });
    const c = await course(f);
    await f.good(f.author, "/ai/config", {
      enabled: true,
      daily_limit: 1,
      expected_revision: 0,
    });
    let calls = 0;
    const original = global.fetch;
    global.fetch = async (url, options) => {
      if (url === "https://provider.invalid/chat") {
        calls++;
        const sent = JSON.parse(options.body);
        assert.equal(sent.messages.length, 2);
        assert.ok(!options.body.includes("user_id"));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    text: "教学草稿：先识别目标，再进行复述确认。",
                    source_keys: ["lesson-1"],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return original(url, options);
    };
    t.after(() => {
      global.fetch = original;
    });
    const body = { kind: "prepare", context_id: c._id, prompt: "设计沟通训练" };
    const results = await Promise.all([
      f.req(f.author, "/ai/jobs", body),
      f.req(f.author, "/ai/jobs", { ...body, prompt: "另一个训练" }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 429]);
    const job = results.find((r) => r.status === 200).data.data;
    const generated = await f.good(
      f.author,
      "/ai/jobs/" + job.id + "/dispatch",
      { expected_revision: job.revision },
    );
    assert.equal(generated.status, "succeeded");
    assert.equal(calls, 1);
    await f.good(f.author, "/ai/jobs/" + job.id + "/dispatch", {
      expected_revision: job.revision,
    });
    assert.equal(calls, 1);
    const draft = await f.good(f.author, "/courses", {
      code: "communication",
      title: "沟通进阶",
      subject_id: f.subject,
      version_no: 2,
      lessons: [lesson],
    });
    const adopted = await f.good(f.author, "/ai/jobs/" + job.id + "/accept", {
      course_id: draft._id,
      expected_revision: draft.revision,
      lesson_key: "ai-lesson",
      title: "训练活动建议",
      body: generated.output,
    });
    assert.equal(adopted.status, "draft");
    assert.equal(adopted.lessons.length, 2);
    assert.equal((await f.good(f.student, "/courses")).items.length, 1);
    const ledger = await f.db
      .collection("ai_usage_ledger")
      .findOne({ org_id: f.org });
    assert.equal(ledger.reserved, 0);
    assert.equal(ledger.used, 1);
    status(await f.req(f.student, "/ai/jobs/" + job.id), 404);
  },
);
test(
  "AI：取消围栏与过期调用恢复，不重复派发（受控传输夹具）",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t, {
      KL_AI_ENDPOINT: "https://provider.invalid/chat",
      KL_AI_MODEL: "transport-test",
      KL_AI_API_KEY: "transport-test-value",
    });
    const c = await course(f);
    await f.good(f.author, "/ai/config", {
      enabled: true,
      daily_limit: 3,
      expected_revision: 0,
    });
    const job = await f.good(f.author, "/ai/jobs", {
      kind: "prepare",
      context_id: c._id,
      prompt: "教学建议",
    });
    let release, started;
    const began = new Promise((r) => {
        started = r;
      }),
      gate = new Promise((r) => {
        release = r;
      });
    const original = global.fetch;
    global.fetch = async (url, options) => {
      if (url === "https://provider.invalid/chat") {
        started();
        await gate;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    text: "已取消的内容",
                    source_keys: ["lesson-1"],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return original(url, options);
    };
    t.after(() => {
      release();
      global.fetch = original;
    });
    const inflight = f.req(f.author, "/ai/jobs/" + job.id + "/dispatch", {
      expected_revision: 1,
    });
    await began;
    const running = await f.db.collection("ai_jobs").findOne({ _id: job.id });
    const cancelled = await f.good(f.author, "/ai/jobs/" + job.id + "/cancel", {
      expected_revision: running.revision,
    });
    assert.equal(cancelled.status, "cancelled");
    release();
    status(await inflight, 200);
    assert.equal((await f.good(f.author, "/ai/jobs/" + job.id)).output, "");
    const crashed = await f.good(f.author, "/ai/jobs", {
      kind: "prepare",
      context_id: c._id,
      prompt: "崩溃调用",
    });
    await f.db.collection("ai_jobs").updateOne(
      { _id: crashed.id },
      {
        $set: {
          status: "running",
          dispatch_started_at: new Date(Date.now() - 61000),
        },
        $inc: { revision: 1 },
      },
    );
    const recovered = await f.good(
      f.author,
      "/ai/jobs/" + crashed.id + "/recover",
      { expected_revision: 2 },
    );
    assert.equal(recovered.status, "unknown");
    const replay = await f.good(
      f.author,
      "/ai/jobs/" + crashed.id + "/dispatch",
      { expected_revision: 2 },
    );
    assert.equal(replay.status, "unknown");
    const ledger = await f.db
      .collection("ai_usage_ledger")
      .findOne({ org_id: f.org });
    assert.equal(ledger.reserved, 0);
    assert.equal(ledger.unknown, 2);
  },
);
test(
  "网站：独立审核、匿名咨询回执、最小披露与默认关闭",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t, {
      KL_SITE_ORG_ID: "",
      KL_SITE_HANDLER_MEMBER_ID: "",
      KL_SITE_LEAD_RETENTION_DAYS: "7",
    });
    const a = await f.actor(["teacher"], ["site:edit"]),
      r = await f.actor(["teacher"], ["site:review", "site:lead-read"]);
    process.env.KL_SITE_ORG_ID = f.org;
    process.env.KL_SITE_HANDLER_MEMBER_ID = r.member;
    const req = (actor, path, body) =>
      actor.browser.request("/site" + path, {
        method: body === undefined ? "GET" : "POST",
        body,
        headers: { "X-Org-Id": f.org, "Idempotency-Key": randomUUID() },
      });
    const draftResponse = await req(a, "/drafts", {
      page_key: "home",
      title: "审核内容",
      body: "独立确认的本地培训说明",
    });
    status(draftResponse, 200);
    const d = draftResponse.data.data;
    status(
      await req(a, "/drafts/" + d._id + "/publish", { expected_revision: 1 }),
      403,
    );
    status(
      await req(r, "/drafts/" + d._id + "/publish", { expected_revision: 1 }),
      200,
    );
    const anonymous = new Browser(f.browser.base);
    let response = await anonymous.request("/site/pages/home");
    status(response, 200);
    assert.equal(response.data.data.page.title, "审核内容");
    assert.equal(response.data.data.consultation_enabled, true);
    const receipt = require("node:crypto").randomBytes(32).toString("hex"),
      body = {
        receipt,
        contact: "local-training@example.invalid",
        name: "本地验收",
        kind: "enterprise",
        consent: true,
      };
    status(
      await anonymous.request("/site/consultations", {
        method: "POST",
        body: { ...body, consent: false },
      }),
      422,
    );
    status(
      await anonymous.request("/site/consultations", { method: "POST", body }),
      200,
    );
    status(
      await anonymous.request("/site/consultations", { method: "POST", body }),
      200,
    );
    response = await anonymous.request("/site/consultations/" + receipt);
    status(response, 200);
    assert.deepEqual(Object.keys(response.data.data), ["status"]);
    assert.equal(await f.db.collection("site_leads").countDocuments(), 1);
    status(await req(a, "/leads"), 403);
    status(await req(r, "/drafts"), 200);
    const lead = (await req(r, "/leads")).data.data.items[0];
    status(
      await req(r, "/leads/" + lead._id + "/status", {
        expected_revision: lead.revision,
        status: "contacted",
      }),
      200,
    );
    response = await anonymous.request("/site/consultations/" + receipt);
    assert.deepEqual(response.data.data, { status: "contacted" });
    process.env.KL_SITE_HANDLER_MEMBER_ID = "";
    status(
      await anonymous.request("/site/consultations", {
        method: "POST",
        body: {
          ...body,
          receipt: require("node:crypto").randomBytes(32).toString("hex"),
        },
      }),
      503,
    );
  },
);

test(
  "培训：同一提交只呈现当前发布反馈；时区与发布目标重新校验",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t);
    const c = await course(f);
    const payload = {
      class_id: f.classId,
      subject_id: f.subject,
      title: "边界作业",
      target_type: "coursework",
      target_id: null,
      due_at: new Date(Date.now() + 60000).toISOString(),
      body: "提交练习",
      rubric: [{ key: "quality", title: "质量", weight: 100 }],
    };
    status(
      await f.req(f.author, "/tasks", {
        ...payload,
        due_at: "2027-10-02T10:00:00",
      }),
      422,
    );
    let task = await f.good(f.author, "/tasks", payload);
    task = await f.good(f.author, "/tasks/" + task._id + "/actions", {
      action: "publish",
      expected_revision: task.revision,
    });
    let head = await f.good(f.student, "/tasks/" + task._id + "/coursework", {
      expected_revision: 0,
      action: "submit",
      body: "完整作答",
    });
    await f.good(f.author, "/tasks/" + task._id + "/feedback", {
      head_revision: head.revision,
      submission_id: head.current_submission_id,
      comments: "第一次反馈",
      scores: [{ key: "quality", score: 70 }],
      publish: true,
    });
    head = (await f.good(f.student, "/tasks/" + task._id + "/coursework")).head;
    await f.good(f.author, "/tasks/" + task._id + "/feedback", {
      head_revision: head.revision,
      submission_id: head.current_submission_id,
      comments: "教师勘误后的反馈",
      scores: [{ key: "quality", score: 90 }],
      publish: true,
    });
    const visible = await f.good(
      f.student,
      "/tasks/" + task._id + "/coursework",
    );
    assert.equal(visible.feedback.length, 1);
    assert.equal(visible.feedback[0].score, 90);
    assert.equal(
      await f.db
        .collection("coursework_feedback")
        .countDocuments({ submission_id: head.current_submission_id }),
      2,
    );
    const courseTask = await f.good(f.author, "/tasks", {
      ...payload,
      title: "课程任务",
      target_type: "course",
      target_id: c._id,
      rubric: [],
    });
    await f.good(f.reviewer, "/courses/" + c._id + "/actions", {
      expected_revision: c.revision,
      action: "retire",
      note: "资料需要更新",
    });
    status(
      await f.req(f.author, "/tasks/" + courseTask._id + "/actions", {
        action: "publish",
        expected_revision: 1,
      }),
      409,
    );
  },
);

test(
  "培训：原v11集合的当前备份登记、空库恢复约束与隐私分类",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t);
    await course(f);
    const {
      systemBackupRegistry,
      initializeRestoreSchema,
      assertSchema,
    } = require("../dist/migrations/schema");
    const { rawDatabase } = require("../dist/database/object-id");
    const { ObjectId } = require("mongodb");
    const registry = systemBackupRegistry();
    const latest = await f.db.collection("schema_migrations").find({ status: "completed" }).sort({ version: -1 }).limit(1).next();
    assert.equal(registry.version, latest.version);
    const trainingMarker = await f.db.collection("schema_migrations").findOne({ version: 11, status: "completed" });
    assert.equal(registry.checksums["11"], trainingMarker.checksum);
    for (const name of [
      "courses",
      "class_courses",
      "course_progress",
      "training_tasks",
      "coursework_heads",
      "coursework_submissions",
      "coursework_feedback",
      "training_profiles",
      "training_idempotency",
      "ai_jobs",
      "ai_usage_ledger",
      "site_revisions",
      "site_leads",
    ])
      assert.ok(registry.collections.includes(name), name);
    const raw = rawDatabase(f.db);
    const stored = await raw.collection("courses").findOne();
    assert.ok(stored._id instanceof ObjectId);
    assert.ok(stored.subject_id instanceof ObjectId);
    const restore = raw.client.db(
      "kl_test_training_restore_" +
        require("node:crypto").randomBytes(6).toString("hex"),
    );
    t.after(async () => {
      assert.ok(restore.databaseName.startsWith("kl_test_training_restore_"));
      const cleanupClient = new (require("mongodb").MongoClient)(
        process.env.TEST_MONGODB_URI,
      );
      await cleanupClient.connect();
      try {
        await cleanupClient.db(restore.databaseName).dropDatabase();
      } finally {
        await cleanupClient.close();
      }
    });
    await initializeRestoreSchema(restore);
    for (const name of registry.collections) {
      const rows = await raw.collection(name).find({}).toArray();
      if (rows.length) await restore.collection(name).insertMany(rows);
    }
    await assertSchema(restore);
    assert.equal(await restore.collection("courses").countDocuments(), 1);
    await assert.rejects(
      restore.collection("courses").insertOne({
        ...stored,
        _id: new ObjectId(),
        subject_id: stored.subject_id.toHexString(),
      }),
      (e) => e.code === 121,
    );
    const { inspectPrivacyRequest } = require("../dist/privacy/execution");
    const { PRIVACY_POLICY_REVISION } = require("../dist/privacy/schema");
    const requestId = newId();
    await f.db.collection("privacy_deletion_requests").insertOne({
      _id: requestId,
      user_id: f.student.user.user_id,
      scope: "account",
      policy_revision: PRIVACY_POLICY_REVISION,
      status: "requested",
      revision: 1,
      plan_hash: null,
      created_at: new Date(),
      updated_at: new Date(),
      actor: null,
      reason_code: null,
      retention_basis: null,
      ledger_sequence: null,
      lease_token: null,
      lease_until: null,
      completed_steps: [],
      deleted_categories: [],
      retained_categories: [],
      remaining_actions: [],
    });
    const plan = await inspectPrivacyRequest(f.db, requestId);
    for (const name of [
      "coursework_feedback",
      "coursework_submissions",
      "coursework_heads",
      "course_progress",
      "training_idempotency",
      "ai_jobs",
    ])
      assert.ok(Object.hasOwn(plan.categories, name), name);
  },
);

test(
  "AI：人工题目建议采纳复用真实题库草稿与幂等事务（传输夹具）",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(
      t,
      {
        KL_AI_ENDPOINT: "https://provider.invalid/chat",
        KL_AI_MODEL: "transport-test",
        KL_AI_API_KEY: "transport-test-value",
      },
      ["teacher", "content_editor"],
    );
    const c = await course(f);
    await f.good(f.author, "/ai/config", {
      enabled: true,
      daily_limit: 1,
      expected_revision: 0,
    });
    const original = global.fetch;
    global.fetch = async (url, options) =>
      url === "https://provider.invalid/chat"
        ? new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      text: "建议练习识别目标和时限。",
                      source_keys: ["lesson-1"],
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          )
        : original(url, options);
    t.after(() => {
      global.fetch = original;
    });
    const job = await f.good(f.author, "/ai/jobs", {
      kind: "questions",
      context_id: c._id,
      prompt: "建议一个沟通练习题",
    });
    await f.good(f.author, "/ai/jobs/" + job.id + "/dispatch", {
      expected_revision: 1,
    });
    const body = {
        question: {
          title: "教师核对后的练习",
          subject_id: f.subject,
          question_type: "numeric",
          prompt: "确认目标需要至少几个方面？",
          answer: "3",
          difficulty: "基础",
          explanation: "目标、期限和资源",
          options: [],
          knowledge_point_ids: [],
        },
      },
      key = randomUUID();
    const draft = await f.good(
      f.author,
      "/ai/jobs/" + job.id + "/accept-question",
      body,
      key,
    );
    assert.equal(draft.status, "draft");
    assert.equal(draft.license.granted, false);
    assert.equal(
      (
        await f.good(
          f.author,
          "/ai/jobs/" + job.id + "/accept-question",
          body,
          key,
        )
      ).id,
      draft.id,
    );
    assert.equal(
      await f.db
        .collection("question_versions")
        .countDocuments({ _id: draft.id }),
      1,
    );
    status(
      await f.req(f.student, "/ai/jobs/" + job.id + "/accept-question", body),
      403,
    );
    const member = await f.db
      .collection("organization_members")
      .findOne({ _id: f.author.member });
    await f.ops.setMembership(f.context, {
      user_id: f.author.user.user_id,
      org_id: f.org,
      roles: ["teacher"],
      expected_revision: member.authorization_revision,
    });
    const nextMember = await f.db
      .collection("organization_members")
      .findOne({ _id: f.author.member });
    await f.ops.setCapability(f.context, {
      org_id: f.org,
      member_id: f.author.member,
      capability: "ai:generate",
      granted: true,
      expected_revision: nextMember.authorization_revision,
      valid_to: new Date(Date.now() + 3600000),
    });
    status(await f.req(f.author, "/receipts/query", { key }), 403);
  },
);

test(
  "AI 报告：确定性任务汇总，无身份明文，事实变化后拒绝旧建议（传输夹具）",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t, {
      KL_AI_ENDPOINT: "https://provider.invalid/chat",
      KL_AI_MODEL: "transport-test",
      KL_AI_API_KEY: "transport-test-value",
    });
    let task = await f.good(f.author, "/tasks", {
      class_id: f.classId,
      subject_id: f.subject,
      title: "汇总任务",
      target_type: "coursework",
      target_id: null,
      due_at: new Date(Date.now() + 60000).toISOString(),
      body: "实践任务",
      rubric: [{ key: "quality", title: "质量", weight: 100 }],
    });
    task = await f.good(f.author, "/tasks/" + task._id + "/actions", {
      action: "publish",
      expected_revision: task.revision,
    });
    await f.good(f.author, "/ai/config", {
      enabled: true,
      daily_limit: 1,
      expected_revision: 0,
    });
    const original = global.fetch;
    global.fetch = async (url, options) => {
      if (url === "https://provider.invalid/chat") {
        const sent = JSON.parse(JSON.parse(options.body).messages[1].content);
        assert.deepEqual(JSON.parse(sent.sources[0].text), {
          assigned: 1,
          submitted: 0,
        });
        assert.ok(!options.body.includes(f.student.user.user_id));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    text: "尚无提交，请提醒学员完成实践。",
                    source_keys: ["task-summary"],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return original(url, options);
    };
    t.after(() => {
      global.fetch = original;
    });
    const job = await f.good(f.author, "/ai/jobs", {
      kind: "report",
      context_id: task._id,
      prompt: "解释任务完成情况",
    });
    await f.good(f.author, "/ai/jobs/" + job.id + "/dispatch", {
      expected_revision: 1,
    });
    await f.good(f.student, "/tasks/" + task._id + "/coursework", {
      expected_revision: 0,
      action: "submit",
      body: "已完成实践",
    });
    status(await f.req(f.author, "/ai/jobs/" + job.id), 409);
    const listed = (await f.good(f.author, "/ai/jobs")).items.find(
      (x) => x.id === job.id,
    );
    assert.equal(listed.output, "");
    assert.equal(listed.error_code, "CONTEXT_CHANGED");
  },
);

test(
  "作业：跨越截止的最终 head 写入被 DB 时间条件拒绝并整体回滚",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t);
    let task = await f.good(f.author, "/tasks", {
      class_id: f.classId,
      subject_id: f.subject,
      title: "截止写入栅栏",
      target_type: "coursework",
      target_id: null,
      due_at: new Date(Date.now() + 60000).toISOString(),
      body: "写入不得越过截止",
      rubric: [{ key: "quality", title: "质量", weight: 100 }],
    });
    task = await f.good(f.author, "/tasks/" + task._id + "/actions", {
      action: "publish",
      expected_revision: 1,
    });
    const due = new Date(Date.now() + 2000);
    await f.db
      .collection("training_tasks")
      .updateOne({ _id: task._id }, { $set: { due_at: due } });
    const service = f.app.get(
        require("../dist/training/training.service").TrainingService,
      ),
      original = service.fenceTaskFacts;
    let reached = false;
    service.fenceTaskFacts = async function (ctx, current) {
      await original.call(this, ctx, current);
      if (current._id === task._id) {
        reached = true;
        await new Promise((r) =>
          setTimeout(r, Math.max(0, due.getTime() - Date.now() + 40)),
        );
      }
    };
    t.after(() => {
      service.fenceTaskFacts = original;
    });
    const response = await f.req(
      f.student,
      "/tasks/" + task._id + "/coursework",
      {
        expected_revision: 0,
        action: "submit",
        body: "截止前发出，最终写入已过期",
      },
    );
    status(response, 409);
    assert.equal(response.data.error.code, "DEADLINE_PASSED");
    assert.equal(reached, true);
    assert.equal(
      await f.db
        .collection("coursework_heads")
        .countDocuments({ task_id: task._id }),
      0,
    );
    assert.equal(
      await f.db
        .collection("coursework_submissions")
        .countDocuments({ task_id: task._id }),
      0,
    );
    assert.equal(
      (await f.db.collection("training_tasks").findOne({ _id: task._id }))
        .revision,
      task.revision,
    );
  },
);

test(
  "AI管理恢复：来源失效队列最小披露、跨组织拒绝、预算释放和幂等竞争",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t, {
      KL_AI_ENDPOINT: "https://provider.invalid/chat",
      KL_AI_MODEL: "transport-test",
      KL_AI_API_KEY: "transport-test-value",
    });
    const c = await course(f);
    await f.good(f.author, "/ai/config", {
      enabled: true,
      daily_limit: 4,
      expected_revision: 0,
    });
    const queued = await f.good(f.author, "/ai/jobs", {
      kind: "prepare",
      context_id: c._id,
      prompt: "不得向管理恢复队列披露的问题",
    });
    const running = await f.good(f.author, "/ai/jobs", {
      kind: "prepare",
      context_id: c._id,
      prompt: "调用中的私有问题",
    });
    await f.db.collection("ai_jobs").updateOne(
      { _id: running.id },
      {
        $set: { status: "running", dispatch_started_at: new Date() },
        $inc: { revision: 1 },
      },
    );
    const manager = await f.actor(["teacher"], ["ai:manage"]);
    status(await f.req(f.student, "/ai/recovery"), 403);
    const otherOrg = (
      await f.ops.createOrganization(f.context, {
        name: "其他恢复组织",
        kind: "school",
      })
    ).organization_id;
    await f.ops.setMembership(f.context, {
      user_id: manager.user.user_id,
      org_id: otherOrg,
      roles: ["teacher"],
    });
    const foreign = await f.db
      .collection("organization_members")
      .findOne({ user_id: manager.user.user_id, org_id: otherOrg });
    await f.ops.setCapability(f.context, {
      org_id: otherOrg,
      member_id: foreign._id,
      capability: "ai:manage",
      granted: true,
      expected_revision: foreign.authorization_revision,
      valid_to: new Date(Date.now() + 3600000),
    });
    const foreignQueue = await manager.browser.request(
      "/training/ai/recovery",
      { headers: { "X-Org-Id": otherOrg } },
    );
    status(foreignQueue, 200);
    assert.deepEqual(foreignQueue.data.data.items, []);
    status(
      await manager.browser.request(
        "/training/ai/jobs/" + queued.id + "/recover",
        {
          method: "POST",
          body: { expected_revision: 1 },
          headers: { "X-Org-Id": otherOrg, "Idempotency-Key": randomUUID() },
        },
      ),
      404,
    );
    await f.good(f.reviewer, "/courses/" + c._id + "/actions", {
      action: "retire",
      expected_revision: c.revision,
      note: "隔离恢复验收退役",
    });
    assert.deepEqual((await f.good(f.author, "/ai/jobs")).items, []);
    const queue = await f.good(manager, "/ai/recovery");
    assert.equal(queue.truncated, false);
    assert.equal(queue.items.length, 2);
    for (const row of queue.items)
      assert.deepEqual(
        Object.keys(row).sort(),
        [
          "id",
          "kind",
          "status",
          "revision",
          "created_at",
          "dispatch_started_at",
          "recoverable",
        ].sort(),
      );
    assert.equal(queue.items.find((x) => x.id === queued.id).recoverable, true);
    assert.equal(
      queue.items.find((x) => x.id === running.id).recoverable,
      false,
    );
    status(
      await f.req(manager, "/ai/jobs/" + running.id + "/recover", {
        expected_revision: 2,
      }),
      409,
    );
    const key = randomUUID(),
      payload = { expected_revision: 1 };
    const results = await Promise.all([
      f.req(manager, "/ai/jobs/" + queued.id + "/recover", payload, key),
      f.req(manager, "/ai/jobs/" + queued.id + "/recover", payload, key),
    ]);
    results.forEach((r) => status(r, 200));
    assert.deepEqual(results[0].data.data, results[1].data.data);
    assert.equal(results[0].data.data.status, "cancelled");
    assert.equal("context_id" in results[0].data.data, false);
    const receipt = await f.good(manager, "/receipts/query", { key });
    assert.equal(receipt.status, "confirmed");
    assert.equal("output" in receipt.result, false);
    let ledger = await f.db
      .collection("ai_usage_ledger")
      .findOne({ org_id: f.org });
    assert.equal(ledger.reserved, 1);
    assert.equal(ledger.used, 0);
    assert.equal(ledger.unknown, 0);
    await f.db
      .collection("ai_jobs")
      .updateOne(
        { _id: running.id },
        { $set: { dispatch_started_at: new Date(Date.now() - 61000) } },
      );
    const old = await f.good(manager, "/ai/jobs/" + running.id + "/recover", {
      expected_revision: 2,
    });
    assert.equal(old.status, "unknown");
    ledger = await f.db
      .collection("ai_usage_ledger")
      .findOne({ org_id: f.org });
    assert.equal(ledger.reserved, 0);
    assert.equal(ledger.unknown, 1);
    assert.deepEqual((await f.good(manager, "/ai/recovery")).items, []);
    const audit = await f.db
      .collection("audit_events")
      .find({ org_id: f.org, action: "training.ai.recover" })
      .toArray();
    assert.equal(audit.length, 2);
  },
);

test(
  "培训任务：草稿取消、原键回执、发布取消后只读访问拒绝与服务端时间",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t);
    const body = {
      class_id: f.classId,
      subject_id: f.subject,
      title: "任务取消验收",
      target_type: "coursework",
      target_id: null,
      due_at: new Date(Date.now() + 60000).toISOString(),
      body: "原创作业",
      rubric: [{ key: "quality", title: "质量", weight: 100 }],
    };
    let draft = await f.good(f.author, "/tasks", body);
    const key = randomUUID();
    const cancel = { action: "cancel", expected_revision: draft.revision };
    draft = await f.good(
      f.author,
      "/tasks/" + draft._id + "/actions",
      cancel,
      key,
    );
    assert.equal(draft.status, "cancelled");
    assert.equal(
      (await f.good(f.author, "/tasks/" + draft._id + "/actions", cancel, key))
        .revision,
      draft.revision,
    );
    status(
      await f.req(f.author, "/tasks/" + draft._id + "/actions", {
        action: "publish",
        expected_revision: draft.revision,
      }),
      409,
    );
    let task = await f.good(f.author, "/tasks", {
      ...body,
      title: "发布取消验收",
    });
    task = await f.good(f.author, "/tasks/" + task._id + "/actions", {
      action: "publish",
      expected_revision: task.revision,
    });
    const work = await f.good(f.student, "/tasks/" + task._id + "/coursework");
    assert.ok(Number.isFinite(Date.parse(work.server_now)));
    const head = await f.good(f.student, "/tasks/" + task._id + "/coursework", {
      action: "submit",
      expected_revision: 0,
      body: "原创提交",
    });
    task = (await f.good(f.author, "/tasks")).items.find(
      (x) => x._id === task._id,
    );
    await f.good(f.author, "/tasks/" + task._id + "/actions", {
      action: "cancel",
      expected_revision: task.revision,
    });
    status(await f.req(f.student, "/tasks/" + task._id + "/coursework"), 404);
    status(
      await f.req(f.student, "/tasks/" + task._id + "/coursework", {
        action: "save",
        expected_revision: head.revision,
        body: "取消后写入",
      }),
      404,
    );
    assert.equal(
      await f.db
        .collection("coursework_submissions")
        .countDocuments({ task_id: task._id }),
      1,
    );
  },
);

function attachmentMetadata(f, head, state = "ready", scan = "clean") {
  const ctx = { orgId: f.org, userId: f.student.user.user_id };
  const input = {
    owner_type: "coursework",
    owner_version_id: head._id,
    display_name: "原创.txt",
    size: 12,
    mime: "text/plain",
    checksum: "a".repeat(64),
  };
  const now = new Date();
  const file = {
    _id: newId(),
    org_id: ctx.orgId,
    owner_type: input.owner_type,
    owner_version_id: input.owner_version_id,
    created_by: ctx.userId,
    display_name: input.display_name,
    storage_key: randomUUID(),
    declared_size: input.size,
    declared_mime: input.mime,
    declared_checksum: input.checksum,
    size: null,
    mime: null,
    checksum: null,
    status: "pending",
    scan_status: "awaiting_upload",
    scan_attempt: 0,
    lease_token: null,
    lease_until: null,
    available_at: now,
    uploaded_at: null,
    error_code: null,
    created_at: now,
    updated_at: now,
    upload_key: null,
    upload_lease_token: null,
    upload_lease_until: null,
    upload_storage_key: null,
    upload_storage_keys: [],
    upload_owner_revision: null,
    upload_result_revision: null,
    retention_until: null,
    legal_hold: false,
    deletion_requested_at: null,
    deletion_requested_by: null,
    deletion_requested_reason: null,
    deleted_at: null,
    deletion_lease_token: null,
    deletion_lease_until: null,
    deletion_attempt: 0,
    scan_engine_version: null,
    scan_database_version: null,
    scan_database_updated_at: null,
    scanned_at: null,
  };
  if (state !== "pending")
    Object.assign(file, {
      status: state,
      scan_status: scan,
      size: 12,
      mime: "text/plain",
      checksum: input.checksum,
      uploaded_at: now,
      upload_result_revision: head.revision,
    });
  return file;
}
test(
  "作业附件v12：元数据权限、冻结引用、隔离扫描拒绝及旧迁移不变（非落盘扫描验收）",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t, {
      KL_COURSEWORK_FILES_ENABLED: "true",
      FILE_SCAN_ENABLED: "false",
    });
    const { systemBackupRegistry } = require("../dist/migrations/schema");
    const { TRAINING_CHECKSUM } = require("../dist/training/schema");
    assert.equal(systemBackupRegistry().version, 22); // Current authentication baseline; the v12 marker/checksum is checked below.
    assert.equal(
      (await f.db.collection("schema_migrations").findOne({ version: 11 }))
        .checksum,
      TRAINING_CHECKSUM,
    );
    assert.equal(
      (await f.db.collection("schema_migrations").findOne({ version: 12 }))
        .status,
      "completed",
    );
    let task = await f.good(f.author, "/tasks", {
      class_id: f.classId,
      subject_id: f.subject,
      title: "附件测试",
      target_type: "coursework",
      target_id: null,
      due_at: new Date(Date.now() + 60000).toISOString(),
      body: "原创题面",
      rubric: [{ key: "q", title: "质量", weight: 100 }],
    });
    task = await f.good(f.author, "/tasks/" + task._id + "/actions", {
      action: "publish",
      expected_revision: task.revision,
    });
    let head = await f.good(f.student, "/tasks/" + task._id + "/coursework", {
      action: "save",
      expected_revision: 0,
      body: "原创正文",
    });
    status(
      await f.req(f.student, "/tasks/" + task._id + "/files", {
        expected_revision: head.revision,
        display_name: "a.txt",
        size: 12,
        mime: "text/plain",
        checksum: "a".repeat(64),
      }),
      503,
    );
    const file = attachmentMetadata(f, head);
    await f.db.collection("file_resources").insertOne(file);
    status(await f.req(f.stranger, "/coursework-files/" + file._id), 404);
    status(await f.req(f.author, "/coursework-files/" + file._id), 404);
    const quarantined = attachmentMetadata(f, head, "quarantined", "queued");
    await f.db.collection("file_resources").insertOne(quarantined);
    status(
      await f.req(f.student, "/tasks/" + task._id + "/coursework", {
        action: "submit",
        expected_revision: head.revision,
        body: "原创正文",
        file_ids: [quarantined._id],
      }),
      409,
    );
    status(
      await f.req(f.student, "/tasks/" + task._id + "/coursework", {
        action: "submit",
        expected_revision: head.revision,
        body: "原创正文",
        file_ids: [file._id, file._id],
      }),
      422,
    );
    head = await f.good(f.student, "/tasks/" + task._id + "/coursework", {
      action: "submit",
      expected_revision: head.revision,
      body: "原创正文",
      file_ids: [file._id],
    });
    const work = await f.good(f.student, "/tasks/" + task._id + "/coursework");
    assert.deepEqual(work.head.file_ids, [file._id]);
    assert.deepEqual(work.submissions[0].file_ids, [file._id]);
    assert.equal(
      (await f.good(f.author, "/coursework-files/" + file._id)).id,
      file._id,
    );
    const { fileReferenced } = require("../dist/files/references");
    const session = f.db.client.startSession();
    try {
      session.startTransaction();
      assert.equal(await fileReferenced(f.db, file._id, session), true);
      await session.abortTransaction();
    } finally {
      await session.endSession();
    }
    const { rawDatabase } = require("../dist/database/object-id");
    const raw = await rawDatabase(f.db)
      .collection("coursework_heads")
      .findOne({});
    assert.equal(raw.file_ids[0]._bsontype, "ObjectId");
    await f.db
      .collection("class_members")
      .updateOne(
        { member_id: f.student.member },
        { $set: { status: "ended" } },
      );
    status(await f.req(f.student, "/coursework-files/" + file._id), 404);
    status(await f.req(f.author, "/coursework-files/" + file._id), 404);
  },
);

async function setupCourseworkLedger(t) {
  const {mkdtemp,mkdir,rm,realpath}=require("node:fs/promises");
  const {join}=require("node:path");const {tmpdir}=require("node:os");
  const {MongoClient}=require("mongodb");const {randomBytes}=require("node:crypto");
  const {guardedUri}=require("./helpers.cjs");
  const exec=require("node:util").promisify(require("node:child_process").execFile);
  const source = guardedUri(process.env.TEST_MONGODB_URI);
  const controlName = `kl_control_privacy_${randomUUID().replaceAll("-", "")}`;
  const controlUri = source.replace(/(mongodb(?:\+srv)?:\/\/[^/]+\/)[^?]+/, `$1${controlName}`);
  const parent = await realpath(process.env.TEST_FILE_STORAGE_PARENT || tmpdir());
  const root = await mkdtemp(join(parent, "knowladder-privacy-ledger-"));
  const primary = join(root, "primary"), mirror = join(root, "mirror");
  const control = new MongoClient(controlUri, { serverSelectionTimeoutMS: 5000 });
  let connected = false;
  t.after(async () => {
    try {
      if (connected) {
        assert.equal(control.db().databaseName, controlName);
        assert.match(controlName, /^kl_control_privacy_[a-f0-9]{32}$/);
        await control.db().dropDatabase();
      }
    } finally {
      await control.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  await mkdir(primary, { mode: 0o700 });
  await mkdir(mirror, { mode: 0o700 });
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($path in @($env:KL_TEST_PRIVATE_ROOT,$env:KL_TEST_PRIVATE_PRIMARY,$env:KL_TEST_PRIVATE_MIRROR)) {
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
}`;
    await exec(join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { env: { ...process.env, KL_TEST_PRIVATE_ROOT: root, KL_TEST_PRIVATE_PRIMARY: primary, KL_TEST_PRIVATE_MIRROR: mirror }, windowsHide: true, timeout: 10000 });
    const { assertWindowsPrivateDirectory } = require("../dist/security/private-directory.js");
    await assertWindowsPrivateDirectory(primary);
    await assertWindowsPrivateDirectory(mirror);
  }
  await control.connect();
  connected = true;
  assert.ok((await control.db("admin").command({ hello: 1 })).setName, "control 必须是真实副本集");
  return { KL_ENVIRONMENT_ID: randomUUID(), KL_CONTROL_MONGODB_URI: controlUri,
    KL_SAFETY_LEDGER_ROOT: primary, KL_SAFETY_LEDGER_MIRROR_ROOT: mirror,
    KL_SAFETY_LEDGER_KEY: randomBytes(32).toString("hex") };
}

test("作业附件保留：真实独立加密账本、head栅栏、单调延期与冻结后拒绝（元数据夹具）",{timeout:180000},async t=>{
  const env=await setupCourseworkLedger(t);
  const f=await setup(t,{...env,KL_COURSEWORK_FILES_ENABLED:'true'});
  let task=await f.good(f.author,'/tasks',{class_id:f.classId,subject_id:f.subject,title:'保留账本',target_type:'coursework',target_id:null,due_at:new Date(Date.now()+120000).toISOString(),body:'原创题面',rubric:[{key:'q',title:'质量',weight:100}]});
  task=await f.good(f.author,'/tasks/'+task._id+'/actions',{action:'publish',expected_revision:task.revision});
  const head=await f.good(f.student,'/tasks/'+task._id+'/coursework',{action:'save',expected_revision:0,body:'原创正文'});
  const file=attachmentMetadata(f,head);await f.db.collection('file_resources').insertOne(file);
  for(const app of f.apps.splice(0))await app.close();
  const control=require('../dist/operations/control');const ledger=require('../dist/operations/ledger');
  await control.registerEnvironment(f.client,f.db,{environmentId:env.KL_ENVIRONMENT_ID,fileRoot:null,actor:'coursework-retention-test',reason:'synthetic local ledger'});
  const {setFileHold}=require('../dist/files/files.service');
  const {extendCourseworkFileRetention}=require('../dist/files/coursework-retention');
  const actor={actor:'coursework-retention-test',reason:'synthetic original metadata'};
  await setFileHold(f.client,f.db,{fileId:file._id,hold:true,...actor});
  await setFileHold(f.client,f.db,{fileId:file._id,hold:true,...actor});
  assert.equal((await f.db.collection('coursework_heads').findOne({_id:head._id})).revision,head.revision+1);
  assert.equal((await f.db.collection('file_resources').findOne({_id:file._id})).legal_hold,true);
  await setFileHold(f.client,f.db,{fileId:file._id,hold:false,...actor});
  const later=new Date(Date.now()+120000).toISOString(),earlier=new Date(Date.now()+60000).toISOString();
  await extendCourseworkFileRetention(f.client,f.db,{fileId:file._id,retentionUntil:later,...actor});
  await extendCourseworkFileRetention(f.client,f.db,{fileId:file._id,retentionUntil:earlier,...actor});
  assert.equal((await f.db.collection('file_resources').findOne({_id:file._id})).retention_until.toISOString(),later);
  const safety=await ledger.readSafetyLedger(env.KL_ENVIRONMENT_ID,0);
  assert.equal(safety.pending,false);
  assert.equal(safety.entries.filter(x=>x.action==='file.hold').length,2);
  assert.equal(safety.entries.filter(x=>x.action==='file.retention').length,2);
  assert.ok(safety.entries.every(x=>x.state==='committed'));
  const cliUntil=new Date(Date.now()+180000).toISOString();
  const exec=require('node:util').promisify(require('node:child_process').execFile);
  const cli=await exec(process.execPath,['dist/operations/cli.js','coursework-retention','--file-id',file._id,'--retention-until',cliUntil,'--actor',actor.actor,'--reason','synthetic CLI retention'],{cwd:require('node:path').resolve(__dirname,'..'),env:{...process.env,MONGODB_URI:f.uri},windowsHide:true,timeout:30000});
  assert.equal(JSON.parse(cli.stdout.trim()).fileId,file._id);
  assert.equal((await f.db.collection('file_resources').findOne({_id:file._id})).retention_until.toISOString(),cliUntil);
  assert.equal(await f.db.collection('operational_writers').countDocuments({state:'running'}),0);
  const pendingId=ledger.safetyOperationId('coursework-abort-test');
  await ledger.reserveSafetyIntent(f.db,{operationId:pendingId,action:'file.hold',resourceId:file._id,resourceType:'file',hold:true});
  const beforeAbort=await f.db.collection('coursework_heads').findOne({_id:head._id});
  const state=await control.getOperationalState(f.db);
  const maintenance=await control.enterMaintenance(f.client,f.db,{expectedRevision:state.revision,...actor});
  await ledger.reconcileSafetyIntent(f.db,{operationId:pendingId,decision:'abort',maintenanceToken:maintenance.token,...actor});
  assert.equal((await f.db.collection('coursework_heads').findOne({_id:head._id})).revision,beforeAbort.revision+1);
  assert.equal((await f.db.collection('coursework_heads').findOne({_id:head._id})).access_revision,undefined);
  await control.leaveMaintenance(f.client,f.db,{token:maintenance.token,...actor});
  await f.db.collection('users').updateOne({_id:f.student.user.user_id},{$set:{privacy_state:'erasing'}});
  await assert.rejects(setFileHold(f.client,f.db,{fileId:file._id,hold:true,actor:actor.actor,reason:'blocked subject'}));
  assert.equal((await f.db.collection('file_resources').findOne({_id:file._id})).legal_hold,false);
});

for(const keep of [false,true])test('作业附件隐私：真实私有字节'+(keep?'保全留存':'物理擦除与墓碑幂等'),{timeout:180000},async t=>{
 const env=await setupCourseworkLedger(t);
 const fs=require('node:fs/promises'),path=require('node:path');const storage=path.join(path.dirname(env.KL_SAFETY_LEDGER_ROOT),'files');await fs.mkdir(storage,{mode:0o700});
 if(process.platform==='win32'){const script=`$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')));Set-Acl -LiteralPath $env:KL_TEST_FILES_PRIVATE -AclObject $acl`;await require('node:util').promisify(require('node:child_process').execFile)(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,env:{...process.env,KL_TEST_FILES_PRIVATE:storage},timeout:10000});}
 const f=await setup(t,{...env,KL_COURSEWORK_FILES_ENABLED:'true',FILE_STORAGE_ROOT:storage});
 await require('../dist/files/config').storageRoot();
 let task=await f.good(f.author,'/tasks',{class_id:f.classId,subject_id:f.subject,title:'隐私字节验收',target_type:'coursework',target_id:null,due_at:new Date(Date.now()+120000).toISOString(),body:'原创题面',rubric:[{key:'q',title:'质量',weight:100}]});task=await f.good(f.author,'/tasks/'+task._id+'/actions',{action:'publish',expected_revision:task.revision});
 const head=await f.good(f.student,'/tasks/'+task._id+'/coursework',{action:'save',expected_revision:0,body:'原创正文'});
 const file=attachmentMetadata(f,head);file.upload_storage_keys=[randomUUID()];await f.db.collection('file_resources').insertOne(file);
 const bytes=Buffer.from('original privacy bytes');const files=[];for(const key of [file.storage_key,...file.upload_storage_keys])for(const area of ['tmp','quarantine','ready']){const filename=path.join(storage,area,key);await fs.writeFile(filename,bytes,{mode:0o600});files.push(filename);}
 for(const app of f.apps.splice(0))await app.close();const control=require('../dist/operations/control');await control.registerEnvironment(f.client,f.db,{environmentId:env.KL_ENVIRONMENT_ID,fileRoot:storage,actor:'privacy-bytes',reason:'original disposable privacy evidence'});
 if(keep)await require('../dist/files/files.service').setFileHold(f.client,f.db,{fileId:file._id,hold:true,actor:'privacy-bytes',reason:'retain original bytes'});
 const privacy=require('../dist/privacy/execution'),now=new Date(),id=newId(),user=f.student.user.user_id;
 await f.db.collection('privacy_deletion_requests').insertOne({_id:id,user_id:user,scope:'account',policy_revision:'local_privacy_v1',status:'requested',revision:0,plan_hash:null,actor:null,reason_code:null,deleted_categories:[],retained_categories:[],retention_basis:null,remaining_actions:[],created_at:now,updated_at:now,lease_token:null,lease_until:null,ledger_sequence:null,completed_steps:[]});
 const plan=await privacy.inspectPrivacyRequest(f.db,id);assert.equal(plan.categories.coursework_file_bytes,1);assert.equal(plan.assessment_held,keep);
 await privacy.approvePrivacyRequest(f.client,f.db,{requestId:id,expectedRevision:plan.revision,planHash:plan.plan_hash,retentionBasis:keep?'local_hold_and_provenance':'local_minimal_provenance',actor:'privacy-bytes',reason:'approved disposable erasure'});
 let packageFile,packageKey,backupApi;
 if(!keep){backupApi=require('../../ops/system-backup.cjs');packageFile=path.join(await courseworkPrivateChild(env,'archives'),'coursework-old.klb');packageKey=require('node:crypto').randomBytes(32);const state=await control.getOperationalState(f.db);const maintenance=await control.enterMaintenance(f.client,f.db,{expectedRevision:state.revision,actor:'privacy-bytes',reason:'old snapshot before erasure'});await backupApi.backup({client:f.client,db:f.db,file:packageFile,key:packageKey,root:storage,maintenanceToken:maintenance.token});await control.leaveMaintenance(f.client,f.db,{token:maintenance.token,actor:'privacy-bytes',reason:'resume approved erasure'});}
 if(!keep){const unsafe=path.join(storage,'ready',file.storage_key);await fs.unlink(unsafe);await fs.mkdir(unsafe);await assert.rejects(privacy.executePrivacyRequest(f.client,f.db,{requestId:id,actor:'privacy-bytes',reason:'interruption negative case'}),e=>['PRIVACY_FILE_PATH_UNSAFE','STORAGE_OBJECT_UNSAFE'].includes(e.message));assert.equal((await f.db.collection('users').findOne({_id:user})).privacy_state,'erasing');assert.equal((await f.db.collection('privacy_deletion_requests').findOne({_id:id})).status,'failed');assert.ok(await f.db.collection('coursework_heads').findOne({_id:head._id}));await fs.rmdir(unsafe);await fs.writeFile(unsafe,bytes,{mode:0o600});await f.db.collection('file_resources').updateOne({_id:file._id},{$set:{deletion_lease_until:new Date(0)}});}
 const result=await privacy.executePrivacyRequest(f.client,f.db,{requestId:id,actor:'privacy-bytes',reason:'disposable erasure'});assert.equal(result.status,'completed_with_retention');
 assert.equal((await f.db.collection('users').findOne({_id:user})).privacy_state,'erased');
 const row=await f.db.collection('file_resources').findOne({_id:file._id});
 if(keep){assert.equal(row.deleted_at,null);assert.ok(await f.db.collection('coursework_heads').findOne({_id:head._id}));for(const filename of files)assert.deepEqual(await fs.readFile(filename),bytes);}else{assert.ok(row.deleted_at instanceof Date);assert.equal(row.display_name,'[erased]');assert.equal(await f.db.collection('coursework_heads').findOne({_id:head._id}),null);for(const filename of files)await assert.rejects(fs.access(filename),{code:'ENOENT'});await privacy.executePrivacyRequest(f.client,f.db,{requestId:id,actor:'privacy-bytes',reason:'repeat'});await require('../dist/privacy/coursework-files').eraseCourseworkFileBytes(f.db,user,id);}
 if(!keep){const restoreRoot=path.join(path.dirname(storage),'restored');await fs.mkdir(restoreRoot,{mode:0o700});if(process.platform==='win32'){const script="$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')));Set-Acl -LiteralPath $env:KL_TEST_FILES_PRIVATE -AclObject $acl";await require('node:util').promisify(require('node:child_process').execFile)(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:{...process.env,KL_TEST_FILES_PRIVATE:restoreRoot},windowsHide:true});}
 const name='kl_restore_coursework_'+randomUUID().replaceAll('-','');const restoreClient=new(require('mongodb').MongoClient)(f.uri.replace(/\/kl_test_[^?]+/,'/'+name));await restoreClient.connect();const restoreDb=require('../dist/database/object-id').objectIdDatabase(restoreClient.db());t.after(async()=>{assert.equal(restoreClient.db().databaseName,name);await restoreClient.db().dropDatabase();await restoreClient.close();});
 process.env.FILE_STORAGE_ROOT=restoreRoot;try{const restored=await backupApi.restore({client:restoreClient,db:restoreDb,file:packageFile,key:packageKey,root:restoreRoot});assert.equal(restored.status,'quarantined');const checked=await backupApi.verifyRestore({db:restoreDb,file:packageFile,key:packageKey,root:restoreRoot,restoreId:restored.restore_id,apply:true});assert.equal(checked.status,'ready');assert.equal((await restoreDb.collection('users').findOne({_id:user})).privacy_state,'erased');assert.equal(await restoreDb.collection('coursework_heads').findOne({_id:head._id}),null);for(const area of ['tmp','quarantine','ready'])assert.deepEqual(await fs.readdir(path.join(restoreRoot,area)),[]);}finally{process.env.FILE_STORAGE_ROOT=storage;packageKey.fill(0);}}
 const ledger=await require('../dist/operations/ledger').readSafetyLedger(env.KL_ENVIRONMENT_ID,0);assert.equal(ledger.pending,false);
});

async function courseworkPrivateChild(env,name){const fs=require('node:fs/promises'),path=require('node:path');const folder=path.join(path.dirname(env.KL_SAFETY_LEDGER_ROOT),name);await fs.mkdir(folder,{mode:0o700});if(process.platform==='win32'){const script="$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')));Set-Acl -LiteralPath $env:KL_TEST_FILES_PRIVATE -AclObject $acl";await require('node:util').promisify(require('node:child_process').execFile)(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:{...process.env,KL_TEST_FILES_PRIVATE:folder},windowsHide:true});}return folder;}
test('作业附件真实扫描：登记原key、上传丢响应、实际clean交付、冻结引用与退班拒绝',{timeout:300000},async t=>{
 assert.ok(process.env.TEST_CLAMSCAN_PATH);assert.ok(process.env.TEST_CLAMAV_DATABASE);
 const env=await setupCourseworkLedger(t),storage=await courseworkPrivateChild(env,'scan-files');
 const f=await setup(t,{...env,KL_COURSEWORK_FILES_ENABLED:'true',FILE_SCAN_ENABLED:'true',FILE_STORAGE_ROOT:storage,CLAMSCAN_PATH:process.env.TEST_CLAMSCAN_PATH,CLAMAV_DATABASE:process.env.TEST_CLAMAV_DATABASE,SCAN_DATABASE_MAX_AGE_HOURS:'168',SCAN_TIMEOUT_MS:'60000'});
 let task=await f.good(f.author,'/tasks',{class_id:f.classId,subject_id:f.subject,title:'真实上传',target_type:'coursework',target_id:null,due_at:new Date(Date.now()+240000).toISOString(),body:'原创题面',rubric:[{key:'q',title:'质量',weight:100}]});task=await f.good(f.author,'/tasks/'+task._id+'/actions',{action:'publish',expected_revision:task.revision});
 let head=await f.good(f.student,'/tasks/'+task._id+'/coursework',{action:'save',expected_revision:0,body:'原创正文'});
 const bytes=Buffer.from('original coursework scanner proof\n'),checksum=require('node:crypto').createHash('sha256').update(bytes).digest('hex'),key=randomUUID();const declaration={expected_revision:head.revision,display_name:'original.txt',size:bytes.length,mime:'text/plain',checksum};const file=await f.good(f.student,'/tasks/'+task._id+'/files',declaration,key);assert.equal((await f.good(f.student,'/tasks/'+task._id+'/files',declaration,key)).id,file.id);assert.equal(await f.db.collection('file_resources').countDocuments({owner_type:'coursework'}),1);
 const browser=f.student.browser,headers={'Content-Type':'application/octet-stream','Content-Length':String(bytes.length),'X-Org-Id':f.org,'X-CSRF-Token':browser.csrf,'Idempotency-Key':randomUUID(),'X-Owner-Revision':String(file.owner_revision),Origin:require('./helpers.cjs').ORIGIN,Cookie:[...browser.cookies].map(([k,v])=>k+'='+v).join('; ')};
 const http=require('node:http');let uploadRequests=0,committedStatus;const proxy=http.createServer((req,res)=>{const upstream=http.request(new URL(req.url,browser.base),{method:req.method,headers:req.headers},response=>{const chunks=[];response.on('data',b=>chunks.push(b));response.on('end',()=>{if(req.method==='PUT'){uploadRequests++;committedStatus=response.statusCode;res.destroy();}else{res.writeHead(response.statusCode,response.headers);res.end(Buffer.concat(chunks));}});});upstream.on('error',()=>res.destroy());req.pipe(upstream);});await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>proxy.close(resolve)));
 await assert.rejects(fetch('http://127.0.0.1:'+proxy.address().port+'/api/v1/training/coursework-files/'+file.id+'/content',{method:'PUT',headers,body:bytes,signal:AbortSignal.timeout(120000)}));assert.equal(committedStatus,200);assert.equal(uploadRequests,1);
 assert.equal((await f.good(f.student,'/coursework-files/'+file.id)).upload_confirmed,true);const {processOne}=require('../dist/files/worker');assert.equal(await processOne(f.db),true);const state=await f.good(f.student,'/coursework-files/'+file.id);assert.equal(state.status,'ready');assert.equal(state.scan_status,'clean');const scanned=await f.db.collection('file_resources').findOne({_id:file.id});assert.ok(scanned.scan_engine_version);assert.ok(scanned.scanned_at instanceof Date);
 const download=await fetch(browser.base+'/api/v1/training/coursework-files/'+file.id+'/content',{headers});assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);assert.match(download.headers.get('cache-control'),/no-store/);
 head=(await f.good(f.student,'/tasks/'+task._id+'/coursework')).head;await f.good(f.student,'/tasks/'+task._id+'/coursework',{action:'submit',expected_revision:head.revision,body:'原创正文',file_ids:[file.id]});const teacherHeaders={'X-Org-Id':f.org,Cookie:[...f.author.browser.cookies].map(([k,v])=>k+'='+v).join('; '),Range:'bytes=0-7'};const ranged=await fetch(browser.base+'/api/v1/training/coursework-files/'+file.id+'/content',{headers:teacherHeaders});assert.equal(ranged.status,206);assert.deepEqual(Buffer.from(await ranged.arrayBuffer()),bytes.subarray(0,8));
 await f.db.collection('class_members').updateOne({member_id:f.student.member},{$set:{status:'ended'}});assert.equal((await fetch(browser.base+'/api/v1/training/coursework-files/'+file.id+'/content',{headers})).status,404);assert.equal((await fetch(browser.base+'/api/v1/training/coursework-files/'+file.id+'/content',{headers:teacherHeaders})).status,404);
});

test('AI v13：逐能力、金额并发预留、取消释放、未知保守占用与币种锁定（传输夹具）',{timeout:180000},async t=>{
 const f=await setup(t,{KL_AI_POLICY_ENABLED:'true',KL_AI_ENDPOINT:'https://provider.invalid/chat',KL_AI_MODEL:'transport-test',KL_AI_API_KEY:'transport-test-value'}),c=await course(f);
 assert.equal(require('../dist/migrations/schema').systemBackupRegistry().version,22);assert.equal((await f.db.collection('schema_migrations').findOne({version:13})).status,'completed');
 const config={enabled:true,daily_limit:10,expected_revision:0,enabled_kinds:['prepare'],currency:'CNY',daily_budget_micro:600000,max_request_micro:300000};await f.good(f.author,'/ai/config',config);
 status(await f.req(f.student,'/ai/jobs',{kind:'assist',context_id:c._id,prompt:'原创问题'}),503);
 const create=(prompt)=>f.req(f.author,'/ai/jobs',{kind:'prepare',context_id:c._id,prompt});
 const emptyCurrency=await f.good(f.author,'/ai/jobs',{kind:'prepare',context_id:c._id,prompt:'币种空占用校验'});await f.good(f.author,'/ai/jobs/'+emptyCurrency.id+'/cancel',{expected_revision:emptyCurrency.revision});let idleProfile=(await f.good(f.author,'/ai/status')).profile;await f.good(f.author,'/ai/config',{...config,expected_revision:idleProfile.revision,currency:'USD'});const usd=await f.good(f.author,'/ai/jobs',{kind:'prepare',context_id:c._id,prompt:'零占用后切换币种'});assert.equal((await f.db.collection('ai_usage_ledger').findOne({org_id:f.org})).currency,'USD');await f.good(f.author,'/ai/jobs/'+usd.id+'/cancel',{expected_revision:usd.revision});idleProfile=(await f.good(f.author,'/ai/status')).profile;await f.good(f.author,'/ai/config',{...config,expected_revision:idleProfile.revision});
 const results=await Promise.all(['a','b','c'].map(create));assert.deepEqual(results.map(x=>x.status).sort(),[200,200,429]);const jobs=results.filter(x=>x.status===200).map(x=>x.data.data);
 let ledger=await f.db.collection('ai_usage_ledger').findOne({org_id:f.org});assert.equal(ledger.reserved_micro,600000);assert.equal(ledger.currency,'CNY');
 await f.good(f.author,'/ai/jobs/'+jobs[0].id+'/cancel',{expected_revision:jobs[0].revision});ledger=await f.db.collection('ai_usage_ledger').findOne({org_id:f.org});assert.equal(ledger.reserved_micro,300000);
 const original=global.fetch;let calls=0;global.fetch=async(url,options)=>{if(url==='https://provider.invalid/chat'){calls++;if(calls===2)throw Error('controlled provider response loss');return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({text:'原创有来源草稿',source_keys:['lesson-1']})}}]}),{status:200});}return original(url,options);};t.after(()=>{global.fetch=original;});
 const done=await f.good(f.author,'/ai/jobs/'+jobs[1].id+'/dispatch',{expected_revision:jobs[1].revision});assert.equal(done.status,'succeeded');ledger=await f.db.collection('ai_usage_ledger').findOne({org_id:f.org});assert.equal(ledger.spent_micro,300000);assert.equal(ledger.reserved_micro,0);
 const unknown=await f.good(f.author,'/ai/jobs',{kind:'prepare',context_id:c._id,prompt:'另一个原创请求'});assert.equal((await f.good(f.author,'/ai/jobs/'+unknown.id+'/dispatch',{expected_revision:unknown.revision})).status,'unknown');ledger=await f.db.collection('ai_usage_ledger').findOne({org_id:f.org});assert.equal(ledger.unknown_micro,300000);assert.equal(ledger.reserved_micro,0);status(await create('超过金额'),429);
 await f.good(f.author,'/ai/jobs/'+unknown.id+'/dispatch',{expected_revision:unknown.revision});assert.equal(calls,2);
 const profile=(await f.good(f.author,'/ai/status')).profile;status(await f.req(f.author,'/ai/config',{...config,expected_revision:profile.revision,currency:'USD'}),409);
 await f.good(f.author,'/ai/config',{enabled:false,daily_limit:10,expected_revision:profile.revision});assert.equal((await f.good(f.author,'/ai/status')).enabled,false);
});

// Real Mongo/HTTP and unlink competition; clean verdict is explicit metadata fixture.
test('作业附件竞争：提交与到期清理互斥，任务取消与截止拒绝（非扫描验收）',{timeout:180000},async t=>{
 const env=await setupCourseworkLedger(t),storage=await courseworkPrivateChild(env,'race-files');
 const f=await setup(t,{...env,KL_COURSEWORK_FILES_ENABLED:'true',FILE_STORAGE_ROOT:storage});
 const fs=require('node:fs/promises'),path=require('node:path');await require('../dist/files/config').storageRoot();
 const make=async title=>{let task=await f.good(f.author,'/tasks',{class_id:f.classId,subject_id:f.subject,title,target_type:'coursework',target_id:null,due_at:new Date(Date.now()+180000).toISOString(),body:'原创竞争题面',rubric:[{key:'q',title:'质量',weight:100}]});task=await f.good(f.author,'/tasks/'+task._id+'/actions',{action:'publish',expected_revision:task.revision});const head=await f.good(f.student,'/tasks/'+task._id+'/coursework',{action:'save',expected_revision:0,body:'原创正文'}),file=attachmentMetadata(f,head);file.retention_until=new Date(0);file.deletion_requested_at=new Date(0);file.deletion_requested_by=f.author.user.user_id;file.deletion_requested_reason='隔离竞争验收';await f.db.collection('file_resources').insertOne(file);await fs.writeFile(path.join(storage,'ready',file.storage_key),'真实竞争字节');return {task,head,file};};
 const race=await make('提交与清理');const {processDeletion}=require('../dist/files/worker');
 const [submission,cleaned]=await Promise.all([f.req(f.student,'/tasks/'+race.task._id+'/coursework',{action:'submit',expected_revision:race.head.revision,body:'原创正文',file_ids:[race.file._id]}),processDeletion(f.db)]);
 const finalFile=await f.db.collection('file_resources').findOne({_id:race.file._id}),finalHead=await f.db.collection('coursework_heads').findOne({_id:race.head._id});
 if(submission.status===200){assert.equal(cleaned,false);assert.equal(finalFile.deleted_at,null);assert.deepEqual(finalHead.file_ids,[race.file._id]);assert.equal(await f.db.collection('coursework_submissions').countDocuments({head_id:race.head._id}),1);assert.equal((await fs.readFile(path.join(storage,'ready',race.file.storage_key))).toString(),'真实竞争字节');}
 else{assert.equal(submission.status,409);assert.equal(cleaned,true);assert.ok(finalFile.deleted_at instanceof Date);assert.equal(finalHead.current_submission_id,null);assert.equal(await f.db.collection('coursework_submissions').countDocuments({head_id:race.head._id}),0);await assert.rejects(fs.stat(path.join(storage,'ready',race.file.storage_key)),{code:'ENOENT'});}
 const protectedWork=await make('提交先完成后清理');await f.db.collection('file_resources').updateOne({_id:protectedWork.file._id},{$set:{deletion_requested_at:null,deletion_requested_by:null,deletion_requested_reason:null}});await f.good(f.student,'/tasks/'+protectedWork.task._id+'/coursework',{action:'submit',expected_revision:protectedWork.head.revision,body:'原创正文',file_ids:[protectedWork.file._id]});await f.db.collection('file_resources').updateOne({_id:protectedWork.file._id},{$set:{deletion_requested_at:new Date(0),deletion_requested_by:f.author.user.user_id,deletion_requested_reason:'故障注入：有引用的清理申请'}});assert.equal(await processDeletion(f.db),false);assert.equal((await f.db.collection('file_resources').findOne({_id:protectedWork.file._id})).deleted_at,null);assert.equal((await fs.readFile(path.join(storage,'ready',protectedWork.file.storage_key))).toString(),'真实竞争字节');
 const misowned=await make('归属错配拒绝');await f.db.collection('file_resources').updateOne({_id:misowned.file._id},{$set:{created_by:f.stranger.user.user_id}});assert.equal(await processDeletion(f.db),false);assert.equal((await f.db.collection('file_resources').findOne({_id:misowned.file._id})).deleted_at,null);assert.equal((await fs.readFile(path.join(storage,'ready',misowned.file.storage_key))).toString(),'真实竞争字节');
 const cancelled=await make('取消与附件提交');await f.good(f.author,'/tasks/'+cancelled.task._id+'/actions',{action:'cancel',expected_revision:(await f.db.collection('training_tasks').findOne({_id:cancelled.task._id})).revision});status(await f.req(f.student,'/tasks/'+cancelled.task._id+'/coursework',{action:'submit',expected_revision:cancelled.head.revision,body:'原创正文',file_ids:[cancelled.file._id]}),404);status(await f.req(f.student,'/coursework-files/'+cancelled.file._id),404);assert.equal(await f.db.collection('coursework_submissions').countDocuments({head_id:cancelled.head._id}),0);
 const expired=await make('截止与附件提交');await f.db.collection('training_tasks').updateOne({_id:expired.task._id},{$set:{due_at:new Date(0)}});status(await f.req(f.student,'/tasks/'+expired.task._id+'/coursework',{action:'submit',expected_revision:expired.head.revision,body:'原创正文',file_ids:[expired.file._id]}),409);assert.equal(await f.db.collection('coursework_submissions').countDocuments({head_id:expired.head._id}),0);
});
