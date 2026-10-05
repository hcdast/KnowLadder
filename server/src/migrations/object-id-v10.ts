import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MongoClient, ObjectId, type Db, type Document, type IndexDescription } from "mongodb";
import { OBJECT_ID_PATHS, NATURAL_KEYS } from "../database/object-id-paths";
import { ROLE_IDS, rawDatabase } from "../database/object-id";
import { assertTopology } from "../database/topology";
import { loadConfig } from "../config";
type Schema = { validator: Document; indexes: IndexDescription[] };
export function objectIdSchemas(legacy: Record<string, Schema>): Record<string, Schema> {
  function transform(name: string, node: any, path = ""): any {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(v => transform(name, v, path));
    if (Object.getPrototypeOf(node) !== Object.prototype) return node;
    const output: Document = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties") {
        output.properties = Object.fromEntries(Object.entries(value as Document).map(([field, shape]) => {
          const fieldPath = path ? path + "." + field : field;
          const old = shape as Document;
          const natural = fieldPath === "_id" ? NATURAL_KEYS[name] : undefined;
          const converted = OBJECT_ID_PATHS[name]?.includes(fieldPath);
          let next = converted && !natural && old.bsonType !== "null" ? (old.anyOf ? { anyOf: old.anyOf.map((s: Document) => s.bsonType === "null" ? s : { bsonType: "objectId" }) } : { bsonType: "objectId" }) : transform(name, shape, fieldPath);
          if (natural) next = { bsonType: "objectId" };
          return [field, next];
        }));
        if (!path && NATURAL_KEYS[name]) {
          const natural = NATURAL_KEYS[name]!;
          output.properties[natural] = (value as Document)._id;
          if (name === "roles") output.properties.code = (value as Document).code;
        }
      } else if (key === "items") {
        output.items = OBJECT_ID_PATHS[name]?.includes(path + "[]") ? { bsonType: "objectId" } : transform(name, value, path + "[]");
      } else if (key === "required" && !path && NATURAL_KEYS[name]) output.required = [...new Set([...(value as string[]), NATURAL_KEYS[name]])];
      else output[key] = transform(name, value, path);
    }
    return output;
  }
  const result: Record<string, Schema> = {};
  for (const [name, old] of Object.entries(legacy)) {
    if (!OBJECT_ID_PATHS[name]) throw new Error("UNREGISTERED_SCHEMA:" + name);
    result[name] = { validator: transform(name, old.validator), indexes: old.indexes.map(index => ({ ...index })) };
    const natural = NATURAL_KEYS[name];
    if (natural && !old.indexes.some(i => i.unique && Object.keys(i.key).length === 1 && (i.key as Document)[natural] === 1))
      result[name]!.indexes.push({ key: { [natural]: 1 }, unique: true, name: name + "_natural_key_unique" });
  }
  // v8 role identity used code as the primary key. v10 stores it independently.
  const role = result.roles!.validator;
  if (role.$and) role.$and = role.$and.filter((v: Document) => !v.$expr);
  // Text-valued polymorphic audit subjects include service operators and real references.
  function mixed(node: any, fields: string[]) {
    if (!node || typeof node !== "object") return;
    if (node.properties) for (const field of fields) if (node.properties[field])
      node.properties[field] = { anyOf: [node.properties[field], { bsonType: "objectId" }] };
    for (const [key,v] of Object.entries(node)) if (key !== "properties") {
      if (Array.isArray(v)) v.forEach(x => mixed(x, fields)); else mixed(v, fields);
    }
  }
  mixed(result.audit_events!.validator, ["actor_id", "resource_id"]);
  mixed(result.administration_operations!.validator, ["actor_id"]);
  mixed(result.content_idempotency!.validator, ["resource_id"]);
  mixed(result.idempotency_records!.validator, ["resource_id"]);
  // v9 conditional role checks are expressed in role codes.
  function roleExpressions(v: any): any {
    if (Array.isArray(v)) return v.map(roleExpressions);
    if (!v || typeof v !== "object") return typeof v === "string" && ROLE_IDS[v] ? ROLE_IDS[v] : v;
    if (Object.getPrototypeOf(v) !== Object.prototype) return v;
    return Object.fromEntries(Object.entries(v).map(([k,x]) => [k, roleExpressions(x)]));
  }
  const member = result.member_roles!.validator;
  if (member.$and) member.$and = member.$and.map((v: Document) => v.$expr ? { $expr: roleExpressions(v.$expr) } : v);
  result.object_id_allocations = { validator: { $jsonSchema: { bsonType:"object", additionalProperties:false, required:["_id","actor_id","key_hash","action","purpose","created_at"], properties:{_id:{bsonType:"objectId"},actor_id:{bsonType:"objectId"},key_hash:{bsonType:"string",pattern:"^[0-9a-f]{64}$"},action:{bsonType:"string"},purpose:{bsonType:"string"},created_at:{bsonType:"date"}} } }, indexes:[{name:"object_id_allocation_key",key:{actor_id:1,key_hash:1,action:1,purpose:1},unique:true}] };
  return result;
}
export function objectIdChecksum(schemas: Record<string, Schema>): string {
  return createHash("sha256").update(JSON.stringify({version:10,schemas,roles:ROLE_IDS})).digest("hex");
}
export async function assertObjectIdSchema(db: Db, schemas: Record<string, Schema>, checksum: string): Promise<void> {
  db = rawDatabase(db);
  const marker = await db.collection("schema_migrations").findOne({version:10,status:"completed",checksum,completed_at:{$type:"date"}});
  if (!marker) throw new Error("Required ObjectId v10 initialization incomplete");
  const names = (await db.listCollections({}, {nameOnly:true}).toArray()).map(row=>row.name);
  if (names.some(n=>!schemas[n])) throw new Error("UNKNOWN_COLLECTION");
  if (names.length !== Object.keys(schemas).length) throw new Error("ObjectId collection registry mismatch");
  for (const [name,schema] of Object.entries(schemas)) {
    const info = await db.listCollections({name}, {nameOnly:false}).next();
    if (!info || !isDeepStrictEqual(info.options?.validator,schema.validator) || info.options?.validationAction!=="error" || info.options?.validationLevel!=="strict") throw new Error("ObjectId validator mismatch:"+name);
    const indexes = await db.collection(name).listIndexes().toArray();
    for (const expected of schema.indexes) {
      const actual=indexes.find(i=>i.name===expected.name);
      if (!actual || !isDeepStrictEqual(actual.key,expected.key) || !!actual.unique!==!!expected.unique ||
          actual.expireAfterSeconds!==expected.expireAfterSeconds || !isDeepStrictEqual(actual.partialFilterExpression,expected.partialFilterExpression) ||
          actual.sparse || actual.hidden || actual.collation) throw new Error("ObjectId index mismatch:"+name);
    }
  }
  for (const [name,key] of [["operational_state","environment"],["administration_guard","administration"],["learning_tracking_config","tracking"]]) {
    if (!await db.collection(name!).findOne({key})) throw new Error("ObjectId state missing:"+name);
  }
}
export async function initializeObjectId(uri: string, schemas: Record<string, Schema>, checksum: string, roles: Record<string,string[]>): Promise<void> {
  const client=new MongoClient(uri,{serverSelectionTimeoutMS:15000});
  await client.connect();
  const db=client.db(), token=randomUUID(), duration=120000;
  let held=false;
  try {
    await assertTopology(db,loadConfig());
    const names=(await db.listCollections({},{nameOnly:true}).toArray()).map(row=>row.name);
    if (names.some(n=>!schemas[n])) throw new Error("ObjectId initialization requires empty target");
    const old=names.includes("schema_migrations") ? await db.collection("schema_migrations").findOne({version:10}) : null;
    if (old?.status==="completed") { await assertObjectIdSchema(db,schemas,checksum); return; }
    if (old && old.checksum!==checksum) throw new Error("ObjectId initialization checksum differs");
    if (!old && names.some(n=>n!=="schema_migrations")) throw new Error("Legacy or nonempty database: explicit migration required");
    const markerSchema=schemas.schema_migrations!;
    if (!names.includes("schema_migrations")) {
      try { await db.createCollection("schema_migrations",{validator:markerSchema.validator,validationLevel:"strict",validationAction:"error"}); }
      catch(e:any){if(e.code!==48)throw e;}
    }
    await db.collection("schema_migrations").createIndexes(markerSchema.indexes);
    if (await db.collection("schema_migrations").countDocuments({version:{$ne:10}})) throw new Error("Legacy markers cannot initialize v10");
    const now=new Date();
    if (!old) {
      try { await db.collection("schema_migrations").insertOne({version:10,checksum,status:"pending",lease_token:null,lease_until:null,created_at:now,started_at:null,completed_at:null,failed_at:null}); }
      catch(e:any){if(e.code!==11000)throw e;}
    }
    const acquired=await db.collection("schema_migrations").updateOne({version:10,checksum,status:{$ne:"completed"},$or:[{lease_until:null},{lease_until:{$lte:now}}]},
      {$set:{status:"running",lease_token:token,lease_until:new Date(now.getTime()+duration),started_at:now,failed_at:null}});
    if(acquired.modifiedCount!==1)throw new Error("ObjectId initializer busy");
    held=true;
    for(const [name,schema]of Object.entries(schemas)){
      const renewed=await db.collection("schema_migrations").updateOne({version:10,lease_token:token,status:"running",lease_until:{$gt:new Date()}},{$set:{lease_until:new Date(Date.now()+duration)}});
      if(renewed.matchedCount!==1)throw new Error("ObjectId initialization lease lost");
      if(name!=="schema_migrations"){
        try{await db.createCollection(name,{validator:schema.validator,validationLevel:"strict",validationAction:"error"});}
        catch(e:any){if(e.code!==48)throw e;const info=await db.listCollections({name}, {nameOnly:false}).next();if(!isDeepStrictEqual(info?.options?.validator,schema.validator))throw new Error("Partial ObjectId schema mismatch");}
      }
      if(schema.indexes.length)await db.collection(name).createIndexes(schema.indexes);
      if(await db.collection(name).findOne({$nor:[schema.validator]},{projection:{_id:1}}))throw new Error("Invalid v10 data:"+name);
    }
    for(const [code,capabilities]of Object.entries(roles))await db.collection("roles").updateOne({code},{$setOnInsert:{_id:ROLE_IDS[code],code,capabilities}},{upsert:true});
    await db.collection("learning_tracking_config").updateOne({key:"tracking"},{$setOnInsert:{epoch:randomUUID(),cutover_at:now,tracking_ready:true}},{upsert:true});
    await db.collection("operational_state").updateOne({key:"environment"},{$setOnInsert:{environment_id:null,mode:"unregistered",revision:0,access_fence:0,restore_id:null,maintenance_token:null,owner:null,updated_at:now}},{upsert:true});
    await db.collection("administration_guard").updateOne({key:"administration"},{$setOnInsert:{revision:1,state:"idle",operation_id:null,recovery_token:null,blocked_targets:{user_ids:[],member_ids:[],org_ids:[],global:false},affected_orgs:[],updated_at:now}},{upsert:true});
    const finished=await db.collection("schema_migrations").updateOne({version:10,checksum,lease_token:token,status:"running",lease_until:{$gt:new Date()}},{$set:{status:"completed",completed_at:new Date(),lease_token:null,lease_until:null,failed_at:null}});
    if(finished.modifiedCount!==1)throw new Error("ObjectId initialization lease lost");
    held=false;
    await assertObjectIdSchema(db,schemas,checksum);
  } catch(error) {
    if(held)await db.collection("schema_migrations").updateOne({version:10,lease_token:token,status:"running"},{$set:{status:"failed",failed_at:new Date(),lease_token:null,lease_until:null}}).catch(()=>{});
    throw error;
  } finally {await client.close();}
}
