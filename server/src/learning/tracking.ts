import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import type { AssessmentContext, SessionItem, Submission } from '../assessment/contracts';
import { databaseNow } from '../assessment/submission';
import type { BaseVersion, ContentKind } from '../content/contracts';
import { fail } from '../errors';
import { requireEvidenceSubject } from '../assessment/subject-access';
import { assertOperationalAccess } from '../operations/control';

type TrackingContext = Pick<AssessmentContext, 'orgId' | 'userId' | 'session'>;
interface TrackingConfig { _id:string; epoch:string; cutover_at:Date; tracking_ready:boolean; }
interface QuestionState {
  _id:string; org_id:string; user_id:string; question_id:string; epoch:string;
  first_session_item_id:string|null; first_seen_at:Date|null; feedback_seen:boolean;
  sealed_submission_id:string|null; revision:number; legacy_unknown:boolean; created_at:Date; updated_at:Date;
}
async function config(db:Db, ctx:TrackingContext):Promise<TrackingConfig> {
  if (!ctx.session.inTransaction()) fail(503, 'LEARNING_TRANSACTION_REQUIRED', '学情记录需要事务');
  await requireEvidenceSubject(db, ctx.session, ctx.userId);
  const row = await db.collection<TrackingConfig>('learning_tracking_config').findOne({_id:'tracking'}, {session:ctx.session});
  const marker = await db.collection('schema_migrations').findOne({version:5,status:'completed'}, {session:ctx.session,projection:{_id:1}});
  if (!row?.tracking_ready || !marker) fail(503, 'LEARNING_TRACKING_NOT_READY', '学情追踪尚未启用');
  return row;
}
export async function touchLearningScope(db:Db, ctx:TrackingContext, subjectId:string, change:boolean):Promise<void> {
  if (!ctx.session.inTransaction()) fail(503, 'LEARNING_TRANSACTION_REQUIRED', '学情记录需要事务');
  await assertOperationalAccess(db);
  const now = await databaseNow(db, ctx);
  await db.collection<{_id:string;org_id:string;subject_id:string}>('learning_scope_states').updateOne(
    {org_id:ctx.orgId, subject_id:subjectId},
    {$inc:{access_fence:1, eligibility_revision:change?1:0, catalog_revision:change?1:0}, $set:{updated_at:now}, $setOnInsert:{_id:randomUUID(),org_id:ctx.orgId,subject_id:subjectId,created_at:now}},
    {session:ctx.session,upsert:true});
}
export async function touchContentLearningScope(db:Db, ctx:TrackingContext, kind:ContentKind, version:BaseVersion, change:boolean):Promise<void> {
  const subject = kind === 'question' ? version.subject_id : (await db.collection<{_id:string;subject_id:string}>('textbooks').findOne({_id:version.textbook_id,org_id:ctx.orgId}, {session:ctx.session}))?.subject_id;
  if (typeof subject !== 'string') throw new Error('LEARNING_SCOPE_INTEGRITY_ERROR');
  await touchLearningScope(db, ctx, subject, change);
}
async function state(db:Db, ctx:TrackingContext, questionId:string, settings:TrackingConfig, now:Date):Promise<QuestionState> {
  const states = db.collection<QuestionState>('learning_question_states');
  const filter = {org_id:ctx.orgId,user_id:ctx.userId,question_id:questionId};
  const existing = await states.findOne(filter, {session:ctx.session});
  if (existing) {
    if (existing.epoch !== settings.epoch) throw new Error('LEARNING_EPOCH_MISMATCH');
    await states.updateOne({_id:existing._id,revision:existing.revision}, {$inc:{revision:1},$set:{updated_at:now}}, {session:ctx.session});
    return existing;
  }
  const user = await db.collection<{_id:string;created_at:Date}>('users').findOne({_id:ctx.userId}, {session:ctx.session});
  const question = await db.collection<{_id:string;created_at:Date}>('questions').findOne({_id:questionId,org_id:ctx.orgId}, {session:ctx.session});
  if (!user || !question) throw new Error('LEARNING_IDENTITY_INTEGRITY_ERROR');
  const legacy = !(user.created_at > settings.cutover_at || question.created_at > settings.cutover_at);
  const author = await db.collection('question_versions').findOne({org_id:ctx.orgId,question_id:questionId,$or:[{created_by:ctx.userId},{contributors:ctx.userId},{published_by:ctx.userId},{submitted_by:ctx.userId}]}, {session:ctx.session,projection:{_id:1}});
  const row:QuestionState = {_id:randomUUID(),...filter,epoch:settings.epoch,first_session_item_id:null,first_seen_at:null,feedback_seen:!!author,sealed_submission_id:null,revision:1,legacy_unknown:legacy,created_at:now,updated_at:now};
  await states.insertOne(row,{session:ctx.session});
  return row;
}
export async function reserveLearningContexts(db:Db, ctx:AssessmentContext, items:SessionItem[]):Promise<void> {
  const settings = await config(db,ctx), now = await databaseNow(db,ctx);
  for (const subject of [...new Set(items.map(item=>item.snapshot.subject_id))].sort()) await touchLearningScope(db,ctx,subject,false);
  for (const item of [...items].sort((a,b)=>a.snapshot.question_id.localeCompare(b.snapshot.question_id)||a._id.localeCompare(b._id))) {
    const row = await state(db,ctx,item.snapshot.question_id,settings,now);
    const qualification = row.legacy_unknown ? 'unknown' : row.first_session_item_id || row.feedback_seen ? 'repeated' : 'first';
    const reason = row.legacy_unknown ? 'legacy_unknown' : row.feedback_seen ? 'prior_feedback' : row.first_session_item_id ? 'repeated' : 'first_seen';
    item.learning_context = {epoch:settings.epoch,qualification,reason};
    if (!row.first_session_item_id) await db.collection<QuestionState>('learning_question_states').updateOne({_id:row._id},{$set:{first_session_item_id:item._id,first_seen_at:now}},{session:ctx.session});
  }
}
export async function sealLearningContexts(db:Db, ctx:AssessmentContext, submission:Submission, items:SessionItem[]):Promise<void> {
  const actual = {...ctx,userId:submission.user_id,memberId:submission.member_id};
  const settings = await config(db,actual), now = await databaseNow(db,actual);
  for (const item of [...items].sort((a,b)=>a.snapshot.question_id.localeCompare(b.snapshot.question_id)||a._id.localeCompare(b._id))) {
    const attempts = db.collection<{_id:string;org_id:string;submission_id:string;session_item_id:string}>('learning_attempt_contexts');
    const filter = {org_id:ctx.orgId,submission_id:submission._id,session_item_id:item._id};
    if (await attempts.findOne(filter,{session:ctx.session})) continue;
    const row = await state(db,actual,item.snapshot.question_id,settings,now);
    let qualification:'first'|'repeated'|'unknown'|'exposed' = 'unknown', reason = 'untracked_item';
    if (item.learning_context?.epoch === settings.epoch) {
      qualification = item.learning_context.qualification; reason = item.learning_context.reason;
      if (qualification === 'first') {
        if (row.first_session_item_id !== item._id || row.sealed_submission_id) { qualification='repeated'; reason='repeated'; }
        else if (row.feedback_seen) { qualification='exposed'; reason='prior_feedback'; }
      }
    }
    await attempts.insertOne({_id:randomUUID(),...filter,user_id:submission.user_id,member_id:submission.member_id,question_id:item.snapshot.question_id,subject_id:item.snapshot.subject_id,epoch:settings.epoch,qualification,reason,created_at:now,updated_at:now} as never,{session:ctx.session});
    if (row.first_session_item_id === item._id && !row.sealed_submission_id) await db.collection<QuestionState>('learning_question_states').updateOne({_id:row._id},{$set:{sealed_submission_id:submission._id}},{session:ctx.session});
  }
}
export async function recordLearningFeedback(db:Db, ctx:TrackingContext, questionIds:string[]):Promise<void> {
  if (!questionIds.length) return;
  const settings = await config(db,ctx), now = await databaseNow(db,ctx);
  for (const questionId of [...new Set(questionIds)].sort()) {
    const row = await state(db,ctx,questionId,settings,now);
    if (!row.feedback_seen) await db.collection<QuestionState>('learning_question_states').updateOne({_id:row._id},{$set:{feedback_seen:true,updated_at:now}},{session:ctx.session});
  }
}
