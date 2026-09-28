import { randomUUID } from 'node:crypto';
import type { Db, Document } from 'mongodb';
import type { AssessmentContext, Submission } from '../assessment/contracts';
import { studentAssessmentEvidence } from '../assessment/student-evidence';
import { databaseNow } from '../assessment/submission';
import { fail } from '../errors';
import { currentLearningManifest } from './manifest';
import { touchLearningScope } from './tracking';
import { RULE_VERSION, type ProjectionHead, type ProjectionBuild, type MasteryRow, type MistakeRow, type ReportRow, type ProjectionInput, type EvidenceRow } from './contracts';
import { fenceEvidenceMember } from '../assessment/subject-access';
export interface LearningView {
  status: 'ready' | 'insufficient_evidence' | 'updating' | 'unavailable';
  source_watermark: string | null; generated_at: string | null; rule_version: string;
  visible_valid_until: Date | null;
  checked_until: Date | null;
  head: ProjectionHead | null; build: ProjectionBuild | null; mastery: MasteryRow[]; mistakes: MistakeRow[]; reports: ReportRow[]; inputs: ProjectionInput[]; evidence: EvidenceRow[];
}
export async function readLearningView(db: Db, ctx: AssessmentContext, subjectId: string, feedback = true): Promise<LearningView> {
  if (!await fenceEvidenceMember(db, ctx.session, ctx.orgId, ctx.memberId)) fail(410, 'SUBJECT_ERASED', '主体证据已不可用');
  const options = { session: ctx.session }, now = await databaseNow(db, ctx);
  const state = await db.collection<Document & { _id: string }>('student_projection_states').findOneAndUpdate({ org_id: ctx.orgId, member_id: ctx.memberId }, { $inc: { publication_fence: 1 }, $setOnInsert: { _id: randomUUID(), org_id: ctx.orgId, member_id: ctx.memberId, projection_revision: 0, created_at: now, updated_at: now } }, { ...options, upsert: true, returnDocument: 'after' });
  await touchLearningScope(db, ctx, subjectId, false);
  const partition = { org_id: ctx.orgId, member_id: ctx.memberId, subject_id: subjectId, rule_version: RULE_VERSION };
  const head = await db.collection<ProjectionHead>('learning_projection_heads').findOne(partition, options);
  const empty = (status: LearningView['status']): LearningView => ({ status, source_watermark: null, generated_at: null, rule_version: RULE_VERSION, visible_valid_until: null, checked_until: null, head, build: null, mastery: [], mistakes: [], reports: [], inputs: [], evidence: [] });
  const current = await currentLearningManifest(db, ctx, subjectId, head?.active_generation ?? randomUUID(), state!.projection_revision as number).catch(error => {
    if (error instanceof Error && error.message === 'INPUT_LIMIT_EXCEEDED') return null;
    throw error;
  });
  if (!current) return empty('unavailable');
  const request = async () => {
    await db.collection<ProjectionHead>('learning_projection_heads').updateOne(partition, { $set: { rebuild_requested: true, next_check_at: now, updated_at: now }, $setOnInsert: { _id: randomUUID(), ...partition, active_generation: null, manifest_digest: null, applied_revision: 0, eligibility_revision: 0, catalog_revision: 0, error_code: null, failure_attempts: 0, retry_signature: null, retry_boundary_at: null, retry_input_revision: null, retry_eligibility_revision: null, retry_catalog_revision: null, created_at: now } }, { ...options, upsert: true });
  };
  if (!current.inputs.length) { if (head?.manifest_digest !== current.digest) await request(); return empty('insufficient_evidence'); }
  if (!head?.active_generation || head.manifest_digest !== current.digest) { await request(); return empty('updating'); }
  const filter = { org_id: ctx.orgId, member_id: ctx.memberId, subject_id: subjectId, generation: head.active_generation };
  const build = await db.collection<ProjectionBuild>('learning_projection_builds').findOne({ ...filter, status: 'complete', rule_version: RULE_VERSION, manifest_digest: current.digest }, options);
  if (!build) { await request(); return empty('unavailable'); }
  const inputs = await db.collection<ProjectionInput>('learning_projection_inputs').find(filter, options).limit(501).toArray();
  const evidence = await db.collection<EvidenceRow>('mastery_evidence').find(filter, options).limit(5001).toArray();
  const mastery = await db.collection<MasteryRow>('mastery_snapshots').find(filter, options).limit(501).toArray();
  const mistakes = await db.collection<MistakeRow>('mistake_entries').find(filter, options).limit(5001).toArray();
  const reports = await db.collection<ReportRow>('report_snapshots').find(filter, options).limit(3).toArray();
  const counts = { inputs: inputs.length, evidence: evidence.length, mastery: mastery.length, mistakes: mistakes.length, reports: reports.length };
  if (Object.entries(counts).some(([key, value]) => value !== build.expected_counts[key as keyof typeof counts] || value !== build.actual_counts[key as keyof typeof counts]) || inputs.length !== current.inputs.length || evidence.length !== current.rows.length) { await request(); return empty('unavailable'); }
  const view: LearningView = { status: mastery.some(row => row.mastery !== null) ? 'ready' : 'insufficient_evidence', source_watermark: `${RULE_VERSION}:${head.active_generation}`, generated_at: build.as_of.toISOString(), rule_version: RULE_VERSION, visible_valid_until: current.visibleValidUntil, checked_until: current.next, head, build, mastery, mistakes, reports, inputs, evidence };
  if (feedback) await deliverLearningFeedback(db, ctx, view, inputs.map(input => input.submission_id));
  if (await databaseNow(db, ctx) >= current.next) fail(409, 'PROJECTION_CHANGED', '学情时间窗口已变化，请重新读取');
  return view;
}

/** Disclose only submissions which actually contribute to the delivered DTO. */
export async function deliverLearningFeedback(db: Db, ctx: AssessmentContext, view: LearningView, submissionIds: Iterable<string>, sessionItemIds?: Iterable<string>): Promise<void> {
  const allowed = new Set(view.inputs.map(input => input.submission_id));
  const selected = sessionItemIds ? new Set(sessionItemIds) : undefined;
  if (selected && [...selected].some(key => !view.evidence.some(row => row.session_item_id === key))) fail(409, 'PROJECTION_CHANGED', '学情贡献已变化');
  for (const key of [...new Set(submissionIds)].sort()) {
    if (!allowed.has(key)) fail(409, 'PROJECTION_CHANGED', '学情贡献已变化');
    const submission = await db.collection<Submission>('submissions').findOne({ _id: key, org_id: ctx.orgId, member_id: ctx.memberId, user_id: ctx.userId }, { session: ctx.session });
    const subset = selected ? new Set(view.evidence.filter(row => row.submission_id === key && selected.has(row.session_item_id)).map(row => row.session_item_id)) : undefined;
    if (!submission || (await studentAssessmentEvidence(db, ctx, submission, 'feedback_delivery', subset)).status !== 'released') fail(409, 'PROJECTION_CHANGED', '学情已变化，请重新读取');
  }
  if (view.checked_until && await databaseNow(db, ctx) >= view.checked_until) fail(409, 'PROJECTION_CHANGED', '学情时间窗口已变化，请重新读取');
}
