import { createHash, randomUUID } from 'node:crypto';
import type { Db, Document } from 'mongodb';
import type { AssessmentContext, AssessmentQuestionState, AssessmentResourceReference, QuestionSnapshot, Quiz } from '../assessment/contracts';
import { fail } from '../errors';
import { uuidPattern } from './access';
import { canonical, validateQuestion } from './dto';
import { CONTENT_COLLECTIONS, type BaseVersion, type ChapterRecord, type ContentKind, type FileResource, type QuestionVersion } from './contracts';
import { touchLearningScope } from '../learning/tracking';

/** Internal only: callers authorize the assessment operation before entering this boundary. */
export class AssessmentSources {
  constructor(readonly db: Db) {}
  private authorized(ctx: AssessmentContext) {
    const worker = ctx.capabilities.length === 1 && (ctx.userId === 'system:assessment' && ctx.capabilities[0] === 'assessment:worker' || ctx.userId === 'system:learning' && ctx.capabilities[0] === 'learning:projection-worker');
    const internal = ctx.userId.startsWith('system:') || ctx.capabilities.some(c => c === 'assessment:worker' || c === 'learning:projection-worker');
    if (internal ? !worker : !ctx.capabilities.some(c => ['learning:self', 'assessment:manage', 'assessment:review'].includes(c))) fail(403, 'FORBIDDEN', '未获评估来源访问权限');
    if (!ctx.session.inTransaction()) fail(503, 'ASSESSMENT_TRANSACTION_REQUIRED', '来源访问必须位于调用者事务');
  }
  private async now(ctx: AssessmentContext): Promise<Date> {
    const row = await this.db.aggregate<{ now: Date }>([{ $documents: [{}] }, { $project: { _id: 0, now: '$$NOW' } }], { session: ctx.session }).next();
    if (!(row?.now instanceof Date)) fail(503, 'DATABASE_TIME_UNAVAILABLE', '数据库时间不可用');
    return row.now;
  }
  private async owner(ctx: AssessmentContext, kind: ContentKind, id: string, newUse: boolean): Promise<BaseVersion> {
    this.authorized(ctx);
    if (ctx.userId === 'system:learning' && newUse) fail(403, 'FORBIDDEN', '投影不能创建来源引用');
    if (!uuidPattern.test(id)) fail(404, 'NOT_FOUND', '来源不存在');
    const owners = this.db.collection<BaseVersion>(CONTENT_COLLECTIONS[kind]);
    const row = await owners.findOne({ _id: id, org_id: ctx.orgId }, { session: ctx.session });
    if (!row || !Number.isSafeInteger(row.access_revision)) fail(409, 'CONTENT_UNAVAILABLE', '来源不可用');
    const fenced = await owners.findOneAndUpdate({
      _id: id, org_id: ctx.orgId, access_revision: row.access_revision,
      status: { $in: newUse ? ['published'] : ['published', 'retired'] },
      access_revoked_at: null, 'license.granted': true, 'license.source': { $regex: '\\S' },
      $expr: { $or: [
        { $eq: ['$license.expires_at', null] },
        { $gt: [{ $convert: { input: '$license.expires_at', to: 'date', onError: null, onNull: null } }, '$$NOW'] },
      ] },
    }, { $inc: { access_revision: 1 } }, { session: ctx.session, returnDocument: 'after' });
    if (!fenced) fail(409, 'CONTENT_UNAVAILABLE', '来源已撤回、过期或授权不可用');
    return fenced;
  }
  private async files(ctx: AssessmentContext, snapshot: QuestionSnapshot): Promise<FileResource[]> {
    if (snapshot.resource_ids.length > 20 || new Set(snapshot.resource_ids).size !== snapshot.resource_ids.length) fail(409, 'CONTENT_UNAVAILABLE', '来源附件无效');
    const rows = await this.db.collection<FileResource>('file_resources').find({
      _id: { $in: snapshot.resource_ids }, org_id: ctx.orgId, owner_type: 'question', owner_version_id: snapshot.question_version_id,
      status: 'ready', scan_status: 'clean', deletion_requested_at: null, deleted_at: null,
    }, { session: ctx.session }).toArray();
    const byId = new Map(rows.map(row => [row._id, row]));
    return snapshot.resource_ids.map(id => {
      const row = byId.get(id);
      if (!row || !row.checksum || !row.mime || !Number.isSafeInteger(row.size) || row.size! <= 0) fail(409, 'FILE_NOT_READY', '来源附件不可用');
      return row;
    });
  }
  async question(ctx: AssessmentContext, versionId: string, newUse: boolean): Promise<QuestionSnapshot> {
    const row = await this.owner(ctx, 'question', versionId, newUse) as QuestionVersion;
    validateQuestion(row);
    const points = await this.db.collection('knowledge_points').countDocuments({ _id: { $in: row.knowledge_point_ids } as never, subject_id: row.subject_id }, { session: ctx.session });
    if (points !== row.knowledge_point_ids.length) fail(409, 'CONTENT_UNAVAILABLE', '来源知识映射不可用');
    const snapshot: QuestionSnapshot = {
      question_version_id: row._id, question_id: row.question_id, subject_id: row.subject_id, title: row.title,
      question_type: row.question_type, prompt: row.prompt, options: row.options, answer: row.answer, explanation: row.explanation,
      scoring_rule: row.scoring_rule!, knowledge_point_ids: row.knowledge_point_ids, knowledge_weights: row.knowledge_weights,
      difficulty: row.difficulty, difficulty_basis: row.difficulty_basis, resource_ids: row.resource_ids,
      created_by: row.created_by, contributors: row.contributors, published_by: row.published_by, display_digest: '',
    };
    snapshot.display_digest = await this.digest(snapshot, ctx);
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 128 * 1024) fail(413, 'SNAPSHOT_TOO_LARGE', '题项快照超过上限');
    return snapshot;
  }
  async textbook(ctx: AssessmentContext, editionId: string, newUse: boolean): Promise<{ subject_id: string; knowledge_point_ids: string[]; chapters: Array<{ id: string; knowledge_point_ids: string[] }> }> {
    const edition = await this.owner(ctx, 'textbook', editionId, newUse);
    const root = await this.db.collection<Document & { _id: string }>('textbooks').findOne({ _id: edition.textbook_id, org_id: ctx.orgId }, { session: ctx.session });
    if (!root || typeof root.subject_id !== 'string') fail(409, 'CONTENT_UNAVAILABLE', '教材身份不可用');
    const chapters = await this.db.collection<ChapterRecord>('chapters').find({ org_id: ctx.orgId, textbook_edition_id: editionId }, { session: ctx.session }).sort({ position: 1, _id: 1 }).limit(101).toArray();
    if (!chapters.length || chapters.length > 100) fail(409, 'CONTENT_UNAVAILABLE', '教材章节不可用');
    return { subject_id: root.subject_id, knowledge_point_ids: [...new Set(chapters.flatMap(ch => ch.knowledge_point_ids))], chapters: chapters.map(ch => ({ id: ch._id, knowledge_point_ids: ch.knowledge_point_ids })) };
  }
  async guard(ctx: AssessmentContext, versionIds: string[], mode: 'practice' | 'quiz' | 'publish' | 'visibility' | 'feedback', quizId?: string): Promise<void> {
    this.authorized(ctx);
    if (ctx.userId === 'system:learning' && mode !== 'visibility') fail(403, 'FORBIDDEN', '投影仅能检查可见性');
    if ((mode === 'publish' || mode === 'quiz') && (!quizId || !uuidPattern.test(quizId))) fail(409, 'QUESTION_EMBARGOED', '考试保密上下文无效');
    const states = this.db.collection<AssessmentQuestionState>('assessment_question_states');
    const now = await this.now(ctx);
    const checked: Array<{ state: AssessmentQuestionState; active: boolean }> = [];
    for (const id of [...new Set(versionIds)].sort()) {
      const filter = { org_id: ctx.orgId, question_version_id: id };
      await states.updateOne(filter, { $setOnInsert: { _id: randomUUID(), ...filter, revision: 1, embargo_quiz_id: null, answer_disclosed: false, created_at: now, updated_at: now } }, { upsert: true, session: ctx.session });
      const state = await states.findOne(filter, { session: ctx.session });
      if (!state) fail(409, 'QUESTION_EMBARGOED', '题目保密状态不可用');
      let active = false;
      if (state.embargo_quiz_id) {
        const quiz = await this.db.collection<Quiz>('quizzes').findOne({ _id: state.embargo_quiz_id, org_id: ctx.orgId }, { session: ctx.session });
        // A missing/malformed owner never silently releases an embargo.
        active = !quiz || !(quiz.release_at instanceof Date) || quiz.release_at > now;
      }
      if (mode === 'publish' && (state.answer_disclosed || active && state.embargo_quiz_id !== quizId) || mode === 'quiz' && active && state.embargo_quiz_id !== quizId || (mode === 'practice' || mode === 'visibility' || mode === 'feedback') && active) fail(409, 'QUESTION_EMBARGOED', '题目处于考试保密期或已披露');
      checked.push({ state, active });
    }
    const changes = checked.filter(({ state, active }) => mode === 'publish' || state.embargo_quiz_id !== null && !active).map(({ state }) => state.question_version_id);
    if (changes.length) {
      const rows = await this.db.collection<QuestionVersion>('question_versions').find({ org_id: ctx.orgId, _id: { $in: changes } }, { session: ctx.session }).toArray();
      if (rows.length !== changes.length) fail(409, 'CONTENT_UNAVAILABLE', '保密题目来源不存在');
      for (const subject of [...new Set(rows.map(row => row.subject_id))].sort()) await touchLearningScope(this.db, ctx, subject, true);
    }
    // Callers may return a withheld result after catching an embargo: check the entire set before disclosing any item.
    for (const { state, active } of checked) {
      // Visibility notifications share the publish fence but do not disclose feedback to a student.
      const changed = await states.updateOne({ _id: state._id, org_id: ctx.orgId, revision: state.revision }, {
        $inc: { revision: 1 }, $set: { updated_at: now, embargo_quiz_id: mode === 'publish' ? quizId! : active ? state.embargo_quiz_id : null, answer_disclosed: state.answer_disclosed || mode === 'feedback' },
      }, { session: ctx.session });
      if (changed.modifiedCount !== 1) fail(409, 'QUESTION_EMBARGOED', '题目保密状态已变化');
    }
  }
  /** Internal dependency deadline; never include this value in a student DTO. */
  async nextCheckAt(ctx: AssessmentContext, versionIds: string[], editionId: string | null, quizId: string | null, now: Date): Promise<Date | null> {
    this.authorized(ctx);
    const options = { session: ctx.session };
    const questions = await this.db.collection<QuestionVersion>('question_versions').find({ org_id: ctx.orgId, _id: { $in: versionIds } }, options).toArray();
    const edition = editionId ? await this.db.collection<BaseVersion>('textbook_editions').findOne({ org_id: ctx.orgId, _id: editionId }, options) : null;
    const states = await this.db.collection<AssessmentQuestionState>('assessment_question_states').find({ org_id: ctx.orgId, question_version_id: { $in: versionIds } }, options).toArray();
    const quizIds = [...new Set([quizId, ...states.map(state => state.embargo_quiz_id)].filter((id): id is string => id !== null))];
    const quizzes = await this.db.collection<Quiz>('quizzes').find({ org_id: ctx.orgId, _id: { $in: quizIds } }, options).toArray();
    const deadlines = [...questions, ...(edition ? [edition] : [])].map(row => row.license.expires_at === null ? null : new Date(row.license.expires_at));
    deadlines.push(...quizzes.map(quiz => quiz.release_at));
    const future = deadlines.filter((date): date is Date => date instanceof Date && Number.isFinite(date.getTime()) && date > now);
    return future.length ? new Date(Math.min(...future.map(date => date.getTime()))) : null;
  }
  async reference(ctx: AssessmentContext, snapshot: QuestionSnapshot, referenceType: 'paper_item' | 'session_item', referenceId: string): Promise<void> {
    if (ctx.userId === 'system:learning') fail(403, 'FORBIDDEN', '投影不能创建来源引用');
    const owner = await this.owner(ctx, 'question', snapshot.question_version_id, false);
    if (snapshot.resource_ids.some(id => !owner.resource_ids.includes(id))) fail(409, 'CONTENT_UNAVAILABLE', '快照附件不属于来源');
    const files = await this.files(ctx, snapshot);
    const now = await this.now(ctx);
    for (const file of files) {
      const filter = { org_id: ctx.orgId, reference_type: referenceType, reference_id: referenceId, file_id: file._id };
      await this.db.collection<AssessmentResourceReference>('assessment_resource_references').updateOne(filter, { $setOnInsert: { _id: randomUUID(), ...filter, owner_type: 'question', owner_version_id: snapshot.question_version_id, created_at: now, updated_at: now } }, { upsert: true, session: ctx.session });
    }
  }
  async digest(snapshot: QuestionSnapshot, ctx?: AssessmentContext): Promise<string> {
    let attachments: Array<{ checksum: string | null; mime: string | null; size: number | null }>;
    if (ctx) attachments = await this.files(ctx, snapshot);
    else {
      const rows = await this.db.collection<FileResource>('file_resources').find({ _id: { $in: snapshot.resource_ids }, owner_type: 'question', owner_version_id: snapshot.question_version_id, status: 'ready', scan_status: 'clean', deletion_requested_at: null, deleted_at: null }).toArray();
      const byId = new Map(rows.map(row => [row._id, row]));
      attachments = snapshot.resource_ids.map(id => { const row = byId.get(id); if (!row || !row.checksum || !row.mime || row.size === null) fail(409, 'FILE_NOT_READY', '附件不可用'); return row; });
    }
    return createHash('sha256').update(canonical({
      title: snapshot.title, subject_id: snapshot.subject_id, question_type: snapshot.question_type, prompt: snapshot.prompt,
      options: snapshot.options, knowledge_point_ids: [...snapshot.knowledge_point_ids].sort(),
      knowledge_weights: [...snapshot.knowledge_weights].sort((a, b) => a.knowledge_point_id.localeCompare(b.knowledge_point_id)),
      attachments: attachments.map(file => ({ checksum: file.checksum, mime: file.mime, size: file.size })),
    })).digest('hex');
  }
}
