import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  MongoClient,
  MongoServerError,
  type Db,
  type Document,
  type IndexDescription,
} from "mongodb";
import { ROLE_CAPABILITIES } from "../database/contracts";
import { CONTENT_SCHEMAS, CONTENT_SCHEMA_CHECKSUM } from "./content-schema";
import { CONTENT_V3_SCHEMAS, CONTENT_V3_CHECKSUM, V3_DEFAULTS, withVersion3Defaults, assertImpactSafe } from "./content-v3";
import { ASSESSMENT_V4_SCHEMAS, ASSESSMENT_V4_CHECKSUM } from "./assessment-v4";
import { LEARNING_V5_SCHEMAS, LEARNING_V5_CHECKSUM, inspectVersion5 } from "./learning-v5";
import { LEARNING_API_V6_SCHEMAS, LEARNING_API_V6_CHECKSUM } from "./learning-api-v6";
import { privacyVersion7, inspectVersion7 } from "./privacy-v7";
import { acquireWriter } from "../operations/control";

export const CURRENT_SCHEMA_VERSION = 7;

const VERSION = 1;
const LEASE_MS = 120_000;
const COMMAND_MS = 15_000;
const WRITE_CONCERN = { w: "majority" as const, wtimeoutMS: COMMAND_MS };
const UUID = {
  bsonType: "string",
  pattern:
    "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
};
const TEXT = { bsonType: "string", minLength: 1 };
const DATE = { bsonType: "date" };
const NULL_DATE = { bsonType: ["date", "null"] };
const COUNTER = {
  bsonType: ["int", "long", "double"],
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
  multipleOf: 1,
};
const ROLE_CODES = Object.keys(ROLE_CAPABILITIES);
const ROLE = { bsonType: "string", enum: ROLE_CODES };
const STATUS = { bsonType: "string", enum: ["active", "disabled"] };

interface CollectionSchema {
  validator: Document;
  indexes: IndexDescription[];
}

function validator(
  properties: Document,
  expressions: Document[] = [],
  alternatives?: Document[],
): Document {
  const schema: Document = {
    bsonType: "object",
    required: Object.keys(properties),
    additionalProperties: false,
    properties,
  };
  if (alternatives) schema.oneOf = alternatives;
  return expressions.length
    ? { $and: [{ $jsonSchema: schema }, { $expr: { $and: expressions } }] }
    : { $jsonSchema: schema };
}

const createdBeforeUpdated = { $lte: ["$created_at", "$updated_at"] };
const schemas: Record<string, CollectionSchema> = {
  users: {
    validator: validator(
      {
        _id: UUID,
        login_key: { bsonType: "string", pattern: "^[a-z0-9_-]{3,64}$" },
        display_name: TEXT,
        status: STATUS,
        password_hash: { bsonType: "string", pattern: "^\\$argon2id\\$" },
        credential_version: { ...COUNTER, minimum: 1 },
        identity_revision: COUNTER,
        must_change_password: { bsonType: "bool" },
        temporary_password_expires_at: NULL_DATE,
        password_changed_at: DATE,
        created_at: DATE,
        updated_at: DATE,
      },
      [
        createdBeforeUpdated,
        { $lte: ["$created_at", "$password_changed_at"] },
        { $lte: ["$password_changed_at", "$updated_at"] },
        {
          $cond: [
            "$must_change_password",
            {
              $and: [
                { $ne: ["$temporary_password_expires_at", null] },
                {
                  $or: [
                    { $eq: ["$status", "disabled"] },
                    {
                      $gt: [
                        "$temporary_password_expires_at",
                        "$password_changed_at",
                      ],
                    },
                  ],
                },
              ],
            },
            { $eq: ["$temporary_password_expires_at", null] },
          ],
        },
      ],
    ),
    indexes: [
      { key: { login_key: 1 }, name: "users_login_key_unique", unique: true },
    ],
  },
  organizations: {
    validator: validator(
      {
        _id: UUID,
        name: TEXT,
        kind: { bsonType: "string", enum: ["school", "personal", "platform"] },
        status: STATUS,
        created_at: DATE,
        updated_at: DATE,
      },
      [createdBeforeUpdated],
    ),
    indexes: [],
  },
  organization_members: {
    validator: validator(
      {
        _id: UUID,
        org_id: UUID,
        user_id: UUID,
        status: STATUS,
        authorization_revision: COUNTER,
        created_at: DATE,
        updated_at: DATE,
      },
      [createdBeforeUpdated],
    ),
    indexes: [
      {
        key: { org_id: 1, user_id: 1 },
        name: "organization_members_org_user_unique",
        unique: true,
      },
      {
        key: { user_id: 1, status: 1 },
        name: "organization_members_user_status",
      },
    ],
  },
  roles: {
    validator: validator(
      {
        _id: ROLE,
        code: ROLE,
        capabilities: {
          bsonType: "array",
          uniqueItems: true,
          items: {
            bsonType: "string",
            enum: [...new Set(Object.values(ROLE_CAPABILITIES).flat())],
          },
        },
      },
      [{ $eq: ["$_id", "$code"] }],
      Object.entries(ROLE_CAPABILITIES).map(([code, capabilities]) => ({
        properties: {
          code: { enum: [code] },
          capabilities: { enum: [capabilities] },
        },
      })),
    ),
    indexes: [{ key: { code: 1 }, name: "roles_code_unique", unique: true }],
  },
  member_roles: {
    validator: validator({
      _id: UUID,
      org_id: UUID,
      member_id: UUID,
      role_id: ROLE,
    }),
    indexes: [
      {
        key: { org_id: 1, member_id: 1, role_id: 1 },
        name: "member_roles_org_member_role_unique",
        unique: true,
      },
    ],
  },
  auth_sessions: {
    validator: validator(
      {
        _id: UUID,
        token_hash: { bsonType: "string", pattern: "^[0-9a-f]{64}$" },
        kind: { bsonType: "string", enum: ["preauth", "authenticated"] },
        user_id: { anyOf: [UUID, { bsonType: "null" }] },
        credential_version: {
          anyOf: [{ ...COUNTER, minimum: 1 }, { bsonType: "null" }],
        },
        csrf_token: { bsonType: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
        created_at: DATE,
        last_seen_at: DATE,
        idle_expires_at: DATE,
        absolute_expires_at: DATE,
        expires_at: DATE,
        revoked_at: NULL_DATE,
      },
      [
        { $lte: ["$created_at", "$last_seen_at"] },
        { $lt: ["$last_seen_at", "$idle_expires_at"] },
        { $lte: ["$idle_expires_at", "$absolute_expires_at"] },
        {
          $eq: [
            "$expires_at",
            { $min: ["$idle_expires_at", "$absolute_expires_at"] },
          ],
        },
        {
          $or: [
            { $eq: ["$revoked_at", null] },
            { $gte: ["$revoked_at", "$created_at"] },
          ],
        },
      ],
      [
        {
          properties: {
            kind: { enum: ["preauth"] },
            user_id: { bsonType: "null" },
            credential_version: { bsonType: "null" },
          },
        },
        {
          properties: {
            kind: { enum: ["authenticated"] },
            user_id: UUID,
            credential_version: { ...COUNTER, minimum: 1 },
          },
        },
      ],
    ),
    indexes: [
      {
        key: { token_hash: 1 },
        name: "auth_sessions_token_hash_unique",
        unique: true,
      },
      {
        key: { user_id: 1, revoked_at: 1 },
        name: "auth_sessions_user_revoked",
      },
      {
        key: { expires_at: 1 },
        name: "auth_sessions_expires_ttl",
        expireAfterSeconds: 0,
      },
    ],
  },
  auth_rate_limits: {
    validator: validator(
      {
        _id: { bsonType: "string", pattern: "^[0-9a-f]{64}$" },
        count: COUNTER,
        window_start: DATE,
        expires_at: DATE,
      },
      [{ $lt: ["$window_start", "$expires_at"] }],
    ),
    indexes: [
      {
        key: { expires_at: 1 },
        name: "auth_rate_limits_expires_ttl",
        expireAfterSeconds: 0,
      },
    ],
  },
  audit_events: {
    validator: validator({
      _id: UUID,
      actor_id: TEXT,
      org_id: { anyOf: [UUID, { bsonType: "null" }] },
      action: TEXT,
      resource_id: TEXT,
      reason: TEXT,
      request_id: UUID,
      created_at: DATE,
    }),
    indexes: [
      { key: { org_id: 1, created_at: -1 }, name: "audit_events_org_created" },
      {
        key: { actor_id: 1, created_at: -1 },
        name: "audit_events_actor_created",
      },
      { key: { request_id: 1 }, name: "audit_events_request" },
    ],
  },
};

const migrationSchema: CollectionSchema = {
  validator: validator(
    {
      _id: UUID,
      version: { ...COUNTER, minimum: 1 },
      checksum: { bsonType: "string", pattern: "^[0-9a-f]{64}$" },
      status: {
        bsonType: "string",
        enum: ["pending", "running", "failed", "completed"],
      },
      lease_token: { anyOf: [UUID, { bsonType: "null" }] },
      lease_until: NULL_DATE,
      created_at: DATE,
      started_at: NULL_DATE,
      completed_at: NULL_DATE,
      failed_at: NULL_DATE,
    },
    [],
    [
      {
        properties: {
          status: { enum: ["pending"] },
          lease_token: { bsonType: "null" },
          lease_until: { bsonType: "null" },
          completed_at: { bsonType: "null" },
        },
      },
      {
        properties: {
          status: { enum: ["running"] },
          lease_token: UUID,
          lease_until: DATE,
          started_at: DATE,
          completed_at: { bsonType: "null" },
        },
      },
      {
        properties: {
          status: { enum: ["failed"] },
          lease_token: { bsonType: "null" },
          lease_until: { bsonType: "null" },
          completed_at: { bsonType: "null" },
          failed_at: DATE,
        },
      },
      {
        properties: {
          status: { enum: ["completed"] },
          lease_token: { bsonType: "null" },
          lease_until: { bsonType: "null" },
          completed_at: DATE,
        },
      },
    ],
  ),
  indexes: [
    {
      key: { version: 1 },
      name: "schema_migrations_version_unique",
      unique: true,
    },
  ],
};

// A migration's data contract is immutable; future changes require a new version.
const CHECKSUM = createHash("sha256")
  .update(
    JSON.stringify({
      version: VERSION,
      schemas,
      migrationSchema,
      roles: ROLE_CAPABILITIES,
    }),
  )
  .digest("hex");

const { schemas: PRIVACY_SCHEMAS, checksum: PRIVACY_V7_CHECKSUM } = privacyVersion7(schemas.users);
export { PRIVACY_V7_CHECKSUM };
const CURRENT_SCHEMAS = { ...schemas, ...CONTENT_SCHEMAS, ...CONTENT_V3_SCHEMAS, ...ASSESSMENT_V4_SCHEMAS, ...LEARNING_V5_SCHEMAS, ...LEARNING_API_V6_SCHEMAS, ...PRIVACY_SCHEMAS, schema_migrations: migrationSchema };
export function systemBackupRegistry() {
  return { version: CURRENT_SCHEMA_VERSION, collections: Object.keys(CURRENT_SCHEMAS).filter(name => !["auth_sessions", "auth_rate_limits"].includes(name)), excluded: ["auth_sessions", "auth_rate_limits"], checksums: { "1": CHECKSUM, "2": CONTENT_SCHEMA_CHECKSUM, "3": CONTENT_V3_CHECKSUM, "4": ASSESSMENT_V4_CHECKSUM, "5": LEARNING_V5_CHECKSUM, "6": LEARNING_API_V6_CHECKSUM, "7": PRIVACY_V7_CHECKSUM } };
}

/** Empty restore targets only. No markers, epochs, role catalog or state seeds. */
export async function initializeRestoreSchema(db: Db): Promise<void> {
  await assertReplicaSet(db);
  if ((await db.listCollections({}, { nameOnly: true, maxTimeMS: COMMAND_MS }).toArray()).length) throw new Error("Restore target must be empty");
  for (const [name, schema] of Object.entries(CURRENT_SCHEMAS)) await ensureCollection(db, name, schema, async () => {});
}

async function assertReplicaSet(db: Db): Promise<void> {
  const hello = await db
    .admin()
    .command(
      { hello: 1, maxTimeMS: COMMAND_MS },
      { readPreference: "primary" },
    );
  if (
    typeof hello.setName !== "string" ||
    !hello.isWritablePrimary ||
    hello.logicalSessionTimeoutMinutes == null
  )
    throw new Error("MongoDB writable replica set is required");
}

async function ensureCollection(
  db: Db,
  name: string,
  schema: CollectionSchema,
  beforeCommand: () => Promise<void>,
): Promise<void> {
  await beforeCommand();
  try {
    await db.createCollection(name, {
      validator: schema.validator,
      validationLevel: "strict",
      validationAction: "error",
      writeConcern: WRITE_CONCERN,
      maxTimeMS: COMMAND_MS,
    });
  } catch (error) {
    if (!(error instanceof MongoServerError) || error.code !== 48) throw error;
    await beforeCommand();
    await db.command({
      collMod: name,
      validator: schema.validator,
      validationLevel: "strict",
      validationAction: "error",
      writeConcern: { w: "majority", wtimeout: COMMAND_MS },
      maxTimeMS: COMMAND_MS,
    });
  }
  // collMod does not retroactively validate existing data. Never certify a dirty collection.
  await beforeCommand();
  if (
    await db
      .collection(name)
      .findOne(
        { $nor: [schema.validator] },
        { projection: { _id: 1 }, maxTimeMS: COMMAND_MS },
      )
  )
    throw new Error(`Invalid existing documents in ${name}`);
  if (schema.indexes.length) {
    await beforeCommand();
    await db
      .collection(name, { writeConcern: WRITE_CONCERN })
      .createIndexes(schema.indexes, { maxTimeMS: COMMAND_MS });
  }
}

async function assertCollection(
  db: Db,
  name: string,
  schema: CollectionSchema,
): Promise<void> {
  const info = await db
    .listCollections({ name }, { nameOnly: false, maxTimeMS: COMMAND_MS })
    .next();
  if (
    !info ||
    info.type !== "collection" ||
    info.options?.validationLevel !== "strict" ||
    info.options?.validationAction !== "error" ||
    !isDeepStrictEqual(info.options.validator, schema.validator) ||
    info.options.collation
  )
    throw new Error(`Schema mismatch in ${name}`);
  const indexes = await db
    .collection(name)
    .listIndexes({ maxTimeMS: COMMAND_MS })
    .toArray();
  for (const expected of schema.indexes) {
    const actual = indexes.find((index) => index.name === expected.name);
    if (
      !actual ||
      JSON.stringify(actual.key) !== JSON.stringify(expected.key) ||
      Boolean(actual.unique) !== Boolean(expected.unique) ||
      actual.expireAfterSeconds !== expected.expireAfterSeconds ||
      actual.sparse ||
      actual.hidden ||
      !isDeepStrictEqual(actual.partialFilterExpression, expected.partialFilterExpression) ||
      actual.collation
    )
      throw new Error(`Required index mismatch in ${name}`);
  }
}

async function assertEffectiveCollection(db: Db, name: string, schema: CollectionSchema, version: number): Promise<void> {
  for (const [newerVersion, checksum, definitions] of [
    [7, PRIVACY_V7_CHECKSUM, PRIVACY_SCHEMAS],
    [6, LEARNING_API_V6_CHECKSUM, LEARNING_API_V6_SCHEMAS],
    [5, LEARNING_V5_CHECKSUM, LEARNING_V5_SCHEMAS],
    [4, ASSESSMENT_V4_CHECKSUM, ASSESSMENT_V4_SCHEMAS],
    [3, CONTENT_V3_CHECKSUM, CONTENT_V3_SCHEMAS],
  ] as const) {
    if (newerVersion <= version || !definitions[name]) continue;
    const marker = await db.collection("schema_migrations").findOne({ version: newerVersion });
    if (!marker) continue;
    if (marker.checksum !== checksum) throw new Error("Migration checksum mismatch");
    if (marker.status === "completed") return assertCollection(db, name, definitions[name]);
    // During resumable DDL, validator may be new while indexes are still old.
    try { await assertCollection(db, name, { validator: definitions[name].validator, indexes: schema.indexes }); return; }
    catch { /* Try the previous contract, without modifying either validator. */ }
  }
  await assertCollection(db, name, schema);
}

/** Read-only readiness check. The caller may cache success briefly, never authorization. */
export async function assertSchemaVersion1(db: Db): Promise<void> {
  await assertReplicaSet(db);
  await assertCollection(db, "schema_migrations", migrationSchema);
  const migration = await db
    .collection("schema_migrations")
    .findOne(
      { version: VERSION },
      {
        readPreference: "primary",
        readConcern: { level: "majority" },
        maxTimeMS: COMMAND_MS,
      },
    );
  if (
    !migration ||
    migration.status !== "completed" ||
    migration.checksum !== CHECKSUM ||
    !(migration.completed_at instanceof Date)
  )
    throw new Error("Required migration is incomplete or its checksum differs");
  for (const [name, schema] of Object.entries(schemas))
    await assertEffectiveCollection(db, name, schema, 1);
  const roles = await db
    .collection<Document & { _id: string }>("roles")
    .find(
      {},
      {
        readPreference: "primary",
        readConcern: { level: "majority" },
        maxTimeMS: COMMAND_MS,
      },
    )
    .toArray();
  if (
    roles.length !== ROLE_CODES.length ||
    ROLE_CODES.some(
      (code) =>
        !roles.some(
          (role) =>
            role._id === code &&
            role.code === code &&
            isDeepStrictEqual(
              role.capabilities,
              ROLE_CAPABILITIES[code as keyof typeof ROLE_CAPABILITIES],
            ),
        ),
    )
  )
    throw new Error("Role catalog mismatch");
}

/** Explicit deployment command, never called by the API to repair its own schema. */
async function migrateVersion(uri: string, spec: {
  version: number;
  checksum: string;
  schemas: Record<string, CollectionSchema>;
  assert: (db: Db) => Promise<void>;
  seedRoles: boolean;
  prepare?: (db: Db, client: MongoClient, renew: () => Promise<void>, held: () => Document) => Promise<void>;
  finalize?: (db: Db, session: import("mongodb").ClientSession) => Promise<void>;
}): Promise<void> {
  const { version: VERSION, checksum: CHECKSUM, schemas, assert: assertVersion } = spec;
  if (!uri.trim()) throw new Error("MONGODB_URI is required");
  const client = new MongoClient(uri, {
    readPreference: "primary",
    readConcern: { level: "majority" },
    writeConcern: WRITE_CONCERN,
    serverSelectionTimeoutMS: COMMAND_MS,
    socketTimeoutMS: COMMAND_MS * 2,
  });
  try {
    await client.connect();
    const db = client.db();
    await assertReplicaSet(db);
    // Bootstrap is deliberately idempotent and contains no application data writes.
    await ensureCollection(
      db,
      "schema_migrations",
      migrationSchema,
      async () => {},
    );
    const migrations = db.collection<Document & { _id: string }>(
      "schema_migrations",
    );
    try {
      await migrations.updateOne(
        { version: VERSION },
        {
          $setOnInsert: {
            _id: randomUUID(),
            version: VERSION,
            checksum: CHECKSUM,
            status: "pending",
            lease_token: null,
            lease_until: null,
            created_at: new Date(),
            started_at: null,
            completed_at: null,
            failed_at: null,
          },
        },
        { upsert: true, maxTimeMS: COMMAND_MS },
      );
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000)
        throw error;
    }
    const current = await migrations.findOne(
      { version: VERSION },
      { maxTimeMS: COMMAND_MS },
    );
    if (!current || current.checksum !== CHECKSUM)
      throw new Error("Migration checksum mismatch");
    if (current.status === "completed") {
      await assertVersion(db);
      return;
    }
    const token = randomUUID();
    const claimed = await migrations.findOneAndUpdate(
      {
        version: VERSION,
        checksum: CHECKSUM,
        $or: [
          { status: { $in: ["pending", "failed"] } },
          { status: "running", $expr: { $lte: ["$lease_until", "$$NOW"] } },
        ],
      },
      [
        {
          $set: {
            status: "running",
            lease_token: token,
            lease_until: { $add: ["$$NOW", LEASE_MS] },
            started_at: "$$NOW",
            completed_at: null,
            failed_at: null,
          },
        },
      ],
      { returnDocument: "after", maxTimeMS: COMMAND_MS },
    );
    if (!claimed) throw new Error("Another migration executor holds the lease");
    const held = () => ({
      version: VERSION,
      checksum: CHECKSUM,
      status: "running",
      lease_token: token,
      $expr: { $gt: ["$lease_until", "$$NOW"] },
    });
    const renew = async () => {
      const result = await migrations.updateOne(
        held(),
        [{ $set: { lease_until: { $add: ["$$NOW", LEASE_MS] } } }],
        { maxTimeMS: COMMAND_MS },
      );
      if (result.matchedCount !== 1) throw new Error("Migration lease lost");
    };
    try {
      if (spec.prepare) await spec.prepare(db, client, renew, held);
      const completedV7 = VERSION < 7 && await migrations.findOne({ version: 7, status: "completed", checksum: PRIVACY_V7_CHECKSUM });
      const completedV6 = VERSION < 6 && await migrations.findOne({ version: 6, status: "completed", checksum: LEARNING_API_V6_CHECKSUM });
      const completedV5 = VERSION < 5 && await migrations.findOne({ version: 5, status: "completed", checksum: LEARNING_V5_CHECKSUM });
      const completedV4 = VERSION < 4 && await migrations.findOne({ version: 4, status: "completed", checksum: ASSESSMENT_V4_CHECKSUM });
      const completedV3 = VERSION < 3 && await migrations.findOne({ version: 3, status: "completed", checksum: CONTENT_V3_CHECKSUM });
      const effectiveSchemas = Object.entries(schemas).map(([name, schema]) =>
        [name, (completedV7 && PRIVACY_SCHEMAS[name]) || (completedV6 && LEARNING_API_V6_SCHEMAS[name]) || (completedV5 && LEARNING_V5_SCHEMAS[name]) || (completedV4 && ASSESSMENT_V4_SCHEMAS[name]) || (completedV3 && CONTENT_V3_SCHEMAS[name]) || schema] as const);
      // DDL cannot join a transaction. Bounded idempotent steps are renewed individually.
      for (const [name, schema] of effectiveSchemas)
        await ensureCollection(db, name, schema, renew);
      for (const [name, schema] of effectiveSchemas) {
        await renew();
        await assertCollection(db, name, schema);
      }
      await renew();
      const session = client.startSession();
      try {
        await session.withTransaction(
          async () => {
            const fence = await migrations.updateOne(
              held(),
              [{ $set: { lease_until: { $add: ["$$NOW", LEASE_MS] } } }],
              { session, maxTimeMS: COMMAND_MS },
            );
            if (fence.matchedCount !== 1)
              throw new Error("Migration lease lost");
            if (spec.seedRoles) for (const [code, capabilities] of Object.entries(
              ROLE_CAPABILITIES,
            ))
              await db
                .collection<Document & { _id: string }>("roles")
                .replaceOne(
                  { _id: code },
                  { _id: code, code, capabilities },
                  { upsert: true, session, maxTimeMS: COMMAND_MS },
                );
            if (spec.finalize) await spec.finalize(db, session);
            const completed = await migrations.updateOne(
              held(),
              [
                {
                  $set: {
                    status: "completed",
                    completed_at: "$$NOW",
                    lease_token: null,
                    lease_until: null,
                  },
                },
              ],
              { session, maxTimeMS: COMMAND_MS },
            );
            if (completed.matchedCount !== 1)
              throw new Error("Migration lease lost");
          },
          {
            readConcern: { level: "snapshot" },
            writeConcern: WRITE_CONCERN,
            readPreference: "primary",
            maxCommitTimeMS: COMMAND_MS,
          },
        );
      } finally {
        await session.endSession();
      }
      await assertVersion(db);
    } catch (error) {
      // A late worker may neither mark success nor alter a successor's failure state.
      await migrations
        .updateOne(
          held(),
          [
            {
              $set: {
                status: "failed",
                failed_at: "$$NOW",
                lease_token: null,
                lease_until: null,
              },
            },
          ],
          { maxTimeMS: COMMAND_MS },
        )
        .catch(() => undefined);
      throw error;
    }
  } finally {
    await client.close();
  }
}

/** Retained for explicit upgrades and recovery of phase-one backups. */
export async function migrateVersion1(uri: string): Promise<void> {
  await migrateVersion(uri, { version: VERSION, checksum: CHECKSUM, schemas,
    assert: assertSchemaVersion1, seedRoles: true });
}

async function assertContentSchema(db: Db): Promise<void> {
  const migration = await db.collection("schema_migrations").findOne(
    { version: 2 }, { readPreference: "primary", readConcern: { level: "majority" }, maxTimeMS: COMMAND_MS });
  if (!migration || migration.status !== "completed" ||
      migration.checksum !== CONTENT_SCHEMA_CHECKSUM || !(migration.completed_at instanceof Date))
    throw new Error("Required content migration is incomplete or its checksum differs");
  if (!await db.collection("schema_migrations").findOne({ version: 3 }))
    for (const [name, schema] of Object.entries(CONTENT_SCHEMAS))
      await assertCollection(db, name, schema);
}

async function assertVersion3(db: Db): Promise<void> {
  const migration = await db.collection("schema_migrations").findOne({ version: 3 });
  if (!migration || migration.status !== "completed" || migration.checksum !== CONTENT_V3_CHECKSUM || !(migration.completed_at instanceof Date))
    throw new Error("Required v3 migration is incomplete or its checksum differs");
  for (const [name, schema] of Object.entries(CONTENT_V3_SCHEMAS)) await assertEffectiveCollection(db, name, schema, 3);
}

async function assertVersion4(db: Db): Promise<void> {
  const marker = await db.collection("schema_migrations").findOne({ version: 4 });
  if (!marker || marker.status !== "completed" || marker.checksum !== ASSESSMENT_V4_CHECKSUM || !(marker.completed_at instanceof Date))
    throw new Error("Required v4 migration is incomplete or its checksum differs");
  for (const [name, schema] of Object.entries(ASSESSMENT_V4_SCHEMAS)) await assertEffectiveCollection(db, name, schema, 4);
}

export async function assertSchemaVersion4(db: Db): Promise<void> {
  await assertSchemaVersion1(db);
  await assertContentSchema(db);
  await assertVersion3(db);
  await assertVersion4(db);
}

export async function assertSchemaVersion5(db: Db): Promise<void> {
  await assertSchemaVersion1(db);
  await assertContentSchema(db);
  await assertVersion3(db);
  await assertVersion4(db);
  const marker = await db.collection("schema_migrations").findOne({ version: 5 });
  if (!marker || marker.status !== "completed" || marker.checksum !== LEARNING_V5_CHECKSUM || !(marker.completed_at instanceof Date))
    throw new Error("Required v5 migration is incomplete or its checksum differs");
  for (const [name, schema] of Object.entries(LEARNING_V5_SCHEMAS)) await assertEffectiveCollection(db, name, schema, 5);
  if (!await db.collection<Document & { _id:string }>("learning_tracking_config").findOne({ _id:"tracking", tracking_ready:true }))
    throw new Error("Learning tracking is not ready");
}

export async function assertSchemaVersion6(db: Db): Promise<void> {
  await assertSchemaVersion5(db);
  const marker = await db.collection("schema_migrations").findOne({ version: 6 });
  if (!marker || marker.status !== "completed" || marker.checksum !== LEARNING_API_V6_CHECKSUM || !(marker.completed_at instanceof Date))
    throw new Error("Required v6 migration is incomplete or its checksum differs");
  for (const [name, schema] of Object.entries(LEARNING_API_V6_SCHEMAS)) await assertEffectiveCollection(db, name, schema, 6);
}

export async function assertSchema(db: Db): Promise<void> {
  await assertSchemaVersion6(db);
  const marker = await db.collection("schema_migrations").findOne({ version: 7 });
  if (!marker || marker.status !== "completed" || marker.checksum !== PRIVACY_V7_CHECKSUM || !(marker.completed_at instanceof Date)) throw new Error("Required v7 migration is incomplete or its checksum differs");
  for (const [name, schema] of Object.entries(PRIVACY_SCHEMAS)) await assertCollection(db, name, schema);
  if (!await db.collection<Document & { _id: string }>("operational_state").findOne({ _id: "environment" })) throw new Error("Operational state is missing");
}

/** A read-only impact command, including on databases without migration markers. */
export async function inspectMigration(uri: string) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: COMMAND_MS, readConcern: { level: "majority" }, readPreference: "primary" });
  try { await client.connect(); await assertReplicaSet(client.db()); return await inspectCurrent(client.db()); }
  finally { await client.close(); }
}

async function inspectCurrent(db: Db) {
  const report = await inspectVersion7(db, PRIVACY_SCHEMAS, CURRENT_SCHEMAS);
  const checksums = new Map([[1,CHECKSUM],[2,CONTENT_SCHEMA_CHECKSUM],[3,CONTENT_V3_CHECKSUM],[4,ASSESSMENT_V4_CHECKSUM],[5,LEARNING_V5_CHECKSUM],[6,LEARNING_API_V6_CHECKSUM],[7,PRIVACY_V7_CHECKSUM]]);
  for (const marker of report.markers) if (checksums.get(marker.version) !== marker.checksum) throw new Error("Migration checksum mismatch");
  return report;
}

function assertLearningImpactSafe(report: Awaited<ReturnType<typeof inspectVersion5>>): void {
  assertImpactSafe(report);
  const current = report as typeof report & { unknown_collections?: string[]; invalid_indexes?: number };
  if (current.unknown_collections?.length) throw new Error("Migration has unknown collections");
  if (current.invalid_indexes) throw new Error("Migration has incompatible indexes");
  if (report.duplicate_keys) throw new Error("Migration has duplicate keys");
  if (report.incomplete_evidence) throw new Error("Migration has incomplete assessment evidence");
}

/** Retained to exercise upgrades from an actual deployed v2 contract. */
export async function migrateVersion2(uri: string): Promise<void> {
  await migrateVersion1(uri);
  await migrateVersion(uri, { version: 2, checksum: CONTENT_SCHEMA_CHECKSUM,
    schemas: CONTENT_SCHEMAS, assert: assertContentSchema, seedRoles: false });
}

/** Upgrade sequentially without ever rewriting historical definitions or checksums. */
export async function migrateVersion3(uri: string): Promise<void> {
  assertLearningImpactSafe(await inspectMigration(uri));
  await migrateVersion2(uri);
  await migrateVersion(uri, { version: 3, checksum: CONTENT_V3_CHECKSUM, schemas: CONTENT_V3_SCHEMAS,
    assert: assertVersion3, seedRoles: false,
    prepare: async (db, client, renew, held) => {
      await renew();
      assertLearningImpactSafe(await inspectCurrent(db));
      for (const [name, defaults] of Object.entries(V3_DEFAULTS)) {
        await renew();
        const session = client.startSession();
        try {
          await session.withTransaction(async () => {
            const fence = await db.collection("schema_migrations").updateOne(held(),
              [{ $set: { lease_until: { $add: ["$$NOW", LEASE_MS] } } }], { session, maxTimeMS: COMMAND_MS });
            if (fence.matchedCount !== 1) throw new Error("Migration lease lost");
            // Missing fields only; explicit nulls, revocations and retention decisions survive retries.
            await db.collection(name).updateMany(
              { $or: Object.keys(defaults).map(field => ({ [field]: { $exists: false } })) },
              [{ $replaceWith: withVersion3Defaults(name) }],
              { session, bypassDocumentValidation: true, maxTimeMS: COMMAND_MS });
          }, { readConcern: { level: "snapshot" }, writeConcern: WRITE_CONCERN, readPreference: "primary" });
        } finally { await session.endSession(); }
      }
      await renew();
      assertLearningImpactSafe(await inspectCurrent(db));
    } });
}

/** Upgrade v4 through bounded lease-fenced DDL; no seed or legacy content rewrite. */
export async function migrateVersion4(uri: string): Promise<void> {
  assertLearningImpactSafe(await inspectMigration(uri));
  await migrateVersion3(uri);
  await migrateVersion(uri, { version: 4, checksum: ASSESSMENT_V4_CHECKSUM, schemas: ASSESSMENT_V4_SCHEMAS,
    assert: assertSchemaVersion4, seedRoles: false, prepare: async (db, _client, renew) => {
      await renew();
      assertLearningImpactSafe(await inspectCurrent(db));
      await renew();
    } });
}

/** The epoch is published atomically with the completed marker, never during DDL. */
export async function migrateVersion5(uri: string): Promise<void> {
  assertLearningImpactSafe(await inspectMigration(uri));
  await migrateVersion4(uri);
  await migrateVersion(uri, { version:5, checksum:LEARNING_V5_CHECKSUM, schemas:LEARNING_V5_SCHEMAS,
    assert:assertSchemaVersion5, seedRoles:false,
    prepare:async (db, _client, renew) => { await renew(); assertLearningImpactSafe(await inspectCurrent(db)); },
    finalize:async (db, session) => {
      await db.collection<Document & { _id:string }>("learning_tracking_config").updateOne({_id:"tracking"},
        [{$set:{epoch:{$ifNull:["$epoch",{$literal:randomUUID()}]},cutover_at:{$ifNull:["$cutover_at","$$NOW"]},tracking_ready:true}}],
        {upsert:true,session,maxTimeMS:COMMAND_MS});
    } });
}

/** Add only the collections used by the learning HTTP APIs; preserve the v5 epoch. */
export async function migrateVersion6(uri: string): Promise<void> {
  assertLearningImpactSafe(await inspectMigration(uri));
  await migrateVersion5(uri);
  await migrateVersion(uri, { version:6, checksum:LEARNING_API_V6_CHECKSUM, schemas:LEARNING_API_V6_SCHEMAS,
    assert:assertSchemaVersion6, seedRoles:false,
    prepare:async (db, _client, renew) => { await renew(); assertLearningImpactSafe(await inspectCurrent(db)); },
  });
}

export async function migrate(uri: string): Promise<void> {
  assertLearningImpactSafe(await inspectMigration(uri));
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: COMMAND_MS });
  await client.connect();
  let writer: { release: () => Promise<void> } | undefined;
  try {
    const state = await client.db().collection<Document & { _id: string }>("operational_state").findOne({ _id: "environment" });
    if (!state && await client.db().collection("schema_migrations").findOne({ version: 7, status: "completed" })) throw new Error("Operational state is missing for completed v7");
    if (state) writer = await acquireWriter(client.db(), "migration");
    await migrateVersion6(uri);
    writer ??= await acquireWriter(client.db(), "migration");
    await migrateVersion(uri, { version: 7, checksum: PRIVACY_V7_CHECKSUM, schemas: PRIVACY_SCHEMAS, assert: assertSchema, seedRoles: false,
      prepare: async (db, migrationClient, renew, held) => {
        await renew();
        assertLearningImpactSafe(await inspectCurrent(db));
        const session = migrationClient.startSession();
        try {
          await session.withTransaction(async () => {
            const fence = await db.collection("schema_migrations").updateOne(held(), [{ $set: { lease_until: { $add: ["$$NOW", LEASE_MS] } } }], { session, maxTimeMS: COMMAND_MS });
            if (fence.matchedCount !== 1) throw new Error("Migration lease lost");
            await db.collection("users").updateMany({ privacy_state: { $exists: false } }, { $set: { privacy_state: "active" } }, { session, bypassDocumentValidation: true, maxTimeMS: COMMAND_MS });
            for await (const tombstone of db.collection("privacy_tombstones").find({}, { session, maxTimeMS: COMMAND_MS })) {
              await db.collection("users").updateOne({ _id: tombstone.user_id, privacy_state: { $ne: "erased" } }, { $set: { privacy_state: tombstone.state === "erased" ? "erased" : "erasing", status: "disabled" } }, { session, bypassDocumentValidation: true, maxTimeMS: COMMAND_MS });
            }
          }, { readConcern: { level: "snapshot" }, writeConcern: WRITE_CONCERN, readPreference: "primary" });
        } finally { await session.endSession(); }
      },
      finalize: async (db, session) => {
        await db.collection<Document & { _id: string }>("operational_state").updateOne({ _id: "environment" }, { $setOnInsert: { environment_id: null, mode: "unregistered", revision: 0, access_fence: 0, restore_id: null, maintenance_token: null, owner: null, updated_at: new Date() } }, { upsert: true, session, maxTimeMS: COMMAND_MS });
      },
    });
  } finally { try { await writer?.release(); } finally { await client.close(); } }
}
