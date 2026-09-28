import type { AssessmentRecord } from '../assessment/contracts';
export const RULE_VERSION = 'learning_v1';
export const DAY_MS = 86400000;
export type Qualification = 'first' | 'repeated' | 'unknown' | 'exposed';
export interface EvidenceRow extends AssessmentRecord {
  generation: string; member_id: string; subject_id: string; session_item_id: string;
  question_id: string; submission_id: string; grading_run_id: string; grading_revision: number;
  submitted_at: Date; qualification: Qualification; verdict: 'correct'|'incorrect'|'unanswered';
  knowledge_weights: { knowledge_point_id: string; weight_bps: number }[];
}
export interface MasteryRow extends AssessmentRecord {
  generation:string; member_id:string; subject_id:string; knowledge_point_id:string;
  independent_question_count:number; numerator:string; denominator:string; mastery:string|null;
  classification:'insufficient_evidence'|'weak'|'developing'|'mastered'; last_evidence_at:Date;
}
export interface MistakeRow extends AssessmentRecord {
  generation:string; member_id:string; subject_id:string; question_id:string;
  latest_visible_item:string; submission_id:string; grading_run_id:string;
  status:'active'|'resolved'; last_attempt_at:Date;
}
export interface ReportRow extends AssessmentRecord {
  generation:string; member_id:string; subject_id:string; period:'7d'|'30d';
  submission_count:number; attempt_count:number; correct_count:number; incorrect_count:number; unanswered_count:number;
  independent_question_count:number; numerator:string; denominator:string;
}
export interface ProjectionHead extends AssessmentRecord {
  member_id:string; subject_id:string; rule_version:string; active_generation:string|null;
  manifest_digest:string|null; applied_revision:number; eligibility_revision:number; catalog_revision:number;
  next_check_at:Date; rebuild_requested:boolean; error_code:string|null;
  failure_attempts:number; retry_signature:string|null; retry_boundary_at:Date|null;
  retry_input_revision:number|null; retry_eligibility_revision:number|null; retry_catalog_revision:number|null;
}
export interface ProjectionBuild extends AssessmentRecord {
  member_id:string; subject_id:string; rule_version:string; generation:string; as_of:Date;
  target_revision:number; eligibility_revision:number; catalog_revision:number; manifest_digest:string;
  expected_counts:Counts; actual_counts:Counts; status:'building'|'complete'|'abandoned'; lease_token:string;
}
export interface Counts { inputs:number; evidence:number; mastery:number; mistakes:number; reports:number; }
export interface ProjectionInput extends AssessmentRecord {
  generation:string; member_id:string; subject_id:string; submission_id:string;
  effective_revision:number; requested_revision:number; grading_run_id:string; submitted_at:Date;
  semantic_digest:string; in_7d:boolean; in_30d:boolean;
}
