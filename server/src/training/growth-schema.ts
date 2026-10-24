import { createHash } from "node:crypto";
import type { Document } from "mongodb";
import type { Schema } from "./schema";
export const growthEnabled = () =>
  process.env.KL_LEARNING_GROWTH_ENABLED === "true";
const id = { bsonType: "objectId" },
  date = { bsonType: "date" },
  nullable = (s: Document) => ({ anyOf: [s, { bsonType: "null" }] }),
  integer = { bsonType: ["int", "long", "double"], minimum: 1, multipleOf: 1 },
  base = {
    _id: id,
    org_id: id,
    revision: integer,
    created_at: date,
    updated_at: date,
  },
  owner = { user_id: id, member_id: id };
function strict(
  properties: Document,
  keys: Record<string, 1 | -1>[] = [],
): Schema {
  return {
    validator: {
      $jsonSchema: {
        bsonType: "object",
        additionalProperties: false,
        required: Object.keys(properties),
        properties,
      },
    },
    indexes: [
      { key: { org_id: 1, _id: -1 }, name: "growth_page" },
      ...keys.map((key, i) => ({
        key,
        unique: true,
        name: `growth_unique_${i}`,
      })),
    ],
  };
}
export const GROWTH_SCHEMAS: Record<string, Schema> = {
  learning_work_questions: strict(
    { ...base, ...owner, question_id: id, task_id: id, submission_id: id },
    [{ org_id: 1, question_id: 1 }],
  ),
  learning_portfolio_shares: strict({
    ...base,
    ...owner,
    recipient_member_id: id,
    recipient_user_id: id,
    label: { bsonType: "string", minLength: 1, maxLength: 120 },
    submission_ids: {
      bsonType: "array",
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      items: id,
    },
    expires_at: date,
    revoked_at: nullable(date),
    access_fence: { ...integer, minimum: 0 },
  }),
  learning_growth_notifications: strict(
    {
      ...base,
      ...owner,
      event_kind: { enum: ["question", "feedback", "meetup"] },
      source_id: id,
      source_revision: integer,
      read_at: nullable(date),
    },
    [
      {
        org_id: 1,
        member_id: 1,
        event_kind: 1,
        source_id: 1,
        source_revision: 1,
      },
    ],
  ),
  learning_growth_preferences: strict(
    {
      ...base,
      ...owner,
      question: { bsonType: "bool" },
      feedback: { bsonType: "bool" },
      meetup: { bsonType: "bool" },
    },
    [{ org_id: 1, member_id: 1 }],
  ),
};
export const GROWTH_COLLECTIONS = Object.keys(GROWTH_SCHEMAS);
export const GROWTH_CHECKSUM = createHash("sha256")
  .update(JSON.stringify(GROWTH_SCHEMAS))
  .digest("hex");
export const GROWTH_PATHS = {
  learning_work_questions: [
    "_id",
    "org_id",
    "user_id",
    "member_id",
    "question_id",
    "task_id",
    "submission_id",
  ],
  learning_portfolio_shares: [
    "_id",
    "org_id",
    "user_id",
    "member_id",
    "recipient_member_id",
    "recipient_user_id",
    "submission_ids",
  ],
  learning_growth_notifications: [
    "_id",
    "org_id",
    "user_id",
    "member_id",
    "source_id",
  ],
  learning_growth_preferences: ["_id", "org_id", "user_id", "member_id"],
};
