import { PROVENANCE_CHECKSUM } from "./import-provenance-schema";
import { createHash, randomUUID } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import { isDeepStrictEqual } from "node:util";
import { rawDatabase } from "../database/object-id";
import type { Schema } from "./schema";
const id = { bsonType: "objectId" },
  date = { bsonType: "date" },
  num = {
    bsonType: ["int", "long", "double"],
    minimum: 1,
    multipleOf: 1,
    maximum: Number.MAX_SAFE_INTEGER,
  };
const text = (maxLength: number) => ({
  bsonType: "string",
  minLength: 1,
  maxLength,
});
const strict = (
  properties: Record<string, unknown>,
  indexes: Schema["indexes"],
): Schema => ({
  validator: {
    $jsonSchema: {
      bsonType: "object",
      additionalProperties: false,
      required: Object.keys(properties),
      properties,
    },
  },
  indexes,
});
const base = {
  _id: id,
  org_id: id,
  revision: num,
  created_at: date,
  updated_at: date,
};
const question = {
  bsonType: "object",
  additionalProperties: false,
  required: ["id", "title", "required", "kind", "options"],
  properties: {
    id: { ...text(64), pattern: "^[A-Za-z0-9_-]+$" },
    title: text(500),
    required: { bsonType: "bool" },
    kind: { enum: ["choice", "rating", "text"] },
    options: {
      bsonType: "array",
      maxItems: 10,
      items: {
        bsonType: "object",
        additionalProperties: false,
        required: ["id", "title"],
        properties: {
          id: { ...text(64), pattern: "^[A-Za-z0-9_-]+$" },
          title: text(120),
        },
      },
    },
  },
};
export const SURVEY_CHANGED = ["training_surveys", "training_survey_responses"];
export function surveySchemas(
  previous: Record<string, Schema>,
): Record<string, Schema> {
  return {
    ...previous,
    training_surveys: strict(
      {
        ...base,
        course_id: id,
        title: text(120),
        questions: {
          bsonType: "array",
          minItems: 1,
          maxItems: 20,
          items: question,
        },
        published_revision: { ...num, minimum: 0 },
        status: { enum: ["draft", "open", "closed"] },
        opens_at: date,
        closes_at: date,
      },
      [{ name: "survey_course", key: { org_id: 1, course_id: 1, _id: 1 } }],
    ),
    training_survey_responses: strict(
      {
        ...base,
        survey_id: id,
        course_id: id,
        user_id: id,
        member_id: id,
        frozen_revision: num,
        answers: {
          bsonType: "array",
          maxItems: 20,
          items: {
            bsonType: "object",
            additionalProperties: false,
            required: ["question_id", "value"],
            properties: {
              question_id: { ...text(64), pattern: "^[A-Za-z0-9_-]+$" },
              value: {
                anyOf: [
                  { bsonType: "string", maxLength: 1000 },
                  {
                    bsonType: ["int", "long", "double"],
                    minimum: 1,
                    maximum: 5,
                    multipleOf: 1,
                  },
                ],
              },
            },
          },
        },
        submitted_at: date,
      },
      [
        {
          name: "survey_one_response",
          key: { org_id: 1, survey_id: 1, user_id: 1 },
          unique: true,
        },
        {
          name: "survey_response_page",
          key: { org_id: 1, survey_id: 1, _id: 1 },
        },
      ],
    ),
  };
}
export const SURVEY_CHECKSUM = createHash("sha256")
  .update(
    JSON.stringify({
      version: 20,
      policy: "named-course-feedback-v1",
      schemas: surveySchemas({}),
    }),
  )
  .digest("hex");
export async function migrateSurveys(db: Db, previous: Record<string, Schema>) {
  db = rawDatabase(db);
  if (process.env.NODE_ENV === "production")
    throw Error("Survey is not approved for production");
  if (await db.collection("operational_writers").findOne({ state: "running" }))
    throw Error("Training migration requires stopped writers");
  if (!(await db.admin().command({ hello: 1 })).setName)
    throw Error("Training migration requires replicaSet");
  const prior = await db
    .collection("schema_migrations")
    .findOne({ version: 19, status: "completed", checksum: PROVENANCE_CHECKSUM });
  if (!prior) throw Error("Survey migration requires completed v19");
  const old = await db.collection("schema_migrations").findOne({ version: 20 });
  if (old && old.checksum !== SURVEY_CHECKSUM)
    throw Error("Training migration checksum differs");
  const token = randomUUID(),
    now = new Date();
  if (!old)
    await db.collection("schema_migrations").insertOne({
      _id: new ObjectId(),
      version: 20,
      checksum: SURVEY_CHECKSUM,
      status: "pending",
      lease_token: null,
      lease_until: null,
      created_at: now,
      started_at: null,
      completed_at: null,
      failed_at: null,
    });
  if (old?.status === "completed") return;
  const held = await db.collection("schema_migrations").findOneAndUpdate(
    {
      version: 20,
      checksum: SURVEY_CHECKSUM,
      status: { $ne: "completed" },
      $or: [{ lease_until: null }, { lease_until: { $lte: now } }],
    },
    {
      $set: {
        status: "running",
        lease_token: token,
        lease_until: new Date(Date.now() + 120000),
        started_at: now,
        failed_at: null,
      },
    },
    { returnDocument: "after" },
  );
  if (!held) throw Error("Training migration lease busy");
  const renew = async () => {
    if (
      (
        await db.collection("schema_migrations").updateOne(
          {
            version: 20,
            status: "running",
            lease_token: token,
            lease_until: { $gt: new Date() },
          },
          { $set: { lease_until: new Date(Date.now() + 120000) } },
        )
      ).matchedCount !== 1
    )
      throw Error("Training migration lease lost");
  };
  try {
    for (const [name, schema] of Object.entries(surveySchemas(previous))) {
      if (!SURVEY_CHANGED.includes(name)) continue;
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
      )
        throw Error("Training schema drift:" + name);
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
    if (
      (
        await db.collection("schema_migrations").updateOne(
          { version: 20, status: "running", lease_token: token },
          {
            $set: {
              status: "completed",
              completed_at: new Date(),
              lease_token: null,
              lease_until: null,
            },
          },
        )
      ).modifiedCount !== 1
    )
      throw Error("Training migration lease lost");
  } catch (e) {
    await db.collection("schema_migrations").updateOne(
      { version: 20, status: "running", lease_token: token },
      {
        $set: {
          status: "failed",
          failed_at: new Date(),
          lease_token: null,
          lease_until: null,
        },
      },
    );
    throw e;
  }
}
