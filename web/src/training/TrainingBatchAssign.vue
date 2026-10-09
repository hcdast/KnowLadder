<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from "vue";
import { ApiError, type BusinessRequest } from "../session";
type Row = Record<string, any>;
type Item = {
  class_id: string;
  key: string;
  hash: string;
  status: "ready" | "unknown" | "assigned" | "already_assigned" | "failed";
  code?: string;
};
const props = defineProps<{
  courseId: string;
  userId: string;
  orgId: string;
  classes: Row[];
  request: BusinessRequest;
  blocked: boolean;
}>();
const emit = defineEmits<{ dirty: [boolean]; unknown: [boolean] }>();
const ids = ref<string[]>([]),
  preview = ref<Row | null>(null),
  items = ref<Item[]>([]),
  busy = ref(false),
  message = ref(""),
  storageBlocked = ref(false),
  status = ref<HTMLElement>();
const lifetime = new AbortController();
const storageKey =
  "kl-batch-assign:" + props.userId + ":" + props.orgId + ":" + props.courseId;
const locked = computed(
  () =>
    busy.value ||
    props.blocked ||
    storageBlocked.value ||
    items.value.length > 0,
);
async function notify(text: string) {
  message.value = text;
  await nextTick();
  status.value?.focus();
}
function persist() {
  try {
    if (items.value.length)
      sessionStorage.setItem(storageKey, JSON.stringify(items.value));
    else sessionStorage.removeItem(storageKey);
  } catch {
    storageBlocked.value = true;
    throw new Error("无法保存恢复编号，操作已停止。");
  }
  emit(
    "dirty",
    items.value.some((x) => ["ready", "unknown", "failed"].includes(x.status)),
  );
  emit(
    "unknown",
    items.value.some((x) => x.status === "unknown"),
  );
}
async function hash(class_id: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify({ class_id })),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
async function check() {
  if (locked.value) return;
  busy.value = true;
  try {
    preview.value = await props.request<Row>(
      "/training/courses/" + props.courseId + "/assignments/preview",
      {
        method: "POST",
        body: { class_ids: ids.value },
        signal: lifetime.signal,
      },
    );
    await notify("预检查完成。执行时会重新校验权限。");
  } catch (e) {
    preview.value = null;
    await notify(e instanceof Error ? e.message : "预检查失败");
  } finally {
    busy.value = false;
  }
}
async function begin() {
  if (!preview.value || locked.value) return;
  busy.value = true;
  try {
    items.value = await Promise.all(
      preview.value.items
        .filter((r: Row) => r.status === "ready")
        .map(async (r: Row) => ({
          class_id: r.class_id,
          key: crypto.randomUUID(),
          hash: await hash(r.class_id),
          status: "ready" as const,
        })),
    );
    persist();
  } catch (e) {
    await notify(e instanceof Error ? e.message : "准备失败");
  } finally {
    busy.value = false;
  }
  if (!storageBlocked.value) await resume();
}
async function resume() {
  if (
    busy.value ||
    props.blocked ||
    storageBlocked.value ||
    items.value.some((x) => x.status === "unknown")
  )
    return;
  busy.value = true;
  try {
    for (const item of items.value) {
      if (item.status !== "ready") continue;
      if ((await hash(item.class_id)) !== item.hash)
        throw new Error("原请求摘要不一致，操作停止。");
      item.status = "unknown";
      persist();
      try {
        const r = await props.request<Row>(
          "/training/courses/" + props.courseId + "/assign",
          {
            method: "POST",
            body: { class_id: item.class_id },
            idempotencyKey: item.key,
            signal: lifetime.signal,
          },
        );
        item.status =
          r.status === "already_assigned" ? "already_assigned" : "assigned";
        persist();
      } catch (e) {
        if (
          e instanceof ApiError &&
          e.status < 500 &&
          ![401, 403, 404, 408].includes(e.status) &&
          e.code !== "IDEMPOTENCY_CONFLICT"
        ) {
          item.status = "failed";
          item.code = e.code;
          persist();
        }
        await notify(
          (e instanceof Error ? e.message : "连接中断") +
            "；后续班级已停止，请核查原编号。",
        );
        return;
      }
    }
    await notify("本批执行结束，请核对逐项结果。");
  } catch (e) {
    await notify(e instanceof Error ? e.message : "执行失败");
  } finally {
    busy.value = false;
  }
}
async function receipt(item: Item) {
  if (busy.value || storageBlocked.value) return;
  busy.value = true;
  try {
    const r = await props.request<Row>("/training/receipts/query", {
      method: "POST",
      body: { key: item.key },
      signal: lifetime.signal,
    });
    if (r.status === "confirmed") {
      if (
        r.result.course_id !== props.courseId ||
        r.result.class_id !== item.class_id
      )
        throw new Error("回执对象不匹配，保留原编号人工核查。");
      item.status =
        r.result.status === "already_assigned"
          ? "already_assigned"
          : "assigned";
      persist();
      await notify("该班级原请求已生效。其余班级需要显式继续。");
    } else await notify("尚未找到回执，可按原编号重试这一班。");
  } catch (e) {
    await notify(e instanceof Error ? e.message : "查询失败");
  } finally {
    busy.value = false;
  }
}
async function retry(item: Item) {
  if (
    item.status !== "unknown" ||
    busy.value ||
    props.blocked ||
    storageBlocked.value
  )
    return;
  busy.value = true;
  try {
    if ((await hash(item.class_id)) !== item.hash)
      throw new Error("摘要不一致。");
    const r = await props.request<Row>(
      "/training/courses/" + props.courseId + "/assign",
      {
        method: "POST",
        body: { class_id: item.class_id },
        idempotencyKey: item.key,
        signal: lifetime.signal,
      },
    );
    item.status =
      r.status === "already_assigned" ? "already_assigned" : "assigned";
    persist();
    await notify("原编号重试完成。");
  } catch (e) {
    await notify(e instanceof Error ? e.message : "重试失败");
  } finally {
    busy.value = false;
  }
}
function reset() {
  if (busy.value || items.value.some((x) => x.status === "unknown")) return;
  items.value = [];
  preview.value = null;
  persist();
  emit("dirty", false);
}
onMounted(() => {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (
      !Array.isArray(data) ||
      data.length > 20 ||
      new Set(data.map((x) => x.class_id)).size !== data.length ||
      data.some(
        (x) =>
          !x ||
          !/^([a-f0-9]{24})$/.test(x.class_id) ||
          !/^[-A-Za-z0-9_]{8,128}$/.test(x.key) ||
          !/^([a-f0-9]{64})$/.test(x.hash) ||
          ![
            "ready",
            "unknown",
            "assigned",
            "already_assigned",
            "failed",
          ].includes(x.status),
      )
    )
      throw new Error("恢复记录无效，请人工核查原编号。");
    items.value = data;
    persist();
    message.value = "已恢复原批次编号，不会自动继续写入。";
  } catch (e) {
    storageBlocked.value = true;
    message.value = e instanceof Error ? e.message : "恢复失败";
  }
});
onBeforeUnmount(() => lifetime.abort());
</script>
<template>
  <section class="batch" aria-label="批量分配课程">
    <h4>批量分配到班级</h4>
    <p ref="status" tabindex="-1" role="status" aria-live="polite">
      {{ message }}
    </p>
    <fieldset :disabled="locked">
      <legend>选择最多20个班级</legend>
      <label v-for="c in classes" :key="c.id"
        ><input
          v-model="ids"
          type="checkbox"
          :value="c.id"
          :disabled="!ids.includes(c.id) && ids.length >= 20"
          @change="preview = null"
        />{{ c.name }}</label
      >
    </fieldset>
    <button :disabled="locked || !ids.length" @click="check">预检查</button>
    <div v-if="preview">
      <p>检查 {{ preview.items.length }} 班，仍需执行时重新鉴权。</p>
      <p v-for="p in preview.items" :key="p.class_id">
        {{ p.name || p.class_id }}：{{
          {
            ready: "可分配",
            already_assigned: "已分配",
            forbidden: "无当前权限",
            conflict: "已结束，需人工处理",
          }[p.status as string]
        }}
      </p>
      <button
        :disabled="
          locked || !preview.items.some((x: Row) => x.status === 'ready')
        "
        @click="begin"
      >
        确认逐项分配
      </button>
    </div>
    <div v-if="items.length">
      <p>部分成功会保留；不会自动撤销或恢复已结束关联。</p>
      <article v-for="item in items" :key="item.class_id">
        <p>
          班级 {{ item.class_id }}：{{
            {
              ready: "尚未执行",
              unknown: "结果待确认",
              assigned: "已分配",
              already_assigned: "原有分配",
              failed: "执行失败",
            }[item.status]
          }}
          {{ item.code }}
        </p>
        <p>原编号 {{ item.key }}</p>
        <button
          v-if="item.status === 'unknown'"
          :disabled="busy"
          @click="receipt(item)"
        >
          查原回执</button
        ><button
          v-if="item.status === 'unknown'"
          :disabled="busy || blocked"
          @click="retry(item)"
        >
          按原编号重试
        </button>
      </article>
      <button
        :disabled="
          busy ||
          blocked ||
          items.some((x) => x.status === 'unknown') ||
          !items.some((x) => x.status === 'ready')
        "
        @click="resume"
      >
        显式继续未执行项</button
      ><button
        :disabled="busy || items.some((x) => x.status === 'unknown')"
        @click="reset"
      >
        结束本批，重新预检查
      </button>
    </div>
  </section>
</template>
<style scoped>
.batch {
  margin-block: 1rem;
  padding: 1rem;
  border: 1px solid #d4dae2;
  border-radius: 0.6rem;
  overflow-wrap: anywhere;
}
.batch fieldset {
  min-width: 0;
}
.batch label {
  display: block;
  padding: 0.25rem;
}
.batch button {
  margin: 0.25rem;
  max-width: 100%;
  white-space: normal;
}
</style>
