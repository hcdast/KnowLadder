import type { Db } from 'mongodb';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { canonical } from '../content/dto';
import type { AssignmentRecoveryPlan } from './assignment-recovery';
const NAME='training_assignment_recovery_plans';
/** Internal only: personal identifiers require migration/erasure registration before deployment. */
export class AssignmentRecoveryPlans {
  constructor(private readonly db:Db) {}
  private col(){return this.db.collection(NAME);}
  async initialize(){
 const validator=assignmentPlanValidator();
    if(!(await this.db.listCollections({name:NAME},{nameOnly:true}).hasNext())){
      try{await this.db.createCollection(NAME,{validator,validationLevel:'strict',validationAction:'error'});}catch(e){if((e as {code?:number}).code!==48)throw e;}
    }
    const info=await this.db.listCollections({name:NAME}).next();
    if(!info||!('options' in info)||!isDeepStrictEqual(info.options?.validator,validator)||info.options?.validationLevel!=='strict'||info.options?.validationAction!=='error')throw Error('ASSIGNMENT_PLAN_SCHEMA_MISMATCH');
    await this.col().createIndex({orgId:1,userId:1,key:1},{unique:true});
  }
  async save(plan:AssignmentRecoveryPlan):Promise<AssignmentRecoveryPlan>{
    // Explicit projection prevents extra request fields from becoming recovery payload.
    const payload={orgId:plan.orgId,userId:plan.userId,memberId:plan.memberId,courseId:plan.courseId,classId:plan.classId,subjectId:plan.subjectId,courseRevision:plan.courseRevision,key:plan.key};
    if(Object.values(payload).some(x=>x===undefined)||!(plan.timestamp instanceof Date)||!Number.isFinite(plan.timestamp.getTime()))throw Error('ASSIGNMENT_PLAN_INPUT');
    const hash=createHash('sha256').update(canonical(payload)).digest('hex');
    const filter={orgId:plan.orgId,userId:plan.userId,key:plan.key};
    try{await this.col().updateOne(filter,{$setOnInsert:{...payload,timestamp:plan.timestamp,hash,integrity:createHash('sha256').update(canonical({...payload,timestamp:plan.timestamp.toISOString()})).digest('hex')}},{upsert:true});}catch(e){if((e as {code?:number}).code!==11000)throw e;}
    return this.read(plan.orgId,plan.userId,plan.key,hash);
  }
  async read(orgId:string,userId:string,key:string,expectedHash?:string):Promise<AssignmentRecoveryPlan>{
    if(!/^[0-9a-f]{24}$/.test(orgId)||!/^[0-9a-f]{24}$/.test(userId)||!/^[A-Za-z0-9_-]{8,128}$/.test(key))throw Error('ASSIGNMENT_PLAN_INPUT');
    const row=await this.col().findOne({orgId,userId,key});
    if(!row)throw Error('ASSIGNMENT_PLAN_NOT_FOUND');
    const {_id,hash,timestamp,integrity,...payload}=row;
    if(!(timestamp instanceof Date)||integrity!==createHash('sha256').update(canonical({...payload,timestamp:timestamp.toISOString()})).digest('hex')||hash!==createHash('sha256').update(canonical(payload)).digest('hex')||(expectedHash&&hash!==expectedHash))throw Error('ASSIGNMENT_PLAN_CONFLICT');
    return {...payload,timestamp} as AssignmentRecoveryPlan;
  }
}
export function assignmentPlanValidator(){
    const id={bsonType:'string',pattern:'^[0-9a-f]{24}$'};
    const properties={_id:{bsonType:'objectId'},orgId:id,userId:id,memberId:id,courseId:id,classId:id,subjectId:id,
      courseRevision:{bsonType:['int','long','double'],minimum:1,multipleOf:1,maximum:Number.MAX_SAFE_INTEGER},
      key:{bsonType:'string',minLength:8,maxLength:128,pattern:'^[A-Za-z0-9_-]+$'},timestamp:{bsonType:'date'},hash:{bsonType:'string',pattern:'^[0-9a-f]{64}$'},integrity:{bsonType:'string',pattern:'^[0-9a-f]{64}$'}};
    const validator={$jsonSchema:{bsonType:'object',required:Object.keys(properties),additionalProperties:false,properties}};
 return validator;
}
