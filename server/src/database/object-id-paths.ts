import { GROWTH_PATHS } from "../training/growth-schema";
import { STUDIO_PATHS } from "../training/studio-schema";
import { PLANNING_PATHS } from "../lifelong/planning-schema";
import { STUDY_PATHS } from "../lifelong/study-schema";
import { TRAINING_PATHS } from "../training/paths";
import { LIFELONG_PATHS } from "../lifelong/schema";
// Reviewed v10 persistence paths. UUID tokens and arbitrary text are intentionally absent.
export const OBJECT_ID_PATHS: Record<string, readonly string[]> = {
  ...STUDIO_PATHS,
  ...GROWTH_PATHS,
  ...TRAINING_PATHS,
  ...LIFELONG_PATHS,
  ...STUDY_PATHS,
  ...PLANNING_PATHS,
  auth_email_identities: ["_id", "user_id"],
  auth_email_challenges: ["_id", "user_id", "invitation_id"],
  auth_admissions: ["_id", "user_id"],
  auth_mail_outbox: ["_id", "challenge_id", "user_id", "invitation_id", "transport_writer_id", "actor_user_id"],
  auth_invitations: ["_id", "org_id", "actor_user_id", "target_user_id", "accepted_user_id", "approval_id", "operation_id",
    "payload.invitation_id", "payload.org_id", "payload.actor_org_id", "payload.actor_member_id", "payload.target_user_id", "payload.member_id"],
  "users": [
    "_id"
  ],
  "organizations": [
    "_id"
  ],
  "organization_members": [
    "_id",
    "org_id",
    "user_id"
  ],
  "roles": [
    "_id"
  ],
  "member_roles": [
    "_id",
    "org_id",
    "member_id",
    "operation_id",
    "approval_id",
    "role_id"
  ],
  "auth_sessions": [
    "_id",
    "user_id"
  ],
  "auth_rate_limits": [
    "_id"
  ],
  "audit_events": [
    "_id",
    "org_id",
    "owner_version_id",
    "actor_org_id",
    "target_org_id",
    "grant_id",
    "grant_ids[]",
    "approval_id",
    "operation_id"
  ],
  "textbooks": [
    "_id",
    "org_id",
    "stage_id",
    "subject_id"
  ],
  "textbook_editions": [
    "_id",
    "org_id",
    "created_by",
    "contributors[]",
    "submitted_by",
    "published_by",
    "source_version_id",
    "resource_ids[]",
    "textbook_id",
    "access_revoked_by",
    "retired_by"
  ],
  "chapters": [
    "_id",
    "org_id",
    "textbook_edition_id",
    "parent_id",
    "knowledge_point_ids[]",
    "resource_ids[]"
  ],
  "questions": [
    "_id",
    "org_id"
  ],
  "question_versions": [
    "_id",
    "org_id",
    "created_by",
    "contributors[]",
    "submitted_by",
    "published_by",
    "source_version_id",
    "resource_ids[]",
    "question_id",
    "subject_id",
    "knowledge_point_ids[]",
    "access_revoked_by",
    "retired_by",
    "knowledge_weights[].knowledge_point_id"
  ],
  "education_stages": [
    "_id"
  ],
  "subjects": [
    "_id"
  ],
  "knowledge_points": [
    "_id",
    "subject_id"
  ],
  "content_idempotency": [
    "_id",
    "org_id",
    "user_id"
  ],
  "file_resources": [
    "_id",
    "org_id",
    "owner_version_id",
    "created_by",
    "deletion_requested_by",
    "upload_actor_user_id",
    "upload_actor_org_id"
  ],
  "member_capability_grants": [
    "_id",
    "org_id",
    "member_id",
    "operation_id"
  ],
  "quizzes": [
    "_id",
    "org_id",
    "subject_id",
    "created_by",
    "contributors[]",
    "published_by",
    "published_paper_id",
    "source_class_ids[]"
  ],
  "papers": [
    "_id",
    "org_id",
    "quiz_id"
  ],
  "paper_items": [
    "_id",
    "org_id",
    "paper_id",
    "snapshot.question_version_id",
    "snapshot.question_id",
    "snapshot.subject_id",
    "snapshot.knowledge_point_ids[]",
    "snapshot.knowledge_weights[].knowledge_point_id",
    "snapshot.resource_ids[]",
    "snapshot.created_by",
    "snapshot.contributors[]",
    "snapshot.published_by"
  ],
  "quiz_audiences": [
    "_id",
    "org_id",
    "quiz_id",
    "member_id"
  ],
  "attempt_counters": [
    "_id",
    "org_id",
    "quiz_id",
    "member_id"
  ],
  "sessions": [
    "_id",
    "org_id",
    "user_id",
    "member_id",
    "quiz_id",
    "paper_id",
    "textbook_edition_id",
    "chapter_id",
    "knowledge_point_ids[]",
    "submission_id"
  ],
  "session_items": [
    "_id",
    "org_id",
    "session_id",
    "snapshot.question_version_id",
    "snapshot.question_id",
    "snapshot.subject_id",
    "snapshot.knowledge_point_ids[]",
    "snapshot.knowledge_weights[].knowledge_point_id",
    "snapshot.resource_ids[]",
    "snapshot.created_by",
    "snapshot.contributors[]",
    "snapshot.published_by"
  ],
  "answers": [
    "_id",
    "org_id",
    "session_id",
    "session_item_id"
  ],
  "submissions": [
    "_id",
    "org_id",
    "session_id",
    "user_id",
    "member_id",
    "quiz_id"
  ],
  "grading_runs": [
    "_id",
    "org_id",
    "submission_id",
    "corrections[].session_item_id",
    "corrections[].snapshot.question_version_id",
    "corrections[].snapshot.question_id",
    "corrections[].snapshot.subject_id",
    "corrections[].snapshot.knowledge_point_ids[]",
    "corrections[].snapshot.knowledge_weights[].knowledge_point_id",
    "corrections[].snapshot.resource_ids[]",
    "corrections[].snapshot.created_by",
    "corrections[].snapshot.contributors[]",
    "corrections[].snapshot.published_by"
  ],
  "grading_results": [
    "_id",
    "org_id",
    "grading_run_id",
    "session_item_id"
  ],
  "outbox_events": [
    "_id",
    "org_id",
    "aggregate_id",
    "payload.submission_id",
    "payload.grading_run_id"
  ],
  "consumer_receipts": [
    "_id",
    "org_id",
    "event_id"
  ],
  "idempotency_records": [
    "_id",
    "org_id",
    "user_id"
  ],
  "assessment_resource_references": [
    "_id",
    "org_id",
    "reference_id",
    "file_id",
    "owner_version_id"
  ],
  "assessment_question_states": [
    "_id",
    "org_id",
    "question_version_id",
    "embargo_quiz_id"
  ],
  "student_projection_states": [
    "_id",
    "org_id",
    "member_id"
  ],
  "learning_tracking_config": [
    "_id"
  ],
  "learning_scope_states": [
    "_id",
    "org_id",
    "subject_id"
  ],
  "learning_question_states": [
    "_id",
    "org_id",
    "user_id",
    "question_id",
    "first_session_item_id",
    "sealed_submission_id"
  ],
  "learning_attempt_contexts": [
    "_id",
    "org_id",
    "user_id",
    "member_id",
    "submission_id",
    "session_item_id",
    "question_id",
    "subject_id"
  ],
  "learning_projection_heads": [
    "_id",
    "org_id",
    "member_id",
    "subject_id"
  ],
  "learning_projection_builds": [
    "_id",
    "org_id",
    "member_id",
    "subject_id"
  ],
  "learning_projection_retirements": [
    "_id",
    "org_id",
    "member_id",
    "subject_id"
  ],
  "learning_projection_inputs": [
    "_id",
    "org_id",
    "member_id",
    "subject_id",
    "submission_id",
    "grading_run_id"
  ],
  "mastery_evidence": [
    "_id",
    "org_id",
    "member_id",
    "subject_id",
    "session_item_id",
    "question_id",
    "submission_id",
    "grading_run_id",
    "knowledge_weights[].knowledge_point_id"
  ],
  "mastery_snapshots": [
    "_id",
    "org_id",
    "member_id",
    "subject_id",
    "knowledge_point_id"
  ],
  "mistake_entries": [
    "_id",
    "org_id",
    "member_id",
    "subject_id",
    "question_id",
    "latest_visible_item",
    "submission_id",
    "grading_run_id"
  ],
  "report_snapshots": [
    "_id",
    "org_id",
    "member_id",
    "subject_id"
  ],
  "recommendations": [
    "_id",
    "org_id",
    "member_id",
    "user_id",
    "subject_id",
    "textbook_edition_id",
    "knowledge_point_ids[]",
    "chapter_id",
    "created_session_id"
  ],
  "behavior_events": [
    "_id",
    "org_id",
    "member_id",
    "chapter_id",
    "edition_id"
  ],
  "reading_progress": [
    "_id",
    "org_id",
    "member_id",
    "chapter_id",
    "edition_id"
  ],
  "privacy_deletion_requests": [
    "_id",
    "user_id"
  ],
  "privacy_operation_receipts": [
    "_id",
    "user_id",
    "request_id"
  ],
  "privacy_tombstones": [
    "_id",
    "user_id",
    "request_id"
  ],
  "privacy_step_receipts": [
    "_id",
    "request_id"
  ],
  "operational_state": [
    "_id",
    "restore_id"
  ],
  "operational_writers": [
    "_id"
  ],
  "backup_restore_runs": [
    "_id"
  ],
  "classes": [
    "_id",
    "org_id",
    "created_by"
  ],
  "class_members": [
    "_id",
    "org_id",
    "class_id",
    "member_id"
  ],
  "teaching_assignments": [
    "_id",
    "org_id",
    "class_id",
    "member_id",
    "subject_id"
  ],
  "administrative_grants": [
    "_id",
    "subject_member_id",
    "actor_org_id",
    "scope.organization_ids[]",
    "operation_id",
    "approval_id"
  ],
  "authorization_requests": [
    "_id",
    "requester_user_id",
    "requester_member_id",
    "beneficiary_user_id",
    "subject_member_id",
    "approver_user_id",
    "operation_id"
  ],
  "administration_operations": [
    "_id",
    "targets.user_ids[]",
    "targets.member_ids[]",
    "targets.org_ids[]",
    "audit_id"
  ],
  "administration_guard": [
    "_id",
    "operation_id",
    "blocked_targets.user_ids[]",
    "blocked_targets.member_ids[]",
    "blocked_targets.org_ids[]",
    "affected_orgs[]"
  ],
  "schema_migrations": [
    "_id"
  ]
};
export const NATURAL_KEYS: Record<string,string> = {
  "roles": "code",
  "auth_rate_limits": "rate_key",
  "operational_state": "key",
  "administration_guard": "key",
  "learning_tracking_config": "key"
};

OBJECT_ID_PATHS.object_id_allocations = ["_id", "actor_id"];
OBJECT_ID_PATHS.knowledge_sources = ["_id", "org_id", "source_id", "owner_id"];
OBJECT_ID_PATHS.knowledge_outbox = ["_id", "org_id", "owner_id"];
OBJECT_ID_PATHS.ai_jobs = [...OBJECT_ID_PATHS.ai_jobs, "knowledge_scope[].id"];

// Independent control database; UUID environment/backup identities are natural keys.
OBJECT_ID_PATHS.safety_ledger_heads = ["_id"];
OBJECT_ID_PATHS.completed_backups = ["_id"];
NATURAL_KEYS.safety_ledger_heads = "ledger_key";
NATURAL_KEYS.completed_backups = "ledger_key";

OBJECT_ID_PATHS.knowledge_import_jobs=["_id","org_id","user_id","member_id","owner_id","file_id","chapter_ids[]"];

OBJECT_ID_PATHS.knowledge_import_provenance=["_id","org_id","owner_id","file_id","chapter_ids[]"];

OBJECT_ID_PATHS.training_surveys=["_id","org_id","course_id"];
OBJECT_ID_PATHS.training_survey_responses=["_id","org_id","survey_id","course_id","user_id","member_id"];
