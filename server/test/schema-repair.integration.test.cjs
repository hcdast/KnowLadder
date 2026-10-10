"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { fixture } = require("./helpers.cjs");
const { repair, inspect } = require("../../ops/schema-repair.cjs");
const { rawDatabase } = require("../dist/database/object-id");
const { BSON, ObjectId } = require("mongodb");
test(
  "copied v10 schema repair preserves documents/checksum and validates all data before DDL",
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t, { app: false });
    const db = rawDatabase(f.db);
    const before = BSON.serialize({
      rows: await db.collection("roles").find({}).sort({ code: 1 }).toArray(),
      marker: await db.collection("schema_migrations").findOne({ version: 10 }),
    });
    await db.command({ collMod: "users", validator: {} });
    await db.collection("auth_sessions").dropIndex("auth_sessions_expires_ttl");
    await db
      .collection("auth_sessions")
      .createIndex({ expires_at: 1 }, { name: "auth_sessions_expires_ttl" });
    const partial =
      require("../dist/migrations/schema").OBJECT_ID_SCHEMAS.class_members.indexes.find(
        (i) => i.name === "class_members_active",
      );
    await db.collection("class_members").dropIndex(partial.name);
    await db
      .collection("class_members")
      .createIndex(partial.key, {
        ...partial,
        partialFilterExpression: { status: {} },
      });
    const bad = new ObjectId();
    await db.collection("users").insertOne({ _id: bad, bad: true });
    await assert.rejects(
      repair(db, { apply: true }),
      /SCHEMA_DOCUMENTS_INCOMPATIBLE/,
    );
    assert.equal(
      (await db.collection("auth_sessions").listIndexes().toArray()).find(
        (i) => i.name === "auth_sessions_expires_ttl",
      ).expireAfterSeconds,
      undefined,
      "validation fails before any index is repaired",
    );
    await db.collection("users").deleteOne({ _id: bad });
    assert.equal((await inspect(db)).length, 3);
    const result = await repair(db, { apply: true });
    assert.equal(result.applied, true);
    assert.deepEqual(await inspect(db), []);
    assert.deepEqual(
      BSON.serialize({
        rows: await db.collection("roles").find({}).sort({ code: 1 }).toArray(),
        marker: await db
          .collection("schema_migrations")
          .findOne({ version: 10 }),
      }),
      before,
      "documents and completed migration marker remain byte-identical",
    );
    await db.command({
      collMod: "users",
      validator: { _id: { $type: "objectId" } },
    });
    await assert.rejects(
      repair(db, { apply: true }),
      /SCHEMA_VALIDATOR_CONFLICT/,
    );
  },
);
