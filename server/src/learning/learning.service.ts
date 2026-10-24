import { HttpException, Injectable } from '@nestjs/common';
import type { Document } from 'mongodb';
import { Database } from '../database/database';
import { AssessmentService } from '../assessment/assessment.service';
import type { Answer, AssessmentContext, SessionItem, StudentAnswer, Submission } from '../assessment/contracts';
import { id, integer, itemDto, object } from '../assessment/dto';
import { scoreCents, scoreText } from '../assessment/scoring';
import { studentAssessmentEvidence } from '../assessment/student-evidence';
import { AssessmentSources } from '../content/assessment-sources';
import type { QuestionVersion } from '../content/contracts';
import { ApiRequest, fail } from '../errors';
import { LearningAccess } from './access';
import { deliverLearningFeedback, readLearningView, type LearningView } from './view';
import type { MasteryRow, MistakeRow } from './contracts';
import { percentage } from './projection';
export interface LearningMeta { status: LearningView['status']; source_watermark: string | null; generated_at: string | null; rule_version: string; }
export interface MasteryItem { knowledge_point_id: string; independent_question_count: number; numerator: string; denominator: string; mastery: string | null; status: MasteryRow['classification']; last_evidence_at: string; }
export interface MasteryResponse extends LearningMeta { evidence_window_days: 90; items: MasteryItem[]; next_cursor: string | null; }
export interface MistakeItem { id: string; question_id: string; status: MistakeRow['status']; title: string; question_type: string; session_item_id: string; submission_id: string; last_attempt_at: string; }
export interface MistakesResponse extends LearningMeta { items: MistakeItem[]; total: number; next_cursor: string | null; }
export interface ReportsResponse extends LearningMeta { period: '7d' | '30d'; activity: { submission_count: number; attempt_count: number; correct_count: number; incorrect_count: number; unanswered_count: number; independent_question_count: number; numerator: string; denominator: string; correctness: string | null } | null; mastery_window_days: 90; mastery: MasteryItem[]; }
function meta(v: LearningView): LearningMeta { return { status: v.status, source_watermark: v.source_watermark, generated_at: v.generated_at, rule_version: v.rule_version }; }
function masteryItem(r: MasteryRow): MasteryItem { return { knowledge_point_id: r.knowledge_point_id, independent_question_count: r.independent_question_count, numerator: r.numerator, denominator: r.denominator, mastery: r.mastery, status: r.classification, last_evidence_at: r.last_evidence_at.toISOString() }; }
@Injectable()
export class LearningService {
  readonly sources: AssessmentSources;
  constructor(readonly database: Database, readonly access: LearningAccess, readonly assessment: AssessmentService) { this.sources = new AssessmentSources(database.db); }
  private c<T extends Document>(name: string) { return this.database.db.collection<T>(name); }
  private async subject(ctx: AssessmentContext, value: unknown) { const key = id(value); if (!await this.c<Document & { _id: string }>('subjects').findOne({ _id: key }, { session: ctx.session })) fail(404, 'NOT_FOUND', '学科不存在'); return key; }
  async mastery(req: ApiRequest, raw: unknown): Promise<MasteryResponse> {
    const q = object(raw, ['subject_id', 'textbook_edition_id', 'knowledge_point_id', 'cursor', 'limit']);
    return this.access.run(req, false, async ctx => {
      const subject = await this.subject(ctx, q.subject_id), limit = q.limit === undefined ? 20 : integer(Number(q.limit), 'limit', 1, 50);
      const view = await readLearningView(this.database.db, ctx, subject, false);
      let allowed: Set<string> | null = null;
      if (q.textbook_edition_id !== undefined) {
        const editionId = id(q.textbook_edition_id);
        if (!await this.c<Document & { _id: string }>('textbook_editions').findOne({ _id: editionId, org_id: ctx.orgId }, { session: ctx.session })) fail(404, 'NOT_FOUND', '教材不存在');
        const book = await this.sources.textbook(ctx, editionId, true);
        if (book.subject_id !== subject) fail(404, 'NOT_FOUND', '教材学科不匹配');
        allowed = new Set(book.knowledge_point_ids);
      }
      const point = q.knowledge_point_id === undefined ? null : id(q.knowledge_point_id);
      if (point && (!await this.c<Document & { _id: string }>('knowledge_points').findOne({ _id: point, subject_id: subject }, { session: ctx.session }) || allowed && !allowed.has(point))) fail(404, 'NOT_FOUND', '知识点不存在');
      const page = this.access.cursor(ctx, 'mastery', { subject, edition: q.textbook_edition_id ?? null, point }, view.source_watermark, q.cursor, limit);
      const rows = view.mastery.filter(r => (!allowed || allowed.has(r.knowledge_point_id)) && (!point || r.knowledge_point_id === point)).sort((a, b) => a.knowledge_point_id.localeCompare(b.knowledge_point_id)).filter(r => !page.after || r.knowledge_point_id > page.after);
      const deliveredPoints = new Set(rows.slice(0, limit).map(row => row.knowledge_point_id));
      const contributions = view.evidence.filter(row => row.qualification === 'first' && row.knowledge_weights.some(weight => deliveredPoints.has(weight.knowledge_point_id)));
      await deliverLearningFeedback(this.database.db, ctx, view, contributions.map(row => row.submission_id), contributions.map(row => row.session_item_id));
      return { ...meta(view), evidence_window_days: 90, items: rows.slice(0, limit).map(masteryItem), next_cursor: rows.length > limit ? page.next(rows[limit - 1].knowledge_point_id) : null };
    });
  }
  async reports(req: ApiRequest, raw: unknown): Promise<ReportsResponse> {
    const q = object(raw, ['subject_id', 'period']);
    if (q.period !== '7d' && q.period !== '30d') fail(422, 'VALIDATION_ERROR', '报告周期必须为7d或30d');
    const period = q.period;
    return this.access.run(req, false, async ctx => {
      const subject = await this.subject(ctx, q.subject_id), view = await readLearningView(this.database.db, ctx, subject, false), r = view.reports.find(item => item.period === period);
      const activity = r ? { submission_count: r.submission_count, attempt_count: r.attempt_count, correct_count: r.correct_count, incorrect_count: r.incorrect_count, unanswered_count: r.unanswered_count, independent_question_count: r.independent_question_count, numerator: r.numerator, denominator: r.denominator, correctness: percentage(BigInt(r.numerator), BigInt(r.denominator)) } : null;
      const windowInputs = new Set(view.inputs.filter(input => period === '7d' ? input.in_7d : input.in_30d).map(input => input.submission_id));
      const contributions = view.evidence.filter(row => row.qualification === 'first' || windowInputs.has(row.submission_id));
      await deliverLearningFeedback(this.database.db, ctx, view, contributions.map(row => row.submission_id), contributions.map(row => row.session_item_id));
      return { ...meta(view), period, activity, mastery_window_days: 90, mastery: view.mastery.map(masteryItem) };
    });
  }
  async mistakes(req: ApiRequest, raw: unknown): Promise<MistakesResponse> {
    const q = object(raw, ['subject_id', 'status', 'cursor', 'limit']), status = q.status ?? 'active';
    if (!['active', 'resolved', 'all'].includes(status as string)) fail(422, 'VALIDATION_ERROR', '错题状态无效');
    return this.access.run(req, false, async ctx => {
      const subject = await this.subject(ctx, q.subject_id), limit = q.limit === undefined ? 20 : integer(Number(q.limit), 'limit', 1, 50);
      const view = await readLearningView(this.database.db, ctx, subject, false), page = this.access.cursor(ctx, 'mistakes', { subject, status }, view.source_watermark, q.cursor, limit);
      const rows = view.mistakes.filter(r => status === 'all' || r.status === status).sort((a, b) => b.last_attempt_at.getTime() - a.last_attempt_at.getTime() || a.submission_id.localeCompare(b.submission_id) || a.latest_visible_item.localeCompare(b.latest_visible_item));
      const start = page.after ? rows.findIndex(r => r._id === page.after) + 1 : 0;
      if (page.after && !start) fail(422, 'CURSOR_INVALID', '错题游标无效');
      const selected = rows.slice(start, start + limit), items: MistakeItem[] = [];
      for (const r of selected) {
        const item = await this.c<SessionItem>('session_items').findOne({ _id: r.latest_visible_item, org_id: ctx.orgId }, { session: ctx.session });
        if (!item) fail(503, 'INVALID_STUDENT_EVIDENCE', '错题证据不完整');
        items.push({ id: r._id, question_id: r.question_id, status: r.status, title: item.snapshot.title, question_type: item.snapshot.question_type, session_item_id: item._id, submission_id: r.submission_id, last_attempt_at: r.last_attempt_at.toISOString() });
      }
      const deliveredQuestions = new Set(rows.map(row => row.question_id));
      const contributions = view.evidence.filter(row => deliveredQuestions.has(row.question_id));
      await deliverLearningFeedback(this.database.db, ctx, view, contributions.map(row => row.submission_id), contributions.map(row => row.session_item_id));
      return { ...meta(view), items, total: rows.length, next_cursor: start + limit < rows.length ? page.next(selected[selected.length - 1]._id) : null };
    });
  }
  private async currentMistake(ctx: AssessmentContext, key: string) {
    const row = await this.c<MistakeRow>('mistake_entries').findOne({ _id: id(key), org_id: ctx.orgId, member_id: ctx.memberId }, { session: ctx.session });
    if (!row) fail(404, 'NOT_FOUND', '错题不存在');
    const view = await readLearningView(this.database.db, ctx, row.subject_id, false);
    if (!view.mistakes.some(item => item._id === row._id)) fail(409, 'PROJECTION_CHANGED', '错题已变化，请重新读取');
    return { row, view };
  }
  async mistake(req: ApiRequest, key: string): Promise<MistakeResponse> {
    return this.access.run(req, false, ctx => this.mistakeInContext(ctx, key));
  }
  async mistakeInContext(ctx: AssessmentContext, key: string): Promise<MistakeResponse> {
      this.access.assessment.require(ctx, 'learning:self');
      if (ctx.studentConflict || ['content:edit', 'content:review', 'assessment:manage', 'assessment:review'].some(cap => ctx.capabilities.includes(cap)))
        fail(403, 'FORBIDDEN', '兼任内容或评估管理者不能访问学生学情');
      const { row, view } = await this.currentMistake(ctx, key);
      const submission = await this.c<Submission>('submissions').findOne({ _id: row.submission_id, org_id: ctx.orgId, user_id: ctx.userId, member_id: ctx.memberId }, { session: ctx.session });
      if (!submission) fail(409, 'PROJECTION_CHANGED', '错题已变化');
      const evidence = await studentAssessmentEvidence(this.database.db, ctx, submission, 'feedback_delivery', new Set([row.latest_visible_item]));
      if (evidence.status !== 'released' || !evidence.run) fail(409, 'PROJECTION_CHANGED', '错题已变化');
      const item = evidence.items.find(item => item._id === row.latest_visible_item), result = evidence.results.find(item => item.session_item_id === row.latest_visible_item);
      if (!item || !result) fail(503, 'INVALID_STUDENT_EVIDENCE', '错题证据不完整');
      const basis = evidence.run.corrections.find(c => c.session_item_id === item._id)?.snapshot ?? item.snapshot;
      const answer = await this.c<Answer>('answers').findOne({ org_id: ctx.orgId, session_id: submission.session_id, session_item_id: item._id }, { session: ctx.session });
      await deliverLearningFeedback(this.database.db, ctx, view, [], []);
      return { ...meta(view), id: row._id, question_id: row.question_id, mistake_status: row.status, submission_id: row.submission_id, grading_revision: evidence.run.revision, question: itemDto(item, answer?.answer ?? null), student_answer: answer?.answer ?? null, standard_answer: basis.answer, explanation: basis.explanation, score: scoreText(scoreCents(result.score)), verdict: result.verdict, practice_version_policy: 'current_published' as const };
  }
  async practice(req: ApiRequest, key: string, raw: unknown) {
    object(raw, []); id(key);
    return this.access.run(req, true, async ctx => {
      const accepted = await this.access.idempotent(ctx, req, 'learning.mistake.practice', key, {}, async () => {
        const { row } = await this.currentMistake(ctx, key);
        const candidates = await this.c<QuestionVersion>('question_versions').find({ org_id: ctx.orgId, question_id: row.question_id, status: 'published', access_revoked_at: null, 'license.granted': true }, { session: ctx.session }).sort({ version_no: -1, _id: 1 }).limit(101).toArray();
        if (candidates.length > 100) fail(409, 'PRACTICE_SOURCE_UNAVAILABLE', '当前题目版本不可用');
        for (const candidate of candidates) {
          let snapshot;
          try { snapshot = await this.sources.question(ctx, candidate._id, true); await this.sources.guard(ctx, [candidate._id], 'practice'); }
          catch (error) { if (!(error instanceof HttpException) || ![403, 404, 409, 422].includes(error.getStatus())) throw error; continue; }
          const session = await this.assessment.createPracticeFromSnapshots(ctx, [snapshot], { textbook_edition_id: null, chapter_id: null, knowledge_point_ids: snapshot.knowledge_point_ids, difficulty: snapshot.difficulty });
          return session;
        }
        fail(409, 'PRACTICE_SOURCE_UNAVAILABLE', '当前没有合法已发布版本可供重练');
      });
      await this.assessment.restorePracticeInContext(ctx, accepted.id);
      return accepted;
    });
  }
}
export interface MistakeResponse extends LearningMeta {
  id: string; question_id: string; mistake_status: 'active' | 'resolved'; submission_id: string; grading_revision: number;
  question: { id: string; position: number; question_type: 'single' | 'multiple' | 'numeric'; title: string; prompt: string; options: { id: string; text: string }[]; resource_ids: string[]; max_score: string; answer: StudentAnswer };
  student_answer: StudentAnswer; standard_answer: string; explanation: string; score: string; verdict: 'correct' | 'incorrect' | 'unanswered'; practice_version_policy: 'current_published';
}
