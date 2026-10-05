"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { Decimal128 } = require("mongodb");
const { fixture: baseFixture, guardedUri } = require("./helpers.cjs");
const { migrate, migrateVersion1, migrateVersion2, migrateVersion3, migrateVersion4, inspectMigration, assertSchemaVersion4: assertSchema } = require("../dist/migrations/schema.js");
async function fixture(t, options = {}) {
  const f = await baseFixture(t, {...options,migrated:false,app:false});
  f.migrate = migrateVersion4;
  if (options.migrated !== false) await migrateVersion4(f.uri);
  return f;
}
const { ASSESSMENT_V4_SCHEMAS } = require("../dist/migrations/assessment-v4.js");
const { createOrganization, createUser, setMembership, setCapability } = require("../dist/cli/admin-operations.js");
const { V3_DEFAULTS } = require("../dist/migrations/content-v3.js");
const { fileReferenced } = require("../dist/files/references.js");
// Captured from the real completed pre-v4 database markers, not recomputed from new source.
const HISTORY = ["922f27041ecad2dcf2f84cd9a21ffc5c03f6c036ba4388448ba1e87b37798981", "9b57b33d0960a86fda01be1993c165ac5a75dd0eca3c5b61897fd5702530d45a", "33ee87fc50c219f7983c78a66d76960d7fafc747b03aea4b386cbfa4f8f59392"];
const base = org_id => ({ _id: randomUUID(), org_id, created_at: new Date(), updated_at: new Date() });
test("v4迁移及持久约束", { concurrency: false, timeout: 240000 }, async t => {
  guardedUri(process.env.TEST_MONGODB_URI);
  await t.test("历史checksum及角色不变，inspect只读，旧迁移不能回退新validator", async t => {
    const f = await fixture(t, { migrated: false, app: false });
    await migrateVersion3(f.uri);
    const before = await f.db.collection("schema_migrations").find().sort({version:1}).toArray();
    assert.deepEqual(before.map(row => row.checksum), HISTORY);
    const roles = await f.db.collection("roles").find().sort({_id:1}).toArray();
    const names = (await f.db.listCollections({}, {nameOnly:true}).toArray()).map(row=>row.name).sort();
    assert.ok((await inspectMigration(f.uri)).new_collections.includes("sessions"));
    assert.deepEqual((await f.db.listCollections({}, {nameOnly:true}).toArray()).map(row=>row.name).sort(), names);
    assert.deepEqual(await f.db.collection("schema_migrations").find().sort({version:1}).toArray(), before);
    await f.migrate(f.uri); await migrateVersion1(f.uri); await migrateVersion2(f.uri); await migrateVersion3(f.uri); await f.migrate(f.uri);
    await assertSchema(f.db);
    assert.deepEqual(await f.db.collection("schema_migrations").find({version:{$lte:3}}).sort({version:1}).toArray(), before);
    assert.deepEqual(await f.db.collection("roles").find().sort({_id:1}).toArray(), roles);
    for (const name of Object.keys(ASSESSMENT_V4_SCHEMAS).filter(name=>!["audit_events","member_capability_grants"].includes(name))) {
      assert.equal(await f.db.collection(name).countDocuments(), 0);
      await assert.rejects(f.db.collection(name).insertOne({...base(randomUUID()),unexpected:true}), e=>e.code===121);
    }
    assert.ok((await f.db.collection("idempotency_records").listIndexes().toArray()).every(index=>index.expireAfterSeconds===undefined));
  });
  await t.test("v4部分DDL、活跃/过期租约恢复及checksum漂移拒绝", async t => {
    const f = await fixture(t, {app:false});
    const migrations = f.db.collection("schema_migrations");
    await migrations.updateOne({version:4}, {$set:{status:"failed",completed_at:null,failed_at:new Date(),lease_token:null,lease_until:null}});
    await f.db.collection("audit_events").dropIndex("audit_events_assessment_page");
    await assert.rejects(assertSchema(f.db));
    await f.migrate(f.uri); await assertSchema(f.db);
    await migrations.updateOne({version:4}, [{$set:{status:"running",lease_token:randomUUID(),lease_until:{$add:["$$NOW",120000]},started_at:"$$NOW",completed_at:null,failed_at:null}}]);
    await assert.rejects(f.migrate(f.uri), /holds the lease/);
    await migrations.updateOne({version:4}, [{$set:{lease_until:{$subtract:["$$NOW",1]}}}]);
    await f.migrate(f.uri); await assertSchema(f.db);
    await migrations.updateOne({version:4}, {$set:{checksum:"0".repeat(64)}});
    await assert.rejects(f.migrate(f.uri), /checksum/i);
    assert.equal((await migrations.findOne({version:4})).checksum, "0".repeat(64));
  });
  await t.test("独立评估能力显式CAS授权审计、worker拒绝和角色变更清除", async t => {
    const f = await fixture(t, {app:false});
    // Current operational CLI requires the latest schema; the historical DDL tests above remain v4-only.
    await migrate(f.uri);
    const ctx = {client:f.client,db:f.db,actor:"assessment-migration-test",reason:"独立能力测试"};
    const org = await createOrganization(ctx,{name:"评估组织",kind:"school"});
    const user = await createUser(ctx,{login_name:"assessment_grant",display_name:"评估操作人"});
    let member = await setMembership(ctx,{user_id:user.user_id,org_id:org.organization_id,roles:["org_admin"]});
    assert.equal(await f.db.collection("member_capability_grants").countDocuments(),0);
    for (const capability of ["assessment:manage","assessment:review"]) {
      const input = {member_id:member.member_id,org_id:org.organization_id,capability,granted:true,valid_to:new Date(Date.now()+3600000),expected_revision:member.authorization_revision};
      member = await setCapability(ctx,input);
      await assert.rejects(setCapability(ctx,input),e=>e.code==="REVISION_CONFLICT");
      const audit = await f.db.collection("audit_events").findOne({action:`capability.grant.${capability}`});
      assert.equal(audit.reason,ctx.reason); assert.equal(audit.access_revision_after,member.authorization_revision);
    }
    await assert.rejects(setCapability(ctx,{member_id:member.member_id,org_id:org.organization_id,capability:"assessment:worker",granted:true,valid_to:new Date(Date.now()+3600000),expected_revision:member.authorization_revision}),e=>e.code==="INVALID_OPERATION");
    await setMembership(ctx,{user_id:user.user_id,org_id:org.organization_id,roles:["org_admin"],expected_revision:member.authorization_revision});
    assert.equal(await f.db.collection("member_capability_grants").countDocuments({ member_id: member.member_id, status: "active" }), 0);
    assert.equal(await f.db.collection("member_capability_grants").countDocuments({ member_id: member.member_id, status: "revoked" }), 2);
    for (const role of await f.db.collection("roles").find().toArray()) assert.ok(role.capabilities.every(cap=>!cap.startsWith("assessment:")));
  });
  await t.test("活动会话部分唯一约束及Decimal128精度和分值上界", async t => {
    const f = await fixture(t, {app:false});
    const org = randomUUID();
    const row = {...base(org),user_id:randomUUID(),member_id:randomUUID(),mode:"quiz",quiz_id:randomUUID(),paper_id:randomUUID(),textbook_edition_id:null,chapter_id:null,knowledge_point_ids:[],difficulty:null,status:"in_progress",revision:1,started_at:new Date(),deadline_at:new Date(Date.now()+60000),submitted_at:null,submission_id:null,item_count:1};
    await f.db.collection("sessions").insertOne(row);
    await assert.rejects(f.db.collection("sessions").insertOne({...row,_id:randomUUID()}),e=>e.code===11000);
    await f.db.collection("sessions").insertOne({...row,_id:randomUUID(),status:"cancelled"});
    await f.db.collection("sessions").insertOne({...row,_id:randomUUID(),org_id:randomUUID()});
    const result = {...base(org),grading_run_id:randomUUID(),session_item_id:randomUUID(),score:Decimal128.fromString("0.10"),max_score:Decimal128.fromString("0.30"),verdict:"correct"};
    await f.db.collection("grading_results").insertOne(result);
    for (const score of ["0.101","0.31","-0.01","NaN","Infinity"]) await assert.rejects(f.db.collection("grading_results").insertOne({...result,_id:randomUUID(),session_item_id:randomUUID(),score:Decimal128.fromString(score)}),e=>e.code===121);
  });
  await t.test("未知跨组织引用在新增marker前失败且不修复原记录", async t => {
    const f = await fixture(t, {migrated:false,app:false});
    await migrateVersion3(f.uri);
    const row = {...base(randomUUID()),quiz_id:randomUUID(),member_id:randomUUID()};
    await f.db.collection("quiz_audiences").insertOne(row);
    assert.ok((await inspectMigration(f.uri)).invalid_references>0);
    await assert.rejects(f.migrate(f.uri),/invalid types or references/);
    assert.equal(await f.db.collection("schema_migrations").countDocuments({version:4}),0);
    assert.deepEqual(await f.db.collection("quiz_audiences").findOne({_id:row._id}),row);
  });
});

test("v4多态资源引用预检拒绝非法保留引用且完全只读", { concurrency: false, timeout: 240000 }, async t => {
  const f = await fixture(t, {migrated:false,app:false});
  await migrateVersion3(f.uri);
  const org = randomUUID(), user = randomUUID(), member = randomUUID();
  const subject = randomUUID(), knowledge = randomUUID(), now = new Date();
  const { hashPassword } = require("../dist/security/password.js");
  await f.db.collection("organizations").insertOne({_id:org,name:"引用迁移",kind:"school",status:"active",created_at:now,updated_at:now});
  await f.db.collection("users").insertOne({_id:user,login_key:"reference_migration",display_name:"引用迁移",status:"active",
    password_hash:await hashPassword("Migration-reference-only!42"),credential_version:1,identity_revision:0,must_change_password:false,
    temporary_password_expires_at:null,password_changed_at:now,created_at:now,updated_at:now});
  await f.db.collection("organization_members").insertOne({_id:member,org_id:org,user_id:user,status:"active",authorization_revision:0,created_at:now,updated_at:now});
  await f.db.collection("subjects").insertOne({_id:subject,code:"reference-migration",name:"引用迁移",created_at:now,updated_at:now});
  await f.db.collection("knowledge_points").insertOne({_id:knowledge,code:"reference-migration",name:"引用迁移",subject_id:subject,created_at:now,updated_at:now});
  const root = {...base(org),next_version_no:3};
  await f.db.collection("questions").insertOne(root);
  const question = {...base(org),...V3_DEFAULTS.question_versions,question_id:root._id,version_no:1,subject_id:subject,
    title:"保留来源",status:"retired",revision:1,created_by:user,contributors:[],submitted_by:user,submitted_at:now,published_by:user,published_at:now,
    source_version_id:null,license:{source:"自主迁移测试",granted:true,expires_at:null},resource_ids:[],notes:"",access_revoked_at:now,
    question_type:"single",prompt:"选择一项",options:[{id:"A",text:"甲"},{id:"B",text:"乙"}],answer:"A",explanation:"解析",knowledge_point_ids:[knowledge],difficulty:"基础",
    scoring_rule:{version:1,strategy:"single_exact",max_score:"1"},knowledge_weights:[{knowledge_point_id:knowledge,weight_bps:10000}],difficulty_basis:"迁移测试"};
  const otherQuestion = {...question,_id:randomUUID(),version_no:2};
  await f.db.collection("question_versions").insertMany([question,otherQuestion]);
  const file = {...base(org),...V3_DEFAULTS.file_resources,owner_type:"question",owner_version_id:question._id,created_by:user,display_name:"retained.txt",storage_key:randomUUID(),
    declared_size:1,declared_mime:"text/plain",declared_checksum:"0".repeat(64),size:1,mime:"text/plain",checksum:"0".repeat(64),status:"ready",scan_status:"clean",scan_attempt:1,
    lease_token:null,lease_until:null,available_at:now,uploaded_at:now,error_code:null};
  await f.db.collection("file_resources").insertOne(file);
  const snapshot = Object.fromEntries(["question_id","subject_id","title","question_type","prompt","options","answer","explanation","scoring_rule","knowledge_point_ids","knowledge_weights","difficulty","difficulty_basis","created_by","contributors","published_by"].map(key=>[key,question[key]]));
  Object.assign(snapshot,{question_version_id:question._id,resource_ids:[file._id],display_digest:"0".repeat(64)});
  const quiz = {...base(org),title:"引用迁移",subject_id:subject,status:"draft",revision:1,created_by:user,contributors:[],published_by:null,published_at:null,
    opens_at:now,closes_at:new Date(now.getTime()+60000),release_at:new Date(now.getTime()+120000),duration_seconds:60,max_attempts:1,published_paper_id:null,visibility_revision:0};
  const paper = {...base(org),quiz_id:quiz._id,revision:1,status:"draft"};
  const session = {...base(org),user_id:user,member_id:member,mode:"practice",quiz_id:null,paper_id:null,textbook_edition_id:null,chapter_id:null,knowledge_point_ids:[],difficulty:null,
    status:"in_progress",revision:1,started_at:now,deadline_at:null,submitted_at:null,submission_id:null,item_count:1};
  await f.db.collection("quizzes").insertOne(quiz);
  await f.db.collection("papers").insertOne(paper);
  await f.db.collection("sessions").insertOne(session);
  const items = {
    paper_item:{...base(org),paper_id:paper._id,position:0,snapshot,max_score:Decimal128.fromString("1")},
    session_item:{...base(org),session_id:session._id,position:0,snapshot,max_score:Decimal128.fromString("1")},
  };
  for (const [type,item] of Object.entries(items)) await f.db.collection(`${type}s`).insertOne(item);
  const capture = async () => {
    const collections = await f.db.listCollections({}, {nameOnly:true}).toArray();
    const rows = {};
    for (const {name} of collections.sort((a,b)=>a.name.localeCompare(b.name))) rows[name] = await f.db.collection(name).find().sort({_id:1}).toArray();
    return rows;
  };
  const retained = [];
  for (const [type,item] of Object.entries(items)) {
    const reference = {...base(org),reference_type:type,reference_id:item._id,file_id:file._id,owner_type:"question",owner_version_id:question._id};
    retained.push(reference);
    await f.db.collection("assessment_resource_references").insertOne(reference);
    await t.test(`${type}合法保留快照不依赖当前来源状态或附件列表`, async () => {
      const before = await capture();
      const report = await inspectMigration(f.uri);
      assert.equal(report.invalid_references,0);
      assert.ok(Object.values(report.collections).every(row=>row.invalid_types===0));
      assert.deepEqual(await capture(),before);
      assert.equal(await fileReferenced(f.db,file._id),true);
    });
    for (const [label,collection,row,changes,invalidReferences,invalidTypes] of [
      ["目标题项缺失","assessment_resource_references",reference,{reference_id:randomUUID()},1,0],
      ["reference_type不得串用另一类题项","assessment_resource_references",reference,{reference_type:type==="paper_item"?"session_item":"paper_item"},1,0],
      ["目标题项跨组织",`${type}s`,item,{org_id:randomUUID()},3,0],
      ["快照来源版本与引用owner不一致",`${type}s`,item,{snapshot:{...snapshot,question_version_id:otherQuestion._id}},1,0],
      ["快照未包含引用附件",`${type}s`,item,{snapshot:{...snapshot,resource_ids:[]}},1,0],
      ["非法附件数组仍返回报告而非聚合异常",`${type}s`,item,{snapshot:{...snapshot,resource_ids:"invalid"}},1,1],
      ["文件owner版本与引用不一致","file_resources",file,{owner_version_id:otherQuestion._id},1,0],
      // The missing textbook owner adds one existing v3 violation; v4 must also reject the owner type mismatch.
      ["文件owner类型与引用不一致","file_resources",file,{owner_type:"textbook"},2,0],
    ]) await t.test(`${type}${label}`, async () => {
      await f.db.collection(collection).updateOne({_id:row._id},{$set:changes});
      try {
        const before = await capture();
        const report = await inspectMigration(f.uri);
        assert.equal(report.invalid_references,invalidReferences);
        assert.equal(Object.values(report.collections).reduce((total,row)=>total+row.invalid_types,0),invalidTypes);
        assert.deepEqual(await capture(),before,"inspect必须完全只读");
        await assert.rejects(f.migrate(f.uri),/invalid types or references/);
        assert.deepEqual(await capture(),before,"拒绝迁移不得修改引用、来源、marker或其他数据");
        assert.equal(await f.db.collection("schema_migrations").countDocuments({version:4}),0);
        assert.equal(await fileReferenced(f.db,file._id),true,"异常保留引用仍必须阻断附件清理");
      } finally {
        await f.db.collection(collection).replaceOne({_id:row._id},row);
      }
    });
    await f.db.collection("assessment_resource_references").deleteOne({_id:reference._id});
  }
  await f.db.collection("assessment_resource_references").insertMany(retained);
  const references = await f.db.collection("assessment_resource_references").find().sort({_id:1}).toArray();
  await f.migrate(f.uri);
  await assertSchema(f.db);
  assert.deepEqual(await f.db.collection("assessment_resource_references").find().sort({_id:1}).toArray(),references);
});

test("v4会话章节与身份关联预检使用正式schema且完全只读", { concurrency: false, timeout: 240000 }, async t => {
  const f = await fixture(t, {migrated:false,app:false});
  await migrateVersion3(f.uri);
  const org = randomUUID(), foreignOrg = randomUUID(), user = randomUUID(), otherUser = randomUUID();
  const member = randomUUID(), otherMember = randomUUID(), foreignMember = randomUUID(), now = new Date();
  const { hashPassword } = require("../dist/security/password.js");
  const password_hash = await hashPassword("Migration-session-only!42");
  await f.db.collection("organizations").insertMany([org,foreignOrg].map(_id=>({_id,name:_id,kind:"school",status:"active",created_at:now,updated_at:now})));
  await f.db.collection("users").insertMany([user,otherUser].map(_id=>({_id,login_key:_id,display_name:_id,status:"active",password_hash,
    credential_version:1,identity_revision:0,must_change_password:false,temporary_password_expires_at:null,password_changed_at:now,created_at:now,updated_at:now})));
  await f.db.collection("organization_members").insertMany([
    {...base(org),_id:member,user_id:user,status:"disabled",authorization_revision:0},
    {...base(org),_id:otherMember,user_id:otherUser,status:"active",authorization_revision:0},
    {...base(foreignOrg),_id:foreignMember,user_id:user,status:"active",authorization_revision:0},
  ]);
  const subject = randomUUID(), stage = randomUUID();
  await f.db.collection("subjects").insertOne({_id:subject,code:"session-migration",name:"会话迁移",created_at:now,updated_at:now});
  await f.db.collection("education_stages").insertOne({_id:stage,code:"session-migration",name:"会话迁移",created_at:now,updated_at:now});
  const books = [org,foreignOrg].map(org_id=>({...base(org_id),title:"保留教材",stage_id:stage,subject_id:subject,source:"迁移测试"}));
  await f.db.collection("textbooks").insertMany(books);
  const editions = [books[0],books[0],books[1]].map((book,index)=>({...base(book.org_id),...V3_DEFAULTS.textbook_editions,
    textbook_id:book._id,edition_code:String(index),title:"保留版本",status:"retired",revision:1,created_by:user,contributors:[],
    submitted_by:user,submitted_at:now,published_by:user,published_at:now,source_version_id:null,
    license:{source:"保留授权",granted:true,expires_at:null},resource_ids:[],notes:"",access_revoked_at:now}));
  await f.db.collection("textbook_editions").insertMany(editions);
  const chapters = editions.map(edition=>({_id:randomUUID(),org_id:edition.org_id,textbook_edition_id:edition._id,
    parent_id:null,position:0,title:"保留章节",body:"",knowledge_point_ids:[],resource_ids:[]}));
  await f.db.collection("chapters").insertMany(chapters);
  // Install the actual validators, not permissive surrogate schemas, without creating a v4 marker.
  for (const name of ["sessions","submissions"]) await f.db.createCollection(name,{validator:ASSESSMENT_V4_SCHEMAS[name].validator});
  const session = {...base(org),user_id:user,member_id:member,mode:"practice",quiz_id:null,paper_id:null,
    textbook_edition_id:editions[0]._id,chapter_id:chapters[0]._id,knowledge_point_ids:[],difficulty:null,
    status:"submitted",revision:1,started_at:now,deadline_at:null,submitted_at:now,submission_id:randomUUID(),item_count:1};
  const submission = {...base(org),_id:session.submission_id,session_id:session._id,user_id:user,member_id:member,mode:"practice",quiz_id:null,
    reason:"manual",submitted_at:now,answers_hash:"0".repeat(64),grading_status:"pending",revision:1,effective_grading_revision:null,
    requested_grading_revision:1,total_score:null,max_score:Decimal128.fromString("1"),error_code:null,visibility_revision:0,visibility_fingerprint:null};
  await f.db.collection("sessions").insertOne(session);
  await f.db.collection("submissions").insertOne(submission);
  const capture = async () => {
    const collections = await f.db.listCollections().toArray();
    const snapshot = {};
    for (const collection of collections.sort((a,b)=>a.name.localeCompare(b.name))) snapshot[collection.name] = {
      options:collection.options,indexes:await f.db.collection(collection.name).listIndexes().toArray(),
      rows:await f.db.collection(collection.name).find().sort({_id:1}).toArray(),
    };
    return snapshot;
  };
  for (const [label,changes] of [
    ["合法章节允许retired和revoked教材及disabled成员",{}],
    ["nullable章节保留教材范围",{chapter_id:null}],
    ["nullable章节和教材范围",{chapter_id:null,textbook_edition_id:null}],
  ]) await t.test(label,async () => {
    await f.db.collection("sessions").updateOne({_id:session._id},{$set:changes});
    try {
      const before = await capture();
      const report = await inspectMigration(f.uri);
      assert.equal(report.invalid_references,0);
      assert.ok(Object.values(report.collections).every(row=>row.invalid_types===0));
      assert.deepEqual(await capture(),before);
    } finally { await f.db.collection("sessions").replaceOne({_id:session._id},session); }
  });
  for (const [label,collection,row,changes] of [
    ["章节孤儿","sessions",session,{chapter_id:randomUUID()}],
    ["章节跨组织","sessions",session,{chapter_id:chapters[2]._id}],
    ["章节同组织错教材版本","sessions",session,{chapter_id:chapters[1]._id}],
    ["章节存在但教材范围为空","sessions",session,{textbook_edition_id:null}],
    ["会话用户孤儿","sessions",session,{user_id:randomUUID()}],
    ["会话用户与成员不一致","sessions",session,{user_id:otherUser}],
    ["会话成员跨组织","sessions",session,{member_id:foreignMember}],
    ["提交成员孤儿","submissions",submission,{member_id:randomUUID()}],
    ["提交成员跨组织","submissions",submission,{member_id:foreignMember}],
    ["提交成员与父会话不一致","submissions",submission,{member_id:otherMember}],
    ["提交用户孤儿","submissions",submission,{user_id:randomUUID()}],
    ["提交用户与父会话不一致","submissions",submission,{user_id:otherUser}],
    ["提交身份整体替换为另一合法成员","submissions",submission,{user_id:otherUser,member_id:otherMember}],
  ]) await t.test(label,async () => {
    await f.db.collection(collection).updateOne({_id:row._id},{$set:changes});
    try {
      const before = await capture();
      const report = await inspectMigration(f.uri);
      assert.ok(Object.values(report.collections).every(value=>value.invalid_types===0),"异常只在关联，不在字段类型");
      assert.ok(report.invalid_references>0,label);
      assert.deepEqual(await capture(),before,"inspect不得修改任何集合、索引或validator");
      await assert.rejects(f.migrate(f.uri),/invalid types or references/);
      assert.deepEqual(await capture(),before,"拒绝迁移不得修改数据、DDL或marker");
      assert.equal(await f.db.collection("schema_migrations").countDocuments({version:4}),0);
    } finally { await f.db.collection(collection).replaceOne({_id:row._id},row); }
  });
  await f.migrate(f.uri);
  await assertSchema(f.db);
  assert.deepEqual(await f.db.collection("sessions").findOne({_id:session._id}),session);
  assert.deepEqual(await f.db.collection("submissions").findOne({_id:submission._id}),submission);
  assert.equal(await f.db.collection("schema_migrations").countDocuments({version:4,status:"completed"}),1);
});
