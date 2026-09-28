import { parseReconcileOptions, validateReconcileOptions, type ReconcileOptions } from './reconcile-options';
import { HttpException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Decimal128, MongoClient, type ClientSession, type Db, type Document } from 'mongodb';
import { AssessmentSources } from '../content/assessment-sources';
import { assertSchema } from '../migrations/schema';
import type { Answer, AssessmentContext, AssessmentSession, GradingResult, GradingRun, OutboxEvent, Quiz, SessionItem, Submission } from './contracts';
import { advanceProjection, createSubmission, databaseNow, eventRecord, visibilityFingerprint } from './submission';
import { scoreAnswer, scoreCents, scoreText } from './scoring';
import { studentAssessmentEvidence } from './student-evidence';
import { acquireWriter, assertOperationalAccess, type WriterRegistration } from '../operations/control';
import { fenceEvidenceSubject, requireEvidenceSubject } from './subject-access';

const LEASE_MS = 30000;
const MAX_ATTEMPTS = 5;
class StaleLease extends Error {}
class InvalidEvidence extends Error {}

async function transaction<T>(db: Db, work: (session: ClientSession) => Promise<T>): Promise<T> {
  await assertOperationalAccess(db);
  const session = db.client.startSession();
  try { return await session.withTransaction(() => work(session), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary', maxCommitTimeMS: 10000 }); }
  finally { await session.endSession(); }
}
function context(event: { org_id: string }, session: ClientSession, memberId = ''): AssessmentContext {
  return { orgId: event.org_id, userId: 'system:assessment', memberId, capabilities: ['assessment:worker'], session, requestId: randomUUID() };
}
function leaseFilter(event: OutboxEvent) {
  return { _id: event._id, org_id: event.org_id, status: 'running' as const, lease_token: event.lease_token, $expr: { $gt: ['$lease_until', '$$NOW'] } };
}
async function claim(db: Db): Promise<OutboxEvent | null> {
  return db.collection<OutboxEvent>('outbox_events').findOneAndUpdate({ target_consumer: 'grading_v1', event_type: { $in: ['SubmissionAccepted', 'RegradeRequested'] }, $or: [{ status: 'pending', $expr: { $lte: ['$available_at', '$$NOW'] } }, { status: 'running', $expr: { $lte: ['$lease_until', '$$NOW'] } }] }, [{ $set: { status: 'running', lease_owner: `assessment:${process.pid}`, lease_token: randomUUID(), lease_until: { $add: ['$$NOW', LEASE_MS] }, attempt: { $add: ['$attempt', 1] }, updated_at: '$$NOW' } }], { sort: { available_at: 1, _id: 1 }, returnDocument: 'after' });
}
async function renew(db: Db, event: OutboxEvent): Promise<boolean> {
  const changed = await db.collection<OutboxEvent>('outbox_events').updateOne(leaseFilter(event), [{ $set: { lease_until: { $add: ['$$NOW', LEASE_MS] }, updated_at: '$$NOW' } }]);
  return changed.modifiedCount === 1;
}
function validTarget(event: OutboxEvent): boolean {
  return event.aggregate_type === 'submission' && event.aggregate_id === event.payload.submission_id && event.schema_version === 1 && event.target_consumer === 'grading_v1' && !!event.payload.grading_run_id;
}
async function evidence(db: Db, event: OutboxEvent, session?: ClientSession) {
  if (!validTarget(event)) throw new InvalidEvidence();
  const options = session ? { session } : {};
  const submission = await db.collection<Submission>('submissions').findOne({ _id: event.payload.submission_id, org_id: event.org_id }, options);
  const run = await db.collection<GradingRun>('grading_runs').findOne({ _id: event.payload.grading_run_id, submission_id: event.payload.submission_id, org_id: event.org_id, revision: event.aggregate_version }, options);
  if (!submission || !run || event.aggregate_id !== submission._id || event.schema_version !== 1) throw new InvalidEvidence();
  const row = await db.collection<AssessmentSession>('sessions').findOne({ _id: submission.session_id, org_id: event.org_id }, options);
  const items = await db.collection<SessionItem>('session_items').find({ session_id: submission.session_id, org_id: event.org_id }, options).sort({ position: 1 }).limit(51).toArray();
  const answers = await db.collection<Answer>('answers').find({ session_id: submission.session_id, org_id: event.org_id }, options).limit(51).toArray();
  if (!row || row.submission_id !== submission._id || !['submitted', 'expired'].includes(row.status) || !items.length || items.length !== row.item_count || items.length > 50 || answers.some((answer) => !items.some((item) => item._id === answer.session_item_id))) throw new InvalidEvidence();
  const byItem = new Map(answers.map((answer) => [answer.session_item_id, answer.answer]));
  const hash = createHash('sha256').update(JSON.stringify(items.map((item) => [item._id, byItem.get(item._id) ?? null]))).digest('hex');
  if (hash !== submission.answers_hash || new Set(run.corrections.map((correction) => correction.session_item_id)).size !== run.corrections.length || run.corrections.some((correction) => !items.some((item) => item._id === correction.session_item_id && item.snapshot.question_id === correction.snapshot.question_id && item.snapshot.question_type === correction.snapshot.question_type && item.snapshot.display_digest === correction.snapshot.display_digest))) throw new InvalidEvidence();
  return { submission, run, row, items, byItem };
}
type Evidence = Awaited<ReturnType<typeof evidence>>;
async function sourceFence(db: Db, ctx: AssessmentContext, data: Evidence) {
  await requireEvidenceSubject(db, ctx.session, data.submission.user_id);
  const sources = new AssessmentSources(db);
  if (data.row.textbook_edition_id) await sources.textbook(ctx, data.row.textbook_edition_id, false);
  const versions = [...new Set([...data.items.map((item) => item.snapshot.question_version_id), ...data.run.corrections.map((correction) => correction.snapshot.question_version_id)])].sort();
  for (const version of versions) await sources.question(ctx, version, false);
}
async function endStale(db: Db, event: OutboxEvent, run: GradingRun, session: ClientSession, now: Date) {
  await db.collection<GradingRun>('grading_runs').updateOne({ _id: run._id, org_id: event.org_id, status: { $in: ['pending', 'running'] } }, { $set: { status: 'failed', error_code: 'STALE_GRADING_TARGET', completed_at: now, updated_at: now } }, { session });
  await db.collection<OutboxEvent>('outbox_events').updateOne(leaseFilter(event), { $set: { status: 'failed', error_code: 'STALE_GRADING_TARGET', lease_owner: null, lease_token: null, lease_until: null, updated_at: now } }, { session });
}
async function complete(db: Db, event: OutboxEvent, calculated: Array<{ session_item_id: string; score: Decimal128; max_score: Decimal128; verdict: GradingResult['verdict'] }>, expectedRevision: number) {
  await transaction(db, async (session) => {
    if (!await db.collection<OutboxEvent>('outbox_events').findOne(leaseFilter(event), { session })) throw new StaleLease();
    const data = await evidence(db, event, session);
    const ctx = context(event, session, data.submission.member_id);
    const now = await databaseNow(db, ctx);
    if (data.submission.requested_grading_revision !== data.run.revision) { await endStale(db, event, data.run, session, now); return; }
    if (data.submission.revision !== expectedRevision || !['pending', 'running'].includes(data.run.status)) throw new StaleLease();
    await sourceFence(db, ctx, data);
    if (calculated.length !== data.items.length) throw new InvalidEvidence();
    const total = calculated.reduce((sum, result) => sum + scoreCents(result.score), 0n);
    const maximum = calculated.reduce((sum, result) => sum + scoreCents(result.max_score), 0n);
    if (maximum !== scoreCents(data.submission.max_score)) throw new InvalidEvidence();
    const changed = await db.collection<Submission>('submissions').updateOne({ _id: data.submission._id, org_id: event.org_id, revision: expectedRevision, requested_grading_revision: data.run.revision }, { $set: { grading_status: 'completed', effective_grading_revision: data.run.revision, total_score: Decimal128.fromString(scoreText(total)), error_code: null, updated_at: now }, $inc: { revision: 1 } }, { session });
    if (changed.modifiedCount !== 1) throw new StaleLease();
    await db.collection<GradingResult>('grading_results').insertMany(calculated.map((result) => ({ _id: randomUUID(), org_id: event.org_id, created_at: now, updated_at: now, grading_run_id: data.run._id, ...result })), { session });
    await db.collection<GradingRun>('grading_runs').updateOne({ _id: data.run._id, org_id: event.org_id }, { $set: { status: 'completed', completed_at: now, error_code: null, updated_at: now } }, { session });
    await advanceProjection(db, ctx, now);
    await db.collection<OutboxEvent>('outbox_events').insertOne(eventRecord(event.org_id, data.submission._id, data.run._id, data.run.revision, 'GradeFinalized', now), { session });
    await db.collection<Document & { _id: string }>('consumer_receipts').insertOne({ _id: randomUUID(), org_id: event.org_id, consumer_name: 'grading_v1', event_id: event._id, created_at: now, updated_at: now }, { session });
    const finished = await db.collection<OutboxEvent>('outbox_events').updateOne(leaseFilter(event), { $set: { status: 'processed', processed_at: now, lease_owner: null, lease_token: null, lease_until: null, error_code: null, updated_at: now } }, { session });
    if (finished.modifiedCount !== 1) throw new StaleLease();
  });
}
function failure(error: unknown): { permanent: boolean; code: string } {
  if (error instanceof InvalidEvidence) return { permanent: true, code: 'INVALID_FROZEN_EVIDENCE' };
  if (error instanceof HttpException && error.getStatus() < 500) {
    const body = error.getResponse();
    const code = typeof body === 'object' && 'code' in body ? String(body.code) : 'CONTENT_UNAVAILABLE';
    return { permanent: true, code: /^[A-Z_]{1,80}$/.test(code) ? code : 'CONTENT_UNAVAILABLE' };
  }
  return { permanent: false, code: 'GRADING_DEPENDENCY_UNAVAILABLE' };
}
async function failEvent(db: Db, event: OutboxEvent, error: unknown, expectedRevision?: number) {
  if (error instanceof StaleLease) return;
  const problem = failure(error);
  await transaction(db, async (session) => {
    if (!await db.collection<OutboxEvent>('outbox_events').findOne(leaseFilter(event), { session })) return;
    // An invalid envelope must fail only itself, never the unrelated payload target.
    const submission = validTarget(event) ? await db.collection<Submission>('submissions').findOne({ _id: event.payload.submission_id, org_id: event.org_id }, { session }) : null;
    const run = submission ? await db.collection<GradingRun>('grading_runs').findOne({ _id: event.payload.grading_run_id, org_id: event.org_id, submission_id: event.payload.submission_id, revision: event.aggregate_version }, { session }) : null;
    const ctx = context(event, session, submission?.member_id);
    const now = await databaseNow(db, ctx);
    if (submission && !await fenceEvidenceSubject(db, session, submission.user_id)) {
      await db.collection<OutboxEvent>('outbox_events').updateOne(leaseFilter(event), { $set: { status: 'failed', error_code: 'SUBJECT_ERASED', lease_owner: null, lease_token: null, lease_until: null, updated_at: now } }, { session });
      return;
    }
    if (submission && run && submission.requested_grading_revision !== run.revision) { await endStale(db, event, run, session, now); return; }
    if (submission && expectedRevision !== undefined && submission.revision !== expectedRevision) return;
    const terminal = problem.permanent || event.attempt >= MAX_ATTEMPTS;
    if (submission && run && ['pending', 'running'].includes(run.status) && terminal) {
      const status = problem.permanent ? 'needs_review' : 'failed';
      const changed = await db.collection<Submission>('submissions').updateOne({ _id: submission._id, org_id: event.org_id, revision: submission.revision, requested_grading_revision: run.revision }, { $set: { grading_status: status, error_code: problem.code, updated_at: now }, $inc: { revision: 1 } }, { session });
      if (changed.modifiedCount !== 1) throw new StaleLease();
      await db.collection<GradingRun>('grading_runs').updateOne({ _id: run._id, org_id: event.org_id }, { $set: { status, error_code: problem.code, completed_at: now, updated_at: now } }, { session });
    }
    const delay = Math.min(60000, 1000 * 2 ** Math.min(event.attempt - 1, 6)) + Math.floor(Math.random() * 250);
    const changed = await db.collection<OutboxEvent>('outbox_events').updateOne(leaseFilter(event), { $set: { status: terminal ? 'failed' : 'pending', error_code: problem.code, available_at: new Date(now.getTime() + delay), lease_owner: null, lease_token: null, lease_until: null, updated_at: now } }, { session });
    if (changed.modifiedCount !== 1) throw new StaleLease();
  });
}

export async function processOne(db: Db): Promise<boolean> {
  await assertOperationalAccess(db);
  const event = await claim(db);
  if (!event) return false;
  let lost = false;
  let renewing: Promise<void> = Promise.resolve();
  const timer = setInterval(() => { renewing = renewing.then(async () => { if (!await renew(db, event)) lost = true; }).catch(() => { lost = true; }); }, 10000);
  timer.unref();
  let expectedRevision: number | undefined;
  try {
    const data = await evidence(db, event);
    expectedRevision = data.submission.revision;
    // Ordinary disable preserves accepted work; irreversible erasure does not.
    await transaction(db, (session) => sourceFence(db, context(event, session, data.submission.member_id), data));
    const corrections = new Map(data.run.corrections.map((item) => [item.session_item_id, item.snapshot]));
    const calculated = data.items.map((item) => ({ session_item_id: item._id, ...scoreAnswer(corrections.get(item._id) ?? item.snapshot, data.byItem.get(item._id) ?? null, item.max_score) }));
    if (lost) throw new StaleLease();
    await complete(db, event, calculated, expectedRevision);
  } catch (error) { await failEvent(db, event, error, expectedRevision); }
  finally { clearInterval(timer); await renewing; }
  return true;
}

export async function processDeadlines(db: Db): Promise<number> {
  await assertOperationalAccess(db);
  const rows = await db.collection<AssessmentSession>('sessions').find({ mode: 'quiz', status: 'in_progress', deadline_at: { $ne: null }, $expr: { $lte: ['$deadline_at', '$$NOW'] } }).sort({ deadline_at: 1, _id: 1 }).limit(100).toArray();
  let count = 0;
  for (const candidate of rows) {
    await transaction(db, async (session) => {
      const row = await db.collection<AssessmentSession>('sessions').findOne({ _id: candidate._id, org_id: candidate.org_id, status: 'in_progress', $expr: { $lte: ['$deadline_at', '$$NOW'] } }, { session });
      if (!row) return;
      if (!await fenceEvidenceSubject(db, session, row.user_id)) return;
      const ctx = context(row, session, row.member_id);
      const items = await db.collection<SessionItem>('session_items').find({ session_id: row._id, org_id: row.org_id }, { session }).limit(51).toArray();
      const sources = new AssessmentSources(db);
      let blocked: string | undefined;
      try {
        for (const version of [...new Set(items.map((item) => item.snapshot.question_version_id))].sort()) await sources.question(ctx, version, false);
        await sources.guard(ctx, items.map((item) => item.snapshot.question_version_id), 'quiz', row.quiz_id!);
      } catch (error) { const problem = failure(error); if (!problem.permanent) throw error; blocked = problem.code; }
      await createSubmission(db, ctx, row, 'deadline', blocked);
      count++;
    });
  }
  await db.collection<Quiz>('quizzes').updateMany({ status: 'published', $expr: { $lte: ['$closes_at', '$$NOW'] } }, [{ $set: { status: 'closed', updated_at: '$$NOW', revision: { $add: ['$revision', 1] } } }]);
  return count;
}


export async function processVisibility(db: Db): Promise<number> {
  await assertOperationalAccess(db);
  let count = 0;
  const cursor = db.collection<Submission>('submissions').find({ effective_grading_revision: { $ne: null } }).sort({ _id: 1 }).batchSize(50);
  for await (const candidate of cursor) {
    const changed = await transaction(db, async (session) => {
      const submission = await db.collection<Submission>('submissions').findOne({ _id: candidate._id, org_id: candidate.org_id }, { session });
      if (!submission) return false;
      if (!await fenceEvidenceSubject(db, session, submission.user_id)) return false;
      const ctx = context(submission, session, submission.member_id);
      const fingerprint = visibilityFingerprint((await studentAssessmentEvidence(db, ctx, submission, 'projection_check')).status);
      if (fingerprint === submission.visibility_fingerprint) return false;
      const now = await databaseNow(db, ctx);
      const updated = await db.collection<Submission>('submissions').updateOne({ _id: submission._id, org_id: ctx.orgId, revision: submission.revision, visibility_revision: submission.visibility_revision }, { $set: { visibility_fingerprint: fingerprint, updated_at: now }, $inc: { revision: 1, visibility_revision: 1 } }, { session });
      if (updated.modifiedCount !== 1) throw new StaleLease();
      await advanceProjection(db, ctx, now);
      await db.collection<OutboxEvent>('outbox_events').insertOne(eventRecord(ctx.orgId, submission._id, null, submission.visibility_revision + 1, 'AssessmentVisibilityChanged', now), { session });
      return true;
    });
    if (changed) count++;
  }
  return count;
}

export async function reconcile(db: Db, options: ReconcileOptions = {}) {
  await assertOperationalAccess(db);
  validateReconcileOptions(options);
  const report = { apply: !!options.apply, overdue_sessions: 0, expired_leases: 0, missing_events: 0, incomplete_results: 0, repaired_events: 0 };
  report.overdue_sessions = await db.collection<AssessmentSession>('sessions').countDocuments({ mode: 'quiz', status: 'in_progress', $expr: { $lte: ['$deadline_at', '$$NOW'] } });
  report.expired_leases = await db.collection<OutboxEvent>('outbox_events').countDocuments({ target_consumer: 'grading_v1', status: 'running', $expr: { $lte: ['$lease_until', '$$NOW'] } });
  for await (const submission of db.collection<Submission>('submissions').find({}).batchSize(50)) {
    const run = await db.collection<GradingRun>('grading_runs').findOne({ org_id: submission.org_id, submission_id: submission._id, revision: submission.requested_grading_revision });
    if (!run) { report.incomplete_results++; continue; }
    if (run.status === 'completed') {
      const items = await db.collection<SessionItem>('session_items').find({ org_id: submission.org_id, session_id: submission.session_id }).limit(51).toArray();
      const results = await db.collection<GradingResult>('grading_results').find({ org_id: submission.org_id, grading_run_id: run._id }).limit(51).toArray();
      if (results.length !== items.length || items.some((item) => !results.some((result) => result.session_item_id === item._id && scoreCents(result.max_score) === scoreCents(item.max_score))) || submission.effective_grading_revision !== run.revision || submission.total_score === null || results.reduce((sum, result) => sum + scoreCents(result.score), 0n) !== scoreCents(submission.total_score)) report.incomplete_results++;
    }
    if (!['pending', 'running'].includes(run.status)) continue;
    const type = run.revision === 1 ? 'SubmissionAccepted' : 'RegradeRequested';
    const key = { org_id: submission.org_id, aggregate_type: 'submission', aggregate_id: submission._id, aggregate_version: run.revision, event_type: type } as const;
    if (await db.collection<OutboxEvent>('outbox_events').findOne(key)) continue;
    report.missing_events++;
    if (!options.apply) continue;
    const repaired = await transaction(db, async (session) => {
      const ctx = context(submission, session, submission.member_id);
      const current = await db.collection<Submission>('submissions').findOne({ _id: submission._id, org_id: submission.org_id, requested_grading_revision: run.revision }, { session });
      const currentRun = await db.collection<GradingRun>('grading_runs').findOne({ _id: run._id, org_id: submission.org_id, status: { $in: ['pending', 'running'] } }, { session });
      if (!current || !currentRun || await db.collection<OutboxEvent>('outbox_events').findOne(key, { session })) return false;
      if (!await fenceEvidenceSubject(db, session, current.user_id)) return false;
      const now = await databaseNow(db, ctx);
      const locked = await db.collection<Submission>('submissions').updateOne({ _id: current._id, org_id: current.org_id, revision: current.revision }, { $inc: { revision: 1 }, $set: { updated_at: now } }, { session });
      if (!locked.modifiedCount) throw new StaleLease();
      await db.collection<OutboxEvent>('outbox_events').insertOne(eventRecord(ctx.orgId, current._id, run._id, run.revision, type, now), { session });
      await db.collection<Document & { _id: string }>('audit_events').insertOne({ _id: randomUUID(), org_id: ctx.orgId, actor_id: options.actor!, action: 'assessment.reconcile', resource_type: 'submission', resource_id: current._id, owner_type: null, owner_version_id: null, revision_before: null, revision_after: null, access_revision_before: null, access_revision_after: null, reason: options.reason!, request_id: ctx.requestId, created_at: now }, { session });
      return true;
    });
    if (repaired) report.repaired_events++;
  }
  // Normal worker paths already CAS overdue sessions and reclaim expired leases; reconciliation never rewinds terminal errors.
  return report;
}

async function main() {
  const command = process.argv[2];
  if (!['run', 'once', 'reconcile'].includes(command) || !process.env.MONGODB_URI) throw new Error('使用 worker.js run|once|reconcile 并配置 MONGODB_URI');
  const reconcileOptions = command === 'reconcile' ? parseReconcileOptions(process.argv.slice(3)) : undefined;
  const client = new MongoClient(process.env.MONGODB_URI, { readPreference: 'primary', writeConcern: { w: 'majority' } });
  await client.connect();
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  let writer: WriterRegistration | undefined;
  try {
    const db = client.db(); await assertSchema(db);
    await assertOperationalAccess(db);
    if (command === 'reconcile') {
      if (reconcileOptions!.apply) writer = await acquireWriter(db, 'assessment');
      console.log(JSON.stringify(await reconcile(db, reconcileOptions)));
      return;
    }
    writer = await acquireWriter(db, 'assessment');
    do {
      if (stopping || await writer.stopRequested()) break;
      const deadlines = await processDeadlines(db);
      const processed = await processOne(db);
      const visible = await processVisibility(db);
      if (command === 'once') { console.log(JSON.stringify({ processed, deadlines, visible })); break; }
      if (!processed && !deadlines && !visible) await sleep(1000);
    } while (!stopping);
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); try { await writer?.release(); } finally { await client.close(); } }
}
if (require.main === module) main().catch(() => { console.error('测评worker失败，请检查数据库与评分任务安全状态'); process.exitCode = 1; });
