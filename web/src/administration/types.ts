import type { BusinessOptions, BusinessRequest } from "../session";

export interface Page<T> { items: T[]; next_cursor: string | null }
export interface Organization { id: string; name: string; kind: string; status?: string }
export interface User { id: string; login_name: string; display_name: string; status: string; identity_revision: number; protected_account?: boolean }
export interface Member { id: string; user_id: string; display_name: string; status: string; roles: string[]; authorization_revision: number; role_assignments?: { role_id: string; valid_from: string | null; valid_to: string | null }[] }
export interface Scope { kind: "organization_ids" | "all_organizations"; organization_ids: string[] }
export interface Grant { id: string; subject_member_id: string; capability: string; scope: Scope; delegate_capabilities?: string[]; valid_from: string; valid_to: string | null; revision: number; status: string }
export interface CatalogEntry { capability: string; storage_kind: string; required_roles: string[]; allowed_scopes: string[]; sensitive: boolean; delegatable: boolean; delegate_capabilities?: string[] }
export type ConsoleMenu = "users" | "organizations" | "authorizations" | "approvals" | "audit" | "business";
export interface ConsoleContext { actor_org_id: string; actor_member_id: string; roles: string[]; capabilities: string[]; grants: Grant[]; catalog: CatalogEntry[]; menus: ConsoleMenu[]; target_organizations: Page<Organization>; database_mode: string }
export interface InvitationEvidence { invitation_id?: string; invitation_state?: string; invitation_revision?: number; delivery_status?: string }
export interface Receipt extends InvitationEvidence { operation_id: string; status: string; approval_id?: string; user_id?: string; temporary_password?: string; password_not_replayable?: boolean }
export interface Operation extends InvitationEvidence { id: string; operation_id: string; status: string; action: string; created_at: string; approval_id?: string | null; approval_status?: string | null }
export interface Approval { id: string; requester_id: string; target_user_id?: string; target_member_id?: string; action: string; payload: Record<string, unknown>; reason: string; status: string; revision: number; approver_id?: string; operation_id?: string; created_at: string }
export interface Audit { id: string; action: string; actor_id: string; actor_org_id?: string; target_org_id?: string; resource_type?: string; resource_id?: string; reason?: string; operation_id?: string; approval_id?: string; created_at: string; request_id: string }
/** undefined means no receipt (including cancelled confirmation); preserve the draft and do not report success. */
export type ConsoleWrite = (path: string, body: Record<string, unknown>, method?: "POST" | "PUT", expectsTemporaryPassword?: boolean) => Promise<Receipt | undefined>;
export interface ConsolePageProps { context: ConsoleContext; request: BusinessRequest; write: ConsoleWrite; locked: boolean; resourceId?: string }

export function platformRequest(request: BusinessRequest, module: "content" | "assessment", targetOrgId: string): BusinessRequest {
  return <T>(path: string, options: BusinessOptions = {}) => {
    const allowed = module === "content"
      ? /^\/admin\/(content-options|textbook-editions|question-versions|files|audit-events)(\/|\?|$)/
      : /^\/(admin\/(quizzes|assessment-questions|assessment-members|submissions|audit-events)|quizzes|submissions)(\/|\?|$)/;
    if (!targetOrgId || !allowed.test(path)) return Promise.reject(new Error("平台业务必须选择单个目标组织，且不能请求学生本人或作答接口。"));
    return request<T>(`/console/business/${module}${path}`, { ...options, headers: { ...options.headers, "X-Target-Org-Id": targetOrgId } });
  };
}
