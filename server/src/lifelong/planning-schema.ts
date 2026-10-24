import { createHash } from "node:crypto";
import type { Document, IndexDescription } from "mongodb";

const id = { bsonType: "objectId" };
const integer = { bsonType: ["int", "long", "double"], minimum: 1, multipleOf: 1 };
const day = { bsonType: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const nullableDay = { ...day, bsonType: ["string", "null"] };
const base = {
  _id: id, user_id: id, revision: integer,
  created_at: { bsonType: "date" }, updated_at: { bsonType: "date" },
  deleted_at: { bsonType: ["date", "null"] },
};
const schema = (properties: Record<string, unknown>, indexes: IndexDescription[]) => ({
  validator: { $jsonSchema: { bsonType: "object", additionalProperties: false, required: Object.keys(properties), properties } }, indexes,
});
export const PLANNING_SCHEMAS = {
  lifelong_agenda: schema({
    ...base,
    title: { bsonType: "string", minLength: 1, maxLength: 120 },
    note: { bsonType: "string", maxLength: 4000 },
    scheduled_on: day,
    planned_minutes: { ...integer, minimum: 0, maximum: 1440 },
    kind: { enum: ["reading", "course", "review", "practice", "project"] },
    state: { enum: ["planned", "completed", "paused", "cancelled"] },
    source_kind: { enum: ["none", "goal", "course", "study"] },
    source_id: { bsonType: ["string", "null"], maxLength: 80 },
    source_version: { ...integer, bsonType: ["int", "long", "double", "null"] },
    unit_id: { bsonType: ["string", "null"], maxLength: 80 },
    completion_note: { bsonType: "string", maxLength: 4000 },
    completed_on: nullableDay,
  }, [
    { name: "agenda_owner_page", key: { user_id: 1, _id: -1 } },
    { name: "agenda_week", key: { user_id: 1, deleted_at: 1, scheduled_on: 1, _id: -1 } },
  ]),
  lifelong_week_reviews: schema({
    ...base, week_start: day,
    highlights: { bsonType: "string", maxLength: 4000 },
    challenges: { bsonType: "string", maxLength: 4000 },
    adjustment: { bsonType: "string", maxLength: 4000 },
  }, [
    { name: "week_review_owner", key: { user_id: 1, week_start: 1 }, unique: true },
    { name: "week_review_page", key: { user_id: 1, _id: -1 } },
  ]),
  lifelong_review_events: schema({
    _id: id, user_id: id, study_item_id: id,
    reviewed_on: day, next_due_on: nullableDay,
    note: { bsonType: "string", minLength: 1, maxLength: 4000 },
    ordinal: integer, created_at: { bsonType: "date" },
  }, [
    { name: "review_event_owner", key: { user_id: 1, study_item_id: 1, ordinal: 1 }, unique: true },
    { name: "review_event_page", key: { user_id: 1, _id: -1 } },
  ]),
} satisfies Record<string, { validator: Document; indexes: IndexDescription[] }>;
export const PLANNING_COLLECTIONS = Object.keys(PLANNING_SCHEMAS);
export const PLANNING_CHECKSUM = createHash("sha256").update(JSON.stringify(PLANNING_SCHEMAS)).digest("hex");
export const PLANNING_PATHS = {
  lifelong_agenda: ["_id", "user_id"],
  lifelong_week_reviews: ["_id", "user_id"],
  lifelong_review_events: ["_id", "user_id", "study_item_id"],
};
