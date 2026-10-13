<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { ApiError, type BusinessRequest, type Identity } from "../session";
import UsersPage from "./UsersPage.vue";
import OrganizationsPage from "./OrganizationsPage.vue";
import GrantsPage from "./GrantsPage.vue";
import ApprovalsAuditPage from "./ApprovalsAuditPage.vue";
import BusinessPage from "./BusinessPage.vue";
import ConsoleLayout from "./ConsoleLayout.vue";
import ConsoleOverview from "./ConsoleOverview.vue";
import type { Approval, ConsoleContext, ConsoleMenu, ConsoleWrite, Operation, Page, Receipt } from "./types";
import { consoleActionLabel, consoleCapabilityLabel, consoleRoleLabel, consoleScopeLabel, consoleStatusLabel } from "./presentation";
const props = defineProps<{ identity: Identity; request: BusinessRequest; busy?: boolean; emailActions?: boolean }>();
const emit = defineEmits<{ unavailable: []; writeActive: [value: boolean]; organization: [event: Event]; password: []; logout: [] }>();
const route = useRoute();
const context = ref<ConsoleContext>(), loading = ref(false), writing = ref(false), error = ref(""), message = ref(""), operationError = ref("");
const currentPassword = ref(""), temporaryPassword = ref(""), temporaryTarget = ref(""), recoveryBody = ref(""), pageEpoch = ref(0), pageDirty = ref(false), businessUnknown = ref(false);
const recoveryStatus = ref("待核查恢复"), temporaryOperation = ref(""), recoveryExpanded = ref(false);
const confirmationDialog = ref<HTMLDialogElement>(), confirmationPassword = ref<HTMLInputElement>(), checking = ref(false), confirmationError = ref("");
const approvalDetails = ref<{ action: string; target: string; organization: string; impact: string; roles: string[]; capability?: string; delegateCapabilities: string[]; status?: string; validFrom?: string; validTo?: string }>();
interface Confirmation {
  path: string; method: "POST" | "PUT"; body: Record<string, unknown>; passwordDelivery: boolean; replay: boolean;
  token: number; identity: string; route: string; context: string;
}
const confirmation = ref<Confirmation>();
let settleConfirmation: { resolve: (value: Receipt | undefined) => void; reject: (cause: unknown) => void } | undefined;
let returnFocus: HTMLElement | undefined;
let confirmationController = new AbortController();
const business = ref<{ beforeLeave: () => Promise<boolean> }>();
interface Recovery { path: string; method: "POST" | "PUT"; key: string; operation_id?: string; password_delivery?: boolean }
const pending = ref<Recovery>(), storageBlocked = ref(false), originalBody = shallowRef<Record<string, unknown>>();
const storageKey = computed(() => `console-recovery:${props.identity.user.id}:${props.identity.context?.org_id ?? ""}`);
const identityStamp = computed(() => JSON.stringify({
  userId: props.identity.user.id, orgId: props.identity.context?.org_id,
  organizationKind: props.identity.organizations.find(item => item.id === props.identity.context?.org_id)?.kind,
  capabilities: [...new Set(props.identity.context?.capabilities ?? [])].sort(),
  studentConflict: props.identity.context?.student_conflict, mustChangePassword: props.identity.must_change_password,
}));
function authorizationStamp(value: ConsoleContext) {
  return JSON.stringify({
    actorOrgId: value.actor_org_id, actorMemberId: value.actor_member_id, databaseMode: value.database_mode,
    roles: [...new Set(value.roles)].sort(), capabilities: [...new Set(value.capabilities)].sort(), menus: [...new Set(value.menus)].sort(),
    grants: value.grants.map(grant => ({
      id: grant.id, subjectMemberId: grant.subject_member_id, capability: grant.capability, revision: grant.revision, status: grant.status,
      scopeKind: grant.scope.kind, organizationIds: [...new Set(grant.scope.organization_ids)].sort(),
      delegateCapabilities: [...new Set(grant.delegate_capabilities ?? [])].sort(), validFrom: grant.valid_from, validTo: grant.valid_to,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    catalog: value.catalog.map(entry => ({
      capability: entry.capability, storageKind: entry.storage_kind, sensitive: entry.sensitive, delegatable: entry.delegatable,
      requiredRoles: [...new Set(entry.required_roles)].sort(), allowedScopes: [...new Set(entry.allowed_scopes)].sort(),
      delegateCapabilities: [...new Set(entry.delegate_capabilities ?? [])].sort(),
    })).sort((left, right) => `${left.storageKind}:${left.capability}`.localeCompare(`${right.storageKind}:${right.capability}`)),
  });
}
const contextStamp = computed(() => context.value ? authorizationStamp(context.value) : "");
let alive = true, generation = 0, writeGeneration = 0, pollTimer = 0, expiryTimer = 0, refreshing = false, contextRefreshPending = false;
let contextController = new AbortController();
let writeController = new AbortController();
function invalidateWrites() {
  writeGeneration++; confirmationController.abort(); confirmationController = new AbortController();
  finishConfirmation(); writeController.abort(); writeController = new AbortController(); writing.value = false;
}
watch(writing, active => {
  if (active) { contextController.abort(); contextController = new AbortController(); contextRefreshPending = true; }
  else void loadContext();
}, { flush: "sync" });
watch(() => writing.value || !!confirmation.value, active => emit("writeActive", active), { flush: "sync" });
const locked = computed(() => writing.value || !!confirmation.value || !!pending.value || storageBlocked.value);
const pageLocked = computed(() => locked.value || businessUnknown.value);
function storedBusinessRecovery() {
  const user = props.identity.user.id, org = props.identity.context?.org_id;
  if (!org) return false;
  const prefixes = [`console-business-recovery:${user}:${org}:`, `content-safety-recovery:${user}:platform:${org}:`, `assessment-admin-recovery:${user}:platform:${org}:`];
  try { return Object.keys(sessionStorage).some(key => prefixes.some(prefix => key.startsWith(prefix))); }
  catch { return true; }
}
function businessRecoveryState(value: boolean) { businessUnknown.value = value || storedBusinessRecovery(); }
const page = computed(() => String(route.meta.consolePage || route.params.page || "overview"));
const resourceId = computed(() => route.params.resourceId ? String(route.params.resourceId) : undefined);
const exactLookupOnly = computed(() => !!context.value && !context.value.menus.includes("users") && context.value.capabilities.includes("platform:govern"));
const allowed = computed(() => !!context.value && (page.value === "overview" || context.value.menus.includes(page.value as ConsoleMenu)
  || page.value === "users" && exactLookupOnly.value && route.meta.consoleMode !== "create"));
function organizationLabel(id: string) {
  return props.identity.organizations.find(item => item.id === id)?.name
    ?? context.value?.target_organizations.items.find(item => item.id === id)?.name ?? id;
}
function summary(path: string, body: Record<string, unknown>) {
  const parts = path.split("/"), id = parts[3] ?? "";
  let action = "管理操作", target = String(body.display_name || body.user_id || body.subject_member_id || id || "待服务端确定");
  let impact = "仅按当前职责和范围提交；敏感变更可能需独立审批，提交不等于已生效。";
  if (path === "/console/users") { action = "创建用户"; target = `${String(body.display_name || "")}（${String(body.login_name || "")}）`; impact = "创建账号及初始成员关系；直接生效时仅首次响应交付临时密码。"; }
  else if (path.endsWith("/password-reset")) { action = "重置用户密码"; impact = "重置影响该账号在所有组织的登录，生效后旧密码失效；新临时密码仅首次确定响应交付，目标人员首次登录须改密。"; }
  else if (path.endsWith("/status")) { action = body.status === "disabled" ? "停用用户" : "启用用户"; impact = "账号状态影响目标用户在所有组织的访问；停用可能使其现有会话失效。"; }
  else if (parts[2] === "organizations" && parts[4] === "invitations") { action = "发起机构邮箱邀请"; target = typeof body.email === "string" ? `${body.email}（仅本次内存）` : "原请求邮箱（需重新输入原正文核对）"; impact = "仅登记邀请及允许的邮件受理；不代表送达或已经加入。受保护或敏感目标必须先独立审批，新邮箱不能直接获得敏感职责。"; }
  else if (parts[2] === "invitations" && parts[4] === "revoke") { action = "撤销机构邀请"; target = `邀请 ${id} · 预期修订 ${String(body.expected_revision ?? "待核对")}`; impact = "使邀请链接、用途挑战及待发邮件失效；不能追回已被邮件服务器接受的邮件。不会删除成员或撤销已接受成员职责。"; }
  else if (parts[2] === "organizations" && parts[4] === "members") action = "添加组织成员";
  else if (parts[2] === "members") { action = "更新成员角色或状态"; impact = "变更组织内角色、有效期或访问状态；职责变更仍须服务端权限和版本核验。"; }
  else if (path === "/console/grants") { action = `授予授权：${consoleCapabilityLabel(String(body.capability || ""))}`; impact = "仅授权所列职责、范围与期限，不扩展其他能力；敏感授权可能需独立审批。"; }
  else if (parts[2] === "grants") { action = "撤销授权"; impact = "生效后目标授权失效；不得通过Web撤销最后治理管理员。"; }
  else if (parts[2] === "approvals") { action = body.decision === "approve" ? "批准申请" : "拒绝申请"; target = `审批 ${id}`; impact = body.decision === "approve" ? "批准不等于已生效，须以实际应用结果为准；不能审批本人申请。" : "拒绝该申请，不执行申请中的授权或账号变更。"; }
  const scope = body.scope && typeof body.scope === "object" && !Array.isArray(body.scope) ? body.scope as Record<string, unknown> : undefined;
  const organizationIds = Array.isArray(scope?.organization_ids) ? scope.organization_ids.filter((id): id is string => typeof id === "string") : [];
  let organization = scope ? `${consoleScopeLabel(String(scope.kind || ""))}${organizationIds.length ? `：${organizationIds.map(organizationLabel).join("、")}` : ""}`
    : organizationLabel(String(body.org_id || (parts[2] === "organizations" ? id : context.value?.actor_org_id || "")));
  if (parts[2] === "approvals") organization = "申请的原始组织范围（含全部组织或明确组织集合），不得在审批时改变";
  else if (parts[2] === "members") organization = "目标成员所属组织，以成员页所选组织为准";
  else if (parts[2] === "grants" && path !== "/console/grants") organization = "原授权的精确组织范围，不扩大或替换范围";
  else if (path.endsWith("/status") || path.endsWith("/password-reset")) organization = "全局用户账号（影响所有组织登录，不代表拥有所有组织业务授权）";
  return { action, target, organization, impact };
}
const confirmationSummary = computed(() => approvalDetails.value ?? (confirmation.value ? summary(confirmation.value.path, confirmation.value.body) : undefined));
const recoverySummary = computed(() => pending.value ? summary(pending.value.path, originalBody.value ?? {}) : undefined);
function validityEndLabel(value: unknown, action: string): string {
  if (typeof value === "string") return value;
  if (action === "member.update") return "未申请修改期限，沿用既有期限";
  if (action === "grant.create" && value === null) return "无自动到期";
  return "未提供截止时间，不推断永久有效";
}
function finishConfirmation(result?: Receipt, cause?: unknown) {
  const waiter = settleConfirmation;
  settleConfirmation = undefined; confirmation.value = undefined; approvalDetails.value = undefined; currentPassword.value = ""; confirmationError.value = ""; checking.value = false;
  confirmationDialog.value?.close();
  const focus = returnFocus; returnFocus = undefined;
  void nextTick(() => window.requestAnimationFrame(() => { if (alive && !confirmation.value && focus?.isConnected) focus.focus(); }));
  if (cause !== undefined) waiter?.reject(cause); else waiter?.resolve(result);
}
function cancelConfirmation() {
  if (writing.value) return;
  confirmationController.abort(); confirmationController = new AbortController(); finishConfirmation();
}
async function askConfirmation(path: string, body: Record<string, unknown>, method: "POST" | "PUT", passwordDelivery: boolean, replay: boolean): Promise<Receipt | undefined> {
  if (!alive || confirmation.value || writing.value || !context.value) return;
  const serialized = JSON.stringify(body);
  if (/"[^"]*(?:password|secret|token|hash)[^"]*"\s*:/i.test(serialized)) throw new Error("操作正文不能包含密码、密钥或哈希字段。");
  const snapshot = JSON.parse(serialized) as Record<string, unknown>;
  const result = new Promise<Receipt | undefined>((resolve, reject) => { settleConfirmation = { resolve, reject }; });
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  confirmationError.value = ""; operationError.value = ""; currentPassword.value = ""; approvalDetails.value = undefined;
  confirmation.value = { path, method, body: snapshot, passwordDelivery, replay, token: writeGeneration, identity: identityStamp.value, route: route.fullPath, context: contextStamp.value };
  const draft = confirmation.value;
  checking.value = path.startsWith("/console/approvals/");
  await nextTick();
  if (confirmation.value === draft) { confirmationDialog.value?.showModal(); confirmationPassword.value?.focus(); }
  if (checking.value && confirmation.value === draft) {
    try {
      const approval = await props.request<Approval>(`/console/approvals/${encodeURIComponent(path.split("/")[3] || "")}`, { signal: confirmationController.signal });
      if (!alive || confirmation.value !== draft) return result;
      const payload = approval.payload;
      const scope = payload.scope && typeof payload.scope === "object" ? payload.scope as Record<string, unknown> : undefined;
      const orgIds = Array.isArray(scope?.organization_ids) ? scope.organization_ids.filter((id): id is string => typeof id === "string") : [];
      const base = summary(path, snapshot);
      approvalDetails.value = {
        action: `${base.action}：${consoleActionLabel(approval.action)}`,
        target: `${approval.target_user_id ? `用户 ${approval.target_user_id}` : approval.target_member_id ? `成员 ${approval.target_member_id}` : "申请中登记的目标"} · 审批 ${approval.id}`,
        organization: ["user.status", "user.password.reset"].includes(approval.action) ? "全局用户账号（影响所有组织登录，不代表拥有所有组织业务授权）"
          : scope ? `${consoleScopeLabel(String(scope.kind || ""))}${orgIds.length ? `：${orgIds.map(organizationLabel).join("、")}` : ""}`
          : payload.org_id ? organizationLabel(String(payload.org_id)) : base.organization,
        impact: `${base.impact}${snapshot.decision === "approve" && approval.action === "user.password.reset" ? " 生效后旧密码失效，新密码仅首次确定响应交付，首次登录须改密。" : ""}${snapshot.decision === "approve" && payload.status === "disabled" && ["user.status", "member.update"].includes(approval.action) ? approval.action === "user.status" ? " 停用该全局账号，影响所有组织访问，现有会话可能失效。" : " 停用目标组织成员关系，其组织内访问和职责将失效。" : ""}`,
        roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [],
        ...(typeof payload.capability === "string" ? { capability: payload.capability } : {}),
        delegateCapabilities: Array.isArray(payload.delegate_capabilities) ? payload.delegate_capabilities.map(String) : [],
        ...(typeof payload.status === "string" ? { status: payload.status } : {}),
        ...(typeof payload.valid_from === "string" ? { validFrom: payload.valid_from } : {}),
        ...("valid_to" in payload ? { validTo: validityEndLabel(payload.valid_to, approval.action) } : {}),
      };
      checking.value = false; await nextTick(); confirmationPassword.value?.focus();
    } catch (cause) {
      if (confirmation.value === draft) {
        operationError.value = cause instanceof Error ? cause.message : "原申请读取失败，未发送写请求";
        finishConfirmation(undefined, cause);
      }
    }
  }
  return result;
}
function trapConfirmationFocus(event: KeyboardEvent) {
  if (event.key !== "Tab") return;
  const controls = Array.from(confirmationDialog.value?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex='0']") ?? []);
  const first = controls[0], last = controls.at(-1);
  if (!first || !last) { event.preventDefault(); confirmationDialog.value?.focus(); return; }
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
async function confirmWrite() {
  const draft = confirmation.value;
  if (!draft || checking.value || writing.value || !currentPassword.value) return;
  checking.value = true; confirmationError.value = ""; let attempted = false;
  try {
    const fresh = await props.request<ConsoleContext>("/console/context", { signal: confirmationController.signal });
    if (!alive || confirmation.value !== draft || draft.token !== writeGeneration || draft.identity !== identityStamp.value || draft.route !== route.fullPath) return;
    if (authorizationStamp(fresh) !== draft.context) {
      invalidateWrites(); pageEpoch.value++; clearSecret(); originalBody.value = undefined; recoveryBody.value = "";
      pageDirty.value = false; businessUnknown.value = false; context.value = fresh; scheduleExpiry(fresh);
      message.value = "职责、组织范围或期限已变化，本次未发送确认已取消，请重新核对表单。";
      if (!fresh.menus.length) emit("unavailable");
      return;
    }
    if (!currentPassword.value) { confirmationError.value = "密码已清空，请重新输入后确认；尚未发送请求。"; return; }
    if (!draft.replay) {
      const metadata: Recovery = { path: draft.path, method: draft.method, key: crypto.randomUUID(), password_delivery: draft.passwordDelivery };
      originalBody.value = draft.body;
      try { remember(metadata); } catch { originalBody.value = undefined; storageBlocked.value = true; throw new Error("安全恢复元数据无法保存，未发送写请求。"); }
    } else {
      if (!pending.value || pending.value.path !== draft.path || pending.value.method !== draft.method || storageBlocked.value) throw new Error("原请求恢复状态已变化，未发送请求。");
      originalBody.value = draft.body;
    }
    checking.value = false;
    attempted = true;
    const result = await send(draft.replay);
    if (confirmation.value === draft) finishConfirmation(result);
  } catch (cause) {
    if (confirmation.value !== draft || !alive) return;
    if (cause instanceof DOMException && cause.name === "AbortError") { finishConfirmation(); return; }
    operationError.value = cause instanceof Error ? cause.message : "本次操作未完成";
    if (attempted || storageBlocked.value) finishConfirmation(undefined, cause);
    else if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
      finishConfirmation(undefined, cause); context.value = undefined; pageEpoch.value++; clearSecret(); fail(cause);
    } else { confirmationError.value = operationError.value; currentPassword.value = ""; void nextTick(() => confirmationPassword.value?.focus()); }
  } finally { if (confirmation.value === draft) checking.value = false; }
}
function clearSecret() { temporaryPassword.value = ""; temporaryTarget.value = ""; temporaryOperation.value = ""; currentPassword.value = ""; }
function fail(cause: unknown) { if (alive && !(cause instanceof DOMException && cause.name === "AbortError")) { error.value = cause instanceof Error ? cause.message : "请求未完成"; if (cause instanceof ApiError && cause.operationId) error.value += ` · 操作编号 ${cause.operationId}，需CLI受控核对恢复。`; } }
function remember(value?: Recovery) {
  const safe = value ? { path: value.path, method: value.method, key: value.key, ...(value.operation_id ? { operation_id: value.operation_id } : {}), ...(value.password_delivery !== undefined ? { password_delivery: value.password_delivery } : {}) } : undefined;
  if (safe) sessionStorage.setItem(storageKey.value, JSON.stringify(safe)); else sessionStorage.removeItem(storageKey.value);
  pending.value = safe;
}
function expectsPassword(value: Recovery, approvalId?: string) { return (value.password_delivery ?? /password-reset$|\/users$/.test(value.path)) && (!approvalId || value.path.startsWith("/console/approvals/")); }
function forget() { remember(); originalBody.value = undefined; recoveryBody.value = ""; }
function accept(receipt: Receipt) {
  clearSecret();
  const metadata = pending.value, decision = metadata?.path.startsWith("/console/approvals/");
  if (receipt.approval_id) message.value = decision
    ? `审批 ${receipt.approval_id} · ${consoleStatusLabel(receipt.status)} · 操作 ${receipt.operation_id}。`
    : `申请已登记 ${receipt.approval_id} · 原操作 ${consoleStatusLabel(receipt.status)}。是否生效以审批页的当前状态为准。`;
  else message.value = `操作 ${receipt.operation_id} · ${receipt.status === "pending" ? "结果待确认" : consoleStatusLabel(receipt.status)}。`;
  if (receipt.invitation_id) message.value += ` 邀请 ${receipt.invitation_id}${receipt.invitation_state ? ` · ${receipt.invitation_state}` : ""}${receipt.invitation_revision ? ` · 修订 ${receipt.invitation_revision}` : ""}。`;
  if (receipt.delivery_status) message.value += ` 邮件状态：${receipt.delivery_status === "accepted" ? "受理入队（非送达）" : receipt.delivery_status}。`;
  recoveryStatus.value = receipt.status === "pending" && !receipt.approval_id ? "结果待确认" : consoleStatusLabel(receipt.status);
  if (receipt.status === "applied" || receipt.status === "rejected" || receipt.approval_id && receipt.status === "pending" && !decision) {
    if (receipt.status === "applied" && receipt.temporary_password && receipt.user_id) { temporaryTarget.value = `${receipt.user_id}${originalBody.value?.display_name ? ` · ${String(originalBody.value.display_name)}` : ""}`; temporaryOperation.value = receipt.operation_id; temporaryPassword.value = receipt.temporary_password; }
    else if (metadata && expectsPassword(metadata, receipt.approval_id) && receipt.status === "applied") message.value += " 结果已确认但未收到可交付密码；原请求不会重新生成或回放密码，请身份核验后发起新的重置。";
    forget();
  } else if (pending.value && receipt.operation_id) remember({ ...pending.value, operation_id: receipt.operation_id });
}
const write: ConsoleWrite = async (path, body, method = "POST", expectsTemporaryPassword = /password-reset$|\/users$/.test(path)) => {
  businessRecoveryState(businessUnknown.value);
  if (locked.value || businessUnknown.value || !context.value) throw new Error("原请求待确认或正在执行，不能更换请求编号重复提交。");
  return askConfirmation(path, body, method, expectsTemporaryPassword, false);
};
async function send(replay: boolean): Promise<Receipt | undefined> {
  const metadata = pending.value; if (!metadata || !originalBody.value || writing.value) return;
  if (!currentPassword.value) throw new Error("请重新输入当前密码，恢复原请求也重新核验身份。");
  writing.value = true; error.value = ""; operationError.value = ""; clearDelivery();
  const token = writeGeneration, password = currentPassword.value, recoveryStorageKey = storageKey.value; currentPassword.value = "";
  try {
    const result = await props.request<Receipt>(metadata.path, { method: metadata.method, idempotencyKey: metadata.key, body: { ...originalBody.value, current_password: password }, signal: writeController.signal });
    if (!alive || token !== writeGeneration) return;
    accept(result);
    return { operation_id: result.operation_id, status: result.status, ...(result.approval_id ? { approval_id: result.approval_id } : {}),
      ...(result.user_id ? { user_id: result.user_id } : {}), ...(result.invitation_id ? { invitation_id: result.invitation_id } : {}),
      ...(result.invitation_state ? { invitation_state: result.invitation_state } : {}), ...(result.invitation_revision ? { invitation_revision: result.invitation_revision } : {}),
      ...(result.delivery_status ? { delivery_status: result.delivery_status } : {}) };
  }
  catch (cause) {
    const rejected = !replay && cause instanceof ApiError && [400,401,403,404,409,413,422,429].includes(cause.status) && !["IDEMPOTENCY_CONFLICT","IDEMPOTENCY_RESULT_INVALID","COMMIT_OUTCOME_UNKNOWN","OPERATION_NEEDS_RECOVERY"].includes(cause.code);
    if (rejected) {
      try {
        const stored = JSON.parse(sessionStorage.getItem(recoveryStorageKey) || "null") as Recovery | null;
        if (stored?.key === metadata.key) sessionStorage.removeItem(recoveryStorageKey);
        if (alive && token === writeGeneration) { pending.value = undefined; originalBody.value = undefined; }
      } catch { if (alive && token === writeGeneration) storageBlocked.value = true; }
    }
    if (!rejected && cause instanceof ApiError && cause.operationId) {
      try {
        const stored = JSON.parse(sessionStorage.getItem(recoveryStorageKey) || "null") as Recovery | null;
        if (stored?.key === metadata.key) {
          const next = { ...metadata, operation_id: cause.operationId };
          sessionStorage.setItem(recoveryStorageKey, JSON.stringify(next));
          if (alive && token === writeGeneration) pending.value = next;
        }
      } catch { if (alive && token === writeGeneration) storageBlocked.value = true; }
    }
    if (alive && token === writeGeneration) operationError.value = cause instanceof Error ? cause.message : "本次操作未完成";
    throw cause;
  }
  finally { if (alive && token === writeGeneration) writing.value = false; }
}
function restoreOriginalBody() {
  if (!pending.value || originalBody.value !== undefined || writing.value || confirmation.value || storageBlocked.value) return;
  if (recoveryBody.value.length > 65536) { operationError.value = "原请求正文过长，须由受控CLI核查。"; return; }
  try {
    const body: unknown = JSON.parse(recoveryBody.value);
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some(key => /password|secret|token|hash/i.test(key)) ||
        Object.values(body).some(value => typeof value === "object" && value !== null &&
          JSON.stringify(value).match(/"(?:[^"]*password|[^"]*secret|[^"]*token|[^"]*hash)"/i)))
      throw new Error("原请求必须是无密码、密钥或哈希字段的JSON对象");
    if (!window.confirm(`请核对 ${pending.value.path} 的原正文、目标与期限完全一致。仅沿原编号 ${pending.value.key} 恢复；字段不一致将保留未知状态。`)) return;
    originalBody.value = body as Record<string, unknown>;
    recoveryBody.value = "";
    message.value = "原请求正文仅恢复在本页内存；请选择重新核验密码，沿原编号重试。";
  } catch (cause) { operationError.value = cause instanceof Error ? cause.message : "原请求正文格式无效"; }
}
function clearDelivery() { temporaryPassword.value = ""; temporaryTarget.value = ""; temporaryOperation.value = ""; }
async function replayOriginal() {
  if (!pending.value || !originalBody.value || writing.value || confirmation.value || storageBlocked.value) return;
  try { await askConfirmation(pending.value.path, originalBody.value, pending.value.method, !!pending.value.password_delivery, true); }
  catch (cause) { operationError.value = cause instanceof Error ? cause.message : "原请求恢复未完成"; }
}
async function recover() {
  const metadata = pending.value; if (!metadata || writing.value || confirmation.value) return;
  writing.value = true; operationError.value = ""; clearDelivery(); const token = writeGeneration;
  try {
    const operation = metadata.operation_id
      ? await props.request<Operation>(`/console/operations/${encodeURIComponent(metadata.operation_id)}`, { signal: writeController.signal, notFound: "lookup" })
      : (await props.request<Page<Operation>>(`/console/operations?${new URLSearchParams({ key: metadata.key })}`, { signal: writeController.signal })).items[0];
    if (!alive || token !== writeGeneration) return;
    if (!operation) { message.value = "服务器尚未确认原请求；未查到回执不代表失败。请继续以原编号查询或在保留原正文时重新核验密码后恢复。"; return; }
    if (operation.status === "applied" || operation.status === "rejected") {
      forget();
      const approvalState = operation.approval_id ? ` · 审批 ${operation.approval_id}：${operation.approval_status ? consoleStatusLabel(operation.approval_status) : "状态待查询"}` : "";
      recoveryStatus.value = consoleStatusLabel(operation.status);
      message.value = `原请求 ${metadata.key} · 操作登记 ${operation.operation_id} · ${consoleStatusLabel(operation.status)}${approvalState}。`;
      if (operation.invitation_id) message.value += ` 邀请 ${operation.invitation_id}${operation.invitation_state ? ` · ${operation.invitation_state}` : ""}${operation.invitation_revision ? ` · 修订 ${operation.invitation_revision}` : ""}。`;
      if (operation.action === "invitation.create" || operation.action === "invitation.revoke") message.value += ` 只读核对未重发邮件或恢复秘密${operation.delivery_status ? `；邮件状态 ${operation.delivery_status === "accepted" ? "受理入队（非送达）" : operation.delivery_status}` : ""}，操作登记不代表加入。`;
      if (operation.status === "applied" && expectsPassword(metadata, operation.approval_id ?? undefined) && (!operation.approval_id || operation.approval_status === "applied"))
        message.value += " 操作已生效但密码未收到；原请求不回放密码。请重新核验身份后发起新的重置。";
    }
    else { remember({ ...metadata, operation_id: operation.operation_id }); recoveryStatus.value = operation.status === "pending" ? "操作登记待确认" : consoleStatusLabel(operation.status); message.value = `原操作 ${operation.operation_id} · ${recoveryStatus.value}，保持未知写入锁；待核查恢复必须由CLI核对。`; }
  } catch (cause) { if (alive && token === writeGeneration) operationError.value = cause instanceof Error ? cause.message : "查询原请求未完成"; } finally { if (alive && token === writeGeneration) writing.value = false; }
}
function scheduleExpiry(value: ConsoleContext) {
  window.clearTimeout(expiryTimer);
  const ends = value.grants.map(grant => grant.valid_to ? Date.parse(grant.valid_to) : NaN).filter(end => Number.isFinite(end) && end > Date.now());
  if (ends.length) expiryTimer = window.setTimeout(() => { if (!alive) return; if (writing.value) { contextRefreshPending = true; return; } generation++; invalidateWrites(); pageEpoch.value++; context.value = undefined; clearSecret(); recoveryBody.value = ""; originalBody.value = undefined; pageDirty.value = false; businessUnknown.value = false; void loadContext(); }, Math.min(Math.max(1, Math.min(...ends) - Date.now()), 2147483647));
}
async function loadContext() {
  if (!alive) return;
  if (refreshing || writing.value) { contextRefreshPending = true; return; }
  refreshing = true; loading.value = !context.value; const token = generation;
  try { const value = await props.request<ConsoleContext>("/console/context", { signal: contextController.signal }); if (!alive || token !== generation || writing.value) return;
    if (context.value && contextStamp.value !== authorizationStamp(value)) { invalidateWrites(); pageEpoch.value++; clearSecret(); recoveryBody.value = ""; originalBody.value = undefined; pageDirty.value = false; businessUnknown.value = false; }
    context.value = value; businessRecoveryState(false); scheduleExpiry(value); if (!value.menus.length) emit("unavailable");
  } catch (cause) { if (alive && token === generation && !writing.value && !(cause instanceof DOMException && cause.name === "AbortError")) { invalidateWrites(); context.value = undefined; pageEpoch.value++; clearSecret(); recoveryBody.value = ""; originalBody.value = undefined; fail(cause); } }
  finally { if (alive) { loading.value = false; refreshing = false; if (contextRefreshPending && !writing.value) { contextRefreshPending = false; void loadContext(); } } }
}
async function beforeLeave() {
  if (!business.value && pageDirty.value && !window.confirm("管理表单或业务草稿未提交，确定放弃本地修改？")) return false;
  if ((writing.value || pending.value || storageBlocked.value) && !window.confirm("管理请求结果仍待确认；离开不会取消服务端操作。仅保留原请求编号，不保存密码或操作正文。是否继续？")) return false;
  if (business.value && !await business.value.beforeLeave()) return false;
  if (temporaryPassword.value && !window.confirm("临时密码只在当前页面显示一次。离开将立即清除且不能从回执找回，请确认已安全交付或接受重新核验后重置。是否离开？")) return false;
  cancelConfirmation(); clearSecret(); recoveryBody.value = ""; originalBody.value = undefined; return true;
}
defineExpose({ beforeLeave });
watch(() => route.fullPath, () => { invalidateWrites(); clearSecret(); recoveryBody.value = ""; originalBody.value = undefined; error.value = ""; message.value = ""; operationError.value = ""; pageDirty.value = false; recoveryExpanded.value = false; });
watch(identityStamp, () => {
  generation++; invalidateWrites(); contextController.abort(); contextController = new AbortController();
  clearSecret(); recoveryBody.value = ""; originalBody.value = undefined; pending.value = undefined; storageBlocked.value = false;
  context.value = undefined; pageEpoch.value++; pageDirty.value = false; businessUnknown.value = false;
  restoreMetadata(); void loadContext();
}, { flush: "sync" });
function beforeUnload(event: BeforeUnloadEvent) { if (pageDirty.value || locked.value || businessUnknown.value) { event.preventDefault(); event.returnValue = ""; } cancelConfirmation(); clearSecret(); }
function restoreMetadata() {
  try { const raw = sessionStorage.getItem(storageKey.value); if (raw) { const value = JSON.parse(raw) as Recovery; if (!value.key || !["POST", "PUT"].includes(value.method) || !(/^\/console\/(users|organizations|members|grants|approvals)(\/|$)/.test(value.path) || value.method === "POST" && /^\/console\/invitations\/[a-f0-9]{24}\/revoke$/.test(value.path))) throw new Error("恢复元数据无效"); remember(value); } } catch { storageBlocked.value = true; error.value = "安全恢复元数据不可读取，写入已冻结，请核对原操作。"; }
}
onMounted(() => {
  restoreMetadata();
  void loadContext(); pollTimer = window.setInterval(() => void loadContext(), 30000); window.addEventListener("beforeunload", beforeUnload);
});
onBeforeUnmount(() => { alive = false; generation++; invalidateWrites(); contextController.abort(); window.clearInterval(pollTimer); window.clearTimeout(expiryTimer); window.removeEventListener("beforeunload", beforeUnload); clearSecret(); recoveryBody.value = ""; originalBody.value = undefined; context.value = undefined; emit("writeActive", false); });
</script>
<template>
  <ConsoleLayout :identity="identity" :context="context" :busy="busy || writing" @organization="emit('organization', $event)" @password="emit('password')" @logout="emit('logout')">
    <p v-if="loading" role="status">正在核验当前职责、组织范围与期限…</p>
    <p v-if="error" class="notice" role="alert">{{ error }}</p>
    <div v-if="context" class="admin-workspace stack">
        <section v-if="message || operationError || writing" class="console-operation-panel stack" aria-label="本次管理操作">
          <h3>操作结果</h3>
          <p v-if="writing" role="status">请求已发送，正在核对结果；不能关闭确认框来取消服务端操作。</p>
          <p v-if="message" role="status">{{ message }}</p>
          <p v-if="operationError" class="notice" role="alert">{{ operationError }}</p>
        </section>
        <section v-if="temporaryPassword" class="console-delivery stack" aria-labelledby="console-delivery-title">
          <h3 id="console-delivery-title">临时密码 · 仅此一次交付</h3>
          <p>交付目标：{{ temporaryTarget }}</p><p>操作编号：{{ temporaryOperation }}</p>
          <p>请安全交付指定目标人员，并提醒其首次登录必须修改密码。</p>
          <output class="console-password" aria-label="一次性临时密码">{{ temporaryPassword }}</output>
          <p class="field-help">仅保存在本页内存，不自动复制。切换页面或组织、刷新、退出、失权即清空；不能从回执恢复。</p>
          <button class="button secondary" @click="clearDelivery">已交付，清除内存密码</button>
        </section>
        <section v-if="pending || storageBlocked" class="notice stack console-recovery" aria-labelledby="console-recovery-title">
          <div class="admin-section-header"><h2 id="console-recovery-title">原请求待确认 · {{ recoveryStatus }}</h2><button class="button secondary" :aria-expanded="recoveryExpanded" aria-controls="console-recovery-details" @click="recoveryExpanded = !recoveryExpanded">{{ recoveryExpanded ? '收起恢复详情' : '查看恢复详情' }}</button></div>
          <p v-if="pending">{{ recoverySummary?.action }} · {{ recoverySummary?.target }}。结果未确认前禁止新写入。</p>
          <div v-if="pending && recoveryExpanded" id="console-recovery-details" class="stack">
            <p>动作：{{ recoverySummary?.action }} · 目标：{{ recoverySummary?.target }}</p>
            <p>原请求：<code>{{ pending.path }}</code></p>
            <p>原编号：<code>{{ pending.key }}</code> · 操作编号：{{ pending.operation_id || '待确认' }}</p>
            <p>结果未确认前禁止新写入，不能更换编号重复提交；未查到回执不代表失败。</p>
            <div class="actions">
              <button class="button secondary" :disabled="writing || !!confirmation" @click="recover">按原编号查询结果</button>
              <button v-if="originalBody" class="button secondary" :disabled="writing || !!confirmation || storageBlocked" @click="replayOriginal">重新核验密码并恢复原请求</button>
              <RouterLink v-if="pending.operation_id && context.menus.includes('audit')" class="button secondary" to="/console/audit">进入操作审计核查</RouterLink>
            </div>
            <details v-if="!originalBody" class="console-advanced-recovery">
              <summary>高级恢复：重新绑定完全相同的原正文</summary>
              <div class="stack">
                <p>刷新后仅保留安全元数据，正文和密码不会持久化。必须填写完全相同的原正文并沿原编号校验幂等；无法确定原正文时请CLI受控核查。</p>
                <div class="field"><label for="console-recovery-body">原请求正文 JSON（不得含密码、密钥或哈希）</label><textarea id="console-recovery-body" v-model="recoveryBody" rows="5" autocomplete="off" :disabled="writing || !!confirmation || storageBlocked" /></div>
                <button class="button secondary" :disabled="writing || !!confirmation || storageBlocked || !recoveryBody.trim()" @click="restoreOriginalBody">核对原正文并绑定原编号</button>
              </div>
            </details>
          </div>
          <p v-if="storageBlocked">安全恢复存储不可用，写入已冻结；请受控核查原操作，不能清除编号后重新提交。</p>
        </section>
        <p v-if="businessUnknown && page !== 'business'" class="notice" role="status">业务原请求结果仍待确认，新管理写入已冻结。请返回原业务模块及目标组织核对原请求；离开页面不会取消服务端操作。</p>
        <p v-if="!allowed" class="notice" role="alert">当前身份无此页面权限，未读取页面数据。请选择仍可见的菜单。</p>
        <ConsoleOverview v-else-if="page === 'overview'" :key="`overview:${pageEpoch}`" :context="context" :request="request" />
        <UsersPage v-else-if="page === 'users'" :key="`users:${pageEpoch}:${route.fullPath}`" :context="context" :request="request" :write="write" :locked="pageLocked" :resource-id="resourceId" :exact-lookup-only="exactLookupOnly" @dirty="pageDirty = $event" />
        <OrganizationsPage v-else-if="page === 'organizations'" :key="`organizations:${pageEpoch}:${route.fullPath}`" :context="context" :request="request" :write="write" :locked="pageLocked" :resource-id="resourceId" :email-actions="emailActions" @dirty="pageDirty = $event" />
        <GrantsPage v-else-if="page === 'authorizations'" :key="`grants:${pageEpoch}:${route.fullPath}`" :context="context" :request="request" :write="write" :locked="pageLocked" :resource-id="resourceId" @dirty="pageDirty = $event" />
        <ApprovalsAuditPage v-else-if="page === 'approvals' || page === 'audit'" :key="`${page}:${pageEpoch}:${route.fullPath}`" :mode="page === 'approvals' ? 'approvals' : 'audit'" :actor-user-id="identity.user.id" :context="context" :request="request" :write="write" :locked="pageLocked" :resource-id="resourceId" @dirty="pageDirty = $event" />
        <BusinessPage v-else-if="page === 'business'" ref="business" :key="`business:${pageEpoch}`" :identity="identity" :context="context" :request="request" :locked="locked" @dirty="pageDirty = $event" @unknown="businessRecoveryState" @context-change="clearSecret" />
    </div>
    <button v-else-if="!loading" class="button secondary" @click="loadContext">重新查询控制台职责</button>
    <dialog ref="confirmationDialog" class="content-dialog console-confirmation" tabindex="-1" aria-labelledby="console-confirmation-title" aria-describedby="console-confirmation-help" @cancel.prevent="cancelConfirmation" @keydown="trapConfirmationFocus">
      <form v-if="confirmation && confirmationSummary" class="stack" @submit.prevent="confirmWrite">
        <h3 id="console-confirmation-title">{{ confirmation.replay ? '恢复原请求前确认' : '提交前确认' }}</h3>
        <dl class="console-confirmation-summary"><dt>动作</dt><dd>{{ confirmationSummary.action }}</dd><dt>目标</dt><dd>{{ confirmationSummary.target }}</dd><dt>组织范围</dt><dd>{{ confirmationSummary.organization }}</dd><dt>影响</dt><dd>{{ confirmationSummary.impact }}</dd></dl>
        <p v-if="confirmation.body.roles && Array.isArray(confirmation.body.roles)">角色：{{ confirmation.body.roles.map(role => consoleRoleLabel(String(role))).join('、') }}</p>
        <p v-if="confirmation.body.status">目标状态：{{ consoleStatusLabel(String(confirmation.body.status)) }}</p>
        <p v-if="'valid_from' in confirmation.body || 'valid_to' in confirmation.body">有效期：{{ confirmation.body.valid_from || '本次操作未指定开始时间' }} → {{ validityEndLabel(confirmation.body.valid_to, confirmation.path === '/console/grants' ? 'grant.create' : confirmation.path.startsWith('/console/members/') ? 'member.update' : '') }}</p>
        <p v-if="Array.isArray(confirmation.body.delegate_capabilities)">委派职责：{{ confirmation.body.delegate_capabilities.map(cap => consoleCapabilityLabel(String(cap))).join('、') || '无' }}</p>
        <p v-if="approvalDetails?.roles.length">申请角色：{{ approvalDetails.roles.map(consoleRoleLabel).join('、') }}</p>
        <p v-if="approvalDetails?.capability">申请职责：{{ consoleCapabilityLabel(approvalDetails.capability) }}（<code>{{ approvalDetails.capability }}</code>）</p>
        <p v-if="approvalDetails?.delegateCapabilities.length">申请委派清单：{{ approvalDetails.delegateCapabilities.map(cap => `${consoleCapabilityLabel(cap)}（${cap}）`).join('、') }}</p>
        <p v-if="approvalDetails?.status">申请目标状态：{{ consoleStatusLabel(approvalDetails.status) }}（<code>{{ approvalDetails.status }}</code>）</p>
        <p v-if="approvalDetails">申请有效期：{{ approvalDetails.validFrom || '原申请未提供开始时间' }} → {{ approvalDetails.validTo || '原申请未提供截止时间' }}</p>
        <p v-if="confirmation.body.reason">操作理由：{{ confirmation.body.reason }}</p>
        <p v-if="confirmation.replay">仅沿原编号 {{ pending?.key }} 恢复；不会生成新请求编号。</p>
        <p id="console-confirmation-help" class="field-help">核对的是本次提交快照，不随表单变化。每次写入重新输入当前密码；仅单次内存核验，发送时立即清空，不是MFA。取消尚未发送的确认会保留表单。</p>
        <p v-if="confirmationError" class="notice" role="alert">{{ confirmationError }}</p>
        <div class="field"><label for="console-current-password">当前密码</label><input id="console-current-password" ref="confirmationPassword" v-model="currentPassword" type="password" autocomplete="off" required :disabled="writing || checking" /></div>
        <p v-if="checking || writing" role="status">{{ writing ? '已发送，等待结果；不能取消服务端操作。' : '正在读取原申请或重新核验职责；尚未发送写请求，可取消。' }}</p>
        <div class="actions"><button class="button secondary" type="button" :disabled="writing" @click="cancelConfirmation">取消未发送操作</button><button class="button" type="submit" :disabled="writing || checking || !currentPassword">{{ confirmation.replay ? '确认并沿原编号恢复' : '确认并提交' }}</button></div>
      </form>
    </dialog>
  </ConsoleLayout>
</template>

<style scoped>
.console-delivery { border-color: var(--color-action); background: var(--color-selected); }
.console-password { font-family: var(--font-mono); overflow-wrap: anywhere; padding: var(--space-3); background: var(--color-surface); user-select: all; }
.console-recovery code { word-break: break-all; }
.console-confirmation-summary { margin: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-2) var(--space-3); }
.console-confirmation-summary dt { font-weight: 700; }
.console-confirmation-summary dd { margin: 0; overflow-wrap: anywhere; }
</style>
