import { storageDriver } from "./storage";
import {isCourseworkFile,fileOwnerCollection} from './owner';
import { requireObjectId } from "../operations/contracts";
import { newId } from "../database/object-id";
import { HttpException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, read as fsRead } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Response } from 'express';
import type { Db, MongoClient } from 'mongodb';
import type { AuditEvent } from '../database/contracts';
import { Database } from '../database/database';
import { ContentAccess, type ContentContext } from '../content/access';
import { CONTENT_COLLECTIONS, licensed, type BaseVersion, type FileResource } from '../content/contracts';
import { ApiRequest, fail } from '../errors';
import { DOCX_FILE_MIME, allowedFileMimes, fileConfig, fileScanEnabled, MAX_FILE_SIZE, openPrivate, assertUploadCapacity } from './config';
import { receive } from './stream';
import { assertScanner } from './scanner';
import { fileReferenced, fenceFileRetentionSubjects } from './references';
import { recordLearningFeedback, touchContentLearningScope } from '../learning/tracking';
import { assertOperationalAccess } from '../operations/control';
import { runInTxn } from '../database/txn';
import { confirmSafetyIntent, reserveManagedSafetyIntent, safetyOperationId } from '../operations/ledger';
import { assertLocalEnvironment, getOperationalState, requireActor, requireUuid } from '../operations/contracts';
export interface RegisterFile { owner_type:'textbook'|'question'; owner_version_id:string; expected_revision:number; display_name:string; size:number; mime:string; checksum:string; }
export interface ScheduleDeletion { expected_owner_revision:number; retention_until:string; reason:string; }
interface PreparedDelivery { handle:FileHandle; start:number; end:number; partial:boolean; }
const UPLOAD_LEASE_MS = 120000;
export async function setFileHold(client:MongoClient,db:Db,input:{fileId:string;hold:boolean;actor:string;reason:string}) {
  requireObjectId(input.fileId); requireActor(input);
  if(typeof input.hold!=='boolean')throw new Error('FILE_HOLD_INVALID');
  await assertOperationalAccess(db);
  const state=await getOperationalState(db);
  if(state.mode!=='active' || !state.environment_id)throw new Error('FILE_HOLD_MANAGED_ACTIVE_REQUIRED');
  assertLocalEnvironment(db,state.environment_id);
  const files=db.collection<FileResource>('file_resources');
  const before=await files.findOne({_id:input.fileId});
  if(!before)throw new Error('FILE_NOT_FOUND');
  if(isCourseworkFile(before) && process.env.KL_COURSEWORK_FILES_ENABLED!=='true')throw Error('COURSEWORK_FILES_DISABLED');
  const operationId=safetyOperationId(JSON.stringify(['file.hold',input.fileId,input.hold,input.actor,input.reason]));
  const reservation=await reserveManagedSafetyIntent(db,{operationId,action:'file.hold',resourceId:input.fileId,resourceType:'file',hold:input.hold});
  if(!reservation)throw new Error('FILE_HOLD_MANAGED_ACTIVE_REQUIRED');
  await runInTxn(client, async (session) => {
    await assertOperationalAccess(db);
    const receipt=await db.collection<AuditEvent>('audit_events').findOne({request_id:operationId,resource_type:'file',resource_id:input.fileId,actor_id:input.actor,action:input.hold?'file.hold.set':'file.hold.release',reason:input.reason},{session});
    if(receipt)return;
    if(before.status==='deleting' || before.deleted_at)throw new Error('FILE_DELETE_BLOCKED');
    const live=await files.findOne({_id:input.fileId,updated_at:before.updated_at,legal_hold:before.legal_hold,status:{$ne:'deleting'},deleted_at:null},{session});
    if(!live)throw new Error('FILE_HOLD_CONFLICT');
    await fenceFileRetentionSubjects(db,live._id,session);
    const owners=db.collection<BaseVersion>(fileOwnerCollection(live));
    const owner=await owners.findOne({_id:live.owner_version_id,org_id:live.org_id},{session});
    if(!owner)throw new Error('FILE_OWNER_NOT_FOUND');
    const coursework=isCourseworkFile(live);
    if(coursework && (owner.user_id!==live.created_by || !Number.isSafeInteger(owner.revision)))throw Error('FILE_OWNER_INVALID');
    const fenced=await owners.updateOne({_id:owner._id,org_id:live.org_id,...(coursework?{revision:owner.revision}:{access_revision:owner.access_revision})},{$inc:coursework?{revision:1}:{access_revision:1}},{session});
    if(fenced.modifiedCount!==1)throw new Error('FILE_HOLD_CONFLICT');
    const now=new Date();
    const changed=await files.updateOne({_id:live._id,updated_at:live.updated_at,legal_hold:live.legal_hold,status:{$ne:'deleting'},deleted_at:null},{$set:{legal_hold:input.hold,updated_at:now}},{session});
    if(changed.matchedCount!==1)throw new Error('FILE_HOLD_CONFLICT');
    await db.collection<AuditEvent>('audit_events').insertOne({_id:newId(),org_id:live.org_id,actor_id:input.actor,action:input.hold?'file.hold.set':'file.hold.release',resource_type:'file',resource_id:live._id,owner_type:live.owner_type,owner_version_id:live.owner_version_id,revision_before:owner.revision,revision_after:owner.revision+(coursework?1:0),access_revision_before:coursework?null:owner.access_revision,access_revision_after:coursework?null:owner.access_revision+1,reason:input.reason,request_id:operationId,created_at:now},{session});
  },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},readPreference:'primary'});
  await confirmSafetyIntent(db,reservation);
  return {fileId:input.fileId,hold:input.hold,operationId};
}

@Injectable()
export class FilesService {
  constructor(readonly access: ContentAccess, readonly database: Database) {}
  private get files() { return this.database.db.collection<FileResource>('file_resources'); }
  private configured() {
    if (!fileScanEnabled()) fail(503,'FILE_SCAN_DISABLED','文件扫描已关闭，暂停新附件上传');
    try { fileConfig(); } catch { fail(503,'SCANNER_NOT_CONFIGURED','私有文件存储或扫描引擎未配置'); }
  }
  private revision(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail(422,'INVALID_REVISION','版本revision无效'); return value; }
  private async file(ctx: ContentContext, id: string) {
    const file = await this.files.findOne({_id:id,org_id:ctx.orgId},{session:ctx.session});
    if (!file || isCourseworkFile(file)) fail(404,'NOT_FOUND','文件不存在');
    return file;
  }
  private view(file: FileResource) { return {id:file._id,owner_type:file.owner_type,owner_version_id:file.owner_version_id,display_name:file.display_name,size:file.size ?? file.declared_size,mime:file.mime ?? file.declared_mime,checksum:file.checksum ?? file.declared_checksum,status:file.status,scan_status:file.scan_status,error_code:file.error_code,retention_until:file.retention_until,legal_hold:file.legal_hold,deletion_requested_at:file.deletion_requested_at,deleted_at:file.deleted_at,upload_in_progress:!!file.upload_lease_until&&file.upload_lease_until.getTime()>Date.now(),scanned_at:file.scanned_at,scan_engine_version:file.scan_engine_version,scan_database_version:file.scan_database_version,scan_database_updated_at:file.scan_database_updated_at}; }
  private async audit(ctx: ContentContext, file: FileResource, action: string, before:BaseVersion, after:BaseVersion, reason:string) {
    await touchContentLearningScope(this.database.db,ctx,file.owner_type,after,true);
    await this.database.db.collection<AuditEvent>('audit_events').insertOne({_id:newId(),org_id:ctx.orgId,actor_id:ctx.userId,action,resource_type:'file',resource_id:file._id,owner_type:file.owner_type,owner_version_id:file.owner_version_id,revision_before:before.revision,revision_after:after.revision,access_revision_before:before.access_revision,access_revision_after:after.access_revision,reason,request_id:ctx.requestId,created_at:new Date(),...(ctx.platform?{actor_org_id:ctx.platform.actorOrgId,target_org_id:ctx.orgId,grant_ids:ctx.platform.grantIds,grant_revision:ctx.platform.grantRevision}:{})},{session:ctx.session});
  }
  async register(req: ApiRequest, input: RegisterFile) {
    this.configured();
    if (!input || typeof input !== 'object' || Object.keys(input).some(key=>!['owner_type','owner_version_id','expected_revision','display_name','size','mime','checksum'].includes(key)) || !['textbook','question'].includes(input.owner_type) || typeof input.owner_version_id !== 'string' || typeof input.display_name !== 'string' || input.display_name.length < 1 || input.display_name.length > 200 || /[\u0000-\u001f\u007f/\\]/.test(input.display_name) || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > MAX_FILE_SIZE || !allowedFileMimes().some(mime=>mime===input.mime) || typeof input.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(input.checksum)) fail(422,'INVALID_FILE','附件登记参数无效');
    if (input.mime === DOCX_FILE_MIME && input.owner_type !== "textbook") fail(422,"INVALID_FILE","DOCX仅用于教材素材导入");
    this.revision(input.expected_revision);
    return this.access.run(req,true,async ctx => {
      this.access.require(ctx,'edit');
      const before=await this.access.owner(ctx,input.owner_type,input.owner_version_id,'manage');
      if(!licensed(before)) fail(404,'NOT_FOUND','内容不存在或未获授权');
      return this.access.idempotent(ctx,req,'file.register',input.owner_version_id,input,async()=>{
        await this.access.fenceOwner(ctx,input.owner_type,input.owner_version_id);
        const owner = await this.access.touchOwner(ctx,input.owner_type,input.owner_version_id,input.expected_revision);
        const now = new Date();
        const file: FileResource = {_id:newId(),org_id:ctx.orgId,owner_type:input.owner_type,owner_version_id:input.owner_version_id,created_by:ctx.userId,display_name:input.display_name,storage_key:randomUUID(),declared_size:input.size,declared_mime:input.mime,declared_checksum:input.checksum,size:null,mime:null,checksum:null,status:'pending',scan_status:'awaiting_upload',scan_attempt:0,lease_token:null,lease_until:null,available_at:now,uploaded_at:null,error_code:null,created_at:now,updated_at:now,upload_key:null,upload_lease_token:null,upload_lease_until:null,upload_storage_key:null,upload_storage_keys:[],upload_owner_revision:null,upload_result_revision:null,retention_until:null,legal_hold:false,deletion_requested_at:null,deletion_requested_by:null,deletion_requested_reason:null,deleted_at:null,deletion_lease_token:null,deletion_lease_until:null,deletion_attempt:0,scan_engine_version:null,scan_database_version:null,scan_database_updated_at:null,scanned_at:null};
        await this.files.insertOne(file,{session:ctx.session});
        await this.audit(ctx,file,'file.register',before,owner,'登记私有附件');
        return {...this.view(file),owner_revision:owner.revision};
      });
    });
  }
  async status(req: ApiRequest, id: string) {
    return this.access.run(req,false,async ctx=>{const file=await this.file(ctx,id);const owner=await this.access.owner(ctx,file.owner_type,file.owner_version_id,'manage');return {...this.view(file),owner_revision:owner.revision};});
  }
  async list(req:ApiRequest, query:Record<string,unknown>) {
    if(!query||Object.keys(query).some(k=>!['owner_type','owner_version_id','cursor','limit'].includes(k))||!['textbook','question'].includes(query.owner_type as string)||typeof query.owner_version_id!=='string')fail(422,'INVALID_QUERY','文件归属筛选无效');
    const kind=query.owner_type as 'textbook'|'question';const id=query.owner_version_id as string;
    const limit=query.limit===undefined?20:Number(query.limit);
    if(!Number.isSafeInteger(limit)||limit<1||limit>50)fail(422,'INVALID_QUERY','limit须为1至50');
    return this.access.run(req,false,async ctx=>{
      const owner=await this.access.owner(ctx,kind,id,'manage');
      const scope=createHash('sha256').update(JSON.stringify([ctx.orgId,ctx.userId,ctx.platform?.actorOrgId ?? ctx.orgId,'files',kind,id,limit])).digest('hex');
      let after:string|undefined;
      if(query.cursor!==undefined){try{if(typeof query.cursor!=='string'||query.cursor.length>1000)throw new Error();const decoded=JSON.parse(Buffer.from(query.cursor,'base64url').toString());if(decoded.scope!==scope||typeof decoded.after!=='string'||!/^[a-f0-9-]{36}$/.test(decoded.after))throw new Error();after=decoded.after;}catch{fail(422,'INVALID_CURSOR','游标不属于当前文件范围');}}
      const rows=await this.files.find({org_id:ctx.orgId,owner_type:kind,owner_version_id:id,...(after?{_id:{$gt:after}}:{})},{session:ctx.session}).sort({_id:1}).limit(limit+1).toArray();
      const more=rows.length>limit;const items=rows.slice(0,limit);
      return {items:items.map(row=>this.view(row)),owner_revision:owner.revision,next_cursor:more?Buffer.from(JSON.stringify({scope,after:items[items.length-1]._id})).toString('base64url'):null};
    });
  }
  async uploadReceipt(req: ApiRequest, key: string, id: string) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key) || !/^[a-f0-9-]{36}$/i.test(id)) fail(422,'INVALID_QUERY','上传恢复查询无效');
    return this.access.run(req,false,async ctx=>{
      if(!ctx.platform)fail(403,'FORBIDDEN','仅平台业务恢复入口可查询上传回执');
      const row=await this.file(ctx,id);
      const owner=await this.access.owner(ctx,row.owner_type,row.owner_version_id,'manage');
      if(!licensed(owner))fail(404,'NOT_FOUND','内容不存在或未获授权');
      if(row.upload_key!==key||row.upload_actor_user_id!==ctx.userId||row.upload_actor_org_id!==ctx.platform.actorOrgId||row.upload_result_revision===null)
        return {status:'unknown' as const};
      return {status:'resolved' as const,result:{id:row._id,status:row.status,scan_status:row.scan_status,owner_revision:row.upload_result_revision}};
    });
  }
  async upload(req: ApiRequest, id: string) {
    this.configured();
    if (req.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream' || req.get('Content-Encoding')) fail(415,'UNSUPPORTED_MEDIA_TYPE','仅支持未压缩原始二进制流');
    const revisionHeader = req.get('X-Owner-Revision');
    if (!revisionHeader || !/^[1-9]\d*$/.test(revisionHeader)) fail(422,'INVALID_REVISION','缺少有效X-Owner-Revision');
    const revision=this.revision(Number(revisionHeader));const key=req.get('Idempotency-Key');
    if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) fail(422,'INVALID_IDEMPOTENCY_KEY','必须提供有效幂等键');
    const token=randomUUID();const storageKey=randomUUID();
    const leaseMs=UPLOAD_LEASE_MS+fileConfig().timeout*3;
    const file=await this.access.run(req,true,async ctx=>{
      const row=await this.file(ctx,id);await this.access.fenceOwner(ctx,row.owner_type,row.owner_version_id);
      if(row.upload_key!==null&&row.upload_key!==key)fail(409,'IDEMPOTENCY_CONFLICT','此资源已绑定其他上传幂等键');
      const actorOrgId=ctx.platform?.actorOrgId ?? ctx.orgId;
      if(row.upload_key!==null&&((row.upload_actor_user_id&&row.upload_actor_user_id!==ctx.userId)||(row.upload_actor_org_id&&row.upload_actor_org_id!==actorOrgId)||(ctx.platform&&!row.upload_actor_user_id)))
        fail(409,'IDEMPOTENCY_CONFLICT','上传幂等键属于另一操作者上下文');
      if(row.status!=='pending')fail(409,'FILE_IMMUTABLE','文件已上传或安排删除，请查询最新状态，不得覆盖');
      if(row.upload_storage_keys.length>=100)fail(409,'UPLOAD_ATTEMPT_LIMIT','上传恢复记录已达上限，请联系管理员安排受控清理');
      const owner=await this.access.owner(ctx,row.owner_type,row.owner_version_id,'edit');
      if(owner.revision!==revision)fail(409,'REVISION_CONFLICT','归属版本已变化，请重新载入');
      const length=req.get('Content-Length');
      if(length&&(!/^\d+$/.test(length)||Number(length)!==row.declared_size))fail(422,'FILE_INTEGRITY_MISMATCH','Content-Length与登记不符');
      const now=new Date();
      const result=await this.files.updateOne({_id:id,status:'pending',$or:[{upload_lease_until:null},{upload_lease_until:{$lte:now}}]},{$set:{upload_key:key,upload_actor_user_id:ctx.userId,upload_actor_org_id:actorOrgId,upload_lease_token:token,upload_lease_until:new Date(now.getTime()+leaseMs),upload_storage_key:storageKey,upload_storage_keys:[...row.upload_storage_keys,storageKey],upload_owner_revision:revision,error_code:null,updated_at:now}},{session:ctx.session});
      if(result.modifiedCount!==1)fail(409,'UPLOAD_IN_PROGRESS','此资源已有上传正在进行');
      return row;
    });
    const timer=setTimeout(()=>req.destroy(new Error('UPLOAD_TIMEOUT')),leaseMs-1000);timer.unref();
    try {
      await assertOperationalAccess(this.database.db);
      try{await assertScanner();}catch{fail(503,'SCANNER_UNAVAILABLE','扫描引擎或有效病毒库不可用，暂停新上传');}
      try{await assertUploadCapacity(file.declared_size);}catch{fail(503,'FILE_STORAGE_CAPACITY','私有存储容量不足或不可用，暂停新上传');}
      const actual=await receive(req,file,storageKey);
      return await this.access.run(req,true,async ctx=>{
        const current=await this.file(ctx,id);const before=await this.access.owner(ctx,current.owner_type,current.owner_version_id,'manage');
        await this.access.fenceOwner(ctx,current.owner_type,current.owner_version_id);
        const owner=await this.access.touchOwner(ctx,current.owner_type,current.owner_version_id,revision);
        const now=new Date();
        const updated=await this.files.updateOne({_id:id,org_id:ctx.orgId,status:'pending',upload_key:key,upload_actor_user_id:ctx.userId,upload_actor_org_id:ctx.platform?.actorOrgId ?? ctx.orgId,upload_lease_token:token,upload_lease_until:{$gt:now}},{$set:{...actual,storage_key:storageKey,status:'quarantined',scan_status:'queued',available_at:now,uploaded_at:now,updated_at:now,upload_lease_token:null,upload_lease_until:null,upload_result_revision:owner.revision}},{session:ctx.session});
        if(updated.modifiedCount!==1)fail(409,'UPLOAD_LEASE_LOST','上传租约已失效，请查询状态后恢复');
        await this.audit(ctx,current,'file.upload',before,owner,'上传附件至安全隔离区');
        return {id,status:'quarantined',scan_status:'queued',owner_revision:owner.revision};
      });
    } catch(error) {
      // Keep the storage key as recovery evidence; reconciliation retains metadata-owned bytes.
      await assertOperationalAccess(this.database.db);
      await this.files.updateOne({_id:id,status:'pending',upload_lease_token:token},{$set:{upload_lease_token:null,upload_lease_until:null,error_code:'UPLOAD_FAILED',updated_at:new Date()}}).catch(()=>undefined);
      if(file.upload_key!==null&&error instanceof HttpException&&error.getStatus()===422)fail(409,'IDEMPOTENCY_CONFLICT','同一上传幂等键的文件内容与登记不一致');
      throw error;
    } finally {clearTimeout(timer);}
  }
  async scheduleDeletion(req:ApiRequest,id:string,input:ScheduleDeletion) {
    if(!input||Object.keys(input).some(k=>!['expected_owner_revision','retention_until','reason'].includes(k))||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>1000||typeof input.retention_until!=='string'||!/^\d{4}-\d\d-\d\dT/.test(input.retention_until)||!Number.isFinite(Date.parse(input.retention_until)))fail(422,'INVALID_DELETION','清理申请参数无效');
    this.revision(input.expected_owner_revision);
    const reservation=await this.access.reserveSafety(req,'file.schedule-deletion',id,input,{action:'file.retention',resourceId:id,resourceType:'file',retentionUntil:new Date(input.retention_until)},async ctx=>{
      if(!ctx.capabilities.includes('file:delete'))fail(403,'FORBIDDEN','未获文件清理能力');
      const file=await this.file(ctx,id);
      await this.access.owner(ctx,file.owner_type,file.owner_version_id,'manage');
    });
    const result=await this.access.run(req,true,async ctx=>{
      if(!ctx.capabilities.includes('file:delete'))fail(403,'FORBIDDEN','未获文件清理能力');
      const file=await this.file(ctx,id);const before=await this.access.owner(ctx,file.owner_type,file.owner_version_id,'manage');
      return this.access.idempotent(ctx,req,'file.schedule-deletion',id,input,async()=>{
        await fenceFileRetentionSubjects(this.database.db,id,ctx.session);
        if(before.revision!==input.expected_owner_revision)fail(409,'REVISION_CONFLICT','归属版本已变化');
        if(file.legal_hold||file.status==='deleting'||file.deleted_at)fail(409,'FILE_DELETE_BLOCKED','文件受保全或已经进入删除');
        if(file.retention_until && file.retention_until.getTime()>Date.parse(input.retention_until))fail(409,'FILE_DELETE_BLOCKED','不可缩短已有保留期限');
        if(file.upload_lease_until&&file.upload_lease_until.getTime()>Date.now()||file.lease_until&&file.lease_until.getTime()>Date.now())fail(409,'FILE_BUSY','文件正在上传或扫描');
        if(await fileReferenced(this.database.db,id,ctx.session))fail(409,'FILE_REFERENCED','文件仍被内容或评估快照引用');
        // Cleanup remains possible for expired/revoked unreferenced files; do not grant byte access.
        const owner=await this.database.db.collection<BaseVersion>(CONTENT_COLLECTIONS[file.owner_type]).findOneAndUpdate({_id:before._id,org_id:ctx.orgId,revision:before.revision,access_revision:before.access_revision},{$inc:{access_revision:1}},{session:ctx.session,returnDocument:'after'});
        if(!owner)fail(409,'REVISION_CONFLICT','归属版本已变化');
        const now=new Date();const until=new Date(input.retention_until);
        await this.files.updateOne({_id:id,legal_hold:false,status:{$ne:'deleting'}},{$set:{retention_until:until,deletion_requested_at:now,deletion_requested_by:ctx.userId,deletion_requested_reason:input.reason.trim(),updated_at:now}},{session:ctx.session});
        await this.audit(ctx,file,'file.schedule-deletion',before,owner,input.reason.trim());
        return {...this.view({...file,retention_until:until,deletion_requested_at:now}),owner_revision:owner.revision};
      });
    });
    if(reservation)await confirmSafetyIntent(this.database.db,reservation);
    return result;
  }
  async download(req: ApiRequest,id: string,res: Response,management=false) {
    return this.deliverAuthorized(req,res,prepare=>this.access.run(req,false,async ctx=>{
        if(management&&!ctx.capabilities.some(capability=>capability==='content:edit'||capability==='content:review'))fail(403,'FORBIDDEN','私有附件预览需要内容编辑或审核职责');
        const row=await this.file(ctx,id);
        if(!management&&row.owner_type==='question')fail(404,'NOT_FOUND','题目附件仅可由本人会话交付');
        const owner=await this.access.owner(ctx,row.owner_type,row.owner_version_id,management?'manage':'read');
        if(!licensed(owner))fail(404,'NOT_FOUND','内容不存在或未获授权');
        if(!management&&!owner.resource_ids.includes(id)){
          const chapter=row.owner_type==='textbook'?await this.database.db.collection('chapters').findOne({org_id:ctx.orgId,textbook_edition_id:owner._id,resource_ids:id},{session:ctx.session,projection:{_id:1}}):null;
          if(!chapter)fail(404,'NOT_FOUND','附件未绑定已发布内容');
        }
        await prepare(row);
        if(management&&row.owner_type==='question'){await touchContentLearningScope(this.database.db,ctx,row.owner_type,owner,false);await recordLearningFeedback(this.database.db,ctx,[owner.question_id]);}
        if(ctx.platform)await this.database.db.collection<AuditEvent>('audit_events').insertOne({_id:newId(),org_id:ctx.orgId,actor_id:ctx.userId,action:'administration.business.file.read',resource_type:'file',resource_id:row._id,owner_type:row.owner_type,owner_version_id:row.owner_version_id,revision_before:owner.revision,revision_after:owner.revision,access_revision_before:owner.access_revision,access_revision_after:owner.access_revision,reason:'跨组织私有附件读取',request_id:ctx.requestId,created_at:new Date(),actor_org_id:ctx.platform.actorOrgId,target_org_id:ctx.orgId,grant_ids:ctx.platform.grantIds,grant_revision:ctx.platform.grantRevision},{session:ctx.session});
        return row;
    }));
  }
  /** Preflight inside authorization's transaction, then stream the same descriptor after commit. */
  async deliverAuthorized(req:ApiRequest,res:Response,authorize:(prepare:(file:FileResource)=>Promise<void>)=>Promise<FileResource>):Promise<void> {
    if(storageDriver()==="s3") {
      const checkpoint=Symbol("delivery-authorized");let initial:FileResource|undefined;
      try {await authorize(async row=>{initial=row;throw checkpoint;});}catch(error){if(error!==checkpoint)throw error;}
      if(!initial)throw Error("FILE_DELIVERY_NOT_PREPARED");
      const abort=new AbortController();const canceled=()=>abort.abort();req.once("aborted",canceled);res.once("close",canceled);let prepared:PreparedDelivery|undefined;
      try {
      prepared=await this.prepareDelivery(req,initial,res,abort.signal);let verified=false;
      try {
        const current=await authorize(async row=>{
          verified=true;
          if(row._id!==initial!._id||row.org_id!==initial!.org_id||row.storage_key!==initial!.storage_key||row.checksum!==initial!.checksum||row.size!==initial!.size||row.status!=="ready"||row.scan_status!=="clean"||row.deleted_at||row.deletion_requested_at)fail(503,"FILE_UNAVAILABLE","文件状态已变化，请重新载入");
        });
        if(!verified)throw Error("FILE_DELIVERY_NOT_PREPARED");
        if(abort.signal.aborted)throw Error("STORAGE_REQUEST_CANCELED");
        await this.streamDelivery(req,current,res,prepared);
      }finally{if(prepared)await prepared.handle.close();}
      }finally{req.off("aborted",canceled);res.off("close",canceled);}
      return;
    }
    let prepared:PreparedDelivery|undefined;
    let preparedFile:FileResource|undefined;
    try {
      const file=await authorize(async row=>{
        // Mongo may retry the entire transaction. Each attempt owns one descriptor.
        if(prepared){await prepared.handle.close();prepared=undefined;}
        prepared=await this.prepareDelivery(req,row,res);
        preparedFile=row;
      });
      if(!prepared||preparedFile!==file)throw new Error('FILE_DELIVERY_NOT_PREPARED');
      await this.streamDelivery(req,file,res,prepared);
    } finally {if(prepared)await prepared.handle.close();}
  }
  private async prepareDelivery(req:ApiRequest,file:FileResource,res:Response,signal?:AbortSignal):Promise<PreparedDelivery> {
    await assertOperationalAccess(this.database.db);
    if(file.status!=='ready'||file.scan_status!=='clean'||file.deleted_at||file.deletion_requested_at||file.size===null||!file.mime||!file.checksum)fail(409,'FILE_NOT_READY','文件不可交付');
    let handle;
    try { handle=await openPrivate('ready',file.storage_key,undefined,signal); } catch { fail(503,'FILE_UNAVAILABLE','文件不可用，等待对账修复'); }
    try {
      const info=await handle.stat();
      if(info.size!==file.size) fail(503,'FILE_UNAVAILABLE','文件完整性异常');
      const hash=createHash('sha256');const buffer=Buffer.allocUnsafe(64*1024);let offset=0;
      while(offset<info.size){const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,info.size-offset),offset);if(bytesRead===0)fail(503,'FILE_UNAVAILABLE','文件完整性异常');hash.update(buffer.subarray(0,bytesRead));offset+=bytesRead;}
      if(hash.digest('hex')!==file.checksum)fail(503,'FILE_UNAVAILABLE','文件完整性异常');
      let start=0;let end=info.size-1;
      const range=req.get('Range');
      if(range){
        const match=/^bytes=(\d*)-(\d*)$/.exec(range);
        const invalid=()=>{res.setHeader('Content-Range',`bytes */${info.size}`);fail(416,'RANGE_NOT_SATISFIABLE','仅支持单个有效字节范围');};
        if(!match||(!match[1]&&!match[2]))invalid();
        if(match![1]){start=Number(match![1]);end=match![2]?Math.min(Number(match![2]),end):end;}else{const suffix=Number(match![2]);if(!Number.isSafeInteger(suffix)||suffix<=0)invalid();start=Math.max(0,info.size-suffix);}
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=info.size)invalid();
      }
      return {handle,start,end,partial:!!range};
    } catch(error) {await handle.close();throw error;}
  }
  /** The caller must authorize this exact file in its transaction before delivery. */
  async deliver(req:ApiRequest,file:FileResource,res:Response) {
    const prepared=await this.prepareDelivery(req,file,res);
    try {await this.streamDelivery(req,file,res,prepared);}finally{await prepared.handle.close();}
  }
  private async streamDelivery(req:ApiRequest,file:FileResource,res:Response,prepared:PreparedDelivery) {
    const {handle,start,end,partial}=prepared;
    try {
      if(partial){res.status(206);res.setHeader('Content-Range',`bytes ${start}-${end}/${file.size}`);
      }
      res.setHeader('Accept-Ranges','bytes');res.setHeader('Content-Length',end-start+1);
      res.setHeader('Content-Type',file.mime!);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'");
      res.setHeader('Cache-Control','private, no-store');
      res.setHeader('Content-Disposition',`attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.display_name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16))}`);
      // FileHandle owns this fd. destroy() must release the stream without closing it twice.
      const stream=createReadStream('',{fd:handle.fd,start,end,autoClose:false,fs:{read:fsRead,close:(_fd,callback)=>callback(null)}});
      try{await pipeline(stream,res);}finally{stream.destroy();}
    } catch(error) {
      console.warn(JSON.stringify({event:'file.delivery.failed',request_id:req.requestId,file_id:file._id}));
      throw error;
    }
  }
}
