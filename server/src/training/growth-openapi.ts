import type {
  OpenAPIObject,
  SchemaObject,
} from "@nestjs/swagger/dist/interfaces/open-api-spec.interface";
const text = (maxLength = 200): SchemaObject => ({ type: "string", maxLength }),
  id: SchemaObject = { type: "string", pattern: "^[a-f0-9]{24}$" },
  integer = (minimum = 1): SchemaObject => ({ type: "integer", minimum }),
  date: SchemaObject = { type: "string", format: "date-time" },
  nullable = (s: SchemaObject): SchemaObject => ({ ...s, nullable: true }),
  en = (...values: string[]): SchemaObject => ({
    type: "string",
    enum: values,
  }),
  object = (
    properties: Record<string, SchemaObject>,
    required = Object.keys(properties),
  ): SchemaObject => ({
    type: "object",
    additionalProperties: false,
    properties,
    required,
  }),
  array = (items: SchemaObject, maxItems = 50): SchemaObject => ({
    type: "array",
    maxItems,
    items,
  }),
  base = {
    _id: id,
    org_id: id,
    revision: integer(),
    created_at: date,
    updated_at: date,
  },
  bool: SchemaObject = { type: "boolean" },
  shareInput = {
    label: text(120),
    recipient_member_id: id,
    submission_ids: { ...array(id, 20), minItems: 1, uniqueItems: true },
    expires_at: date,
  },
  share = object({
    ...base,
    ...shareInput,
    user_id: id,
    member_id: id,
    recipient_user_id: id,
    revoked_at: nullable(date),
    access_fence: integer(0),
  }),
  feedback = nullable(
    object({ comments: text(16000), score: integer(0), at: date }),
  ),
  portfolio = object(
    {
      id,
      kind: en("work", "course", "meetup"),
      source_id: id,
      title: text(500),
      subject_id: id,
      subject_name: text(),
      organization_id: id,
      at: date,
      verification: en(
        "submitted",
        "teacher_feedback",
        "self_confirmed",
        "in_progress",
        "teacher_recorded",
      ),
      body: text(16000),
      feedback,
      class_id: id,
      submission_no: integer(),
      lesson_key: text(64),
    },
    [
      "id",
      "kind",
      "source_id",
      "title",
      "subject_id",
      "at",
      "verification",
      "body",
      "feedback",
    ],
  ),
  preferences = { question: bool, feedback: bool, meetup: bool },
  inbox = object({
    _id: id,
    revision: integer(),
    created_at: date,
    read_at: nullable(date),
    event_kind: en("question", "feedback", "meetup"),
    message: text(300),
    target: object({ kind: en("question", "work", "meetup"), id }),
  });
export function growthOpenApi(document: OpenAPIObject) {
  const requests: Record<string, SchemaObject> = {
    shares: object(shareInput),
    "shares/{id}/revoke": object({ expected_revision: integer() }),
    "inbox/{id}/read": object({ expected_revision: integer() }),
    preferences: object({ expected_revision: integer(0), ...preferences }),
    "receipts/query": object({
      key: { ...text(128), pattern: "^[A-Za-z0-9_-]{8,128}$" },
    }),
  };
  for (const [path, item] of Object.entries(document.paths)) {
    if (!path.startsWith("/api/v1/training/growth/")) continue;
    const key = path.slice("/api/v1/training/growth/".length);
    for (const method of ["get", "post"] as const) {
      const op = item?.[method];
      if (!op) continue;
      op.parameters = [
        { name: "X-Org-Id", in: "header", required: true, schema: id },
        ...(path.includes("{id}")
          ? [{ name: "id", in: "path" as const, required: true, schema: id }]
          : []),
      ];
      if (method === "post") {
        op.parameters.push({
          name: "X-CSRF-Token",
          in: "header",
          required: true,
          schema: text(200),
        });
        if (key !== "receipts/query")
          op.parameters.push({
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { ...text(128), pattern: "^[A-Za-z0-9_-]{8,128}$" },
          });
        op.requestBody = {
          required: true,
          content: { "application/json": { schema: requests[key]! } },
        };
      }
      const paged =
        ["portfolio", "shares", "inbox"].includes(key) && method === "get";
      const query: Record<string, SchemaObject> = paged
        ? { cursor: text(2000), limit: { ...integer(), maximum: 50 } }
        : {};
      if (["portfolio", "portfolio/export"].includes(key))
        Object.assign(query, {
          kind: en("work", "course", "meetup"),
          from: { type: "string", format: "date" },
          to: { type: "string", format: "date" },
          subject_id: id,
        });
      if (key === "inbox") query.unread = en("true", "false");
      if (key === "recipients") query.submission_id = id;
      if (method === "get")
        op.parameters.push(
          ...Object.entries(query).map(([name, schema]) => ({
            name,
            in: "query" as const,
            required: key === "recipients",
            schema,
          })),
        );
      let result: SchemaObject;
      if (key === "portfolio/export")
        result = object({
          items: array(portfolio, 2000),
          filters: object(
            {
              kind: en("work", "course", "meetup"),
              from: { type: "string", format: "date" },
              to: { type: "string", format: "date" },
              subject_id: id,
            },
            [],
          ),
          count: integer(0),
          exported_at: date,
        });
      else if (paged)
        result = object({
          items: array(
            key === "portfolio"
              ? portfolio
              : key === "inbox"
                ? inbox
                : object({
                    ...share.properties,
                    perspective: en("owner", "recipient"),
                  }),
          ),
          next_cursor: nullable(text(2000)),
        });
      else if (key === "shares/{id}")
        result = object({ share, items: array(portfolio, 20) });
      else if (key.startsWith("shares")) result = share;
      else if (key === "recipients")
        result = object({
          items: array(object({ member_id: id, name: text() }), 200),
          truncated: bool,
        });
      else if (key === "preferences")
        result = object(
          method === "get"
            ? { revision: integer(0), ...preferences }
            : { ...base, user_id: id, member_id: id, ...preferences },
        );
      else if (key === "inbox/{id}/read")
        result = object({ _id: id, revision: integer(), read_at: date });
      else result = object({ status: en("confirmed", "not_found") });
      op.responses["200"] = {
        description: "当前授权核验后的成长记录",
        content: {
          "application/json": {
            schema: object({ data: result, request_id: text() }),
          },
        },
      };
      for (const status of [401, 403, 404, 409, 422, 429, 503])
        op.responses[status] = {
          description: "会话、来源、修订、输入或模块准入失败",
        };
    }
  }
}
