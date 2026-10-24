import type {
  OpenAPIObject,
  SchemaObject,
  ReferenceObject,
} from "@nestjs/swagger/dist/interfaces/open-api-spec.interface";
const id: SchemaObject = { type: "string", pattern: "^[a-f0-9]{24}$" },
  text: SchemaObject = { type: "string", maxLength: 200 },
  body: SchemaObject = { type: "string", maxLength: 16000 },
  revision: SchemaObject = { type: "integer", minimum: 1 },
  bool: SchemaObject = { type: "boolean" };
const object = (
  properties: Record<string, SchemaObject | ReferenceObject>,
  required = Object.keys(properties),
): SchemaObject => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const lesson = object({
  key: { type: "string", pattern: "^[a-z0-9_-]{1,64}$" },
  title: text,
  kind: { type: "string", enum: ["text", "pdf", "video", "audio"] },
  required: bool,
  body,
  file_id: { ...id, nullable: true },
  owner_version_id: { ...id, nullable: true },
});
const rubric: SchemaObject = {
  type: "array",
  minItems: 1,
  maxItems: 20,
  items: object({
    key: text,
    title: text,
    weight: { type: "integer", minimum: 0, maximum: 100 },
  }),
};
const requestSchemas: Record<string, SchemaObject> = {
  "knowledge/search": object({query:{type:"string",maxLength:256},scope:{type:"array",minItems:1,maxItems:20,
    items:{$ref:"#/components/schemas/KnowledgeSource"}}}),
  "knowledge/rebuild": object({source:{$ref:"#/components/schemas/KnowledgeSource"}}),
  reports: object(
    {
      class_id: id,
      subject_id: id,
      task_id: { ...id, nullable: true },
      title: text,
      body: { type: "string", maxLength: 12000 },
    },
    ["class_id", "subject_id", "title", "body"],
  ),
  "reports/{id}/actions": object(
    {
      action: {
        type: "string",
        enum: [
          "edit",
          "refresh-facts",
          "request-review",
          "reject",
          "publish",
          "retire",
        ],
      },
      expected_revision: revision,
      title: text,
      body,
      note: body,
    },
    ["action", "expected_revision"],
  ),
  "receipts/query": object({
    key: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
  }),
  courses: object({
    code: text,
    title: text,
    subject_id: id,
    version_no: revision,
    lessons: { type: "array", minItems: 1, maxItems: 100, items: lesson },
  }),
  "courses/{id}/actions": object(
    {
      expected_revision: revision,
      action: {
        type: "string",
        enum: ["edit", "request-review", "publish", "reject", "retire"],
      },
      title: text,
      lessons: { type: "array", maxItems: 100, items: lesson },
      note: body,
    },
    ["expected_revision", "action"],
  ),
  "courses/{id}/assign": object({ class_id: id }),
  "courses/{id}/progress": object({
    lesson_key: text,
    position: { type: "integer", minimum: 0, maximum: 86400 },
    complete: bool,
  }),
  tasks: object({
    class_id: id,
    subject_id: id,
    title: text,
    target_type: { type: "string", enum: ["course", "coursework", "quiz"] },
    target_id: { ...id, nullable: true },
    due_at: { type: "string", format: "date-time" },
    body,
    rubric,
  }),
  "tasks/{id}/actions": object({
    expected_revision: revision,
    action: { type: "string", enum: ["publish", "cancel"] },
  }),
  "tasks/{id}/coursework": object(
    {
      expected_revision: { type: "integer", minimum: 0 },
      action: { type: "string", enum: ["save", "submit", "withdraw"] },
      body,
      file_ids: { type: "array", items: id, maxItems: 5, uniqueItems: true },
    },
    ["expected_revision", "action", "body"],
  ),
  "tasks/{id}/files": object({
    expected_revision: revision,
    display_name: text,
    size: { type: "integer", minimum: 1, maximum: 10485760 },
    mime: {
      type: "string",
      enum: [
        "application/pdf",
        "image/png",
        "image/jpeg",
        "text/plain",
        "video/mp4",
        "audio/mpeg",
      ],
    },
    checksum: { type: "string", pattern: "^[a-f0-9]{64}$" },
  }),
  "tasks/{id}/feedback": object({
    head_revision: revision,
    submission_id: id,
    comments: { type: "string", maxLength: 8000 },
    scores: {
      type: "array",
      maxItems: 20,
      items: object({
        key: text,
        score: { type: "integer", minimum: 0, maximum: 100 },
      }),
    },
    publish: bool,
  }),
  "ai/config": object({
    enabled: bool,
    daily_limit: { type: "integer", minimum: 0, maximum: 10000 },
    expected_revision: { type: "integer", minimum: 0 },
  }),
  "ai/jobs": object({
    kind: {
      type: "string",
      enum: ["assist", "prepare", "questions", "report", "learning-report"],
    },
    context_id: id,
    prompt: { type: "string", maxLength: 4000 },
  }),
  "ai/jobs/{id}/dispatch": object({ expected_revision: revision }),
  "ai/jobs/{id}/cancel": object({ expected_revision: revision }),
  "ai/jobs/{id}/recover": object({ expected_revision: revision }),
  "ai/jobs/{id}/accept-report": object({expected_revision:revision}),
  "ai/jobs/{id}/accept": object({
    course_id: id,
    expected_revision: revision,
    lesson_key: text,
    title: text,
    body,
  }),
};
if (process.env.KL_AI_POLICY_ENABLED === "true")
  requestSchemas["ai/config"] = object(
    {
      enabled: bool,
      daily_limit: { type: "integer", minimum: 0, maximum: 10000 },
      expected_revision: { type: "integer", minimum: 0 },
      enabled_kinds: {
        type: "array",
        maxItems: 4,
        uniqueItems: true,
        items: {
          type: "string",
          enum: ["assist", "prepare", "questions", "report"],
        },
      },
      currency: { type: "string", pattern: "^[A-Z]{3}$" },
      daily_budget_micro: {
        type: "integer",
        minimum: 0,
        maximum: 1000000000000,
      },
      max_request_micro: { type: "integer", minimum: 0, maximum: 1000000000 },
    },
    ["enabled", "daily_limit", "expected_revision"],
  );
requestSchemas["ai/jobs/{id}/accept-question"] = object({
  question: object(
    {
      title: text,
      subject_id: id,
      question_type: {
        type: "string",
        enum: ["single", "multiple", "numeric"],
      },
      prompt: { type: "string", maxLength: 20000 },
      answer: { type: "string", maxLength: 2000 },
      explanation: { type: "string", maxLength: 20000 },
      difficulty: { type: "string", enum: ["基础", "提升", "挑战"] },
      options: {
        type: "array",
        maxItems: 12,
        items: object({
          id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,32}$" },
          text: { type: "string", maxLength: 2000 },
        }),
      },
      knowledge_point_ids: { type: "array", maxItems: 100, items: id },
    },
    ["title", "subject_id", "question_type", "prompt", "difficulty"],
  ),
});
const job = object({
  id,
  kind: { type: "string", enum: ["assist", "prepare", "questions", "report"] },
  context_id: id,
  status: {
    type: "string",
    enum: ["queued", "running", "succeeded", "failed", "unknown", "cancelled"],
  },
  revision,
  output: { type: "string", maxLength: 12000 },
  citations: { type: "array", items: object({ key: text, title: text }) },
  error_code: text,
  created_at: { type: "string", format: "date-time" },
});
const recoveryJob = object({
  id,
  kind: job.properties!.kind as SchemaObject,
  status: job.properties!.status as SchemaObject,
  revision,
  created_at: { type: "string", format: "date-time" },
  dispatch_started_at: { type: "string", format: "date-time", nullable: true },
});
const report = object({
  _id: id,
  org_id: id,
  revision,
  created_at: { type: "string", format: "date-time" },
  updated_at: { type: "string", format: "date-time" },
  class_id: id,
  subject_id: id,
  task_id: { ...id, nullable: true },
  author_id: id,
  contributors: { type: "array", maxItems: 100, uniqueItems: true, items: id },
  title: text,
  body: { type: "string", maxLength: 12000 },
  facts_json: { type: "string", maxLength: 16000 },
  source_watermark: { type: "string", pattern: "^[a-f0-9]{64}$" },
  facts_at: { type: "string", format: "date-time" },
  valid_until: { type: "string", format: "date-time" },
  status: { type: "string", enum: ["draft", "review", "published", "retired"] },
  reviewer_id: { ...id, nullable: true },
  review_note: body,
  published_version_id: { ...id, nullable: true },
});
export function trainingOpenApi(document: OpenAPIObject) {
  const metadata = object({ objectives: { type: "string", maxLength: 2000 }, audience: { type: "string", maxLength: 1000 },
    prerequisites: { type: "string", maxLength: 2000 }, difficulty: { type: "string", enum: ["introductory", "intermediate", "advanced"] },
    estimated_minutes: { type: "integer", minimum: 1, maximum: 100000 }, instructor: text, language: { type: "string", maxLength: 80 } });
  requestSchemas.courses!.properties!.metadata = metadata;
  requestSchemas.courses!.required = ["code", "title", "subject_id", "version_no", "lessons"];
  requestSchemas["courses/{id}/actions"]!.properties!.metadata = metadata;
  const envelope = (data: SchemaObject) =>
    object({ data, request_id: { type: "string", format: "uuid" } });
  const error = object({
    error: object({ code: text, message: text }),
    request_id: { type: "string", format: "uuid" },
  });
  document.components ??= {};
  document.components.schemas ??= {};
  const source:SchemaObject={oneOf:[object({kind:{type:"string",enum:["chapter"]},id}),
    object({kind:{type:"string",enum:["course-text"]},id,lesson_key:{type:"string",maxLength:64}})]};
  const scope:SchemaObject={type:"array",minItems:1,maxItems:20,items:{$ref:"#/components/schemas/KnowledgeSource"}};
  const evidence=object({key:text,source:{$ref:"#/components/schemas/KnowledgeSource"},title:text,revision,
    owner_id:id,source_hash:{type:"string",pattern:"^[a-f0-9]{64}$"},
    start_utf16:{type:"integer",minimum:0},end_utf16:{type:"integer",minimum:1},
    content_hash:{type:"string",pattern:"^[a-f0-9]{64}$"},text:{type:"string",maxLength:1600}});
  document.components.schemas.KnowledgeSource=source;
  document.components.schemas.KnowledgeEvidence=evidence;
  requestSchemas["ai/jobs"]!.properties!.knowledge_scope=scope;
  requestSchemas["ai/jobs"]!.properties!.knowledge_fingerprint={type:"string",pattern:"^[a-f0-9]{64}$"};
  job.properties!.knowledge_scope=scope;
  job.properties!.knowledge_evidence={type:"array",maxItems:5,items:{$ref:"#/components/schemas/KnowledgeEvidence"}};
  document.components.schemas.TrainingAiJob = job;
  document.components.schemas.TrainingLesson = lesson;
  for (const [path, item] of Object.entries(document.paths)) {
    if (
      !path.startsWith("/api/v1/training/") &&
      !path.startsWith("/api/v1/site/")
    )
      continue;
    for (const method of ["get", "post", "put"] as const) {
      const op = item[method];
      if (!op) continue;
      const training = path.startsWith("/api/v1/training/"),
        publicSite =
          path.includes("/site/pages/") || path.includes("/site/consultations");
      if (!publicSite) {
        op.security = [{ session: [] }];
        op.parameters = [
          ...(op.parameters ?? []).filter((p: any) => p.name !== "X-Org-Id"),
          { name: "X-Org-Id", in: "header", required: true, schema: id },
        ];
      } else op.security = [];
      if ((method === "post" || method === "put") && !publicSite) {
        op.parameters = [
          ...(op.parameters ?? []),
          {
            name: "Idempotency-Key",
            in: "header",
            required: !path.endsWith("/receipts/query") && !path.endsWith("/knowledge/search"),
            schema: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
          },
          {
            name: "X-CSRF-Token",
            in: "header",
            required: !path.endsWith("/knowledge/search"),
            schema: { type: "string" },
          },
        ];
      }
      const key = path.replace("/api/v1/training/", "");
      if (method === "put") {
        op.requestBody = {
          required: true,
          content: {
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
          },
        };
        op.parameters = [
          ...(op.parameters ?? []),
          {
            in: "header",
            name: "X-Owner-Revision",
            required: true,
            schema: revision,
          },
        ];
      }
      if (method === "post" && training && requestSchemas[key])
        op.requestBody = {
          required: true,
          content: { "application/json": { schema: requestSchemas[key]! } },
        };
      if (method === "post" && path === "/api/v1/site/drafts")
        op.requestBody = {
          required: true,
          content: {
            "application/json": {
              schema: object({
                page_key: {
                  type: "string",
                  enum: [
                    "home",
                    "features",
                    "ai-teaching",
                    "solutions",
                    "help",
                    "about",
                    "contact",
                  ],
                },
                title: text,
                body: { type: "string", maxLength: 12000 },
              }),
            },
          },
        };
      if (method === "post" && path.endsWith("/publish") && !training)
        op.requestBody = {
          required: true,
          content: {
            "application/json": {
              schema: object({ expected_revision: revision }),
            },
          },
        };
      if (method === "post" && path === "/api/v1/site/consultations")
        op.requestBody = {
          required: true,
          content: {
            "application/json": {
              schema: object({
                receipt: { type: "string", pattern: "^[a-f0-9]{64}$" },
                contact: text,
                name: { type: "string", maxLength: 80 },
                kind: {
                  type: "string",
                  enum: ["enterprise", "school", "other"],
                },
                consent: bool,
              }),
            },
          },
        };
      if (method === "post" && path === "/api/v1/site/leads/{id}/status")
        op.requestBody = {
          required: true,
          content: {
            "application/json": {
              schema: object({
                expected_revision: revision,
                status: { type: "string", enum: ["contacted", "closed"] },
              }),
            },
          },
        };
      let result: SchemaObject = { type: "object", additionalProperties: true };
      if (method === "get" && key === "discovery") {
        op.parameters = [...(op.parameters ?? []).filter((p: any) => p.in !== "query"),
          ...Object.entries({
            q: { type: "string", maxLength: 100 }, subject_id: id,
            format: { type: "string", enum: ["text", "pdf", "video", "audio"] },
            sort: { type: "string", enum: ["newest", "oldest"], default: "newest" },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
            cursor: { type: "string", maxLength: 2000 },
          }).map(([name, schema]) => ({ name, in: "query" as const, required: false, schema: schema as SchemaObject })),
        ];
        result = object({
        items: { type: "array", maxItems: 50, items: object({
          id, title: text, status: { type: "string", enum: ["published"] },
          revision, subject_id: id, subject_name: { type: "string", nullable: true },
          version_no: revision, lesson_count: { type: "integer", minimum: 1 },
          formats: { type: "array", uniqueItems: true, items: { type: "string", enum: ["text", "pdf", "video", "audio"] } },
          required_lesson_count: { type: "integer", minimum: 0 },
          lesson_titles: { type: "array", maxItems: 5, items: text },
          updated_at: { type: "string", format: "date-time" },
          metadata: { ...metadata, nullable: true },
        }, ["id", "title", "status", "revision", "subject_id", "subject_name", "version_no", "lesson_count", "formats", "required_lesson_count", "lesson_titles", "updated_at"]) },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        next_cursor: { type: "string", nullable: true },
      });
      }
      if (method === "get" && key === "discovery/paths") {
        op.parameters = [...(op.parameters ?? []).filter((p: any) => p.in !== "query"),
          ...Object.entries({ q: { type: "string", maxLength: 100 }, sort: { type: "string", enum: ["newest", "oldest"] },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 }, cursor: { type: "string", maxLength: 2000 } })
            .map(([name, schema]) => ({ name, in: "query" as const, required: false, schema: schema as SchemaObject }))];
        result = object({ items: { type: "array", maxItems: 50, items: object({ id, title: text, path_revision: revision,
          course_count: { type: "integer", minimum: 1, maximum: 30 }, task_count: { type: "integer", minimum: 0, maximum: 30 },
          assigned_at: { type: "string", format: "date-time" } }) }, limit: { type: "integer", minimum: 1, maximum: 50 },
          next_cursor: { type: "string", nullable: true } });
      }
      if (method === "get" && key === "discovery/paths/{id}") result = object({ id, title: text, path_revision: revision,
        assigned_at: { type: "string", format: "date-time" }, task_count: { type: "integer", minimum: 0, maximum: 30 },
        attendance_bp: { type: "integer", minimum: 8000, maximum: 10000 }, grade_min: { type: "integer", minimum: 0, maximum: 100 },
        courses: { type: "array", minItems: 1, maxItems: 30, items: object({ id, title: text, version_no: revision,
          lesson_count: { type: "integer", minimum: 1, maximum: 100 }, required_lesson_count: { type: "integer", minimum: 0, maximum: 100 },
          confirmed_required_count: { type: "integer", minimum: 0, maximum: 100 } }) } });
      if(path.endsWith("/knowledge/search"))result=object({status:{type:"string",enum:["grounded","insufficient-evidence"]},
        citations:{type:"array",maxItems:5,items:{$ref:"#/components/schemas/KnowledgeEvidence"}},fingerprint:{type:"string",pattern:"^[a-f0-9]{64}$"}});
      if(path.endsWith("/knowledge/rebuild"))result=object({status:{type:"string",enum:["pending"]},generation:revision});
      if(path.endsWith("/knowledge/sources"))result=object({items:{type:"array",maxItems:200,
        items:object({source:{$ref:"#/components/schemas/KnowledgeSource"},title:text,revision,current:bool})},truncated:bool});
      if(path.endsWith("/knowledge/status"))result=object({items:{type:"array",maxItems:100,items:object({
        kind:{type:"string",enum:["textbook","course"]},owner_id:id,title:text,
        status:{type:"string",enum:["pending","running","completed","failed"]},error_code:text,generation:revision,
        updated_at:{type:"string",format:"date-time"},source:{oneOf:[{$ref:"#/components/schemas/KnowledgeSource"},{type:"object",nullable:true,enum:[null]}]}})},truncated:bool,index_version:revision});
      if (
        (training && path.includes("/ai/jobs/")) ||
        (training && path.endsWith("/ai/jobs") && method === "post")
      )
        result = job;
      if (path.endsWith("/accept-report") || path.endsWith("/accept") || path.endsWith("/accept-question"))
        result = { type: "object", additionalProperties: true };
      if (path === "/api/v1/training/ai/recovery")
        result = object({
          items: {
            type: "array",
            maxItems: 100,
            items: object({ ...recoveryJob.properties, recoverable: bool }),
          },
          truncated: bool,
        });
      if (path === "/api/v1/training/ai/jobs/{id}/recover")
        result = recoveryJob;
      op.responses["200"] = {
        description:
          "服务端重新验证授权后的实际结果；列表最多200项（AI/网站最多100项），没有内存兜底",
        content: { "application/json": { schema: envelope(result) } },
      };
      if (
        method === "get" &&
        path === "/api/v1/training/coursework-files/{id}/content"
      ) {
        op.responses["200"] = {
          description: "授权后交付已扫描附件",
          content: {
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
          },
        };
      }
      for (const code of [401, 403, 404, 409, 422, 429, 503])
        op.responses[code] = {
          description: (
            {
              401: "会话失效",
              403: "授权/CSRF/职责分离失败",
              404: "资源不可访问",
              409: "版本/状态/截止/幂等冲突",
              422: "输入无效",
              429: "频率或AI日预算限制",
              503: "扩展/模型/数据库不可用",
            } as Record<number, string>
          )[code]!,
          content: { "application/json": { schema: error } },
        };
    }
  }
}
