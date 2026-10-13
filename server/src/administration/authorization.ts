import { type ClientSession, type Db, type Document, type Filter } from "mongodb";
import { collections, type AdministrationGuard, type AdministrationOperation, type AdministrativeGrant, type MemberCapabilityGrant, type MemberRole } from "../database/contracts";
import { ADMINISTRATIVE_CATALOG, scopeContains } from "./catalog";

const NONTERMINAL: AdministrationOperation["status"][] = ["pending", "applying", "needs_recovery"];
export class AdministrationTargetIsolatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdministrationTargetIsolatedError";
  }
}

async function databaseNow(db: Db, session?: ClientSession): Promise<Date> {
  const row = await db.aggregate<{ now: Date }>(
    [{ $documents: [{}] }, { $project: { _id: 0, now: "$$NOW" } }], { session }).next();
  if (!(row?.now instanceof Date)) throw new Error("Database clock unavailable for authorization");
  return row.now;
}

type AccessSubject = { user_id?: string; org_id?: string; member_id?: string };
async function assertTargetAccess(db: Db, subjects: AccessSubject[], session?: ClientSession): Promise<void> {
  const guard = await db.collection<AdministrationGuard>("administration_guard").findOne({ _id: "administration" }, { session });
  if (!guard || guard.state !== "idle" && !guard.operation_id)
    throw new Error("Administration guard missing or corrupt; preserve isolation");
  const userIds = [...new Set(subjects.map(subject => subject.user_id).filter((id): id is string => !!id))];
  const orgIds = [...new Set(subjects.map(subject => subject.org_id).filter((id): id is string => !!id))];
  const memberIds = [...new Set(subjects.map(subject => subject.member_id).filter((id): id is string => !!id))];
  if (guard.operation_id && guard.blocked_targets.global)
    throw new Error("Administration target is isolated pending explicit recovery");
  const targetIsolated = guard.operation_id && (
      userIds.some(id => guard.blocked_targets.user_ids.includes(id)) ||
      orgIds.some(id => guard.blocked_targets.org_ids.includes(id)) ||
      memberIds.some(id => guard.blocked_targets.member_ids.includes(id)));
  const targetClauses: Document[] = [{ "targets.global": true }];
  if (userIds.length) targetClauses.push({ "targets.user_ids": { $in: userIds } });
  if (orgIds.length) targetClauses.push({ "targets.org_ids": { $in: orgIds } });
  if (memberIds.length) targetClauses.push({ "targets.member_ids": { $in: memberIds } });
  const unfinished = await db.collection<AdministrationOperation>("administration_operations").findOne({
    status: { $in: NONTERMINAL }, $or: targetClauses,
  }, { session, projection: { _id: 1, "targets.global": 1 }, sort: { "targets.global": -1 } });
  if (unfinished && unfinished.targets?.global !== false)
    throw new Error("Administration operation is unfinished for this target");
  if (targetIsolated)
    throw new AdministrationTargetIsolatedError("Administration target is isolated pending explicit recovery");
  if (unfinished)
    throw new AdministrationTargetIsolatedError("Administration operation is unfinished for this target");
}

export async function assertAdministrationGlobalAccess(db: Db, session?: ClientSession): Promise<void> {
  await assertTargetAccess(db, [], session);
}

export async function assertAdministrationOrganizationAccess(db: Db, orgId: string, session?: ClientSession): Promise<void> {
  await assertTargetAccess(db, [{org_id:orgId}], session);
}

export async function assertAdministrationAccess(db: Db, userId: string, orgId?: string, session?: ClientSession): Promise<void> {
  const members = await collections(db).members.find({ user_id: userId }, { session, projection: { _id: 1, org_id: 1 } }).toArray();
  await assertTargetAccess(db, [{ user_id: userId, org_id: orgId },
    ...members.filter(member => !orgId || member.org_id === orgId)
      .map(member => ({ user_id: userId, member_id: member._id, org_id: member.org_id }))], session);
}

async function appliedOperations(db: Db, ids: string[], session?: ClientSession): Promise<Set<string>> {
  const applied = new Set<string>();
  if (!ids.length) return applied;
  for (const op of await db.collection<AdministrationOperation>("administration_operations")
    .find({ _id: { $in: ids }, status: "applied" }, { session, projection: { _id: 1 } }).toArray()) applied.add(op._id);
  return applied;
}

/** Active means current DB time, a published operation, and no unfinished target operation. */
export async function activeMemberGrants(db: Db, filter: Document, session?: ClientSession): Promise<MemberCapabilityGrant[]> {
  const now = await databaseNow(db, session);
  const grants = await db.collection<MemberCapabilityGrant>("member_capability_grants").find({ $and: [filter, {
    status: "active", valid_from: { $lte: now }, $or: [{ valid_to: null }, { valid_to: { $gt: now } }],
  }] } as Filter<MemberCapabilityGrant>, { session }).toArray();
  const operations = await appliedOperations(db, [...new Set(grants.map(grant => grant.operation_id).filter((id): id is string => !!id))], session);
  const members = await collections(db).members.find({ _id: { $in: grants.map(grant => grant.member_id) } },
    { session, projection: { _id: 1, org_id: 1, user_id: 1 } }).toArray();
  const subjects = new Map(members.map(member => [member._id, member]));
  const safe = grants.filter(grant => (grant.operation_id ? operations.has(grant.operation_id) : grant.authority === "legacy") &&
    subjects.get(grant.member_id)?.org_id === grant.org_id);
  await assertTargetAccess(db, safe.map(grant => ({ user_id: subjects.get(grant.member_id)!.user_id,
    member_id: grant.member_id, org_id: grant.org_id })), session);
  return safe;
}

/** Historical four-field assignments keep their previous validity; new reviewers require
 * an applied operation and explicit deadline. Never synthesize a role from a pending row. */
export async function activeMemberRoles(db: Db, filter: Document, session?: ClientSession): Promise<MemberRole[]> {
  const now = await databaseNow(db, session);
  const rows = await collections(db).memberRoles.find(filter as Filter<MemberRole>, { session }).toArray();
  const applied = await appliedOperations(db,
    [...new Set(rows.map(row => row.operation_id).filter((id): id is string => !!id))], session);
  const members = await collections(db).members.find({ _id: { $in: rows.map(row => row.member_id) } },
    { session, projection: { _id: 1, org_id: 1, user_id: 1 } }).toArray();
  const subjects = new Map(members.map(member => [member._id, member]));
  const visible: MemberRole[] = [];
  for (const row of rows) {
    if (row.status && row.status !== "active") continue;
    if (row.valid_from && row.valid_from > now || row.valid_to && row.valid_to <= now) continue;
    if (row.role_id === "content_reviewer") {
      if (row.authority === "legacy") {
        if (row.operation_id || row.approval_id || row.valid_to !== null) continue;
      } else if (!row.operation_id || !row.valid_to ||
        (row.authority === "approval" ? !row.approval_id : row.authority !== "cli")) continue;
    }
    if (row.operation_id && !applied.has(row.operation_id)) continue;
    const member = subjects.get(row.member_id);
    if (!member || member.org_id !== row.org_id) continue;
    visible.push(row);
  }
  await assertTargetAccess(db, visible.map(row => ({ user_id: subjects.get(row.member_id)!.user_id,
    member_id: row.member_id, org_id: row.org_id })), session);
  return visible;
}

export async function effectiveAdministrativeGrants(db: Db, memberId: string, session?: ClientSession): Promise<AdministrativeGrant[]> {
  const member = await collections(db).members.findOne({ _id: memberId, status: "active" }, { session });
  if (!member) return [];
  const user = await collections(db).users.findOne({ _id: member.user_id, status: "active", privacy_state: "active" }, { session });
  const organization = await collections(db).organizations.findOne({ _id: member.org_id, status: "active" }, { session });
  if (!user || !organization) return [];
  const roles = await activeMemberRoles(db, { member_id: memberId, org_id: member.org_id }, session);
  if (!roles.length) return [];
  const roleIds = new Set(roles.map(role => role.role_id));
  await assertAdministrationAccess(db, member.user_id, member.org_id, session);
  const now = await databaseNow(db, session);
  const grants = await db.collection<AdministrativeGrant>("administrative_grants").find({ subject_member_id: memberId,
    actor_org_id: member.org_id, status: "active", valid_from: { $lte: now }, $or: [{ valid_to: null }, { valid_to: { $gt: now } }],
  }, { session }).toArray();
  const applied = await appliedOperations(db, [...new Set(grants.map(grant => grant.operation_id).filter((id): id is string => !!id))], session);
  return grants.filter(grant => {
    if (!grant.operation_id || !applied.has(grant.operation_id)) return false;
    const policy = ADMINISTRATIVE_CATALOG[grant.capability];
    if (!policy || (policy.required_role === "platform_member"
      ? organization.kind !== "platform"
      : policy.required_role === "organization_member" ? false : !roleIds.has(policy.required_role))) return false;
    if ((grant.capability.startsWith("platform:") || grant.capability === "account:platform-manage") &&
        organization.kind !== "platform") return false;
    if (policy.scope === "self" && (grant.scope.kind !== "organization_ids" ||
        grant.scope.organization_ids.length !== 1 || grant.scope.organization_ids[0] !== member.org_id)) return false;
    return true;
  });
}

/** Independent capability/scope tuples: never cartesian-product organization and capability arrays. */
export async function scopedBusinessCapabilities(db: Db, userId: string, targetOrgId: string, session?: ClientSession): Promise<string[]> {
  await assertAdministrationAccess(db, userId, targetOrgId, session);
  const organization = await collections(db).organizations.findOne({ _id: targetOrgId, status: "active" }, { session });
  if (!organization) return [];
  const members = await collections(db).members.find({ user_id: userId, status: "active" }, { session }).toArray();
  const candidates = await collections(db).organizations.find({ _id: { $in: members.map(member => member.org_id) }, kind: "platform", status: "active" }, { session, projection: { _id: 1 } }).toArray();
  const platformOrgIds = new Set(candidates.map(org => org._id));
  const result = new Set<string>();
  for (const member of members) {
    if (!platformOrgIds.has(member.org_id)) continue;
    const grants = await effectiveAdministrativeGrants(db, member._id, session);
    for (const grant of grants) if (scopeContains(grant.scope, targetOrgId) &&
      !["platform:govern", "account:platform-manage", "account:manage", "authorization:delegate"].includes(grant.capability)) result.add(grant.capability);
  }
  return [...result];
}
/** The global administration guard serializes this check with governance changes. */
export async function usableGovernanceAccounts(db: Db, now: Date, session: ClientSession): Promise<{
  user_id: string; member_id: string; org_id: string;
}[]> {
  return db.collection<AdministrativeGrant>("administrative_grants").aggregate<{
    user_id: string; member_id: string; org_id: string;
  }>([
    { $match: { capability: "platform:govern", status: "active", valid_from: { $lte: now },
      $or: [{ valid_to: null }, { valid_to: { $gt: now } }] } },
    { $lookup: { from: "administration_operations", localField: "operation_id", foreignField: "_id", as: "operation" } },
    { $match: { "operation.status": "applied" } },
    { $lookup: { from: "organization_members", localField: "subject_member_id", foreignField: "_id", as: "member" } },
    { $unwind: "$member" },
    { $match: { "member.status": "active" } },
    { $lookup: { from: "users", localField: "member.user_id", foreignField: "_id", as: "user" } },
    { $unwind: "$user" },
    { $match: { "user.status": "active", "user.privacy_state": "active", "user.must_change_password": false } },
    { $lookup: { from: "organizations", localField: "member.org_id", foreignField: "_id", as: "organization" } },
    { $unwind: "$organization" },
    { $match: { "organization.status": "active", "organization.kind": "platform" } },
    { $lookup: { from: "member_roles", let: { member: "$member._id", org: "$member.org_id" }, pipeline: [
      { $match: { role_id: "platform_ops", $expr: { $and: [
        { $eq: ["$member_id", "$$member"] }, { $eq: ["$org_id", "$$org"] },
        { $eq: [{ $ifNull: ["$status", "active"] }, "active"] },
        { $lte: [{ $ifNull: ["$valid_from", new Date(0)] }, now] },
        { $or: [{ $eq: [{ $ifNull: ["$valid_to", null] }, null] }, { $gt: ["$valid_to", now] }] },
      ] } } },
      { $lookup: { from: "administration_operations", localField: "operation_id", foreignField: "_id", as: "role_operation" } },
      { $match: { $or: [{ operation_id: null }, { "role_operation.status": "applied" }] } },
      { $project: { _id: 1 } },
    ], as: "roles" } },
    { $match: { "roles.0": { $exists: true } } },
    { $project: { user_id: "$member.user_id", member_id: "$member._id", org_id: "$member.org_id" } },
  ], { session }).toArray();
}

export async function assertRetainsGovernance(db: Db, now: Date, session: ClientSession,
  excluding: { user_id?: string; member_id?: string; org_id?: string }): Promise<void> {
  const governing = await usableGovernanceAccounts(db, now, session);
  if (governing.length && !governing.some(grant =>
    (excluding.user_id === undefined || grant.user_id !== excluding.user_id) &&
    (excluding.member_id === undefined || grant.member_id !== excluding.member_id) &&
    (excluding.org_id === undefined || grant.org_id !== excluding.org_id)))
    throw new Error("Cannot remove the final active governance administrator");
}
