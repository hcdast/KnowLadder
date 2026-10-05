/** Local teaching DTOs until OpenAPI schema regeneration covers teacher routes. */

export interface TeachingClass {
  id: string;
  name: string;
  year_label: string;
  status: 'active' | 'archived';
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface TeachingClassList {
  items: TeachingClass[];
}

export interface TeachingRosterEntry {
  member_id: string;
  display_name: string;
}

export interface TeachingRoster {
  class: TeachingClass;
  items: TeachingRosterEntry[];
}

export interface TeachingMasteryBands {
  insufficient_evidence: number;
  weak: number;
  developing: number;
  mastered: number;
}

export interface TeachingWeakKnowledgePoint {
  knowledge_point_id: string;
  title: string;
  student_count: number;
}

export interface TeachingClassSubjectReport {
  class_id: string;
  subject_id: string;
  status: 'ready' | 'insufficient';
  roster_count: number;
  projected_count: number;
  mastery_bands: TeachingMasteryBands;
  submission_count_7d: number;
  submission_count_30d: number;
  weak_knowledge_points: TeachingWeakKnowledgePoint[];
  rule_version: string;
}

export interface TeachingStudentActivity {
  submission_count: number;
  attempt_count: number;
  correct_count: number;
  incorrect_count: number;
  unanswered_count: number;
  independent_question_count: number;
  numerator: string;
  denominator: string;
  correctness: string | null;
}

export interface TeachingStudentMasteryRow {
  knowledge_point_id: string;
  independent_question_count: number;
  numerator: string;
  denominator: string;
  mastery: string | null;
  status: 'insufficient_evidence' | 'weak' | 'developing' | 'mastered';
  last_evidence_at: string;
}

export interface TeachingStudentSubjectReport {
  class_id: string;
  subject_id: string;
  member_id: string;
  status: 'ready' | 'insufficient_evidence' | 'updating' | 'unavailable';
  source_watermark: string | null;
  generated_at: string | null;
  rule_version: string;
  period: '7d' | '30d';
  activity: TeachingStudentActivity | null;
  mastery_window_days: 90;
  mastery: TeachingStudentMasteryRow[];
}

export interface QuizDraftSummary {
  id: string;
  title: string;
  subject_id: string;
  status: string;
  revision: number;
  source_class_ids?: string[];
}

export interface TeachingQuizRecovery {
  path: '/quizzes';
  method: 'POST';
  key: string;
}
