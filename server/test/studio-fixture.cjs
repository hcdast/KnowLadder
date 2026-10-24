'use strict';
const {setup}=require('./training-isolated-helpers.cjs');
const metadata={objectives:'能观察、记录并解释一次实践',audience:'希望学习观察与表达的学习者',prerequisites:'',difficulty:'introductory',estimated_minutes:45,instructor:'原创课程教师',language:'中文'};
async function studioFixture(t,env={}){
 const f=await setup(t,{KL_LEARNING_STUDIO_ENABLED:'true',...env});
 f.course=await f.good(f.author,'/courses',{code:'studio-original',title:'观察与作品',subject_id:f.subject,version_no:1,metadata,
  lessons:[{key:'observe',title:'观察与记录',kind:'text',required:true,body:'观察一件日常物品，记录三个可以核验的事实。',file_id:null,owner_version_id:null}]});
 f.course=await f.good(f.author,`/courses/${f.course._id}/actions`,{action:'request-review',expected_revision:f.course.revision});
 f.course=await f.good(f.reviewer,`/courses/${f.course._id}/actions`,{action:'publish',expected_revision:f.course.revision,note:'原创内容独立核验'});
 await f.good(f.author,`/courses/${f.course._id}/assign`,{class_id:f.classId});
 f.question=body=>f.good(f.student,'/studio/questions',{class_id:f.classId,subject_id:f.subject,course_id:f.course._id,title:'如何区分事实与判断？',body:'记录时用了“漂亮”，应该怎样改写？',...body});
 f.meetup=async(capacity=1)=>{
  const now=Date.now();let row=await f.good(f.author,'/studio/meetups',{class_id:f.classId,subject_id:f.subject,title:'一起观察校园中的植物',body:'每人记录三个观察事实，交流各自的证据。',location:'班级学习室',starts_at:new Date(now+7200000).toISOString(),ends_at:new Date(now+10800000).toISOString(),enrollment_closes_at:new Date(now+3600000).toISOString(),capacity});
  return f.good(f.author,`/studio/meetups/${row._id}/actions`,{action:'publish',expected_revision:row.revision});
 };
 return f;
}
// File metadata fixture only; scanner/byte verification belongs to the existing file integration suite.
function attachment(f,head){
 const {newId}=require('../dist/database/object-id'),{randomUUID}=require('node:crypto'),now=new Date();
 return {_id:newId(),org_id:f.org,owner_type:'coursework',owner_version_id:head._id,created_by:f.student.user.user_id,display_name:'观察记录.txt',storage_key:randomUUID(),
  declared_size:12,declared_mime:'text/plain',declared_checksum:'a'.repeat(64),size:12,mime:'text/plain',checksum:'a'.repeat(64),status:'ready',scan_status:'clean',scan_attempt:0,
  lease_token:null,lease_until:null,available_at:now,uploaded_at:now,error_code:null,created_at:now,updated_at:now,upload_key:null,upload_lease_token:null,upload_lease_until:null,
  upload_storage_key:null,upload_storage_keys:[],upload_owner_revision:null,upload_result_revision:head.revision,retention_until:null,legal_hold:false,
  deletion_requested_at:null,deletion_requested_by:null,deletion_requested_reason:null,deleted_at:null,deletion_lease_token:null,deletion_lease_until:null,deletion_attempt:0,
  scan_engine_version:null,scan_database_version:null,scan_database_updated_at:null,scanned_at:null};
}
module.exports={studioFixture,metadata,attachment};
