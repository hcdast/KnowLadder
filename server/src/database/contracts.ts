import type { Collection, Db, Document } from "mongodb";
export type RoleCode =
  | "student"
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
  content_editor: ["account:read", "content:edit"],
  content_reviewer: ["account:read", "content:review"],
  org_admin: ["account:read", "organization:admin"],
  platform_ops: ["account:read", "operations:health"],
};
// Explicit member grants only. Never append these capabilities to built-in roles.
export const CONTROLLED_CAPABILITIES = ["content:retire", "content:revoke", "file:delete", "assessment:manage", "assessment:review"] as const;
export type ControlledCapability = typeof CONTROLLED_CAPABILITIES[number];
export interface MemberCapabilityGrant extends Document {
  _id: string;
  org_id: string;
  member_id: string;
  capability: ControlledCapability;
}
export const normalizeLogin = (value: string) => value.trim().toLowerCase();
export function validLogin(value: string): boolean {
  return /^[a-z0-9_-]{3,64}$/.test(normalizeLogin(value));
}
export function validPassword(value: string): boolean {
  return (
    [...value].length >= 12 &&
    [...value].length <= 128 &&
    Buffer.byteLength(value, "utf8") <= 512
  );
}
