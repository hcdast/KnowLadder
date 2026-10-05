import type { ClientSession, Db } from 'mongodb';
import { requireEvidenceSubject } from '../assessment/subject-access';
import { fail } from '../errors';

/** Deliberately includes malformed cross-organization references: cleanup must fail closed. */
export async function fileReferenced(db: Db, fileId: string, session: ClientSession): Promise<boolean> {
  for (const name of ['textbook_editions', 'question_versions', 'chapters']) {
    if (await db.collection(name).findOne({ resource_ids: fileId }, { session, projection: { _id: 1 } })) return true;
  }
  if (process.env.KL_TRAINING_ENABLED === 'true' && await db.collection('courses').findOne({'lessons.file_id':fileId},{session,projection:{_id:1}})) return true;
  if(process.env.KL_COURSEWORK_FILES_ENABLED==='true') for(const name of ['coursework_heads','coursework_submissions']) if(await db.collection(name).findOne({file_ids:fileId},{session,projection:{_id:1}})) return true;
  return !!await db.collection('assessment_resource_references').findOne({ file_id: fileId }, { session, projection: { _id: 1 } });
}

/** Serialize stronger retention/hold with subject erasure's user barrier. */
export async function fenceFileRetentionSubjects(db:Db,fileId:string,session:ClientSession):Promise<void> {
  if(!session.inTransaction())fail(503,'FILE_TRANSACTION_REQUIRED','保留策略变更必须位于事务');
  const workFile=await db.collection<{_id:string;owner_version_id:string;org_id:string;created_by:string}>('file_resources').findOne({_id:fileId,owner_type:'coursework'},{session});
  if(workFile){const head=await db.collection<{_id:string;user_id:string;org_id:string}>('coursework_heads').findOne({_id:workFile.owner_version_id,org_id:workFile.org_id,user_id:workFile.created_by},{session});if(!head)fail(409,'FILE_OWNER_MISSING','作业文件归属缺失');await requireEvidenceSubject(db,session,head.user_id,head.org_id);}
  const references=await db.collection('assessment_resource_references').find({file_id:fileId,reference_type:'session_item'},{session}).limit(1001).toArray();
  if(references.length>1000)fail(503,'FILE_REFERENCE_CAPACITY','引用过多，不能安全变更保留策略');
  const subjects=new Map<string,Set<string>>();
  for(const reference of references){
    const item=await db.collection<{_id:string;session_id:string;org_id:string}>('session_items').findOne({_id:reference.reference_id as string,org_id:reference.org_id as string},{session});
    if(!item)fail(409,'FILE_REFERENCE_INVALID','文件引用关系不完整');
    const owner=await db.collection<{_id:string;user_id:string;org_id:string}>('sessions').findOne({_id:item.session_id,org_id:item.org_id},{session});
    if(!owner)fail(409,'FILE_REFERENCE_INVALID','文件引用关系不完整');
    let organizations=subjects.get(owner.user_id);
    if(!organizations){organizations=new Set<string>();subjects.set(owner.user_id,organizations);}
    organizations.add(owner.org_id);
  }
  for(const [userId,organizations] of subjects)for(const orgId of organizations)await requireEvidenceSubject(db,session,userId,orgId);
}
