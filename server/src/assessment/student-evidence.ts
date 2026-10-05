import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import { AssessmentSources } from '../content/assessment-sources';
import { fail } from '../errors';
import { recordLearningFeedback, touchLearningScope } from '../learning/tracking';
import type { Answer, AssessmentContext, AssessmentSession, GradingResult, GradingRun, Quiz, SessionItem, Submission } from './contracts';
import { scoreAnswer, scoreCents } from './scoring';
import { databaseNow, type VisibilityState } from './submission';
import { requireEvidenceSubject } from './subject-access';
import { isExplicitStandaloneWork } from '../database/txn';

export interface StudentAssessmentEvidence {
  status: VisibilityState;
  session: AssessmentSession;
  items: SessionItem[];
  run: GradingRun | null;
  results: GradingResult[];
  subjectId: string;
  nextCheckAt: Date | null;
}

function invalid(): never { return fail(503, 'INVALID_STUDENT_EVIDENCE', '学生评分证据不完整'); }

/** Internal frozen evidence only. Callers must never spread this result into a DTO. */
export async function studentAssessmentEvidence(db: Db, ctx: AssessmentContext, submission: Submission, purpose: 'projection_check' | 'feedback_delivery', feedbackItemIds?: ReadonlySet<string>, reportTarget?: { memberId: string; userId: string }): Promise<StudentAssessmentEvidence> {
  if (reportTarget) {
    if (purpose !== 'projection_check' || ctx.platform?.principalKind !== 'platform_delegate' || !ctx.capabilities.includes('report:read') ||
      submission.org_id !== ctx.orgId || submission.member_id !== reportTarget.memberId || submission.user_id !== reportTarget.userId)
      fail(403, 'FORBIDDEN', '报告证据范围无效');
    const subject = await db.collection<{ _id: string; privacy_state?: string }>('users').findOne({ _id: reportTarget.userId, status: 'active' }, { session: ctx.session });
    if (!subject || subject.privacy_state && subject.privacy_state !== 'active') fail(410, 'SUBJECT_ERASED', '主体证据已不可用');
  } else {
    if (!ctx.session.inTransaction() && !isExplicitStandaloneWork(ctx.session)) fail(503, 'ASSESSMENT_TRANSACTION_REQUIRED', '证据访问需要真实事务或显式本地standalone工作上下文');
    const internal = ctx.capabilities.length === 1 && (ctx.userId === 'system:learning' && ctx.capabilities[0] === 'learning:projection-worker' || ctx.userId === 'system:assessment' && ctx.capabilities[0] === 'assessment:worker');
    if (submission.org_id !== ctx.orgId || submission.member_id !== ctx.memberId || (internal ? purpose !== 'projection_check' : ctx.userId.startsWith('system:') || ctx.capabilities.some(c => c === 'assessment:worker' || c === 'learning:projection-worker') || !ctx.capabilities.includes('learning:self') || submission.user_id !== ctx.userId)) fail(403, 'FORBIDDEN', '未获本人学生证据权限');
    await requireEvidenceSubject(db, ctx.session, submission.user_id, ctx.orgId);
  }
  const options = { session: ctx.session };
  const current = await db.collection<Submission>('submissions').findOne({ _id: submission._id, org_id: ctx.orgId, user_id: submission.user_id, member_id: submission.member_id }, options);
  if (!current || current.revision !== submission.revision || current.requested_grading_revision !== submission.requested_grading_revision || current.effective_grading_revision !== submission.effective_grading_revision) invalid();
  submission = current;
  const session = await db.collection<AssessmentSession>('sessions').findOne({ _id: submission.session_id, org_id: ctx.orgId, user_id: submission.user_id, member_id: submission.member_id }, options);
  const items = await db.collection<SessionItem>('session_items').find({ org_id: ctx.orgId, session_id: submission.session_id }, options).sort({ position: 1 }).limit(51).toArray();
  if (!session || session.submission_id !== submission._id || session.mode !== submission.mode || session.quiz_id !== submission.quiz_id || !['submitted', 'expired'].includes(session.status) || !items.length || items.length > 50 || items.length !== session.item_count || items.some((item, index) => item.position !== index)) invalid();
  const subjectId = items[0].snapshot.subject_id;
  if (!subjectId || items.some(item => item.snapshot.subject_id !== subjectId)) invalid();
  const run = submission.effective_grading_revision === null ? null : await db.collection<GradingRun>('grading_runs').findOne({ org_id: ctx.orgId, submission_id: submission._id, revision: submission.effective_grading_revision }, options);
  const requested = submission.requested_grading_revision === submission.effective_grading_revision ? run : await db.collection<GradingRun>('grading_runs').findOne({ org_id: ctx.orgId, submission_id: submission._id, revision: submission.requested_grading_revision }, options);
  if (!requested || submission.effective_grading_revision !== null && !run) invalid();
  const output: StudentAssessmentEvidence = { status: 'pending', session, items, run: null, results: [], subjectId, nextCheckAt: null };
  const now = await databaseNow(db, ctx);
  const versions = [...new Set([...items.map(item => item.snapshot.question_version_id), ...(run?.corrections.map(c => c.snapshot.question_version_id) ?? [])])].sort();
  const sources = new AssessmentSources(db);
  output.nextCheckAt = await sources.nextCheckAt(ctx, versions, session.textbook_edition_id, submission.quiz_id, now, !!reportTarget);
  const member = await db.collection('organization_members').findOne({ _id: submission.member_id as never, org_id: ctx.orgId, user_id: submission.user_id, status: 'active' }, options);
  const user = await db.collection('users').findOne({ _id: submission.user_id as never, status: 'active' }, options);
  if (!member || !user) return { ...output, status: 'withheld_access' };
  if (submission.effective_grading_revision !== submission.requested_grading_revision || submission.grading_status !== 'completed') return { ...output, status: submission.requested_grading_revision > 1 ? 'regrading' : 'pending' };
  if (!run || run.status !== 'completed' || !(run.completed_at instanceof Date)) invalid();
  if (submission.quiz_id) {
    const quiz = await db.collection<Quiz>('quizzes').findOne({ _id: submission.quiz_id, org_id: ctx.orgId }, options);
    if (!quiz || quiz.subject_id !== subjectId || !(quiz.release_at instanceof Date)) invalid();
    if (!['published', 'closed', 'archived'].includes(quiz.status) || quiz.release_at > now) return output;
  }
  const answers = await db.collection<Answer>('answers').find({ org_id: ctx.orgId, session_id: session._id }, options).limit(51).toArray();
  const byItem = new Map(items.map(item => [item._id, item]));
  const answerMap = new Map(answers.map(answer => [answer.session_item_id, answer.answer]));
  if (answers.length !== answerMap.size || answers.some(answer => !byItem.has(answer.session_item_id))) invalid();
  const hash = createHash('sha256').update(JSON.stringify(items.map(item => [item._id, answerMap.get(item._id) ?? null]))).digest('hex');
  if (hash !== submission.answers_hash || new Set(run.corrections.map(c => c.session_item_id)).size !== run.corrections.length) invalid();
  for (const correction of run.corrections) {
    const original = byItem.get(correction.session_item_id)?.snapshot;
    if (!original || correction.snapshot.subject_id !== subjectId || correction.snapshot.question_id !== original.question_id || correction.snapshot.question_type !== original.question_type || correction.snapshot.display_digest !== original.display_digest) invalid();
  }
  const results = await db.collection<GradingResult>('grading_results').find({ org_id: ctx.orgId, grading_run_id: run._id }, options).limit(51).toArray();
  if (results.length !== items.length || new Set(results.map(result => result.session_item_id)).size !== items.length) invalid();
  let total = 0n;
  let maximum = 0n;
  try {
    for (const result of results) {
      const item = byItem.get(result.session_item_id);
      if (!item) invalid();
      const basis = run.corrections.find(c => c.session_item_id === item._id)?.snapshot ?? item.snapshot;
      const expected = scoreAnswer(basis, answerMap.get(item._id) ?? null, item.max_score);
      if (result.verdict !== expected.verdict || scoreCents(result.score) !== scoreCents(expected.score) || scoreCents(result.max_score) !== scoreCents(item.max_score)) invalid();
      total += scoreCents(result.score);
      maximum += scoreCents(result.max_score);
    }
    if (submission.total_score === null || total !== scoreCents(submission.total_score) || maximum !== scoreCents(submission.max_score)) invalid();
  } catch { invalid(); }
  if (!reportTarget) await touchLearningScope(db, ctx, subjectId, false);
  try {
    if (session.textbook_edition_id) {
      const textbook = await sources.textbook(ctx, session.textbook_edition_id, false, !!reportTarget);
      if (textbook.subject_id !== subjectId) invalid();
    }
    for (const version of versions) {
      const source = await sources.question(ctx, version, false, !!reportTarget);
      if (source.subject_id !== subjectId || !items.some(item => item.snapshot.question_id === source.question_id)) invalid();
    }
    await sources.guard(ctx, versions, 'visibility', undefined, !!reportTarget);
  } catch (error) {
    if (!(error instanceof HttpException) || ![403, 404, 409, 422].includes(error.getStatus())) throw error;
    const body = error.getResponse();
    return { ...output, status: typeof body === 'object' && 'code' in body && body.code === 'QUESTION_EMBARGOED' ? 'withheld_embargo' : 'withheld_access' };
  }
  // Feedback/ledger failures abort the entire transaction, including earlier disclosure writes.
  if (purpose === 'feedback_delivery') {
    if (feedbackItemIds && [...feedbackItemIds].some(key => !items.some(item => item._id === key))) invalid();
    const delivered = feedbackItemIds ? items.filter(item => feedbackItemIds.has(item._id)) : items;
    const corrections = run.corrections.filter(correction => delivered.some(item => item._id === correction.session_item_id));
    const deliveredVersions = [...new Set([...delivered.map(item => item.snapshot.question_version_id), ...corrections.map(correction => correction.snapshot.question_version_id)])].sort();
    if (deliveredVersions.length) await sources.guard(ctx, deliveredVersions, 'feedback');
    if (delivered.length) await recordLearningFeedback(db, ctx, [...delivered.map(item => item.snapshot.question_id), ...corrections.map(correction => correction.snapshot.question_id)]);
  }
  return { ...output, status: 'released', run, results };
}
