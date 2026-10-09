import {isManagedExitProof,type ManagedExitProof} from './managed-writer-process';
import type {Db} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
type Ticket={token:string;generation:number;owner:string};
/** Global admission. Executing writers NEVER expire into automatic takeover. */
export class StandaloneWriterAdmission {
 constructor(private readonly db:Db){}
 private col(){return this.db.collection('training_standalone_writer');}
 async initialize(){
 const validator=writerAdmissionValidator();
  const name='training_standalone_writer';
  if(!(await this.db.listCollections({name},{nameOnly:true}).hasNext()))try{await this.db.createCollection(name,{validator,validationLevel:'strict',validationAction:'error'});}catch(e){if((e as {code?:number}).code!==48)throw e;}
  const info=await this.db.listCollections({name}).next();
  if(!info||!('options' in info)||!isDeepStrictEqual(info.options?.validator,validator)||info.options?.validationLevel!=='strict'||info.options?.validationAction!=='error')throw Error('STANDALONE_WRITER_SCHEMA');
  await this.col().createIndex({key:1},{unique:true});
  await this.col().updateOne({key:'global'},{$setOnInsert:{key:'global',state:'idle',token:'',owner:'',generation:0,until:new Date(0)}},{upsert:true});
 }
 async reserve(owner:string):Promise<Ticket|null>{
  if(!/^[A-Za-z0-9_-]{8,128}$/.test(owner))throw Error('STANDALONE_WRITER_INPUT');
  const token=randomUUID();
  const row=await this.col().findOneAndUpdate({key:'global',$or:[{state:'idle'},{state:'reserved',$expr:{$lte:['$until','$$NOW']}}]},
    [{$set:{state:'reserved',owner,token,generation:{$add:['$generation',1]},until:{$add:['$$NOW',30000]}}}],{returnDocument:'after'});
  return row?{owner,token,generation:row.generation}:null;
 }
 async begin(ticket:Ticket){
  const result=await this.col().updateOne({key:'global',...ticket,state:'reserved',$expr:{$gt:['$until','$$NOW']}},{$set:{state:'executing'}});
  if(result.modifiedCount!==1)throw Error('STANDALONE_WRITER_STALE');
 }
 async complete(ticket:Ticket){
  // Expiry cannot admit anyone else while executing, so only the same owner may finish.
  const result=await this.col().updateOne({key:'global',...ticket,state:'executing'},{$set:{state:'idle',until:new Date(0),token:'',owner:''}});
  if(result.modifiedCount!==1)throw Error('STANDALONE_WRITER_STALE');
 }
 async quarantine(ticket:Ticket){
  const result=await this.col().updateOne({key:'global',...ticket,state:'executing'},{$set:{state:'quarantined'}});
  if(result.modifiedCount!==1)throw Error('STANDALONE_WRITER_STALE');
 }
 async recoverAfterExit(ticket:Ticket,proof:ManagedExitProof,nextOwner?:string):Promise<Ticket>{
  if(!isManagedExitProof(proof,ticket.owner))throw Error('STANDALONE_WRITER_EXIT_PROOF');
  const owner=nextOwner??'recovery-'+randomUUID(),token=randomUUID();
  if(!/^[A-Za-z0-9_-]{8,128}$/.test(owner))throw Error('STANDALONE_WRITER_INPUT');
  const row=await this.col().findOneAndUpdate({key:'global',...ticket,state:{$in:['executing','quarantined']}},
   [{$set:{state:'reserved',owner,token,generation:{$add:['$generation',1]},until:{$add:['$$NOW',30000]}}}],{returnDocument:'after'});
  if(!row)throw Error('STANDALONE_WRITER_STALE');
  return {owner,token,generation:row.generation};
 }
 async assertReadable(){
  if(!(await this.col().findOne({key:'global',state:'idle'})))throw Error('STANDALONE_WRITER_BLOCKED');
 }
}
export function writerAdmissionValidator(){
  const properties={_id:{bsonType:'objectId'},key:{enum:['global']},state:{enum:['idle','reserved','executing','quarantined']},token:{bsonType:'string'},owner:{bsonType:'string'},generation:{bsonType:['int','long','double'],minimum:0,multipleOf:1,maximum:Number.MAX_SAFE_INTEGER},until:{bsonType:'date'}};
  const validator={$jsonSchema:{bsonType:'object',additionalProperties:false,required:Object.keys(properties),properties}};
 return validator;
}
