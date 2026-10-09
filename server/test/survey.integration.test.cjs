"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { setup } = require("./training-isolated-helpers.cjs");
const { status } = require("./helpers.cjs");
test(
  "实名反馈真实HTTP：v20、冻结发布、报名权限、一次提交、原编号与汇总",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t, {
      KL_KNOWLEDGE_ENABLED: "true",
      KL_KNOWLEDGE_IMPORT_ENABLED: "true",
      KL_TRAINING_SURVEYS_ENABLED: "true",
    });
    assert.equal(
      (await f.db.collection("schema_migrations").findOne({ version: 20 }))
        .status,
      "completed",
    );
    // Export from the running application's canonical public OpenAPI route.
    const contract = await fetch(f.browser.base + "/api/openapi.json");
    assert.equal(contract.status, 200);
    const api = await contract.json();
    assert.ok(api.paths["/api/v1/training/surveys"].post.requestBody);
    require("node:fs").writeFileSync(
      require("node:path").join(
        __dirname,
        "../../ops/artifacts/training-validation/revision152-survey-openapi.json",
      ),
      JSON.stringify(api, null, 2),
    );
    let c = await f.good(f.author, "/courses", {
      code: "survey-course",
      title: "原创反馈课程",
      subject_id: f.subject,
      version_no: 1,
      lessons: [
        {
          key: "lesson",
          title: "沟通基础",
          kind: "text",
          required: true,
          body: "原创课程正文",
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
      note: "原创内容独立检查",
    });
    await f.good(f.author, "/courses/" + c._id + "/assign", {
      class_id: f.classId,
    });
    const draft = {
      title: "课程反馈",
      opens_at: new Date(Date.now() - 60000).toISOString(),
      closes_at: new Date(Date.now() + 3600000).toISOString(),
      questions: [
        { id: "rating", title: "满意度", kind: "rating", required: true },
        { id: "text", title: "建议", kind: "text", required: false },
      ],
    };
    const key = randomUUID(),
      body = { course_id: c._id, draft };
    let s = await f.good(f.author, "/surveys", body, key);
    const same = await f.good(f.author, "/surveys", body, key);
    assert.equal(same._id, s._id);
    assert.equal(await f.db.collection("training_surveys").countDocuments(), 1);
    status(await f.req(f.student, "/surveys/" + s._id), 404);
    status(await f.req(f.student, "/surveys", body), 403);
    s = await f.good(f.author, "/surveys/" + s._id + "/actions", {
      expected_revision: s.revision,
      action: "publish",
    });
    assert.equal(s.published_revision, 2);
    status(await f.req(f.stranger, "/surveys/" + s._id), 404);
    status(await f.req(f.student, "/surveys/" + s._id + "/results"), 403);
    status(await f.req(f.reviewer, "/surveys/" + s._id + "?mode=manage"), 403);
    const put = await f.author.browser.request("/training/surveys/" + s._id, {
      method: "PUT",
      body: { expected_revision: s.revision, draft },
      headers: { "X-Org-Id": f.org, "Idempotency-Key": randomUUID() },
    });
    status(put, 409);
    const answers = [
        { question_id: "rating", value: 4 },
        { question_id: "text", value: "原创反馈建议" },
      ],
      submitKey = randomUUID(),
      submit = { expected_revision: s.revision, answers };
    const receipt = await f.good(
      f.student,
      "/surveys/" + s._id + "/responses",
      submit,
      submitKey,
    );
    await f.good(
      f.student,
      "/surveys/" + s._id + "/responses",
      submit,
      submitKey,
    );
    assert.equal(
    await f.db.collection("training_survey_responses").countDocuments(),
      1,
    );
    const recovered = await f.good(f.student, "/surveys/receipts/query", {
      key: submitKey,
      operation: "survey.submit",
      resource_id: s._id,
    });
    assert.equal(recovered.status, "applied");
    assert.equal(recovered.result.response_id, receipt.response_id);
    assert.ok(!JSON.stringify(recovered).includes("原创反馈建议"));
    status(
      await f.req(
        f.student,
        "/surveys/" + s._id + "/responses",
        { ...submit, answers: [{ question_id: "rating", value: 2 }] },
        submitKey,
      ),
      409,
    );
    status(
      await f.req(f.student, "/surveys/" + s._id + "/responses", submit),
      409,
    );
    let result = await f.good(f.author, "/surveys/" + s._id + "/results");
    assert.equal(result.summary.respondents, 1);
    assert.equal(result.summary.questions[0].rating_mean, 4);
    assert.equal(result.items[0].answers[0].value, "原创反馈建议");
    let read = await f.good(f.student, "/surveys/" + s._id);
    assert.equal(read.response.answers[0].value, 4);
    s = await f.good(f.author, "/surveys/" + s._id + "?mode=manage");
    s = await f.good(f.author, "/surveys/" + s._id + "/actions", {
      action: "close",
      expected_revision: s.revision,
    });
    status(
      await f.req(f.author, "/surveys/" + s._id + "/actions", {
        action: "publish",
        expected_revision: s.revision,
      }),
      409,
    );
    const closedReplay = await f.good(f.student, "/surveys/" + s._id + "/responses", submit, submitKey);
    assert.equal(closedReplay.response_id, receipt.response_id);
    assert.equal(await f.db.collection("training_survey_responses").countDocuments({survey_id: s._id}), 1);
    await f.db
      .collection("class_members")
      .updateOne(
        { member_id: f.student.member },
        { $set: { status: "ended" } },
      );
    status(
      await f.req(f.student, "/surveys/receipts/query", {
        key: submitKey,
        operation: "survey.submit",
        resource_id: s._id,
      }),
      404,
    );
    const { migrateSurveys } = require("../dist/training/survey-schema");
    await assert.rejects(()=>migrateSurveys(f.db, {}),/stopped writers/);
    assert.equal(
      await f.db
        .collection("schema_migrations")
        .countDocuments({ version: 20 }),
      1,
    );
    await f.db
      .collection("class_members")
      .updateOne(
        { member_id: f.student.member },
        { $set: { status: "active" } },
      );
    let racing = await f.good(f.author, "/surveys", body);
    racing = await f.good(f.author, "/surveys/" + racing._id + "/actions", {
      action: "publish",
      expected_revision: racing.revision,
    });
    const sameKey = randomUUID(),
      raceBody = { expected_revision: racing.revision, answers };
    const attempts = await Promise.all([
      f.req(
        f.student,
        "/surveys/" + racing._id + "/responses",
        raceBody,
        sameKey,
      ),
      f.req(
        f.student,
        "/surveys/" + racing._id + "/responses",
        raceBody,
        sameKey,
      ),
    ]);
    for (const r of attempts) status(r, 200);
    assert.equal(
      attempts[0].data.data.response_id,
      attempts[1].data.data.response_id,
    );
    assert.equal(
      await f.db
        .collection("training_survey_responses")
        .countDocuments({ survey_id: racing._id }),
      1,
    );
    assert.equal(
      await f.db
        .collection("training_idempotency")
        .countDocuments({
          resource_id: racing._id,
          operation: "survey.submit",
          key: sameKey,
        }),
      1,
    );
    const stored = await f.db.collection("training_survey_responses").findOne();
    await assert.rejects(
      () =>
        f.db.collection("training_survey_responses").insertOne({
          ...stored,
          _id: require("../dist/database/object-id").newId(),
        }),
      (e) => e.code === 11000,
    );
    await assert.rejects(
      () =>
        f.db
          .collection("training_surveys")
          .updateOne({ _id: s._id }, { $set: { unexpected: true } }),
      (e) => e.code === 121,
    );
    const training = f.app.get(require("../dist/training/training.service").TrainingService);
    for (const boundary of ["close", "revoke"]) {
      let target = await f.good(f.author, "/surveys", body);
      target = await f.good(f.author, "/surveys/" + target._id + "/actions", {action: "publish", expected_revision: target.revision});
      const original = training.row;
      let release, entered, hits = 0;
      const paused = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { entered = resolve; });
      training.row = async function(ctx, name, id) {
        const row = await original.call(this, ctx, name, id);
        if (name === "training_surveys" && id === target._id && ctx.userId === f.student.user.user_id) {
          hits++;
          if (hits === 1) { entered(); await paused; }
        }
        return row;
      };
      const requestKey = randomUUID();
      const pending = f.req(f.student, "/surveys/" + target._id + "/responses", {expected_revision: target.revision, answers}, requestKey);
      pending.catch(() => {});
      let timer;
      try {
        await Promise.race([started, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error("survey snapshot hook not reached")), 10000);})]);
        clearTimeout(timer);
        if (boundary === "close") await f.db.collection("training_surveys").updateOne({_id: target._id, revision: target.revision}, {$set: {status: "closed", updated_at: new Date()}, $inc: {revision: 1}}, {maxTimeMS: 5000});
        else await f.db.collection("class_members").updateOne({member_id: f.student.member}, {$set: {status: "ended"}}, {maxTimeMS: 5000});
        release();
        status(await pending, boundary === "close" ? 409 : 404);
        assert.ok(hits >= 2, boundary + " must retry after real transaction conflict");
        assert.equal(await f.db.collection("training_survey_responses").countDocuments({survey_id: target._id}), 0);
        assert.equal(await f.db.collection("training_idempotency").countDocuments({key: requestKey}), 0);
      } finally {
        clearTimeout(timer); release(); await pending.catch(() => {}); training.row = original;
        if (boundary === "revoke") await f.db.collection("class_members").updateOne({member_id: f.student.member}, {$set: {status: "active"}});
      }
    }
    await f.app.close();
    await migrateSurveys(f.db, {});
    assert.equal(await f.db.collection("schema_migrations").countDocuments({version:20}),1);
  },
);
