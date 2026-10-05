import { createHash, randomUUID } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import { isDeepStrictEqual } from "node:util";
import { rawDatabase } from "../database/object-id";
import type { Schema } from "./schema";
export const REPORT_CAPABILITIES = [
  "training:report-edit",
  "training:report-review",
] as const;
const id = { bsonType: "objectId" },
  date = { bsonType: "date" },
  str = { bsonType: "string", maxLength: 16000 },
  nullable = (x: any) => ({ anyOf: [x, { bsonType: "null" }] });
const base = {
  _id: id,
  org_id: id,
  revision: { bsonType: ["int", "long", "double"], minimum: 1, multipleOf: 1 },
  created_at: date,
  updated_at: date,
};
const content = {
  class_id: id,
  subject_id: id,
  task_id: nullable(id),
  author_id: id,
  contributors: {
    bsonType: "array",
    uniqueItems: true,
    maxItems: 100,
    items: id,
  },
  title: { bsonType: "string", minLength: 1, maxLength: 200 },
  body: str,
  facts_json: str,
  source_watermark: { bsonType: "string", pattern: "^[a-f0-9]{64}$" },
  facts_at: date,
  valid_until: date,
};
function strict(props: any, indexes: any[]): Schema {
  return {
    validator: {
      $jsonSchema: {
        bsonType: "object",
        additionalProperties: false,
        required: Object.keys(props),
        properties: props,
      },
    },
    indexes,
  };
}
export const TRAINING_REPORT_CHANGED = [
  "training_reports",
  "training_report_versions",
  "member_capability_grants",
  "audit_events",
];
export function trainingReportSchemas(
  previous: Record<string, Schema>,
): Record<string, Schema> {
  const grants = structuredClone(previous.member_capability_grants!),
    audit = structuredClone(previous.audit_events!);
  const visit = (value: any) => {
    if (!value || typeof value !== "object") return;
    if (value.properties?.capability?.enum)
      value.properties.capability.enum = [
        ...new Set([
          ...value.properties.capability.enum,
          ...REPORT_CAPABILITIES,
        ]),
      ];
    if (value.properties?.resource_type?.enum)
      value.properties.resource_type.enum = [
        ...new Set([...value.properties.resource_type.enum, "training_report"]),
      ];
    Object.values(value).forEach(visit);
  };
  visit(grants.validator);
  visit(audit.validator);
  return {
    ...previous,
    member_capability_grants: grants,
    audit_events: audit,
    training_reports: strict(
      {
        ...base,
        ...content,
        status: { enum: ["draft", "review", "published", "retired"] },
        reviewer_id: nullable(id),
        review_note: str,
        published_version_id: nullable(id),
      },
      [
        {
          key: { org_id: 1, class_id: 1, updated_at: -1 },
          name: "report_class",
        },
      ],
    ),
    training_report_versions: strict(
      {
        ...base,
        ...content,
        report_id: id,
        reviewer_id: id,
        review_note: str,
        published_at: date,
      },
      [
        {
          key: { report_id: 1, revision: 1 },
          name: "report_version",
          unique: true,
        },
      ],
    ),
  };
}
export const TRAINING_REPORT_CHECKSUM = createHash("sha256")
  .update(
    JSON.stringify({
      version: 14,
      schemas: trainingReportSchemas({
        member_capability_grants: { validator: {}, indexes: [] },
        audit_events: { validator: {}, indexes: [] },
      }),
      capabilities: REPORT_CAPABILITIES,
      policy: "independent-review-effective-facts-v1",
    }),
  )
  .digest("hex");
export async function migrateTrainingReports(
  db: Db,
  baseSchemas: Record<string, Schema>,
): Promise<void> {
  db = rawDatabase(db);
  const schemas = trainingReportSchemas(baseSchemas);
  if (await db.collection("operational_writers").findOne({ state: "running" }))
    throw Error("Training migration requires stopped writers");
  const existing = await db
    .collection("schema_migrations")
    .findOne({ version: 14 });
  if (existing && existing.checksum !== TRAINING_REPORT_CHECKSUM)
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
      version: 14,
      checksum: TRAINING_REPORT_CHECKSUM,
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
      version: 14,
      checksum: TRAINING_REPORT_CHECKSUM,
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
        version: 14,
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
      if (!TRAINING_REPORT_CHANGED.includes(name)) continue;
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
          !TRAINING_REPORT_CHANGED.includes(name) ||
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
        version: 14,
        checksum: TRAINING_REPORT_CHECKSUM,
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
      { version: 14, lease_token: token, status: "running" },
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
