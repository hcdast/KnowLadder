import { newId } from "../database/object-id";
import { createHash, randomUUID } from 'node:crypto';
import type { Db, Document } from 'mongodb';
import type { AssessmentContext, Submission } from '../assessment/contracts';
import { databaseNow } from '../assessment/submission';
import { studentAssessmentEvidence } from '../assessment/student-evidence';
import { DAY_MS, RULE_VERSION, type EvidenceRow, type ProjectionInput, type Qualification } from './contracts';
import { fenceEvidenceMember } from '../assessment/subject-access';
import { fail } from '../errors';
type Row = Document & { _id: string };
function hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

/** One semantic manifest for publication and HTTP freshness; caller owns member/scope fences. */
export async function currentLearningManifest(db: Db, ctx: AssessmentContext, subjectId: string, generation: string, revision: number, reportTarget?: { memberId: string; userId: string }) {
  if (reportTarget) {
    if (ctx.platform?.principalKind !== 'platform_delegate' || !ctx.capabilities.includes('report:read')) fail(403, 'FORBIDDEN', '无报告权限');
    const member = await db.collection<{ _id: string; user_id: string }>('organization_members').findOne(
      { _id: reportTarget.memberId, org_id: ctx.orgId, user_id: reportTarget.userId, status: 'active' }, { session: ctx.session });
    if (!member) fail(404, 'NOT_FOUND', '学生不存在');
  } else if (!await fenceEvidenceMember(db, ctx.session, ctx.orgId, ctx.memberId)) throw new Error('SUBJECT_ERASED');
  const session = ctx.session, now = await databaseNow(db, ctx);
  let next = new Date(now.getTime()+60000);
  // The periodic refresh is not an evidence expiration. A slow build may cross
  // it while remaining semantically valid; real boundaries still gate publication.
  const validity: { until: Date | null } = { until: null };
  let visibleValidUntil: Date | null = null;
  const boundary = (date:Date|null) => {
    if (!date || date <= now) return;
    if (date < next) next = date;
    if (!validity.until || date < validity.until) validity.until = date;
  };
  const candidates = await db.collection<Submission>('submissions').aggregate<Submission>([
    {$match:{org_id:ctx.orgId,member_id:reportTarget?.memberId??ctx.memberId,submitted_at:{$gt:new Date(now.getTime()-90*DAY_MS),$lte:now}}},
    {$lookup:{from:'session_items',let:{sid:'$session_id',org:'$org_id'},pipeline:[{$match:{$expr:{$and:[{$eq:['$session_id','$$sid']},{$eq:['$org_id','$$org']},{$eq:['$snapshot.subject_id',subjectId]}]}}},{$limit:1},{$project:{_id:1}}],as:'subject_items'}},
    {$match:{'subject_items.0':{$exists:true}}},{$sort:{_id:1}},{$unset:'subject_items'}
  ],{session}).batchSize(50);
  const inputs:ProjectionInput[] = [], rows:EvidenceRow[] = [], sources = new Set<string>(), points = new Set<string>();
  const semanticInputs:unknown[][]|null = reportTarget ? [] : null;
  let inputCount = 0, rowCount = 0;
  for await (const submission of candidates) {
    const evidence = await studentAssessmentEvidence(db,ctx,submission,'projection_check',undefined,reportTarget);
    boundary(evidence.nextCheckAt);
    if (evidence.status !== 'released') continue;
    if ((reportTarget ? inputCount : inputs.length) >= 500) throw new Error('INPUT_LIMIT_EXCEEDED');
    if (evidence.nextCheckAt && (!visibleValidUntil || evidence.nextCheckAt < visibleValidUntil)) visibleValidUntil = evidence.nextCheckAt;
    if (evidence.subjectId !== subjectId || !evidence.run) throw new Error('INVALID_EVIDENCE');
    const attempts = await db.collection<Row>('learning_attempt_contexts').find({org_id:ctx.orgId,submission_id:submission._id},{session}).limit(5001).toArray();
    const qualifications = new Map(attempts.map(row => [row.session_item_id,row]));
    if (qualifications.size !== attempts.length) throw new Error('INVALID_EVIDENCE');
    const itemSemantics:unknown[] = [];
    for (const item of [...evidence.items].sort((a,b)=>a._id.localeCompare(b._id))) {
      const result = evidence.results.find(row=>row.session_item_id===item._id);
      if (!result) throw new Error('INVALID_EVIDENCE');
      const qualification = qualifications.get(item._id);
      if (qualification && (qualification.user_id !== submission.user_id || qualification.member_id !== submission.member_id || qualification.question_id !== item.snapshot.question_id || qualification.subject_id !== subjectId)) throw new Error('INVALID_EVIDENCE');
      const qualified:Qualification = qualification?.qualification ?? 'unknown';
      if (!['first','repeated','unknown','exposed'].includes(qualified)) throw new Error('INVALID_EVIDENCE');
      // Match calculateProjection: only released first-attempt evidence contributes mastery points.
      if (qualified === 'first') {
        for (const weight of item.snapshot.knowledge_weights) points.add(weight.knowledge_point_id);
        if (points.size > 500) throw new Error('INPUT_LIMIT_EXCEEDED');
      }
      sources.add(item.snapshot.question_version_id);
      rowCount++;
      if (!reportTarget) rows.push({_id:newId(),org_id:ctx.orgId,member_id:ctx.memberId,subject_id:subjectId,generation,session_item_id:item._id,question_id:item.snapshot.question_id,submission_id:submission._id,grading_run_id:evidence.run._id,grading_revision:evidence.run.revision,submitted_at:submission.submitted_at,qualification:qualified,verdict:result.verdict,knowledge_weights:item.snapshot.knowledge_weights,created_at:now,updated_at:now});
      itemSemantics.push([item._id,item.snapshot.question_id,item.snapshot.question_version_id,item.snapshot.knowledge_weights,qualified,result.verdict,result.score.toString(),result.max_score.toString()]);
    }
    for (const correction of evidence.run.corrections) sources.add(correction.snapshot.question_version_id);
    if (rowCount > 5000 || sources.size > 500) throw new Error('INPUT_LIMIT_EXCEEDED');
    for (const days of [7,30,90]) boundary(new Date(submission.submitted_at.getTime()+days*DAY_MS));
    const in7 = submission.submitted_at.getTime() > now.getTime()-7*DAY_MS, in30 = submission.submitted_at.getTime() > now.getTime()-30*DAY_MS;
    const semanticDigest=hash([itemSemantics,evidence.run.corrections.map(c=>[c.session_item_id,c.snapshot.question_version_id])]);
    inputCount++;
    if (reportTarget) semanticInputs!.push([submission._id,submission.effective_grading_revision!,submission.requested_grading_revision,evidence.run._id,submission.submitted_at,semanticDigest,in7,in30]);
    else inputs.push({_id:newId(),org_id:ctx.orgId,member_id:ctx.memberId,subject_id:subjectId,generation,submission_id:submission._id,effective_revision:submission.effective_grading_revision!,requested_revision:submission.requested_grading_revision,grading_run_id:evidence.run._id,submitted_at:submission.submitted_at,semantic_digest:semanticDigest,in_7d:in7,in_30d:in30,created_at:now,updated_at:now});
  }
  const digest = hash([RULE_VERSION,reportTarget?semanticInputs!:inputs.map(row=>[row.submission_id,row.effective_revision,row.requested_revision,row.grading_run_id,row.submitted_at,row.semantic_digest,row.in_7d,row.in_30d])]);
  const scope = await db.collection<Row>('learning_scope_states').findOne({org_id:ctx.orgId,subject_id:subjectId},{session});
  if (!scope && !(reportTarget && !inputCount)) throw new Error('MISSING_SCOPE');
  return {inputs,rows,inputCount,rowCount,digest,now,next,publicationValidUntil:validity.until,visibleValidUntil,revision,eligibility:(scope?.eligibility_revision as number|undefined)??0,catalog:(scope?.catalog_revision as number|undefined)??0};
}
