"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {randomUUID}=require("node:crypto");
const {MongoClient}=require("mongodb");
const {fixture}=require("./helpers.cjs");
const control=require("../dist/operations/control.js");
const actor={actor:"operations-test",reason:"synthetic safety lifecycle"};
async function activeFixture(t) {
  const environmentId=randomUUID();
  const f=await fixture(t,{app:false,env:{KL_ENVIRONMENT_ID:environmentId}});
  // Isolate source CAS from real ledger registration, exercised in ledger integration coverage.
  await f.db.collection("operational_state").updateOne({_id:"environment"},{$set:{environment_id:environmentId,mode:"active",revision:2}});
  return {...f,environmentId};
}
test("unregistered writers are tracked and block registration",async t=> {
  const environmentId=randomUUID();const f=await fixture(t,{app:false,env:{KL_ENVIRONMENT_ID:environmentId}});
  const writer=await control.acquireWriter(f.db,"admin");t.after(()=>writer.release());
  assert.equal((await control.inspectOperations(f.db)).writers.length,1);
  await assert.rejects(control.registerEnvironment(f.client,f.db,{...actor,environmentId,fileRoot:null}),/WRITERS_RUNNING/);
  assert.equal((await control.getOperationalState(f.db)).mode,"unregistered");
  await writer.release();await writer.release();assert.equal((await control.inspectOperations(f.db)).writers.length,0);
});
test("stale heartbeat never proves exit; drain requires explicit acknowledgement",async t=> {
  const f=await activeFixture(t);const writer=await control.acquireWriter(f.db,"learning");t.after(()=>writer.release());
  await f.db.collection("operational_writers").updateOne({_id:writer.id},{$set:{started_at:new Date(0),heartbeat_at:new Date(0)}});
  const state=await control.getOperationalState(f.db);
  await assert.rejects(control.enterMaintenance(f.client,f.db,{...actor,expectedRevision:state.revision}),/WRITERS_RUNNING/);
  assert.equal((await control.getOperationalState(f.db)).mode,"draining");assert.equal(await writer.stopRequested(),true);
  await assert.rejects(control.acquireWriter(f.db,"files"),/ACCESS_BLOCKED/);await assert.rejects(control.assertOperationalAccess(f.db),/ACCESS_BLOCKED/);
  await writer.release();const drained=await control.getOperationalState(f.db);
  const maintenance=await control.enterMaintenance(f.client,f.db,{...actor,expectedRevision:drained.revision});
  await control.assertOperationalAccess(f.db,{allowMaintenance:true,maintenanceToken:maintenance.token});
  await assert.rejects(control.assertOperationalAccess(f.db,{allowMaintenance:true,maintenanceToken:randomUUID()}),/ACCESS_BLOCKED/);
  await assert.rejects(control.assertOperationalAccess(f.db,{maintenanceToken:maintenance.token}),/ACCESS_BLOCKED/);
  assert.equal((await control.inspectOperations(f.db)).ready,false);assert.ok(!JSON.stringify(await control.inspectOperations(f.db)).includes(maintenance.token));
});
test("concurrent CAS drains have exactly one winner",async t=> {
  const f=await activeFixture(t);const state=await control.getOperationalState(f.db);
  const results=await Promise.allSettled([control.drainEnvironment(f.client,f.db,{...actor,expectedRevision:state.revision}),control.drainEnvironment(f.client,f.db,{...actor,expectedRevision:state.revision})]);
  assert.equal(results.filter(result=>result.status==="fulfilled").length,1);assert.equal(results.filter(result=>result.status==="rejected").length,1);
  assert.equal((await control.getOperationalState(f.db)).revision,state.revision+1);
});
test("writer acquisition serializes against drain fence",async t=> {
  const f=await activeFixture(t);const state=await control.getOperationalState(f.db);
  const results=await Promise.allSettled([control.acquireWriter(f.db,"assessment"),control.drainEnvironment(f.client,f.db,{...actor,expectedRevision:state.revision})]);
  assert.equal(results[1].status,"fulfilled");
  if(results[0].status==="fulfilled") {const writer=results[0].value;t.after(()=>writer.release());assert.equal(await writer.stopRequested(),true);await assert.rejects(control.enterMaintenance(f.client,f.db,{...actor,expectedRevision:state.revision+1}),/WRITERS_RUNNING/);await writer.release();}
  await assert.rejects(control.acquireWriter(f.db,"admin"),/ACCESS_BLOCKED/);
});
test("strict validators reject missing restore checks and inconsistent operational state",async t=> {
  const f=await fixture(t,{app:false});
  await assert.rejects(f.db.collection("operational_state").updateOne({_id:"environment"},{$set:{mode:"maintenance",maintenance_token:null}}));
  await assert.rejects(f.db.collection("operational_state").updateOne({_id:"environment"},{$set:{arbitrary_bypass:true}}));
  await assert.rejects(f.db.collection("backup_restore_runs").insertOne({_id:randomUUID(),environment_id:randomUUID(),status:"ready",manifest_hash:"a".repeat(64),file_root_hash:"b".repeat(64),ledger_sequence:0,revision:0,checks:{schema:true},created_at:new Date(),updated_at:new Date()}));
});
test("registration retry cannot resume a normally drained registered environment",async t=> {
  const f=await activeFixture(t);const state=await control.getOperationalState(f.db);
  await control.drainEnvironment(f.client,f.db,{...actor,expectedRevision:state.revision});
  await assert.rejects(control.registerEnvironment(f.client,f.db,{...actor,environmentId:f.environmentId,fileRoot:null}),/ALREADY_REGISTERED/);
  assert.equal((await control.getOperationalState(f.db)).mode,"draining");
});
test("new restore target starts quarantined without an unregistered access window",async t=> {
  const environmentId=randomUUID(),restoreId=randomUUID();const f=await fixture(t,{app:false,env:{KL_ENVIRONMENT_ID:environmentId}});
  const db=f.client.db(`kl_restore_${randomUUID().replaceAll("-","")}`);
  t.after(async()=>{assert.match(db.databaseName,/^kl_restore_/);const cleanup=new MongoClient(f.uri);try {await cleanup.connect();await cleanup.db(db.databaseName).dropDatabase();}finally {await cleanup.close();}});
  const {initializeRestoreSchema}=require("../dist/migrations/schema.js");await initializeRestoreSchema(db);
  await assert.rejects(control.assertOperationalAccess(db),/STATE_MISSING/);
  await control.quarantineRestore(db,{environmentId,restoreId});
  const state=await control.getOperationalState(db);assert.equal(state.mode,"restore_quarantined");assert.equal(state.restore_id,restoreId);
  await assert.rejects(control.assertOperationalAccess(db),/ACCESS_BLOCKED/);await assert.rejects(control.acquireWriter(db,"admin"),/ACCESS_BLOCKED/);
  await control.quarantineRestore(db,{environmentId,restoreId});assert.equal((await control.getOperationalState(db)).revision,state.revision);
  await assert.rejects(control.quarantineRestore(db,{environmentId,restoreId:randomUUID()}),/RESTORE_CONFLICT/);
  await db.collection("operational_state").updateOne({_id:"environment"},{$set:{mode:"active"}});
  await assert.rejects(control.quarantineRestore(db,{environmentId,restoreId}),/RESTORE_CONFLICT/);
  assert.equal((await control.getOperationalState(db)).mode,"active");
});
test("completed v7 state loss cannot silently revert to unregistered",async t=> {
  const f=await fixture(t,{app:false});await f.db.collection("operational_state").deleteOne({_id:"environment"});
  await assert.rejects(control.acquireWriter(f.db,"migration"),/STATE_MISSING/);
  assert.equal(await f.db.collection("operational_state").countDocuments({}),0);
});
