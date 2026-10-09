"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  prepareKnowledgeChunks,
  knowledgeQueryTerms,
  rankKnowledgeCandidates,
  knowledgeChunkMatches,
  KNOWLEDGE_LIMITS,
} = require("../dist/training/knowledge-text");

test("知识分片保留原文UTF-16引用，重叠且不切开代理对", () => {
  const body = "甲😀".repeat(700);
  const chunks = prepareKnowledgeChunks(body);
  assert.equal(chunks[0].start_utf16, 0);
  assert.equal(chunks.at(-1).end_utf16, body.length);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    assert.ok(knowledgeChunkMatches(body, chunk));
    assert.ok(Array.from(chunk.text).length <= 800);
    if (i) assert.ok(chunk.start_utf16 < chunks[i - 1].end_utf16);
  }
  assert.equal(knowledgeChunkMatches("乙" + body.slice(1), chunks[0]), false);
  assert.equal(
    knowledgeChunkMatches(body, { ...chunks[0], content_hash: "wrong" }),
    false,
  );
});

test("索引和查询拒绝超限与畸形Unicode，不把超限变成截断成功", () => {
  assert.throws(
    () =>
      prepareKnowledgeChunks(
        "文".repeat(KNOWLEDGE_LIMITS.maxSourceCharacters + 1),
      ),
    { code: "KNOWLEDGE_SOURCE_LIMIT" },
  );
  assert.throws(() => prepareKnowledgeChunks("\ud800"), {
    code: "KNOWLEDGE_SOURCE_INVALID",
  });
  assert.throws(() => knowledgeQueryTerms("?"), {
    code: "KNOWLEDGE_QUERY_EMPTY",
  });
  assert.throws(() => knowledgeQueryTerms("a".repeat(257)), {
    code: "KNOWLEDGE_QUERY_INVALID",
  });
  assert.throws(
    () =>
      knowledgeQueryTerms(
        Array.from({ length: 65 }, (_, i) => `word${i}`).join(" "),
      ),
    { code: "KNOWLEDGE_QUERY_INVALID" },
  );
  assert.throws(
    () =>
      knowledgeQueryTerms(
        Array.from({ length: 65 }, (_, i) => `${i}`).join(" "),
      ),
    { code: "KNOWLEDGE_QUERY_LIMIT" },
  );
  assert.deepEqual(prepareKnowledgeChunks(" \n"), []);
});

test("中文双字/英文规范化匹配，稳定排序且无匹配返回空", () => {
  assert.deepEqual(knowledgeQueryTerms("ＡＩ 培训培训"), [
    "ai",
    "培训",
    "训培",
  ]);
  const candidates = ["b", "a"].map((source_key) => ({
    source_key,
    chunk: prepareKnowledgeChunks("原创AI培训资料")[0],
  }));
  assert.deepEqual(
    rankKnowledgeCandidates("ai 培训", candidates).map((x) => x.source_key),
    ["a", "b"],
  );
  assert.deepEqual(rankKnowledgeCandidates("biology", candidates), []);
  assert.throws(
    () => rankKnowledgeCandidates("ai", [...candidates, candidates[0]]),
    { code: "KNOWLEDGE_CANDIDATE_DUPLICATE" },
  );
  assert.throws(
    () => rankKnowledgeCandidates("ai", Array(201).fill(candidates[0])),
    { code: "KNOWLEDGE_CANDIDATE_LIMIT" },
  );
});

test("候选引用严格限定最多五条", () => {
  const candidates = Array.from({ length: 10 }, (_, i) => ({
    source_key: `source${i}`,
    chunk: prepareKnowledgeChunks("培训资料")[0],
  }));
  assert.equal(rankKnowledgeCandidates("培训", candidates).length, 5);
  const atLimit = prepareKnowledgeChunks(
    "文".repeat(KNOWLEDGE_LIMITS.maxSourceCharacters),
  );
  assert.ok(atLimit.length <= KNOWLEDGE_LIMITS.maxChunks);
  assert.equal(atLimit.at(-1).end_utf16, KNOWLEDGE_LIMITS.maxSourceCharacters);
});
