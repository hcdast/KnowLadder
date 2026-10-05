"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {randomUUID}=require("node:crypto");
const {fixture}=require("./helpers.cjs");
const {migrate,migrateVersion1,migrateVersion2,migrateVersion3,migrateVersion4,migrateVersion5,migrateVersion6,assertSchema,assertSchemaVersion7,inspectMigration,PRIVACY_V7_CHECKSUM,TEACHING_V8_CHECKSUM,systemBackupRegistry,initializeRestoreSchema}=require("../dist/migrations/schema.js");
const {TEACHING_V8_SCHEMAS}=require("../dist/migrations/teaching-v8.js");
async function capture(db) {
  const result={};
  for(const {name,options} of await db.listCollections().toArray()) result[name]={options,indexes:await db.collection(name).listIndexes().toArray(),rows:await db.collection(name).find().sort({_id:1}).toArray()};
  return result;
}
test("v8真实旧库升级保全历史marker并安装教师集合与角色",{timeout:240000},async t=>{
  const f=await fixture(t,{migrated:false,app:false});
  await migrateVersion6(f.uri);
  const beforeInspect=await capture(f.db);
  const report=await inspectMigration(f.uri);
  for(const name of ["classes","class_members","teaching_assignments"]) assert.ok(report.new_collections.includes(name));
  assert.deepEqual(await capture(f.db),beforeInspect,"inspect不得写DDL或数据");
  await migrate(f.uri); await assertSchema(f.db);
  const installed=await capture(f.db);
  assert.deepEqual(installed.schema_migrations.rows.filter(row=>row.version<=6),beforeInspect.schema_migrations.rows);
  const v7=installed.schema_migrations.rows.find(row=>row.version===7);
  const v8=installed.schema_migrations.rows.find(row=>row.version===8);
  assert.equal(v7.checksum,PRIVACY_V7_CHECKSUM);
  assert.equal(v8.checksum,TEACHING_V8_CHECKSUM);
  assert.equal(v8.status,"completed");
  for(const name of Object.keys(TEACHING_V8_SCHEMAS).filter(n=>["classes","class_members","teaching_assignments"].includes(n))) {
    assert.equal(installed[name].rows.length,0);
    assert.equal(installed[name].options.validationLevel,"strict");
    assert.equal(installed[name].options.validationAction,"error");
    await assert.rejects(f.db.collection(name).insertOne({_id:randomUUID(),unexpected:true}),error=>error.code===121);
  }
  for(const historical of [migrateVersion1,migrateVersion2,migrateVersion3,migrateVersion4,migrateVersion5,migrateVersion6]) await historical(f.uri);
  assert.deepEqual(await capture(f.db),installed,"历史入口不得降级v8或重写账本");
  await migrate(f.uri); await assertSchema(f.db);
  assert.deepEqual(await f.db.collection("schema_migrations").find({version:{$lte:8}}).sort({version:1}).project({_id:0,version:1,checksum:1,status:1}).toArray(),
    installed.schema_migrations.rows.filter(row=>row.version<=8).map(row=>({version:row.version,checksum:row.checksum,status:row.status})).sort((a,b)=>a.version-b.version));
});
test("v8只读预检与备份登记含新集合",{timeout:240000},async t=>{
  const f=await fixture(t,{migrated:false,app:false});
  await migrate(f.uri); await assertSchema(f.db);
  const before=await capture(f.db),report=await inspectMigration(f.uri);
  assert.equal(report.duplicate_keys,0);
  assert.deepEqual(await capture(f.db),before);
  const registry=systemBackupRegistry();
  assert.equal(registry.checksums["7"],PRIVACY_V7_CHECKSUM);
  assert.equal(registry.checksums["8"],TEACHING_V8_CHECKSUM);
  for(const name of ["classes","class_members","teaching_assignments"]) assert.ok(registry.collections.includes(name));
  const target=await fixture(t,{migrated:false,app:false}); await initializeRestoreSchema(target.db);
  assert.deepEqual((await target.db.listCollections().toArray()).map(row=>row.name).sort(),[...registry.collections,...registry.excluded].sort());
  await assertSchemaVersion7(f.db);
});
