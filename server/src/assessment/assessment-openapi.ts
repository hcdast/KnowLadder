const traceUuid = { type: "string" as const, format: "uuid" };
import type { OpenAPIObject, ParameterObject, ReferenceObject, SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

type Schema = SchemaObject | ReferenceObject;
const text: SchemaObject = { type: 'string' };
const resourceId: SchemaObject = { type: 'string', pattern: "^[0-9a-f]{24}$" };
const date: SchemaObject = { type: 'string', format: 'date-time' };
const revision: SchemaObject = { type: 'integer', minimum: 1 };
const score: SchemaObject = { type: 'string', pattern: '^[0-9]+\\.[0-9]{2}$', description: '精确分数，固定两位小数' };
const nullable = (s: SchemaObject): SchemaObject => ({ ...s, nullable: true });
const choices = (...values: string[]): SchemaObject => ({ type: 'string', enum: values });
const ref = (name: string): ReferenceObject => ({ $ref: `#/components/schemas/Assessment${name}` });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): SchemaObject => ({ type: 'object', additionalProperties: false, properties, required });
const array = (items: Schema, maxItems?: number): SchemaObject => ({ type: 'array', items, ...(maxItems === undefined ? {} : { maxItems }) });
const page = (items: Schema, extra: Record<string, Schema> = {}): SchemaObject => object({ items: array(items, 50), next_cursor: nullable(text), ...extra });
const query = (name: string, schema: SchemaObject = text, required = false): ParameterObject => ({ in: 'query', name, required, schema });
const pagination = [query('cursor'), query('limit', { type: 'integer', minimum: 1, maximum: 50, default: 20 })];
const mode = choices('practice', 'quiz');
const status = choices('in_progress', 'submitted', 'expired', 'cancelled');
const grading = choices('pending', 'running', 'needs_review', 'completed', 'failed');
const difficulty = choices('基础', '提升', '挑战');
const reason: SchemaObject = { type: 'string', minLength: 1, maxLength: 1000 };
const ids = (maxItems: number): SchemaObject => ({ ...array(resourceId, maxItems), uniqueItems: true });

export function assessmentOpenApi(document: OpenAPIObject) {
  document.components ??= {};
  document.components.schemas ??= {};
  const schemas = document.components.schemas;
  const add = (name: string, schema: SchemaObject) => { schemas[`Assessment${name}`] = schema; };
  add('Answer', { oneOf: [object({ selected_option_ids: { ...array({ type: 'string', maxLength: 32 }, 12), uniqueItems: true } }), object({ value: { type: 'string', maxLength: 100, description: '精确十进制，指数绝对值不超过100；空白视为未答' } }), { type: 'object', nullable: true, enum: [null] }], description: 'null清空答案；选项须属于冻结题项；非法结构422，不按答错处理' });
  add('PracticeCreate', object({ textbook_edition_id: resourceId, chapter_id: resourceId, knowledge_point_ids: { ...ids(100), minItems: 1 }, difficulty, count: { type: 'integer', minimum: 1, maximum: 20, default: 5 } }, ['textbook_edition_id', 'knowledge_point_ids']));
  add('PracticeOptions', object({ subject_id: resourceId, knowledge_points: array(object({ id: resourceId, name: text, code: text })), chapters: array(object({ id: resourceId, knowledge_point_ids: ids(100) })), difficulties: array(difficulty, 3), default_count: { type: 'integer', enum: [5] }, max_count: { type: 'integer', enum: [20] } }));
  add('Session', object({ id: resourceId, mode, status, revision, server_time: date, started_at: date, deadline_at: nullable(date), submission_id: nullable(resourceId), item_count: { type: 'integer', minimum: 1, maximum: 50 }, quiz_id: nullable(resourceId), textbook_edition_id: nullable(resourceId) }));
  const visible = { id: resourceId, position: { type: 'integer', minimum: 0 } as SchemaObject, question_type: choices('single', 'multiple', 'numeric'), title: text, prompt: text, options: array(object({ id: text, text }), 12), resource_ids: ids(20), max_score: score, answer: ref('Answer') };
  add('SessionItem', object(visible));
  add('SaveAnswer', object({ expected_revision: revision, answer: ref('Answer') }));
  add('SavedAnswer', object({ session_id: resourceId, session_item_id: resourceId, revision, saved_at: date }));
  add('Submit', object({ expected_revision: revision, answers: array(object({ session_item_id: resourceId, answer: ref('Answer') }), 50) }));
  add('SubmissionReceipt', object({ submission_id: resourceId, session_id: resourceId, session_status: choices('submitted', 'expired'), revision, submitted_at: date, grading_status: grading, report_status: choices('not_available') }));
  const result = { id: resourceId, session_id: resourceId, revision, grading_status: grading, release_status: choices('pending', 'released', 'withheld_access', 'withheld_embargo', 'regrading'), report_status: choices('not_available'), effective_grading_revision: nullable(revision), requested_grading_revision: revision, error_code: nullable(text), submitted_at: date };
  const scores = { total_score: nullable(score), max_score: score };
  add('Submission', object({ ...result, ...scores }, Object.keys(result)));
  add('ResultItem', object({ ...visible, student_answer: ref('Answer'), score, verdict: choices('correct', 'incorrect', 'unanswered'), standard_answer: text, explanation: text }));
  const quiz = { id: resourceId, title: text, subject_id: resourceId, status: choices('draft', 'published', 'closed', 'archived'), revision, opens_at: date, closes_at: date, release_at: date, duration_seconds: { type: 'integer', minimum: 60, maximum: 7200 } as SchemaObject, max_attempts: { type: 'integer', minimum: 1, maximum: 3 } as SchemaObject };
  add('QuizSummary', object(quiz));
  add('StudentQuiz', object({ ...quiz, remaining_attempts: { type: 'integer', minimum: 0, maximum: 3 }, active_session_id: nullable(resourceId), server_time: date, can_start: { type: 'boolean' } }));
  const maxScore: SchemaObject = { type: 'string', maxLength: 6, pattern: '^(?:(?:[1-9][0-9]?)(?:\\.[0-9]{1,2})?|0\\.(?:0[1-9]|[1-9][0-9]?)|100(?:\\.0{1,2})?)$' };
  const quizInput = { title: { type: 'string', minLength: 1, maxLength: 200 } as SchemaObject, subject_id: resourceId, opens_at: date, closes_at: date, release_at: date, duration_seconds: quiz.duration_seconds, max_attempts: { ...quiz.max_attempts, default: 1 }, items: { ...array(object({ question_version_id: resourceId, max_score: maxScore }, ['question_version_id']), 50), minItems: 1 }, audience_member_ids: { ...ids(200), minItems: 1 }, source_class_ids: { ...ids(5), minItems: 1 } };
  const quizRequired = Object.keys(quizInput).filter(key => key !== 'max_attempts' && key !== 'audience_member_ids' && key !== 'source_class_ids');
  add('QuizCreate', object(quizInput, quizRequired));
  add('QuizPatch', object({ ...quizInput, expected_revision: revision }, [...quizRequired, 'expected_revision']));
  add('Publish', object({ expected_revision: revision, reason }));
  add('AdminQuiz', object({ ...quiz, items: array(object({ id: resourceId, position: { type: 'integer', minimum: 0 }, question_version_id: resourceId, max_score: score, question: ref('Question') }), 50), audience_member_ids: ids(200), source_class_ids: ids(5), created_by: resourceId, contributors: ids(200), published_by: nullable(resourceId), published_at: nullable(date) }));
  add('Member', object({ id: resourceId, display_name: text }));
  const candidate = { id: resourceId, question_id: resourceId, subject_id: resourceId, title: text, question_type: choices('single', 'multiple', 'numeric'), difficulty };
  add('QuestionSummary', object({ ...candidate, max_score: score }));
  add('Question', object({ ...candidate, prompt: text, options: visible.options, answer: text, explanation: text, resource_ids: ids(20), scoring_rule: object({ version: { type: 'integer', enum: [1] }, strategy: choices('single_exact', 'multiple_exact_set', 'numeric_exact_decimal'), max_score: maxScore }), knowledge_point_ids: ids(100), knowledge_weights: array(object({ knowledge_point_id: resourceId, weight_bps: { type: 'integer', minimum: 1, maximum: 10000 } }), 100), difficulty_basis: text, created_by: resourceId, contributors: ids(200), published_by: nullable(resourceId) }));
  add('Regrade', object({ expected_revision: revision, reason, correction_source_version_id: resourceId }, ['expected_revision', 'reason']));
  add('RegradeReceipt', object({ grading_run_id: resourceId, submission_id: resourceId, revision, grading_status: grading }));
  const admin = { ...result, quiz_id: nullable(resourceId), member_id: resourceId, user_id: resourceId };
  add('AdminSubmissionSummary', object({ ...admin, ...scores }, Object.keys(admin)));
  add('AdminSubmission', object({ ...admin, ...scores, grading_runs: array(object({ id: resourceId, revision, status: grading, reason: text, requested_by: text, scoring_code_version: text, completed_at: nullable(date), error_code: nullable(text) }), 50), items: array(object({ id: resourceId, question_id: resourceId, question_version_id: resourceId, title: text, student_answer: ref('Answer'), standard_answer: text, explanation: text, score, max_score: score, verdict: choices('correct', 'incorrect', 'unanswered'), correction_source_version_id: nullable(resourceId) }), 50) }, [...Object.keys(admin), 'grading_runs']));
  add('Idempotency', { oneOf: [object({ status: choices('unknown') }), object({ status: choices('resolved'), response_status: { type: 'integer', enum: [200, 202] }, result: { oneOf: [ref('Session'), ref('SavedAnswer'), ref('SubmissionReceipt')] } })], description: '只查询本人安全引用；unknown不表示原请求已失败，不得据此换key重新创建' });
  add('Audit', object({ id: resourceId, resource_type: choices('quiz', 'session', 'submission', 'grading_run'), resource_id: resourceId, action: text, actor_id: text, reason: text, request_id: text, created_at: date, revision_before: nullable(revision), revision_after: nullable(revision) }));

  type Route = { path: string; method: 'get' | 'post' | 'put' | 'patch'; summary: string; data: Schema; body?: Schema; queries?: ParameterObject[]; accepted?: boolean };
  const routes: Route[] = [
    { path: 'practice-options', method: 'get', summary: '本人合法练习范围选项，不返回保密题单', data: ref('PracticeOptions'), queries: [query('textbook_edition_id', resourceId, true), query('chapter_id', resourceId)] },
    { path: 'practice-sessions', method: 'post', summary: '创建冻结练习会话；题量不足整体拒绝', body: ref('PracticeCreate'), data: ref('Session') },
    { path: 'quizzes', method: 'get', summary: '本人冻结受众内可见考试', data: page(ref('StudentQuiz')), queries: pagination },
    { path: 'quizzes/{id}', method: 'get', summary: '本人考试规则和窗口，无试卷题面', data: ref('StudentQuiz') },
    { path: 'quizzes/{id}/sessions', method: 'post', summary: '合法窗口内分配考试次数并创建会话', body: object({}), data: ref('Session') },
    { path: 'me/sessions', method: 'get', summary: '本人可恢复会话分页', data: page(ref('Session')), queries: [...pagination, query('mode', mode), query('status', status)] },
    { path: 'sessions/{id}', method: 'get', summary: '本人会话安全元数据和数据库时间', data: ref('Session') },
    { path: 'sessions/{id}/items', method: 'get', summary: '冻结修订题项与本人已保存答案；无评分依据', data: page(ref('SessionItem'), { session_revision: revision }), queries: [...pagination, query('session_revision', revision)] },
    { path: 'sessions/{id}/answers/{session_item_id}', method: 'put', summary: '按会话修订保存单题答案', body: ref('SaveAnswer'), data: ref('SavedAnswer') },
    { path: 'sessions/{id}/submissions', method: 'post', summary: '原子接受最终答案补丁与交卷，不等待评分', body: ref('Submit'), data: ref('SubmissionReceipt'), accepted: true },
    { path: 'submissions/{id}', method: 'get', summary: '本人批改及发布状态，仅released包含分数', data: ref('Submission') },
    { path: 'submissions/{id}/items', method: 'get', summary: '整份提交通过当前许可及保密检查后返回结果', data: page(ref('ResultItem'), { grading_revision: revision }), queries: [...pagination, query('grading_revision', revision)] },
    { path: 'me/idempotency-requests', method: 'get', summary: '恢复本人原幂等键安全受理结果', data: ref('Idempotency'), queries: [query('operation', choices('practice.create', 'quiz.start', 'answer.save', 'session.submit'), true), query('resource_id', { type: 'string', description: 'practice.create为new；其余为考试、题项、会话UUID' }, true), query('key', { type: 'string', minLength: 8, maxLength: 128 }, true)] },
    { path: 'admin/quizzes', method: 'get', summary: '评估管理或审核职责内考试分页', data: page(ref('QuizSummary')), queries: [...pagination, query('status', quiz.status), query('subject_id', resourceId)] },
    { path: 'admin/quizzes/{id}', method: 'get', summary: '评估管理或审核职责内编排详情', data: ref('AdminQuiz') },
    { path: 'quizzes', method: 'post', summary: 'assessment:manage创建本人考试草稿', data: ref('QuizSummary'), body: ref('QuizCreate') },
    { path: 'quizzes/{id}', method: 'patch', summary: 'assessment:manage完整替换本人草稿题单与受众', data: ref('QuizSummary'), body: ref('QuizPatch') },
    { path: 'quizzes/{id}/publish', method: 'post', summary: '独立assessment:review原子冻结试卷与受众', data: ref('QuizSummary'), body: ref('Publish') },
    { path: 'admin/assessment-members', method: 'get', summary: 'assessment:manage选择组织内可参试成员', data: page(ref('Member')), queries: pagination },
    { path: 'admin/assessment-questions', method: 'get', summary: '独立评估能力选题，无需content能力', data: page(ref('QuestionSummary')), queries: [...pagination, query('subject_id', resourceId), query('question_id', resourceId), query('difficulty', difficulty)] },
    { path: 'admin/assessment-questions/{version_id}', method: 'get', summary: '合法候选题或历史版本评估职责预览', data: ref('Question') },
    { path: 'admin/submissions', method: 'get', summary: 'assessment:review指定quiz_id或submission_id范围查询', data: page(ref('AdminSubmissionSummary')), queries: [...pagination, query('quiz_id', resourceId), query('submission_id', resourceId)] },
    { path: 'admin/submissions/{id}', method: 'get', summary: 'assessment:review评分证据，撤销时安全降级', data: ref('AdminSubmission') },
    { path: 'submissions/{id}/regrades', method: 'post', summary: 'assessment:review有原因重批，不接受客户端分数', data: ref('RegradeReceipt'), body: ref('Regrade'), accepted: true },
  ];
  const errors: Record<string, string[]> = {
    '401': ['SESSION_EXPIRED'], '403': ['FORBIDDEN', 'ORIGIN_REJECTED', 'CSRF_REJECTED', 'PASSWORD_CHANGE_REQUIRED', 'SEPARATION_OF_DUTIES'], '404': ['NOT_FOUND'],
    '409': ['REVISION_CONFLICT', 'IDENTITY_CHANGED', 'ASSESSMENT_CONFLICT', 'SESSION_DEADLINE_PASSED', 'ATTEMPT_LIMIT_REACHED', 'CONTENT_UNAVAILABLE', 'FILE_NOT_READY', 'QUESTION_EMBARGOED', 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_RESULT_INVALID', 'ACTIVE_SESSION_EXISTS', 'QUIZ_WINDOW_CLOSED', 'RESULT_NOT_RELEASED', 'INSUFFICIENT_QUESTIONS', 'SESSION_INCOMPLETE', 'PAPER_INCOMPLETE', 'PAPER_INVALID', 'PARTICIPANT_INVALID', 'GRADING_INCOMPLETE', 'GRADING_IN_PROGRESS', 'SESSION_NOT_SUBMITTED'],
    '413': ['PAYLOAD_TOO_LARGE', 'SNAPSHOT_TOO_LARGE'], '422': ['VALIDATION_ERROR', 'INVALID_ANSWER', 'INVALID_SCORE', 'UNSUPPORTED_SCORING_RULE', 'ORG_REQUIRED', 'IDEMPOTENCY_KEY_REQUIRED', 'CURSOR_INVALID', 'REVISION_REQUIRED', 'PRACTICE_SCOPE_INVALID', 'CORRECTION_MISMATCH', 'SNAPSHOT_LIMIT'], '429': ['RATE_LIMITED'], '503': ['DEPENDENCY_UNAVAILABLE', 'COMMIT_OUTCOME_UNKNOWN', 'CANDIDATE_CAPACITY_EXCEEDED', 'DATABASE_TIME_UNAVAILABLE', 'ASSESSMENT_TRANSACTION_REQUIRED'],
  };
  errors['403']!.push('SELF_REVIEW_FORBIDDEN');
  errors['409']!.push('AUTHORIZATION_CHANGED');
  errors['422']!.push('SCORING_RULE_INVALID', 'PARTICIPANT_INVALID', 'PARTICIPANT_CONFLICT', 'QUESTION_SCOPE_INVALID', 'KNOWLEDGE_WEIGHTS_INVALID', 'QUESTION_INCOMPLETE', 'ANSWER_INVALID');
  for (const route of routes) {
    const operation = document.paths[`/api/v1/${route.path}`]?.[route.method];
    if (!operation) continue;
    operation.summary = route.summary;
    operation.description = '请求体最大64KiB，未知字段422。当前认证、组织、能力及源许可优先于幂等回放；游标绑定调用者、组织、资源与全部筛选；题项与结果续页必须带首响应修订，变化409。学生未发布或受限成绩不返回分数、标准答案或解析；独立评估审核可在学生release前查看当前许可有效的完整评分证据，不标记学生答案披露。';
    operation.security = [{ session: [] }];
    operation.parameters = [{ in: 'header', name: 'X-Org-Id', required: true, schema: resourceId }, ...Array.from(route.path.matchAll(/\{([^}]+)\}/g), match => ({ in: 'path' as const, name: match[1]!, required: true, schema: resourceId })), ...(route.queries ?? []), ...(route.method === 'get' ? [] : ['Origin', 'X-CSRF-Token', 'Idempotency-Key'].map(name => ({ in: 'header' as const, name, required: true, schema: name === 'Idempotency-Key' ? { type: 'string' as const, minLength: 8, maxLength: 128 } : text })))];
    if (route.body) operation.requestBody = { required: true, content: { 'application/json': { schema: route.body } } };
    operation.responses = { [route.accepted ? '202' : '200']: { description: route.accepted ? '已受理，不表示评分已完成' : '成功', headers: { 'Cache-Control': { schema: choices('private, no-store') }, 'X-Request-Id': { schema: traceUuid } }, content: { 'application/json': { schema: object({ data: route.data, request_id: traceUuid }) } } } };
    for (const [code, codes] of Object.entries(errors)) operation.responses[code] = { description: codes.join(' / '), content: { 'application/json': { schema: object({ error: object({ code: choices(...codes), message: text, session_id: resourceId }, ['code', 'message']), request_id: traceUuid }) } }, ...(code === '429' ? { headers: { 'Retry-After': { schema: text } } } : {}) };
  }
  const audit = document.paths['/api/v1/admin/audit-events']?.get;
  if (audit) {
    audit.description = '统一审计入口：assessment:manage仅本人考试编排记录，assessment:review读取授权评估记录；内容资源沿用原权限，不记录答案正文。';
    const type = audit.parameters?.find(p => 'name' in p && p.name === 'resource_type') as ParameterObject | undefined;
    if (type) type.schema = choices('textbook', 'question', 'quiz', 'session', 'submission', 'grading_run');
    audit.responses['200'] = { description: '对应资源类型的安全审计分页', content: { 'application/json': { schema: object({ data: page({ oneOf: [{ $ref: '#/components/schemas/ContentAudit' }, ref('Audit')] }), request_id: traceUuid }) } } };
  }
  for (const path of ['/api/v1/sessions/{id}/items/{item_id}/files/{file_id}/content', '/api/v1/admin/assessment-questions/{version_id}/files/{file_id}/content']) {
    const operation = document.paths[path]?.get;
    if (!operation) continue;
    operation.summary = '精确资源关联、当前许可、保密及ready+clean检查后下载私有附件';
    operation.parameters ??= [];
    operation.parameters.push({ in: 'header', name: 'Range', required: false, schema: text, description: '单一bytes范围；每次请求重新授权' });
    operation.security = [{ session: [] }];
    for (const parameter of operation.parameters) if ('in' in parameter && parameter.in === 'path') parameter.schema = resourceId;
    operation.responses['416'] = { description: 'Range格式无效、多个范围或超出文件长度', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } };
    for (const code of ['200', '206']) operation.responses[code] = { description: code === '206' ? '合法单段范围' : '完整文件', headers: { 'Content-Disposition': { schema: text }, 'Cache-Control': { schema: choices('private, no-store') }, 'Content-Range': { schema: text }, 'Accept-Ranges': { schema: choices('bytes') } }, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } };
  }
}
