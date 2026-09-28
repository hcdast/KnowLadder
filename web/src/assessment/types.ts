import type { components, paths } from '../api/schema';

export interface Page<T> { items: T[]; next_cursor: string | null }
export type Answer = components['schemas']['AssessmentAnswer'];
export type Session = components['schemas']['AssessmentSession'];
export type Item = components['schemas']['AssessmentSessionItem'];
export type SessionPage = paths['/api/v1/sessions/{id}/items']['get']['responses'][200]['content']['application/json']['data'];
export type QuizSummary = components['schemas']['AssessmentQuizSummary'];
export type StudentQuiz = components['schemas']['AssessmentStudentQuiz'];
export type AdminQuiz = components['schemas']['AssessmentAdminQuiz'];
export type Submission = components['schemas']['AssessmentSubmission'];
export type AdminSubmissionSummary = components['schemas']['AssessmentAdminSubmissionSummary'];
export type AdminSubmission = components['schemas']['AssessmentAdminSubmission'];
export type SavedAnswer = components['schemas']['AssessmentSavedAnswer'];
export type SubmissionReceipt = components['schemas']['AssessmentSubmissionReceipt'];
export type ResultItem = components['schemas']['AssessmentResultItem'];
export type ResultPage = paths['/api/v1/submissions/{id}/items']['get']['responses'][200]['content']['application/json']['data'];
export type AssessmentAudit = components['schemas']['AssessmentAudit'];
export type Candidate = components['schemas']['AssessmentQuestionSummary'];
export type Question = components['schemas']['AssessmentQuestion'];
export type Member = components['schemas']['AssessmentMember'];
export type PracticeOptions = components['schemas']['AssessmentPracticeOptions'];
export interface Recovery { user: string; org: string; operation: 'practice.create' | 'quiz.start' | 'answer.save' | 'session.submit'; resource_id: string; key: string; expected_revision?: number; session_id?: string }
export type Resolution = components['schemas']['AssessmentIdempotency'];
