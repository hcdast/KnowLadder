import { createHash, randomUUID } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import { isDeepStrictEqual } from "node:util";
import { rawDatabase } from "../database/object-id";
import type { Schema } from "./schema";
const id = { bsonType: "objectId" },
  str = { bsonType: "string" },
  num = {
    bsonType: ["int", "long", "double"],
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    multipleOf: 1,
  },
  date = { bsonType: "date" };
const nullable = (v: object) => ({ anyOf: [v, { bsonType: "null" }] });
const obj = (properties: Record<string, any>) => ({
  bsonType: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
export const IMPORT_CHANGED = ["knowledge_import_jobs"];
export function importSchemas(
  previous: Record<string, Schema>,
): Record<string, Schema> {
  return {
    ...previous,
    knowledge_import_jobs: {
      validator: {
        $jsonSchema: obj({
          _id: id,
          org_id: id,
          user_id: id,
          member_id: id,
          owner_id: id,
          file_id: id,
          source_revision: num,
          source_hash: { ...str, pattern: "^[a-f0-9]{64}$" },
          revision: { ...num, minimum: 1 },
          generation: { ...num, minimum: 1 },
          status: {
            enum: [
              "queued",
              "running",
              "preview-ready",
              "failed",
              "cancelled",
              "applied",
            ],
          },
          lease_token: nullable(str),
          lease_until: nullable(date),
          error_code: str,
          expires_at: date,
          created_at: date,
          updated_at: date,
          preview: {
            bsonType: "array",
            maxItems: 100,
            items: obj({
              ordinal: num,
              page: nullable({ ...num, minimum: 1, maximum: 100 }),
              text: { ...str, maxLength: 160000 },
            }),
          },
          warnings: { bsonType: "array", maxItems: 10, items: str },
          format: { enum: ["pdf", "docx"] },
          applied_revision: nullable(num),
          chapter_ids: { bsonType: "array", maxItems: 100, items: id },
          license_json: { ...str, maxLength: 8192 },
        }),
      },
      indexes: [
        {
          key: { org_id: 1, owner_id: 1, user_id: 1, created_at: -1 },
          name: "import_owner_user",
        },
        { key: { status: 1, lease_until: 1 }, name: "import_claim" },
        { key: { expires_at: 1 }, name: "import_expiry" },
      ],
    },
  };
}
export const IMPORT_CHECKSUM = createHash("sha256")
  .update(
    JSON.stringify({
      version: 18,
      policy: "scanned-draft-import-v1",
      schemas: importSchemas({}),
    }),
  )
  .digest("hex");
export async function migrateImports(
  db: Db,
  baseSchemas: Record<string, Schema>,
): Promise<void> {
  db = rawDatabase(db);
  const schemas = importSchemas(baseSchemas);
  if (await db.collection("operational_writers").findOne({ state: "running" }))
    throw Error("Training migration requires stopped writers");
  const existing = await db
    .collection("schema_migrations")
    .findOne({ version: 18 });
  if (existing && existing.checksum !== IMPORT_CHECKSUM)
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
      version: 18,
      checksum: IMPORT_CHECKSUM,
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
      version: 18,
      checksum: IMPORT_CHECKSUM,
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
        version: 18,
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
      if (!IMPORT_CHANGED.includes(name)) continue;
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
        throw Error("Training schema drift:" + name);
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
        version: 18,
        checksum: IMPORT_CHECKSUM,
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
      { version: 18, lease_token: token, status: "running" },
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
