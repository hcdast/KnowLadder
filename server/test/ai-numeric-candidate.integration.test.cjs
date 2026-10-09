'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const {assessmentFixture,good}=require('./assessment-helpers.cjs');
const {pack,validate}=require('../../ops/ai-evaluation/numeric-validation.cjs');
test('真实数值题模型候选：正式HTTP保存隔离草稿及精确答案，不自动送审发布',{timeout:120000},async t=>{
  if(process.env.KL_REAL_NUMERIC_ARTIFACTS_VERIFY!=='true'){t.skip('仅显式验证保存的原创真实模型产物时运行');return;}
  const result=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../ops/artifacts/training-validation/revision99-real-numeric.json'),'utf8'));
  assert.equal(result.model,'gpt-5.5');assert.equal(result.transport,'real-gateway-numeric-supplement');assert.equal(result.corpus_sha256,crypto.createHash('sha256').update(JSON.stringify(pack)).digest('hex'));assert.equal(result.records.length,5);assert.equal(new Set(result.records.map(r=>r.case_id)).size,5);
  const f=await assessmentFixture(t);
  let count=0;
  for(const c of pack.cases){
    const record=result.records.find(r=>r.case_id===c.id);assert.ok(record);assert.equal(record.status,'succeeded');
    const validated=validate(c,JSON.parse(record.response_json).text);assert.equal(validated.status,'pass');
    const q=validated.candidate;
    const draft=await good(f.editor,'/admin/question-versions',{method:'POST',body:{...q,title:'真实模型原创数值候选 '+c.id,subject_id:f.subject,knowledge_point_ids:[f.knowledge],knowledge_weights:[{knowledge_point_id:f.knowledge,weight_bps:10000}],difficulty:'基础',difficulty_basis:'原创精确数值表达式隔离验证',license:{source:'KnowLadder本轮原创合成数值题验证',granted:true,expires_at:null}}});
    const row=await f.db.collection('question_versions').findOne({_id:draft.id});assert.ok(row);assert.equal(row.status,'draft');assert.equal(row.question_type,'numeric');assert.equal(row.answer,q.answer);assert.equal(row.published_at,null);assert.equal(validate(c,JSON.stringify({question_type:row.question_type,prompt:row.prompt,options:row.options,answer:row.answer,explanation:row.explanation,scoring_rule:row.scoring_rule})).status,'pass');count++;
  }
  assert.equal(count,5);
});
