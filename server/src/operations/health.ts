import { lstat, realpath, statfs } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Db } from "mongodb";
import { assertSchema, CURRENT_SCHEMA_VERSION } from "../migrations/schema";
import { assertScanner } from "../files/scanner";
import { assertLocalEnvironment, WRITER_KINDS } from "./contracts";
import { readLatestCompletedBackup } from "./ledger";

const consumers=["grading_v1","learning_projection_v1"];
const queueStates=["pending","running","failed"];
const fileStates=["pending","quarantined","ready","deleting"];
const scanStates=["awaiting_upload","queued","scanning","clean","infected","failed"];
const age=(date:unknown,now:number)=>date instanceof Date&&Number.isFinite(date.getTime())?Math.max(0,now-date.getTime()):null;
const known=(field:string,values:readonly string[])=>({$cond:[{$in:[field,values]},field,"unknown"]});
async function observe<T>(read:()=>Promise<T>):Promise<T|{status:"unavailable"}> {
  try {return await read();} catch {return {status:"unavailable"};}
}
async function storageHealth() {
  const root=process.env.FILE_STORAGE_ROOT;
  if(!root) return {status:"unconfigured"};
  return observe(async()=> {
    if(!isAbsolute(root)||root.startsWith("\\\\")) throw new Error("INVALID_ROOT");
    const path=resolve(root);
    for(const base of [resolve(__dirname,"../../.."),process.cwd()]) {
      const child=relative(base,path);if(!child||(!child.startsWith(`..${sep}`)&&child!==".."&&!isAbsolute(child))) throw new Error("INVALID_ROOT");
    }
    const info=await lstat(path),actual=await realpath(path);
    if(!info.isDirectory()||info.isSymbolicLink()||(process.platform==="win32"?actual.toLowerCase()!==path.toLowerCase():actual!==path)) throw new Error("INVALID_ROOT");
    const space=await statfs(path,{bigint:true});
    if(space.bsize<=0n||space.bavail<0n||space.blocks<0n) throw new Error("INVALID_STORAGE_CAPACITY");
    // This is availability/capacity observation, not a replacement for private path checks on file access.
    return {status:"available",available_bytes:(space.bavail*space.bsize).toString(),total_bytes:(space.blocks*space.bsize).toString()};
  });
}
async function scannerHealth(probe:boolean,now:number) {
  if(!["FILE_STORAGE_ROOT","CLAMSCAN_PATH","CLAMAV_DATABASE","SCAN_DATABASE_MAX_AGE_HOURS"].every(name=>!!process.env[name])) return {status:"unconfigured"};
  if(!probe) return {status:"not_checked"};
  return observe(async()=>{const health=await assertScanner();return {status:"healthy",database_updated_at:health.database_updated_at,database_age_ms:age(health.database_updated_at,now)};});
}
async function backupHealth(db:Db) {
  if(!["KL_ENVIRONMENT_ID","KL_CONTROL_MONGODB_URI","KL_SAFETY_LEDGER_ROOT","KL_SAFETY_LEDGER_MIRROR_ROOT","KL_SAFETY_LEDGER_KEY"].every(name=>!!process.env[name])) return {status:"unconfigured"};
  return observe(async()=> {
    const latest=await readLatestCompletedBackup(db);
    return latest.status==="not_recorded"?latest:{status:"recorded",created_at:latest.createdAt,completed_at:latest.completedAt,db_bytes:latest.dbBytes,file_count:latest.fileCount,ledger_sequence:latest.ledgerSequence};
  });
}
/** Counts and bounded operational facts only. No collection creation, file writes or worker leases. */
export async function operationalHealth(db:Db,options:{scanner?:boolean}={}) {
  assertLocalEnvironment(db);const now=Date.now();
  const [schema,storage,scanner,workers,queues,files,restore,backup]=await Promise.all([
    observe(async()=>{await assertSchema(db);return {status:"ready",version:CURRENT_SCHEMA_VERSION};}),
    storageHealth(),scannerHealth(options.scanner===true,now),
    observe(async()=> {
      const rows=await db.collection("operational_writers").aggregate([
        {$match:{state:"running"}},{$group:{_id:known("$kind",WRITER_KINDS),count:{$sum:1},oldest_heartbeat:{$min:"$heartbeat_at"},newest_heartbeat:{$max:"$heartbeat_at"}}},{$sort:{_id:1}},
      ],{maxTimeMS:10000}).toArray();
      return {status:"observed",process_liveness:"not_verified",registered_running:rows.reduce((sum,row)=>sum+row.count,0),kinds:rows.map(row=>({kind:row._id,count:row.count,oldest_heartbeat_age_ms:age(row.oldest_heartbeat,now),newest_heartbeat_age_ms:age(row.newest_heartbeat,now)}))};
    }),
    observe(async()=> {
      const rows=await db.collection("outbox_events").aggregate([
        {$match:{status:{$in:queueStates}}},{$group:{_id:{consumer:known("$target_consumer",consumers),state:"$status"},count:{$sum:1},oldest:{$min:"$created_at"}}},
      ],{maxTimeMS:10000}).toArray();
      const names=[...consumers,...(rows.some(row=>row._id.consumer==="unknown")?["unknown"]:[])];
      return {status:"observed",consumers:names.map(consumer=>({consumer,states:queueStates.map(state=>{const row=rows.find(value=>value._id.consumer===consumer&&value._id.state===state);return {state,count:row?.count??0,oldest_age_ms:row?age(row.oldest,now):null};})}))};
    }),
    observe(async()=> {
      const rows=await db.collection("file_resources").aggregate([
        {$group:{_id:{status:known("$status",fileStates),scan_status:known("$scan_status",scanStates)},count:{$sum:1},bytes:{$sum:{$ifNull:["$size",0]}},oldest:{$min:"$created_at"}}},{$sort:{"_id.status":1,"_id.scan_status":1}},
      ],{maxTimeMS:10000}).toArray();
      return {status:"observed",metadata_only:true,groups:rows.map(row=>({status:row._id.status,scan_status:row._id.scan_status,count:row.count,recorded_bytes:row.bytes,oldest_age_ms:age(row.oldest,now)}))};
    }),
    observe(async()=> {
      const run=await db.collection("backup_restore_runs").findOne({},{sort:{updated_at:-1},projection:{_id:0,status:1,created_at:1,updated_at:1,checks:1},maxTimeMS:10000});
      if(!run) return {status:"not_recorded"};
      return {status:"recorded",outcome:["quarantined","ready","released","failed"].includes(run.status)?run.status:"unknown",created_at:run.created_at instanceof Date?run.created_at:null,updated_at:run.updated_at instanceof Date?run.updated_at:null,checks:Object.fromEntries(["schema","files","ledger","identities","smoke"].map(key=>[key,run.checks?.[key]===true]))};
    }),
    backupHealth(db),
  ]);
  return {checked_at:new Date(now),schema,storage,scanner,workers,queues,files,backup:{scope:"registered_environment",last_success:backup,latest_restore:restore}};
}
