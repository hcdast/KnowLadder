const traceUuid = { type: "string" as const, format: "uuid" };
import type { OpenAPIObject, ParameterObject, ReferenceObject, SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

type Schema = SchemaObject | ReferenceObject;
const text: SchemaObject = { type: 'string' };
const resourceId: SchemaObject = { type: 'string', pattern: "^[0-9a-f]{24}$" };
const choice = (...values: string[]): SchemaObject => ({ type: 'string', enum: values });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): SchemaObject => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});
const ref = (name: string): ReferenceObject => ({ $ref: `#/components/schemas/${name}` });
const revision: SchemaObject = { type: 'integer', minimum: 1 };
const nullableDate: SchemaObject = { type: 'string', format: 'date-time', nullable: true };

export function teachingOpenApi(document: OpenAPIObject): void {
  document.components ??= {};
  document.components.schemas ??= {};
  Object.assign(document.components.schemas, {
    TeachingClassView: object({
      id: resourceId,
      name: { type: 'string', maxLength: 200 },
      year_label: { type: 'string', maxLength: 64 },
      status: choice('active', 'archived'),
      revision,
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    }),
    TeachingClassCreate: object({
      name: { type: 'string', minLength: 1, maxLength: 200 },
      year_label: { type: 'string', minLength: 1, maxLength: 64 },
    }),
    TeachingClassPatch: object(
      {
        expected_revision: revision,
        name: { type: 'string', minLength: 1, maxLength: 200 },
        year_label: { type: 'string', minLength: 1, maxLength: 64 },
        status: choice('active', 'archived'),
      },
      ['expected_revision'],
    ),
    TeachingRosterMutation: object({
      expected_revision: revision,
      member_ids: { type: 'array', minItems: 1, maxItems: 200, uniqueItems: true, items: resourceId },
    }),
    TeachingRosterMutationResult: object({
      class: ref('TeachingClassView'),
      added: { type: 'integer', minimum: 0 },
    }),
    TeachingRosterRemoveResult: object({
      class: ref('TeachingClassView'),
      removed: { type: 'integer', minimum: 0 },
    }),
    TeachingAssignmentCreate: object(
      {
        class_id: resourceId,
        member_id: resourceId,
        subject_id: resourceId,
        valid_from: nullableDate,
        valid_to: nullableDate,
      },
      ['class_id', 'member_id', 'subject_id'],
    ),
    TeachingAssignmentEnd: object({ expected_revision: revision }),
    TeachingAssignmentView: object({
      id: resourceId,
      class_id: resourceId,
      member_id: resourceId,
      subject_id: resourceId,
      status: choice('active', 'ended'),
      revision,
      valid_from: nullableDate,
      valid_to: nullableDate,
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    }),
    TeachingClassList: object({ items: { type: 'array', maxItems: 200, items: ref('TeachingClassView') } }),
    TeachingRosterView: object({
      class: ref('TeachingClassView'),
      items: {
        type: 'array',
        maxItems: 200,
        items: object({ member_id: resourceId, display_name: { type: 'string', maxLength: 100 } }),
      },
    }),
    TeachingMasteryBands: object({
      insufficient_evidence: { type: 'integer', minimum: 0 },
      weak: { type: 'integer', minimum: 0 },
      developing: { type: 'integer', minimum: 0 },
      mastered: { type: 'integer', minimum: 0 },
    }),
    TeachingClassSubjectReport: object({
      class_id: resourceId,
      subject_id: resourceId,
      status: choice('ready', 'insufficient'),
      roster_count: { type: 'integer', minimum: 0, maximum: 200 },
      projected_count: { type: 'integer', minimum: 0, maximum: 200 },
      mastery_bands: ref('TeachingMasteryBands'),
      submission_count_7d: { type: 'integer', minimum: 0 },
      submission_count_30d: { type: 'integer', minimum: 0 },
      weak_knowledge_points: {
        type: 'array',
        maxItems: 10,
        items: object({
          knowledge_point_id: resourceId,
          title: { type: 'string', maxLength: 200 },
          student_count: { type: 'integer', minimum: 1 },
        }),
      },
      rule_version: text,
    }),
    TeachingStudentSubjectReport: object({
      class_id: resourceId,
      subject_id: resourceId,
      member_id: resourceId,
      status: choice('ready', 'insufficient_evidence', 'updating', 'unavailable'),
      source_watermark: { type: 'string', nullable: true },
      generated_at: nullableDate,
      rule_version: text,
      period: choice('7d', '30d'),
      activity: {
        type: 'object',
        nullable: true,
        additionalProperties: false,
        properties: {
          submission_count: { type: 'integer', minimum: 0 },
          attempt_count: { type: 'integer', minimum: 0 },
          correct_count: { type: 'integer', minimum: 0 },
          incorrect_count: { type: 'integer', minimum: 0 },
          unanswered_count: { type: 'integer', minimum: 0 },
          independent_question_count: { type: 'integer', minimum: 0 },
          numerator: { type: 'string', pattern: '^[0-9]+$' },
          denominator: { type: 'string', pattern: '^[0-9]+$' },
          correctness: { type: 'string', nullable: true, pattern: '^(100|[0-9]{1,2})\\.[0-9]{2}$' },
        },
        required: [
          'submission_count',
          'attempt_count',
          'correct_count',
          'incorrect_count',
          'unanswered_count',
          'independent_question_count',
          'numerator',
          'denominator',
          'correctness',
        ],
      },
      mastery_window_days: { type: 'integer', enum: [90] },
      mastery: {
        type: 'array',
        maxItems: 500,
        items: object({
          knowledge_point_id: resourceId,
          independent_question_count: { type: 'integer', minimum: 0 },
          numerator: { type: 'string', pattern: '^[0-9]+$' },
          denominator: { type: 'string', pattern: '^[0-9]+$' },
          mastery: { type: 'string', nullable: true, pattern: '^(100|[0-9]{1,2})\\.[0-9]{2}$' },
          status: choice('insufficient_evidence', 'weak', 'developing', 'mastered'),
          last_evidence_at: { type: 'string', format: 'date-time' },
        }),
      },
    }),
  });

  const orgHeader: ParameterObject = { in: 'header', name: 'X-Org-Id', required: true, schema: resourceId };
  const writeHeaders: ParameterObject[] = [
    orgHeader,
    { in: 'header', name: 'Origin', required: true, schema: text },
    { in: 'header', name: 'X-CSRF-Token', required: true, schema: text },
    { in: 'header', name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' } },
  ];
  const errors: Record<string, string> = {
    '401': 'SESSION_EXPIRED',
    '403': 'FORBIDDEN / ORIGIN_REJECTED / CSRF_REJECTED',
    '404': 'NOT_FOUND',
    '409': 'REVISION_CONFLICT / CLASS_ARCHIVED / ASSIGNMENT_EXISTS / IDEMPOTENCY_CONFLICT',
    '422': 'VALIDATION_ERROR / CLASS_TOO_LARGE / PARTICIPANT_INVALID / ORG_REQUIRED / IDEMPOTENCY_KEY_REQUIRED',
    '429': 'RATE_LIMITED',
    '503': 'MAINTENANCE_ACTIVE / DEPENDENCY_UNAVAILABLE',
  };

  const routes: Array<{
    path: string;
    method: 'get' | 'post' | 'patch';
    summary: string;
    schema: string;
    body?: string;
    write?: boolean;
    params?: ParameterObject[];
    queries?: ParameterObject[];
  }> = [
    { path: '/api/v1/teacher/classes', method: 'post', summary: '创建班级', schema: 'TeachingClassView', body: 'TeachingClassCreate', write: true },
    { path: '/api/v1/teacher/classes/{id}', method: 'patch', summary: '更新或归档班级', schema: 'TeachingClassView', body: 'TeachingClassPatch', write: true, params: [{ in: 'path', name: 'id', required: true, schema: resourceId }] },
    { path: '/api/v1/teacher/classes/{id}/members', method: 'post', summary: '添加名册学生', schema: 'TeachingRosterMutationResult', body: 'TeachingRosterMutation', write: true, params: [{ in: 'path', name: 'id', required: true, schema: resourceId }] },
    { path: '/api/v1/teacher/classes/{id}/members/remove', method: 'post', summary: '移除名册学生', schema: 'TeachingRosterRemoveResult', body: 'TeachingRosterMutation', write: true, params: [{ in: 'path', name: 'id', required: true, schema: resourceId }] },
    { path: '/api/v1/teacher/assignments', method: 'post', summary: '创建授课关系', schema: 'TeachingAssignmentView', body: 'TeachingAssignmentCreate', write: true },
    { path: '/api/v1/teacher/assignments/{id}/end', method: 'post', summary: '结束授课关系', schema: 'TeachingAssignmentView', body: 'TeachingAssignmentEnd', write: true, params: [{ in: 'path', name: 'id', required: true, schema: resourceId }] },
    { path: '/api/v1/teacher/classes', method: 'get', summary: '列出本人有效授课班', schema: 'TeachingClassList' },
    { path: '/api/v1/teacher/classes/{id}/roster', method: 'get', summary: '读取授课班活动名册', schema: 'TeachingRosterView', params: [{ in: 'path', name: 'id', required: true, schema: resourceId }] },
    {
      path: '/api/v1/teacher/classes/{id}/subjects/{subjectId}/report',
      method: 'get',
      summary: '班级学科聚合报告',
      schema: 'TeachingClassSubjectReport',
      params: [
        { in: 'path', name: 'id', required: true, schema: resourceId },
        { in: 'path', name: 'subjectId', required: true, schema: resourceId },
      ],
    },
    {
      path: '/api/v1/teacher/classes/{id}/subjects/{subjectId}/students/{memberId}/report',
      method: 'get',
      summary: '单生学科绑定报告',
      schema: 'TeachingStudentSubjectReport',
      params: [
        { in: 'path', name: 'id', required: true, schema: resourceId },
        { in: 'path', name: 'subjectId', required: true, schema: resourceId },
        { in: 'path', name: 'memberId', required: true, schema: resourceId },
      ],
      queries: [{ in: 'query', name: 'period', required: false, schema: choice('7d', '30d') }],
    },
  ];

  for (const route of routes) {
    const operation = document.paths[route.path]?.[route.method];
    if (!operation) throw new Error(`Missing teaching API route: ${route.method.toUpperCase()} ${route.path}`);
    operation.summary = route.summary;
    operation.description = '教师最小端班级/名册/授课；可见性只认 teaching_assignments；归档班不可写名册。';
    operation.security = [{ session: [] }];
    operation.parameters = [...(route.write ? writeHeaders : [orgHeader]), ...(route.params ?? []), ...(route.queries ?? [])];
    if (route.body) {
      operation.requestBody = { required: true, content: { 'application/json': { schema: ref(route.body) } } };
    }
    operation.responses = {
      '200': {
        description: route.summary,
        headers: { 'Cache-Control': { schema: choice('private, no-store') }, 'X-Request-Id': { schema: traceUuid } },
        content: { 'application/json': { schema: object({ data: ref(route.schema), request_id: traceUuid }) } },
      },
    };
    for (const [status, description] of Object.entries(errors)) {
      operation.responses[status] = {
        description,
        content: { 'application/json': { schema: ref('ApiError') } },
        ...(status === '429' ? { headers: { 'Retry-After': { schema: text } } } : {}),
      };
    }
  }
}
