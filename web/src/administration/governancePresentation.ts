import type { CatalogEntry, Member } from "./types";

export type AuthorizationMember = Member & { org_id: string; organization_name: string; login_name?: string; user_status: string };
export const baseRoleDirectory = [
  { role: "student", description: "使用本人学习与账号功能。", capabilities: ["account:read", "learning:self"] },
  { role: "teacher", description: "管理已有班级教学；名单与任务分配需独立授权。", capabilities: ["account:read", "teaching:class"] },
  { role: "content_editor", description: "编写教材与题库内容，不包含审核或退役。", capabilities: ["account:read", "content:edit"] },
  { role: "content_reviewer", description: "在批准的明确期限内审核内容。", capabilities: ["account:read", "content:review"] },
  { role: "org_admin", description: "组织管理身份；账号管理与委派仍需独立授权。", capabilities: ["account:read", "organization:admin"] },
  { role: "platform_ops", description: "平台运维身份；不自动获得治理、账号或业务管理权。", capabilities: ["account:read", "operations:health"] },
];
const responsibilities: Record<string, string> = {
  "platform:govern": "发起和独立审批治理变更，维护固定授权目录内的管理职责。",
  "account:platform-manage": "在平台账号职责范围内创建、查看及管理用户账号。",
  "account:manage": "管理本组织账号和成员；不自动获得跨组织账号管理权。",
  "authorization:delegate": "仅向本组织成员授予或撤销清单内的精确能力，不可再委派治理权。",
  "content:edit": "管理授权组织的教材与题库编写。",
  "content:review": "审核授权组织的教材与题库内容。",
  "content:retire": "退役授权范围内的内容版本。",
  "content:revoke": "撤回授权范围内的已发布内容。",
  "file:delete": "执行授权范围内的文件删除处置。",
  "assessment:manage": "管理授权范围内的测评与考试配置。",
  "assessment:review": "执行授权范围内的测评审核。",
  "report:read": "只读查看授权组织的聚合教学报告，不代表可读取原始答案。",
  "teaching:roster": "管理本组织内的教学名单。",
  "teaching:assign": "分配本组织内的教学任务。",
  "teaching:report": "查看本组织内的教学报告。",
};
export function responsibilityDescription(capability: string): string {
  return responsibilities[capability] ?? "仅执行服务端固定目录中该职责允许的动作。";
}
export function requiresOwnOrganization(entry: CatalogEntry): boolean {
  return entry.storage_kind === "member" || ["platform:govern", "account:platform-manage", "account:manage", "authorization:delegate"].includes(entry.capability);
}
export function eligibleEntry(entry: CatalogEntry, member: AuthorizationMember, organizationKind: string | undefined, catalog: CatalogEntry[]): boolean {
  if (!organizationKind || member.status !== "active" || member.user_status !== "active" || !entry.required_roles.every(role => member.roles.includes(role))) return false;
  if (entry.storage_kind === "member") {
    return organizationKind !== "platform" || !catalog.some(item => item.storage_kind === "administrative" && item.capability === entry.capability);
  }
  if (["account:manage", "authorization:delegate"].includes(entry.capability)) return true;
  return organizationKind === "platform" && member.roles.length > 0;
}
