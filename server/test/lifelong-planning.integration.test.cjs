"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { setup } = require("./lifelong-fixture.cjs");
const { status } = require("./helpers.cjs");
const { LEARNING_COURSES } = require("../dist/lifelong/courses");
const input = (extra = {}) => ({ title: "观察与阅读", note: "自己安排学习", kind: "reading", scheduled_on: "2026-10-15", planned_minutes: 20, source_kind: "none", source_id: null, source_version: null, unit_id: null, ...extra });
const change = (revision, state, extra = {}) => ({ revision, state, note: "", completed_on: null, ...extra });
const study = () => ({ title: "复习观察方法", note: "区分事实与推断", bookmarked: true, course_id: null, course_version: null, unit_id: null, due_on: "2026-10-15" });

test("周计划：跨课程来源、暂停调整、本人完成与原课程进度分离、幂等与取消晚到", { timeout: 180000 }, async t => {
  const f = await setup(t), owner = await f.person(), other = await f.person(false), course = LEARNING_COURSES[0], unit = course.units[0];
  const before = await f.good(owner, `/courses/${course.id}`);
  const payload = input({ source_kind: "course", source_id: course.id, source_version: course.version, unit_id: unit.id });
  const key = randomUUID(), created = await f.good(owner, "/agenda", payload, key);
  assert.deepEqual(await f.good(owner, "/agenda", payload, key), created);
  assert.equal((await f.good(owner, "/agenda")).items.length, 1);
  status(await f.request(other, `/agenda/${created.resource_id}`, { ...payload, revision: 1 }, randomUUID(), "PATCH"), 404);
  await f.good(owner, `/agenda/${created.resource_id}/state`, change(1, "paused"));
  await f.good(owner, `/agenda/${created.resource_id}`, { ...payload, revision: 2, scheduled_on: "2026-10-16" }, randomUUID(), "PATCH");
  await f.good(owner, `/agenda/${created.resource_id}/state`, change(3, "planned"));
  const doneKey = randomUUID(), done = change(4, "completed", { note: "完成复述，仍需系统学习", completed_on: "2026-10-16" });
  await f.good(owner, `/agenda/${created.resource_id}/state`, done, doneKey);
  await f.good(owner, `/agenda/${created.resource_id}/state`, done, doneKey);
  const row = (await f.good(owner, "/agenda")).items[0];
  assert.equal(row.state, "completed"); assert.equal(row.revision, 5); assert.equal(row.evidence, "self_reported");
  assert.deepEqual((await f.good(owner, `/courses/${course.id}`)).learning, before.learning);
  assert.equal((await f.good(owner, "/activities")).items.length, 0);
  status(await f.request(owner, `/agenda/${row.id}/state`, change(5, "planned")), 409);
  status(await f.request(owner, `/agenda/${row.id}`, { ...payload, revision: 5 }, randomUUID(), "PATCH"), 409);
  const late = randomUUID(); await f.good(owner, `/operations/${late}/cancel`, {});
  status(await f.request(owner, "/agenda", input(), late), 409);
  await f.good(owner, `/agenda/${row.id}/remove`, { revision: 5 });
  assert.equal((await f.good(owner, "/agenda")).items.length, 0);
  const deleted = await f.db.collection("lifelong_agenda").findOne({ _id: row.id });
  assert.equal(deleted.title, "已移除"); assert.equal(deleted.completion_note, ""); assert.equal(deleted.source_id, null);
});

test("周计划：来源隔离、过期版本、日期与字段校验、分页作用域", { timeout: 180000 }, async t => {
  const f = await setup(t), owner = await f.person(false), other = await f.person();
  const goal = await f.good(owner, "/goals", f.goal()), note = await f.good(owner, "/study-items", study());
  for (const [kind, source] of [["goal", goal.resource_id], ["study", note.resource_id]]) {
    await f.good(owner, "/agenda", input({ source_kind: kind, source_id: source }));
    status(await f.request(other, "/agenda", input({ source_kind: kind, source_id: source })), 404);
  }
  const page = await f.good(owner, "/agenda?limit=1&week_start=2026-10-12"); assert.ok(page.next_cursor);
  assert.equal((await f.good(owner, `/agenda?limit=1&week_start=2026-10-12&cursor=${encodeURIComponent(page.next_cursor)}`)).items.length, 1);
  for (const prefix of ["/agenda?limit=2&week_start=2026-10-12", "/agenda?limit=1&week_start=2026-10-19"]) status(await f.request(owner, `${prefix}&cursor=${encodeURIComponent(page.next_cursor)}`), 422);
  status(await f.request(other, `/agenda?limit=1&week_start=2026-10-12&cursor=${encodeURIComponent(page.next_cursor)}`), 422);
  for (const extra of [{scheduled_on:"2026-02-30"},{planned_minutes:1441},{user_id:other.id},{source_kind:"none",source_id:goal.resource_id},{source_kind:"goal",source_id:"wrong"}]) status(await f.request(owner,"/agenda",input(extra)),422);
  const c=LEARNING_COURSES[0]; status(await f.request(owner,"/agenda",input({source_kind:"course",source_id:c.id,source_version:c.version+1,unit_id:c.units[0].id})),404);
  status(await f.request(owner,"/agenda?week_start=2026-10-13"),422);
  const original = (await f.good(owner,"/agenda")).items.find(r=>r.source_kind==="goal");
  await f.good(owner,`/goals/${goal.resource_id}/remove`,{revision:1});
  assert.equal((await f.good(owner,"/agenda")).items.find(r=>r.id===original.id).source_available,false);
  status(await f.request(owner,`/agenda/${original.id}/state`,change(1,"completed",{note:"完成",completed_on:"2026-10-15"})),409);
  await f.good(owner,`/agenda/${original.id}`,{...input({title:original.title,source_kind:"none"}),revision:1},randomUUID(),"PATCH");
  await f.good(owner,`/agenda/${original.id}/state`,change(2,"completed",{note:"解除来源后自行回顾",completed_on:"2026-10-15"}));
});

test("周汇总与周回顾：完整统计、预计投入口径、本人隔离和CAS", { timeout: 180000 }, async t => {
  const f=await setup(t), owner=await f.person(),other=await f.person();
  const rows=[];
  for(const date of ["2026-10-12","2026-10-15","2026-10-16","2026-10-17","2026-10-19"]) rows.push(await f.good(owner,"/agenda",input({scheduled_on:date})));
  await f.good(owner,`/agenda/${rows[1].resource_id}/state`,change(1,"completed",{note:"本人的完成说明",completed_on:"2026-10-15"}));
  await f.good(owner,`/agenda/${rows[2].resource_id}/state`,change(1,"paused"));
  await f.good(owner,`/agenda/${rows[3].resource_id}/state`,change(1,"cancelled"));
  const summary=await f.good(owner,"/week-overview?week_start=2026-10-12&as_of=2026-10-15");
  for(const [key,value] of Object.entries({total:4,completed:1,paused:1,cancelled:1,overdue:1,planned_minutes:60,truncated:false})) assert.equal(summary[key],value,key);
  const body={week_start:"2026-10-12",revision:0,highlights:"完成第一步",challenges:"安排过满",adjustment:"预留休息与复习"},key=randomUUID();
  const saved=await f.good(owner,"/week-reviews",body,key); assert.deepEqual(await f.good(owner,"/week-reviews",body,key),saved);
  status(await f.request(owner,"/week-reviews",body),409);
  await f.good(owner,"/week-reviews",{...body,revision:1,adjustment:"每天一小步"});
  const review=(await f.good(owner,"/week-overview?week_start=2026-10-12&as_of=2026-10-15")).review;assert.equal(review.revision,2);assert.equal(review.adjustment,"每天一小步");
  assert.equal((await f.good(other,"/week-overview?week_start=2026-10-12&as_of=2026-10-15")).total,0);
  assert.equal((await f.good(other,"/week-reviews")).items.length,0);
  await f.good(owner,`/week-reviews/${review.id}/remove`,{revision:2});
  assert.equal((await f.good(owner,"/week-reviews")).items.length,0);
  assert.equal((await f.db.collection("lifelong_week_reviews").findOne({_id:review.id})).highlights,"");
  await f.good(owner,"/week-reviews",body);
  assert.equal((await f.good(owner,"/week-reviews")).items[0].revision,4);
  assert.equal(await f.db.collection("lifelong_week_reviews").countDocuments({user_id:owner.id}),1);
  status(await f.request(owner,"/week-overview?week_start=2026-10-12&as_of=2026-02-30"),422);
  status(await f.request(owner,"/week-reviews",{...body,week_start:"2026-10-13"}),422);
});

test("复习事件：只记录真实新增历史、重复不追加、跨主体不可见、移除清正文", { timeout: 180000 }, async t => {
  const f=await setup(t),owner=await f.person(),other=await f.person(),saved=await f.good(owner,"/study-items",study());
  await f.db.collection("lifelong_study_items").updateOne({_id:saved.resource_id},{$set:{review_count:3,reviewed_on:"2026-10-10",review_note:"旧版最近一次回顾"}});
  assert.equal((await f.good(owner,`/study-items/${saved.resource_id}/reviews`)).items.length,0);
  const body={revision:1,answer:null,reviewed_on:"2026-10-15",next_due_on:"2026-10-18",note:"升级后的真实回顾"},key=randomUUID();
  await f.good(owner,`/study-items/${saved.resource_id}/review`,body,key);await f.good(owner,`/study-items/${saved.resource_id}/review`,body,key);
  const history=await f.good(owner,`/study-items/${saved.resource_id}/reviews`);assert.equal(history.items.length,1);assert.equal(history.items[0].ordinal,4);assert.equal(history.items[0].note,body.note);
  assert.equal((await f.good(owner,"/study-items")).items[0].suggested_interval_days,30);
  status(await f.request(other,`/study-items/${saved.resource_id}/reviews`),404);assert.equal((await f.good(other,"/review-history")).items.length,0);
  await f.good(owner,`/study-items/${saved.resource_id}/remove`,{revision:2});assert.equal((await f.good(owner,"/review-history")).items.length,0);
  assert.equal(await f.db.collection("lifelong_review_events").countDocuments({user_id:owner.id}),0);
});

test("v25：严格schema与索引、历史registry和重复迁移不改变v23/v24",{timeout:180000},async t=>{
  const f=await setup(t),schema=require("../dist/migrations/schema"),{PLANNING_CHECKSUM}=require("../dist/lifelong/planning-schema");
  const before=await f.db.collection("schema_migrations").find({version:{$in:[23,24]}}).toArray();
  await schema.migrate(f.uri);
  assert.deepEqual(await f.db.collection("schema_migrations").find({version:{$in:[23,24]}}).toArray(),before);
  assert.equal((await f.db.collection("schema_migrations").findOne({version:25})).checksum,PLANNING_CHECKSUM);
  assert.equal(schema.systemBackupRegistry().version,25);for(const v of [22,23,24])assert.ok(schema.supportedSystemBackupRegistries().some(r=>r.version===v));
  await assert.rejects(()=>f.db.collection("lifelong_agenda").insertOne({user_id:"invalid",title:"缺少字段"}));
  await f.db.collection("lifelong_agenda").dropIndex("agenda_week");await assert.rejects(()=>schema.assertSchema(f.db));
});
