import type { OpenAPIObject, ParameterObject, ReferenceObject, SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

type Schema = SchemaObject | ReferenceObject;
const text: SchemaObject = { type: 'string' };
const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const date: SchemaObject = { type: 'string', format: 'date-time' };
const natural: SchemaObject = { type: 'integer', minimum: 0 };
const revision: SchemaObject = { type: 'integer', minimum: 1 };
const integerText: SchemaObject = { type: 'string', pattern: '^(0|[1-9][0-9]*)$' };
const percentage: SchemaObject = { type: 'string', pattern: '^(100|[0-9]{1,2})\\.[0-9]{2}$' };
const nullable = (schema: SchemaObject): SchemaObject => ({ ...schema, nullable: true, ...(schema.enum ? { enum: [...schema.enum, null] } : {}) });
const choice = (...values: string[]): SchemaObject => ({ type: 'string', enum: values });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): SchemaObject => ({ type: 'object', additionalProperties: false, properties, required });
const array = (items: Schema, maxItems?: number): SchemaObject => ({ type: 'array', items, ...(maxItems === undefined ? {} : { maxItems }) });
const ref = (name: string): ReferenceObject => ({ $ref: `#/components/schemas/Learning${name}` });
const query = (name: string, schema: SchemaObject = text, required = false): ParameterObject => ({ in: 'query', name, schema, required });
const pagination = [query('cursor'), query('limit', { type: 'integer', minimum: 1, maximum: 50, default: 20 })];
const meta = { status: choice('ready', 'insufficient_evidence', 'updating', 'unavailable'), source_watermark: nullable(text), generated_at: nullable(date), rule_version: text };

export function learningOpenApi(document: OpenAPIObject): void {
  document.components ??= {};
  document.components.schemas ??= {};
  const add = (name: string, schema: SchemaObject) => { document.components!.schemas![`Learning${name}`] = schema; };
  add('MasteryItem', object({ knowledge_point_id: uuid, independent_question_count: natural, numerator: integerText, denominator: integerText, mastery: nullable(percentage), status: choice('insufficient_evidence', 'weak', 'developing', 'mastered'), last_evidence_at: date }));
  add('Mastery', object({ ...meta, evidence_window_days: { type: 'integer', enum: [90] }, items: array(ref('MasteryItem'), 50), next_cursor: nullable(text) }));
  const activity = object({ submission_count: natural, attempt_count: natural, correct_count: natural, incorrect_count: natural, unanswered_count: natural, independent_question_count: natural, numerator: integerText, denominator: integerText, correctness: nullable(percentage) });
  add('Reports', object({ ...meta, period: choice('7d', '30d'), activity: nullable(activity), mastery_window_days: { type: 'integer', enum: [90] }, mastery: array(ref('MasteryItem'), 500) }));
  add('MistakeItem', object({ id: uuid, question_id: uuid, status: choice('active', 'resolved'), title: text, question_type: choice('single', 'multiple', 'numeric'), session_item_id: uuid, submission_id: uuid, last_attempt_at: date }));
  add('Mistakes', object({ ...meta, items: array(ref('MistakeItem'), 50), total: natural, next_cursor: nullable(text) }));
  add('Mistake', object({ ...meta, id: uuid, question_id: uuid, mistake_status: choice('active', 'resolved'), submission_id: uuid, grading_revision: revision, question: { $ref: '#/components/schemas/AssessmentSessionItem' }, student_answer: { $ref: '#/components/schemas/AssessmentAnswer' }, standard_answer: text, explanation: text, score: { type: 'string', pattern: '^[0-9]+\\.[0-9]{2}$' }, verdict: choice('correct', 'incorrect', 'unanswered'), practice_version_policy: choice('current_published') }));
  add('RecommendationCard', object({ id: uuid, kind: choice('practice', 'reading'), textbook_edition_id: uuid, chapter_id: nullable(uuid), knowledge_point_ids: { ...array(uuid, 100), uniqueItems: true }, difficulty: nullable(choice('基础', '提升')), count: { type: 'integer', enum: [0, 5] }, expires_at: date, reason_code: choice('DIAGNOSTIC', 'WEAK_KNOWLEDGE', 'CONSOLIDATION', 'RELATED_READING'), reason: text, independent_question_count: natural, mastery: nullable(percentage) }));
  add('Recommendations', object({ status: meta.status, rule_version: text, source_watermark: nullable(text), catalog_revision: natural, edition_revision: revision, expires_at: date, prerequisite_policy: choice('not_used_v1'), graph_revision: { type: 'string', nullable: true, enum: [null] }, empty_reason: nullable(choice('NO_ELIGIBLE_CONTENT')), items: array(ref('RecommendationCard'), 3) }));
  const position = object({ kind: choice('text_offset'), offset_utf16: natural });
  add('ReadingPosition', position);
  add('ReadingEvent', object({ event_type: choice('reading_progress_set'), event_id: uuid, textbook_edition_id: uuid, chapter_id: uuid, edition_revision: revision, expected_revision: natural, position: ref('ReadingPosition'), completed: { type: 'boolean' } }));
  add('ReadingResult', object({ event_id: uuid, progress_revision: revision, server_received_at: date }));
  add('ReadingProgress', object({ chapter_id: uuid, edition_revision: revision, position: nullable(position), completed: { type: 'boolean', nullable: true }, progress_revision: natural, updated_at: nullable(date) }));
  add('ReadingPage', object({ textbook_edition_id: uuid, edition_revision: revision, items: array(ref('ReadingProgress'), 50), next_cursor: nullable(text) }));

  type Route = { path: string; method: 'get' | 'post'; summary: string; data: Schema; queries?: ParameterObject[]; body?: Schema; event?: boolean };
  const routes: Route[] = [
    { path: 'me/mastery', method: 'get', summary: '本人当前可见的90天独立作答掌握度；不足五题返回待诊断', data: ref('Mastery'), queries: [query('subject_id', uuid, true), query('textbook_edition_id', uuid), query('knowledge_point_id', uuid), ...pagination] },
    { path: 'me/reports', method: 'get', summary: '本人7天或30天真实活动报告及90天掌握度', data: ref('Reports'), queries: [query('subject_id', uuid, true), query('period', choice('7d', '30d'), true)] },
    { path: 'me/mistakes', method: 'get', summary: '本人当前可见错题分页，不返回隐藏考试或旧失权记录', data: ref('Mistakes'), queries: [query('subject_id', uuid, true), query('status', { ...choice('active', 'resolved', 'all'), default: 'active' }), ...pagination] },
    { path: 'me/mistakes/{id}', method: 'get', summary: '当前有效评分的原题面、作答与纠错后解析', data: ref('Mistake') },
    { path: 'me/mistakes/{id}/practice-sessions', method: 'post', summary: '从同题身份当前合法发布版本建立一题新练习，原key可恢复', data: { $ref: '#/components/schemas/AssessmentSession' }, body: object({}) },
    { path: 'me/recommendations', method: 'get', summary: '真实教材范围内最多三张规则推荐卡，无先修图依赖', data: ref('Recommendations'), queries: [query('textbook_edition_id', uuid, true)] },
    { path: 'me/recommendations/{id}/practice-sessions', method: 'post', summary: '重新核验当前候选并接受五题推荐；原key恢复，不重复创建', data: { $ref: '#/components/schemas/AssessmentSession' }, body: object({}) },
    { path: 'me/reading-progress', method: 'get', summary: '本人当前可读教材的章节字符位置，无记录为null/未开始', data: ref('ReadingPage'), queries: [query('textbook_edition_id', uuid, true), query('chapter_id', uuid), ...pagination] },
    { path: 'behavior-events', method: 'post', summary: '只接受本人阅读进度事件，以event_id去重和独立revision CAS提交', data: ref('ReadingResult'), body: ref('ReadingEvent'), event: true },
  ];
  for (const route of routes) {
    const operation = document.paths[`/api/v1/${route.path}`]?.[route.method];
    if (!operation) throw new Error(`Missing learning API route: ${route.path}`);
    operation.summary = route.summary;
    operation.description = route.event
      ? '实际JSON请求体最大2KiB；未知字段422。UTF-16 offset绑定原始章节正文与教材revision，不允许落在代理对中间。completed必须显式声明，不计入掌握度。event_id同正文恢复原结果、异正文409；原始事件清理不删除最小幂等回执。当前授权优先于重放，原结果revision不等于最新进度。'
      : '本人当前组织及学习权限；学情/错题/推荐排除四类内容和评估冲突能力。实时核验当前可见评分、来源许可和考试保密后交付，不暴露内部projection_revision或未发布输入。游标绑定身份、筛选与可见generation，变化409；旧结果不能绕过撤回。原key成功创建练习后，即使推荐过期或派生条目清理仍按当前会话权限恢复，不重复创建。';
    operation.security = [{ session: [] }];
    operation.parameters = [
      { in: 'header', name: 'X-Org-Id', required: true, schema: uuid },
      ...Array.from(route.path.matchAll(/\{([^}]+)\}/g), match => ({ in: 'path' as const, name: match[1]!, required: true, schema: uuid })),
      ...(route.queries ?? []),
      ...(route.method === 'post' ? ['Origin', 'X-CSRF-Token', ...(route.event ? [] : ['Idempotency-Key'])].map(name => ({ in: 'header' as const, name, required: true, schema: name === 'Idempotency-Key' ? { type: 'string' as const, minLength: 8, maxLength: 128 } : text })) : []),
    ];
    if (route.body) operation.requestBody = { required: true, content: { 'application/json': { schema: route.body } } };
    operation.responses = { '200': { description: '成功；updating/unavailable不包含旧敏感数值，insufficient_evidence不是零分', headers: { 'Cache-Control': { schema: choice('private, no-store') }, 'X-Request-Id': { schema: uuid } }, content: { 'application/json': { schema: object({ data: route.data, request_id: uuid }) } } } };
    const errors: Record<string, string> = {
      '401': '会话失效或未认证', '403': 'FORBIDDEN / ORIGIN_REJECTED / CSRF_REJECTED / PASSWORD_CHANGE_REQUIRED / SEPARATION_OF_DUTIES', '404': 'NOT_FOUND，跨组织或非本人对象不可枚举',
      '409': 'PROJECTION_CHANGED / READING_REVISION_CONFLICT / READING_CONTENT_CHANGED / RECOMMENDATION_EXPIRED / RECOMMENDATION_ALREADY_ACCEPTED / PRACTICE_SOURCE_UNAVAILABLE / IDEMPOTENCY_CONFLICT / CONTENT_UNAVAILABLE / QUESTION_EMBARGOED / AUTHORIZATION_CHANGED',
      '413': 'PAYLOAD_TOO_LARGE', '422': 'VALIDATION_ERROR / ORG_REQUIRED / CURSOR_INVALID / IDEMPOTENCY_KEY_REQUIRED', '429': 'RATE_LIMITED，按Retry-After重试',
      '503': 'DEPENDENCY_UNAVAILABLE / COMMIT_OUTCOME_UNKNOWN / INVALID_STUDENT_EVIDENCE / CANDIDATE_CAPACITY_EXCEEDED；未知受理必须保留原key/event_id',
    };
    for (const [status, description] of Object.entries(errors)) operation.responses[status] = { description, content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } }, ...(status === '429' ? { headers: { 'Retry-After': { schema: text } } } : {}) };
  }
}
