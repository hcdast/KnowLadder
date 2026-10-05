import { createHash } from "node:crypto";
import type { AdministrativeCapability, AdministrativeScope, RoleCode } from "../database/contracts";

export type StorageKind = "member" | "administrative";
export type Sensitivity = "ordinary" | "sensitive" | "governance";
export interface CapabilityPolicy {
  storage_kind: StorageKind;
  required_role: RoleCode | "platform_member" | "organization_member";
  scope: "self" | "organizations" | "all";
  sensitivity: Sensitivity;
  delegable: boolean;
}

export const DELEGABLE_CAPABILITIES = ["teaching:roster", "teaching:assign", "assessment:manage"] as const;
const ordinary = (delegable = false): CapabilityPolicy =>
  ({ storage_kind: "member", required_role: "organization_member", scope: "self", sensitivity: "ordinary", delegable });
const sensitive = (): CapabilityPolicy =>
  ({ storage_kind: "member", required_role: "organization_member", scope: "self", sensitivity: "sensitive", delegable: false });
const business = (sensitivity: Sensitivity): CapabilityPolicy =>
  ({ storage_kind: "administrative", required_role: "platform_member", scope: "all", sensitivity, delegable: false });

/** Fixed server-side allowlist. A role alone never creates an administrative grant. */
export const ADMINISTRATIVE_CATALOG: Readonly<Record<AdministrativeCapability, CapabilityPolicy>> = Object.freeze({
  "platform:govern": { storage_kind: "administrative", required_role: "platform_ops", scope: "self", sensitivity: "governance", delegable: false },
  "account:platform-manage": { storage_kind: "administrative", required_role: "platform_ops", scope: "self", sensitivity: "sensitive", delegable: false },
  "account:manage": { storage_kind: "administrative", required_role: "org_admin", scope: "self", sensitivity: "ordinary", delegable: false },
  "authorization:delegate": { storage_kind: "administrative", required_role: "org_admin", scope: "self", sensitivity: "sensitive", delegable: false },
  "content:edit": business("sensitive"),
  "content:review": business("sensitive"),
  "assessment:manage": business("sensitive"),
  "assessment:review": business("sensitive"),
  "report:read": business("sensitive"),
  "content:retire": business("sensitive"),
  "content:revoke": business("sensitive"),
  "file:delete": business("sensitive"),
});

export const MEMBER_CAPABILITY_CATALOG = Object.freeze({
  "training:schedule-manage": sensitive(), "training:attendance-edit": sensitive(), "training:attendance-review": sensitive(), "training:path-edit": sensitive(), "training:path-review": sensitive(), "training:certificate-issue": sensitive(), "training:certificate-revoke": sensitive(), "training:operations-read": sensitive(),
  "training:report-edit": sensitive(), "training:report-review": sensitive(),
  "course:edit": sensitive(), "course:review": sensitive(), "course:assign": ordinary(),
  "task:manage": ordinary(), "coursework:grade": sensitive(), "ai:assist": ordinary(),
  "ai:generate": ordinary(), "ai:manage": sensitive(), "site:edit": sensitive(),
  "site:review": sensitive(), "site:lead-read": sensitive(),
  "content:retire": sensitive(),
  "content:revoke": sensitive(),
  "file:delete": sensitive(),
  "assessment:manage": ordinary(true),
  "assessment:review": sensitive(),
  "teaching:roster": ordinary(true),
  "teaching:assign": ordinary(true),
  "teaching:report": sensitive(),
});

export function scopeContains(scope: AdministrativeScope, orgId: string): boolean {
  return scope.kind === "all_organizations" || scope.organization_ids.includes(orgId);
}

export function canonicalScope(scope: AdministrativeScope): AdministrativeScope {
  if (scope.kind === "all_organizations") {
    if (scope.organization_ids.length) throw new Error("all scope cannot include organization IDs");
    return { kind: "all_organizations", organization_ids: [] };
  }
  if (!scope.organization_ids.length || scope.organization_ids.some(id => !/^[0-9a-f]{24}$/.test(id)))
    throw new Error("Organization scope must contain valid IDs");
  return { kind: "organization_ids", organization_ids: [...new Set(scope.organization_ids)].sort() };
}
/** Stable exact-tuple identity, including all-organizations (whose ID array is empty). */
export function scopeFingerprint(scope: AdministrativeScope): string {
  const normalized = canonicalScope(scope);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}


export function assertGrantPolicy(capability: AdministrativeCapability, scope: AdministrativeScope, roles: RoleCode[], orgKind: string, delegates: string[]): void {
  const policy = ADMINISTRATIVE_CATALOG[capability];
  if (!policy) throw new Error("Unknown administrative capability");
  if (policy.required_role === "platform_member") {
    if (orgKind !== "platform" || roles.length === 0) throw new Error("Grant subject requires an effective platform membership");
  } else if (policy.required_role === "organization_member") {
    if (roles.length === 0) throw new Error("Grant subject requires an effective organization membership");
  } else if (!roles.includes(policy.required_role)) throw new Error("Grant subject does not hold required role");
  if (capability.startsWith("platform:") || capability === "account:platform-manage" || policy.required_role === "platform_member") {
    if (orgKind !== "platform") throw new Error("Platform capability requires a platform member");
  }
  const canonical = canonicalScope(scope);
  if (policy.scope === "self" && (canonical.kind !== "organization_ids" || canonical.organization_ids.length !== 1)) throw new Error("Administrative scope must be self");
  if (delegates.length && (capability !== "authorization:delegate" || delegates.some(value => !(DELEGABLE_CAPABILITIES as readonly string[]).includes(value)))) throw new Error("Delegation list exceeds server allowlist");
}
