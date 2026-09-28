import { createHash } from "node:crypto";
import { Decimal128, type ClientSession, type Db, type Document, type IndexDescription } from "mongodb";
import { CONTENT_V3_SCHEMAS, inspectVersion3, type MigrationImpact } from "./content-v3";

const uuid = { bsonType:"string", pattern:"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" };
const text = (max=1000, min=1) => ({bsonType:"string",minLength:min,maxLength:max});
const integer = (min=0,max=Number.MAX_SAFE_INTEGER) => ({bsonType:["int","long","double"],minimum:min,maximum:max,multipleOf:1});
const nullable = (shape:Document) => ({anyOf:[shape,{bsonType:"null"}]});
const date = {bsonType:"date"};
const values = (...enumValues:unknown[]) => ({enum:enumValues});
const array = (items:Document,max:number,min=0,unique=false) => ({bsonType:"array",items,maxItems:max,minItems:min,uniqueItems:unique});
const object = (properties:Document,required=Object.keys(properties)) => ({bsonType:"object",additionalProperties:false,required,properties});
const ids = (max=100,min=0) => array(uuid,max,min,true);
const digest = {bsonType:"string",pattern:"^[a-f0-9]{64}$"};
const score = {bsonType:"decimal",minimum:0,maximum:5000};
const itemScore = {...score,exclusiveMinimum:true,maximum:100};
const exactScore = (field:string) => ({$eq:[{$mod:[`$${field}`,Decimal128.fromString("0.01")]},0]});
const grading = values("pending","running","needs_review","completed","failed");
const snapshot = object({question_version_id:uuid,question_id:uuid,subject_id:uuid,title:text(200),question_type:values("single","multiple","numeric"),
  prompt:text(20000),options:array(object({id:text(64),text:text(2000)}),12),answer:text(2000),explanation:text(20000,0),
  scoring_rule:object({version:values(1),strategy:values("single_exact","multiple_exact_set","numeric_exact_decimal"),max_score:{bsonType:"string",pattern:"^(?:(?:[1-9][0-9]?)(?:\\.[0-9]{1,2})?|0\\.(?:0[1-9]|[1-9][0-9]?)|100(?:\\.0{1,2})?)$"}}),
  knowledge_point_ids:ids(100,1),knowledge_weights:array(object({knowledge_point_id:uuid,weight_bps:integer(1,10000)}),100,1),
  difficulty:values("基础","提升","挑战"),difficulty_basis:text(2000),resource_ids:ids(20),created_by:uuid,contributors:ids(100),published_by:nullable(uuid),display_digest:digest});
interface Schema {validator:Document;indexes:IndexDescription[];}
const base = {_id:uuid,org_id:uuid,created_at:date,updated_at:date};
function schema(fields:Document,indexes:IndexDescription[],expressions:Document[]=[]):Schema {
  return {validator:{$and:[{$jsonSchema:object({...base,...fields})},{$expr:{$and:[{$lte:["$created_at","$updated_at"]},...expressions]}}]},indexes};
}
function unique(name:string,...fields:string[]):IndexDescription {return {key:Object.fromEntries(["org_id",...fields].map(field=>[field,1])),name,unique:true};}
function page(name:string,key:Record<string,1|-1>):IndexDescription {return {name,key};}
export const ASSESSMENT_V4_SCHEMAS:Record<string,Schema> = {
  quizzes:schema({title:text(200),subject_id:uuid,status:values("draft","published","closed","archived"),revision:integer(1),created_by:uuid,contributors:ids(100),published_by:nullable(uuid),published_at:nullable(date),opens_at:date,closes_at:date,release_at:date,duration_seconds:integer(60,7200),max_attempts:integer(1,3),published_paper_id:nullable(uuid),visibility_revision:integer()},[
    page("quizzes_org_page",{org_id:1,status:1,_id:1}),page("quizzes_creator_page",{org_id:1,created_by:1,_id:1}),page("quizzes_visibility_due",{status:1,release_at:1,_id:1})], [{$lt:["$opens_at","$closes_at"]},{$lte:["$closes_at","$release_at"]}]),
  papers:schema({quiz_id:uuid,revision:integer(1),status:values("draft","frozen")},[unique("papers_quiz_revision","quiz_id","revision")]),
  paper_items:schema({paper_id:uuid,position:integer(0,49),snapshot,max_score:itemScore},[unique("paper_items_position","paper_id","position"),unique("paper_items_question","paper_id","snapshot.question_id")],[exactScore("max_score")]),
  quiz_audiences:schema({quiz_id:uuid,member_id:uuid},[unique("quiz_audiences_member","quiz_id","member_id"),page("quiz_audiences_member_page",{org_id:1,member_id:1,quiz_id:1})]),
  attempt_counters:schema({quiz_id:uuid,member_id:uuid,allocated:integer(0,3),revision:integer(1)},[unique("attempt_counters_member","quiz_id","member_id")]),
  sessions:schema({user_id:uuid,member_id:uuid,mode:values("practice","quiz"),quiz_id:nullable(uuid),paper_id:nullable(uuid),textbook_edition_id:nullable(uuid),chapter_id:nullable(uuid),knowledge_point_ids:ids(),difficulty:nullable(values("基础","提升","挑战")),status:values("in_progress","submitted","expired","cancelled"),revision:integer(1),started_at:date,deadline_at:nullable(date),submitted_at:nullable(date),submission_id:nullable(uuid),item_count:integer(1,50)},[
    {...unique("sessions_active_quiz","quiz_id","member_id"),partialFilterExpression:{mode:"quiz",status:"in_progress"}},
    page("sessions_member_page",{org_id:1,member_id:1,mode:1,status:1,_id:1}),page("sessions_deadline_due",{status:1,mode:1,deadline_at:1,_id:1})]),
  session_items:schema({session_id:uuid,position:integer(0,49),snapshot,max_score:itemScore},[unique("session_items_position","session_id","position"),unique("session_items_question","session_id","snapshot.question_id")],[exactScore("max_score")]),
  answers:schema({session_id:uuid,session_item_id:uuid,answer_schema_version:values(1),answer:{anyOf:[{bsonType:"null"},object({selected_option_ids:array(text(64),12,0,true)}),object({value:text(100)})]},saved_at:date},[unique("answers_session_item","session_id","session_item_id")]),
  submissions:schema({session_id:uuid,user_id:uuid,member_id:uuid,mode:values("practice","quiz"),quiz_id:nullable(uuid),reason:values("manual","deadline"),submitted_at:date,answers_hash:digest,grading_status:grading,revision:integer(1),effective_grading_revision:nullable(integer(1)),requested_grading_revision:integer(1),total_score:nullable(score),max_score:{...score,exclusiveMinimum:true},error_code:nullable(text(100)),visibility_revision:integer(),visibility_fingerprint:nullable(digest)},[
    unique("submissions_session","session_id"),page("submissions_member_page",{org_id:1,member_id:1,_id:1}),page("submissions_quiz_page",{org_id:1,quiz_id:1,_id:1}),page("submissions_grading",{grading_status:1,_id:1})],[exactScore("max_score"),{$or:[{$eq:["$total_score",null]},{$and:[exactScore("total_score"),{$lte:["$total_score","$max_score"]}]}]}]),
  grading_runs:schema({submission_id:uuid,revision:integer(1),status:grading,reason:text(1000),requested_by:text(128),scoring_code_version:text(100),corrections:array(object({session_item_id:uuid,snapshot}),50),completed_at:nullable(date),error_code:nullable(text(100))},[unique("grading_runs_revision","submission_id","revision")]),
  grading_results:schema({grading_run_id:uuid,session_item_id:uuid,score,max_score:itemScore,verdict:values("correct","incorrect","unanswered")},[unique("grading_results_item","grading_run_id","session_item_id")],[exactScore("score"),exactScore("max_score"),{$lte:["$score","$max_score"]}]),
  outbox_events:schema({aggregate_type:text(100),aggregate_id:uuid,aggregate_version:integer(1),event_type:values("SubmissionAccepted","RegradeRequested","GradeFinalized","AssessmentVisibilityChanged"),schema_version:values(1),target_consumer:values("grading_v1","learning_projection_v1"),payload:object({submission_id:uuid,grading_run_id:uuid},["submission_id"]),status:values("pending","running","processed","failed"),lease_owner:nullable(text(200)),lease_token:nullable(uuid),lease_until:nullable(date),attempt:integer(),available_at:date,processed_at:nullable(date),error_code:nullable(text(100))},[
    unique("outbox_events_aggregate","aggregate_type","aggregate_id","aggregate_version","event_type"),page("outbox_events_claim",{target_consumer:1,status:1,available_at:1,lease_until:1,_id:1})]),
  consumer_receipts:schema({consumer_name:text(100),event_id:uuid},[unique("consumer_receipts_event","consumer_name","event_id")]),
  idempotency_records:schema({user_id:uuid,operation:text(100),resource_id:text(128),key:text(128,8),request_hash:digest,response_status:integer(200,299),result:{bsonType:"object"}},[unique("idempotency_records_scope","user_id","operation","resource_id","key")]),
  assessment_resource_references:schema({reference_type:values("paper_item","session_item"),reference_id:uuid,file_id:uuid,owner_type:values("question"),owner_version_id:uuid},[unique("assessment_resource_references_unique","reference_type","reference_id","file_id"),page("assessment_resource_references_file",{file_id:1,org_id:1})]),
  assessment_question_states:schema({question_version_id:uuid,revision:integer(),embargo_quiz_id:nullable(uuid),answer_disclosed:{bsonType:"bool"}},[unique("assessment_question_states_version","question_version_id")]),
  student_projection_states:schema({member_id:uuid,projection_revision:integer()},[unique("student_projection_states_member","member_id")]),
};
ASSESSMENT_V4_SCHEMAS.audit_events=structuredClone(CONTENT_V3_SCHEMAS.audit_events);
ASSESSMENT_V4_SCHEMAS.audit_events.validator.$jsonSchema.properties.resource_type.enum.push("quiz","session","submission","grading_run");
ASSESSMENT_V4_SCHEMAS.audit_events.indexes.push(page("audit_events_assessment_page",{org_id:1,resource_type:1,resource_id:1,_id:1}));
ASSESSMENT_V4_SCHEMAS.member_capability_grants=structuredClone(CONTENT_V3_SCHEMAS.member_capability_grants);
ASSESSMENT_V4_SCHEMAS.member_capability_grants.validator.$jsonSchema.properties.capability.enum.push("assessment:manage","assessment:review");
export const ASSESSMENT_V4_CHECKSUM=createHash("sha256").update(JSON.stringify({version:4,schemas:ASSESSMENT_V4_SCHEMAS})).digest("hex");

/** Read-only preflight also accepts partially installed v4 validators, never repairs data. */
export async function inspectVersion4(db:Db,session?:ClientSession):Promise<MigrationImpact & {target_version:number;new_collections:string[];markers:Document[];indexes:Record<string,string[]>}> {
  const report=await inspectVersion3(db,session,{...CONTENT_V3_SCHEMAS,audit_events:ASSESSMENT_V4_SCHEMAS.audit_events,member_capability_grants:ASSESSMENT_V4_SCHEMAS.member_capability_grants});
  const options={session,maxTimeMS:15000};
  const existing=await db.listCollections({}, {nameOnly:true,maxTimeMS:15000}).toArray();
  const names=new Set(existing.map(row=>row.name));
  const indexes:Record<string,string[]>={};
  for(const [name,shape] of Object.entries(ASSESSMENT_V4_SCHEMAS)) {
    report.collections[name]={documents:await db.collection(name).countDocuments({},options),needs_defaults:0,invalid_types:await db.collection(name).countDocuments({$nor:[shape.validator]},options)};
    indexes[name]=names.has(name)?(await db.collection(name).listIndexes({maxTimeMS:15000}).toArray()).map(index=>index.name!):[];
  }
  for(const [from,field,to] of [
    ["quizzes","subject_id","subjects"],["quizzes","published_paper_id","papers"],["papers","quiz_id","quizzes"],["paper_items","paper_id","papers"],
    ["quiz_audiences","quiz_id","quizzes"],["quiz_audiences","member_id","organization_members"],["attempt_counters","quiz_id","quizzes"],["attempt_counters","member_id","organization_members"],
    ["sessions","member_id","organization_members"],["sessions","quiz_id","quizzes"],["sessions","paper_id","papers"],["sessions","textbook_edition_id","textbook_editions"],["sessions","chapter_id","chapters"],["sessions","submission_id","submissions"],
    ["session_items","session_id","sessions"],["answers","session_id","sessions"],["answers","session_item_id","session_items"],["submissions","session_id","sessions"],
    ["grading_runs","submission_id","submissions"],["grading_results","grading_run_id","grading_runs"],["grading_results","session_item_id","session_items"],
    ["assessment_resource_references","file_id","file_resources"],["assessment_resource_references","owner_version_id","question_versions"],
    ["assessment_question_states","question_version_id","question_versions"],["assessment_question_states","embargo_quiz_id","quizzes"],["student_projection_states","member_id","organization_members"],
    ["paper_items","snapshot.question_version_id","question_versions"],["session_items","snapshot.question_version_id","question_versions"],
    ["consumer_receipts","event_id","outbox_events"],["outbox_events","payload.submission_id","submissions"],["outbox_events","payload.grading_run_id","grading_runs"],
  ]) {
    // Scope and identity are structural links; retired content and inactive members remain valid history.
    const extra:Document[]=from==="sessions"&&field==="chapter_id"?[{$eq:["$textbook_edition_id","$$edition"]}]:
      from==="sessions"&&field==="member_id"?[{$eq:["$user_id","$$user"]}]:
      from==="submissions"&&field==="session_id"?[{$eq:["$user_id","$$user"]},{$eq:["$member_id","$$member"]}]:[];
    const [result]=await db.collection(from).aggregate([{$match:{[field]:{$exists:true,$ne:null}}},{$lookup:{from:to,let:{target:`$${field}`,org:"$org_id",edition:"$textbook_edition_id",user:"$user_id",member:"$member_id"},pipeline:[{$match:{$expr:{$and:[{$eq:["$_id","$$target"]},...(to==="subjects"?[]:[{$eq:["$org_id","$$org"]}]),...extra]}}}],as:"reference"}},{$match:{reference:{$size:0}}},{$count:"n"}],options).toArray();
    report.invalid_references+=result?.n??0;
  }
  // Retained references remain protective even when invalid; preflight reports, never repairs them.
  for(const [type,target] of [["paper_item","paper_items"],["session_item","session_items"]]) {
    const [result]=await db.collection("assessment_resource_references").aggregate([
      {$match:{reference_type:type}},
      {$lookup:{from:target,let:{target:"$reference_id",org:"$org_id",owner:"$owner_version_id",file:"$file_id"},pipeline:[
        {$match:{$expr:{$and:[{$eq:["$_id","$$target"]},{$eq:["$org_id","$$org"]},
          {$eq:["$snapshot.question_version_id","$$owner"]},
          {$in:["$$file",{$cond:[{$isArray:"$snapshot.resource_ids"},"$snapshot.resource_ids",[]]}]}]}}},
        {$project:{_id:1}},{$limit:1},
      ],as:"reference"}},
      {$match:{reference:{$size:0}}},{$count:"n"},
    ],options).toArray();
    report.invalid_references+=result?.n??0;
  }
  const [fileOwners]=await db.collection("assessment_resource_references").aggregate([
    {$lookup:{from:"file_resources",let:{file:"$file_id",org:"$org_id",type:"$owner_type",owner:"$owner_version_id"},pipeline:[
      {$match:{$expr:{$and:[{$eq:["$_id","$$file"]},{$eq:["$org_id","$$org"]},
        {$eq:["$owner_type","$$type"]},{$eq:["$owner_version_id","$$owner"]}]}}},
      {$project:{_id:1}},{$limit:1},
    ],as:"reference"}},
    {$match:{reference:{$size:0}}},{$count:"n"},
  ],options).toArray();
  report.invalid_references+=fileOwners?.n??0;
  return {...report,target_version:4,new_collections:Object.keys(ASSESSMENT_V4_SCHEMAS).filter(name=>!names.has(name)),
    markers:await db.collection("schema_migrations").find({}, {projection:{_id:0,version:1,status:1,checksum:1},...options}).sort({version:1}).toArray(),indexes};
}
