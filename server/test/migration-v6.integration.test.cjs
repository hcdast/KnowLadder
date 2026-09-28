"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {randomUUID}=require("node:crypto");
const {fixture}=require("./helpers.cjs");
const {assessmentFixture,practice}=require("./assessment-helpers.cjs");
const {migrateVersion6:migrate,migrateVersion1,migrateVersion2,migrateVersion3,migrateVersion4,migrateVersion5,assertSchemaVersion6:assertSchema,assertSchemaVersion5,inspectMigration}=require("../dist/migrations/schema.js");
const {LEARNING_API_V6_SCHEMAS,LEARNING_API_V6_CHECKSUM}=require("../dist/migrations/learning-api-v6.js");
const {LEARNING_V5_CHECKSUM}=require("../dist/migrations/learning-v5.js");
const V5_CHECKSUM="1faeffd5983acb20e7691a9dd014a122f877c2c6af204df9656c5b96de900ead";
async function capture(db) {
  const result={};
  for(const {name,options} of await db.listCollections().toArray()) result[name]={options,indexes:await db.collection(name).listIndexes().toArray(),rows:await db.collection(name).find().sort({_id:1}).toArray()};
  return result;
}
function readingRow(overrides={}) {
  return {_id:randomUUID(),org_id:randomUUID(),member_id:randomUUID(),chapter_id:randomUUID(),edition_id:randomUUID(),edition_revision:1,
    position:{kind:"text_offset",offset_utf16:0},completed:false,revision:1,updated_at:new Date(),cleared_at:null,...overrides};
}
test("v6迁移保留v1-v5完整账本、epoch与角色，仅完整DDL可就绪",{timeout:240000},async t=>{
  const f=await fixture(t,{migrated:false,app:false});
  await migrateVersion5(f.uri); await assertSchemaVersion5(f.db);
  assert.equal(LEARNING_V5_CHECKSUM,V5_CHECKSUM);
  await assert.rejects(assertSchema(f.db),/v6/);
  const before=await capture(f.db),report=await inspectMigration(f.uri);
  assert.equal(report.target_version,7); assert.equal(report.duplicate_keys,0);
  for(const name of Object.keys(LEARNING_API_V6_SCHEMAS)) assert.ok(report.new_collections.includes(name));
  assert.deepEqual(await capture(f.db),before,"inspect不得写DDL或数据");
  await migrate(f.uri); await assertSchema(f.db);
  const installed=await capture(f.db);
  for(const [name,prior] of Object.entries(before)) if(name!=="schema_migrations") assert.deepEqual(installed[name],prior);
  assert.deepEqual(installed.schema_migrations.rows.filter(row=>row.version<=5),before.schema_migrations.rows);
  for(const name of Object.keys(LEARNING_API_V6_SCHEMAS)) {
    assert.equal(installed[name].rows.length,0,"不得填充未来数据");
    assert.equal(installed[name].options.validationLevel,"strict");
    assert.equal(installed[name].options.validationAction,"error");
    assert.ok(installed[name].indexes.every(index=>index.expireAfterSeconds===undefined));
    await assert.rejects(f.db.collection(name).insertOne({_id:randomUUID(),unexpected:true}),error=>error.code===121);
  }
  for(const historical of [migrateVersion1,migrateVersion2,migrateVersion3,migrateVersion4,migrateVersion5,migrate]) await historical(f.uri);
  await assertSchema(f.db); assert.deepEqual(await capture(f.db),installed,"历史入口不得降级v6或重写账本");
});
test("v6活租约排他、部分DDL过期恢复、失败索引恢复不改v5epoch",{timeout:240000},async t=>{
  const f=await fixture(t,{migrated:false,app:false}); await migrateVersion5(f.uri);
  const historical=await capture(f.db),now=new Date();
  await f.db.collection("schema_migrations").insertOne({_id:randomUUID(),version:6,checksum:LEARNING_API_V6_CHECKSUM,status:"running",lease_token:randomUUID(),lease_until:new Date(now.getTime()+120000),created_at:now,started_at:now,completed_at:null,failed_at:null});
  await f.db.createCollection("recommendations",{validator:LEARNING_API_V6_SCHEMAS.recommendations.validator,validationLevel:"strict",validationAction:"error"});
  await assert.rejects(migrate(f.uri),/holds the lease/); await assert.rejects(assertSchema(f.db),/v6/);
  await f.db.collection("schema_migrations").updateOne({version:6},[{$set:{lease_until:{$subtract:["$$NOW",1]}}}]);
  await migrate(f.uri); await assertSchema(f.db);
  await f.db.collection("schema_migrations").updateOne({version:6},{$set:{status:"failed",completed_at:null,failed_at:new Date(),lease_token:null,lease_until:null}});
  await f.db.collection("reading_progress").dropIndex("reading_member_edition_page");
  await assert.rejects(assertSchema(f.db)); await migrate(f.uri); await assertSchema(f.db);
  assert.deepEqual(await f.db.collection("learning_tracking_config").find().toArray(),historical.learning_tracking_config.rows);
  assert.deepEqual(await f.db.collection("schema_migrations").find({version:{$lte:5}}).sort({_id:1}).toArray(),historical.schema_migrations.rows);
});
test("v6异常类型、归属、重复及历史checksum均只读拒绝",{timeout:240000},async t=>{
  const f=await fixture(t,{migrated:false,app:false}); await migrateVersion5(f.uri);
  const row=readingRow(); await f.db.collection("reading_progress").insertMany([row,{...row,_id:randomUUID(),revision:"1"}]);
  const before=await capture(f.db),report=await inspectMigration(f.uri);
  assert.equal(report.duplicate_keys,1); assert.equal(report.collections.reading_progress.invalid_types,1); assert.ok(report.invalid_references>0);
  assert.deepEqual(await capture(f.db),before); await assert.rejects(migrate(f.uri),/invalid types or references/);
  assert.deepEqual(await capture(f.db),before); assert.equal(await f.db.collection("schema_migrations").countDocuments({version:6}),0);
  await f.db.collection("reading_progress").drop();
  await f.db.collection("schema_migrations").updateOne({version:5},{$set:{checksum:"0".repeat(64)}});
  const corrupt=await capture(f.db);
  await assert.rejects(inspectMigration(f.uri),/checksum/); await assert.rejects(migrate(f.uri),/checksum/);
  assert.deepEqual(await capture(f.db),corrupt);
});
test("v6真实来源行、整数约束、最小阅读墓碑与推荐接受状态",{timeout:240000},async t=>{
  const f=await assessmentFixture(t),now=new Date();
  const progress=readingRow({org_id:f.org,member_id:f.student.memberId,chapter_id:f.chapterId,edition_id:f.book.id,edition_revision:f.book.revision});
  const event={_id:randomUUID(),org_id:f.org,member_id:f.student.memberId,event_id:randomUUID(),event_type:"reading_progress_set",request_hash:"a".repeat(64),chapter_id:f.chapterId,edition_id:f.book.id,edition_revision:f.book.revision,expected_revision:0,position:{kind:"text_offset",offset_utf16:0},completed:false,server_received_at:now,progress_revision:1};
  const card={_id:randomUUID(),org_id:f.org,member_id:f.student.memberId,user_id:f.student.user.user_id,subject_id:f.subject,textbook_edition_id:f.book.id,created_at:now,updated_at:now,request_key:"b".repeat(64),rank:1,generation:null,edition_revision:f.book.revision,catalog_revision:0,rule_version:"learning_v1",expires_at:new Date(now.getTime()+60000),kind:"practice",knowledge_point_ids:[f.knowledge],chapter_id:null,difficulty:"基础",count:5,reason_code:"DIAGNOSTIC",independent_question_count:0,mastery:null,signature:"c".repeat(64),accepted_at:null,created_session_id:null};
  await f.db.collection("reading_progress").insertOne(progress); await f.db.collection("behavior_events").insertOne(event); await f.db.collection("recommendations").insertOne(card);
  for(const [name,row,changes] of [["reading_progress",progress,{revision:1.5}],["reading_progress",progress,{position:null}],["behavior_events",event,{server_received_at:now.toISOString()}],["behavior_events",event,{position:{kind:"text_offset",offset_utf16:-1}}],["recommendations",card,{accepted_at:now}],["recommendations",card,{rank:4}],["recommendations",card,{unexpected:true}]])
    await assert.rejects(f.db.collection(name).updateOne({_id:row._id},{$set:changes}),error=>error.code===121);
  await assert.rejects(f.db.collection("reading_progress").insertOne({...progress,_id:randomUUID()}),error=>error.code===11000);
  await assert.rejects(f.db.collection("behavior_events").insertOne({...event,_id:randomUUID()}),error=>error.code===11000);
  await assert.rejects(f.db.collection("recommendations").insertOne({...card,_id:randomUUID()}),error=>error.code===11000);
  const session=await practice(f);
  await f.db.collection("recommendations").updateOne({_id:card._id},{$set:{accepted_at:now,created_session_id:session.id}});
  await f.db.collection("reading_progress").updateOne({_id:progress._id},{$set:{position:null,completed:null,cleared_at:now,updated_at:now},$inc:{revision:1}});
  const report=await inspectMigration(f.uri); assert.equal(report.invalid_references,0);
  for(const name of Object.keys(LEARNING_API_V6_SCHEMAS)) assert.equal(report.collections[name].invalid_types,0);
  const other=await f.actor();
  await Promise.all(f.apps.map(app=>app.close()));
  assert.equal(await f.db.collection("operational_writers").countDocuments({state:"running"}),0,"只读预检快照前必须真实关闭API并确认writer停止");
  await f.db.collection("recommendations").updateOne({_id:card._id},{$set:{user_id:other.user.user_id}});
  const corrupted=await capture(f.db); assert.ok((await inspectMigration(f.uri)).invalid_references>0);
  await assert.rejects(migrate(f.uri),/invalid types or references/); assert.deepEqual(await capture(f.db),corrupted);
});
