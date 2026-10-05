<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { ApiError, type BusinessRequest, type Identity } from "../session";
const props = defineProps<{
  identity: Identity;
  request: BusinessRequest;
  taskId: string;
  revision: number;
  selected: string[];
  disabled: boolean;
}>();
const emit = defineEmits<{
  selection: [string[]];
  revision: [number];
  unknown: [boolean];
}>();
type RecordFile = {
  id: string;
  display_name: string;
  size: number;
  checksum: string;
  status: string;
  scan_status: string;
  owner_revision?: number;
  upload_confirmed: boolean;
  upload_in_progress: boolean;
};
type Pending = {
  key: string;
  id: string | null;
  declaration: {
    expected_revision: number;
    display_name: string;
    size: number;
    mime: string;
    checksum: string;
  };
};
const uploadEnabled = ref(false);
const records = ref<RecordFile[]>([]),
  busy = ref(false),
  message = ref(""),
  pending = ref<Pending | null>(null),
  storageBlocked = ref(false);
const lifetime = new AbortController();
const scope =
  "kl-work-files:" +
  props.identity.user.id +
  ":" +
  props.identity.context?.org_id +
  ":" +
  props.taskId;
let localFile: File | undefined;
function persist() {
  try {
    if (pending.value)
      sessionStorage.setItem(scope, JSON.stringify(pending.value));
    else sessionStorage.removeItem(scope);
  } catch {
    storageBlocked.value = true;
    message.value = "恢复记录无法保存，未发送新请求。";
  }
  emit("unknown", !!pending.value || storageBlocked.value);
}
try {
  const raw = JSON.parse(sessionStorage.getItem(scope) || "null");
  if (raw) {
    const d = raw.declaration;
    if (
      Object.keys(raw).some((k) => !["key", "id", "declaration"].includes(k)) ||
      typeof raw.key !== "string" ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(raw.key) ||
      (raw.id !== null && !/^[0-9a-f]{24}$/.test(raw.id)) ||
      !d ||
      Object.keys(d).some(
        (k) =>
          ![
            "expected_revision",
            "display_name",
            "size",
            "mime",
            "checksum",
          ].includes(k),
      ) ||
      !Number.isSafeInteger(d.expected_revision) ||
      d.expected_revision < 1 ||
      typeof d.display_name !== "string" ||
      d.display_name.length > 200 ||
      typeof d.mime !== "string" ||
      !Number.isSafeInteger(d.size) ||
      d.size < 1 ||
      d.size > 10485760 ||
      typeof d.checksum !== "string" ||
      !/^[a-f0-9]{64}$/.test(d.checksum)
    )
      throw Error();
    pending.value = raw;
  }
} catch {
  storageBlocked.value = true;
  message.value = "恢复元数据无效，附件写入冻结。";
}
persist();
async function request<T>(path: string, options: any = {}) {
  return props.request<T>(path, { ...options, signal: lifetime.signal });
}
function error(e: unknown) {
  message.value = e instanceof Error ? e.message : "附件请求失败";
  if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
    records.value = [];
    localFile = undefined;
  }
  persist();
}
async function load() {
  if (busy.value) return;
  busy.value = true;
  try {
    const data = await request<{ items: RecordFile[]; owner_revision: number; upload_enabled: boolean }>(
      "/training/tasks/" + props.taskId + "/files",
    );
    records.value = data.items;
    uploadEnabled.value = data.upload_enabled;
    emit("revision", data.owner_revision);
    if (pending.value?.id) {
      const current = await request<RecordFile>(
        "/training/coursework-files/" + pending.value.id,
      );
      if (current.upload_confirmed) {
        pending.value = null;
        localFile = undefined;
        persist();
        message.value = "原附件传输已确认；仍需等待扫描。";
      }
    }
  } catch (e) {
    error(e);
  } finally {
    busy.value = false;
  }
}
async function select(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || busy.value || props.disabled || storageBlocked.value) return;
  busy.value = true;
  try {
    if (file.size < 1 || file.size > 10485760)
      throw Error("请选择非空且不超过10MiB的文件");
    const mime = file.type || (/\.txt$/i.test(file.name) ? "text/plain" : "");
    if (
      ![
        "application/pdf",
        "image/png",
        "image/jpeg",
        "text/plain",
        "video/mp4",
        "audio/mpeg",
      ].includes(mime)
    )
      throw Error("文件类型不支持");
    const checksum = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
      ),
      (v) => v.toString(16).padStart(2, "0"),
    ).join("");
    if (
      pending.value &&
      (pending.value.declaration.display_name !== file.name ||
        pending.value.declaration.size !== file.size ||
        pending.value.declaration.mime !== mime ||
        pending.value.declaration.checksum !== checksum)
    )
      throw Error("请重新选择与原登记名称、大小、类型和校验和一致的文件");
    localFile = file;
    if (!pending.value)
      pending.value = {
        key: crypto.randomUUID(),
        id: null,
        declaration: {
          expected_revision: props.revision,
          display_name: file.name,
          size: file.size,
          mime,
          checksum,
        },
      };
    persist();
  } catch (e) {
    error(e);
  } finally {
    busy.value = false;
  }
  if (localFile && pending.value && !storageBlocked.value) await resume();
}
async function resume() {
  if (
    busy.value ||
    props.disabled ||
    storageBlocked.value ||
    !pending.value ||
    !localFile
  )
    return;
  busy.value = true;
  try {
    const operation = pending.value;
    if (!operation.id) {
      const row = await request<RecordFile>(
        "/training/tasks/" + props.taskId + "/files",
        {
          method: "POST",
          idempotencyKey: operation.key,
          body: operation.declaration,
        },
      );
      operation.id = row.id;
      pending.value = { ...operation };
      persist();
      if (storageBlocked.value) return;
      emit("revision", row.owner_revision!);
    }
    const row = await request<RecordFile>(
      "/training/coursework-files/" + operation.id,
    );
    if (row.upload_confirmed) {
      pending.value = null;
      localFile = undefined;
      persist();
      message.value = "原上传已确认，等待真实扫描。";
      return;
    }
    if (row.upload_in_progress) {
      message.value = "原上传仍在处理，请稍后查询；保留原编号。";
      return;
    }
    if (row.status !== "pending") throw Error("文件状态不能上传，请查询原记录");
    await request("/training/coursework-files/" + row.id + "/content", {
      method: "PUT",
      idempotencyKey: "upload_" + row.id,
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Owner-Revision": String(row.owner_revision),
      },
      body: localFile,
    });
    pending.value = null;
    localFile = undefined;
    persist();
    message.value = "已传输至隔离区，等待扫描，尚不能提交。";
  } catch (e) {
    error(e);
  } finally {
    busy.value = false;
  }
  await load();
}
function choose(row: RecordFile) {
  if (
    props.disabled ||
    pending.value ||
    storageBlocked.value ||
    busy.value ||
    row.status !== "ready" ||
    row.scan_status !== "clean"
  )
    return;
  if (props.selected.includes(row.id))
    emit(
      "selection",
      props.selected.filter((id) => id !== row.id),
    );
  else if (props.selected.length < 5)
    emit("selection", [...props.selected, row.id]);
  else message.value = "最多选择5个附件";
}
async function download(row: RecordFile) {
  busy.value = true;
  try {
    const blob = await request<Blob>(
      "/training/coursework-files/" + row.id + "/content",
      { responseType: "blob" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = row.display_name;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    error(e);
  } finally {
    busy.value = false;
  }
}
function unload(e: BeforeUnloadEvent) {
  if (pending.value || storageBlocked.value) {
    e.preventDefault();
    e.returnValue = "";
  }
}
onMounted(() => {
  void load();
  window.addEventListener("beforeunload", unload);
});
onBeforeUnmount(() => {
  lifetime.abort();
  localFile = undefined;
  records.value = [];
  window.removeEventListener("beforeunload", unload);
  emit("unknown", false);
});
</script>
<template>
  <section aria-label="作业附件" class="lesson">
    <h4>作业附件 · 最多5个</h4>
    <p v-if="!uploadEnabled" class="field-help">新附件上传暂不可用：扫描未开启或状态未确认。已有附件仍需重新授权。</p>
    <p class="field-help">
      只提交扫描通过的附件；正文仍需填写。先选择附件，再保存或提交作业。
    </p>
    <p role="status">{{ message }}</p>
    <p v-if="pending">
      原附件请求待确认。{{
        pending.declaration.display_name
      }}：刷新后请重新选择原文件，沿原编号恢复。
    </p>
    <label
      >选择文件<input
        type="file"
        :disabled="busy || disabled || storageBlocked || !uploadEnabled"
        @change="select"
    /></label>
    <button
      type="button"
      class="button secondary"
      :disabled="busy"
      @click="load"
    >
      刷新附件与原传输状态
    </button>
    <button
      v-if="pending"
      type="button"
      class="button"
      :disabled="busy || disabled || storageBlocked"
      @click="resume"
    >
      恢复原附件上传
    </button>
    <ul>
      <li v-for="file in records" :key="file.id">
        {{ file.display_name }} · {{ file.size }}字节 ·
        {{
          file.status === "ready" && file.scan_status === "clean"
            ? "扫描通过"
            : file.scan_status === "infected"
              ? "感染，禁止使用"
              : file.scan_status === "failed"
                ? "扫描失败，禁止使用"
                : "待上传或扫描"
        }}
        <button
          type="button"
          :disabled="
            disabled ||
            busy ||
            !!pending ||
            storageBlocked ||
            file.status !== 'ready' ||
            file.scan_status !== 'clean'
          "
          @click="choose(file)"
        >
          {{ selected.includes(file.id) ? "移出本次作业" : "加入本次作业" }}
        </button>
        <button
          v-if="file.status === 'ready' && file.scan_status === 'clean'"
          type="button"
          :disabled="busy"
          @click="download(file)"
        >
          下载附件
        </button>
      </li>
    </ul>
    <p v-if="!records.length">暂无作业附件。</p>
  </section>
</template>
