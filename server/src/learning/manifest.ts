import { createHash, randomUUID } from 'node:crypto';
import type { Db, Document } from 'mongodb';
import type { AssessmentContext, Submission } from '../assessment/contracts';
import { databaseNow } from '../assessment/submission';
import { studentAssessmentEvidence } from '../assessment/student-evidence';
import { DAY_MS, RULE_VERSION, type EvidenceRow, type ProjectionInput, type Qualification } from './contracts';
import { fenceEvidenceMember } from '../assessment/subject-access';
type Row = Document & { _id: string };
function hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

/** One semantic manifest for publication and HTTP freshness; caller owns member/scope fences. */
export async function currentLearningManifest(db: Db, ctx: AssessmentContext, subjectId: string, generation: string, revision: number) {
  if (!await fenceEvidenceMember(db, ctx.session, ctx.orgId, ctx.memberId)) throw new Error('SUBJECT_ERASED');
  const session = ctx.session, now = await databaseNow(db, ctx);
  let next = new Date(now.getTime()+60000);
  let visibleValidUntil: Date | null = null;
  const boundary = (date:Date|null) => { if (date && date > now && date < next) next = date; };
  const candidates = await db.collection<Submission>('submissions').aggregate<Submission>([
    {$match:{org_id:ctx.orgId,member_id:ctx.memberId,submitted_at:{$gt:new Date(now.getTime()-90*DAY_MS),$lte:now}}},
    {$lookup:{from:'session_items',let:{sid:'$session_id',org:'$org_id'},pipeline:[{$match:{$expr:{$and:[{$eq:['$session_id','$$sid']},{$eq:['$org_id','$$org']},{$eq:['$snapshot.subject_id',subjectId]}]}}},{$limit:1},{$project:{_id:1}}],as:'subject_items'}},
    {$match:{'subject_items.0':{$exists:true}}},{$sort:{_id:1}},{$unset:'subject_items'}
  ],{session}).batchSize(50);
  const inputs:ProjectionInput[] = [], rows:EvidenceRow[] = [], sources = new Set<string>(), points = new Set<string>();
  for await (const submission of candidates) {
    const evidence = await studentAssessmentEvidence(db,ctx,submission,'projection_check');
    boundary(evidence.nextCheckAt);
    if (evidence.status !== 'released') continue;
    if (inputs.length >= 500) throw new Error('INPUT_LIMIT_EXCEEDED');
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
      rows.push({_id:randomUUID(),org_id:ctx.orgId,member_id:ctx.memberId,subject_id:subjectId,generation,session_item_id:item._id,question_id:item.snapshot.question_id,submission_id:submission._id,grading_run_id:evidence.run._id,grading_revision:evidence.run.revision,submitted_at:submission.submitted_at,qualification:qualified,verdict:result.verdict,knowledge_weights:item.snapshot.knowledge_weights,created_at:now,updated_at:now});
      itemSemantics.push([item._id,item.snapshot.question_id,item.snapshot.question_version_id,item.snapshot.knowledge_weights,qualified,result.verdict,result.score.toString(),result.max_score.toString()]);
    }
    for (const correction of evidence.run.corrections) sources.add(correction.snapshot.question_version_id);
    if (rows.length > 5000 || sources.size > 500) throw new Error('INPUT_LIMIT_EXCEEDED');
    for (const days of [7,30,90]) boundary(new Date(submission.submitted_at.getTime()+days*DAY_MS));
    const in7 = submission.submitted_at.getTime() > now.getTime()-7*DAY_MS, in30 = submission.submitted_at.getTime() > now.getTime()-30*DAY_MS;
    inputs.push({_id:randomUUID(),org_id:ctx.orgId,member_id:ctx.memberId,subject_id:subjectId,generation,submission_id:submission._id,effective_revision:submission.effective_grading_revision!,requested_revision:submission.requested_grading_revision,grading_run_id:evidence.run._id,submitted_at:submission.submitted_at,semantic_digest:hash([itemSemantics,evidence.run.corrections.map(c=>[c.session_item_id,c.snapshot.question_version_id])]),in_7d:in7,in_30d:in30,created_at:now,updated_at:now});
  }
  const digest = hash([RULE_VERSION,inputs.map(row=>[row.submission_id,row.effective_revision,row.requested_revision,row.grading_run_id,row.submitted_at,row.semantic_digest,row.in_7d,row.in_30d])]);
  const scope = await db.collection<Row>('learning_scope_states').findOne({org_id:ctx.orgId,subject_id:subjectId},{session});
  if (!scope) throw new Error('MISSING_SCOPE');
  return {inputs,rows,digest,now,next,visibleValidUntil,revision,eligibility:scope.eligibility_revision as number,catalog:scope.catalog_revision as number};
}
