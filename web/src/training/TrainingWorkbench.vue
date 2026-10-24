<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, nextTick } from "vue";
import type { BusinessRequest } from "../session";
type Row = Record<string, any>;
const props = defineProps<{ request: BusinessRequest; embedded?: boolean }>();
const emit = defineEmits<{ course: [string]; tasks: []; phase2: [] }>();
const data = ref<Row | null>(null),
  message = ref(""),
  busy = ref(false),
  status = ref<HTMLElement>();
const from = ref(new Date().toISOString().slice(0, 10)),
  to = ref(new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10));
const lifetime = new AbortController();
const labels: Record<string, string> = {
  courses: "课程进度",
  tasks: "已发布任务",
  schedule: "最近课表",
  certificates: "本人证书",
  notifications: "站内通知",
  surveys: "待反馈课程",
};
const visibleModules = computed(() => (Object.entries(data.value?.modules || {}) as [string, Row][]).filter(([, module]) => module.status !== "disabled"));
const disabledModules = computed(() => Object.entries(data.value?.modules || {}).filter(([, module]: [string, any]) => module.status === "disabled").map(([name]) => labels[name] || name));
const time = (s: string) =>
  new Date(s).toLocaleString("zh-CN", { timeZoneName: "short" });
async function load() {
  if (busy.value) return;
  busy.value = true;
  try {
    const start = new Date(from.value + "T00:00:00Z").toISOString(),
      end = new Date(to.value + "T00:00:00Z").toISOString();
    const result = await props.request<Row>(
      "/training/workbench?from=" +
        encodeURIComponent(start) +
        "&to=" +
        encodeURIComponent(end),
      { signal: lifetime.signal },
    );
    if (lifetime.signal.aborted) return;
    data.value = result;
    message.value = "已读取本人学习数据；学习完成不等同掌握或结业。";
  } catch (e) {
    data.value = null;
    if (!lifetime.signal.aborted)
      message.value = e instanceof Error ? e.message : "读取失败";
  } finally {
    busy.value = false;
  }
}
async function refresh() {
  await load();
  await nextTick();
  status.value?.focus();
}
function source(name: string, r: Row) {
  if (name === "courses") emit("course", r.id);
  else if (name === "surveys") emit("course", r.course_id);
  else if (name === "tasks") emit("tasks");
  else emit("phase2");
}
onMounted(load);
const timer = setInterval(load, 15000);
onBeforeUnmount(() => {
  clearInterval(timer);
  lifetime.abort();
  data.value = null;
});
</script>
<template>
  <section class="workbench">
    <h3 v-if="!embedded">我的学习</h3>
    <p v-if="!embedded">继续课程，查看待完成任务，安排下一步学习。</p>
    <p ref="status" tabindex="-1" role="status" aria-live="polite">
      {{ message }}
    </p>
    <details class="workbench-range"><summary>调整课表日期范围</summary><form @submit.prevent="refresh">
      <label
        >课表起始日期（UTC）<input v-model="from" type="date" required /></label
      ><label
        >结束日期（UTC，不含当天，最多31天）<input
          v-model="to"
          type="date"
          required /></label
      ><button :disabled="busy">刷新本人数据</button>
    </form><p>日期范围按 UTC 查询，课次按本地时区显示。</p></details>
    <div v-if="data" class="modules">
      <section v-for="[name, module] in visibleModules" :key="name">
        <h4>{{ labels[name as string] }}</h4>
        <p v-if="module.status === 'disabled'">该模块尚未开放。</p>
        <p v-else-if="module.status === 'unavailable'">
          数据暂不可用，请刷新核查，不计算为已完成。
        </p>
        <template v-else
          ><p v-if="module.truncated">
            数据达到读取上限，列表和数量不代表完整范围，请进入来源核查。
          </p>
          <p v-if="!module.items.length">暂无当前可访问数据。</p>
          <p v-if="name === 'notifications'">
            仅显示已生成的站内通知；可进入来源核查后续通知。
          </p>
          <article v-for="r in module.items" :key="r.id">
            <h5>{{ r.title || r.number || r.message }}</h5>
            <p v-if="name === 'courses'">
              已完成必修课节 {{ r.completed }}/{{ r.required }}
              {{ r.completion === null ? "（无必修项，不判定完成）" : "" }}
            </p>
            <p v-else-if="name === 'tasks'">
              截止 {{ time(r.due_at) }} ·
              {{
                r.status === "course_complete"
                  ? "课程必修课节已完成"
                  : r.status === "pending"
                    ? "课程待学习"
                    : "请在来源核查完成状态"
              }}
            </p>
            <p v-else-if="name === 'schedule'">
              {{ time(r.start_at) }} 至 {{ time(r.end_at) }}
            </p>
            <p v-else-if="name === 'surveys'">
              {{ r.submitted ? "已提交" : "待反馈" }} ·
              {{ time(r.closes_at) }}结束
            </p>
            <p v-else>{{ r.status }}</p>
            <button @click="source(name as string, r)">进入来源</button>
          </article></template
        >
      </section>
    </div>
    <details v-if="disabledModules.length"><summary>更多功能</summary><p>当前尚未开放：{{ disabledModules.join('、') }}。</p></details>
  </section>
</template>
<style scoped>
.modules {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
  gap: 1rem;
}
.modules > section {
  border: 1px solid #d4dae2;
  border-radius: 0.6rem;
  padding: 1rem;
  min-width: 0;
  overflow-wrap: anywhere;
}
.modules article {
  border-top: 1px solid #e1e5ec;
  padding-block: 0.5rem;
}
.workbench label {
  display: block;
  margin-block: 0.5rem;
}
.workbench input {
  max-width: 100%;
  box-sizing: border-box;
}
.workbench button {
  max-width: 100%;
  white-space: normal;
}
</style>
