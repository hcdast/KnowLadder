import type { AssessmentRecord } from '../assessment/contracts';
export type RecommendationReason = 'DIAGNOSTIC'|'WEAK_KNOWLEDGE'|'CONSOLIDATION'|'RELATED_READING';
export interface RecommendationRow extends AssessmentRecord {
  member_id:string; user_id:string; subject_id:string; textbook_edition_id:string;
  request_key:string; rank:number; generation:string|null; edition_revision:number; catalog_revision:number;
  rule_version:string; expires_at:Date; kind:'practice'|'reading'; knowledge_point_ids:string[];
  chapter_id:string|null; difficulty:'基础'|'提升'|null; count:5|0;
  reason_code:RecommendationReason; independent_question_count:number; mastery:string|null;
  signature:string|null; accepted_at:Date|null; created_session_id:string|null;
}
export interface RecommendationCard {
  id:string; kind:'practice'|'reading'; textbook_edition_id:string; chapter_id:string|null;
  knowledge_point_ids:string[]; difficulty:'基础'|'提升'|null; count:5|0; expires_at:string;
  reason_code:RecommendationReason; reason:string; independent_question_count:number; mastery:string|null;
}
export interface RecommendationsResponse {
  status:'ready'|'insufficient_evidence'|'updating'|'unavailable'; rule_version:string;
  source_watermark:string|null; catalog_revision:number; edition_revision:number; expires_at:string;
  prerequisite_policy:'not_used_v1'; graph_revision:null; empty_reason:'NO_ELIGIBLE_CONTENT'|null;
  items:RecommendationCard[];
}
