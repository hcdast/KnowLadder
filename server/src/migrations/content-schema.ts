import { createHash } from "node:crypto";
import type { Document, IndexDescription } from "mongodb";

// Version two is immutable after deployment; version-one definitions remain untouched.
const UUID = { bsonType: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" };
const text = { bsonType: "string" };
const title = { ...text, minLength: 1, maxLength: 200 };
const date = { bsonType: "date" };
const nullable = (schema: Document): Document => ({ anyOf: [schema, { bsonType: "null" }] });
const integer = { bsonType: ["int", "long", "double"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 };
const ids = (maxItems: number): Document => ({ bsonType: "array", items: UUID, uniqueItems: true, maxItems });
const hash = { ...text, pattern: "^[0-9a-f]{64}$" };
const timestamps = { created_at: date, updated_at: date };
function object(properties: Document): Document {
  return { bsonType: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
function schema(properties: Document, indexes: IndexDescription[], expressions: Document[] = []) {
  const shape = { $jsonSchema: object(properties) };
  return { validator: expressions.length ? { $and: [shape, { $expr: { $and: expressions } }] } : shape, indexes };
}
const version = {
  _id: UUID, org_id: UUID, title, status: { enum: ["draft", "review", "published", "retired"] },
  revision: { ...integer, minimum: 1 }, created_by: UUID, contributors: ids(100), ...timestamps,
  submitted_by: nullable(UUID), submitted_at: nullable(date), published_by: nullable(UUID), published_at: nullable(date),
  source_version_id: nullable(UUID),
  license: object({ source: { ...text, maxLength: 2000 }, granted: { bsonType: "bool" }, expires_at: nullable({ ...text, pattern: "^\\d{4}-\\d{2}-\\d{2}T" }) }),
  resource_ids: ids(20), notes: { ...text, maxLength: 2000 },
};
const versionExpressions = [
  { $lte: ["$created_at", "$updated_at"] },
  { $cond: [{ $eq: ["$status", "published"] }, { $and: [
    { $ne: ["$published_by", null] }, { $ne: ["$published_at", null] },
    { $ne: ["$published_by", "$created_by"] }, { $not: [{ $in: ["$published_by", "$contributors"] }] },
    { $eq: ["$license.granted", true] },
  ] }, true] },
];
const listing = (name: string): IndexDescription => ({ key: { org_id: 1, status: 1, _id: 1 }, name: `${name}_org_status_id` });
const catalog = { _id: UUID, code: { ...text, minLength: 1, maxLength: 100 }, name: title, ...timestamps };
export const CONTENT_SCHEMAS: Record<string, { validator: Document; indexes: IndexDescription[] }> = {
  textbooks: schema({ _id: UUID, org_id: UUID, title, stage_id: UUID, subject_id: UUID, source: text, ...timestamps }, [
    { key: { org_id: 1, _id: 1 }, name: "textbooks_org_id" },
  ]),
  textbook_editions: schema({ ...version, textbook_id: UUID, edition_code: { ...text, minLength: 1, maxLength: 100 } }, [
    listing("textbook_editions"),
    { key: { org_id: 1, textbook_id: 1, edition_code: 1 }, name: "textbook_editions_org_book_code_unique", unique: true },
  ], versionExpressions),
  chapters: schema({ _id: UUID, org_id: UUID, textbook_edition_id: UUID, parent_id: nullable(UUID), position: integer,
    title, body: { ...text, maxLength: 20000 }, knowledge_point_ids: ids(100), resource_ids: ids(20) }, [
    { key: { org_id: 1, textbook_edition_id: 1, parent_id: 1, position: 1 }, name: "chapters_org_edition_tree" },
  ]),
  questions: schema({ _id: UUID, org_id: UUID, next_version_no: { ...integer, minimum: 1 }, ...timestamps }, [
    { key: { org_id: 1, _id: 1 }, name: "questions_org_id" },
  ]),
  question_versions: schema({ ...version, question_id: UUID, version_no: { ...integer, minimum: 1 }, subject_id: UUID,
    question_type: { enum: ["single", "multiple", "numeric"] }, prompt: { ...text, maxLength: 20000 },
    options: { bsonType: "array", maxItems: 12, items: object({ id: { ...text, minLength: 1, maxLength: 32 }, text: { ...text, maxLength: 2000 } }) },
    answer: { ...text, maxLength: 2000 }, explanation: { ...text, maxLength: 20000 }, knowledge_point_ids: ids(100),
    difficulty: { enum: ["基础", "提升", "挑战"] },
  }, [listing("question_versions"),
    { key: { org_id: 1, question_id: 1, version_no: 1 }, name: "question_versions_org_question_version_unique", unique: true },
    { key: { org_id: 1, knowledge_point_ids: 1, status: 1 }, name: "question_versions_org_knowledge_status" },
  ], versionExpressions),
  education_stages: schema(catalog, [{ key: { code: 1 }, name: "education_stages_code_unique", unique: true }]),
  subjects: schema(catalog, [{ key: { code: 1 }, name: "subjects_code_unique", unique: true }]),
  knowledge_points: schema({ ...catalog, subject_id: UUID }, [
    { key: { subject_id: 1, code: 1 }, name: "knowledge_points_subject_code_unique", unique: true },
  ]),
  content_idempotency: schema({ _id: UUID, org_id: UUID, user_id: UUID, operation: { ...text, minLength: 1 },
    resource_id: text, key: { ...text, minLength: 1, maxLength: 200 }, request_hash: hash, result: { bsonType: "object" }, created_at: date }, [
    { key: { org_id: 1, user_id: 1, operation: 1, resource_id: 1, key: 1 }, name: "content_idempotency_scope_key_unique", unique: true },
  ]),
  file_resources: schema({ _id: UUID, org_id: UUID, owner_type: { enum: ["textbook", "question"] }, owner_version_id: UUID,
    created_by: UUID, display_name: { ...text, minLength: 1, maxLength: 200 }, storage_key: UUID,
    declared_size: { ...integer, minimum: 1, maximum: 10485760 }, declared_mime: { ...text, minLength: 1 }, declared_checksum: hash,
    size: nullable({ ...integer, minimum: 1, maximum: 10485760 }), mime: nullable(text), checksum: nullable(hash),
    status: { enum: ["pending", "quarantined", "ready", "deleting"] },
    scan_status: { enum: ["awaiting_upload", "queued", "scanning", "clean", "infected", "failed"] },
    scan_attempt: integer, lease_token: nullable(UUID), lease_until: nullable(date), available_at: date,
    uploaded_at: nullable(date), error_code: nullable(text), ...timestamps,
  }, [
    { key: { org_id: 1, owner_type: 1, owner_version_id: 1 }, name: "file_resources_org_owner" },
    { key: { storage_key: 1 }, name: "file_resources_storage_unique", unique: true },
    { key: { scan_status: 1, available_at: 1, lease_until: 1 }, name: "file_resources_scan_lease" },
  ], [
    { $lte: ["$created_at", "$updated_at"] },
    { $cond: [{ $eq: ["$status", "ready"] }, { $and: [
      { $eq: ["$scan_status", "clean"] }, { $ne: ["$size", null] }, { $ne: ["$mime", null] }, { $ne: ["$checksum", null] },
    ] }, true] },
    { $cond: [{ $eq: ["$scan_status", "scanning"] }, { $and: [
      { $ne: ["$lease_token", null] }, { $ne: ["$lease_until", null] },
    ] }, true] },
  ]),
};
// No TTL on evidence or file records: expiring a scan lease must not delete its resource.
export const CONTENT_SCHEMA_CHECKSUM = createHash("sha256")
  .update(JSON.stringify({ version: 2, schemas: CONTENT_SCHEMAS })).digest("hex");
