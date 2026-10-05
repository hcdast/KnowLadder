<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ApiError, type BusinessRequest } from "../session";
import type { Page } from "./types";
import { consoleStatusLabel } from "./presentation";
import ResourceTable from "./components/ResourceTable.vue";
import StatusBadge from "./components/StatusBadge.vue";
interface Metadata { id: string; title: string; status: string; revision: number; access_revision: number; access_revoked_at: string | null }
interface FileMetadata { id: string; display_name: string; owner_type: string; owner_version_id: string; owner_revision: number; status: string; scan_status: string; legal_hold: boolean; retention_until: string | null; deleted_at: string | null }
const props = defineProps<{ request: BusinessRequest; capabilities: string[]; databaseMode: string; locked: boolean; recoveryScope?: string }>();
const emit = defineEmits<{ dirty: [value: boolean]; unknown: [value: boolean] }>();
const kind = ref<"textbook" | "question">("textbook"), items = ref<Metadata[]>([]), cursor = ref<string | null>(null), selected = ref<Metadata>();
const resourceId = ref(""), fileId = ref(""), file = ref<FileMetadata>(), reason = ref(""), retention = ref(""), busy = ref(false), error = ref(""), message = ref("");
const actionError = ref(""), fileError = ref(""), detailError = ref(""), itemsLoaded = ref(false);
const life = new AbortController(); let alive = true, generation = 0;
const canRetire = computed(() => props.capabilities.includes("content:retire")), canRevoke = computed(() => props.capabilities.includes("content:revoke")), canDelete = computed(() => props.capabilities.includes("file:delete"));
const resourceRoute = computed(() => kind.value === "textbook" ? "textbook-editions" : "question-versions");
interface Recovery { path: string; key: string }
const pending = ref<Recovery>(), storageBlocked = ref(false); let originalBody: Record<string, unknown> | undefined;
const storageKey = `content-safety-recovery:${props.recoveryScope}`;
const locked = computed(() => props.locked || !!pending.value || storageBlocked.value);
watch(() => !!pending.value || storageBlocked.value, value => emit("unknown", value), { flush: "sync" });
function remember(value?: Recovery) { if (value) sessionStorage.setItem(storageKey, JSON.stringify({ path: value.path, key: value.key })); else sessionStorage.removeItem(storageKey); pending.value = value; }
async function send<T>(path: string, body: Record<string, unknown>): Promise<T> {
  if (!props.recoveryScope) return props.request<T>(path, { method: "POST", body, idempotencyKey: crypto.randomUUID(), signal: life.signal });
  if (pending.value || storageBlocked.value) throw new Error("原安全操作待确认，不能更换key重复提交。");
  const metadata = { path, key: crypto.randomUUID() }; originalBody = structuredClone(body);
  try { remember(metadata); } catch { originalBody = undefined; storageBlocked.value = true; throw new Error("无法保存原key安全元数据，未发送写入。"); }
  return replay<T>(true);
}
async function replay<T>(firstAttempt = false): Promise<T> {
  const metadata = pending.value; if (!metadata || !originalBody) throw new Error("仅保留原key，未保存原正文，请查询真实回执。");
  try { const value = await props.request<T>(metadata.path, { method: "POST", body: originalBody, idempotencyKey: metadata.key, signal: life.signal }); if (!alive) throw new DOMException("已离开安全工作区", "AbortError"); remember(); originalBody = undefined; return value; }
  catch (cause) { if (firstAttempt && cause instanceof ApiError && [400,404,409,413,422,429].includes(cause.status) && !["COMMIT_OUTCOME_UNKNOWN","IDEMPOTENCY_CONFLICT","IDEMPOTENCY_RESULT_INVALID"].includes(cause.code)) { remember(); originalBody = undefined; } throw cause; }
}
async function recover() {
  const metadata = pending.value; if (!metadata || busy.value) return; busy.value = true; error.value = ""; actionError.value = ""; fileError.value = ""; message.value = "";
  try { const result = await props.request<{ status: "resolved" | "unknown" }>(`/admin/content-requests?${new URLSearchParams({ key: metadata.key })}`, { signal: life.signal }); if (!alive) return; if (result.status === "resolved") { remember(); originalBody = undefined; selected.value = undefined; file.value = undefined; reason.value = ""; retention.value = ""; message.value = "已由真实原key回执确认，请重新读取当前资源。"; } else message.value = "原请求仍未知，资源状态不作为提交结果证明。"; } catch (cause) { fail(cause); } finally { if (alive) busy.value = false; }
}
async function replayPending() { if (busy.value) return; busy.value = true; error.value = ""; actionError.value = ""; fileError.value = ""; message.value = ""; try { await replay(); if (alive) { selected.value = undefined; file.value = undefined; reason.value = ""; retention.value = ""; message.value = "已以原编号和原正文确认，请重新读取资源。"; } } catch (cause) { fail(cause); } finally { if (alive) busy.value = false; } }
watch(() => !!reason.value || !!retention.value, value => emit("dirty", value));
function fail(cause: unknown, target = error) { if (alive && !(cause instanceof DOMException && cause.name === "AbortError")) target.value = cause instanceof Error ? cause.message : "安全操作未完成"; }
async function load(next = false) {
  if (busy.value || !(canRetire.value || canRevoke.value)) return; busy.value = true; error.value = "";
  const token = generation;
  try { const q = new URLSearchParams({ limit: "20" }); if (next && cursor.value) q.set("cursor", cursor.value); const page = await props.request<Page<Metadata>>(`/admin/${resourceRoute.value}?${q}`, { signal: life.signal }); if (alive && token === generation) { items.value = next ? [...items.value, ...page.items] : page.items; cursor.value = page.next_cursor; itemsLoaded.value = true; } } catch (cause) { fail(cause); } finally { if (alive) busy.value = false; }
}
let confirmedKind: "textbook" | "question" = "textbook";
async function changeKind() { if (reason.value && !window.confirm("放弃未提交的安全操作理由？")) { kind.value = confirmedKind; return; } confirmedKind = kind.value; generation++; items.value = []; selected.value = undefined; cursor.value = null; reason.value = ""; itemsLoaded.value = false; actionError.value = ""; message.value = ""; await load(); }
async function open(id: string) {
  if (!id.trim() || busy.value || !(canRetire.value || canRevoke.value)) return; busy.value = true; detailError.value = ""; actionError.value = ""; message.value = ""; const token = ++generation; selected.value = undefined;
  try { const value = await props.request<Metadata>(`/admin/${resourceRoute.value}/${encodeURIComponent(id)}`, { signal: life.signal }); if (alive && token === generation) selected.value = value; } catch (cause) { fail(cause, detailError); } finally { if (alive) busy.value = false; }
}
async function stop(action: "retire" | "revoke-access") {
  const value = selected.value; if (!value || busy.value || locked.value) return;
  if (action === "revoke-access" && props.databaseMode !== "replicaSet") return;
  if (!window.confirm(`${action === "retire" ? "退役后停止新的使用" : "撤销授权后原文不可再读取"}：${value.title} (${value.id})？不会跳过安全账本、保全和引用检查。`)) return;
  busy.value = true; actionError.value = ""; message.value = "";
  try { const result = await send<Metadata>(`/admin/${resourceRoute.value}/${value.id}/${action}`, { ...(action === "retire" ? { expected_revision: value.revision } : { expected_access_revision: value.access_revision }), reason: reason.value }); if (alive) { selected.value = result; reason.value = ""; message.value = "已收到安全操作回执，请读取当前版本状态。"; } } catch (cause) { fail(cause, actionError); } finally { if (alive) busy.value = false; }
}
async function loadFile() {
  if (!fileId.value || busy.value || !canDelete.value) return; busy.value = true; fileError.value = ""; message.value = ""; file.value = undefined;
  try { const value = await props.request<FileMetadata>(`/admin/files/${encodeURIComponent(fileId.value)}`, { signal: life.signal }); if (alive) file.value = value; } catch (cause) { fail(cause, fileError); } finally { if (alive) busy.value = false; }
}
async function deleteFile() {
  const value = file.value; if (!value || busy.value || locked.value || props.databaseMode !== "replicaSet") return;
  if (!window.confirm(`安排文件 ${value.display_name} (${value.id}) 留存到期清理？本操作不等于已经完成物理删除，保全/引用/扫描仍由服务端检查。`)) return;
  busy.value = true; fileError.value = ""; message.value = "";
  try { const result = await send<FileMetadata>(`/admin/files/${value.id}/schedule-deletion`, { expected_owner_revision: value.owner_revision, retention_until: new Date(retention.value).toISOString(), reason: reason.value }); if (alive) { file.value = result; reason.value = ""; retention.value = ""; message.value = "已安排留存到期清理，尚未证明物理删除完成。"; } } catch (cause) { fail(cause, fileError); } finally { if (alive) busy.value = false; }
}
function beforeUnload(event: BeforeUnloadEvent) { if (pending.value || storageBlocked.value || reason.value || retention.value) { event.preventDefault(); event.returnValue = ""; } }
onMounted(() => { if (props.recoveryScope) { try { const raw = sessionStorage.getItem(storageKey); if (raw) { const value = JSON.parse(raw) as Recovery; if (!value.key || !/^\/admin\/(textbook-editions|question-versions|files)\/[^/]+\/(retire|revoke-access|schedule-deletion)$/.test(value.path)) throw new Error("恢复元数据无效"); remember({ path: value.path, key: value.key }); } } catch { storageBlocked.value = true; error.value = "无法读取原安全请求元数据，写入已冻结。"; } } window.addEventListener("beforeunload", beforeUnload); void load(); });
onBeforeUnmount(() => { alive = false; generation++; life.abort(); originalBody = undefined; selected.value = undefined; file.value = undefined; window.removeEventListener("beforeunload", beforeUnload); emit("dirty", false); emit("unknown", false); });
</script>
<template>
  <section class="admin-page safety-page">
    <header class="stack"><h2>资源安全工作区</h2><p class="admin-meta">只读必要元数据；退役、授权撤销和文件清理分别受独立能力约束，不读取题面、答案、章节或私有文件正文。</p></header>
    <p v-if="databaseMode === 'standalone'" class="notice">当前数据库不支持副本集安全账本：授权撤销与文件清理不可用。获授权的元数据读取、资源退役仍可执行。</p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="busy" role="status">正在读取或处理安全操作…</p>
    <section v-if="pending || storageBlocked" class="notice stack" aria-label="原安全请求恢复">
      <h2>安全请求结果待确认</h2><p>原编号 {{ pending?.key || '元数据不可读取' }}。未确认前冻结新写入，不持久化正文、答案或密码。</p>
      <details v-if="pending"><summary>原请求路径</summary>{{ pending.path }}</details>
      <p>未查到回执不等于提交失败，资源状态变化也不能证明原请求结果。</p>
      <div class="actions"><button class="button secondary" :disabled="busy || !pending" @click="recover">按原编号查询回执</button><button v-if="originalBody" class="button secondary" :disabled="busy" @click="replayPending">以原编号与内存原正文恢复</button></div>
    </section>
    <section v-if="canRetire || canRevoke" class="admin-card stack">
      <div class="admin-toolbar">
        <div class="field"><label for="safety-kind">资源类型</label><select id="safety-kind" v-model="kind" :disabled="busy" @change="changeKind"><option value="textbook">教材版本</option><option value="question">题目版本</option></select></div>
        <button class="button secondary" :disabled="busy" @click="load()">刷新元数据</button>
      </div>
      <div v-if="error" class="notice" role="alert"><p>资源读取或恢复未完成：{{ error }}</p><button class="button secondary" :disabled="busy" @click="load()">重试资源读取</button></div>
      <ResourceTable :headers="['资源名称', '状态', '授权', '操作']" :busy="busy" :empty="itemsLoaded && !items.length && !error" empty-label="当前可见范围没有资源元数据。">
        <tr v-for="item in items" :key="item.id">
          <td><button class="text-button" :disabled="busy" @click="open(item.id)">{{ item.title }}</button></td>
          <td><StatusBadge :status="item.status" /></td><td>{{ item.access_revoked_at ? '已撤销' : '未撤销' }}</td>
          <td><button class="button secondary" :disabled="busy" @click="open(item.id)">查看详情</button></td>
        </tr>
      </ResourceTable>
      <button v-if="cursor" class="button secondary" :disabled="busy" @click="load(true)">加载更多资源</button>
      <details class="admin-meta"><summary>按明确版本编号定位</summary>
        <form class="admin-toolbar" @submit.prevent="open(resourceId)"><div class="field"><label for="safety-resource-id">版本 ID</label><input id="safety-resource-id" v-model="resourceId" required /></div><button class="button secondary" :disabled="busy">读取元数据</button></form>
      </details>
      <p v-if="detailError" class="notice" role="alert">{{ detailError }}。可重新选择资源重试。</p>
    </section>
    <section v-if="selected" class="admin-card stack" aria-label="资源安全详情">
      <div class="admin-toolbar"><h2>{{ selected.title }}</h2><StatusBadge :status="selected.status" /></div>
      <dl class="safety-facts"><div><dt>授权状态</dt><dd>{{ selected.access_revoked_at ? '已撤销' : '未撤销' }}</dd></div><div><dt>撤销时间</dt><dd>{{ selected.access_revoked_at || '未撤销' }}</dd></div></dl>
      <details class="admin-meta"><summary>资源技术信息</summary><p>版本 {{ selected.id }} · 修订 {{ selected.revision }} · 授权修订 {{ selected.access_revision }}</p></details>
      <div class="admin-danger stack">
        <h3>处置影响</h3><p v-if="canRetire">退役停止新的使用，不等同于撤销原文授权。仅已发布版本可退役。</p>
        <p v-if="canRevoke">撤销授权将阻断原文后续读取；保全、引用与安全账本仍由服务端检查。{{ databaseMode !== 'replicaSet' ? '当前数据库模式不支持此操作。' : '' }}</p>
        <div class="field"><label for="safety-resource-reason">操作理由</label><textarea id="safety-resource-reason" v-model="reason" :disabled="busy || locked" /></div>
        <p v-if="actionError" class="notice" role="alert">{{ actionError }}</p>
        <div class="actions"><button v-if="canRetire" class="button secondary" :disabled="busy || locked || !reason.trim() || selected.status !== 'published'" @click="stop('retire')">退役资源</button><button v-if="canRevoke" class="button secondary" :disabled="busy || locked || databaseMode !== 'replicaSet' || !reason.trim() || !!selected.access_revoked_at" @click="stop('revoke-access')">撤销原文授权</button></div>
      </div>
    </section>
    <section v-if="canDelete" class="admin-card stack" aria-label="文件安全处置">
      <h2>私有文件留存清理</h2><p class="field-help">仅定位明确文件并读取元数据，不读取文件正文。安排清理不代表已物理删除。</p>
      <form class="admin-toolbar" @submit.prevent="loadFile"><div class="field"><label for="safety-file-id">文件 ID</label><input id="safety-file-id" v-model="fileId" required /></div><button class="button secondary" :disabled="busy">读取文件元数据</button></form>
      <p v-if="fileError" class="notice" role="alert">{{ fileError }}。读取失败时可使用上方按钮重试；未知写入须按原编号恢复。</p>
      <section v-if="file" class="stack">
        <div class="admin-toolbar"><h3>{{ file.display_name }}</h3><StatusBadge :status="file.status" /></div>
        <dl class="safety-facts"><div><dt>扫描状态</dt><dd>{{ file.scan_status === 'pending' ? '待扫描' : consoleStatusLabel(file.scan_status) }}</dd></div><div><dt>法律保全</dt><dd>{{ file.legal_hold ? '保全中，不能清理' : '未保全' }}</dd></div><div><dt>留存截止</dt><dd>{{ file.retention_until || '未安排' }}</dd></div></dl>
        <details class="admin-meta"><summary>文件技术信息</summary><p>文件 {{ file.id }} · 归属 {{ file.owner_type }} {{ file.owner_version_id }} · 归属修订 {{ file.owner_revision }}</p></details>
        <form class="admin-danger stack" @submit.prevent="deleteFile">
          <h3>安排到期清理</h3><p>只登记留存安排，实际删除仍受保全、引用和扫描检查约束。{{ databaseMode !== 'replicaSet' ? '当前数据库模式不支持此操作。' : '' }}</p>
          <div class="field"><label for="safety-file-reason">操作理由</label><textarea id="safety-file-reason" v-model="reason" :disabled="busy || locked" /></div>
          <div class="field"><label for="safety-retention">留存截止时间</label><input id="safety-retention" v-model="retention" type="datetime-local" required :disabled="busy || databaseMode !== 'replicaSet' || locked" /></div>
          <button class="button secondary" :disabled="busy || locked || databaseMode !== 'replicaSet' || !reason.trim() || file.legal_hold || !!file.deleted_at">安排留存到期清理</button>
        </form>
      </section>
      <p v-else-if="!busy && !fileError" class="admin-empty">输入明确文件编号后查看元数据与留存状态。</p>
    </section>
    <p v-if="error && !(canRetire || canRevoke)" class="notice" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.safety-facts { display: flex; flex-wrap: wrap; gap: 16px 32px; margin: 0; }
.safety-facts dt { color: #667085; }
.safety-facts dd { margin: 4px 0 0; overflow-wrap: anywhere; }
.safety-page h2 { margin: 0; font-size: 16px; line-height: 24px; }
.safety-page h3 { margin: 0; font-size: 14px; line-height: 22px; }
.safety-page details { overflow-wrap: anywhere; }
</style>
