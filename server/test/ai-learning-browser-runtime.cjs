"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {randomUUID}=require("node:crypto");
const {assessmentFixture,practice,good}=require("./assessment-helpers.cjs");
const {status}=require("./helpers.cjs");
const {newId}=require("../dist/database/object-id");

(async()=>{
const cleanup=[];let rs;try { const t={after:cb=>cleanup.push(cb)};
const {MongoMemoryReplSet}=require("mongodb-memory-server-core");rs=await MongoMemoryReplSet.create({binary:{version:"8.0.17"},replSet:{count:1,storageEngine:"wiredTiger"},instanceOpts:[{args:["--wiredTigerCacheSizeGB","0.25"]}]});
process.env.TEST_MONGODB_URI=rs.getUri("kl_test_ai_learning_browser");
const {Browser}=require("./helpers.cjs");const originalRequest=Browser.prototype.request;Browser.prototype.request=function(path,options={}){return originalRequest.call(this,path,{...options,origin:"http://127.0.0.1:5194"});};
  const f=await assessmentFixture(t,{env:{APP_ORIGIN:"http://127.0.0.1:5194",KL_TRAINING_ENABLED:"true",KL_TRAINING_REPORTS_ENABLED:"true",KL_AI_POLICY_ENABLED:"true",KL_AI_LEARNING_REPORTS_ENABLED:"true",KL_AI_ENDPOINT:"https://ai-learning.invalid/v1/chat/completions",KL_AI_MODEL:"controlled-test",KL_AI_API_KEY:"controlled-fixture-only"}});
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
  const insufficient=await post(teacher,"/ai/jobs",input());status(insufficient,422);assert.equal(insufficient.data.error.code,"AI_LEARNING_EVIDENCE_INSUFFICIENT");
  assert.equal(await f.db.collection("ai_usage_ledger").countDocuments({org_id:f.org}),0);
  await f.db.collection("class_members").insertOne({_id:newId(),org_id:f.org,class_id:classId,member_id:students[4].memberId,kind:"student",status:"active",valid_from:null,valid_to:null,created_at:now,updated_at:now});
  report=await ok(teacher,"/reports/"+report._id+"/actions",{action:"refresh-facts",expected_revision:report.revision});
  assert.equal(JSON.parse(report.facts_json).learning.projected_count,5);
  await ok(teacher,"/ai/config",{enabled:true,daily_limit:20,expected_revision:0,enabled_kinds:["report"],currency:"USD",daily_budget_micro:5000000,max_request_micro:50000});
  const originalFetch=global.fetch;let calls=0,mode="valid",sent=[];
  global.fetch=async(url,opts)=>{
    if(String(url)!=="https://ai-learning.invalid/v1/chat/completions")return originalFetch(url,opts);
    calls++;sent.push(JSON.parse(opts.body));
    if(mode==="unknown")throw Error("CONTROLLED_RESPONSE_LOST");
    if(mode==="change")await ok(teacher,"/reports/"+report._id+"/actions",{action:"edit",expected_revision:report.revision,title:report.title,body:"并发教师改稿"});
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({interpretation:mode==="numeric"?"已有5人掌握":"证据仍有限，宜继续观察。",suggestions:["安排基础巩固练习。"],source_keys:["effective-learning"]})}}]}),{status:200});
  };
  t.after(()=>{global.fetch=originalFetch;});

const {writeFile}=require("node:fs/promises");await writeFile("../ops/artifacts/training-validation/revision94-browser-ready.json",JSON.stringify({api:f.browser.base,login_name:teacher.user.login_name,org_id:f.org,report_id:report._id}));console.log("AI_LEARNING_BROWSER_READY");process.stdin.resume();await new Promise(resolve=>{process.stdin.on("data",data=>{if(String(data).includes("stop"))resolve();});process.on("SIGINT",resolve);process.on("SIGTERM",resolve);const timer=setInterval(async()=>{try{await require("node:fs/promises").access("../ops/artifacts/training-validation/revision94-browser-stop");clearInterval(timer);resolve();}catch{}},500);});} finally {for(const cb of cleanup.reverse()){try{await cb();}catch{}}await rs?.stop();for(const path of ["../ops/artifacts/training-validation/revision94-browser-ready.json","../ops/artifacts/training-validation/revision94-browser-stop"]){await require("node:fs/promises").rm(path,{force:true});}console.log("AI_LEARNING_BROWSER_STOPPED");}})().catch(e=>{console.error(e.message);process.exitCode=1;});
