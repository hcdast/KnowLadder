"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {ObjectId}=require("mongodb");
const {randomUUID}=require("node:crypto");
const {fixture,status,PASSWORD}=require("./helpers.cjs");
const {newId,encodeDocument,encodeFilter,objectIdDatabase,rawDatabase}=require("../dist/database/object-id.js");
const schema=require("../dist/migrations/schema.js");

test("ObjectId codec only converts declared references, leaves text/tokens intact",()=>{
 const id=newId(),token=randomUUID();
 const encoded=encodeDocument("file_resources",{_id:id,org_id:id,owner_version_id:id,created_by:id,storage_key:token,display_name:id,lease_token:token,upload_storage_keys:[token]});
 assert.ok(encoded._id instanceof ObjectId);assert.ok(encoded.org_id instanceof ObjectId);
 assert.equal(encoded.display_name,id);assert.equal(encoded.storage_key,token);
 assert.equal(encoded.lease_token,token);assert.equal(encoded.upload_storage_keys[0],token);
 assert.ok(encodeFilter("users",{_id:{$in:[id]}})._id.$in[0] instanceof ObjectId);
 assert.throws(()=>encodeDocument("users",{_id:randomUUID()}),/OBJECT_ID_VALUE_REQUIRED/);
});
for(const topology of ["replicaSet","standalone"]){
 test("v10 "+topology+": native IDs, auth, natural keys and strict UUID rejection",async t=>{
  const f=await fixture(t,{topology,env:{FILE_SCAN_ENABLED:"false"}});
  if(process.env.KL_GENERATE_API === "true" && topology === "replicaSet") {
    const {execFile}=require("node:child_process");
    await require("node:util").promisify(execFile)(process.execPath,["scripts/generate-api.mjs"],{cwd:require("node:path").resolve(__dirname,"../../web"),windowsHide:true,env:{...process.env,OPENAPI_URL:f.browser.base+"/api/openapi.json"}});
  }
  const raw=rawDatabase(f.db);
  await schema.assertSchema(raw);
  assert.equal((await raw.collection("schema_migrations").findOne({version:10})).status,"completed");
  assert.equal(await raw.collection("schema_migrations").countDocuments({version:{$lt:10}}),0);
  const org=(await f.ops.createOrganization(f.context,{name:"ObjectId验收",kind:"school"})).organization_id;
  const auth=f.app.get(require('../dist/auth.service.js').AuthService);
  try {await auth.rate('csrf','objectid-probe',60);await auth.createSession('preauth',null);} catch(e){t.diagnostic(JSON.stringify({message:e.message,details:e.errInfo},(k,v)=>['consideredValue','failingDocumentId','specifiedAs'].includes(k)?undefined:v));throw e;}
  const user=await f.authenticated(f.browser);
  const member=(await f.ops.setMembership(f.context,{user_id:user.user_id,org_id:org,roles:["student"]})).member_id;
  for(const id of [org,user.user_id,member])assert.match(id,/^[0-9a-f]{24}$/);
  const row=await raw.collection("organization_members").findOne({_id:new ObjectId(member)});
  assert.ok(row.org_id instanceof ObjectId);assert.ok(row.user_id instanceof ObjectId);
  const role=await raw.collection("member_roles").findOne({member_id:row._id});
  assert.ok(role._id instanceof ObjectId);assert.ok(role.role_id instanceof ObjectId);
  assert.equal((await raw.collection("roles").findOne({_id:role.role_id})).code,"student");
  const me=await f.browser.request("/me",{headers:{"X-Org-Id":org}});status(me,200);
  assert.equal(me.data.data.user.id,user.user_id);
  assert.equal((await f.db.collection("member_roles").findOne({member_id:member})).role_id,"student");
  const account=await raw.collection("users").findOne({_id:new ObjectId(user.user_id)});
  assert.ok(account);assert.equal(account.status,"active");
  await assert.rejects(raw.collection("users").insertOne({...account,_id:randomUUID()}),e=>e.code===121);
  const admin=f.app.get(require("../dist/administration/administration.service").AdministrationService);
  const allocated=await Promise.all(Array.from({length:12},()=>admin.stableId({identity:{user:{_id:user.user_id}}},"allocation-race-key","test.allocate","resource")));
  assert.equal(new Set(allocated).size,1);
  assert.ok((await raw.collection("object_id_allocations").findOne({_id:new ObjectId(allocated[0])})).actor_id instanceof ObjectId);
  await Promise.all(Array.from({length:12},()=>auth.rate("csrf","same-natural-key",60)));
  const fields=await raw.collection("auth_rate_limits").find({}).toArray();
  assert.ok(fields.length>0);assert.ok(fields.every(r=>r._id instanceof ObjectId&&typeof r.rate_key==="string"));
  for(const {name}of await raw.listCollections({},{nameOnly:true}).toArray()){
    assert.equal(await raw.collection(name).countDocuments({_id:{$not:{$type:"objectId"}}}),0,name+" primary key must be BSON ObjectId");
  }
  const joined=await f.db.collection("organization_members").aggregate([{$match:{_id:member}},{$lookup:{from:"users",localField:"user_id",foreignField:"_id",as:"user"}},{$match:{"user.0._id":user.user_id}}]).toArray();
  assert.equal(joined.length,1);
  assert.equal(await f.db.collection("users").countDocuments({$expr:{$eq:["$_id",user.user_id]}}),1);
  const count=await raw.collection("users").countDocuments({});
  await f.migrate(f.uri);assert.equal(await raw.collection("users").countDocuments({}),count);
 });
}

for (const topology of ["replicaSet","standalone"]) test("v10 "+topology+": initialization rejects legacy and resumes same-version failure",async t=>{
 const f=await fixture(t,{topology,migrated:false,app:false});
 await f.db.collection("users").insertOne({_id:randomUUID()});
 await assert.rejects(f.migrate(f.uri),/Legacy or nonempty/);
 await f.db.collection("users").drop();
 await f.migrate(f.uri);
 const marker=await f.db.collection("schema_migrations").findOne({version:10});
 await f.db.collection("schema_migrations").updateOne({_id:marker._id},{$set:{status:"failed",completed_at:null,failed_at:new Date()}});
 await f.migrate(f.uri);await schema.assertSchema(f.db);
 await f.db.collection("schema_migrations").updateOne({_id:marker._id},{$set:{status:"running",completed_at:null,lease_token:randomUUID(),lease_until:new Date(Date.now()+60000)}});
 await assert.rejects(f.migrate(f.uri),/busy/);
 await f.db.collection("schema_migrations").updateOne({_id:marker._id},{$set:{lease_until:new Date(0)}});
 await f.migrate(f.uri);await schema.assertSchema(f.db);
});

test("ObjectId chapters: server allocation, parent mapping, replay and ownership",async t=>{
 const {assessmentFixture,good,request}=require("./assessment-helpers.cjs");
 const f=await assessmentFixture(t);
 const create=()=>good(f.editor,"/admin/textbook-editions",{method:"POST",body:{textbook_id:f.book.textbook_id,title:"ObjectId章节",edition_code:randomUUID(),license:{source:"原创隔离验收",granted:true,expires_at:null}}});
 const book=await create(), key=randomUUID(), route="/admin/textbook-editions/"+book.id+"/chapters";
 const chapter=(client_key,parent_client_key)=>({client_key,...(parent_client_key?{parent_client_key}:{parent_id:null}),position:parent_client_key?1:0,title:client_key,body:"正文",knowledge_point_ids:[f.knowledge],resource_ids:[]});
 const body={expected_revision:book.revision,chapters:[chapter("root"),chapter("child","root")]};
 const first=await good(f.editor,route,{method:"PUT",key,body});
 const replay=await good(f.editor,route,{method:"PUT",key,body});
 assert.deepEqual(replay,first);assert.equal(first.chapter_id_map.length,2);
 const ids=Object.fromEntries(first.chapter_id_map.map(r=>[r.client_key,r.id]));
 const rows=await rawDatabase(f.db).collection("chapters").find({textbook_edition_id:new ObjectId(book.id)}).toArray();
 assert.equal(rows.length,2);assert.ok(rows.every(r=>r._id instanceof ObjectId));assert.equal(rows.find(r=>r._id.toHexString()===ids.child).parent_id.toHexString(),ids.root);
 const foreign=await create();
 const bad=await request(f.editor,"/admin/textbook-editions/"+foreign.id+"/chapters",{method:"PUT",body:{expected_revision:foreign.revision,chapters:[{...chapter("unused"),client_key:undefined,id:ids.root}]}});
 assert.equal(bad.status,422);assert.equal(await f.db.collection("chapters").countDocuments({textbook_edition_id:foreign.id}),0);
});

test("v10 preserves historical v8 validators and refuses implicit conversion",async t=>{
 const f=await fixture(t,{migrated:false,app:false});
 await schema.migrateVersion8(f.uri);
 assert.equal(await f.db.collection("schema_migrations").countDocuments({status:"completed"}),8);
 await assert.rejects(f.migrate(f.uri),/Legacy or nonempty/);
 assert.equal(await f.db.collection("schema_migrations").countDocuments({version:10}),0);
});
