import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, lstat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { MongoClient, type Db, type Document } from "mongodb";
import { assertWindowsPrivateDirectory } from "../security/private-directory";
import { assertLocalEnvironment, requireActor, requireUuid } from "./contracts";
import { acquireWriter, drainEnvironment, enterMaintenance, inspectOperations, leaveMaintenance, registerEnvironment, releaseRestoredLocal } from "./control";
import { reconcileSafetyIntent, releaseOwnedLedgerLock } from "./ledger";
import { setFileHold } from "../files/files.service";
import { operationalHealth } from "./health";

async function privateTokenPath(path:string) {
  if(!isAbsolute(path)) throw new Error("OPERATIONS_PRIVATE_TOKEN_PATH_REQUIRED");
  const parent=dirname(path),stat=await lstat(parent);
  if(!stat.isDirectory()||stat.isSymbolicLink()) throw new Error("OPERATIONS_PRIVATE_TOKEN_PATH_REQUIRED");
  if(process.platform==="win32") await assertWindowsPrivateDirectory(parent);
  else if((stat.mode&0o077)!==0||stat.uid!==process.getuid?.()) throw new Error("OPERATIONS_PRIVATE_TOKEN_PATH_REQUIRED");
}
async function readToken(path:string) {
  await privateTokenPath(path); const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try { const stat=await handle.stat(); if(!stat.isFile()||stat.size!==36||(process.platform!=="win32"&&(stat.mode&0o077)!==0)) throw new Error("OPERATIONS_TOKEN_FILE_INVALID"); const token=await handle.readFile("utf8"); requireUuid(token); return token; }
  finally { await handle.close(); }
}
const launches:Record<string,{path:string;args:string[]}>= {
  api:{path:"../main.js",args:[]},files:{path:"../files/worker.js",args:["run"]},assessment:{path:"../assessment/worker.js",args:["run"]},learning:{path:"../learning/worker.js",args:["run"]},reading:{path:"../learning/reading-cleanup.js",args:[]},
};
async function launchControlledCommand(db:Db,launch:{path:string;args:string[]},terminateOnSignal:boolean):Promise<{exit_code:number}> {
  const token=randomUUID();
  const child=spawn(process.execPath,[resolve(__dirname,launch.path),...launch.args],{shell:false,stdio:"inherit",env:{...process.env,KL_WRITER_LAUNCH_TOKEN:token,KL_OPERATION_LAUNCH_TOKEN:token}});
  let stopFailure=false,stopRequested=false,signaling=false,stopInFlight=Promise.resolve();
  const signalStop=()=> {
    if(signaling) return;signaling=true;
    stopInFlight=db.collection<Document>("operational_writers").updateMany({token,state:"running"},{$set:{shutdown_nonce:randomUUID()}}).then(()=>{}).catch(()=>{stopFailure=true;}).finally(()=>{signaling=false;});
  };
  const stop=()=> {
    stopRequested=true;
    if(terminateOnSignal) {
      // Only signal the ChildProcess this controller created; never resolve or kill a stored PID.
      if(child.exitCode===null&&child.signalCode===null) child.kill("SIGTERM");
    } else signalStop();
  };
  const stopTimer=setInterval(()=>{if(stopRequested&&!terminateOnSignal) signalStop();},200);stopTimer.unref();
  process.on("SIGINT",stop); process.on("SIGTERM",stop);
  const stopMessage=(message:unknown)=>{if(message==="operations.stop") stop();};
  process.on("message",stopMessage);
  try {
    const code=await new Promise<number>((resolveExit,reject)=>{child.once("error",()=>reject(new Error("OPERATIONS_CHILD_START_FAILED")));child.once("exit",code=>resolveExit(code??1));});
    // This acknowledgement is based on the owned ChildProcess exit event, never a PID or heartbeat heuristic.
    const environmentId=process.env.KL_ENVIRONMENT_ID;
    if(environmentId) await releaseOwnedLedgerLock(environmentId,token);
    await db.collection<Document>("operational_writers").updateMany({token,pid:child.pid,state:"running"},{$set:{state:"stopped",stopped_at:new Date(),heartbeat_at:new Date()}});
    if(stopFailure) throw new Error("OPERATIONS_STOP_REQUEST_FAILED");
    return {exit_code:code};
  } finally { clearInterval(stopTimer);process.off("SIGINT",stop);process.off("SIGTERM",stop);process.off("message",stopMessage);await stopInFlight; }
}
export async function launchControlledWriter(db:Db,kind:string):Promise<{exit_code:number}> {
  const launch=launches[kind];if(!launch) throw new Error("OPERATIONS_LAUNCH_KIND_INVALID");
  return launchControlledCommand(db,launch,false);
}
export async function runOperations(argv=process.argv.slice(2)):Promise<void> {
  const [command,...args]=argv;
  const accepted:Record<string,string[]>= {
    register:["environment-id","actor","reason","file-root"],inspect:[],drain:["actor","reason","expected-revision"],maintenance:["actor","reason","expected-revision","token-file"],resume:["actor","reason","token-file"],"ledger-reconcile":["actor","reason","token-file","operation-id","decision"],"release-local":["actor","reason","expected-revision","restore-id","manifest-hash","ledger-sequence"],wait:["timeout-ms"],launch:["kind","actor","reason"],"file-hold":["actor","reason","file-id","hold"],
    "privacy-execute":["request-id","actor","reason"],"backup-run":["operation","file","restore-id","actor","reason"],
    health:["scanner"],
  };
  if(!Object.hasOwn(accepted,command)) throw new Error("OPERATIONS_COMMAND_INVALID");
  const flags:Record<string,string>={};
  for(let index=0;index<args.length;index+=2) { const key=args[index].slice(2),value=args[index+1]; if(!args[index].startsWith("--")||!accepted[command].includes(key)||Object.hasOwn(flags,key)||!value) throw new Error("OPERATIONS_ARGUMENT_INVALID"); flags[key]=value; }
  const required=(name:string)=>{ if(!flags[name]) throw new Error("OPERATIONS_ARGUMENT_REQUIRED"); return flags[name]; };
  const integer=(name:string)=>{const value=required(name);if(!/^(0|[1-9][0-9]*)$/.test(value)||!Number.isSafeInteger(Number(value))) throw new Error("OPERATIONS_ARGUMENT_INVALID");return Number(value);};
  const actorInput=()=>{const input={actor:required("actor"),reason:required("reason")};requireActor(input);return input;};
  const uri=process.env.MONGODB_URI; if(!uri) throw new Error("OPERATIONS_DATABASE_REQUIRED");
  const client=new MongoClient(uri,{serverSelectionTimeoutMS:5000});
  try {
    await client.connect();const db=client.db();assertLocalEnvironment(db);let result:unknown;
    switch(command) {
      case "inspect": result=await inspectOperations(db);break;
      case "health": {
        if(flags.scanner!==undefined&&!['true','false'].includes(flags.scanner)) throw new Error("OPERATIONS_ARGUMENT_INVALID");
        result=await operationalHealth(db,{scanner:flags.scanner==="true"});break;
      }
      case "register":result=await registerEnvironment(client,db,{...actorInput(),environmentId:required("environment-id"),fileRoot:flags["file-root"]??null});break;
      case "drain":result=await drainEnvironment(client,db,{...actorInput(),expectedRevision:integer("expected-revision")});break;
      case "maintenance": {
        const path=required("token-file");await privateTokenPath(path);
        // Reserve the private destination before changing state; never print the capability.
        const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
        const created=await file.stat();let capabilityIssued=false;
        try { const maintenance=await enterMaintenance(client,db,{...actorInput(),expectedRevision:integer("expected-revision")});capabilityIssued=true;await file.writeFile(maintenance.token);await file.sync();result={environment_id:maintenance.environmentId,revision:maintenance.revision,mode:"maintenance"}; }
        finally {
          await file.close();
          if(!capabilityIssued) {const current=await lstat(path);if(current.dev===created.dev&&current.ino===created.ino&&current.size===0&&!current.isSymbolicLink()) await unlink(path);}
        }break;
      }
      case "resume":result=await leaveMaintenance(client,db,{...actorInput(),token:await readToken(required("token-file"))});break;
      case "ledger-reconcile": {
        const decision=required("decision");if(decision!=="commit"&&decision!=="abort") throw new Error("OPERATIONS_ARGUMENT_INVALID");
        await reconcileSafetyIntent(db,{...actorInput(),operationId:required("operation-id"),decision,maintenanceToken:await readToken(required("token-file"))});result={reconciled:true};break;
      }
      case "release-local":result=await releaseRestoredLocal(client,db,{...actorInput(),restoreId:required("restore-id"),expectedRevision:integer("expected-revision"),manifestHash:required("manifest-hash"),ledgerSequence:integer("ledger-sequence")});break;
      case "launch": {
        const input=actorInput(),kind=required("kind");if(!launches[kind]) throw new Error("OPERATIONS_LAUNCH_KIND_INVALID");
        const writer=await acquireWriter(db,"admin");
        try {await db.collection<Document & {_id:string}>("audit_events").insertOne({_id:randomUUID(),actor_id:input.actor,org_id:null,action:"operations.launch",resource_id:kind,reason:input.reason,request_id:randomUUID(),created_at:new Date()});}
        finally {await writer.release();}
        result=await launchControlledWriter(db,kind);break;
      }
      case "privacy-execute": {
        const input=actorInput(),requestId=required("request-id");requireUuid(requestId);requireUuid(process.env.KL_ENVIRONMENT_ID??"");
        result=await launchControlledCommand(db,{path:"../privacy/cli.js",args:["execute","--request-id",requestId,"--actor",input.actor,"--reason",input.reason]},true);break;
      }
      case "backup-run": {
        const input=actorInput(),operation=required("operation"),file=required("file");requireUuid(process.env.KL_ENVIRONMENT_ID??"");
        if(!["backup","restore","inspect","verify","release"].includes(operation)||!isAbsolute(file)) throw new Error("OPERATIONS_ARGUMENT_INVALID");
        if(["verify","release"].includes(operation)) requireUuid(required("restore-id"));
        else if(flags["restore-id"]) throw new Error("OPERATIONS_ARGUMENT_INVALID");
        const childArgs=[operation,"--file",file,...(flags["restore-id"]?["--restore-id",flags["restore-id"]]:[]),...(operation==="release"?["--actor",input.actor,"--reason",input.reason]:[])];
        result=await launchControlledCommand(db,{path:"../../../ops/system-backup.cjs",args:childArgs},true);break;
      }
      case "file-hold": {
        const hold=required("hold");if(!["true","false"].includes(hold)) throw new Error("OPERATIONS_ARGUMENT_INVALID");
        const writer=await acquireWriter(db,"admin");
        try {result=await setFileHold(client,db,{...actorInput(),fileId:required("file-id"),hold:hold==="true"});}
        finally {await writer.release();}break;
      }
      case "wait": {
        const timeout=integer("timeout-ms");if(timeout<1||timeout>600000) throw new Error("OPERATIONS_ARGUMENT_INVALID"); const end=Date.now()+timeout;
        while(await db.collection("operational_writers").countDocuments({state:"running"})) { if(Date.now()>=end) throw new Error("OPERATIONS_WRITERS_RUNNING");await new Promise(resolveWait=>setTimeout(resolveWait,200)); }
        result=await inspectOperations(db);break;
      }
    }
    process.stdout.write(JSON.stringify(result)+"\n");
    if(result&&typeof result==="object"&&"exit_code" in result&&typeof result.exit_code==="number"&&result.exit_code!==0) process.exitCode=result.exit_code;
  } finally {await client.close();}
}
if(require.main===module) void runOperations().catch(()=>{process.stderr.write("本地运维操作失败；环境保持阻断，请检查安全配置及 inspect 状态\n");process.exitCode=1;});
