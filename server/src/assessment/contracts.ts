import type { ClientSession, Decimal128 } from "mongodb";
import type { KnowledgeWeight, ScoringRule } from "../content/contracts";
import type { PlatformBusinessContext } from '../administration/platform-access';

export interface AssessmentContext { orgId:string; userId:string; memberId:string; capabilities:string[]; session:ClientSession; requestId:string; platform?:PlatformBusinessContext; studentConflict?:boolean; }
export interface AssessmentRecord { _id:string; org_id:string; created_at:Date; updated_at:Date; }
/** Internal frozen evidence. Never spread this object into student responses. */
export interface QuestionSnapshot {
  question_version_id:string; question_id:string; subject_id:string; title:string;
  question_type:"single"|"multiple"|"numeric"; prompt:string; options:{id:string;text:string}[];
  answer:string; explanation:string; scoring_rule:ScoringRule; knowledge_point_ids:string[];
  knowledge_weights:KnowledgeWeight[]; difficulty:"基础"|"提升"|"挑战"; difficulty_basis:string;
  resource_ids:string[]; created_by:string; contributors:string[]; published_by:string|null; display_digest:string;
}
export type StudentAnswer = null | { selected_option_ids:string[] } | { value:string };
export type GradingStatus = "pending"|"running"|"needs_review"|"completed"|"failed";
export interface Quiz extends AssessmentRecord {
  title:string; subject_id:string; status:"draft"|"published"|"closed"|"archived"; revision:number;
  created_by:string; contributors:string[]; published_by:string|null; published_at:Date|null;
  opens_at:Date; closes_at:Date; release_at:Date; duration_seconds:number; max_attempts:number;
  published_paper_id:string|null; visibility_revision:number;
  source_class_ids?:string[];
}
export interface Paper extends AssessmentRecord { quiz_id:string; revision:number; status:"draft"|"frozen"; }
export interface PaperItem extends AssessmentRecord { paper_id:string; position:number; snapshot:QuestionSnapshot; max_score:Decimal128; }
export interface QuizAudience extends AssessmentRecord { quiz_id:string; member_id:string; }
export interface AttemptCounter extends AssessmentRecord { quiz_id:string; member_id:string; allocated:number; revision:number; }
export interface AssessmentSession extends AssessmentRecord {
  user_id:string; member_id:string; mode:"practice"|"quiz"; quiz_id:string|null; paper_id:string|null;
  textbook_edition_id:string|null; chapter_id:string|null; knowledge_point_ids:string[]; difficulty:"基础"|"提升"|"挑战"|null;
  status:"in_progress"|"submitted"|"expired"|"cancelled"; revision:number; started_at:Date; deadline_at:Date|null;
  submitted_at:Date|null; submission_id:string|null; item_count:number;
}
export interface SessionItem extends AssessmentRecord { session_id:string; position:number; snapshot:QuestionSnapshot; max_score:Decimal128; learning_context?:{epoch:string;qualification:'first'|'repeated'|'unknown';reason:string}; }
export interface Answer extends AssessmentRecord { session_id:string; session_item_id:string; answer_schema_version:1; answer:StudentAnswer; saved_at:Date; }
export interface Submission extends AssessmentRecord {
  session_id:string; user_id:string; member_id:string; mode:"practice"|"quiz"; quiz_id:string|null;
  reason:"manual"|"deadline"; submitted_at:Date; answers_hash:string; grading_status:GradingStatus;
  revision:number; effective_grading_revision:number|null; requested_grading_revision:number;
  total_score:Decimal128|null; max_score:Decimal128; error_code:string|null; visibility_revision:number;
  visibility_fingerprint:string|null;
}
export interface Correction { session_item_id:string; snapshot:QuestionSnapshot; }
export interface GradingRun extends AssessmentRecord {
  submission_id:string; revision:number; status:GradingStatus; reason:string; requested_by:string;
  scoring_code_version:string; corrections:Correction[]; completed_at:Date|null; error_code:string|null;
}
export interface GradingResult extends AssessmentRecord { grading_run_id:string; session_item_id:string; score:Decimal128; max_score:Decimal128; verdict:"correct"|"incorrect"|"unanswered"; }
export interface OutboxEvent extends AssessmentRecord {
  aggregate_type:string; aggregate_id:string; aggregate_version:number;
  event_type:"SubmissionAccepted"|"RegradeRequested"|"GradeFinalized"|"AssessmentVisibilityChanged";
  schema_version:1; target_consumer:"grading_v1"|"learning_projection_v1";
  payload:{submission_id:string;grading_run_id?:string}; status:"pending"|"running"|"processed"|"failed";
  lease_owner:string|null; lease_token:string|null; lease_until:Date|null; attempt:number;
  available_at:Date; processed_at:Date|null; error_code:string|null;
}
export interface ConsumerReceipt extends AssessmentRecord { consumer_name:string; event_id:string; }
export interface IdempotencyRecord extends AssessmentRecord { user_id:string; operation:string; resource_id:string; key:string; request_hash:string; response_status:number; result:Record<string,unknown>; }
export interface AssessmentResourceReference extends AssessmentRecord { reference_type:"paper_item"|"session_item"; reference_id:string; file_id:string; owner_type:"question"; owner_version_id:string; }
export interface AssessmentQuestionState extends AssessmentRecord { question_version_id:string; revision:number; embargo_quiz_id:string|null; answer_disclosed:boolean; }
export interface StudentProjectionState extends AssessmentRecord { member_id:string; projection_revision:number; }
export interface SubmissionReceipt { submission_id:string; session_id:string; session_status:AssessmentSession["status"]; revision:number; submitted_at:Date; grading_status:GradingStatus; report_status:"not_available"; }
