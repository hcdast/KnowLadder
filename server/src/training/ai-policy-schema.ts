import { createHash, randomUUID } from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import { isDeepStrictEqual } from 'node:util';
import { rawDatabase } from '../database/object-id';
import type { Schema } from './schema';
export const AI_POLICY_CHANGED=['training_profiles','ai_jobs','ai_usage_ledger'];
const amount={bsonType:['double','int','long'],minimum:0,maximum:Number.MAX_SAFE_INTEGER};
const currency={bsonType:'string',pattern:'^[A-Z]{3}$'};
export function aiPolicySchemas(previous:Record<string,Schema>):Record<string,Schema>{
 const result={...previous};for(const name of AI_POLICY_CHANGED){const next=structuredClone(previous[name]!);const props=next.validator.$jsonSchema.properties;
 if(name==='training_profiles')Object.assign(props,{ai_enabled_kinds:{bsonType:'array',uniqueItems:true,maxItems:4,items:{enum:['assist','prepare','questions','report']}},ai_currency:currency,ai_daily_budget_micro:amount,ai_max_request_micro:amount});
 else if(name==='ai_jobs')Object.assign(props,{cost_ceiling_micro:amount,budget_currency:currency});
 else Object.assign(props,{reserved_micro:amount,spent_micro:amount,unknown_micro:amount,currency});
 result[name]=next;}return result;
}
export const AI_POLICY_CHECKSUM=createHash('sha256').update(JSON.stringify({version:13,fields:['kinds','currency','daily_budget_micro','max_request_micro','job_ceiling','reserved_micro','spent_micro','unknown_micro'],policy:'conservative-reservation-upper-bound-v1'})).digest('hex');
export async function migrateAiPolicy(
  db: Db,
  baseSchemas: Record<string, Schema>,
): Promise<void> {
  db = rawDatabase(db);
  const schemas = aiPolicySchemas(baseSchemas);
  const existing = await db
    .collection("schema_migrations")
    .findOne({ version: 13 });
  if (existing && existing.checksum !== AI_POLICY_CHECKSUM)
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
      version: 13,
      checksum: AI_POLICY_CHECKSUM,
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
      version: 13,
      checksum: AI_POLICY_CHECKSUM,
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
        version: 13,
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
        !AI_POLICY_CHANGED.includes(name)
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
          !AI_POLICY_CHANGED.includes(name) ||
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
        version: 13,
        checksum: AI_POLICY_CHECKSUM,
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
      { version: 13, lease_token: token, status: "running" },
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
