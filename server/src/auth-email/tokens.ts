import { createHash, randomBytes } from "node:crypto";
import type { ClientSession, Db, Filter } from "mongodb";
import { domainToASCII } from "node:url";
import { newId } from "../database/object-id";
import { fail } from "../errors";
import { emailCollections, type EmailChallenge, type EmailPurpose } from "./contracts";

export function normalizeEmail(raw: string): { key: string; display: string } {
  if (typeof raw !== "string") fail(422, "VALIDATION_ERROR", "邮箱格式不合法");
  const display = raw.normalize("NFKC").trim();
  const at = display.lastIndexOf("@");
  const local = display.slice(0, at);
  const domain = domainToASCII(display.slice(at + 1)).toLowerCase();
  if (at < 1 || local.length > 64 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
      local.startsWith(".") || local.endsWith(".") || local.includes("..") ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain) ||
      Buffer.byteLength(`${local}@${domain}`, "utf8") > 254)
    fail(422, "VALIDATION_ERROR", "邮箱格式不合法");
  return { key: `${local.toLowerCase()}@${domain}`, display: `${local}@${domain}` };
}
export const tokenDigest = (token: string) => createHash("sha256").update(token).digest("hex");
export function invalidEmailAction(): never {
  fail(409, "EMAIL_ACTION_INVALID", "邮件链接无效、已使用或已过期，请重新发起");
}
const pendingAlive = { status: "pending" as const, $expr: { $gt: ["$expires_at", "$$NOW"] } };
export async function revokeEmailChallenges(db: Db, session: ClientSession, filter: Filter<EmailChallenge>) {
  const c = emailCollections(db);
  const ids = (await c.challenges.find({ ...filter, status: "pending" }, { session }).project({ _id: 1 }).toArray()).map(row => row._id);
  if (!ids.length) return;
  await c.challenges.updateMany({ _id: { $in: ids }, status: "pending" }, [
    { $set: { status: "revoked", updated_at: "$$NOW" } },
  ], { session });
  await db.collection("auth_mail_outbox").updateMany({ challenge_id: { $in: ids }, status: { $in: ["pending", "sending"] } }, [
    { $set: { status: "cancelled", encrypted_payload: null, lease_token: null, lease_until: null,
      safe_error_code: "CHALLENGE_REVOKED", updated_at: "$$NOW" } },
  ], { session });
}
export async function issueEmailChallenge(db: Db, session: ClientSession, input: {
  purpose: EmailPurpose; userId: string | null; email: { key: string; display: string };
  invitationId?: string | null; credentialVersion?: number | null; emailRevision?: number | null;
  invitationRevision?: number | null; durationMs?: number;
}) {
  if (!session.inTransaction()) fail(503, "AUTH_TRANSACTION_REQUIRED", "邮箱操作需要副本集事务");
  const c = emailCollections(db);
  const duration = input.durationMs ?? 15 * 60 * 1000;
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 7 * 86400000) throw new Error("EMAIL_CHALLENGE_DURATION_INVALID");
  await revokeEmailChallenges(db, session, {
    purpose: input.purpose, email_key: input.email.key, user_id: input.userId,
    invitation_id: input.invitationId ?? null,
  });
  const id = newId(), token = randomBytes(32).toString("base64url");
  await c.challenges.updateOne({ _id: id }, [{ $set: {
    purpose: input.purpose, token_hash: tokenDigest(token), user_id: input.userId,
    email_key: { $literal: input.email.key }, invitation_id: input.invitationId ?? null,
    credential_version: input.credentialVersion ?? null, email_revision: input.emailRevision ?? null,
    invitation_revision: input.invitationRevision ?? null, status: "pending",
    expires_at: { $add: ["$$NOW", duration] }, consumed_at: null, created_at: "$$NOW", updated_at: "$$NOW",
  } }], { upsert: true, session });
  const row = await c.challenges.findOne({ _id: id }, { session });
  if (!row) throw new Error("EMAIL_CHALLENGE_NOT_CONFIRMED");
  return { id, token, expiresAt: row.expires_at };
}
export async function readEmailChallenge(db: Db, session: ClientSession, token: string, purpose: EmailPurpose) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) invalidEmailAction();
  const row = await emailCollections(db).challenges.findOne({ token_hash: tokenDigest(token), purpose, ...pendingAlive }, { session });
  if (!row) invalidEmailAction();
  return row;
}
export async function consumeEmailChallenge(db: Db, session: ClientSession, challenge: EmailChallenge) {
  const changed = await emailCollections(db).challenges.updateOne({ _id: challenge._id, purpose: challenge.purpose, ...pendingAlive }, [
    { $set: { status: "consumed", consumed_at: "$$NOW", updated_at: "$$NOW" } },
  ], { session });
  if (changed.modifiedCount !== 1) invalidEmailAction();
  await db.collection("auth_mail_outbox").updateMany({ challenge_id: challenge._id, status: { $in: ["pending", "sending"] } }, [
    { $set: { status: "cancelled", encrypted_payload: null, lease_token: null, lease_until: null,
      safe_error_code: "CHALLENGE_CONSUMED", updated_at: "$$NOW" } },
  ], { session });
}
export function maskedEmail(email: string) {
  const at = email.lastIndexOf("@");
  return `${email.slice(0, 1)}***@${email.slice(at + 1)}`;
}
