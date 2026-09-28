"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {randomUUID}=require("node:crypto");
const {fixture}=require("./helpers.cjs");
const {migrateVersion5:migrate,migrateVersion1,migrateVersion2,migrateVersion3,migrateVersion4,assertSchemaVersion5:assertSchema,inspectMigration}=require("../dist/migrations/schema.js");
const {LEARNING_V5_SCHEMAS,LEARNING_V5_CHECKSUM}=require("../dist/migrations/learning-v5.js");
const HISTORY=["922f27041ecad2dcf2f84cd9a21ffc5c03f6c036ba4388448ba1e87b37798981","9b57b33d0960a86fda01be1993c165ac5a75dd0eca3c5b61897fd5702530d45a","33ee87fc50c219f7983c78a66d76960d7fafc747b03aea4b386cbfa4f8f59392","ea24f1e368a0b18855f6b4dbb265adbbbe9a759bfd90773d3928be9ea5c39ebd"];
async function capture(db) {
  const result={};
  for(const {name,options} of await db.listCollections().toArray()) result[name]={options,indexes:await db.collection(name).listIndexes().toArray(),rows:await db.collection(name).find().sort({_id:1}).toArray()};
  return result;
}
test("v5正式切换、只读预检与租约恢复",{concurrency:false,timeout:240000},async t=>{
  await t.test("历史checksum不变、旧入口不回退、仅完整迁移开放tracking",async t=>{
    const f=await fixture(t,{migrated:false,app:false});
    await migrateVersion4(f.uri);
    const history=await f.db.collection("schema_migrations").find().sort({version:1}).toArray();
    assert.deepEqual(history.map(row=>row.checksum),HISTORY);
    await assert.rejects(assertSchema(f.db),/v5/);
    const before=await capture(f.db);
    const report=await inspectMigration(f.uri);
    assert.equal(report.target_version,7); assert.equal(report.duplicate_keys,0);
    assert.ok(report.new_collections.includes("learning_question_states"));
    assert.deepEqual(await capture(f.db),before);
    assert.equal(await f.db.collection("learning_tracking_config").countDocuments(),0);
    await migrate(f.uri); await assertSchema(f.db);
    const config=await f.db.collection("learning_tracking_config").findOne({_id:"tracking"});
    assert.equal(config.tracking_ready,true); assert.ok(config.cutover_at instanceof Date);
    assert.match(config.epoch,/^[a-f0-9-]{36}$/);
    const installed=await capture(f.db);
    for(const historical of [migrateVersion1,migrateVersion2,migrateVersion3,migrateVersion4]) await historical(f.uri);
    await migrate(f.uri); await assertSchema(f.db);
    assert.deepEqual(await capture(f.db),installed);
    assert.deepEqual(await f.db.collection("schema_migrations").find({version:{$lte:4}}).sort({version:1}).toArray(),history);
    assert.equal(await f.db.collection("learning_question_states").countDocuments(),0,"迁移不得伪造曝光");
    for(const [name,shape] of Object.entries(LEARNING_V5_SCHEMAS)) {
      const info=await f.db.listCollections({name}).next();
      assert.deepEqual(info.options.validator,shape.validator);
      await assert.rejects(f.db.collection(name).insertOne({_id:randomUUID(),unexpected:true}),error=>error.code===121);
      assert.ok((await f.db.collection(name).listIndexes().toArray()).every(index=>index.expireAfterSeconds===undefined));
    }
  });
  await t.test("部分DDL失败不会开放tracking，过期租约恢复保留epoch",async t=>{
    const f=await fixture(t,{migrated:false,app:false}); await migrateVersion4(f.uri);
    const now=new Date();
    await f.db.collection("schema_migrations").insertOne({_id:randomUUID(),version:5,checksum:LEARNING_V5_CHECKSUM,status:"running",lease_token:randomUUID(),lease_until:new Date(now.getTime()+120000),created_at:now,started_at:now,completed_at:null,failed_at:null});
    await f.db.createCollection("learning_tracking_config",{validator:LEARNING_V5_SCHEMAS.learning_tracking_config.validator,validationLevel:"strict",validationAction:"error"});
    const config={_id:"tracking",epoch:randomUUID(),cutover_at:now,tracking_ready:false};
    await f.db.collection("learning_tracking_config").insertOne(config);
    await assert.rejects(migrate(f.uri),/holds the lease/);
    assert.deepEqual(await f.db.collection("learning_tracking_config").findOne({_id:"tracking"}),config);
    await assert.rejects(assertSchema(f.db));
    await f.db.collection("schema_migrations").updateOne({version:5},[{$set:{lease_until:{$subtract:["$$NOW",1]}}}]);
    await migrate(f.uri); await assertSchema(f.db);
    assert.deepEqual(await f.db.collection("learning_tracking_config").findOne({_id:"tracking"}),{...config,tracking_ready:true});
    await f.db.collection("schema_migrations").updateOne({version:5},{$set:{status:"failed",completed_at:null,failed_at:new Date(),lease_token:null,lease_until:null}});
    await f.db.collection("learning_projection_heads").dropIndex("learning_head_due");
    await assert.rejects(assertSchema(f.db)); await migrate(f.uri); await assertSchema(f.db);
    assert.equal((await f.db.collection("learning_tracking_config").findOne({_id:"tracking"})).epoch,config.epoch);
  });
  await t.test("重复键与归属异常只报告且拒绝写入marker",async t=>{
    const f=await fixture(t,{migrated:false,app:false}); await migrateVersion4(f.uri);
    const now=new Date(),org=randomUUID(),subject=randomUUID();
    const row={_id:randomUUID(),org_id:org,subject_id:subject,eligibility_revision:0,catalog_revision:0,access_fence:0,created_at:now,updated_at:now};
    await f.db.collection("learning_scope_states").insertMany([row,{...row,_id:randomUUID()}]);
    const before=await capture(f.db),report=await inspectMigration(f.uri);
    assert.equal(report.duplicate_keys,1); assert.ok(report.invalid_references>0);
    assert.deepEqual(await capture(f.db),before);
    await assert.rejects(migrate(f.uri),/invalid types or references/);
    assert.deepEqual(await capture(f.db),before);
    assert.equal(await f.db.collection("schema_migrations").countDocuments({version:5}),0);
  });
  await t.test("历史checksum漂移在任何DDL前拒绝且不自动修复",async t=>{
    const f=await fixture(t,{migrated:false,app:false}); await migrateVersion4(f.uri);
    await f.db.collection("schema_migrations").updateOne({version:2},{$set:{checksum:"0".repeat(64)}});
    const before=await capture(f.db);
    await assert.rejects(inspectMigration(f.uri),/checksum/); await assert.rejects(migrate(f.uri),/checksum/);
    assert.deepEqual(await capture(f.db),before);
  });
});

test("v5预检拒绝真实评分缺行，旧题项不补造学习资格",{concurrency:false,timeout:240000},async t=>{
  const {assessmentFixture,practice,good}=require("./assessment-helpers.cjs");
  const {processOne}=require("../dist/assessment/worker.js");
  const f=await assessmentFixture(t);
  const session=await practice(f);
  await f.db.collection("session_items").updateMany({session_id:session.id},{$unset:{learning_context:""}});
  const receipt=await good(f.student,`/sessions/${session.id}/submissions`,{method:"POST",body:{expected_revision:session.revision,answers:[]}},202);
  assert.equal(await processOne(f.db),true);
  const contexts=await f.db.collection("learning_attempt_contexts").find({submission_id:receipt.submission_id}).toArray();
  assert.equal(contexts.length,3); assert.ok(contexts.every(row=>row.qualification==="unknown"));
  await Promise.all(f.apps.map(app=>app.close()));
  assert.equal(await f.db.collection("operational_writers").countDocuments({state:"running"}),0,"快照前必须真实关闭API并确认writer停止");
  const before=await capture(f.db);
  const valid=await inspectMigration(f.uri);
  assert.equal(valid.incomplete_evidence,0); assert.equal(valid.history.untracked_items,3);
  await migrate(f.uri);
  assert.deepEqual(await capture(f.db),before,"幂等迁移不改变历史题项或资格");
  const result=await f.db.collection("grading_results").findOne();
  await f.db.collection("grading_results").deleteOne({_id:result._id});
  const corrupt=await capture(f.db);
  assert.ok((await inspectMigration(f.uri)).incomplete_evidence>0);
  await assert.rejects(migrate(f.uri),/incomplete assessment evidence/);
  assert.deepEqual(await capture(f.db),corrupt,"预检不得把缺行评分修复为零分");
});

test("v5 reconcile CLI显式apply原子保存重建请求与安全审计",{concurrency:false,timeout:240000},async t=>{
  const {assessmentFixture,practice,good}=require("./assessment-helpers.cjs");
  const {processOne}=require("../dist/assessment/worker.js");
  const {promisify}=require("node:util");
  const execFile=promisify(require("node:child_process").execFile);
  const f=await assessmentFixture(t);
  const session=await practice(f);
  await good(f.student,`/sessions/${session.id}/submissions`,{method:"POST",body:{expected_revision:session.revision,answers:[]}},202);
  assert.equal(await processOne(f.db),true);
  const run=(args=[])=>execFile(process.execPath,[require.resolve("../dist/learning/worker.js"),"reconcile",...args],{env:{...process.env,MONGODB_URI:f.uri},timeout:30000});
  await Promise.all(f.apps.map(app=>app.close()));
  assert.equal(await f.db.collection("operational_writers").countDocuments({state:"running"}),0,"只读CLI快照前必须真实关闭API并确认writer停止");
  const before=await capture(f.db);
  const preview=JSON.parse((await run()).stdout.trim());
  assert.equal(preview.apply,false); assert.equal(preview.missing_heads,1); assert.equal(preview.requested,0);
  assert.deepEqual(await capture(f.db),before,"默认reconcile只读");
  await assert.rejects(run(["--apply"]));
  assert.deepEqual(await capture(f.db),before,"缺失actor/reason不可留部分重建请求");
  const applied=JSON.parse((await run(["--apply","--actor","v5-migration-test","--reason","原创隔离学情重建验收"])).stdout.trim());
  assert.equal(applied.apply,true); assert.equal(applied.requested,1);
  const head=await f.db.collection("learning_projection_heads").findOne({org_id:f.org,member_id:f.student.memberId,subject_id:f.subject});
  assert.equal(head.rebuild_requested,true); assert.equal(head.active_generation,null);
  const audits=await f.db.collection("audit_events").find({action:"learning.reconcile"}).toArray();
  assert.equal(audits.length,1);
  assert.equal(audits[0].resource_type,"student_projection"); assert.equal(audits[0].resource_id,f.student.memberId);
  assert.equal(audits[0].actor_id,"v5-migration-test"); assert.equal(audits[0].reason,"原创隔离学情重建验收");
  assert.equal(audits[0].org_id,f.org); assert.ok(audits[0].created_at instanceof Date);
  const inspected=await inspectMigration(f.uri);
  assert.equal(inspected.collections.audit_events.invalid_types,0);
  await migrateVersion4(f.uri); await migrate(f.uri); await assertSchema(f.db);
  assert.deepEqual(await f.db.collection("audit_events").find({action:"learning.reconcile"}).toArray(),audits);
});
