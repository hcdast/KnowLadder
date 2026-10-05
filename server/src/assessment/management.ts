import { newId } from "../database/object-id";
import { HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Decimal128, type Document, type Filter } from 'mongodb';
import { Database } from '../database/database';
import { collections, type Member, type User } from '../database/contracts';
import { ApiRequest, fail } from '../errors';
import { AssessmentSources } from '../content/assessment-sources';
import type { QuestionVersion } from '../content/contracts';
import { AssessmentAccess } from './access';
import type { AssessmentContext, Paper, PaperItem, QuestionSnapshot, Quiz, QuizAudience } from './contracts';
import { boundedSnapshots, canonical, difficulty, id, ids, integer, object, pageInput, quizDto, text } from './dto';
import { scoreCents, scoreText } from './scoring';
import { recordLearningFeedback } from '../learning/tracking';
import { TeachingAccess } from '../teaching/access';
import { CLASS_STUDENT_LIMIT, currentlyValid, type ClassMemberRecord, type ClassRecord } from '../teaching/contracts';

import { activeMemberGrants, activeMemberRoles, scopedBusinessCapabilities } from '../administration/authorization';

const conflictingCapabilities = ['content:edit', 'content:review', 'assessment:manage', 'assessment:review'];
const quizKeys = ['title', 'subject_id', 'opens_at', 'closes_at', 'release_at', 'duration_seconds', 'max_attempts', 'items', 'audience_member_ids', 'source_class_ids'];
function dateInput(value:unknown, name:string):Date {
  const raw = text(value, name, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw) || !Number.isFinite(Date.parse(raw))) fail(422, 'VALIDATION_ERROR', `${name}无效`);
  return new Date(raw);
}
function maxScore(value:unknown):Decimal128 {
  const raw = text(value, 'max_score', 6);
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?$/.test(raw)) fail(422, 'SCORING_RULE_INVALID', '满分须为最多两位小数的十进制字符串');
  const cents = scoreCents(raw);
  if (cents <= 0n || cents > 10000n) fail(422, 'SCORING_RULE_INVALID', '满分须大于0且不超过100');
  return Decimal128.fromString(scoreText(cents));
}
interface QuizPaperItemInput {
  question_version_id:string;
  max_score:Decimal128 | null;
}
interface QuizInput {
  fields:{
    title:string;
    subject_id:string;
    opens_at:Date;
    closes_at:Date;
    release_at:Date;
    duration_seconds:number;
    max_attempts:number;
  };
  items:QuizPaperItemInput[];
  audience:string[] | null;
  source_class_ids:string[] | null;
  expected:number | null;
}
function quizInput(raw:unknown, patch:boolean):QuizInput {
  const body = object(raw, [...quizKeys, ...(patch ? ['expected_revision'] : [])]);
  const opens_at = dateInput(body.opens_at, 'opens_at'), closes_at = dateInput(body.closes_at, 'closes_at'), release_at = dateInput(body.release_at, 'release_at');
  if (!(opens_at < closes_at && closes_at <= release_at)) fail(422, 'VALIDATION_ERROR', '须满足开场早于关场且出分不早于关场');
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) fail(422, 'VALIDATION_ERROR', '试卷须包含1至50题');
  const items = body.items.map(rawItem => {
    const item = object(rawItem, ['question_version_id', 'max_score']);
    return { question_version_id:id(item.question_version_id), max_score:item.max_score === undefined ? null : maxScore(item.max_score) };
  });
  if (new Set(items.map(item => item.question_version_id)).size !== items.length) fail(422, 'VALIDATION_ERROR', '题目版本不能重复');
  const hasAudience = body.audience_member_ids !== undefined;
  const hasSource = body.source_class_ids !== undefined;
  if (hasAudience === hasSource) fail(422, 'VALIDATION_ERROR', 'audience_member_ids与source_class_ids须互斥且必选其一');
  const audience = hasAudience ? ids(body.audience_member_ids, 'audience_member_ids', CLASS_STUDENT_LIMIT).sort() : null;
  if (audience && !audience.length) fail(422, 'VALIDATION_ERROR', '受众不能为空');
  const source_class_ids = hasSource ? ids(body.source_class_ids, 'source_class_ids', 5).sort() : null;
  if (source_class_ids && !source_class_ids.length) fail(422, 'VALIDATION_ERROR', 'source_class_ids不能为空');
  return { fields:{title:text(body.title, 'title', 200), subject_id:id(body.subject_id), opens_at, closes_at, release_at, duration_seconds:integer(body.duration_seconds, 'duration_seconds', 60, 7200), max_attempts:body.max_attempts === undefined ? 1 : integer(body.max_attempts, 'max_attempts', 1, 3)}, items, audience, source_class_ids, expected:patch ? integer(body.expected_revision, 'expected_revision') : null };
}
function questionDto(q:QuestionSnapshot) {
  return {id:q.question_version_id, question_id:q.question_id, subject_id:q.subject_id, title:q.title, question_type:q.question_type, prompt:q.prompt, options:q.options, answer:q.answer, explanation:q.explanation, scoring_rule:q.scoring_rule, knowledge_point_ids:q.knowledge_point_ids, knowledge_weights:q.knowledge_weights, difficulty:q.difficulty, difficulty_basis:q.difficulty_basis, resource_ids:q.resource_ids, created_by:q.created_by, contributors:q.contributors, published_by:q.published_by};
}

export class AssessmentManagement {
  private readonly sources:AssessmentSources;
  private readonly teaching:TeachingAccess;
  constructor(private readonly database:Database, private readonly access:AssessmentAccess) {
    this.sources = new AssessmentSources(database.db);
    this.teaching = new TeachingAccess(access);
  }
  private requireReader(ctx:AssessmentContext) {
    if (!ctx.capabilities.some(cap => cap === 'assessment:manage' || cap === 'assessment:review')) fail(403, 'FORBIDDEN', '无权管理评估');
  }
  private async quiz(ctx:AssessmentContext, key:string):Promise<Quiz> {
    this.requireReader(ctx);
    const row = await this.database.db.collection<Quiz>('quizzes').findOne({_id:id(key), org_id:ctx.orgId}, {session:ctx.session});
    if (!row || (!ctx.capabilities.includes('assessment:review') && row.created_by !== ctx.userId)) fail(404, 'NOT_FOUND', '考试不存在');
    return row;
  }
  private async participantRecords(ctx:AssessmentContext, memberIds:string[]) {
    const c = collections(this.database.db), options = {session:ctx.session};
    const members = await c.members.find({org_id:ctx.orgId, _id:{$in:memberIds}, status:'active'}, options).toArray();
    const users = await c.users.find({_id:{$in:members.map(m => m.user_id)}, status:'active', must_change_password:false,
      $or:[{privacy_state:'active'},{privacy_state:{$exists:false}}]}, options).toArray();
    const assignments = await activeMemberRoles(this.database.db, {org_id:ctx.orgId, member_id:{$in:memberIds}}, ctx.session);
    const roles = await c.roles.find({_id:{$in:[...new Set(assignments.map(a => a.role_id))]}}, options).toArray();
    const grants = await activeMemberGrants(this.database.db, {org_id:ctx.orgId, member_id:{$in:memberIds}}, ctx.session);
    const userMap = new Map(users.map(user => [user._id, user]));
    const roleMap = new Map(roles.map(role => [role._id, role.capabilities]));
    const caps = new Map<string, string[]>();
    for (const assignment of assignments) caps.set(assignment.member_id, [...(caps.get(assignment.member_id) ?? []), ...(roleMap.get(assignment.role_id) ?? [])]);
    for (const grant of grants) caps.set(grant.member_id, [...(caps.get(grant.member_id) ?? []), grant.capability]);
    const eligible = members.flatMap(member => {
      const user = userMap.get(member.user_id), capabilities = caps.get(member._id) ?? [];
      return user && capabilities.includes('learning:self') && capabilities.includes('account:read') && !capabilities.some(cap => conflictingCapabilities.includes(cap)) ? [{member, user}] : [];
    });
    const available = [];
    for (const participant of eligible) {
      const scoped = await scopedBusinessCapabilities(this.database.db, participant.user._id, ctx.orgId, ctx.session);
      if (!scoped.some(cap => conflictingCapabilities.includes(cap))) available.push(participant);
    }
    return available;
  }
  private async fenceParticipant(ctx:AssessmentContext, member:Member, user:User) {
    await this.access.auth.fenceUser(user, ctx.session);
    const result = await collections(this.database.db).members.updateOne({_id:member._id, org_id:ctx.orgId, status:'active', authorization_revision:member.authorization_revision}, {$inc:{authorization_revision:1}}, {session:ctx.session});
    if (result.modifiedCount !== 1) fail(409, 'AUTHORIZATION_CHANGED', '受众资格已变化');
  }
  private async validateParticipants(ctx:AssessmentContext, memberIds:string[], quiz:Quiz, snapshots:QuestionSnapshot[]) {
    const records = await this.participantRecords(ctx, memberIds);
    if (records.length !== memberIds.length) fail(422, 'PARTICIPANT_INVALID', '受众须为有效且无职责冲突的学习成员');
    const excluded = new Set([quiz.created_by, ...quiz.contributors, quiz.published_by, ...snapshots.flatMap(q => [q.created_by, ...q.contributors, q.published_by])]);
    for (const {member, user} of records.sort((a,b) => a.member._id.localeCompare(b.member._id))) {
      if (excluded.has(user._id)) fail(422, 'PARTICIPANT_CONFLICT', '题目或考试作者、贡献者和审核者不得参试');
      await this.fenceParticipant(ctx, member, user);
    }
  }
  public async validateParticipant(ctx:AssessmentContext, memberId:string, quiz:Quiz, snapshots:QuestionSnapshot[]):Promise<void> {
    await this.validateParticipants(ctx, [id(memberId)], quiz, snapshots);
  }
  private async paper(ctx:AssessmentContext, quiz:Quiz) {
    const paper = await this.database.db.collection<Paper>('papers').findOne({org_id:ctx.orgId, ...(quiz.published_paper_id ? {_id:quiz.published_paper_id, quiz_id:quiz._id, status:'frozen' as const} : {quiz_id:quiz._id, revision:quiz.revision, status:'draft' as const})}, {session:ctx.session});
    if (!paper) fail(409, 'PAPER_INVALID', '试卷修订不存在');
    const items = await this.database.db.collection<PaperItem>('paper_items').find({org_id:ctx.orgId, paper_id:paper._id}, {session:ctx.session}).sort({position:1}).limit(51).toArray();
    if (!items.length || items.length > 50) fail(409, 'PAPER_INVALID', '试卷题项数量无效');
    return {paper, items};
  }
  private async authorizeClassExpand(ctx:AssessmentContext, classId:string, subjectId:string):Promise<ClassRecord> {
    if (ctx.capabilities.includes('teaching:assign') || ctx.capabilities.includes('organization:admin') || ctx.platform && ctx.capabilities.includes('assessment:manage')) {
      const clazz = await this.database.db.collection<ClassRecord>('classes').findOne({_id:id(classId), org_id:ctx.orgId}, {session:ctx.session});
      if (!clazz || clazz.status === 'archived') fail(404, 'NOT_FOUND', '班级不存在');
      return clazz;
    }
    const {clazz} = await this.teaching.requireAssignment(ctx, classId, subjectId);
    return clazz;
  }
  private async expandFromClasses(ctx:AssessmentContext, classIds:string[], subjectId:string):Promise<string[]> {
    const now = await this.access.now(ctx);
    const members = new Set<string>();
    for (const classId of classIds) {
      await this.authorizeClassExpand(ctx, classId, subjectId);
      const rows = await this.database.db.collection<ClassMemberRecord>('class_members').find({
        org_id:ctx.orgId, class_id:classId, kind:'student', status:'active',
      }, {session:ctx.session}).limit(CLASS_STUDENT_LIMIT + 1).toArray();
      for (const row of rows) if (currentlyValid(row, now)) members.add(row.member_id);
    }
    const audience = [...members].sort();
    if (!audience.length) fail(422, 'VALIDATION_ERROR', '展开后受众不能为空');
    if (audience.length > CLASS_STUDENT_LIMIT) fail(422, 'CLASS_TOO_LARGE', '展开后受众超过200人');
    return audience;
  }
  private async resolveAudience(ctx:AssessmentContext, input:QuizInput):Promise<string[]> {
    if (input.audience) return input.audience;
    return this.expandFromClasses(ctx, input.source_class_ids!, input.fields.subject_id);
  }
  private async replace(ctx:AssessmentContext, quiz:Quiz, input:QuizInput, audience:string[], now:Date) {
    const snapshots = new Map<string, QuestionSnapshot>();
    for (const item of [...input.items].sort((a,b) => a.question_version_id.localeCompare(b.question_version_id))) snapshots.set(item.question_version_id, await this.sources.question(ctx, item.question_version_id, true));
    const paper:Paper = {_id:newId(), org_id:ctx.orgId, quiz_id:quiz._id, revision:quiz.revision, status:'draft', created_at:now, updated_at:now};
    const items:PaperItem[] = input.items.map((item, position) => ({_id:newId(), org_id:ctx.orgId, paper_id:paper._id, position, snapshot:snapshots.get(item.question_version_id)!, max_score:item.max_score ?? maxScore(snapshots.get(item.question_version_id)!.scoring_rule.max_score), created_at:now, updated_at:now}));
    if (new Set(items.map(item => item.snapshot.question_id)).size !== items.length || items.some(item => item.snapshot.subject_id !== quiz.subject_id)) fail(422, 'QUESTION_SCOPE_INVALID', '题目须同学科且题目身份不能重复');
    boundedSnapshots(items);
    await this.validateParticipants(ctx, audience, quiz, items.map(item => item.snapshot));
    await this.database.db.collection<Paper>('papers').insertOne(paper, {session:ctx.session});
    await this.database.db.collection<PaperItem>('paper_items').insertMany(items, {session:ctx.session});
    for (const item of [...items].sort((a,b) => a.snapshot.question_version_id.localeCompare(b.snapshot.question_version_id))) await this.sources.reference(ctx, item.snapshot, 'paper_item', item._id);
    await this.database.db.collection<QuizAudience>('quiz_audiences').deleteMany({org_id:ctx.orgId, quiz_id:quiz._id}, {session:ctx.session});
    await this.database.db.collection<QuizAudience>('quiz_audiences').insertMany(audience.map(member_id => ({_id:newId(), org_id:ctx.orgId, quiz_id:quiz._id, member_id, created_at:now, updated_at:now})), {session:ctx.session});
    await recordLearningFeedback(this.database.db,ctx,items.map(item=>item.snapshot.question_id));
  }
  async createQuiz(req:ApiRequest, raw:unknown) {
    const input = quizInput(raw, false);
    return this.access.run(req, true, async ctx => {
      this.access.require(ctx, 'assessment:manage');
      return this.access.idempotent(ctx, req, 'quiz.create', 'new', raw, async () => {
        const now = await this.access.now(ctx);
        const audience = await this.resolveAudience(ctx, input);
        const quiz:Quiz = {_id:newId(), org_id:ctx.orgId, ...input.fields, status:'draft', revision:1, created_by:ctx.userId, contributors:[ctx.userId], published_by:null, published_at:null, published_paper_id:null, visibility_revision:0, created_at:now, updated_at:now, ...(input.source_class_ids ? {source_class_ids:input.source_class_ids} : {})};
        await this.database.db.collection<Quiz>('quizzes').insertOne(quiz, {session:ctx.session});
        await this.replace(ctx, quiz, input, audience, now);
        await this.access.audit(ctx, 'quiz', quiz._id, 'assessment.quiz.create', '创建考试', {revision_after:1, source_class_ids:input.source_class_ids});
        return quizDto(quiz);
      }, 200);
    });
  }
  async patchQuiz(req:ApiRequest, key:string, raw:unknown) {
    const input = quizInput(raw, true);
    return this.access.run(req, true, async ctx => {
      this.access.require(ctx, 'assessment:manage');
      const before = await this.quiz(ctx, key);
      if (before.created_by !== ctx.userId) fail(404, 'NOT_FOUND', '考试不存在');
      return this.access.idempotent(ctx, req, 'quiz.patch', before._id, raw, async () => {
        if (before.status !== 'draft' || before.revision !== input.expected) fail(409, 'REVISION_CONFLICT', '仅可编辑当前修订的本人草稿');
        const now = await this.access.now(ctx);
        const audience = await this.resolveAudience(ctx, input);
        const $set: Record<string, unknown> = {...input.fields, updated_at:now};
        const update: Document = {$set, $inc:{revision:1}, $addToSet:{contributors:ctx.userId}};
        if (input.source_class_ids) $set.source_class_ids = input.source_class_ids;
        else update.$unset = {source_class_ids:''};
        const updated = await this.database.db.collection<Quiz>('quizzes').findOneAndUpdate({_id:before._id, org_id:ctx.orgId, status:'draft', revision:input.expected!, created_by:ctx.userId}, update, {session:ctx.session, returnDocument:'after'});
        if (!updated) fail(409, 'REVISION_CONFLICT', '考试已变化');
        await this.replace(ctx, updated, input, audience, now);
        await this.access.audit(ctx, 'quiz', key, 'assessment.quiz.edit', '编辑考试', {revision_before:before.revision, revision_after:updated.revision, source_class_ids:input.source_class_ids});
        return quizDto(updated);
      });
    });
  }
  async publishQuiz(req:ApiRequest, key:string, raw:unknown) {
    const body = object(raw, ['expected_revision', 'reason']);
    const expected = integer(body.expected_revision, 'expected_revision'), reason = text(body.reason, 'reason', 1000).trim();
    return this.access.run(req, true, async ctx => {
      this.access.require(ctx, 'assessment:review');
      const quiz = await this.quiz(ctx, key);
      if (quiz.created_by === ctx.userId || quiz.contributors.includes(ctx.userId)) fail(403, 'SELF_REVIEW_FORBIDDEN', '不得发布自己创建或编辑的考试');
      return this.access.idempotent(ctx, req, 'quiz.publish', quiz._id, raw, async () => {
        if (quiz.status !== 'draft' || quiz.revision !== expected) fail(409, 'REVISION_CONFLICT', '考试修订已变化');
        const now = await this.access.now(ctx);
        if (!(quiz.opens_at < quiz.closes_at && quiz.closes_at <= quiz.release_at) || quiz.closes_at <= now) fail(422, 'QUIZ_WINDOW_INVALID', '考试窗口无效或已关场');
        const {paper, items} = await this.paper(ctx, quiz);
        boundedSnapshots(items);
        if (new Set(items.map(item => item.snapshot.question_id)).size !== items.length) fail(422, 'QUESTION_SCOPE_INVALID', '试卷不能包含重复题目身份');
        for (const item of [...items].sort((a,b) => a.snapshot.question_version_id.localeCompare(b.snapshot.question_version_id))) {
          const source = await this.sources.question(ctx, item.snapshot.question_version_id, true);
          if (source.subject_id !== quiz.subject_id || canonical(source) !== canonical(item.snapshot)) fail(409, 'SOURCE_CHANGED', '题目依据已变化，请重新保存草稿');
          maxScore(scoreText(scoreCents(item.max_score)));
          await this.sources.reference(ctx, item.snapshot, 'paper_item', item._id);
        }
        const audience = await this.database.db.collection<QuizAudience>('quiz_audiences').find({org_id:ctx.orgId, quiz_id:quiz._id}, {session:ctx.session}).sort({member_id:1}).limit(201).toArray();
        if (!audience.length || audience.length > 200) fail(422, 'PARTICIPANT_INVALID', '受众数量无效');
        await this.validateParticipants(ctx, audience.map(row => row.member_id), {...quiz, published_by:ctx.userId}, items.map(item => item.snapshot));
        await this.sources.guard(ctx, items.map(item => item.snapshot.question_version_id).sort(), 'publish', quiz._id);
        const frozen = await this.database.db.collection<Paper>('papers').updateOne({_id:paper._id, org_id:ctx.orgId, status:'draft', revision:expected}, {$set:{status:'frozen', updated_at:now}}, {session:ctx.session});
        if (frozen.modifiedCount !== 1) fail(409, 'REVISION_CONFLICT', '试卷已变化');
        const published = await this.database.db.collection<Quiz>('quizzes').findOneAndUpdate({_id:quiz._id, org_id:ctx.orgId, status:'draft', revision:expected, $expr:{$gt:['$closes_at', '$$NOW']}}, {$set:{status:'published', published_by:ctx.userId, published_at:now, published_paper_id:paper._id, updated_at:now}, $inc:{revision:1}}, {session:ctx.session, returnDocument:'after'});
        if (!published) fail(409, 'REVISION_CONFLICT', '考试已变化或已关场');
        await recordLearningFeedback(this.database.db,ctx,items.map(item=>item.snapshot.question_id));
        await this.access.audit(ctx, 'quiz', key, 'assessment.quiz.publish', reason, {revision_before:expected, revision_after:published.revision});
        return quizDto(published);
      });
    });
  }
  async adminQuizzes(req:ApiRequest, query:unknown) {
    return this.access.run(req, false, async ctx => {
      this.requireReader(ctx);
      const page = pageInput(query, ctx, 'admin.quizzes', ['status', 'subject_id']);
      const filter:Filter<Quiz> = {org_id:ctx.orgId};
      if (!ctx.capabilities.includes('assessment:review')) filter.created_by = ctx.userId;
      if (page.q.status !== undefined) {
        if (!['draft', 'published', 'closed', 'archived'].includes(page.q.status as string)) fail(422, 'VALIDATION_ERROR', '考试状态无效');
        filter.status = page.q.status as Quiz['status'];
      }
      if (page.q.subject_id !== undefined) filter.subject_id = id(page.q.subject_id);
      if (page.after) filter._id = {$gt:page.after};
      const rows = await this.database.db.collection<Quiz>('quizzes').find(filter, {session:ctx.session}).sort({_id:1}).limit(page.limit + 1).toArray();
      return {items:rows.slice(0, page.limit).map(quizDto), next_cursor:rows.length > page.limit ? page.next(rows[page.limit - 1]._id) : null};
    });
  }
  async adminQuiz(req:ApiRequest, key:string) {
    return this.access.run(req, false, async ctx => {
      const quiz = await this.quiz(ctx, key), {items} = await this.paper(ctx, quiz);
      for (const item of [...items].sort((a,b) => a.snapshot.question_version_id.localeCompare(b.snapshot.question_version_id))) await this.sources.question(ctx, item.snapshot.question_version_id, false);
      const audience = await this.database.db.collection<QuizAudience>('quiz_audiences').find({org_id:ctx.orgId, quiz_id:quiz._id}, {session:ctx.session}).sort({member_id:1}).limit(201).toArray();
      if (audience.length > 200) fail(409, 'PARTICIPANT_INVALID', '受众数量超限');
      await recordLearningFeedback(this.database.db,ctx,items.map(item=>item.snapshot.question_id));
      if (ctx.platform) await this.access.audit(ctx, 'quiz', quiz._id, 'assessment.quiz.read', '平台业务读取题目答案');
      return {...quizDto(quiz), created_by:quiz.created_by, contributors:quiz.contributors, published_by:quiz.published_by, published_at:quiz.published_at, items:items.map(item => ({id:item._id, position:item.position, question_version_id:item.snapshot.question_version_id, max_score:scoreText(scoreCents(item.max_score)), question:questionDto(item.snapshot)})), audience_member_ids:audience.map(row => row.member_id)};
    });
  }
  async assessmentMembers(req:ApiRequest, query:unknown) {
    return this.access.run(req, false, async ctx => {
      this.access.require(ctx, 'assessment:manage');
      const page = pageInput(query, ctx, 'assessment.members');
      const candidates = await collections(this.database.db).members.find({org_id:ctx.orgId, status:'active', ...(page.after ? {_id:{$gt:page.after}} : {})}, {session:ctx.session}).sort({_id:1}).limit(201).toArray();
      const records = await this.participantRecords(ctx, candidates.slice(0, 200).map(row => row._id));
      records.sort((a,b) => a.member._id.localeCompare(b.member._id));
      const selected = records.slice(0, page.limit);
      for (const {member, user} of selected) await this.fenceParticipant(ctx, member, user);
      const after = records.length > page.limit ? selected[selected.length - 1].member._id : candidates.length > 200 ? candidates[199]._id : null;
      return {items:selected.map(({member, user}) => ({id:member._id, display_name:user.display_name})), next_cursor:after ? page.next(after) : null};
    });
  }
  async assessmentQuestions(req:ApiRequest, query:unknown) {
    return this.access.run(req, false, async ctx => {
      this.requireReader(ctx);
      const page = pageInput(query, ctx, 'assessment.questions', ['subject_id', 'question_id', 'difficulty']);
      const filter:Filter<QuestionVersion> = {org_id:ctx.orgId, status:'published', access_revoked_at:null, 'license.granted':true};
      if (page.q.subject_id !== undefined) filter.subject_id = id(page.q.subject_id);
      if (page.q.question_id !== undefined) filter.question_id = id(page.q.question_id);
      const level = difficulty(page.q.difficulty); if (level) filter.difficulty = level;
      if (page.after) filter._id = {$gt:page.after};
      const candidates = await this.database.db.collection<QuestionVersion>('question_versions').find(filter, {session:ctx.session}).sort({_id:1}).limit(201).toArray();
      const items:{id:string;question_id:string;subject_id:string;title:string;question_type:string;difficulty:string;max_score:string}[] = [];
      let after:string|null = null;
      for (const candidate of candidates.slice(0, 200)) {
        after = candidate._id;
        try {
          const q = await this.sources.question(ctx, candidate._id, true);
          items.push({id:q.question_version_id, question_id:q.question_id, subject_id:q.subject_id, title:q.title, question_type:q.question_type, difficulty:q.difficulty, max_score:scoreText(scoreCents(q.scoring_rule.max_score))});
        } catch (error) {
          if (!(error instanceof HttpException)) throw error;
          const response = error.getResponse();
          const code = typeof response === 'object' && response !== null && 'code' in response ? response.code : null;
          if (![404, 422].includes(error.getStatus()) && code !== 'CONTENT_UNAVAILABLE' && code !== 'FILE_NOT_READY' && code !== 'SNAPSHOT_TOO_LARGE') throw error;
        }
        if (items.length === page.limit) break;
      }
      const more = after !== null && candidates.some(candidate => candidate._id > after!);
      return {items, next_cursor:more ? page.next(after!) : null};
    });
  }
  async assessmentQuestion(req:ApiRequest, key:string) {
    return this.access.run(req, false, async ctx => {
      this.requireReader(ctx);
      const question = await this.sources.question(ctx,id(key),false);
      await recordLearningFeedback(this.database.db,ctx,[question.question_id]);
      if (ctx.platform) await this.access.audit(ctx, 'question', question.question_version_id, 'assessment.question.read', '平台业务读取题目答案');
      return questionDto(question);
    });
  }
  async audits(req:ApiRequest, query:unknown) {
    return this.access.run(req, false, async ctx => {
      this.requireReader(ctx);
      const page = pageInput(query, ctx, 'assessment.audits', ['resource_type', 'resource_id']);
      const kind = text(page.q.resource_type, 'resource_type', 30), key = id(page.q.resource_id);
      const collection = ({quiz:'quizzes', session:'sessions', submission:'submissions', grading_run:'grading_runs'} as Record<string,string>)[kind];
      if (!collection) fail(422, 'VALIDATION_ERROR', '评估审计资源类型无效');
      if (kind === 'quiz') await this.quiz(ctx, key);
      else {
        this.access.require(ctx, 'assessment:review');
        if (!await this.database.db.collection<Document & {_id:string}>(collection).findOne({_id:key, org_id:ctx.orgId}, {session:ctx.session, projection:{_id:1}})) fail(404, 'NOT_FOUND', '评估资源不存在');
      }
      const rows = await this.database.db.collection<Document & {_id:string}>('audit_events').find({org_id:ctx.orgId, resource_type:kind, resource_id:key, ...(page.after ? {_id:{$gt:page.after}} : {})}, {session:ctx.session}).sort({_id:1}).limit(page.limit + 1).toArray();
      return {items:rows.slice(0, page.limit).map(row => ({id:row._id, resource_type:row.resource_type, resource_id:row.resource_id, action:row.action, actor_id:row.actor_id, reason:row.reason, request_id:row.request_id, created_at:row.created_at, revision_before:row.revision_before ?? null, revision_after:row.revision_after ?? null})), next_cursor:rows.length > page.limit ? page.next(rows[page.limit - 1]._id) : null};
    });
  }
}
