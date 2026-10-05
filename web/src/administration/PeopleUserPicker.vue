<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ConsoleContext, Page, User } from "./types";
import type { BusinessRequest } from "../session";
import { isUserId, sameUserName } from "./peopleSelection";
import ResourceTable from "./components/ResourceTable.vue";
import StatusBadge from "./components/StatusBadge.vue";

const props = defineProps<{ context: ConsoleContext; request: BusinessRequest; locked?: boolean; selected?: User }>();
const emit = defineEmits<{ select: [user: User] }>();
const directory = computed(() => props.context.menus.includes("users"));
const queryKind = ref("login"), query = ref(""), appliedLogin = ref("");
const users = ref<User[]>([]), cursor = ref<string | null>(null), loaded = ref(false), busy = ref(false), error = ref("");
let controller = new AbortController(), generation = 0, alive = true;
watch([queryKind, query], () => { generation++; controller.abort(); controller = new AbortController(); busy.value = false; cursor.value = null; loaded.value = false; users.value = []; error.value = ""; }, { flush: "sync" });
async function load(next = false) {
  if (busy.value) return;
  const token = ++generation;
  const value = query.value.trim();
  error.value = "";
  if ((!directory.value || queryKind.value === "id") && !isUserId(value)) { error.value = "请输入完整有效的用户 ID。"; return; }
  busy.value = true;
  try {
    if (!directory.value || queryKind.value === "id") {
      const user = await props.request<User>(`/console/users/${encodeURIComponent(value)}`, { signal: controller.signal });
      if (alive && token === generation) { users.value = [user]; cursor.value = null; loaded.value = true; }
    } else {
      const filter = next ? appliedLogin.value : value;
      const params = new URLSearchParams({ limit: "20" });
      if (filter) params.set("login_name", filter);
      if (next && cursor.value) params.set("cursor", cursor.value);
      const page = await props.request<Page<User>>(`/console/users?${params}`, { signal: controller.signal });
      if (alive && token === generation) { users.value = next ? [...users.value, ...page.items] : page.items; cursor.value = page.next_cursor; appliedLogin.value = filter; loaded.value = true; }
    }
  } catch (cause) {
    if (alive && token === generation && !(cause instanceof DOMException && cause.name === "AbortError")) error.value = cause instanceof Error ? cause.message : "人员读取失败，请重试。";
  } finally { if (alive && token === generation) busy.value = false; }
}
onMounted(() => { if (directory.value) void load(); });
onBeforeUnmount(() => { alive = false; generation++; controller.abort(); });
</script>

<template>
  <section class="stack" aria-label="选择已有用户">
    <p v-if="selected" role="status">已选择：<strong>{{ selected.display_name }}</strong> · {{ selected.login_name }} <code>{{ selected.id }}</code></p>
    <div class="admin-toolbar">
      <div v-if="directory" class="field"><label for="person-query-kind">定位方式</label><select id="person-query-kind" v-model="queryKind" :disabled="locked"><option value="login">精确登录名（留空读取有权目录）</option><option value="id">明确用户 ID</option></select></div>
      <div class="field"><label for="person-query">{{ !directory || queryKind === 'id' ? '用户 ID' : '精确登录名' }}</label><input id="person-query" v-model="query" :disabled="locked" autocomplete="off" @keydown.enter.prevent="load()" /></div>
      <button type="button" class="button secondary" :disabled="busy || locked" @click="load()">定位人员</button>
    </div>
    <p v-if="!directory" class="field-help">当前职责没有用户目录权限，仅按已知用户 ID 精确定位，不读取登录名目录。</p>
    <p v-if="error" class="notice" role="alert">{{ error }}</p>
    <ResourceTable :headers="['用户', '账号状态', '操作']" :busy="busy" :empty="loaded && !users.length" empty-label="当前范围没有匹配的用户。">
      <tr v-for="user in users" :key="user.id"><td><strong>{{ user.display_name }}</strong><span class="admin-meta">{{ user.login_name }}</span><code v-if="sameUserName(users, user)" class="admin-meta">{{ user.id }}</code></td><td><StatusBadge :status="user.status" :label="user.status === 'active' ? '已启用' : undefined" /></td><td><button type="button" class="text-button" :disabled="locked || busy" @click="emit('select', user)">{{ selected?.id === user.id ? '已选择' : '选择此用户' }}</button></td></tr>
    </ResourceTable>
    <div v-if="cursor" class="admin-toolbar"><span class="field-help">已载入 {{ users.length }} 条，不代表用户总数。</span><button type="button" class="button secondary" :disabled="busy || locked" @click="load(true)">加载下一页人员</button></div>
  </section>
</template>
