import type { OpenAPIObject, SchemaObject } from "@nestjs/swagger/dist/interfaces/open-api-spec.interface";
const text = (maxLength = 200): SchemaObject => ({ type: "string", maxLength }),
  id: SchemaObject = { type: "string", pattern: "^[a-f0-9]{24}$" }, rev: SchemaObject = { type: "integer", minimum: 1 },
  date: SchemaObject = { type: "string", format: "date-time" }, nullable = (s: SchemaObject): SchemaObject => ({ ...s, nullable: true }),
  en = (...values: string[]): SchemaObject => ({ type: "string", enum: values }),
  object = (properties: Record<string, SchemaObject>, required = Object.keys(properties)): SchemaObject => ({ type: "object", additionalProperties: false, required, properties }),
  array = (items: SchemaObject, maxItems: number): SchemaObject => ({ type: "array", maxItems, items });
const base = { _id: id, org_id: id, revision: rev, created_at: date, updated_at: date },
  owned = { user_id: id, member_id: id }, scope = { class_id: id, subject_id: id },
  noteInput = { title: text(120), body: text(4000), source_kind: en("course", "chapter", "mistake"), source_id: id, lesson_key: text(64), due_on: nullable({ type: "string", format: "date" }) },
  note = object({ ...base, ...owned, ...noteInput, source_revision: rev, review_count: { type: "integer", minimum: 0 },
    review_history: array(object({ at: date, note: text(1000) }), 100), deleted_at: nullable(date) }),
  questionInput = { ...scope, course_id: nullable(id), title: text(), body: text(4000) },
  question = object({ ...base, ...owned, ...questionInput, status: en("open", "answered", "closed"), message_count: { type: "integer", minimum: 0, maximum: 100 }, answered_by: nullable(id) }),
  message = object({ ...base, ...owned, question_id: id, role: en("learner", "teacher"), body: text(4000) }),
  meetupInput = { ...scope, title: text(), body: text(4000), location: text(), starts_at: date, ends_at: date, enrollment_closes_at: date, capacity: { type: "integer", minimum: 1, maximum: 200 } as SchemaObject },
  meetup = object({ ...base, ...meetupInput, created_by: id, status: en("draft", "published", "cancelled", "completed") }),
  enrollment = object({ ...base, ...owned, meetup_id: id, status: en("enrolled", "cancelled", "attended", "absent"), reflection: text(2000), recorded_by: nullable(id), recorded_at: nullable(date) }),
  source = object({ kind: en("course", "chapter", "mistake"), id, title: text(), revision: rev, lesson_key: text(64), edition_id: id }, ["kind", "id", "title", "revision"]),
  noteView = object({ ...note.properties, source, source_changed: { type: "boolean" } }),
  meetupView = object({ ...meetup.properties, enrolled_count: { type: "integer", minimum: 0, maximum: 200 }, enrollment: nullable(enrollment),
    members: array(object({ ...enrollment.properties, name: text() }), 200) }, [...meetup.required!, "enrolled_count", "enrollment"]);
export function studioOpenApi(document: OpenAPIObject) {
  const requests: Record<string, SchemaObject> = {
    notes: object(noteInput, ["title", "body", "source_kind", "source_id", "due_on"]),
    "notes/{id}/actions": object({ action: en("edit", "review", "refresh-source", "delete"), expected_revision: rev, title: text(120), body: text(4000), due_on: noteInput.due_on!, note: text(1000) }, ["action", "expected_revision"]),
    questions: object({...questionInput,submission_id:nullable(id)}, ["class_id", "subject_id", "title", "body"]),
    "questions/{id}/actions": object({ action: en("reply", "close", "reopen"), expected_revision: rev, body: text(4000) }, ["action", "expected_revision"]),
    meetups: object(meetupInput),
    "meetups/{id}/actions": object({ action: en("publish", "cancel", "complete", "enroll", "withdraw", "attended", "absent", "reflect"), expected_revision: rev,
      enrollment_id: id, enrollment_revision: rev, reflection: text(2000) }, ["action", "expected_revision"]),
    "receipts/query": object({ key: { ...text(128), pattern: "^[A-Za-z0-9_-]{8,128}$" } }),
  };
  for (const [path, item] of Object.entries(document.paths)) {
    if (!path.startsWith("/api/v1/training/studio/")) continue;
    const key = path.slice("/api/v1/training/studio/".length);
    for (const method of ["get", "post"] as const) {
      const op = item?.[method]; if (!op) continue;
      op.parameters = [{ name: "X-Org-Id", in: "header", required: true, schema: id },
        ...(path.includes("{id}") ? [{ name: "id", in: "path" as const, required: true, schema: id }] : []),
        ...(key === "{kind}" ? [{ name: "kind", in: "path" as const, required: true, schema: en("notes", "questions", "meetups") }] : [])];
      if (method === "post") {
        op.parameters.push({ name: "X-CSRF-Token", in: "header", required: true, schema: text(200) });
        if (key !== "receipts/query") op.parameters.push({ name: "Idempotency-Key", in: "header", required: true, schema: { ...text(128), pattern: "^[A-Za-z0-9_-]{8,128}$" } });
        op.requestBody = { required: true, content: { "application/json": { schema: requests[key]! } } };
      }
      if (method === "get" && ["{kind}", "meetups/{id}"].includes(key)) {
        const query: Record<string, SchemaObject> = key === "{kind}" ? { mode: en("learner", "staff"), limit: { type: "integer", minimum: 1, maximum: 50 }, cursor: text(2000), q: text(100) } : { mode: en("learner", "staff") };
        op.parameters.push(...Object.entries(query).map(([name, schema]) => ({ name, in: "query" as const, required: false, schema })));
      }
      let result: SchemaObject;
      if (key === "catalog") result = object({ learner: { type: "boolean" }, teacher: { type: "boolean" }, truncated: { type: "boolean" },
        pairs: array(object({ ...scope, class_name: text(), subject_name: text() }), 200) });
      else if (key === "receipts/query") result = object({ status: en("confirmed", "not_found"), resource_id: id }, ["status"]);
      else if (key === "{kind}") result = object({ items: array({ oneOf: [noteView, meetupView, object({ _id: id, title: text(), status: en("open", "answered", "closed"), revision: rev, updated_at: date })] }, 50), next_cursor: nullable(text(2000)) });
      else if (key === "questions/{id}") result = object({ ...question.properties, work_context: object({task_id:id,submission_id:id}), messages: array(message, 100) }, [...question.required!,"messages"]);
      else if (key === "meetups/{id}") result = meetupView;
      else result = key.startsWith("notes") ? note : key.startsWith("questions") ? question : meetup;
      op.responses["200"] = { description: "当前组织、本人/授课范围重新核验后的结果", content: { "application/json": { schema: object({ data: result, request_id: text() }) } } };
      for (const code of [401,403,404,409,422,429,503]) op.responses[code] = { description: "会话、授权、状态/修订/名额、输入或扩展准入失败" };
    }
  }
}
