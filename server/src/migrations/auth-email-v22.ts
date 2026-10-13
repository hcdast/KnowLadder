import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MongoServerError, type Db, type Document } from "mongodb";
import { objectIdDatabase, rawDatabase } from "../database/object-id";
import { changeCollectionOptions } from "./collection-options";
import { AUTH_EMAIL_CHECKSUM, AUTH_EMAIL_SCHEMAS } from "../auth-email/schema";

const COMMAND_MS = 15000, LEASE_MS = 120000;
const writeConcern = { w: "majority" as const, wtimeoutMS: COMMAND_MS };
const gateOwner = /^auth-email-v22:(unregistered|active):[0-9a-f-]{36}$/;
async function releaseEmailMigrationGate(db: Db, state: Document): Promise<void> {
  const match = typeof state.owner === "string" ? gateOwner.exec(state.owner) : null;
  if (!match || state.mode !== "draining") throw Error("AUTH_EMAIL_MIGRATION_GATE_INVALID");
  const restoredMode = match[1]!;
  const result = await objectIdDatabase(db).collection("operational_state").updateOne({
    _id: "environment" as never, mode: "draining", owner: state.owner, revision: state.revision,
  }, [{ $set: { mode: restoredMode, environment_id: restoredMode === "unregistered" ? null : state.environment_id,
    owner: null, revision: { $add: ["$revision", 1] }, access_fence: { $add: ["$access_fence", 1] }, updated_at: "$$NOW" } }],
  { writeConcern, maxTimeMS: COMMAND_MS });
  if (result.modifiedCount !== 1) throw Error("AUTH_EMAIL_MIGRATION_GATE_CHANGED");
}
export async function assertEmailCollections(db: Db): Promise<void> {
  db = rawDatabase(db);
  for (const [name, schema] of Object.entries(AUTH_EMAIL_SCHEMAS)) {
    const info = await db.listCollections({ name }, { nameOnly: false, maxTimeMS: COMMAND_MS }).next();
    if (!info || info.type !== "collection" || info.options?.validationLevel !== "strict" ||
      info.options?.validationAction !== "error" || info.options?.collation ||
      !isDeepStrictEqual(info.options?.validator, schema.validator)) throw Error("AUTH_EMAIL_SCHEMA_MISMATCH");
    const indexes = await db.collection(name).listIndexes({ maxTimeMS: COMMAND_MS }).toArray();
    for (const expected of schema.indexes) {
      const actual = indexes.find(i => i.name === expected.name);
      if (!actual || !isDeepStrictEqual(actual.key, expected.key) || !!actual.unique !== !!expected.unique ||
        actual.expireAfterSeconds !== expected.expireAfterSeconds || actual.sparse || actual.hidden || actual.collation ||
        !isDeepStrictEqual(actual.partialFilterExpression, expected.partialFilterExpression)) throw Error("AUTH_EMAIL_INDEX_MISMATCH");
    }
  }
}
/** Explicit stopped-writer DDL. No training dependency or standalone transaction shim. */
export async function migrateAuthEmail(db: Db, coreChecksum: string): Promise<void> {
  db = rawDatabase(db);
  const markers = db.collection<Document>("schema_migrations");
  if (!await markers.findOne({ version: 10, checksum: coreChecksum, status: "completed" })) throw Error("AUTH_EMAIL_V10_REQUIRED");
  const existing = await markers.findOne({ version: 22 }, { maxTimeMS: COMMAND_MS });
  if (existing && existing.checksum !== AUTH_EMAIL_CHECKSUM) throw Error("AUTH_EMAIL_MIGRATION_CHECKSUM_MISMATCH");
  if (existing?.status === "completed") {
    if (!(existing.completed_at instanceof Date) || !Number.isFinite(existing.completed_at.getTime())) throw Error("AUTH_EMAIL_MIGRATION_MARKER_INVALID");
    await assertEmailCollections(db);
    const state = await objectIdDatabase(db).collection("operational_state").findOne({ _id: "environment" as never });
    if (state?.mode === "draining" && typeof state.owner === "string" && gateOwner.test(state.owner)) {
      if (await db.collection("operational_writers").findOne({ state: "running" })) throw Error("AUTH_EMAIL_WRITERS_RUNNING");
      await releaseEmailMigrationGate(db, state);
    }
    return;
  }
  if (await db.collection("operational_writers").findOne({ state: "running" })) throw Error("AUTH_EMAIL_WRITERS_RUNNING");
  try {
    await markers.updateOne({ version: 22 }, { $setOnInsert: {
      version: 22, checksum: AUTH_EMAIL_CHECKSUM, status: "pending", lease_token: null, lease_until: null,
      created_at: new Date(), started_at: null, completed_at: null, failed_at: null,
    } }, { upsert: true, writeConcern, maxTimeMS: COMMAND_MS });
  } catch (error) { if (!(error instanceof MongoServerError) || error.code !== 11000) throw error; }
  const old = await markers.findOne({ version: 22 }, { maxTimeMS: COMMAND_MS });
  if (!old || old.checksum !== AUTH_EMAIL_CHECKSUM) throw Error("AUTH_EMAIL_MIGRATION_CHECKSUM_MISMATCH");
  if (old.status === "completed") { await assertEmailCollections(db); return; }
  const token = randomUUID();
  const acquired = await markers.findOneAndUpdate({ version: 22, checksum: AUTH_EMAIL_CHECKSUM,
    $or: [{ status: { $in: ["pending", "failed"] } }, { status: "running", $expr: { $lte: ["$lease_until", "$$NOW"] } }],
  }, [{ $set: { status: "running", lease_token: token, lease_until: { $add: ["$$NOW", LEASE_MS] },
    started_at: "$$NOW", failed_at: null, completed_at: null } }], { returnDocument: "after", writeConcern, maxTimeMS: COMMAND_MS });
  if (!acquired) throw Error("AUTH_EMAIL_MIGRATION_BUSY");
  const held = { version: 22, checksum: AUTH_EMAIL_CHECKSUM, status: "running", lease_token: token,
    $expr: { $gt: ["$lease_until", "$$NOW"] } };
  const states = objectIdDatabase(db).collection("operational_state");
  let guard: Document | null = null;
  const renew = async () => {
    if (await db.collection("operational_writers").findOne({ state: "running" }, { maxTimeMS: COMMAND_MS })) throw Error("AUTH_EMAIL_WRITERS_RUNNING");
    const result = await markers.updateOne(held, [{ $set: { lease_until: { $add: ["$$NOW", LEASE_MS] } } }], { writeConcern, maxTimeMS: COMMAND_MS });
    if (result.matchedCount !== 1) throw Error("AUTH_EMAIL_MIGRATION_LEASE_LOST");
    if (guard && !await states.findOne({ _id: "environment" as never, mode: "draining", owner: guard.owner, revision: guard.revision }))
      throw Error("AUTH_EMAIL_MIGRATION_GATE_CHANGED");
  };
  try {
    const before = await states.findOne({ _id: "environment" as never }, { maxTimeMS: COMMAND_MS });
    const resumedMode = before?.mode === "draining" && typeof before.owner === "string" ? gateOwner.exec(before.owner)?.[1] : undefined;
    if (!before || (!resumedMode && (!["unregistered", "active"].includes(before.mode) || before.owner !== null)) ||
        before.maintenance_token !== null || (before.restore_id !== null && (resumedMode ?? before.mode) !== "active")) throw Error("AUTH_EMAIL_MIGRATION_STATE");
    const originalMode = resumedMode ?? before.mode;
    guard = await states.findOneAndUpdate({ _id: "environment" as never, mode: before.mode,
      owner: before.owner, revision: before.revision, access_fence: before.access_fence },
    [{ $set: { mode: "draining", environment_id: before.environment_id ?? randomUUID(),
      owner: `auth-email-v22:${originalMode}:${token}`, revision: { $add: ["$revision", 1] },
      access_fence: { $add: ["$access_fence", 1] }, updated_at: "$$NOW" } }],
    { returnDocument: "after", writeConcern, maxTimeMS: COMMAND_MS });
    if (!guard) throw Error("AUTH_EMAIL_MIGRATION_BUSY");
    // Same operational_state CAS conflicts with acquireWriter's admission fence.
    // After closing admission, recheck writers before the very first DDL.
    await renew();
    for (const [name, schema] of Object.entries(AUTH_EMAIL_SCHEMAS)) {
      await renew();
      const info = await db.listCollections({ name }, { nameOnly: false, maxTimeMS: COMMAND_MS }).next();
      if (!info) await db.createCollection(name, { validator: schema.validator, validationLevel: "strict", validationAction: "error", writeConcern, maxTimeMS: COMMAND_MS });
      else if (!isDeepStrictEqual(info.options?.validator, schema.validator) || info.options?.validationLevel !== "strict" || info.options?.validationAction !== "error") {
        await renew();
        await changeCollectionOptions(db, { collMod: name, validator: schema.validator, validationLevel: "strict", validationAction: "error", writeConcern: { w: "majority", wtimeout: COMMAND_MS }, maxTimeMS: COMMAND_MS }, schema.indexes);
      }
      await renew();
      if (await db.collection(name).findOne({ $nor: [schema.validator] }, { projection: { _id: 1 }, maxTimeMS: COMMAND_MS })) throw Error("AUTH_EMAIL_EXISTING_DATA_INVALID");
      await renew();
      await db.command({ createIndexes: name, indexes: schema.indexes,
        writeConcern: { w: "majority", wtimeout: COMMAND_MS }, maxTimeMS: COMMAND_MS });
    }
    await renew();
    await assertEmailCollections(db);
    await renew();
    const completed = await markers.updateOne(held, [{ $set: { status: "completed", completed_at: "$$NOW", lease_token: null, lease_until: null } }], { writeConcern, maxTimeMS: COMMAND_MS });
    if (completed.matchedCount !== 1) throw Error("AUTH_EMAIL_MIGRATION_LEASE_LOST");
    await releaseEmailMigrationGate(db, guard);
  } catch (error) {
    // Preserve draining admission after any partial DDL or uncertain publication.
    // An explicit retry claims the marker lease and resumes only this named gate.
    await markers.updateOne(held, [{ $set: { status: "failed", failed_at: "$$NOW", lease_token: null, lease_until: null } }], { writeConcern, maxTimeMS: COMMAND_MS }).catch(() => undefined);
    throw error;
  }
}
