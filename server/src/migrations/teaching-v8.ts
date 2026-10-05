import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Db, Document, IndexDescription } from "mongodb";
import { ASSESSMENT_V4_SCHEMAS } from "./assessment-v4";
import { LEARNING_V5_SCHEMAS } from "./learning-v5";
import { inspectVersion7 } from "./privacy-v7";
// v8 validators and checksum describe the installed historical catalog, not the current IAM catalog.
const V8_CONTROLLED_CAPABILITIES = ["content:retire", "content:revoke", "file:delete", "assessment:manage", "assessment:review", "teaching:roster", "teaching:assign", "teaching:report"] as const;
const V8_ROLE_CAPABILITIES = {
  student: ["account:read", "learning:self"],
  teacher: ["account:read", "teaching:class"],
  content_editor: ["account:read", "content:edit"],
  content_reviewer: ["account:read", "content:review"],
  org_admin: ["account:read", "organization:admin"],
  platform_ops: ["account:read", "operations:health"],
} as const;


const uuid = {
  bsonType: "string",
  pattern:
    "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
};
const text = (max = 200, min = 1) => ({
  bsonType: "string",
  minLength: min,
  maxLength: max,
});
const integer = (min = 0, max = Number.MAX_SAFE_INTEGER) => ({
  bsonType: ["int", "long", "double"],
  minimum: min,
  maximum: max,
  multipleOf: 1,
});
const date = { bsonType: "date" };
const nullable = (shape: Document) => ({ anyOf: [shape, { bsonType: "null" }] });
const object = (properties: Document, required = Object.keys(properties)) => ({
  bsonType: "object",
  additionalProperties: false,
  required,
  properties,
});
interface Schema {
  validator: Document;
  indexes: IndexDescription[];
}
const base = { _id: uuid, org_id: uuid, created_at: date, updated_at: date };
function schema(
  fields: Document,
  indexes: IndexDescription[],
  expressions: Document[] = [],
): Schema {
  return {
    validator: {
      $and: [
        { $jsonSchema: object({ ...base, ...fields }) },
        {
          $expr: {
            $and: [{ $lte: ["$created_at", "$updated_at"] }, ...expressions],
          },
        },
      ],
    },
    indexes,
  };
}
function unique(name: string, ...fields: string[]): IndexDescription {
  return {
    key: Object.fromEntries(["org_id", ...fields].map((field) => [field, 1])),
    name,
    unique: true,
  };
}
function page(name: string, key: Record<string, 1 | -1>): IndexDescription {
  return { name, key };
}
const validity = [
  {
    $or: [
      { $eq: ["$valid_from", null] },
      { $eq: ["$valid_to", null] },
      { $lte: ["$valid_from", "$valid_to"] },
    ],
  },
];
const ROLE_CODES = Object.keys(V8_ROLE_CAPABILITIES);
const ROLE = { bsonType: "string", enum: ROLE_CODES };

export const TEACHING_V8_SCHEMAS: Record<string, Schema> = {
  classes: schema(
    {
      name: text(200),
      year_label: text(64),
      status: { enum: ["active", "archived"] },
      revision: integer(1),
      created_by: uuid,
    },
    [
      page("classes_org_status", { org_id: 1, status: 1, _id: 1 }),
      page("classes_org_year", { org_id: 1, year_label: 1, _id: 1 }),
    ],
  ),
  class_members: schema(
    {
      class_id: uuid,
      member_id: uuid,
      kind: { enum: ["student"] },
      status: { enum: ["active", "ended"] },
      valid_from: nullable(date),
      valid_to: nullable(date),
    },
    [
      {
        ...unique("class_members_active", "class_id", "member_id"),
        partialFilterExpression: { status: "active" },
      },
      page("class_members_member_status", {
        org_id: 1,
        member_id: 1,
        status: 1,
        _id: 1,
      }),
      page("class_members_class_status", {
        org_id: 1,
        class_id: 1,
        status: 1,
        _id: 1,
      }),
    ],
    validity,
  ),
  teaching_assignments: schema(
    {
      class_id: uuid,
      member_id: uuid,
      subject_id: uuid,
      status: { enum: ["active", "ended"] },
      valid_from: nullable(date),
      valid_to: nullable(date),
      revision: integer(1),
    },
    [
      {
        ...unique(
          "teaching_assignments_active",
          "class_id",
          "member_id",
          "subject_id",
        ),
        partialFilterExpression: { status: "active" },
      },
      page("teaching_assignments_member_status", {
        org_id: 1,
        member_id: 1,
        status: 1,
        _id: 1,
      }),
      page("teaching_assignments_class_status", {
        org_id: 1,
        class_id: 1,
        status: 1,
        _id: 1,
      }),
    ],
    validity,
  ),
  roles: {
    validator: {
      $and: [
        {
          $jsonSchema: {
            ...object({
              _id: ROLE,
              code: ROLE,
              capabilities: {
                bsonType: "array",
                uniqueItems: true,
                items: {
                  bsonType: "string",
                  enum: [...new Set(Object.values(V8_ROLE_CAPABILITIES).flat())],
                },
              },
            }),
            oneOf: Object.entries(V8_ROLE_CAPABILITIES).map(([code, capabilities]) => ({
              properties: {
                code: { enum: [code] },
                capabilities: { enum: [capabilities] },
              },
            })),
          },
        },
        { $expr: { $eq: ["$_id", "$code"] } },
      ],
    },
    indexes: [{ key: { code: 1 }, name: "roles_code_unique", unique: true }],
  },
  member_roles: {
    validator: {
      $jsonSchema: object({
        _id: uuid,
        org_id: uuid,
        member_id: uuid,
        role_id: ROLE,
      }),
    },
    indexes: [
      {
        key: { org_id: 1, member_id: 1, role_id: 1 },
        name: "member_roles_org_member_role_unique",
        unique: true,
      },
    ],
  },
};

TEACHING_V8_SCHEMAS.member_capability_grants = structuredClone(
  ASSESSMENT_V4_SCHEMAS.member_capability_grants,
);
TEACHING_V8_SCHEMAS.member_capability_grants.validator.$jsonSchema.properties.capability.enum =
  [...V8_CONTROLLED_CAPABILITIES];

TEACHING_V8_SCHEMAS.audit_events = structuredClone(LEARNING_V5_SCHEMAS.audit_events);
TEACHING_V8_SCHEMAS.audit_events.validator.$jsonSchema.properties.resource_type.enum.push(
  "class",
  "teaching_assignment",
);

TEACHING_V8_SCHEMAS.quizzes = structuredClone(ASSESSMENT_V4_SCHEMAS.quizzes);
TEACHING_V8_SCHEMAS.quizzes.validator.$and[0].$jsonSchema.properties.source_class_ids = {
  bsonType: "array",
  items: uuid,
  minItems: 0,
  maxItems: 5,
  uniqueItems: true,
};

export const TEACHING_V8_CHECKSUM = createHash("sha256")
  .update(JSON.stringify({ version: 8, schemas: TEACHING_V8_SCHEMAS }))
  .digest("hex");

/** Read-only counts for teaching collections; never writes markers or role seeds. */
export async function inspectVersion8(
  db: Db,
  schemas: Record<string, Schema>,
  known: Record<string, Schema>,
) {
  const report = await inspectVersion7(db, schemas, known);
  const options = { maxTimeMS: 15000 };
  const collections = await db
    .listCollections({}, { ...options, nameOnly: false })
    .toArray();
  const names = new Set(collections.map((row) => row.name));
  const teaching = Object.fromEntries(
    Object.entries(TEACHING_V8_SCHEMAS).filter(([name]) =>
      ["classes", "class_members", "teaching_assignments"].includes(name),
    ),
  );
  let invalid_indexes = report.invalid_indexes ?? 0;
  for (const [name, schema] of Object.entries(teaching)) {
    const [invalid] = await db
      .collection(name)
      .aggregate(
        [{ $match: { $nor: [schema.validator] } }, { $count: "n" }],
        options,
      )
      .toArray();
    report.collections[name] = {
      documents: await db.collection(name).countDocuments({}, options),
      needs_defaults: 0,
      invalid_types: invalid?.n ?? 0,
    };
    const indexes = names.has(name)
      ? await db.collection(name).listIndexes(options).toArray()
      : [];
    report.indexes[name] = indexes.map((index) => index.name!);
    for (const actual of indexes) {
      if (actual.name === "_id_") continue;
      const expected = schema.indexes.find((index) => index.name === actual.name);
      if (
        !expected ||
        JSON.stringify(actual.key) !== JSON.stringify(expected.key) ||
        Boolean(actual.unique) !== Boolean(expected.unique) ||
        actual.expireAfterSeconds !== expected.expireAfterSeconds ||
        actual.sparse ||
        actual.hidden ||
        actual.collation ||
        !isDeepStrictEqual(
          actual.partialFilterExpression,
          expected.partialFilterExpression,
        )
      )
        invalid_indexes++;
    }
    for (const index of schema.indexes)
      if (index.unique) {
        const [duplicates] = await db
          .collection(name)
          .aggregate(
            [
              ...(index.partialFilterExpression
                ? [{ $match: index.partialFilterExpression }]
                : []),
              {
                $group: {
                  _id: Object.fromEntries(
                    Object.keys(index.key).map((field, i) => [
                      `k${i}`,
                      `$${field}`,
                    ]),
                  ),
                  n: { $sum: 1 },
                },
              },
              { $match: { n: { $gt: 1 } } },
              { $count: "n" },
            ],
            options,
          )
          .toArray();
        report.duplicate_keys += duplicates?.n ?? 0;
      }
  }
  return {
    ...report,
    target_version: 8,
    invalid_indexes,
    new_collections: [
      ...report.new_collections,
      ...Object.keys(teaching).filter((name) => !names.has(name)),
    ],
  };
}
