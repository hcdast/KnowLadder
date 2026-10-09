import {runManagedInvocation} from './managed-invocation';
import {StandaloneWriterAdmission} from './standalone-writer-admission';
import {signalAssignmentKnowledge} from './assignment-knowledge-signal';
import type { Db } from 'mongodb';
import { createHash } from 'node:crypto';
import { canonical } from '../content/dto';
import { isDeepStrictEqual } from 'node:util';
import { AssignmentRecovery, type AssignmentRecoveryPlan } from './assignment-recovery';
import { AssignmentRecoveryPlans } from './assignment-recovery-plan';
import { StandaloneOperation } from './standalone-operation';
type Result={course_id:string;class_id:string;status:'assigned'|'already_assigned'};
/** Deterministic steps; API callers must hold managed global admission and verify current access. */
export class AssignmentRecoveryRunner {
  constructor(private readonly business:Db,private readonly journal:Db) {}
  async runProtected(input:AssignmentRecoveryPlan,owner:string,verify:()=>Promise<void>,knowledgeEnabled=false):Promise<Result>{
    const admission=new StandaloneWriterAdmission(this.journal);
    const ticket=await admission.reserve(owner);
    if(!ticket)throw Error('STANDALONE_WRITER_BLOCKED');
    await admission.begin(ticket);
    try{
      const result=await runManagedInvocation(ticket,()=>this.run(input,verify,knowledgeEnabled));
      await admission.complete(ticket);
      return result;
    }catch(e){
      await admission.quarantine(ticket);
      throw e;
    }
  }
  async run(input:AssignmentRecoveryPlan,verify:()=>Promise<void>, knowledgeEnabled=false, afterStep?:(step:string)=>Promise<void>):Promise<Result>{

    await verify();
    const plans=new AssignmentRecoveryPlans(this.journal),operations=new StandaloneOperation(this.journal);
    const plan=await plans.save(input);
    const scope=createHash('sha256').update(JSON.stringify([plan.orgId,plan.userId,'course.assign',plan.courseId,plan.classId])).digest('hex');
    const state=await operations.prepare(scope,plan.key,{...plan,timestamp:plan.timestamp.toISOString()},knowledgeEnabled?['assignment','audit','knowledge','receipt']:['assignment','audit','receipt']);
    const readReceipt=async()=>{
      await verify();
      const row=await this.business.collection<{_id:string;[key:string]:any}>('training_idempotency').findOne({org_id:plan.orgId,user_id:plan.userId,operation:'course.assign',key:plan.key,resource_id:plan.courseId});
      if(!row||row._id!==AssignmentRecovery.identity(plan,'receipt'))throw Error('ASSIGNMENT_RECEIPT_CONFLICT');
      const result=JSON.parse(row.result_json) as Result;
      if(result.course_id!==plan.courseId||result.class_id!==plan.classId||!['assigned','already_assigned'].includes(result.status)||row.request_hash!==createHash('sha256').update(canonical({class_id:plan.classId})).digest('hex'))throw Error('ASSIGNMENT_RECEIPT_CONFLICT');
      return result;
    };
    if(state.state==='completed')return readReceipt();
    const handle=await operations.claim(scope,plan.key);
    if(!handle)throw Error('ASSIGNMENT_RECOVERY_BUSY');
    const effect=new AssignmentRecovery(this.business);
    try{
      let result:Result;
      // Re-evaluate deterministic association on every recovery, including after acknowledgement.
      await verify();await operations.renew(handle);
      const linked=await effect.ensureAssignment(plan);
      result={course_id:plan.courseId,class_id:plan.classId,status:linked.status};
      const once=async(collection:string,row:{_id:string;[key:string]:any})=>{
        const col=this.business.collection<{_id:string;[key:string]:any}>(collection);
        try{await col.updateOne({_id:row._id},{$setOnInsert:row},{upsert:true});}catch(e){if((e as {code?:number}).code!==11000)throw e;}
        const stored=await col.findOne({_id:row._id});
        if(!isDeepStrictEqual(stored,row))throw Error('ASSIGNMENT_EFFECT_CONFLICT');
      };
      while(true){
        const checkpoint=await operations.checkpoint(handle);if(!checkpoint.next)break;
        await verify();await operations.renew(handle);
        if(checkpoint.next==='audit'&&result.status==='assigned')await once('audit_events',{
          _id:AssignmentRecovery.identity(plan,'audit'),org_id:plan.orgId,actor_id:plan.userId,resource_type:'course',resource_id:plan.courseId,
          owner_type:null,owner_version_id:null,action:'training.course.assign',reason:'课程分配恢复',request_id:(()=>{const h=createHash('sha256').update(JSON.stringify([plan.orgId,plan.userId,plan.key,'audit-request'])).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);})(),created_at:plan.timestamp,
          revision_before:null,revision_after:plan.courseRevision,access_revision_before:null,access_revision_after:null,
        });
        if(checkpoint.next==='knowledge'&&result.status==='assigned')await signalAssignmentKnowledge(this.business,this.journal,plan.orgId,plan.courseId,plan.key);
        if(checkpoint.next==='receipt')await once('training_idempotency',{
          _id:AssignmentRecovery.identity(plan,'receipt'),org_id:plan.orgId,user_id:plan.userId,operation:'course.assign',resource_id:plan.courseId,key:plan.key,
          request_hash:createHash('sha256').update(canonical({class_id:plan.classId})).digest('hex'),result_json:JSON.stringify(result),
          revision:1,created_at:plan.timestamp,updated_at:plan.timestamp,
        });
        await afterStep?.(checkpoint.next);
        await operations.acknowledge(handle,checkpoint.cursor,checkpoint.next);
      }
      await verify();await operations.complete(handle);return readReceipt();
    }catch(e){
      // Failed effects remain gated until this owner's time window expires.
      // A takeover resumes acknowledged steps; effects themselves retain fixed identity.
      throw e;
    }
  }
}