<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { ApiError, type BusinessRequest } from "../session";
import type { FileRecord, Kind, Page } from "./types";
const props = defineProps<{ request: BusinessRequest; kind: Kind; ownerId: string; revision: number; disabled: boolean; editable: boolean; canDelete: boolean; boundIds: string[]; localIds: string[] }>();
const emit = defineEmits<{ revision: [value: number]; ready: [file: FileRecord]; error: [cause: unknown]; recovered: [cause: unknown] }>();
const busy = ref(false);
const message = ref("");
const records = ref<FileRecord[]>([]);
const cursor = ref<string | null>(null);
const recovery = ref<FileRecord>();
const pending = ref(false);
const deletionFile = ref<FileRecord>();
const deletionReason = ref("");
const retention = ref("");
const lifetime = new AbortController();
let alive = true;
let localFile: File | undefined;
let registration: Record<string, unknown> | undefined;
let registrationKey = "";
let expectedOwnerRevision = 0;
let currentRecord: FileRecord | undefined;
let uploadError: ApiError | undefined;
const deletionKeys = new Map<string, string>();
onBeforeUnmount(() => { alive = false; lifetime.abort(); localFile = undefined; registration = undefined; records.value = []; });
onMounted(() => { void load(false); });
function fail(error: unknown) {
  if (!alive) return;
  message.value = `${error instanceof Error ? error.message : "请求未完成"}。未知结果不会视为回滚，请查询或恢复原请求。`;
  if (error instanceof ApiError) emit("error", error);
}
function upsert(record: FileRecord) {
  const index = records.value.findIndex(item => item.id === record.id);
  if (index < 0) records.value.unshift(record); else records.value[index] = record;
}
async function load(next = false) {
  if (busy.value) return;
  busy.value = true;
  try {
    const query = new URLSearchParams({ owner_type: props.kind, owner_version_id: props.ownerId, limit: "50" });
    if (next && cursor.value) query.set("cursor", cursor.value);
    const result = await props.request<Page<FileRecord> & { owner_revision: number }>(`/admin/files?${query}`, { signal: lifetime.signal });
    if (!alive) return;
    records.value = next ? [...records.value, ...result.items] : result.items; cursor.value = result.next_cursor;
    // Do not adopt a remotely changed revision: the parent may hold an unsaved draft.
  } catch (error) { fail(error); }
  finally { if (alive) busy.value = false; }
}
async function check(record: FileRecord) {
  if (busy.value) return;
  busy.value = true;
  try {
    const result = await props.request<FileRecord>(`/admin/files/${record.id}`, { signal: lifetime.signal });
    if (!alive) return;
    upsert(result);
    message.value = `文件状态：${label(result)}。扫描通过仅表示可绑定，绑定后仍须保存草稿。`;
  } catch (error) { fail(error); }
  finally { if (alive) busy.value = false; }
}
function label(file: FileRecord) {
  if (file.deleted_at) return "已清理（审计墓碑保留）";
  if (file.status === "deleting") return "正在清理，不可使用";
  if (file.status === "ready" && file.scan_status === "clean") return props.boundIds.includes(file.id) ? "已绑定" : props.localIds.includes(file.id) ? "已加入本地草稿，尚未保存绑定" : "可绑定（尚未保存到正文）";
  if (file.scan_status === "failed" || file.scan_status === "infected") return `不可绑定：${file.error_code || file.scan_status}`;
  if (file.upload_in_progress) return "传输中（上传租约有效，请等待后查询）";
  if (file.status === "pending") return "已登记，等待传输或恢复";
  return `扫描中：${file.scan_status}`;
}
function chooseRecovery(file: FileRecord) {
  recovery.value = file; message.value = `请重新选择 ${file.display_name}；名称、大小及 SHA-256 必须一致。`;
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0]; input.value = "";
  if (!file || busy.value || props.disabled || pending.value) return;
  if (!file.size || file.size > 10 * 1024 * 1024) { message.value = "请选择非空且不超过 10 MiB 的文件。"; return; }
  const mime = file.type || (/\.txt$/i.test(file.name) ? "text/plain" : "");
  if (!["application/pdf", "image/png", "image/jpeg", "text/plain", "video/mp4", "audio/mpeg"].includes(mime)) { message.value = "支持 PDF、PNG、JPEG、UTF-8 文本；启用培训扩展后支持 MP4 与 MP3。"; return; }
  busy.value = true;
  try {
    message.value = "正在核对 SHA-256…";
    const checksum = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("");
    if (!alive) return;
    if (recovery.value && (recovery.value.display_name !== file.name || recovery.value.size !== file.size || recovery.value.checksum !== checksum)) { message.value = "文件与登记声明不符，请选择原始文件。"; return; }
    localFile = file; currentRecord = recovery.value; registrationKey = crypto.randomUUID(); expectedOwnerRevision = props.revision;
    registration = { owner_type: props.kind, owner_version_id: props.ownerId, expected_revision: props.revision, display_name: file.name, size: file.size, mime, checksum };
    pending.value = true;
  } catch (error) { fail(error); }
  finally { if (alive) busy.value = false; }
  if (pending.value && alive) await resume();
}
async function resume() {
  if (busy.value || props.disabled || !pending.value || !localFile || !registration) return;
  busy.value = true;
  try {
    if (!currentRecord) {
      message.value = "正在登记（恢复时沿用原幂等键与原声明）…";
      currentRecord = await props.request<FileRecord>("/admin/files", { method: "POST", signal: lifetime.signal, idempotencyKey: registrationKey, body: registration });
      if (!alive) return;
      if (currentRecord.owner_revision !== undefined) { expectedOwnerRevision = currentRecord.owner_revision; emit("revision", currentRecord.owner_revision); }
    }
    const latest = await props.request<FileRecord>(`/admin/files/${currentRecord.id}`, { signal: lifetime.signal });
    if (!alive) return;
    currentRecord = latest; upsert(latest);
    if (latest.status === "pending") {
      if (latest.upload_in_progress) { message.value = "原上传仍在处理，已保留原文件与幂等键。请等待后查询并恢复，勿重复传输。"; return; }
      if (latest.owner_revision !== expectedOwnerRevision) throw new ApiError(409, "归属版本修订已改变。本地草稿保留，请重新加载版本后从附件列表恢复。");
      message.value = "正在传输完整文件，请勿关闭页面…";
      const uploaded = await props.request<FileRecord>(`/admin/files/${latest.id}/content`, { method: "PUT", signal: lifetime.signal, idempotencyKey: `upload_${latest.id}`, headers: { "Content-Type": "application/octet-stream", "X-Owner-Revision": String(expectedOwnerRevision) }, body: localFile });
      if (!alive) return;
      currentRecord = { ...latest, ...uploaded }; upsert(currentRecord);
      if (uploaded.owner_revision !== undefined) emit("revision", uploaded.owner_revision);
    }
    if (latest.status !== "pending" && latest.owner_revision !== undefined && latest.owner_revision !== expectedOwnerRevision) throw new ApiError(409, "文件已送达，但版本修订已更新。请保留草稿并重新加载以恢复附件状态。");
    pending.value = false; recovery.value = undefined; localFile = undefined; registration = undefined;
    message.value = `文件状态：${label(currentRecord)}。扫描通过仅表示可绑定，绑定后仍须保存草稿。`;
    if (uploadError !== undefined) { emit("recovered", uploadError); uploadError = undefined; }
  } catch (error) { if (error instanceof ApiError) uploadError = error; fail(error); }
  finally { if (alive) busy.value = false; }
}
async function preview(file: FileRecord) {
  try {
    const blob = await props.request<Blob>(`/admin/files/${file.id}/content`, { responseType: "blob", signal: lifetime.signal });
    if (!alive) return;
    const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = file.display_name || `附件-${file.id}`; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { fail(error); }
}
async function scheduleDeletion() {
  if (!deletionFile.value || busy.value || props.disabled || !deletionReason.value.trim() || !retention.value) return;
  if (!window.confirm("到期清理不可恢复；服务端将再次检查引用、保全及权限。确认申请清理此文件？")) return;
  busy.value = true;
  try {
    const body = { expected_owner_revision: props.revision, retention_until: new Date(retention.value).toISOString(), reason: deletionReason.value.trim() };
    const path = `/admin/files/${deletionFile.value.id}/schedule-deletion`;
    const fingerprint = JSON.stringify([path, body]); const key = deletionKeys.get(fingerprint) || crypto.randomUUID(); deletionKeys.set(fingerprint, key);
    const result = await props.request<FileRecord>(path, { method: "POST", body, idempotencyKey: key, signal: lifetime.signal });
    if (!alive) return;
    deletionKeys.delete(fingerprint); upsert(result); if (result.owner_revision !== undefined) emit("revision", result.owner_revision);
    deletionFile.value = undefined; deletionReason.value = ""; retention.value = ""; message.value = "已安排留存到期清理；尚未证明物理删除完成。";
  } catch (error) { fail(error); }
  finally { if (alive) busy.value = false; }
}
</script>
<template>
  <section class="content-section stack" aria-label="私有文件上传与恢复" :aria-busy="busy">
    <h3>归属版本附件与恢复</h3>
    <div v-if="editable" class="field"><label for="private-upload">{{ recovery ? '重新选择原始文件以恢复传输' : '上传私有附件' }}</label><input id="private-upload" type="file" accept=".pdf,.png,.jpg,.jpeg,.txt" :disabled="disabled || busy || pending" @change="upload" /><p class="field-help">最多 10 MiB。先保存草稿再上传。刷新后从服务端恢复未绑定文件，不保存敏感内容到浏览器存储。</p></div>
    <p v-if="message" role="status">{{ message }}</p>
    <button v-if="pending" type="button" class="button secondary" :disabled="busy || disabled" @click="resume">查询并恢复原上传请求（固定幂等键）</button>
    <button type="button" class="button secondary" :disabled="busy" @click="load(false)">刷新附件状态</button>
    <p v-if="!records.length && !busy" class="field-help">尚无已登记文件。选择本地文件开始上传。</p>
    <ul class="content-list"><li v-for="file in records" :key="file.id"><div><strong>{{ file.display_name || file.id }}</strong><p class="field-help">{{ file.id }} · {{ label(file) }}</p><p v-if="file.retention_until" class="field-help">留存至 {{ file.retention_until }}</p></div><div class="actions">
      <button type="button" class="button secondary" :disabled="busy" @click="check(file)">查询状态</button>
      <button v-if="file.status === 'ready' && file.scan_status === 'clean'" type="button" class="button secondary" :disabled="busy" @click="preview(file)">管理附件预览（下载）</button>
      <button v-if="editable && file.status === 'ready' && file.scan_status === 'clean' && !localIds.includes(file.id)" type="button" class="button secondary" :disabled="disabled || busy" @click="emit('ready', file)">加入本地附件（需保存）</button>
      <button v-if="editable && file.status === 'pending' && !file.upload_in_progress" type="button" class="button secondary" :disabled="disabled || busy || pending" @click="chooseRecovery(file)">恢复此文件传输</button>
      <button v-if="canDelete && !boundIds.includes(file.id) && !localIds.includes(file.id) && !file.legal_hold && file.status !== 'deleting'" type="button" class="button secondary" :disabled="disabled || busy" @click="deletionFile = file">申请到期清理</button>
    </div></li></ul>
    <button v-if="cursor" type="button" class="button secondary" :disabled="busy" @click="load(true)">加载更多附件</button>
    <form v-if="deletionFile" class="stack" @submit.prevent="scheduleDeletion"><h4>清理 {{ deletionFile.display_name }}</h4><p>仅限未引用且无合法保全的文件；物理清理不可恢复，元数据及审计仍保留。</p><div class="field"><label for="file-retention">留存截止时间（本地时间）</label><input id="file-retention" v-model="retention" type="datetime-local" required /></div><div class="field"><label for="file-delete-reason">清理原因</label><textarea id="file-delete-reason" v-model="deletionReason" required maxlength="1000" /></div><div class="actions"><button class="button" :disabled="busy || disabled">确认申请清理</button><button type="button" class="button secondary" :disabled="busy" @click="deletionFile = undefined">取消</button></div></form>
  </section>
</template>
