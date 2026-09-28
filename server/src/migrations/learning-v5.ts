import { createHash } from "node:crypto";
import { BSON, type ClientSession, type Db, type Document, type IndexDescription } from "mongodb";
import { ASSESSMENT_V4_SCHEMAS, inspectVersion4 } from "./assessment-v4";

const uuid = { bsonType:"string", pattern:"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" };
const text = (max=100) => ({bsonType:"string",minLength:1,maxLength:max});
const integer = {bsonType:["int","long","double"],minimum:0,maximum:Number.MAX_SAFE_INTEGER,multipleOf:1};
const date = {bsonType:"date"};
const bool = {bsonType:"bool"};
const nullable = (shape:Document) => ({anyOf:[shape,{bsonType:"null"}]});
const values = (...choices:string[]) => ({enum:choices});
const object = (properties:Document,required=Object.keys(properties)) => ({bsonType:"object",additionalProperties:false,required,properties});
const digest = {bsonType:"string",pattern:"^[a-f0-9]{64}$"};
const natural = {bsonType:"string",pattern:"^(0|[1-9][0-9]{0,15})$"};
const base = {_id:uuid,org_id:uuid,created_at:date,updated_at:date};
const generated = {generation:uuid,member_id:uuid,subject_id:uuid};
const qualification = values("first","repeated","unknown","exposed");
const counts = object({inputs:integer,evidence:integer,mastery:integer,mistakes:integer,reports:integer});
interface Schema {validator:Document;indexes:IndexDescription[];}
const unique = (name:string,...fields:string[]):IndexDescription => ({name,key:Object.fromEntries(["org_id",...fields].map(field=>[field,1])),unique:true});
const page = (name:string,key:Record<string,1|-1>):IndexDescription => ({name,key});
const schema = (fields:Document,indexes:IndexDescription[]):Schema => ({validator:{$and:[{$jsonSchema:object({...base,...fields})},{$expr:{$lte:["$created_at","$updated_at"]}}]},indexes});
export const LEARNING_V5_SCHEMAS:Record<string,Schema> = {
  learning_tracking_config:{validator:{$jsonSchema:object({_id:{enum:["tracking"]},epoch:uuid,cutover_at:date,tracking_ready:bool})},indexes:[]},
  learning_scope_states:schema({subject_id:uuid,eligibility_revision:integer,catalog_revision:integer,access_fence:integer},[unique("learning_scope_subject","subject_id")]),
  learning_question_states:schema({user_id:uuid,question_id:uuid,epoch:uuid,first_session_item_id:nullable(uuid),first_seen_at:nullable(date),feedback_seen:bool,sealed_submission_id:nullable(uuid),revision:integer,legacy_unknown:bool},[unique("learning_question_user","user_id","question_id")]),
  learning_attempt_contexts:schema({user_id:uuid,member_id:uuid,submission_id:uuid,session_item_id:uuid,question_id:uuid,subject_id:uuid,epoch:uuid,qualification,reason:text(64)},[unique("learning_attempt_item","submission_id","session_item_id"),page("learning_attempt_member",{org_id:1,member_id:1,subject_id:1,_id:1})]),
  learning_projection_heads:schema({member_id:uuid,subject_id:uuid,rule_version:text(),active_generation:nullable(uuid),manifest_digest:nullable(digest),applied_revision:integer,eligibility_revision:integer,catalog_revision:integer,next_check_at:date,rebuild_requested:bool,error_code:nullable(text()),failure_attempts:{...integer,maximum:5},retry_signature:nullable(digest),retry_boundary_at:nullable(date),retry_input_revision:nullable(integer),retry_eligibility_revision:nullable(integer),retry_catalog_revision:nullable(integer)},[unique("learning_head_scope","member_id","subject_id","rule_version"),page("learning_head_due",{next_check_at:1,_id:1})]),
  learning_projection_builds:schema({...generated,rule_version:text(),as_of:date,target_revision:integer,eligibility_revision:integer,catalog_revision:integer,manifest_digest:digest,expected_counts:counts,actual_counts:counts,status:values("building","complete","abandoned"),lease_token:uuid},[unique("learning_build_generation","generation"),page("learning_build_cleanup",{status:1,updated_at:1,_id:1}),page("learning_build_member",{org_id:1,member_id:1,subject_id:1,_id:1})]),
  learning_projection_retirements:schema({...generated,retired_at:date},[unique("learning_retirement_generation","generation"),page("learning_retirement_cleanup",{retired_at:1,_id:1})]),
  learning_projection_inputs:schema({...generated,submission_id:uuid,effective_revision:integer,requested_revision:integer,grading_run_id:uuid,submitted_at:date,semantic_digest:digest,in_7d:bool,in_30d:bool},[unique("learning_input_submission","generation","submission_id")]),
  mastery_evidence:schema({...generated,session_item_id:uuid,question_id:uuid,submission_id:uuid,grading_run_id:uuid,grading_revision:integer,submitted_at:date,qualification,verdict:values("correct","incorrect","unanswered"),knowledge_weights:{bsonType:"array",minItems:1,maxItems:100,items:object({knowledge_point_id:uuid,weight_bps:{...integer,minimum:1,maximum:10000}})}},[unique("mastery_evidence_item","generation","session_item_id")]),
  mastery_snapshots:schema({...generated,knowledge_point_id:uuid,independent_question_count:integer,numerator:natural,denominator:natural,mastery:nullable({bsonType:"string",pattern:"^(100|[0-9]{1,2})\\.[0-9]{2}$"}),classification:values("insufficient_evidence","weak","developing","mastered"),last_evidence_at:date},[unique("mastery_snapshot_knowledge","generation","knowledge_point_id")]),
  mistake_entries:schema({...generated,question_id:uuid,latest_visible_item:uuid,submission_id:uuid,grading_run_id:uuid,status:values("active","resolved"),last_attempt_at:date},[unique("mistake_question","generation","question_id")]),
  report_snapshots:schema({...generated,period:values("7d","30d"),submission_count:integer,attempt_count:integer,correct_count:integer,incorrect_count:integer,unanswered_count:integer,independent_question_count:integer,numerator:natural,denominator:natural},[unique("report_period","generation","period")]),
};
// Optional only for historical rows; production producers initialize these fields on insertion.
LEARNING_V5_SCHEMAS.student_projection_states=structuredClone(ASSESSMENT_V4_SCHEMAS.student_projection_states);
Object.assign(LEARNING_V5_SCHEMAS.student_projection_states.validator.$and[0].$jsonSchema.properties,{publication_fence:integer,lease_owner:nullable(text(200)),lease_token:nullable(uuid),lease_until:nullable(date)});
// structuredClone strips Decimal128's prototype from the immutable score expressions.
LEARNING_V5_SCHEMAS.session_items=BSON.deserialize(BSON.serialize(ASSESSMENT_V4_SCHEMAS.session_items)) as Schema;
LEARNING_V5_SCHEMAS.session_items.validator.$and[0].$jsonSchema.properties.learning_context=object({epoch:uuid,qualification:values("first","repeated","unknown"),reason:text(64)});
LEARNING_V5_SCHEMAS.audit_events=structuredClone(ASSESSMENT_V4_SCHEMAS.audit_events);
LEARNING_V5_SCHEMAS.audit_events.validator.$jsonSchema.properties.resource_type.enum.push("student_projection");
export const LEARNING_V5_CHECKSUM=createHash("sha256").update(JSON.stringify({version:5,schemas:LEARNING_V5_SCHEMAS})).digest("hex");

/** Counts-only, read-only inspection. Historical snapshots and exposure are never synthesized. */
export async function inspectVersion5(db:Db,session?:ClientSession) {
  const report=await inspectVersion4(db,session);
  const options={session,maxTimeMS:15000};
  const names=new Set((await db.listCollections({}, {nameOnly:true,maxTimeMS:15000}).toArray()).map(row=>row.name));
  let duplicate_keys=0;
  for(const [name,shape] of Object.entries(LEARNING_V5_SCHEMAS)) {
    report.collections[name]={documents:await db.collection(name).countDocuments({},options),needs_defaults:0,invalid_types:await db.collection(name).countDocuments({$nor:[shape.validator]},options)};
    report.indexes[name]=names.has(name)?(await db.collection(name).listIndexes({maxTimeMS:15000}).toArray()).map(index=>index.name!):[];
  }
  for(const [name,shape] of Object.entries({...ASSESSMENT_V4_SCHEMAS,...LEARNING_V5_SCHEMAS})) for(const index of shape.indexes) {
    if(!index.unique) continue;
    const [result]=await db.collection(name).aggregate([...(index.partialFilterExpression?[{$match:index.partialFilterExpression}]:[]),{$group:{_id:Object.fromEntries(Object.keys(index.key).map((field,i)=>[`k${i}`,`$${field}`])),n:{$sum:1}}},{$match:{n:{$gt:1}}},{$count:"n"}],options).toArray();
    duplicate_keys+=result?.n??0;
  }
  for(const [name,shape] of Object.entries(LEARNING_V5_SCHEMAS)) {
    if(name==="learning_tracking_config" || name==="session_items" || name==="student_projection_states" || name==="audit_events") continue;
    const fields=shape.validator.$and[0].$jsonSchema.properties;
    for(const [field,to] of [["org_id","organizations"],["member_id","organization_members"],["user_id","users"],["subject_id","subjects"],["question_id","questions"],["submission_id","submissions"],["session_item_id","session_items"],["grading_run_id","grading_runs"]]) {
      if(!fields[field]) continue;
      const global=["organizations","users","subjects"].includes(to);
      const [result]=await db.collection(name).aggregate([{$lookup:{from:to,let:{id:`$${field}`,org:"$org_id",user:"$user_id",member:"$member_id"},pipeline:[{$match:{$expr:{$and:[{$eq:["$_id","$$id"]},...(global?[]:[{$eq:["$org_id","$$org"]}]),...(field==="member_id"&&fields.user_id?[{$eq:["$user_id","$$user"]}]:[]),...(field==="submission_id"?[{$eq:["$member_id","$$member"]}]:[])]}}}],as:"reference"}},{$match:{reference:{$size:0}}},{$count:"n"}],options).toArray();
      report.invalid_references+=result?.n??0;
    }
  }
  let incomplete_evidence=0;
  for await (const run of db.collection("grading_runs").find({status:"completed"},options)) {
    const submission=await db.collection("submissions").findOne({_id:run.submission_id,org_id:run.org_id},options);
    if(!submission) { incomplete_evidence++; continue; }
    const items=await db.collection("session_items").find({org_id:run.org_id,session_id:submission.session_id},options).toArray();
    const results=await db.collection("grading_results").find({org_id:run.org_id,grading_run_id:run._id},options).toArray();
    if(!items.length || results.length!==items.length || new Set(results.map(row=>row.session_item_id)).size!==items.length ||
      results.some(row=>!items.some(item=>item._id===row.session_item_id && String(item.max_score)===String(row.max_score)))) incomplete_evidence++;
    for(const item of items) {
      const weights=item.snapshot?.knowledge_weights;
      if(!Array.isArray(weights) || !weights.length || weights.reduce((sum:number,row:Document)=>sum+Number(row.weight_bps),0)!==10000 ||
        new Set(weights.map((row:Document)=>row.knowledge_point_id)).size!==weights.length ||
        !Array.isArray(item.snapshot?.knowledge_point_ids) || weights.length!==item.snapshot.knowledge_point_ids.length ||
        weights.some((row:Document)=>!item.snapshot.knowledge_point_ids.includes(row.knowledge_point_id))) incomplete_evidence++;
    }
  }
  return {...report,target_version:5,duplicate_keys,incomplete_evidence,new_collections:Object.keys({...ASSESSMENT_V4_SCHEMAS,...LEARNING_V5_SCHEMAS}).filter(name=>!names.has(name)),history:{users:await db.collection("users").countDocuments({},options),questions:await db.collection("questions").countDocuments({},options),untracked_items:await db.collection("session_items").countDocuments({learning_context:{$exists:false}},options)}};
}
