'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {template,summarize,hash}=require('../../ops/ai-evaluation/results.cjs');
function success(pack,index=0){pack.transport='controlled';const r=pack.records[index];Object.assign(r,{status:'succeeded',response_json:JSON.stringify({text:'复述目标并确认验收条件。',source_keys:['original-source']}),reserved_micro:50000,usage:{prompt_tokens:100,completion_tokens:30,reasoning_tokens:10}});return r;}
function review(r,id,decision='approve'){return {reviewer_ref:id,response_sha256:hash(r.response_json),decision,source_fidelity:4,teaching_usefulness:4,boundary_awareness:4,notes:'已核对原创来源与教学步骤。'};}
test('blank and partial packs preserve per-capability unrun counts and pending verification',()=>{const p=template();let s=summarize(p);assert.equal(s.groups.assist.not_run,20);assert.equal(s.groups['learning-report'].not_run,10);assert.equal(s.overall,'pending_external_verification');p.records=[];s=summarize(p);assert.equal(s.rows.length,60);assert.equal(s.groups.questions.not_run,20);});
test('unreconciled unknown charges remain reserved; token counts never become supplier fees',()=>{const p=template();Object.assign(p.records[0],{status:'unknown',reserved_micro:70000});success(p,1);const s=summarize(p);assert.equal(s.budget.conservative_exposure_micro,120000);assert.equal(s.budget.billed_micro,0);assert.equal(s.groups.assist.unknown,1);assert.throws(()=>{p.records[0].response_json='lost output';summarize(p);},/UNSUCCESSFUL_OUTPUT/);});
test('five dollar aggregate cap and per-request reservations fail closed',()=>{let p=template();for(let i=0;i<2;i++)Object.assign(p.records[i],{status:'unknown',reserved_micro:3000000});assert.throws(()=>summarize(p),/BUDGET_EXCEEDED/);p=template();const r=success(p);r.billed_micro=50001;r.provider_receipt_ref='invoice_1';assert.throws(()=>summarize(p),/RESERVATION_EXCEEDED/);r.billed_micro=30000;assert.equal(summarize(p).budget.conservative_exposure_micro,30000);r.provider_receipt_ref=null;assert.throws(()=>summarize(p),/BILLING_RECEIPT_REQUIRED/);});
test('review binds exact output and requires two distinct reviewers with complete scores',()=>{const p=template(),r=success(p);r.reviews=[review(r,'reviewer_A')];assert.equal(summarize(p).groups.assist.human_pending,1);r.reviews.push(review(r,'reviewer_A'));assert.throws(()=>summarize(p),/INDEPENDENT_REVIEWERS_REQUIRED/);r.reviews[1]=review(r,'reviewer_B');assert.equal(summarize(p).groups.assist.human_approved,1);r.response_json=JSON.stringify({text:'改稿后的内容。',source_keys:['original-source']});assert.throws(()=>summarize(p),/STALE_REVIEW/);});
test('disagreements and invalid outputs cannot be hidden by aggregate averages',()=>{const p=template(),r=success(p);r.reviews=[review(r,'reviewer_A'),review(r,'reviewer_B','reject')];assert.equal(summarize(p).groups.assist.human_disagreement,1);r.response_json='bad';r.reviews=[review(r,'reviewer_A'),review(r,'reviewer_B')];assert.throws(()=>summarize(p),/INVALID_OUTPUT_APPROVAL/);r.reviews=[];assert.equal(summarize(p).groups.assist.structure_fail,1);});
test('duplicate cases, stale corpus and impossible reasoning usage are rejected',()=>{let p=template();p.records[1].case_id=p.records[0].case_id;assert.throws(()=>summarize(p),/INVALID_CASE_REF/);p=template();p.corpus_sha256='wrong';assert.throws(()=>summarize(p),/RESULT_CONTEXT_MISMATCH/);p=template();success(p).usage.reasoning_tokens=31;assert.throws(()=>summarize(p),/INVALID_USAGE/);});
test('complete controlled declarations cannot claim real model or production admission',()=>{
  const p=template();
  for(let i=0;i<60;i++){
    const r=success(p,i);
    if(i>=50)r.response_json=JSON.stringify({interpretation:'有效证据提示需继续观察。',suggestions:['安排巩固练习与反馈。'],source_keys:['effective-learning']});
    r.reviews=[review(r,'reviewer_A'),review(r,'reviewer_B')];
    r.billed_micro=0;r.provider_receipt_ref='controlled_receipt';
  }
  const s=summarize(p);assert.equal(s.review_status,'all_declared_reviews_approved');assert.equal(s.overall,'pending_external_verification');assert.equal(s.transport,'controlled');assert.equal(s.groups['learning-report'].human_approved,10);
  p.transport='not_run';assert.throws(()=>summarize(p),/TRANSPORT_STATUS_MISMATCH/);
});
test('CLI consumes real files, emits stable errors and never echoes malformed payloads',()=>{
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kl-eval-results-')),file=path.join(dir,'input.json'),script=path.resolve(__dirname,'../../ops/ai-evaluation/results.cjs');
  try{
    const generated=JSON.parse(cp.execFileSync(process.execPath,[script,'template'],{encoding:'utf8'}));
    fs.writeFileSync(file,JSON.stringify(generated));
    const summary=JSON.parse(cp.execFileSync(process.execPath,[script,'summarize',file],{encoding:'utf8'}));assert.equal(summary.groups.prepare.not_run,10);
    fs.writeFileSync(file,'{ sensitive_fixture_marker');
    const invalid=cp.spawnSync(process.execPath,[script,'summarize',file],{encoding:'utf8'});assert.equal(invalid.status,1);assert.equal(invalid.stderr.trim(),'RESULT_INPUT_INVALID');assert.equal(invalid.stdout,'');
  }finally{fs.unlinkSync(file);fs.rmdirSync(dir);}
});
