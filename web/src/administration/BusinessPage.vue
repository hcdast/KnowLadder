<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import PageHeader from "./components/PageHeader.vue";
import ResourceTable from "./components/ResourceTable.vue";
import ContentWorkspace from "../content/ContentWorkspace.vue";
import AssessmentAdmin from "../assessment/AssessmentAdmin.vue";
import ReportsPage from "./ReportsPage.vue";
import BusinessSafetyPage from "./BusinessSafetyPage.vue";
import { ApiError, type BusinessOptions, type BusinessRequest, type Identity } from "../session";
import { platformRequest, type ConsoleContext, type Organization, type Page } from "./types";
import { consoleBusinessModules, consoleCapabilityLabel, type ConsoleBusinessModule } from "./presentation";
const props = defineProps<{ identity: Identity; context: ConsoleContext; request: BusinessRequest; locked?: boolean }>();
const emit = defineEmits<{ dirty: [value: boolean]; unknown: [value: boolean]; contextChange: [] }>();
type BusinessModule = ConsoleBusinessModule;
const route = useRoute();
const moduleCapabilities: Record<BusinessModule, string[]> = {
  content: ["content:edit", "content:review"],
  assessment: ["assessment:manage", "assessment:review"],
  reports: ["report:read"],
  safety: ["content:retire", "content:revoke", "file:delete"],
};
const moduleTitles: Record<BusinessModule, string> = { content: "教材与题库", assessment: "考试管理", reports: "学情报告", safety: "安全处置" };
const moduleDescriptions: Record<BusinessModule, string> = {
  content: "在单个已授权组织中维护教材与题库，沿既有版本审核流程操作。",
  assessment: "在单个已授权组织中编排考试与复核提交，不替学生作答。",
  reports: "读取已发布的班级与学生证据，不重建投影或虚构统计。",
  safety: "按独立安全能力处置资源，仅读取必要元数据。",
};
function routeModule(): BusinessModule | undefined {
  const value = route.params.module;
  return typeof value === "string" && Object.hasOwn(moduleCapabilities, value) ? value as BusinessModule : undefined;
}
const validBusinessGrants = computed(() => props.context.grants.filter(grant =>
  grant.status === "active" && Date.parse(grant.valid_from) <= Date.now() &&
  (!grant.valid_to || Date.parse(grant.valid_to) > Date.now()) &&
  Object.values(moduleCapabilities).some(values => values.includes(grant.capability))));
function grantsForModule(value: BusinessModule) { return validBusinessGrants.value.filter(grant => moduleCapabilities[value].includes(grant.capability)); }
const initialModule = routeModule() || consoleBusinessModules(props.context)[0] || "content";
const module = ref<BusinessModule>(initialModule), epoch = ref(0), dirty = ref(false), childUnknown = ref(false), error = ref(""), busy = ref(false);
const organizations = ref<Organization[]>([]), orgCursor = ref<string | null>(null), target = ref("");
const message = ref(""), organizationError = ref(""), organizationsLoading = ref(false), organizationsLoaded = ref(false);
function allowsOrganization(id: string, value = module.value) {
  return grantsForModule(value).some(grant => grant.scope.kind === "all_organizations" || grant.scope.organization_ids.includes(id));
}
const targetChoices = computed(() => organizations.value.filter(item => item.kind !== "platform" && item.id !== props.context.actor_org_id && allowsOrganization(item.id)));
const targetName = computed(() => organizations.value.find(item => item.id === target.value)?.name || "未选择");
const moduleAuthorized = computed(() => consoleBusinessModules(props.context).includes(module.value));
const content = ref<{ beforeLeave: () => Promise<boolean> }>(); const life = new AbortController(); let alive = true, generation = 0;
interface Recovery { path: string; method: "POST" | "PATCH" | "PUT"; key: string; module: "content" | "assessment"; owner_revision?: number }
const pending = ref<Recovery>(), storageBlocked = ref(false); let originalBody: unknown;
const otherPending = ref<{ targetOrgId: string; key: string; module: Recovery["module"] }[]>([]);
let requests = new AbortController(); const storagePrefix = `console-business-recovery:${props.identity.user.id}:${props.context.actor_org_id}:`;
const recoveryScope = computed(() => `platform:${props.context.actor_org_id}:${target.value}`);
const activeGrants = computed(() => validBusinessGrants.value.filter(grant => grant.scope.kind === "all_organizations" || grant.scope.organization_ids.includes(target.value)));
const capabilities = computed(() => [...new Set(activeGrants.value.map(grant => grant.capability))]);
const canContent = computed(() => capabilities.value.some(cap => moduleCapabilities.content.includes(cap)));
const canSafety = computed(() => capabilities.value.some(cap => moduleCapabilities.safety.includes(cap)));
const canAssessment = computed(() => capabilities.value.some(cap => moduleCapabilities.assessment.includes(cap)));
const canReport = computed(() => capabilities.value.includes("report:read"));
const selectedGrants = computed(() => activeGrants.value.filter(grant => moduleCapabilities[module.value].includes(grant.capability)));
const displayIdentity = computed<Identity>(() => ({ ...props.identity, context: { ...props.identity.context!, capabilities: capabilities.value } }));
const unknown = computed(() => !!pending.value || storageBlocked.value || childUnknown.value || busy.value || otherPending.value.length > 0);
watch(dirty, value => emit("dirty", value)); watch(unknown, value => emit("unknown", value), { flush: "sync" });
function fail(cause: unknown, targetError = error) { if (alive && !(cause instanceof DOMException && cause.name === "AbortError")) targetError.value = cause instanceof Error ? cause.message : "请求失败"; }
function storageKey() { return `${storagePrefix}${target.value}`; }
function scanOutstanding() {
  const found: typeof otherPending.value = [];
  const prefixes = [
    { prefix: storagePrefix, module: undefined },
    { prefix: `assessment-admin-recovery:${props.identity.user.id}:platform:${props.context.actor_org_id}:`, module: "assessment" as const },
    { prefix: `content-safety-recovery:${props.identity.user.id}:platform:${props.context.actor_org_id}:`, module: "content" as const },
  ];
  try {
    for (let index = 0; index < sessionStorage.length; index++) {
      const name = sessionStorage.key(index);
      if (!name) continue;
      const scope = prefixes.find(value => name.startsWith(value.prefix));
      if (!scope) continue;
      const targetOrgId = name.slice(scope.prefix.length);
      const value = JSON.parse(sessionStorage.getItem(name) || "") as Partial<Recovery>;
      const originalModule = scope.module || value.module;
      if (!targetOrgId || typeof value.key !== "string" || !value.key || !["content", "assessment"].includes(originalModule || "")) throw new Error("原业务请求元数据无效");
      if (targetOrgId !== target.value && !found.some(item => item.targetOrgId === targetOrgId && item.key === value.key)) found.push({ targetOrgId, key: value.key, module: originalModule as Recovery["module"] });
    }
    otherPending.value = found;
  } catch {
    storageBlocked.value = true;
    error.value = "无法核验当前管理身份的业务恢复元数据，所有新业务写入已冻结；请受控核查原编号。";
  }
}
function remember(value?: Recovery) {
  const safe = value ? { path: value.path, method: value.method, key: value.key, module: value.module, ...(value.owner_revision !== undefined ? { owner_revision: value.owner_revision } : {}) } : undefined;
  if (safe) sessionStorage.setItem(storageKey(), JSON.stringify(safe)); else sessionStorage.removeItem(storageKey());
  pending.value = safe;
  scanOutstanding();
}
function readRecovery() {
  storageBlocked.value = false; originalBody = undefined;
  scanOutstanding();
  pending.value = undefined;
  if (!target.value) return;
  try {
    const raw = sessionStorage.getItem(storageKey());
    if (raw) {
      const metadata = JSON.parse(raw) as Recovery;
      if (!metadata.key || !metadata.path.startsWith("/") || !["content", "assessment"].includes(metadata.module) || !["POST", "PATCH", "PUT"].includes(metadata.method)) throw new Error("原请求元数据无效");
      pending.value = metadata;
    }
  } catch { storageBlocked.value = true; error.value = "无法读取原业务请求元数据，写入冻结；不得清除记录后重复提交。"; }
}
const request: BusinessRequest = async <T>(path: string, options: BusinessOptions = {}): Promise<T> => {
  if (!alive || options.signal?.aborted || requests.signal.aborted) throw new DOMException("业务上下文已离开", "AbortError");
  const chosen = pending.value && pending.value.key === options.idempotencyKey
    ? pending.value.module
    : module.value === "safety" ? "content" : module.value;
  if (chosen === "reports") throw new Error("报告只读，不能复用内容或考试写入接口。");
  if (!target.value || !activeGrants.value.some(grant => (chosen === "content" ? [...moduleCapabilities.content, ...moduleCapabilities.safety] : moduleCapabilities.assessment).includes(grant.capability))) throw new Error("当前目标组织没有对应业务授权，未发送请求。");
  const token = generation, targetOrg = target.value, scopeSignal = requests.signal;
  const adapter = platformRequest(props.request, chosen, targetOrg);
  const method = options.method || "GET", isWrite = method !== "GET";
  const tracked = isWrite;
  const firstAttempt = !pending.value;
  let wireBody = options.body;
  if (tracked) {
    scanOutstanding();
    if (firstAttempt && otherPending.value.length) throw new ApiError(409, "其他目标组织有原业务请求待确认，未发送新的写入；请先恢复原目标请求。");
    if (props.locked) throw new ApiError(409, "控制台原请求待确认，未发送新的业务写入。");
    if (storageBlocked.value) throw new Error("安全恢复元数据不可读取，写入已冻结。");
    if (pending.value && (pending.value.key !== options.idempotencyKey || pending.value.path !== path || pending.value.method !== method || pending.value.module !== chosen)) throw new Error("原业务写入结果仍待确认，请按原编号恢复，不能提交其他操作。");
    if (!options.idempotencyKey) throw new Error("平台业务写入必须具有原幂等编号。");
    if (!firstAttempt && originalBody === undefined) throw new Error("仅保留原key，原正文未保存；不能使用新表单重放，请查询真实原请求回执。");
    wireBody = !firstAttempt ? originalBody : options.body === undefined || options.body instanceof Blob ? options.body : JSON.parse(JSON.stringify(options.body));
    remember({ path, method: method as Recovery["method"], key: options.idempotencyKey, module: chosen, ...(options.headers?.["X-Owner-Revision"] ? { owner_revision: Number(options.headers["X-Owner-Revision"]) } : {}) }); originalBody = wireBody;
  }
  const cancel = new AbortController(); const abort = () => cancel.abort(); scopeSignal.addEventListener("abort", abort, { once: true }); options.signal?.addEventListener("abort", abort, { once: true }); if (scopeSignal.aborted || options.signal?.aborted) abort();
  try { const value = await adapter<T>(path, { ...options, body: wireBody, signal: cancel.signal }); if (!alive || token !== generation || targetOrg !== target.value) throw new DOMException("目标组织已变更", "AbortError"); if (tracked) { remember(); originalBody = undefined; } return value; }
  catch (cause) { if (alive && token === generation && tracked && firstAttempt && cause instanceof ApiError && [400,404,409,413,422,429].includes(cause.status) && !["COMMIT_OUTCOME_UNKNOWN","IDEMPOTENCY_CONFLICT","IDEMPOTENCY_RESULT_INVALID","IDENTITY_CHANGED"].includes(cause.code)) { remember(); originalBody = undefined; } throw cause; }
  finally { scopeSignal.removeEventListener("abort", abort); options.signal?.removeEventListener("abort", abort); }
};
async function loadOrganizations(next = false) {
  if (organizationsLoading.value || !moduleAuthorized.value) return;
  organizationsLoading.value = true; organizationError.value = "";
  try { const q = new URLSearchParams({ limit: "20" }); if (next && orgCursor.value) q.set("cursor", orgCursor.value); const page = await props.request<Page<Organization>>(`/console/organizations?${q}`, { signal: life.signal }); if (alive) { organizations.value = next ? [...organizations.value, ...page.items] : page.items; orgCursor.value = page.next_cursor; organizationsLoaded.value = true; } } catch (cause) { fail(cause, organizationError); } finally { if (alive) organizationsLoading.value = false; }
}
async function beforeLeave() {
  if (dirty.value && !window.confirm("业务草稿未保存，确定放弃当前修改？")) return false;
  if (unknown.value && !window.confirm("业务请求结果尚未确认；切换不会取消已到达服务器的写入。保留原编号但不保存正文 / 学生数据，确定继续？")) return false;
  return !content.value || await content.value.beforeLeave();
}
defineExpose({ beforeLeave });
function invalidate() { generation++; requests.abort(); requests = new AbortController(); epoch.value++; dirty.value = false; childUnknown.value = false; busy.value = false; originalBody = undefined; error.value = ""; message.value = ""; emit("contextChange"); }
async function selectTarget(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (value === target.value) return;
  if ((value && !targetChoices.value.some(item => item.id === value)) || !await beforeLeave()) { (event.target as HTMLSelectElement).value = target.value; return; }
  invalidate(); target.value = value; readRecovery();
}
watch(() => route.params.module, () => {
  const value = routeModule();
  if (!value || value === module.value) return;
  invalidate(); module.value = value;
  if (target.value && !allowsOrganization(target.value)) target.value = "";
  readRecovery();
  if (!organizationsLoaded.value && moduleAuthorized.value) void loadOrganizations();
});
async function resumeTarget(id: string) {
  if (!targetChoices.value.some(item => item.id === id) || !await beforeLeave()) return;
  invalidate(); target.value = id; readRecovery();
}
async function recover() {
  const metadata = pending.value; if (!metadata || busy.value) return;
  const needed = metadata.module === "content" ? [...moduleCapabilities.content, ...moduleCapabilities.safety] : moduleCapabilities.assessment;
  if (!activeGrants.value.some(grant => needed.includes(grant.capability))) { error.value = "当前目标已无原操作所属模块的授权；原编号继续保留，请由有权管理者核查。"; return; }
  busy.value = true; error.value = ""; message.value = ""; const token = generation;
  try { const query = new URLSearchParams({ key: metadata.key }); const upload = /^\/admin\/files\/([^/]+)\/content$/.exec(metadata.path); if (upload && metadata.method === "PUT") query.set("resource_id", upload[1]!); const result = await props.request<{ status: "resolved" | "unknown"; result?: unknown }>(`/console/business/${metadata.module}/requests?${query}`, { signal: requests.signal, headers: { "X-Target-Org-Id": target.value } }); if (!alive || token !== generation) return; if (result.status === "resolved") { remember(); sessionStorage.removeItem(`assessment-admin-recovery:${props.identity.user.id}:${recoveryScope.value}`); originalBody = undefined; childUnknown.value = false; epoch.value++; message.value = "原请求已由真实幂等记录确认；请重新读取当前资源，不将原回执当完整业务正文。"; } else message.value = "原请求结果仍未知，不能用资源存在或版本变化断言提交失败。"; } catch (cause) { fail(cause); } finally { if (alive && token === generation) busy.value = false; }
}
async function replay() { const metadata = pending.value; if (!metadata || originalBody === undefined || busy.value) return; busy.value = true; error.value = ""; message.value = ""; const token = generation; try { const body = originalBody; await request(metadata.path, { method: metadata.method, idempotencyKey: metadata.key, body, ...(body instanceof Blob ? { headers: { "Content-Type": "application/octet-stream", "X-Owner-Revision": String(metadata.owner_revision) } } : {}) }); if (alive && token === generation) { sessionStorage.removeItem(`assessment-admin-recovery:${props.identity.user.id}:${recoveryScope.value}`); childUnknown.value = false; epoch.value++; message.value = "已以原编号确认，请重新读取资源。"; } } catch (cause) { fail(cause); } finally { if (alive && token === generation) busy.value = false; } }
async function selectUploadFile(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0], metadata = pending.value;
  input.value = "";
  if (!file || !metadata || metadata.module !== "content" || metadata.method !== "PUT" || !/^\/admin\/files\/[^/]+\/content$/.test(metadata.path) || metadata.owner_revision === undefined) return;
  if (!activeGrants.value.some(grant => moduleCapabilities.content.includes(grant.capability))) { error.value = "当前目标没有内容上传授权，原编号继续保留。"; return; }
  const token = generation; busy.value = true; error.value = ""; message.value = "";
  try {
    const path = metadata.path.slice(0, -"/content".length);
    const record = await platformRequest(props.request, "content", target.value)<{ size: number; mime: string; checksum: string }>(path, { signal: requests.signal });
    if (file.size !== record.size || file.type !== record.mime) throw new Error("文件大小或MIME与原上传声明不同，不能用原key上传其他文件。");
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (!alive || token !== generation) return;
    if (digest !== record.checksum) throw new Error("SHA-256 与原上传声明不同，不能用原key上传其他内容。");
    originalBody = file; message.value = "已核对所选文件与原声明一致；请使用原编号恢复上传，不会生成新文件登记。";
  } catch (cause) { fail(cause); } finally { if (alive && token === generation) busy.value = false; }
}
onMounted(() => { readRecovery(); void loadOrganizations(); });
onBeforeUnmount(() => { alive = false; generation++; life.abort(); requests.abort(); originalBody = undefined; emit("dirty", false); });
</script>
<template>
  <section class="admin-page business-page">
    <PageHeader :title="moduleTitles[module]" :description="moduleDescriptions[module]" />
    <section class="admin-card business-context" aria-label="业务目标组织">
      <div class="admin-toolbar">
        <div class="field">
          <label for="business-target">目标组织</label>
          <select id="business-target" :value="target" :disabled="busy || organizationsLoading || !moduleAuthorized" @change="selectTarget">
            <option value="">选择已授权组织</option>
            <option v-for="org in targetChoices" :key="org.id" :value="org.id">{{ org.name }}</option>
          </select>
        </div>
        <button v-if="orgCursor && moduleAuthorized" class="button secondary" :disabled="organizationsLoading" @click="loadOrganizations(true)">加载更多组织</button>
        <details class="admin-meta"><summary>授权与技术信息</summary>
          <p>管理身份：{{ identity.user.display_name }}。全部组织授权也必须选择单个业务目标，治理授权不赋予业务读取权。</p>
          <p>管理组织 {{ context.actor_org_id }} · 目标组织 {{ target || '未选择' }}</p>
          <ResourceTable v-if="target" :headers="['业务职责', '生效时间', '到期时间']" :empty="!selectedGrants.length">
            <tr v-for="grant in selectedGrants" :key="grant.id"><td>{{ consoleCapabilityLabel(grant.capability) }}</td><td>{{ grant.valid_from }}</td><td>{{ grant.valid_to || '无自动到期' }}<details><summary>授权编号</summary>{{ grant.id }}</details></td></tr>
          </ResourceTable>
        </details>
      </div>
      <p v-if="target" class="field-help">工作区目标：<strong>{{ targetName }}</strong>。操作不会改变顶栏中的管理身份。</p>
      <p v-if="organizationsLoading" role="status">正在读取组织目录…</p>
      <div v-if="organizationError" class="notice" role="alert"><p>组织目录读取失败：{{ organizationError }}</p><button class="button secondary" :disabled="organizationsLoading" @click="loadOrganizations()">重试组织目录</button></div>
      <p v-if="!moduleAuthorized" class="admin-empty">没有本模块的有效业务授权，未读取组织或业务数据。</p>
      <p v-else-if="organizationsLoaded && !targetChoices.length && !organizationsLoading && !organizationError" class="admin-empty">当前已读取目录中没有获授权的目标组织。{{ orgCursor ? '可继续加载目录。' : '未请求业务数据。' }}</p>
    </section>
    <p v-if="error" class="notice" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="props.locked" class="notice" role="alert">控制台另有请求正在处理或待确认，请先完成其核验与恢复。当前业务工作区暂不可操作。</p>
    <p v-if="busy" role="status">正在核对原业务请求…</p>
    <section v-if="otherPending.length" class="notice stack" aria-label="其他目标原业务请求">
      <h2>其他目标组织有请求待确认</h2><p>当前管理身份仍有原请求未确认，所有新业务写入保持冻结。选择原目标恢复；若本模块未授权该目标，请切换原操作所属模块，或交由有权管理者核查。</p>
      <div v-for="item in otherPending" :key="`${item.targetOrgId}:${item.key}`" class="stack">
        <p>{{ organizations.find(org => org.id === item.targetOrgId)?.name || '已保存的原目标' }} · {{ item.module === 'assessment' ? '考试操作' : '内容或安全操作' }} · 原编号 {{ item.key }}</p>
        <details><summary>目标组织标识</summary>{{ item.targetOrgId }}</details>
        <button class="button secondary" :disabled="busy || !targetChoices.some(org => org.id === item.targetOrgId)" @click="resumeTarget(item.targetOrgId)">选择原目标并恢复</button>
      </div>
    </section>
    <section v-if="pending || storageBlocked" class="notice stack" aria-label="平台业务原请求恢复">
      <h2>业务请求结果待确认</h2><p>{{ pending?.module === 'assessment' ? '考试操作' : '内容或安全操作' }}的原编号 {{ pending?.key || '元数据不可读取' }}。未确认前禁止新写入，切换页面不会取消已到达服务器的请求。</p>
      <details v-if="pending"><summary>原请求技术信息</summary>{{ pending.path }} · {{ pending.method }}</details>
      <p v-if="originalBody === undefined">刷新后仅保留原编号，不持久化题面、答案、学生内容、凭据或请求正文；未查到回执不代表提交失败。</p>
      <div class="actions"><button class="button secondary" :disabled="busy || !pending" @click="recover">按原编号查询真实回执</button><button v-if="originalBody !== undefined" class="button secondary" :disabled="busy" @click="replay">以原编号与内存原正文恢复</button></div>
      <div v-if="pending?.module === 'content' && pending.method === 'PUT' && /^\/admin\/files\/[^/]+\/content$/.test(pending.path) && originalBody === undefined" class="field">
        <label for="recover-upload-file">重新选择原上传文件</label><input id="recover-upload-file" type="file" :disabled="busy || pending.owner_revision === undefined" @change="selectUploadFile" />
        <p class="field-help">先查询原回执，仍未知时核验文件大小、MIME 与 SHA-256，之后仅沿原编号续传。</p>
      </div>
    </section>
    <div v-if="target && allowsOrganization(target)" class="business-domain" :inert="props.locked || undefined">
      <ContentWorkspace v-if="module === 'content' && canContent" ref="content" :key="`content:${target}:${epoch}`" :identity="displayIdentity" :request="request" platform console-presentation @dirty="dirty = $event" />
      <BusinessSafetyPage v-else-if="module === 'safety' && canSafety" :key="`safety:${target}:${epoch}`" :request="request" :capabilities="capabilities" :database-mode="context.database_mode" :locked="unknown || !!props.locked" @dirty="dirty = $event" @unknown="childUnknown = $event" />
      <AssessmentAdmin v-else-if="module === 'assessment' && canAssessment" :key="`assessment:${target}:${epoch}`" :identity="displayIdentity" :request="request" :recovery-scope="recoveryScope" console-presentation @dirty="dirty = $event" @unknown="childUnknown = $event" />
      <ReportsPage v-else-if="module === 'reports' && canReport" :key="`reports:${target}:${epoch}`" :target-org-id="target" :console-request="props.request" />
    </div>
    <p v-else-if="moduleAuthorized && !organizationError" class="admin-empty">选择目标组织后进入{{ moduleTitles[module] }}工作区。仅请求当前模块获授权的数据。</p>
  </section>
</template>

<style scoped>
.business-context .field { flex: 1; max-width: 28rem; min-width: 0; }
.business-context select { width: 100%; }
.business-context details { min-width: 0; }
.business-domain { min-width: 0; }
.business-domain :deep(.content-workspace.panel) { max-width: none; margin: 0; padding: 0; background: transparent; box-shadow: none; border: 0; }
.business-domain :deep(.page-heading) { display: none; }
.business-domain :deep(.content-section) { border: 1px solid var(--admin-border, #e4e7ec); border-radius: 8px; background: #fff; padding: 20px; }
.business-domain :deep(h3) { font-size: 16px; line-height: 24px; }
.business-domain :deep(.content-list) { padding: 0; margin: 0; list-style: none; border: 1px solid var(--admin-border, #e4e7ec); border-radius: 6px; overflow: hidden; }
.business-domain :deep(.content-list > li) { min-height: 48px; padding: 12px 16px; border-bottom: 1px solid var(--admin-border, #e4e7ec); background: #fff; }
.business-domain :deep(.content-list > li:last-child) { border-bottom: 0; }
.business-domain :deep(.content-empty) { padding: 32px 16px; border: 1px dashed var(--admin-border, #e4e7ec); background: #fff; }
.business-domain :deep(.content-toolbar), .business-domain :deep(.content-columns) { flex-wrap: wrap; }
.business-domain :deep(form) { min-width: 0; }
.business-domain :deep(.content-fields) { min-width: 0; border: 1px solid var(--admin-border, #e4e7ec); border-radius: 6px; padding: 16px; }
.business-domain :deep(.field-help), .business-domain :deep(details) { overflow-wrap: anywhere; }
@media (max-width: 640px) {
  .business-context .field { max-width: none; width: 100%; }
  .business-domain :deep(.content-section) { padding: 16px; }
  .business-domain :deep(.content-list > li) { flex-wrap: wrap; gap: 8px; }
}
</style>
