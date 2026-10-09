"use strict";
const { MongoMemoryReplSet } = require("mongodb-memory-server-core");
const { randomBytes, randomUUID } = require("node:crypto");
const { fixture, Browser, status } = require("./helpers.cjs");
const { newId } = require("../dist/database/object-id");
const { hashPassword } = require("../dist/security/password");
(async () => {
  let rs, f;
  const cleanup = [];
  try {
    rs = await MongoMemoryReplSet.create({
      binary: { version: "8.0.17" },
      replSet: { count: 1, storageEngine: "wiredTiger" },
      instanceOpts: [{ args: ["--wiredTigerCacheSizeGB", "0.25"] }],
    });
    process.env.TEST_MONGODB_URI = rs.getUri("kl_test_workspace_119");
    const testOrigin =
      process.env.KL_TEST_BROWSER_ORIGIN || "http://127.0.0.9:5209";
    if (
      !["http://127.0.0.9:5209", "http://localhost:5209"].includes(testOrigin)
    )
      throw Error("INVALID_LOCAL_TEST_ORIGIN");
    const original = Browser.prototype.request;
    Browser.prototype.request = function (path, options = {}) {
      return original.call(this, path, {
        ...options,
        origin: testOrigin,
      });
    };
    f = await fixture(
      { after: (cb) => cleanup.push(cb) },
      {
        env: {
          KL_TRAINING_ENABLED: "true",
          KL_TRAINING_REPORTS_ENABLED: "true",
          ...(process.env.KL_TEST_PHASE2 === "true" ? {KL_TRAINING_PHASE2_ENABLED:"true"} : {}),
          APP_ORIGIN: testOrigin,
          FILE_SCAN_ENABLED: "false",
          ...(process.env.KL_TEST_AI_RECOVERY === "true"
            ? {
                KL_AI_ENDPOINT: "https://provider.invalid/chat",
                KL_AI_MODEL: "transport-test",
                KL_AI_API_KEY: "transport-test-value",
              }
            : {}),
        },
      },
    );
    const org = (
      await f.ops.createOrganization(f.context, {
        name: "本地职业培训验收",
        kind: "school",
      })
    ).organization_id;
    const actor = async (roles, caps = []) => {
      const browser = new Browser(f.browser.base),
        user = await f.authenticated(browser);
      await f.ops.setMembership(f.context, {
        user_id: user.user_id,
        org_id: org,
        roles,
      });
      const member = await f.db
        .collection("organization_members")
        .findOne({ user_id: user.user_id, org_id: org });
      for (const capability of caps) {
        const m = await f.db
          .collection("organization_members")
          .findOne({ _id: member._id });
        await f.ops.setCapability(f.context, {
          org_id: org,
          member_id: member._id,
          capability,
          granted: true,
          expected_revision: m.authorization_revision,
          valid_to: new Date(Date.now() + 3600000),
        });
      }
      const password = randomBytes(24).toString("hex");
      await f.db.collection("users").updateOne(
        { _id: user.user_id },
        {
          $set: {
            password_hash: await hashPassword(password),
            must_change_password: false,
            temporary_password_expires_at: null,
            password_changed_at: new Date(),
            updated_at: new Date(),
          },
          $inc: { credential_version: 1 },
        },
      );
      return { browser, user, member: member._id, password };
    };
    const teacher = await actor(
      ["teacher"],
      [
        ...(process.env.KL_TEST_PHASE2 === "true" ? require("../dist/training/phase2-schema").PHASE2_CAPABILITIES : []),
        "course:edit",
        "training:report-edit",
        "training:report-review",
        "course:assign",
        "task:manage",
        "coursework:grade",
        "ai:generate",
        "ai:manage",
        ...(process.env.KL_TEST_RECOVERY_FLOW === "true"
          ? ["teaching:report", "assessment:manage"]
          : []),
      ],
    );
    const reviewer = await actor(["teacher"], ["course:review","training:report-review",...(process.env.KL_TEST_PHASE2 === "true" ? require("../dist/training/phase2-schema").PHASE2_CAPABILITIES : [])]);
    const student = await actor(["student"], ["ai:assist"]);
    const now = new Date(),
      subject = newId(),
      classId = newId();
    await f.db.collection("subjects").insertOne({
      _id: subject,
      code: "local-training",
      name: "职业沟通",
      created_at: now,
      updated_at: now,
    });
    await f.db.collection("classes").insertOne({
      _id: classId,
      org_id: org,
      name: "职业沟通培训班",
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
        org_id: org,
        class_id: classId,
        member_id: a.member,
        subject_id: subject,
        status: "active",
        revision: 1,
        valid_from: null,
        valid_to: null,
        created_at: now,
        updated_at: now,
      });
    await f.db.collection("class_members").insertOne({
      _id: newId(),
      org_id: org,
      class_id: classId,
      member_id: student.member,
      kind: "student",
      status: "active",
      valid_from: null,
      valid_to: null,
      created_at: now,
      updated_at: now,
    });
    const courseId = newId();
    await f.db.collection("courses").insertOne({
      _id: courseId,
      org_id: org,
      revision: 1,
      created_at: now,
      updated_at: now,
      code: "communication",
      title: "职业沟通：从需求到行动",
      subject_id: subject,
      version_no: 1,
      status: "published",
      author_id: teacher.user.user_id,
      contributors: [teacher.user.user_id],
      reviewer_id: reviewer.user.user_id,
      review_note: "本地原创资料审核",
      lessons: [
        {
          key: "confirm-needs",
          title: "第一课：确认目标与约束",
          kind: "text",
          required: true,
          body: "先询问对方希望达成什么结果，再确认期限、资源和限制。用自己的话复述需求，获得确认后提供建议。",
          file_id: null,
          owner_version_id: null,
        },
      ],
    });
    await f.db.collection("class_courses").insertOne({
      _id: newId(),
      org_id: org,
      revision: 1,
      created_at: now,
      updated_at: now,
      class_id: classId,
      course_id: courseId,
      subject_id: subject,
      status: "active",
    });
    const taskId = newId();
    await f.db.collection("training_tasks").insertOne({
      _id: taskId,
      org_id: org,
      revision: 1,
      created_at: now,
      updated_at: now,
      class_id: classId,
      subject_id: subject,
      created_by: teacher.user.user_id,
      title: "实践：写一段需求确认话术",
      target_type: "coursework",
      target_id: null,
      due_at: new Date(Date.now() + 86400000),
      status: "published",
      body: "围绕目标、期限和资源限制，写出一个清晰的需求确认问题。",
      rubric: [{ key: "quality", title: "综合质量", weight: 100 }],
      recipients: [student.member],
      published_at: now,
    });
    await teacher.browser.prepare();
    status(await teacher.browser.login(teacher.user.login_name, teacher.password),200);
    await teacher.browser.prepare();
    const reportReq=async(path,body)=>{const response=await teacher.browser.request("/training"+path,{method:"POST",body,headers:{"X-Org-Id":org,"Idempotency-Key":randomUUID()}});status(response,200);return response.data.data;};
    let report=await reportReq("/reports",{class_id:classId,subject_id:subject,task_id:null,title:"原创班级验收报告",body:"培训完成与知识掌握分别核对，证据不足不推断已掌握。"});
    await reportReq("/reports/"+report._id+"/actions",{action:"request-review",expected_revision:report.revision});
    if (process.env.KL_TEST_AI_RECOVERY === "true") {
      await teacher.browser.prepare();
      status(
        await teacher.browser.login(teacher.user.login_name, teacher.password),
        200,
      );
      await teacher.browser.prepare();
      const trainingRequest = async (path, body) => {
        const result = await teacher.browser.request("/training" + path, {
          method: "POST",
          body,
          headers: { "X-Org-Id": org, "Idempotency-Key": randomUUID() },
        });
        status(result, 200);
        return result.data.data;
      };
      await trainingRequest("/ai/config", {
        enabled: true,
        daily_limit: 3,
        expected_revision: 0,
      });
      await trainingRequest("/ai/jobs", {
        kind: "prepare",
        context_id: courseId,
        prompt: "本地恢复场景的私有问题，不得向管理队列展示",
      });
      // Disposable browser fixture: retire its synthetic source without ever dispatching a model call.
      await f.db
        .collection("courses")
        .updateOne(
          { _id: courseId },
          { $set: { status: "retired" }, $inc: { revision: 1 } },
        );
    }
    if (process.send)
      process.send({
        ready: true,
        base: f.browser.base,
        org,
        classId,
        subject,
        courseId,
        taskId,
        actors: { teacher: { login: teacher.user.login_name, password: teacher.password }, reviewer: {login:reviewer.user.login_name,password:reviewer.password} },
        teacher: { login: teacher.user.login_name, password: teacher.password },
        student: { login: student.user.login_name, password: student.password },
        reviewer: {login:reviewer.user.login_name,password:reviewer.password},
      });
    await new Promise((resolve) => {
      process.on("message", async (message) => {
        if (message.stop) {
          resolve();
          return;
        }
        if (process.env.KL_TEST_RECOVERY_FLOW !== "true") return;
        try {
          let result;
          if (message.command === "phase2-inspect" && process.env.KL_TEST_PHASE2 === "true") {
            result = { locations: await f.db.collection("training_locations").countDocuments({org_id:org}), receipts: await f.db.collection("training_idempotency").countDocuments({org_id:org,operation:"phase2.location-create"}) };
          } else if (message.command === "inspect") {
            const head = await f.db
              .collection("coursework_heads")
              .findOne({
                org_id: org,
                task_id: taskId,
                user_id: student.user.user_id,
              });
            result = {
              submission_count: await f.db
                .collection("coursework_submissions")
                .countDocuments({ org_id: org, task_id: taskId }),
              head_revision: head?.revision || 0,
              has_current_submission: !!head?.current_submission_id,
              coursework_receipts: await f.db
                .collection("training_idempotency")
                .countDocuments({
                  org_id: org,
                  user_id: student.user.user_id,
                  operation: "coursework.submit",
                }),
            };
          } else if (message.command === "offboard") {
            const updated = await f.db
              .collection("class_members")
              .updateOne(
                { org_id: org, class_id: classId, member_id: student.member },
                { $set: { status: "ended", updated_at: new Date() } },
              );
            result = { updated: updated.modifiedCount };
          } else if (message.command === "revoke-teacher") {
            const updated = await f.db
              .collection("teaching_assignments")
              .updateOne(
                { org_id: org, class_id: classId, member_id: teacher.member },
                {
                  $set: { status: "ended", updated_at: new Date() },
                  $inc: { revision: 1 },
                },
              );
            result = { updated: updated.modifiedCount };
          } else throw Error("UNKNOWN_TEST_COMMAND");
          process.send?.({ request_id: message.request_id, result });
        } catch (e) {
          process.send?.({
            request_id: message.request_id,
            error: e.code || e.name,
          });
        }
      });
      process.once("SIGTERM", resolve);
      process.once("disconnect", resolve);
    });
  } catch (e) {
    console.error(e.name, e.code || "", e.message?.slice(0, 160));
    process.exitCode = 1;
  } finally {
    for (const cb of cleanup.reverse()) await cb();
    await rs?.stop();
    if (process.connected) process.disconnect();
  }
})();
