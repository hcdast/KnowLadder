<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { ApiError, type BusinessRequest } from "../session";
type Row = Record<string, any>;
const props = defineProps<{
  request: BusinessRequest;
  write: (path: string, body: unknown) => Promise<Row | undefined>;
  contextKey: string;
  blocked: boolean;
  recovered?: Row | null;
}>();
const emit = defineEmits<{
  dirty: [boolean];
  source: [{ kind: string; id: string }];
}>();
const rows = ref<Row[]>([]),
  cursor = ref<string | null>(null),
  unread = ref(false),
  error = ref(""),
  busy = ref(false),
  dirty = ref(false),
  denied = ref(false),
  notice = ref(false);
const preferences = reactive({
    revision: 0,
    question: true,
    feedback: true,
    meetup: true,
  }),
  locked = computed(() => props.blocked || busy.value);
let epoch = 0,
  alive = true,
  controller = new AbortController();
watch(dirty, (v) => emit("dirty", v), { flush: "sync" });
watch(
  () => props.recovered,
  (v) => {
    if (v) notice.value = true;
  },
);
function failure(e: unknown) {
  error.value = e instanceof Error ? e.message : "通知读取失败";
  if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
    denied.value = true;
    rows.value = [];
    cursor.value = null;
    Object.assign(preferences, {
      revision: 0,
      question: true,
      feedback: true,
      meetup: true,
    });
    dirty.value = false;
  }
}
async function load(more = false) {
  if (!alive || locked.value) return;
  busy.value = true;
  error.value = "";
  const token = epoch;
  try {
    const q = new URLSearchParams({ unread: String(unread.value) });
    if (more && cursor.value) q.set("cursor", cursor.value);
    const data = await props.request<Row>("/training/growth/inbox?" + q, {
      signal: controller.signal,
    });
    if (!alive || token !== epoch) return;
    rows.value = more
      ? [
          ...new Map(
            [...rows.value, ...data.items].map((r) => [r._id, r]),
          ).values(),
        ]
      : data.items;
    cursor.value = data.next_cursor;
    if (!dirty.value) {
      const p = await props.request<Row>("/training/growth/preferences", {
        signal: controller.signal,
      });
      if (!alive || token !== epoch) return;
      Object.assign(preferences, p);
    }
    denied.value = false;
  } catch (e) {
    if (token === epoch) {
      rows.value = [];
      failure(e);
    }
  } finally {
    if (alive && token === epoch) busy.value = false;
  }
}
async function write(path: string, body: Row) {
  if (locked.value) return;
  busy.value = true;
  error.value = "";
  const token = epoch;
  let saved = false;
  try {
    const result = await props.write(path, body);
    if (!alive || token !== epoch) return;
    if (result) {
      dirty.value = false;
      saved = true;
    }
  } catch (e) {
    if (token === epoch) failure(e);
  } finally {
    if (alive && token === epoch) busy.value = false;
  }
  if (saved && alive && token === epoch) await load();
}
async function recheck(row: Row) {
  if (locked.value || dirty.value) return;
  busy.value = true;
  const token = epoch;
  try {
    if (row.target.kind === "question")
      await props.request("/training/studio/questions/" + row.target.id, {
        signal: controller.signal,
      });
    else if (row.target.kind === "work")
      await props.request("/training/tasks/" + row.target.id + "/coursework", {
        signal: controller.signal,
      });
    else
      await props.request("/training/studio/meetups/" + row.target.id, {
        signal: controller.signal,
      });
    if (alive && token === epoch) emit("source", row.target);
  } catch (e) {
    if (token === epoch) {
      rows.value = [];
      failure(e);
    }
  } finally {
    if (alive && token === epoch) busy.value = false;
  }
}
async function readConfirmed() {
  if (locked.value) return;
  dirty.value = false;
  notice.value = false;
  await load();
}
watch(
  () => props.contextKey,
  () => {
    ++epoch;
    controller.abort();
    controller = new AbortController();
    rows.value = [];
    cursor.value = null;
    dirty.value = false;
    denied.value = false;
    busy.value = false;
    notice.value = false;
    Object.assign(preferences, {
      revision: 0,
      question: true,
      feedback: true,
      meetup: true,
    });
    void load();
  },
  { immediate: true },
);
const timer = window.setInterval(() => {
  if (!denied.value && !locked.value) void load();
}, 30000);
onBeforeUnmount(() => {
  alive = false;
  ++epoch;
  controller.abort();
  window.clearInterval(timer);
  rows.value = [];
  emit("dirty", false);
});
</script>
<template>
  <section class="growth-inbox" aria-label="学习通知" :aria-busy="busy">
    <h4>学习通知</h4>
    <p>
      答疑、作品反馈与共学动态。仅站内展示，打开时重新核对来源；偏好只影响之后的新通知。
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="busy" role="status">正在核对通知…</p>
    <details v-if="notice">
      <summary>原通知操作已确认</summary>
      <p>可继续保留当前偏好草稿，或明确清除草稿并重读。</p>
      <button :disabled="locked" @click="readConfirmed">
        清除偏好草稿并重读
      </button>
    </details>
    <div class="actions">
      <label
        ><input
          v-model="unread"
          type="checkbox"
          :disabled="locked || dirty"
          @change="load()"
        />只看未读</label
      ><button :disabled="locked" @click="load()">刷新学习通知</button>
    </div>
    <form
      @submit.prevent="
        write('/training/growth/preferences', {
          expected_revision: preferences.revision,
          question: preferences.question,
          feedback: preferences.feedback,
          meetup: preferences.meetup,
        })
      "
      @change="dirty = true"
    >
      <fieldset :disabled="locked">
        <legend>接收哪些学习动态</legend>
        <label
          ><input
            v-model="preferences.question"
            type="checkbox"
          />答疑动态</label
        ><label
          ><input
            v-model="preferences.feedback"
            type="checkbox"
          />作品反馈</label
        ><label
          ><input v-model="preferences.meetup" type="checkbox" />共学动态</label
        >
      </fieldset>
      <button :disabled="locked || !dirty">保存通知偏好</button>
    </form>
    <p v-if="!busy && !rows.length">当前没有可读通知。</p>
    <article v-for="row in rows" :key="row._id">
      <p>
        {{ row.message }} · {{ row.read_at ? "已读" : "未读" }} ·
        {{ new Date(row.created_at).toLocaleString() }}
      </p>
      <div class="actions">
        <button :disabled="locked || dirty" @click="recheck(row)">
          查看通知来源</button
        ><button
          v-if="!row.read_at"
          :disabled="locked || dirty"
          @click="
            write('/training/growth/inbox/' + row._id + '/read', {
              expected_revision: row.revision,
            })
          "
        >
          标记这条已读
        </button>
      </div>
    </article>
    <button v-if="cursor" :disabled="locked || dirty" @click="load(true)">
      继续读取通知
    </button>
  </section>
</template>
<style scoped>
.growth-inbox {
  min-width: 0;
  overflow-wrap: anywhere;
}
.growth-inbox article {
  border: 1px solid #c8d9e7;
  border-radius: 12px;
  padding: 1rem;
  margin: 1rem 0;
}
.growth-inbox button {
  min-height: 44px;
  max-width: 100%;
  white-space: normal;
  font: inherit;
  padding: 0.5rem 0.8rem;
}
.actions {
  display: flex;
  gap: 0.7rem;
  flex-wrap: wrap;
  align-items: center;
}
.growth-inbox fieldset {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  min-width: 0;
}
.growth-inbox label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 44px;
}
.growth-inbox input {
  min-width: 22px;
  min-height: 22px;
}
</style>
