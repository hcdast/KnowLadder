'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {assessmentFixture,good,request,practice,createQuestion,grant}=require('./assessment-helpers.cjs');
const {status}=require('./helpers.cjs');
test('学习来源：授权教材和本人有效错题进入机构笔记，撤权/旧投影停止交付',{timeout:180000},async t=>{
 const f=await assessmentFixture(t,{env:{KL_TRAINING_ENABLED:'true',KL_LEARNING_STUDIO_ENABLED:'true'}});
 const input={title:'整数的理解',body:'我自己的解释，不复制原题答案。',source_kind:'chapter',source_id:f.chapterId,lesson_key:'',due_on:null};
 const note=await good(f.student,'/training/studio/notes',{method:'POST',body:input});
 let list=await good(f.student,'/training/studio/notes');assert.equal(list.items[0].source.edition_id,f.book.id);assert.equal(list.items[0].source.kind,'chapter');assert.ok(!JSON.stringify(list).includes('原创整数正文'));
 f.questions.push(await createQuestion(f));const session=await practice(f,{count:4});
 const receipt=await good(f.student,`/sessions/${session.id}/submissions`,{method:'POST',body:{expected_revision:session.revision,answers:[]}},202);
 const {processOne:grade}=require('../dist/assessment/worker'),{processOne:project,processDue}=require('../dist/learning/worker');
 for(let n=0;n<30;n++){if((await f.db.collection('submissions').findOne({_id:receipt.submission_id})).grading_status==='completed')break;assert.equal(await grade(f.db),true);}
 for(let n=0;n<40;n++){if(!await project(f.db)){await processDue(f.db);break;}}
 const mistakes=await good(f.student,'/me/mistakes?subject_id='+f.subject);assert.ok(mistakes.items.length);
 const mistake=await good(f.student,'/training/studio/notes',{method:'POST',body:{...input,title:'错题反思',source_kind:'mistake',source_id:mistakes.items[0].id}});
 list=await good(f.student,'/training/studio/notes');assert.equal(list.items.length,2);assert.ok(!JSON.stringify(list).includes('standard_answer'));assert.ok(!JSON.stringify(list).includes('原创验收解析'));
 const stranger=await f.actor();status(await request(stranger,'/training/studio/notes',{method:'POST',body:{...input,source_kind:'mistake',source_id:mistakes.items[0].id}}),404);
 await grant(f,f.editor,'content:revoke');const book=await good(f.editor,'/admin/textbook-editions/'+f.book.id);
 await good(f.editor,`/admin/textbook-editions/${f.book.id}/revoke-access`,{method:'POST',body:{expected_access_revision:book.access_revision,reason:'隔离来源笔记授权撤回'}});
 assert.deepEqual((await good(f.student,'/training/studio/notes')).items,[]);
 status(await request(f.student,`/training/studio/notes/${note._id}/actions`,{method:'POST',body:{action:'review',expected_revision:note.revision,note:'',due_on:null}}),404);
 await good(f.student,`/training/studio/notes/${mistake._id}/actions`,{method:'POST',body:{action:'delete',expected_revision:mistake.revision}});
});
