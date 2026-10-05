import type { Db, Document } from "mongodb";
export const WRITER_KINDS = ["api","files","assessment","learning","reading","admin","catalogue","migration","privacy"] as const;
export type WriterKind = typeof WRITER_KINDS[number];
export type OperationalMode = "unregistered"|"active"|"draining"|"maintenance"|"restore_quarantined";
export interface OperationalState extends Document {
  _id:string; environment_id:string|null; mode:OperationalMode; revision:number; access_fence:number;
  restore_id:string|null; maintenance_token:string|null; owner:string|null; updated_at:Date;
}
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function requireUuid(value:string):void { if(!UUID_PATTERN.test(value)) throw new Error("OPERATIONS_INVALID_ID"); }
export function requireActor(input:{actor:string;reason:string}):void {
  if(typeof input.actor!=="string"||!input.actor.trim()||input.actor.length>120||typeof input.reason!=="string"||!input.reason.trim()||input.reason.length>500||/[\x00-\x1f]/.test(input.actor+input.reason)) throw new Error("OPERATIONS_ACTOR_REASON_REQUIRED");
}
export function assertLocalEnvironment(db:Db,environmentId?:string):void {
  if(process.env.NODE_ENV==="production"||!/^kl_(test|restore)_[A-Za-z0-9_-]+$/.test(db.databaseName)) throw new Error("OPERATIONS_LOCAL_ONLY");
  const hosts=db.client.options.hosts;
  if(!hosts?.length||hosts.some(host=>!host.host||!["127.0.0.1","localhost","::1"].includes(host.host))) throw new Error("OPERATIONS_LOOPBACK_REQUIRED");
  if(environmentId!==undefined) { requireUuid(environmentId); if(process.env.KL_ENVIRONMENT_ID!==environmentId) throw new Error("OPERATIONS_ENVIRONMENT_MISMATCH"); }
}
export async function getOperationalState(db:Db):Promise<OperationalState> {
  const state=await db.collection<OperationalState>("operational_state").findOne({_id:"environment"});
  if(!state) throw new Error("OPERATIONS_STATE_MISSING");
  return state;
}

export function requireObjectId(value:string):void { if(!/^[0-9a-f]{24}$/.test(value)) throw new Error("OPERATIONS_INVALID_ID"); }
