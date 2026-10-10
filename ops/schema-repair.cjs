"use strict";
// Explicit, non-production repair of a copied v10 database. Never edits markers/data.
const { MongoClient } = require("../server/node_modules/mongodb");
const { isDeepStrictEqual } = require("node:util");
const { loadConfig } = require("../server/dist/config");
const { assertTopology } = require("../server/dist/database/topology");
const {
  OBJECT_ID_SCHEMAS,
  OBJECT_ID_CHECKSUM,
} = require("../server/dist/migrations/schema");
const {
  assertObjectIdSchema,
} = require("../server/dist/migrations/object-id-v10");
const {
  changeCollectionOptions,
} = require("../server/dist/migrations/collection-options");
const { safeErrorCode } = require("../server/dist/runtime/process-lifecycle");
function matchingIndex(actual, expected) {
  return (
    actual &&
    isDeepStrictEqual(actual.key, expected.key) &&
    !!actual.unique === !!expected.unique &&
    actual.expireAfterSeconds === expected.expireAfterSeconds &&
    isDeepStrictEqual(
      actual.partialFilterExpression,
      expected.partialFilterExpression,
    ) &&
    !actual.sparse &&
    !actual.hidden &&
    !actual.collation
  );
}
async function inspect(db) {
  const marker = await db
    .collection("schema_migrations")
    .findOne({
      version: 10,
      status: "completed",
      checksum: OBJECT_ID_CHECKSUM,
      completed_at: { $type: "date" },
    });
  if (!marker) throw Error("SCHEMA_V10_REQUIRED");
  if (
    await db.collection("schema_migrations").findOne({ version: { $ne: 10 } })
  )
    throw Error("SCHEMA_REPAIR_V10_ONLY");
  const names = (
    await db.listCollections({}, { nameOnly: true }).toArray()
  ).map((row) => row.name);
  if (
    names.length !== Object.keys(OBJECT_ID_SCHEMAS).length ||
    names.some((name) => !OBJECT_ID_SCHEMAS[name])
  )
    throw Error("SCHEMA_COLLECTION_REGISTRY_MISMATCH");
  const repairs = [];
  for (const [name, shape] of Object.entries(OBJECT_ID_SCHEMAS)) {
    const info = await db.listCollections({ name }, { nameOnly: false }).next();
    if (
      await db
        .collection(name)
        .findOne({ $nor: [shape.validator] }, { projection: { _id: 1 } })
    )
      throw Error("SCHEMA_DOCUMENTS_INCOMPATIBLE");
    const indexes = await db.collection(name).listIndexes().toArray();
    const missing = [],
      rebuild = [];
    for (const expected of shape.indexes) {
      const existing = indexes.find((index) => index.name === expected.name);
      if (
        existing &&
        !matchingIndex(existing, expected) &&
        (!isDeepStrictEqual(existing.key, expected.key) ||
          !!existing.unique !== !!expected.unique ||
          existing.sparse ||
          existing.hidden ||
          existing.collation)
      )
        throw Error("SCHEMA_INDEX_CONFLICT");
      if (!matchingIndex(existing, expected)) {
        if (existing) rebuild.push(expected.name);
        if (expected.unique) {
          const duplicate = await db
            .collection(name)
            .aggregate([
              {
                ...(expected.partialFilterExpression
                  ? { $match: expected.partialFilterExpression }
                  : { $match: {} }),
              },
              {
                $group: {
                  _id: Object.fromEntries(
                    Object.keys(expected.key).map((key, i) => [
                      "field" + i,
                      "$" + key,
                    ]),
                  ),
                  count: { $sum: 1 },
                },
              },
              { $match: { count: { $gt: 1 } } },
              { $limit: 1 },
            ])
            .next();
          if (duplicate) throw Error("SCHEMA_UNIQUE_DATA_CONFLICT");
        }
        missing.push(expected.name);
      }
    }
    // Only absent/empty validators from data-only imports may be replaced here.
    const validatorMatches = isDeepStrictEqual(
      info?.options?.validator,
      shape.validator,
    );
    if (
      !validatorMatches &&
      info?.options?.validator &&
      Object.keys(info.options.validator).length
    )
      throw Error("SCHEMA_VALIDATOR_CONFLICT");
    if (
      !validatorMatches ||
      info.options.validationLevel !== "strict" ||
      info.options.validationAction !== "error" ||
      missing.length
    )
      repairs.push({
        collection: name,
        validator:
          !validatorMatches ||
          info.options.validationLevel !== "strict" ||
          info.options.validationAction !== "error",
        indexes: missing,
        rebuild_indexes: rebuild,
      });
  }
  return repairs;
}
async function repair(db, { apply = false } = {}) {
  const repairs = await inspect(db); // Validate every document and all conflicts before the first DDL.
  if (apply) {
    for (const row of repairs) {
      const shape = OBJECT_ID_SCHEMAS[row.collection];
      await changeCollectionOptions(
        db,
        {
          collMod: row.collection,
          validator: shape.validator,
          validationLevel: "strict",
          validationAction: "error",
          maxTimeMS: 15000,
        },
        shape.indexes,
      );
      for (const name of row.rebuild_indexes) {
        const expected = shape.indexes.find((index) => index.name === name);
        const current = (
          await db.collection(row.collection).listIndexes().toArray()
        ).find((index) => index.name === name);
        if (matchingIndex(current, expected)) continue;
        if (
          isDeepStrictEqual(
            current.partialFilterExpression,
            expected.partialFilterExpression,
          ) &&
          expected.expireAfterSeconds !== undefined
        )
          await db.command({
            collMod: row.collection,
            index: { name, expireAfterSeconds: expected.expireAfterSeconds },
            maxTimeMS: 15000,
          });
        else await db.collection(row.collection).dropIndex(name);
      }
      if (row.indexes.length)
        await db.collection(row.collection).createIndexes(
          shape.indexes.filter((index) => row.indexes.includes(index.name)),
          { maxTimeMS: 15000 },
        );
      console.log(
        JSON.stringify({
          event: "schema.metadata.repaired",
          collection: row.collection,
        }),
      );
    }
    await assertObjectIdSchema(db, OBJECT_ID_SCHEMAS, OBJECT_ID_CHECKSUM);
  }
  return { ok: true, applied: apply, repairs };
}
async function main() {
  const args = process.argv.slice(2);
  const apply = args[0] === "--apply";
  if (
    !["--inspect", "--apply"].includes(args[0]) ||
    args[1] !== "--database" ||
    !args[2] ||
    args.length !== 3
  )
    throw Error("SCHEMA_REPAIR_ARGUMENTS_REQUIRED");
  const config = loadConfig();
  if (config.production) throw Error("SCHEMA_REPAIR_NONPRODUCTION_REQUIRED");
  const client = new MongoClient(config.mongoUri, {
    serverSelectionTimeoutMS: 10000,
  });
  try {
    await client.connect();
    const db = client.db();
    if (db.databaseName !== args[2])
      throw Error("SCHEMA_REPAIR_DATABASE_MISMATCH");
    const topology = await assertTopology(db, config);
    if (topology.mode !== "replicaSet")
      throw Error("SCHEMA_REPAIR_REPLICA_SET_REQUIRED");
    console.log(JSON.stringify(await repair(db, { apply })));
  } finally {
    await client.close();
  }
}
module.exports = { repair, inspect };
if (require.main === module)
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, code: safeErrorCode(error) }));
    process.exitCode = 1;
  });
