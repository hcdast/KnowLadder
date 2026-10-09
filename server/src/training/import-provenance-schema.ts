import { createHash, randomUUID } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import { isDeepStrictEqual } from "node:util";
import { rawDatabase } from "../database/object-id";
import type { Schema } from "./schema";
import { provenanceRecord } from "./import-provenance";
const id = { bsonType: "objectId" },
  str = { bsonType: "string" },
  num = {
    bsonType: ["int", "long", "double"],
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
    multipleOf: 1,
  },
  date = { bsonType: "date" };
export const PROVENANCE_CHANGED = ["knowledge_import_provenance"];
export function provenanceSchemas(
  previous: Record<string, Schema>,
): Record<string, Schema> {
  const properties = {
    _id: id,
    org_id: id,
    owner_id: id,
    file_id: id,
    source_hash: { ...str, pattern: "^[a-f0-9]{64}$" },
    applied_revision: num,
    chapter_ids: { bsonType: "array", minItems: 1, maxItems: 100, items: id },
    license_json: { ...str, maxLength: 8192 },
    created_at: date,
  };
  return {
    ...previous,
    knowledge_import_provenance: {
      validator: {
        $jsonSchema: {
          bsonType: "object",
          additionalProperties: false,
          required: Object.keys(properties),
          properties,
        },
      },
      indexes: [
        {
          key: { org_id: 1, owner_id: 1, applied_revision: -1, _id: 1 },
          name: "provenance_owner_revision",
        },
      ],
    },
  };
}
export const PROVENANCE_CHECKSUM = createHash("sha256")
  .update(
    JSON.stringify({
      version: 19,
      policy: "shared-import-proof-v1",
      schemas: provenanceSchemas({}),
    }),
  )
  .digest("hex");
export async function migrateProvenance(
  db: Db,
  baseSchemas: Record<string, Schema>,
): Promise<void> {
  db = rawDatabase(db);
  const schemas = provenanceSchemas(baseSchemas);
  if (await db.collection("operational_writers").findOne({ state: "running" }))
    throw Error("Training migration requires stopped writers");
  const existing = await db
    .collection("schema_migrations")
    .findOne({ version: 19 });
  if (existing && existing.checksum !== PROVENANCE_CHECKSUM)
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
      version: 19,
      checksum: PROVENANCE_CHECKSUM,
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
      version: 19,
      checksum: PROVENANCE_CHECKSUM,
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
        version: 19,
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
      if (!PROVENANCE_CHANGED.includes(name)) continue;
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
    for await (const job of db
      .collection("knowledge_import_jobs")
      .find({ status: "applied" })) {
      await renew();
      const owner = await db
        .collection("textbook_editions")
        .findOne({ _id: job.owner_id, org_id: job.org_id });
      const file = await db
        .collection("file_resources")
        .findOne({
          _id: job.file_id,
          org_id: job.org_id,
          owner_type: "textbook",
          owner_version_id: job.owner_id,
        });
      if (
        !owner ||
        !file ||
        file.checksum !== job.source_hash ||
        !job.applied_revision ||
        job.applied_revision > owner.revision ||
        !Array.isArray(job.chapter_ids) ||
        !job.chapter_ids.length
      )
        throw Error("Import provenance backfill invalid:" + job._id);
      const record = provenanceRecord(
        job,
        job.applied_revision,
        job.chapter_ids,
        job.license_json,
        job.updated_at,
      );
      await db
        .collection("knowledge_import_provenance")
        .updateOne(
          { _id: record._id },
          { $setOnInsert: record },
          { upsert: true },
        );
    }
    await renew();
    const r = await db.collection("schema_migrations").updateOne(
      {
        version: 19,
        checksum: PROVENANCE_CHECKSUM,
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
      { version: 19, lease_token: token, status: "running" },
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
