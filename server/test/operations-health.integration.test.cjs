"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {randomUUID}=require("node:crypto");
const {mkdtemp,rm,lstat}=require("node:fs/promises");
const {tmpdir}=require("node:os");
const {join}=require("node:path");
const {MongoClient}=require("mongodb");
const {fixture}=require("./helpers.cjs");
const {operationalHealth}=require("../dist/operations/health.js");
const {V3_DEFAULTS}=require("../dist/migrations/content-v3.js");
async function snapshot(db) {
  const names=(await db.listCollections({},{nameOnly:true}).toArray()).map(row=>row.name).sort();
  return Promise.all(names.map(async name=>({name,documents:await db.collection(name).find({}).sort({_id:1}).toArray()})));
}
test("operational health reports safe counts and ages without changing source documents or files",async t=>{
  const root=await mkdtemp(join(process.env.TEST_FILE_STORAGE_PARENT||tmpdir(),"kl_test_health_"));t.after(()=>rm(root,{recursive:true,force:true}));
  const f=await fixture(t,{app:false,env:{FILE_STORAGE_ROOT:root,CLAMSCAN_PATH:"",CLAMAV_DATABASE:"",SCAN_DATABASE_MAX_AGE_HOURS:"",KL_CONTROL_MONGODB_URI:""}});
  const old=new Date(Date.now()-90000),id=randomUUID(),token=randomUUID(),org=randomUUID();
  await f.db.collection("operational_writers").insertOne({_id:id,environment_id:null,kind:"learning",token,pid:999999,state:"running",started_at:old,heartbeat_at:old,stopped_at:null,shutdown_nonce:null});
  for(const [consumer,status] of [["grading_v1","pending"],["grading_v1","running"],["learning_projection_v1","failed"]]) {
    await f.db.collection("outbox_events").insertOne({_id:randomUUID(),org_id:org,created_at:old,updated_at:old,aggregate_type:"submission",aggregate_id:randomUUID(),aggregate_version:1,event_type:"SubmissionAccepted",schema_version:1,target_consumer:consumer,payload:{submission_id:randomUUID()},status,lease_owner:null,lease_token:null,lease_until:null,attempt:0,available_at:old,processed_at:null,error_code:null});
  }
  await f.db.collection("file_resources").insertOne({_id:randomUUID(),org_id:org,owner_type:"question",owner_version_id:randomUUID(),created_by:randomUUID(),display_name:"private-name-must-not-appear",storage_key:randomUUID(),declared_size:1,declared_mime:"text/plain",declared_checksum:"a".repeat(64),size:null,mime:null,checksum:null,status:"pending",scan_status:"awaiting_upload",scan_attempt:0,lease_token:null,lease_until:null,available_at:old,uploaded_at:null,error_code:null,created_at:old,updated_at:old,...V3_DEFAULTS.file_resources});
  const before=await snapshot(f.db),rootBefore=await lstat(root),health=await operationalHealth(f.db);
  assert.equal(health.schema.status,"ready");assert.equal(health.storage.status,"available");assert.ok(BigInt(health.storage.available_bytes)>=0n);
  assert.equal(health.scanner.status,"unconfigured");assert.equal(health.workers.process_liveness,"not_verified");assert.equal(health.workers.registered_running,1);
  assert.ok(health.workers.kinds[0].oldest_heartbeat_age_ms>=90000);
  const grading=health.queues.consumers.find(row=>row.consumer==="grading_v1");assert.equal(grading.states.find(row=>row.state==="pending").count,1);assert.equal(grading.states.find(row=>row.state==="running").count,1);assert.ok(grading.states.find(row=>row.state==="pending").oldest_age_ms>=90000);
  assert.equal(health.files.metadata_only,true);assert.equal(health.files.groups[0].count,1);assert.equal(health.backup.latest_restore.status,"not_recorded");assert.equal(health.backup.last_success.status,"unconfigured");
  const rendered=JSON.stringify(health);for(const value of [root,id,token,org,"private-name-must-not-appear",f.uri]) assert.equal(rendered.includes(value),false);
  assert.deepEqual(await snapshot(f.db),before);assert.equal((await lstat(root)).mtimeMs,rootBefore.mtimeMs);
});
test("health unavailable dependencies remain explicit and never create a missing file root",async t=>{
  const missing=join(process.env.TEST_FILE_STORAGE_PARENT||tmpdir(),`kl_test_missing_health_${randomUUID()}`);
  const f=await fixture(t,{app:false,env:{FILE_STORAGE_ROOT:missing,CLAMSCAN_PATH:join(missing,"scanner"),CLAMAV_DATABASE:join(missing,"signatures"),SCAN_DATABASE_MAX_AGE_HOURS:"24",KL_CONTROL_MONGODB_URI:""}});
  const before=await snapshot(f.db);const skipped=await operationalHealth(f.db);assert.equal(skipped.scanner.status,"not_checked");
  const health=await operationalHealth(f.db,{scanner:true});assert.equal(health.storage.status,"unavailable");assert.equal(health.scanner.status,"unavailable");
  await assert.rejects(lstat(missing),error=>error.code==="ENOENT");assert.deepEqual(await snapshot(f.db),before);assert.equal(JSON.stringify(health).includes(missing),false);
  const unavailable=new MongoClient(f.uri);await unavailable.connect();await unavailable.close();const down=await operationalHealth(unavailable.db());
  for(const section of [down.schema,down.workers,down.queues,down.files,down.backup.latest_restore]) assert.equal(section.status,"unavailable");
});
