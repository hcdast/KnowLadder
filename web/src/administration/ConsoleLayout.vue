<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import AccountMenu from "../components/AccountMenu.vue";
import type { Identity } from "../session";
import type { ConsoleContext, ConsoleMenu } from "./types";
import { consoleBusinessModules } from "./presentation";
import "./console.css";
const props = defineProps<{ identity: Identity; context?: ConsoleContext; busy?: boolean }>();
const emit = defineEmits<{ organization: [event: Event]; password: []; logout: [] }>();
const route = useRoute();
const collapsed = ref(false), mobile = ref(false), drawer = ref(false);
const sidebar = ref<HTMLElement>(), toggle = ref<HTMLButtonElement>();
const currentPage = computed(() => String(route.meta.consolePage || route.params.page || "overview"));
const modules = computed(() => props.context ? consoleBusinessModules(props.context) : []);
const links: { page: ConsoleMenu; label: string; icon: string; group: string }[] = [
  { page: "users", label: "用户", icon: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75", group: "身份与访问" },
  { page: "organizations", label: "组织与成员", icon: "M3 21h18 M5 21V3h14v18 M9 7h1 M14 7h1 M9 11h1 M14 11h1 M10 21v-6h4v6", group: "身份与访问" },
  { page: "authorizations", label: "角色与授权", icon: "M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11 M9 12l2 2 4-4", group: "身份与访问" },
  { page: "approvals", label: "审批中心", icon: "M9 5H5v16h14V5h-4 M9 3h6v4H9z M8 14l3 3 5-6", group: "治理" },
  { page: "audit", label: "操作审计", icon: "M14 2H6v20h12V6z M14 2v6h4 M8 12h6 M8 16h6", group: "治理" },
];
const groups = computed(() => ["身份与访问", "治理"].map(label => ({ label, links: links.filter(link => link.group === label && props.context?.menus.includes(link.page)) })).filter(group => group.links.length));
const businessLabels = { content: "教材题库", assessment: "考试管理", reports: "报告管理", safety: "安全处置" };
function resize() { mobile.value = window.matchMedia("(max-width: 1023px)").matches; if (!mobile.value) closeDrawer(); }
async function openNavigation() {
  if (!mobile.value) { collapsed.value = !collapsed.value; return; }
  drawer.value = true; await nextTick(); sidebar.value?.querySelector<HTMLElement>("button, a")?.focus();
}
function closeDrawer() { const wasOpen = drawer.value; drawer.value = false; if (wasOpen) void nextTick(() => toggle.value?.focus()); }
function trapNavigation(event: KeyboardEvent) {
  if (!drawer.value) return;
  if (event.key === "Escape") { event.preventDefault(); closeDrawer(); return; }
  if (event.key !== "Tab") return;
  const controls = Array.from(sidebar.value?.querySelectorAll<HTMLElement>("button, a[href]") ?? []);
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
watch(() => route.fullPath, closeDrawer);
onMounted(() => { resize(); window.addEventListener("resize", resize); });
onBeforeUnmount(() => window.removeEventListener("resize", resize));
</script>
<template>
  <div class="admin-shell" :class="{ 'is-collapsed': collapsed && !mobile, 'is-drawer-open': drawer }">
    <header class="admin-header" :inert="drawer || undefined">
      <button ref="toggle" class="admin-icon-button" :aria-label="mobile ? '打开后台导航' : collapsed ? '展开侧栏' : '折叠侧栏'" :aria-expanded="mobile ? drawer : !collapsed" aria-controls="admin-navigation" @click="openNavigation"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18 M3 12h18 M3 18h18" /></svg></button>
      <RouterLink class="admin-brand" to="/console/overview">知阶<span>管理后台</span></RouterLink>
      <div class="admin-header-tools">
        <label class="admin-organization"><span>管理组织</span><select aria-label="当前管理组织" :value="identity.context?.org_id || ''" :disabled="busy" @change="emit('organization', $event)"><option v-if="!identity.context" value="" disabled>请选择组织</option><option v-for="organization in identity.organizations" :key="organization.id" :value="organization.id">{{ organization.name }}</option></select></label>
        <AccountMenu :name="identity.user.display_name" :busy="busy" allow-password @password="emit('password')" @logout="emit('logout')" />
      </div>
    </header>
    <div v-if="drawer" class="admin-drawer-backdrop" aria-hidden="true" @click="closeDrawer" />
    <aside ref="sidebar" class="admin-sidebar" :class="{ 'is-open': drawer }" :role="drawer ? 'dialog' : undefined" :aria-modal="drawer ? true : undefined" aria-label="后台导航" :inert="mobile && !drawer || undefined" @keydown="trapNavigation">
      <button v-if="mobile" class="admin-drawer-close" @click="closeDrawer">关闭导航</button>
      <nav id="admin-navigation" aria-label="管理后台一级导航">
        <RouterLink class="admin-navigation-link" to="/console/overview" :aria-current="currentPage === 'overview' ? 'page' : undefined" title="工作台"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z" /></svg><span>工作台</span></RouterLink>
        <section v-for="group in groups" :key="group.label" class="admin-nav-group"><h2>{{ group.label }}</h2><RouterLink v-for="link in group.links" :key="link.page" class="admin-navigation-link" :to="`/console/${link.page}`" :aria-current="currentPage === link.page ? 'page' : undefined" :title="link.label"><svg viewBox="0 0 24 24" aria-hidden="true"><path :d="link.icon" /></svg><span>{{ link.label }}</span></RouterLink></section>
        <section v-if="modules.length" class="admin-nav-group"><h2>业务管理</h2><RouterLink v-for="module in modules" :key="module" class="admin-navigation-link" :to="`/console/business/${module}`" :aria-current="currentPage === 'business' && route.params.module === module ? 'page' : undefined" :title="businessLabels[module]"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h7v18H4z M14 3h6v18h-6z M7 7h1 M7 11h1 M17 7h1 M17 11h1" /></svg><span>{{ businessLabels[module] }}</span></RouterLink></section>
        <RouterLink v-if="identity.context?.capabilities.some(cap => cap.startsWith('course:') || cap.startsWith('task:') || cap.startsWith('ai:') || cap.startsWith('site:') || cap === 'coursework:grade')" class="admin-navigation-link" to="/training" title="课程与培训"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4z M8 8h8 M8 12h8 M8 16h5" /></svg><span>课程与培训</span></RouterLink>
        <RouterLink class="admin-navigation-link" to="/" title="网站首页"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 11 9-8 9 8 M5 10v11h14V10" /></svg><span>网站首页</span></RouterLink>
      </nav>
    </aside>
    <main id="main-content" class="admin-main" :inert="drawer || undefined"><slot /></main>
  </div>
</template>
