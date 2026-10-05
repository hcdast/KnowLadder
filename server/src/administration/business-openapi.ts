const traceUuid = { type: "string" as const, format: "uuid" };
import type { OpenAPIObject } from '@nestjs/swagger';
import type { OperationObject, SchemaObject, ReferenceObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

type Schema = SchemaObject | ReferenceObject;
const resourceId: SchemaObject = { type: 'string', pattern: "^[0-9a-f]{24}$" };
const text: SchemaObject = { type: 'string' };
const natural: SchemaObject = { type: 'integer', minimum: 0 };
const nullable = (schema: SchemaObject): SchemaObject => ({ ...schema, nullable: true });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): SchemaObject => ({ type: 'object', additionalProperties: false, properties, required });
const array = (items: Schema): SchemaObject => ({ type: 'array', items });
const choices = (...values: string[]): SchemaObject => ({ type: 'string', enum: values });
const normalizePath = (path: string) => path.replace(/\{[^}]+\}/g, '{}');
const methods = ['get', 'post', 'put', 'patch'] as const;
const prefix = '/api/v1/console/business/';
const orgHeaders = [
  { in: 'header' as const, name: 'X-Org-Id', required: true, description: '操作者的有效平台组织', schema: resourceId },
  { in: 'header' as const, name: 'X-Target-Org-Id', required: true, description: '精确授权范围内的单个目标业务组织', schema: resourceId },
];

/** The platform routes use the same domain DTOs, not a second content/exam contract. */
export function extendPlatformBusinessOpenApi(document: OpenAPIObject): void {
  const originals = Object.entries(document.paths).filter(([path]) => !path.startsWith(prefix));
  for (const [path, item] of Object.entries(document.paths)) {
    if (!path.startsWith(prefix)) continue;
    const relative = path.slice(prefix.length);
    const module = relative.split('/')[0];
    if (module !== 'content' && module !== 'assessment' || relative.endsWith('/requests')) continue;
    const originalPath = `/api/v1/${relative.slice(module.length + 1)}`;
    const originalEntry = originals.find(([candidate]) => normalizePath(candidate) === normalizePath(originalPath));
    if (!originalEntry) throw new Error(`Missing domain OpenAPI contract for ${path}`);
    const original = originalEntry[1];
    for (const method of methods) {
      const operation = item[method], source = original[method];
      if (!operation || !source) continue;
      const copy = structuredClone(source);
      const sourceParameters: string[] = originalEntry[0].match(/\{[^}]+\}/g) ?? [];
      const targetParameters: string[] = path.match(/\{[^}]+\}/g) ?? [];
      copy.parameters = (copy.parameters ?? []).filter(p => !('name' in p) || p.name !== 'X-Org-Id' && p.name !== 'X-Target-Org-Id');
      for (const parameter of copy.parameters) {
        if (!('name' in parameter) || parameter.in !== 'path') continue;
        const index = sourceParameters.indexOf(`{${parameter.name}}`);
        if (index >= 0 && targetParameters[index]) parameter.name = targetParameters[index].slice(1, -1);
      }
      copy.parameters.push(...orgHeaders);
      copy.operationId = operation.operationId ?? `platform_${copy.operationId ?? `${module}_${method}`}`;
      copy.tags = ['平台跨组织业务'];
      copy.description = `平台能力-组织范围逐请求校验；保留原领域资源与独立审核规则。${copy.description ?? ''}`;
      item[method] = copy;
    }
  }
  const envelope = (data: SchemaObject) => object({ data, request_id: text });
  const error = object({ error: object({ code: text, message: text }), request_id: text });
  const response = (schema: SchemaObject) => ({ description: '当前授权范围内的真实结果', content: { 'application/json': { schema: envelope(schema) } } });
  const read = (path: string, schema: SchemaObject, parameters: OperationObject['parameters'] = []) => {
    const operation = document.paths[`${prefix}${path}`]?.get;
    if (!operation) throw new Error(`Missing platform read route ${path}`);
    operation.parameters = [...orgHeaders, ...parameters];
    operation.responses = { 200: response(schema) };
    for (const status of ['401', '403', '404', '409', '422', '429', '503']) operation.responses[status] = { description: '身份、范围、版本或依赖不可用时拒绝交付', content: { 'application/json': { schema: error } } };
  };
  const receiptResult = object({ id: nullable(resourceId), revision: nullable(natural), owner_revision: natural, status: nullable(text), scan_status: text }, ['id', 'status']);
  const receipt = object({ status: choices('unknown', 'resolved'), result: receiptResult }, ['status']);
  const keyQuery = { in: 'query' as const, name: 'key', required: true, schema: { type: 'string' as const, pattern: '^[A-Za-z0-9_-]{8,128}$' } };
  read('content/requests', receipt, [keyQuery, { in: 'query', name: 'resource_id', required: false, description: '仅文件上传回执需提供原fileId；按原key及操作者组织绑定验证', schema: resourceId }]);
  read('assessment/requests', receipt, [keyQuery]);
  const page = object({ items: array(object({ id: resourceId, name: text, member_id: resourceId }, [])), next_cursor: nullable(text), class_id: resourceId }, ['items', 'next_cursor']);
  read('reports/options', page, [
    { in: 'query', name: 'resource', schema: choices('classes', 'subjects') },
    { in: 'query', name: 'class_id', schema: resourceId },
    { in: 'query', name: 'cursor', schema: text },
    { in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
  ]);
  const pathParameters = ['classId', 'subjectId'].map(name => ({ in: 'path' as const, name, required: true, schema: resourceId }));
  const bands = object({ insufficient_evidence: natural, weak: natural, developing: natural, mastered: natural });
  read('reports/classes/{classId}/subjects/{subjectId}', object({ class_id: resourceId, subject_id: resourceId, status: choices('ready', 'insufficient', 'stale', 'updating'), roster_count: natural, projected_count: nullable(natural), mastery_bands: { ...bands, nullable: true }, submission_count_7d: nullable(natural), submission_count_30d: nullable(natural), weak_knowledge_points: array(object({ knowledge_point_id: resourceId, title: text, student_count: natural })), rule_version: text }), pathParameters);
  const percentage = nullable({ type: 'string', pattern: '^(?:100|[0-9]{1,2})\\.[0-9]{2}$' });
  const activity = object({ submission_count: natural, attempt_count: natural, correct_count: natural, incorrect_count: natural, unanswered_count: natural, independent_question_count: natural, numerator: text, denominator: text, correctness: percentage });
  const mastery = object({ knowledge_point_id: resourceId, independent_question_count: natural, numerator: text, denominator: text, mastery: percentage, status: choices('insufficient_evidence', 'weak', 'developing', 'mastered'), last_evidence_at: { type: 'string', format: 'date-time' } });
  read('reports/classes/{classId}/subjects/{subjectId}/students/{memberId}', object({ class_id: resourceId, subject_id: resourceId, member_id: resourceId, status: choices('ready', 'insufficient_evidence', 'stale', 'updating', 'unavailable'), source_watermark: nullable(text), generated_at: nullable({ type: 'string', format: 'date-time' }), rule_version: text, period: choices('7d', '30d'), activity: { ...activity, nullable: true }, mastery_window_days: { type: 'integer', enum: [90] }, mastery: array(mastery) }), [...pathParameters, { in: 'path', name: 'memberId', required: true, schema: resourceId }, { in: 'query', name: 'period', schema: choices('7d', '30d') }]);
}
