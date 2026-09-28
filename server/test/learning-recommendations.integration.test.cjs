"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { assessmentFixture, createQuestion, createQuiz, request, good, grant, practice } = require("./assessment-helpers.cjs");
const { guardedUri, status } = require("./helpers.cjs");
const list = f => good(f.student, `/me/recommendations?textbook_edition_id=${f.book.id}`);
const accept = (f, card, key = randomUUID()) => request(f.student, `/me/recommendations/${card.id}/practice-sessions`, { method:"POST", body:{}, key });
async function five(t) {
  const f = await assessmentFixture(t);
  f.questions.push(await createQuestion(f), await createQuestion(f));
  return f;
}
function practiceCard(value) { const card=value.items.find(row=>row.kind==="practice");assert.ok(card,JSON.stringify(value));return card; }

test("推荐API：真实候选、受理、权限与原key事务契约", { concurrency:false, timeout:600000 }, async t => {
  guardedUri(process.env.TEST_MONGODB_URI);
  await t.test("冷启动真实五题、稳定批次、同key并发恢复及冷却", async t => {
    const f=await five(t);
    const [a,b]=await Promise.all([list(f),list(f)]);
    assert.deepEqual(a,b);assert.equal(a.status,"insufficient_evidence");
    assert.equal(a.prerequisite_policy,"not_used_v1");assert.equal(a.graph_revision,null);
    assert.ok(a.items.length<=3);
    const card=practiceCard(a);assert.equal(card.count,5);assert.equal(card.difficulty,"基础");assert.equal(card.reason_code,"DIAGNOSTIC");
    assert.equal(card.independent_question_count,0);assert.equal(card.mastery,null);
    assert.equal("question_ids" in card,false);assert.equal("answer" in card,false);
    const key=randomUUID();const [one,two]=await Promise.all([accept(f,card,key),accept(f,card,key)]);
    status(one,200);status(two,200);assert.deepEqual(one.data.data,two.data.data);
    const session=one.data.data;assert.equal(session.item_count,5);
    const items=await f.db.collection("session_items").find({session_id:session.id}).toArray();
    assert.equal(items.length,5);assert.equal(new Set(items.map(row=>row.snapshot.question_id)).size,5);
    assert.ok(items.every(row=>row.learning_context.qualification==="first"));
    const frozen=await f.db.collection("recommendations").findOne({_id:card.id});
    assert.equal(frozen.created_session_id,session.id);assert.ok(frozen.accepted_at instanceof Date);
    assert.equal(await f.db.collection("sessions").countDocuments({member_id:f.student.memberId}),1);
    const repeat=await accept(f,card);status(repeat,409);assert.equal(repeat.data.error.code,"RECOMMENDATION_ALREADY_ACCEPTED");
    // Sufficient fresh identities still cannot bypass successful acceptance cooling.
    for(let n=0;n<5;n++)await createQuestion(f);
    assert.equal((await list(f)).items.some(row=>row.kind==="practice"),false);
    // 显式到期与卡清理是两个恢复边界：原 key 都必须返回原会话，不重建或刷新冷却。
    const past=new Date(Date.now()-1000);
    await f.db.collection("recommendations").updateOne({_id:card.id},{$set:{created_at:new Date(past.getTime()-1000),expires_at:past}});
    const expiredRestored=await accept(f,card,key);status(expiredRestored,200);assert.deepEqual(expiredRestored.data.data,session);
    assert.equal(await f.db.collection("sessions").countDocuments({member_id:f.student.memberId}),1);
    assert.deepEqual(await f.db.collection("session_items").find({session_id:session.id}).sort({_id:1}).toArray(),[...items].sort((a,b)=>a._id.localeCompare(b._id)));
    assert.equal(await f.db.collection("idempotency_records").countDocuments({org_id:f.org,user_id:f.student.user.user_id,operation:"learning.recommendation.practice"}),1);
    const expiredFrozen=await f.db.collection("recommendations").findOne({_id:card.id});
    assert.deepEqual(expiredFrozen.accepted_at,frozen.accepted_at);assert.equal(expiredFrozen.created_session_id,session.id);
    // Card cleanup cannot erase the successful original-key receipt.
    await f.db.collection("recommendations").deleteOne({_id:card.id});
    const restored=await accept(f,card,key);status(restored,200);assert.deepEqual(restored.data.data,session);
    await grant(f,f.editor,"content:revoke");
    const book=await good(f.editor,`/admin/textbook-editions/${f.book.id}`);
    await good(f.editor,`/admin/textbook-editions/${book.id}/revoke-access`,{method:"POST",body:{expected_access_revision:book.access_revision,reason:"隔离测试撤回教材"}});
    status(await accept(f,card,key),409);
  });
  await t.test("只有四题不发练习，阅读卡仅章节导航", async t => {
    const f=await assessmentFixture(t);await createQuestion(f);
    const result=await list(f);assert.equal(result.items.some(row=>row.kind==="practice"),false);
    assert.equal(result.items[0].kind,"reading");assert.equal(result.items[0].chapter_id,f.chapterId);
    assert.equal(result.items[0].count,0);status(await accept(f,result.items[0]),409);
    assert.equal(await f.db.collection("sessions").countDocuments({member_id:f.student.memberId}),0);
  });
  await t.test("候选已见、作者历史与考试embargo分别排除", async t => {
    const f=await five(t);
    await practice(f,{count:1});
    assert.equal((await list(f)).items.some(row=>row.kind==="practice"),false);
    // Two historical versions share an identity; only the replacement is published.
    const original=f.questions[0];
    const historical=await createQuestion(f,{question_id:original.question_id});
    await f.db.collection("question_versions").updateMany({_id:{$in:[original.id,historical.id]}},{$set:{status:"draft"}});
    const replacement=await createQuestion(f,{question_id:original.question_id});
    assert.equal(replacement.question_id,original.question_id);
    assert.equal(await f.db.collection("question_versions").countDocuments({question_id:original.question_id,status:"published"}),1);
    for(const field of ["created_by","contributors","published_by","submitted_by"]){
      const fresh=await f.actor();
      assert.equal(practiceCard(await list({...f,student:fresh})).count,5);
      await f.db.collection("question_versions").updateMany({_id:{$in:[original.id,historical.id]}},{$set:{[field]:field==="contributors"?[fresh.user.user_id]:fresh.user.user_id}});
      assert.equal((await list({...f,student:fresh})).items.some(row=>row.kind==="practice"),false,`${field} in historical versions must exclude the current replacement`);
    }
    f.questions[0]=replacement;
    const other=await f.actor();await createQuiz(f);
    assert.equal((await list({...f,student:other})).items.some(row=>row.kind==="practice"),false);
  });
  await t.test("过期与目录变动不创建会话", async t => {
    const f=await five(t);const card=practiceCard(await list(f));
    const past=new Date(Date.now()-1000);
    await f.db.collection("recommendations").updateOne({_id:card.id},{$set:{created_at:new Date(past.getTime()-1000),expires_at:past}});
    const expired=await accept(f,card);status(expired,409);assert.equal(expired.data.error.code,"RECOMMENDATION_EXPIRED");
    assert.equal(await f.db.collection("sessions").countDocuments({member_id:f.student.memberId}),0);
    const student=await f.actor();const next=practiceCard(await list({...f,student}));
    await createQuestion(f);
    const changed=await accept({...f,student},next);status(changed,409);assert.equal(changed.data.error.code,"RECOMMENDATION_EXPIRED");
  });
  await t.test("接受时重验候选及不同key并发只建一会话", async t => {
    const f=await five(t);const card=practiceCard(await list(f));
    const [a,b]=await Promise.all([accept(f,card),accept(f,card)]);
    assert.deepEqual([a.status,b.status].sort(),[200,409]);
    assert.equal(await f.db.collection("sessions").countDocuments({member_id:f.student.memberId}),1);
    const student=await f.actor();const candidate=practiceCard(await list({...f,student}));
    await practice({...f,student},{count:1});
    const unavailable=await accept({...f,student},candidate);status(unavailable,409);assert.equal(unavailable.data.error.code,"PRACTICE_SOURCE_UNAVAILABLE");
  });
  await t.test("不同卡同signature并发只成功一次且只写一次回执与冷却", async t => {
    const f=await five(t);
    // 留足十个真实发布题，使失败方即使看到已创建的五题会话，仍有五题可选。
    for(let n=0;n<5;n++)await createQuestion(f);
    const card=practiceCard(await list(f));
    const original=await f.db.collection("recommendations").findOne({_id:card.id});
    assert.ok(original);assert.equal(original.accepted_at,null);assert.equal(original.created_session_id,null);
    // 隔离 fixture 只有一个知识点；同批 GET 固定返回同一卡，改目录会使旧卡失效。
    // 因此仅克隆真实 API 已生成的合法未受理卡并分配另一个合法 rank；正式 validator/index 均保留。
    // 不预设会话、回执或冷却，两个受理请求都走真实 HTTP/Mongo 事务。
    const duplicate={...original,_id:randomUUID(),rank:2};
    await f.db.collection("recommendations").insertOne(duplicate);
    assert.notEqual(duplicate._id,card.id);assert.equal(duplicate.signature,original.signature);
    const cards=[card,{...card,id:duplicate._id}],keys=[randomUUID(),randomUUID()];
    const results=await Promise.all(cards.map((candidate,index)=>accept(f,candidate,keys[index])));
    assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
    const winner=results.findIndex(result=>result.status===200),loser=1-winner;
    assert.equal(results[loser].data.error.code,"RECOMMENDATION_ALREADY_ACCEPTED");
    const session=results[winner].data.data;
    assert.equal(await f.db.collection("sessions").countDocuments({member_id:f.student.memberId}),1);
    const items=await f.db.collection("session_items").find({session_id:session.id}).toArray();
    assert.equal(items.length,5);assert.equal(new Set(items.map(row=>row.snapshot.question_id)).size,5);
    const receipts=await f.db.collection("idempotency_records").find({org_id:f.org,user_id:f.student.user.user_id,operation:"learning.recommendation.practice"}).toArray();
    assert.equal(receipts.length,1);assert.equal(receipts[0].resource_id,cards[winner].id);
    assert.equal(receipts[0].key,keys[winner]);assert.equal(receipts[0].result.id,session.id);
    const signatureScope={org_id:f.org,member_id:f.student.memberId,signature:original.signature};
    const accepted=await f.db.collection("recommendations").find({...signatureScope,accepted_at:{$ne:null}}).toArray();
    assert.equal(accepted.length,1);assert.equal(accepted[0]._id,cards[winner].id);
    assert.equal(accepted[0].created_session_id,session.id);assert.ok(accepted[0].accepted_at instanceof Date);
    const rejected=await f.db.collection("recommendations").findOne({_id:cards[loser].id});
    assert.equal(rejected.accepted_at,null);assert.equal(rejected.created_session_id,null);
    assert.equal((await list(f)).items.some(row=>row.kind==="practice"),false);
    const restored=await accept(f,cards[winner],keys[winner]);status(restored,200);assert.deepEqual(restored.data.data,session);
    const retried=await accept(f,cards[loser],keys[loser]);status(retried,409);assert.equal(retried.data.error.code,"RECOMMENDATION_ALREADY_ACCEPTED");
    assert.equal(await f.db.collection("sessions").countDocuments({member_id:f.student.memberId}),1);
    assert.deepEqual(await f.db.collection("idempotency_records").find({org_id:f.org,user_id:f.student.user.user_id,operation:"learning.recommendation.practice"}).toArray(),receipts);
    assert.deepEqual(await f.db.collection("recommendations").find({...signatureScope,accepted_at:{$ne:null}}).toArray(),accepted);
  });
  await t.test("反馈曝光排除且成功卡24小时后可再次诊断", async t => {
    const f=await five(t);
    const { recordLearningFeedback }=require("../dist/learning/tracking.js");
    const tx=f.db.client.startSession();
    try{await tx.withTransaction(()=>recordLearningFeedback(f.db,{orgId:f.org,userId:f.student.user.user_id,session:tx},[f.questions[0].question_id]));}finally{await tx.endSession();}
    assert.equal((await list(f)).items.some(row=>row.kind==="practice"),false);
    const student=await f.actor();const other={...f,student};const card=practiceCard(await list(other));
    status(await accept(other,card),200);
    for(let n=0;n<5;n++)await createQuestion(f);
    assert.equal((await list(other)).items.some(row=>row.kind==="practice"),false);
    const earlier=new Date(Date.now()-25*60*60*1000);
    await f.db.collection("recommendations").updateOne({_id:card.id},{$set:{accepted_at:earlier,created_at:new Date(earlier.getTime()-1000)}});
    // A new catalog batch is generated without deleting the old successful receipt.
    await createQuestion(f);
    assert.equal(practiceCard(await list(other)).count,5);
  });
  await t.test("无最终推荐卡不把学科全部已评分题记为反馈", async t => {
    const f=await five(t);
    const session=await practice(f,{count:5});
    const items=await f.db.collection("session_items").find({session_id:session.id}).toArray();
    const answers=items.map(item=>({session_item_id:item._id,answer:item.snapshot.question_type==="numeric"?{value:item.snapshot.answer}:{selected_option_ids:item.snapshot.answer.split(",")}}));
    const submission=await good(f.student,`/sessions/${session.id}/submissions`,{method:"POST",body:{expected_revision:session.revision,answers}},202);
    const { processOne:gradeOne }=require("../dist/assessment/worker.js");
    for(let n=0;n<20;n++){
      if((await f.db.collection("submissions").findOne({_id:submission.submission_id})).grading_status==="completed")break;
      await gradeOne(f.db);
    }
    assert.equal((await f.db.collection("submissions").findOne({_id:submission.submission_id})).grading_status,"completed");
    const { processOne:projectOne }=require("../dist/learning/worker.js");
    for(let n=0;n<40;n++){
      await f.db.collection("outbox_events").updateMany({target_consumer:"learning_projection_v1",status:"pending"},[{$set:{available_at:"$$NOW"}}]);
      if(!await projectOne(f.db))break;
    }
    assert.equal(await f.db.collection("learning_question_states").countDocuments({user_id:f.student.user.user_id,feedback_seen:true}),0);
    const result=await list(f);assert.equal(result.status,"ready");assert.deepEqual(result.items,[]);
    assert.equal(await f.db.collection("learning_question_states").countDocuments({user_id:f.student.user.user_id,feedback_seen:true}),0);
    assert.equal(await f.db.collection("assessment_question_states").countDocuments({org_id:f.org,question_version_id:{$in:items.map(item=>item.snapshot.question_version_id)},answer_disclosed:true}),0);
  });
  await t.test("四项冲突能力与跨本人推荐不可旁路", async t => {
    const f=await five(t);const card=practiceCard(await list(f));
    const stranger=await f.actor();status(await accept({...f,student:stranger},card),404);
    for(const capability of ["content:edit","content:review","assessment:manage","assessment:review"]){
      const actor=capability==="content:edit"?await f.actor(["student","content_editor"]):capability==="content:review"?await f.actor(["student","content_reviewer"]):await f.actor(["student"],[capability]);
      status(await request(actor,`/me/recommendations?textbook_edition_id=${f.book.id}`),403);
      status(await accept({...f,student:actor},card),403);
    }
    status(await request(f.student,`/me/recommendations?textbook_edition_id=${f.book.id}&member_id=${stranger.memberId}`),422);
  });
});
