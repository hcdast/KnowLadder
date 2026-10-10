"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { fixture } = require("./helpers.cjs");
const { rawDatabase } = require("../dist/database/object-id");
const { rebuildCollection } = require("../dist/migrations/collection-options");
const { BSON } = require("mongodb");
const {
  OBJECT_ID_SCHEMAS,
  OBJECT_ID_CHECKSUM,
} = require("../dist/migrations/schema");
const { assertObjectIdSchema } = require("../dist/migrations/object-id-v10");
const snapshot = async (db) =>
  BSON.serialize({
    roles: await db.collection("roles").find({}).sort({ _id: 1 }).toArray(),
    marker: await db.collection("schema_migrations").findOne({ version: 10 }),
  });
test(
  "offline collection rebuild preserves BSON/markers, aborts races and never drops original on a copy fault",
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t, {
        app: false,
        env: {
          KL_MONGO_ALLOW_COLLECTION_REBUILD: "true",
          KL_SCHEMA_REBUILD_OFFLINE: "true",
        },
      }),
      db = rawDatabase(f.db);
    const shape = OBJECT_ID_SCHEMAS.roles,
      command = {
        collMod: "roles",
        validator: shape.validator,
        validationLevel: "strict",
        validationAction: "error",
      };
    const before = await snapshot(db);
    await rebuildCollection(db, command, shape.indexes);
    assert.deepEqual(await snapshot(db), before);
    await assertObjectIdSchema(db, OBJECT_ID_SCHEMAS, OBJECT_ID_CHECKSUM);
    await assert.rejects(
      rebuildCollection(db, command, shape.indexes, async () => {
        throw Error("TEST_COPY_ABORT");
      }),
      /TEST_COPY_ABORT/,
    );
    assert.deepEqual(await snapshot(db), before);
    await db
      .collection("operational_state")
      .updateOne(
        { key: "environment" },
        {
          $set: {
            revision: BSON.Long.fromNumber(2),
            access_fence: new BSON.Double(0),
          },
        },
      );
    const numericBefore = await db
      .collection("operational_state")
      .findOne(
        { key: "environment" },
        { promoteValues: false, promoteLongs: false },
      );
    await rebuildCollection(
      db,
      {
        collMod: "operational_state",
        validator: OBJECT_ID_SCHEMAS.operational_state.validator,
        validationLevel: "strict",
        validationAction: "error",
      },
      OBJECT_ID_SCHEMAS.operational_state.indexes,
    );
    const numericAfter = await db
      .collection("operational_state")
      .findOne(
        { key: "environment" },
        { promoteValues: false, promoteLongs: false },
      );
    assert.deepEqual(
      BSON.serialize(numericAfter),
      BSON.serialize(numericBefore),
      "safe Long and integral Double retain exact BSON types",
    );
    const guard = await db
      .collection("administration_guard")
      .findOne({ key: "administration" });
    const guardShape = OBJECT_ID_SCHEMAS.administration_guard;
    await assert.rejects(
      rebuildCollection(
        db,
        {
          collMod: "administration_guard",
          validator: guardShape.validator,
          validationLevel: "strict",
          validationAction: "error",
        },
        guardShape.indexes,
        async () => {
          await db
            .collection("administration_guard")
            .updateOne({ _id: guard._id }, { $inc: { revision: 1 } });
        },
      ),
      /SCHEMA_REBUILD_SOURCE_CHANGED/,
    );
    assert.equal(
      (await db.collection("administration_guard").findOne({ _id: guard._id }))
        .revision,
      guard.revision + 1,
      "concurrent source edit is preserved",
    );
    assert.equal(
      (await db.listCollections({}, { nameOnly: true }).toArray()).filter(
        (row) => row.name.startsWith("_kl_rebuild_"),
      ).length,
      0,
    );
    process.env.KL_SCHEMA_REBUILD_OFFLINE = "false";
    await assert.rejects(
      rebuildCollection(db, command, shape.indexes),
      /SCHEMA_REBUILD_OFFLINE_REQUIRED/,
    );
  },
);
