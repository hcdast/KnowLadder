const { test } = require('node:test');
const assert = require('node:assert/strict');
const tool = require('../../ops/ai-evaluation/check.cjs');
const corpus = require('../../ops/ai-evaluation/cases.json');
test('60 original cases have exact ability distribution and safe anonymous groups', () => {
  assert.equal(tool.validateCorpus().cases, 60);
  const bad = structuredClone(corpus); bad.cases[50].sources[0].text = JSON.stringify({rule_version:'learning_v1',mastery_bands:{insufficient_evidence:1,weak:5,developing:0,mastered:0},training_completion:'unavailable'});
  assert.throws(()=>tool.validateCorpus(bad), /UNSAFE_GROUP/);
  const duplicate = structuredClone(corpus); duplicate.cases[1].id = duplicate.cases[0].id;
  assert.throws(()=>tool.validateCorpus(duplicate), /INVALID_CASE/);
});
test('structure pass never substitutes human pedagogical review', () => {
  const result = tool.checkOutput(corpus.cases[0], JSON.stringify({text:'先确认需求，再记录结论。',source_keys:['original-source']}));
  assert.equal(result.structure, 'pass'); assert.equal(result.pedagogy, 'pending_two_human_reviewers');
  assert.equal(tool.reviewRows().length,60);
  assert.ok(tool.reviewRows().every(r=>r.reviews.length===2 && r.reviews.every(x=>x.reviewer===null && x.decision===null)));
});
test('malformed responses and unknown citations fail closed', () => {
  for (const raw of ['bad','null','[]',JSON.stringify({text:'答案',source_keys:['unknown']}), 'x'.repeat(100001)]) assert.equal(tool.checkOutput(corpus.cases[0],raw).structure,'fail');
});
test('learning report rejects numbers, invalid shape and empty suggestions', () => {
  const c=corpus.cases[50], good={interpretation:'有效证据提示需要巩固基础。',suggestions:['安排示范与反馈。'],source_keys:['effective-learning']};
  assert.equal(tool.checkOutput(c,JSON.stringify(good)).structure,'pass');
  for(const interpretation of ['5人','５０％','三人']) assert.equal(tool.checkOutput(c,JSON.stringify({...good,interpretation})).code,'AI_NUMERIC_CLAIM');
  assert.equal(tool.checkOutput(c,JSON.stringify({...good,suggestions:[]})).structure,'fail');
  assert.equal(tool.checkOutput(c,JSON.stringify({...good,score:99})).structure,'fail');
});
test('preflight does not leak key or claim paid budget readiness', () => {
  const env={KL_AI_ENDPOINT:'https://sub2api.akool.icu/v1/chat/completions',KL_AI_MODEL:'gpt-5.5',KL_AI_API_KEY:'test-secret',KL_AI_POLICY_ENABLED:'true'};
  const r=tool.preflight(env); assert.equal(r.endpoint_matches,true); assert.equal(r.external_requests,0); assert.equal(r.spent_usd,0); assert.ok(!JSON.stringify(r).includes('test-secret'));
  assert.equal(tool.preflight({...env,KL_AI_ENDPOINT:'https://sub2api.akool.icu/v1/chat/completions?key=secret'}).endpoint_matches,false);
});
