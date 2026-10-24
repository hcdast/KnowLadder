<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { ApiError, type BusinessRequest } from "../session";
import CourseMetadata from "./CourseMetadata.vue";
import type { paths } from "../api/schema";
type Catalogue = paths["/api/v1/training/discovery"]["get"]["responses"][200]["content"]["application/json"]["data"];
type Course = Catalogue["items"][number];
const props = defineProps<{ request: BusinessRequest; contextKey: string }>();
const emit = defineEmits<{ course: [id: string] }>();
const items = ref<Course[]>([]), loaded = ref(false), busy = ref(false), error = ref("");
const filters = reactive({ q: "", subject_id: "", format: "", sort: "newest" });
const applied = ref({ ...filters }), denied = ref(false);
const unapplied = computed(() => JSON.stringify(filters) !== JSON.stringify(applied.value));
const cursor = ref<string | null>(null), compareIds = ref<string[]>([]);
const formats: Record<string, string> = { text: "文本阅读", pdf: "PDF 文档", video: "视频", audio: "音频" };
let epoch = 0, controller = new AbortController(), timer = 0;
const subjects = computed(() => [...new Map(items.value.map(row => [row.subject_id, row.subject_name || "名称未提供的学科"])).entries()]);
const comparing = computed(() => items.value.filter(row => compareIds.value.includes(row.id)));
function compare(row: Course) {
  if (compareIds.value.includes(row.id)) compareIds.value = compareIds.value.filter(id => id !== row.id);
  else if (compareIds.value.length < 3) compareIds.value.push(row.id);
}
async function load(more = false, apply = false) {
  if (apply) applied.value = { ...filters };
  const token = ++epoch;
  controller.abort(); controller = new AbortController();
  if (!more) { items.value = []; cursor.value = null; }
  loaded.value = false; error.value = ""; busy.value = true;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(applied.value)) if (value && !(key === "sort" && value === "newest")) query.set(key, value);
  if (more && cursor.value) query.set("cursor", cursor.value);
  try {
    const data = await props.request<Catalogue>("/training/discovery" + (query.size ? "?" + query : ""), { signal: controller.signal });
    if (token !== epoch) return;
    // Each response is a new authorized snapshot. No cached comparison survives a failed read.
    items.value = [...new Map([...(more ? items.value : []), ...data.items].map(row => [row.id, row])).values()];
    cursor.value = data.next_cursor; loaded.value = true; denied.value = false;
    compareIds.value = compareIds.value.filter(id => items.value.some(row => row.id === id));
  } catch (e) {
    if (token !== epoch) return;
    items.value = []; cursor.value = null; compareIds.value = [];
    denied.value = e instanceof ApiError && [401,403,404].includes(e.status);
    error.value = e instanceof ApiError && [401, 403, 404].includes(e.status) ? "当前学习权限已变化，请重新确认身份。" : e instanceof Error ? e.message : "资源读取失败，请重试。";
  } finally { if (token === epoch) busy.value = false; }
}
function clear() { Object.assign(filters, { q: "", subject_id: "", format: "", sort: "newest" }); void load(false, true); }
watch(() => props.contextKey, () => { compareIds.value = []; clear(); }, { immediate: true, flush: "sync" });
timer = window.setInterval(() => { if (!busy.value && !denied.value) void load(); }, 30000);
onBeforeUnmount(() => { ++epoch; controller.abort(); window.clearInterval(timer); items.value = []; compareIds.value = []; });
</script>

<template>
  <section class="learning-discovery" aria-labelledby="discovery-title" :aria-busy="busy">
    <div class="discovery-heading"><div><h3 id="discovery-title">发现可学资源</h3><p>只展示当前组织中你本人有权学习的课程。选择资源后会再次核对授权。</p></div><button class="button secondary" :disabled="busy" @click="load()">刷新资源</button></div>
    <form class="discovery-filters" role="search" aria-label="筛选可学资源" @submit.prevent="load(false, true)">
      <label>名称或学科<input v-model="filters.q" type="search" maxlength="100" placeholder="输入课程名称或学科" :disabled="busy" /></label>
      <label>学科<select v-model="filters.subject_id" :disabled="busy"><option value="">全部可学学科</option><option v-if="filters.subject_id && !subjects.some(([id]) => id === filters.subject_id)" :value="filters.subject_id">所选学科（当前无结果）</option><option v-for="[key, name] in subjects" :key="key" :value="key">{{ name }}</option></select></label>
      <label>内容形态<select v-model="filters.format" :disabled="busy"><option value="">全部可用形态</option><option v-for="[key, name] in Object.entries(formats)" :key="key" :value="key">{{ name }}</option></select></label>
      <label>排序<select v-model="filters.sort" :disabled="busy"><option value="newest">创建较新在前</option><option value="oldest">创建较早在前</option></select></label>
      <div class="filter-actions"><button class="button" :disabled="busy">查找资源</button><button class="button secondary" type="button" :disabled="busy" @click="clear">清除筛选</button></div>
    </form>
    <p class="muted">查找作用于当前有权目录；学科选项来自已加载课程。资源会定期重新核对，刷新后从首批开始。</p>
    <p v-if="unapplied" role="status">筛选条件尚未应用，点击“查找资源”后生效；继续查找仍使用上次条件。</p>
    <p v-if="busy" role="status">正在核对可学资源…</p>
    <p v-else-if="error" role="alert">{{ error }}</p>
    <template v-else-if="loaded">
      <p v-if="!items.length && cursor" role="status">这一批没有可交付资源，可以继续查找后续课程。</p>
      <p v-else-if="!items.length" role="status">暂无匹配的当前可学课程，可清除筛选或联系教师确认安排。</p>
      <p v-else class="muted" role="status">已加载 {{ items.length }} 项匹配资源{{ cursor ? '，还有后续资源可查找。' : '，本次查找已结束。' }}</p>
      <div class="discovery-grid"><article v-for="row in items" :key="row.id"><p class="muted">{{ row.subject_name || '学科名称未提供' }} · 课程</p><h4>{{ row.title }}</h4><p>{{ row.lesson_count }} 个课节 · {{ row.required_lesson_count }} 个必修 · 版本 {{ row.version_no }}</p><p>{{ row.formats.map(key => formats[key]).join(' / ') }}</p><details><summary>查看目录预览</summary><ol><li v-for="(title, index) in row.lesson_titles" :key="index">{{ title }}</li></ol><p v-if="row.lesson_count > 5">这里展示前5个课节，完整内容在课程中查看。</p></details><div class="course-actions"><button class="button" @click="emit('course', row.id)">学习《{{ row.title }}》</button><button class="button secondary" :aria-label="'比较：' + row.title" :aria-pressed="compareIds.includes(row.id)" :disabled="compareIds.length >= 3 && !compareIds.includes(row.id)" @click="compare(row)">{{ compareIds.includes(row.id) ? '移出比较' : '加入比较' }}</button></div></article></div>
      <button v-if="cursor" class="button secondary" :disabled="busy" @click="load(true)">继续查找课程</button>
      <section v-if="comparing.length" class="comparison" aria-label="可学课程比较"><div class="discovery-heading"><h3>比较已选课程（{{ comparing.length }}/3）</h3><button class="button secondary" @click="compareIds = []">清空比较</button></div><div class="discovery-grid"><article v-for="row in comparing" :key="row.id"><h4>{{ row.title }}</h4><dl><dt>学科</dt><dd>{{ row.subject_name || '未提供' }}</dd><dt>内容形式</dt><dd>{{ row.formats.map(key=>formats[key]).join(' / ') }}</dd><dt>学习结构</dt><dd>{{ row.lesson_count }} 课节，其中 {{ row.required_lesson_count }} 个必修</dd><dt>版本</dt><dd>{{ row.version_no }}</dd><dt>最近更新</dt><dd>{{ row.updated_at.slice(0,10) }}</dd></dl><CourseMetadata v-if="row.metadata" :model-value="row.metadata" readonly /><p v-else>目标、难度、先修与预计时长尚未提供；课节数量不等于学习难度或实际投入。</p><button class="button secondary" @click="compare(row)">移除《{{ row.title }}》</button></article></div></section>
      <p class="muted">已加载数量不代表全站资源总量。比较只使用当前授权信息，不计算星级、热度或推荐分数。</p>
    </template>
    <a href="/explore">探索各阶段的学习方向 →</a>
  </section>
</template>

<style scoped>
.discovery-heading { display: flex; justify-content: space-between; gap: 1rem; align-items: start; } h3 { margin: .5rem 0; } p { line-height: 1.7; }
.discovery-filters { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: .8rem; align-items: end; margin: 1rem 0; }
label { display: grid; gap: .5rem; min-width: 0; } input, select { width: 100%; min-width: 0; min-height: 44px; box-sizing: border-box; font: inherit; padding: .6rem; }
.discovery-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; } article { border: 1px solid #c8d9e7; padding: 1rem; border-radius: 12px; overflow-wrap: anywhere; }
article h4 { font-size: 1.1rem; margin: .7rem 0; } article button { max-width: 100%; white-space: normal; text-align: start; } a { display: inline-block; margin-top: 1rem; color: #145d9b; }
.course-actions,.filter-actions { display: flex; gap: .6rem; flex-wrap: wrap; margin: .8rem 0; }.learning-discovery button,.learning-discovery summary { min-height:44px; }.learning-discovery summary{cursor:pointer;display:flex;align-items:center}.comparison{margin-top:1.5rem}.comparison dd{margin:0 0 .7rem;overflow-wrap:anywhere}.comparison dt{font-weight:600}.muted{overflow-wrap:anywhere}
@media (max-width: 850px) { .discovery-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 480px) { .discovery-filters, .discovery-grid { grid-template-columns: 1fr; } .discovery-heading { flex-direction: column; } }
</style>
