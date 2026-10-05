import { newId } from "../database/object-id";
import { randomUUID } from 'node:crypto';
import { DAY_MS, type EvidenceRow, type MasteryRow, type MistakeRow, type ReportRow } from './contracts';

/** Exact integer arithmetic; presentation rounding never determines classification. */
export function percentage(numerator: bigint, denominator: bigint): string | null {
  if (denominator === 0n) return null;
  const scaled = (numerator * 10000n * 2n + denominator) / (2n * denominator);
  return `${scaled / 100n}.${(scaled % 100n).toString().padStart(2, '0')}`;
}
export function calculateProjection(rows: EvidenceRow[], asOf: Date) {
  if (rows.length > 5000) throw new Error('INPUT_LIMIT_EXCEEDED');
  const visible = rows.filter(row => row.submitted_at.getTime() > asOf.getTime() - 90 * DAY_MS && row.submitted_at <= asOf);
  const points = new Map<string, { questions:Set<string>; numerator:bigint; denominator:bigint; last:Date; row:EvidenceRow }>();
  const questions = new Map<string, EvidenceRow[]>();
  const first = new Set<string>();
  for (const row of visible) {
    const attempts = questions.get(row.question_id) ?? []; attempts.push(row); questions.set(row.question_id, attempts);
    if (row.qualification !== 'first') continue;
    if (first.has(row.question_id)) throw new Error('DUPLICATE_FIRST_EVIDENCE');
    first.add(row.question_id);
    const weights = new Set<string>();
    for (const weight of row.knowledge_weights) {
      if (!Number.isSafeInteger(weight.weight_bps) || weight.weight_bps <= 0 || weight.weight_bps > 10000 || weights.has(weight.knowledge_point_id)) throw new Error('INVALID_KNOWLEDGE_WEIGHT');
      weights.add(weight.knowledge_point_id);
      const point = points.get(weight.knowledge_point_id) ?? { questions:new Set<string>(), numerator:0n, denominator:0n, last:row.submitted_at, row };
      point.questions.add(row.question_id); point.denominator += BigInt(weight.weight_bps);
      if (row.verdict === 'correct') point.numerator += BigInt(weight.weight_bps);
      if (row.submitted_at > point.last) point.last = row.submitted_at;
      points.set(weight.knowledge_point_id, point);
    }
  }
  if (points.size > 500) throw new Error('INPUT_LIMIT_EXCEEDED');
  const base = (row:EvidenceRow) => ({ _id:newId(), org_id:row.org_id, member_id:row.member_id, subject_id:row.subject_id, generation:row.generation, created_at:asOf, updated_at:asOf });
  const mastery:MasteryRow[] = [...points].sort(([a],[b]) => a.localeCompare(b)).map(([id, point]) => {
    const enough = point.questions.size >= 5 && point.denominator > 0n;
    return { ...base(point.row), knowledge_point_id:id, independent_question_count:point.questions.size, numerator:String(point.numerator), denominator:String(point.denominator), mastery:enough ? percentage(point.numerator, point.denominator) : null,
      classification:!enough ? 'insufficient_evidence' : point.numerator * 100n < point.denominator * 60n ? 'weak' : point.numerator * 100n < point.denominator * 80n ? 'developing' : 'mastered', last_evidence_at:point.last };
  });
  const mistakes:MistakeRow[] = [];
  for (const [questionId, attempts] of questions) {
    if (!attempts.some(row => row.verdict !== 'correct')) continue;
    attempts.sort((a,b) => a.submitted_at.getTime() - b.submitted_at.getTime() || a.submission_id.localeCompare(b.submission_id) || a.session_item_id.localeCompare(b.session_item_id));
    const latest = attempts[attempts.length - 1];
    mistakes.push({ ...base(latest), question_id:questionId, latest_visible_item:latest.session_item_id, submission_id:latest.submission_id, grading_run_id:latest.grading_run_id, status:latest.verdict === 'correct' ? 'resolved' : 'active', last_attempt_at:latest.submitted_at });
  }
  const reports:ReportRow[] = [];
  // Empty generations receive their partition metadata from the manifest writer.
  if (rows.length) for (const days of [7,30] as const) {
    const attempts = visible.filter(row => row.submitted_at.getTime() > asOf.getTime() - days * DAY_MS);
    const independent = attempts.filter(row => row.qualification === 'first');
    let numerator = 0n, denominator = 0n;
    for (const row of independent) for (const weight of row.knowledge_weights) { denominator += BigInt(weight.weight_bps); if (row.verdict === 'correct') numerator += BigInt(weight.weight_bps); }
    reports.push({ ...base(rows[0]), period:`${days}d`, submission_count:new Set(attempts.map(row => row.submission_id)).size, attempt_count:attempts.length, correct_count:attempts.filter(row => row.verdict === 'correct').length, incorrect_count:attempts.filter(row => row.verdict === 'incorrect').length, unanswered_count:attempts.filter(row => row.verdict === 'unanswered').length, independent_question_count:new Set(independent.map(row => row.question_id)).size, numerator:String(numerator), denominator:String(denominator) });
  }
  return { mastery, mistakes, reports };
}
