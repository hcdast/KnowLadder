<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
defineProps<{ name: string; busy?: boolean; allowPassword?: boolean }>();
const emit = defineEmits<{ logout: []; password: [] }>();
const menu = ref<HTMLDetailsElement>(),
  summary = ref<HTMLElement>();
const route = useRoute();
function close(restore = false) {
  if (menu.value?.open) {
    menu.value.open = false;
    if (restore) void nextTick(() => summary.value?.focus());
  }
}
function outside(event: PointerEvent) {
  if (!menu.value?.contains(event.target as Node)) close();
}
watch(
  () => route.fullPath,
  () => close(),
);
onMounted(() => document.addEventListener("pointerdown", outside));
onBeforeUnmount(() => document.removeEventListener("pointerdown", outside));
</script>
<template>
  <details ref="menu" class="account-menu" @keydown.esc.prevent="close(true)">
    <summary ref="summary" :aria-label="name + '的账号菜单'">
      <span class="account-avatar" aria-hidden="true">{{ Array.from(name)[0] }}</span
      ><span class="account-name">{{ name }}</span
      ><span aria-hidden="true">⌄</span>
    </summary>
    <nav aria-label="账号操作">
      <p>{{ name }}</p>
      <RouterLink to="/home">我的工作区</RouterLink>
      <RouterLink to="/personal">个人学习空间</RouterLink>
      <RouterLink to="/account">账号与安全</RouterLink>
      <button
        v-if="allowPassword"
        :disabled="busy"
        @click="
          close();
          emit('password');
        "
      >
        修改密码
      </button>
      <RouterLink to="/">网站首页</RouterLink>
      <button
        class="account-logout"
        :disabled="busy"
        @click="
          close();
          emit('logout');
        "
      >
        {{ busy ? "请稍候…" : "退出登录" }}
      </button>
    </nav>
  </details>
</template>
<style scoped>
.account-menu {
  position: relative;
  color: #20384a;
  z-index: 5;
  font-size: 14px;
}
.account-menu summary {
  display: flex;
  align-items: center;
  gap: 9px;
  cursor: pointer;
  padding: 5px;
  border-radius: 8px;
  list-style: none;
  min-height: 44px;
}
.account-menu summary::-webkit-details-marker {
  display: none;
}
.account-avatar {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  background: #e7f0fa;
  color: #1263b0;
  border-radius: 50%;
  font-weight: 600;
}
.account-name {
  max-width: 140px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.account-menu nav {
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  width: 220px;
  max-width: calc(100vw - 32px);
  border: 1px solid #d7e2eb;
  border-radius: 12px;
  padding: 8px;
  background: #fff;
  box-shadow: 0 12px 40px #243a5126;
  display: grid;
  gap: 2px;
}
.account-menu nav p {
  font-size: 12px;
  color: #617487;
  padding: 8px;
  margin: 0;
  overflow-wrap: anywhere;
  border-bottom: 1px solid #eef2f6;
}
.account-menu nav a,
.account-menu nav button {
  border: 0;
  background: transparent;
  text-align: left;
  text-decoration: none;
  font: inherit;
  color: inherit;
  padding: 12px;
  border-radius: 6px;
  cursor: pointer;
}
.account-menu nav a:hover,
.account-menu nav button:hover {
  background: #f0f5fa;
}
.account-menu nav .account-logout {
  color: #a13f39;
  border-top: 1px solid #eef2f6;
  border-radius: 0;
  margin-top: 4px;
}
a:focus-visible,
button:focus-visible,
summary:focus-visible {
  outline: 3px solid #9ccaf5;
  outline-offset: 2px;
}
button:disabled {
  opacity: 0.6;
  cursor: wait;
}
@media (max-width: 600px) {
  .account-name {
    max-width: 80px;
  }
}
</style>
