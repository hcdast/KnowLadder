<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";
import {
  RouterLink,
  isNavigationFailure,
  NavigationFailureType,
  useRoute,
  useRouter,
} from "vue-router";
import { ApiError, type GlobalRequest } from "../session";
import SiteImage from "../site/SiteImage.vue";
import { courseCover, siteMedia } from "../site/media";
import type { components } from "../api/schema";
type S = components["schemas"];
type Course = S["LifelongCourse"];
const props = defineProps<{
  request: GlobalRequest;
  locked: boolean;
  mode: "continue" | "catalog";
  write: (
    path: string,
    body: unknown,
  ) => Promise<S["LifelongOperation"] | undefined>;
}>();
const emit = defineEmits<{ dirty: [value: boolean]; browse: [] }>();
const route = useRoute(),
  router = useRouter();
const items = ref<Course[]>([]),
  detail = ref<S["LifelongCourseDetail"]>();
const busy = ref(false),
  error = ref(""),
  unavailable = ref(false),
  saved = ref("");
const filters = reactive({ q: "", stage: "", field: "" });
const order = ref("catalog"),
  compareIds = ref<string[]>([]);
const displayed = computed(() => {
  const list = [...items.value];
  if (order.value === "minutes")
    list.sort(
      (a, b) =>
        a.minutes - b.minutes || a.title.localeCompare(b.title, "zh-CN"),
    );
  if (order.value === "title")
    list.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  return list;
});
const comparing = computed(() =>
  items.value.filter((c) => compareIds.value.includes(c.id)),
);
function toggleCompare(course: Course) {
  if (compareIds.value.includes(course.id))
    compareIds.value = compareIds.value.filter((id) => id !== course.id);
  else if (compareIds.value.length < 3) compareIds.value.push(course.id);
}
const stages: Record<string, string> = {
  early: "启蒙成长",
  school: "学校学习",
  higher: "大学与专业",
  career: "职业发展",
  life: "兴趣生活",
  senior: "银龄学习",
};
const fields: Record<string, string> = {
  language: "语言与阅读",
  science: "数理与科学",
  humanities: "人文与社会",
  arts: "艺术与创作",
  health: "运动与健康素养",
  digital: "数字与AI素养",
  career: "职业技能",
  life: "生活与家庭",
};
const form = reactive({ answer: -1, practice: "", reflection: "" });
const dirty = computed(
  () => form.answer !== -1 || !!form.practice || !!form.reflection,
);
watch(dirty, (v) => emit("dirty", v), { flush: "sync" });
const life = new AbortController();
let epoch = 0,
  alive = true;
const activeUnit = computed(() => {
  if (props.mode !== "catalog" || !detail.value?.learning || unavailable.value)
    return;
  const unit = detail.value.units.find((u) => u.id === route.query.unit);
  if (
    unit &&
    (detail.value.learning.completed_unit_ids.includes(unit.id) ||
      detail.value.learning.next_unit_id === unit.id)
  )
    return unit;
});
const alreadyCompleted = computed(
  () =>
    !!activeUnit.value &&
    !!detail.value?.learning?.completed_unit_ids.includes(activeUnit.value.id),
);
const joined = computed(() => items.value.filter((c) => c.learning));
const continuing = computed(() =>
  joined.value.filter((c) => c.learning?.state !== "completed"),
);
const heading = ref<HTMLElement>();
function resetDraft() {
  Object.assign(form, { answer: -1, practice: "", reflection: "" });
}
async function refresh() {
  const ticket = ++epoch;
  busy.value = true;
  error.value = "";
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) query.set(k, v);
  try {
    // Home always shows all joined courses; catalog filters are local to catalog mode.
    const list = await props.request<S["LifelongCoursePage"]>(
      `/personal/courses${props.mode === "catalog" && query.size ? `?${query}` : ""}`,
      { signal: life.signal },
    );
    const courseId =
      typeof route.query.course === "string" ? route.query.course : "";
    const course = courseId
      ? await props.request<S["LifelongCourseDetail"]>(
          `/personal/courses/${encodeURIComponent(courseId)}`,
          { signal: life.signal, notFound: "lookup" },
        )
      : undefined;
    if (!alive || ticket !== epoch) return;
    items.value = list.items;
    compareIds.value = compareIds.value.filter((id) =>
      list.items.some((c) => c.id === id),
    );
    detail.value = course;
    unavailable.value = false;
  } catch (cause) {
    if (!alive || ticket !== epoch) return;
    // Do not leave stale course bodies visible after a failed permission/version read.
    detail.value = undefined;
    items.value = [];
    compareIds.value = [];
    unavailable.value = true;
    error.value =
      cause instanceof Error ? cause.message : "课程暂时无法读取，请重试。";
    if (cause instanceof ApiError && [401, 403, 404].includes(cause.status))
      resetDraft();
  } finally {
    if (alive && ticket === epoch) busy.value = false;
  }
}
async function openCourse(course: Course, unit?: string | null) {
  const moved = await router.push({
    path: "/personal",
    query: { tab: "courses", course: course.id, ...(unit ? { unit } : {}) },
  });
  if (!moved || isNavigationFailure(moved, NavigationFailureType.duplicated)) {
    emit("browse");
    await nextTick();
    heading.value?.focus();
  }
}
async function catalog() {
  const moved = await router.push({
    path: "/personal",
    query: { tab: "courses" },
  });
  if (!moved || isNavigationFailure(moved, NavigationFailureType.duplicated))
    emit("browse");
}
async function enroll() {
  const course = detail.value;
  if (!course || props.locked || busy.value) return;
  const result = await props.write(`/personal/courses/${course.id}/enroll`, {
    version: course.version,
  });
  if (result && alive) {
    await refresh();
    saved.value = "已加入学习，可以从第一个单元开始。";
  }
}
async function complete() {
  const course = detail.value,
    unit = activeUnit.value,
    learning = course?.learning;
  if (
    !course ||
    !unit ||
    !learning ||
    props.locked ||
    busy.value ||
    alreadyCompleted.value
  )
    return;
  const result = await props.write(
    `/personal/courses/${course.id}/units/${unit.id}/complete`,
    {
      version: course.version,
      goal_id: learning.goal_id,
      revision: learning.revision,
      answer: form.answer,
      practice: form.practice,
      reflection: form.reflection,
    },
  );
  if (result && alive) {
    resetDraft();
    await refresh();
    saved.value = "本单元已完成，实践记录与回顾已保存到学习与实践。";
    await nextTick();
    heading.value?.focus();
  }
}
function clearFilters() {
  Object.assign(filters, { q: "", stage: "", field: "" });
  void refresh();
}
watch(
  () => [route.query.course, route.query.unit],
  () => {
    resetDraft();
    saved.value = "";
    void refresh();
  },
);
watch(
  () => props.mode,
  () => void refresh(),
);
onMounted(() => void refresh());
onBeforeUnmount(() => {
  alive = false;
  ++epoch;
  life.abort();
});
defineExpose({ refresh, resetDraft });
</script>

<template>
  <section
    class="course-center"
    aria-labelledby="course-center-heading"
    :aria-busy="busy"
  >
    <header class="course-heading">
      <div>
        <p class="eyebrow">从内容到行动</p>
        <h2 id="course-center-heading" ref="heading" tabindex="-1">
          {{
            mode === "continue"
              ? "继续我的学习"
              : detail
                ? detail.title
                : "内容中心"
          }}
        </h2>
      </div>
      <button v-if="mode === 'continue'" @click="catalog">浏览原创课程</button>
      <button v-else-if="detail || route.query.course" @click="catalog">
        返回内容中心
      </button>
    </header>
    <p v-if="error" class="notice error" role="alert">
      {{ error }}
      <button :disabled="busy" @click="refresh">重新读取课程</button>
    </p>
    <p v-if="busy" role="status">正在读取课程与学习进度…</p>
    <p v-if="saved" class="notice" role="status">{{ saved }}</p>
    <template v-if="mode === 'continue' && !unavailable">
      <SiteImage
        v-if="!joined.length && !busy && !error"
        class="empty-art"
        :src="siteMedia.emptyCourse"
        alt="还没有加入课程"
        :width="800"
        :height="800"
      />
      <p v-if="!joined.length && !busy">
        还没有加入课程。选一门感兴趣的原创微课程，按自己的节奏阅读、实践和回顾。
      </p>
      <div class="course-grid">
        <article
          v-for="course in continuing"
          :key="course.id"
          class="course-card"
        >
          <SiteImage
            v-if="courseCover(course.id)"
            class="course-cover"
            :src="courseCover(course.id)!"
            alt=""
            :width="1200"
            :height="800"
          />
          <span>{{ stages[course.stage] }} · {{ fields[course.field] }}</span>
          <h3>{{ course.title }}</h3>
          <p>
            已完成 {{ course.learning!.completed_unit_ids.length }} /
            {{ course.unit_count }} 个单元
          </p>
          <progress
            :value="course.learning!.completed_unit_ids.length"
            :max="course.unit_count"
            :aria-label="`${course.title}学习进度`"
          />
          <button
            :disabled="busy || locked"
            @click="openCourse(course, course.learning!.next_unit_id)"
          >
            继续学习
          </button>
        </article>
      </div>
      <p v-if="joined.length && !continuing.length">
        已完成当前加入的课程，可以重读课程或探索新主题。
      </p>
    </template>
    <template v-else-if="mode === 'catalog'">
      <template v-if="!route.query.course">
        <p>
          六门原创微课程，覆盖不同人生阶段。方向可跨阶段选择，无需提供出生日期；每门课程包含阅读、练习、实践与回顾。
        </p>
        <form class="course-filters" @submit.prevent="refresh">
          <label
            >搜索课程<input
              v-model="filters.q"
              maxlength="120"
              type="search"
              placeholder="标题、主题或学习目标"
          /></label>
          <label
            >学习方向<select v-model="filters.stage">
              <option value="">全部方向</option>
              <option v-for="(label, key) in stages" :key="key" :value="key">
                {{ label }}
              </option>
            </select></label
          >
          <label
            >学习领域<select v-model="filters.field">
              <option value="">全部领域</option>
              <option v-for="(label, key) in fields" :key="key" :value="key">
                {{ label }}
              </option>
            </select></label
          >
          <div class="course-actions">
            <button :disabled="busy" type="submit">筛选课程</button
            ><button :disabled="busy" type="button" @click="clearFilters">
              清除筛选
            </button>
          </div>
        </form>
        <label class="course-order"
          >当前目录排序<select v-model="order">
            <option value="catalog">目录顺序</option>
            <option value="minutes">预计投入从少到多</option>
            <option value="title">课程名称</option>
          </select></label
        >
        <section
          v-if="comparing.length"
          class="course-compare"
          aria-label="课程比较"
        >
          <div class="course-actions">
            <h3>比较已选课程（最多3门）</h3>
            <button @click="compareIds = []">清空比较</button>
          </div>
          <p>按目标、先修和编辑预计投入选择适合的课程；不代表学习效果排名。</p>
          <div class="course-grid">
            <article v-for="c in comparing" :key="c.id" class="course-card">
              <h4>{{ c.title }}</h4>
              <dl class="course-meta">
                <dt>适用对象</dt>
                <dd>{{ c.audience }}</dd>
                <dt>学习目标</dt>
                <dd>{{ c.outcome }}</dd>
                <dt>先修要求</dt>
                <dd>{{ c.prerequisites }}</dd>
                <dt>预计投入</dt>
                <dd>{{ c.minutes }}分钟 / {{ c.unit_count }}单元</dd>
                <dt>准备材料</dt>
                <dd>{{ c.materials }}</dd>
                <dt>学习支持</dt>
                <dd>{{ c.support }}</dd>
                <dt>版本与来源</dt>
                <dd>
                  v{{ c.version }} · {{ c.updated_on }} · {{ c.provider }}
                </dd>
              </dl>
              <button :disabled="busy || locked" @click="openCourse(c)">
                了解这门课程
              </button>
            </article>
          </div>
        </section>
        <SiteImage
          v-if="!busy && !error && !items.length"
          class="empty-art"
          :src="siteMedia.emptyCourse"
          alt="暂无符合条件的课程"
          :width="800"
          :height="800"
        />
        <p v-if="!busy && !error && !items.length" role="status">
          暂无符合条件的课程。试试其他关键词，或清除筛选查看全部原创课程。
        </p>
        <p v-else-if="!error" role="status">共 {{ items.length }} 门课程</p>
        <div class="course-grid">
          <article
            v-for="course in displayed"
            :key="course.id"
            class="course-card"
          >
            <SiteImage
              v-if="courseCover(course.id)"
              class="course-cover"
              :src="courseCover(course.id)!"
              alt=""
              :width="1200"
              :height="800"
            />
            <span class="tag"
              >{{ stages[course.stage] }} · {{ fields[course.field] }}</span
            >
            <h3>{{ course.title }}</h3>
            <p>{{ course.summary }}</p>
            <p>
              {{ course.unit_count }} 个单元 · 编辑预计
              {{ course.minutes }} 分钟 · {{ course.level }} · 阅读与实践
            </p>
            <p v-if="course.learning">
              {{
                course.learning.state === "completed"
                  ? "已完成课程"
                  : `已完成 ${course.learning.completed_unit_ids.length}/${course.unit_count} 个单元`
              }}
            </p>
            <button :disabled="busy || locked" @click="openCourse(course)">
              查看课程详情
            </button>
            <button
              :aria-label="`比较：${course.title}`"
              :aria-pressed="compareIds.includes(course.id)"
              :disabled="
                busy ||
                locked ||
                (!compareIds.includes(course.id) && compareIds.length >= 3)
              "
              @click="toggleCompare(course)"
            >
              {{ compareIds.includes(course.id) ? "移出比较" : "加入比较" }}
            </button>
            <button
              v-if="course.learning?.next_unit_id"
              :disabled="busy || locked"
              @click="openCourse(course, course.learning.next_unit_id)"
            >
              继续学习
            </button>
          </article>
        </div>
      </template>
      <article v-else-if="detail && !unavailable" class="course-detail">
        <SiteImage
          v-if="!activeUnit && courseCover(detail.id)"
          class="detail-cover"
          :src="courseCover(detail.id)!"
          alt=""
          :width="1200"
          :height="800"
        />
        <p>
          {{ stages[detail.stage] }} · {{ fields[detail.field] }} ·
          {{ detail.unit_count }} 单元 · 编辑预计 {{ detail.minutes }} 分钟
        </p>
        <p>{{ detail.summary }}</p>
        <dl class="course-meta">
          <dt>适用对象</dt>
          <dd>{{ detail.audience }}</dd>
          <dt>先修要求</dt>
          <dd>{{ detail.prerequisites }}</dd>
          <dt>学习目标</dt>
          <dd>{{ detail.outcome }}</dd>
          <dt>准备材料</dt>
          <dd>{{ detail.materials }}</dd>
          <dt>来源与版本</dt>
          <dd>
            {{ detail.provider }} · {{ detail.source }} · v{{
              detail.version
            }}
            · 更新于 {{ detail.updated_on }}
          </dd>
          <dt>完成方式</dt>
          <dd>{{ detail.completion }}</dd>
        </dl>
        <p class="course-support">{{ detail.support }}</p>
        <div class="course-actions">
          <button
            v-if="!detail.learning"
            :disabled="locked || busy"
            @click="enroll"
          >
            加入我的学习
          </button>
          <button
            v-else-if="detail.learning.next_unit_id && !activeUnit"
            :disabled="locked || busy"
            @click="openCourse(detail, detail.learning.next_unit_id)"
          >
            开始 / 继续学习
          </button>
          <p v-if="detail.learning" role="status">
            {{
              detail.learning.state === "completed"
                ? "课程已完成，可重读各单元。"
                : `已完成 ${detail.learning.completed_unit_ids.length}/${detail.unit_count} 个单元`
            }}
          </p>
        </div>
        <h3>课程目录</h3>
        <ol class="unit-list">
          <li v-for="unit in detail.units" :key="unit.id">
            <button
              :disabled="
                locked ||
                busy ||
                !detail.learning ||
                (!detail.learning.completed_unit_ids.includes(unit.id) &&
                  detail.learning.next_unit_id !== unit.id)
              "
              :aria-current="activeUnit?.id === unit.id ? 'step' : undefined"
              @click="openCourse(detail, unit.id)"
            >
              {{ unit.title }} · 约 {{ unit.minutes }} 分钟
              <span v-if="detail.learning?.completed_unit_ids.includes(unit.id)"
                >· 已完成</span
              ><span v-else-if="detail.learning?.next_unit_id === unit.id"
                >· 下一单元</span
              >
            </button>
          </li>
        </ol>
        <p v-if="route.query.unit && !activeUnit">
          请先加入课程并按目录顺序学习。已完成单元可以随时重读。
        </p>
        <section
          v-if="activeUnit"
          :key="activeUnit.id"
          class="unit-reading"
          aria-labelledby="unit-heading"
        >
          <h3 id="unit-heading">{{ activeUnit.title }}</h3>
          <RouterLink
            :to="{
              path: '/personal',
              query: { tab: 'notes', course: detail.id, unit: activeUnit.id },
            }"
            >记笔记 / 收藏并安排复习 →</RouterLink
          >
          <p><strong>本单元目标：</strong>{{ activeUnit.objective }}</p>
          <p v-for="paragraph in activeUnit.paragraphs" :key="paragraph">
            {{ paragraph }}
          </p>
          <h4>动手试一试</h4>
          <ol>
            <li v-for="step in activeUnit.steps" :key="step">{{ step }}</li>
          </ol>
          <p>{{ activeUnit.practice }}</p>
          <p v-if="alreadyCompleted" class="notice">
            本单元已完成。原实践记录与回顾保留在“学习与实践”，重读不会重复计入完成。
          </p>
          <form v-else class="unit-form" @submit.prevent="complete">
            <fieldset :disabled="locked || busy">
              <legend>{{ activeUnit.question }}</legend>
              <label
                v-for="(option, index) in activeUnit.options"
                :key="option"
                class="choice"
                ><input
                  v-model="form.answer"
                  type="radio"
                  :value="index"
                  name="course-answer"
                  required
                />{{ option }}</label
              >
            </fieldset>
            <details>
              <summary>查看思路提示</summary>
              <p>{{ activeUnit.explanation }}</p>
            </details>
            <label
              >我的实践记录<textarea
                v-model="form.practice"
                :disabled="locked || busy"
                required
                maxlength="2000"
                rows="5"
                :placeholder="activeUnit.practice"
              />
            </label>
            <label
              >我的学习回顾<textarea
                v-model="form.reflection"
                :disabled="locked || busy"
                required
                maxlength="1000"
                rows="3"
                placeholder="学到了什么？还有什么疑问，下一次如何改进？"
              />
            </label>
            <p>
              保存表示完成本单元的阅读与自述实践，不生成考试成绩或认证。预计时长不计作实际学习用时。
            </p>
            <button
              :disabled="
                locked ||
                busy ||
                form.answer < 0 ||
                !form.practice.trim() ||
                !form.reflection.trim()
              "
              type="submit"
            >
              保存并完成本单元
            </button>
          </form>
          <button
            v-if="alreadyCompleted && detail.learning?.next_unit_id"
            :disabled="locked || busy"
            @click="openCourse(detail, detail.learning.next_unit_id)"
          >
            学习下一单元
          </button>
          <p
            v-if="alreadyCompleted && detail.learning?.state === 'completed'"
            class="notice"
          >
            你已完成全部单元。可以回顾记录、继续实践，或返回内容中心选学新主题。
          </p>
        </section>
      </article>
    </template>
  </section>
</template>

<style scoped>
.course-cover {
  border-radius: 10px;
  margin-bottom: 1rem;
}
.detail-cover {
  max-width: 420px;
  border-radius: 12px;
  margin-bottom: 1.2rem;
}
.empty-art {
  max-width: 160px;
  margin: 1rem auto;
}
.course-order {
  display: grid;
  gap: 0.4rem;
  max-width: 24rem;
  margin: 1rem 0;
}
.course-order select {
  min-height: 44px;
  padding: 0.65rem;
  font: inherit;
  border: 1px solid var(--border, #dbe4ec);
  border-radius: 8px;
  max-width: 100%;
  background: var(--surface, #fff);
  color: inherit;
}
.course-compare {
  margin: 1rem 0;
  padding: 1rem;
  border: 1px solid var(--border, #dbe4ec);
  border-radius: 16px;
  min-width: 0;
}
.course-compare h3 {
  flex: 1;
}
.course-compare dd {
  overflow-wrap: anywhere;
}
.course-center {
  margin: 1.5rem 0;
  color: #183349;
  overflow-wrap: anywhere;
}
.course-heading,
.course-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
  justify-content: space-between;
}
.course-heading h2 {
  margin: 0.3rem 0 1rem;
}
.course-heading .eyebrow {
  margin: 0;
}
.course-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 270px), 1fr));
  gap: 1rem;
}
.course-card,
.course-detail {
  border: 1px solid #ccdce8;
  border-radius: 14px;
  padding: 1.25rem;
  background: #fff;
}
.course-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.6rem;
}
.course-card h3,
.course-card p {
  margin: 0;
}
p,
li,
dd {
  line-height: 1.85;
}
.course-card button {
  margin-top: auto;
}
progress {
  width: 100%;
  accent-color: #1263b0;
}
.course-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  margin: 1.4rem 0;
  align-items: end;
  padding: 1rem;
  background: #f1f6fa;
  border-radius: 12px;
}
label {
  display: grid;
  gap: 0.45rem;
  flex: 1 1 160px;
  min-width: 0;
}
input,
select,
textarea {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  width: 100%;
  padding: 0.65rem;
  border: 1px solid #aebfce;
  border-radius: 7px;
  background: white;
  font: inherit;
  color: inherit;
}
button {
  min-height: 44px;
  padding: 0.65rem 1rem;
  background: #1263b0;
  border: 1px solid #1263b0;
  border-radius: 8px;
  color: white;
  font: inherit;
  cursor: pointer;
  max-width: 100%;
}
button:disabled {
  opacity: 0.6;
  cursor: default;
}
:is(button, input, select, textarea, summary):focus-visible {
  outline: 3px solid #1263b0;
  outline-offset: 3px;
}
.course-meta {
  display: grid;
  grid-template-columns: 6rem minmax(0, 1fr);
  gap: 0.65rem 1rem;
}
dt {
  font-weight: 650;
}
dd {
  margin: 0;
}
.course-support {
  padding: 1rem;
  background: #eef6fc;
  border-left: 3px solid #1263b0;
}
.unit-list {
  padding-left: 1.4rem;
}
.unit-list li {
  margin: 0.5rem 0;
}
.unit-list button {
  text-align: left;
  background: #edf5fc;
  color: #174f7d;
  border-color: #b8d4e9;
}
.unit-list button[aria-current] {
  border-width: 2px;
  font-weight: 650;
}
.unit-reading {
  border-top: 1px solid #ccdce8;
  margin-top: 1.5rem;
  padding-top: 1rem;
  max-width: 75ch;
}
.unit-form {
  display: grid;
  gap: 1.2rem;
}
fieldset {
  min-width: 0;
  margin: 0;
  border: 1px solid #ccdce8;
  border-radius: 8px;
  padding: 1rem;
}
legend {
  font-weight: 650;
}
.choice {
  display: flex;
  align-items: center;
  min-height: 44px;
  margin: 0.4rem 0;
}
.choice input {
  width: auto;
  flex: 0 0 auto;
}
.notice {
  padding: 0.9rem;
  background: #eef6fc;
}
.error {
  background: #fff0ee;
  color: #85291c;
}
@media (max-width: 480px) {
  .course-meta {
    grid-template-columns: 1fr;
    gap: 0.2rem;
  }
  dd {
    margin-bottom: 0.7rem;
  }
  .course-card,
  .course-detail {
    padding: 0.9rem;
  }
}
</style>
