import { createHash } from "node:crypto";
import type { Document } from "mongodb";
import type { Schema } from "./schema";
export const studioEnabled = () => process.env.KL_LEARNING_STUDIO_ENABLED === "true";
const id = { bsonType: "objectId" }, date = { bsonType: "date" },
  str = (maxLength: number) => ({ bsonType: "string", maxLength }),
  num = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ bsonType: ["int", "long", "double"], multipleOf: 1, minimum, maximum }),
  nullable = (value: Document) => ({ anyOf: [value, { bsonType: "null" }] }),
  base = { _id: id, org_id: id, revision: num(1), created_at: date, updated_at: date };
function strict(properties: Document, unique: Record<string, 1 | -1>[] = []): Schema {
  return { validator: { $jsonSchema: { bsonType: "object", additionalProperties: false, required: Object.keys(properties), properties } },
    indexes: unique.map((key, i) => ({ key, unique: true, name: `studio_unique_${i}` })) };
}
export const STUDIO_METADATA = {
  objectives: str(2000), audience: str(1000), difficulty: { enum: ["introductory", "intermediate", "advanced"] },
  prerequisites: str(2000), estimated_minutes: num(1, 100000), instructor: str(200), language: str(80),
};
export const STUDIO_SCHEMAS: Record<string, Schema> = {
  learning_studio_events: strict({ ...base, user_id: id, member_id: id,
    resource_kind: { enum: ["note", "question", "meetup"] }, resource_id: id, action: str(40), revision_after: num(1), subject_member_id: nullable(id) }),
  learning_source_fences: strict({ ...base, course_id: id }, [{ org_id: 1, course_id: 1 }]),
  learning_course_metadata: strict({ ...base, course_id: id, ...STUDIO_METADATA }, [{ org_id: 1, course_id: 1 }]),
  learning_source_notes: strict({ ...base, user_id: id, member_id: id, title: str(120), body: str(4000),
    source_kind: { enum: ["course", "chapter", "mistake"] }, source_id: id, lesson_key: str(64), source_revision: num(1),
    due_on: nullable({ bsonType: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), review_count: num(),
    review_history: { bsonType: "array", maxItems: 100, items: { bsonType: "object", additionalProperties: false,
      required: ["at", "note"], properties: { at: date, note: str(1000) } } }, deleted_at: nullable(date),
  }),
  learning_questions: strict({ ...base, user_id: id, member_id: id, class_id: id, subject_id: id,
    course_id: nullable(id), title: str(200), body: str(4000), status: { enum: ["open", "answered", "closed"] },
    message_count: num(0, 100), answered_by: nullable(id),
  }),
  learning_question_messages: strict({ ...base, question_id: id, user_id: id, member_id: id,
    role: { enum: ["learner", "teacher"] }, body: str(4000) }),
  learning_meetups: strict({ ...base, class_id: id, subject_id: id, created_by: id,
    title: str(200), body: str(4000), location: str(200), starts_at: date, ends_at: date, enrollment_closes_at: date,
    capacity: num(1, 200), status: { enum: ["draft", "published", "cancelled", "completed"] },
  }),
  learning_meetup_members: strict({ ...base, meetup_id: id, user_id: id, member_id: id,
    status: { enum: ["enrolled", "cancelled", "attended", "absent"] }, reflection: str(2000),
    recorded_by: nullable(id), recorded_at: nullable(date),
  }, [{ org_id: 1, meetup_id: 1, member_id: 1 }]),
};
for (const schema of Object.values(STUDIO_SCHEMAS)) schema.indexes.push({ key: { org_id: 1, _id: -1 }, name: "studio_page" });
STUDIO_SCHEMAS.learning_question_messages!.indexes.push({ key: { org_id: 1, question_id: 1, _id: 1 }, name: "studio_thread" });
STUDIO_SCHEMAS.learning_meetup_members!.indexes.push({ key: { org_id: 1, meetup_id: 1, status: 1 }, name: "studio_enrollment" });
export const STUDIO_COLLECTIONS = Object.keys(STUDIO_SCHEMAS);
export const STUDIO_CHECKSUM = createHash("sha256").update(JSON.stringify(STUDIO_SCHEMAS)).digest("hex");
export const STUDIO_PATHS: Record<string, readonly string[]> = {
  learning_studio_events: ["_id", "org_id", "user_id", "member_id", "resource_id", "subject_member_id"],
  learning_source_fences: ["_id", "org_id", "course_id"],
  learning_course_metadata: ["_id", "org_id", "course_id"],
  learning_source_notes: ["_id", "org_id", "user_id", "member_id", "source_id"],
  learning_questions: ["_id", "org_id", "user_id", "member_id", "class_id", "subject_id", "course_id", "answered_by"],
  learning_question_messages: ["_id", "org_id", "question_id", "user_id", "member_id"],
  learning_meetups: ["_id", "org_id", "class_id", "subject_id", "created_by"],
  learning_meetup_members: ["_id", "org_id", "meetup_id", "user_id", "member_id", "recorded_by"],
};
