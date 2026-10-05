"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {randomUUID}=require("node:crypto");
const {assessmentFixture,practice,good}=require("./assessment-helpers.cjs");
const {status}=require("./helpers.cjs");
const {newId}=require("../dist/database/object-id");

test("真实gpt-5.5：隔离HTTP匿名学情派发及教师草稿采纳",{timeout:180000},async t=>{
  if(process.env.KL_REAL_AI_VERIFY_AUTHORIZED!=="true"){t.skip("仅显式授权真实模型验证时运行");return;}
  const evidence="../ops/artifacts/training-validation/revision97-real-system-http.json";
  assert.equal(require("node:fs").existsSync(evidence),false,"REAL_PROVIDER_EVIDENCE_ALREADY_EXISTS");
  const f=await assessmentFixture(t,{env:{KL_TRAINING_ENABLED:"true",KL_TRAINING_REPORTS_ENABLED:"true",KL_AI_POLICY_ENABLED:"true",KL_AI_LEARNING_REPORTS_ENABLED:"true",KL_AI_ENDPOINT:process.env.KL_AI_ENDPOINT,KL_AI_MODEL:process.env.KL_AI_MODEL,KL_AI_API_KEY:process.env.KL_AI_API_KEY}});
  const teacher=await f.actor(["teacher"],["training:report-edit","training:report-review","ai:generate","ai:manage","course:edit"]);
  const reviewer=await f.actor(["teacher"],["training:report-review"]);
  const now=new Date(), classId=newId();
  await f.db.collection("classes").insertOne({_id:classId,org_id:f.org,name:"原创匿名学情班",year_label:"2026",status:"active",revision:1,created_by:teacher.user.user_id,created_at:now,updated_at:now});
  for(const actor of [teacher,reviewer])await f.db.collection("teaching_assignments").insertOne({_id:newId(),org_id:f.org,class_id:classId,member_id:actor.memberId,subject_id:f.subject,status:"active",revision:1,valid_from:null,valid_to:null,created_at:now,updated_at:now});
  const post=(actor,path,body,key=randomUUID())=>actor.browser.request("/training"+path,{method:"POST",body,headers:{"X-Org-Id":f.org,"Idempotency-Key":key}});
  const ok=async(actor,path,body,key)=>{const r=await post(actor,path,body,key);status(r,200);return r.data.data;};
  const settle=async()=>{for(let i=0;i<30;i++)if(!await require("../dist/assessment/worker").processOne(f.db))break;for(let i=0;i<50;i++)if(!await require("../dist/learning/worker").processOne(f.db)){await require("../dist/learning/worker").processDue(f.db);break;}};
  const students=[];
  for(let i=0;i<5;i++){
    f.student=i===0?f.student:await f.actor();students.push(f.student);
    const s=await practice(f,{count:1});await good(f.student,"/sessions/"+s.id+"/submissions",{method:"POST",body:{expected_revision:s.revision,answers:[]}},202);
    if(i<4)await f.db.collection("class_members").insertOne({_id:newId(),org_id:f.org,class_id:classId,member_id:f.student.memberId,kind:"student",status:"active",valid_from:null,valid_to:null,created_at:now,updated_at:now});
  }
  await settle();
  let report=await ok(teacher,"/reports",{class_id:classId,subject_id:f.subject,title:"原创报告",body:"PRIVATE_MANUAL_BODY",task_id:null});
  const input=()=>({kind:"learning-report",context_id:report._id,prompt:"PRIVATE_TEACHER_PROMPT"});
  status(await post(students[0],"/ai/jobs",input()),403);
  const insufficient=await post(teacher,"/ai/jobs",input());status(insufficient,422);assert.equal(insufficient.data.error.code,"AI_LEARNING_EVIDENCE_INSUFFICIENT");
  assert.equal(await f.db.collection("ai_usage_ledger").countDocuments({org_id:f.org}),0);
  await f.db.collection("class_members").insertOne({_id:newId(),org_id:f.org,class_id:classId,member_id:students[4].memberId,kind:"student",status:"active",valid_from:null,valid_to:null,created_at:now,updated_at:now});
  report=await ok(teacher,"/reports/"+report._id+"/actions",{action:"refresh-facts",expected_revision:report.revision});
  assert.equal(JSON.parse(report.facts_json).learning.projected_count,5);
  await ok(teacher,"/ai/config",{enabled:true,daily_limit:20,expected_revision:0,enabled_kinds:["report"],currency:"USD",daily_budget_micro:5000000,max_request_micro:50000});
  const nativeFetch=global.fetch;let calls=0,sent=null,usage=null;
  global.fetch=async(url,options)=>{
    if(String(url)!==process.env.KL_AI_ENDPOINT)return nativeFetch(url,options);
    calls++;sent=JSON.parse(options.body);
    const response=await nativeFetch(url,options);
    try{const u=(await response.clone().json()).usage;if(u)usage={prompt_tokens:u.prompt_tokens??null,completion_tokens:u.completion_tokens??null,reasoning_tokens:u.completion_tokens_details?.reasoning_tokens??null};}catch{}
    return response;
  };
  t.after(()=>{global.fetch=nativeFetch;});
  let job=await ok(teacher,"/ai/jobs",input());
  // Claim the evidence path before any external dispatch, preventing concurrent/repeated paid probes.
  await require("node:fs/promises").writeFile(evidence,JSON.stringify({transport:"real-system-http",request_attempts:null,status:"in_flight",cost_usd:null})+"\n",{flag:"wx"});
  job=await ok(teacher,"/ai/jobs/"+job.id+"/dispatch",{expected_revision:job.revision});
  const record={transport:"real-system-http",model:"gpt-5.5",request_attempts:calls,status:job.status,usage,cost_usd:null,adoption:"not_tested",human_quality:"not_reviewed"};
  await require("node:fs/promises").writeFile(evidence,JSON.stringify(record,null,2)+"\n");
  assert.equal(calls,1);assert.equal(job.status,"succeeded");
  const outbound=JSON.stringify(sent);
  for(const value of [f.org,classId,f.subject,report._id,"PRIVATE_MANUAL_BODY","PRIVATE_TEACHER_PROMPT",...students.map(x=>x.memberId)])assert.equal(outbound.includes(value),false);
  const facts=report.facts_json;
  report=await ok(teacher,"/ai/jobs/"+job.id+"/accept-report",{expected_revision:report.revision});
  assert.equal(report.status,"draft");assert.equal(report.facts_json,facts);assert.match(report.body,/AI辅助解读/);
  record.adoption="draft_confirmed";record.anonymous_payload="verified";
  await require("node:fs/promises").writeFile(evidence,JSON.stringify(record,null,2)+"\n");
});
