import type { Db } from 'mongodb';
const integer = { bsonType: ['int','long','double'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 };
const text = (maxLength:number, minLength=1) => ({bsonType:'string',minLength,maxLength});
export function standaloneJournalSpec(kind:'leases'|'operations') {
  const name='training_standalone_'+kind;
  const properties:Record<string,unknown> = kind==='leases' ? {
    _id:{bsonType:'objectId'},resource:text(256),owner:text(128,0),token:text(128,0),generation:integer,until:{bsonType:'date'},
  } : {
    _id:{bsonType:'objectId'},scope:text(256),key:{...text(128,8),pattern:'^[A-Za-z0-9_-]+$'},hash:{...text(64),pattern:'^[0-9a-f]{64}$'},
    steps:{bsonType:'array',minItems:1,maxItems:20,uniqueItems:true,items:{...text(64),pattern:'^[a-z][a-z0-9_-]*$'}},
    cursor:integer,state:{enum:['pending','recovering','completed','needs-review']},generation:integer,token:text(128,0),until:{bsonType:'date'},
  };
  const structure={bsonType:'object',additionalProperties:false,required:Object.keys(properties),properties};
  const validator=kind==='leases'?{$jsonSchema:structure}:{$and:[{$jsonSchema:structure},{$expr:{$and:[{$lte:['$cursor',{$size:'$steps'}]},{$or:[{$ne:['$state','completed']},{$eq:['$cursor',{$size:'$steps'}]}]}]}}]};
  return {name,validator};
}
export async function initializeStandaloneJournal(db:Db,kind:'leases'|'operations'){
  const {name,validator}=standaloneJournalSpec(kind);
  if (!(await db.listCollections({name},{nameOnly:true}).hasNext())) {
    try {await db.createCollection(name,{validator,validationLevel:'strict',validationAction:'error'});}
    catch(e){if((e as {code?:number}).code!==48)throw e;}
  }
  // Do not silently adopt loose or incompatible collections containing old data.
  const actual=await db.listCollections({name}).next();
  const {isDeepStrictEqual}=await import('node:util');
  if(!actual || !("options" in actual) || !isDeepStrictEqual(actual.options?.validator,validator) || actual.options?.validationLevel!=='strict' || actual.options?.validationAction!=='error')
    throw Error('STANDALONE_JOURNAL_SCHEMA_MISMATCH');
  await db.collection(name).createIndex(kind==='leases'?{resource:1}:{scope:1,key:1},{unique:true});
}