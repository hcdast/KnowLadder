import { createHash } from "node:crypto";
import type { Document, IndexDescription } from "mongodb";

const id = { bsonType: "objectId" };
const day = { bsonType: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const integer = {
  bsonType: ["int", "long", "double"],
  minimum: 1,
  multipleOf: 1,
};
const properties = {
  _id: id,
  user_id: id,
  title: { bsonType: "string", minLength: 1, maxLength: 120 },
  note: { bsonType: "string", maxLength: 4000 },
  bookmarked: { bsonType: "bool" },
  course_id: { bsonType: ["string", "null"], maxLength: 80 },
  course_version: { ...integer, bsonType: ["int", "long", "double", "null"] },
  unit_id: { bsonType: ["string", "null"], maxLength: 80 },
  due_on: day,
  reviewed_on: day,
  review_count: { ...integer, minimum: 0 },
  review_note: { bsonType: "string", maxLength: 4000 },
  revision: integer,
  deleted_at: { bsonType: ["date", "null"] },
  created_at: { bsonType: "date" },
  updated_at: { bsonType: "date" },
};
export const STUDY_SCHEMAS = {
  lifelong_study_items: {
    validator: {
      $jsonSchema: {
        bsonType: "object",
        additionalProperties: false,
        required: Object.keys(properties),
        properties,
      },
    },
    indexes: [
      { name: "study_owner_page", key: { user_id: 1, _id: -1 } },
      {
        name: "study_due",
        key: { user_id: 1, deleted_at: 1, due_on: 1, _id: -1 },
      },
    ] as IndexDescription[],
  },
} satisfies Record<
  string,
  { validator: Document; indexes: IndexDescription[] }
>;
export const STUDY_COLLECTIONS = Object.keys(STUDY_SCHEMAS);
export const STUDY_CHECKSUM = createHash("sha256")
  .update(JSON.stringify(STUDY_SCHEMAS))
  .digest("hex");
export const STUDY_PATHS = { lifelong_study_items: ["_id", "user_id"] };
