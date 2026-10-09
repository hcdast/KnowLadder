import type {
  OpenAPIObject,
  SchemaObject,
} from "@nestjs/swagger/dist/interfaces/open-api-spec.interface";
export function workbenchOpenApi(d: OpenAPIObject) {
  const id: SchemaObject = { type: "string", pattern: "^[a-f0-9]{24}$" },
    date: SchemaObject = { type: "string", format: "date-time" },
    bool: SchemaObject = { type: "boolean" },
    str: SchemaObject = { type: "string" },
    num: SchemaObject = { type: "integer", minimum: 0 };
  const obj = (
    properties: Record<string, any>,
    required = Object.keys(properties),
  ): SchemaObject => ({
    type: "object",
    additionalProperties: false,
    properties,
    required,
  });
  const base = "/api/v1/training",
    security = [{ session: [] }];
  const headers = [
    { name: "X-Org-Id", in: "header", required: true, schema: id },
  ];
  const response = (data: SchemaObject) => ({
    "200": {
      description: "当前权限下的真实结果",
      content: {
        "application/json": {
          schema: obj({ data, request_id: { type: "string", format: "uuid" } }),
        },
      },
    },
  });
  const preview = d.paths[base + "/courses/{id}/assignments/preview"]!.post!;
  preview.operationId = "courseAssignmentsPreview";
  preview.security = security;
  preview.parameters = [
    ...headers,
    { name: "id", in: "path", required: true, schema: id },
    { name: "X-CSRF-Token", in: "header", required: true, schema: str },
  ] as any;
  preview.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: obj({
          class_ids: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            uniqueItems: true,
            items: id,
          },
        }),
      },
    },
  };
  preview.responses = response(
    obj({
      course_id: id,
      items: {
        type: "array",
        maxItems: 20,
        items: obj(
          {
            class_id: id,
            name: str,
            status: {
              type: "string",
              enum: ["ready", "already_assigned", "forbidden", "conflict"],
            },
          },
          ["class_id", "status"],
        ),
      },
    }),
  );
  d.paths[base + "/courses/{id}/assign"]!.post!.responses = response(
    obj({
      course_id: id,
      class_id: id,
      status: { type: "string", enum: ["assigned", "already_assigned"] },
    }),
  );
  const module = (item: SchemaObject, max: number) =>
    obj({
      status: { type: "string", enum: ["ready", "disabled", "unavailable"] },
      items: { type: "array", maxItems: max, items: item },
      truncated: bool,
    });
  const modules = obj({
    courses: module(
      obj({
        id,
        title: str,
        required: num,
        completed: num,
        completion: { type: "boolean", nullable: true },
      }),
      200,
    ),
    tasks: module(
      obj({
        id,
        title: str,
        due_at: date,
        target_type: { type: "string", enum: ["course", "coursework", "quiz"] },
        target_id: { ...id, nullable: true },
        status: {
          type: "string",
          enum: ["pending", "course_complete", "check_source"],
        },
      }),
      200,
    ),
    schedule: module(
      obj({
        id,
        title: str,
        start_at: date,
        end_at: date,
        status: { type: "string", enum: ["published", "ended"] },
      }),
      100,
    ),
    certificates: module(
      obj({
        id,
        number: str,
        status: { type: "string", enum: ["issued", "revoked"] },
        created_at: date,
      }),
      200,
    ),
    notifications: module(
      obj({
        id,
        message: str,
        status: { type: "string", enum: ["read", "unread"] },
        source_type: str,
        source_id: id,
        created_at: date,
      }),
      50,
    ),
    surveys: module(
      obj({ id, title: str, course_id: id, closes_at: date, submitted: bool }),
      50,
    ),
  });
  const courseRead = d.paths[base + "/courses/{id}"]!.get!;
  courseRead.parameters = [
    ...(courseRead.parameters ?? []).filter((parameter:any)=>parameter.name!=="mode"),
    {
      name: "mode",
      in: "query",
      required: false,
      schema: { type: "string", enum: ["learner"] },
    },
  ];
  const read = d.paths[base + "/workbench"]!.get!;
  read.operationId = "learnerWorkbench";
  read.security = security;
  read.parameters = [
    ...headers,
    { name: "from", in: "query", required: true, schema: date },
    { name: "to", in: "query", required: true, schema: date },
  ] as any;
  read.responses = response(
    obj({ from: date, to: date, generated_at: date, modules }),
  );
}
