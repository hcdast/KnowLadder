import { createHash } from "node:crypto";
import type { Document, IndexDescription } from "mongodb";

export const STAGES = [
  "early",
  "school",
  "higher",
  "career",
  "life",
  "senior",
] as const;
export const FIELDS = [
  "language",
  "science",
  "humanities",
  "arts",
  "health",
  "digital",
  "career",
  "life",
] as const;
export const ACTIVITY_KINDS = [
  "reading",
  "course",
  "practice",
  "project",
  "creation",
  "offline",
  "reflection",
] as const;
export const SUPPORT_SCOPES = ["goals", "activities", "feedback"] as const;
export const lifelongEnabled = () => process.env.KL_LIFELONG_ENABLED === "true";
const id = { bsonType: "objectId" },
  nullableId = { bsonType: ["objectId", "null"] };
const date = { bsonType: "date" },
  nullableDate = { bsonType: ["date", "null"] };
const integer = {
  bsonType: ["int", "long", "double"],
  minimum: 1,
  multipleOf: 1,
};
const digest = { bsonType: "string", pattern: "^[0-9a-f]{64}$" };
const short = { bsonType: "string", minLength: 1, maxLength: 120 };
const note = { bsonType: "string", maxLength: 4000 };
const ids = { bsonType: "array", maxItems: 20, uniqueItems: true, items: id };
function strict(properties: Document, indexes: IndexDescription[]) {
  return {
    validator: {
      $jsonSchema: {
        bsonType: "object",
        additionalProperties: false,
        required: Object.keys(properties),
        properties,
      },
    },
    indexes,
  };
}
const owned = {
  _id: id,
  user_id: id,
  revision: integer,
  deleted_at: nullableDate,
  created_at: date,
  updated_at: date,
};
const ownerIndex: IndexDescription = {
  name: "lifelong_owner_page",
  key: { user_id: 1, _id: -1 },
};
export const LIFELONG_SCHEMAS = {
  lifelong_goals: strict(
    {
      ...owned,
      title: short,
      stage: { enum: [...STAGES, null] },
      field: { enum: FIELDS },
      outcome: note,
      due_on: {
        bsonType: ["string", "null"],
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      },
      state: { enum: ["active", "completed", "paused"] },
      template_id: { bsonType: ["string", "null"] },
    },
    [ownerIndex],
  ),
  lifelong_activities: strict(
    {
      ...owned,
      goal_id: nullableId,
      kind: { enum: ACTIVITY_KINDS },
      title: short,
      note,
      reflection: note,
      occurred_on: { bsonType: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      minutes: {
        bsonType: ["int", "long", "double"],
        minimum: 0,
        maximum: 1440,
        multipleOf: 1,
      },
      evidence: { enum: ["self_reported"] },
    },
    [
      ownerIndex,
      {
        name: "lifelong_goal_activities",
        key: { user_id: 1, goal_id: 1, _id: -1 },
      },
    ],
  ),
  lifelong_supports: strict(
    {
      _id: id,
      user_id: id,
      supporter_user_id: nullableId,
      label: short,
      scopes: {
        bsonType: "array",
        minItems: 1,
        maxItems: 3,
        uniqueItems: true,
        items: { enum: SUPPORT_SCOPES },
      },
      goal_ids: ids,
      activity_ids: ids,
      token_hash: digest,
      invite_expires_at: date,
      expires_at: date,
      state: { enum: ["pending", "active", "revoked"] },
      basis: { enum: ["adult_self_consent", "verified_guardian"] },
      assurance_id: nullableId,
      accepted_at: nullableDate,
      revoked_at: nullableDate,
      revision: integer,
      access_fence: integer,
      created_at: date,
      updated_at: date,
    },
    [
      ownerIndex,
      {
        name: "lifelong_supporter_page",
        key: { supporter_user_id: 1, _id: -1 },
      },
      { name: "lifelong_support_token", key: { token_hash: 1 }, unique: true },
    ],
  ),
  lifelong_assurances: strict(
    {
      _id: id,
      user_id: id,
      guardian_user_id: id,
      org_id: id,
      proposer_user_id: id,
      reviewer_user_id: nullableId,
      evidence_reference: short,
      policy_version: short,
      transition_at: date,
      expires_at: date,
      state: { enum: ["pending", "approved", "rejected", "revoked"] },
      revision: integer,
      created_at: date,
      updated_at: date,
    },
    [
      ownerIndex,
      {
        name: "lifelong_guardian_assurance",
        key: { guardian_user_id: 1, _id: -1 },
      },
      {
        name: "lifelong_assurance_review",
        key: { org_id: 1, state: 1, _id: -1 },
      },
    ],
  ),
  lifelong_feedback: strict(
    { ...owned, actor_user_id: id, relation_id: id, activity_id: id, note },
    [
      ownerIndex,
      { name: "lifelong_feedback_relation", key: { relation_id: 1, _id: -1 } },
      { name: "lifelong_feedback_actor", key: { actor_user_id: 1, _id: -1 } },
    ],
  ),
  lifelong_receipts: strict(
    {
      _id: id,
      user_id: id,
      key_hash: digest,
      request_hash: digest,
      operation: { bsonType: "string", maxLength: 100 },
      resource_id: id,
      revision: integer,
      created_at: date,
    },
    [
      {
        name: "lifelong_request_key",
        key: { user_id: 1, key_hash: 1 },
        unique: true,
      },
      ownerIndex,
    ],
  ),
};
export const LIFELONG_COLLECTIONS = Object.keys(LIFELONG_SCHEMAS);
export const LIFELONG_CHECKSUM = createHash("sha256")
  .update(JSON.stringify(LIFELONG_SCHEMAS))
  .digest("hex");
export const LIFELONG_PATHS = {
  lifelong_goals: ["_id", "user_id"],
  lifelong_activities: ["_id", "user_id", "goal_id"],
  lifelong_supports: [
    "_id",
    "user_id",
    "supporter_user_id",
    "assurance_id",
    "goal_ids[]",
    "activity_ids[]",
  ],
  lifelong_assurances: [
    "_id",
    "user_id",
    "guardian_user_id",
    "org_id",
    "proposer_user_id",
    "reviewer_user_id",
  ],
  lifelong_feedback: [
    "_id",
    "user_id",
    "actor_user_id",
    "relation_id",
    "activity_id",
  ],
  lifelong_receipts: ["_id", "user_id", "resource_id"],
};
