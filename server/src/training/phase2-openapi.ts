import { TRAINING_PHASE2_WIRE_SCHEMAS } from "./phase2-schema";
const id = { type: "string", pattern: "^[a-f0-9]{24}$" },
  text = { type: "string", maxLength: 2000 },
  revision = { type: "integer", minimum: 0 },
  ids = { type: "array", maxItems: 30, uniqueItems: true, items: id };
function wire(x: any): any {
  if(x.anyOf){const nonNull=x.anyOf.filter((branch:any)=>branch.bsonType!=='null');if(nonNull.length===1 && nonNull.length<x.anyOf.length)return {...wire(nonNull[0]),nullable:true};return {oneOf:x.anyOf.map(wire)};}
  if (x.enum) return { type: "string", enum: x.enum };
  const t = x.bsonType;
  if (t === "objectId") return id;
  if (t === "date") return { type: "string", format: "date-time" };
  if (t === "null") return { nullable: true, type: "string" };
  if (Array.isArray(t))
    return { type: "integer", minimum: x.minimum, maximum: x.maximum };
  if (t === "array")
    return {
      type: "array",
      items: wire(x.items),
      minItems: x.minItems,
      maxItems: x.maxItems,
      uniqueItems: x.uniqueItems,
    };
  if (t === "object")
    return {
      type: "object",
      additionalProperties: x.additionalProperties ?? false,
      required: x.required,
      properties: Object.fromEntries(
        Object.entries(x.properties ?? {}).map(([k, v]) => [k, wire(v)]),
      ),
    };
  return {
    type: t ?? "string",
    maxLength: x.maxLength,
    minLength: x.minLength,
    pattern: x.pattern,
    minimum: x.minimum,
    maximum: x.maximum,
  };
}
function strict(properties: any, required = Object.keys(properties)) {
  return { type: "object", additionalProperties: false, required, properties };
}
function envelope(data: any) {
  return strict({ data, request_id: { type: "string" } });
}
export function phase2OpenApi(doc: any) {
  doc.components ??= {};
  doc.components.schemas ??= {};
  for (const [name, s] of Object.entries(TRAINING_PHASE2_WIRE_SCHEMAS))
    doc.components.schemas[name] = wire((s.validator as any).$jsonSchema);
  const certificateSchema = doc.components.schemas.training_certificates;
  for (const field of ["token_hash", "evidence_json", "evidence_hash"]) {
    delete certificateSchema.properties[field];
    certificateSchema.required = certificateSchema.required.filter(
      (x: string) => x !== field,
    );
  }
  const ref = (name: string) => ({ $ref: "#/components/schemas/" + name });
  const base = "/api/v1/training";
  const path = (name: string, method: string, body: any, data: any) => {
    const p = doc.paths[base + name]?.[method];
    if (!p) return;
    if (body)
      p.requestBody = {
        required: true,
        content: { "application/json": { schema: body } },
      };
    p.responses["200"] = {
      description: "成功；回执不绕过当前授权",
      content: { "application/json": { schema: envelope(data) } },
    };
  };
  const schedule = ref("training_sessions"),
    attendance = ref("training_attendance"),
    leave = ref("training_leave_requests"),
    learningPath = ref("training_paths");
  path(
    "/phase2/{kind}",
    "get",
    null,
    strict({
      items: {
        type: "array",
        maxItems: 200,
        items: {
          oneOf: Object.keys(TRAINING_PHASE2_WIRE_SCHEMAS)
            .filter(
              (x) =>
                !x.endsWith("_versions") &&
                !x.endsWith("_locks") &&
                !x.endsWith("_outbox"),
            )
            .map(ref),
        },
      },
      truncated: { type: "boolean" },
    }),
  );
  path(
    "/phase2/locations",
    "post",
    strict({ title: { type: "string", minLength: 1, maxLength: 200 } }),
    ref("training_locations"),
  );
  path(
    "/phase2/schedule",
    "post",
    strict(
      {
        class_id: id,
        subject_id: id,
        title: { type: "string", minLength: 1, maxLength: 200 },
        course_id: id,
        teacher_member_id: id,
        location_id: id,
        start_at: { type: "string", format: "date-time" },
        end_at: { type: "string", format: "date-time" },
        original_session_id: { ...id, nullable: true },
      },
      [
        "class_id",
        "subject_id",
        "title",
        "course_id",
        "teacher_member_id",
        "location_id",
        "start_at",
        "end_at",
      ],
    ),
    schedule,
  );
  path(
    "/phase2/schedule/{id}/actions",
    "post",
    strict(
      {
        action: { enum: ["publish", "reschedule", "cancel", "end"] },
        expected_revision: revision,
        start_at: { type: "string", format: "date-time" },
        end_at: { type: "string", format: "date-time" },
        note: text,
      },
      ["action", "expected_revision"],
    ),
    schedule,
  );
  path(
    "/phase2/schedule/{id}/attendance",
    "post",
    strict(
      {
        action: {
          enum: ["save", "request-review", "confirm", "reject", "correct"],
        },
        expected_revision: revision,
        entries: {
          type: "array",
          maxItems: 200,
          items: strict({
            member_id: id,
            status: { enum: ["present", "late", "absent", "excused"] },
          }),
        },
        note: text,
      },
      ["action", "expected_revision"],
    ),
    attendance,
  );
  path(
    "/phase2/leave",
    "post",
    strict({
      session_id: id,
      reason: { type: "string", minLength: 1, maxLength: 500 },
    }),
    leave,
  );
  path(
    "/phase2/leave/{id}/actions",
    "post",
    strict(
      {
        action: { enum: ["approve", "reject", "cancel"] },
        expected_revision: revision,
        note: text,
      },
      ["action", "expected_revision"],
    ),
    leave,
  );
  path(
    "/phase2/paths",
    "post",
    strict(
      {
        class_id: id,
        subject_id: id,
        title: { type: "string", minLength: 1, maxLength: 200 },
        course_ids: { ...ids, minItems: 1 },
        task_ids: ids,
        attendance_bp: { type: "integer", minimum: 8000, maximum: 10000 },
        grade_min: { type: "integer", minimum: 0, maximum: 100 },
      },
      ["class_id", "subject_id", "title", "course_ids"],
    ),
    learningPath,
  );
  path(
    "/phase2/paths/{id}/actions",
    "post",
    strict(
      {
        action: { enum: ["edit", "request-review", "publish", "reject", "retire"] },
        expected_revision: revision,
        note: text,title:{type:"string",minLength:1,maxLength:200},course_ids:{...ids,minItems:1},task_ids:ids,attendance_bp:{type:"integer",minimum:8000,maximum:10000},grade_min:{type:"integer",minimum:0,maximum:100},
      },
      ["action", "expected_revision"],
    ),
    learningPath,
  );
  path(
    "/phase2/completions/{id}",
    "get",
    null,
    strict({
      eligible: { type: "boolean" },
      evidence: { type: "object", additionalProperties: true },
      evidence_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    }),
  );
  path(
    "/phase2/certificates",
    "post",
    strict({ assignment_id: id, note: text }),
    {
      ...certificateSchema,
      required: [...certificateSchema.required, "verification_token"],
      properties: {
        ...certificateSchema.properties,
        verification_token: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
    },
  );
  path(
    "/phase2/certificates/{id}/revoke",
    "post",
    strict({ expected_revision: revision, note: text }),
    strict({ id, status: { enum: ["revoked"] }, revision }),
  );
  path(
    "/phase2/notifications/{id}/read",
    "post",
    strict({ expected_revision: revision }),
    ref("training_notifications"),
  );
  path(
    "/phase2/receipts/query",
    "post",
    strict({ key: { type: "string", minLength: 8, maxLength: 128 } }),
    strict(
      {
        status: { enum: ["confirmed", "not_found"] },
        result: { type: "object", additionalProperties: true },
      },
      ["status"],
    ),
  );
  path(
    "/phase2-catalog",
    "get",
    null,
    strict({
      tasks: {
        type: "array",
        maxItems: 200,
        items: strict({
          id,
          title: { type: "string" },
          class_id: id,
          subject_id: id,
          target_type: { enum: ["coursework", "quiz"] },
        }),
      },
      teachers: {
        type: "array",
        maxItems: 1000,
        items: strict({
          class_id: id,
          subject_id: id,
          member_id: id,
          name: { type: "string" },
        }),
      },
    }),
  );
  path(
    "/phase2-overview",
    "get",
    null,
    strict({
      items: {
        type: "array",
        items: { type: "object", additionalProperties: true },
      },
    }),
  );
  const publicOperation =
    doc.paths["/api/v1/training-public/verification/{token}"]?.get;
  if (publicOperation) {
    publicOperation.security = [];
    publicOperation.responses["200"] = {
      description: "仅返回当前验证状态及公开最小字段",
      content: {
        "application/json": {
          schema: envelope(
            strict(
              {
                status: {
                  enum: ["valid", "revoked", "pending_review", "not_found"],
                },
                organization: { type: "string" },
                course: { type: "string" },
                issued_at: { type: "string", format: "date-time" },
              },
              ["status"],
            ),
          ),
        },
      },
    };
  }
  return doc;
}
