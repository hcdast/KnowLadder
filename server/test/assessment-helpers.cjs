"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { fixture, Browser, status } = require("./helpers.cjs");

function request(actor, path, { method = "GET", body, key = randomUUID(), headers = {} } = {}) {
  return actor.browser.request(path, { method, body, headers: { "X-Org-Id": actor.org,
    ...(method === "GET" ? {} : { "Idempotency-Key": key }), ...headers } });
}
async function good(actor, path, options, expected = 200) {
  const response = await request(actor, path, options);
  status(response, expected);
  assert.equal(typeof response.data.request_id, "string");
  return response.data.data;
}
const license = () => ({ source: "阶段三原创隔离验收材料", granted: true, expires_at: null });
async function grant(f, actor, capability) {
  const member = await f.db.collection("organization_members").findOne({ _id: actor.memberId });
  await f.ops.setCapability(f.context, { org_id: actor.org, member_id: actor.memberId,
    capability, granted: true, expected_revision: member.authorization_revision });
}
async function publishContent(f, base, row) {
  await good(f.editor, `${base}/${row.id}/submit-review`, { method: "POST", body: { expected_revision: row.revision } });
  const pending = await good(f.contentReviewer, `${base}/${row.id}`);
  return good(f.contentReviewer, `${base}/${row.id}/publish`, { method: "POST", body: { expected_revision: pending.revision } });
}
async function createQuestion(f, changes = {}) {
  const input = { title: "原创单选验收", subject_id: f.subject, question_type: "single", prompt: "选出数字一",
    options: [{ id: "A", text: "一" }, { id: "B", text: "二" }], answer: "A", explanation: "原创验收解析",
    knowledge_point_ids: [f.knowledge], knowledge_weights: [{ knowledge_point_id: f.knowledge, weight_bps: 10000 }],
    difficulty: "基础", difficulty_basis: "只识别一个整数", scoring_rule: { version: 1, strategy: "single_exact", max_score: "1" },
    license: license(), ...changes };
  const draft = await good(f.editor, "/admin/question-versions", { method: "POST", body: input });
  await publishContent(f, "/admin/question-versions", draft);
  return good(f.editor, `/admin/question-versions/${draft.id}`);
}
async function assessmentFixture(t, options = {}) {
  const { publishedQuiz = false, ...fixtureOptions } = options;
  const f = await fixture(t, fixtureOptions);
  assert.equal((await f.db.collection("schema_migrations").findOne({ version: 4 })).status, "completed");
  const organization = await f.ops.createOrganization(f.context, { name: "评估隔离验收组织", kind: "school" });
  f.org = f.orgId = organization.organization_id;
  const now = new Date();
  f.stage = randomUUID(); f.subject = randomUUID(); f.knowledge = randomUUID();
  for (const [collection, row] of [
    ["education_stages", { _id: f.stage, code: "assessment-stage", name: "验收学段" }],
    ["subjects", { _id: f.subject, code: "assessment-subject", name: "验收学科" }],
    ["knowledge_points", { _id: f.knowledge, code: "assessment-point", name: "验收知识点", subject_id: f.subject }],
  ]) await f.db.collection(collection).insertOne({ ...row, created_at: now, updated_at: now });
  f.actor = async (roles = ["student"], capabilities = [], org = f.org) => {
    const browser = new Browser(f.browser.base);
    const user = await f.authenticated(browser);
    await f.ops.setMembership(f.context, { user_id: user.user_id, org_id: org, roles });
    const member = await f.db.collection("organization_members").findOne({ org_id: org, user_id: user.user_id });
    const actor = { browser, user, org, memberId: member._id };
    for (const capability of capabilities) await grant(f, actor, capability);
    return actor;
  };
  f.editor = await f.actor(["content_editor"]);
  f.contentReviewer = await f.actor(["content_reviewer"]);
  f.manager = await f.actor(["student"], ["assessment:manage"]);
  f.reviewer = await f.actor(["student"], ["assessment:review"]);
  f.student = await f.actor();
  const draft = await good(f.editor, "/admin/textbook-editions", { method: "POST", body: {
    title: "原创练测教材", textbook: { title: "原创练测教材", stage_id: f.stage, subject_id: f.subject, source: "自主编写" },
    edition_code: `assessment-${randomUUID()}`, license: license(),
  } });
  f.chapterId = randomUUID();
  const withChapter = await good(f.editor, `/admin/textbook-editions/${draft.id}/chapters`, { method: "PUT", body: {
    expected_revision: draft.revision, chapters: [{ id: f.chapterId, parent_id: null, position: 0, title: "整数", body: "原创整数正文",
      knowledge_point_ids: [f.knowledge], resource_ids: [] }],
  } });
  // Fetch metadata rather than depending on the chapter replacement response shape.
  void withChapter;
  await publishContent(f, "/admin/textbook-editions", await good(f.editor, `/admin/textbook-editions/${draft.id}`));
  f.book = await good(f.editor, `/admin/textbook-editions/${draft.id}`);
  f.questions = [await createQuestion(f), await createQuestion(f, { title: "原创多选验收", question_type: "multiple", answer: "A,B",
    scoring_rule: { version: 1, strategy: "multiple_exact_set", max_score: "2.50" } }),
  await createQuestion(f, { title: "原创数值验收", question_type: "numeric", prompt: "一加一", options: [], answer: "2e0",
    scoring_rule: { version: 1, strategy: "numeric_exact_decimal", max_score: "3.25" } })];
  if (publishedQuiz) { f.quiz = await createQuiz(f); f.quizId = f.quiz.id; }
  return f;
}
function quizInput(f, changes = {}) {
  const now = Date.now();
  return { title: "原创考试", subject_id: f.subject, opens_at: new Date(now - 60000).toISOString(),
    closes_at: new Date(now + 600000).toISOString(), release_at: new Date(now + 600000).toISOString(),
    duration_seconds: 600, max_attempts: 1,
    items: [{ question_version_id: f.questions[2].id, max_score: "7.25" }], audience_member_ids: [f.student.memberId], ...changes };
}
async function createQuiz(f, changes = {}, publish = true) {
  const draft = await good(f.manager, "/quizzes", { method: "POST", body: quizInput(f, changes) });
  if (!publish) return draft;
  await good(f.reviewer, `/quizzes/${draft.id}/publish`, { method: "POST", body: { expected_revision: draft.revision, reason: "独立审核原创验收试卷" } });
  return good(f.reviewer, `/admin/quizzes/${draft.id}`);
}
async function practice(f, changes = {}, key = randomUUID()) {
  return good(f.student, "/practice-sessions", { method: "POST", key, body: {
    textbook_edition_id: f.book.id, chapter_id: f.chapterId, knowledge_point_ids: [f.knowledge], count: 3, ...changes,
  } });
}
module.exports = { assessmentFixture, request, good, grant, createQuestion, createQuiz, quizInput, practice };
