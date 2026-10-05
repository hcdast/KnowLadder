<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { ConsoleContext, Member, Page, User } from "./types";
import type { BusinessRequest } from "../session";
import type { AuthorizationMember } from "./governancePresentation";
import { consoleRoleLabel } from "./presentation";
import ResourceTable from "./components/ResourceTable.vue";
import StatusBadge from "./components/StatusBadge.vue";
const props = defineProps<{ context: ConsoleContext; request: BusinessRequest; disabled?: boolean; initialUserId?: string; initialMemberId?: string; selectedId?: string }>();
const emit = defineEmits<{ select: [member: AuthorizationMember | undefined] }>();
const canAccounts = computed(() => props.context.capabilities.some(cap => ["account:platform-manage", "account:manage"].includes(cap)));
const canLocate = computed(() => canAccounts.value || props.context.capabilities.includes("platform:govern"));
const lookupKind = ref<"login_name" | "user_id">(canAccounts.value ? "login_name" : "user_id"), lookup = ref("");
const user = ref<User>(), members = ref<AuthorizationMember[]>([]), cursor = ref<string | null>(null);
const busy = ref(false), error = ref(""), loaded = ref(false);
const life = new AbortController(); let alive = true;
async function locate(userId?: string) {
  if (busy.value || props.disabled || !canLocate.value) return;
  const value = userId || lookup.value.trim(); if (!value) return;
  busy.value = true; error.value = ""; loaded.value = false; user.value = undefined; members.value = []; cursor.value = null; emit("select", undefined);
  try {
    if (userId || lookupKind.value === "user_id" || !canAccounts.value) {
      const found = await props.request<User>(`/console/users/${encodeURIComponent(value)}`, { signal: life.signal });
      if (!alive) return;
      user.value = found;
    } else {
      const page = await props.request<Page<User>>(`/console/users?${new URLSearchParams({ login_name: value, limit: "20" })}`, { signal: life.signal });
      if (!alive) return;
      user.value = page.items[0];
      if (!user.value) { error.value = "未找到当前职责范围内的精确登录名；不会遍历全库或猜测其他账号。"; return; }
    }
    if (alive) await loadMembers();
  } catch (cause) { if (alive && !(cause instanceof DOMException && cause.name === "AbortError")) error.value = cause instanceof Error ? cause.message : "用户定位失败"; }
  finally { if (alive) busy.value = false; }
}
async function loadMembers(next = false) {
  const target = user.value; if (!target || !alive) return;
  error.value = "";
  try {
    const q = new URLSearchParams({ limit: "20" }); if (next && cursor.value) q.set("cursor", cursor.value);
    const page = await props.request<Page<Member & { org_id: string; organization_name: string }>>(`/console/users/${encodeURIComponent(target.id)}/members?${q}`, { signal: life.signal });
    if (!alive) return;
    const rows = page.items.map(member => ({ ...member, user_id: target.id, display_name: target.display_name, login_name: target.login_name, user_status: target.status }));
    members.value = next ? [...members.value, ...rows] : rows; cursor.value = page.next_cursor; loaded.value = true;
    const initial = rows.find(member => member.id === props.initialMemberId);
    if (initial) emit("select", initial);
  } catch (cause) { if (alive && !(cause instanceof DOMException && cause.name === "AbortError")) error.value = cause instanceof Error ? cause.message : "成员关系读取失败"; }
}
async function nextMembers() {
  if (busy.value || props.disabled) return;
  busy.value = true;
  try { await loadMembers(!!cursor.value); } finally { if (alive) busy.value = false; }
}
onMounted(() => { if (props.initialUserId) void locate(props.initialUserId); });
onBeforeUnmount(() => { alive = false; life.abort(); });
</script>
<template>
  <section class="stack" aria-label="定位授权目标" :aria-busy="busy">
    <p v-if="!canLocate" class="notice">需组织账号管理职责才能定位人员。仅有精确委派职责不提供人员目录，未读取任何用户列表；请由有权治理者安排相应目录职责。已有精确授权的读取与撤销仍按真实权限校验。</p>
    <template v-else>
      <p class="field-help">{{ canAccounts ? '仅按精确登录名或明确用户 ID 定位当前可见账号，不进行模糊搜索。' : '当前治理身份不具备用户目录职责；仅按已知用户 ID 安全定位，不查询全局用户列表。' }}</p>
      <form class="admin-toolbar" @submit.prevent="locate()">
        <div v-if="canAccounts" class="field"><label for="authorization-lookup-kind">定位方式</label><select id="authorization-lookup-kind" v-model="lookupKind" :disabled="busy || disabled"><option value="login_name">精确登录名</option><option value="user_id">明确用户 ID</option></select></div>
        <div class="field"><label for="authorization-target-lookup">{{ canAccounts && lookupKind === 'login_name' ? '完整登录名' : '已知用户 ID' }}</label><input id="authorization-target-lookup" v-model="lookup" :disabled="busy || disabled" required autocomplete="off" /></div>
        <button class="button secondary" :disabled="busy || disabled || !lookup.trim()">定位用户</button>
      </form>
      <p v-if="error" class="notice" role="alert">{{ error }}</p><p v-if="busy" role="status">正在读取目标与成员关系…</p>
      <template v-if="user">
        <p><strong>{{ user.display_name }}</strong> · {{ user.login_name }} · <StatusBadge :status="user.status" /></p>
        <p v-if="user.status !== 'active'" class="notice">账号未启用，不能新增授权；仍可查看已有成员关系。</p>
        <ResourceTable :headers="['成员所在组织', '基础角色', '成员状态', '选择']" :busy="busy" :empty="loaded && !members.length" empty-label="此用户没有可见成员关系。">
          <tr v-for="member in members" :key="member.id"><td><strong>{{ member.organization_name || member.org_id }}</strong><small class="admin-meta">成员 {{ member.id }}</small></td><td>{{ member.roles.map(consoleRoleLabel).join('、') || '无有效基础角色' }}</td><td><StatusBadge :status="member.status" /></td><td><button type="button" class="button secondary" :disabled="busy || disabled" :aria-pressed="selectedId === member.id" @click="emit('select', member)">{{ selectedId === member.id ? '已选择' : '选择此成员' }}</button></td></tr>
        </ResourceTable>
        <button v-if="cursor || error || !loaded" type="button" class="button secondary" :disabled="busy || disabled" @click="nextMembers">{{ cursor ? '加载更多成员关系' : '重试成员关系' }}</button>
        <p v-if="initialMemberId && loaded && !members.some(member => member.id === initialMemberId)" class="field-help">当前页尚未包含指定成员。{{ cursor ? '继续分页读取或选择当前有权成员。' : '指定成员不在当前可见关系内，不能凭路由参数直接提交。' }}</p>
      </template>
    </template>
  </section>
</template>
