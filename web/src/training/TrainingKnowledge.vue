<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { ApiError, type BusinessRequest } from "../session";
type Row = Record<string, any>;
const props = defineProps<{
  request: BusinessRequest;
  write: (path: string, body: unknown) => Promise<any>;
  caps: string[];
  blocked: boolean;
  recovered: Row | null;
}>();
const emit = defineEmits<{
  reading: [{ editionId: string; chapterId: string }];
  course: [{ id: string; lessonKey: string }];
}>();
const sources = ref<Row[]>([]),
  selected = ref<string[]>([]),
  courses = ref<Row[]>([]),
  anchor = ref(""),
  query = ref(""),
  evidence = ref<Row | null>(null),
  job = ref<Row | null>(null),
  jobs = ref<Row[]>([]),
  indexes = ref<Row[]>([]),
  message = ref(""),
  busy = ref(false),
  limited = ref(false);
const live = new AbortController();
let epoch = 0,
  timer = 0;
const notice = ref<HTMLElement>();
const key = (source: Row) => JSON.stringify(source);
const canAssist = computed(
  () =>
    props.caps.includes("ai:assist") && props.caps.includes("learning:self"),
);
const canPrepare = computed(() => props.caps.includes("ai:generate"));
const canGenerate = computed(() => canAssist.value || canPrepare.value);
const generationKind = ref(canAssist.value ? "assist" : "prepare");
const canManage = computed(() => props.caps.includes("ai:manage"));
const disabled = computed(() => busy.value || props.blocked);
const chosen = computed(() =>
  sources.value
    .filter((item) => selected.value.includes(key(item.source)))
    .map((item) => item.source),
);
const states: Record<string, string> = {
  pending: "等待更新",
  running: "正在更新",
  completed: "更新完成",
  failed: "更新失败",
  queued: "等待生成",
  succeeded: "生成完成",
  unknown: "调用结果待核对",
  cancelled: "已取消",
};
const errorText = (code: string) =>
  code === "CONTEXT_CHANGED"
    ? "知识来源已变化，请重新检索。"
    : code === "KNOWLEDGE_SOURCE_LIMIT"
      ? "来源超出索引容量，请拆分资料后重建。"
      : code === "AI_PROVIDER_OUTCOME_UNKNOWN"
        ? "模型调用结果尚未确认，请由管理员核对。"
        : "操作未完成，请重试或联系管理员核对。";
function clear() {
  epoch++;
  evidence.value = null;
  job.value = null;
  message.value = "";
}
watch([query, selected], clear, { deep: true });
watch(anchor, () => {
  epoch++;
  job.value = null;
});
watch(generationKind, () => {
  epoch++;
  job.value = null;
});
function openCitation(citation: Row) {
  if (disabled.value) return;
  if (citation.source.kind === "chapter")
    emit("reading", {
      editionId: citation.owner_id,
      chapterId: citation.source.id,
    });
  else
    emit("course", {
      id: citation.source.id,
      lessonKey: citation.source.lesson_key,
    });
}
function purge() {
  epoch++;
  sources.value = [];
  selected.value = [];
  evidence.value = null;
  job.value = null;
  jobs.value = [];
  indexes.value = [];
  courses.value = [];
}
async function read<T>(
  path: string,
  options: Record<string, any> = {},
): Promise<T> {
  try {
    return await props.request<T>(path, { ...options, signal: live.signal });
  } catch (error) {
    if (
      error instanceof ApiError &&
      ([401, 403, 404].includes(error.status) ||
        error.code === "CONTEXT_CHANGED" ||
        error.code.startsWith("KNOWLEDGE_INDEX_"))
    )
      purge();
    throw error;
  }
}
async function announce(text: string) {
  message.value = text;
  await nextTick();
  notice.value?.focus();
}
async function refresh() {
  if (disabled.value) return;
  busy.value = true;
  const version = epoch;
  try {
    const options = await read<Row>("/training/knowledge/sources");
    const available = await read<Row>("/training/courses");
    const recent = await read<Row>("/training/ai/jobs");
    const management = canManage.value
      ? await read<Row>("/training/knowledge/status")
      : null;
    if (live.signal.aborted || version !== epoch) return;
    sources.value = options.items;
    limited.value = options.truncated || management?.truncated || false;
    courses.value = available.items.filter(
      (course: Row) => course.status === "published",
    );
    jobs.value = recent.items.filter((item: Row) => item.knowledge_scope);
    indexes.value = management?.items ?? [];
    selected.value = selected.value.filter((value) =>
      sources.value.some((item) => key(item.source) === value),
    );
  } catch (error) {
    if (!live.signal.aborted)
      await announce(
        error instanceof Error ? error.message : "知识来源读取失败",
      );
  } finally {
    busy.value = false;
  }
}
async function search() {
  if (disabled.value) return;
  busy.value = true;
  evidence.value = null;
  job.value = null;
  const version = ++epoch;
  try {
    const result = await read<Row>("/training/knowledge/search", {
      method: "POST",
      body: { query: query.value, scope: chosen.value },
    });
    if (version !== epoch || live.signal.aborted) return;
    evidence.value = result;
    await announce(
      result.status === "grounded"
        ? "已找到原文证据，请核对后明确生成。"
        : "当前范围证据不足，请调整问题或来源。",
    );
  } catch (error) {
    if (!live.signal.aborted)
      await announce(error instanceof Error ? error.message : "检索失败");
  } finally {
    busy.value = false;
  }
}
async function create() {
  if (disabled.value || evidence.value?.status !== "grounded" || !anchor.value)
    return;
  const version = epoch;
  const result = await props.write("/training/ai/jobs", {
    kind: generationKind.value,
    context_id: anchor.value,
    prompt: query.value,
    knowledge_scope: chosen.value,
    knowledge_fingerprint: evidence.value.fingerprint,
  });
  if (result && version === epoch && !live.signal.aborted) {
    job.value = result;
    await announce("任务已创建。点击“发送给AI生成”才会调用模型。");
  }
}
async function action(name: "dispatch" | "cancel") {
  if (disabled.value || !job.value) return;
  const current = job.value,
    version = epoch;
  const result = await props.write(`/training/ai/jobs/${current.id}/${name}`, {
    expected_revision: current.revision,
  });
  if (result && version === epoch && !live.signal.aborted) {
    job.value = result;
    await announce(states[result.status] ?? "任务已更新");
  }
}
async function open(id: string) {
  if (disabled.value) return;
  busy.value = true;
  evidence.value = null;
  job.value = null;
  const version = ++epoch;
  try {
    const result = await read<Row>(`/training/ai/jobs/${id}`);
    if (version === epoch && !live.signal.aborted) {
      job.value = result;
      await announce(states[result.status] ?? "已重新核对任务来源");
    }
  } catch (error) {
    if (!live.signal.aborted)
      await announce(error instanceof Error ? error.message : "任务读取失败");
  } finally {
    busy.value = false;
  }
}
async function rebuild(source: Row) {
  if (disabled.value) return;
  const result = await props.write("/training/knowledge/rebuild", { source });
  if (result && !live.signal.aborted) {
    evidence.value = null;
    job.value = null;
    await announce("重建已受理，等待索引更新后刷新。");
    await refresh();
  }
}
watch(
  () => props.recovered,
  (value) => {
    if (value?.id) void open(value.id);
    else if (value) void refresh();
  },
);
watch(
  () => props.caps.join("|"),
  () => {
    purge();
    void refresh();
  },
);
onMounted(() => {
  void (async () => {
    await refresh();
    if (props.recovered?.id) await open(props.recovered.id);
  })();
  timer = window.setInterval(async () => {
    if ((!job.value && !evidence.value) || disabled.value) return;
    const id = job.value?.id,
      version = epoch;
    try {
      if (id) {
        const current = await read<Row>(`/training/ai/jobs/${id}`);
        if (version === epoch && !live.signal.aborted) job.value = current;
      } else {
        const current = await read<Row>("/training/knowledge/search", {
          method: "POST",
          body: { query: query.value, scope: chosen.value },
        });
        if (
          version === epoch &&
          !live.signal.aborted &&
          current.fingerprint !== evidence.value?.fingerprint
        ) {
          evidence.value = null;
          message.value = "知识来源已变化，请重新检索。";
        }
      }
    } catch (error) {
      if (!live.signal.aborted)
        message.value = error instanceof Error ? error.message : "来源复核失败";
    }
  }, 15000);
});
onBeforeUnmount(() => {
  live.abort();
  window.clearInterval(timer);
  purge();
});
</script>

<template>
  <section class="knowledge-workspace" :aria-busy="busy">
    <div class="knowledge-top">
      <div>
        <p class="eyebrow">KNOWLEDGE / 授权知识库</p>
        <h3>先查原文，再向 AI 提问</h3>
      </div>
      <button class="button secondary" :disabled="disabled" @click="refresh">
        刷新来源与任务
      </button>
    </div>
    <p>
      仅检索当前有权访问的已发布教材章节和课程文本。AI回答用于辅助学习，仍需核对原文。
    </p>
    <p ref="notice" tabindex="-1" role="status" aria-live="polite">
      {{ message }}
    </p>
    <p v-if="limited">
      本页展示的来源或索引记录已达上限，当前列表不代表全部资料。
    </p>
    <div class="knowledge-grid">
      <section class="panel">
        <h4>选择知识来源</h4>
        <p v-if="!sources.length">
          暂无可用知识来源。索引更新后刷新；管理员可查看下方更新状态。
        </p>
        <fieldset :disabled="disabled">
          <legend>最多选择20个章节或课时</legend>
          <label
            v-for="item in sources"
            :key="key(item.source)"
            class="knowledge-source"
          >
            <input
              v-model="selected"
              type="checkbox"
              :value="key(item.source)"
              :disabled="
                selected.length >= 20 && !selected.includes(key(item.source))
              "
            />
            <span
              >{{ item.title }} ·
              {{ item.source.kind === "chapter" ? "教材章节" : "课程文本" }} ·
              版本{{ item.revision
              }}<small v-if="!item.current">（等待重建）</small></span
            >
          </label>
        </fieldset>
        <label for="knowledge-query">学习问题</label>
        <textarea
          id="knowledge-query"
          v-model="query"
          rows="4"
          maxlength="256"
          :disabled="disabled"
          placeholder="例如：沟通培训中如何复述确认？"
        />
        <button
          class="button"
          :disabled="disabled || !chosen.length || !query.trim()"
          @click="search"
        >
          检索原文证据
        </button>
        <template v-if="canGenerate"
          ><label for="knowledge-anchor">当前学习课程</label>
          <select id="knowledge-anchor" v-model="anchor" :disabled="disabled">
            <option value="">请选择课程</option>
            <option
              v-for="course in courses"
              :key="course.id"
              :value="course.id"
            >
              {{ course.title }}
            </option>
          </select>
          <template v-if="canAssist && canPrepare"
            ><label for="knowledge-kind">生成用途</label>
            <select
              id="knowledge-kind"
              v-model="generationKind"
              :disabled="disabled"
            >
              <option value="assist">学习答疑</option>
              <option value="prepare">教学备课</option>
            </select></template
          >
          <button
            class="button secondary"
            :disabled="
              disabled || !anchor || evidence?.status !== 'grounded' || !!job
            "
            @click="create"
          >
            确认证据，创建{{
              generationKind === "assist" ? "答疑" : "备课"
            }}任务
          </button>
        </template>
        <p v-else>当前角色可检索资料；学习答疑生成需要相应学习与AI答疑权限。</p>
      </section>
      <section class="panel">
        <h4>原文证据</h4>
        <p v-if="!evidence">选择范围并检索后，这里显示最多5条引用。</p>
        <p v-else-if="evidence.status === 'insufficient-evidence'">
          证据不足，未调用模型。
        </p>
        <article
          v-for="citation in evidence?.citations ?? []"
          :key="citation.key"
          class="knowledge-evidence"
        >
          <h5>{{ citation.title }} · 版本{{ citation.revision }}</h5>
          <p class="knowledge-text">{{ citation.text }}</p>
          <small
            >原文位置 {{ citation.start_utf16 }}–{{ citation.end_utf16 }}</small
          >
          <button
            v-if="
              citation.source.kind === 'course-text' ||
              caps.includes('learning:self')
            "
            class="button secondary"
            :disabled="disabled"
            @click="openCitation(citation)"
          >
            打开原文核对
          </button>
        </article>
        <template v-if="job"
          ><h4>AI答疑 · {{ states[job.status] ?? job.status }}</h4>
          <button
            v-if="job.status === 'queued'"
            class="button"
            :disabled="disabled"
            @click="action('dispatch')"
          >
            发送给AI生成
          </button>
          <button
            v-if="['queued', 'running'].includes(job.status)"
            class="button secondary"
            :disabled="disabled"
            @click="action('cancel')"
          >
            取消任务
          </button>
          <p v-if="job.status === 'unknown'">
            调用结果尚未确认，请保留任务编号交由管理员核对，避免重复发送。
          </p>
          <p v-if="job.error_code">{{ errorText(job.error_code) }}</p>
          <p v-if="job.output" class="knowledge-text">{{ job.output }}</p>
          <article
            v-for="citation in job.knowledge_evidence ?? []"
            :key="citation.key"
            class="knowledge-evidence"
          >
            <h5>{{ citation.title }} · 版本{{ citation.revision }}</h5>
            <p class="knowledge-text">{{ citation.text }}</p>
            <button
              v-if="
                citation.source.kind === 'course-text' ||
                caps.includes('learning:self')
              "
              class="button secondary"
              :disabled="disabled"
              @click="openCitation(citation)"
            >
              打开原文核对
            </button>
          </article>
        </template>
      </section>
    </div>
    <section class="panel">
      <h4>最近的知识答疑任务</h4>
      <p v-if="!jobs.length">暂无任务。已撤权的来源结果会停止交付。</p>
      <button
        v-for="item in jobs"
        :key="item.id"
        class="button secondary"
        :disabled="disabled"
        @click="open(item.id)"
      >
        {{ states[item.status] ?? item.status }} ·
        {{ new Date(item.created_at).toLocaleString() }}
      </button>
    </section>
    <section v-if="canManage" class="panel">
      <h4>知识索引更新</h4>
      <p v-if="!indexes.length">暂无来源更新记录。</p>
      <article
        v-for="item in indexes"
        :key="item.owner_id"
        class="knowledge-evidence"
      >
        <strong>{{ item.title }}</strong>
        <p>
          {{ states[item.status] ?? item.status }} ·
          {{ new Date(item.updated_at).toLocaleString() }}
        </p>
        <p v-if="item.error_code">{{ errorText(item.error_code) }}</p>
        <button
          v-if="item.source"
          class="button secondary"
          :disabled="disabled"
          @click="rebuild(item.source)"
        >
          申请重建此来源
        </button>
      </article>
    </section>
  </section>
</template>
<style scoped>
.knowledge-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.knowledge-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 1rem;
}
.knowledge-workspace {
  display: grid;
  gap: 1rem;
  min-width: 0;
  overflow-wrap: anywhere;
}
.knowledge-source {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
  margin: 0.6rem 0;
}
.knowledge-source input {
  width: auto;
  flex: none;
}
.knowledge-workspace fieldset {
  max-height: 24rem;
  overflow: auto;
  min-width: 0;
}
.knowledge-workspace textarea,
.knowledge-workspace select {
  width: 100%;
  box-sizing: border-box;
  margin: 0.5rem 0;
}
.knowledge-evidence {
  border-top: 1px solid var(--border, #d8dfec);
  padding: 0.8rem 0;
}
.knowledge-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
@media (max-width: 760px) {
  .knowledge-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
