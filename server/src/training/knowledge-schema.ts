import { changeCollectionOptions } from "../migrations/collection-options";
import { createHash, randomUUID } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import { isDeepStrictEqual } from "node:util";
import { rawDatabase } from "../database/object-id";
import type { Schema } from "./schema";
const id = { bsonType: "objectId" },
  str = { bsonType: "string" },
  num = { bsonType: ["int", "long", "double"], minimum: 0, multipleOf: 1 },
  date = { bsonType: "date" };
const nullable = (type: object) => ({ anyOf: [type, { bsonType: "null" }] });
const obj = (
  properties: Record<string, any>,
  required = Object.keys(properties),
) => ({
  bsonType: "object",
  additionalProperties: false,
  properties,
  required,
});
const source = obj(
  {
    kind: { enum: ["chapter", "course-text"] },
    id,
    lesson_key: { bsonType: "string", maxLength: 64 },
  },
  ["kind", "id"],
);
const chunk = obj({
  ordinal: num,
  start_utf16: num,
  end_utf16: num,
  text: { bsonType: "string", maxLength: 1600 },
  content_hash: { bsonType: "string", pattern: "^[a-f0-9]{64}$" },
  terms: { bsonType: "array", maxItems: 1600, items: str },
});
export const KNOWLEDGE_CHANGED = [
  "knowledge_sources",
  "knowledge_outbox",
  "ai_jobs",
];
export function knowledgeSchemas(
  previous: Record<string, Schema>,
): Record<string, Schema> {
  const jobs = structuredClone(previous.ai_jobs!);
  jobs.validator.$jsonSchema.properties.knowledge_scope = {
    bsonType: "array",
    minItems: 1,
    maxItems: 20,
    items: source,
  };
  jobs.validator.$jsonSchema.properties.knowledge_fingerprint = {
    bsonType: "string",
    pattern: "^[a-f0-9]{64}$",
  };
  jobs.validator.$jsonSchema.allOf = [
    ...(jobs.validator.$jsonSchema.allOf ?? []),
    {
      oneOf: [
        {
          required: ["knowledge_scope", "knowledge_fingerprint"],
          properties: { kind: { enum: ["assist", "prepare"] } },
        },
        {
          not: {
            anyOf: [
              { required: ["knowledge_scope"] },
              { required: ["knowledge_fingerprint"] },
            ],
          },
        },
      ],
    },
  ];
  return {
    ...previous,
    ai_jobs: jobs,
    knowledge_sources: {
      validator: {
        $jsonSchema: obj({
          _id: id,
          org_id: id,
          kind: { enum: ["chapter", "course-text"] },
          source_id: id,
          lesson_key: str,
          owner_id: id,
          source_revision: num,
          source_hash: str,
          index_version: num,
          title: str,
          status: { enum: ["ready", "unavailable"] },
          error_code: str,
          chunks: { bsonType: "array", maxItems: 128, items: chunk },
          updated_at: date,
        }),
      },
      indexes: [
        {
          key: { org_id: 1, kind: 1, source_id: 1, lesson_key: 1 },
          unique: true,
          name: "knowledge_source_unique",
        },
        { key: { org_id: 1, owner_id: 1 }, name: "knowledge_source_owner" },
      ],
    },
    knowledge_outbox: {
      validator: {
        $jsonSchema: obj({
          _id: id,
          org_id: id,
          kind: { enum: ["textbook", "course"] },
          owner_id: id,
          generation: num,
          access_revision: num,
          status: { enum: ["pending", "running", "completed", "failed"] },
          lease_token: nullable(str),
          lease_until: nullable(date),
          error_code: str,
          created_at: date,
          updated_at: date,
        }),
      },
      indexes: [
        {
          key: { org_id: 1, kind: 1, owner_id: 1 },
          unique: true,
          name: "knowledge_outbox_owner",
        },
        { key: { status: 1, updated_at: 1 }, name: "knowledge_outbox_pending" },
      ],
    },
  };
}
export const KNOWLEDGE_CHECKSUM = createHash("sha256")
  .update(
    JSON.stringify({
      version: 17,
      policy: "authorized-keyword-v1",
      schemas: knowledgeSchemas({
        ai_jobs: {
          validator: { $jsonSchema: { properties: {} } },
          indexes: [],
        },
      }),
    }),
  )
  .digest("hex");
export async function migrateKnowledge(
  db: Db,
  baseSchemas: Record<string, Schema>,
): Promise<void> {
  db = rawDatabase(db);
  const schemas = knowledgeSchemas(baseSchemas);
  if (await db.collection("operational_writers").findOne({ state: "running" }))
    throw Error("Training migration requires stopped writers");
  const existing = await db
    .collection("schema_migrations")
    .findOne({ version: 17 });
  if (existing && existing.checksum !== KNOWLEDGE_CHECKSUM)
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
      version: 17,
      checksum: KNOWLEDGE_CHECKSUM,
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
      version: 17,
      checksum: KNOWLEDGE_CHECKSUM,
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
        version: 17,
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
      if (!KNOWLEDGE_CHANGED.includes(name)) continue;
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
          name !== "ai_jobs" ||
          !baseSchemas[name] ||
          !isDeepStrictEqual(
            (info as any).options?.validator,
            baseSchemas[name]!.validator,
          )
        )
          throw Error("Training schema drift:" + name);
        await changeCollectionOptions(db, {
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
    // Existing published sources are queued without copying original text into events.
    for (const kind of ["course", "textbook"] as const) {
      const name = kind === "course" ? "courses" : "textbook_editions";
      for await (const owner of db
        .collection(name)
        .find({ status: "published" }, { projection: { _id: 1, org_id: 1 } })) {
        await renew();
        const now = new Date();
        await db.collection("knowledge_outbox").updateOne(
          { org_id: owner.org_id, kind, owner_id: owner._id },
          {
            $setOnInsert: {
              _id: new ObjectId(),
              org_id: owner.org_id,
              kind,
              owner_id: owner._id,
              generation: 1,
              access_revision: 0,
              status: "pending",
              lease_token: null,
              lease_until: null,
              error_code: "",
              created_at: now,
              updated_at: now,
            },
          },
          { upsert: true },
        );
      }
    }
    await renew();
    const r = await db.collection("schema_migrations").updateOne(
      {
        version: 17,
        checksum: KNOWLEDGE_CHECKSUM,
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
      { version: 17, lease_token: token, status: "running" },
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
