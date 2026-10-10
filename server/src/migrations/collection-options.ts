import { BSON, type Db, type Document, type IndexDescription } from "mongodb";
import { createHash, randomUUID } from "node:crypto";
import { rawDatabase } from "../database/object-id";
import { isDeepStrictEqual } from "node:util";
function fingerprint(rows: Document[]) {
  const hash = createHash("sha256");
  for (const row of rows) hash.update(BSON.serialize(row));
  return hash.digest("hex");
}
async function rows(
  db: Db,
  name: string,
  session?: import("mongodb").ClientSession,
) {
  const result: Document[] = [];
  let bytes = 0;
  for await (const row of db
    .collection(name)
    .find({}, { session, promoteValues: false, promoteLongs: false })
    .sort({ _id: 1 })) {
    bytes += BSON.serialize(row).length;
    if (result.length >= 10000 || bytes > 64 * 1024 * 1024)
      throw Error("SCHEMA_REBUILD_SIZE_LIMIT");
    result.push(row);
  }
  return result;
}
function indexSpec(index: Document): IndexDescription {
  const result: Document = { key: index.key, name: index.name };
  for (const key of [
    "unique",
    "sparse",
    "expireAfterSeconds",
    "partialFilterExpression",
    "collation",
    "hidden",
    "storageEngine",
  ])
    if (index[key] !== undefined) result[key] = index[key];
  return result as IndexDescription;
}
/** Explicit offline, non-production fallback for a server that refuses collMod.
 * The original namespace stays available until one atomic rename. An independent
 * BSON-identical rollback copy is kept until the replacement has been verified.
 */
export async function rebuildCollection(
  db: Db,
  command: Document,
  indexes?: IndexDescription[],
  beforePublish?: () => Promise<void>,
) {
  db = rawDatabase(db);
  if (
    process.env.NODE_ENV === "production" ||
    process.env.KL_MONGO_ALLOW_COLLECTION_REBUILD !== "true" ||
    process.env.KL_SCHEMA_REBUILD_OFFLINE !== "true"
  )
    throw Error("SCHEMA_REBUILD_OFFLINE_REQUIRED");
  const name = command.collMod;
  if (
    typeof name !== "string" ||
    !/^[a-z][a-z0-9_]{0,99}$/.test(name) ||
    !command.validator
  )
    throw Error("SCHEMA_REBUILD_ARGUMENTS_INVALID");
  const original = await db
    .listCollections({ name }, { nameOnly: false })
    .next();
  if (
    !original ||
    original.type !== "collection" ||
    original.options?.capped ||
    original.options?.timeseries
  )
    throw Error("SCHEMA_REBUILD_COLLECTION_INVALID");
  const oldIndexes = await db.collection(name).listIndexes().toArray();
  const specs =
    indexes ?? oldIndexes.filter((i) => i.name !== "_id_").map(indexSpec);
  const id = randomUUID().replaceAll("-", ""),
    stage = "_kl_rebuild_stage_" + id,
    backup = "_kl_rebuild_backup_" + id;
  let stageCreated = false,
    backupCreated = false,
    published = false,
    expected: string | undefined;
  try {
    await db.createCollection(stage, {
      validator: command.validator,
      validationLevel: command.validationLevel ?? "strict",
      validationAction: command.validationAction ?? "error",
    });
    stageCreated = true;
    const stableSpecs = specs.filter(
      (index) => index.expireAfterSeconds === undefined,
    );
    if (stableSpecs.length)
      await db.collection(stage).createIndexes(stableSpecs);
    await db.createCollection(backup);
    backupCreated = true;
    const session = db.client.startSession();
    try {
      await session.withTransaction(
        async () => {
          const source = await rows(db, name, session);
          expected = fingerprint(source);
          for (let start = 0; start < source.length; start += 250) {
            const batch = source.slice(start, start + 250);
            await db.collection(stage).insertMany(batch, { session });
            await db.collection(backup).insertMany(batch, { session });
          }
        },
        {
          readConcern: { level: "snapshot" },
          writeConcern: { w: "majority" },
          readPreference: "primary",
          maxCommitTimeMS: 5000,
        },
      );
    } finally {
      await session.endSession();
    }
    if (
      fingerprint(await rows(db, stage)) !== expected ||
      fingerprint(await rows(db, backup)) !== expected
    )
      throw Error("SCHEMA_REBUILD_COPY_MISMATCH");
    await beforePublish?.(); // Controlled race/fault acceptance; never selected by a request.
    const current = await db
      .listCollections({ name }, { nameOnly: false })
      .next();
    if (
      !isDeepStrictEqual(current?.info?.uuid, original.info?.uuid) ||
      fingerprint(await rows(db, name)) !== expected
    )
      throw Error("SCHEMA_REBUILD_SOURCE_CHANGED");
    await db.collection(stage).rename(name, { dropTarget: true });
    published = true;
    stageCreated = false;
    const replacement = await db
      .listCollections({ name }, { nameOnly: false })
      .next();
    if (
      !isDeepStrictEqual(replacement?.options?.validator, command.validator) ||
      fingerprint(await rows(db, name)) !== expected
    )
      throw Error("SCHEMA_REBUILD_PUBLISH_MISMATCH");
    await db.collection(backup).drop();
    backupCreated = false;
    const ttlSpecs = specs.filter(
      (index) => index.expireAfterSeconds !== undefined,
    );
    if (ttlSpecs.length) await db.collection(name).createIndexes(ttlSpecs);
  } catch (error) {
    // Before publication only our staging copies are removable; original is untouched.
    // After publication keep rollback BSON if anything cannot be proved.
    if (!published) {
      if (stageCreated) await db.collection(stage).drop();
      if (backupCreated) await db.collection(backup).drop();
    }
    if (published && backupCreated)
      throw Object.assign(Error("SCHEMA_REBUILD_ROLLBACK_COPY_RETAINED"), {
        backupCollection: backup,
      });
    throw error;
  }
  return { rebuilt: true };
}
export async function changeCollectionOptions(
  db: Db,
  command: Document,
  indexes?: IndexDescription[],
) {
  try {
    return await rawDatabase(db).command(command);
  } catch (error) {
    const e = error as { code?: number; message?: string };
    if (
      e.code !== 8000 ||
      !e.message?.includes("collMod") ||
      process.env.KL_MONGO_ALLOW_COLLECTION_REBUILD !== "true"
    )
      throw error;
    return rebuildCollection(db, command, indexes);
  }
}
