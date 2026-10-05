import { createHash, randomUUID } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import { isDeepStrictEqual } from "node:util";
import { rawDatabase } from "../database/object-id";
import type { Schema } from "./schema";
export const PHASE2_CAPABILITIES = [
  "training:schedule-manage",
  "training:attendance-edit",
  "training:attendance-review",
  "training:path-edit",
  "training:path-review",
  "training:certificate-issue",
  "training:certificate-revoke",
  "training:operations-read",
] as const;
const id = { bsonType: "objectId" },
  date = { bsonType: "date" },
  text = { bsonType: "string", maxLength: 16000 },
  title = { bsonType: "string", minLength: 1, maxLength: 200 },
  integer = { bsonType: ["int", "long", "double"], minimum: 0, multipleOf: 1 },
  nullable = (x: any) => ({ anyOf: [x, { bsonType: "null" }] }),
  ids = { bsonType: "array", maxItems: 200, uniqueItems: true, items: id };
const base = {
  _id: id,
  org_id: id,
  revision: { ...integer, minimum: 1 },
  created_at: date,
  updated_at: date,
};
const scoped = { class_id: id, subject_id: id },
  authored = { author_id: id, contributors: ids, reviewer_id: nullable(id) };
const schemas: Record<string, Schema> = {};
function add(name: string, props: any, indexes: any[] = []) {
  schemas[name] = {
    validator: {
      $jsonSchema: {
        bsonType: "object",
        additionalProperties: false,
        required: Object.keys({ ...base, ...props }),
        properties: { ...base, ...props },
      },
    },
    indexes,
  };
}
add("training_locations", { title, status: { enum: ["active", "retired"] } }, [
  { key: { org_id: 1, title: 1 }, name: "location_name", unique: true },
]);
add(
  "training_sessions",
  {
    ...scoped,
    ...authored,
    title,
    course_id: id,
    teacher_member_id: id,
    location_id: id,
    start_at: date,
    end_at: date,
    original_session_id: nullable(id),
    recipients: ids,
    status: { enum: ["draft", "published", "ended", "cancelled"] },
    note: text,
  },
  [
    { key: { org_id: 1, class_id: 1, start_at: 1 }, name: "schedule_class" },
    {
      key: { org_id: 1, teacher_member_id: 1, start_at: 1 },
      name: "schedule_teacher",
    },
    {
      key: { org_id: 1, location_id: 1, start_at: 1 },
      name: "schedule_location",
    },
  ],
);
add("training_session_versions", {
  ...scoped,
  session_id: id,
  payload_json: text,
  author_id: id,
});
add(
  "training_schedule_locks",
  { resource_key: { bsonType: "string", maxLength: 180 } },
  [
    {
      key: { org_id: 1, resource_key: 1 },
      unique: true,
      name: "schedule_lock",
    },
  ],
);
add(
  "training_attendance",
  {
    ...scoped,
    session_id: id,
    ...authored,
    status: { enum: ["draft", "review", "confirmed"] },
    entries: {
      bsonType: "array",
      maxItems: 200,
      items: {
        bsonType: "object",
        additionalProperties: false,
        required: ["member_id", "status"],
        properties: {
          member_id: id,
          status: { enum: ["present", "late", "absent", "excused"] },
        },
      },
    },
    note: text,
  },
  [
    {
      key: { org_id: 1, session_id: 1 },
      unique: true,
      name: "attendance_session",
    },
  ],
);
add("training_attendance_versions", {
  ...scoped,
  attendance_id: id,
  session_id: id,
  payload_json: text,
  author_id: id,
});
add(
  "training_leave_requests",
  {
    ...scoped,
    session_id: id,
    user_id: id,
    member_id: id,
    status: { enum: ["requested", "approved", "rejected", "cancelled"] },
    reason: text,
    note: text,
  },
  [
    {
      key: { org_id: 1, session_id: 1, member_id: 1 },
      unique: true,
      name: "leave_member",
    },
  ],
);
add("training_paths", {
  ...scoped,
  ...authored,
  title,
  course_ids: { ...ids, maxItems: 30, minItems: 1 },
  task_ids: { ...ids, maxItems: 30 },
  attendance_bp: { ...integer, minimum: 8000, maximum: 10000 },
  grade_min: { ...integer, maximum: 100 },
  status: { enum: ["draft", "review", "published", "retired"] },
  note: text,
});
add("training_path_versions", {
  ...scoped,
  path_id: id,
  payload_json: text,
  author_id: id,
});
add(
  "training_path_assignments",
  { ...scoped, path_id: id, user_id: id, member_id: id, rules_json: text },
  [
    {
      key: { org_id: 1, path_id: 1, member_id: 1 },
      unique: true,
      name: "path_member",
    },
  ],
);
add(
  "training_certificates",
  {
    ...scoped,
    path_id: id,
    assignment_id: id,
    user_id: id,
    member_id: id,
    issuer_id: id,
    number: { bsonType: "string", maxLength: 80 },
    token_hash: { bsonType: "string", pattern: "^[a-f0-9]{64}$" },
    evidence_json: text,
    evidence_hash: { bsonType: "string", pattern: "^[a-f0-9]{64}$" },
    status: { enum: ["issued", "revoked"] },
    note: text,
  },
  [
    { key: { org_id: 1, number: 1 }, unique: true, name: "certificate_number" },
    { key: { assignment_id: 1 }, unique: true, name: "certificate_assignment" },
    { key: { token_hash: 1 }, unique: true, name: "certificate_token" },
  ],
);
add("training_certificate_events", {
  ...scoped,
  certificate_id: id,
  user_id: id,
  actor_id: id,
  action: { enum: ["issued", "revoked"] },
  note: text,
});
add("training_notification_outbox", {
  user_id: id,
  member_id: id,
  source_type: {
    enum: ["schedule", "leave", "attendance", "path", "certificate", "task"],
  },
  source_id: id,
  message: { bsonType: "string", maxLength: 300 },
  status: { enum: ["pending", "delivered"] },
  lease_token: nullable({ bsonType: "string", maxLength: 36 }),
  lease_until: nullable(date),
});
add(
  "training_notifications",
  {
    user_id: id,
    member_id: id,
    event_id: id,
    source_type: {
      enum: ["schedule", "leave", "attendance", "path", "certificate", "task"],
    },
    source_id: id,
    message: { bsonType: "string", maxLength: 300 },
    read_at: nullable(date),
  },
  [
    { key: { event_id: 1 }, unique: true, name: "notification_event" },
    {
      key: { org_id: 1, user_id: 1, created_at: -1 },
      name: "notification_member",
    },
  ],
);
export const TRAINING_PHASE2_COLLECTIONS = Object.keys(schemas);
export const TRAINING_PHASE2_CHANGED = [
  ...TRAINING_PHASE2_COLLECTIONS,
  "member_capability_grants",
  "audit_events",
];
export function trainingPhase2Schemas(
  previous: Record<string, Schema>,
): Record<string, Schema> {
  const grants = structuredClone(previous.member_capability_grants!),
    audit = structuredClone(previous.audit_events!);
  function visit(x: any) {
    if (!x || typeof x !== "object") return;
    if (x.properties?.capability?.enum)
      x.properties.capability.enum = [
        ...new Set([...x.properties.capability.enum, ...PHASE2_CAPABILITIES]),
      ];
    if (x.properties?.resource_type?.enum)
      x.properties.resource_type.enum = [
        ...new Set([...x.properties.resource_type.enum, "training_phase2"]),
      ];
    Object.values(x).forEach(visit);
  }
  visit(grants.validator);
  visit(audit.validator);
  return {
    ...previous,
    ...schemas,
    member_capability_grants: grants,
    audit_events: audit,
  };
}
export const TRAINING_PHASE2_CHECKSUM = createHash("sha256")
  .update(
    JSON.stringify({
      version: 15,
      schemas,
      capabilities: PHASE2_CAPABILITIES,
      policy: "adult-training-phase2-v1",
    }),
  )
  .digest("hex");
export async function migrateTrainingPhase2(
  db: Db,
  baseSchemas: Record<string, Schema>,
): Promise<void> {
  db = rawDatabase(db);
  const schemas = trainingPhase2Schemas(baseSchemas);
  if (await db.collection("operational_writers").findOne({ state: "running" }))
    throw Error("Training migration requires stopped writers");
  const existing = await db
    .collection("schema_migrations")
    .findOne({ version: 15 });
  if (existing && existing.checksum !== TRAINING_PHASE2_CHECKSUM)
    throw Error("Training migration checksum differs");
  if (process.env.NODE_ENV === "production")
    throw Error("Training extension is not approved for production");
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName) throw Error("Training migration requires replicaSet");
  const token = randomUUID(),
    now = new Date();
  if (!existing)
    await db.collection("schema_migrations").insertOne({
      _id: new ObjectId(),
      version: 15,
      checksum: TRAINING_PHASE2_CHECKSUM,
      status: "pending",
      lease_token: null,
      lease_until: null,
      created_at: now,
      started_at: null,
      completed_at: null,
      failed_at: null,
    });
  const held = await db.collection("schema_migrations").findOneAndUpdate(
    {
      version: 15,
      checksum: TRAINING_PHASE2_CHECKSUM,
      status: { $ne: "completed" },
      $or: [{ lease_until: null }, { lease_until: { $lte: now } }],
    },
    {
      $set: {
        status: "running",
        lease_token: token,
        lease_until: new Date(now.getTime() + 120000),
        started_at: now,
        failed_at: null,
      },
    },
    { returnDocument: "after" },
  );
  if (!held) {
    if (existing?.status === "completed") return;
    throw Error("Training migration lease busy");
  }
  const renew = async () => {
    const r = await db.collection("schema_migrations").updateOne(
      {
        version: 15,
        lease_token: token,
        status: "running",
        lease_until: { $gt: new Date() },
      },
      { $set: { lease_until: new Date(Date.now() + 120000) } },
    );
    if (r.matchedCount !== 1) throw Error("Training migration lease lost");
  };
  try {
    for (const [name, schema] of Object.entries(schemas)) {
      if (!TRAINING_PHASE2_CHANGED.includes(name)) continue;
      await renew();
      const info = await db.listCollections({ name }).next();
      if (!info)
        await db.createCollection(name, {
          validator: schema.validator,
          validationAction: "error",
          validationLevel: "strict",
          maxTimeMS: 15000,
        });
      else if (
        !isDeepStrictEqual((info as any).options?.validator, schema.validator)
      ) {
        if (
          !TRAINING_PHASE2_CHANGED.includes(name) ||
          !isDeepStrictEqual(
            (info as any).options?.validator,
            baseSchemas[name]!.validator,
          )
        )
          throw Error("Training schema drift:" + name);
        await db.command({
          collMod: name,
          validator: schema.validator,
          validationAction: "error",
          validationLevel: "strict",
          maxTimeMS: 15000,
        });
      }
      if (schema.indexes.length)
        await db
          .collection(name)
          .createIndexes(schema.indexes, { maxTimeMS: 15000 });
      if (
        await db
          .collection(name)
          .findOne({ $nor: [schema.validator] }, { maxTimeMS: 15000 })
      )
        throw Error("Training data invalid:" + name);
    }
    await renew();
    const r = await db.collection("schema_migrations").updateOne(
      {
        version: 15,
        checksum: TRAINING_PHASE2_CHECKSUM,
        lease_token: token,
        status: "running",
      },
      {
        $set: {
          status: "completed",
          completed_at: new Date(),
          lease_token: null,
          lease_until: null,
        },
      },
    );
    if (r.modifiedCount !== 1) throw Error("Training migration lease lost");
  } catch (error) {
    await db.collection("schema_migrations").updateOne(
      { version: 15, lease_token: token, status: "running" },
      {
        $set: {
          status: "failed",
          failed_at: new Date(),
          lease_token: null,
          lease_until: null,
        },
      },
    );
    throw error;
  }
}

export const TRAINING_PHASE2_WIRE_SCHEMAS = schemas;
