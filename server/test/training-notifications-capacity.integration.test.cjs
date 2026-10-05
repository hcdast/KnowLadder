"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { fixture, Browser, status } = require("./helpers.cjs");
const { newId } = require("../dist/database/object-id");
async function setup(t, env = {}, authorRoles = ["teacher"]) {
  const f = await fixture(t, { env: { KL_TRAINING_ENABLED: "true", ...env } });
  f.org = (
    await f.ops.createOrganization(f.context, {
      name: "职业培训隔离验收",
      kind: "school",
    })
  ).organization_id;
  const now = new Date();
  f.subject = newId();
  await f.db.collection("subjects").insertOne({
    _id: f.subject,
    code: "training-" + f.subject,
    name: "职业沟通",
    created_at: now,
    updated_at: now,
  });
  f.actor = async (roles, caps = []) => {
    const browser = new Browser(f.browser.base),
      user = await f.authenticated(browser);
    await f.ops.setMembership(f.context, {
      user_id: user.user_id,
      org_id: f.org,
      roles,
    });
    const member = await f.db
      .collection("organization_members")
      .findOne({ user_id: user.user_id, org_id: f.org });
    for (const capability of caps) {
      const m = await f.db
        .collection("organization_members")
        .findOne({ _id: member._id });
      await f.ops.setCapability(f.context, {
        org_id: f.org,
        member_id: member._id,
        capability,
        granted: true,
        expected_revision: m.authorization_revision,
        valid_to: new Date(Date.now() + 3600000),
      });
    }
    return { browser, user, member: member._id };
  };
  f.author = await f.actor(authorRoles, [
    ...(env.KL_TRAINING_REPORTS_ENABLED === "true"
      ? ["training:report-edit", "training:report-review"]
      : []),
    "course:edit",
    "course:assign",
    "task:manage",
    "coursework:grade",
    "ai:generate",
    "ai:manage",
  ]);
  f.reviewer = await f.actor(
    ["teacher"],
    [
      "course:review",
      ...(env.KL_TRAINING_REPORTS_ENABLED === "true"
        ? ["training:report-review"]
        : []),
    ],
  );
  f.student = await f.actor(["student"], ["ai:assist"]);
  f.stranger = await f.actor(["student"]);
  f.classId = newId();
  await f.db.collection("classes").insertOne({
    _id: f.classId,
    org_id: f.org,
    name: "培训班",
    year_label: "2026",
    status: "active",
    revision: 1,
    created_by: f.author.user.user_id,
    created_at: now,
    updated_at: now,
  });
  for (const actor of [f.author, f.reviewer])
    await f.db.collection("teaching_assignments").insertOne({
      _id: newId(),
      org_id: f.org,
      class_id: f.classId,
      member_id: actor.member,
      subject_id: f.subject,
      status: "active",
      revision: 1,
      valid_from: null,
      valid_to: null,
      created_at: now,
      updated_at: now,
    });
  await f.db.collection("class_members").insertOne({
    _id: newId(),
    org_id: f.org,
    class_id: f.classId,
    member_id: f.student.member,
    kind: "student",
    status: "active",
    valid_from: null,
    valid_to: null,
    created_at: now,
    updated_at: now,
  });
  f.req = (a, p, b, key = randomUUID()) =>
    a.browser.request("/training" + p, {
      method: b === undefined ? "GET" : "POST",
      body: b,
      headers: { "X-Org-Id": f.org, "Idempotency-Key": key },
    });
  f.good = async (a, p, b, key) => {
    const r = await f.req(a, p, b, key);
    status(r, 200);
    return r.data.data;
  };
  return f;
}

test('通知容量：50项分批、200项截断、并发去重与来源撤权', {timeout:180000}, async t=>{
 const f=await setup(t,{KL_TRAINING_PHASE2_ENABLED:'true'});const now=new Date();const taskId=newId();
 await f.db.collection('training_tasks').insertOne({_id:taskId,org_id:f.org,revision:1,created_at:now,updated_at:now,class_id:f.classId,subject_id:f.subject,created_by:f.author.user.user_id,title:'容量原创任务',target_type:'coursework',target_id:null,due_at:new Date(Date.now()+3600000),status:'published',body:'原创容量验证',rubric:[{key:'q',title:'质量',weight:100}],recipients:[f.student.member],published_at:now});
 const jobs=Array.from({length:205},(_,i)=>({_id:newId(),org_id:f.org,revision:1,created_at:new Date(now.getTime()+i),updated_at:now,user_id:f.student.user.user_id,member_id:f.student.member,source_type:'task',source_id:taskId,message:'原创站内事件'+i,status:'pending',lease_token:null,lease_until:null}));
 await f.db.collection('training_notification_outbox').insertMany(jobs);
 const read=()=>f.good(f.student,'/phase2/notifications');
 const first=await read();assert.equal(first.items.length,50);assert.equal(first.truncated,false);assert.equal(await f.db.collection('training_notification_outbox').countDocuments({status:'pending'}),155);
 const second=await read();assert.equal(second.items.length,100);
 await Promise.all([read(),read()]);
 assert.equal(await f.db.collection('training_notification_outbox').countDocuments({status:'pending'}),5);
 await read();const capped=await read();assert.equal(capped.items.length,200);assert.equal(capped.truncated,true);
 const stored=await f.db.collection('training_notifications').find().toArray();assert.equal(stored.length,205);assert.equal(new Set(stored.map(x=>x.event_id)).size,205);assert.equal(await f.db.collection('training_notification_outbox').countDocuments({status:'pending'}),0);
 assert.equal((await f.good(f.stranger,'/phase2/notifications')).items.length,0);
 await f.db.collection('training_tasks').updateOne({_id:taskId},{$set:{status:'cancelled'},$inc:{revision:1}});
 const hidden=await read();assert.equal(hidden.items.length,0);
 const lost={...jobs[0],_id:newId(),message:'失效来源不得物化',status:'pending'};await f.db.collection('training_notification_outbox').insertOne(lost);await read();assert.equal(await f.db.collection('training_notifications').countDocuments(),205);assert.equal((await f.db.collection('training_notification_outbox').findOne({_id:lost._id})).status,'delivered');
});
