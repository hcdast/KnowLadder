import { newId } from "../database/object-id";
import { createHash, randomUUID } from "node:crypto";
import { MongoError, type ClientSession, type Db, type Document, type Filter, type MongoClient } from "mongodb";
import { loadConfig } from "../config";
import type { AdministrationGuard, AdministrationOperation, AdministrationTargets, AuditEvent } from "../database/contracts";
import { resolvedTxnMode, type MongoTopologyMode } from "../database/topology";
import { runInTxn } from "../database/txn";
import { assertOperationalAccess } from "../operations/control";
import type { OperationalState } from "../operations/contracts";

export type OperationWorkContext = { session: ClientSession; operation_id: string; now: Date; mode: MongoTopologyMode };
export type OperationAudit = { org_id?: string | null; resource_id: string; request_id?: string;
  actor_org_id?: string | null; target_org_id?: string | null; approval_id?: string | null;
  grant_id?: string | null; resource_type?: string; owner_type?: string | null;
  owner_version_id?: string | null; revision_before?: number | null; revision_after?: number | null;
  access_revision_before?: number | null; access_revision_after?: number | null };
export type OperationInput<T> = {
  client: MongoClient;
  db: Db;
  actor: string;
  reason: string;
  action: string;
  targets: Partial<AdministrationTargets>;
  payload: unknown;
  before?: unknown;
  key?: string;
  operation_id?: string;
  apply: (ctx: OperationWorkContext) => Promise<T>;
  verify?: (ctx: OperationWorkContext, result: T) => Promise<void>;
  audit?: OperationAudit;
  auditResult?: (result: T) => Partial<OperationAudit>;
};
export type OperationReceipt<T> = { operation_id: string; status: "applied"; replayed: boolean; result: T | null };
export class AdministrationNeedsRecovery extends Error {
  readonly status = 503;
  readonly code = "ADMINISTRATION_NEEDS_RECOVERY";
  constructor(readonly operation_id: string) {
    super("Administration result is unknown; inspect and recover by operation ID");
  }
}


function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object") throw new Error("Operation payload must be normalized JSON without credentials");
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => {
    if (v === undefined || /password|secret|token|hash/i.test(k)) throw new Error("Operation payload cannot contain credentials");
    return `${JSON.stringify(k)}:${canonical(v)}`;
  }).join(",")}}`;
}

function normalizeTargets(targets: Partial<AdministrationTargets>): AdministrationTargets {
  const normalize = (values: string[] | undefined) => {
    if (values !== undefined && (!Array.isArray(values) || values.some(id => typeof id !== "string" || !/^[0-9a-f]{24}$/.test(id)))) throw new Error("Operation targets require ObjectIds");
    return [...new Set(values ?? [])].sort();
  };
  return { user_ids: normalize(targets.user_ids), member_ids: normalize(targets.member_ids), org_ids: normalize(targets.org_ids), global: targets.global === true };
}

function assertImmutableIntent(operation: AdministrationOperation): void {
  const digest = createHash("sha256").update(canonical({
    before: operation.before, desired: operation.desired,
  })).digest("hex");
  if (digest !== operation.payload_hash) throw new Error("Operation intent digest changed; preserve isolation");
}

export async function inspectAdministrationOperations(db: Db, operation_id?: string): Promise<AdministrationOperation[]> {
  const guard = await db.collection<AdministrationGuard>("administration_guard").findOne({ _id: "administration" });
  if (!guard) throw new Error("Administration guard missing");
  const query: Filter<AdministrationOperation> = operation_id ? { _id: operation_id } : { $or: [
    { status: { $in: ["pending", "applying", "needs_recovery"] } },
    ...(guard.operation_id ? [{ _id: guard.operation_id }] : []),
  ] };
  return db.collection<AdministrationOperation>("administration_operations").find(query).sort({ created_at: 1, _id: 1 }).limit(operation_id ? 1 : 100).toArray();
}

async function claimGuard(db: Db, operationId: string, targets: AdministrationTargets, now: Date, session?: ClientSession): Promise<void> {
  const changed = await db.collection<AdministrationGuard>("administration_guard").updateOne(
    { _id: "administration", state: "idle", operation_id: null, recovery_token: null },
    { $inc: { revision: 1 }, $set: { state: "applying", operation_id: operationId, blocked_targets: targets, affected_orgs: targets.org_ids, updated_at: now } },
    { session },
  );
  if (changed.matchedCount !== 1) throw new Error("Administration guard busy or missing; inspect and recover explicitly");
}

async function releaseGuard(db: Db, operationId: string, now: Date, session?: ClientSession): Promise<void> {
  const changed = await db.collection<AdministrationGuard>("administration_guard").updateOne(
    { _id: "administration", state: "applying", operation_id: operationId, recovery_token: null },
    { $inc: { revision: 1 }, $set: { state: "idle", operation_id: null, blocked_targets: { user_ids: [], member_ids: [], org_ids: [], global: false }, affected_orgs: [], updated_at: now } },
    { session },
  );
  if (changed.matchedCount !== 1) throw new Error("Administration guard changed; leave target isolated");
}

/** No lease or automatic takeover: reclaiming a crashed recovery requires its visible previous token. */
async function claimRecoveryGuard(db: Db, guard: AdministrationGuard, operation: AdministrationOperation,
  previousToken: string | undefined, session: ClientSession): Promise<string> {
  if (guard.state === "recovering" && (!previousToken || previousToken !== guard.recovery_token))
    throw new Error("Recovery already in progress; inspect and supply previous recovery token explicitly");
  if (guard.state !== "recovering" && previousToken) throw new Error("Previous recovery token does not match guard state");
  const recoveryToken = randomUUID();
  const now = new Date();
  const changed = await db.collection<AdministrationGuard>("administration_guard").updateOne(
    { _id: "administration", revision: guard.revision, state: guard.state,
      operation_id: guard.operation_id, recovery_token: guard.recovery_token },
    { $inc: { revision: 1 }, $set: { state: "recovering", operation_id: operation._id,
      recovery_token: recoveryToken, blocked_targets: operation.targets,
      affected_orgs: operation.targets.org_ids, updated_at: now } }, { session });
  if (changed.matchedCount !== 1) throw new Error("Another recovery writer claimed the administration guard");
  return recoveryToken;
}

async function releaseRecoveredGuard(db: Db, operationId: string, token: string,
  session: ClientSession): Promise<void> {
  const changed = await db.collection<AdministrationGuard>("administration_guard").updateOne(
    { _id: "administration", operation_id: operationId, state: "recovering", recovery_token: token },
    { $inc: { revision: 1 }, $set: { state: "idle", operation_id: null, recovery_token: null,
      blocked_targets: { user_ids: [], member_ids: [], org_ids: [], global: false },
      affected_orgs: [], updated_at: new Date() } }, { session });
  if (changed.matchedCount !== 1) throw new Error("Recovery guard changed before publication");
}

export async function executeAdministrationOperation<T>(input: OperationInput<T>): Promise<OperationReceipt<T>> {
  const { db, client } = input;
  const mode = await resolvedTxnMode(db, loadConfig());
  await assertOperationalAccess(db);
  if (!input.actor.trim() || !input.reason.trim() || !input.action.trim()) throw new Error("Actor, action and reason are required");
  const targets = normalizeTargets(input.targets);
  const before = JSON.parse(canonical(input.before ?? {})) as Document;
  const desired = JSON.parse(canonical(input.payload)) as Document;
  if (Array.isArray(before) || before === null || Array.isArray(desired) || desired === null)
    throw new Error("Administration before and desired must be non-secret objects");
  const payload_hash = createHash("sha256").update(canonical({ before, desired })).digest("hex");
  const operation_id = input.operation_id ?? newId();
  const operations = db.collection<AdministrationOperation>("administration_operations");
  const existing = input.key ? await operations.findOne({ actor_id: input.actor, action: input.action, key: input.key }) : await operations.findOne({ _id: operation_id });
  if (existing) {
    if (existing.actor_id !== input.actor || existing.action !== input.action || existing.payload_hash !== payload_hash || JSON.stringify(existing.targets) !== JSON.stringify(targets)) throw new Error("Operation key conflict");
    if (existing.status !== "applied") throw new Error(`Operation ${existing._id} requires read-only inspect and manual recovery`);
    const guard = await db.collection<AdministrationGuard>("administration_guard").findOne({ _id: "administration" });
    if (!guard || guard.state !== "idle" || guard.operation_id !== null || existing.mode !== mode)
      throw new Error("Committed operation cannot be replayed while administration needs recovery");
    return { operation_id: existing._id, status: "applied", replayed: true, result: null };
  }
  const now = (await db.command({ hello: 1 })).localTime;
  if (!(now instanceof Date)) throw new Error("Database clock unavailable");
  const intent: AdministrationOperation = {
    _id: operation_id, actor_id: input.actor, action: input.action, reason: input.reason, targets,
    payload_hash, before, desired, key: input.key ?? null, mode, status: "pending", step: "intent", revision: 1,
    audit_id: null, created_at: now, updated_at: now,
  };
  const auditId = newId();
  const auditRequestId = input.audit?.request_id ?? randomUUID();
  const perform = async (session: ClientSession): Promise<T> => {
    await assertOperationalAccess(db);
    const fence = await db.collection<OperationalState>("operational_state").updateOne(
      { _id: "environment", mode: { $in: ["unregistered", "active"] } },
      { $inc: { access_fence: 1 } }, { session });
    if (fence.matchedCount !== 1) throw new Error("Operational state is quarantined or has changed");
    await claimGuard(db, operation_id, targets, now, session);
    const step = await operations.updateOne({ _id: operation_id, status: "pending" }, { $set: { status: "applying", step: "guarded", updated_at: now }, $inc: { revision: 1 } }, { session });
    if (step.matchedCount !== 1) throw new Error("Operation intent changed");
    const context = { session, operation_id, now, mode };
    const result = await input.apply(context);
    await operations.updateOne({ _id: operation_id, status: "applying" }, { $set: { step: "written", updated_at: now }, $inc: { revision: 1 } }, { session });
    const evidence = input.auditResult?.(result);
    const details = { ...input.audit, ...evidence };
    const versionEvidence = details.resource_type === undefined ? {} : {
      resource_type: details.resource_type, owner_type: details.owner_type ?? null,
      owner_version_id: details.owner_version_id ?? null,
      revision_before: details.revision_before ?? null, revision_after: details.revision_after ?? null,
      access_revision_before: details.access_revision_before ?? null,
      access_revision_after: details.access_revision_after ?? null,
    };
    await db.collection<AuditEvent>("audit_events").insertOne({ _id: auditId, actor_id: input.actor, org_id: details.org_id ?? null,
      action: input.action, resource_id: details.resource_id ?? operation_id, reason: input.reason,
      request_id: details.request_id ?? auditRequestId, operation_id, created_at: now, ...versionEvidence,
      ...(details.actor_org_id ? { actor_org_id: details.actor_org_id } : {}),
      ...(details.target_org_id ? { target_org_id: details.target_org_id } : {}),
      ...(details.approval_id ? { approval_id: details.approval_id } : {}),
      ...(details.grant_id ? { grant_id: details.grant_id } : {}) }, { session });
    if (input.verify) await input.verify(context, result);
    const finished = await operations.updateOne({ _id: operation_id, status: "applying" },
      { $set: { status: "applied", step: "verified", audit_id: auditId, updated_at: now }, $inc: { revision: 1 } }, { session });
    if (finished.matchedCount !== 1) throw new Error("Operation was not finalized");
    await releaseGuard(db, operation_id, now, session);
    return result;
  };
  if (mode === "replicaSet") {
    try {
      const result = await runInTxn(client, async session => {
        await operations.insertOne(intent, { session });
        return perform(session);
      });
      return { operation_id, status: "applied", replayed: false, result };
    } catch (error) {
      if (error instanceof MongoError && error.hasErrorLabel("UnknownTransactionCommitResult"))
        throw new AdministrationNeedsRecovery(operation_id);
      throw error;
    }
  }
  await operations.insertOne(intent);
  const session = client.startSession();
  try {
    const result = await perform(session);
    return { operation_id, status: "applied", replayed: false, result };
  } catch {
    // An unknown acknowledgement may already have committed. Never release or retry an isolated target automatically.
    await operations.updateOne({ _id: operation_id, status: { $in: ["pending", "applying"] } },
      { $set: { status: "needs_recovery", updated_at: new Date() }, $inc: { revision: 1 } }).catch(() => undefined);
    await db.collection<AdministrationGuard>("administration_guard").updateOne({ _id: "administration", operation_id },
      { $set: { state: "needs_recovery", updated_at: new Date() }, $inc: { revision: 1 } }).catch(() => undefined);
    throw new AdministrationNeedsRecovery(operation_id);
  } finally { await session.endSession(); }
}

/** Recovery never replays stale approvals. All permissions and target state must be rechecked by callbacks. */
export async function recoverAdministrationOperation<T>(input: {
  db: Db; client: MongoClient; operation_id: string; actor: string; reason: string;
  previous_recovery_token?: string;
  revalidate: (operation: AdministrationOperation, session: ClientSession) => Promise<void>;
  finish: (operation: AdministrationOperation, session: ClientSession) => Promise<T>;
  verify: (operation: AdministrationOperation, session: ClientSession, result: T | null) => Promise<void>;
}): Promise<{ operation_id: string; status: "applied"; result: T | null }> {
  if (!input.actor.trim() || !input.reason.trim() || !input.operation_id.trim()) throw new Error("Recovery requires explicit actor, reason and operation ID");
  const mode = await resolvedTxnMode(input.db, loadConfig());
  await assertOperationalAccess(input.db);
  const operations = input.db.collection<AdministrationOperation>("administration_operations");
  const operation = await operations.findOne({ _id: input.operation_id });
  const guard = await input.db.collection<AdministrationGuard>("administration_guard").findOne({ _id: "administration" });
  if (!operation || !guard || operation.mode !== mode ||
      !["pending", "applying", "needs_recovery", "applied"].includes(operation.status) ||
      (operation.status === "applied" && guard.operation_id !== operation._id) ||
      (guard.operation_id !== operation._id && guard.state !== "idle"))
    throw new Error("Operation cannot be recovered; inspect mode, operation and guard");
  assertImmutableIntent(operation);
  const work = async (session: ClientSession): Promise<T | null> => {
    await assertOperationalAccess(input.db);
    const fence = await input.db.collection<OperationalState>("operational_state").updateOne(
      { _id: "environment", mode: { $in: ["unregistered", "active"] } },
      { $inc: { access_fence: 1 } }, { session });
    if (fence.matchedCount !== 1) throw new Error("Operational state is quarantined or has changed");
    const recoveryToken = await claimRecoveryGuard(input.db, guard, operation, input.previous_recovery_token, session);
    await input.revalidate(operation, session);
    // A published operation with a stranded guard must only be verified and released, never applied twice.
    const result = operation.status === "applied" ? null : await input.finish(operation, session);
    await input.verify(operation, session, result);
    const now = new Date();
    await input.db.collection<AuditEvent>("audit_events").insertOne({ _id: newId(), actor_id: input.actor, org_id: null,
      action: "administration.recovery", resource_id: operation._id, reason: input.reason, request_id: randomUUID(), operation_id: operation._id, created_at: now }, { session });
    if (operation.status !== "applied") {
      const done = await operations.updateOne({ _id: operation._id, status: operation.status, revision: operation.revision },
        { $set: { status: "applied", step: "recovered", updated_at: now }, $inc: { revision: 1 } }, { session });
      if (done.matchedCount !== 1) throw new Error("Operation changed during recovery");
    }
    await releaseRecoveredGuard(input.db, operation._id, recoveryToken, session);
    return result;
  };
  let result: T | null;
  if (mode === "replicaSet") result = await runInTxn(input.client, work);
  else {
    const session = input.client.startSession();
    try { result = await work(session); }
    finally { await session.endSession(); }
  }
  return { operation_id: operation._id, status: "applied", result };
}

/** Only an intent that never reached the apply stage can be voided. A failure after
 * status=applying must use explicit forward recovery, not an inferred rollback. */
export async function voidAdministrationOperation(input: {
  db: Db; client: MongoClient; operation_id: string; actor: string; reason: string;
  previous_recovery_token?: string;
  verifyNoEffect: (operation: AdministrationOperation, session: ClientSession) => Promise<void>;
}): Promise<void> {
  if (!input.operation_id.trim() || !input.actor.trim() || !input.reason.trim()) throw new Error("Void requires explicit actor, reason and operation ID");
  await assertOperationalAccess(input.db);
  const operation = await input.db.collection<AdministrationOperation>("administration_operations").findOne({ _id: input.operation_id });
  const guard = await input.db.collection<AdministrationGuard>("administration_guard").findOne({ _id: "administration" });
  const mode = await resolvedTxnMode(input.db, loadConfig());
  if (!operation || !guard || operation.mode !== mode || operation.step !== "intent" ||
    !["pending", "needs_recovery", "void"].includes(operation.status) ||
    (guard.operation_id !== operation._id && guard.state !== "idle")) throw new Error("Only unchanged pre-apply intent may be voided");
  assertImmutableIntent(operation);
  const work = async (session: ClientSession) => {
    const fence = await input.db.collection<OperationalState>("operational_state").updateOne(
      { _id: "environment", mode: { $in: ["unregistered", "active"] } }, { $inc: { access_fence: 1 } }, { session });
    if (fence.matchedCount !== 1) throw new Error("Restore lock forbids voiding intent");
    const recoveryToken = await claimRecoveryGuard(input.db, guard, operation, input.previous_recovery_token, session);
    await input.verifyNoEffect(operation, session);
    const now = new Date();
    await input.db.collection<AuditEvent>("audit_events").insertOne({ _id: newId(), actor_id: input.actor,
      org_id: null, action: "administration.intent.void", resource_id: operation._id,
      reason: input.reason, request_id: randomUUID(), operation_id: operation._id, created_at: now }, { session });
    if (operation.status !== "void") {
      const changed = await input.db.collection<AdministrationOperation>("administration_operations").updateOne(
        { _id: operation._id, status: operation.status, revision: operation.revision, step: "intent" },
        { $set: { status: "void", updated_at: now }, $inc: { revision: 1 } }, { session });
      if (changed.matchedCount !== 1) throw new Error("Intent changed during void");
    }
    await releaseRecoveredGuard(input.db, operation._id, recoveryToken, session);
  };
  if (mode === "replicaSet") await runInTxn(input.client, work);
  else {
    const session = input.client.startSession();
    try { await work(session); }
    finally { await session.endSession(); }
  }
}

/** Explicitly terminates an invalidated approval only after a domain-specific
 * forward cleanup and proof that no broadened permission can become effective. */
export async function cancelAdministrationOperation(input: {
  db: Db; client: MongoClient; operation_id: string; actor: string; reason: string;
  previous_recovery_token?: string;
  invalidate: (operation: AdministrationOperation, session: ClientSession) => Promise<void>;
  verifySafe: (operation: AdministrationOperation, session: ClientSession) => Promise<void>;
}): Promise<{ operation_id: string; status: "void"; isolated: true }> {
  if (!input.operation_id.trim() || !input.actor.trim() || !input.reason.trim())
    throw new Error("Cancellation requires explicit actor, reason and operation ID");
  await assertOperationalAccess(input.db);
  const mode = await resolvedTxnMode(input.db, loadConfig());
  const operations = input.db.collection<AdministrationOperation>("administration_operations");
  const operation = await operations.findOne({ _id: input.operation_id });
  const guard = await input.db.collection<AdministrationGuard>("administration_guard").findOne({ _id: "administration" });
  if (!operation || !guard || operation.mode !== mode ||
      !["pending", "applying", "needs_recovery", "void"].includes(operation.status) ||
      (guard.operation_id !== operation._id && guard.state !== "idle"))
    throw new Error("Operation cannot be invalidated; inspect guard and status");
  assertImmutableIntent(operation);
  const work = async (session: ClientSession) => {
    const fence = await input.db.collection<OperationalState>("operational_state").updateOne(
      { _id: "environment", mode: { $in: ["unregistered", "active"] } }, { $inc: { access_fence: 1 } }, { session });
    if (fence.matchedCount !== 1) throw new Error("Restore lock forbids invalidation");
    await claimRecoveryGuard(input.db, guard, operation, input.previous_recovery_token, session);
    if (operation.status !== "void") await input.invalidate(operation, session);
    await input.verifySafe(operation, session);
    const now = new Date();
    await input.db.collection<AuditEvent>("audit_events").insertOne({ _id: newId(), actor_id: input.actor,
      org_id: null, action: "administration.recovery.invalidate", resource_id: operation._id,
      reason: input.reason, request_id: randomUUID(), operation_id: operation._id, created_at: now }, { session });
    if (operation.status !== "void") {
      const changed = await operations.updateOne({ _id: operation._id, status: operation.status, revision: operation.revision },
        { $set: { status: "void", step: "invalidated", updated_at: now }, $inc: { revision: 1 } }, { session });
      if (changed.matchedCount !== 1) throw new Error("Approval changed during invalidation");
    }
  };
  if (mode === "replicaSet") await runInTxn(input.client, work);
  else {
    const session = input.client.startSession();
    try { await work(session); }
    finally { await session.endSession(); }
  }
  return { operation_id: operation._id, status: "void", isolated: true };
}

/** Second, separate human action after invalidation and target verification. */
export async function releaseInvalidatedAdministration(input: {
  db: Db; client: MongoClient; operation_id: string; actor: string; reason: string;
  previous_recovery_token: string;
  verifySafe: (operation: AdministrationOperation, session: ClientSession) => Promise<void>;
}): Promise<{ operation_id: string; status: "void"; isolated: false }> {
  if (!input.operation_id.trim() || !input.actor.trim() || !input.reason.trim() ||
      !input.previous_recovery_token.trim())
    throw new Error("Explicit operation, actor, reason and prior recovery token required");
  await assertOperationalAccess(input.db);
  const mode = await resolvedTxnMode(input.db, loadConfig());
  const operation = await input.db.collection<AdministrationOperation>("administration_operations").findOne({
    _id: input.operation_id, status: "void", step: "invalidated",
  });
  const guard = await input.db.collection<AdministrationGuard>("administration_guard").findOne({
    _id: "administration", operation_id: input.operation_id, state: "recovering",
    recovery_token: input.previous_recovery_token,
  });
  if (!operation || !guard || operation.mode !== mode) throw new Error("Invalidated operation does not own this guard");
  assertImmutableIntent(operation);
  const work = async (session: ClientSession) => {
    const fence = await input.db.collection<OperationalState>("operational_state").updateOne(
      { _id: "environment", mode: { $in: ["unregistered", "active"] } },
      { $inc: { access_fence: 1 } }, { session });
    if (fence.matchedCount !== 1) throw new Error("Restore lock forbids release");
    const token = await claimRecoveryGuard(input.db, guard, operation, input.previous_recovery_token, session);
    await input.verifySafe(operation, session);
    await input.db.collection<AuditEvent>("audit_events").insertOne({ _id: newId(), actor_id: input.actor,
      org_id: null, action: "administration.recovery.release", resource_id: operation._id,
      reason: input.reason, request_id: randomUUID(), operation_id: operation._id, created_at: new Date() }, { session });
    await releaseRecoveredGuard(input.db, operation._id, token, session);
  };
  if (mode === "replicaSet") await runInTxn(input.client, work);
  else {
    const session = input.client.startSession();
    try { await work(session); }
    finally { await session.endSession(); }
  }
  return { operation_id: operation._id, status: "void", isolated: false };
}
