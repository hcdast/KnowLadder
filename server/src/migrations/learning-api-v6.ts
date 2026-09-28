import { createHash } from "node:crypto";
import { type ClientSession, type Db, type Document, type IndexDescription } from "mongodb";
import { inspectVersion5 } from "./learning-v5";

const uuid = { bsonType:"string", pattern:"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" };
const integer = { bsonType:["int","long","double"], minimum:0, maximum:Number.MAX_SAFE_INTEGER, multipleOf:1 };
const positive = { ...integer, minimum:1 };
const date = { bsonType:"date" };
const bool = { bsonType:"bool" };
const digest = { bsonType:"string", pattern:"^[a-f0-9]{64}$" };
const nullable = (shape:Document) => ({anyOf:[shape,{bsonType:"null"}]});
const object = (properties:Document) => ({bsonType:"object",additionalProperties:false,required:Object.keys(properties),properties});
const position = object({kind:{enum:["text_offset"]},offset_utf16:integer});
const identity = {_id:uuid,org_id:uuid,member_id:uuid};
const unique = (name:string,...fields:string[]):IndexDescription => ({name,key:Object.fromEntries(["org_id","member_id",...fields].map(field=>[field,1])),unique:true});
interface Schema { validator:Document; indexes:IndexDescription[]; }
export const LEARNING_API_V6_SCHEMAS:Record<string,Schema> = {
  recommendations:{
    validator:{$and:[{$jsonSchema:object({...identity,user_id:uuid,subject_id:uuid,textbook_edition_id:uuid,
      created_at:date,updated_at:date,request_key:digest,rank:{...positive,maximum:3},generation:nullable(uuid),
      edition_revision:positive,catalog_revision:integer,rule_version:{bsonType:"string",minLength:1,maxLength:100},expires_at:date,
      kind:{enum:["practice","reading"]},knowledge_point_ids:{bsonType:"array",minItems:1,maxItems:100,uniqueItems:true,items:uuid},
      chapter_id:nullable(uuid),difficulty:{enum:["基础","提升",null]},count:{enum:[0,5]},
      reason_code:{enum:["DIAGNOSTIC","WEAK_KNOWLEDGE","CONSOLIDATION","RELATED_READING"]},independent_question_count:integer,
      mastery:nullable({bsonType:"string",pattern:"^(100|[0-9]{1,2})\\.[0-9]{2}$"}),signature:nullable(digest),accepted_at:nullable(date),created_session_id:nullable(uuid)})},
      {$expr:{$and:[{$lte:["$created_at","$updated_at"]},{$gt:["$expires_at","$created_at"]},
        {$eq:[{$eq:["$accepted_at",null]},{$eq:["$created_session_id",null]}]},
        {$cond:[{$eq:["$kind","practice"]},{$and:[{$eq:["$count",5]},{$ne:["$difficulty",null]},{$ne:["$signature",null]},{$ne:["$reason_code","RELATED_READING"]}]},
          {$and:[{$eq:["$count",0]},{$eq:["$difficulty",null]},{$eq:["$signature",null]},{$ne:["$chapter_id",null]},{$eq:["$accepted_at",null]},{$eq:["$reason_code","RELATED_READING"]}]}]},
      ]}},
    ]},
    indexes:[unique("recommendation_batch_rank","request_key","rank"),
      {name:"recommendation_signature_accepted",key:{org_id:1,member_id:1,signature:1,accepted_at:1}},
      {name:"recommendation_member_subject_expiry",key:{org_id:1,member_id:1,subject_id:1,expires_at:1}}],
  },
  behavior_events:{validator:{$jsonSchema:object({...identity,event_id:uuid,event_type:{enum:["reading_progress_set"]},request_hash:digest,
    chapter_id:uuid,edition_id:uuid,edition_revision:positive,expected_revision:integer,position,completed:bool,server_received_at:date,progress_revision:positive})},
    indexes:[unique("behavior_member_event","event_id"),{name:"behavior_event_cleanup",key:{server_received_at:1,_id:1}}]},
  reading_progress:{validator:{$and:[{$jsonSchema:object({...identity,chapter_id:uuid,edition_id:uuid,edition_revision:positive,
    position:nullable(position),completed:nullable(bool),revision:positive,updated_at:date,cleared_at:nullable(date)})},
    {$expr:{$cond:[{$eq:["$cleared_at",null]},{$and:[{$ne:["$position",null]},{$ne:["$completed",null]}]},
      {$and:[{$eq:["$position",null]},{$eq:["$completed",null]},{$lte:["$cleared_at","$updated_at"]}]}]}}]},
    indexes:[unique("reading_member_chapter","chapter_id"),{name:"reading_member_edition_page",key:{org_id:1,member_id:1,edition_id:1,chapter_id:1}},
      {name:"reading_progress_cleanup",key:{cleared_at:1,updated_at:1,_id:1}}]},
};
export const LEARNING_API_V6_CHECKSUM=createHash("sha256").update(JSON.stringify({version:6,schemas:LEARNING_API_V6_SCHEMAS})).digest("hex");

/** Counts-only inspection. Never writes markers, defaults, reading positions or recommendations. */
export async function inspectVersion6(db:Db,session?:ClientSession) {
  const report=await inspectVersion5(db,session);
  const options={session,maxTimeMS:15000};
  const names=new Set((await db.listCollections({}, {nameOnly:true,maxTimeMS:15000}).toArray()).map(row=>row.name));
  for(const [name,shape] of Object.entries(LEARNING_API_V6_SCHEMAS)) {
    report.collections[name]={documents:await db.collection(name).countDocuments({},options),needs_defaults:0,invalid_types:await db.collection(name).countDocuments({$nor:[shape.validator]},options)};
    report.indexes[name]=names.has(name)?(await db.collection(name).listIndexes({maxTimeMS:15000}).toArray()).map(index=>index.name!):[];
    for(const index of shape.indexes) if(index.unique) {
      const [result]=await db.collection(name).aggregate([{$group:{_id:Object.fromEntries(Object.keys(index.key).map((field,i)=>[`k${i}`,`$${field}`])),n:{$sum:1}}},{$match:{n:{$gt:1}}},{$count:"n"}],options).toArray();
      report.duplicate_keys+=result?.n??0;
    }
    const fields=name==="behavior_events"?shape.validator.$jsonSchema.properties:shape.validator.$and[0].$jsonSchema.properties;
    const editionField=name==="recommendations"?"textbook_edition_id":"edition_id";
    for(const [field,to] of [["org_id","organizations"],["member_id","organization_members"],["user_id","users"],["subject_id","subjects"],[editionField,"textbook_editions"],["chapter_id","chapters"],["created_session_id","sessions"],["knowledge_point_ids","knowledge_points"]]) {
      if(!fields[field]) continue;
      const global=["organizations","users","subjects","knowledge_points"].includes(to);
      const conditions:Document[]=[{$eq:["$_id","$$id"]},...(global?[]:[{$eq:["$org_id","$$org"]}])];
      if(field==="member_id"&&fields.user_id) conditions.push({$eq:["$user_id","$$user"]});
      if(field==="chapter_id") conditions.push({$eq:["$textbook_edition_id","$$edition"]});
      if(field==="created_session_id") conditions.push({$eq:["$member_id","$$member"]},{$eq:["$user_id","$$user"]});
      if(field==="knowledge_point_ids") conditions.push({$eq:["$subject_id","$$subject"]});
      const [result]=await db.collection(name).aggregate([
        {$match:{[field]:{$exists:true,$ne:null}}},...(field==="knowledge_point_ids"?[{$unwind:"$knowledge_point_ids"}]:[]),
        {$lookup:{from:to,let:{id:`$${field}`,org:"$org_id",user:"$user_id",member:"$member_id",edition:`$${editionField}`,subject:"$subject_id"},pipeline:[{$match:{$expr:{$and:conditions}}}],as:"reference"}},
        {$match:{reference:{$size:0}}},{$count:"n"}],options).toArray();
      report.invalid_references+=result?.n??0;
    }
    if(name==="recommendations") {
      const [result]=await db.collection(name).aggregate([
        {$lookup:{from:"textbook_editions",localField:"textbook_edition_id",foreignField:"_id",as:"edition"}},{$unwind:"$edition"},
        {$lookup:{from:"textbooks",localField:"edition.textbook_id",foreignField:"_id",as:"textbook"}},{$unwind:"$textbook"},
        {$match:{$expr:{$ne:["$subject_id","$textbook.subject_id"]}}},{$count:"n"}],options).toArray();
      report.invalid_references+=result?.n??0;
    }
  }
  return {...report,target_version:6,new_collections:[...report.new_collections,...Object.keys(LEARNING_API_V6_SCHEMAS).filter(name=>!names.has(name))]};
}
