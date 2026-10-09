import type {
  OpenAPIObject,
  SchemaObject,
} from "@nestjs/swagger/dist/interfaces/open-api-spec.interface";
export function importOpenApi(d: OpenAPIObject) {
  const schemas = d.components!.schemas!,
    ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const id: SchemaObject = { type: "string", pattern: "^[0-9a-f]{24}$" },
    revision: SchemaObject = { type: "integer", minimum: 1 },
    str: SchemaObject = { type: "string" },
    date: SchemaObject = { type: "string", format: "date-time" };
  const obj = (
    properties: Record<string, any>,
    required = Object.keys(properties),
  ): SchemaObject => ({
    type: "object",
    additionalProperties: false,
    properties,
    required,
  });
  const metadata = {
    id,
    owner_id: id,
    file_id: id,
    status: {
      type: "string",
      enum: [
        "queued",
        "running",
        "preview-ready",
        "failed",
        "cancelled",
        "applied",
      ],
    },
    revision,
    error_code: str,
    expires_at: date,
    format: { type: "string", enum: ["pdf", "docx"] },
    applied_revision: { ...revision, nullable: true },
    created_at: date,
  };
  schemas.ImportMetadata = obj(metadata);
  schemas.ImportCreate = obj({ file_id: id, expected_revision: revision });
  schemas.ImportCancel = obj({ job_revision: revision });
  schemas.ImportApply = obj({
    job_revision: revision,
    expected_revision: revision,
    chapters: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: ref("ContentChapterInput"),
    },
    license: ref("ContentLicense"),
    rights_type: {
      type: "string",
      enum: ["original", "authorized", "public-domain"],
    },
    proof_reference: { type: "string", minLength: 1, maxLength: 1000 },
    usage_restrictions: { type: "string", maxLength: 1000 },
  });
  schemas.ImportRead = obj(
    {
      ...metadata,
      preview: {
        type: "array",
        maxItems: 100,
        items: obj({
          ordinal: { type: "integer", minimum: 0 },
          page: { type: "integer", minimum: 1, maximum: 100, nullable: true },
          text: { type: "string", maxLength: 160000 },
        }),
      },
      warnings: { type: "array", maxItems: 10, items: str },
    },
    Object.keys(metadata),
  );
  schemas.ImportList = obj({
    items: { type: "array", maxItems: 50, items: ref("ImportMetadata") },
    truncated: { type: "boolean" },
  });
  schemas.ImportCancelled = obj({
    id,
    status: { type: "string", enum: ["cancelled"] },
    revision,
  });
  schemas.ImportApplied = obj({
    id,
    status: { type: "string", enum: ["applied"] },
    revision,
    owner_revision: revision,
    chapter_count: { type: "integer", minimum: 1, maximum: 100 },
  });
  const base = "/api/v1/admin/textbook-editions/{ownerId}/imports";
  for (const [suffix, method, input, output] of [
    ["", "get", null, "ImportList"],
    ["", "post", "ImportCreate", "ImportMetadata"],
    ["/{jobId}", "get", null, "ImportRead"],
    ["/{jobId}/cancel", "post", "ImportCancel", "ImportCancelled"],
    ["/{jobId}/apply", "post", "ImportApply", "ImportApplied"],
  ] as const) {
    const path = base + suffix,
      parameters: any[] = [
        { name: "ownerId", in: "path", required: true, schema: id },
        { name: "X-Org-Id", in: "header", required: true, schema: id },
      ];
    if (suffix)
      parameters.push({
        name: "jobId",
        in: "path",
        required: true,
        schema: id,
      });
    if (input)
      parameters.push(
        {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          schema: { type: "string", minLength: 8, maxLength: 128 },
        },
        { name: "X-CSRF-Token", in: "header", required: true, schema: str },
      );
    d.paths[path] ??= {};
    d.paths[path]![method] = {
      tags: ["素材导入"],
      operationId: `import${output}${method}`,
      description:
        "需开启培训、知识、导入及扫描；只返回当前用户任务，应用仍为草稿，正文不会自动外发。",
      security: [{ session: [] }],
      parameters,
      ...(input
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: ref(input) } },
            },
          }
        : {}),
      responses: {
        "200": {
          description: "成功",
          content: {
            "application/json": {
              schema: obj({
                data: ref(output),
                request_id: { type: "string", format: "uuid" },
              }),
            },
          },
        },
        "409": { description: "版本、任务、文件或许可已变化" },
        "503": { description: "导入未启用" },
      },
    };
  }
  schemas.ImportReceipt = obj({
    status: { type: "string", enum: ["unknown", "resolved"] },
    result: { ...obj({ id, status: str, revision }), nullable: true },
  });
  d.paths[base + "/requests/{key}"] = {
    get: {
      operationId: "importReceipt",
      tags: ["素材导入"],
      security: [{ session: [] }],
      parameters: [
        { name: "ownerId", in: "path", required: true, schema: id },
        {
          name: "key",
          in: "path",
          required: true,
          schema: { type: "string", minLength: 8, maxLength: 128 },
        },
        { name: "X-Org-Id", in: "header", required: true, schema: id },
      ],
      responses: {
        "200": {
          description: "仅当前许可/编辑权下的原编号元数据回执",
          content: {
            "application/json": {
              schema: obj({
                data: ref("ImportReceipt"),
                request_id: { type: "string", format: "uuid" },
              }),
            },
          },
        },
      },
    },
  };
  schemas.ImportProvenance = obj({
    items: {
      type: "array",
      maxItems: 50,
      items: obj({
        id,
        file_id: id,
        applied_revision: revision,
        chapter_ids: { type: "array", items: id, maxItems: 100 },
        license: ref("ContentLicense"),
        rights_type: {
          type: "string",
          enum: ["original", "authorized", "public-domain"],
        },
        proof_reference: str,
        usage_restrictions: str,
        created_at: date,
      }),
    },
    truncated: { type: "boolean" },
  });
  d.paths[base + "/provenance"] = {
    get: {
      operationId: "importProvenance",
      tags: ["素材导入"],
      security: [{ session: [] }],
      parameters: [
        { name: "ownerId", in: "path", required: true, schema: id },
        { name: "X-Org-Id", in: "header", required: true, schema: id },
      ],
      responses: {
        "200": {
          description:
            "当前管理/独立审核权限与有效许可下的共享来源证明，无个人任务身份与正文",
          content: {
            "application/json": {
              schema: obj({
                data: ref("ImportProvenance"),
                request_id: { type: "string", format: "uuid" },
              }),
            },
          },
        },
      },
    },
  };
}
