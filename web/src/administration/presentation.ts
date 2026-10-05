import type { ConsoleContext } from "./types";

const statusLabels: Record<string, string> = {
  pending: "申请待审批", approved: "审批已批准但未应用", applying: "正在应用",
  applied: "已生效", rejected: "已拒绝", needs_recovery: "待核查恢复",
  active: "有效", disabled: "已停用", revoked: "已撤销", enabled: "已启用",
  ready: "已就绪", insufficient_evidence: "证据不足", stale: "已过期", updating: "正在更新",
  suppressed: "已抑制", not_ready: "尚未就绪", draft: "草稿", pending_review: "待审核",
  published: "已发布", retired: "已退役", scanning: "正在扫描", clean: "扫描通过",
  infected: "检测到感染", failed: "失败", skipped: "已跳过",
  insufficient: "证据不足", unavailable: "暂不可用", weak: "薄弱", developing: "发展中", mastered: "已掌握",
};
const roleLabels: Record<string, string> = {
  student: "学生", teacher: "教师", content_editor: "内容编辑", content_reviewer: "内容审核",
  org_admin: "组织管理员", platform_ops: "平台运营",
  platform_member: "平台成员", organization_member: "组织成员",
};
const capabilityLabels: Record<string, string> = {
  "platform:govern": "平台治理", "account:platform-manage": "平台账号管理", "account:manage": "组织账号管理",
  "authorization:delegate": "精确授权委派", "account:read": "账号读取", "organization:admin": "组织管理",
  "learning:self": "本人学习", "teaching:class": "班级教学", "teaching:roster": "教学名单管理",
  "teaching:assign": "教学任务分配", "teaching:report": "教学报告读取", "content:edit": "内容编辑",
  "content:review": "内容审核", "content:retire": "内容退役", "content:revoke": "内容撤回",
  "file:delete": "文件删除", "assessment:manage": "测评管理", "assessment:review": "测评审核", "report:read": "报告读取",
  "operations:health": "运维健康检查",
};
const actionLabels: Record<string, string> = {
  "user.create": "创建用户", "member.add": "添加组织成员", "member.update": "更新成员角色或状态",
  "user.status": "变更用户状态", "user.password.reset": "重置用户密码", "grant.create": "授予精确授权",
  "grant.revoke": "撤销授权", "approval.approve": "批准申请", "approval.reject": "拒绝申请",
  "auth.login": "账号登录", "auth.logout": "退出登录", "auth.password.change": "修改登录密码",
  "organization.create": "创建组织", "organization.status": "变更组织状态",
  "membership.set": "设置组织成员", "governance.bootstrap": "初始化治理授权",
  "teaching.class.create": "创建班级", "teaching.class.update": "更新班级",
  "teaching.roster.add": "添加班级学生", "teaching.roster.remove": "移除班级学生",
  "teaching.assignment.create": "创建授课关系", "teaching.assignment.end": "结束授课关系",
};
export function consoleStatusLabel(status: string | null | undefined): string {
  return status ? Object.hasOwn(statusLabels, status) ? statusLabels[status]! : status : "未提供";
}
export function consoleRoleLabel(role: string): string { return Object.hasOwn(roleLabels, role) ? roleLabels[role]! : role; }
export function consoleCapabilityLabel(capability: string): string { return Object.hasOwn(capabilityLabels, capability) ? capabilityLabels[capability]! : capability; }
export function consoleActionLabel(action: string): string {
  if (action.startsWith("approval.request.")) return `申请：${consoleActionLabel(action.slice("approval.request.".length))}`;
  if (action.startsWith("capability.grant.")) return `授予权限：${consoleCapabilityLabel(action.slice("capability.grant.".length))}`;
  if (action.startsWith("capability.revoke.")) return `撤销权限：${consoleCapabilityLabel(action.slice("capability.revoke.".length))}`;
  return Object.hasOwn(actionLabels, action) ? actionLabels[action]! : action;
}
export function consoleScopeLabel(kind: string): string {
  return kind === "all_organizations" ? "所有组织（含未来组织）" : kind === "organization_ids" ? "指定组织" : kind;
}

export type ConsoleBusinessModule = "content" | "assessment" | "reports" | "safety";
const businessCapabilities: Record<ConsoleBusinessModule, readonly string[]> = {
  content: ["content:edit", "content:review"],
  assessment: ["assessment:manage", "assessment:review"],
  reports: ["report:read"],
  safety: ["content:retire", "content:revoke", "file:delete"],
};
export function consoleBusinessModules(context: ConsoleContext): ConsoleBusinessModule[] {
  if (!context.menus.includes("business")) return [];
  const now = Date.now();
  const grants = context.grants.filter(grant => grant.status === "active"
    && Date.parse(grant.valid_from) <= now && (!grant.valid_to || Date.parse(grant.valid_to) > now)
    && (grant.scope.kind === "all_organizations" || grant.scope.organization_ids.some(id => id !== context.actor_org_id)));
  return (Object.keys(businessCapabilities) as ConsoleBusinessModule[])
    .filter(module => grants.some(grant => businessCapabilities[module].includes(grant.capability)));
}

export function consoleDateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
