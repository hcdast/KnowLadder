import { installShutdown, notifyReady, validateRuntimeFlags, finishRuntimeFailure } from '../runtime/process-lifecycle';
import { objectIdDatabase } from "../database/object-id";
import { newId } from "../database/object-id";
import { parseReconcileOptions, validateReconcileOptions, type ReconcileOptions } from '../assessment/reconcile-options';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { MongoClient, type ClientSession, type Db, type Document, type Filter } from 'mongodb';
import type { AssessmentContext, OutboxEvent, Submission } from '../assessment/contracts';
import { databaseNow } from '../assessment/submission';
import { assertSchema } from '../migrations/schema';
import { touchLearningScope } from './tracking';
import { calculateProjection } from './projection';
import { DAY_MS, RULE_VERSION, type Counts, type ProjectionBuild, type ProjectionHead } from './contracts';
import { currentLearningManifest } from './manifest';
import { acquireWriter, assertOperationalAccess, type WriterRegistration } from '../operations/control';
import { fenceEvidenceMember } from '../assessment/subject-access';
import { runInTxn } from '../database/txn';
import { assertAdministrationAccess } from '../administration/authorization';
import type { Member } from '../database/contracts';

type Row = Document & { _id:string };
type Target = { org_id:string; member_id:string; subject_id:string };
type Lease = Target & { token:string; event:OutboxEvent|null };
const LEASE_MS = 30000;
const CONSUMER = 'learning_projection_v1';
const collections = ['learning_projection_inputs','mastery_evidence','mastery_snapshots','mistake_entries','report_snapshots'];
export async function transaction<T>(db:Db, work:(session:ClientSession)=>Promise<T>):Promise<T> {
  await assertOperationalAccess(db);
  return runInTxn(db.client, work, { readConcern:{level:'snapshot'}, writeConcern:{w:'majority'}, readPreference:'primary', maxCommitTimeMS:10000 });
}
function context(target:Target, session:ClientSession):AssessmentContext { return {orgId:target.org_id, memberId:target.member_id, userId:'system:learning', capabilities:['learning:projection-worker'], session, requestId:randomUUID()}; }
function memberFilter(lease:Lease) { return {org_id:lease.org_id,member_id:lease.member_id,lease_token:lease.token,$expr:{$gt:['$lease_until','$$NOW']}}; }
function eventFilter(event:OutboxEvent) { return {_id:event._id,org_id:event.org_id,status:'running' as const,lease_token:event.lease_token,$expr:{$gt:['$lease_until','$$NOW']}}; }
function hash(value:unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
class AdministrationIsolated extends Error {}
function administrationBlocked(error: unknown) {
  return error instanceof AdministrationIsolated || (error instanceof Error &&
    ['Administration target is isolated pending explicit recovery',
      'Administration operation is unfinished for this target'].includes(error.message));
}
async function guardUser(db: Db, userId: string, orgId: string, session?: ClientSession) {
  try { await assertAdministrationAccess(db, userId, orgId, session); }
  catch (error) {
    if (administrationBlocked(error)) throw new AdministrationIsolated('PROJECTION_ADMINISTRATION_ISOLATED');
    throw error;
  }
}
async function guardMember(db: Db, orgId: string, memberId: string, session?: ClientSession) {
  const member = await db.collection<Member>('organization_members').findOne({ _id: memberId, org_id: orgId }, { session, projection: { user_id: 1 } });
  if (!member || typeof member.user_id !== 'string') throw new Error('PROJECTION_SUBJECT_MISSING');
  await guardUser(db, member.user_id, orgId, session);
}
async function guardLearningEvent(db: Db, event: OutboxEvent) {
  const submission = await db.collection<Submission>('submissions').findOne(
    { _id: event.payload.submission_id, org_id: event.org_id }, { projection: { user_id: 1 } });
  await guardUser(db, submission?.user_id ?? 'system:learning', event.org_id);
}
async function returnIsolatedClaim(db: Db, event: OutboxEvent, lease: Lease | null) {
  // Only our current leases may return their bookkeeping attempts. Never
  // publish or alter a subject's evidence while administration is isolated.
  await transaction(db, async session => {
    if (lease) await db.collection<Row>('student_projection_states').updateOne(
      { org_id: lease.org_id, member_id: lease.member_id, lease_token: lease.token },
      { $set: { lease_owner: null, lease_token: null, lease_until: null } }, { session });
    await db.collection<OutboxEvent>('outbox_events').updateOne(
      { _id: event._id, org_id: event.org_id, status: 'running', lease_token: event.lease_token }, [{
      $set: { status: 'pending', attempt: { $max: [0, { $subtract: ['$attempt', 1] }] },
        available_at: '$$NOW', lease_owner: null, lease_token: null, lease_until: null, updated_at: '$$NOW' },
    }], { session });
  });
}
const clearedFailure = {failure_attempts:0,retry_signature:null,retry_boundary_at:null,retry_input_revision:null,retry_eligibility_revision:null,retry_catalog_revision:null};
const NEVER = new Date('9999-12-31T23:59:59.999Z');
async function retryWatermark(db:Db,lease:Lease,session:ClientSession) {
  const {state,scope}=await lock(db,lease,session), now=await databaseNow(db,{session});
  let last=new Date(0), next:Date|null=null;
  const subjectLookup = {$lookup:{from:'session_items',let:{sid:'$session_id',org:'$org_id'},pipeline:[{$match:{$expr:{$and:[{$eq:['$session_id','$$sid']},{$eq:['$org_id','$$org']},{$eq:['$snapshot.subject_id',lease.subject_id]}]}}},{$limit:1},{$project:{_id:1}}],as:'subject_items'}};
  const queries:[string,Document[]][] = [
    ['submissions',[{$match:{org_id:lease.org_id,member_id:lease.member_id}},subjectLookup,{$match:{'subject_items.0':{$exists:true}}},{$project:{boundaries:{$map:{input:[0,7,30,90],as:'days',in:{$add:['$submitted_at',{$multiply:['$$days',DAY_MS]}]}}}}}]],
    ['quizzes',[{$match:{org_id:lease.org_id,subject_id:lease.subject_id}},{$project:{boundaries:['$release_at']}}]],
    ['question_versions',[{$match:{org_id:lease.org_id,subject_id:lease.subject_id}},{$project:{boundaries:[{$convert:{input:'$license.expires_at',to:'date',onError:null,onNull:null}}]}}]],
    ['textbook_editions',[{$match:{org_id:lease.org_id}},{$lookup:{from:'textbooks',localField:'textbook_id',foreignField:'_id',as:'book'}},{$match:{'book.subject_id':lease.subject_id,'book.org_id':lease.org_id}},{$project:{boundaries:[{$convert:{input:'$license.expires_at',to:'date',onError:null,onNull:null}}]}}]],
  ];
  for (const [name,pipeline] of queries) {
    const [dates]=await db.collection(name).aggregate<{past:Date;future:Date}>([...pipeline,{$unwind:'$boundaries'},{$match:{boundaries:{$type:'date'}}},{$group:{_id:null,past:{$max:{$cond:[{$lte:['$boundaries',now]},'$boundaries',new Date(0)]}},future:{$min:{$cond:[{$gt:['$boundaries',now]},'$boundaries',NEVER]}}}}],{session}).toArray();
    if (dates && dates.past>last) last=dates.past;
    if (dates && dates.future<NEVER && (!next || dates.future<next)) next=dates.future;
  }
  const revisions={retry_input_revision:state.projection_revision as number,retry_eligibility_revision:scope.eligibility_revision as number,retry_catalog_revision:scope.catalog_revision as number};
  return {...revisions,retry_signature:hash([revisions,last]),retry_boundary_at:next};
}
async function prepareRetry(db:Db,lease:Lease):Promise<boolean> {
  return transaction(db,async session=>{
    const watermark=await retryWatermark(db,lease,session);
    const head=await db.collection<ProjectionHead>('learning_projection_heads').findOne(partition(lease),{session});
    if (!head || head.retry_signature!==watermark.retry_signature) {
      if (head) await db.collection<ProjectionHead>('learning_projection_heads').updateOne({_id:head._id},{$set:{...watermark,failure_attempts:0}},{session});
      return true;
    }
    if (head.failure_attempts<5) return true;
    const now=await databaseNow(db,{session});
    if (lease.event && !(await db.collection<OutboxEvent>('outbox_events').updateOne(eventFilter(lease.event),{$set:{status:'failed',error_code:'RETRY_BUDGET_EXHAUSTED',updated_at:now,lease_owner:null,lease_token:null,lease_until:null}},{session})).matchedCount) throw new Error('STALE_LEASE');
    if (!(await db.collection<Row>('student_projection_states').updateOne(memberFilter(lease),{$set:{lease_owner:null,lease_token:null,lease_until:null}},{session})).matchedCount) throw new Error('STALE_LEASE');
    return false;
  });
}
async function lock(db:Db, lease:Lease, session:ClientSession) {
  if (!await fenceEvidenceMember(db, session, lease.org_id, lease.member_id)) throw new Error('SUBJECT_ERASED');
  const state = await db.collection<Row>('student_projection_states').findOneAndUpdate(memberFilter(lease), {$inc:{publication_fence:1}}, {session,returnDocument:'after'});
  if (!state) throw new Error('STALE_LEASE');
  if (lease.event && !(await db.collection<OutboxEvent>('outbox_events').updateOne(eventFilter(lease.event), {$set:{lease_owner:lease.event.lease_owner}}, {session})).matchedCount) throw new Error('STALE_LEASE');
  await touchLearningScope(db, context(lease,session), lease.subject_id, false);
  const scope = await db.collection<Row>('learning_scope_states').findOne({org_id:lease.org_id,subject_id:lease.subject_id},{session});
  if (!scope) throw new Error('MISSING_SCOPE');
  return {state,scope};
}
async function acquire(db:Db,target:Target,event:OutboxEvent|null):Promise<Lease|null> {
  const token = randomUUID();
  await guardMember(db, target.org_id, target.member_id);
  // Producers own input revisions. The consumer only acquires its independent publication lease.
  const state = await db.collection<Row>('student_projection_states').findOneAndUpdate({org_id:target.org_id,member_id:target.member_id,$or:[{lease_until:null},{lease_until:{$exists:false}},{$expr:{$lte:['$lease_until','$$NOW']}}]}, [{$set:{lease_owner:`learning:${process.pid}`,lease_token:token,lease_until:{$add:['$$NOW',LEASE_MS]},publication_fence:{$ifNull:['$publication_fence',0]}}}], {returnDocument:'after'});
  return state ? {...target,token,event} : null;
}
async function renew(db:Db,lease:Lease) {
  return transaction(db,async session => {
    await guardMember(db, lease.org_id, lease.member_id, session);
    if (!(await db.collection<Row>('student_projection_states').updateOne(memberFilter(lease),[{$set:{lease_until:{$add:['$$NOW',LEASE_MS]}}}],{session})).matchedCount) throw new Error('STALE_LEASE');
    if (lease.event && !(await db.collection<OutboxEvent>('outbox_events').updateOne(eventFilter(lease.event),[{$set:{lease_until:{$add:['$$NOW',LEASE_MS]}}}],{session})).matchedCount) throw new Error('STALE_LEASE');
  });
}
async function manifest(db:Db,lease:Lease,generation:string,session:ClientSession) {
  const {state} = await lock(db,lease,session);
  return currentLearningManifest(db, context(lease,session), lease.subject_id, generation, state.projection_revision as number);
}
async function acknowledge(db:Db,lease:Lease,session:ClientSession,now:Date) {
  if (lease.event) {
    await db.collection<Row>('consumer_receipts').updateOne({org_id:lease.org_id,consumer_name:CONSUMER,event_id:lease.event._id},{$setOnInsert:{_id:newId(),org_id:lease.org_id,consumer_name:CONSUMER,event_id:lease.event._id,created_at:now,updated_at:now}},{upsert:true,session});
    if (!(await db.collection<OutboxEvent>('outbox_events').updateOne(eventFilter(lease.event),{$set:{status:'processed',processed_at:now,updated_at:now,error_code:null,lease_owner:null,lease_token:null,lease_until:null}},{session})).matchedCount) throw new Error('STALE_LEASE');
  }
  if (!(await db.collection<Row>('student_projection_states').updateOne(memberFilter(lease),{$set:{lease_owner:null,lease_token:null,lease_until:null}},{session})).matchedCount) throw new Error('STALE_LEASE');
}
async function rebuild(db:Db,lease:Lease) {
  const generation = randomUUID();
  let leaseError:unknown = null, renewal:Promise<void>|null = null;
  const timer = setInterval(()=>{ if (!renewal) { renewal = renew(db,lease).catch(error=>{leaseError=error;}).finally(()=>{renewal=null;}); } },8000);
  const check = () => { if (leaseError) throw leaseError; };
  try {
    const fixed = await transaction(db,session=>manifest(db,lease,generation,session));
    const projected = calculateProjection(fixed.rows,fixed.now);
    if (!projected.reports.length) for (const period of ['7d','30d'] as const) projected.reports.push({_id:newId(),org_id:lease.org_id,member_id:lease.member_id,subject_id:lease.subject_id,generation,period,submission_count:0,attempt_count:0,correct_count:0,incorrect_count:0,unanswered_count:0,independent_question_count:0,numerator:'0',denominator:'0',created_at:fixed.now,updated_at:fixed.now});
    const counts:Counts = {inputs:fixed.inputs.length,evidence:fixed.rows.length,mastery:projected.mastery.length,mistakes:projected.mistakes.length,reports:projected.reports.length};
    const existing = await db.collection<ProjectionHead>('learning_projection_heads').findOne({...partition(lease)});
    let reuse = existing?.active_generation && existing.manifest_digest===fixed.digest;
    if (reuse) {
      const complete=await db.collection<ProjectionBuild>('learning_projection_builds').findOne({org_id:lease.org_id,generation:existing!.active_generation!,status:'complete',manifest_digest:fixed.digest});
      if (!complete) reuse=false;
      else for (let index=0;index<collections.length;index++) if (await db.collection(collections[index]).countDocuments({org_id:lease.org_id,generation:existing!.active_generation})!==Object.values(counts)[index]) reuse=false;
    }
    if (!reuse) {
      const build:ProjectionBuild = {_id:newId(),org_id:lease.org_id,member_id:lease.member_id,subject_id:lease.subject_id,rule_version:RULE_VERSION,generation,as_of:fixed.now,target_revision:fixed.revision,eligibility_revision:fixed.eligibility,catalog_revision:fixed.catalog,manifest_digest:fixed.digest,expected_counts:counts,actual_counts:{inputs:0,evidence:0,mastery:0,mistakes:0,reports:0},status:'building',lease_token:lease.token,created_at:fixed.now,updated_at:fixed.now};
      await transaction(db, async session => {
        await lock(db, lease, session);
        await db.collection<ProjectionBuild>('learning_projection_builds').insertOne(build, { session });
      });
      const batches = [fixed.inputs,fixed.rows,projected.mastery,projected.mistakes,projected.reports];
      for (let index=0;index<batches.length;index++) for (let offset=0;offset<batches[index].length;offset+=50) {
        check(); await renew(db,lease);
        await transaction(db, async session => {
          await lock(db, lease, session);
          await db.collection<Row>(collections[index]).insertMany(batches[index].slice(offset,offset+50), { session });
        });
      }
    }
    check();
    await transaction(db,async session=>{
      const current = await manifest(db,lease,generation,session);
      if (current.digest!==fixed.digest || fixed.publicationValidUntil && current.now>=fixed.publicationValidUntil) throw new Error('INPUT_CHANGED');
      const head = await db.collection<ProjectionHead>('learning_projection_heads').findOne(partition(lease),{session});
      if (reuse && (!head || head.active_generation!==existing!.active_generation || head.manifest_digest!==fixed.digest)) throw new Error('INPUT_CHANGED');
      if (reuse) {
        const complete = await db.collection<ProjectionBuild>('learning_projection_builds').findOne({org_id:lease.org_id,generation:existing!.active_generation!,status:'complete',manifest_digest:fixed.digest},{session});
        if (!complete) throw new Error('INCOMPLETE_GENERATION');
        for (let index=0;index<collections.length;index++) if (await db.collection(collections[index]).countDocuments({org_id:lease.org_id,generation:existing!.active_generation},{session})!==Object.values(counts)[index]) throw new Error('INCOMPLETE_GENERATION');
      }
      if (!reuse) {
        for (let index=0;index<collections.length;index++) if (await db.collection( collections[index]).countDocuments({org_id:lease.org_id,generation},{session})!==Object.values(counts)[index]) throw new Error('INCOMPLETE_GENERATION');
        if (!(await db.collection<ProjectionBuild>('learning_projection_builds').updateOne({org_id:lease.org_id,generation,status:'building',lease_token:lease.token},{$set:{status:'complete',actual_counts:counts,updated_at:current.now}},{session})).matchedCount) throw new Error('INCOMPLETE_GENERATION');
      }
      const publicationNow = await databaseNow(db,{session});
      if (current.publicationValidUntil && publicationNow >= current.publicationValidUntil || fixed.publicationValidUntil && publicationNow >= fixed.publicationValidUntil) throw new Error('INPUT_CHANGED');
      const nextCheck = new Date(Math.min(publicationNow.getTime()+60000, current.publicationValidUntil?.getTime() ?? Infinity));
      if (!reuse && head?.active_generation) await db.collection<Row>('learning_projection_retirements').insertOne({_id:newId(),org_id:lease.org_id,member_id:lease.member_id,subject_id:lease.subject_id,generation:head.active_generation,retired_at:publicationNow,created_at:publicationNow,updated_at:publicationNow},{session});
      await db.collection<ProjectionHead>('learning_projection_heads').updateOne(partition(lease),{$set:{...clearedFailure,active_generation:reuse?existing!.active_generation:generation,manifest_digest:fixed.digest,applied_revision:current.revision,eligibility_revision:current.eligibility,catalog_revision:current.catalog,next_check_at:nextCheck,rebuild_requested:false,error_code:null,updated_at:current.now},$setOnInsert:{_id:newId(),...partition(lease),created_at:current.now}},{upsert:true,session});
      await acknowledge(db,lease,session,current.now);
    });
  } catch (error) {
    await db.collection<ProjectionBuild>('learning_projection_builds').updateOne({org_id:lease.org_id,generation,status:'building',lease_token:lease.token},[{$set:{status:'abandoned',updated_at:'$$NOW'}}]);
    throw error;
  } finally { clearInterval(timer); if (renewal) await renewal; }
}
function partition(target:Target) { return {org_id:target.org_id,member_id:target.member_id,subject_id:target.subject_id,rule_version:RULE_VERSION}; }
async function fail(db:Db,event:OutboxEvent|null,lease:Lease|null,error:unknown) {
  const code = error instanceof Error && ['STALE_LEASE','INPUT_CHANGED','INPUT_LIMIT_EXCEEDED','INVALID_EVENT','INVALID_EVIDENCE','INCOMPLETE_GENERATION','DUPLICATE_FIRST_EVIDENCE'].includes(error.message) ? error.message : 'PROJECTION_FAILED';
  await transaction(db,async session=>{
    let exhausted=false;
    if (event && !await db.collection<OutboxEvent>('outbox_events').findOne(eventFilter(event),{session})) return;
    if (lease) {
      const state = await db.collection<Row>('student_projection_states').findOne(memberFilter(lease),{session});
      if (!state) return;
      if (!await fenceEvidenceMember(db, session, lease.org_id, lease.member_id)) {
        await db.collection<Row>('student_projection_states').updateOne(memberFilter(lease), {$set:{lease_owner:null,lease_token:null,lease_until:null}}, {session});
        if (event) await db.collection<OutboxEvent>('outbox_events').updateOne(eventFilter(event), [{$set:{status:'failed',error_code:'SUBJECT_ERASED',lease_owner:null,lease_token:null,lease_until:null,updated_at:'$$NOW'}}], {session});
        return;
      }
      const now = await databaseNow(db,{session});
      const watermark=await retryWatermark(db,lease,session);
      const head=await db.collection<ProjectionHead>('learning_projection_heads').findOne(partition(lease),{session});
      const attempts=Math.min(5,head?.retry_signature===watermark.retry_signature ? head.failure_attempts+1 : 1);
      exhausted=attempts>=5;
      await db.collection<ProjectionHead>('learning_projection_heads').updateOne(partition(lease),{$set:{...watermark,failure_attempts:attempts,rebuild_requested:true,error_code:code,next_check_at:exhausted ? watermark.retry_boundary_at??NEVER : new Date(now.getTime()+Math.min(60000,1000*2**attempts)),updated_at:now},$setOnInsert:{_id:newId(),...partition(lease),active_generation:null,manifest_digest:null,applied_revision:0,eligibility_revision:0,catalog_revision:0,created_at:now}},{session,upsert:true});
      if (!(await db.collection<Row>('student_projection_states').updateOne(memberFilter(lease),{$set:{lease_owner:null,lease_token:null,lease_until:null}},{session})).matchedCount) throw new Error('STALE_LEASE');
    }
    if (event && !(await db.collection<OutboxEvent>('outbox_events').updateOne(eventFilter(event),[{$set:{status:exhausted||event.attempt>=5||code==='INVALID_EVENT'?'failed':'pending',error_code:code,lease_owner:null,lease_token:null,lease_until:null,updated_at:'$$NOW',available_at:{$add:['$$NOW',Math.min(60000,1000*2**Math.min(event.attempt,6))]}}}],{session})).matchedCount) throw new Error('STALE_LEASE');
  }).catch(error=>{if (!(error instanceof Error) || error.message!=='STALE_LEASE') throw error;});
}
export async function processOne(db:Db):Promise<boolean> {
  await assertOperationalAccess(db);
  const filter: Filter<OutboxEvent> = {target_consumer:CONSUMER,event_type:{$in:['GradeFinalized','AssessmentVisibilityChanged']},
    $or:[{status:'pending',$expr:{$lte:['$available_at','$$NOW']}},{status:'running',$expr:{$lte:['$lease_until','$$NOW']}}]};
  let event: OutboxEvent | null = null;
  for await (const candidate of db.collection<OutboxEvent>('outbox_events').find(filter).sort({available_at:1,_id:1}).batchSize(50)) {
    try { await guardLearningEvent(db,candidate); }
    catch(error) { if (error instanceof AdministrationIsolated) continue; throw error; }
    event = await db.collection<OutboxEvent>('outbox_events').findOneAndUpdate({_id:candidate._id,...filter},
      [{$set:{status:'running',lease_owner:`learning:${process.pid}`,lease_token:randomUUID(),
        lease_until:{$add:['$$NOW',LEASE_MS]},attempt:{$add:['$attempt',1]},updated_at:'$$NOW'}}],
      {returnDocument:'after'});
    if (event) break;
  }
  if (!event) return false;
  let lease:Lease|null=null;
  try {
    const aggregateType = event.event_type==='AssessmentVisibilityChanged' ? 'submission_visibility' : 'submission';
    if (event.schema_version!==1 || event.aggregate_type!==aggregateType || event.aggregate_id!==event.payload.submission_id || (event.event_type==='GradeFinalized' && !event.payload.grading_run_id)) throw new Error('INVALID_EVENT');
    const submission = await db.collection<Submission>('submissions').findOne({_id:event.payload.submission_id,org_id:event.org_id});
    if (!submission) throw new Error('INVALID_EVENT');
    if (event.payload.grading_run_id && !await db.collection('grading_runs').findOne({_id:event.payload.grading_run_id as never,org_id:event.org_id,submission_id:submission._id})) throw new Error('INVALID_EVENT');
    const items = await db.collection<Row>('session_items').find({org_id:event.org_id,session_id:submission.session_id}).limit(51).toArray();
    const subjects = new Set(items.map(item=>item.snapshot.subject_id as string));
    if (!items.length || items.length>50 || subjects.size!==1) throw new Error('INVALID_EVIDENCE');
    lease = await acquire(db,{org_id:event.org_id,member_id:submission.member_id,subject_id:[...subjects][0]},event);
    if (!lease) {
      // Contention is not a failed projection attempt and must never exhaust another event's retries.
      await db.collection<OutboxEvent>('outbox_events').updateOne(eventFilter(event),[{$set:{status:'pending',attempt:{$subtract:['$attempt',1]},available_at:{$add:['$$NOW',1000]},lease_owner:null,lease_token:null,lease_until:null,updated_at:'$$NOW'}}]);
      return true;
    }
    if (await prepareRetry(db,lease)) await rebuild(db,lease);
  } catch(error) {
    // Isolation is not a projection failure and must not consume retry budget.
    if (administrationBlocked(error)) { await returnIsolatedClaim(db,event,lease); return false; }
    try { await fail(db,event,lease,error); }
    catch (failure) {
      if (administrationBlocked(failure)) { await returnIsolatedClaim(db,event,lease); return false; }
      throw failure;
    }
  }
  return true;
}
export async function processDue(db:Db):Promise<number> {
  await assertOperationalAccess(db);
  let count=0, claimed=0;
  const heads = db.collection<ProjectionHead>('learning_projection_heads').aggregate<ProjectionHead>([
    {$match:{rule_version:RULE_VERSION}},
    {$lookup:{from:'student_projection_states',let:{org:'$org_id',member:'$member_id'},pipeline:[{$match:{$expr:{$and:[{$eq:['$org_id','$$org']},{$eq:['$member_id','$$member']}]}}},{$project:{projection_revision:1}}],as:'state'}},
    {$lookup:{from:'learning_scope_states',let:{org:'$org_id',subject:'$subject_id'},pipeline:[{$match:{$expr:{$and:[{$eq:['$org_id','$$org']},{$eq:['$subject_id','$$subject']}]}}},{$project:{eligibility_revision:1,catalog_revision:1}}],as:'scope'}},
    {$match:{$expr:{$or:[
      {$and:[{$lt:['$failure_attempts',5]},{$or:[{$and:[{$eq:['$rebuild_requested',true]},{$eq:['$error_code',null]}]},{$lte:['$next_check_at','$$NOW']}]}]},
      {$and:[{$gte:['$failure_attempts',5]},{$or:[{$ne:['$retry_input_revision',{$ifNull:[{$arrayElemAt:['$state.projection_revision',0]},0]}]},{$ne:['$retry_eligibility_revision',{$ifNull:[{$arrayElemAt:['$scope.eligibility_revision',0]},0]}]},{$ne:['$retry_catalog_revision',{$ifNull:[{$arrayElemAt:['$scope.catalog_revision',0]},0]}]},{$and:[{$ne:['$retry_boundary_at',null]},{$lte:['$retry_boundary_at','$$NOW']}]}]}]}
    ]}}},{$sort:{next_check_at:1,_id:1}},{$unset:['state','scope']}
  ]).batchSize(50);
  // A blocked prefix must not starve later subjects; bound work, not inspection.
  for await (const head of heads) {
    if (claimed >= 50) break;
    let lease:Lease|null=null;
    try {
      lease=await acquire(db,head,null);
      if (lease) {
        claimed++;
        if (await prepareRetry(db,lease)) { await rebuild(db,lease); count++; }
      }
    } catch(error) {
      if (administrationBlocked(error)) continue;
      try { await fail(db,null,lease,error); }
      catch (failure) { if (!administrationBlocked(failure)) throw failure; }
    }
  }
  return count;
}
export async function reconcile(db:Db,options:ReconcileOptions={}) {
  await assertOperationalAccess(db);
  validateReconcileOptions(options);
  const report={apply:!!options.apply,missing_heads:0,stale_heads:0,missing_events:0,incomplete_builds:0,incomplete_generations:0,expired_leases:0,requested:0};
  report.expired_leases=await db.collection('student_projection_states').countDocuments({lease_token:{$ne:null},$expr:{$lte:['$lease_until','$$NOW']}});
  report.incomplete_builds=await db.collection('learning_projection_builds').countDocuments({status:{$ne:'complete'}});
  report.missing_events = (await db.collection<Submission>('submissions').aggregate<{count:number}>([{$match:{effective_grading_revision:{$ne:null}}},{$lookup:{from:'outbox_events',let:{id:'$_id',org:'$org_id',revision:'$effective_grading_revision'},pipeline:[{$match:{$expr:{$and:[{$eq:['$org_id','$$org']},{$eq:['$aggregate_id','$$id']},{$eq:['$aggregate_version','$$revision']},{$eq:['$event_type','GradeFinalized']},{$eq:['$target_consumer',CONSUMER]}]}}},{$limit:1}],as:'events'}},{$match:{'events.0':{$exists:false}}},{$count:'count'}]).toArray())[0]?.count ?? 0;
  for await (const target of db.collection<Submission>('submissions').aggregate<Target>([{$lookup:{from:'session_items',localField:'session_id',foreignField:'session_id',as:'items'}},{$unwind:'$items'},{$match:{$expr:{$eq:['$org_id','$items.org_id']}}},{$group:{_id:{org_id:'$org_id',member_id:'$member_id',subject_id:'$items.snapshot.subject_id'}}},{$replaceWith:'$_id'}]).batchSize(50)) {
    const head=await db.collection<ProjectionHead>('learning_projection_heads').findOne(partition(target));
    const state=await db.collection<Row>('student_projection_states').findOne({org_id:target.org_id,member_id:target.member_id});
    const scope=await db.collection<Row>('learning_scope_states').findOne({org_id:target.org_id,subject_id:target.subject_id});
    const now=await transaction(db,session=>databaseNow(db,{session}));
    let incomplete=false;
    if (head?.active_generation) {
      const build=await db.collection<ProjectionBuild>('learning_projection_builds').findOne({org_id:head.org_id,generation:head.active_generation,status:'complete'});
      incomplete=!build;
      if (build) for (let index=0;index<collections.length;index++) if (await db.collection(collections[index]).countDocuments({org_id:head.org_id,generation:head.active_generation})!==Object.values(build.expected_counts)[index]) incomplete=true;
      if (incomplete) report.incomplete_generations++;
    }
    const stale=!head || incomplete || head.rebuild_requested || head.applied_revision!==state?.projection_revision || head.eligibility_revision!==(scope?.eligibility_revision??0) || head.catalog_revision!==(scope?.catalog_revision??0) || head.next_check_at<=now;
    if (!head) report.missing_heads++; else if (stale) report.stale_heads++;
    if (!stale || !options.apply) continue;
    const requested = await transaction(db,async session=>{
      if (!await fenceEvidenceMember(db, session, target.org_id, target.member_id)) return false;
      const at=await databaseNow(db,{session});
      await db.collection<ProjectionHead>('learning_projection_heads').updateOne(partition(target),{$set:{...clearedFailure,rebuild_requested:true,updated_at:at,next_check_at:at,error_code:null},$setOnInsert:{_id:newId(),...partition(target),active_generation:null,manifest_digest:null,applied_revision:0,eligibility_revision:0,catalog_revision:0,created_at:at}},{session,upsert:true});
      await db.collection<Row>('audit_events').insertOne({_id:newId(),org_id:target.org_id,actor_id:options.actor!,action:'learning.reconcile',resource_type:'student_projection',resource_id:target.member_id,owner_type:null,owner_version_id:null,revision_before:null,revision_after:null,access_revision_before:null,access_revision_after:null,reason:options.reason!,request_id:randomUUID(),created_at:at},{session});
      return true;
    }); if (requested) report.requested++;
  }
  return report;
}
export async function cleanup(db:Db):Promise<number> {
  await assertOperationalAccess(db);
  let removed=0;
  const builds=db.collection<ProjectionBuild>('learning_projection_builds').find({$or:[{status:'abandoned',$expr:{$lte:['$updated_at',{$subtract:['$$NOW',DAY_MS]}]}},{status:{$in:['complete','building']},$expr:{$lte:['$updated_at',{$subtract:['$$NOW',7*DAY_MS]}]}}]}).sort({updated_at:1,_id:1}).batchSize(50);
  for await (const build of builds) {
    const deleted = await transaction(db,async session=>{
      await guardMember(db, build.org_id, build.member_id, session);
      // Same member document as publication: cleanup cannot race a new active pointer.
      const state=await db.collection<Row>('student_projection_states').findOneAndUpdate({org_id:build.org_id,member_id:build.member_id,$or:[{lease_until:null},{lease_until:{$exists:false}},{$expr:{$lte:['$lease_until','$$NOW']}}]},{$inc:{publication_fence:1}},{session,returnDocument:'after'});
      if (!state || await db.collection<ProjectionHead>('learning_projection_heads').findOne({org_id:build.org_id,active_generation:build.generation},{session})) return false;
      if (build.status==='complete' && !await db.collection<Row>('learning_projection_retirements').findOne({org_id:build.org_id,generation:build.generation,$expr:{$lte:['$retired_at',{$subtract:['$$NOW',7*DAY_MS]}]}},{session})) return false;
      for (const name of collections) await db.collection(name).deleteMany({org_id:build.org_id,generation:build.generation},{session});
      await db.collection<Row>('learning_projection_retirements').deleteOne({org_id:build.org_id,generation:build.generation},{session});
      await db.collection<ProjectionBuild>('learning_projection_builds').deleteOne({_id:build._id},{session}); return true;
    });
    if (deleted && ++removed>=50) break;
  }
  return removed;
}
async function main() {
  validateRuntimeFlags();
  const command = process.argv[2];
  if (
    !["run", "once", "reconcile", "cleanup"].includes(command) ||
    !process.env.MONGODB_URI
  )
    throw new Error("INVALID_WORKER_COMMAND");
  const reconcileOptions =
    command === "reconcile"
      ? parseReconcileOptions(process.argv.slice(3))
      : undefined;
  const client = new MongoClient(process.env.MONGODB_URI, {
    readPreference: "primary",
    writeConcern: { w: "majority" },
  });
  await client.connect();
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  const dispose = installShutdown(stop);
  let writer: WriterRegistration | undefined;
  try {
    const db = objectIdDatabase(client.db());
    await assertSchema(db);
    await assertOperationalAccess(db);
    if (command === "reconcile") {
      if (reconcileOptions!.apply) writer = await acquireWriter(db, "learning");
      console.log(JSON.stringify(await reconcile(db, reconcileOptions)));
      return;
    }
    writer = await acquireWriter(db, "learning");
    notifyReady();
    if (command === "cleanup") {
      console.log(JSON.stringify({ removed: await cleanup(db) }));
      return;
    }
    do {
      if (stopping || (await writer.stopRequested())) break;
      const processed = await processOne(db),
        due = await processDue(db);
      if (command === "once") {
        console.log(JSON.stringify({ processed, due }));
        break;
      }
      if (!processed && !due) await sleep(1000);
    } while (!stopping);
  } finally {
    try {
      await writer?.release();
    } finally {
      try {
        await client.close();
      } finally {
        dispose();
      }
    }
  }
}
if (require.main === module)
  main().catch((error) => {
    finishRuntimeFailure("learning-worker", error);
  });
