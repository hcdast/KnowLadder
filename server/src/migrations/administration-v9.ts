import { createHash } from "node:crypto";
import { type Db, type Document, type IndexDescription } from "mongodb";
import { TEACHING_V8_SCHEMAS } from "./teaching-v8";
import { CONTENT_V3_SCHEMAS } from "./content-v3";
import { ADMINISTRATIVE_CATALOG } from "../administration/catalog";

export type Schema = { validator: Document; indexes: IndexDescription[] };
const uuid = { bsonType: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" };
const nullable = (shape: Document) => ({ anyOf: [shape, { bsonType: "null" }] });
const text = { bsonType: "string", minLength: 1, maxLength: 1024 };
const digest = { bsonType: "string", pattern: "^[a-f0-9]{64}$" };
const date = { bsonType: "date" };
const positive = { bsonType: ["int", "long", "double"], minimum: 1, multipleOf: 1 };
const nonnegative = { bsonType: ["int", "long", "double"], minimum: 0, multipleOf: 1 };
const ids = { bsonType: "array", items: uuid, uniqueItems: true, maxItems: 1000 };
const targets = { bsonType: "object", additionalProperties: false, required: ["user_ids", "member_ids", "org_ids", "global"],
  properties: { user_ids: ids, member_ids: ids, org_ids: ids, global: { bsonType: "bool" } } };
const scope = { oneOf: [
  { bsonType: "object", additionalProperties: false, required: ["kind", "organization_ids"], properties: { kind: { enum: ["organization_ids"] }, organization_ids: { ...ids, minItems: 1 } } },
  { bsonType: "object", additionalProperties: false, required: ["kind", "organization_ids"], properties: { kind: { enum: ["all_organizations"] }, organization_ids: { ...ids, maxItems: 0 } } },
] };
const grantPeriod = { $and: [{ $lte: ["$created_at", "$updated_at"] }, { $or: [{ $eq: ["$valid_to", null] }, { $lt: ["$valid_from", "$valid_to"] }] }] };
const strict = (properties: Document, indexes: IndexDescription[], expressions?: Document): Schema => ({
  validator: expressions ? { $and: [{ $jsonSchema: { bsonType: "object", additionalProperties: false, required: Object.keys(properties), properties } }, { $expr: expressions }] }
    : { $jsonSchema: { bsonType: "object", additionalProperties: false, required: Object.keys(properties), properties } },
  indexes,
});
const roleCodes = ["student", "teacher", "content_editor", "content_reviewer", "org_admin", "platform_ops"] as const;
const memberRoleSchema: Schema = {
  validator: { $and: [
    { $jsonSchema: { bsonType: "object", additionalProperties: false,
      required: ["_id", "org_id", "member_id", "role_id"],
      properties: { _id: uuid, org_id: uuid, member_id: uuid, role_id: { enum: [...roleCodes] },
        status: { enum: ["pending", "active", "revoked"] }, valid_from: date, valid_to: nullable(date),
        operation_id: nullable(uuid), approval_id: nullable(uuid), authority: { enum: ["legacy", "cli", "approval"] } } } },
    { $expr: { $or: [
      { $ne: ["$role_id", "content_reviewer"] },
      { $and: [
        { $in: ["$authority", ["legacy", "cli", "approval"]] },
        { $eq: [{ $type: "$valid_from" }, "date"] },
        { $in: ["$status", ["pending", "active", "revoked"]] },
        { $or: [
          { $and: [{ $eq: ["$authority", "legacy"] }, { $eq: ["$valid_to", null] },
            { $eq: ["$operation_id", null] }, { $eq: ["$approval_id", null] }] },
          { $and: [{ $in: ["$authority", ["cli", "approval"]] }, { $eq: [{ $type: "$valid_to" }, "date"] },
            { $lt: ["$valid_from", "$valid_to"] }, { $ne: ["$operation_id", null] },
            { $cond: [{ $eq: ["$authority", "approval"] }, { $ne: ["$approval_id", null] }, { $eq: ["$approval_id", null] }] }] },
        ] },
      ] },
    ] } },
  ] },
  indexes: [{ name: "member_roles_org_member_role_unique", key: { org_id: 1, member_id: 1, role_id: 1 }, unique: true }],
};

const grantFields = {
  _id: uuid, org_id: uuid, member_id: uuid, capability: { enum: TEACHING_V8_SCHEMAS.member_capability_grants.validator.$jsonSchema.properties.capability.enum },
  status: { enum: ["pending", "active", "revoked"] }, revision: positive, valid_from: date, valid_to: nullable(date),
  operation_id: nullable(uuid), authority: { enum: ["legacy", "cli", "delegation", "approval"] }, created_at: date, updated_at: date,
};
const administrativeGrantFields = {
  _id: uuid, subject_member_id: uuid, actor_org_id: uuid, capability: { enum: Object.keys(ADMINISTRATIVE_CATALOG) },
  scope, scope_key: digest, delegate_capabilities: { bsonType: "array", items: text, uniqueItems: true, maxItems: 16 },
  status: { enum: ["pending", "active", "revoked"] }, revision: positive, valid_from: date, valid_to: nullable(date),
  operation_id: uuid, authority: { enum: ["cli", "delegation", "approval"] }, approval_id: nullable(uuid), created_at: date, updated_at: date,
};
const audit = structuredClone(TEACHING_V8_SCHEMAS.audit_events);
const auditShape = audit.validator.$jsonSchema;
Object.assign(auditShape.properties, {
  actor_org_id: nullable(uuid), target_org_id: nullable(uuid), grant_id: nullable(uuid), grant_ids: { bsonType: "array", items: uuid, uniqueItems: true, maxItems: 100 },
  grant_revision: positive, approval_id: nullable(uuid), operation_id: nullable(uuid),
});
auditShape.properties.resource_type.enum.push("organization", "user", "authorization_grant", "approval", "administration_operation", "report", "business_receipt");
audit.indexes.push({ name: "audit_events_operation", key: { operation_id: 1, _id: 1 } });
const fileResources = structuredClone(CONTENT_V3_SCHEMAS.file_resources);
const fileShape = fileResources.validator.$jsonSchema ?? fileResources.validator.$and[0].$jsonSchema;
fileShape.properties.upload_actor_user_id = nullable(uuid);
fileShape.properties.upload_actor_org_id = nullable(uuid);


export const ADMINISTRATION_V9_SCHEMAS: Record<string, Schema> = {
  member_roles: memberRoleSchema,
  member_capability_grants: strict(grantFields, TEACHING_V8_SCHEMAS.member_capability_grants.indexes,
    { $and: [grantPeriod, { $or: [{ $and: [{ $eq: ["$authority", "legacy"] },
      { $eq: ["$operation_id", null] }] }, { $and: [{ $ne: ["$authority", "legacy"] },
      { $ne: ["$operation_id", null] }] }] }] }),
  administrative_grants: strict(administrativeGrantFields, [
    { name: "administrative_grants_tuple", key: { subject_member_id: 1, capability: 1, scope_key: 1, valid_from: 1 }, unique: true },
    { name: "administrative_grants_subject", key: { subject_member_id: 1, status: 1, valid_from: 1, _id: 1 } },
    { name: "administrative_grants_scope", key: { "scope.organization_ids": 1, capability: 1, status: 1, _id: 1 } },
  ], { $and: [grantPeriod, { $or: [{ $ne: ["$capability", "platform:govern"] }, { $eq: ["$valid_to", null] }] }] }),
  authorization_requests: strict({ _id: uuid, requester_user_id: uuid, requester_member_id: uuid,
    beneficiary_user_id: uuid, subject_member_id: nullable(uuid), action: text, payload: { bsonType: "object" }, payload_hash: digest,
    expected_grant_revision: nullable(positive), requester_permission_revision: positive, requester_credential_version: positive,
    target_credential_version: nonnegative, target_identity_revision: nonnegative, reason: text,
    status: { enum: ["pending", "approved", "rejected", "applying", "applied", "needs_recovery"] }, revision: positive,
    approver_user_id: nullable(uuid), approver_credential_version: nullable(positive), approved_at: nullable(date),
    operation_id: nullable(uuid), created_at: date, updated_at: date,
  }, [{ name: "authorization_requests_requester", key: { requester_user_id: 1, status: 1, _id: 1 } },
    { name: "authorization_requests_beneficiary", key: { beneficiary_user_id: 1, status: 1, _id: 1 } }]),
  administration_operations: strict({ _id: uuid, actor_id: text, action: text, reason: text, targets,
    payload_hash: digest, before: { bsonType: "object" }, desired: { bsonType: "object" }, key: nullable(text), mode: { enum: ["replicaSet", "standalone"] },
    status: { enum: ["pending", "applying", "applied", "needs_recovery", "void"] }, step: text, revision: positive,
    audit_id: nullable(uuid), created_at: date, updated_at: date,
  }, [{ name: "administration_operations_actor_key", key: { actor_id: 1, action: 1, key: 1 }, unique: true, partialFilterExpression: { key: { $type: "string" } } },
    { name: "administration_operations_active_users", key: { "targets.user_ids": 1, status: 1, _id: 1 } },
    { name: "administration_operations_active_members", key: { "targets.member_ids": 1, status: 1, _id: 1 } },
    { name: "administration_operations_active_orgs", key: { "targets.org_ids": 1, status: 1, _id: 1 } }]),
  administration_guard: strict({ _id: { enum: ["administration"] }, revision: positive,
    state: { enum: ["idle", "applying", "needs_recovery", "recovering"] }, operation_id: nullable(uuid), recovery_token: nullable(uuid), blocked_targets: targets,
    affected_orgs: ids, updated_at: date,
  }, []),
  audit_events: audit,
  file_resources: fileResources,
};

export const ADMINISTRATION_V9_CHECKSUM = createHash("sha256").update(JSON.stringify({ version: 9, schemas: ADMINISTRATION_V9_SCHEMAS,
  defaults: { status: "active", revision: 1, valid_from: "1970-01-01T00:00:00.000Z", valid_to: null, operation_id: null, authority: "legacy" },
})).digest("hex");

/** Read-only preflight: no broadening of existing grants; invalid data always blocks cutover. */
export async function inspectVersion9(db: Db, knownCollections: readonly string[]): Promise<{ target_version: 9; old_grants: number; old_reviewer_roles: number; invalid_grants: number; invalid_roles: number; unbound_grants: number; unfinished_operations: number; unknown_collections: string[] }> {
  const old_grants = await db.collection("member_capability_grants").countDocuments({ status: { $exists: false } });
  const old_reviewer_roles = await db.collection("member_roles").countDocuments({ role_id: "content_reviewer", authority: { $exists: false } });
  const invalid_grants = await db.collection("member_capability_grants").countDocuments({ $nor: [TEACHING_V8_SCHEMAS.member_capability_grants.validator, ADMINISTRATION_V9_SCHEMAS.member_capability_grants.validator] });
  const invalid_roles = await db.collection("member_roles").countDocuments({ $nor: [ADMINISTRATION_V9_SCHEMAS.member_roles.validator] });
  const memberReferences = (await db.collection("member_capability_grants").aggregate([
    { $lookup: { from: "organization_members", localField: "member_id", foreignField: "_id", as: "member" } },
    { $match: { $or: [{ member: { $size: 0 } }, { $expr: { $ne: ["$org_id", { $arrayElemAt: ["$member.org_id", 0] }] } }] } },
    { $count: "count" },
  ]).toArray())[0]?.count ?? 0;
  const administrativeReferences = (await db.collection("administrative_grants").aggregate([
    { $lookup: { from: "organization_members", localField: "subject_member_id", foreignField: "_id", as: "member" } },
    { $lookup: { from: "organizations", localField: "actor_org_id", foreignField: "_id", as: "actor_org" } },
    { $lookup: { from: "organizations", localField: "scope.organization_ids", foreignField: "_id", as: "scope_orgs" } },
    { $match: { $or: [
      { member: { $size: 0 } }, { actor_org: { $size: 0 } },
      { $expr: { $or: [
        { $ne: ["$actor_org_id", { $arrayElemAt: ["$member.org_id", 0] }] },
        { $ne: [{ $size: "$scope.organization_ids" }, { $size: "$scope_orgs" }] },
      ] } },
    ] } },
    { $count: "count" },
  ]).toArray())[0]?.count ?? 0;
  const unbound_grants = memberReferences + administrativeReferences;
  const unfinished_operations = await db.collection("administration_operations").countDocuments({ status: { $in: ["pending", "applying", "needs_recovery"] } });
  const names = await db.listCollections({}, { nameOnly: true }).toArray();
  const known = new Set(knownCollections);
  return { target_version: 9, old_grants, old_reviewer_roles, invalid_grants, invalid_roles, unbound_grants, unfinished_operations,
    unknown_collections: names.filter(row => !known.has(row.name)).map(row => row.name) };
}
