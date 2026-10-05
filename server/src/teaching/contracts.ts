import type { AssessmentContext } from '../assessment/contracts';

export type TeachingContext = AssessmentContext;

export const CLASS_STUDENT_LIMIT = 200;
export const ROSTER_CONFLICTS = ['content:edit', 'content:review', 'assessment:manage', 'assessment:review'] as const;

export interface ClassRecord {
  _id: string;
  org_id: string;
  name: string;
  year_label: string;
  status: 'active' | 'archived';
  revision: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface ClassMemberRecord {
  _id: string;
  org_id: string;
  class_id: string;
  member_id: string;
  kind: 'student';
  status: 'active' | 'ended';
  valid_from: Date | null;
  valid_to: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface TeachingAssignmentRecord {
  _id: string;
  org_id: string;
  class_id: string;
  member_id: string;
  subject_id: string;
  status: 'active' | 'ended';
  valid_from: Date | null;
  valid_to: Date | null;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

export interface ClassView {
  id: string;
  name: string;
  year_label: string;
  status: ClassRecord['status'];
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface RosterEntryView {
  member_id: string;
  display_name: string;
}

export interface AssignmentView {
  id: string;
  class_id: string;
  member_id: string;
  subject_id: string;
  status: TeachingAssignmentRecord['status'];
  revision: number;
  valid_from: string | null;
  valid_to: string | null;
  created_at: string;
  updated_at: string;
}

export interface MasteryBandCounts {
  insufficient_evidence: number;
  weak: number;
  developing: number;
  mastered: number;
}

export interface WeakKnowledgePointView {
  knowledge_point_id: string;
  title: string;
  student_count: number;
}

export interface ClassSubjectReportView {
  class_id: string;
  subject_id: string;
  status: 'ready' | 'insufficient';
  roster_count: number;
  projected_count: number;
  mastery_bands: MasteryBandCounts;
  submission_count_7d: number;
  submission_count_30d: number;
  weak_knowledge_points: WeakKnowledgePointView[];
  rule_version: string;
}

export interface StudentSubjectReportMasteryItem {
  knowledge_point_id: string;
  independent_question_count: number;
  numerator: string;
  denominator: string;
  mastery: string | null;
  status: 'insufficient_evidence' | 'weak' | 'developing' | 'mastered';
  last_evidence_at: string;
}

export interface StudentSubjectReportView {
  class_id: string;
  subject_id: string;
  member_id: string;
  status: 'ready' | 'insufficient_evidence' | 'updating' | 'unavailable';
  source_watermark: string | null;
  generated_at: string | null;
  rule_version: string;
  period: '7d' | '30d';
  activity: {
    submission_count: number;
    attempt_count: number;
    correct_count: number;
    incorrect_count: number;
    unanswered_count: number;
    independent_question_count: number;
    numerator: string;
    denominator: string;
    correctness: string | null;
  } | null;
  mastery_window_days: 90;
  mastery: StudentSubjectReportMasteryItem[];
}


export function classView(row: ClassRecord): ClassView {
  return {
    id: row._id,
    name: row.name,
    year_label: row.year_label,
    status: row.status,
    revision: row.revision,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function assignmentView(row: TeachingAssignmentRecord): AssignmentView {
  return {
    id: row._id,
    class_id: row.class_id,
    member_id: row.member_id,
    subject_id: row.subject_id,
    status: row.status,
    revision: row.revision,
    valid_from: row.valid_from ? row.valid_from.toISOString() : null,
    valid_to: row.valid_to ? row.valid_to.toISOString() : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function currentlyValid(
  row: { status: string; valid_from: Date | null; valid_to: Date | null },
  now: Date,
): boolean {
  if (row.status !== 'active') return false;
  if (row.valid_from !== null && row.valid_from > now) return false;
  if (row.valid_to !== null && row.valid_to < now) return false;
  return true;
}
