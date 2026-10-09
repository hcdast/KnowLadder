export const TRAINING_PATHS: Record<string, readonly string[]> = {
  courses: [
    "_id",
    "org_id",
    "subject_id",
    "author_id",
    "contributors[]",
    "reviewer_id",
    "lessons[].file_id",
    "lessons[].owner_version_id",
  ],
  class_courses: ["_id", "org_id", "class_id", "course_id", "subject_id"],
  course_progress: ["_id", "org_id", "user_id", "member_id", "course_id"],
  training_tasks: [
    "_id",
    "org_id",
    "class_id",
    "subject_id",
    "created_by",
    "target_id",
    "recipients[]",
  ],
  coursework_heads: [
    "_id",
    "org_id",
    "user_id",
    "member_id",
    "task_id",
    "current_submission_id",
    "current_feedback_id",
    "file_ids[]",
  ],
  coursework_submissions: [
    "_id",
    "org_id",
    "user_id",
    "member_id",
    "task_id",
    "head_id",
    "file_ids[]",
  ],
  coursework_feedback: [
    "_id",
    "org_id",
    "task_id",
    "submission_id",
    "author_id",
  ],
  training_idempotency: ["_id", "org_id", "user_id"],
  training_profiles: ["_id", "org_id"],
  ai_jobs: ["_id", "org_id", "user_id", "member_id", "context_id"],
  ai_usage_ledger: ["_id", "org_id"],
  site_revisions: ["_id", "org_id", "author_id", "publisher_id"],
  site_leads: ["_id", "org_id"],
};

TRAINING_PATHS.training_reports=['_id','org_id','class_id','subject_id','task_id','author_id','contributors[]','reviewer_id','published_version_id'];
TRAINING_PATHS.training_report_versions=['_id','org_id','class_id','subject_id','task_id','author_id','contributors[]','reviewer_id','report_id'];

for(const name of ['training_locations','training_schedule_locks'])TRAINING_PATHS[name]=['_id','org_id'];
TRAINING_PATHS.training_sessions=['_id','org_id','class_id','subject_id','course_id','teacher_member_id','location_id','original_session_id','author_id','contributors[]','reviewer_id','recipients[]'];
for(const name of ['training_session_versions','training_attendance','training_attendance_versions','training_leave_requests','training_paths','training_path_versions','training_path_assignments','training_certificates','training_certificate_events'])TRAINING_PATHS[name]=['_id','org_id','class_id','subject_id','session_id','attendance_id','path_id','assignment_id','certificate_id','user_id','member_id','author_id','contributors[]','reviewer_id','issuer_id','actor_id','entries[].member_id','course_ids[]','task_ids[]'];
for(const name of ['training_notification_outbox','training_notifications'])TRAINING_PATHS[name]=['_id','org_id','user_id','member_id','source_id','event_id'];

// Recovery journals store opaque hashes and explicit canonical string plan IDs.
for(const name of ['training_standalone_leases','training_standalone_operations','training_assignment_recovery_plans','training_standalone_knowledge_signals','training_standalone_writer'])TRAINING_PATHS[name]=['_id'];
