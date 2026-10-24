'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID,randomBytes}=require('node:crypto'),{MongoClient,BSON}=require('mongodb');
const {studioFixture}=require('./studio-fixture.cjs'),{newId,rawDatabase,objectIdDatabase}=require('../dist/database/object-id');
const privacy=require('../dist/privacy/execution'),control=require('../dist/operations/control'),ledger=require('../dist/operations/ledger');
const backup=require('../../ops/system-backup.cjs'),archive=require('../../ops/system-backup-archive.cjs'),schema=require('../dist/migrations/schema');
async function protect(root){await fs.chmod(root,0o700);if(process.platform!=='win32')return;
 const script="$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule);Set-Acl -LiteralPath $env:KL_TEST_PRIVATE_ROOT -AclObject $acl";
 await require('node:util').promisify(require('node:child_process').execFile)(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,env:{...process.env,KL_TEST_PRIVATE_ROOT:root}});
 await require('../dist/security/private-directory').assertWindowsPrivateDirectory(root);
}
test('学习拓展生命周期：v26加密备份、主体擦除、恢复重放及精确v22旧包空集合升级',{timeout:240000},async t=>{
 const f=await studioFixture(t),owner=f.student.user.user_id,now=new Date();
 await f.good(f.student,'/studio/notes',{title:'私人观察',body:'自己的思考',source_kind:'course',source_id:f.course._id,lesson_key:'observe',due_on:null});
 let question=await f.question();question=await f.good(f.author,`/studio/questions/${question._id}/actions`,{action:'reply',expected_revision:question.revision,body:'私有教师答复'});
 let meetup=await f.meetup(2);await f.good(f.student,`/studio/meetups/${meetup._id}/actions`,{action:'enroll',expected_revision:meetup.revision});
 const parent=await fs.realpath(process.env.TEST_FILE_STORAGE_PARENT||require('node:os').homedir()),root=await fs.mkdtemp(path.join(parent,'studio-lifecycle-'));
 t.after(async()=>{assert.equal(path.dirname(root),parent);assert.ok(path.basename(root).startsWith('studio-lifecycle-'));await fs.rm(root,{recursive:true,force:true});});await protect(root);
 async function child(name){const p=path.join(root,name);await fs.mkdir(p,{mode:0o700});await protect(p);return p;}
 const source=await child('source'),archives=await child('archives');for(const name of ['tmp','quarantine','ready'])await fs.mkdir(path.join(source,name),{mode:0o700});
 const envId=randomUUID(),controlName='kl_control_'+randomUUID().replaceAll('-',''),targets=[];
 const values={KL_CONTROL_MONGODB_URI:f.uri.replace(/\/kl_test_[^?]+/,'/'+controlName),KL_ENVIRONMENT_ID:envId,KL_SAFETY_LEDGER_ROOT:await child('ledger'),KL_SAFETY_LEDGER_MIRROR_ROOT:await child('mirror'),KL_SAFETY_LEDGER_KEY:randomBytes(32).toString('hex'),FILE_STORAGE_ROOT:source};
 const previous=new Map(Object.keys(values).map(k=>[k,process.env[k]]));Object.assign(process.env,values);
 t.after(async()=>{const c=new MongoClient(f.uri);try{await c.connect();for(const name of [controlName,...targets]){assert.match(name,/^kl_(control|restore)_[a-f0-9]{32}$/);await c.db(name).dropDatabase();}}finally{await c.close();for(const[k,v]of previous){if(v===undefined)delete process.env[k];else process.env[k]=v;}}});
 for(const app of f.apps.splice(0))await app.close();const operator={actor:'studio-isolated-test',reason:'合成学习协作数据生命周期核验'};
 await control.registerEnvironment(f.client,f.db,{environmentId:envId,fileRoot:source,...operator});
 const state=await control.getOperationalState(f.db),gate=await control.enterMaintenance(f.client,f.db,{expectedRevision:state.revision,...operator});
 const file=path.join(archives,'v26.klb'),key=randomBytes(32);await backup.backup({client:f.client,db:f.db,file,key,root:source,maintenanceToken:gate.token});
 const handle=await archive.openFile(file);let verified;try{verified=await backup.authenticate(handle,key);}finally{await handle.close();}
 assert.equal(verified.manifest.registry.version,26);assert.equal(verified.manifest.counts.learning_source_notes,1);assert.equal(verified.manifest.counts.learning_question_messages,1);assert.equal(verified.manifest.counts.learning_meetup_members,1);assert.ok(verified.manifest.counts.learning_studio_events>=5);
 await control.leaveMaintenance(f.client,f.db,{token:gate.token,...operator});
 const requestId=newId();await f.db.collection('privacy_deletion_requests').insertOne({_id:requestId,user_id:owner,scope:'account',policy_revision:'local_privacy_v1',status:'requested',revision:0,plan_hash:null,actor:null,reason_code:null,deleted_categories:[],retained_categories:[],retention_basis:null,remaining_actions:[],created_at:now,updated_at:now,lease_token:null,lease_until:null,ledger_sequence:null,completed_steps:[]});
 const plan=await privacy.inspectPrivacyRequest(f.db,requestId);for(const name of ['learning_source_notes','learning_questions','learning_question_messages','learning_meetup_members','learning_studio_events'])assert.ok(plan.categories[name]>0,name);
 await privacy.approvePrivacyRequest(f.client,f.db,{requestId,expectedRevision:plan.revision,planHash:plan.plan_hash,retentionBasis:'local_minimal_provenance',...operator});await privacy.executePrivacyRequest(f.client,f.db,{requestId,...operator});
 async function erased(db){for(const name of ['learning_source_notes','learning_questions','learning_question_messages','learning_meetup_members'])assert.equal(await db.collection(name).countDocuments(),0,name);assert.equal(await db.collection('learning_studio_events').countDocuments({$or:[{user_id:owner},{subject_member_id:f.student.member}]}),0);assert.equal(await db.collection('learning_meetups').countDocuments(),1);}
 await erased(f.db);
 const targetName='kl_restore_'+randomUUID().replaceAll('-','');targets.push(targetName);const target=objectIdDatabase(f.client.db(targetName));
 assert.equal((await backup.restore({client:f.client,db:target,file,key,root:await child('target')})).status,'quarantined');await erased(target);await schema.assertSchema(target);
 // Construct a genuine encrypted pre-studio registry package; absent optional personal versions stay absent.
 const registry=schema.supportedSystemBackupRegistries().find(r=>r.version===22),frames=[];
 for(const collection of registry.collections.filter(n=>!registry.excluded.includes(n)))for await(const row of rawDatabase(f.db).collection(collection).find({},{promoteValues:false,promoteLongs:false})){
  if(collection==='schema_migrations'&&Number(row.version)>22)continue;frames.push({name:collection,bytes:BSON.serialize(row)});
 }
 const counts=Object.fromEntries(registry.collections.filter(n=>!registry.excluded.includes(n)).map(n=>[n,0]));for(const frame of frames)counts[frame.name]++;
 const oldFile=path.join(archives,'v22.klb'),writer=await archive.createArchive(oldFile,key),manifest={...verified.manifest,backup_id:randomUUID(),registry,created_at:new Date().toISOString(),ledger_sequence:(await ledger.readSafetyLedger(envId,0)).sequence,counts,db_bytes:frames.reduce((n,f)=>n+f.bytes.length,0),files:[],missing:[]};
 try{await writer.frame({kind:'header',manifest});const indexes={};for(const frame of frames){await writer.frame({kind:'db',collection:frame.name,index:(indexes[frame.name]??=0),part:0,last:true,data:frame.bytes.toString('base64')});indexes[frame.name]++;}await writer.publish(manifest);}catch(e){await writer.abort();throw e;}
 const oldName='kl_restore_'+randomUUID().replaceAll('-','');targets.push(oldName);const old=objectIdDatabase(f.client.db(oldName));await backup.restore({client:f.client,db:old,file:oldFile,key,root:await child('historical')});
 assert.equal(await old.collection('schema_migrations').findOne({version:23}),null);assert.equal((await old.collection('schema_migrations').findOne({version:26})).checksum,schema.STUDIO_CHECKSUM);for(const name of require('../dist/training/studio-schema').STUDIO_COLLECTIONS)assert.equal(await old.collection(name).countDocuments(),0,name);await schema.assertSchema(old);key.fill(0);
});
