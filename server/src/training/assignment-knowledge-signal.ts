import {createHash} from 'node:crypto';
import type {Db} from 'mongodb';
/** Internal assignment invalidation only. Does not admit standalone indexing worker writes. */
export async function signalAssignmentKnowledge(business:Db,journal:Db,orgId:string,courseId:string,key:string){
  const id=createHash('sha256').update(JSON.stringify([orgId,courseId,key])).digest('hex');
  const signals=journal.collection('training_standalone_knowledge_signals');
  const outbox=business.collection<{_id:string;[key:string]:any}>('knowledge_outbox');
  const filter={org_id:orgId,kind:'course',owner_id:courseId};
  let signal=await signals.findOne({identity:id});
  if(!signal){
    const existing=await outbox.findOne(filter);
    const base=existing?.generation??0;
    if(!Number.isSafeInteger(base)||base<0)throw Error('KNOWLEDGE_SIGNAL_INVALID');
    try{await signals.insertOne({identity:id,orgId,courseId,base});}catch(e){if((e as {code?:number}).code!==11000)throw e;}
    signal=await signals.findOne({identity:id});
  }
  if(!signal||signal.orgId!==orgId||signal.courseId!==courseId||!Number.isSafeInteger(signal.base)||signal.base<0)throw Error('KNOWLEDGE_SIGNAL_CONFLICT');
  const now=new Date();
  const row={_id:createHash('sha256').update(JSON.stringify(['knowledge-source',orgId,courseId])).digest('hex').slice(0,24),...filter,created_at:now,access_revision:0,status:'pending',lease_token:null,lease_until:null,error_code:'',updated_at:now,generation:1};
  const existing=await outbox.findOne(filter);
  if(!existing){
    if(signal.base!==0)throw Error('KNOWLEDGE_SIGNAL_SOURCE_MISSING');
    try{await outbox.insertOne(row);}catch(e){if((e as {code?:number}).code!==11000)throw e;}
  }else if(existing.generation===signal.base){
    await outbox.updateOne({...filter,generation:signal.base},{$set:{status:'pending',lease_token:null,lease_until:null,error_code:'',updated_at:now},$inc:{generation:1}});
  }
  const current=await outbox.findOne(filter);
  if(!current||!Number.isSafeInteger(current.generation)||current.generation<=signal.base)throw Error('KNOWLEDGE_SIGNAL_CONFLICT');
}
export async function initializeAssignmentKnowledgeSignals(db:Db){
  const name='training_standalone_knowledge_signals';
 const validator=assignmentSignalValidator();
  if(!(await db.listCollections({name},{nameOnly:true}).hasNext()))try{await db.createCollection(name,{validator,validationLevel:'strict',validationAction:'error'});}catch(e){if((e as {code?:number}).code!==48)throw e;}
  const info=await db.listCollections({name}).next();const {isDeepStrictEqual}=await import('node:util');
  if(!info||!('options' in info)||!isDeepStrictEqual(info.options?.validator,validator)||info.options?.validationLevel!=='strict'||info.options?.validationAction!=='error')throw Error('KNOWLEDGE_SIGNAL_SCHEMA_MISMATCH');
  await db.collection(name).createIndex({identity:1},{unique:true});
}
export function assignmentSignalValidator(){
  const properties={_id:{bsonType:'objectId'},identity:{bsonType:'string',pattern:'^[0-9a-f]{64}$'},orgId:{bsonType:'string',pattern:'^[0-9a-f]{24}$'},courseId:{bsonType:'string',pattern:'^[0-9a-f]{24}$'},base:{bsonType:['int','long','double'],minimum:0,multipleOf:1,maximum:Number.MAX_SAFE_INTEGER}};
  const validator={$jsonSchema:{bsonType:'object',additionalProperties:false,required:Object.keys(properties),properties}};
 return validator;
}
