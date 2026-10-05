import { newId } from "../database/object-id";
import { createHash, randomUUID } from 'node:crypto';
import { Decimal128, type Db } from 'mongodb';
import { fail } from '../errors';
import type { Answer, AssessmentContext, AssessmentSession, Correction, GradingRun, OutboxEvent, SessionItem, StudentProjectionState, Submission, SubmissionReceipt } from './contracts';
import { SCORING_CODE_VERSION, scoreCents, scoreText } from './scoring';
import { sealLearningContexts } from '../learning/tracking';
import { fenceEvidenceMember, requireEvidenceSubject } from './subject-access';

export async function databaseNow(db: Db, ctx: Pick<AssessmentContext, 'session'>): Promise<Date> {
  const [row] = await db.aggregate<{ now: Date }>([{ $documents: [{}] }, { $project: { _id: 0, now: '$$NOW' } }], { session: ctx.session }).toArray();
  if (!(row?.now instanceof Date)) throw new Error('DATABASE_TIME_UNAVAILABLE');
  return row.now;
}

export function eventRecord(orgId: string, submissionId: string, runId: string | null, revision: number, type: OutboxEvent['event_type'], now: Date): OutboxEvent {
  return { _id: newId(), org_id: orgId, created_at: now, updated_at: now, aggregate_type: type === 'AssessmentVisibilityChanged' ? 'submission_visibility' : 'submission', aggregate_id: submissionId, aggregate_version: revision, event_type: type, schema_version: 1, target_consumer: type === 'SubmissionAccepted' || type === 'RegradeRequested' ? 'grading_v1' : 'learning_projection_v1', payload: { submission_id: submissionId, ...(runId ? { grading_run_id: runId } : {}) }, status: 'pending', lease_owner: null, lease_token: null, lease_until: null, attempt: 0, available_at: now, processed_at: null, error_code: null };
}

export async function advanceProjection(db: Db, ctx: AssessmentContext, now: Date): Promise<void> {
  if (!await fenceEvidenceMember(db, ctx.session, ctx.orgId, ctx.memberId)) fail(410, 'SUBJECT_ERASED', '主体证据已不可用');
  await db.collection<StudentProjectionState>('student_projection_states').updateOne({ org_id: ctx.orgId, member_id: ctx.memberId }, { $inc: { projection_revision: 1 }, $set: { updated_at: now }, $setOnInsert: { _id: newId(), org_id: ctx.orgId, member_id: ctx.memberId, created_at: now } }, { session: ctx.session, upsert: true });
}

export type VisibilityState = 'pending' | 'regrading' | 'released' | 'withheld_access' | 'withheld_embargo';
export function visibilityFingerprint(state: VisibilityState): string {
  return createHash('sha256').update(state).digest('hex');
}

function receipt(row: AssessmentSession, submission: Submission, blocked: boolean): SubmissionReceipt {
  return { submission_id: submission._id, session_id: row._id, session_status: row.status, revision: row.revision, submitted_at: submission.submitted_at, grading_status: blocked ? 'needs_review' : 'pending', report_status: 'not_available' };
}

export async function createSubmission(db: Db, ctx: AssessmentContext, row: AssessmentSession, reason: 'manual' | 'deadline', blockedCode?: string): Promise<SubmissionReceipt> {
  await requireEvidenceSubject(db, ctx.session, row.user_id, ctx.orgId);
  const options = { session: ctx.session };
  const submissions = db.collection<Submission>('submissions');
  const existing = await submissions.findOne({ org_id: ctx.orgId, session_id: row._id }, options);
  if (existing) {
    const frozen = await db.collection<AssessmentSession>('sessions').findOne({ _id: row._id, org_id: ctx.orgId }, options);
    const initial = await db.collection<GradingRun>('grading_runs').findOne({ org_id: ctx.orgId, submission_id: existing._id, revision: 1 }, options);
    if (!frozen || !initial) throw new Error('SUBMISSION_INTEGRITY_ERROR');
    const accepted = await db.collection<OutboxEvent>('outbox_events').findOne({ org_id: ctx.orgId, aggregate_id: existing._id, event_type: 'SubmissionAccepted', aggregate_version: 1 }, options);
    if (!accepted) throw new Error('SUBMISSION_INTEGRITY_ERROR');
    return receipt(frozen, existing, accepted.status === 'failed' && accepted.attempt === 0);
  }
  const id = newId();
  const finalized = await db.collection<AssessmentSession>('sessions').findOneAndUpdate({ _id: row._id, org_id: ctx.orgId, status: 'in_progress', revision: row.revision, ...(reason === 'deadline' ? { mode: 'quiz', deadline_at: { $ne: null }, $expr: { $lte: ['$deadline_at', '$$NOW'] } } : { $expr: { $or: [{ $eq: ['$deadline_at', null] }, { $gt: ['$deadline_at', '$$NOW'] }] } }) }, [{ $set: { status: reason === 'deadline' ? 'expired' : 'submitted', revision: { $add: ['$revision', 1] }, submission_id: id, submitted_at: '$$NOW', updated_at: '$$NOW' } }], { ...options, returnDocument: 'after' });
  if (!finalized) {
    const now = await databaseNow(db, ctx);
    if (reason === 'manual' && row.deadline_at && row.deadline_at <= now) fail(409, 'SESSION_DEADLINE_PASSED', '考试已截止');
    fail(409, 'REVISION_CONFLICT', '会话修订或截止状态已变化');
  }
  const now = finalized.submitted_at!;
  const items = await db.collection<SessionItem>('session_items').find({ org_id: ctx.orgId, session_id: row._id }, options).sort({ position: 1 }).limit(51).toArray();
  if (items.length !== row.item_count || !items.length || items.length > 50) throw new Error('SUBMISSION_INTEGRITY_ERROR');
  const answers = await db.collection<Answer>('answers').find({ org_id: ctx.orgId, session_id: row._id }, options).limit(51).toArray();
  if (answers.some((answer) => !items.some((item) => item._id === answer.session_item_id))) throw new Error('SUBMISSION_INTEGRITY_ERROR');
  const byItem = new Map(answers.map((answer) => [answer.session_item_id, answer.answer]));
  const hash = createHash('sha256').update(JSON.stringify(items.map((item) => [item._id, byItem.get(item._id) ?? null]))).digest('hex');
  const maximum = items.reduce((total, item) => total + scoreCents(item.max_score), 0n);
  const status = blockedCode ? 'needs_review' : 'pending';
  const submission: Submission = { _id: id, org_id: ctx.orgId, created_at: now, updated_at: now, session_id: row._id, user_id: row.user_id, member_id: row.member_id, mode: row.mode, quiz_id: row.quiz_id, reason, submitted_at: now, answers_hash: hash, grading_status: status, revision: 1, effective_grading_revision: null, requested_grading_revision: 1, total_score: null, max_score: Decimal128.fromString(scoreText(maximum)), error_code: blockedCode ?? null, visibility_revision: 0, visibility_fingerprint: null };
  const run: GradingRun = { _id: newId(), org_id: ctx.orgId, created_at: now, updated_at: now, submission_id: id, revision: 1, status, reason, requested_by: ctx.userId, scoring_code_version: SCORING_CODE_VERSION, corrections: [], completed_at: blockedCode ? now : null, error_code: blockedCode ?? null };
  const event = eventRecord(ctx.orgId, id, run._id, 1, 'SubmissionAccepted', now);
  if (blockedCode) { event.status = 'failed'; event.error_code = blockedCode; }
  await sealLearningContexts(db, ctx, submission, items);
  await submissions.insertOne(submission, options);
  await db.collection<GradingRun>('grading_runs').insertOne(run, options);
  await db.collection<OutboxEvent>('outbox_events').insertOne(event, options);
  return receipt(finalized, submission, !!blockedCode);
}

export async function queueRegrade(db: Db, ctx: AssessmentContext, submission: Submission, corrections: Correction[], reason: string) {
  await requireEvidenceSubject(db, ctx.session, submission.user_id, ctx.orgId);
  const options = { session: ctx.session };
  const current = await db.collection<GradingRun>('grading_runs').findOne({ org_id: ctx.orgId, submission_id: submission._id, revision: submission.requested_grading_revision }, options);
  if (!current || current.status === 'pending' || current.status === 'running') fail(409, 'GRADING_IN_PROGRESS', '当前评分尚未终结');
  const revision = submission.requested_grading_revision + 1;
  const now = await databaseNow(db, ctx);
  const run: GradingRun = { _id: newId(), org_id: ctx.orgId, created_at: now, updated_at: now, submission_id: submission._id, revision, status: 'pending', reason, requested_by: ctx.userId, scoring_code_version: SCORING_CODE_VERSION, corrections, completed_at: null, error_code: null };
  const changed = await db.collection<Submission>('submissions').updateOne({ _id: submission._id, org_id: ctx.orgId, revision: submission.revision, requested_grading_revision: submission.requested_grading_revision }, { $set: { requested_grading_revision: revision, grading_status: 'pending', error_code: null, visibility_fingerprint: visibilityFingerprint('regrading'), updated_at: now }, $inc: { revision: 1, visibility_revision: 1 } }, options);
  if (changed.modifiedCount !== 1) fail(409, 'REVISION_CONFLICT', '提交修订已变化');
  await db.collection<GradingRun>('grading_runs').insertOne(run, options);
  await db.collection<OutboxEvent>('outbox_events').insertMany([eventRecord(ctx.orgId, submission._id, run._id, revision, 'RegradeRequested', now), eventRecord(ctx.orgId, submission._id, null, submission.visibility_revision + 1, 'AssessmentVisibilityChanged', now)], options);
  await advanceProjection(db, { ...ctx, memberId: submission.member_id }, now);
  return { grading_run_id: run._id, submission_id: submission._id, revision: submission.revision + 1, grading_status: 'pending' as const };
}
