<script setup lang="ts">
import SiteImage from "../site/SiteImage.vue";
import { siteMedia } from "../site/media";
import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";
import { RouterLink } from "vue-router";
import { ApiError, type GlobalRequest } from "../session";
import type { components } from "../api/schema";
type S = components["schemas"];
type Item = S["LifelongAgenda"];
const props = defineProps<{
  request: GlobalRequest;
  locked: boolean;
  mode: "home" | "week";
  write: (
    path: string,
    body: unknown,
    method?: "POST" | "PATCH",
  ) => Promise<S["LifelongOperation"] | undefined>;
}>();
const emit = defineEmits<{ dirty: [value: boolean]; browse: [] }>();
function localDay() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function moveDay(value: string, days: number) {
  const d = new Date(value);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function monday(value: string) {
  const d = new Date(value);
  return moveDay(value, -(d.getUTCDay() + 6) % 7);
}
const today = ref(localDay()),
  week = ref(monday(today.value));
const items = ref<Item[]>([]),
  overview = ref<S["LifelongWeekOverview"]>();
const cursor = ref<string | null>(null),
  busy = ref(false),
  unavailable = ref(false),
  error = ref(""),
  notice = ref("");
const kinds = {
  reading: "阅读与听看",
  course: "课程学习",
  review: "复习",
  practice: "实践",
  project: "项目与作品",
};
const states = {
  planned: "待进行",
  completed: "已完成（本人记录）",
  paused: "已暂停",
  cancelled: "已取消",
};
const empty = (): S["LifelongAgendaInput"] => ({
  title: "",
  note: "",
  kind: "reading",
  scheduled_on:
    today.value >= week.value && today.value <= moveDay(week.value, 6)
      ? today.value
      : week.value,
  planned_minutes: 0,
  source_kind: "none",
  source_id: null,
  source_version: null,
  unit_id: null,
});
const form = reactive(empty()),
  editing = ref<Item>();
const baseline = ref(JSON.stringify(form));
const weekForm = reactive({ highlights: "", challenges: "", adjustment: "" });
const weekBaseline = ref(JSON.stringify(weekForm));
const weekRevision = ref(0);
const finishing = ref<Item>(),
  finishingNote = ref(""),
  finishedOn = ref(today.value),
  removing = ref<Item>();
const removingWeek = ref(false);
const dirty = computed(
  () =>
    JSON.stringify(form) !== baseline.value ||
    JSON.stringify(weekForm) !== weekBaseline.value ||
    (!!finishing.value && !!finishingNote.value),
);
watch(dirty, (value) => emit("dirty", value), { flush: "sync" });
const goals = ref<S["LifelongGoal"][]>([]),
  studies = ref<S["LifelongStudyItem"][]>([]),
  courses = ref<S["LifelongCourse"][]>([]);
const sourceCourse = ref<S["LifelongCourseDetail"]>(),
  choicesTruncated = ref(false);
const sorted = computed(() =>
  [...items.value].sort(
    (a, b) =>
      a.scheduled_on.localeCompare(b.scheduled_on) || a.id.localeCompare(b.id),
  ),
);
const visibleItems = computed(() =>
  props.mode === "home"
    ? sorted.value
        .filter((i) => i.scheduled_on === today.value && i.state === "planned")
        .slice(0, 5)
    : sorted.value,
);
const locked = computed(() => props.locked || busy.value || unavailable.value);
const life = new AbortController();
let alive = true,
  epoch = 0,
  sourceEpoch = 0,
  accessEpoch = 0;
function resetDraft(kind: "all" | "agenda" | "week" = "all") {
  if (kind !== "week") {
    ++sourceEpoch;
    editing.value = undefined;
    finishing.value = undefined;
    finishingNote.value = "";
    removing.value = undefined;
    Object.assign(form, empty());
    baseline.value = JSON.stringify(form);
    sourceCourse.value = undefined;
  }
  if (kind !== "agenda") {
    removingWeek.value = false;
    Object.assign(weekForm, {
      highlights: overview.value?.review?.highlights ?? "",
      challenges: overview.value?.review?.challenges ?? "",
      adjustment: overview.value?.review?.adjustment ?? "",
    });
    weekBaseline.value = JSON.stringify(weekForm);
    weekRevision.value = overview.value?.review?.revision ?? 0;
  }
}
function failure(cause: unknown) {
  error.value =
    cause instanceof Error ? cause.message : "周计划暂时无法读取，请重试。";
  if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
    ++accessEpoch;
    ++sourceEpoch;
    unavailable.value = true;
    items.value = [];
    overview.value = undefined;
    goals.value = [];
    studies.value = [];
    courses.value = [];
    resetDraft();
  }
}
async function refresh(more = false) {
  const ticket = ++epoch,
    access = accessEpoch;
  today.value = localDay();
  if (props.mode === "home" && !dirty.value) week.value = monday(today.value);
  busy.value = true;
  error.value = "";
  if (!more) {
    items.value = [];
    cursor.value = null;
  }
  try {
    const result = await props.request<S["LifelongAgendaPage"]>(
      `/personal/agenda?week_start=${week.value}&limit=50${more && cursor.value ? `&cursor=${encodeURIComponent(cursor.value)}` : ""}`,
      { signal: life.signal },
    );
    const summary = await props.request<S["LifelongWeekOverview"]>(
      `/personal/week-overview?week_start=${week.value}&as_of=${today.value}`,
      { signal: life.signal },
    );
    if (!alive || ticket !== epoch || access !== accessEpoch) return;
    items.value = more ? [...items.value, ...result.items] : result.items;
    cursor.value = result.next_cursor;
    overview.value = summary;
    unavailable.value = false;
    if (JSON.stringify(weekForm) === weekBaseline.value) {
      Object.assign(weekForm, {
        highlights: summary.review?.highlights ?? "",
        challenges: summary.review?.challenges ?? "",
        adjustment: summary.review?.adjustment ?? "",
      });
      weekBaseline.value = JSON.stringify(weekForm);
      weekRevision.value = summary.review?.revision ?? 0;
    }
  } catch (cause) {
    if (!alive || ticket !== epoch) return;
    items.value = [];
    overview.value = undefined;
    cursor.value = null;
    unavailable.value = true;
    failure(cause);
  } finally {
    if (alive && ticket === epoch) busy.value = false;
  }
}
async function loadChoices() {
  const access = accessEpoch;
  try {
    const g = await props.request<S["LifelongGoalPage"]>(
      "/personal/goals?limit=50",
      { signal: life.signal },
    );
    const s = await props.request<S["LifelongStudyPage"]>(
      "/personal/study-items?limit=50",
      { signal: life.signal },
    );
    const c = await props.request<S["LifelongCoursePage"]>(
      "/personal/courses",
      { signal: life.signal },
    );
    if (!alive || access !== accessEpoch) return;
    goals.value = g.items;
    studies.value = s.items;
    courses.value = c.items;
    choicesTruncated.value = !!(g.next_cursor || s.next_cursor);
  } catch (cause) {
    if (alive && access === accessEpoch) {
      goals.value = [];
      studies.value = [];
      courses.value = [];
      failure(cause);
    }
  }
}
async function reload() {
  await refresh();
  if (alive && props.mode === "week" && !unavailable.value) await loadChoices();
}
async function sourceChanged(reset = true) {
  const ticket = ++sourceEpoch,
    access = accessEpoch;
  sourceCourse.value = undefined;
  if (reset) {
    form.source_version = null;
    form.unit_id = null;
  }
  if (form.source_kind !== "course" || !form.source_id) return;
  try {
    const c = await props.request<S["LifelongCourseDetail"]>(
      `/personal/courses/${encodeURIComponent(form.source_id)}`,
      { signal: life.signal, notFound: "lookup" },
    );
    if (!alive || ticket !== sourceEpoch || access !== accessEpoch) return;
    sourceCourse.value = c;
    if (reset) {
      form.source_version = c.version;
      form.unit_id = c.units[0]?.id ?? null;
    }
  } catch (cause) {
    if (alive && ticket === sourceEpoch) failure(cause);
  }
}
function kindChanged() {
  form.source_id = null;
  void sourceChanged();
}
async function edit(item: Item) {
  if (dirty.value || locked.value) return;
  resetDraft("agenda");
  editing.value = item;
  for (const k of Object.keys(empty()) as (keyof S["LifelongAgendaInput"])[])
    (form as Record<string, unknown>)[k] = item[k];
  baseline.value = JSON.stringify(form);
  await sourceChanged(false);
}
async function save() {
  if (locked.value) return;
  const result = await props.write(
    `/personal/agenda${editing.value ? `/${editing.value.id}` : ""}`,
    { ...form, ...(editing.value ? { revision: editing.value.revision } : {}) },
    editing.value ? "PATCH" : "POST",
  );
  if (result && alive) {
    resetDraft("agenda");
    await refresh();
    notice.value = "安排已保存；预计投入与课程成绩独立记录。";
  }
}
async function transition(
  item: Item,
  state: "planned" | "paused" | "completed" | "cancelled",
) {
  if (locked.value) return;
  const result = await props.write(`/personal/agenda/${item.id}/state`, {
    revision: item.revision,
    state,
    note: state === "completed" ? finishingNote.value : "",
    completed_on: state === "completed" ? finishedOn.value : null,
  });
  if (result && alive) {
    resetDraft("agenda");
    await refresh();
    notice.value = "安排状态已更新，不影响原课程或正式成绩。";
  }
}
async function remove() {
  if (!removing.value || locked.value) return;
  const result = await props.write(
    `/personal/agenda/${removing.value.id}/remove`,
    { revision: removing.value.revision },
  );
  if (result && alive) {
    removing.value = undefined;
    resetDraft("agenda");
    await refresh();
  }
}
async function saveReview() {
  if (locked.value) return;
  const result = await props.write("/personal/week-reviews", {
    week_start: week.value,
    revision: weekRevision.value,
    ...weekForm,
  });
  if (result && alive) {
    weekBaseline.value = JSON.stringify(weekForm);
    await refresh();
    notice.value = "本周回顾已保存，仅本人可见。";
  }
}
async function removeReview() {
  const review = overview.value?.review;
  if (!review || locked.value) return;
  const result = await props.write(
    `/personal/week-reviews/${review.id}/remove`,
    { revision: review.revision },
  );
  if (result && alive) {
    removingWeek.value = false;
    resetDraft("week");
    await refresh();
    notice.value = "已移除本周回顾的当前正文。";
  }
}
async function switchWeek(value: string) {
  if (
    dirty.value ||
    props.locked ||
    busy.value ||
    !value ||
    !Number.isFinite(Date.parse(value))
  )
    return;
  week.value = monday(value);
  overview.value = undefined;
  resetDraft();
  await refresh();
}
watch(
  () => props.mode,
  (mode) => {
    if (mode === "week") void loadChoices();
  },
);
onMounted(async () => {
  await refresh();
  if (props.mode === "week") await loadChoices();
});
onBeforeUnmount(() => {
  alive = false;
  ++epoch;
  ++sourceEpoch;
  life.abort();
  emit("dirty", false);
});
defineExpose({ refresh, resetDraft });
</script>

<template>
  <section class="week-planner" aria-label="个人周计划">
    <div class="plan-actions">
      <h2>{{ mode === "home" ? "本周学习安排" : "我的周计划" }}</h2>
      <button v-if="mode === 'home'" @click="emit('browse')">安排这一周</button
      ><button :disabled="busy || (locked && !unavailable)" @click="reload()">
        刷新周计划
      </button>
    </div>
    <p v-if="error" class="notice" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <div v-if="overview" class="plan-summary" aria-live="polite">
      <p>{{ overview.week_start }} — {{ overview.week_end }}</p>
      <p>
        本周 {{ overview.total }} 项 · 完成 {{ overview.completed }} · 暂停
        {{ overview.paused }} · 取消 {{ overview.cancelled }} · 逾期
        {{ overview.overdue }}
      </p>
      <p>
        预计投入 {{ overview.planned_minutes }} 分钟（不是实际学习用时）<span
          v-if="overview.truncated"
        >
          · 仅统计前200项</span
        >
      </p>
    </div>
    <template v-if="mode === 'week'">
      <div class="plan-actions">
        <button
          :disabled="busy || props.locked || dirty"
          @click="switchWeek(moveDay(week, -7))"
        >
          上一周
        </button>
        <label
          >选择一周<input
            type="date"
            :value="week"
            :disabled="busy || props.locked || dirty"
            @change="switchWeek(($event.target as HTMLInputElement).value)"
        /></label>
        <button
          :disabled="busy || props.locked || dirty"
          @click="switchWeek(moveDay(week, 7))"
        >
          下一周
        </button>
        <button
          :disabled="busy || props.locked || dirty"
          @click="switchWeek(today)"
        >
          回到本周
        </button>
      </div>
      <p v-if="dirty" role="status">
        请先保存或放弃当前草稿，再切换一周或编辑其他安排。
      </p>
      <form class="plan-card" @submit.prevent="save">
        <h3>{{ editing ? "调整安排" : "新增学习安排" }}</h3>
        <label
          >安排标题<input
            v-model="form.title"
            required
            maxlength="120"
            :disabled="locked"
        /></label>
        <div class="plan-grid">
          <label
            >活动类型<select v-model="form.kind" :disabled="locked">
              <option v-for="(label, key) in kinds" :key="key" :value="key">
                {{ label }}
              </option>
            </select></label
          ><label
            >安排日期<input
              v-model="form.scheduled_on"
              type="date"
              required
              :disabled="locked" /></label
          ><label
            >预计分钟<input
              v-model.number="form.planned_minutes"
              type="number"
              min="0"
              max="1440"
              required
              :disabled="locked"
          /></label>
        </div>
        <label
          >安排说明<textarea
            v-model="form.note"
            maxlength="4000"
            rows="3"
            :disabled="locked"
          />
        </label>
        <label
          >关联来源<select
            v-model="form.source_kind"
            :disabled="locked"
            @change="kindChanged"
          >
            <option value="none">独立安排</option>
            <option value="goal">我的目标</option>
            <option value="course">原创课程单元</option>
            <option value="study">我的笔记与复习</option>
          </select></label
        >
        <label v-if="form.source_kind !== 'none'"
          >选择来源<select
            v-model="form.source_id"
            :disabled="locked"
            required
            @change="sourceChanged()"
          >
            <option :value="null" disabled>请选择</option>
            <option
              v-if="editing && form.source_id && !editing.source_available"
              :value="form.source_id"
            >
              原来源已不可用（可解除关联）
            </option>
            <template v-if="form.source_kind === 'goal'"
              ><option v-for="i in goals" :key="i.id" :value="i.id">
                {{ i.title }}
              </option></template
            ><template v-else-if="form.source_kind === 'course'"
              ><option v-for="i in courses" :key="i.id" :value="i.id">
                {{ i.title }}
              </option></template
            ><template v-else
              ><option
                v-for="i in studies"
                :key="i.id"
                :value="i.id"
                :disabled="!i.source_available"
              >
                {{ i.title }}
              </option></template
            >
          </select></label
        >
        <label v-if="sourceCourse"
          >选择单元<select v-model="form.unit_id" :disabled="locked" required>
            <option v-for="u in sourceCourse.units" :key="u.id" :value="u.id">
              {{ u.title }}
            </option>
          </select></label
        >
        <p v-if="choicesTruncated">
          来源选择展示最近50条目标或笔记；可以先整理原记录，也可建立独立安排。
        </p>
        <div class="plan-actions">
          <button :disabled="locked || !form.title.trim()">保存安排</button
          ><button
            type="button"
            :disabled="props.locked || busy"
            @click="resetDraft('agenda')"
          >
            放弃安排草稿
          </button>
        </div>
      </form>
    </template>
    <SiteImage
      v-if="!busy && !unavailable && !error && !visibleItems.length"
      class="empty-art"
      :src="siteMedia.emptyPlan"
      alt="当前没有学习安排"
      :width="800"
      :height="800"
    />
    <p v-if="!busy && !unavailable && !visibleItems.length">
      {{
        mode === "home"
          ? "当前已加载安排中，今天没有待进行项；可进入周计划查看完整一周。"
          : "这一周还没有安排，可以先选一个小目标。"
      }}
    </p>
    <div class="plan-list">
      <article v-for="item in visibleItems" :key="item.id" class="plan-card">
        <h3>{{ item.title }}</h3>
        <p>
          {{ item.scheduled_on }} · {{ kinds[item.kind] }} ·
          {{ states[item.state] }}
        </p>
        <p v-if="item.state === 'planned' && item.scheduled_on < today">
          已逾期，可以调整日期、暂停或取消。
        </p>
        <p class="plan-text">{{ item.note }}</p>
        <p v-if="item.source_title">关联：{{ item.source_title }}</p>
        <p v-if="!item.source_available">
          原来源已不可访问，请调整或解除关联后再完成。
        </p>
        <p>预计 {{ item.planned_minutes }} 分钟</p>
        <p v-if="item.completed_on" class="plan-text">
          本人记录 {{ item.completed_on }}：{{ item.completion_note }}
        </p>
        <div class="plan-actions">
          <RouterLink
            v-if="item.source_available && item.source_kind === 'course'"
            :to="{
              path: '/personal',
              query: {
                tab: 'courses',
                course: item.source_id!,
                unit: item.unit_id!,
              },
            }"
            >打开课程单元 →</RouterLink
          >
          <RouterLink
            v-if="item.source_available && item.source_kind === 'study'"
            to="/personal?tab=notes"
            >打开笔记与复习 →</RouterLink
          >
          <template v-if="mode === 'week'"
            ><template
              v-if="item.state === 'planned' || item.state === 'paused'"
            >
              <button :disabled="locked || dirty" @click="edit(item)">
                调整
              </button>
              <button
                v-if="item.state === 'planned'"
                :disabled="locked || dirty"
                @click="transition(item, 'paused')"
              >
                暂停</button
              ><button
                v-else
                :disabled="locked || dirty"
                @click="transition(item, 'planned')"
              >
                恢复安排
              </button>
              <button
                :disabled="locked || dirty || !item.source_available"
                @click="
                  finishing = item;
                  finishingNote = '';
                  finishedOn = today;
                "
              >
                记录完成
              </button>
              <button :disabled="locked || dirty" @click="removing = item">
                取消或移除
              </button> </template
            ><button
              v-else
              :disabled="locked || dirty"
              @click="removing = item"
            >
              移除记录
            </button></template
          >
        </div>
        <form
          v-if="finishing?.id === item.id"
          @submit.prevent="transition(item, 'completed')"
        >
          <label
            >完成日期<input
              v-model="finishedOn"
              type="date"
              required
              :disabled="locked" /></label
          ><label
            >完成收获<textarea
              v-model="finishingNote"
              required
              maxlength="4000"
              rows="3"
              :disabled="locked"
            />
          </label>
          <p>
            这条记录只说明本人完成了安排，不代表课程结课、正式成绩或掌握度。
          </p>
          <div class="plan-actions">
            <button :disabled="locked || !finishingNote.trim()">
              保存完成记录</button
            ><button
              type="button"
              :disabled="props.locked || busy"
              @click="
                finishing = undefined;
                finishingNote = '';
              "
            >
              返回安排
            </button>
          </div>
        </form>
      </article>
    </div>
    <button
      v-if="cursor && mode === 'week'"
      :disabled="locked"
      @click="refresh(true)"
    >
      加载更多安排</button
    ><button v-if="cursor && mode === 'home'" @click="emit('browse')">
      查看本周全部安排
    </button>
    <div v-if="removing" class="plan-card" role="alert">
      <p>
        处理“{{
          removing.title
        }}”？取消会保留内容和取消状态，移除会清空当前正文与关联。
      </p>
      <div class="plan-actions">
        <button
          v-if="removing.state === 'planned' || removing.state === 'paused'"
          :disabled="locked"
          @click="
            transition(removing, 'cancelled');
            removing = undefined;
          "
        >
          确认取消安排</button
        ><button :disabled="locked" @click="remove">确认移除记录</button
        ><button :disabled="busy" @click="removing = undefined">返回</button>
      </div>
    </div>
    <form
      v-if="mode === 'week' && overview"
      class="plan-card"
      @submit.prevent="saveReview"
    >
      <h3>这一周的回顾</h3>
      <p>回顾 {{ week }} 开始的一周，只有你可以看到。</p>
      <label
        >本周收获<textarea
          v-model="weekForm.highlights"
          maxlength="4000"
          rows="3"
          :disabled="locked"
        /></label
      ><label
        >遇到的困难<textarea
          v-model="weekForm.challenges"
          maxlength="4000"
          rows="3"
          :disabled="locked"
        /></label
      ><label
        >下周调整<textarea
          v-model="weekForm.adjustment"
          maxlength="4000"
          rows="3"
          :disabled="locked"
        />
      </label>
      <div class="plan-actions">
        <button
          :disabled="
            locked ||
            ![
              weekForm.highlights,
              weekForm.challenges,
              weekForm.adjustment,
            ].some((v) => v.trim())
          "
        >
          保存周回顾</button
        ><button
          type="button"
          :disabled="props.locked || busy"
          @click="resetDraft('week')"
        >
          放弃未保存修改</button
        ><button
          v-if="overview.review"
          type="button"
          :disabled="locked || dirty"
          @click="removingWeek = true"
        >
          移除周回顾
        </button>
      </div>
      <div v-if="removingWeek" role="alert">
        <p>移除这一周回顾的当前正文？历史备份仍遵循账号隐私处置政策。</p>
        <button type="button" :disabled="locked" @click="removeReview">
          确认移除周回顾</button
        ><button type="button" :disabled="busy" @click="removingWeek = false">
          保留周回顾
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.empty-art {
  max-width: 140px;
  margin: 1rem auto;
}
.week-planner {
  display: grid;
  gap: 1rem;
  min-width: 0;
  margin: 1.5rem 0;
}
.plan-actions {
  display: flex;
  align-items: end;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.plan-actions h2 {
  flex: 1;
}
.plan-card,
.plan-summary {
  display: grid;
  gap: 0.8rem;
  padding: 1.2rem;
  border: 1px solid var(--border, #dbe4ec);
  border-radius: 16px;
  background: var(--surface, #fff);
  min-width: 0;
}
.plan-list {
  display: grid;
  gap: 1rem;
}
.plan-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
  gap: 1rem;
}
.week-planner label {
  display: grid;
  gap: 0.4rem;
  min-width: 0;
}
.week-planner input,
.week-planner textarea,
.week-planner select {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  min-height: 44px;
  padding: 0.65rem;
  border: 1px solid var(--border, #cbd5e1);
  border-radius: 8px;
  background: var(--surface, #fff);
  color: inherit;
  font: inherit;
}
.week-planner button {
  min-height: 44px;
  padding: 0.6rem 0.9rem;
  border: 1px solid var(--border, #cbd5e1);
  border-radius: 8px;
  background: var(--surface, #fff);
  color: inherit;
  cursor: pointer;
  font: inherit;
  white-space: normal;
}
.week-planner button:disabled {
  opacity: 0.55;
  cursor: default;
}
.week-planner button:focus-visible,
.week-planner input:focus-visible,
.week-planner textarea:focus-visible,
.week-planner select:focus-visible {
  outline: 3px solid var(--primary, #2563eb);
  outline-offset: 3px;
}
.plan-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.week-planner p,
.week-planner h3,
.week-planner a {
  overflow-wrap: anywhere;
}
.notice {
  padding: 1rem;
  background: var(--surface-muted, #eff6ff);
  border-radius: 10px;
}
@media (max-width: 600px) {
  .plan-card,
  .plan-summary {
    padding: 0.85rem;
  }
  .plan-actions > * {
    max-width: 100%;
  }
}
</style>
