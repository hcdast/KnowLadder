import { newId } from "../database/object-id";
import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Document } from 'mongodb';
import { Database } from '../database/database';
import { ApiRequest, fail } from '../errors';
import { ContentAccess, ContentContext } from './access';
import { BaseVersion, ChapterRecord, ContentKind, CONTENT_COLLECTIONS, QuestionVersion, TextbookVersion, FileResource, licensed } from './contracts';
import { object, text, id, ids, integer, license, dto, Input, canonical, scoringRule, knowledgeWeights, validateQuestion, safeVersion, studentEdition, studentChapter } from './dto';
import { recordLearningFeedback, touchContentLearningScope } from '../learning/tracking';
import { confirmSafetyIntent } from '../operations/ledger';
import { enqueueKnowledge } from '../training/knowledge-events';
const questionKeys=['title','subject_id','question_type','prompt','options','answer','explanation','knowledge_point_ids','difficulty','license','resource_ids','scoring_rule','knowledge_weights','difficulty_basis'];
@Injectable()
export class ContentService {
  constructor(readonly database:Database,readonly access:ContentAccess){}
  private collection(kind:ContentKind){return this.database.db.collection<BaseVersion>(CONTENT_COLLECTIONS[kind]);}
  private async audit(ctx:ContentContext,kind:ContentKind,resource:string,action:string,reason='',before?:BaseVersion){
    const proofCapability = action === 'retire' ? 'content:retire' : action === 'revoke-access' ? 'content:revoke'
      : action === 'return' || action === 'publish' ? 'content:review' : 'content:edit';
    const proof = ctx.platform?.grants.find(grant => grant.capability === proofCapability);
    if(ctx.platform && !proof) fail(403,'FORBIDDEN','操作授权依据无效');
    const after=await this.collection(kind).findOne({_id:resource,org_id:ctx.orgId},{session:ctx.session});
    if(kind==='textbook')await enqueueKnowledge(this.database.db,ctx,'textbook',resource);
    if(after)await touchContentLearningScope(this.database.db,ctx,kind,after,true);
    if(before&&kind==='question'&&before.subject_id!==after?.subject_id)await touchContentLearningScope(this.database.db,ctx,kind,before,true);
    await this.database.db.collection('audit_events').insertOne({_id:newId(),actor_id:ctx.userId,org_id:ctx.orgId,...(ctx.platform?{actor_org_id:ctx.platform.actorOrgId,target_org_id:ctx.orgId,grant_id:proof!.id,grant_ids:ctx.platform.grantIds,grant_revision:proof!.revision}:{}),action:`content.${kind}.${action}`,resource_type:kind,resource_id:resource,owner_type:kind,owner_version_id:resource,revision_before:before?.revision??null,revision_after:after?.revision??null,access_revision_before:before?.access_revision??null,access_revision_after:after?.access_revision??null,reason:reason.trim()||`内容操作：${action}`,request_id:ctx.requestId,created_at:new Date()} as never,{session:ctx.session});
  }
  private async catalogue(ctx:ContentContext,collection:string,key:string){const value=await this.database.db.collection<Document & {_id:string}>(collection).findOne({_id:key},{session:ctx.session});if(!value)fail(422,'CATALOGUE_INVALID','目录项不存在');return value;}
  private async knowledge(ctx:ContentContext,values:string[],subject:string){
    const points=await this.database.db.collection('knowledge_points').find({_id:{$in:values} as never},{session:ctx.session}).toArray();
    if(points.length!==values.length)fail(422,'CATALOGUE_INVALID','知识点不存在');
    if(points.some(point=>point.subject_id!==subject))fail(422,'SUBJECT_MISMATCH','知识点不属于当前学科');
  }
  private base(ctx:ContentContext,title:string,source:string|null):BaseVersion {const now=new Date();return {_id:newId(),org_id:ctx.orgId,title,status:'draft',revision:1,access_revision:0,access_revoked_at:null,access_revoked_by:null,access_revoked_reason:null,retired_at:null,retired_by:null,retired_reason:null,created_by:ctx.userId,contributors:[ctx.userId],created_at:now,updated_at:now,submitted_by:null,submitted_at:null,published_by:null,published_at:null,source_version_id:source,license:{source:'',granted:false,expires_at:null},resource_ids:[],notes:''};}
  private async resources(ctx:ContentContext,kind:ContentKind,owner:string,values:string[],ready=false){
    const unique=[...new Set(values)];
    const files=await this.database.db.collection<FileResource>('file_resources').find({_id:{$in:unique},org_id:ctx.orgId,owner_type:kind,owner_version_id:owner},{session:ctx.session}).toArray();
    if(files.length!==unique.length)fail(422,'RESOURCE_OWNER_MISMATCH','附件不属于当前版本');
    if(files.some(f=>f.status==='deleting'||f.deleted_at!==null||f.deletion_requested_at!==null))fail(409,'RESOURCE_DELETING','附件已安排清理');
    if(ready&&files.some(f=>f.status!=='ready'||f.scan_status!=='clean'))fail(409,'RESOURCE_NOT_READY','附件尚未通过安全扫描');
  }
  private questionFields(body:Input):Partial<QuestionVersion>{const out:Partial<QuestionVersion>={};for(const key of questionKeys){if(!(key in body))continue;const value=body[key];switch(key){case 'title':out.title=text(value,key);break;case 'subject_id':out.subject_id=id(value,key);break;case 'question_type':if(!['single','multiple','numeric'].includes(value as string))fail(422,'VALIDATION_ERROR','题型无效');out.question_type=value as QuestionVersion['question_type'];break;case 'prompt':out.prompt=text(value,key,20000,true);break;case 'answer':out.answer=text(value,key,2000,true);break;case 'explanation':out.explanation=text(value,key,20000,true);break;case 'difficulty':if(!['基础','提升','挑战'].includes(value as string))fail(422,'VALIDATION_ERROR','难度无效');out.difficulty=value as QuestionVersion['difficulty'];break;case 'knowledge_point_ids':out.knowledge_point_ids=ids(value,key,100);break;case 'resource_ids':out.resource_ids=ids(value,key);break;case 'license':out.license=license(value);break;case 'options':if(!Array.isArray(value)||value.length>12)fail(422,'VALIDATION_ERROR','选项数量无效');out.options=value.map(item=>{const option=object(item,['id','text']);const key=text(option.id,'选项id',32);if(!/^[A-Za-z0-9_-]+$/.test(key))fail(422,'VALIDATION_ERROR','选项id无效');return {id:key,text:text(option.text,'选项',2000,true)};});if(new Set(out.options.map(o=>o.id)).size!==out.options.length)fail(422,'VALIDATION_ERROR','选项id重复');}}
    if('scoring_rule' in body)out.scoring_rule=scoringRule(body.scoring_rule);
    if('knowledge_weights' in body)out.knowledge_weights=knowledgeWeights(body.knowledge_weights);
    if('difficulty_basis' in body)out.difficulty_basis=text(body.difficulty_basis,'difficulty_basis',2000,true);
    return out;
  }
  private async complete(ctx:ContentContext,kind:ContentKind,version:BaseVersion){
    if(!licensed(version))fail(422,'LICENSE_INVALID','须确认有效授权来源及截止时间');
    const resourceIds=[...version.resource_ids];
    if(kind==='question'){const q=version as QuestionVersion;validateQuestion(q);await this.catalogue(ctx,'subjects',q.subject_id);await this.knowledge(ctx,q.knowledge_point_ids,q.subject_id);}
    else {
      const root=await this.database.db.collection<Document & {_id:string}>('textbooks').findOne({_id:version.textbook_id,org_id:ctx.orgId},{session:ctx.session});
      if(!root)fail(422,'TEXTBOOK_INCOMPLETE','教材身份不存在');
      await this.catalogue(ctx,'education_stages',root.stage_id);await this.catalogue(ctx,'subjects',root.subject_id);
      const chapters=await this.database.db.collection<ChapterRecord>('chapters').find({org_id:ctx.orgId,textbook_edition_id:version._id},{session:ctx.session}).limit(101).toArray();
      if(!chapters.length||chapters.length>100)fail(422,'TEXTBOOK_INCOMPLETE','教材须有1至100个章节');
      const byId=new Map(chapters.map(ch=>[ch._id,ch]));const positions=new Set<string>();
      for(const ch of chapters){
        if(!ch.knowledge_point_ids.length||(!ch.body.trim()&&!ch.resource_ids.length))fail(422,'TEXTBOOK_INCOMPLETE','每章须有知识点及正文或附件');
        const seen=new Set([ch._id]);let parent=ch.parent_id;
        while(parent!==null){if(seen.has(parent)||!byId.has(parent))fail(422,'CHAPTER_TREE_INVALID','章节父节点缺失或成环');seen.add(parent);parent=byId.get(parent)!.parent_id;}
        const position=`${ch.parent_id}:${ch.position}`;if(positions.has(position))fail(422,'CHAPTER_TREE_INVALID','同级章节顺序重复');positions.add(position);
        resourceIds.push(...ch.resource_ids);
      }
      await this.knowledge(ctx,[...new Set(chapters.flatMap(ch=>ch.knowledge_point_ids))],root.subject_id);
    }
    await this.resources(ctx,kind,version._id,resourceIds,true);
  }
  async options(req:ApiRequest){return this.access.run(req,false,async ctx=>{this.access.require(ctx,'manage');const result:Record<string,unknown>={};for(const name of ['education_stages','subjects','knowledge_points'])result[name]=(await this.database.db.collection(name).find({},{session:ctx.session}).sort({code:1}).limit(10000).toArray()).map(v=>dto(v));return result;});}
  async create(req:ApiRequest,kind:ContentKind,raw:unknown){const body=object(raw,kind==='textbook'?['title','textbook','textbook_id','edition_code','license','resource_ids','source_edition_id']: [...questionKeys,'question_id','source_version_id']);return this.access.run(req,true,async ctx=>{this.access.require(ctx,'edit');return this.access.idempotent(ctx,req,`${kind}.create`,'new',body,async()=>this.createInside(ctx,kind,body));});}
  /** Internal atomic draft creation; caller must already hold the authenticated transaction. */
  async createQuestionDraft(ctx:ContentContext,raw:unknown){this.access.require(ctx,'edit');if(!ctx.session.inTransaction())fail(503,'TRANSACTION_REQUIRED','题目采纳需要事务');return this.createInside(ctx,'question',object(raw,questionKeys));}
  private async createInside(ctx:ContentContext,kind:ContentKind,body:Input){
    const sourceKey=kind==='textbook'?body.source_edition_id:body.source_version_id;
    const source=sourceKey!==undefined?await this.access.owner(ctx,kind,id(sourceKey),'manage'):null;
    if(source){if(source.status!=='published'||!licensed(source))fail(409,'SOURCE_NOT_PUBLISHED','只能从当前合法已发布版本派生');await this.access.fenceOwner(ctx,kind,source._id);}
    let version:BaseVersion;
    if(kind==='textbook'){
      let textbookId:string;
      if(source){textbookId=(source as TextbookVersion).textbook_id;if(body.textbook!==undefined||(body.textbook_id!==undefined&&body.textbook_id!==textbookId))fail(422,'SOURCE_MISMATCH','派生版本不能更换教材');}
      else if(body.textbook_id!==undefined){
        if(body.textbook!==undefined)fail(422,'VALIDATION_ERROR','textbook与textbook_id二选一');textbookId=id(body.textbook_id);
        const root=await this.database.db.collection<Document & {_id:string}>('textbooks').findOne({_id:textbookId,org_id:ctx.orgId},{session:ctx.session});if(!root)fail(404,'NOT_FOUND','教材不存在');
      }else {const root=object(body.textbook,['title','stage_id','subject_id','source']);const stage=id(root.stage_id);const subject=id(root.subject_id);await this.catalogue(ctx,'education_stages',stage);await this.catalogue(ctx,'subjects',subject);textbookId=newId();const now=new Date();await this.database.db.collection('textbooks').insertOne({_id:textbookId,org_id:ctx.orgId,title:text(root.title,'教材名'),stage_id:stage,subject_id:subject,source:text(root.source,'来源',1000,true),created_at:now,updated_at:now} as never,{session:ctx.session});}
      version={...this.base(ctx,text(body.title??source?.title,'标题'),source?._id??null),textbook_id:textbookId,edition_code:text(body.edition_code,'版本号',64),license:body.license===undefined?(source?.license??{source:'',granted:false,expires_at:null}):license(body.license)};
      if(source){const chapters=await this.database.db.collection<ChapterRecord>('chapters').find({org_id:ctx.orgId,textbook_edition_id:source._id},{session:ctx.session}).toArray();const mapping=new Map(chapters.map(ch=>[ch._id,newId()]));if(chapters.length)await this.database.db.collection<ChapterRecord>('chapters').insertMany(chapters.map(ch=>({...ch,_id:mapping.get(ch._id)!,textbook_edition_id:version._id,parent_id:ch.parent_id?mapping.get(ch.parent_id)!:null,resource_ids:[]})),{session:ctx.session});}
    }else{
      let questionId:string;let versionNo:number;
      if(source||body.question_id!==undefined){questionId=source?(source as QuestionVersion).question_id:id(body.question_id);if(source&&body.question_id!==undefined&&body.question_id!==questionId)fail(422,'SOURCE_MISMATCH','派生版本不能更换题目');const root=await this.database.db.collection<Document & {_id:string;next_version_no:number}>('questions').findOneAndUpdate({_id:questionId,org_id:ctx.orgId},{$inc:{next_version_no:1},$set:{updated_at:new Date()}},{session:ctx.session,returnDocument:'before'});if(!root)fail(404,'NOT_FOUND','题目身份不存在');versionNo=root.next_version_no;}
      else{questionId=newId();versionNo=1;const now=new Date();await this.database.db.collection('questions').insertOne({_id:questionId,org_id:ctx.orgId,next_version_no:2,created_at:now,updated_at:now} as never,{session:ctx.session});}
      const fields=this.questionFields(body);const original=source as QuestionVersion|null;
      version={...this.base(ctx,text(body.title??original?.title,'标题'),source?._id??null),question_id:questionId,version_no:versionNo,subject_id:fields.subject_id??original?.subject_id,question_type:fields.question_type??original?.question_type,prompt:fields.prompt??original?.prompt??'',options:fields.options??original?.options??[],answer:fields.answer??original?.answer??'',explanation:fields.explanation??original?.explanation??'',knowledge_point_ids:fields.knowledge_point_ids??original?.knowledge_point_ids??[],difficulty:fields.difficulty??original?.difficulty,scoring_rule:'scoring_rule' in fields?fields.scoring_rule:original?.scoring_rule??null,knowledge_weights:fields.knowledge_weights??original?.knowledge_weights??[],difficulty_basis:fields.difficulty_basis??original?.difficulty_basis??'',license:fields.license??original?.license??{source:'',granted:false,expires_at:null}};
      if(!version.subject_id||!version.question_type||!version.difficulty)fail(422,'VALIDATION_ERROR','缺少学科、题型或难度');await this.catalogue(ctx,'subjects',version.subject_id);await this.knowledge(ctx,version.knowledge_point_ids,version.subject_id);
    }
    if(body.resource_ids!==undefined&&ids(body.resource_ids,'resource_ids').length)fail(422,'RESOURCE_OWNER_MISMATCH','新版本请先创建后上传附件');
    await this.collection(kind).insertOne(version,{session:ctx.session});await this.audit(ctx,kind,version._id,'create');const result=await this.detailInside(ctx,kind,version._id,'manage');if(source)result.copy_notice='已复制内容并清空全部附件；请在新版本重新上传授权附件';return result;
  }
  private async detailInside(ctx:ContentContext,kind:ContentKind,key:string,mode:'manage'|'read'){
    const version=await this.access.owner(ctx,kind,key,mode);
    if(mode==='read')return studentEdition(version);
    if(version.access_revoked_at!==null)return safeVersion(version);
    if(kind==='question'){await touchContentLearningScope(this.database.db,ctx,kind,version,false);await recordLearningFeedback(this.database.db,ctx,[(version as QuestionVersion).question_id]);}
    const result=dto(version);
    if(kind==='textbook'){const root=await this.database.db.collection<Document & {_id:string}>('textbooks').findOne({_id:version.textbook_id,org_id:ctx.orgId},{session:ctx.session});result.textbook=root?dto(root):null;}
    return result;
  }
  async detail(req:ApiRequest,kind:ContentKind,key:string){return this.access.run(req,false,async ctx=>{
    if(!ctx.capabilities.some(cap=>cap==='content:edit'||cap==='content:review')) {
      const version=await this.access.owner(ctx,kind,key,'manage');
      return safeVersion(version);
    }
    const result=await this.detailInside(ctx,kind,key,'manage');
    if(ctx.platform && kind==='question') await this.access.platform.audit(ctx.platform,'content.question.read','question',key,['content:edit','content:review']);
    return result;
  });}
  async patch(req:ApiRequest,kind:ContentKind,key:string,raw:unknown){
    const body=object(raw,kind==='textbook'?['expected_revision','title','license','resource_ids']:['expected_revision',...questionKeys]);
    return this.access.run(req,true,ctx=>this.access.idempotent(ctx,req,`${kind}.patch`,key,body,async()=>{
      const before=await this.access.owner(ctx,kind,key,'edit');const current=await this.access.touchOwner(ctx,kind,key,integer(body.expected_revision,'expected_revision'));
      const fields:Document=kind==='question'?this.questionFields(body):{};
      if(kind==='textbook'){if('title'in body)fields.title=text(body.title,'title');if('license'in body)fields.license=license(body.license);if('resource_ids'in body)fields.resource_ids=ids(body.resource_ids,'resource_ids');}
      if(fields.resource_ids?.length){if(!licensed({...current,...fields}))fail(422,'LICENSE_INVALID','绑定附件须有效授权');await this.resources(ctx,kind,key,fields.resource_ids,true);}
      if(kind==='question'){const next={...current,...fields} as QuestionVersion;await this.catalogue(ctx,'subjects',next.subject_id);await this.knowledge(ctx,next.knowledge_point_ids,next.subject_id);}
      await this.collection(kind).updateOne({_id:key,org_id:ctx.orgId,revision:current.revision},{$set:fields},{session:ctx.session});
      await this.audit(ctx,kind,key,'edit','',before);return this.detailInside(ctx,kind,key,'manage');
    }));
  }
  async chapters(req:ApiRequest,key:string,raw:unknown){
    const body=object(raw,['expected_revision','chapters']);
    return this.access.run(req,true,ctx=>this.access.idempotent(ctx,req,'textbook.chapters',key,body,()=>this.chaptersInside(ctx,key,body)));
  }
  private async chaptersInside(ctx:ContentContext,key:string,body:Input,importOptions?:{permission:TextbookVersion['license'];fileId:string}){
      const before=await this.access.owner(ctx,'textbook',key,'edit');const version=await this.access.touchOwner(ctx,'textbook',key,integer(body.expected_revision,'expected_revision')) as TextbookVersion;
      if(importOptions){
        if(!licensed({...version,license:importOptions.permission}))fail(422,'LICENSE_INVALID','导入授权无效');
        const resources=[...new Set([...version.resource_ids,importOptions.fileId])];if(resources.length>20)fail(422,'RESOURCE_LIMIT','附件数量超限');
        await this.resources(ctx,'textbook',key,resources,true);
        await this.collection('textbook').updateOne({_id:key,revision:version.revision},{$set:{license:importOptions.permission,resource_ids:resources}},{session:ctx.session});
      }
      if(!Array.isArray(body.chapters)||body.chapters.length>100)fail(422,'CHAPTER_LIMIT','章节最多100个');
      const root=await this.database.db.collection<Document & {_id:string}>('textbooks').findOne({_id:version.textbook_id,org_id:ctx.orgId},{session:ctx.session});if(!root)fail(404,'NOT_FOUND','教材不存在');
      const sourceChapters = body.chapters.map(rawChapter=>object(rawChapter,['id','client_key','parent_id','parent_client_key','position','title','body','knowledge_point_ids','resource_ids']));
      const clientIds=new Map<string,string>();
      for(const ch of sourceChapters){
        if((ch.id!==undefined)===(ch.client_key!==undefined))fail(422,'CHAPTER_TREE_INVALID','已有章节须提供id，新章节须提供client_key');
        if(ch.client_key!==undefined){const clientKey=text(ch.client_key,'client_key',64);if(clientIds.has(clientKey))fail(422,'CHAPTER_TREE_INVALID','client_key重复');clientIds.set(clientKey,newId());}
        if(ch.parent_client_key!==undefined&&ch.parent_id!=null)fail(422,'CHAPTER_TREE_INVALID','父引用不可重复填写');
      }
      const existingIds=sourceChapters.filter(ch=>ch.id!==undefined).map(ch=>id(ch.id));
      const owned=await this.database.db.collection<ChapterRecord>('chapters').countDocuments({org_id:ctx.orgId,textbook_edition_id:key,_id:{$in:existingIds}},{session:ctx.session});
      if(owned!==new Set(existingIds).size)fail(422,'CHAPTER_ID_CONFLICT','已有章节不属于当前教材');
      const chapters:ChapterRecord[]=sourceChapters.map(ch=>{const parent=ch.parent_client_key===undefined?(ch.parent_id==null?null:id(ch.parent_id)):clientIds.get(text(ch.parent_client_key,'parent_client_key',64));if(parent===undefined)fail(422,'CHAPTER_TREE_INVALID','父临时键不存在');return {_id:ch.id===undefined?clientIds.get(ch.client_key as string)!:id(ch.id),org_id:ctx.orgId,textbook_edition_id:key,parent_id:parent,position:integer(ch.position,'position',0,99),title:text(ch.title,'章节名'),body:text(ch.body,'正文',20000,true),knowledge_point_ids:ids(ch.knowledge_point_ids,'knowledge_point_ids',100),resource_ids:ids(ch.resource_ids,'resource_ids')};});
      const byId=new Map(chapters.map(ch=>[ch._id,ch]));if(byId.size!==chapters.length)fail(422,'CHAPTER_TREE_INVALID','章节id重复');const positions=new Set<string>();
      for(const ch of chapters){
        const seen=new Set([ch._id]);let parent=ch.parent_id;while(parent!==null){if(seen.has(parent)||!byId.has(parent))fail(422,'CHAPTER_TREE_INVALID','章节父节点缺失或成环');seen.add(parent);parent=byId.get(parent)!.parent_id;}
        const position=`${ch.parent_id}:${ch.position}`;if(positions.has(position))fail(422,'CHAPTER_TREE_INVALID','同级章节位置重复');positions.add(position);
      }
      await this.knowledge(ctx,[...new Set(chapters.flatMap(ch=>ch.knowledge_point_ids))],root.subject_id);
      const resourceIds=chapters.flatMap(ch=>ch.resource_ids);if(resourceIds.length&&!licensed(version))fail(422,'LICENSE_INVALID','绑定附件须有效授权');await this.resources(ctx,'textbook',key,resourceIds,true);
      const foreign=await this.database.db.collection<ChapterRecord>('chapters').findOne({_id:{$in:[...byId.keys()]},textbook_edition_id:{$ne:key}},{session:ctx.session});if(foreign)fail(422,'CHAPTER_ID_CONFLICT','章节id已被使用');
      await this.database.db.collection<ChapterRecord>('chapters').deleteMany({org_id:ctx.orgId,textbook_edition_id:key},{session:ctx.session});if(chapters.length)await this.database.db.collection<ChapterRecord>('chapters').insertMany(chapters,{session:ctx.session});
      await this.audit(ctx,'textbook',key,'chapters','',before);return {...await this.detailInside(ctx,'textbook',key,'manage'),chapter_id_map:[...clientIds].map(([client_key,id])=>({client_key,id}))};

  }
  async importAuditInside(ctx:ContentContext,key:string,reason:string){await this.audit(ctx,"textbook",key,"edit",reason);}
  async importChaptersInside(ctx:ContentContext,key:string,body:Input,permission:TextbookVersion['license'],fileId:string){
    const result=await this.chaptersInside(ctx,key,body,{permission,fileId});
    const chapters=await this.database.db.collection<ChapterRecord>('chapters').find({org_id:ctx.orgId,textbook_edition_id:key},{session:ctx.session}).toArray();
    const version=await this.collection("textbook").findOne({_id:key,org_id:ctx.orgId},{session:ctx.session});return {revision:version!.revision,chapter_ids:chapters.map(ch=>ch._id)};
  }
  async transition(req:ApiRequest,kind:ContentKind,key:string,action:'submit-review'|'return'|'publish',raw:unknown){
    const body=object(raw,['expected_revision','reason']);const revision=integer(body.expected_revision,'expected_revision');const reason=body.reason===undefined?'':text(body.reason,'reason',1000,true);
    return this.access.run(req,true,async ctx=>{
      const owner=await this.access.owner(ctx,kind,key,'manage');
      if(owner.access_revoked_at!==null)fail(409,'ACCESS_REVOKED','授权已撤销');
      if(action==='submit-review')this.access.require(ctx,'edit');else if(!ctx.capabilities.includes('content:review'))fail(403,'FORBIDDEN','缺少审核权限');
      return this.access.idempotent(ctx,req,`${kind}.${action}`,key,body,async()=>{
        const version=owner;if(version.revision!==revision)fail(409,'REVISION_CONFLICT','内容已变化，请重新载入');
        if(action==='submit-review'){if(version.status!=='draft')fail(409,'INVALID_TRANSITION','仅草稿可送审');}
        else {if(version.created_by===ctx.userId||version.contributors.includes(ctx.userId))fail(403,'SELF_REVIEW_FORBIDDEN','作者及贡献者不能审核本人版本');if(version.status!=='review')fail(409,'INVALID_TRANSITION','当前版本不在审核中');if(action==='return'&&!reason.trim())fail(422,'REASON_REQUIRED','退回必须填写原因');}
        if(action!=='return')await this.complete(ctx,kind,version);
        const now=new Date();const fields:Document={status:action==='submit-review'?'review':action==='return'?'draft':'published',updated_at:now};
        if(action==='submit-review'){fields.submitted_by=ctx.userId;fields.submitted_at=now;}
        if(action==='publish'){fields.published_by=ctx.userId;fields.published_at=now;}
        const filter:Document={_id:key,org_id:ctx.orgId,revision,status:version.status,access_revision:version.access_revision,access_revoked_at:null};
        if(action!=='return'){filter['license.granted']=true;filter.$or=[{'license.expires_at':null},{'license.expires_at':{$gt:new Date().toISOString()}}];}
        const changed=await this.collection(kind).updateOne(filter,{$set:fields,$inc:{revision:1,access_revision:1}},{session:ctx.session});
        if(changed.modifiedCount!==1)fail(409,'REVISION_CONFLICT','内容或授权已变化');
        await this.audit(ctx,kind,key,action,reason,version);return this.detailInside(ctx,kind,key,'manage');
      });
    });
  }
  async stop(req:ApiRequest,kind:ContentKind,key:string,action:'retire'|'revoke-access',raw:unknown){
    const revoke=action==='revoke-access';const field=revoke?'expected_access_revision':'expected_revision';const body=object(raw,[field,'reason']);const revision=integer(body[field],field,revoke?0:1);const reason=text(body.reason,'reason',1000);
    const reservation=revoke?await this.access.reserveSafety(req,`${kind}.${action}`,key,body,{action:'content.revoke',resourceId:key,resourceType:kind,revision:revision+1},async ctx=>{
      if(!ctx.capabilities.includes('content:revoke'))fail(403,'FORBIDDEN','缺少停止使用权限');
      await this.access.owner(ctx,kind,key,'manage');
    }):null;
    const result=await this.access.run(req,true,async ctx=>{
      if(!ctx.capabilities.includes(revoke?'content:revoke':'content:retire'))fail(403,'FORBIDDEN','缺少停止使用权限');
      const version=await this.access.owner(ctx,kind,key,'manage');
      return this.access.idempotent(ctx,req,`${kind}.${action}`,key,body,async()=>{
        if((revoke?version.access_revision:version.revision)!==revision)fail(409,'REVISION_CONFLICT','内容或授权已变化');
        if(revoke?version.access_revoked_at!==null:version.status!=='published')fail(409,'INVALID_TRANSITION','当前状态不允许该操作');
        const now=new Date();const fields:Document=revoke?{access_revoked_at:now,access_revoked_by:ctx.userId,access_revoked_reason:reason}:{status:'retired',retired_at:now,retired_by:ctx.userId,retired_reason:reason};
        fields.updated_at=now;
        const changed=await this.collection(kind).updateOne({_id:key,org_id:ctx.orgId,revision:version.revision,access_revision:version.access_revision,status:version.status},{$set:fields,$inc:revoke?{access_revision:1}:{revision:1,access_revision:1}},{session:ctx.session});
        if(changed.modifiedCount!==1)fail(409,'REVISION_CONFLICT','内容或授权已变化');
        await this.audit(ctx,kind,key,action,reason,version);
        if(ctx.platform || !ctx.capabilities.some(cap=>cap==='content:edit'||cap==='content:review')) {
          const updated=await this.collection(kind).findOne({_id:key,org_id:ctx.orgId},{session:ctx.session});
          if(!updated) fail(409,'REVISION_CONFLICT','内容已变化');
          return safeVersion(updated);
        }
        return this.detailInside(ctx,kind,key,'manage');
      });
    });
    if(reservation)await confirmSafetyIntent(this.database.db,reservation);
    return result;
  }
  private page(query:unknown,scope:string){
    const q=object(query,['status','textbook_id','cursor','limit']);const limit=q.limit===undefined?20:integer(Number(q.limit),'limit',1,50);
    if(q.status!==undefined&&!['draft','review','published','retired'].includes(q.status as string))fail(422,'VALIDATION_ERROR','状态筛选无效');
    const textbookId=q.textbook_id===undefined?undefined:id(q.textbook_id,'textbook_id');const hash=createHash('sha256').update(canonical({scope,status:q.status??null,textbook_id:textbookId??null,limit})).digest('hex');
    let after:string|undefined;
    if(q.cursor!==undefined){try{const decoded=JSON.parse(Buffer.from(text(q.cursor,'cursor',1000),'base64url').toString('utf8'));if(decoded.scope!==hash)throw Error();after=id(decoded.after);}catch{fail(422,'CURSOR_INVALID','分页游标无效');}}
    return {limit,status:q.status as string|undefined,textbookId,after,next:(after:string)=>Buffer.from(JSON.stringify({scope:hash,after})).toString('base64url')};
  }
  async list(req:ApiRequest,kind:ContentKind,query:unknown,student=false){return this.access.run(req,false,async ctx=>{
    this.access.require(ctx,student?'read':'manage');const page=this.page(query,`${ctx.platform?`${ctx.platform.actorOrgId}:`:''}${ctx.orgId}:${ctx.userId}:${kind}:${student}`);const filter:Document={org_id:ctx.orgId};
    if(page.textbookId){if(kind!=='textbook')fail(422,'VALIDATION_ERROR','题目不支持教材筛选');filter.textbook_id=page.textbookId;}
    if(student){if(page.status&&page.status!=='published')fail(422,'VALIDATION_ERROR','学生仅可查询已发布版本');filter.status='published';filter.access_revoked_at=null;filter['license.granted']=true;filter['license.source']={$regex:'\\S'};filter.$or=[{'license.expires_at':null},{'license.expires_at':{$gt:new Date().toISOString()}}];}else if(page.status)filter.status=page.status;
    if(page.after)filter._id={$gt:page.after};const values=await this.collection(kind).find(filter,{session:ctx.session}).sort({_id:1}).limit(page.limit+1).toArray();
    return {items:values.slice(0,page.limit).map(v=>student?studentEdition(v):safeVersion(v)),next_cursor:values.length>page.limit?page.next(values[page.limit-1]._id):null};
  });}
  async chapterPage(req:ApiRequest,key:string,query:unknown,student:boolean){
    const q=object(query,['cursor','limit','edition_revision']);const limit=q.limit===undefined?20:integer(Number(q.limit),'limit',1,50);
    return this.access.run(req,false,async ctx=>{
      if(!student && !ctx.capabilities.some(cap=>cap==='content:edit'||cap==='content:review'))
        fail(403,'FORBIDDEN','此授权不能读取教材正文');
      const edition=await this.access.owner(ctx,'textbook',key,student?'read':'manage');
      if(edition.access_revoked_at!==null)fail(404,'NOT_FOUND','内容不存在或未获授权');
      const revision=q.edition_revision===undefined?edition.revision:integer(Number(q.edition_revision),'edition_revision');
      if(revision!==edition.revision)fail(409,'REVISION_CONFLICT','章树版本已变化，请重新读取');
      const scope=createHash('sha256').update(canonical({...(ctx.platform?{actorOrg:ctx.platform.actorOrgId}:{}),org:ctx.orgId,user:ctx.userId,key,student,revision,limit})).digest('hex');let after:string|undefined;
      if(q.cursor!==undefined){if(q.edition_revision===undefined)fail(422,'REVISION_REQUIRED','续页须携带edition_revision');try{const decoded=JSON.parse(Buffer.from(text(q.cursor,'cursor',1000),'base64url').toString('utf8'));if(decoded.scope!==scope)throw Error();after=id(decoded.after);}catch{fail(422,'CURSOR_INVALID','分页游标无效');}}
      const chapters=await this.database.db.collection<ChapterRecord>('chapters').find({org_id:ctx.orgId,textbook_edition_id:key},{session:ctx.session}).sort({parent_id:1,position:1,_id:1}).limit(101).toArray();
      if(chapters.length>100)fail(409,'CHAPTER_LIMIT','章树超出安全范围');
      const index=after?chapters.findIndex(ch=>ch._id===after):-1;if(after&&index<0)fail(422,'CURSOR_INVALID','分页游标无效');const rows=chapters.slice(index+1,index+1+limit);
      return {items:rows.map(ch=>student?studentChapter(ch,revision):dto(ch)),edition_revision:revision,next_cursor:index+1+limit<chapters.length?Buffer.from(JSON.stringify({scope,after:rows[rows.length-1]._id})).toString('base64url'):null};
    });
  }
  async studentChapter(req:ApiRequest,key:string){return this.access.run(req,false,async ctx=>{const chapter=await this.database.db.collection<ChapterRecord>('chapters').findOne({_id:id(key),org_id:ctx.orgId},{session:ctx.session});if(!chapter)fail(404,'NOT_FOUND','章节不存在');const edition=await this.access.owner(ctx,'textbook',chapter.textbook_edition_id,'read');return studentChapter(chapter,edition.revision);});}
  async studentKnowledge(req:ApiRequest,key:string){return this.access.run(req,false,async ctx=>{
    this.access.require(ctx,'read');const point=await this.catalogue(ctx,'knowledge_points',id(key));
    const chapters=await this.database.db.collection<ChapterRecord>('chapters').aggregate<ChapterRecord>([{$match:{org_id:ctx.orgId,knowledge_point_ids:key}},{$lookup:{from:CONTENT_COLLECTIONS.textbook,localField:'textbook_edition_id',foreignField:'_id',as:'edition'}},{$unwind:'$edition'},{$match:{'edition.org_id':ctx.orgId,'edition.status':'published','edition.access_revoked_at':null,'edition.license.granted':true,'edition.license.source':{$regex:'\\S'},$or:[{'edition.license.expires_at':null},{'edition.license.expires_at':{$gt:new Date().toISOString()}}]}},{$sort:{_id:1}},{$limit:50}],{session:ctx.session}).toArray();
    if(!chapters.length)fail(404,'NOT_FOUND','知识点没有可读内容');return {id:point._id,code:point.code,name:point.name,subject_id:point.subject_id,chapters:chapters.map(ch=>({id:ch._id,title:ch.title,textbook_edition_id:ch.textbook_edition_id}))};
  });}
  async audits(req:ApiRequest,query:unknown){
    const q=object(query,['resource_type','resource_id','cursor','limit']);if(q.resource_type!=='textbook'&&q.resource_type!=='question')fail(422,'VALIDATION_ERROR','资源类型无效');const kind=q.resource_type;const key=id(q.resource_id);
    return this.access.run(req,false,async ctx=>{
      await this.access.owner(ctx,kind,key,'manage');const page=this.page({...(q.cursor===undefined?{}:{cursor:q.cursor}),...(q.limit===undefined?{}:{limit:q.limit})},`${ctx.platform?`${ctx.platform.actorOrgId}:`:''}${ctx.orgId}:${ctx.userId}:audit:${kind}:${key}`);
      const values=await this.database.db.collection<Document & {_id:string}>('audit_events').find({org_id:ctx.orgId,$or:[{owner_type:kind,owner_version_id:key},{resource_id:key,action:{$regex:`^content\\.${kind}\\.`}}],...(page.after?{_id:{$gt:page.after}}:{})},{session:ctx.session}).sort({_id:1}).limit(page.limit+1).toArray();
      return {items:values.slice(0,page.limit).map(v=>({id:v._id,action:v.action,resource_type:v.resource_type??null,resource_id:v.resource_id,owner_type:v.owner_type??null,owner_version_id:v.owner_version_id??null,revision_before:v.revision_before??null,revision_after:v.revision_after??null,access_revision_before:v.access_revision_before??null,access_revision_after:v.access_revision_after??null,actor_id:v.actor_id,reason:v.reason,request_id:v.request_id,created_at:v.created_at})),next_cursor:values.length>page.limit?page.next(values[page.limit-1]._id):null};
    });
  }
  async safetyReceipt(req:ApiRequest,raw:unknown) {
    const q=object(raw,['key']), key=text(q.key,'key',128);
    if(!/^[A-Za-z0-9_-]{8,128}$/.test(key))fail(422,'VALIDATION_ERROR','幂等查询键无效');
    return this.access.run(req,false,async ctx=>{
      const operations:string[]=[];
      if(ctx.capabilities.includes('content:retire'))operations.push('textbook.retire','question.retire');
      if(ctx.capabilities.includes('content:revoke'))operations.push('textbook.revoke-access','question.revoke-access');
      if(ctx.capabilities.includes('file:delete'))operations.push('file.schedule-deletion');
      if(!operations.length)fail(403,'FORBIDDEN','缺少受控停止或清理能力');
      const rows=await this.database.db.collection<Document & {_id:string}>('content_idempotency')
        .find({org_id:ctx.orgId,user_id:ctx.userId,operation:{$in:operations},key},
          {session:ctx.session,projection:{operation:1,resource_id:1,result:1}}).limit(2).toArray();
      if(rows.length>1)fail(409,'IDEMPOTENCY_AMBIGUOUS','此key对应多个受控操作，请人工核查');
      await this.database.db.collection('audit_events').insertOne({
        _id:newId(),actor_id:ctx.userId,org_id:ctx.orgId,action:'content.safety.receipt.read',
        resource_type:'business_receipt',resource_id:rows[0]?._id??ctx.orgId,owner_type:null,owner_version_id:null,
        revision_before:null,revision_after:null,access_revision_before:null,access_revision_after:null,
        reason:'读取受控操作幂等回执',request_id:ctx.requestId,created_at:new Date(),
      } as never,{session:ctx.session});
      if(!rows.length)return {status:'unknown' as const};
      const result=rows[0].result as Record<string,unknown>;
      return {status:'resolved' as const,result:{
        id:typeof result.id==='string'?result.id:null,
        revision:typeof result.revision==='number'?result.revision:typeof result.owner_revision==='number'?result.owner_revision:null,
        status:typeof result.status==='string'?result.status:null,
      }};
    });
  }
}
