import { requireObjectId } from "../operations/contracts";
import { newId } from "../database/object-id";
import { createHash, randomUUID } from "node:crypto";
import type { Db, Document as MongoDocument, MongoClient, ClientSession } from "mongodb";
import { assertLocalEnvironment, getOperationalState, requireActor, requireUuid, WRITER_KINDS, type OperationalState, type WriterKind } from "./contracts";
import { OPERATIONS_V7_SCHEMAS } from "./schema";
import { realpath } from "node:fs/promises";
import { storageRoot } from "../files/config";
import { runInTxn } from "../database/txn";
import type { AdministrationGuard } from '../database/contracts';
export { getOperationalState } from "./contracts";
export interface WriterRegistration { id:string; token:string; release:()=>Promise<void>; stopRequested:()=>Promise<boolean>; }
interface Document extends MongoDocument { _id:string; }

async function auditOperation(db:Db,input:{actor:string;reason:string},action:string,session?:ClientSession):Promise<void> {
  await db.collection<Document>("audit_events").insertOne({_id:newId(),actor_id:input.actor,org_id:null,action:`operations.${action}`,resource_id:db.databaseName,reason:input.reason,request_id:randomUUID(),created_at:new Date()},{session});
}

async function transaction<T>(client:MongoClient,work:(session:ClientSession)=>Promise<T>):Promise<T> {
  return runInTxn(client, work, {readConcern:{level:"snapshot"},writeConcern:{w:"majority"},readPreference:"primary"});
}
export async function bootstrapOperations(db:Db):Promise<void> {
  const existing=await db.collection<OperationalState>("operational_state").findOne({_id:"environment"});
  if(!existing&&await db.collection("schema_migrations").findOne({version:{$gte:7},status:"completed"})) throw new Error("OPERATIONS_STATE_MISSING");
  for(const [name,shape] of Object.entries(OPERATIONS_V7_SCHEMAS)) {
    try { await db.createCollection(name,{validator:shape.validator,validationLevel:"strict",validationAction:"error"}); }
    catch(error) { if((error as {code?:number}).code!==48) throw error; }
    if(shape.indexes.length) await db.collection(name).createIndexes(shape.indexes);
  }
  await db.collection<OperationalState>("operational_state").updateOne({_id:"environment"},{$setOnInsert:{environment_id:null,mode:"unregistered",revision:0,access_fence:0,restore_id:null,maintenance_token:null,owner:null,updated_at:new Date()}},{upsert:true});
}
export async function assertOperationalAccess(db:Db,options:{allowMaintenance?:boolean;maintenanceToken?:string}={}):Promise<void> {
  const state=await getOperationalState(db);
  if(state.mode==="unregistered") return;
  assertLocalEnvironment(db,state.environment_id!);
  if(state.mode==="active") return;
  if(state.mode==="maintenance"&&options.allowMaintenance===true&&options.maintenanceToken&&options.maintenanceToken===state.maintenance_token) return;
  throw new Error("OPERATIONS_ACCESS_BLOCKED");
}
export async function acquireWriter(db:Db,kind:WriterKind,legacyMigration=false):Promise<WriterRegistration> {
  if(!WRITER_KINDS.includes(kind)) throw new Error("OPERATIONS_WRITER_KIND_INVALID");
  if(kind==="migration") await bootstrapOperations(db);
  if(legacyMigration && (kind!=="migration" || await db.collection("schema_migrations").findOne({version:10}))) throw new Error("LEGACY_WRITER_NOT_ALLOWED");
  const id=legacyMigration?randomUUID():newId(),token=process.env.KL_WRITER_LAUNCH_TOKEN??randomUUID(); requireUuid(token);
  await transaction(db.client,async session=> {
    const state=await db.collection<OperationalState>("operational_state").findOne({_id:"environment"},{session});
    if(!state||!["unregistered","active"].includes(state.mode)) throw new Error("OPERATIONS_ACCESS_BLOCKED");
    if(state.mode!=="unregistered") assertLocalEnvironment(db,state.environment_id!);
    const fence=await db.collection<OperationalState>("operational_state").updateOne({_id:"environment",revision:state.revision,mode:state.mode},{$inc:{access_fence:1}},{session});
    if(fence.modifiedCount!==1) throw new Error("OPERATIONS_REVISION_CONFLICT");
    const now=new Date();
    await db.collection<Document>("operational_writers").insertOne({_id:id,environment_id:state.environment_id,kind,token,pid:process.pid,state:"running",started_at:now,heartbeat_at:now,stopped_at:null,shutdown_nonce:null},{session});
  });
  let released=false,heartbeatFailed=false,inflight=Promise.resolve();
  const timer=setInterval(()=> {
    inflight=inflight.then(async()=> { if(released) return; const result=await db.collection("operational_writers").updateOne({_id:id as never,token,state:"running"},{$set:{heartbeat_at:new Date()}}); if(result.modifiedCount!==1) heartbeatFailed=true; }).catch(()=>{heartbeatFailed=true;});
  },3000); timer.unref();
  return {id,token,stopRequested:async()=> {
    if(heartbeatFailed) return true;
    const row=await db.collection<Document>("operational_writers").findOne({_id:id,token,state:"running"});
    return !row||row.shutdown_nonce!==null;
  },release:async()=> {
    if(released) return; released=true; clearInterval(timer); await inflight;
    try { const result=await db.collection<Document>("operational_writers").updateOne({_id:id,token,state:"running"},{$set:{state:"stopped",stopped_at:new Date(),heartbeat_at:new Date()}}); if(result.modifiedCount!==1) throw new Error("OPERATIONS_WRITER_RELEASE_CONFLICT"); }
    catch(error) { released=false; throw error; }
  }};
}
export async function inspectOperations(db:Db) {
  const state=await getOperationalState(db);
  const writers=await db.collection<Document>("operational_writers").find({state:"running"},{projection:{_id:1,kind:1,started_at:1,heartbeat_at:1,shutdown_nonce:1}}).toArray();
  return {environment_id:state.environment_id,mode:state.mode,revision:state.revision,restore_id:state.restore_id,writers:writers.map(row=>({id:row._id,kind:row.kind,started_at:row.started_at,heartbeat_at:row.heartbeat_at,stop_requested:row.shutdown_nonce!==null})),ready:["active","unregistered"].includes(state.mode)};
}
export async function registerEnvironment(client:MongoClient,db:Db,input:{environmentId:string;actor:string;reason:string;fileRoot:string|null}) {
  requireActor(input); assertLocalEnvironment(db,input.environmentId);
  if(!/^kl_test_/.test(db.databaseName)) throw new Error("OPERATIONS_SOURCE_DATABASE_REQUIRED");
  const current=await getOperationalState(db);
  if(!((current.mode==="unregistered"&&current.revision===0)||(current.mode==="draining"&&current.revision===1&&current.environment_id===input.environmentId&&current.owner===input.actor))) throw new Error("OPERATIONS_ALREADY_REGISTERED");
  if(current.mode==="unregistered") await transaction(client,async session=> {
    if(await db.collection("operational_writers").countDocuments({state:"running"},{session})) throw new Error("OPERATIONS_WRITERS_RUNNING");
    const result=await db.collection<OperationalState>("operational_state").updateOne({_id:"environment",mode:"unregistered",revision:current.revision},{$set:{mode:"draining",environment_id:input.environmentId,owner:input.actor,updated_at:new Date()},$inc:{revision:1,access_fence:1}},{session});
    if(result.modifiedCount!==1) throw new Error("OPERATIONS_REVISION_CONFLICT");
    await auditOperation(db,input,"register",session);
  });
  // Lazy loading breaks the control/ledger/privacy runtime cycle; ledger calls control guards.
  const {registerSafetyLedger}=await import("./ledger");
  await registerSafetyLedger(db,input.environmentId,input.fileRoot);
  const result=await db.collection<OperationalState>("operational_state").updateOne({_id:"environment",mode:"draining",revision:1,environment_id:input.environmentId,owner:input.actor},{$set:{mode:"active",owner:null,updated_at:new Date()},$inc:{revision:1,access_fence:1}});
  if(result.modifiedCount!==1) throw new Error("OPERATIONS_REVISION_CONFLICT");
  return inspectOperations(db);
}
export async function drainEnvironment(client:MongoClient,db:Db,input:{actor:string;reason:string;expectedRevision:number}) {
  requireActor(input); const state=await getOperationalState(db); assertLocalEnvironment(db,state.environment_id!);
  if(state.revision<2) throw new Error("OPERATIONS_REGISTRATION_INCOMPLETE");
  await transaction(client,async session=> {
    const result=await db.collection<OperationalState>("operational_state").updateOne({_id:"environment",mode:{$in:["active","draining"]},revision:input.expectedRevision},{$set:{mode:"draining",owner:input.actor,updated_at:new Date()},$inc:{revision:1,access_fence:1}},{session});
    if(result.modifiedCount!==1) throw new Error("OPERATIONS_REVISION_CONFLICT");
    await db.collection("operational_writers").updateMany({state:"running"},{$set:{shutdown_nonce:randomUUID()}},{session});
    await auditOperation(db,input,"drain",session);
  });
  return inspectOperations(db);
}
export async function enterMaintenance(client:MongoClient,db:Db,input:{actor:string;reason:string;expectedRevision:number}):Promise<{environmentId:string;token:string;revision:number}> {
  requireActor(input); let state=await getOperationalState(db); assertLocalEnvironment(db,state.environment_id!);
  if(state.revision!==input.expectedRevision) throw new Error("OPERATIONS_REVISION_CONFLICT");
  if(state.mode==="active") {
    await drainEnvironment(client,db,input); state=await getOperationalState(db);
    if(state.revision!==input.expectedRevision+1) throw new Error("OPERATIONS_REVISION_CONFLICT");
  }
  if(state.mode!=="draining"||state.revision<3) throw new Error("OPERATIONS_DRAIN_REQUIRED");
  const token=randomUUID();
  await transaction(client,async session=> {
    if(await db.collection("operational_writers").countDocuments({state:"running"},{session})) throw new Error("OPERATIONS_WRITERS_RUNNING");
    const result=await db.collection<OperationalState>("operational_state").updateOne({_id:"environment",mode:"draining",revision:state.revision},{$set:{mode:"maintenance",maintenance_token:token,owner:input.actor,updated_at:new Date()},$inc:{revision:1,access_fence:1}},{session});
    if(result.modifiedCount!==1) throw new Error("OPERATIONS_REVISION_CONFLICT");
    await auditOperation(db,input,"maintenance",session);
  });
  return {environmentId:state.environment_id!,token,revision:state.revision+1};
}
export async function assertMaintenance(db:Db,token:string):Promise<{environmentId:string;revision:number}> {
  requireUuid(token); const state=await getOperationalState(db); assertLocalEnvironment(db,state.environment_id!);
  if(state.mode!=="maintenance"||state.maintenance_token!==token) throw new Error("OPERATIONS_MAINTENANCE_REQUIRED");
  return {environmentId:state.environment_id!,revision:state.revision};
}
export async function leaveMaintenance(client:MongoClient,db:Db,input:{token:string;actor:string;reason:string}) {
  requireActor(input); const state=await assertMaintenance(db,input.token);
  // Lazy loading breaks the control/ledger/privacy runtime cycle.
  const {runWithCurrentSafetyLedger}=await import("./ledger");
  await runWithCurrentSafetyLedger(state.environmentId,0,async ledger=> {
  if(ledger.pending) throw new Error("OPERATIONS_PENDING_LEDGER");
  await transaction(client,async session=> {
    if(await db.collection("operational_writers").countDocuments({state:"running"},{session})) throw new Error("OPERATIONS_WRITERS_RUNNING");
    if(await db.collection("privacy_deletion_requests").findOne({$or:[{lease_until:{$gt:new Date()}},{remaining_actions:"resume_coursework_disposition"}]},{session}))throw Error("OPERATIONS_PRIVACY_DISPOSITION_PENDING");
    const result=await db.collection<OperationalState>("operational_state").updateOne({_id:"environment",mode:"maintenance",maintenance_token:input.token,revision:state.revision},{$set:{mode:"active",maintenance_token:null,owner:null,updated_at:new Date()},$inc:{revision:1,access_fence:1}},{session});
    if(result.modifiedCount!==1) throw new Error("OPERATIONS_REVISION_CONFLICT");
    await auditOperation(db,input,"resume",session);
  }); }); return inspectOperations(db);
}
export async function quarantineRestore(db:Db,input:{environmentId:string;restoreId:string}):Promise<void> {
  assertLocalEnvironment(db,input.environmentId); requireObjectId(input.restoreId);
  if(!/^kl_restore_/.test(db.databaseName)) throw new Error("OPERATIONS_RESTORE_DATABASE_REQUIRED");
  const state=await db.collection<OperationalState>("operational_state").findOne({_id:"environment"});
  if(!state) {
    await transaction(db.client,async session=> {
      const names=await db.listCollections({},{nameOnly:true}).toArray();
      for(const collection of names) if(await db.collection(collection.name).findOne({},{session,projection:{_id:1}})) throw new Error("OPERATIONS_RESTORE_TARGET_NOT_EMPTY");
      await db.collection<OperationalState>("operational_state").insertOne({_id:"environment",environment_id:input.environmentId,mode:"restore_quarantined",revision:1,access_fence:1,restore_id:input.restoreId,maintenance_token:null,owner:null,updated_at:new Date()},{session});
      // The archived guard and management operations are never restored. Start from a
      // fresh idle guard only after proving the target schema contains no data.
      await db.collection<AdministrationGuard>("administration_guard").insertOne({
        _id: "administration", revision: 1, state: "idle", operation_id: null, recovery_token: null,
        blocked_targets: { user_ids: [], member_ids: [], org_ids: [], global: false },
        affected_orgs: [], updated_at: new Date(),
      }, { session });
    });
    return;
  }
  if(state.mode==="restore_quarantined"&&state.restore_id===input.restoreId&&state.environment_id===input.environmentId) return;
  throw new Error("OPERATIONS_RESTORE_CONFLICT");
}
export async function releaseRestoredLocal(client:MongoClient,db:Db,input:{restoreId:string;actor:string;reason:string;expectedRevision:number;manifestHash:string;ledgerSequence:number}) {
  requireActor(input); requireObjectId(input.restoreId);
  const state=await getOperationalState(db); assertLocalEnvironment(db,state.environment_id!);
  if(!/^kl_restore_/.test(db.databaseName)||state.mode!=="restore_quarantined"||state.restore_id!==input.restoreId||state.revision!==input.expectedRevision) throw new Error("OPERATIONS_RESTORE_CONFLICT");
  const fileRootHash=createHash("sha256").update(await realpath(await storageRoot())).digest("hex");
  // Lazy loading breaks the control/ledger/privacy runtime cycle.
  const {runWithCurrentSafetyLedger}=await import("./ledger");
  await runWithCurrentSafetyLedger(state.environment_id!,input.ledgerSequence,async (ledger,authorizeDatabase)=> {
  if(ledger.pending||ledger.sequence!==input.ledgerSequence) throw new Error("OPERATIONS_LEDGER_NOT_CURRENT");
  const runFilter={_id:input.restoreId,environment_id:state.environment_id,status:"ready",manifest_hash:input.manifestHash,file_root_hash:fileRootHash,ledger_sequence:ledger.sequence,"checks.schema":true,"checks.files":true,"checks.ledger":true,"checks.identities":true,"checks.smoke":true};
  if(!await db.collection<Document>("backup_restore_runs").findOne(runFilter)) throw new Error("OPERATIONS_RESTORE_NOT_VALIDATED");
  await authorizeDatabase(db);
  await transaction(client,async session=> {
    if(await db.collection("operational_writers").countDocuments({state:"running"},{session})) throw new Error("OPERATIONS_WRITERS_RUNNING");
    const run=await db.collection<Document>("backup_restore_runs").findOne(runFilter,{session});
    if(!run) throw new Error("OPERATIONS_RESTORE_NOT_VALIDATED");
    const guard = await db.collection<AdministrationGuard>("administration_guard").findOne({ _id: "administration", state: "idle", operation_id: null, recovery_token: null }, { session });
    if (!guard || guard.blocked_targets?.global !== false || guard.blocked_targets?.user_ids?.length || guard.blocked_targets?.member_ids?.length || guard.blocked_targets?.org_ids?.length || guard.affected_orgs?.length)
      throw new Error("OPERATIONS_RESTORE_NOT_VALIDATED");
    for (const name of ["member_roles", "member_capability_grants", "administrative_grants", "authorization_requests", "administration_operations", "auth_sessions"]) {
      if (await db.collection(name).findOne({}, { session, projection: { _id: 1 } })) throw new Error("OPERATIONS_RESTORE_NOT_VALIDATED");
    }
    const result=await db.collection<OperationalState>("operational_state").updateOne({_id:"environment",mode:"restore_quarantined",restore_id:input.restoreId,revision:input.expectedRevision},{$set:{mode:"active",owner:null,updated_at:new Date()},$inc:{revision:1,access_fence:1}},{session});
    if(result.modifiedCount!==1) throw new Error("OPERATIONS_REVISION_CONFLICT");
    await db.collection<Document>("backup_restore_runs").updateOne({_id:input.restoreId,status:"ready",revision:run.revision},{$set:{status:"released",updated_at:new Date()},$inc:{revision:1}},{session});
    await auditOperation(db,input,"release-local",session);
  }); }); return inspectOperations(db);
}
