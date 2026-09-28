"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { scoringRule, knowledgeWeights, validateQuestion, studentEdition, studentChapter, safeVersion } = require("../dist/content/dto");
const point = "10000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";
const strategies = { single: "single_exact", multiple: "multiple_exact_set", numeric: "numeric_exact_decimal" };
function question(type = "single", changes = {}) {
  return { question_type: type, prompt: "原创校验题", options: type === "numeric" ? [] : [{ id: "a", text: "甲" }, { id: "b", text: "乙" }],
    answer: type === "numeric" ? "1.25" : type === "multiple" ? "a,b" : "a", knowledge_point_ids: [point],
    scoring_rule: { version: 1, strategy: strategies[type], max_score: "10.00" },
    knowledge_weights: [{ knowledge_point_id: point, weight_bps: 10000 }], difficulty_basis: "原创题仅包含单步运算", ...changes };
}
function rejects(work, code) {
  assert.throws(work, error => error.getStatus() === 422 && error.getResponse().code === code);
}

test("评分规则允许草稿null，限制版本、策略和精确满分范围", () => {
  assert.equal(scoringRule(null), null);
  for (const strategy of Object.values(strategies)) {
    for (const max_score of ["0.01", "0.1", "1", "99.99", "100", "100.00"]) {
      const rule = { version: 1, strategy, max_score };
      assert.deepEqual(scoringRule(rule), rule);
    }
  }
  for (const max_score of ["0", "0.00", "-1", "100.01", "101", "0.001", "01", "1e1", "NaN"]) {
    rejects(() => scoringRule({ version: 1, strategy: strategies.single, max_score }), "SCORING_RULE_INVALID");
  }
  rejects(() => scoringRule({ version: 1, strategy: strategies.single, max_score: "Infinity" }), "VALIDATION_ERROR");
  rejects(() => scoringRule({ version: 2, strategy: strategies.single, max_score: "1" }), "SCORING_RULE_INVALID");
  rejects(() => scoringRule({ version: 1, strategy: "partial", max_score: "1" }), "SCORING_RULE_INVALID");
});

test("三题型送审必须匹配策略与有效答案，不允许草稿缺项", () => {
  for (const type of Object.keys(strategies)) {
    assert.doesNotThrow(() => validateQuestion(question(type)));
    const wrong = type === "single" ? strategies.numeric : strategies.single;
    rejects(() => validateQuestion(question(type, { scoring_rule: { version: 1, strategy: wrong, max_score: "1" } })), "SCORING_RULE_INVALID");
  }
  for (const changes of [{ scoring_rule: null }, { difficulty_basis: " " }, { prompt: " " }, { knowledge_point_ids: [] }]) {
    rejects(() => validateQuestion(question("single", changes)), "QUESTION_INCOMPLETE");
  }
  for (const answer of ["a,b", "missing", ""]) rejects(() => validateQuestion(question("single", { answer })), "ANSWER_INVALID");
  for (const answer of ["a", "a,a", "a,missing"]) rejects(() => validateQuestion(question("multiple", { answer })), "ANSWER_INVALID");
  assert.doesNotThrow(() => validateQuestion(question("multiple", { answer: "b,a" })));
  for (const options of [[{ id: "a", text: "甲" }, { id: "a", text: "乙" }], [{ id: "a", text: "甲" }, { id: "b,c", text: "乙" }]]) {
    rejects(() => validateQuestion(question("single", { options })), "ANSWER_INVALID");
  }
});

test("数值答案保留精确十进制文本，限制长度和指数而非浮点舍入", () => {
  for (const answer of ["9007199254740993", "0.10000000000000001", "+.5", "-1e100", "1e-100", "9".repeat(100)]) {
    const value = question("numeric", { answer });
    assert.doesNotThrow(() => validateQuestion(value));
    assert.equal(value.answer, answer);
  }
  for (const answer of ["NaN", "Infinity", "0x10", "1e101", "1e-101", "9".repeat(101), "1,2", ""]) {
    rejects(() => validateQuestion(question("numeric", { answer })), "ANSWER_INVALID");
  }
  rejects(() => validateQuestion(question("numeric", { options: [{ id: "a", text: "甲" }] })), "ANSWER_INVALID");
});

test("知识点权重为正整数、无重复、集合精确匹配且总和10000", () => {
  const weights = [{ knowledge_point_id: point, weight_bps: 3000 }, { knowledge_point_id: other, weight_bps: 7000 }];
  assert.deepEqual(knowledgeWeights(weights), weights);
  assert.doesNotThrow(() => validateQuestion(question("single", { knowledge_point_ids: [other, point], knowledge_weights: weights })));
  rejects(() => knowledgeWeights([{ knowledge_point_id: point, weight_bps: 5000 }, { knowledge_point_id: point, weight_bps: 5000 }]), "KNOWLEDGE_WEIGHTS_INVALID");
  for (const weight_bps of [0, -1, 0.5, 10001]) rejects(() => knowledgeWeights([{ knowledge_point_id: point, weight_bps }]), "VALIDATION_ERROR");
  for (const knowledge_weights of [[], [{ knowledge_point_id: point, weight_bps: 9999 }], [{ knowledge_point_id: other, weight_bps: 10000 }], weights]) {
    rejects(() => validateQuestion(question("single", { knowledge_weights })), "KNOWLEDGE_WEIGHTS_INVALID");
  }
});

test("学生DTO仅暴露白名单，章节只有教材归属与冻结revision而无edition_id别名", () => {
  const hidden = { license: { source: "私有授权" }, answer: "内部答案", explanation: "内部解析", scoring_rule: question().scoring_rule,
    knowledge_weights: question().knowledge_weights, difficulty_basis: "内部依据", org_id: other, notes: "内部备注", arbitrary_secret: "禁止透传" };
  const edition = { ...hidden, _id: point, textbook_id: other, title: "教材", edition_code: "2026", revision: 3, resource_ids: [] };
  assert.deepEqual(studentEdition(edition), { id: point, textbook_id: other, title: "教材", edition_code: "2026", revision: 3, resource_ids: [] });
  const chapter = { ...hidden, _id: point, textbook_edition_id: other, edition_id: "旧别名", parent_id: null, position: 0, title: "章节", body: "合法正文", knowledge_point_ids: [point], resource_ids: [] };
  assert.deepEqual(studentChapter(chapter, 7), { id: point, textbook_edition_id: other, edition_revision: 7, parent_id: null, position: 0, title: "章节", body: "合法正文", knowledge_point_ids: [point], resource_ids: [] });
});

test("授权撤销安全元数据禁止返回正文答案授权或资源引用", () => {
  const value = { ...question(), _id: point, question_id: other, version_no: 2, title: "题目", status: "published", revision: 4,
    access_revision: 5, access_revoked_at: "2026-09-21T00:00:00.000Z", access_revoked_by: other, access_revoked_reason: "授权终止",
    retired_at: null, retired_by: null, retired_reason: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-09-21T00:00:00.000Z",
    license: { source: "私有授权" }, resource_ids: [point], body: "私有正文", arbitrary_secret: "禁止透传" };
  const result = safeVersion(value);
  assert.deepEqual(result, { id: point, title: "题目", question_id: other, version_no: 2, status: "published", revision: 4,
    access_revision: 5, access_revoked_at: value.access_revoked_at, access_revoked_by: other, access_revoked_reason: "授权终止",
    retired_at: null, retired_by: null, retired_reason: null, created_at: value.created_at, updated_at: value.updated_at });
  const {question_id,version_no,...common}=value;
  const textbook = safeVersion({...common,textbook_id:other,edition_code:"2026"});
  assert.ok(!("question_id" in textbook)); assert.ok(!("version_no" in textbook));
  assert.equal(textbook.textbook_id,other); assert.equal(textbook.edition_code,"2026");
  assert.ok(Object.values(textbook).every(field=>field!==undefined));
});
