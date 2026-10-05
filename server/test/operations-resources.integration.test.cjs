"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {randomUUID,randomBytes,createHash}=require("node:crypto");
const {mkdtemp,mkdir,rm,writeFile,readFile,rename,unlink}=require("node:fs/promises");
const {homedir}=require("node:os");
const {join}=require("node:path");
const {promisify}=require("node:util");
const {execFile}=require("node:child_process");
const {MongoClient}=require("mongodb");
const {fixture,guardedUri,status}=require("./helpers.cjs");
const control=require("../dist/operations/control.js");
const ledger=require("../dist/operations/ledger.js");
const {setFileHold}=require("../dist/files/files.service.js");
const {processDeletion}=require("../dist/files/worker.js");
const {storageRoot}=require("../dist/files/config.js");
const exec=promisify(execFile);
const actor={actor:"managed-resource-test",reason:"synthetic resource safety evidence"};

async function setup(t,http=false) {
  const root=await mkdtemp(join(process.env.TEST_FILE_STORAGE_PARENT||(process.platform==="win32"?"C:\\":homedir()),"kl_test_resources_"));
  const primary=join(root,"primary"),mirror=join(root,"mirror"),filesRoot=join(root,"files");
  for(const directory of [primary,mirror,filesRoot])await mkdir(directory,{mode:0o700});
  if(process.platform==="win32") {
    const script=`$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($p in @($env:KL_TEST_PRIVATE_ROOT,$env:KL_TEST_PRIMARY,$env:KL_TEST_MIRROR,$env:KL_TEST_FILES)) { $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))); Set-Acl -LiteralPath $p -AclObject $acl }`;
    const system=process.env.SystemRoot||"C:\\Windows";
    await exec(join(system,"System32/WindowsPowerShell/v1.0/powershell.exe"),["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")],{windowsHide:true,env:{...process.env,PSModulePath:join(system,"System32/WindowsPowerShell/v1.0/Modules"),KL_TEST_PRIVATE_ROOT:root,KL_TEST_PRIMARY:primary,KL_TEST_MIRROR:mirror,KL_TEST_FILES:filesRoot}});
  }
  const environmentId=randomUUID(),controlName=`kl_control_resources_${randomUUID().replaceAll("-","")}`;
  const controlUri=guardedUri(process.env.TEST_MONGODB_URI).replace(/(mongodb:\/\/[^/]+\/)[^?]+/,`$1${controlName}`);
  const f=await fixture(t,{app:false,env:{KL_ENVIRONMENT_ID:environmentId,KL_CONTROL_MONGODB_URI:controlUri,KL_SAFETY_LEDGER_ROOT:primary,KL_SAFETY_LEDGER_MIRROR_ROOT:mirror,KL_SAFETY_LEDGER_KEY:randomBytes(32).toString("hex"),FILE_STORAGE_ROOT:filesRoot}});
  t.after(async()=>{
    const cleanup=new MongoClient(controlUri);
    try {await cleanup.connect();assert.equal(cleanup.db().databaseName,controlName);await cleanup.db().dropDatabase();}
    finally {await cleanup.close();await rm(root,{recursive:true,force:true});}
  });
  await storageRoot();
  await control.registerEnvironment(f.client,f.db,{...actor,environmentId,fileRoot:filesRoot});
  assert.equal((await control.getOperationalState(f.db)).mode,"active");
  // fixture runs the full migration; no collection or validator is replaced for this suite.
  const org=(await f.ops.createOrganization(f.context,{name:"Managed resource evidence",kind:"school"})).organization_id;
  const user=await f.user();
  const now=new Date(),stage=randomUUID(),subject=randomUUID(),textbook=randomUUID();
  await f.db.collection("education_stages").insertOne({_id:stage,code:"managed-stage",name:"Managed stage",created_at:now,updated_at:now});
  await f.db.collection("subjects").insertOne({_id:subject,code:"managed-subject",name:"Managed subject",created_at:now,updated_at:now});
  await f.db.collection("textbooks").insertOne({_id:textbook,org_id:org,title:"Synthetic textbook",stage_id:stage,subject_id:subject,source:"original synthetic",created_at:now,updated_at:now});
  const owner={_id:randomUUID(),org_id:org,textbook_id:textbook,edition_code:"managed-resources",title:"Synthetic edition",revision:1,access_revision:0,status:"draft",resource_ids:[],access_revoked_at:null,access_revoked_by:null,access_revoked_reason:null,retired_at:null,retired_by:null,retired_reason:null,created_by:user.user_id,contributors:[user.user_id],created_at:now,updated_at:now,submitted_by:null,submitted_at:null,published_by:null,published_at:null,source_version_id:null,notes:"",license:{source:"original synthetic",granted:true,expires_at:null}};
  await f.db.collection("textbook_editions").insertOne(owner);
  f.file=async(changes={})=>{
    const past=new Date(Date.now()-60000),bytes=Buffer.from("managed synthetic private bytes\n"),hash=createHash("sha256").update(bytes).digest("hex");
    const row={_id:randomUUID(),org_id:org,owner_type:"textbook",owner_version_id:owner._id,created_by:user.user_id,display_name:"managed.txt",storage_key:randomUUID(),declared_size:bytes.length,declared_mime:"text/plain",declared_checksum:hash,size:bytes.length,mime:"text/plain",checksum:hash,status:"pending",scan_status:"awaiting_upload",scan_attempt:0,lease_token:null,lease_until:null,available_at:past,uploaded_at:null,error_code:null,created_at:past,updated_at:past,retention_until:past,legal_hold:false,deletion_requested_at:past,deletion_requested_by:user.user_id,deletion_requested_reason:"synthetic deletion",deleted_at:null,deletion_lease_token:null,deletion_lease_until:null,deletion_attempt:0,upload_key:null,upload_lease_token:null,upload_lease_until:null,upload_storage_key:null,upload_storage_keys:[],upload_owner_revision:null,upload_result_revision:null,scan_engine_version:null,scan_database_version:null,scan_database_updated_at:null,scanned_at:null,...changes};
    await f.db.collection("file_resources").insertOne(row);
    const path=join(filesRoot,"ready",row.storage_key);await writeFile(path,bytes,{mode:0o600});
    return {...row,path,bytes};
  };
  if(http) {
    Object.assign(f,await f.start());const editor=await f.authenticated();
    await f.ops.setMembership(f.context,{user_id:editor.user_id,org_id:org,roles:["content_editor"]});
    const member=await f.db.collection("organization_members").findOne({org_id:org,user_id:editor.user_id});
    let revision=member.authorization_revision;
    for(const capability of ["content:revoke","file:delete"]) {
      const granted=await f.ops.setCapability(f.context,{org_id:org,member_id:member._id,capability,
        granted:true,valid_to:new Date(Date.now()+3600000),expected_revision:revision});
      revision=granted.authorization_revision;
    }
    f.post=(path,body,key=randomUUID())=>f.browser.request(path,{method:"POST",body,headers:{"X-Org-Id":org,"Idempotency-Key":key}});
  }
  return Object.assign(f,{root,primary,mirror,filesRoot,environmentId,owner});
}
async function maintenance(f) {
  const state=await control.getOperationalState(f.db);
  return control.enterMaintenance(f.client,f.db,{...actor,expectedRevision:state.revision});
}

// Run serially: real replica-set transactions, strict migrated schemas, private files and signed roots.
test("managed resources: revoke and retention commit; replay keeps the newer retention",{timeout:180000},async t=>{
  const f=await setup(t,true),file=await f.file({retention_until:null,deletion_requested_at:null,deletion_requested_by:null,deletion_requested_reason:null});
  const first={expected_owner_revision:1,retention_until:new Date(Date.now()+60000).toISOString(),reason:"initial retention"};
  const second={...first,retention_until:new Date(Date.now()+120000).toISOString(),reason:"extended retention"};
  const key=randomUUID(),path=`/admin/files/${file._id}/schedule-deletion`;
  status(await f.post(path,first,key),200);status(await f.post(path,second),200);status(await f.post(path,first,key),200);
  assert.equal((await f.db.collection("file_resources").findOne({_id:file._id})).retention_until.toISOString(),second.retention_until);
  const current=await f.db.collection("textbook_editions").findOne({_id:f.owner._id});
  status(await f.post(`/admin/textbook-editions/${current._id}/revoke-access`,{expected_access_revision:current.access_revision,reason:"synthetic revoke"}),200);
  const log=await ledger.readSafetyLedger(f.environmentId,0);assert.equal(log.pending,false);
  assert.equal(log.entries.filter(entry=>entry.action==="file.retention"&&entry.state==="committed").length,2);
  assert.equal(log.entries.filter(entry=>entry.action==="content.revoke"&&entry.state==="committed").length,1);
  assert.ok((await f.db.collection("textbook_editions").findOne({_id:current._id})).access_revoked_at instanceof Date);
});

test("managed hold: old release replay cannot clear a later hold or duplicate audit",{timeout:180000},async t=>{
  const f=await setup(t),file=await f.file();
  const release={...actor,fileId:file._id,hold:false,reason:"release command A"};
  const original=await setFileHold(f.client,f.db,release);
  await setFileHold(f.client,f.db,{...actor,fileId:file._id,hold:true,reason:"hold command B"});
  assert.deepEqual(await setFileHold(f.client,f.db,release),original);
  assert.equal((await f.db.collection("file_resources").findOne({_id:file._id})).legal_hold,true);
  assert.equal(await f.db.collection("audit_events").countDocuments({request_id:original.operationId,action:"file.hold.release"}),1);
  assert.equal((await ledger.readSafetyLedger(f.environmentId,0)).pending,false);
  assert.deepEqual(await readFile(file.path),file.bytes);
});

test("managed deletion: claim precedes reserve, missing mirror preserves bytes, retry uses persisted attempt",{timeout:180000},async t=>{
  const f=await setup(t),file=await f.file(),hiddenMirror=`${f.mirror}-unavailable`;
  await rename(f.mirror,hiddenMirror);
  try {await assert.rejects(processDeletion(f.db),/SAFETY_LEDGER/);}
  finally {await rm(f.mirror,{recursive:true,force:true});await rename(hiddenMirror,f.mirror);}
  const claimed=await f.db.collection("file_resources").findOne({_id:file._id});
  assert.equal(claimed.status,"deleting");assert.equal(claimed.deletion_attempt,1);assert.equal(claimed.deleted_at,null);
  assert.deepEqual(await readFile(file.path),file.bytes);
  assert.equal((await ledger.readSafetyLedger(f.environmentId,0)).entries.length,0);
  // Expire only this synthetic stopped attempt, rather than waiting two minutes.
  await f.db.collection("file_resources").updateOne({_id:file._id},{$set:{deletion_lease_until:new Date(Date.now()-1)}});
  assert.equal(await processDeletion(f.db),true);
  const deleted=await f.db.collection("file_resources").findOne({_id:file._id});
  assert.equal(deleted.deletion_attempt,2);assert.ok(deleted.deleted_at instanceof Date);
  await assert.rejects(readFile(file.path),error=>error.code==="ENOENT");
  const log=await ledger.readSafetyLedger(f.environmentId,0);assert.equal(log.entries.length,1);
  assert.equal(log.entries[0].operationId,ledger.safetyOperationId(`file.deleted:${file._id}:2`));assert.equal(log.entries[0].state,"committed");
  assert.equal(await processDeletion(f.db),false);
});

test("managed deletion: lost confirmation needs maintenance source proof; abort stays forbidden",{timeout:180000},async t=>{
  const f=await setup(t),file=await f.file(),writer=await control.acquireWriter(f.db,"files");
  const token=randomUUID(),session=f.client.startSession();let reservation;
  try {
    await session.withTransaction(async()=>{
      await f.db.collection("file_resources").updateOne({_id:file._id,legal_hold:false},{$set:{status:"deleting",deletion_lease_token:token,deletion_lease_until:new Date(Date.now()+60000),updated_at:new Date()},$inc:{deletion_attempt:1}},{session});
    });
    reservation=await ledger.reserveManagedSafetyIntent(f.db,{operationId:ledger.safetyOperationId(`file.deleted:${file._id}:1`),action:"file.deleted",resourceId:file._id,resourceType:"file"});
    await unlink(file.path);
    await session.withTransaction(async()=>{
      await f.db.collection("file_resources").updateOne({_id:file._id,deletion_lease_token:token},{$set:{deleted_at:new Date(),deletion_lease_token:null,deletion_lease_until:null,updated_at:new Date()}},{session});
    });
    // Stop at the real committed-source/pre-confirm boundary without fabricating an acknowledgement.
  } finally {await session.endSession();await writer.release();}
  assert.ok(reservation);assert.equal((await ledger.readSafetyLedger(f.environmentId,0)).pending,true);
  const window=await maintenance(f),input={...actor,operationId:reservation.operationId,maintenanceToken:window.token};
  await assert.rejects(ledger.reconcileSafetyIntent(f.db,{...input,decision:"abort"}),/SAFETY_LEDGER/);
  assert.equal((await ledger.readSafetyLedger(f.environmentId,0)).pending,true);
  await ledger.reconcileSafetyIntent(f.db,{...input,decision:"commit"});
  assert.equal((await ledger.readSafetyLedger(f.environmentId,0)).pending,false);
  await assert.rejects(readFile(file.path),error=>error.code==="ENOENT");
});

test("managed hold: server audit-insert failure rolls back source and leaves external pending recoverable",{timeout:180000},async t=>{
  const f=await setup(t),file=await f.file();
  const source=new MongoClient(f.uri,{appName:"managed-resource-source-fault",serverSelectionTimeoutMS:10000});await source.connect();
  const hello=await source.db("admin").command({hello:1});assert.match(hello.primary,/^(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]+$/);
  const direct=new MongoClient(`mongodb://${hello.primary}/admin?directConnection=true`,{serverSelectionTimeoutMS:10000});await direct.connect();
  const input={...actor,fileId:file._id,hold:true,reason:"real transaction rollback"};
  try {
    await direct.db("admin").command({configureFailPoint:"failCommand",mode:{times:1},data:{appName:"managed-resource-source-fault",failCommands:["insert"],errorCode:121}});
    await assert.rejects(setFileHold(source,source.db(),input));
  } finally {
    try {await direct.db("admin").command({configureFailPoint:"failCommand",mode:"off"});}
    finally {await direct.close();await source.close();}
  }
  assert.equal((await f.db.collection("file_resources").findOne({_id:file._id})).legal_hold,false);
  assert.equal((await f.db.collection("textbook_editions").findOne({_id:f.owner._id})).access_revision,f.owner.access_revision);
  assert.equal(await f.db.collection("audit_events").countDocuments({resource_id:file._id,action:"file.hold.set"}),0);
  let log=await ledger.readSafetyLedger(f.environmentId,0);assert.equal(log.entries.length,1);assert.equal(log.entries[0].state,"pending");
  await setFileHold(f.client,f.db,input);
  log=await ledger.readSafetyLedger(f.environmentId,0);assert.equal(log.entries.length,1);assert.equal(log.entries[0].state,"committed");
  assert.equal((await f.db.collection("file_resources").findOne({_id:file._id})).legal_hold,true);
});

test("file worker: unsupported arguments fail before writer registration or subject writes",{timeout:180000},async t=>{
  const f=await setup(t);
  const beforeState=await control.getOperationalState(f.db);
  const beforeWriters=await f.db.collection("operational_writers").find({}).sort({_id:1}).toArray();
  const userFields={projection:{_id:1,status:1,privacy_state:1,identity_revision:1,credential_version:1,updated_at:1}};
  const beforeUsers=await f.db.collection("users").find({},userFields).sort({_id:1}).toArray();
  await assert.rejects(exec(process.execPath,[join(__dirname,"../dist/files/worker.js"),"reconcile","--apply"],{env:{...process.env},timeout:10000}),error=>error.code===1);
  assert.deepEqual(await control.getOperationalState(f.db),beforeState);
  assert.deepEqual(await f.db.collection("operational_writers").find({}).sort({_id:1}).toArray(),beforeWriters);
  assert.deepEqual(await f.db.collection("users").find({},userFields).sort({_id:1}).toArray(),beforeUsers);
});
