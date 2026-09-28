"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { guardedUri, status } = require("./helpers.cjs");
const { assessmentFixture, createQuestion, request, good } = require("./assessment-helpers.cjs");
const { processOne: grade } = require("../dist/assessment/worker.js");
const { processOne: project } = require("../dist/learning/worker.js");

// Exercise the documented schema subset against real HTTP data, including nullable enums and refs.
function matches(document, schema, value, label) {
  if (schema.$ref) {
    const name = schema.$ref.split("/").at(-1);
    assert.ok(document.components.schemas[name], `${label}: missing schema reference`);
    return matches(document, document.components.schemas[name], value, label);
  }
  if (schema.oneOf) {
    let matched = 0;
    for (const alternative of schema.oneOf) {
      try { matches(document, alternative, value, label); matched++; } catch (error) { if (!(error instanceof assert.AssertionError)) throw error; }
    }
    assert.equal(matched, 1, `${label}: oneOf mismatch`);
    return;
  }
  if (schema.enum) assert.ok(schema.enum.some(item => Object.is(item, value)), `${label}: enum mismatch`);
  if (value === null) { assert.equal(schema.nullable, true, `${label}: null is not allowed`); return; }
  if (schema.type === "object") {
    assert.ok(typeof value === "object" && !Array.isArray(value), `${label}: expected object`);
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${label}.${key}: missing`);
    for (const [key, child] of Object.entries(value)) {
      if (schema.additionalProperties === false) assert.ok(Object.hasOwn(schema.properties, key), `${label}.${key}: undocumented`);
      if (schema.properties?.[key]) matches(document, schema.properties[key], child, `${label}.${key}`);
    }
  } else if (schema.type === "array") {
    assert.ok(Array.isArray(value), `${label}: expected array`);
    if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems, `${label}: array bound`);
    for (const child of value) matches(document, schema.items, child, `${label}[]`);
  } else if (schema.type === "string") {
    assert.equal(typeof value, "string", `${label}: expected string`);
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern), `${label}: pattern`);
  } else if (schema.type === "integer") {
    assert.ok(Number.isSafeInteger(value), `${label}: expected integer`);
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${label}: minimum`);
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, `${label}: maximum`);
  } else if (schema.type === "boolean") assert.equal(typeof value, "boolean", `${label}: expected boolean`);
}
function fields(document, name, value) {
  matches(document, { $ref: `#/components/schemas/Learning${name}` }, value, `Learning${name}`);
}

test("S4-03 真实OpenAPI与九条学习HTTP路由响应契约一致", { timeout: 180000 }, async t => {
  guardedUri(process.env.TEST_MONGODB_URI);
  const f = await assessmentFixture(t);
  await createQuestion(f, { title: "契约验证第四题" });
  await createQuestion(f, { title: "契约验证第五题" });
  const openapi = await fetch(`${f.browser.base}/api/openapi.json`, { signal: AbortSignal.timeout(15000) });
  assert.equal(openapi.status, 200);
  const document = await openapi.json();
  for (const [path, method] of [
    ["me/mastery", "get"], ["me/reports", "get"], ["me/mistakes", "get"], ["me/mistakes/{id}", "get"],
    ["me/mistakes/{id}/practice-sessions", "post"], ["me/recommendations", "get"],
    ["me/recommendations/{id}/practice-sessions", "post"], ["me/reading-progress", "get"], ["behavior-events", "post"],
  ]) {
    const operation = document.paths[`/api/v1/${path}`][method];
    assert.deepEqual(operation.security, [{ session: [] }]);
    assert.ok(operation.parameters.some(p => p.name === "X-Org-Id" && p.required));
    assert.ok(operation.responses[200].content["application/json"].schema.properties.data);
    if (method === "post") {
      assert.ok(operation.parameters.some(p => p.name === "X-CSRF-Token" && p.required));
      assert.equal(operation.parameters.some(p => p.name === "Idempotency-Key" && p.required), path !== "behavior-events");
    }
  }
  const initial = await request(f.student, `/me/mastery?subject_id=${f.subject}`);
  status(initial, 200);
  assert.match(initial.headers.get("cache-control"), /no-store/);
  fields(document, "Mastery", initial.data.data);
  assert.equal(initial.data.data.status, "insufficient_evidence");
  assert.equal(initial.data.data.source_watermark, null);
  assert.deepEqual(initial.data.data.items, []);

  const reading = await good(f.student, `/me/reading-progress?textbook_edition_id=${f.book.id}`);
  fields(document, "ReadingPage", reading);
  assert.equal(reading.items.length, 1);
  fields(document, "ReadingProgress", reading.items[0]);
  assert.equal(reading.items[0].position, null);
  const readingInput = { event_type: "reading_progress_set", event_id: randomUUID(), textbook_edition_id: f.book.id, chapter_id: f.chapterId,
    edition_revision: f.book.revision, expected_revision: 0, position: { kind: "text_offset", offset_utf16: 2 }, completed: false };
  fields(document, "ReadingEvent", readingInput);
  const readingResponse = await f.student.browser.request("/behavior-events", { method: "POST", headers: { "X-Org-Id": f.org }, body: readingInput });
  status(readingResponse, 200); // Deliberately no Idempotency-Key: event_id owns this contract.
  const readingResult = readingResponse.data.data;
  fields(document, "ReadingResult", readingResult);
  assert.equal(readingResult.progress_revision, 1);

  const recommendations = await good(f.student, `/me/recommendations?textbook_edition_id=${f.book.id}`);
  fields(document, "Recommendations", recommendations);
  for (const card of recommendations.items) fields(document, "RecommendationCard", card);
  const card = recommendations.items.find(item => item.kind === "practice");
  assert.ok(card, "五道真实合法新题应提供基础诊断卡");
  const session = await good(f.student, `/me/recommendations/${card.id}/practice-sessions`, { method: "POST", body: {} });
  matches(document, { $ref: "#/components/schemas/AssessmentSession" }, session, "RecommendationSession");
  assert.equal(session.item_count, 5);
  const receipt = await good(f.student, `/sessions/${session.id}/submissions`, { method: "POST", body: { expected_revision: session.revision, answers: [] } }, 202);
  assert.ok(receipt.submission_id);
  assert.equal(await grade(f.db), true);
  assert.equal(await project(f.db), true);

  const mastery = await good(f.student, `/me/mastery?subject_id=${f.subject}`);
  fields(document, "Mastery", mastery);
  assert.equal(mastery.status, "ready");
  assert.equal(mastery.items.length, 1);
  fields(document, "MasteryItem", mastery.items[0]);
  assert.equal(mastery.items[0].independent_question_count, 5);
  assert.equal(mastery.items[0].mastery, "0.00");
  const report = await good(f.student, `/me/reports?subject_id=${f.subject}&period=7d`);
  fields(document, "Reports", report);
  assert.equal(report.activity.attempt_count, 5);
  assert.equal(report.activity.unanswered_count, 5);
  const mistakes = await good(f.student, `/me/mistakes?subject_id=${f.subject}`);
  fields(document, "Mistakes", mistakes);
  assert.equal(mistakes.total, 5);
  for (const item of mistakes.items) fields(document, "MistakeItem", item);
  const mistake = await good(f.student, `/me/mistakes/${mistakes.items[0].id}`);
  fields(document, "Mistake", mistake);
  assert.equal(mistake.practice_version_policy, "current_published");
  const retry = await good(f.student, `/me/mistakes/${mistake.id}/practice-sessions`, { method: "POST", body: {} });
  matches(document, { $ref: "#/components/schemas/AssessmentSession" }, retry, "MistakeSession");
  assert.equal(retry.item_count, 1);
  assert.notEqual(retry.id, session.id);
});
