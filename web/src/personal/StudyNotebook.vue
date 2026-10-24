<script setup lang="ts">
import SiteImage from "../site/SiteImage.vue";
import { siteMedia } from "../site/media";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";
import { RouterLink, useRoute } from "vue-router";
import { ApiError, type GlobalRequest } from "../session";
import type { components } from "../api/schema";
type S = components["schemas"];
type Item = S["LifelongStudyItem"];
const props = defineProps<{
  request: GlobalRequest;
  locked: boolean;
  mode: "today" | "notebook";
  write: (
    path: string,
    body: unknown,
    method?: "POST" | "PATCH",
  ) => Promise<S["LifelongOperation"] | undefined>;
}>();
const emit = defineEmits<{ dirty: [value: boolean]; browse: [] }>();
const route = useRoute();
function localDay() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const today = ref(localDay()),
  filter = ref("all"),
  query = ref("");
const items = ref<Item[]>([]),
  cursor = ref<string | null>(null),
  busy = ref(false),
  unavailable = ref(false),
  error = ref(""),
  notice = ref("");
const empty = () => ({
  title: "",
  note: "",
  bookmarked: false,
  course_id: null as string | null,
  course_version: null as number | null,
  unit_id: null as string | null,
  due_on: null as string | null,
});
const form = reactive(empty()),
  editing = ref<Item>();
const baseline = ref(JSON.stringify(form));
const reviewUnit = ref<S["LifelongCourseDetail"]["units"][number]>();
const reviewing = ref<Item>(),
  review = reactive({
    answer: null as number | null,
    reviewed_on: localDay(),
    next_due_on: null as string | null,
    note: "",
  });
const historyFor = ref<Item>(),
  history = ref<S["LifelongReviewEvent"][]>([]),
  historyCursor = ref<string | null>(null);
const suggestedDate = computed(() => {
  if (!reviewing.value || !/^\d{4}-\d{2}-\d{2}$/.test(review.reviewed_on))
    return "";
  const d = new Date(review.reviewed_on);
  if (!Number.isFinite(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() + reviewing.value.suggested_interval_days);
  const value = d.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
});
async function loadHistory(item: Item, more = false) {
  if (props.locked || busy.value || unavailable.value) return;
  const ticket = ++epoch;
  busy.value = true;
  error.value = "";
  if (!more) {
    history.value = [];
    historyCursor.value = null;
    historyFor.value = item;
  }
  try {
    const p = await props.request<S["LifelongReviewEventPage"]>(
      `/personal/study-items/${item.id}/reviews?limit=20${more && historyCursor.value ? `&cursor=${encodeURIComponent(historyCursor.value)}` : ""}`,
      { signal: life.signal, notFound: "lookup" },
    );
    if (!alive || ticket !== epoch) return;
    history.value = more ? [...history.value, ...p.items] : p.items;
    historyCursor.value = p.next_cursor;
  } catch (cause) {
    if (alive && ticket === epoch) {
      history.value = [];
      historyCursor.value = null;
      sourceFailure(cause, "复习历史暂时无法读取");
    }
  } finally {
    if (alive && ticket === epoch) busy.value = false;
  }
}
const dirty = computed(
  () =>
    JSON.stringify(form) !== baseline.value ||
    (!!reviewing.value &&
      !!(review.note || review.next_due_on || review.answer !== null)),
);
watch(dirty, (v) => emit("dirty", v), { flush: "sync" });
const life = new AbortController();
let alive = true,
  epoch = 0;
const heading = ref<HTMLElement>();
async function refresh(more = false) {
  const ticket = ++epoch;
  today.value = localDay();
  busy.value = true;
  error.value = "";
  if (!more) {
    items.value = [];
    cursor.value = null;
    historyFor.value = undefined;
    history.value = [];
    historyCursor.value = null;
  }
  const q = new URLSearchParams({
    filter: props.mode === "today" ? "due" : filter.value,
    as_of: today.value,
    limit: props.mode === "today" ? "5" : "20",
  });
  if (query.value && props.mode !== "today") q.set("q", query.value);
  if (more && cursor.value) q.set("cursor", cursor.value);
  try {
    const result = await props.request<S["LifelongStudyPage"]>(
      `/personal/study-items?${q}`,
      { signal: life.signal },
    );
    if (!alive || ticket !== epoch) return;
    items.value = more ? [...items.value, ...result.items] : result.items;
    cursor.value = result.next_cursor;
    unavailable.value = false;
  } catch (cause) {
    if (!alive || ticket !== epoch) return;
    items.value = [];
    cursor.value = null;
    unavailable.value = true;
    error.value =
      cause instanceof Error ? cause.message : "笔记暂时无法读取，请重试。";
    if (cause instanceof ApiError && [401, 403].includes(cause.status))
      resetDraft();
  } finally {
    if (alive && ticket === epoch) busy.value = false;
  }
}
function resetDraft() {
  historyFor.value = undefined;
  history.value = [];
  historyCursor.value = null;
  Object.assign(form, empty());
  editing.value = undefined;
  reviewing.value = undefined;
  reviewUnit.value = undefined;
  Object.assign(review, {
    answer: null,
    reviewed_on: localDay(),
    next_due_on: null,
    note: "",
  });
  baseline.value = JSON.stringify(form);
}
function sourceFailure(cause: unknown, fallback: string) {
  error.value = cause instanceof Error ? cause.message : fallback;
  if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
    items.value = [];
    cursor.value = null;
    unavailable.value = true;
    resetDraft();
  }
}
async function sourceFromRoute() {
  if (
    props.mode !== "notebook" ||
    route.query.tab !== "notes" ||
    typeof route.query.course !== "string" ||
    typeof route.query.unit !== "string" ||
    dirty.value
  )
    return;
  const ticket = ++epoch;
  busy.value = true;
  error.value = "";
  try {
    const c = await props.request<S["LifelongCourseDetail"]>(
      `/personal/courses/${encodeURIComponent(route.query.course)}`,
      { signal: life.signal, notFound: "lookup" },
    );
    if (!alive || ticket !== epoch) return;
    const unit = c.units.find((u) => u.id === route.query.unit);
    if (!unit) throw Error("原单元不可用，请从内容中心重新选择。");
    Object.assign(form, empty(), {
      title: `${unit.title} · 学习笔记`,
      course_id: c.id,
      course_version: c.version,
      unit_id: unit.id,
    });
    editing.value = undefined;
    baseline.value = JSON.stringify(form);
    await nextTick();
    heading.value?.focus();
  } catch (cause) {
    if (alive && ticket === epoch) sourceFailure(cause, "无法读取来源");
  } finally {
    if (alive && ticket === epoch) busy.value = false;
  }
}
async function edit(item: Item) {
  if (dirty.value || props.locked || busy.value || unavailable.value) return;
  resetDraft();
  editing.value = item;
  for (const k of Object.keys(empty()) as (keyof ReturnType<typeof empty>)[])
    (form as Record<string, unknown>)[k] = item[k];
  baseline.value = JSON.stringify(form);
  await nextTick();
  heading.value?.focus();
}
async function save() {
  if (props.locked || busy.value || unavailable.value) return;
  const result = await props.write(
    `/personal/study-items${editing.value ? `/${editing.value.id}` : ""}`,
    { ...form, ...(editing.value ? { revision: editing.value.revision } : {}) },
    editing.value ? "PATCH" : "POST",
  );
  if (result && alive) {
    resetDraft();
    await refresh();
    notice.value = "笔记、收藏与复习日期已保存，仅本人可见。";
  }
}
async function startReview(item: Item) {
  if (dirty.value || props.locked || busy.value || unavailable.value) return;
  resetDraft();
  if (item.course_id) {
    busy.value = true;
    error.value = "";
    const ticket = ++epoch;
    try {
      const c = await props.request<S["LifelongCourseDetail"]>(
        `/personal/courses/${encodeURIComponent(item.course_id)}`,
        { signal: life.signal, notFound: "lookup" },
      );
      if (!alive || ticket !== epoch) return;
      const unit = c.units.find((u) => u.id === item.unit_id);
      if (c.version !== item.course_version || !unit)
        throw Error("原课程版本已不可用，请刷新笔记列表。");
      reviewUnit.value = unit;
    } catch (cause) {
      if (alive && ticket === epoch) sourceFailure(cause, "无法读取复习单元");
      return;
    } finally {
      if (alive && ticket === epoch) busy.value = false;
    }
  }
  reviewing.value = item;
  await nextTick();
  heading.value?.focus();
}
async function completeReview() {
  const item = reviewing.value;
  if (!item || props.locked || busy.value || unavailable.value) return;
  const result = await props.write(`/personal/study-items/${item.id}/review`, {
    revision: item.revision,
    ...review,
  });
  if (result && alive) {
    resetDraft();
    await refresh();
    notice.value = "复习回顾已保存；原课程完成与成绩保持原有记录。";
  }
}
const removing = ref<Item>();
async function remove() {
  const item = removing.value;
  if (!item || props.locked || busy.value || unavailable.value) return;
  const result = await props.write(`/personal/study-items/${item.id}/remove`, {
    revision: item.revision,
  });
  if (result && alive) {
    removing.value = undefined;
    resetDraft();
    await refresh();
    notice.value = "已移除笔记及其复习安排。";
  }
}
watch(
  () => props.mode,
  async () => {
    today.value = localDay();
    await refresh();
    await sourceFromRoute();
  },
);
watch(
  () => [route.query.tab, route.query.course, route.query.unit],
  () => {
    if (route.query.tab === "notes") {
      resetDraft();
      void sourceFromRoute();
    }
  },
);
onMounted(async () => {
  await refresh();
  await sourceFromRoute();
});
onBeforeUnmount(() => {
  alive = false;
  ++epoch;
  life.abort();
  emit("dirty", false);
});
defineExpose({ refresh, resetDraft });
</script>

<template>
  <section class="study-notebook" :aria-busy="busy" aria-label="笔记与复习">
    <header class="study-actions">
      <h2 ref="heading" tabindex="-1">
        {{ mode === "today" ? "今日待复习" : "我的笔记与复习" }}
      </h2>
      <button v-if="mode === 'today'" @click="emit('browse')">
        管理笔记与收藏
      </button>
    </header>
    <p v-if="error" role="alert" class="notice error">{{ error }}</p>
    <p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <p v-if="mode === 'today'">
      {{ today }} · 包含已到期和逾期安排，日期按你当前设备的本地日期计算。
    </p>
    <template v-else>
      <form class="study-actions" @submit.prevent="refresh()">
        <label
          >查找笔记<input
            v-model="query"
            maxlength="120"
            :disabled="busy || locked"
            placeholder="标题、笔记或复习回顾"
        /></label>
        <label
          >查看范围<select v-model="filter" :disabled="busy || locked">
            <option value="all">全部笔记</option>
            <option value="bookmarked">我的收藏</option>
            <option value="due">今日待复习</option>
          </select></label
        >
        <button :disabled="busy || locked">查找</button>
      </form>
      <form v-if="!reviewing" class="study-form" @submit.prevent="save">
        <h3>{{ editing ? "编辑笔记" : "写一条私人笔记" }}</h3>
        <p v-if="form.course_id">
          已关联原创课程单元 v{{ form.course_version }}。保存自己的理解与疑问。
        </p>
        <label
          >笔记标题<input
            v-model="form.title"
            required
            maxlength="120"
            :disabled="locked || busy"
        /></label>
        <label
          >我的笔记<textarea
            v-model="form.note"
            maxlength="4000"
            rows="4"
            :disabled="locked || busy"
            placeholder="重点、错因或想继续探索的问题"
          />
        </label>
        <label class="study-check"
          ><input
            v-model="form.bookmarked"
            type="checkbox"
            :disabled="locked || busy"
          />加入收藏</label
        >
        <label
          >复习日期（可选）<input
            :value="form.due_on ?? ''"
            type="date"
            :disabled="locked || busy"
            @input="
              form.due_on = ($event.target as HTMLInputElement).value || null
            "
        /></label>
        <div class="study-actions">
          <button
            :disabled="locked || busy || unavailable || !form.title.trim()"
          >
            保存笔记</button
          ><button type="button" :disabled="locked || busy" @click="resetDraft">
            清空 / 取消编辑</button
          ><button
            v-if="form.course_id"
            type="button"
            :disabled="locked || busy"
            @click="form.course_id = form.course_version = form.unit_id = null"
          >
            解除课程关联
          </button>
        </div>
      </form>
    </template>
    <form v-if="reviewing" class="study-form" @submit.prevent="completeReview">
      <h3>复习：{{ reviewing.title }}</h3>
      <p class="study-text">{{ reviewing.note }}</p>
      <RouterLink
        v-if="reviewing.course_id && reviewing.source_available"
        :to="{
          path: '/personal',
          query: {
            tab: 'courses',
            course: reviewing.course_id,
            unit: reviewing.unit_id!,
          },
        }"
        >回看原单元 →</RouterLink
      >
      <fieldset v-if="reviewUnit" :disabled="locked || busy">
        <legend>{{ reviewUnit.question }}</legend>
        <label
          v-for="(option, index) in reviewUnit.options"
          :key="index"
          class="study-check"
          ><input
            v-model="review.answer"
            type="radio"
            name="review-answer"
            :value="index"
            required
          />{{ option }}</label
        >
        <details>
          <summary>查看思路提示</summary>
          <p>{{ reviewUnit.explanation }}</p>
        </details>
        <p>本次再练仅用于复习，不计入原课程完成或首次测评成绩。</p>
      </fieldset>
      <label
        >本次复习日期<input
          v-model="review.reviewed_on"
          required
          type="date"
          :disabled="locked || busy"
      /></label>
      <label
        >复习回顾<textarea
          v-model="review.note"
          required
          maxlength="4000"
          rows="3"
          :disabled="locked || busy"
          placeholder="现在能否解释重点？还有什么需要再练习？"
        />
      </label>
      <label
        >下次复习日期（留空则结束本次安排）<input
          :value="review.next_due_on ?? ''"
          type="date"
          :min="review.reviewed_on"
          :disabled="locked || busy"
          @input="
            review.next_due_on =
              ($event.target as HTMLInputElement).value || null
          "
      /></label>
      <p>
        可选规则建议：按累计回顾次数采用1、3、7、14、30日间隔；不是记忆效果测定或自适应AI。
      </p>
      <button
        type="button"
        :disabled="locked || busy || !suggestedDate"
        @click="review.next_due_on = suggestedDate || null"
      >
        采用建议日期：{{ suggestedDate || "请先填写本次日期" }}
      </button>
      <div class="study-actions">
        <button
          :disabled="locked || busy || unavailable || !review.note.trim()"
        >
          保存复习回顾</button
        ><button type="button" :disabled="locked || busy" @click="resetDraft">
          取消复习
        </button>
      </div>
    </form>
    <SiteImage
      v-if="!busy && !unavailable && !error && !items.length"
      class="empty-art"
      :src="siteMedia.emptyNote"
      alt="暂无符合条件的笔记"
      :width="800"
      :height="800"
    />
    <p v-if="!busy && !unavailable && !items.length">
      {{
        mode === "today" || filter === "due"
          ? "当前没有到期的复习安排。"
          : "暂无符合条件的笔记，可以先记录一个重点。"
      }}
    </p>
    <div class="study-list">
      <article v-for="item in items" :key="item.id" class="study-card">
        <h3>{{ item.bookmarked ? "★ " : "" }}{{ item.title }}</h3>
        <p v-if="item.source_title">
          {{ item.source_title }} · v{{ item.course_version }}
        </p>
        <p v-if="!item.source_available" role="status">
          原课程版本已不可用；保留私人记录，可解除关联后自行复习。
        </p>
        <p class="study-text">{{ item.note }}</p>
        <p>
          {{ item.due_on ? `待复习：${item.due_on}` : "未安排下一次复习" }} ·
          已回顾 {{ item.review_count }} 次
        </p>
        <p v-if="item.reviewed_on" class="study-text">
          上次回顾 {{ item.reviewed_on }}：{{ item.review_note }}
        </p>
        <div class="study-actions">
          <button
            v-if="mode === 'notebook'"
            :disabled="locked || busy"
            @click="loadHistory(item)"
          >
            查看复习历史
          </button>
          <RouterLink
            v-if="item.course_id && item.source_available"
            :to="{
              path: '/personal',
              query: {
                tab: 'courses',
                course: item.course_id,
                unit: item.unit_id!,
              },
            }"
            >回看原单元 →</RouterLink
          >
          <button
            v-if="mode === 'notebook'"
            :disabled="locked || busy || dirty"
            @click="edit(item)"
          >
            编辑笔记
          </button>
          <button
            v-if="item.due_on && item.due_on <= today && item.source_available"
            :disabled="locked || busy || dirty"
            @click="startReview(item)"
          >
            开始复习
          </button>
          <button
            v-if="mode === 'notebook'"
            :disabled="locked || busy || dirty"
            @click="removing = item"
          >
            移除
          </button>
        </div>
      </article>
    </div>
    <section v-if="historyFor" class="study-card" aria-label="复习历史">
      <h3>{{ historyFor.title }} · 逐次回顾</h3>
      <p>此处保留升级后的真实复习事件；早期仅存最近一次回顾，不补造历史。</p>
      <p v-if="!busy && !history.length">尚无可展示的逐次回顾。</p>
      <article v-for="event in history" :key="event.id">
        <h4>第{{ event.ordinal }}次 · {{ event.reviewed_on }}</h4>
        <p class="study-text">{{ event.note }}</p>
        <p>
          {{
            event.next_due_on
              ? `当次安排下次日期：${event.next_due_on}`
              : "当次未安排下一日期"
          }}
        </p>
      </article>
      <div class="study-actions">
        <button
          v-if="historyCursor"
          :disabled="locked || busy"
          @click="loadHistory(historyFor, true)"
        >
          加载更多回顾</button
        ><button
          :disabled="busy"
          @click="
            historyFor = undefined;
            history = [];
            historyCursor = null;
          "
        >
          收起历史
        </button>
      </div>
    </section>
    <button
      v-if="cursor && mode === 'notebook'"
      :disabled="locked || busy"
      @click="refresh(true)"
    >
      加载更多笔记
    </button>
    <button v-if="cursor && mode === 'today'" @click="emit('browse')">
      还有更多待复习，查看全部
    </button>
    <div v-if="removing" class="notice" role="alert">
      <p>移除“{{ removing.title }}”及其复习安排？</p>
      <button :disabled="locked || busy" @click="remove">确认移除</button
      ><button :disabled="busy" @click="removing = undefined">取消</button>
    </div>
  </section>
</template>

<style scoped>
.empty-art {
  max-width: 140px;
  margin: 1rem auto;
}
.study-notebook {
  display: grid;
  gap: 1rem;
  min-width: 0;
  margin: 1.5rem 0;
}
.study-actions {
  display: flex;
  gap: 0.75rem;
  align-items: end;
  flex-wrap: wrap;
}
.study-actions h2 {
  flex: 1;
}
.study-form,
.study-card {
  display: grid;
  gap: 0.75rem;
  padding: 1.25rem;
  border: 1px solid var(--border, #dbe4ec);
  border-radius: 16px;
  background: var(--surface, #fff);
  min-width: 0;
}
.study-list {
  display: grid;
  gap: 1rem;
}
.study-notebook label {
  display: grid;
  gap: 0.4rem;
  min-width: 0;
}
.study-notebook input:not([type="checkbox"]):not([type="radio"]),
.study-notebook textarea,
.study-notebook select {
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  font: inherit;
  padding: 0.65rem;
  border: 1px solid #c4d0dd;
  border-radius: 8px;
}
.study-notebook .study-check {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  min-height: 44px;
  font-weight: 400;
}
.study-notebook .study-check input {
  width: 20px;
  height: 20px;
  min-height: 20px;
  padding: 0;
  flex: 0 0 20px;
  margin: 0;
  accent-color: #1263b0;
}
.study-notebook button {
  white-space: normal;
  min-height: 44px;
  max-width: 100%;
  padding: 0.65rem 1rem;
  border: 1px solid #1263b0;
  border-radius: 8px;
  background: #1263b0;
  color: white;
  font: inherit;
  cursor: pointer;
}
.study-notebook button[type="button"],
.study-card button {
  background: #edf5fc;
  color: #174f7d;
  border-color: #b8d4e9;
}
.study-notebook button:disabled {
  opacity: 0.6;
  cursor: default;
}
.study-notebook :is(button, a, input, select, textarea, summary):focus-visible {
  outline: 3px solid #1263b0;
  outline-offset: 3px;
}
.study-actions > label {
  flex: 1 1 180px;
}
.study-notebook p {
  line-height: 1.75;
}
.study-notebook fieldset {
  border: 1px solid #c4d0dd;
  border-radius: 8px;
  min-width: 0;
}
.study-notebook legend {
  white-space: normal;
  overflow-wrap: anywhere;
}
.study-form h3 {
  margin: 0.25rem 0;
}
.study-notebook textarea {
  resize: vertical;
}
.study-notebook summary {
  cursor: pointer;
  min-height: 44px;
  line-height: 1.7;
}
.study-notebook input,
.study-notebook select {
  min-height: 44px;
}
.study-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.study-card h3,
.study-card p {
  overflow-wrap: anywhere;
  margin: 0;
}
.study-notebook a {
  color: var(--primary, #2366b3);
}
@media (max-width: 480px) {
  .study-form,
  .study-card {
    padding: 1rem;
  }
  .study-actions > label {
    width: 100%;
  }
}
</style>
