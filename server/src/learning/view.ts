import { newId } from "../database/object-id";
import { randomUUID } from 'node:crypto';
import type { ClientSession, Db, Document } from 'mongodb';
import type { AssessmentContext, Submission } from '../assessment/contracts';
import { studentAssessmentEvidence } from '../assessment/student-evidence';
import { databaseNow } from '../assessment/submission';
import { fail } from '../errors';
import { currentLearningManifest } from './manifest';
import { touchLearningScope } from './tracking';
import { RULE_VERSION, type ProjectionHead, type ProjectionBuild, type MasteryRow, type MistakeRow, type ReportRow, type ProjectionInput, type EvidenceRow } from './contracts';
import { fenceEvidenceMember } from '../assessment/subject-access';
import type { PlatformBusinessContext } from '../administration/platform-access';
export interface LearningView {
  status: 'ready' | 'insufficient_evidence' | 'updating' | 'unavailable';
  source_watermark: string | null; generated_at: string | null; rule_version: string;
  visible_valid_until: Date | null;
  checked_until: Date | null;
  head: ProjectionHead | null; build: ProjectionBuild | null; mastery: MasteryRow[]; mistakes: MistakeRow[]; reports: ReportRow[]; inputs: ProjectionInput[]; evidence: EvidenceRow[];
}
export interface PublishedLearningView {
  status: LearningView['status'] | 'stale';
  source_watermark: string | null;
  generated_at: string | null;
  rule_version: string;
  mastery: MasteryRow[];
  reports: ReportRow[];
}
export async function readLearningView(db: Db, ctx: AssessmentContext, subjectId: string, feedback = true): Promise<LearningView> {
  if (!await fenceEvidenceMember(db, ctx.session, ctx.orgId, ctx.memberId)) fail(410, 'SUBJECT_ERASED', '主体证据已不可用');
  const options = { session: ctx.session }, now = await databaseNow(db, ctx);
  const state = await db.collection<Document & { _id: string }>('student_projection_states').findOneAndUpdate({ org_id: ctx.orgId, member_id: ctx.memberId }, { $inc: { publication_fence: 1 }, $setOnInsert: { _id: newId(), org_id: ctx.orgId, member_id: ctx.memberId, projection_revision: 0, created_at: now, updated_at: now } }, { ...options, upsert: true, returnDocument: 'after' });
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
    await db.collection<ProjectionHead>('learning_projection_heads').updateOne(partition, { $set: { rebuild_requested: true, next_check_at: now, updated_at: now }, $setOnInsert: { _id: newId(), ...partition, active_generation: null, manifest_digest: null, applied_revision: 0, eligibility_revision: 0, catalog_revision: 0, error_code: null, failure_attempts: 0, retry_signature: null, retry_boundary_at: null, retry_input_revision: null, retry_eligibility_revision: null, retry_catalog_revision: null, created_at: now } }, { ...options, upsert: true });
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

/**
 * Read a target member's learning projection inside a TeachingAccess (or similar) transaction.
 * Does NOT go through LearningAccess.run and does not mutate the caller's memberId.
 * Builds an explicit target fence for projection reuse; feedback delivery is always off.
 */
export async function readTargetLearningView(
  db: Db,
  caller: AssessmentContext,
  target: { memberId: string; userId: string },
  subjectId: string,
): Promise<LearningView> {
  if (target.memberId === caller.memberId && target.userId === caller.userId) {
    return readLearningView(db, caller, subjectId, false);
  }
  if (!await fenceEvidenceMember(db, caller.session, caller.orgId, target.memberId)) {
    fail(410, 'SUBJECT_ERASED', '主体证据已不可用');
  }
  const member = await db.collection<{ _id: string; org_id: string; user_id: string }>('organization_members').findOne(
    { _id: target.memberId, org_id: caller.orgId, user_id: target.userId },
    { session: caller.session },
  );
  if (!member) fail(404, 'NOT_FOUND', '成员不存在');
  const targetCtx: AssessmentContext = {
    orgId: caller.orgId,
    memberId: target.memberId,
    userId: target.userId,
    capabilities: ['learning:self'],
    session: caller.session,
    requestId: caller.requestId,
  };
  return readLearningView(db, targetCtx, subjectId, false);
}

async function publishedHiddenCounts(db: Db, filter: { org_id: string; member_id: string; subject_id: string; generation: string }, session: ClientSession) {
  const inputs = await db.collection('learning_projection_inputs').countDocuments(filter, { session, limit: 501 });
  const evidence = await db.collection('mastery_evidence').countDocuments(filter, { session, limit: 5001 });
  const mistakes = await db.collection('mistake_entries').countDocuments(filter, { session, limit: 5001 });
  return { inputs, evidence, mistakes };
}
/**
 * Platform reports inspect published evidence without publication fences,
 * projection scheduling, feedback delivery or student impersonation.
 */
export async function readPublishedLearningView(
  db: Db, actor: PlatformBusinessContext, subject: { memberId: string; userId: string }, subjectId: string,
): Promise<PublishedLearningView> {
  if (!actor.capabilities.includes('report:read') || actor.principalKind !== 'platform_delegate') fail(403, 'FORBIDDEN', '无报告权限');
  const session = actor.session;
  const partition = { org_id: actor.orgId, member_id: subject.memberId, subject_id: subjectId, rule_version: RULE_VERSION };
  const target = { memberId: subject.memberId, userId: subject.userId };
  const options = { session };
  const state = await db.collection<Document & { _id: string }>('student_projection_states')
    .findOne({ org_id: actor.orgId, member_id: subject.memberId }, options);
  const head = await db.collection<ProjectionHead>('learning_projection_heads').findOne(partition, options);
  const empty = (status: PublishedLearningView['status']): PublishedLearningView =>
    ({ status, source_watermark: null, generated_at: null, rule_version: RULE_VERSION, mastery: [], reports: [] });
  const ctx: AssessmentContext = { orgId: actor.orgId, memberId: actor.memberId, userId: actor.userId,
    capabilities: actor.capabilities, session, requestId: actor.requestId, platform: actor };
  const manifest = await currentLearningManifest(db, ctx, subjectId, head?.active_generation ?? '',
    typeof state?.projection_revision === 'number' ? state.projection_revision : 0, target).catch(error => {
    if (error instanceof Error && ['INPUT_LIMIT_EXCEEDED', 'MISSING_SCOPE'].includes(error.message)) return null;
    throw error;
  });
  if (!manifest) return empty('unavailable');
  if (!manifest.inputCount && (!head || head.manifest_digest === manifest.digest && !head.rebuild_requested && head.next_check_at > manifest.now))
    return empty('insufficient_evidence');
  if (!head?.active_generation || !state) return empty('updating');
  if (head.rebuild_requested || head.next_check_at <= manifest.now || head.error_code) return empty('stale');
  if (head.manifest_digest !== manifest.digest || head.applied_revision !== state.projection_revision ||
      head.eligibility_revision !== manifest.eligibility || head.catalog_revision !== manifest.catalog)
    return empty('stale');
  const filter = { org_id: actor.orgId, member_id: subject.memberId, subject_id: subjectId, generation: head.active_generation };
  const build = await db.collection<ProjectionBuild>('learning_projection_builds')
    .findOne({ ...filter, status: 'complete', rule_version: RULE_VERSION, manifest_digest: manifest.digest }, options);
  if (!build || build.target_revision !== state.projection_revision || build.eligibility_revision !== manifest.eligibility ||
      build.catalog_revision !== manifest.catalog) return empty('stale');
  const hidden = await publishedHiddenCounts(db, filter, session);
  const mastery = await db.collection<MasteryRow>('mastery_snapshots').find(filter, options).limit(501).toArray();
  const reports = await db.collection<ReportRow>('report_snapshots').find(filter, options).limit(3).toArray();
  const counts = { ...hidden, mastery: mastery.length, reports: reports.length };
  if (Object.entries(counts).some(([key, value]) => value !== build.expected_counts[key as keyof typeof counts] ||
      value !== build.actual_counts[key as keyof typeof counts]) ||
      counts.inputs !== manifest.inputCount || counts.evidence !== manifest.rowCount) return empty('stale');
  const currentTime = await databaseNow(db, ctx);
  if (currentTime >= manifest.next) return empty('stale');
  if (!session.inTransaction()) {
    const stateAgain = await db.collection<Document & { _id: string }>('student_projection_states')
      .findOne({ org_id: actor.orgId, member_id: subject.memberId }, options);
    const headAgain = await db.collection<ProjectionHead>('learning_projection_heads').findOne(partition, options);
    const buildAgain = await db.collection<ProjectionBuild>('learning_projection_builds')
      .findOne({ _id: build._id, ...filter, status: 'complete' }, options);
    const hiddenAgain = await publishedHiddenCounts(db, filter, session);
    const masteryAgain = await db.collection('mastery_snapshots').countDocuments(filter, { session, limit: 501 });
    const reportsAgain = await db.collection('report_snapshots').countDocuments(filter, { session, limit: 3 });
    const again = await currentLearningManifest(db, ctx, subjectId, head.active_generation, state.projection_revision as number, target)
      .catch(error => {
        if (error instanceof Error && ['INPUT_LIMIT_EXCEEDED', 'MISSING_SCOPE'].includes(error.message)) return null;
        throw error;
      });
    const later = await databaseNow(db, ctx);
    if (!stateAgain || stateAgain.projection_revision !== state.projection_revision ||
        !headAgain || headAgain.active_generation !== head.active_generation ||
        headAgain.manifest_digest !== head.manifest_digest || headAgain.applied_revision !== head.applied_revision ||
        headAgain.eligibility_revision !== head.eligibility_revision || headAgain.catalog_revision !== head.catalog_revision ||
        headAgain.rebuild_requested || headAgain.error_code || headAgain.next_check_at.getTime() !== head.next_check_at.getTime() ||
        headAgain.next_check_at <= later || !buildAgain || buildAgain.manifest_digest !== build.manifest_digest ||
        buildAgain.target_revision !== build.target_revision ||
        !again || again.digest !== manifest.digest || again.inputCount !== manifest.inputCount || again.rowCount !== manifest.rowCount ||
        again.eligibility !== manifest.eligibility || again.catalog !== manifest.catalog || later >= again.next ||
        hiddenAgain.inputs !== counts.inputs || hiddenAgain.evidence !== counts.evidence || hiddenAgain.mistakes !== counts.mistakes ||
        masteryAgain !== counts.mastery || reportsAgain !== counts.reports)
      return empty('stale');
  }
  return { status: mastery.some(row => row.mastery !== null) ? 'ready' : 'insufficient_evidence',
    source_watermark: `${RULE_VERSION}:${head.active_generation}`, generated_at: build.as_of.toISOString(), rule_version: RULE_VERSION,
    mastery, reports };
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
