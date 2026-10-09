<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onBeforeUnmount,
  ref,
  watch,
} from "vue";
import { ApiError, type BusinessRequest } from "../session";
import type { Version, FileRecord, Page } from "./types";
type Job = {
  id: string;
  status: string;
  revision: number;
  error_code: string;
  expires_at: string;
  preview?: { ordinal: number; page: number | null; text: string }[];
  warnings?: string[];
};
type Entry = {
  client_key: string;
  title: string;
  body: string;
  knowledge_point_ids: string[];
  original: string;
};
type Pending = { path: string; key: string; hash: string; body?: unknown };
const props = defineProps<{
  request: BusinessRequest;
  version: Version;
  scope: string;
  blocked: boolean;
}>();
const emit = defineEmits<{ dirty: [boolean]; applied: [] }>();
const files = ref<FileRecord[]>([]),
  jobs = ref<Job[]>([]),
  job = ref<Job>(),
  entries = ref<Entry[]>([]),
  fileId = ref("");
const busy = ref(false),
  message = ref(""),
  available = ref(false),
  confirmed = ref(false),
  pending = ref<Pending>();
const source = ref(""),
  rights = ref("original"),
  proof = ref(""),
  expires = ref(""),
  restrictions = ref(""),
  granted = ref(false);
const notice = ref<HTMLElement>();
const lifetime = new AbortController();
let alive = true,
  timer = 0;
const base = computed(
  () => "/admin/textbook-editions/" + props.version.id + "/imports",
);
const storage = computed(
  () => "kl-import:" + props.scope + ":" + props.version.id,
);
const labels: Record<string, string> = {
  queued: "等待提取",
  running: "正在提取",
  "preview-ready": "待核对章节",
  failed: "提取失败",
  cancelled: "已取消",
  applied: "已应用到草稿",
};
const editing = computed(() => entries.value.length > 0 || !!pending.value);
watch(editing, (v) => emit("dirty", v));
watch(message, async () => {
  await nextTick();
  if (alive) notice.value?.focus();
});
watch(
  [entries, source, rights, proof, expires, restrictions, granted],
  () => {
    confirmed.value = false;
  },
  { deep: true },
);
function clearText() {
  entries.value = [];
  if (job.value) job.value = { ...job.value, preview: [], warnings: [] };
  source.value = "";
  proof.value = "";
  restrictions.value = "";
  confirmed.value = false;
  granted.value = false;
}
function fail(e: unknown) {
  clearText();
  message.value =
    (e instanceof Error ? e.message : "请求未完成") +
    (pending.value ? "；结果未知，请查询原编号，勿新建请求。" : "");
  if (e instanceof ApiError && [401, 403, 404, 409, 503].includes(e.status))
    available.value = false;
}
function persist() {
  try {
    if (pending.value) {
      const { path, key, hash } = pending.value;
      sessionStorage.setItem(
        storage.value,
        JSON.stringify({ path, key, hash }),
      );
    } else sessionStorage.removeItem(storage.value);
  } catch {
    message.value = "浏览器不允许保存请求编号，请保留当前页面恢复。";
  }
}
async function run(work: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  try {
    await work();
  } catch (e) {
    fail(e);
  } finally {
    if (alive) busy.value = false;
  }
}
async function load() {
  await run(async () => {
    const result = await props.request<{ items: Job[]; truncated: boolean }>(
      base.value,
      { signal: lifetime.signal },
    );
    if (!alive) return;
    jobs.value = result.items;
    available.value = true;
    const f = await props.request<Page<FileRecord>>(
      "/admin/files?" +
        new URLSearchParams({
          owner_type: "textbook",
          owner_version_id: props.version.id,
          limit: "50",
        }),
      { signal: lifetime.signal },
    );
    if (!alive) return;
    files.value = f.items.filter(
      (x) =>
        x.status === "ready" &&
        x.scan_status === "clean" &&
        !x.deleted_at &&
        [
          "application/pdf",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ].includes(x.mime || ""),
    );
    message.value =
      result.truncated || f.next_cursor
        ? "仅展示前50项；如找不到文件，请先核对附件列表。"
        : "选择已扫描通过的PDF或DOCX；上传请使用下方附件区。";
  });
}
async function open(id: string) {
  await run(async () => {
    const value = await props.request<Job>(base.value + "/" + id, {
      signal: lifetime.signal,
    });
    if (!alive) return;
    clearText();
    job.value = value;
    if (value.status === "preview-ready")
      entries.value = (value.preview || []).map((s, i) => ({
        client_key: crypto.randomUUID(),
        title: "章节 " + (i + 1),
        body: s.text,
        knowledge_point_ids: [],
        original: s.text,
      }));
    message.value =
      (labels[value.status] || value.status) +
      (value.error_code ? "：" + value.error_code : "");
  });
}
async function finish(result: Job) {
  pending.value = undefined;
  persist();
  clearText();
  job.value = result;
  if (result.status === "applied") {
    message.value = "已保存到教材草稿，请继续独立送审；尚未加入知识库。";
    emit("applied");
  } else if (result.status === "queued") {
    message.value = "提取任务已创建，请刷新状态后打开任务。";
  } else message.value = labels[result.status] || result.status;
}
async function send() {
  const intent = pending.value;
  if (!intent?.body) return;
  await run(async () => {
    const result = await props.request<Job>(intent.path, {
      method: "POST",
      body: intent.body,
      idempotencyKey: intent.key,
      signal: lifetime.signal,
    });
    if (!alive) return;
    await finish(result);
  });
}
async function write(path: string, body: unknown) {
  if (pending.value || busy.value || props.blocked) return;
  busy.value = true;
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(body)),
    );
    if (!alive) return;
    pending.value = {
      path,
      key: crypto.randomUUID(),
      hash: Array.from(new Uint8Array(digest))
        .map((x) => x.toString(16).padStart(2, "0"))
        .join(""),
      body,
    };
    persist();
  } catch (e) {
    fail(e);
    return;
  } finally {
    if (alive) busy.value = false;
  }
  await send();
}
async function recover() {
  let result: Job | undefined;
  await run(async () => {
    if (!pending.value) return;
    const receipt = await props.request<{ status: string; result: Job | null }>(
      base.value + "/requests/" + pending.value.key,
      { signal: lifetime.signal },
    );
    if (!alive) return;
    if (receipt.status === "resolved" && receipt.result)
      result = receipt.result;
    else
      message.value =
        "原请求尚未查到；请稍后再查询。有原内容时可显式重试同一编号，刷新后不要创建新请求绕过未知结果。";
  });
  if (result) {
    await finish(result);
  }
}
async function create() {
  await write(base.value, {
    file_id: fileId.value,
    expected_revision: props.version.revision,
  });
}
function addChapter() {
  if (entries.value.length < 100)
    entries.value.push({
      client_key: crypto.randomUUID(),
      title: "新章节",
      body: "",
      knowledge_point_ids: [],
      original: "",
    });
}
async function apply() {
  if (
    !job.value ||
    !confirmed.value ||
    !granted.value ||
    !source.value.trim() ||
    !proof.value.trim() ||
    !entries.value.length
  )
    return;
  const expiry = expires.value ? new Date(expires.value).toISOString() : null;
  if (expiry && expiry <= new Date().toISOString()) {
    message.value = "许可有效期已到，请修改后重新确认。";
    return;
  }
  if (
    entries.value.some((x) => !x.title.trim() || x.body.length > 20000) ||
    entries.value.reduce((n, x) => n + [...x.body].length, 0) > 80000
  ) {
    message.value = "标题须填写，每章最多20000字符，合计最多80000码点。";
    return;
  }
  await write(base.value + "/" + job.value.id + "/apply", {
    job_revision: job.value.revision,
    expected_revision: props.version.revision,
    chapters: entries.value.map((x, i) => ({
      client_key: x.client_key,
      title: x.title,
      body: x.body,
      knowledge_point_ids: x.knowledge_point_ids,
      parent_id: null,
      position: i,
      resource_ids: [],
    })),
    license: { source: source.value, granted: true, expires_at: expiry },
    rights_type: rights.value,
    proof_reference: proof.value,
    usage_restrictions: restrictions.value,
  });
}
onMounted(async () => {
  try {
    const raw = sessionStorage.getItem(storage.value);
    if (raw) {
      const p = JSON.parse(raw);
      if (
        typeof p.path === "string" &&
        (p.path === base.value || p.path.startsWith(base.value + "/")) &&
        /^[a-zA-Z0-9_-]{8,128}$/.test(p.key) &&
        /^[a-f0-9]{64}$/.test(p.hash)
      )
        pending.value = p;
    }
  } catch {}
  await load();
  timer = window.setInterval(async () => {
    if (busy.value || !job.value || job.value.status === "applied") return;
    try {
      const value = await props.request<Job>(base.value + "/" + job.value.id, {
        signal: lifetime.signal,
      });
      if (!alive) return;
      if (job.value.status !== value.status) {
        clearText();
        job.value = value;
        message.value = "任务状态已变化，请重新打开预览。";
      }
    } catch (e) {
      if (alive) fail(e);
    }
  }, 15000);
});
onBeforeUnmount(() => {
  alive = false;
  lifetime.abort();
  window.clearInterval(timer);
  clearText();
  emit("dirty", false);
});
</script>
<template>
  <section
    class="content-section stack import-panel"
    aria-labelledby="import-heading"
  >
    <h3 id="import-heading">从文件导入章节</h3>
    <p ref="notice" tabindex="-1" role="status" aria-live="polite">
      {{ message }}
    </p>
    <button class="button secondary" :disabled="busy" @click="load">
      刷新导入状态与文件
    </button>
    <div v-if="pending" class="notice stack">
      <p>原请求结果待确认；编辑已冻结。编号：{{ pending.key }}</p>
      <div class="actions">
        <button class="button" :disabled="busy" @click="recover">
          查询原编号结果</button
        ><button
          v-if="pending.body"
          class="button secondary"
          :disabled="busy"
          @click="send"
        >
          重试原编号与原内容
        </button>
      </div>
    </div>
    <template v-if="available">
      <p>1. 选择文件 → 2. 本地提取 → 3. 核对章节与许可 → 4. 确认替换草稿</p>
      <fieldset :disabled="busy || blocked || !!pending" class="stack">
        <legend>选择来源文件</legend>
        <label for="import-file">已扫描通过的文件</label
        ><select id="import-file" v-model="fileId">
          <option value="">请选择PDF或DOCX</option>
          <option v-for="f in files" :key="f.id" :value="f.id">
            {{ f.display_name || f.id }}
          </option></select
        ><button class="button" :disabled="!fileId || editing" @click="create">
          创建提取任务
        </button>
      </fieldset>
      <ul class="content-list">
        <li v-for="j in jobs" :key="j.id">
          <span>{{ labels[j.status] || j.status }} · {{ j.id }}</span
          ><button
            class="button secondary"
            :disabled="busy || !!pending || editing"
            @click="open(j.id)"
          >
            查看任务
          </button>
        </li>
      </ul>
      <template v-if="job"
        ><p>
          任务：{{ labels[job.status] || job.status }}，预览有效至
          {{ job.expires_at }}
        </p>
        <div class="actions">
          <button
            class="button secondary"
            :disabled="busy || !!pending"
            @click="open(job.id)"
          >
            重新读取任务（丢弃本地编辑）</button
          ><button
            v-if="!['applied', 'cancelled'].includes(job.status)"
            class="button secondary"
            :disabled="busy || blocked || !!pending"
            @click="
              write(base + '/' + job.id + '/cancel', {
                job_revision: job.revision,
              })
            "
          >
            取消任务并清除预览
          </button>
        </div></template
      >
      <template v-if="job?.status === 'preview-ready' && entries.length">
        <p class="notice">
          PDF表格、公式与阅读顺序请人工核对。原始分段仅供参考，保存后引用定位教材章节。
        </p>
        <fieldset class="stack" :disabled="busy || blocked || !!pending">
          <legend>章节预览编辑与许可登记</legend>
          <button
            class="button secondary"
            :disabled="entries.length >= 100"
            @click="addChapter"
          >
            新增章节（可手动分拆长段落）
          </button>
          <div
            v-for="(entry, i) in entries"
            :key="entry.client_key"
            class="import-columns"
          >
            <details>
              <summary>原文分段 {{ i + 1 }}</summary>
              <p class="import-text">{{ entry.original }}</p>
            </details>
            <div class="stack">
              <label :for="'import-title-' + entry.client_key">章节标题</label
              ><input
                :id="'import-title-' + entry.client_key"
                v-model="entry.title"
                maxlength="200"
              /><label :for="'import-body-' + entry.client_key">章节正文</label
              ><textarea
                :id="'import-body-' + entry.client_key"
                v-model="entry.body"
                rows="8"
                maxlength="20000"
              /><button class="button secondary" @click="entries.splice(i, 1)">
                删除此章节
              </button>
            </div>
          </div>
          <label for="import-source">许可来源</label
          ><input id="import-source" v-model="source" maxlength="1000" />
          <label for="import-rights">权利类型</label
          ><select id="import-rights" v-model="rights">
            <option value="original">原创</option>
            <option value="authorized">已获授权</option>
            <option value="public-domain">公有领域</option>
          </select>
          <label for="import-proof">授权证明引用或原创声明（请使用编号，不填写个人身份信息）</label
          ><input id="import-proof" v-model="proof" maxlength="1000" />
          <label for="import-expiry">许可到期时间（可选，本地时间）</label
          ><input id="import-expiry" v-model="expires" type="datetime-local" />
          <label for="import-restrictions">用途限制</label
          ><textarea
            id="import-restrictions"
            v-model="restrictions"
            maxlength="1000"
          />
          <label
            ><input
              v-model="granted"
              type="checkbox"
            />确认有权使用这些材料（声明不等于版权批准）</label
          >
          <h4>确认替换草稿</h4>
          <p>
            将替换现有 {{ version.chapters?.length || 0 }} 个章节，保存
            {{ entries.length }}
            个新章节。现有章节的结构、知识点和章节附件绑定会被替换，请核对；后续可在草稿补充知识点。教材附件引用保留。
          </p>
          <div class="import-columns">
            <details>
              <summary>当前草稿内容</summary>
              <article v-for="c in version.chapters" :key="c.id">
                <h5>{{ c.title }}</h5>
                <p class="import-text">{{ c.body }}</p>
              </article>
            </details>
            <details>
              <summary>将保存的内容</summary>
              <article v-for="e in entries" :key="e.client_key">
                <h5>{{ e.title }}</h5>
                <p class="import-text">{{ e.body }}</p>
              </article>
            </details>
          </div>
          <label
            ><input
              v-model="confirmed"
              type="checkbox"
            />已核对差异、许可及正文，确认替换此草稿章节</label
          >
          <button
            class="button"
            :disabled="
              !confirmed || !granted || !source.trim() || !proof.trim()
            "
            @click="apply"
          >
            确认应用到草稿
          </button>
        </fieldset></template
      >
    </template>
  </section>
</template>
<style scoped>
.import-panel {
  min-width: 0;
}
.import-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
}
.import-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.import-panel input,
.import-panel textarea,
.import-panel select {
  max-width: 100%;
  min-width: 0;
}
.import-panel p {
  overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  .import-columns {
    grid-template-columns: 1fr;
  }
}
</style>
