import { createHash } from "node:crypto";
import type { ClientSession, Db, Document, IndexDescription } from "mongodb";
import { CONTENT_SCHEMAS } from "./content-schema";
// Historical v3 input must never depend on the runtime grant catalog.
const CONTROLLED_CAPABILITIES = ["content:retire", "content:revoke", "file:delete"] as const;

const uuid = { bsonType: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" };
const nullable = (shape: Document): Document => ({ anyOf: [shape, { bsonType: "null" }] });
const integer = { bsonType: ["int", "long", "double"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 };
const date = nullable({ bsonType: "date" });
const reason = nullable({ bsonType: "string", minLength: 1, maxLength: 1000 });
const access = { access_revision: integer, access_revoked_at: date, access_revoked_by: nullable(uuid), access_revoked_reason: reason,
  retired_at: date, retired_by: nullable(uuid), retired_reason: reason };
const accessDefaults = { access_revision: 0, access_revoked_at: null, access_revoked_by: null, access_revoked_reason: null,
  retired_at: null, retired_by: null, retired_reason: null };
export const V3_DEFAULTS: Record<string, Document> = {
  textbook_editions: accessDefaults,
  question_versions: { ...accessDefaults, scoring_rule: null, knowledge_weights: [], difficulty_basis: "" },
  file_resources: { retention_until: null, legal_hold: false, deletion_requested_at: null, deletion_requested_by: null,
    deletion_requested_reason: null, deleted_at: null, deletion_lease_token: null, deletion_lease_until: null, deletion_attempt: 0,
    upload_key: null, upload_lease_token: null, upload_lease_until: null, upload_storage_key: null, upload_owner_revision: null,
    upload_storage_keys: [],
    upload_result_revision: null, scan_engine_version: null, scan_database_version: null, scan_database_updated_at: null, scanned_at: null },
};
export function withVersion3Defaults(name: string): Document {
  return { $mergeObjects: [{ $literal: V3_DEFAULTS[name] ?? {} }, ...(name === "file_resources" ? [{
    upload_storage_keys: { $cond: [{ $eq: [{ $type: "$upload_storage_key" }, "string"] }, ["$upload_storage_key"], []] },
  }] : []), "$$ROOT"] };
}
export const CONTENT_V3_SCHEMAS: Record<string, { validator: Document; indexes: IndexDescription[] }> = structuredClone(CONTENT_SCHEMAS);
function extend(name: string, fields: Document): void {
  const validator = CONTENT_V3_SCHEMAS[name].validator;
  const shape = validator.$jsonSchema ?? validator.$and[0].$jsonSchema;
  Object.assign(shape.properties, fields);
  shape.required.push(...Object.keys(fields));
}
extend("textbook_editions", access);
extend("question_versions", { ...access,
  scoring_rule: nullable({ bsonType: "object", additionalProperties: false, required: ["version", "strategy", "max_score"], properties: {
    version: { enum: [1] }, strategy: { enum: ["single_exact", "multiple_exact_set", "numeric_exact_decimal"] },
    max_score: { bsonType: "string", pattern: "^(?:(?:[1-9][0-9]?)(?:\\.[0-9]{1,2})?|0\\.(?:0[1-9]|[1-9][0-9]?)|100(?:\\.0{1,2})?)$" },
  } }),
  knowledge_weights: { bsonType: "array", maxItems: 100, items: { bsonType: "object", additionalProperties: false,
    required: ["knowledge_point_id", "weight_bps"], properties: { knowledge_point_id: uuid, weight_bps: { ...integer, minimum: 1, maximum: 10000 } } } },
  difficulty_basis: { bsonType: "string", maxLength: 2000 },
});
extend("file_resources", { retention_until: date, legal_hold: { bsonType: "bool" }, deletion_requested_at: date,
  deletion_requested_by: nullable(uuid), deletion_requested_reason: reason, deleted_at: date,
  deletion_lease_token: nullable(uuid), deletion_lease_until: date, deletion_attempt: integer,
  upload_key: nullable({ bsonType: "string", minLength: 1, maxLength: 200 }), upload_lease_token: nullable(uuid), upload_lease_until: date,
  upload_storage_key: nullable(uuid), upload_owner_revision: nullable({ ...integer, minimum: 1 }), upload_result_revision: nullable({ ...integer, minimum: 1 }),
  upload_storage_keys: { bsonType: "array", items: uuid, maxItems: 100, uniqueItems: true },
  scan_engine_version: nullable({ bsonType: "string", maxLength: 500 }), scan_database_version: nullable({ bsonType: "string", maxLength: 500 }),
  scan_database_updated_at: date, scanned_at: date });
CONTENT_V3_SCHEMAS.file_resources.indexes.push(
  { key: { org_id: 1, owner_type: 1, owner_version_id: 1, _id: 1 }, name: "file_resources_owner_page" },
  { key: { status: 1, retention_until: 1, deletion_lease_until: 1, _id: 1 }, name: "file_resources_deletion_due" },
  { key: { upload_storage_key: 1 }, name: "file_resources_upload_storage" });
CONTENT_V3_SCHEMAS.member_capability_grants = {
  validator: { $jsonSchema: { bsonType: "object", additionalProperties: false, required: ["_id", "org_id", "member_id", "capability"],
    properties: { _id: uuid, org_id: uuid, member_id: uuid, capability: { enum: [...CONTROLLED_CAPABILITIES] } } } },
  indexes: [{ key: { org_id: 1, member_id: 1, capability: 1 }, name: "member_capability_grants_unique", unique: true }],
};
const auditRequired = ["_id", "actor_id", "org_id", "action", "resource_id", "reason", "request_id", "created_at"];
const auditExtra = ["resource_type", "owner_type", "owner_version_id", "revision_before", "revision_after", "access_revision_before", "access_revision_after"];
CONTENT_V3_SCHEMAS.audit_events = {
  validator: { $jsonSchema: { bsonType: "object", additionalProperties: false, required: auditRequired,
    properties: { _id: uuid, actor_id: { bsonType: "string", minLength: 1 }, org_id: nullable(uuid),
      action: { bsonType: "string", minLength: 1 }, resource_id: { bsonType: "string", minLength: 1 },
      reason: { bsonType: "string", minLength: 1 }, request_id: uuid, created_at: { bsonType: "date" },
      resource_type: { enum: ["textbook", "question", "file", "member"] }, owner_type: { enum: ["textbook", "question", null] },
      owner_version_id: nullable(uuid), revision_before: nullable(integer), revision_after: nullable(integer),
      access_revision_before: nullable(integer), access_revision_after: nullable(integer) },
    dependencies: Object.fromEntries(auditExtra.map(field => [field, auditExtra.filter(other => other !== field)])),
  } },
  indexes: [ { key: { org_id: 1, created_at: -1 }, name: "audit_events_org_created" },
    { key: { actor_id: 1, created_at: -1 }, name: "audit_events_actor_created" },
    { key: { request_id: 1 }, name: "audit_events_request" },
    { key: { org_id: 1, owner_type: 1, owner_version_id: 1, _id: 1 }, name: "audit_events_owner_page" } ],
};
export const CONTENT_V3_CHECKSUM = createHash("sha256").update(JSON.stringify({ version: 3, schemas: CONTENT_V3_SCHEMAS, defaults: V3_DEFAULTS })).digest("hex");

export interface MigrationImpact { collections: Record<string, { documents: number; needs_defaults: number; invalid_types: number }>; invalid_references: number; incomplete_questions: number }
/** Read-only, counts only: never prints document contents or repairs anomalous data. */
export async function inspectVersion3(db: Db, session?: ClientSession, effectiveSchemas = CONTENT_V3_SCHEMAS): Promise<MigrationImpact> {
  const options = { session, maxTimeMS: 15000 };
  const report: MigrationImpact = { collections: {}, invalid_references: 0, incomplete_questions: 0 };
  for (const [name, schema] of Object.entries(effectiveSchemas)) {
    const defaults = V3_DEFAULTS[name] ?? {};
    const [counts] = await db.collection(name).aggregate([
      { $facet: { documents: [{ $count: "n" }], needs_defaults: Object.keys(defaults).length ? [
        { $match: { $or: Object.keys(defaults).map(field => ({ [field]: { $exists: false } })) } }, { $count: "n" },
      ] : [{ $match: { _id: { $exists: false } } }, { $count: "n" }], invalid_types: [
        { $replaceWith: withVersion3Defaults(name) },
        { $match: { $nor: [schema.validator] } }, { $count: "n" },
      ] } },
    ], options).toArray();
    report.collections[name] = { documents: counts?.documents[0]?.n ?? 0, needs_defaults: counts?.needs_defaults[0]?.n ?? 0, invalid_types: counts?.invalid_types[0]?.n ?? 0 };
  }
  if (Object.values(report.collections).some(row => row.invalid_types)) return report;
  const reference = async (from: string, to: string, local: string, extra: Document[] = [], array = false) => {
    const pipeline: Document[] = [{ $match: { [local]: { $ne: null } } }];
    if (array) pipeline.push({ $unwind: `$${local}` });
    pipeline.push({ $lookup: { from: to, let: { target: `$${local}`, org: "$org_id", owner: "$owner_version_id", edition: "$textbook_edition_id", self: "$_id" },
      pipeline: [{ $match: { $expr: { $and: [{ $eq: ["$_id", "$$target"] }, ...extra] } } }], as: "reference" } },
      { $match: { reference: { $size: 0 } } }, { $count: "n" });
    const [result] = await db.collection(from).aggregate(pipeline, options).toArray();
    report.invalid_references += result?.n ?? 0;
  };
  const sameOrg = { $eq: ["$org_id", "$$org"] };
  for (const [from, local, to] of [
    ["textbook_editions", "textbook_id", "textbooks"], ["question_versions", "question_id", "questions"],
    ["chapters", "textbook_edition_id", "textbook_editions"], ["textbook_editions", "source_version_id", "textbook_editions"],
    ["question_versions", "source_version_id", "question_versions"], ["member_capability_grants", "member_id", "organization_members"],
  ]) await reference(from, to, local, [sameOrg]);
  await reference("chapters", "chapters", "parent_id", [sameOrg, { $eq: ["$textbook_edition_id", "$$edition"] }]);
  for (const name of ["textbook_editions", "question_versions", "chapters"]) {
    const kind = name === "question_versions" ? "question" : "textbook";
    await reference(name, "file_resources", "resource_ids", [sameOrg, { $eq: ["$owner_type", kind] },
      { $eq: ["$owner_version_id", name === "chapters" ? "$$edition" : "$$self"] }], true);
  }
  for (const [kind, target] of [["textbook", "textbook_editions"], ["question", "question_versions"]]) {
    const [result] = await db.collection("file_resources").aggregate([
      { $match: { owner_type: kind } }, { $lookup: { from: target, let: { owner: "$owner_version_id", org: "$org_id" },
        pipeline: [{ $match: { $expr: { $and: [{ $eq: ["$_id", "$$owner"] }, sameOrg] } } }], as: "reference" } },
      { $match: { reference: { $size: 0 } } }, { $count: "n" },
    ], options).toArray(); report.invalid_references += result?.n ?? 0;
  }
  for (const [from, field, target] of [["textbooks", "stage_id", "education_stages"], ["textbooks", "subject_id", "subjects"],
    ["question_versions", "subject_id", "subjects"], ["knowledge_points", "subject_id", "subjects"]]) await reference(from, target, field);
  for (const name of ["chapters", "question_versions"]) await reference(name, "knowledge_points", "knowledge_point_ids", [], true);
  // Existing references must also belong to the version's subject; existence alone is insufficient.
  for (const name of ["chapters", "question_versions"]) {
    const pipeline: Document[] = [];
    if (name === "chapters") pipeline.push(
      { $lookup: { from: "textbook_editions", localField: "textbook_edition_id", foreignField: "_id", as: "edition" } },
      { $unwind: "$edition" },
      { $lookup: { from: "textbooks", localField: "edition.textbook_id", foreignField: "_id", as: "textbook" } },
      { $unwind: "$textbook" });
    pipeline.push({ $unwind: "$knowledge_point_ids" },
      { $lookup: { from: "knowledge_points", localField: "knowledge_point_ids", foreignField: "_id", as: "point" } },
      { $unwind: "$point" },
      { $match: { $expr: { $ne: ["$point.subject_id", name === "chapters" ? "$textbook.subject_id" : "$subject_id"] } } },
      { $count: "n" });
    const [result] = await db.collection(name).aggregate(pipeline, options).toArray();
    report.invalid_references += result?.n ?? 0;
  }
  // A reused/exhausted root counter would allocate an existing or unsafe version number.
  const [unsafeCounters] = await db.collection("questions").aggregate([
    { $lookup: { from: "question_versions", let: { root: "$_id" }, pipeline: [
      { $match: { $expr: { $eq: ["$question_id", "$$root"] } } },
      { $group: { _id: null, maximum: { $max: "$version_no" } } },
    ], as: "versions" } },
    { $match: { $expr: { $or: [
      { $lte: ["$next_version_no", { $ifNull: [{ $arrayElemAt: ["$versions.maximum", 0] }, 0] }] },
      { $gte: ["$next_version_no", Number.MAX_SAFE_INTEGER] },
    ] } } }, { $count: "n" },
  ], options).toArray();
  report.collections.questions.invalid_types += unsafeCounters?.n ?? 0;
  report.incomplete_questions = await db.collection("question_versions").countDocuments({ $or: [
    { scoring_rule: null }, { difficulty_basis: { $exists: false } }, { difficulty_basis: "" },
    { knowledge_weights: { $exists: false } }, { knowledge_weights: { $size: 0 } },
  ] }, options);
  return report;
}
export function assertImpactSafe(report: MigrationImpact): void {
  if (report.invalid_references || Object.values(report.collections).some(row => row.invalid_types))
    throw new Error("Migration preflight found invalid types or references; no repair is permitted");
}
