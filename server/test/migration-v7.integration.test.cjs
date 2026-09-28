"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {randomUUID}=require("node:crypto");
const {fixture}=require("./helpers.cjs");
const {migrate,migrateVersion1,migrateVersion2,migrateVersion3,migrateVersion4,migrateVersion5,migrateVersion6,assertSchema,assertSchemaVersion6,inspectMigration,CURRENT_SCHEMA_VERSION,PRIVACY_V7_CHECKSUM,systemBackupRegistry,initializeRestoreSchema}=require("../dist/migrations/schema.js");
const {PRIVACY_V7_SCHEMAS}=require("../dist/privacy/schema.js");
const {OPERATIONS_V7_SCHEMAS}=require("../dist/operations/schema.js");
async function capture(db) {
  const result={};
  for(const {name,options} of await db.listCollections().toArray()) result[name]={options,indexes:await db.collection(name).listIndexes().toArray(),rows:await db.collection(name).find().sort({_id:1}).toArray()};
  return result;
}
function legacyUser() {
  const now=new Date();
  return {_id:randomUUID(),login_key:`legacy_${randomUUID().slice(0,8)}`,display_name:"Synthetic legacy",status:"active",password_hash:"$argon2id$synthetic-not-login",credential_version:1,identity_revision:0,must_change_password:false,temporary_password_expires_at:null,password_changed_at:now,created_at:now,updated_at:now};
}
test("v7真实旧库升级仅添加安全缺省，历史marker/epoch不变且历史入口不降级",{timeout:240000},async t=>{
  const f=await fixture(t,{migrated:false,app:false}); await migrateVersion6(f.uri);
  const user=legacyUser(); await f.db.collection("users").insertOne(user);
  const before=await capture(f.db),report=await inspectMigration(f.uri);
  assert.equal(CURRENT_SCHEMA_VERSION,7); assert.equal(report.target_version,7);
  assert.equal(report.collections.users.needs_defaults,1); assert.equal(report.collections.users.invalid_types,0);
  assert.deepEqual(await capture(f.db),before);
  await migrate(f.uri); await assertSchema(f.db);
  assert.deepEqual(await f.db.collection("users").findOne({_id:user._id}),{...user,privacy_state:"active"});
  assert.deepEqual(await f.db.collection("schema_migrations").find({version:{$lte:6}}).sort({_id:1}).toArray(),before.schema_migrations.rows);
  assert.deepEqual(await f.db.collection("learning_tracking_config").find().toArray(),before.learning_tracking_config.rows);
  const state=await f.db.collection("operational_state").findOne({_id:"environment"});
  assert.deepEqual({...state,updated_at:null},{_id:"environment",environment_id:null,mode:"unregistered",revision:0,access_fence:1,restore_id:null,maintenance_token:null,owner:null,updated_at:null});
  for(const name of Object.keys(PRIVACY_V7_SCHEMAS)) assert.equal(await f.db.collection(name).countDocuments(),0);
  const installed=await capture(f.db);
  for(const historical of [migrateVersion1,migrateVersion2,migrateVersion3,migrateVersion4,migrateVersion5,migrateVersion6]) await historical(f.uri);
  assert.deepEqual(await capture(f.db),installed); await assertSchemaVersion6(f.db);
  await assert.rejects(f.db.collection("users").updateOne({_id:user._id},{$unset:{privacy_state:""}}),e=>e.code===121);
  await assert.rejects(f.db.collection("users").updateOne({_id:user._id},{$set:{privacy_state:null}}),e=>e.code===121);
  for(const name of Object.keys({...PRIVACY_V7_SCHEMAS,...OPERATIONS_V7_SCHEMAS})) await assert.rejects(f.db.collection(name).insertOne({_id:randomUUID(),unexpected:true}),e=>e.code===121);
});
test("v7活租约排他、部分users DDL过期恢复及索引失败重启",{timeout:240000},async t=>{
  const f=await fixture(t,{migrated:false,app:false}); await migrateVersion6(f.uri);
  const history=await f.db.collection("schema_migrations").find().sort({_id:1}).toArray(),now=new Date();
  await f.db.collection("schema_migrations").insertOne({_id:randomUUID(),version:7,checksum:PRIVACY_V7_CHECKSUM,status:"running",lease_token:randomUUID(),lease_until:new Date(now.getTime()+120000),created_at:now,started_at:now,completed_at:null,failed_at:null});
  const target=await fixture(t,{migrated:false,app:false}); await initializeRestoreSchema(target.db);
  const users=await target.db.listCollections({name:"users"}).next();
  await f.db.command({collMod:"users",validator:users.options.validator,validationLevel:"strict",validationAction:"error"});
  await assert.rejects(migrate(f.uri),/holds the lease/);
  await f.db.collection("schema_migrations").updateOne({version:7},[{$set:{lease_until:{$subtract:["$$NOW",1]}}}]);
  await migrate(f.uri); await assertSchema(f.db);
  await f.db.collection("schema_migrations").updateOne({version:7},{$set:{status:"failed",completed_at:null,failed_at:new Date(),lease_token:null,lease_until:null}});
  await f.db.collection("privacy_tombstones").dropIndex("privacy_tombstone_user_unique");
  await assert.rejects(assertSchema(f.db)); await migrate(f.uri); await assertSchema(f.db);
  assert.deepEqual(await f.db.collection("schema_migrations").find({version:{$lte:6}}).sort({_id:1}).toArray(),history);
});
test("v7只读预检拒绝未知集合、异常隐私类型/引用/索引",{timeout:240000},async t=>{
  const f=await fixture(t,{migrated:false,app:false}); await migrateVersion6(f.uri);
  await f.db.collection("unknown_private_data").insertOne({_id:randomUUID()});
  const before=await capture(f.db); assert.deepEqual((await inspectMigration(f.uri)).unknown_collections,["unknown_private_data"]);
  await assert.rejects(migrate(f.uri),/unknown collections/); assert.deepEqual(await capture(f.db),before);
  await f.db.collection("unknown_private_data").drop();
  await f.db.collection("privacy_operation_receipts").insertOne({_id:randomUUID(),user_id:randomUUID(),key_hash:"a".repeat(64),request_hash:"b".repeat(64),request_id:randomUUID(),created_at:"not-date"});
  await f.db.collection("privacy_operation_receipts").createIndex({user_id:1},{name:"unexpected_index"});
  const dirty=await capture(f.db),report=await inspectMigration(f.uri);
  assert.equal(report.collections.privacy_operation_receipts.invalid_types,1); assert.ok(report.invalid_references>=2); assert.equal(report.invalid_indexes,1);
  await assert.rejects(migrate(f.uri),/invalid types or references/); assert.deepEqual(await capture(f.db),dirty);
  assert.equal(await f.db.collection("schema_migrations").countDocuments({version:7}),0);
});
test("恢复初始化只创建完整当前schema，不伪造角色、epoch、marker或环境",{timeout:240000},async t=>{
  const source=await fixture(t,{migrated:false,app:false}); await migrate(source.uri);
  const target=await fixture(t,{migrated:false,app:false}); await initializeRestoreSchema(target.db);
  const registry=systemBackupRegistry(); assert.equal(registry.version,7);
  assert.deepEqual(registry.excluded,["auth_sessions","auth_rate_limits"]);
  assert.equal(registry.checksums["7"],PRIVACY_V7_CHECKSUM);
  assert.deepEqual((await target.db.listCollections().toArray()).map(row=>row.name).sort(),[...registry.collections,...registry.excluded].sort());
  for(const name of [...registry.collections,...registry.excluded]) {
    assert.equal(await target.db.collection(name).countDocuments(),0);
    const a=await source.db.listCollections({name}).next(),b=await target.db.listCollections({name}).next();
    assert.deepEqual(b.options,a.options);
    assert.deepEqual(await target.db.collection(name).listIndexes().toArray(),await source.db.collection(name).listIndexes().toArray());
  }
  await assert.rejects(assertSchema(target.db));
  const empty=await capture(target.db); await assert.rejects(initializeRestoreSchema(target.db),/empty/); assert.deepEqual(await capture(target.db),empty);
  for(const name of registry.collections) { const rows=await source.db.collection(name).find().toArray(); if(rows.length) await target.db.collection(name).insertMany(rows); }
  await assertSchema(target.db);
});
test("v7墓碑强于缺省，重启不可将erased降级",{timeout:240000},async t=>{
  const f=await fixture(t,{migrated:false,app:false}); await migrateVersion6(f.uri);
  const user=legacyUser(),requestId=randomUUID(),now=new Date(); await f.db.collection("users").insertOne(user);
  await f.db.collection("privacy_deletion_requests").insertOne({_id:requestId,user_id:user._id,scope:"account",policy_revision:"local_privacy_v1",status:"blocking",revision:1,plan_hash:null,actor:null,reason_code:null,deleted_categories:[],retained_categories:[],retention_basis:null,remaining_actions:[],created_at:now,updated_at:now,lease_token:null,lease_until:null,ledger_sequence:1,completed_steps:[]});
  await f.db.collection("privacy_tombstones").insertOne({_id:randomUUID(),user_id:user._id,epoch:randomUUID(),request_id:requestId,state:"blocking",ledger_sequence:1,created_at:now,updated_at:now});
  await migrate(f.uri);
  assert.deepEqual(await f.db.collection("users").findOne({_id:user._id}),{...user,privacy_state:"erasing",status:"disabled"});
  await f.db.collection("users").updateOne({_id:user._id},{$set:{privacy_state:"erased"}});
  await f.db.collection("schema_migrations").updateOne({version:7},{$set:{status:"failed",completed_at:null,failed_at:new Date(),lease_token:null,lease_until:null}});
  await migrate(f.uri); await assertSchema(f.db);
  assert.deepEqual(await f.db.collection("users").findOne({_id:user._id}),{...user,privacy_state:"erased",status:"disabled"});
});
test("completed v7环境状态丢失不得重新bootstrap降级",{timeout:240000},async t=>{
  const f=await fixture(t,{migrated:false,app:false}); await migrate(f.uri);
  await f.db.collection("operational_state").deleteOne({_id:"environment"});
  const before=await capture(f.db);
  await assert.rejects(migrate(f.uri),/Operational state is missing/);
  assert.deepEqual(await capture(f.db),before);
});
