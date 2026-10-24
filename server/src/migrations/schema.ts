import { GROWTH_SCHEMAS, GROWTH_CHECKSUM, GROWTH_COLLECTIONS, growthEnabled } from "../training/growth-schema";
export { GROWTH_CHECKSUM };
import { STUDIO_SCHEMAS, STUDIO_CHECKSUM, STUDIO_COLLECTIONS, studioEnabled } from "../training/studio-schema";
export { STUDIO_CHECKSUM };
import { PLANNING_SCHEMAS, PLANNING_CHECKSUM, PLANNING_COLLECTIONS } from "../lifelong/planning-schema";
import { AUTH_EMAIL_SCHEMAS, AUTH_EMAIL_CHECKSUM, AUTH_EMAIL_COLLECTIONS, AUTH_EMAIL_EXCLUDED } from "../auth-email/schema";
import { migrateAuthEmail } from "./auth-email-v22";
import { migrateLifelong } from "./lifelong-v23";
import { LIFELONG_SCHEMAS, LIFELONG_CHECKSUM, LIFELONG_COLLECTIONS, lifelongEnabled } from "../lifelong/schema";
import { STUDY_SCHEMAS, STUDY_CHECKSUM, STUDY_COLLECTIONS } from "../lifelong/study-schema";
export { LIFELONG_CHECKSUM, STUDY_CHECKSUM, PLANNING_CHECKSUM };
import { loadEmailConfig } from "../auth-email/config";
import { probeTopology } from "../database/topology";
export { AUTH_EMAIL_CHECKSUM };
import {recoveryEnabled,assertRecoveryConfiguration,STANDALONE_RECOVERY_SCHEMAS,RECOVERY_COLLECTIONS,RECOVERY_CHECKSUM,migrateRecovery,initializeRecovery,withRecoveryMigration} from '../training/standalone-recovery-lifecycle';
import {surveySchemas,migrateSurveys,SURVEY_CHECKSUM} from "../training/survey-schema";
import {provenanceSchemas,migrateProvenance,PROVENANCE_CHECKSUM} from '../training/import-provenance-schema';
import {importSchemas,migrateImports,IMPORT_CHECKSUM} from '../training/import-schema';
import { knowledgeSchemas, migrateKnowledge, KNOWLEDGE_CHECKSUM } from "../training/knowledge-schema";
import {aiLearningSchemas,migrateAiLearning,AI_LEARNING_CHECKSUM} from "../training/ai-learning-schema";
import {trainingPhase2Schemas,migrateTrainingPhase2,TRAINING_PHASE2_CHECKSUM} from '../training/phase2-schema';
import {trainingReportSchemas,migrateTrainingReports,TRAINING_REPORT_CHECKSUM} from '../training/report-schema';
import {aiPolicySchemas,migrateAiPolicy,AI_POLICY_CHECKSUM} from '../training/ai-policy-schema';
import {courseworkFilesSchemas,migrateCourseworkFiles,COURSEWORK_FILES_CHECKSUM} from '../training/coursework-files-schema';
import { trainingSchemas, migrateTraining, TRAINING_CHECKSUM } from "../training/schema";
import { objectIdSchemas, objectIdChecksum, assertObjectIdSchema, initializeObjectId } from "./object-id-v10";
import { checkStep, type CheckContext } from "../runtime/check-context";
import { rawDatabase } from "../database/object-id";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  MongoClient,
  MongoServerError,
  type Db,
  type Document,
  type IndexDescription,
} from "mongodb";
import { ROLE_CAPABILITIES, type AdministrationGuard } from "../database/contracts";
import { CONTENT_SCHEMAS, CONTENT_SCHEMA_CHECKSUM } from "./content-schema";
import { CONTENT_V3_SCHEMAS, CONTENT_V3_CHECKSUM, V3_DEFAULTS, withVersion3Defaults, assertImpactSafe, inspectVersion3 } from "./content-v3";
import { ASSESSMENT_V4_SCHEMAS, ASSESSMENT_V4_CHECKSUM } from "./assessment-v4";
import { LEARNING_V5_SCHEMAS, LEARNING_V5_CHECKSUM, inspectVersion5 } from "./learning-v5";
import { LEARNING_API_V6_SCHEMAS, LEARNING_API_V6_CHECKSUM } from "./learning-api-v6";
import { privacyVersion7 } from "./privacy-v7";
import { TEACHING_V8_SCHEMAS, TEACHING_V8_CHECKSUM, inspectVersion8 } from "./teaching-v8";
import { ADMINISTRATION_V9_SCHEMAS, ADMINISTRATION_V9_CHECKSUM, inspectVersion9 } from "./administration-v9";
import { acquireWriter } from "../operations/control";
import { loadConfig } from "../config";
import { assertTopology } from "../database/topology";
import { runInTxn } from "../database/txn";


export const CURRENT_SCHEMA_VERSION = 10;

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
// Historical v1 role catalog must stay frozen so CHECKSUM and validators do not drift.
const V1_ROLE_CAPABILITIES = {
  student: ["account:read", "learning:self"],
  content_editor: ["account:read", "content:edit"],
  content_reviewer: ["account:read", "content:review"],
  org_admin: ["account:read", "organization:admin"],
  platform_ops: ["account:read", "operations:health"],
} as const;
const V1_ROLE_CODES = Object.keys(V1_ROLE_CAPABILITIES);
const ROLE = { bsonType: "string", enum: V1_ROLE_CODES };
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
            enum: [...new Set(Object.values(V1_ROLE_CAPABILITIES).flat())],
          },
        },
      },
      [{ $eq: ["$_id", "$code"] }],
      Object.entries(V1_ROLE_CAPABILITIES).map(([code, capabilities]) => ({
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
      roles: V1_ROLE_CAPABILITIES,
    }),
  )
  .digest("hex");

const { schemas: PRIVACY_SCHEMAS, checksum: PRIVACY_V7_CHECKSUM } = privacyVersion7(schemas.users);
export { PRIVACY_V7_CHECKSUM, TEACHING_V8_CHECKSUM };
const CURRENT_SCHEMAS = { ...schemas, ...CONTENT_SCHEMAS, ...CONTENT_V3_SCHEMAS, ...ASSESSMENT_V4_SCHEMAS, ...LEARNING_V5_SCHEMAS, ...LEARNING_API_V6_SCHEMAS, ...PRIVACY_SCHEMAS, ...TEACHING_V8_SCHEMAS, ...ADMINISTRATION_V9_SCHEMAS, schema_migrations: migrationSchema };
export const OBJECT_ID_SCHEMAS = objectIdSchemas(CURRENT_SCHEMAS);
export const OBJECT_ID_CHECKSUM = objectIdChecksum(OBJECT_ID_SCHEMAS);
function preAiTrainingSchemas(){const s=trainingSchemas(OBJECT_ID_SCHEMAS);return process.env.KL_COURSEWORK_FILES_ENABLED === "true" ? courseworkFilesSchemas(s):s;}
function preReportSchemas(){const s=preAiTrainingSchemas();return process.env.KL_AI_POLICY_ENABLED === "true" ? aiPolicySchemas(s):s;}
function prePhase2Schemas(){const s=preReportSchemas();return process.env.KL_TRAINING_REPORTS_ENABLED === "true" ? trainingReportSchemas(s):s;}
function preLearningAiSchemas(){const s=prePhase2Schemas();return process.env.KL_TRAINING_PHASE2_ENABLED === "true" ? trainingPhase2Schemas(s):s;}
function preKnowledgeSchemas(){const s=preLearningAiSchemas();return process.env.KL_AI_LEARNING_REPORTS_ENABLED === "true" ? aiLearningSchemas(s):s;}
function preImportSchemas(){const s=preKnowledgeSchemas();return process.env.KL_KNOWLEDGE_ENABLED === "true" ? knowledgeSchemas(s):s;}
function preProvenanceSchemas(){const s=preImportSchemas();return process.env.KL_KNOWLEDGE_IMPORT_ENABLED === "true" ? importSchemas(s):s;}
function preSurveySchemas(){const s=preProvenanceSchemas();return process.env.KL_KNOWLEDGE_IMPORT_ENABLED === "true" ? provenanceSchemas(s):s;}
function effectiveTrainingSchemas(){const s=preSurveySchemas();return process.env.KL_TRAINING_SURVEYS_ENABLED === "true" ? surveySchemas(s):s;}
function requireLearningAiDependencies(){if(process.env.KL_TRAINING_SURVEYS_ENABLED === "true" && ["KL_TRAINING_ENABLED","KL_KNOWLEDGE_IMPORT_ENABLED","KL_KNOWLEDGE_ENABLED"].some(key=>process.env[key]!=="true"))throw Error("Surveys require training, knowledge and import v19");if(process.env.KL_KNOWLEDGE_IMPORT_ENABLED === "true" && ["KL_TRAINING_ENABLED","KL_KNOWLEDGE_ENABLED"].some(key=>process.env[key]!=="true"))throw Error("Knowledge import requires training and knowledge");if(process.env.KL_KNOWLEDGE_ENABLED === "true" && process.env.KL_TRAINING_ENABLED !== "true")throw Error("Knowledge requires training");if(process.env.KL_AI_LEARNING_REPORTS_ENABLED === "true" && ["KL_TRAINING_ENABLED","KL_TRAINING_REPORTS_ENABLED","KL_AI_POLICY_ENABLED"].some(key=>process.env[key]!=="true"))throw Error("AI learning reports require training, reports and amount policy");}
function baseSystemBackupRegistry() {
  return { version: process.env.KL_TRAINING_ENABLED === "true" ? (process.env.KL_TRAINING_SURVEYS_ENABLED === "true" ? 20 : process.env.KL_KNOWLEDGE_IMPORT_ENABLED === "true" ? 19 : process.env.KL_KNOWLEDGE_ENABLED === "true" ? 17 : process.env.KL_AI_LEARNING_REPORTS_ENABLED === "true" ? 16 : process.env.KL_TRAINING_PHASE2_ENABLED === "true" ? 15 : process.env.KL_TRAINING_REPORTS_ENABLED === "true" ? 14 : process.env.KL_AI_POLICY_ENABLED === "true" ? 13 : process.env.KL_COURSEWORK_FILES_ENABLED === "true" ? 12 : 11) : CURRENT_SCHEMA_VERSION, collections: Object.keys(process.env.KL_TRAINING_ENABLED === "true" ? effectiveTrainingSchemas() : OBJECT_ID_SCHEMAS).filter(name => !["auth_sessions", "auth_rate_limits"].includes(name)), excluded: ["auth_sessions", "auth_rate_limits"], checksums: { "1": CHECKSUM, "2": CONTENT_SCHEMA_CHECKSUM, "3": CONTENT_V3_CHECKSUM, "4": ASSESSMENT_V4_CHECKSUM, "5": LEARNING_V5_CHECKSUM, "6": LEARNING_API_V6_CHECKSUM, "7": PRIVACY_V7_CHECKSUM, "8": TEACHING_V8_CHECKSUM, "9": ADMINISTRATION_V9_CHECKSUM, "10": OBJECT_ID_CHECKSUM, ...(process.env.KL_TRAINING_ENABLED === "true" ? { "11": TRAINING_CHECKSUM, ...(process.env.KL_COURSEWORK_FILES_ENABLED === "true" ? {"12":COURSEWORK_FILES_CHECKSUM}:{}), ...(process.env.KL_AI_POLICY_ENABLED === "true" ? {"13":AI_POLICY_CHECKSUM}:{}), ...(process.env.KL_TRAINING_REPORTS_ENABLED === "true" ? {"14":TRAINING_REPORT_CHECKSUM}:{}), ...(process.env.KL_TRAINING_PHASE2_ENABLED === "true" ? {"15":TRAINING_PHASE2_CHECKSUM}:{}), ...(process.env.KL_AI_LEARNING_REPORTS_ENABLED === "true" ? {"16":AI_LEARNING_CHECKSUM}:{}), ...(process.env.KL_KNOWLEDGE_ENABLED === "true" ? {"17":KNOWLEDGE_CHECKSUM}:{}),...(process.env.KL_KNOWLEDGE_IMPORT_ENABLED === "true" ? {"18":IMPORT_CHECKSUM,"19":PROVENANCE_CHECKSUM}:{}),...(process.env.KL_TRAINING_SURVEYS_ENABLED === "true" ? {"20":SURVEY_CHECKSUM}:{}) } : {}) } };
}

function legacySystemBackupRegistry() {
 assertRecoveryConfiguration();
 const base=baseSystemBackupRegistry();
 if(!recoveryEnabled())return base;
 return {...base,version:21,collections:[...base.collections,...RECOVERY_COLLECTIONS],excluded:[...base.excluded,...RECOVERY_COLLECTIONS],checksums:{...base.checksums,'21':RECOVERY_CHECKSUM}};
}
function emailSystemBackupRegistry() {
 const base = legacySystemBackupRegistry();
 return { ...base, version: 22, collections: [...base.collections, ...AUTH_EMAIL_COLLECTIONS],
   excluded: [...base.excluded, ...AUTH_EMAIL_EXCLUDED], checksums: { ...base.checksums, "22": AUTH_EMAIL_CHECKSUM } };
}
function personalSystemBackupRegistry() {
 const base = emailSystemBackupRegistry();
 return lifelongEnabled() ? { ...base, version: 23, collections: [...base.collections, ...LIFELONG_COLLECTIONS],
   checksums: { ...base.checksums, "23": LIFELONG_CHECKSUM } } : base;
}
function studySystemBackupRegistry() {
 const base = personalSystemBackupRegistry();
 return lifelongEnabled() ? { ...base, version: 24, collections: [...base.collections, ...STUDY_COLLECTIONS], checksums: {...base.checksums, "24": STUDY_CHECKSUM} } : base;
}
function planningSystemBackupRegistry() {
 const base = studySystemBackupRegistry();
 return lifelongEnabled() ? { ...base, version: 25, collections: [...base.collections, ...PLANNING_COLLECTIONS], checksums: {...base.checksums, "25": PLANNING_CHECKSUM} } : base;
}
function studioSystemBackupRegistry() {
 const base = planningSystemBackupRegistry();
 return studioEnabled() ? { ...base, version: 26, collections: [...base.collections, ...STUDIO_COLLECTIONS], checksums: {...base.checksums, "26": STUDIO_CHECKSUM} } : base;
}
export function systemBackupRegistry() {
 const base = studioSystemBackupRegistry();
 return growthEnabled() ? {...base, version:27, collections:[...base.collections,...GROWTH_COLLECTIONS], checksums:{...base.checksums,"27":GROWTH_CHECKSUM}} : base;
}
/** Exact pre-email registry for this supported feature combination, never a wildcard. */
export function supportedSystemBackupRegistries() {
 return [legacySystemBackupRegistry(), emailSystemBackupRegistry(), personalSystemBackupRegistry(), studySystemBackupRegistry(), planningSystemBackupRegistry(), studioSystemBackupRegistry(), systemBackupRegistry()] as const;
}
function effectiveRuntimeSchemas(){const base=process.env.KL_TRAINING_ENABLED==='true'?effectiveTrainingSchemas():OBJECT_ID_SCHEMAS;return {...base,...(recoveryEnabled()?STANDALONE_RECOVERY_SCHEMAS:{}),...AUTH_EMAIL_SCHEMAS,...(lifelongEnabled()?{...LIFELONG_SCHEMAS,...STUDY_SCHEMAS,...PLANNING_SCHEMAS}:{}),...(studioEnabled()?STUDIO_SCHEMAS:{}),...(growthEnabled()?GROWTH_SCHEMAS:{})};}

/** Empty restore targets only. No markers, epochs, role catalog or state seeds. */
export async function initializeRestoreSchema(db: Db): Promise<void> {
  await assertTopology(db, loadConfig());
  if ((await db.listCollections({}, { nameOnly: true, maxTimeMS: COMMAND_MS }).toArray()).length) throw new Error("Restore target must be empty");
  for (const [name, schema] of Object.entries(effectiveRuntimeSchemas())) await ensureCollection(rawDatabase(db), name, schema, async () => {});

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
    [9, ADMINISTRATION_V9_CHECKSUM, ADMINISTRATION_V9_SCHEMAS],
    [8, TEACHING_V8_CHECKSUM, TEACHING_V8_SCHEMAS],
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
  await assertTopology(db, loadConfig());
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
  const catalogMarker = await db.collection("schema_migrations").findOne({ version: 8 });
  const catalog =
    catalogMarker?.status === "completed" && catalogMarker.checksum === TEACHING_V8_CHECKSUM
      ? ROLE_CAPABILITIES
      : V1_ROLE_CAPABILITIES;
  const catalogCodes = Object.keys(catalog);
  if (
    roles.length !== catalogCodes.length ||
    catalogCodes.some(
      (code) =>
        !roles.some(
          (role) =>
            role._id === code &&
            role.code === code &&
            isDeepStrictEqual(
              role.capabilities,
              catalog[code as keyof typeof catalog],
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
  seedRoles: false | Record<string, readonly string[]>;
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
    await assertTopology(db, loadConfig());
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
      const completedV9 = VERSION < 9 && await migrations.findOne({ version: 9, status: "completed", checksum: ADMINISTRATION_V9_CHECKSUM });
      const completedV8 = VERSION < 8 && await migrations.findOne({ version: 8, status: "completed", checksum: TEACHING_V8_CHECKSUM });
      const completedV7 = VERSION < 7 && await migrations.findOne({ version: 7, status: "completed", checksum: PRIVACY_V7_CHECKSUM });
      const completedV6 = VERSION < 6 && await migrations.findOne({ version: 6, status: "completed", checksum: LEARNING_API_V6_CHECKSUM });
      const completedV5 = VERSION < 5 && await migrations.findOne({ version: 5, status: "completed", checksum: LEARNING_V5_CHECKSUM });
      const completedV4 = VERSION < 4 && await migrations.findOne({ version: 4, status: "completed", checksum: ASSESSMENT_V4_CHECKSUM });
      const completedV3 = VERSION < 3 && await migrations.findOne({ version: 3, status: "completed", checksum: CONTENT_V3_CHECKSUM });
      const effectiveSchemas = Object.entries(schemas).map(([name, schema]) =>
        [name, (completedV9 && ADMINISTRATION_V9_SCHEMAS[name]) || (completedV8 && TEACHING_V8_SCHEMAS[name]) || (completedV7 && PRIVACY_SCHEMAS[name]) || (completedV6 && LEARNING_API_V6_SCHEMAS[name]) || (completedV5 && LEARNING_V5_SCHEMAS[name]) || (completedV4 && ASSESSMENT_V4_SCHEMAS[name]) || (completedV3 && CONTENT_V3_SCHEMAS[name]) || schema] as const);
      // DDL cannot join a transaction. Bounded idempotent steps are renewed individually.
      for (const [name, schema] of effectiveSchemas)
        await ensureCollection(db, name, schema, renew);
      for (const [name, schema] of effectiveSchemas) {
        await renew();
        await assertCollection(db, name, schema);
      }
      await renew();
      await runInTxn(
        client,
        async (session) => {
          const fence = await migrations.updateOne(
            held(),
            [{ $set: { lease_until: { $add: ["$$NOW", LEASE_MS] } } }],
            { session, maxTimeMS: COMMAND_MS },
          );
          if (fence.matchedCount !== 1)
            throw new Error("Migration lease lost");
          if (spec.seedRoles) for (const [code, capabilities] of Object.entries(spec.seedRoles))
            await db
              .collection<Document & { _id: string }>("roles")
              .replaceOne(
                { _id: code },
                { _id: code, code, capabilities: [...capabilities] },
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
    assert: assertSchemaVersion1, seedRoles: V1_ROLE_CAPABILITIES });
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

export async function assertSchemaVersion7(db: Db): Promise<void> {
  await assertSchemaVersion6(db);
  const marker = await db.collection("schema_migrations").findOne({ version: 7 });
  if (!marker || marker.status !== "completed" || marker.checksum !== PRIVACY_V7_CHECKSUM || !(marker.completed_at instanceof Date)) throw new Error("Required v7 migration is incomplete or its checksum differs");
  for (const [name, schema] of Object.entries(PRIVACY_SCHEMAS)) await assertCollection(db, name, schema);
  if (!await db.collection<Document & { _id: string }>("operational_state").findOne({ _id: "environment" })) throw new Error("Operational state is missing");
}

export async function assertSchemaVersion8(db: Db): Promise<void> {
  await assertSchemaVersion7(db);
  const marker = await db.collection("schema_migrations").findOne({ version: 8 });
  if (!marker || marker.status !== "completed" || marker.checksum !== TEACHING_V8_CHECKSUM || !(marker.completed_at instanceof Date)) throw new Error("Required v8 migration is incomplete or its checksum differs");
  for (const [name, schema] of Object.entries(TEACHING_V8_SCHEMAS)) await assertEffectiveCollection(db, name, schema, 8);
}

export async function assertLegacySchema(db: Db): Promise<void> {
  await assertSchemaVersion8(db);
  const marker = await db.collection("schema_migrations").findOne({ version: 9 });
  if (!marker || marker.status !== "completed" || marker.checksum !== ADMINISTRATION_V9_CHECKSUM || !(marker.completed_at instanceof Date)) throw new Error("Required v9 migration is incomplete or its checksum differs");
  for (const [name, schema] of Object.entries(ADMINISTRATION_V9_SCHEMAS)) await assertCollection(db, name, schema);
  if (!await db.collection<AdministrationGuard>("administration_guard").findOne({ _id: "administration" })) throw new Error("Administration guard missing");
}

/** A read-only impact command, including on databases without migration markers. */
export async function inspectLegacyMigration(uri: string) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: COMMAND_MS, readConcern: { level: "majority" }, readPreference: "primary" });
  try { await client.connect(); await assertTopology(client.db(), loadConfig()); return await inspectCurrent(client.db()); }
  finally { await client.close(); }
}

async function inspectCurrent(db: Db) {
  const markerV9 = await db.collection("schema_migrations").findOne({ version: 9 });
  const v9Cutover = markerV9?.checksum === ADMINISTRATION_V9_CHECKSUM;
  const publishedV9 = v9Cutover && markerV9.status === "completed";
  const report = await inspectVersion8(db, PRIVACY_SCHEMAS, CURRENT_SCHEMAS);
  // A crashed v9 prepare may have converted some grants before its DDL/marker.
  // Accept only the two valid contracts; neither old definition is rewritten.
  const effectiveSchemas: Record<string, CollectionSchema> = !v9Cutover || publishedV9 ? CURRENT_SCHEMAS : {
    ...CURRENT_SCHEMAS,
    member_roles: { ...ADMINISTRATION_V9_SCHEMAS.member_roles,
      validator: { $or: [TEACHING_V8_SCHEMAS.member_roles.validator, ADMINISTRATION_V9_SCHEMAS.member_roles.validator] } },
    member_capability_grants: { ...ADMINISTRATION_V9_SCHEMAS.member_capability_grants,
      validator: { $or: [TEACHING_V8_SCHEMAS.member_capability_grants.validator, ADMINISTRATION_V9_SCHEMAS.member_capability_grants.validator] } },
  };
  if (v9Cutover) {
    const content = await inspectVersion3(db, undefined, effectiveSchemas);
    for (const [name, counts] of Object.entries(content.collections)) report.collections[name] = counts;
    report.invalid_references = Math.max(report.invalid_references, content.invalid_references);
  }
  if (v9Cutover) {
    const listed = new Set((await db.listCollections({}, { nameOnly: true, maxTimeMS: COMMAND_MS }).toArray()).map(row => row.name));
    for (const [name, schema] of Object.entries(ADMINISTRATION_V9_SCHEMAS)) {
      const count = await db.collection(name).countDocuments({}, { maxTimeMS: COMMAND_MS });
      const expected = publishedV9 ? schema : name === "member_roles" || name === "member_capability_grants"
        ? effectiveSchemas[name] : schema;
      const invalid = await db.collection(name).countDocuments({ $nor: [expected.validator] }, { maxTimeMS: COMMAND_MS });
      report.collections[name] = { documents: count, needs_defaults: 0, invalid_types: invalid };
      const indexes = listed.has(name) ? await db.collection(name).listIndexes({ maxTimeMS: COMMAND_MS }).toArray() : [];
      report.indexes[name] = indexes.map(index => index.name!);
      const previous = PRIVACY_SCHEMAS[name];
      for (const index of indexes) {
        if (index.name === "_id_" || previous?.indexes.some(old => old.name === index.name)) continue;
        const expected = schema.indexes.find(candidate => candidate.name === index.name);
        if (expected && isDeepStrictEqual(index.key, expected.key) &&
            Boolean(index.unique) === Boolean(expected.unique) &&
            index.expireAfterSeconds === expected.expireAfterSeconds &&
            isDeepStrictEqual(index.partialFilterExpression, expected.partialFilterExpression) &&
            !index.sparse && !index.hidden && !index.collation) {
          if (previous) report.invalid_indexes--;
        } else if (!previous) report.invalid_indexes++;
      }
      if (publishedV9) for (const required of schema.indexes) {
        if (!indexes.some(index => index.name === required.name)) report.invalid_indexes++;
      }
    }
  }
  const checksums = new Map([[1,CHECKSUM],[2,CONTENT_SCHEMA_CHECKSUM],[3,CONTENT_V3_CHECKSUM],[4,ASSESSMENT_V4_CHECKSUM],[5,LEARNING_V5_CHECKSUM],[6,LEARNING_API_V6_CHECKSUM],[7,PRIVACY_V7_CHECKSUM],[8,TEACHING_V8_CHECKSUM],[9,ADMINISTRATION_V9_CHECKSUM]]);
  for (const marker of report.markers) if (checksums.get(marker.version) !== marker.checksum) throw new Error("Migration checksum mismatch");
  const administration = await inspectVersion9(db, Object.keys(CURRENT_SCHEMAS));
  return { ...report, ...administration, invalid_references: report.invalid_references + administration.unbound_grants };
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
  assertLearningImpactSafe(await inspectLegacyMigration(uri));
  await migrateVersion2(uri);
  await migrateVersion(uri, { version: 3, checksum: CONTENT_V3_CHECKSUM, schemas: CONTENT_V3_SCHEMAS,
    assert: assertVersion3, seedRoles: false,
    prepare: async (db, client, renew, held) => {
      await renew();
      assertLearningImpactSafe(await inspectCurrent(db));
      for (const [name, defaults] of Object.entries(V3_DEFAULTS)) {
        await renew();
        await runInTxn(
          client,
          async (session) => {
            const fence = await db.collection("schema_migrations").updateOne(held(),
              [{ $set: { lease_until: { $add: ["$$NOW", LEASE_MS] } } }], { session, maxTimeMS: COMMAND_MS });
            if (fence.matchedCount !== 1) throw new Error("Migration lease lost");
            // Missing fields only; explicit nulls, revocations and retention decisions survive retries.
            await db.collection(name).updateMany(
              { $or: Object.keys(defaults).map(field => ({ [field]: { $exists: false } })) },
              [{ $replaceWith: withVersion3Defaults(name) }],
              { session, bypassDocumentValidation: true, maxTimeMS: COMMAND_MS });
          },
          { readConcern: { level: "snapshot" }, writeConcern: WRITE_CONCERN, readPreference: "primary" },
        );
      }
      await renew();
      assertLearningImpactSafe(await inspectCurrent(db));
    } });
}

/** Upgrade v4 through bounded lease-fenced DDL; no seed or legacy content rewrite. */
export async function migrateVersion4(uri: string): Promise<void> {
  assertLearningImpactSafe(await inspectLegacyMigration(uri));
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
  assertLearningImpactSafe(await inspectLegacyMigration(uri));
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
  assertLearningImpactSafe(await inspectLegacyMigration(uri));
  await migrateVersion5(uri);
  await migrateVersion(uri, { version:6, checksum:LEARNING_API_V6_CHECKSUM, schemas:LEARNING_API_V6_SCHEMAS,
    assert:assertSchemaVersion6, seedRoles:false,
    prepare:async (db, _client, renew) => { await renew(); assertLearningImpactSafe(await inspectCurrent(db)); },
  });
}

/** Retained to verify actual v8 upgrades without manufacturing a v9 marker. */
export async function migrateVersion8(uri: string): Promise<void> {
  await migrateThrough(uri, 8);
}

export async function migrate(uri:string):Promise<void>{
 const emailClient = new MongoClient(uri);
 try {
  await emailClient.connect();
  await assertTopology(emailClient.db(), loadConfig());
  if (!await emailClient.db().collection("schema_migrations").findOne({version:10,status:"completed",checksum:OBJECT_ID_CHECKSUM}))
   await initializeObjectId(uri, OBJECT_ID_SCHEMAS, OBJECT_ID_CHECKSUM, ROLE_CAPABILITIES);
  await migrateAuthEmail(emailClient.db(), OBJECT_ID_CHECKSUM);
  if (studioEnabled()) {
    if (process.env.KL_TRAINING_ENABLED !== "true") throw Error("Learning studio requires training");
    if ((await probeTopology(emailClient.db())).mode !== "replicaSet") throw Error("STUDIO_TRANSACTION_REQUIRED");
    await migrateLifelong(emailClient.db(), OBJECT_ID_CHECKSUM, {version:26,checksum:STUDIO_CHECKSUM,schemas:STUDIO_SCHEMAS});
  }
  if (growthEnabled()) {
    if (!studioEnabled()) throw Error("Learning growth requires studio");
    await migrateLifelong(emailClient.db(), OBJECT_ID_CHECKSUM, {version:27,checksum:GROWTH_CHECKSUM,schemas:GROWTH_SCHEMAS});
  }
  if (lifelongEnabled()) {
 await migrateLifelong(emailClient.db(), OBJECT_ID_CHECKSUM);
 await migrateLifelong(emailClient.db(), OBJECT_ID_CHECKSUM, {version: 24, checksum: STUDY_CHECKSUM, schemas: STUDY_SCHEMAS});
 await migrateLifelong(emailClient.db(), OBJECT_ID_CHECKSUM, {version: 25, checksum: PLANNING_CHECKSUM, schemas: PLANNING_SCHEMAS});
 }
 } finally { await emailClient.close(); }
 if(!recoveryEnabled())return migrateCore(uri);
 assertRecoveryConfiguration();const coordinator=new MongoClient(uri);await coordinator.connect();
 try{
  if(!await coordinator.db().collection('schema_migrations').findOne({version:10,status:'completed',checksum:OBJECT_ID_CHECKSUM}))await initializeObjectId(uri,OBJECT_ID_SCHEMAS,OBJECT_ID_CHECKSUM,ROLE_CAPABILITIES);
  return await withRecoveryMigration(coordinator.db(),()=>migrateCore(uri));
 }finally{await coordinator.close();}
}
async function migrateCore(uri: string): Promise<void> {
  requireLearningAiDependencies();
  if (process.env.KL_TRAINING_ENABLED !== "true") {
    if(!recoveryEnabled()){
      const coreClient = new MongoClient(uri); await coreClient.connect();
      try { await assertSchema(coreClient.db()); } finally { await coreClient.close(); }
      return;
    }
    assertRecoveryConfiguration();
    const controlClient=new MongoClient(uri);await controlClient.connect();
    try{if(!await controlClient.db().collection('schema_migrations').findOne({version:10,status:'completed',checksum:OBJECT_ID_CHECKSUM}))await initializeObjectId(uri,OBJECT_ID_SCHEMAS,OBJECT_ID_CHECKSUM,ROLE_CAPABILITIES);
      await migrateRecovery(controlClient.db());await assertSchema(controlClient.db());return;
    }finally{await controlClient.close();}
  }
  const client = new MongoClient(uri); await client.connect();
  try {
    const marker = await client.db().collection('schema_migrations').findOne({version:10,status:'completed',checksum:OBJECT_ID_CHECKSUM});
    if (!marker) await initializeObjectId(uri, OBJECT_ID_SCHEMAS, OBJECT_ID_CHECKSUM, ROLE_CAPABILITIES);
    if (await client.db().collection('schema_migrations').findOne({version:11,status:'completed',checksum:TRAINING_CHECKSUM}) && (process.env.KL_COURSEWORK_FILES_ENABLED !== 'true' || await client.db().collection('schema_migrations').findOne({version:12,status:'completed',checksum:COURSEWORK_FILES_CHECKSUM})) && (process.env.KL_AI_POLICY_ENABLED !== 'true' || await client.db().collection('schema_migrations').findOne({version:13,status:'completed',checksum:AI_POLICY_CHECKSUM})) && (process.env.KL_TRAINING_REPORTS_ENABLED !== 'true' || await client.db().collection('schema_migrations').findOne({version:14,status:'completed',checksum:TRAINING_REPORT_CHECKSUM})) && (process.env.KL_TRAINING_PHASE2_ENABLED !== 'true' || await client.db().collection('schema_migrations').findOne({version:15,status:'completed',checksum:TRAINING_PHASE2_CHECKSUM})) && (process.env.KL_AI_LEARNING_REPORTS_ENABLED !== 'true' || await client.db().collection('schema_migrations').findOne({version:16,status:'completed',checksum:AI_LEARNING_CHECKSUM})) && (process.env.KL_KNOWLEDGE_ENABLED !== 'true' || await client.db().collection('schema_migrations').findOne({version:17,status:'completed',checksum:KNOWLEDGE_CHECKSUM})) && (process.env.KL_KNOWLEDGE_IMPORT_ENABLED !== "true" || await client.db().collection("schema_migrations").findOne({version:19,status:"completed",checksum:PROVENANCE_CHECKSUM})) && (process.env.KL_TRAINING_SURVEYS_ENABLED !== "true" || await client.db().collection("schema_migrations").findOne({version:20,status:"completed",checksum:SURVEY_CHECKSUM}))) { if(recoveryEnabled())await migrateRecovery(client.db()); await assertSchema(client.db()); return; }
    // No active application writers may observe a half-migrated extension.
    const writers = await client.db().collection('operational_writers').findOne({state:'running'});
    if (writers) throw new Error('Training migration requires stopped writers');
    if(recoveryEnabled()){assertRecoveryConfiguration();await migrateRecovery(client.db());} await migrateTraining(client.db(),OBJECT_ID_SCHEMAS); if(process.env.KL_COURSEWORK_FILES_ENABLED === "true") await migrateCourseworkFiles(client.db(),trainingSchemas(OBJECT_ID_SCHEMAS)); if(process.env.KL_AI_POLICY_ENABLED === "true") await migrateAiPolicy(client.db(),preAiTrainingSchemas()); if(process.env.KL_TRAINING_REPORTS_ENABLED === "true") await migrateTrainingReports(client.db(),preReportSchemas()); if(process.env.KL_TRAINING_PHASE2_ENABLED === "true") await migrateTrainingPhase2(client.db(),prePhase2Schemas()); if(process.env.KL_AI_LEARNING_REPORTS_ENABLED === "true") await migrateAiLearning(client.db(),preLearningAiSchemas()); if(process.env.KL_KNOWLEDGE_ENABLED === "true") await migrateKnowledge(client.db(),preKnowledgeSchemas()); if(process.env.KL_KNOWLEDGE_IMPORT_ENABLED === "true"){await migrateImports(client.db(),preImportSchemas());await migrateProvenance(client.db(),preProvenanceSchemas());} if(process.env.KL_TRAINING_SURVEYS_ENABLED === "true")await migrateSurveys(client.db(),preSurveySchemas()); if(recoveryEnabled())await migrateRecovery(client.db()); await assertSchema(client.db());
  } finally { await client.close(); }
}

async function migrateThrough(uri: string, targetVersion: 8 | 9): Promise<void> {
  const preflight = await inspectLegacyMigration(uri);
  assertLearningImpactSafe(preflight);
  if (targetVersion === 9 && (preflight.invalid_grants || preflight.invalid_roles !== preflight.old_reviewer_roles ||
      preflight.unbound_grants || preflight.unfinished_operations))
    throw new Error("v9 migration preflight found invalid grants, invalid roles or unfinished operations");
  if (Array.from({ length: targetVersion }, (_, index) => index + 1).every(version =>
    preflight.markers.some(marker => marker.version === version && marker.status === "completed"))) {
    const ready = new MongoClient(uri, { serverSelectionTimeoutMS: COMMAND_MS });
    try { await ready.connect(); await (targetVersion === 9 ? assertLegacySchema(ready.db()) : assertSchemaVersion8(ready.db())); return; }
    finally { await ready.close(); }
  }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: COMMAND_MS });
  await client.connect();
  let writer: { release: () => Promise<void> } | undefined;
  try {
    const state = await client.db().collection<Document & { _id: string }>("operational_state").findOne({ _id: "environment" });
    if (!state && await client.db().collection("schema_migrations").findOne({ version: 7, status: "completed" })) throw new Error("Operational state is missing for completed v7");
    if (state) writer = await acquireWriter(client.db(), "migration", true);
    await migrateVersion6(uri);
    writer ??= await acquireWriter(client.db(), "migration", true);
    await migrateVersion(uri, { version: 7, checksum: PRIVACY_V7_CHECKSUM, schemas: PRIVACY_SCHEMAS, assert: assertSchemaVersion7, seedRoles: false,
      prepare: async (db, migrationClient, renew, held) => {
        await renew();
        assertLearningImpactSafe(await inspectCurrent(db));
        await runInTxn(
          migrationClient,
          async (session) => {
            const fence = await db.collection("schema_migrations").updateOne(held(), [{ $set: { lease_until: { $add: ["$$NOW", LEASE_MS] } } }], { session, maxTimeMS: COMMAND_MS });
            if (fence.matchedCount !== 1) throw new Error("Migration lease lost");
            await db.collection("users").updateMany({ privacy_state: { $exists: false } }, { $set: { privacy_state: "active" } }, { session, bypassDocumentValidation: true, maxTimeMS: COMMAND_MS });
            for await (const tombstone of db.collection("privacy_tombstones").find({}, { session, maxTimeMS: COMMAND_MS })) {
              await db.collection("users").updateOne({ _id: tombstone.user_id, privacy_state: { $ne: "erased" } }, { $set: { privacy_state: tombstone.state === "erased" ? "erased" : "erasing", status: "disabled" } }, { session, bypassDocumentValidation: true, maxTimeMS: COMMAND_MS });
            }
          },
          { readConcern: { level: "snapshot" }, writeConcern: WRITE_CONCERN, readPreference: "primary" },
        );
      },
      finalize: async (db, session) => {
        await db.collection<Document & { _id: string }>("operational_state").updateOne({ _id: "environment" }, { $setOnInsert: { environment_id: null, mode: "unregistered", revision: 0, access_fence: 0, restore_id: null, maintenance_token: null, owner: null, updated_at: new Date() } }, { upsert: true, session, maxTimeMS: COMMAND_MS });
      },
    });
    await migrateVersion(uri, { version: 8, checksum: TEACHING_V8_CHECKSUM, schemas: TEACHING_V8_SCHEMAS, assert: assertSchemaVersion8, seedRoles: ROLE_CAPABILITIES,
      prepare: async (db, _client, renew) => {
        await renew();
        assertLearningImpactSafe(await inspectCurrent(db));
      },
    });
    if (targetVersion === 9) await migrateVersion(uri, { version: 9, checksum: ADMINISTRATION_V9_CHECKSUM, schemas: ADMINISTRATION_V9_SCHEMAS, assert: assertLegacySchema, seedRoles: false,
      prepare: async (db, migrationClient, renew, held) => {
        await renew();
        const impact = await inspectVersion9(db, Object.keys(CURRENT_SCHEMAS));
        if (impact.invalid_grants || impact.invalid_roles !== impact.old_reviewer_roles ||
            impact.unbound_grants || impact.unfinished_operations || impact.unknown_collections.length)
          throw new Error("v9 migration preflight found invalid grants, invalid roles, unfinished operations or unknown collections");
        await runInTxn(migrationClient, async session => {
          const fence = await db.collection("schema_migrations").updateOne(held(), [{ $set: { lease_until: { $add: ["$$NOW", LEASE_MS] } } }], { session, maxTimeMS: COMMAND_MS });
          if (fence.matchedCount !== 1) throw new Error("Migration lease lost");
          await db.collection("member_capability_grants").updateMany(
            { status: { $exists: false } },
            [{ $set: { status: "active", revision: 1, valid_from: new Date(0), valid_to: null,
              operation_id: null, authority: "legacy", created_at: "$$NOW", updated_at: "$$NOW" } }],
            { session, bypassDocumentValidation: true, maxTimeMS: COMMAND_MS });
          await db.collection("member_roles").updateMany(
            { role_id: "content_reviewer", authority: { $exists: false } },
            { $set: { status: "active", valid_from: new Date(0), valid_to: null, operation_id: null,
              approval_id: null, authority: "legacy" } },
            { session, bypassDocumentValidation: true, maxTimeMS: COMMAND_MS });
        }, { readConcern: { level: "snapshot" }, writeConcern: WRITE_CONCERN, readPreference: "primary" });
        await renew();
        const after = await inspectVersion9(db, Object.keys(CURRENT_SCHEMAS));
        if (after.old_grants || after.old_reviewer_roles || after.invalid_grants || after.invalid_roles || after.unbound_grants)
          throw new Error("Legacy grant or reviewer role conversion incomplete");
      },
      finalize: async (db, session) => {
        await db.collection<AdministrationGuard>("administration_guard").updateOne({ _id: "administration" },
          { $setOnInsert: { _id: "administration", revision: 1, state: "idle", operation_id: null, recovery_token: null,
            blocked_targets: { user_ids: [], member_ids: [], org_ids: [], global: false }, affected_orgs: [], updated_at: new Date() } },
          { upsert: true, session, maxTimeMS: COMMAND_MS });
      },
    });
  } finally { try { await writer?.release(); } finally { await client.close(); } }
}

export async function assertSchema(
  db: Db,
  context: CheckContext = {},
): Promise<void> {
  assertRecoveryConfiguration();
  requireLearningAiDependencies();
  if (loadEmailConfig().actionsEnabled && (await probeTopology(db)).mode !== "replicaSet")
    throw Error("AUTH_TRANSACTION_REQUIRED");
  const requirements: Array<[number, string, string]> = [];
  requirements.push([22, AUTH_EMAIL_CHECKSUM, "Auth email v22 migration incomplete"]);
  if (studioEnabled()) {
    if (process.env.KL_TRAINING_ENABLED !== "true") throw Error("Learning studio requires training");
    if ((await probeTopology(db)).mode !== "replicaSet") throw Error("STUDIO_TRANSACTION_REQUIRED");
    requirements.push([26, STUDIO_CHECKSUM, "Learning studio v26 migration incomplete"]);
  }
  if (growthEnabled()) {
    if (!studioEnabled()) throw Error("Learning growth requires studio");
    requirements.push([27, GROWTH_CHECKSUM, "Learning growth v27 migration incomplete"]);
  }
  if (lifelongEnabled()) {
    if ((await probeTopology(db)).mode !== "replicaSet") throw Error("LIFELONG_TRANSACTION_REQUIRED");
    requirements.push([23, LIFELONG_CHECKSUM, "Lifelong v23 migration incomplete"]);
    requirements.push([24, STUDY_CHECKSUM, "Personal study v24 migration incomplete"]);
    requirements.push([25, PLANNING_CHECKSUM, "Personal planning v25 migration incomplete"]);
  }
  const add = (
    enabled: boolean,
    version: number,
    checksum: string,
    message: string,
  ) => {
    if (enabled) requirements.push([version, checksum, message]);
  };
  add(
    recoveryEnabled(),
    21,
    RECOVERY_CHECKSUM,
    "Recovery v21 migration incomplete",
  );
  add(
    process.env.KL_KNOWLEDGE_IMPORT_ENABLED === "true",
    18,
    IMPORT_CHECKSUM,
    "Knowledge import v18 migration incomplete",
  );
  add(
    process.env.KL_TRAINING_SURVEYS_ENABLED === "true",
    20,
    SURVEY_CHECKSUM,
    "Survey v20 migration required",
  );
  add(
    process.env.KL_KNOWLEDGE_IMPORT_ENABLED === "true",
    19,
    PROVENANCE_CHECKSUM,
    "Knowledge provenance v19 migration incomplete",
  );
  add(
    process.env.KL_KNOWLEDGE_ENABLED === "true",
    17,
    KNOWLEDGE_CHECKSUM,
    "Knowledge v17 migration incomplete",
  );
  add(
    process.env.KL_AI_LEARNING_REPORTS_ENABLED === "true",
    16,
    AI_LEARNING_CHECKSUM,
    "AI learning v16 migration incomplete",
  );
  add(
    process.env.KL_TRAINING_PHASE2_ENABLED === "true",
    15,
    TRAINING_PHASE2_CHECKSUM,
    "Training phase2 v15 migration incomplete",
  );
  add(
    process.env.KL_TRAINING_REPORTS_ENABLED === "true",
    14,
    TRAINING_REPORT_CHECKSUM,
    "Training reports v14 migration incomplete",
  );
  add(
    process.env.KL_TRAINING_ENABLED === "true",
    11,
    TRAINING_CHECKSUM,
    "Training v11 migration incomplete",
  );
  add(
    process.env.KL_COURSEWORK_FILES_ENABLED === "true",
    12,
    COURSEWORK_FILES_CHECKSUM,
    "Coursework files v12 migration incomplete",
  );
  add(
    process.env.KL_AI_POLICY_ENABLED === "true",
    13,
    AI_POLICY_CHECKSUM,
    "AI policy v13 migration incomplete",
  );
  const rows = await checkStep(context, "schema.migrations", () =>
    rawDatabase(db)
      .collection("schema_migrations")
      .find(
        { version: { $in: [10, ...requirements.map((r) => r[0])] } },
        {
          projection: {
            _id: 0,
            version: 1,
            status: 1,
            checksum: 1,
            completed_at: 1,
          },
          maxTimeMS: 10000,
          signal: context.signal,
        },
      )
      .limit(101)
      .toArray(),
  );
  if (
    rows.length > 100 ||
    new Set(rows.map((r) => r.version)).size !== rows.length
  )
    throw Error("SCHEMA_MIGRATION_RECORDS_INVALID");
  const records = new Map(rows.map((r) => [r.version, r]));
  for (const [version, checksum, message] of requirements) {
    const row = records.get(version);
    if (!row || row.status !== "completed" || row.checksum !== checksum ||
        !(row.completed_at instanceof Date) || !Number.isFinite(row.completed_at.getTime()))
      throw Error(message);
  }
  await assertObjectIdSchema(
    db,
    effectiveRuntimeSchemas(),
    OBJECT_ID_CHECKSUM,
    context,
    records.get(10) ?? null,
  );
}
export async function inspectMigration(uri: string) {
 const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
 try { await client.connect(); const db = client.db(); await assertTopology(db, loadConfig());
 const collections = await db.listCollections({}, {nameOnly:true}).toArray();
 const markers = collections.some(c=>c.name==="schema_migrations") ? await db.collection("schema_migrations").find({}, {projection:{_id:0,version:1,status:1,checksum:1,completed_at:1}}).toArray() : [];
 const registry=systemBackupRegistry();
 return {target_version:registry.version,mode:collections.length?'existing':'empty',collections:collections.map(c=>c.name),markers,requires_legacy_migration:markers.some(m=>m.version<10),checksum:registry.checksums[String(registry.version) as keyof typeof registry.checksums]};
 } finally { await client.close(); }
}
