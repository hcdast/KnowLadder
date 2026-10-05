"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeAiLearningFacts } = require("../dist/training/ai-learning-source");
const { RULE_VERSION } = require("../dist/learning/contracts");
function facts(roster = 5, projected = 5, bands = { insufficient_evidence: 0, weak: 5, developing: 0, mastered: 0 }) {
  return { learning: { status: "ready", rule_version: RULE_VERSION, roster_count: roster,
    projected_count: projected, mastery_bands: bands } };
}
test("AI学情发送边界：4人、4份有效证据与无证据均不合格", () => {
  for (const value of [facts(4,4), facts(5,4), {...facts(), learning:{...facts().learning,status:"insufficient"}}])
    assert.deepEqual(sanitizeAiLearningFacts(value), {eligible:false, reason:"insufficient_evidence"});
  assert.equal(sanitizeAiLearningFacts(facts()).eligible,true);
});
test("AI学情发送边界：小分类及两种补集均隐藏整个维度", () => {
  const split = { insufficient_evidence:0, weak:4, developing:1, mastered:0 };
  for (const value of [facts(5,5,split), facts(6,5), facts(10,6)]) {
    const result = sanitizeAiLearningFacts(value);
    assert.equal(result.eligible,true);
    assert.equal(result.source.mastery_bands,null);
    assert.equal("roster_count" in result.source,false);
    assert.equal("projected_count" in result.source,false);
  }
  assert.deepEqual(sanitizeAiLearningFacts(facts(15,10,{insufficient_evidence:0,weak:5,developing:0,mastered:5})).source.mastery_bands,
    {insufficient_evidence:0,weak:5,developing:0,mastered:5});
});
test("AI学情发送边界：不发送身份、正文、重叠薄弱点或缺分母的任务人数", () => {
  const value=facts();
  Object.assign(value.learning, {class_id:"PRIVATE_CLASS",subject_id:"PRIVATE_SUBJECT",student_name:"PRIVATE_NAME",
    submission_count_7d:1,weak_knowledge_points:[{knowledge_point_id:"PRIVATE_KP",title:"PRIVATE_TITLE",student_count:5}]});
  value.training={title:"PRIVATE_TASK",completion_count:1,completion_status:"available"};
  value.manual_body="PRIVATE_BODY";
  const output=JSON.stringify(sanitizeAiLearningFacts(value));
  assert.equal(output.includes("PRIVATE"),false);
  assert.equal(output.includes("submission_count"),false);
  assert.equal(output.includes("completion_count"),false);
  assert.equal(JSON.parse(output).source.training_completion,"unavailable");
});
test("AI学情发送边界：不接受非法、旧规则或不一致统计", () => {
  const values=[null,[],{}, {learning:[]},facts(201,5),facts(5,6),facts(5,5,{insufficient_evidence:0,weak:6,developing:0,mastered:0})];
  for(const n of [-1,1.5,NaN,Infinity,"5",null]) values.push(facts(n,5));
  values.push({...facts(),learning:{...facts().learning,rule_version:"old"}});
  for(const value of values) assert.deepEqual(sanitizeAiLearningFacts(value), {eligible:false,reason:"invalid_facts"});
});
