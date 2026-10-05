const {test}=require('node:test');
const assert=require('node:assert/strict');
const {probe,requestBody}=require('../../ops/ai-evaluation/live-smoke.cjs');
const corpus=require('../../ops/ai-evaluation/cases.json');
test('smoke matches production request parameters and sends original source only',()=>{const b=requestBody(corpus.cases[0]);assert.equal(b.model,'gpt-5.5');assert.equal(b.max_tokens,2000);assert.equal(b.temperature,0.2);assert.equal(b.messages.length,2);assert.deepEqual(JSON.parse(b.messages[1].content).sources,corpus.cases[0].sources);});
test('success retains structured output and supplier usage without claiming a fee',async()=>{const r=await probe(corpus.cases[0],{},async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({text:'确认目标与验收条件。',source_keys:['original-source']})}}],usage:{prompt_tokens:50,completion_tokens:30,completion_tokens_details:{reasoning_tokens:10}}})));assert.equal(r.status,'succeeded');assert.equal(r.usage.reasoning_tokens,10);assert.equal(r.cost_usd,null);});
test('rejected or lost responses invoke transport once and do not expose secrets',async()=>{for(const mode of ['http','throw']){let calls=0;const r=await probe(corpus.cases[0],{},async()=>{calls++;if(mode==='throw')throw Error('sensitive_fixture_marker');return new Response('sensitive_fixture_marker',{status:400});});assert.equal(calls,1);assert.equal(r.status,'unknown');assert.ok(!JSON.stringify(r).includes('sensitive_fixture_marker'));}});
test('numeric learning output is rejected and not retained',async()=>{const r=await probe(corpus.cases[50],{},async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({interpretation:'5人通过',suggestions:['练习'],source_keys:['effective-learning']})}}]})));assert.equal(r.status,'unknown');assert.equal(r.response_json,null);assert.equal(r.error_code,'OUTPUT_STRUCTURE_REJECTED');});
test('continuation excludes four completed cases and rejects unknown prior outcomes',()=>{
  const {remainingCases}=require('../../ops/ai-evaluation/live-smoke.cjs');
  const prior={model:'gpt-5.5',transport:'real-gateway-smoke',corpus_sha256:require('../../ops/ai-evaluation/check.cjs').validateCorpus().sha256,finished_at:'fixture',records:[0,20,30,50].map(i=>({case_id:corpus.cases[i].id,status:'succeeded',http_status:200,response_json:JSON.stringify(i===50?{interpretation:'需要巩固基础。',suggestions:['安排练习。'],source_keys:['effective-learning']}:{text:'原创教学建议。',source_keys:['original-source']})}))};
  const next=remainingCases(prior);assert.equal(next.length,56);assert.ok(next.every(c=>!prior.records.some(r=>r.case_id===c.id)));
  prior.records[0].status='unknown';assert.throws(()=>remainingCases(prior),/INVALID_PRIOR_BATCH/);
});
