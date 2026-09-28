"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { mkdtemp, mkdir, rm, readFile, writeFile, readdir } = require('node:fs/promises');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { promisify } = require('node:util');
const { execFile, fork } = require('node:child_process');
const { once } = require('node:events');
const { MongoClient } = require('mongodb');
const { setTimeout:delay } = require('node:timers/promises');
const { guardedUri } = require('./helpers.cjs');
const ledger = require('../dist/operations/ledger.js');
const exec = promisify(execFile);
async function setup(t) {
  const sourceUri = guardedUri(process.env.TEST_MONGODB_URI, randomUUID().replaceAll('-',''));
  const controlName = `kl_control_ledger_${randomUUID().replaceAll('-','')}`;
  const controlUri = sourceUri.replace(/(mongodb:\/\/[^/]+\/)[^?]+/, `$1${controlName}`);
  const parent = process.env.TEST_FILE_STORAGE_PARENT || (process.platform === 'win32' ? 'C:\\' : homedir());
  const root = await mkdtemp(join(parent,'kl_test_ledger_'));
  const primary = join(root,'primary'), mirror = join(root,'mirror');
  await mkdir(primary,{mode:0o700}); await mkdir(mirror,{mode:0o700});
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($p in @($env:KL_TEST_ROOT,$env:KL_TEST_PRIMARY,$env:KL_TEST_MIRROR)) { $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))); Set-Acl -LiteralPath $p -AclObject $acl }`;
    const system = process.env.SystemRoot || 'C:\\Windows';
    await exec(join(system,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{ windowsHide:true, env:{...process.env, PSModulePath:join(system,'System32/WindowsPowerShell/v1.0/Modules'), KL_TEST_ROOT:root, KL_TEST_PRIMARY:primary, KL_TEST_MIRROR:mirror} });
  }
  const environmentId = randomUUID();
  const settings = { NODE_ENV:'test', KL_ENVIRONMENT_ID:environmentId, KL_CONTROL_MONGODB_URI:controlUri, KL_SAFETY_LEDGER_ROOT:primary, KL_SAFETY_LEDGER_MIRROR_ROOT:mirror, KL_SAFETY_LEDGER_KEY:randomBytes(32).toString('hex') };
  const previous = Object.fromEntries(Object.keys(settings).map(key=>[key,process.env[key]])); Object.assign(process.env,settings);
  const client = new MongoClient(sourceUri), controlClient = new MongoClient(controlUri); let sourceConnected=false, controlConnected=false;
  const restores=[];
  t.after(async()=>{
    try { for(const db of restores) await db.dropDatabase(); if(sourceConnected) await client.db().dropDatabase(); if(controlConnected) { assert.equal(controlClient.db().databaseName,controlName); await controlClient.db().dropDatabase(); } }
    finally { await client.close(); await controlClient.close(); await rm(root,{recursive:true,force:true}); for(const [key,value] of Object.entries(previous)) { if(value===undefined) delete process.env[key]; else process.env[key]=value; } }
  });
  await client.connect(); sourceConnected=true; await controlClient.connect(); controlConnected=true; const db=client.db(), control=controlClient.db(); assert.ok((await control.command({hello:1})).setName);
  await db.collection('operational_state').insertOne({_id:'environment',environment_id:environmentId,mode:'active',revision:0,access_fence:0,restore_id:null,maintenance_token:null,owner:null,updated_at:new Date()});
  await ledger.registerSafetyLedger(db,environmentId,null);
  const intent=()=>({operationId:randomUUID(),action:'content.revoke',resourceId:randomUUID(),resourceType:'question',revision:1});
  return {db,control,client,environmentId,primary,mirror,intent,restores,uri:sourceUri};
}
test('ledger pending precedes effects; concurrent idempotency, conflicts and truthful confirmation',async t=>{
  const f=await setup(t), intent=f.intent(); await f.db.collection('question_versions').insertOne({_id:intent.resourceId,access_revoked_at:null,access_revision:0});
  const reservations=await Promise.all([ledger.reserveSafetyIntent(f.db,intent),ledger.reserveSafetyIntent(f.db,intent)]); assert.deepEqual(reservations[0],reservations[1]);
  let view=await ledger.readSafetyLedger(f.environmentId,0); assert.equal(view.sequence,1); assert.equal(view.pending,true); assert.equal(view.entries.length,1);
  await assert.rejects(ledger.confirmSafetyIntent(f.db,reservations[0])); await assert.rejects(ledger.reserveSafetyIntent(f.db,{...intent,resourceId:randomUUID()}));
  await f.db.collection('question_versions').updateOne({_id:intent.resourceId},{$set:{access_revoked_at:new Date(),access_revision:1}});
  await ledger.confirmSafetyIntent(f.db,reservations[0]); await ledger.confirmSafetyIntent(f.db,reservations[0]);
  view=await ledger.readSafetyLedger(f.environmentId,0); assert.equal(view.pending,false); assert.equal(view.entries[0].state,'committed');
  for(const file of await readdir(f.primary)) assert.equal((await readFile(join(f.primary,file))).includes(Buffer.from(intent.resourceId)),false);
  await assert.rejects(ledger.readSafetyLedger(f.environmentId,2));
});
test('ledger mirror tampering, stale file replay, chain gaps and lost authority fail closed',async t=>{
  const f=await setup(t); const genesis=await f.control.collection('safety_ledger_heads').findOne({_id:f.environmentId}); await ledger.reserveSafetyIntent(f.db,f.intent());
  const head=await f.control.collection('safety_ledger_heads').findOne({_id:f.environmentId}); const filename=join(f.mirror,`${head.hash}.ledger`); const original=await readFile(filename);
  await writeFile(filename,await readFile(join(f.primary,`${genesis.hash}.ledger`))); await assert.rejects(ledger.readSafetyLedger(f.environmentId,0));
  await writeFile(filename,original); const damaged=Buffer.from(original); damaged[damaged.length-1]^=1; await writeFile(filename,damaged); await assert.rejects(ledger.readSafetyLedger(f.environmentId,0));
  await writeFile(filename,original); const ancestor=join(f.mirror,`${genesis.hash}.ledger`); const ancestorBytes=await readFile(ancestor); await rm(ancestor); await assert.rejects(ledger.readSafetyLedger(f.environmentId,0)); await writeFile(ancestor,ancestorBytes,{mode:0o600});
  await f.control.collection('safety_ledger_heads').deleteOne({_id:f.environmentId}); await assert.rejects(ledger.readSafetyLedger(f.environmentId,0)); await assert.rejects(ledger.registerSafetyLedger(f.db,f.environmentId,null));
});
test('release lock excludes a racing reservation; old minimum never hides latest pending',async t=>{
  const f=await setup(t); let reservation; let observed=false;
  await ledger.runWithCurrentSafetyLedger(f.environmentId,0,async view=>{
    assert.equal(view.sequence,0); reservation=ledger.reserveSafetyIntent(f.db,f.intent()).then(value=>{observed=true;return value;});
    await delay(150); assert.equal(observed,false); assert.equal((await ledger.readSafetyLedger(f.environmentId,0)).sequence,0);
  });
  await reservation; const latest=await ledger.readSafetyLedger(f.environmentId,0); assert.equal(latest.sequence,1); assert.equal(latest.pending,true);
});
test('ledger callback preserves allowlisted domain codes and redacts all other errors',async t=>{
  const f=await setup(t);
  const safe=Object.assign(new Error('OPERATIONS_PENDING_LEDGER'),{cause:new Error('mongodb://secret.invalid/private'),details:'private-file-path'});
  await assert.rejects(ledger.runWithCurrentSafetyLedger(f.environmentId,0,async()=>{throw safe;}),error=>error.message==='OPERATIONS_PENDING_LEDGER'&&error.cause===undefined&&error.details===undefined);
  for(const message of ['MongoServerError mongodb://secret.invalid/private','ENOENT C:\\private\\ledger','OPERATIONS_PENDING_LEDGER mongodb://secret.invalid/private','OPERATIONS_UNRECOGNIZED_VALUE']) {
    await assert.rejects(ledger.runWithCurrentSafetyLedger(f.environmentId,0,async()=>{throw new Error(message);}),error=>error.message==='SAFETY_LEDGER_UNAVAILABLE');
  }
  assert.equal((await ledger.readSafetyLedger(f.environmentId,0)).sequence,0);
});
test('reconciliation requires quiescence and unchanged source; applied effects cannot be aborted',async t=>{
  const f=await setup(t), intent=f.intent(); await f.db.collection('question_versions').insertOne({_id:intent.resourceId,access_revoked_at:null,access_revision:0});
  await ledger.reserveSafetyIntent(f.db,intent); const token=randomUUID(); await f.db.collection('operational_state').updateOne({_id:'environment'},{$set:{mode:'maintenance',maintenance_token:token}});
  const input={operationId:intent.operationId,decision:'abort',maintenanceToken:token,actor:'ledger-test',reason:'prove source not applied'};
  await f.db.collection('operational_writers').insertOne({_id:randomUUID(),state:'running'}); await assert.rejects(ledger.reconcileSafetyIntent(f.db,input)); await f.db.collection('operational_writers').deleteMany({});
  await ledger.reconcileSafetyIntent(f.db,input); assert.equal((await ledger.readSafetyLedger(f.environmentId,0)).entries[0].state,'aborted'); await assert.rejects(ledger.reserveSafetyIntent(f.db,intent));
  const next=f.intent(); await f.db.collection('question_versions').insertOne({_id:next.resourceId,access_revoked_at:null,access_revision:0}); await ledger.reserveSafetyIntent(f.db,next);
  await f.db.collection('question_versions').updateOne({_id:next.resourceId},{$set:{access_revoked_at:new Date(),access_revision:1}});
  await assert.rejects(ledger.reconcileSafetyIntent(f.db,{...input,operationId:next.operationId}));
  await ledger.reconcileSafetyIntent(f.db,{...input,operationId:next.operationId,decision:'commit'}); assert.equal((await ledger.readSafetyLedger(f.environmentId,0)).pending,false);
});
test('file deletion cannot be aborted from missing tombstone or unchanged metadata',async t=>{
  const f=await setup(t),resourceId=randomUUID(),operationId=ledger.safetyOperationId(`file.deleted:${resourceId}`);
  await f.db.collection('file_resources').insertOne({_id:resourceId,status:'deleting',deleted_at:null,legal_hold:false});
  const intent={operationId,action:'file.deleted',resourceId,resourceType:'file'};
  const reservation=await ledger.reserveSafetyIntent(f.db,intent),token=randomUUID();
  await f.db.collection('operational_state').updateOne({_id:'environment'},{$set:{mode:'maintenance',maintenance_token:token}});
  const input={operationId,decision:'abort',maintenanceToken:token,actor:'ledger-test',reason:'deletion crash has unknown byte outcome'};
  await assert.rejects(ledger.reconcileSafetyIntent(f.db,input));
  await assert.rejects(ledger.confirmSafetyIntent(f.db,reservation));
  assert.deepEqual(await ledger.reserveSafetyIntent(f.db,intent),reservation);
  const pending=await ledger.readSafetyLedger(f.environmentId,0);assert.equal(pending.pending,true);assert.equal(pending.entries[0].state,'pending');
  await f.db.collection('file_resources').updateOne({_id:resourceId},{$set:{deleted_at:new Date()}});
  await ledger.reconcileSafetyIntent(f.db,{...input,decision:'commit'});
  assert.equal((await ledger.readSafetyLedger(f.environmentId,0)).entries[0].state,'committed');
});
test('restore overlays pending restrictions and preserves existing deletion chronology on replay',async t=>{
  const f=await setup(t), resourceId=randomUUID(), revoked=f.intent(), until=new Date('2040-01-01T00:00:00Z');
  for(const intent of [revoked,{operationId:randomUUID(),action:'file.hold',resourceId,resourceType:'file',hold:true},{operationId:randomUUID(),action:'file.retention',resourceId,resourceType:'file',retentionUntil:until},{operationId:randomUUID(),action:'file.deleted',resourceId,resourceType:'file'}]) await ledger.reserveSafetyIntent(f.db,intent);
  const restore=f.client.db(`kl_restore_ledger_${randomUUID().replaceAll('-','')}`); f.restores.push(restore);
  await restore.collection('operational_state').insertOne({_id:'environment',environment_id:f.environmentId,mode:'restore_quarantined'});
  await restore.collection('question_versions').insertOne({_id:revoked.resourceId,access_revoked_at:null,access_revision:0}); await restore.collection('file_resources').insertOne({_id:resourceId,legal_hold:false,status:'ready',retention_until:null,deleted_at:null});
  const view=await ledger.readSafetyLedger(f.environmentId,0); const result=await ledger.applySafetyLedger(restore,view); assert.equal(result.pending,true);
  const file=await restore.collection('file_resources').findOne({_id:resourceId}); assert.equal(file.legal_hold,true); assert.equal(file.retention_until.getTime(),until.getTime()); assert.equal(file.status,'deleting'); assert.equal(file.deleted_at,null);
  assert.ok((await restore.collection('question_versions').findOne({_id:revoked.resourceId})).access_revoked_at instanceof Date); await assert.rejects(ledger.applySafetyLedger(restore,{...view,entries:[]}));
  const completed=new Date(); await restore.collection('file_resources').updateOne({_id:resourceId},{$set:{deleted_at:completed}}); await ledger.applySafetyLedger(restore,view);
  const replayed=await restore.collection('file_resources').findOne({_id:resourceId}); assert.equal(replayed.deletion_requested_at.getTime(),file.deletion_requested_at.getTime()); assert.equal(replayed.deleted_at.getTime(),completed.getTime());
  await ledger.runWithCurrentSafetyLedger(f.environmentId,0,async(_view,authorize)=>authorize(restore)); await restore.collection('operational_state').updateOne({_id:'environment'},{$set:{mode:'active'}});
  await assert.rejects(ledger.confirmSafetyIntent(restore,{environmentId:f.environmentId,operationId:revoked.operationId,sequence:1}));
});
test('source cluster mismatch fails closed; control schema rejects invalid counters and lock identity',async t=>{
  const f=await setup(t); const head=await f.control.collection('safety_ledger_heads').findOne({_id:f.environmentId});
  await f.control.collection('safety_ledger_heads').updateOne({_id:f.environmentId},{$set:{sourceCluster:'0'.repeat(64),acceptedDatabases:[{databaseName:f.db.databaseName,cluster:'0'.repeat(64)}]}});
  await assert.rejects(ledger.reserveSafetyIntent(f.db,f.intent())); await assert.rejects(ledger.inspectSafetyLedger(f.db));
  await f.control.collection('safety_ledger_heads').updateOne({_id:f.environmentId},{$set:{sourceCluster:head.sourceCluster,acceptedDatabases:head.acceptedDatabases}});
  for(const fields of [{sequence:0.5},{generation:-1},{lock:'not-a-token'},{lock:null,ownerLaunchToken:randomUUID()},{acceptedDatabases:[head.acceptedDatabases[0],head.acceptedDatabases[0]]}]) await assert.rejects(f.control.collection('safety_ledger_heads').updateOne({_id:f.environmentId},{$set:fields}));
  assert.equal((await ledger.readSafetyLedger(f.environmentId,0)).sequence,0);
});
test('multi-host loopback control URI is accepted; a remote seed is rejected',async t=>{
  const f=await setup(t); const original=process.env.KL_CONTROL_MONGODB_URI;
  const match=/^(mongodb:\/\/)([^/]+)(\/.*)$/.exec(original); assert.ok(match);
  const at=match[2].lastIndexOf('@'), auth=at<0?'':match[2].slice(0,at+1), seeds=match[2].slice(at+1);
  try {
    process.env.KL_CONTROL_MONGODB_URI=`${match[1]}${auth}${seeds},${seeds.split(',')[0]}${match[3]}`;
    assert.equal((await ledger.readSafetyLedger(f.environmentId,0)).sequence,0);
    process.env.KL_CONTROL_MONGODB_URI=`${match[1]}${auth}${seeds},192.0.2.1:27017${match[3]}`;
    await assert.rejects(ledger.readSafetyLedger(f.environmentId,0));
  } finally { process.env.KL_CONTROL_MONGODB_URI=original; }
});
test('another loopback replica set can bind an empty restore target but cannot finalize an identical-name source intent',async t=>{
  const f=await setup(t);
  assert.ok(process.env.TEST_RESTORE_MONGODB_URI,'跨集群验收必须显式配置独立副本集 TEST_RESTORE_MONGODB_URI');
  const remote=new MongoClient(guardedUri(process.env.TEST_RESTORE_MONGODB_URI));
  const name=`kl_restore_identity_${randomUUID().replaceAll('-','')}`, local=f.client.db(name), target=remote.db(name); f.restores.push(local);
  let connected=false;
  t.after(async()=>{try {if(connected) await target.dropDatabase();} finally {await remote.close();}});
  await remote.connect(); connected=true;
  const original=(await f.client.db('local').collection('system.replset').findOne({})).settings.replicaSetId;
  const destination=(await remote.db('local').collection('system.replset').findOne({})).settings.replicaSetId;
  assert.notEqual(original.toHexString(),destination.toHexString(),'验收必须使用不同真实副本集');
  const intent=f.intent();
  for(const db of [local,target]) {
    assert.equal(await db.listCollections().hasNext(),false);
    await db.collection('operational_state').insertOne({_id:'environment',environment_id:f.environmentId,mode:'restore_quarantined'});
    await ledger.runWithCurrentSafetyLedger(f.environmentId,0,async(_view,authorize)=>authorize(db));
    await db.collection('operational_state').updateOne({_id:'environment'},{$set:{mode:'active'}});
    await db.collection('question_versions').insertOne({_id:intent.resourceId,access_revoked_at:null,access_revision:0});
  }
  const reservation=await ledger.reserveSafetyIntent(local,intent);
  await target.collection('question_versions').updateOne({_id:intent.resourceId},{$set:{access_revoked_at:new Date(),access_revision:1}});
  await assert.rejects(ledger.confirmSafetyIntent(target,reservation));
  const token=randomUUID(); await target.collection('operational_state').updateOne({_id:'environment'},{$set:{mode:'maintenance',maintenance_token:token}});
  await assert.rejects(ledger.reconcileSafetyIntent(target,{operationId:intent.operationId,decision:'abort',maintenanceToken:token,actor:'ledger-test',reason:'cannot finalize other cluster'}));
  const own=f.intent(); await target.collection('question_versions').insertOne({_id:own.resourceId,access_revoked_at:null,access_revision:0});
  const ownReservation=await ledger.reserveSafetyIntent(target,own); await target.collection('question_versions').updateOne({_id:own.resourceId},{$set:{access_revoked_at:new Date(),access_revision:1}}); await ledger.confirmSafetyIntent(target,ownReservation);
  const latest=await ledger.readSafetyLedger(f.environmentId,0); assert.equal(latest.entries.find(entry=>entry.operationId===intent.operationId).state,'pending'); assert.equal(latest.entries.find(entry=>entry.operationId===own.operationId).state,'committed');
});
test('subject proof requires request identity and known policy enums; confirmation requires the matching tombstone',async t=>{
  const f=await setup(t); const intent={operationId:randomUUID(),action:'subject.erase',subjectId:randomUUID(),privacyRequestId:randomUUID(),privacyPolicyRevision:'local_privacy_v1',privacyRetentionBasis:'local_minimal_provenance'};
  await assert.rejects(ledger.reserveSafetyIntent(f.db,{...intent,privacyRetentionBasis:undefined}));
  await assert.rejects(ledger.reserveSafetyIntent(f.db,{...intent,privacyRequestId:undefined}));
  await assert.rejects(ledger.reserveSafetyIntent(f.db,{...intent,privacyPolicyRevision:'invented'}));
  await assert.rejects(ledger.reserveSafetyIntent(f.db,{...f.intent(),privacyPolicyRevision:'local_privacy_v1',privacyRetentionBasis:'local_minimal_provenance'}));
  const reservation=await ledger.reserveSafetyIntent(f.db,intent);
  const stored=(await ledger.readSafetyLedger(f.environmentId,reservation.sequence)).entries[0]; assert.equal(stored.privacyPolicyRevision,'local_privacy_v1'); assert.equal(stored.privacyRetentionBasis,'local_minimal_provenance');
  await assert.rejects(ledger.reserveSafetyIntent(f.db,{...intent,privacyRetentionBasis:'local_hold_and_provenance'}));
  await f.db.collection('privacy_tombstones').insertOne({_id:randomUUID(),user_id:intent.subjectId,request_id:randomUUID(),ledger_sequence:reservation.sequence,state:'blocking'});
  await assert.rejects(ledger.confirmSafetyIntent(f.db,reservation));
  await f.db.collection('privacy_tombstones').updateOne({user_id:intent.subjectId},{$set:{request_id:intent.privacyRequestId}});
  await ledger.confirmSafetyIntent(f.db,reservation);
  assert.equal((await ledger.readSafetyLedger(f.environmentId,0)).entries[0].state,'committed');
});
test('subject abort tolerates unrelated auth revisions but never an installed privacy barrier',async t=>{
  const f=await setup(t), subjectId=randomUUID();
  await f.db.collection('users').insertOne({_id:subjectId,privacy_state:'active',identity_revision:1,credential_version:1});
  const intent={operationId:randomUUID(),action:'subject.erase',subjectId}; await ledger.reserveSafetyIntent(f.db,intent);
  await f.db.collection('users').updateOne({_id:subjectId},{$inc:{identity_revision:1,credential_version:1}});
  const token=randomUUID(); await f.db.collection('operational_state').updateOne({_id:'environment'},{$set:{mode:'maintenance',maintenance_token:token}});
  const input={operationId:intent.operationId,decision:'abort',maintenanceToken:token,actor:'ledger-test',reason:'pre-freeze stale approval'};
  await ledger.reconcileSafetyIntent(f.db,input);
  const next={...intent,operationId:randomUUID()}; const reservation=await ledger.reserveSafetyIntent(f.db,next);
  await f.db.collection('users').updateOne({_id:subjectId},{$set:{privacy_state:'erasing'}});
  await assert.rejects(ledger.reconcileSafetyIntent(f.db,{...input,operationId:next.operationId}));
  await f.db.collection('privacy_tombstones').insertOne({_id:randomUUID(),user_id:subjectId,request_id:next.operationId,ledger_sequence:reservation.sequence,state:'blocking'});
  await assert.rejects(ledger.reconcileSafetyIntent(f.db,{...input,operationId:next.operationId}));
  assert.equal((await ledger.readSafetyLedger(f.environmentId,0)).entries.find(entry=>entry.operationId===next.operationId).state,'pending');
});
test('abort commits source fences that invalidate old subject, content and file-owner snapshots',async t=>{
  const f=await setup(t), token=randomUUID();
  await f.db.collection('operational_state').updateOne({_id:'environment'},{$set:{mode:'maintenance',maintenance_token:token}});
  for(const action of ['subject.erase','content.revoke','file.hold','file.retention']) {
    const subjectId=randomUUID(), resourceId=randomUUID(), ownerId=randomUUID();
    let collection, fencedId, intent;
    if(action==='subject.erase') {
      collection='users'; fencedId=subjectId; await f.db.collection(collection).insertOne({_id:subjectId,privacy_state:'active',identity_revision:1}); intent={operationId:randomUUID(),action,subjectId};
    } else if(action==='content.revoke') {
      collection='question_versions'; fencedId=resourceId; await f.db.collection(collection).insertOne({_id:resourceId,access_revoked_at:null,access_revision:0}); intent={operationId:randomUUID(),action,resourceId,resourceType:'question',revision:1};
    } else {
      collection='question_versions'; fencedId=ownerId; await f.db.collection(collection).insertOne({_id:ownerId,access_revision:0});
      await f.db.collection('file_resources').insertOne({_id:resourceId,owner_type:'question',owner_version_id:ownerId,legal_hold:false,retention_until:null,deletion_requested_at:null,deleted_at:null,status:'ready'});
      intent={operationId:randomUUID(),action,resourceId,resourceType:'file',...(action==='file.hold'?{hold:true}:{retentionUntil:new Date('2040-01-01T00:00:00Z')})};
    }
    await ledger.reserveSafetyIntent(f.db,intent);
    const stale=f.client.startSession(); stale.startTransaction({readConcern:{level:'snapshot'}});
    try {
      const before=await f.db.collection(collection).findOne({_id:fencedId},{session:stale});
      await ledger.reconcileSafetyIntent(f.db,{operationId:intent.operationId,decision:'abort',maintenanceToken:token,actor:'ledger-test',reason:'fence old server snapshot'});
      const counter=action==='subject.erase'?'identity_revision':'access_revision'; const after=await f.db.collection(collection).findOne({_id:fencedId}); assert.equal(after[counter],before[counter]+1);
      await assert.rejects(f.db.collection(collection).updateOne({_id:fencedId},{$inc:{[counter]:1}},{session:stale}),error=>error.code===112||error.hasErrorLabel?.('TransientTransactionError'));
      assert.equal((await ledger.readSafetyLedger(f.environmentId,0)).entries.find(entry=>entry.operationId===intent.operationId).state,'aborted');
    } finally { await stale.abortTransaction().catch(()=>{}); await stale.endSession(); }
  }
});
test('owned child exit with commitTransaction blocked cannot turn a late source commit into an aborted ledger entry',{timeout:60000},async t=>{
  const f=await setup(t), intent=f.intent(), appName=`kl-ledger-inflight-${randomUUID()}`;
  await f.db.collection('question_versions').insertOne({_id:intent.resourceId,access_revoked_at:null,access_revision:0}); await ledger.reserveSafetyIntent(f.db,intent);
  const admin=f.client.db('admin'), writerId=randomUUID(), token=randomUUID();
  const child=fork(join(__dirname,'safety-ledger-transaction-child.cjs'),[],{env:{...process.env,TEST_LEDGER_SOURCE_URI:f.uri,TEST_LEDGER_APP_NAME:appName,TEST_LEDGER_RESOURCE_ID:intent.resourceId},stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  const exit=once(child,'exit'), staged=once(child,'message',{signal:AbortSignal.timeout(10000)}); let configured=false;
  const fenceClient=new MongoClient(f.uri,{monitorCommands:true}); let abortOutcome;
  try {
    await f.db.collection('operational_writers').insertOne({_id:writerId,pid:child.pid,state:'running'});
    const [message]=await staged; assert.equal(message.type,'staged');
    const fault=await admin.command({configureFailPoint:'failCommand',mode:{times:1},data:{appName,failCommands:['commitTransaction'],blockConnection:true,blockTimeMS:1500}}); configured=true;
    child.send({type:'commit'}); await admin.command({waitForFailPoint:'failCommand',timesEntered:fault.count+1,maxTimeMS:10000});
    child.kill('SIGKILL'); await exit;
    await f.db.collection('operational_writers').updateOne({_id:writerId,pid:child.pid},{$set:{state:'stopped'}});
    await f.db.collection('operational_state').updateOne({_id:'environment'},{$set:{mode:'maintenance',maintenance_token:token}});
    await fenceClient.connect();
    const dispatched=Promise.withResolvers();
    fenceClient.on('commandStarted',event=>{if(event.commandName==='update'&&event.command.update==='question_versions') dispatched.resolve();});
    abortOutcome=ledger.reconcileSafetyIntent(fenceClient.db(),{operationId:intent.operationId,decision:'abort',maintenanceToken:token,actor:'ledger-test',reason:'owned process exited, server outcome must settle'}).then(()=>({aborted:true}),()=>({aborted:false}));
    // If commit was already visible, reconciliation rejects before dispatching a fence.
    await Promise.race([dispatched.promise,abortOutcome]);
    const outcome=await abortOutcome;
    const deadline=Date.now()+10000;
    for(;;) {
      const running=await admin.aggregate([{$currentOp:{allUsers:true}},{$match:{$and:[{$or:[{appName},{'clientMetadata.application.name':appName}]},{'command.commitTransaction':1}]}}]).toArray();
      if(!running.length) break;
      assert.ok(Date.now()<deadline,'必须观察真实服务器在途提交收敛，不能只依据child exit'); await delay(20);
    }
    const row=await f.db.collection('question_versions').findOne({_id:intent.resourceId});
    const entry=(await ledger.readSafetyLedger(f.environmentId,0)).entries[0];
    if(outcome.aborted) { assert.equal(entry.state,'aborted'); assert.equal(row.access_revoked_at,null); assert.ok(row.access_revision>=1); }
    else { assert.equal(entry.state,'pending'); }
    // Any subsequently attempted old snapshot write must have lost to the committed fence;
    // a committed revocation is never labelled aborted merely because its client exited.
    assert.ok(!(entry.state==='aborted'&&row.access_revoked_at instanceof Date));
  } finally {
    if(child.exitCode===null&&child.signalCode===null) child.kill('SIGKILL'); await exit.catch(()=>{});
    if(configured) await admin.command({configureFailPoint:'failCommand',mode:'off'});
    await abortOutcome; await fenceClient.close();
  }
});
test('completed backup index is source-bound, metadata-idempotent and read-only for health',async t=>{
  const f=await setup(t), token=randomUUID();
  assert.deepEqual(await ledger.readLatestCompletedBackup(f.db),{status:'not_recorded'});
  const metadata={backupId:randomUUID(),manifestHash:'a'.repeat(64),createdAt:new Date('2026-01-01T00:00:00Z'),dbBytes:12,fileCount:1,ledgerSequence:0,maintenanceToken:token};
  await assert.rejects(ledger.registerCompletedBackup(f.db,metadata));
  await f.db.collection('operational_state').updateOne({_id:'environment'},{$set:{mode:'maintenance',maintenance_token:token}});
  await ledger.registerCompletedBackup(f.db,metadata);
  const recorded=await ledger.readLatestCompletedBackup(f.db); assert.equal(recorded.status,'recorded'); assert.equal(recorded.backupId,metadata.backupId); assert.equal(recorded.createdAt.getTime(),metadata.createdAt.getTime()); assert.equal(recorded.ledgerSequence,0);
  await ledger.registerCompletedBackup(f.db,metadata); assert.deepEqual(await ledger.readLatestCompletedBackup(f.db),recorded); assert.equal(await f.control.collection('completed_backups').countDocuments({}),1);
  for(const change of [{manifestHash:'b'.repeat(64)},{createdAt:new Date('2026-01-02T00:00:00Z')},{dbBytes:13},{fileCount:2},{ledgerSequence:1}]) await assert.rejects(ledger.registerCompletedBackup(f.db,{...metadata,...change}));
  const unbound=f.client.db(`kl_restore_unbound_${randomUUID().replaceAll('-','')}`); f.restores.push(unbound);
  await unbound.collection('operational_state').insertOne({_id:'environment',environment_id:f.environmentId,mode:'maintenance',maintenance_token:token});
  await assert.rejects(ledger.registerCompletedBackup(unbound,{...metadata,backupId:randomUUID()})); await assert.rejects(ledger.readLatestCompletedBackup(unbound));
  const authorityBefore=await f.control.collection('safety_ledger_heads').findOne({_id:f.environmentId});
  await unbound.collection('operational_state').updateOne({_id:'environment'},{$set:{mode:'restore_quarantined'}});
  assert.deepEqual(await ledger.readLatestCompletedBackup(unbound),recorded);
  assert.deepEqual(await f.control.collection('safety_ledger_heads').findOne({_id:f.environmentId}),authorityBefore);
  await assert.rejects(ledger.reserveSafetyIntent(unbound,f.intent()));
  const before={head:await f.control.collection('safety_ledger_heads').findOne({_id:f.environmentId}),rows:await f.control.collection('completed_backups').find().toArray(),collections:await f.control.listCollections().toArray(),files:await readdir(f.primary)};
  await ledger.readLatestCompletedBackup(f.db);
  assert.deepEqual({head:await f.control.collection('safety_ledger_heads').findOne({_id:f.environmentId}),rows:await f.control.collection('completed_backups').find().toArray(),collections:await f.control.listCollections().toArray(),files:await readdir(f.primary)},before);
  const view=JSON.stringify(recorded); assert.equal(view.includes(process.env.KL_SAFETY_LEDGER_ROOT),false); assert.equal(view.includes(process.env.KL_SAFETY_LEDGER_KEY),false); assert.equal(view.includes(process.env.KL_CONTROL_MONGODB_URI),false);
  await f.control.collection('completed_backups').drop(); await assert.rejects(ledger.readLatestCompletedBackup(f.db)); assert.equal(await f.control.listCollections({name:'completed_backups'}).hasNext(),false);
  const original=process.env.KL_SAFETY_LEDGER_ROOT, missing=join(original,`missing-${randomUUID()}`);
  try { process.env.KL_SAFETY_LEDGER_ROOT=missing; await assert.rejects(ledger.readLatestCompletedBackup(f.db)); await assert.rejects(readdir(missing),error=>error.code==='ENOENT'); } finally { process.env.KL_SAFETY_LEDGER_ROOT=original; }
});
test('authenticated older backup checkpoint may be registered after ledger advances without rewinding authority',async t=>{
  const f=await setup(t), token=randomUUID(), intent=f.intent(); await f.db.collection('question_versions').insertOne({_id:intent.resourceId,access_revoked_at:null,access_revision:0});
  const reservation=await ledger.reserveSafetyIntent(f.db,intent); await f.db.collection('operational_state').updateOne({_id:'environment'},{$set:{mode:'maintenance',maintenance_token:token}});
  const metadata={backupId:randomUUID(),manifestHash:'c'.repeat(64),createdAt:new Date('2026-01-01T00:00:00Z'),dbBytes:12,fileCount:0,ledgerSequence:0,maintenanceToken:token};
  await assert.rejects(ledger.registerCompletedBackup(f.db,metadata));
  await f.db.collection('question_versions').updateOne({_id:intent.resourceId},{$set:{access_revoked_at:new Date(),access_revision:1}}); await ledger.confirmSafetyIntent(f.db,reservation);
  await ledger.registerCompletedBackup(f.db,metadata); assert.equal((await ledger.readSafetyLedger(f.environmentId,0)).sequence,1); assert.equal((await ledger.readLatestCompletedBackup(f.db)).ledgerSequence,0);
  await ledger.registerCompletedBackup(f.db,metadata);
  await assert.rejects(ledger.registerCompletedBackup(f.db,{...metadata,backupId:randomUUID(),ledgerSequence:2}));
});
test('completed backup registration and idempotent replay both require an unexpired fixed maintenance window',async t=>{
  const f=await setup(t), token=randomUUID();
  const metadata={backupId:randomUUID(),manifestHash:'d'.repeat(64),createdAt:new Date('2026-01-01T00:00:00Z'),dbBytes:1,fileCount:0,ledgerSequence:0,maintenanceToken:token};
  await f.db.collection('operational_state').updateOne({_id:'environment'},{$set:{mode:'maintenance',maintenance_token:token,updated_at:new Date(Date.now()-30*60*1000-1)}});
  await assert.rejects(ledger.registerCompletedBackup(f.db,metadata),{message:'BACKUP_MAINTENANCE_TIMEOUT'}); assert.equal(await f.control.collection('completed_backups').countDocuments({}),0);
  const nextToken=randomUUID(); await f.db.collection('operational_state').updateOne({_id:'environment'},{$set:{maintenance_token:nextToken,updated_at:new Date()}});
  await ledger.registerCompletedBackup(f.db,{...metadata,maintenanceToken:nextToken}); const recorded=await ledger.readLatestCompletedBackup(f.db);
  await f.db.collection('operational_state').updateOne({_id:'environment'},{$set:{updated_at:new Date(Date.now()-30*60*1000-1)}});
  await assert.rejects(ledger.registerCompletedBackup(f.db,{...metadata,maintenanceToken:nextToken}),{message:'BACKUP_MAINTENANCE_TIMEOUT'});
  assert.deepEqual(await ledger.readLatestCompletedBackup(f.db),recorded); assert.equal(await f.control.collection('completed_backups').countDocuments({}),1);
});
