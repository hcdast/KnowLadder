import { createHash, randomUUID } from "node:crypto";
import {
  ObjectId,
  type Document,
  type IndexDescription,
  type Db,
} from "mongodb";
import { isDeepStrictEqual } from "node:util";
import { rawDatabase, newId } from "../database/object-id";
import { TRAINING_CAPABILITIES } from "./capabilities";
export type Schema = { validator: Document; indexes: IndexDescription[] };
const id = { bsonType: "objectId" },
  date = { bsonType: "date" },
  text = { bsonType: "string", maxLength: 65536 },
  small = { bsonType: "string", maxLength: 200 },
  num = { bsonType: ["int", "long", "double"], minimum: 0, multipleOf: 1 },
  nullable = (v: Document) => ({ anyOf: [v, { bsonType: "null" }] });
const base = {
  _id: id,
  org_id: id,
  revision: { ...num, minimum: 1 },
  created_at: date,
  updated_at: date,
};
const strict = (
  props: Document,
  keys: Record<string, 1 | -1>[] = [],
  required = Object.keys(props),
): Schema => ({
  validator: {
    $jsonSchema: {
      bsonType: "object",
      additionalProperties: false,
      required,
      properties: props,
    },
  },
  indexes: keys.map((key, i) => ({
    key,
    unique: true,
    name: "training_unique_" + i,
  })),
});
const lesson = {
  bsonType: "object",
  additionalProperties: false,
  required: [
    "key",
    "title",
    "kind",
    "required",
    "body",
    "file_id",
    "owner_version_id",
  ],
  properties: {
    key: { bsonType: "string", pattern: "^[a-z0-9_-]{1,64}$" },
    title: small,
    kind: { enum: ["text", "pdf", "video", "audio"] },
    required: { bsonType: "bool" },
    body: text,
    file_id: nullable(id),
    owner_version_id: nullable(id),
  },
};
export const TRAINING_SCHEMAS: Record<string, Schema> = {
  courses: strict(
    {
      ...base,
      code: small,
      title: small,
      subject_id: id,
      version_no: { ...num, minimum: 1 },
      status: { enum: ["draft", "review", "published", "retired"] },
      author_id: id,
      contributors: { bsonType: "array", items: id, uniqueItems: true },
      reviewer_id: nullable(id),
      review_note: text,
      lessons: { bsonType: "array", maxItems: 100, items: lesson },
    },
    [{ org_id: 1, code: 1, version_no: 1 }],
  ),
  class_courses: strict(
    {
      ...base,
      class_id: id,
      course_id: id,
      subject_id: id,
      status: { enum: ["active", "ended"] },
    },
    [{ org_id: 1, class_id: 1, course_id: 1 }],
  ),
  course_progress: strict(
    {
      ...base,
      user_id: id,
      member_id: id,
      course_id: id,
      lesson_key: small,
      position: num,
      completed_at: nullable(date),
    },
    [{ org_id: 1, member_id: 1, course_id: 1, lesson_key: 1 }],
  ),
  training_tasks: strict({
    ...base,
    class_id: id,
    subject_id: id,
    created_by: id,
    title: small,
    target_type: { enum: ["course", "coursework", "quiz"] },
    target_id: nullable(id),
    due_at: date,
    status: { enum: ["draft", "published", "cancelled"] },
    body: text,
    rubric: {
      bsonType: "array",
      maxItems: 20,
      items: {
        bsonType: "object",
        additionalProperties: false,
        required: ["key", "title", "weight"],
        properties: {
          key: small,
          title: small,
          weight: { ...num, maximum: 100 },
        },
      },
    },
    recipients: {
      bsonType: "array",
      maxItems: 200,
      items: id,
      uniqueItems: true,
    },
    published_at: nullable(date),
  }),
  coursework_heads: strict(
    {
      ...base,
      user_id: id,
      member_id: id,
      task_id: id,
      draft: text,
      current_submission_id: nullable(id),
      current_feedback_id: nullable(id),
      submission_no: num,
    },
    [{ org_id: 1, task_id: 1, member_id: 1 }],
  ),
  coursework_submissions: strict(
    {
      ...base,
      user_id: id,
      member_id: id,
      task_id: id,
      head_id: id,
      submission_no: { ...num, minimum: 1 },
      body: text,
      submitted_at: date,
    },
    [{ org_id: 1, head_id: 1, submission_no: 1 }],
  ),
  coursework_feedback: strict({
    ...base,
    task_id: id,
    submission_id: id,
    author_id: id,
    status: { enum: ["draft", "published"] },
    comments: text,
    scores: {
      bsonType: "array",
      maxItems: 20,
      items: {
        bsonType: "object",
        additionalProperties: false,
        required: ["key", "score"],
        properties: { key: small, score: { ...num, maximum: 100 } },
      },
    },
    score: { ...num, maximum: 100 },
    published_at: nullable(date),
  }),
  training_idempotency: strict(
    {
      ...base,
      user_id: id,
      operation: small,
      resource_id: small,
      key: small,
      request_hash: { bsonType: "string", pattern: "^[a-f0-9]{64}$" },
      result_json: text,
    },
    [{ org_id: 1, user_id: 1, operation: 1, resource_id: 1, key: 1 }],
  ),
  training_profiles: strict(
    {
      ...base,
      scenario: { enum: ["adult-training"] },
      ai_enabled: { bsonType: "bool" },
      ai_daily_limit: num,
    },
    [{ org_id: 1 }],
  ),
  ai_jobs: strict(
    {
      ...base,
      user_id: id,
      member_id: id,
      key: small,
      request_hash: small,
      kind: { enum: ["assist", "prepare", "questions", "report"] },
      context_id: id,
      context_revision: num,
      prompt: text,
      status: {
        enum: [
          "queued",
          "running",
          "succeeded",
          "failed",
          "unknown",
          "cancelled",
        ],
      },
      output: text,
      error_code: small,
      citations: {
        bsonType: "array",
        maxItems: 100,
        items: {
          bsonType: "object",
          additionalProperties: false,
          required: ["key", "title"],
          properties: { key: small, title: small },
        },
      },
      dispatch_started_at: nullable(date),
      budget_day: small,
    },
    [{ org_id: 1, user_id: 1, key: 1 }],
  ),
  ai_usage_ledger: strict(
    { ...base, day: small, reserved: num, used: num, unknown: num },
    [{ org_id: 1, day: 1 }],
  ),
  site_revisions: strict({
    ...base,
    page_key: small,
    title: small,
    body: text,
    status: { enum: ["draft", "published"] },
    author_id: id,
    publisher_id: nullable(id),
  }),
  site_leads: strict(
    {
      ...base,
      receipt_hash: small,
      contact: small,
      kind: small,
      name: small,
      status: { enum: ["new", "contacted", "closed"] },
      consent_at: date,
      policy_revision: small,
      expires_at: date,
    },
    [{ receipt_hash: 1 }],
  ),
};
TRAINING_SCHEMAS.site_leads!.indexes.push({
  key: { expires_at: 1 },
  expireAfterSeconds: 0,
  name: "site_lead_retention",
});
export function trainingSchemas(
  baseSchemas: Record<string, Schema>,
): Record<string, Schema> {
  const grant = structuredClone(baseSchemas.member_capability_grants!);
  function visit(v: any) {
    if (!v || typeof v !== "object") return;
    if (v.properties?.capability?.enum)
      v.properties.capability.enum = [
        ...new Set([...v.properties.capability.enum, ...TRAINING_CAPABILITIES]),
      ];
    Object.values(v).forEach(visit);
  }
  visit(grant.validator);
  const audit = structuredClone(baseSchemas.audit_events!);
  function auditVisit(value: any) {
    if (!value || typeof value !== "object") return;
    if (value.properties?.resource_type?.enum)
      value.properties.resource_type.enum = [
        ...new Set([
          ...value.properties.resource_type.enum,
          "course",
          "task",
          "coursework",
          "feedback",
          "ai_job",
          "training_profile",
          "site_revision",
          "site_lead",
        ]),
      ];
    Object.values(value).forEach(auditVisit);
  }
  auditVisit(audit.validator);
  const files = structuredClone(baseSchemas.file_resources!);
  function mimeVisit(value: any) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value.enum) && value.enum.includes("application/pdf"))
      value.enum = [...new Set([...value.enum, "video/mp4", "audio/mpeg"])];
    Object.values(value).forEach(mimeVisit);
  }
  mimeVisit(files.validator);
  return {
    ...baseSchemas,
    ...TRAINING_SCHEMAS,
    member_capability_grants: grant,
    audit_events: audit,
    file_resources: files,
  };
}
export const TRAINING_CHECKSUM = createHash("sha256")
  .update(
    JSON.stringify({
      version: 11,
      schemas: TRAINING_SCHEMAS,
      capabilities: TRAINING_CAPABILITIES,
      media_mimes: ["video/mp4", "audio/mpeg"],
      audit_resource_types: [
        "course",
        "task",
        "coursework",
        "feedback",
        "ai_job",
        "training_profile",
        "site_revision",
        "site_lead",
      ],
    }),
  )
  .digest("hex");
export async function migrateTraining(
  db: Db,
  baseSchemas: Record<string, Schema>,
): Promise<void> {
  db = rawDatabase(db);
  const schemas = trainingSchemas(baseSchemas);
  const existing = await db
    .collection("schema_migrations")
    .findOne({ version: 11 });
  if (existing && existing.checksum !== TRAINING_CHECKSUM)
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
      version: 11,
      checksum: TRAINING_CHECKSUM,
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
      version: 11,
      checksum: TRAINING_CHECKSUM,
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
        version: 11,
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
      if (
        !TRAINING_SCHEMAS[name] &&
        ![
          "member_capability_grants",
          "audit_events",
          "file_resources",
        ].includes(name)
      )
        continue;
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
          !["member_capability_grants", "audit_events"].includes(name) ||
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
        version: 11,
        checksum: TRAINING_CHECKSUM,
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
      { version: 11, lease_token: token, status: "running" },
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
