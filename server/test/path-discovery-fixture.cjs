'use strict';
const {setup}=require('./training-isolated-helpers.cjs');
async function pathFixture(t) {
 const f=await setup(t,{KL_TRAINING_PHASE2_ENABLED:'true'});
 for(const [actor,cap] of [[f.author,'training:path-edit'],[f.reviewer,'training:path-review']]) {
  const m=await f.db.collection('organization_members').findOne({_id:actor.member});
  await f.ops.setCapability(f.context,{org_id:f.org,member_id:actor.member,capability:cap,granted:true,expected_revision:m.authorization_revision,valid_to:new Date(Date.now()+3600000)});
 }
 f.courses=[];
 for(const [i,title] of ['观察事实','表达与回顾'].entries()) {
  let c=await f.good(f.author,'/courses',{code:'path-course-'+i,title,subject_id:f.subject,version_no:1,lessons:[{key:'reading',title:'记录与表达',kind:'text',required:true,body:'记录一条事实，再写一句解释，分别标明依据。',file_id:null,owner_version_id:null}]});
  c=await f.good(f.author,`/courses/${c._id}/actions`,{action:'request-review',expected_revision:c.revision});
  c=await f.good(f.reviewer,`/courses/${c._id}/actions`,{action:'publish',expected_revision:c.revision,note:'原创隔离样本'});
  await f.good(f.author,`/courses/${c._id}/assign`,{class_id:f.classId});f.courses.push(c);
 }
 f.publishPath=async(title='观察到表达 [1].*',ids=f.courses.map(c=>c._id))=>{
  let p=await f.good(f.author,'/phase2/paths',{class_id:f.classId,subject_id:f.subject,title,course_ids:ids,task_ids:[],attendance_bp:8000,grade_min:60});
  p=await f.good(f.author,`/phase2/paths/${p._id}/actions`,{action:'request-review',expected_revision:p.revision});
  p=await f.good(f.reviewer,`/phase2/paths/${p._id}/actions`,{action:'publish',expected_revision:p.revision,note:'独立审核隔离路径'});
  const a=await f.db.collection('training_path_assignments').findOne({path_id:p._id,member_id:f.student.member});return {path:await f.db.collection("training_paths").findOne({_id:p._id}),assignment:a};
 };
 f.path=await f.publishPath();return f;
}
module.exports={pathFixture};
