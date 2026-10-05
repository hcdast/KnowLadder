import { newId } from "../database/object-id";
import { HttpException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Document } from 'mongodb';
import { Database } from '../database/database';
import { ApiRequest, fail } from '../errors';
import { AssessmentService } from '../assessment/assessment.service';
import type { AssessmentContext, IdempotencyRecord, QuestionSnapshot } from '../assessment/contracts';
import { id, object } from '../assessment/dto';
import type { BaseVersion } from '../content/contracts';
import { canonical } from '../content/dto';
import { LearningAccess } from './access';
import { deliverLearningFeedback, readLearningView } from './view';
import { DAY_MS, RULE_VERSION, type MasteryRow } from './contracts';
import type { RecommendationCard, RecommendationRow, RecommendationsResponse } from './recommendations.types';

const BUCKET_MS=15*60*1000;
const OPERATION='learning.recommendation.practice';
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
@Injectable()
export class RecommendationsService {
  constructor(readonly database:Database,readonly access:LearningAccess,readonly assessment:AssessmentService){}
  private get db(){return this.database.db;}
  private async context(ctx:AssessmentContext,editionId:string){
    const edition=await this.db.collection<BaseVersion>('textbook_editions').findOne({_id:editionId,org_id:ctx.orgId},{session:ctx.session});
    const root=edition?await this.db.collection<Document & {_id:string;subject_id:string}>('textbooks').findOne({_id:edition.textbook_id,org_id:ctx.orgId},{session:ctx.session}):null;
    if(!edition||!root)fail(404,'NOT_FOUND','教材不存在');
    const view=await readLearningView(this.db,ctx,root.subject_id,false);
    const source=await this.assessment.sources.textbook(ctx,editionId,true);
    if(!source.knowledge_point_ids.length||source.knowledge_point_ids.length>100)fail(409,'CONTENT_UNAVAILABLE','教材知识映射不可用');
    const pointCount=await this.db.collection('knowledge_points').countDocuments({_id:{$in:source.knowledge_point_ids} as never,subject_id:source.subject_id},{session:ctx.session});
    if(pointCount!==source.knowledge_point_ids.length)fail(409,'CONTENT_UNAVAILABLE','教材知识映射不可用');
    const scope=await this.db.collection<Document & {_id:string;catalog_revision:number}>('learning_scope_states').findOne({org_id:ctx.orgId,subject_id:source.subject_id},{session:ctx.session});
    if(!scope)fail(503,'LEARNING_SCOPE_UNAVAILABLE','推荐目录不可用');
    return {edition,source,view,catalog:scope.catalog_revision,now:await this.assessment.access.now(ctx)};
  }
  private async candidates(ctx:AssessmentContext,subject:string,points:string[],difficulty:'基础'|'提升'){
    const rows=await this.db.collection<Document & {_id:string;question_id:string}>('question_versions').find({org_id:ctx.orgId,subject_id:subject,status:'published',knowledge_point_ids:{$in:points,$not:{$elemMatch:{$nin:points}}},difficulty},{session:ctx.session}).sort({question_id:1,_id:1}).limit(5001).maxTimeMS(5000).toArray();
    if(rows.length>5000)fail(503,'CANDIDATE_CAPACITY_EXCEEDED','选题范围过大');
    const identities=[...new Set(rows.map(row=>row.question_id))];
    const states=await this.db.collection<Document & {_id:string;question_id:string}>('learning_question_states').find({org_id:ctx.orgId,user_id:ctx.userId,question_id:{$in:identities},$or:[{first_session_item_id:{$ne:null}},{feedback_seen:true},{legacy_unknown:true}]},{session:ctx.session}).toArray();
    const authors=await this.db.collection('question_versions').aggregate<{question_id:string}>([
      {$match:{org_id:ctx.orgId,question_id:{$in:identities},$or:[{created_by:ctx.userId},{contributors:ctx.userId},{published_by:ctx.userId},{submitted_by:ctx.userId}]}},
      {$group:{_id:'$question_id'}},{$project:{_id:0,question_id:'$_id'}},
    ],{session:ctx.session,maxTimeMS:5000}).toArray();
    const prior=await this.db.collection('session_items').aggregate<{question_id:string}>([
      {$match:{org_id:ctx.orgId,'snapshot.question_id':{$in:identities}}},
      {$lookup:{from:'sessions',localField:'session_id',foreignField:'_id',as:'owner'}},
      {$match:{'owner.org_id':ctx.orgId,'owner.user_id':ctx.userId}},
      {$group:{_id:'$snapshot.question_id'}},{$project:{_id:0,question_id:'$_id'}},
    ],{session:ctx.session,maxTimeMS:5000}).toArray();
    const excluded=new Set([...states,...authors,...prior].map(row=>row.question_id));
    const selected:QuestionSnapshot[]=[];
    for(const row of rows){
      if(excluded.has(row.question_id))continue;
      try{
        const snapshot=await this.assessment.sources.question(ctx,row._id,true);
        await this.assessment.sources.guard(ctx,[row._id],'practice');
        selected.push(snapshot);excluded.add(row.question_id);
        if(selected.length===5)break;
      }catch(error){
        if(!(error instanceof HttpException))throw error;
        const response=error.getResponse();
        const code=typeof response==='object'&&'code' in response?String(response.code):'';
        if(!['CONTENT_UNAVAILABLE','FILE_NOT_READY','QUESTION_EMBARGOED'].includes(code))throw error;
      }
    }
    return selected;
  }
  private async cooling(ctx:AssessmentContext,signature:string,now:Date){
    return !!await this.db.collection<RecommendationRow>('recommendations').findOne({org_id:ctx.orgId,member_id:ctx.memberId,signature,accepted_at:{$gt:new Date(now.getTime()-DAY_MS)}},{session:ctx.session,projection:{_id:1}});
  }
  private dto(row:RecommendationRow):RecommendationCard{
    const reason=row.reason_code==='DIAGNOSTIC'?`该知识范围有${row.independent_question_count}道合格首次题，尚不足5道；建议基础诊断`:row.reason_code==='WEAK_KNOWLEDGE'?`该知识点的练习掌握指标为${row.mastery}%，建议基础巩固`:row.reason_code==='CONSOLIDATION'?`该知识点的练习掌握指标为${row.mastery}%，建议短练习巩固`:'阅读当前教材中与该知识点关联的章节';
    return {id:row._id,kind:row.kind,textbook_edition_id:row.textbook_edition_id,chapter_id:row.chapter_id,knowledge_point_ids:row.knowledge_point_ids,difficulty:row.difficulty,count:row.count,expires_at:row.expires_at.toISOString(),reason_code:row.reason_code,reason,independent_question_count:row.independent_question_count,mastery:row.mastery};
  }
  async list(req:ApiRequest,raw:unknown):Promise<RecommendationsResponse>{
    const q=object(raw,['textbook_edition_id']),editionId=id(q.textbook_edition_id);
    return this.access.run(req,false,async ctx=>{
      const {edition,source,view,catalog,now}=await this.context(ctx,editionId);
      const bucket=Math.floor(now.getTime()/BUCKET_MS);
      const expires=new Date(Math.min((bucket+1)*BUCKET_MS,edition.license.expires_at===null?Infinity:new Date(edition.license.expires_at).getTime(),view.visible_valid_until?.getTime()??Infinity));
      const response:RecommendationsResponse={status:view.status,rule_version:RULE_VERSION,source_watermark:view.source_watermark,catalog_revision:catalog,edition_revision:edition.revision,expires_at:expires.toISOString(),prerequisite_policy:'not_used_v1',graph_revision:null,empty_reason:null,items:[]};
      if(view.status==='updating'||view.status==='unavailable')return response;
      const generation=view.build?.generation??null;
      const requestKey=hash([ctx.orgId,ctx.memberId,editionId,generation,edition.revision,catalog,RULE_VERSION,bucket]);
      const collection=this.db.collection<RecommendationRow>('recommendations');
      let cards=await collection.find({org_id:ctx.orgId,member_id:ctx.memberId,request_key:requestKey},{session:ctx.session}).sort({rank:1}).toArray();
      if(!cards.length){
        const mastery=new Map(view.mastery.map(row=>[row.knowledge_point_id,row]));
        const compare=(a:MasteryRow,b:MasteryRow)=>{const delta=BigInt(a.numerator)*BigInt(b.denominator)-BigInt(b.numerator)*BigInt(a.denominator);return delta<0n?-1:delta>0n?1:a.knowledge_point_id.localeCompare(b.knowledge_point_id);};
        const relevant=source.knowledge_point_ids.map(k=>mastery.get(k)).filter((row):row is MasteryRow=>!!row);
        const weak=relevant.filter(row=>row.classification==='weak').sort(compare);
        const developing=relevant.filter(row=>row.classification==='developing').sort(compare);
        const diagnostic=source.knowledge_point_ids.filter(k=>!mastery.has(k)||mastery.get(k)!.classification==='insufficient_evidence').sort();
        const priorities=[...weak.map(row=>row.knowledge_point_id),...diagnostic,...developing.map(row=>row.knowledge_point_id)];
        for(const point of priorities){
          if(cards.length===3)break;
          const evidence=mastery.get(point),level='基础' as const;
          const signature=hash([editionId,[point],level]);
          const cooling=await this.cooling(ctx,signature,now);
          const candidates=cooling?[]:await this.candidates(ctx,source.subject_id,[point],level);
          const chapter=source.chapters.find(ch=>ch.knowledge_point_ids.includes(point));
          if(candidates.length!==5&&!chapter)continue;
          const practice=candidates.length===5;
          const deadline=await this.assessment.sources.nextCheckAt(ctx,practice?candidates.map(s=>s.question_version_id):[],editionId,null,now);
          const row:RecommendationRow={_id:newId(),org_id:ctx.orgId,created_at:now,updated_at:now,user_id:ctx.userId,member_id:ctx.memberId,subject_id:source.subject_id,textbook_edition_id:editionId,request_key:requestKey,rank:cards.length+1,generation,edition_revision:edition.revision,catalog_revision:catalog,rule_version:RULE_VERSION,expires_at:new Date(Math.min(expires.getTime(),deadline?.getTime()??Infinity)),kind:practice?'practice':'reading',knowledge_point_ids:[point],chapter_id:practice?null:chapter!.id,difficulty:practice?level:null,count:practice?5:0,reason_code:practice?(evidence?.classification==='weak'?'WEAK_KNOWLEDGE':evidence?.classification==='developing'?'CONSOLIDATION':'DIAGNOSTIC'):'RELATED_READING',independent_question_count:evidence?.independent_question_count??0,mastery:evidence?.mastery??null,signature:practice?signature:null,accepted_at:null,created_session_id:null};
          await collection.insertOne(row,{session:ctx.session});cards.push(row);
          if(practice&&chapter&&evidence?.classification==='weak'&&cards.length<3){
            const reading:RecommendationRow={...row,_id:newId(),rank:cards.length+1,kind:'reading',chapter_id:chapter.id,difficulty:null,count:0,reason_code:'RELATED_READING',signature:null};
            await collection.insertOne(reading,{session:ctx.session});cards.push(reading);
          }
        }
      }
      for(const card of cards){
        if(card.accepted_at||card.expires_at<=now)continue;
        if(card.kind==='practice'){
          if(await this.cooling(ctx,card.signature!,now))continue;
          if((await this.candidates(ctx,source.subject_id,card.knowledge_point_ids,card.difficulty!)).length!==5)continue;
        }else if(!source.chapters.some(ch=>ch.id===card.chapter_id&&card.knowledge_point_ids.every(k=>ch.knowledge_point_ids.includes(k))))continue;
        response.items.push(this.dto(card));
      }
      response.empty_reason=response.items.length?null:'NO_ELIGIBLE_CONTENT';
      if(response.items.length)response.expires_at=new Date(Math.min(...response.items.map(card=>new Date(card.expires_at).getTime()))).toISOString();
      const deliveredPoints=new Set(response.items.flatMap(card=>card.knowledge_point_ids));
      const contributingItems=view.evidence.filter(row=>row.qualification==='first'&&row.knowledge_weights.some(weight=>deliveredPoints.has(weight.knowledge_point_id)));
      await deliverLearningFeedback(this.db,ctx,view,new Set(contributingItems.map(row=>row.submission_id)),new Set(contributingItems.map(row=>row.session_item_id)));
      return response;
    });
  }
  async accept(req:ApiRequest,key:string,raw:unknown){
    object(raw,[]);const cardId=id(key);
    return this.access.run(req,true,async ctx=>{
      const receipt=await this.db.collection<IdempotencyRecord>('idempotency_records').findOne({org_id:ctx.orgId,user_id:ctx.userId,operation:OPERATION,resource_id:cardId,key:req.get('Idempotency-Key')},{session:ctx.session});
      if(receipt)await this.assessment.restorePracticeInContext(ctx,id(receipt.result.id));
      return this.assessment.access.idempotent(ctx,req,OPERATION,cardId,{},async()=>{
        const collection=this.db.collection<RecommendationRow>('recommendations');
        const card=await collection.findOne({_id:cardId,org_id:ctx.orgId,member_id:ctx.memberId,user_id:ctx.userId},{session:ctx.session});
        if(!card)fail(404,'NOT_FOUND','推荐不存在');
        if(card.accepted_at)fail(409,'RECOMMENDATION_ALREADY_ACCEPTED','推荐已经受理');
        if(card.kind!=='practice')fail(409,'PRACTICE_SOURCE_UNAVAILABLE','阅读推荐仅供章节导航');
        const {edition,source,view,catalog,now}=await this.context(ctx,card.textbook_edition_id);
        if(card.expires_at<=now||card.rule_version!==RULE_VERSION||card.generation!==(view.build?.generation??null)||card.catalog_revision!==catalog||card.edition_revision!==edition.revision||view.status==='updating'||view.status==='unavailable')fail(409,'RECOMMENDATION_EXPIRED','推荐已过期，请重新获取');
        if(await this.cooling(ctx,card.signature!,now))fail(409,'RECOMMENDATION_ALREADY_ACCEPTED','同类练习已经受理');
        if(card.knowledge_point_ids.some(k=>!source.knowledge_point_ids.includes(k)))fail(409,'RECOMMENDATION_EXPIRED','推荐范围已变化');
        const snapshots=await this.candidates(ctx,source.subject_id,card.knowledge_point_ids,card.difficulty!);
        if(snapshots.length!==5)fail(409,'PRACTICE_SOURCE_UNAVAILABLE','合法练习来源不足');
        const result=await this.assessment.createPracticeFromSnapshots(ctx,snapshots,{textbook_edition_id:card.textbook_edition_id,chapter_id:null,knowledge_point_ids:card.knowledge_point_ids,difficulty:card.difficulty});
        const saved=await collection.updateOne({_id:card._id,org_id:ctx.orgId,member_id:ctx.memberId,accepted_at:null,$expr:{$gt:['$expires_at','$$NOW']}},{$set:{accepted_at:now,created_session_id:result.id,updated_at:now}},{session:ctx.session});
        if(saved.modifiedCount!==1)fail(409,'RECOMMENDATION_EXPIRED','推荐已过期或受理');
        return result;
      });
    });
  }
}
