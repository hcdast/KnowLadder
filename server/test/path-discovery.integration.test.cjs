'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {pathFixture}=require('./path-discovery-fixture.cjs');const {status}=require('./helpers.cjs');const {newId}=require('../dist/database/object-id');
const {spawn}=require('node:child_process'),path=require('node:path');
test('路径发现：本人指派快照、顺序进度与只读投影，真实生成契约',{timeout:180000},async t=>{
 const f=await pathFixture(t),a=f.path.assignment;
 const list=await f.good(f.student,'/discovery/paths');assert.equal(list.items.length,1);assert.equal(list.limit,20);assert.equal(list.next_cursor,null);assert.equal(list.items[0].title,f.path.path.title);
 assert.deepEqual(Object.keys(list.items[0]).sort(),['id','title','path_revision','course_count','task_count','assigned_at'].sort());
 const before=await f.db.collection('training_paths').findOne({_id:f.path.path._id});
 const detail=await f.good(f.student,'/discovery/paths/'+a._id);assert.deepEqual(detail.courses.map(c=>c.id),f.courses.map(c=>c._id));assert.equal(detail.courses[0].confirmed_required_count,0);assert.equal(detail.attendance_bp,8000);
 await f.good(f.student,`/courses/${f.courses[0]._id}/progress`,{lesson_key:'reading',position:0,complete:true});
 assert.equal((await f.good(f.student,'/discovery/paths/'+a._id)).courses[0].confirmed_required_count,1);
 assert.equal((await f.db.collection('training_paths').findOne({_id:before._id})).revision,before.revision);assert.equal(await f.db.collection('training_certificates').countDocuments({}),0);
 assert.deepEqual((await f.good(f.stranger,'/discovery/paths')).items,[]);status(await f.req(f.stranger,'/discovery/paths/'+a._id),404);status(await f.req(f.author,'/discovery/paths'),403);
 const schema=await (await fetch(new URL('/api/openapi.json',f.browser.base))).json(),op=schema.paths['/api/v1/training/discovery/paths'].get;
 assert.deepEqual(op.parameters.filter(p=>p.in==='query').map(p=>p.name),['q','sort','limit','cursor']);assert.equal(op.responses[200].content['application/json'].schema.properties.data.properties.items.maxItems,50);
 assert.equal(schema.paths['/api/v1/training/discovery/paths/{id}'].get.responses[200].content['application/json'].schema.properties.data.properties.courses.maxItems,30);
 if(process.env.GENERATE_PATH_API==='true') {const c=spawn(process.execPath,['scripts/generate-api.mjs'],{cwd:path.resolve(__dirname,'../../web'),windowsHide:true,stdio:'inherit',env:{...process.env,OPENAPI_URL:new URL('/api/openapi.json',f.browser.base).href}});assert.equal(await new Promise((resolve,reject)=>{c.once('error',reject);c.once('exit',resolve)}),0);}
});
test('路径发现：分页条件绑定与200个失效班级候选续查、其他人的新记录不截断本人目录',{timeout:180000},async t=>{
 const f=await pathFixture(t);for(let i=0;i<4;i++)await f.publishPath('连续路径'+i);
 const all=[];let cursor=null;do{const data=await f.good(f.student,'/discovery/paths?limit=2'+(cursor?'&cursor='+cursor:''));all.push(...data.items.map(x=>x.id));cursor=data.next_cursor;}while(cursor);assert.equal(all.length,5);assert.equal(new Set(all).size,5);
 const first=await f.good(f.student,'/discovery/paths?limit=2');for(const suffix of ['&q=观察','&sort=oldest','&limit=3'])status(await f.req(f.student,'/discovery/paths?limit=2&cursor='+first.next_cursor+suffix),422);
 status(await f.req(f.stranger,'/discovery/paths?limit=2&cursor='+first.next_cursor),422);status(await f.req(f.student,'/discovery/paths?cursor=bad'),422);
 const coursePage=await f.good(f.student,'/discovery?limit=1');status(await f.req(f.student,'/discovery/paths?limit=1&cursor='+coursePage.next_cursor),422);
 const oldest=await f.good(f.student,'/discovery/paths?sort=oldest');assert.deepEqual(oldest.items.map(x=>x.id),[...all].reverse());
 assert.equal((await f.good(f.student,'/discovery/paths?q='+encodeURIComponent('[1].*'))).items.length,1);
 for(const suffix of ['?subject_id='+f.subject,'?format=text','?limit=51','?q[x]=a','?sort=hot','?q='+('a'.repeat(101))])status(await f.req(f.student,'/discovery/paths'+suffix),422);
 const base=f.path.assignment,p=f.path.path,now=new Date(),clazz=newId();const sample=await f.db.collection('classes').findOne({_id:f.classId});await f.db.collection('classes').insertOne({...sample,_id:clazz});
 const records=Array.from({length:201},()=>{const pid=newId();return {p:{...p,_id:pid,class_id:clazz},a:{...base,_id:newId(),path_id:pid,class_id:clazz,created_at:now,updated_at:now}}});
 await f.db.collection('training_paths').insertMany(records.map(x=>x.p));await f.db.collection('training_path_assignments').insertMany(records.map(x=>x.a));
 const empty=await f.good(f.student,'/discovery/paths');assert.deepEqual(empty.items,[]);assert.ok(empty.next_cursor);assert.ok(!empty.next_cursor.includes(records[0].a._id));
 const next=await f.good(f.student,'/discovery/paths?cursor='+empty.next_cursor);assert.equal(next.items.length,5);assert.equal(next.next_cursor,null);
 await f.db.collection('training_path_assignments').insertMany(Array.from({length:215},()=>({...base,_id:newId(),path_id:newId(),user_id:f.stranger.user.user_id,member_id:f.stranger.member})));
 assert.equal((await f.good(f.student,'/discovery/paths?q=连续')).items.length,4);
});
test('路径发现：来源撤回、同班分配失效、退班与路径撤回停止交付',{timeout:180000},async t=>{
 const f=await pathFixture(t),url='/discovery/paths/'+f.path.assignment._id;
 const link=await f.db.collection('class_courses').findOne({course_id:f.courses[0]._id,class_id:f.classId});
 await f.db.collection('class_courses').updateOne({_id:link._id},{$set:{status:'ended'}});status(await f.req(f.student,url),404);
 await f.db.collection('class_courses').updateOne({_id:link._id},{$set:{status:'active'}});
 await f.db.collection('courses').updateOne({_id:f.courses[0]._id},{$set:{status:'retired'}});status(await f.req(f.student,url),404);
 await f.db.collection('courses').updateOne({_id:f.courses[0]._id},{$set:{status:'published'}});
 const course=await f.db.collection('courses').findOne({_id:f.courses[0]._id});
 await f.db.collection('courses').updateOne({_id:course._id},{$set:{lessons:[{key:'missing',title:'不可交付的媒体',kind:'pdf',required:true,body:'',file_id:newId(),owner_version_id:newId()}]}});status(await f.req(f.student,url),404);
 await f.db.collection('courses').updateOne({_id:course._id},{$set:{lessons:course.lessons}});
 await f.db.collection('class_members').updateOne({member_id:f.student.member},{$set:{status:'ended'}});assert.deepEqual((await f.good(f.student,'/discovery/paths')).items,[]);status(await f.req(f.student,url),404);
 await f.db.collection('class_members').updateOne({member_id:f.student.member},{$set:{status:'active'}});
 await f.good(f.author,`/phase2/paths/${f.path.path._id}/actions`,{action:'retire',expected_revision:f.path.path.revision,note:'撤回隔离路径'});assert.deepEqual((await f.good(f.student,'/discovery/paths')).items,[]);status(await f.req(f.student,url),404);
});

test('路径发现：教务开关关闭时接口拒绝，不回退旧数据',{timeout:180000},async t=>{
 const {setup}=require('./training-isolated-helpers.cjs'),f=await setup(t);
 status(await f.req(f.student,'/discovery/paths'),503);status(await f.req(f.student,'/discovery/paths/'+newId()),503);
});
