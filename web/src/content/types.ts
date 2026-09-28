export type Kind = "textbook" | "question";
export interface License { source: string; granted: boolean; expires_at: string | null }
export interface Chapter { id: string; parent_id: string | null; position: number; title: string; body: string; knowledge_point_ids: string[]; resource_ids: string[] }
export interface Version {
  id: string; title: string; status: "draft" | "review" | "published" | "retired"; revision: number;
  access_revision?: number; access_revoked_at?: string | null; access_revoked_reason?: string | null; retired_reason?: string | null;
  created_by: string; contributors: string[]; source_version_id: string | null;
  license: License; resource_ids: string[]; textbook_id?: string; edition_code?: string;
  chapters?: Chapter[]; question_id?: string; subject_id?: string; question_type?: "single" | "multiple" | "numeric";
  prompt?: string; options?: { id: string; text: string }[]; answer?: string; explanation?: string;
  knowledge_point_ids?: string[]; difficulty?: "基础" | "提升" | "挑战"; copy_notice?: string;
  scoring_rule?: { version: 1; strategy: "single_exact" | "multiple_exact_set" | "numeric_exact_decimal"; max_score: string } | null;
  knowledge_weights?: { knowledge_point_id: string; weight_bps: number }[]; difficulty_basis?: string;
}
export interface DirectoryItem { id: string; code: string; name: string; subject_id?: string }
export interface ContentOptions { education_stages: DirectoryItem[]; subjects: DirectoryItem[]; knowledge_points: DirectoryItem[] }
export interface Page<T> { items: T[]; next_cursor: string | null }
export interface AuditEvent { id: string; actor_id: string; action: string; reason?: string; created_at: string; request_id: string; resource_type?: string; resource_id?: string; revision_before?: number | null; revision_after?: number | null; access_revision_before?: number | null; access_revision_after?: number | null }
export interface FileRecord { id: string; status: string; scan_status: string; display_name?: string; owner_revision?: number; error_code?: string | null; size?: number; mime?: string; checksum?: string; legal_hold?: boolean; retention_until?: string | null; deleted_at?: string | null; upload_in_progress?: boolean }
export interface ChapterPage extends Page<Chapter> { edition_revision: number }
export interface ReaderChapter extends Chapter { textbook_edition_id: string; edition_revision: number }
