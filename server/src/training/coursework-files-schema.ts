import { createHash, randomUUID } from "node:crypto";
import { ObjectId, type Document, type Db } from "mongodb";
import { isDeepStrictEqual } from "node:util";
import { rawDatabase } from "../database/object-id";
import type { Schema } from "./schema";
export const COURSEWORK_FILES_CHANGED = [
  "file_resources",
  "audit_events",
  "coursework_heads",
  "coursework_submissions",
];
export function courseworkFilesSchemas(
  previous: Record<string, Schema>,
): Record<string, Schema> {
  const schemas = { ...previous };
  for (const name of COURSEWORK_FILES_CHANGED) {
    const next = structuredClone(previous[name]!);

    if (name === "file_resources" || name === "audit_events") {
      function visit(v: any) {
        if (!v || typeof v !== "object") return;
        if (v.properties?.owner_type?.enum)
          v.properties.owner_type.enum = [
            ...new Set([...v.properties.owner_type.enum, "coursework"]),
          ];
        Object.values(v).forEach(visit);
      }
      visit(next.validator);
    } else {
      const properties = next.validator.$jsonSchema.properties;
      properties.file_ids = {
        bsonType: "array",
        items: { bsonType: "objectId" },
        maxItems: 5,
        uniqueItems: true,
      };
    }
    schemas[name] = next;
  }
  return schemas;
}
export const COURSEWORK_FILES_CHECKSUM = createHash("sha256")
  .update(
    JSON.stringify({
      version: 12,
      owner: "coursework",
      changes: COURSEWORK_FILES_CHANGED,
      file_ids: { max: 5, unique: true },
      policy: "ready-clean-private-v1",
    }),
  )
  .digest("hex");
export async function migrateCourseworkFiles(
  db: Db,
  baseSchemas: Record<string, Schema>,
): Promise<void> {
  db = rawDatabase(db);
  const schemas = courseworkFilesSchemas(baseSchemas);
  const existing = await db
    .collection("schema_migrations")
    .findOne({ version: 12 });
  if (existing && existing.checksum !== COURSEWORK_FILES_CHECKSUM)
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
      version: 12,
      checksum: COURSEWORK_FILES_CHECKSUM,
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
      version: 12,
      checksum: COURSEWORK_FILES_CHECKSUM,
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
        version: 12,
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
        !COURSEWORK_FILES_CHANGED.includes(name) &&
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
          !COURSEWORK_FILES_CHANGED.includes(name) ||
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
        version: 12,
        checksum: COURSEWORK_FILES_CHECKSUM,
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
      { version: 12, lease_token: token, status: "running" },
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
