import type { ClientSession, Db } from 'mongodb';
import { requireEvidenceSubject } from '../assessment/subject-access';
import { fail } from '../errors';

/** Deliberately includes malformed cross-organization references: cleanup must fail closed. */
export async function fileReferenced(db: Db, fileId: string, session: ClientSession): Promise<boolean> {
  for (const name of ['textbook_editions', 'question_versions', 'chapters']) {
    if (await db.collection(name).findOne({ resource_ids: fileId }, { session, projection: { _id: 1 } })) return true;
  }
  return !!await db.collection('assessment_resource_references').findOne({ file_id: fileId }, { session, projection: { _id: 1 } });
}

/** Serialize stronger retention/hold with subject erasure's user barrier. */
export async function fenceFileRetentionSubjects(db:Db,fileId:string,session:ClientSession):Promise<void> {
  if(!session.inTransaction())fail(503,'FILE_TRANSACTION_REQUIRED','保留策略变更必须位于事务');
  const references=await db.collection('assessment_resource_references').find({file_id:fileId,reference_type:'session_item'},{session}).limit(1001).toArray();
  if(references.length>1000)fail(503,'FILE_REFERENCE_CAPACITY','引用过多，不能安全变更保留策略');
  const subjects=new Set<string>();
  for(const reference of references){
    const item=await db.collection<{_id:string;session_id:string;org_id:string}>('session_items').findOne({_id:reference.reference_id as string,org_id:reference.org_id as string},{session});
    if(!item)fail(409,'FILE_REFERENCE_INVALID','文件引用关系不完整');
    const owner=await db.collection<{_id:string;user_id:string;org_id:string}>('sessions').findOne({_id:item.session_id,org_id:item.org_id},{session});
    if(!owner)fail(409,'FILE_REFERENCE_INVALID','文件引用关系不完整');
    subjects.add(owner.user_id);
  }
  for(const userId of subjects)await requireEvidenceSubject(db,session,userId);
}
