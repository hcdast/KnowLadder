"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { assessmentFixture, quizInput } = require("./assessment-helpers.cjs");
const { administrativeGrant } = require("./administration-helpers.cjs");
const { status, error } = require("./helpers.cjs");

async function request(actor, targetOrg, module, path, { method = "GET", body } = {}) {
  return actor.browser.request(`/console/business/${module}${path}`, { method, body, headers: {
    "X-Org-Id": actor.org, "X-Target-Org-Id": targetOrg,
    ...(method === "GET" ? {} : { "Idempotency-Key": randomUUID() }),
  } });
}
async function good(actor, targetOrg, module, path, opts, expected = 200) {
  const response = await request(actor, targetOrg, module, path, opts);
  status(response, expected);
  return response.data.data;
}
for (const topology of ["replicaSet", "standalone"]) {
  test(`IAM ${topology}：平台真实跨组织题目作者、独立审核、考试发布`, { timeout: 360000, concurrency: false }, async t => {
    const f = await assessmentFixture(t, { topology, env: { FILE_SCAN_ENABLED: "false" } });
    const platform = (await f.ops.createOrganization(f.context, { name: "IAM 内容与考试平台", kind: "platform" })).organization_id;
    const contentEditor = await f.actor(["platform_ops"], [], platform);
    const contentReviewer = await f.actor(["platform_ops"], [], platform);
    const examManager = await f.actor(["platform_ops"], [], platform);
    const examReviewer = await f.actor(["platform_ops"], [], platform);
    const governor = await f.actor(["platform_ops"], [], platform);
    await administrativeGrant(f, governor, "platform:govern");
    await administrativeGrant(f, contentEditor, "content:edit", [f.org]);
    await administrativeGrant(f, contentReviewer, "content:review", [f.org]);
    await administrativeGrant(f, examManager, "assessment:manage", [f.org]);
    await administrativeGrant(f, examReviewer, "assessment:review", [f.org]);
    error(await request(governor, f.org, "content", `/admin/question-versions/${f.questions[0].id}`), 403);

    const draft = await good(contentEditor, f.org, "content", "/admin/question-versions", { method: "POST", body: {
      title: "IAM 跨组织原创单选题", subject_id: f.subject, question_type: "single", prompt: "二乘二等于几？",
      options: [{ id: "A", text: "四" }, { id: "B", text: "三" }], answer: "A", explanation: "原创整数解析",
      knowledge_point_ids: [f.knowledge], knowledge_weights: [{ knowledge_point_id: f.knowledge, weight_bps: 10000 }],
      difficulty: "基础", difficulty_basis: "整数计算", scoring_rule: { version: 1, strategy: "single_exact", max_score: "1" },
      license: { source: "IAM 合成原创", granted: true, expires_at: null },
    } });
    assert.equal(draft.status, "draft");
    const review = await good(contentEditor, f.org, "content", `/admin/question-versions/${draft.id}/submit-review`, { method: "POST", body: { expected_revision: draft.revision } });
    assert.equal(review.status, "review");
    await administrativeGrant(f, contentEditor, "content:review", [f.org]);
    error(await request(contentEditor, f.org, "content", `/admin/question-versions/${draft.id}/publish`, { method: "POST", body: { expected_revision: review.revision } }), 403);
    const published = await good(contentReviewer, f.org, "content", `/admin/question-versions/${draft.id}/publish`, { method: "POST", body: { expected_revision: review.revision } });
    assert.equal(published.status, "published");
    const audit = await f.db.collection("audit_events").findOne({ org_id: f.org, actor_id: contentReviewer.user.user_id, action: "content.question.publish", resource_id: draft.id });
    assert.equal(audit.actor_org_id, platform);
    assert.equal(audit.target_org_id, f.org);
    error(await request(contentReviewer, platform, "content", `/admin/question-versions/${draft.id}`), 403);

    const quiz = await good(examManager, f.org, "assessment", "/quizzes", { method: "POST", body: quizInput(f) });
    assert.equal(quiz.status, "draft");
    await administrativeGrant(f, examManager, "assessment:review", [f.org]);
    error(await request(examManager, f.org, "assessment", `/quizzes/${quiz.id}/publish`, { method: "POST", body: { expected_revision: quiz.revision, reason: "同人发布负例" } }), 403);
    const released = await good(examReviewer, f.org, "assessment", `/quizzes/${quiz.id}/publish`, { method: "POST", body: { expected_revision: quiz.revision, reason: "独立验收本地原创考试" } });
    assert.equal(released.status, "published");
    const stored = await f.db.collection("quizzes").findOne({ _id: quiz.id, org_id: f.org });
    assert.equal(stored.created_by, examManager.user.user_id);
    assert.equal(stored.published_by, examReviewer.user.user_id);
    assert.equal(await f.db.collection("quiz_audiences").countDocuments({ quiz_id: quiz.id, member_id: f.student.memberId }), 1);
  });
}
