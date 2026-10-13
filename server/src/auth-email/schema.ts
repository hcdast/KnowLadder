import { createHash } from "node:crypto";
import type { Document, IndexDescription } from "mongodb";

export type EmailSchema = { validator: Document; indexes: IndexDescription[] };
const id = { bsonType: "objectId" };
const nullableId = { bsonType: ["objectId", "null"] };
const text = { bsonType: "string", minLength: 1, maxLength: 512 };
const date = { bsonType: "date" };
const nullableDate = { bsonType: ["date", "null"] };
const positive = { bsonType: ["int", "long", "double", "decimal"], minimum: 1, multipleOf: 1 };
const nullablePositive = { anyOf: [positive, { bsonType: "null" }] };
const digest = { bsonType: "string", pattern: "^[0-9a-f]{64}$" };
const purpose = { enum: ["register", "bind", "reset", "invite"] };
const email = { bsonType: "string", minLength: 3, maxLength: 254 };
const roles = { bsonType: "array", minItems: 1, maxItems: 6, uniqueItems: true,
  items: { enum: ["student", "teacher", "content_editor", "content_reviewer", "org_admin", "platform_ops"] } };
function strict(properties: Document, indexes: IndexDescription[], expressions: Document[] = []): EmailSchema {
  const shape = { $jsonSchema: { bsonType: "object", additionalProperties: false, required: Object.keys(properties), properties } };
  if (properties.created_at) expressions = [{ $lte: ["$created_at", "$updated_at"] }, ...expressions];
  return { validator: expressions.length ? { $and: [shape, { $expr: { $and: expressions } }] } : shape, indexes };
}
export const AUTH_EMAIL_SCHEMAS: Record<string, EmailSchema> = {
  auth_email_identities: strict({ _id: id, user_id: id, email_key: email, email_display: email,
    state: { enum: ["verified", "needs_reverify"] }, verified_at: nullableDate, revision: positive,
    created_at: date, updated_at: date }, [
    { name: "auth_email_verified_address", key: { email_key: 1 }, unique: true, partialFilterExpression: { state: "verified" } },
    { name: "auth_email_verified_user", key: { user_id: 1 }, unique: true, partialFilterExpression: { state: "verified" } },
    { name: "auth_email_subject", key: { user_id: 1, _id: 1 } },
  ], [{ $eq: [{ $eq: ["$state", "verified"] }, { $ne: ["$verified_at", null] }] }]),
  auth_email_challenges: strict({ _id: id, purpose, token_hash: digest, user_id: nullableId, email_key: email,
    invitation_id: nullableId, credential_version: nullablePositive, email_revision: nullablePositive,
    invitation_revision: nullablePositive, status: { enum: ["pending", "consumed", "revoked"] },
    expires_at: date, consumed_at: nullableDate, created_at: date, updated_at: date }, [
    { name: "auth_email_token", key: { token_hash: 1 }, unique: true },
    { name: "auth_email_pending", key: { purpose: 1, email_key: 1, user_id: 1, invitation_id: 1 }, unique: true, partialFilterExpression: { status: "pending" } },
    { name: "auth_email_challenge_expiry", key: { expires_at: 1 }, expireAfterSeconds: 0 },
    { name: "auth_email_challenge_subject", key: { user_id: 1, status: 1 } },
    { name: "auth_email_challenge_address", key: { email_key: 1, status: 1 } },
  ], [{ $lt: ["$created_at", "$expires_at"] },
    { $eq: [{ $eq: ["$status", "consumed"] }, { $ne: ["$consumed_at", null] }] },
    { $or: [{ $ne: ["$purpose", "invite"] }, { $and: [{ $ne: ["$invitation_id", null] }, { $ne: ["$invitation_revision", null] }] }] }]),
  auth_invitations: strict({ _id: id, org_id: id, actor_user_id: id, target_user_id: nullableId, email_key: email,
    roles, valid_to: nullableDate, payload_hash: digest, payload: { bsonType: "object", additionalProperties: false,
      required: ["invitation_id", "org_id", "actor_org_id", "actor_member_id", "actor_credential_version", "actor_authorization_revision", "target_user_id", "email_key", "roles", "valid_to", "expires_at", "member_id", "target_member_revision", "target_credential_version"],
      properties: { invitation_id: id, org_id: id, actor_org_id: id, actor_member_id: id,
        actor_credential_version: positive, actor_authorization_revision: positive, target_user_id: nullableId,
        email_key: email, roles, valid_to: { bsonType: ["string", "null"] }, expires_at: text,
        member_id: id, target_member_revision: nullablePositive, target_credential_version: nullablePositive } },
    revision: positive, state: { enum: ["pending", "accepted", "revoked", "expired"] }, expires_at: date,
    accepted_user_id: nullableId, accepted_at: nullableDate, approval_id: nullableId, operation_id: nullableId,
    created_at: date, updated_at: date }, [
    { name: "auth_invitation_subject", key: { target_user_id: 1, state: 1 } },
    { name: "auth_invitation_address", key: { email_key: 1, state: 1 } },
    { name: "auth_invitation_org", key: { org_id: 1, state: 1, _id: 1 } },
    { name: "auth_invitation_expiry", key: { expires_at: 1 }, expireAfterSeconds: 0 },
  ], [{ $lt: ["$created_at", "$expires_at"] },
    { $eq: [{ $eq: ["$state", "accepted"] }, { $and: [{ $ne: ["$accepted_at", null] }, { $ne: ["$accepted_user_id", null] }] }] }]),
  auth_admissions: strict({ _id: id, user_id: id, age_band: { enum: ["adult"] },
    source: { enum: ["public_register", "invite_activate"] }, terms_version: text, privacy_notice_version: text,
    accepted_at: date, policy_basis: text }, [{ name: "auth_admission_subject", key: { user_id: 1 }, unique: true }], []),
  auth_mail_outbox: strict({ _id: id, challenge_id: id, user_id: nullableId, invitation_id: nullableId, purpose,
    recipient_key_hash: digest, actor_user_id: nullableId,
    status: { enum: ["pending", "sending", "sent", "failed", "uncertain", "cancelled"] },
    encrypted_payload: { bsonType: ["string", "null"], minLength: 1, maxLength: 8192 }, key_id: { bsonType: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" }, expires_at: date,
    lease_token: { bsonType: ["string", "null"] }, lease_until: nullableDate,
    transport_token: { bsonType: ["string", "null"], pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" },
    transport_writer_id: nullableId, transport_closed_at: nullableDate,
    safe_error_code: { bsonType: "string", pattern: "^[A-Z0-9_]{0,64}$" }, created_at: date, updated_at: date }, [
    { name: "auth_mail_challenge", key: { challenge_id: 1 }, unique: true },
    { name: "auth_mail_claim", key: { status: 1, created_at: 1, _id: 1 } },
    { name: "auth_mail_lease", key: { status: 1, lease_until: 1 } },
    { name: "auth_mail_expiry", key: { expires_at: 1 }, expireAfterSeconds: 0, partialFilterExpression: { transport_token: null } },
    { name: "auth_mail_subject", key: { user_id: 1, status: 1 } },
    { name: "auth_mail_privacy_recipient", key: { recipient_key_hash: 1, transport_token: 1 } },
    { name: "auth_mail_privacy_actor", key: { actor_user_id: 1, transport_token: 1 } },
    { name: "auth_mail_transport_owner", key: { transport_writer_id: 1, transport_token: 1 } },
  ], [{ $eq: [{ $eq: ["$status", "sending"] }, { $ne: ["$lease_token", null] }] },
    { $eq: [{ $eq: ["$status", "sending"] }, { $ne: ["$lease_until", null] }] },
    { $eq: [{ $eq: ["$transport_token", null] }, { $eq: ["$transport_writer_id", null] }] },
    { $eq: [{ $in: ["$status", ["pending", "sending"]] }, { $ne: ["$encrypted_payload", null] }] }]),
};
export const AUTH_EMAIL_COLLECTIONS = Object.keys(AUTH_EMAIL_SCHEMAS);
export const AUTH_EMAIL_EXCLUDED = ["auth_email_challenges", "auth_invitations", "auth_mail_outbox"];
export const AUTH_EMAIL_CHECKSUM = createHash("sha256").update(JSON.stringify({ version: 22, schemas: AUTH_EMAIL_SCHEMAS })).digest("hex");
