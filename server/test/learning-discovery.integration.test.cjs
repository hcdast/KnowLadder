"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./training-isolated-helpers.cjs');
const { status, Browser } = require('./helpers.cjs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { newId } = require('../dist/database/object-id');
async function create(f, code, title) {
  return f.good(f.author, '/courses', { code, title, subject_id: f.subject, version_no: 1,
    lessons: [{ key: 'reading', title: '观察与表达', kind: 'text', required: true, body: '记录一次观察，区分看到的事实与自己的解释。', file_id: null, owner_version_id: null }] });
}
async function publish(f, c) {
  c = await f.good(f.author, `/courses/${c._id}/actions`, { action: 'request-review', expected_revision: c.revision });
  return f.good(f.reviewer, `/courses/${c._id}/actions`, { action: 'publish', expected_revision: c.revision, note: '原创样本审核' });
}
test('资源发现：仅返回本人已分配且可读的已发布课程与授权名称，撤回后不泄露', { timeout: 180000 }, async t => {
  const f = await setup(t);
  const readable = await publish(f, await create(f, 'observation', '观察与表达'));
  await f.good(f.author, `/courses/${readable._id}/assign`, { class_id: f.classId });
  const draft = await create(f, 'private-draft', '未审核的私有内容');
  await publish(f, await create(f, 'not-assigned', '未分配的课程'));
  const data = await f.good(f.student, '/discovery');
  assert.equal(data.limit, 20); assert.equal(data.items.length, 1); assert.equal(data.next_cursor, null);
  const current = await f.db.collection('courses').findOne({_id:readable._id});
  assert.deepEqual(data.items[0], { id: readable._id, title: '观察与表达', status: 'published', revision: readable.revision, subject_id: f.subject, version_no: 1, lesson_count: 1, subject_name: '职业沟通', formats: ['text'], required_lesson_count: 1, lesson_titles: ['观察与表达'], updated_at: current.updated_at.toISOString() });
  assert.ok(!JSON.stringify(data).includes(draft._id)); assert.ok(!JSON.stringify(data).includes('未分配'));
  assert.deepEqual((await f.good(f.stranger, '/discovery')).items, []);
  status(await f.req(f.author, '/discovery'), 403);
  const anon = new Browser(f.browser.base);
  status(await anon.request('/training/discovery', { headers: { 'X-Org-Id': f.org } }), 401);
  await f.db.collection('class_members').updateOne({ member_id: f.student.member }, { $set: { status: 'ended' } });
  assert.deepEqual((await f.good(f.student, '/discovery')).items, []);
  status(await f.req(f.student, `/courses/${readable._id}?mode=learner`), 404);
});
test('资源发现：学科名称缺失不伪造；源退役停止发现；真实OpenAPI定义完整', { timeout: 180000 }, async t => {
  const f = await setup(t);
  const c = await publish(f, await create(f, 'reading', '阅读与反思'));
  await f.good(f.author, `/courses/${c._id}/assign`, { class_id: f.classId });
  const subject = await f.db.collection('subjects').findOne({ _id: f.subject });
  await f.db.collection('subjects').deleteOne({ _id: f.subject });
  assert.equal((await f.good(f.student, '/discovery')).items[0].subject_name, null);
  await f.db.collection('subjects').insertOne(subject);
  await f.good(f.reviewer, `/courses/${c._id}/actions`, { action: 'retire', expected_revision: c.revision, note: '验收源撤回停止发现' });
  assert.deepEqual((await f.good(f.student, '/discovery')).items, []);
  const url = new URL('/api/openapi.json', f.browser.base).href;
  const schema = await (await fetch(url)).json();
  const op = schema.paths['/api/v1/training/discovery'].get;
  assert.equal(op.responses[200].content['application/json'].schema.properties.data.properties.items.items.properties.subject_name.nullable, true);
  assert.ok(op.security.some(row => row.session));
  assert.deepEqual(op.parameters.filter(p => p.in === 'query').map(p => p.name), ['q','subject_id','format','sort','limit','cursor']);
  assert.equal(op.responses[200].content['application/json'].schema.properties.data.properties.items.maxItems, 50);
  // Explicit opt-in runs the repository's generator against this isolated real service.
  if (process.env.GENERATE_DISCOVERY_API === 'true') {
    const child = spawn(process.execPath, ['scripts/generate-api.mjs'], { cwd: path.resolve(__dirname, '../../web'), windowsHide: true, stdio: 'inherit', env: { ...process.env, OPENAPI_URL: url } });
    assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }), 0);
  }
});

async function seed(f, sample, count, { assigned=true, invalidMedia=false, title='分页原创课' }={}) {
  const rows=Array.from({length:count},(_,i)=>({...sample,_id:newId(),code:'seed-'+newId(),title:title+i,
    updated_at:new Date(Date.now()+i),created_at:new Date(),
    lessons:invalidMedia?[{key:'missing',title:'不可交付的材料',kind:'pdf',required:true,body:'',file_id:newId(),owner_version_id:newId()}]:sample.lessons}));
  await f.db.collection('courses').insertMany(rows);
  if(assigned)await f.db.collection('class_courses').insertMany(rows.map(row=>({_id:newId(),org_id:f.org,class_id:f.classId,course_id:row._id,subject_id:f.subject,status:'active',revision:1,created_at:new Date(),updated_at:new Date()})));
  return rows;
}

test('资源发现：200条较新无权课程不遮住旧可学课程，班级关联也无前200条截断', { timeout:180000 }, async t=>{
  const f=await setup(t), c=await publish(f,await create(f,'older','较早的有权课程'));
  // Deliberately put 205 unrelated links before the genuine assignment.
  await f.db.collection('class_courses').insertMany(Array.from({length:205},()=>({_id:newId(),org_id:f.org,class_id:newId(),course_id:c._id,subject_id:f.subject,status:'active',revision:1,created_at:new Date(),updated_at:new Date()})));
  await f.good(f.author,`/courses/${c._id}/assign`,{class_id:f.classId});
  const sample=await f.db.collection('courses').findOne({_id:c._id});await seed(f,sample,215,{assigned:false,title:'不应被发现的内容'});
  const data=await f.good(f.student,'/discovery');assert.deepEqual(data.items.map(r=>r.id),[c._id]);assert.equal(data.next_cursor,null);
  assert.ok(!JSON.stringify(data).includes('不应被发现'));
  assert.equal((await f.good(f.student,`/courses/${c._id}?mode=learner`))._id,c._id);
  await f.db.collection('classes').updateOne({_id:f.classId},{$set:{status:'archived'}});
  assert.deepEqual((await f.good(f.student,'/discovery')).items,[]);
});

test('资源发现：稳定分页无重复、服务端字面筛选与正倒序、游标绑定本人及全部条件', {timeout:180000},async t=>{
  const f=await setup(t), c=await publish(f,await create(f,'paging','观察[1].*'));
  await f.good(f.author,`/courses/${c._id}/assign`,{class_id:f.classId});
  const sample=await f.db.collection('courses').findOne({_id:c._id}), seeded=await seed(f,sample,6);
  const seen=[];let cursor=null;
  do{const page=await f.good(f.student,'/discovery?limit=2&sort=oldest'+(cursor?'&cursor='+encodeURIComponent(cursor):''));assert.ok(page.items.length<=2);seen.push(...page.items.map(r=>r.id));cursor=page.next_cursor;}while(cursor);
  assert.deepEqual(seen,[c._id,...seeded.map(r=>r._id)].sort());assert.equal(new Set(seen).size,7);
  const first=await f.good(f.student,'/discovery?limit=2');assert.deepEqual(first.items.map(r=>r.id),[...seen].reverse().slice(0,2));
  for(const query of ['limit=3','limit=2&sort=oldest','limit=2&q=x','limit=2&format=audio','limit=2&subject_id='+f.subject])
    status(await f.req(f.student,'/discovery?'+query+'&cursor='+encodeURIComponent(first.next_cursor)),422);
  status(await f.req(f.stranger,'/discovery?limit=2&cursor='+encodeURIComponent(first.next_cursor)),422);
  const tampered=(first.next_cursor[0]==='A'?'B':'A')+first.next_cursor.slice(1);
  status(await f.req(f.student,'/discovery?limit=2&cursor='+encodeURIComponent(tampered)),422);
  const literal=await f.good(f.student,'/discovery?q='+encodeURIComponent('[1].*'));assert.deepEqual(literal.items.map(r=>r.id),[c._id]);
  assert.equal((await f.good(f.student,'/discovery?q='+encodeURIComponent('职业沟通'))).items.length,7);
  assert.equal((await f.good(f.student,'/discovery?format=audio')).items.length,0);
  for(const query of ['limit=0','limit=51','limit=1.5','limit=x','q=a&q=b','format=unknown','sort=title','subject_id=bad','unknown=x','q[$ne]=x'])status(await f.req(f.student,'/discovery?'+query),422);
  const other=(await f.ops.createOrganization(f.context,{name:'另一隔离学校',kind:'school'})).organization_id;
  await f.ops.setMembership(f.context,{user_id:f.student.user.user_id,org_id:other,roles:['student']});
  status(await f.student.browser.request('/training/discovery?limit=2&cursor='+encodeURIComponent(first.next_cursor),{headers:{'X-Org-Id':other}}),422);
});

test('资源发现：不可用媒体的有界空批次可继续，游标不泄露候选ID，撤班后旧游标不能复活目录', {timeout:180000},async t=>{
  const f=await setup(t), c=await publish(f,await create(f,'valid-tail','最后一门可学课程'));
  await f.good(f.author,`/courses/${c._id}/assign`,{class_id:f.classId});
  const sample=await f.db.collection('courses').findOne({_id:c._id});const hidden=await seed(f,sample,201,{invalidMedia:true,title:'未就绪内容'});
  let page=await f.good(f.student,'/discovery');assert.equal(page.items.length,0);assert.ok(page.next_cursor);
  const decoded=Buffer.from(page.next_cursor,'base64url').toString('utf8');assert.ok(hidden.every(r=>!decoded.includes(r._id)));assert.ok(!JSON.stringify(page).includes('未就绪'));
  const token=page.next_cursor;page=await f.good(f.student,'/discovery?cursor='+encodeURIComponent(token));assert.deepEqual(page.items.map(r=>r.id),[c._id]);assert.equal(page.next_cursor,null);
  await f.db.collection('class_members').updateOne({member_id:f.student.member},{$set:{status:'ended'}});
  page=await f.good(f.student,'/discovery?cursor='+encodeURIComponent(token));assert.deepEqual(page.items,[]);assert.equal(page.next_cursor,null);
});
