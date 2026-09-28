import type { components, paths } from '../api/schema';
export type Mastery = components['schemas']['LearningMastery'];
export type MasteryItem = components['schemas']['LearningMasteryItem'];
export type Reports = components['schemas']['LearningReports'];
export type Mistakes = components['schemas']['LearningMistakes'];
export type Mistake = components['schemas']['LearningMistake'];
export type Recommendations = components['schemas']['LearningRecommendations'];
export type Recommendation = components['schemas']['LearningRecommendationCard'];
export type Editions = paths['/api/v1/textbook-editions']['get']['responses'][200]['content']['application/json']['data'];
export type Quizzes = paths['/api/v1/quizzes']['get']['responses'][200]['content']['application/json']['data'];
export type PracticeOptions = components['schemas']['AssessmentPracticeOptions'];
export type Session = components['schemas']['AssessmentSession'];
export type Submission = components['schemas']['AssessmentSubmission'];
export type Answer = components['schemas']['AssessmentAnswer'];
// Only safe recovery references are persisted; never assessment content or answers.
export interface Recovery { operation: 'learning.mistake.practice' | 'learning.recommendation.practice'; resource: string; key: string }
