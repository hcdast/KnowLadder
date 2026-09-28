<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  demo,
  faults,
  resetDemo,
  type Fault,
  type Role,
} from "./services/core";
import ConfirmDialog from "./components/ConfirmDialog.vue";
const route = useRoute();
const router = useRouter();
const resetting = ref(false);
const admin = computed(() => route.path.startsWith("/admin"));
const landing = computed(() => route.path === "/");
const focusMode = computed(() =>
  ["S05", "S07"].includes(String(route.meta.page)),
);
const blocked = computed(
  () =>
    demo.fault === "forbidden" ||
    demo.fault === "expired" ||
    (admin.value && demo.role === "student") ||
    (!admin.value &&
      !landing.value &&
      String(route.meta.page).startsWith("S") &&
      demo.role !== "student"),
);
const studentLinks = [
  ["/student", "首页"],
  ["/student/textbooks", "课本"],
  ["/student/practice", "练测"],
  ["/student/growth", "成长"],
  ["/student/mistakes", "错题"],
];
const adminLinks = [
  ["/admin", "工作台"],
  ["/admin/textbooks", "教材章节"],
  ["/admin?type=question", "题库"],
];
function isActive(path: string) {
  if (path === "/student") return route.path === path;
  if (path === "/admin")
    return (
      (route.path === path && route.query.type !== "question") ||
      route.path.includes("/reviews/")
    );
  if (path === "/admin?type=question")
    return (
      route.path.includes("/questions/") ||
      (route.path === "/admin" && route.query.type === "question")
    );
  if (path === "/student/practice")
    return (
      route.path.includes("/practice") ||
      route.path.includes("/quiz") ||
      route.path.includes("/submissions")
    );
  return route.path.startsWith(path);
}
function changeRole(event: Event) {
  const input = event.target as HTMLSelectElement;
  if (
    demo.dirty &&
    !window.confirm("切换演示身份将离开当前编辑，可能丢失未保存内容，继续吗？")
  ) {
    input.value = demo.role;
    return;
  }
  demo.dirty = false;
  demo.role = input.value as Role;
  if (demo.role === "student" && admin.value) void router.push("/student");
  else if (demo.role !== "student" && route.path.startsWith("/student"))
    void router.push("/admin");
}
function changeFault(event: Event) {
  const input = event.target as HTMLSelectElement;
  const next = input.value as Fault;
  if ((next === "forbidden" || next === "expired") && demo.dirty) {
    if (
      !window.confirm("此场景会关闭受保护页面并丢弃未保存的输入，确定继续吗？")
    ) {
      input.value = demo.fault;
      return;
    }
    demo.dirty = false;
  }
  demo.fault = next;
}
function reset() {
  resetDemo(demo.scenario, demo.role);
  void router.push(demo.role === "student" ? "/student" : "/admin");
}
function recover() {
  demo.fault = "normal";
  demo.dirty = false;
  void router.push("/");
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (demo.dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
}
window.addEventListener("beforeunload", beforeUnload);
onBeforeUnmount(() => window.removeEventListener("beforeunload", beforeUnload));
</script>
<template>
  <div :class="{ 'focus-mode': focusMode }">
    <a class="skip-link" href="#main-content">跳至正文</a>
    <header class="app-header">
      <RouterLink
        class="brand"
        to="/"
        aria-label="知阶 KnowLadder，返回演示入口"
        ><span class="brand-name">知阶<span>KnowLadder</span></span
        ><span class="brand-tagline">知阶而上，智达未来</span></RouterLink
      >
      <nav
        v-if="!landing && !focusMode"
        class="main-nav"
        :aria-label="admin ? '内容管理导航' : '学生导航'"
      >
        <RouterLink
          v-for="[path, label] in admin ? adminLinks : studentLinks"
          :key="path"
          :to="path"
          :class="{ active: isActive(path) }"
          :aria-current="isActive(path) ? 'page' : undefined"
          >{{ label }}</RouterLink
        >
      </nav>
      <span class="tag demo-label">交互原型</span>
    </header>
    <div class="demo-banner">
      <span>交互演示 · 示例数据</span
      ><span>仅内存保存，刷新将重置场景；非真实认证、评分或文件服务。</span>
    </div>
    <details v-if="!landing" class="demo-toolbar">
      <summary>演示控制 · 场景与身份</summary>
      <div class="actions">
        <label
          >演示身份<select :value="demo.role" @change="changeRole">
            <option value="student">学生</option>
            <option value="editor">内容编辑</option>
            <option value="reviewer">内容审核</option>
          </select></label
        >
        <label
          >异常场景<select :value="demo.fault" @change="changeFault">
            <option v-for="f in faults" :key="f.value" :value="f.value">
              {{ f.label }}
            </option>
          </select></label
        >
        <button class="button secondary" @click="resetting = true">
          重置演示</button
        ><RouterLink class="button ghost" to="/">返回场景入口</RouterLink>
      </div>
      <p class="muted">
        切换身份仅模拟权限。重置会清空作答、成绩和内容更改；恢复正常场景后可使用页面内重试按钮。
      </p>
    </details>
    <main id="main-content" class="app-main" tabindex="-1">
      <section v-if="blocked" class="empty-state" role="alert">
        <p class="eyebrow">访问状态演示</p>
        <h1 tabindex="-1">
          {{ demo.fault === "expired" ? "会话已过期" : "当前内容不可访问" }}
        </h1>
        <p>
          已停止展示受保护内容。请返回演示入口选择有效身份，原型不收集真实账号密码。
        </p>
        <button class="button" @click="recover">返回演示入口</button>
      </section>
      <RouterView v-else :key="`${demo.epoch}-${demo.role}`" />
    </main>
    <footer class="app-footer">
      <span>KnowLadder / 每一步，都算数</span
      ><span>原创教学示例 · 非正式教材与学习效果证明</span>
    </footer>
    <ConfirmDialog
      v-model="resetting"
      title="重置当前演示？"
      confirm-text="确认重置"
      @confirm="reset"
      ><p>
        将清空所有演示作答、成绩、草稿与发布记录，恢复场景初始状态。此操作不涉及真实用户数据。
      </p></ConfirmDialog
    >
  </div>
</template>
