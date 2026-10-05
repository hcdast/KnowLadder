import {PHASE2_CAPABILITIES} from '../training/phase2-schema';
import { REPORT_CAPABILITIES } from '../training/report-schema';
import { TRAINING_CAPABILITIES } from "../training/capabilities";
import type { Collection, Db, Document } from "mongodb";
export type RoleCode =
  | "student"
  | "teacher"
  | "content_editor"
  | "content_reviewer"
  | "org_admin"
  | "platform_ops";
export interface User extends Document {
  _id: string;
  login_key: string;
  display_name: string;
  status: "active" | "disabled";
  privacy_state?: "active" | "erasing" | "erased";
  password_hash: string;
  credential_version: number;
  identity_revision: number;
  must_change_password: boolean;
  temporary_password_expires_at: Date | null;
  password_changed_at: Date;
  created_at: Date;
  updated_at: Date;
}
export interface Organization extends Document {
  _id: string;
  name: string;
  kind: "school" | "personal" | "platform";
  status: "active" | "disabled";
  created_at: Date;
  updated_at: Date;
}
export interface Member extends Document {
  _id: string;
  org_id: string;
  user_id: string;
  status: "active" | "disabled";
  authorization_revision: number;
  created_at: Date;
  updated_at: Date;
}
export interface Role extends Document {
  _id: RoleCode;
  code: RoleCode;
  capabilities: string[];
}
export interface MemberRole extends Document {
  _id: string;
  org_id: string;
  member_id: string;
  role_id: RoleCode;
  status?: GrantStatus;
  valid_from?: Date;
  valid_to?: Date | null;
  operation_id?: string | null;
  approval_id?: string | null;
  authority?: "legacy" | "cli" | "approval";
}
export interface AuthSession extends Document {
  _id: string;
  token_hash: string;
  kind: "preauth" | "authenticated";
  user_id: string | null;
  credential_version: number | null;
  csrf_token: string;
  created_at: Date;
  last_seen_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}
export interface AuditEvent extends Document {
  _id: string;
  actor_id: string;
  org_id: string | null;
  action: string;
  resource_id: string;
  reason: string;
  request_id: string;
  created_at: Date;
}
export type GrantStatus = "pending" | "active" | "revoked";
export type AdministrativeScope =
  | { kind: "organization_ids"; organization_ids: string[] }
  | { kind: "all_organizations"; organization_ids: [] };
export type AdministrativeCapability =
  | "platform:govern"
  | "account:platform-manage"
  | "account:manage"
  | "authorization:delegate"
  | "content:edit"
  | "content:review"
  | "assessment:manage"
  | "assessment:review"
  | "report:read"
  | "content:retire"
  | "content:revoke"
  | "file:delete";
export interface AdministrativeGrant extends Document {
  _id: string;
  subject_member_id: string;
  actor_org_id: string;
  capability: AdministrativeCapability;
  scope: AdministrativeScope;
  scope_key: string;
  delegate_capabilities: string[];
  status: GrantStatus;
  revision: number;
  valid_from: Date;
  valid_to: Date | null;
  operation_id: string | null;
  authority: "cli" | "delegation" | "approval";
  approval_id: string | null;
  created_at: Date;
  updated_at: Date;
}
export interface AuthorizationRequest extends Document {
  _id: string;
  requester_user_id: string;
  requester_member_id: string;
  beneficiary_user_id: string;
  subject_member_id: string | null;
  action: string;
  payload: Document;
  payload_hash: string;
  expected_grant_revision: number | null;
  requester_permission_revision: number;
  requester_credential_version: number;
  target_credential_version: number;
  target_identity_revision: number;
  reason: string;
  status: "pending" | "approved" | "rejected" | "applying" | "applied" | "needs_recovery";
  revision: number;
  approver_user_id: string | null;
  approver_credential_version: number | null;
  approved_at: Date | null;
  operation_id: string | null;
  created_at: Date;
  updated_at: Date;
}
export interface AdministrationTargets {
  user_ids: string[];
  member_ids: string[];
  org_ids: string[];
  global: boolean;
}
export interface AdministrationOperation extends Document {
  _id: string;
  actor_id: string;
  action: string;
  reason: string;
  targets: AdministrationTargets;
  payload_hash: string;
  before: Document;
  desired: Document;
  key: string | null;
  mode: "replicaSet" | "standalone";
  status: "pending" | "applying" | "applied" | "needs_recovery" | "void";
  step: string;
  revision: number;
  audit_id: string | null;
  created_at: Date;
  updated_at: Date;
}
export interface AdministrationGuard extends Document {
  _id: "administration";
  revision: number;
  state: "idle" | "applying" | "needs_recovery" | "recovering";
  operation_id: string | null;
  recovery_token: string | null;
  blocked_targets: AdministrationTargets;
  affected_orgs: string[];
  updated_at: Date;
}
export function collections(db: Db): {
  users: Collection<User>;
  organizations: Collection<Organization>;
  members: Collection<Member>;
  roles: Collection<Role>;
  memberRoles: Collection<MemberRole>;
  sessions: Collection<AuthSession>;
  audit: Collection<AuditEvent>;
} {
  return {
    users: db.collection<User>("users"),
    organizations: db.collection<Organization>("organizations"),
    members: db.collection<Member>("organization_members"),
    roles: db.collection<Role>("roles"),
    memberRoles: db.collection<MemberRole>("member_roles"),
    sessions: db.collection<AuthSession>("auth_sessions"),
    audit: db.collection<AuditEvent>("audit_events"),
  };
}
export const ROLE_CAPABILITIES: Record<RoleCode, string[]> = {
  student: ["account:read", "learning:self"],
  teacher: ["account:read", "teaching:class"],
  content_editor: ["account:read", "content:edit"],
  content_reviewer: ["account:read", "content:review"],
  org_admin: ["account:read", "organization:admin"],
  platform_ops: ["account:read", "operations:health"],
};
// Explicit member grants only. Never append these capabilities to built-in roles.
export const CONTROLLED_CAPABILITIES = [...TRAINING_CAPABILITIES, ...PHASE2_CAPABILITIES, ...REPORT_CAPABILITIES, "content:retire", "content:revoke", "file:delete", "assessment:manage", "assessment:review", "teaching:roster", "teaching:assign", "teaching:report"] as const;
export type ControlledCapability = typeof CONTROLLED_CAPABILITIES[number];
export interface MemberCapabilityGrant extends Document {
  _id: string;
  org_id: string;
  member_id: string;
  capability: ControlledCapability;
  status: GrantStatus;
  revision: number;
  valid_from: Date;
  valid_to: Date | null;
  operation_id: string | null;
  authority: "legacy" | "cli" | "delegation" | "approval";
  created_at: Date;
  updated_at: Date;
}
export const normalizeLogin = (value: string) => value.trim().toLowerCase();
export function validLogin(value: string): boolean {
  return /^[a-z0-9_-]{3,64}$/.test(normalizeLogin(value));
}
export function validPassword(value: string): boolean {
  return (
    [...value].length >= 6 &&
    [...value].length <= 128 &&
    Buffer.byteLength(value, "utf8") <= 512
  );
}
