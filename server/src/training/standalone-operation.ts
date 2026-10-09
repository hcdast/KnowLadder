import { initializeStandaloneJournal } from './standalone-schema';
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { canonical } from '../content/dto';
import { createHash } from 'node:crypto';
type Handle = { scope: string; key: string; token: string; generation: number };
/** Internal journal. Business effects must independently be recoverable/idempotent. */
export class StandaloneOperation {
  constructor(private readonly db: Db) {}
  private col() { return this.db.collection('training_standalone_operations'); }
  async initialize() { await initializeStandaloneJournal(this.db, 'operations'); }
  async prepare(scope: string, key: string, input: unknown, steps: string[]) {
    if (!scope || scope.length > 256 || !/^[A-Za-z0-9_-]{8,128}$/.test(key) || !steps.length || steps.length > 20 || new Set(steps).size !== steps.length || steps.some(s => !/^[a-z][a-z0-9_-]{0,63}$/.test(s))) throw Error('STANDALONE_OPERATION_INPUT');
    const encoded = canonical(input);
    if (encoded.length > 65536) throw Error('STANDALONE_OPERATION_INPUT');
    const hash = createHash('sha256').update(encoded).digest('hex');
    // No request body persisted: module-specific recovery payload is a later contract.
    try { await this.col().insertOne({ scope, key, hash, steps, cursor: 0, state: 'pending', generation: 0, token: '', until: new Date(0) }); }
    catch (e) { if ((e as {code?: number}).code !== 11000) throw e; }
    const row = await this.col().findOne({scope,key});
    if (!row || row.hash !== hash || canonical(row.steps) !== canonical(steps)) throw Error('STANDALONE_OPERATION_CONFLICT');
    return {state:row.state, cursor:row.cursor};
  }
  async claim(scope: string, key: string): Promise<Handle|null> {
    const token=randomUUID();
    const row=await this.col().findOneAndUpdate({scope,key,state:{$in:['pending','recovering']},$expr:{$lte:['$until','$$NOW']}},
      [{$set:{state:'recovering',token,generation:{$add:['$generation',1]},until:{$add:['$$NOW',30000]}}}],{returnDocument:'after'});
    return row?{scope,key,token,generation:row.generation}:null;
  }
  async advance(handle: Handle, cursor: number, step: string) {
    if (!Number.isInteger(cursor)||cursor<0) throw Error('STANDALONE_OPERATION_INPUT');
    const result=await this.col().updateOne({...handle,state:'recovering',cursor,[`steps.${cursor}`]:step,$expr:{$gt:['$until','$$NOW']}},
      {$inc:{cursor:1}});
    if(result.modifiedCount!==1) throw Error('STANDALONE_OPERATION_STALE');
  }
  async checkpoint(handle: Handle) {
    const row = await this.col().findOne({...handle,state:'recovering',$expr:{$gt:['$until','$$NOW']}}, {projection:{_id:0,cursor:1,steps:1}});
    if (!row) throw Error('STANDALONE_OPERATION_STALE');
    return {cursor:row.cursor as number,next:row.steps[row.cursor] as string|undefined};
  }
  async renew(handle: Handle) {
    const result=await this.col().updateOne({...handle,state:'recovering',$expr:{$gt:['$until','$$NOW']}}, [{$set:{until:{$add:['$$NOW',30000]}}}]);
    if(result.matchedCount!==1) throw Error('STANDALONE_OPERATION_STALE');
  }
  /** Scoped gate only; all writers and post-read checks still need integration. */
  async assertReadable(scope: string) {
    if (!scope || scope.length>256) throw Error('STANDALONE_OPERATION_INPUT');
    if (await this.col().findOne({scope,state:{$ne:'completed'}},{projection:{_id:1}})) throw Error('STANDALONE_OPERATION_PENDING');
  }
  async acknowledge(handle: Handle, cursor: number, step: string) {
    if (!Number.isInteger(cursor)||cursor<0) throw Error('STANDALONE_OPERATION_INPUT');
    const row=await this.col().findOne({...handle,state:'recovering',[`steps.${cursor}`]:step,$expr:{$gt:['$until','$$NOW']}}, {projection:{_id:0,cursor:1}});
    if(!row || row.cursor<cursor) throw Error('STANDALONE_OPERATION_STALE');
    if(row.cursor>cursor) return;
    try {await this.advance(handle,cursor,step);}
    catch(e){
      const latest=await this.col().findOne({...handle,state:'recovering',[`steps.${cursor}`]:step,cursor:{$gt:cursor},$expr:{$gt:['$until','$$NOW']}},{projection:{_id:1}});
      if(!latest)throw e;
    }
  }
  async complete(handle: Handle) {
    const result=await this.col().updateOne({...handle,state:'recovering',$expr:{$and:[{$gt:['$until','$$NOW']},{$eq:['$cursor',{$size:'$steps'}]}]}},{$set:{state:'completed',until:new Date(0)}});
    if(result.modifiedCount!==1) throw Error('STANDALONE_OPERATION_STALE');
  }
  async needsReview(handle: Handle) {
    const result=await this.col().updateOne({...handle,state:'recovering',$expr:{$gt:['$until','$$NOW']}},{$set:{state:'needs-review',until:new Date(0)}});
    if(result.modifiedCount!==1) throw Error('STANDALONE_OPERATION_STALE');
  }
}