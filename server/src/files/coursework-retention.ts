import type { MongoClient, Db, Document } from 'mongodb';
import { newId } from '../database/object-id';
import { assertOperationalAccess } from '../operations/control';
import { assertLocalEnvironment, getOperationalState, requireActor, requireObjectId } from '../operations/contracts';
import { reserveManagedSafetyIntent, confirmSafetyIntent, safetyOperationId } from '../operations/ledger';
import { runInTxn } from '../database/txn';
import { fenceFileRetentionSubjects } from './references';

/** Managed local operator extension only; never schedules physical deletion. */
export async function extendCourseworkFileRetention(client:MongoClient, db:Db, input:{fileId:string;retentionUntil:string;actor:string;reason:string}) {
  requireObjectId(input.fileId); requireActor(input);
  if(process.env.KL_COURSEWORK_FILES_ENABLED!=='true')throw Error('COURSEWORK_FILES_DISABLED');
  const until=new Date(input.retentionUntil);
  if(!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input.retentionUntil) || !Number.isFinite(until.getTime()) || until<=new Date())throw Error('FILE_RETENTION_INVALID');
  await assertOperationalAccess(db);
  const state=await getOperationalState(db);
  if(state.mode!=='active' || !state.environment_id)throw Error('FILE_RETENTION_MANAGED_ACTIVE_REQUIRED');
  assertLocalEnvironment(db,state.environment_id);
  const files=db.collection<Document & {_id:string}>('file_resources');
  const before=await files.findOne({_id:input.fileId,owner_type:'coursework'});
  if(!before)throw Error('FILE_NOT_FOUND');
  if(before.status==='deleting' || before.deleted_at)throw Error('FILE_DELETE_BLOCKED');
  const operationId=safetyOperationId(JSON.stringify(['file.retention',input.fileId,until.toISOString(),input.actor,input.reason]));
  const reservation=await reserveManagedSafetyIntent(db,{operationId,action:'file.retention',resourceId:input.fileId,resourceType:'file',retentionUntil:until});
  if(!reservation)throw Error('FILE_RETENTION_MANAGED_ACTIVE_REQUIRED');
  await runInTxn(client,async session=>{
    await assertOperationalAccess(db);
    if(await db.collection('audit_events').findOne({request_id:operationId,resource_type:'file',resource_id:input.fileId,action:'file.retention.extend'},{session}))return;
    const live=await files.findOne({_id:input.fileId,owner_type:'coursework',updated_at:before.updated_at,deleted_at:null,status:{$ne:'deleting'}},{session});
    if(!live)throw Error('FILE_RETENTION_CONFLICT');
    await fenceFileRetentionSubjects(db,live._id,session);
    const owners=db.collection<Document & {_id:string}>('coursework_heads');
    const owner=await owners.findOne({_id:live.owner_version_id,org_id:live.org_id,user_id:live.created_by},{session});
    if(!owner || !Number.isSafeInteger(owner.revision))throw Error('FILE_OWNER_INVALID');
    const now=new Date();
    if((await owners.updateOne({_id:owner._id,revision:owner.revision},{$inc:{revision:1},$set:{updated_at:now}},{session})).matchedCount!==1)throw Error('FILE_RETENTION_CONFLICT');
    if((await files.updateOne({_id:live._id,updated_at:live.updated_at,deleted_at:null,status:{$ne:'deleting'}},{$max:{retention_until:until},$set:{updated_at:now}},{session})).matchedCount!==1)throw Error('FILE_RETENTION_CONFLICT');
    await db.collection<Document & {_id:string}>('audit_events').insertOne({_id:newId(),org_id:live.org_id,actor_id:input.actor,action:'file.retention.extend',resource_type:'file',resource_id:live._id,owner_type:'coursework',owner_version_id:owner._id,revision_before:owner.revision,revision_after:owner.revision+1,access_revision_before:null,access_revision_after:null,reason:input.reason,request_id:operationId,created_at:now},{session});
  },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},readPreference:'primary'});
  await confirmSafetyIntent(db,reservation);
  return {fileId:input.fileId,operationId,retentionUntil:(await files.findOne({_id:input.fileId}))!.retention_until};
}
