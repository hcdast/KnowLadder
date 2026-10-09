import type { ConsoleContext, Member, Organization, User } from "./types";

export interface UserMembership extends Pick<Member, "id" | "status" | "roles" | "authorization_revision" | "role_assignments"> {
  org_id: string;
  organization_name?: string;
}

const basicRoles = ["student", "teacher", "content_editor", "content_reviewer", "org_admin"];
const supportedRoles: Record<string, true> = { student: true, teacher: true, content_editor: true, org_admin: true, content_reviewer: true, platform_ops: true };

/** The directory supplies role prerequisites, not authority to grant a platform identity. */
export function availablePeopleRoles(context: ConsoleContext, organization: Organization | undefined, existing: readonly string[] = []): string[] {
  const roles = new Set(basicRoles);
  for (const entry of context.catalog) {
    for (const role of entry.required_roles) if (Object.hasOwn(supportedRoles, role)) roles.add(role);
  }
  if (!context.capabilities.includes("platform:govern") || organization?.kind !== "platform" || organization.id !== context.actor_org_id) roles.delete("platform_ops");
  for (const role of existing) roles.add(role);
  return [...roles];
}

export function canAddPeopleRole(context: ConsoleContext, organization: Organization | undefined, role: string): boolean {
  return availablePeopleRoles(context, organization).includes(role);
}

export function isUserId(value: string): boolean {
  return /^[0-9a-f]{24}$/.test(value);
}

export function sameUserName(users: readonly Pick<User, "id" | "display_name">[], user: Pick<User, "id" | "display_name">): boolean {
  return users.some(other => other.id !== user.id && other.display_name === user.display_name);
}

export function organizationKindLabel(kind: string): string {
  return ({ platform: "平台组织", school: "学校", personal: "个人组织" } as Record<string, string>)[kind] ?? kind;
}
