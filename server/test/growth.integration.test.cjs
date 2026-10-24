"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { randomUUID } = require("node:crypto");
const { studioFixture } = require("./studio-fixture.cjs"),
  { status } = require("./helpers.cjs");
const { newId, rawDatabase } = require("../dist/database/object-id");
async function fixture(t, env = {}) {
  return studioFixture(t, { KL_LEARNING_GROWTH_ENABLED: "true", ...env });
}
const { work } = require("./growth-fixture.cjs");
const shareInput = (f, id) => ({
  label: "请教师指导我的实践",
  recipient_member_id: f.author.member,
  submission_ids: [id],
  expires_at: new Date(Date.now() + 3600000).toISOString(),
});
test(
  "成长档案：当前作品/课程/参与来源、反馈分离、创建时期筛选、分页与本人隔离",
  { timeout: 180000 },
  async (t) => {
    const f = await fixture(t),
      w = await work(f);
    let row = (await f.good(f.student, "/growth/portfolio?kind=work")).items[0];
    assert.equal(row.body, "我的原创观察与实践反思");
    assert.equal(row.verification, "submitted");
    assert.equal(row.feedback, null);
    const published = await f.good(f.author, `/tasks/${w.task._id}/feedback`, {
      head_revision: w.head.revision,
      submission_id: w.id,
      comments: "补充观察条件",
      scores: [{ key: "evidence", score: 82 }],
      publish: true,
    });
    row = (await f.good(f.student, "/growth/portfolio?kind=work")).items[0];
    assert.equal(row.feedback.comments, "补充观察条件");
    assert.equal(row.feedback.score, 82);
    assert.equal(row.verification, "teacher_feedback");
    assert.ok(!JSON.stringify(row).includes(published.author_id));
    assert.deepEqual(
      (await f.good(f.stranger, "/growth/portfolio?kind=work")).items,
      [],
    );
    assert.equal(
      (
        await f.good(
          f.student,
          "/growth/portfolio?kind=work&from=2000-01-01&to=2000-01-02",
        )
      ).items.length,
      0,
    );
    status(await f.req(f.student, "/growth/portfolio?from=2026-02-30"), 422);
    status(await f.req(f.student, "/growth/portfolio?kind=constructor"), 422);
    await f.good(f.student, `/courses/${f.course._id}/progress`, {
      lesson_key: "observe",
      position: 0,
      complete: true,
    });
    const course = (await f.good(f.student, "/growth/portfolio?kind=course"))
      .items[0];
    assert.equal(course.verification, "self_confirmed");
    assert.equal(course.body, "");
    let meetup = await f.meetup(2);
    meetup = await f.good(f.student, `/studio/meetups/${meetup._id}/actions`, {
      action: "enroll",
      expected_revision: meetup.revision,
    });
    const start = new Date(Date.now() - 3600000),
      end = new Date(Date.now() - 1000);
    await f.db
      .collection("learning_meetups")
      .updateOne(
        { _id: meetup._id },
        { $set: { starts_at: start, ends_at: end } },
      );
    let detail = await f.good(
        f.author,
        `/studio/meetups/${meetup._id}?mode=staff`,
      ),
      member = detail.members[0];
    await f.good(f.author, `/studio/meetups/${meetup._id}/actions`, {
      action: "attended",
      expected_revision: detail.revision,
      enrollment_id: member._id,
      enrollment_revision: member.revision,
    });
    assert.equal(
      (await f.good(f.student, "/growth/portfolio?kind=meetup")).items[0]
        .verification,
      "teacher_recorded",
    );
    const exported = await f.good(
      f.student,
      "/growth/portfolio/export?kind=work",
    );
    assert.equal(exported.count, 1);
    assert.equal(exported.items[0].body, "我的原创观察与实践反思");
    assert.equal(exported.filters.kind, "work");
    const page = await f.good(f.student, "/growth/portfolio?kind=work&limit=1");
    assert.equal(page.items.length, 1);
    // More than a candidate window of inaccessible historical submissions cannot starve continuation.
    const original = await f.db
      .collection("coursework_submissions")
      .findOne({ _id: w.id });
    await f.db.collection("coursework_submissions").insertMany(
      Array.from({ length: 202 }, (_, i) => ({
        ...original,
        _id: newId(),
        head_id: newId(),
        submission_no: i + 2,
      })),
    );
    const first = await f.good(
      f.student,
      "/growth/portfolio?kind=work&limit=1",
    );
    assert.equal(first.items.length, 0);
    assert.ok(first.next_cursor);
    const next = await f.good(
      f.student,
      "/growth/portfolio?kind=work&limit=1&cursor=" +
        encodeURIComponent(first.next_cursor),
    );
    assert.equal(next.items[0].id, w.id);
    status(
      await f.req(
        f.stranger,
        "/growth/portfolio?kind=work&limit=1&cursor=" +
          encodeURIComponent(first.next_cursor),
      ),
      422,
    );
  },
);
test(
  "成长分享：名称教师候选、明确范围、当前授权、幂等、撤回及最小回执",
  { timeout: 180000 },
  async (t) => {
    const f = await fixture(t),
      w = await work(f),
      key = randomUUID();
    const recipients = await f.good(
      f.student,
      "/growth/recipients?submission_id=" + w.id,
    );
    assert.deepEqual(
      recipients.items.map((x) => x.member_id),
      [f.author.member],
    );
    let share = await f.good(
      f.student,
      "/growth/shares",
      shareInput(f, w.id),
      key,
    );
    assert.equal(share.submission_ids.length, 1);
    // Replays require exactly the original expiry, just as every other idempotent write.
    const input = {
      label: share.label,
      recipient_member_id: share.recipient_member_id,
      submission_ids: share.submission_ids,
      expires_at: share.expires_at,
    };
    assert.equal(
      (await f.good(f.student, "/growth/shares", input, key))._id,
      share._id,
    );
    const received = await f.good(f.author, `/growth/shares/${share._id}`);
    assert.equal(received.items[0].body, "我的原创观察与实践反思");
    assert.equal(received.share.revision, 1);
    status(await f.req(f.stranger, `/growth/shares/${share._id}`), 404);
    assert.deepEqual((await f.good(f.stranger, "/growth/shares")).items, []);
    assert.deepEqual(
      await f.good(f.student, "/growth/receipts/query", { key }),
      { status: "confirmed" },
    );
    const list = await f.good(f.student, "/growth/shares");
    share = list.items[0];
    share = await f.good(f.student, `/growth/shares/${share._id}/revoke`, {
      expected_revision: share.revision,
    });
    status(await f.req(f.author, `/growth/shares/${share._id}`), 404);
    assert.equal(
      (await f.good(f.student, "/growth/shares")).items[0].revoked_at,
      share.revoked_at,
    );
    status(
      await f.req(f.student, "/growth/shares", {
        ...input,
        recipient_member_id: f.stranger.member,
      }),
      404,
    );
    status(
      await f.req(f.student, "/growth/shares", {
        ...input,
        expires_at: new Date(Date.now() + 31 * 86400000).toISOString(),
      }),
      422,
    );
    status(
      await f.req(f.student, "/growth/shares", {
        ...input,
        submission_ids: [w.id, w.id],
      }),
      422,
    );
  },
);
test(
  "成长分享：过期、作品撤回重交、授课撤回和跨学科停止交付",
  { timeout: 180000 },
  async (t) => {
    const f = await fixture(t),
      w = await work(f);
    let share = await f.good(f.student, "/growth/shares", shareInput(f, w.id));
    await f.db
      .collection("learning_portfolio_shares")
      .updateOne(
        { _id: share._id },
        { $set: { expires_at: new Date(Date.now() - 1) } },
      );
    status(await f.req(f.author, `/growth/shares/${share._id}`), 404);
    share = await f.good(f.student, "/growth/shares", shareInput(f, w.id));
    const latest = await f.good(f.student, `/tasks/${w.task._id}/coursework`);
    let head = await f.good(f.student, `/tasks/${w.task._id}/coursework`, {
      action: "withdraw",
      expected_revision: latest.head.revision,
      body: "修改草稿",
    });
    status(await f.req(f.author, `/growth/shares/${share._id}`), 404);
    assert.equal(
      (await f.good(f.student, "/growth/portfolio?kind=work")).items.length,
      0,
    );
    head = await f.good(f.student, `/tasks/${w.task._id}/coursework`, {
      action: "submit",
      expected_revision: head.revision,
      body: "第二版",
    });
    status(await f.req(f.author, `/growth/shares/${share._id}`), 404);
    share = await f.good(
      f.student,
      "/growth/shares",
      shareInput(f, head.current_submission_id),
    );
    await f.db
      .collection("teaching_assignments")
      .updateOne({ member_id: f.author.member }, { $set: { status: "ended" } });
    status(await f.req(f.author, `/growth/shares/${share._id}`), 404);
    status(await f.req(f.student, `/growth/shares/${share._id}`), 404);
    assert.equal((await f.good(f.student, "/growth/shares")).items.length, 3);
  },
);
test(
  "作品答疑：具体提交绑定、冒用/错班拒绝、教师回复及撤回后全路由停止",
  { timeout: 180000 },
  async (t) => {
    const f = await fixture(t),
      w = await work(f),
      key = randomUUID();
    let question = await f.question({ submission_id: w.id });
    const detail = await f.good(f.student, `/studio/questions/${question._id}`);
    assert.equal(detail.work_context.submission_id, w.id);
    status(
      await f.req(f.stranger, "/studio/questions", {
        class_id: f.classId,
        subject_id: f.subject,
        title: "冒用作品",
        body: "查看",
        submission_id: w.id,
      }),
      404,
    );
    question = await f.good(
      f.author,
      `/studio/questions/${question._id}/actions`,
      {
        action: "reply",
        expected_revision: question.revision,
        body: "针对这一版补充证据",
      },
      key,
    );
    const latest = await f.good(f.student, `/tasks/${w.task._id}/coursework`);
    await f.good(f.student, `/tasks/${w.task._id}/coursework`, {
      action: "withdraw",
      expected_revision: latest.head.revision,
      body: "修改",
    });
    for (const actor of [f.student, f.author])
      status(await f.req(actor, `/studio/questions/${question._id}`), 404);
    assert.deepEqual(
      (await f.good(f.author, "/studio/questions?mode=staff")).items,
      [],
    );
    assert.deepEqual((await f.good(f.student, "/studio/questions")).items, []);
    status(await f.req(f.author, "/studio/receipts/query", { key }), 404);
    status(
      await f.req(f.author, `/studio/questions/${question._id}/actions`, {
        action: "reply",
        expected_revision: question.revision,
        body: "不能再回复",
      }),
      404,
    );
  },
);
test(
  "学习通知：同事务去重、未读/CAS、偏好、反馈草稿隔离及来源撤回",
  { timeout: 180000 },
  async (t) => {
    const f = await fixture(t),
      w = await work(f);
    let question = await f.question(),
      key = randomUUID();
    const reply = {
      action: "reply",
      expected_revision: question.revision,
      body: "教师真实回复",
    };
    await f.good(
      f.author,
      `/studio/questions/${question._id}/actions`,
      reply,
      key,
    );
    await f.good(
      f.author,
      `/studio/questions/${question._id}/actions`,
      reply,
      key,
    );
    let inbox = await f.good(f.student, "/growth/inbox?unread=true");
    assert.equal(inbox.items.length, 1);
    assert.ok(!JSON.stringify(inbox).includes("教师真实回复"));
    const notice = inbox.items[0];
    await f.good(f.student, `/growth/inbox/${notice._id}/read`, {
      expected_revision: notice.revision,
    });
    assert.equal(
      (await f.good(f.student, "/growth/inbox?unread=true")).items.length,
      0,
    );
    status(
      await f.req(f.stranger, `/growth/inbox/${notice._id}/read`, {
        expected_revision: notice.revision,
      }),
      404,
    );
    let pref = await f.good(f.student, "/growth/preferences");
    assert.equal(pref.revision, 0);
    pref = await f.good(f.student, "/growth/preferences", {
      expected_revision: 0,
      question: false,
      feedback: true,
      meetup: true,
    });
    question = await f.good(f.author, `/studio/questions/${question._id}`);
    await f.good(f.author, `/studio/questions/${question._id}/actions`, {
      action: "reply",
      expected_revision: question.revision,
      body: "不再建立此类通知",
    });
    assert.equal((await f.good(f.student, "/growth/inbox")).items.length, 1);
    await f.good(f.author, `/tasks/${w.task._id}/feedback`, {
      head_revision: w.head.revision,
      submission_id: w.id,
      comments: "仅草稿",
      scores: [{ key: "evidence", score: 50 }],
      publish: false,
    });
    assert.equal((await f.good(f.student, "/growth/inbox")).items.length, 1);
    let latest = await f.good(f.student, `/tasks/${w.task._id}/coursework`);
    await f.good(f.author, `/tasks/${w.task._id}/feedback`, {
      head_revision: latest.head.revision,
      submission_id: w.id,
      comments: "已发布",
      scores: [{ key: "evidence", score: 80 }],
      publish: true,
    });
    assert.equal(
      (await f.good(f.student, "/growth/inbox?unread=true")).items.length,
      1,
    );
    await f.good(f.student, "/growth/shares", shareInput(f, w.id));
    assert.equal(
      (await f.good(f.student, "/growth/inbox?unread=true")).items.length,
      1,
      "分享栅栏不能使当前反馈通知失效",
    );
    await f.db
      .collection("class_members")
      .updateOne(
        { member_id: f.student.member },
        { $set: { status: "ended" } },
      );
    assert.equal((await f.good(f.student, "/growth/inbox")).items.length, 0);
  },
);
test(
  "成长v27：严格schema、BSON路径、精确registry及实际OpenAPI类型生成",
  { timeout: 180000 },
  async (t) => {
    const f = await fixture(t);
    const marker = await f.db
      .collection("schema_migrations")
      .findOne({ version: 27 });
    assert.equal(marker.status, "completed");
    const registry =
      require("../dist/migrations/schema").systemBackupRegistry();
    assert.equal(registry.version, 27);
    assert.ok(registry.checksums["26"]);
    assert.ok(!registry.checksums["23"]);
    const schemas = require("../dist/training/growth-schema").GROWTH_SCHEMAS;
    for (const name of Object.keys(schemas)) {
      const info = await rawDatabase(f.db).listCollections({ name }).next();
      assert.deepEqual(info.options.validator, schemas[name].validator);
      await assert.rejects(
        f.db.collection(name).insertOne({ _id: newId(), unexpected: true }),
        (e) => e.code === 121,
      );
    }
    const api = await (
      await fetch(new URL("/api/openapi.json", f.browser.base))
    ).json();
    assert.equal(
      api.paths["/api/v1/training/growth/portfolio"].get.responses[200].content[
        "application/json"
      ].schema.properties.data.properties.items.maxItems,
      50,
    );
    if (process.env.GENERATE_GROWTH_API === "true") {
      const { spawn } = require("node:child_process"),
        path = require("node:path");
      const c = spawn(process.execPath, ["scripts/generate-api.mjs"], {
        cwd: path.resolve(__dirname, "../../web"),
        windowsHide: true,
        stdio: "inherit",
        env: {
          ...process.env,
          OPENAPI_URL: new URL("/api/openapi.json", f.browser.base).href,
        },
      });
      assert.equal(
        await new Promise((resolve, reject) => {
          c.once("error", reject);
          c.once("exit", resolve);
        }),
        0,
      );
    }
  },
);
test(
  "成长分享：读取旧快照后并发撤回，事务冲突重试后停止正文交付",
  { timeout: 180000 },
  async (t) => {
    const f = await fixture(t),
      w = await work(f),
      share = await f.good(f.student, "/growth/shares", shareInput(f, w.id));
    const service = f.apps[0].get(
        require("../dist/training/growth.service").LearningGrowthService,
      ),
      original = service.t.taskAccess.bind(service.t);
    let release,
      entered,
      paused = false;
    const gate = new Promise((r) => (release = r)),
      ready = new Promise((r) => (entered = r));
    service.t.taskAccess = async (...args) => {
      const value = await original(...args);
      if (
        !paused &&
        args[0].userId === f.author.user.user_id &&
        args[1] === w.task._id
      ) {
        paused = true;
        entered();
        await gate;
      }
      return value;
    };
    t.after(() => {
      release();
      service.t.taskAccess = original;
    });
    const reading = f.req(f.author, `/growth/shares/${share._id}`);
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(Error("share read hook timeout")),
          10000,
        );
        timer.unref();
      }),
    ]);
    // This independent atomic writer deliberately avoids the shared HTTP authorization fence.
    // The HTTP read already holds an older snapshot; its own share access_fence must force retry.
    const result = await f.db
      .collection("learning_portfolio_shares")
      .updateOne(
        { _id: share._id, org_id: f.org, revision: share.revision },
        {
          $set: { revoked_at: new Date(), updated_at: new Date() },
          $inc: { revision: 1 },
        },
      );
    assert.equal(result.modifiedCount, 1);
    release();
    status(await reading, 404);
    assert.equal((await f.good(f.author, "/growth/shares")).items.length, 0);
  },
);
test(
  "成长分享：读取期间自然到期，数据库当前时间栅栏停止正文交付",
  { timeout: 180000 },
  async (t) => {
    const f = await fixture(t),
      w = await work(f);
    const share = await f.good(
      f.student,
      "/growth/shares",
      shareInput(f, w.id),
    );
    const expires = new Date(Date.now() + 4000);
    await f.db
      .collection("learning_portfolio_shares")
      .updateOne({ _id: share._id }, { $set: { expires_at: expires } });
    const service = f.apps[0].get(
      require("../dist/training/growth.service").LearningGrowthService,
    );
    const original = service.workView.bind(service);
    let waited = false;
    service.workView = async (...args) => {
      const row = await original(...args);
      if (!waited && args[0].userId === f.author.user.user_id) {
        waited = true;
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.max(0, expires.getTime() - Date.now()) + 150,
          ),
        );
      }
      return row;
    };
    t.after(() => {
      service.workView = original;
    });
    status(await f.req(f.author, `/growth/shares/${share._id}`), 404);
    assert.equal(waited, true, "HTTP读取须在到期前进入作品正文检查");
  },
);
test(
  "共学通知：本人报名去重、取消事件无活动正文及退班隐藏",
  { timeout: 180000 },
  async (t) => {
    const f = await fixture(t);
    let meetup = await f.meetup(2);
    assert.equal((await f.good(f.student, "/growth/inbox")).items.length, 0);
    const key = randomUUID(),
      body = { action: "enroll", expected_revision: meetup.revision };
    meetup = await f.good(
      f.student,
      `/studio/meetups/${meetup._id}/actions`,
      body,
      key,
    );
    await f.good(f.student, `/studio/meetups/${meetup._id}/actions`, body, key);
    assert.equal((await f.good(f.student, "/growth/inbox")).items.length, 1);
    assert.equal((await f.good(f.stranger, "/growth/inbox")).items.length, 0);
    await f.good(f.author, `/studio/meetups/${meetup._id}/actions`, {
      action: "cancel",
      expected_revision: meetup.revision,
    });
    const inbox = await f.good(f.student, "/growth/inbox");
    assert.equal(inbox.items.length, 2);
    assert.ok(inbox.items.every((r) => r.message === "已报名的共学活动已取消"));
    assert.ok(!JSON.stringify(inbox).includes("班级学习室"));
    await f.db
      .collection("class_members")
      .updateOne(
        { member_id: f.student.member },
        { $set: { status: "ended" } },
      );
    assert.equal((await f.good(f.student, "/growth/inbox")).items.length, 0);
  },
);
test(
  "成长开关关闭：拒绝档案/分享/通知，不改变原普通答疑",
  { timeout: 180000 },
  async (t) => {
    const f = await studioFixture(t);
    for (const p of ["/growth/portfolio", "/growth/shares", "/growth/inbox"])
      status(await f.req(f.student, p), 503);
    assert.equal((await f.question()).status, "open");
  },
);
