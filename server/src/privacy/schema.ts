import type { Document, IndexDescription } from 'mongodb';
export const PRIVACY_POLICY_REVISION = 'local_privacy_v1' as const;
export const PRIVACY_STATUSES = ['requested','reviewing','rejected','approved','blocking','erasing','failed','completed','completed_with_retention'] as const;
const uuid = { bsonType:'string', pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const text = {bsonType:'string',maxLength:512};
const date = {bsonType:'date'};
const number = {bsonType:['int','long','double'],minimum:0,maximum:Number.MAX_SAFE_INTEGER,multipleOf:1};
const nullable = (value:Document) => ({anyOf:[value,{bsonType:'null'}]});
const strings = {bsonType:'array',maxItems:100,uniqueItems:true,items:text};
const hash = {bsonType:'string',pattern:'^[a-f0-9]{64}$'};
function schema(properties:Document,indexes:IndexDescription[]) { return {validator:{$jsonSchema:{bsonType:'object',additionalProperties:false,required:Object.keys(properties),properties}},indexes}; }
export const PRIVACY_USER_FIELDS = {privacy_state:{enum:['active','erasing','erased']}};
export const PRIVACY_V7_SCHEMAS:Record<string,{validator:Document;indexes:IndexDescription[]}> = {
  privacy_deletion_requests:schema({_id:uuid,user_id:uuid,scope:{enum:['account']},policy_revision:{enum:[PRIVACY_POLICY_REVISION]},status:{enum:PRIVACY_STATUSES},revision:number,plan_hash:nullable(hash),actor:nullable(text),reason_code:nullable(text),deleted_categories:strings,retained_categories:strings,retention_basis:nullable(text),remaining_actions:strings,created_at:date,updated_at:date,lease_token:nullable(uuid),lease_until:nullable(date),ledger_sequence:nullable(number),completed_steps:strings},[{key:{user_id:1,_id:1},name:'privacy_requests_user_page'}]),
  privacy_operation_receipts:schema({_id:uuid,user_id:uuid,key_hash:hash,request_hash:hash,request_id:uuid,created_at:date},[{key:{user_id:1,key_hash:1},name:'privacy_operation_key_unique',unique:true}]),
  privacy_tombstones:schema({_id:uuid,user_id:uuid,epoch:uuid,request_id:uuid,state:{enum:['blocking','erasing','erased']},ledger_sequence:number,created_at:date,updated_at:date},[{key:{user_id:1},name:'privacy_tombstone_user_unique',unique:true}]),
  privacy_step_receipts:schema({_id:uuid,request_id:uuid,step:text,deleted_count:number,created_at:date},[{key:{request_id:1,step:1},name:'privacy_step_unique',unique:true}]),
};
