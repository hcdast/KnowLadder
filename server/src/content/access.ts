import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { canonical, safeVersion } from './dto';
import type { ClientSession } from 'mongodb';
import { AuthService } from '../auth.service';
import { Database } from '../database/database';
import { ApiRequest, fail } from '../errors';
import { BaseVersion, ContentKind, CONTENT_COLLECTIONS, licensed, CONTENT_LIMITS } from './contracts';
import { assertOperationalAccess } from '../operations/control';
import { reserveManagedSafetyIntent, safetyOperationId, type SafetyIntent } from '../operations/ledger';
export interface ContentContext { orgId:string; userId:string; capabilities:string[]; session:ClientSession; requestId:string; }
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
@Injectable()
export class ContentAccess {
  constructor(readonly database:Database, readonly auth:AuthService) {}
  async run<T>(req:ApiRequest,write:boolean,work:(ctx:ContentContext)=>Promise<T>):Promise<T> {
    await assertOperationalAccess(this.database.db);
    if(write) this.auth.origin(req);
    const orgId=req.get('X-Org-Id');
    if(!orgId || !uuidPattern.test(orgId)) fail(422,'ORG_REQUIRED','请选择有效组织');
    return this.database.transaction(async session=>{
      const identity=await this.auth.identify(req,true,session);
      if(write) this.auth.csrf(req,identity.session);
      const capabilities=await this.auth.authorize(identity,orgId,'account:read',session);
      return work({orgId,userId:identity.user._id,capabilities,session,requestId:req.requestId});
    }).catch((error:unknown)=>{if(error&&typeof error==='object'&&'code' in error&&error.code===11000)fail(409,'DUPLICATE_CONTENT','版本号或幂等键已存在，请重新载入');throw error;});
  }
  async reserveSafety(req:ApiRequest,operation:string,resourceId:string,payload:unknown,intent:Omit<SafetyIntent,'operationId'>,preflight:(ctx:ContentContext)=>Promise<void>) {
    const key=req.get('Idempotency-Key');
    if(!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) fail(422,'IDEMPOTENCY_KEY_REQUIRED','请提供8至128字符幂等键');
    const operationId=await this.run(req,true,async ctx=>{
      this.require(ctx,'manage');
      await preflight(ctx);
      const existing=await this.database.db.collection('content_idempotency').findOne({org_id:ctx.orgId,user_id:ctx.userId,operation,resource_id:resourceId,key},{session:ctx.session});
      if(existing && existing.request_hash!==createHash('sha256').update(canonical(payload)).digest('hex'))fail(409,'IDEMPOTENCY_CONFLICT','幂等键已用于不同请求');
      return safetyOperationId(canonical([ctx.orgId,ctx.userId,operation,resourceId,key]));
    });
    // External durable pending must precede, and never run inside, the source transaction.
    return reserveManagedSafetyIntent(this.database.db,{...intent,operationId});
  }
  require(ctx:ContentContext,mode:'edit'|'manage'|'read') {
    const allowed=mode==='edit'?ctx.capabilities.includes('content:edit'):ctx.capabilities.some(c=>['content:edit','content:review','content:retire','content:revoke','file:delete'].includes(c)||(mode==='read'&&c==='learning:self'));
    if(!allowed) fail(403,'FORBIDDEN','无权执行内容操作');
  }
  async idempotent<T>(ctx:ContentContext,req:ApiRequest,operation:string,resourceId:string,payload:unknown,work:()=>Promise<T>):Promise<T> {
    this.require(ctx,'manage');
    const [kind,action]=operation.split('.');
    if((kind==='textbook'||kind==='question')&&(action==='patch'||action==='chapters'))this.require(ctx,'edit');
    const key=req.get('Idempotency-Key');
    if(!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) fail(422,'IDEMPOTENCY_KEY_REQUIRED','请提供8至128字符幂等键');
    const filter={org_id:ctx.orgId,user_id:ctx.userId,operation,resource_id:resourceId,key};
    const request_hash=createHash('sha256').update(canonical(payload)).digest('hex');
    const collection=this.database.db.collection('content_idempotency');
    const existing=await collection.findOne(filter,{session:ctx.session});
    if(existing){
      if(existing.request_hash!==request_hash)fail(409,'IDEMPOTENCY_CONFLICT','幂等键已用于不同请求');
      if(kind==='textbook'||kind==='question'){
        const resultId=resourceId==='new'?existing.result?.id:resourceId;
        const owner=await this.owner(ctx,kind,resultId,'manage');
        if(owner.access_revoked_at!==null){if(action==='revoke-access')return existing.result as T;if(action==='retire')return safeVersion(owner) as T;fail(409,'ACCESS_REVOKED','授权已撤销，不能读取历史原文');}
      }
      return existing.result as T;
    }
    const result=await work();
    await collection.insertOne({_id:randomUUID(),...filter,request_hash,result,created_at:new Date()} as never,{session:ctx.session});
    return result;
  }
  async owner(ctx:ContentContext,kind:ContentKind,id:string,mode:'edit'|'manage'|'read'):Promise<BaseVersion> {
    this.require(ctx,mode);
    if(!uuidPattern.test(id)) fail(404,'NOT_FOUND','内容不存在');
    const version=await this.database.db.collection<BaseVersion>(CONTENT_COLLECTIONS[kind]).findOne({_id:id,org_id:ctx.orgId},{session:ctx.session});
    if(!version || (mode==='read'&&(version.status!=='published'||!licensed(version)))) fail(404,'NOT_FOUND','内容不存在或未获授权');
    if(mode==='edit'&&version.status!=='draft') fail(409,'VERSION_IMMUTABLE','仅草稿可以编辑');
    if(mode==='edit'&&version.access_revoked_at!==null) fail(409,'ACCESS_REVOKED','授权已撤销，不能编辑原文');
    return version;
  }
  async touchOwner(ctx:ContentContext,kind:ContentKind,id:string,expectedRevision:number):Promise<BaseVersion> {
    const owner=await this.owner(ctx,kind,id,'edit');
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1) fail(422,'VALIDATION_ERROR','expected_revision无效');
    if(owner.revision!==expectedRevision) fail(409,'REVISION_CONFLICT','内容已变化，请重新载入');
    if(!owner.contributors.includes(ctx.userId)&&owner.contributors.length>=CONTENT_LIMITS.contributors) fail(409,'CONTRIBUTOR_LIMIT','贡献者数量已达上限');
    const result=await this.database.db.collection<BaseVersion>(CONTENT_COLLECTIONS[kind]).findOneAndUpdate({_id:id,org_id:ctx.orgId,status:'draft',revision:expectedRevision,access_revision:owner.access_revision,access_revoked_at:null},{$inc:{revision:1,access_revision:1},$addToSet:{contributors:ctx.userId},$set:{updated_at:new Date()}},{session:ctx.session,returnDocument:'after'});
    if(!result) fail(409,'REVISION_CONFLICT','内容已变化，请重新载入');
    return result;
  }
  async fenceOwner(ctx:ContentContext,kind:ContentKind,id:string):Promise<BaseVersion> {
    const owner=await this.owner(ctx,kind,id,'manage');
    if(!licensed(owner)) fail(404,'NOT_FOUND','内容不存在或未获授权');
    const result=await this.database.db.collection<BaseVersion>(CONTENT_COLLECTIONS[kind]).findOneAndUpdate({_id:id,org_id:ctx.orgId,access_revision:owner.access_revision,access_revoked_at:null,'license.granted':true,$or:[{'license.expires_at':null},{'license.expires_at':{$gt:new Date().toISOString()}}]},{$inc:{access_revision:1}},{session:ctx.session,returnDocument:'after'});
    if(!result) fail(409,'ACCESS_CONFLICT','授权已变化，请重新载入');
    return result;
  }
}
