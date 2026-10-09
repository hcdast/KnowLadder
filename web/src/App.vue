<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { useSession } from "./session";
import CertificateVerification from "./training/CertificateVerification.vue";
import PublicSite from "./site/PublicSite.vue";
import TrainingWorkspace from "./training/TrainingWorkspace.vue";
import BrandJourney from "./components/BrandJourney.vue";
import BrandIcon from "./components/BrandIcon.vue";
import ContentWorkspace from "./content/ContentWorkspace.vue";
import AssessmentWorkspace from "./assessment/AssessmentWorkspace.vue";
import LearningWorkspace from "./learning/LearningWorkspace.vue";
import PrivacyWorkspace from "./privacy/PrivacyWorkspace.vue";
import TeacherWorkspace from "./teaching/TeacherWorkspace.vue";
import BusinessSafetyPage from "./administration/BusinessSafetyPage.vue";
import type { ConsoleContext } from "./administration/types";
const ConsoleWorkspace = defineAsyncComponent(
  () => import("./administration/ConsoleWorkspace.vue"),
);

const { state, synchronize, mutate, businessRequest, globalRequest } =
  useSession();
const route = useRoute(),
  router = useRouter();
const consoleAvailable = ref(false),
  consoleDatabaseMode = ref("");
const consoleStatus = ref<"idle" | "loading" | "ready" | "error">("idle");
const accountMenu = ref<HTMLDetailsElement>();
const signingIn = ref(false);
const consoleWriteActive = ref(false);
const consoleWorkspace = ref<{ beforeLeave: () => Promise<boolean> }>();
let consoleGeneration = 0,
  consoleTimer = 0;
let consoleController = new AbortController();
async function checkConsole() {
  const identity = state.identity;
  if (
    state.phase !== "authenticated" ||
    !identity?.context ||
    identity.must_change_password
  )
    return;
  if (consoleWriteActive.value || state.busy) return;
  consoleStatus.value = "loading";
  const token = ++consoleGeneration;
  consoleController.abort();
  consoleController = new AbortController();
  try {
    const context = await businessRequest<ConsoleContext>("/console/context", {
      signal: consoleController.signal,
    });
    if (token === consoleGeneration) {
      consoleAvailable.value = context.menus.length > 0;
      consoleDatabaseMode.value = context.database_mode;
      consoleStatus.value = "ready";
    }
  } catch {
    if (token === consoleGeneration) {
      consoleAvailable.value = false;
      consoleDatabaseMode.value = "";
      consoleStatus.value = "error";
    }
  }
}
function consoleWriteState(active: boolean) {
  consoleWriteActive.value = active;
  if (active) {
    consoleGeneration++;
    consoleController.abort();
  } else void checkConsole();
}
watch(
  [
    () => state.phase,
    () => state.identity?.user.id,
    () => state.identity?.context?.org_id,
    () => state.formEpoch,
    () => state.busy,
  ],
  () => {
    consoleGeneration++;
    consoleController.abort();
    consoleAvailable.value = false;
    consoleDatabaseMode.value = "";
    consoleStatus.value = "idle";
    void checkConsole();
  },
  { flush: "sync" },
);
const removeRouteGuard = router.beforeEach(async (to, from) => {
  if (to.fullPath === from.fullPath || state.phase !== "authenticated")
    return true;
  return confirmContentLeave();
});
onMounted(() => {
  consoleTimer = window.setInterval(() => void checkConsole(), 30000);
});
onBeforeUnmount(() => {
  removeRouteGuard();
  consoleGeneration++;
  consoleController.abort();
  window.clearInterval(consoleTimer);
});
const contentDirty = ref(false);
const safetyDirty = ref(false),
  safetyUnknown = ref(false);
const assessmentDirty = ref(false);
const assessmentUnknown = ref(false);
const learningDirty = ref(false);
const learningUnknown = ref(false);
const teachingDirty = ref(false);
const teachingUnknown = ref(false);
const privacyUnknown = ref(false);
const readingPending = ref(false);
const contentWorkspace = ref<{ beforeLeave: () => Promise<boolean> }>();
const readingTarget = ref<{ editionId: string; chapterId: string }>();
const publicPage = computed(() =>
  [
    "/",
    "/features",
    "/ai-teaching",
    "/solutions",
    "/help",
    "/about",
    "/contact",
    "/verify-certificate",
  ].includes(route.path),
);
const trainingDirty = ref(false),
  trainingUnknown = ref(false);
const canTraining = computed(
  () =>
    state.identity?.context?.capabilities.some(
      (cap) =>
        cap.startsWith("course:") ||
        cap.startsWith("task:") ||
        cap.startsWith("ai:") ||
        cap.startsWith("site:") ||
        cap.startsWith("training:") ||
        cap === "teaching:report" ||
        cap === "coursework:grade" ||
        cap === "learning:self",
    ) || false,
);
const workspace = computed(() =>
  route.path.startsWith("/console")
    ? "console"
    : (route.path.slice(1) as
        | "home"
        | "account"
        | "content"
        | "assessment"
        | "learning"
        | "teaching"
        | "privacy"
        | "training"
        | "login"),
);
const navigationBusy = ref(false);
const trainingLeavePrompt = ref(""),
  trainingLeaveCancel = ref<HTMLButtonElement>();
let finishTrainingLeave: ((value: boolean) => void) | undefined;
async function confirmTrainingLeave(message: string) {
  trainingLeavePrompt.value = message;
  const answer = new Promise<boolean>((resolve) => {
    finishTrainingLeave = resolve;
  });
  await nextTick();
  trainingLeaveCancel.value?.focus();
  return answer;
}
function decideTrainingLeave(value: boolean) {
  trainingLeavePrompt.value = "";
  finishTrainingLeave?.(value);
  finishTrainingLeave = undefined;
}
watch(
  () => state.formEpoch,
  () => {
    if (trainingLeavePrompt.value) decideTrainingLeave(false);
  },
);
onBeforeUnmount(() => decideTrainingLeave(false));
const canLearn = computed(() => {
  const caps = state.identity?.context?.capabilities || [];
  return (
    caps.includes("learning:self") &&
    !state.identity?.context?.student_conflict &&
    !caps.some((value) =>
      [
        "content:edit",
        "content:review",
        "assessment:manage",
        "assessment:review",
      ].includes(value),
    )
  );
});
const canTeach = computed(() =>
  (state.identity?.context?.capabilities || []).includes("teaching:class"),
);
const canReadContent = computed(
  () =>
    state.identity?.context?.capabilities.some((cap) =>
      ["content:edit", "content:review"].includes(cap),
    ) || false,
);
const canSafety = computed(
  () =>
    state.identity?.context?.capabilities.some((cap) =>
      ["content:retire", "content:revoke", "file:delete"].includes(cap),
    ) || false,
);
const canAssessment = computed(
  () =>
    canLearn.value ||
    state.identity?.context?.capabilities.some((cap) =>
      ["assessment:manage", "assessment:review"].includes(cap),
    ) ||
    false,
);
async function selectWorkspace(
  value:
    | "home"
    | "account"
    | "content"
    | "assessment"
    | "learning"
    | "teaching"
    | "privacy"
    | "training"
    | "console",
) {
  if (value !== workspace.value)
    await router.push(value === "console" ? "/console" : `/${value}`);
}
// Only the entry route chooses a workspace; explicit account/privacy links remain stable.
const workspaceAllowed = computed(() =>
  workspace.value === "content"
    ? canReadContent.value || canSafety.value || canLearn.value
    : workspace.value === "assessment"
      ? canAssessment.value
      : workspace.value === "learning"
        ? canLearn.value
        : workspace.value === "teaching"
          ? canTeach.value
          : workspace.value === "training"
            ? canTraining.value
            : true,
);
const defaultWorkspace = computed(() =>
  consoleAvailable.value
    ? "/console/overview"
    : canTeach.value
      ? "/teaching"
      : canLearn.value
        ? "/learning"
        : canReadContent.value || canSafety.value
          ? "/content"
          : canAssessment.value
            ? "/assessment"
            : "",
);
let selectingOnlyOrganization = false;
watch(
  () =>
    [
      state.phase,
      state.busy,
      signingIn.value,
      state.identity?.user.id,
      state.identity?.context?.org_id,
      route.path,
      state.identity?.must_change_password,
    ] as const,
  async () => {
    const identity = state.identity;
    if (
      state.phase !== "authenticated" ||
      state.busy ||
      signingIn.value ||
      !identity ||
      identity.must_change_password ||
      identity.context ||
      identity.organizations.length !== 1 ||
      selectingOnlyOrganization ||
      workspace.value === "account" ||
      workspace.value === "privacy"
    )
      return;
    selectingOnlyOrganization = true;
    try {
      await synchronize(identity.organizations[0]!.id);
    } finally {
      selectingOnlyOrganization = false;
    }
  },
  { flush: "post" },
);
watch(
  () =>
    [
      route.path,
      state.phase,
      state.busy,
      consoleStatus.value,
      defaultWorkspace.value,
      state.identity?.must_change_password,
    ] as const,
  () => {
    if (
      (route.path === "/home" || route.path === "/login") &&
      state.phase === "authenticated" &&
      !state.busy &&
      !mustChange.value &&
      consoleStatus.value === "ready" &&
      defaultWorkspace.value
    )
      void router.replace(defaultWorkspace.value);
  },
  { flush: "post" },
);
watch(
  () => route.fullPath,
  () => {
    if (accountMenu.value) accountMenu.value.open = false;
  },
);
async function openReading(target: { editionId: string; chapterId: string }) {
  if (workspace.value === "content") {
    if (!(await confirmContentLeave())) return;
  } else await router.push("/content");
  if (workspace.value === "content") readingTarget.value = target;
}
async function confirmContentLeave() {
  if (navigationBusy.value) return false;
  navigationBusy.value = true;
  const epoch = state.formEpoch;
  try {
    if (
      trainingDirty.value &&
      !(await confirmTrainingLeave(
        "培训或报告草稿尚未保存。继续会放弃本地修改。",
      ))
    )
      return false;
    if (
      trainingUnknown.value &&
      !(await confirmTrainingLeave(
        "培训或报告请求结果待确认。离开不会取消请求，请保留原编号以便恢复。",
      ))
    )
      return false;
    if (
      (contentDirty.value || safetyDirty.value) &&
      !window.confirm(
        "内容草稿或安全操作表单尚未保存，确定放弃本地修改并继续？",
      )
    )
      return false;
    if (
      (assessmentDirty.value || learningDirty.value || teachingDirty.value) &&
      !window.confirm("练测作答、考试草稿或教师出卷表单尚未保存，确定离开？")
    )
      return false;
    if (
      (assessmentUnknown.value ||
        learningUnknown.value ||
        teachingUnknown.value) &&
      !window.confirm(
        "练测或出卷请求结果待确认。离开不会取消请求；请保留原请求恢复记录。确定继续？",
      )
    )
      return false;
    if (
      safetyUnknown.value &&
      !window.confirm(
        "内容安全请求结果待确认。离开不会取消服务端操作；仅保留原key，不保存正文。确定继续？",
      )
    )
      return false;
    if (
      privacyUnknown.value &&
      !window.confirm(
        "隐私申请结果待确认。离开不会取消申请；恢复时须重新输入密码并沿用原请求编号。确定继续？",
      )
    )
      return false;
    if (
      workspace.value === "content" &&
      contentWorkspace.value &&
      !(await contentWorkspace.value.beforeLeave())
    )
      return false;
    if (
      workspace.value === "console" &&
      consoleWorkspace.value &&
      !(await consoleWorkspace.value.beforeLeave())
    )
      return false;
    return epoch === state.formEpoch;
  } finally {
    navigationBusy.value = false;
  }
}
function clearAssessmentRecovery(
  keepScope?: string,
  keepUser?: string,
  keepPrivacyUser?: string,
) {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (
        key.startsWith("privacy-recovery:") &&
        key !== `privacy-recovery:${keepPrivacyUser}:account`
      )
        sessionStorage.removeItem(key);
      for (const prefix of [
        "console-recovery:",
        "console-business-recovery:",
        "content-safety-recovery:",
      ]) {
        // Safe original keys survive logout/organization changes, never payloads.
        // Only a newly confirmed different account prunes another account's keys.
        const consoleUser =
          keepPrivacyUser || keepUser || keepScope?.split(":")[0];
        if (
          consoleUser &&
          key.startsWith(prefix) &&
          !key.startsWith(`${prefix}${consoleUser}:`)
        )
          sessionStorage.removeItem(key);
      }
      for (const prefix of [
        "assessment-recovery:",
        "assessment-admin-recovery:",
        "learning-recovery:",
        "teaching-quiz-recovery:",
      ]) {
        const platformRecovery =
          prefix === "assessment-admin-recovery:" &&
          keepScope &&
          key.startsWith(
            `${prefix}${keepScope.split(":")[0]}:platform:${keepScope.split(":")[1]}:`,
          );
        if (
          key.startsWith(prefix) &&
          key !== `${prefix}${keepScope}` &&
          !platformRecovery &&
          !(keepUser && key.startsWith(`${prefix}${keepUser}:`))
        )
          sessionStorage.removeItem(key);
      }
    }
  } catch {
    /* Storage may be unavailable; identity isolation still unmounts sensitive views. */
  }
}
async function logout() {
  if (await confirmContentLeave()) {
    clearAssessmentRecovery();
    await mutate("logout");
  }
}
const loginName = ref("");
const password = ref("");
const currentPassword = ref("");
const newPassword = ref("");
const confirmation = ref("");
const changing = ref(false);
const localError = ref("");
const errorSummary = ref<HTMLElement>();
const heading = ref<HTMLElement>();
const mustChange = computed(() => !!state.identity?.must_change_password);
const passwordPage = computed(() => mustChange.value || changing.value);
const message = computed(() => localError.value || state.message);
const consoleShell = computed(
  () =>
    workspace.value === "console" &&
    state.phase === "authenticated" &&
    !!state.identity &&
    !passwordPage.value,
);
const title = computed(() =>
  publicPage.value
    ? (
        {
          "/": "AI 教学培训平台",
          "/features": "产品功能",
          "/ai-teaching": "AI 教学",
          "/solutions": "解决方案",
          "/help": "使用帮助",
          "/about": "关于知阶",
          "/contact": "联系咨询",
        } as Record<string, string>
      )[route.path] || "知阶"
    : state.phase === "loading"
      ? "正在确认你的身份"
      : state.phase === "unknown"
        ? "会话状态待确认"
        : state.phase === "anonymous"
          ? "登录知阶"
          : passwordPage.value
            ? mustChange.value
              ? "先设置你的专属密码"
              : "修改密码"
            : workspace.value === "account"
              ? "账号与安全"
              : workspace.value === "privacy"
                ? "隐私与数据"
                : workspace.value === "training"
                  ? "课程与培训"
                  : workspace.value === "teaching"
                    ? "教学工作台"
                    : workspace.value === "learning"
                      ? "学习首页"
                      : workspace.value === "content"
                        ? "教材与内容"
                        : workspace.value === "assessment"
                          ? "练习与考试"
                          : "进入工作台",
);
const consolePageTitles: Record<string, string> = {
  overview: "工作台",
  users: "用户",
  organizations: "组织与成员",
  authorizations: "角色与授权",
  approvals: "审批中心",
  audit: "操作审计",
  business: "业务管理",
  content: "教材与题库",
  assessment: "考试管理",
  reports: "学情报告",
  safety: "安全处置",
};
watch(
  () => {
    if (!consoleShell.value) return `${title.value} | 知阶 KnowLadder`;
    const page = String(
      route.meta.consolePage || route.params.page || "overview",
    );
    const key =
      page === "business" ? String(route.params.module || "business") : page;
    return `${consolePageTitles[key] || "管理后台"} | 知阶管理后台`;
  },
  (value) => {
    document.title = value;
  },
  { immediate: true },
);
const organizationName = computed(
  () =>
    state.identity?.organizations.find(
      (org) => org.id === state.identity?.context?.org_id,
    )?.name,
);

function clearPasswords() {
  password.value = "";
  currentPassword.value = "";
  newPassword.value = "";
  confirmation.value = "";
}
watch(
  () => state.formEpoch,
  () => {
    clearPasswords();
    changing.value = false;
    localError.value = "";
    readingTarget.value = undefined;
    contentDirty.value = false;
    assessmentDirty.value = false;
    assessmentUnknown.value = false;
    safetyDirty.value = false;
    safetyUnknown.value = false;
    learningDirty.value = false;
    learningUnknown.value = false;
    readingPending.value = false;
    privacyUnknown.value = false;
    trainingDirty.value = false;
    trainingUnknown.value = false;
  },
);
let confirmedScope: string | undefined;
watch(
  () =>
    [
      state.phase,
      state.identity?.user.id,
      state.identity?.context?.org_id,
    ] as const,
  ([phase, user, org]) => {
    // Temporary loading/unknown identities hide content but must not erase original request keys.
    if (phase === "anonymous") {
      confirmedScope = undefined;
      clearAssessmentRecovery();
      return;
    }
    if (phase !== "authenticated" || !user) return;
    // Initial account hydration has no organization yet; retain only this account's recovery keys.
    if (!org) {
      clearAssessmentRecovery(
        undefined,
        confirmedScope ? undefined : user,
        user,
      );
      confirmedScope = undefined;
      return;
    }
    const next = `${user}:${org}`;
    clearAssessmentRecovery(
      confirmedScope && confirmedScope !== next ? undefined : next,
      undefined,
      user,
    );
    confirmedScope = next;
  },
  { flush: "sync" },
);
watch(message, async (value) => {
  if (value) {
    await nextTick();
    errorSummary.value?.focus();
  }
});
watch(title, async () => {
  await nextTick();
  heading.value?.focus();
});
async function login() {
  localError.value = "";
  signingIn.value = true;
  const pending = mutate("login", {
    login_name: loginName.value,
    password: password.value,
  });
  password.value = "";
  try {
    await pending;
    if (state.phase === "authenticated") await router.replace("/home");
  } finally {
    signingIn.value = false;
  }
}
async function changePassword() {
  localError.value = "";
  if (newPassword.value !== confirmation.value) {
    localError.value = "两次输入的新密码不一致，请重新确认。";
    return;
  }
  if (
    [...newPassword.value].length < 6 ||
    [...newPassword.value].length > 128 ||
    new TextEncoder().encode(newPassword.value).length > 512
  ) {
    localError.value =
      "新密码需为 6–128 个字符，且 UTF-8 编码不超过 512 字节。";
    return;
  }
  const pending = mutate("change-password", {
    current_password: currentPassword.value,
    new_password: newPassword.value,
  });
  clearPasswords();
  await pending;
}
async function selectOrganization(event: Event) {
  const org = (event.target as HTMLSelectElement).value;
  if (await confirmContentLeave()) {
    if (
      state.identity?.context?.org_id &&
      org !== state.identity.context.org_id
    )
      clearAssessmentRecovery(undefined, undefined, state.identity.user.id);
    await synchronize(org);
    if (
      state.phase === "authenticated" &&
      !mustChange.value &&
      workspace.value !== "account" &&
      workspace.value !== "privacy"
    )
      await router.replace("/home");
  } else
    (event.target as HTMLSelectElement).value =
      state.identity?.context?.org_id || "";
}
async function openPassword() {
  if (workspace.value !== "account") {
    await router.push("/account");
    if (route.path !== "/account") return;
  } else if (!(await confirmContentLeave())) return;
  changing.value = true;
  state.message = "";
  state.fields = {};
  localError.value = "";
}
function closePassword() {
  clearPasswords();
  changing.value = false;
  localError.value = "";
  state.message = "";
  state.fields = {};
}
async function retry() {
  if (!(await confirmContentLeave())) return;
  localError.value = "";
  void synchronize();
}
</script>

<template>
  <section
    v-if="trainingLeavePrompt"
    class="panel notice training-leave-confirm"
    role="alertdialog"
    aria-labelledby="training-leave-title"
    aria-describedby="training-leave-message"
    @keydown.esc.prevent="decideTrainingLeave(false)"
  >
    <h2 id="training-leave-title">确认离开培训工作区</h2>
    <p id="training-leave-message">{{ trainingLeavePrompt }}</p>
    <div class="actions">
      <button
        ref="trainingLeaveCancel"
        class="button secondary"
        @click="decideTrainingLeave(false)"
      >
        留在当前页面</button
      ><button class="button" @click="decideTrainingLeave(true)">
        确认继续
      </button>
    </div>
  </section>
  <a class="skip-link" href="#main-content">跳至正文</a>
  <CertificateVerification v-if="route.path === '/verify-certificate'" />
  <PublicSite v-else-if="publicPage" />
  <ConsoleWorkspace
    v-else-if="consoleShell && state.identity"
    ref="consoleWorkspace"
    :key="`${state.identity.user.id}:${state.identity.context?.org_id || ''}:${state.formEpoch}`"
    :identity="state.identity"
    :request="businessRequest"
    :busy="state.busy || navigationBusy"
    @organization="selectOrganization"
    @password="openPassword"
    @logout="logout"
    @unavailable="consoleAvailable = false"
    @write-active="consoleWriteState"
  />
  <template v-else>
    <header class="app-header">
      <div class="brand" aria-label="知阶 KnowLadder">
        <span class="brand-name">知阶</span
        ><span class="brand-en">KnowLadder</span>
      </div>
      <div
        v-if="
          state.phase === 'authenticated' && state.identity && !passwordPage
        "
        class="workspace-header-tools"
      >
        <label
          v-if="state.identity.organizations.length"
          class="workspace-organization"
          ><span>当前组织</span>
          <select
            aria-label="当前组织"
            :value="state.identity.context?.org_id || ''"
            :disabled="state.busy || navigationBusy"
            @change="selectOrganization"
          >
            <option value="">请选择组织</option>
            <option
              v-for="org in state.identity.organizations"
              :key="org.id"
              :value="org.id"
            >
              {{ org.name }}
            </option>
          </select>
        </label>
        <details
          ref="accountMenu"
          class="workspace-account-menu"
          @keydown.esc="accountMenu && (accountMenu.open = false)"
        >
          <summary
            :aria-label="state.identity.user.display_name + '的账号菜单'"
          >
            <span class="workspace-avatar" aria-hidden="true">{{
              Array.from(state.identity.user.display_name)[0]
            }}</span
            ><span>{{ state.identity.user.display_name }}</span>
          </summary>
          <div class="workspace-account-links">
            <RouterLink to="/account">账号与安全</RouterLink
            ><button :disabled="state.busy || navigationBusy" @click="logout">
              退出登录
            </button>
          </div>
        </details>
      </div>
      <span v-else class="header-note"
        ><BrandIcon name="shield-check" /> 账号与安全</span
      >
    </header>
    <main
      id="main-content"
      :class="[
        'layout',
        {
          'account-layout': state.phase === 'authenticated' && !passwordPage,
          'auth-layout': state.phase !== 'authenticated' || passwordPage,
        },
      ]"
    >
      <nav
        v-if="
          state.phase === 'authenticated' && state.identity && !passwordPage
        "
        class="content-workspace content-toolbar workspace-navigation"
        aria-label="工作台导航"
      >
        <button
          v-if="
            workspace === 'account' ||
            workspace === 'privacy' ||
            workspace === 'home' ||
            !workspaceAllowed
          "
          class="button secondary"
          :disabled="navigationBusy"
          :aria-pressed="workspace === 'home'"
          @click="selectWorkspace('home')"
        >
          返回工作台
        </button>
        <button
          v-if="canReadContent || canSafety || canLearn"
          class="button secondary"
          :aria-pressed="workspace === 'content'"
          @click="selectWorkspace('content')"
        >
          教材与内容工作台
        </button>
        <button
          v-if="canAssessment"
          class="button secondary"
          :aria-pressed="workspace === 'assessment'"
          @click="selectWorkspace('assessment')"
        >
          练习、考试与结果
        </button>
        <button
          v-if="canLearn"
          class="button secondary"
          :disabled="navigationBusy"
          :aria-pressed="workspace === 'learning'"
          @click="selectWorkspace('learning')"
        >
          学习首页
        </button>
        <button
          v-if="canTraining"
          class="button secondary"
          :disabled="navigationBusy"
          :aria-pressed="workspace === 'training'"
          @click="selectWorkspace('training')"
        >
          课程与培训
        </button>
        <button
          v-if="canTeach"
          class="button secondary"
          :disabled="navigationBusy"
          :aria-pressed="workspace === 'teaching'"
          @click="selectWorkspace('teaching')"
        >
          教学工作台
        </button>
        <button
          v-if="consoleAvailable"
          class="button secondary"
          :disabled="navigationBusy"
          :aria-pressed="workspace === 'console'"
          @click="selectWorkspace('console')"
        >
          管理控制台
        </button>
        <span v-if="readingPending" class="field-help" role="status"
          >阅读位置尚未确认；切换前会先尝试保存。</span
        >
      </nav>
      <div
        v-if="
          state.phase === 'authenticated' &&
          !passwordPage &&
          workspace !== 'account' &&
          message
        "
        class="notice content-workspace"
        role="status"
      >
        {{ message }}
      </div>
      <section
        v-if="
          workspace === 'home' &&
          state.phase === 'authenticated' &&
          state.identity &&
          !passwordPage
        "
        class="panel stack content-workspace"
      >
        <p class="eyebrow">WORKSPACE / 工作台</p>
        <h1>
          {{
            !state.identity.organizations.length
              ? "暂未加入组织"
              : !state.identity.context
                ? "选择你的工作组织"
                : consoleStatus === "error"
                  ? "暂时无法加载工作台"
                  : consoleStatus !== "ready" || defaultWorkspace
                    ? "正在进入工作台…"
                    : "暂未开通业务权限"
          }}
        </h1>
        <p class="muted">
          {{
            !state.identity.organizations.length
              ? "请联系管理员加入组织。你仍可管理账号与安全设置。"
              : !state.identity.context
                ? "请在顶部选择组织，系统会打开你有权访问的工作台。"
                : consoleStatus === "error"
                  ? "请检查网络后重试，或切换其他组织。"
                  : consoleStatus !== "ready" || defaultWorkspace
                    ? "正在确认可用功能，请稍候。"
                    : "请联系管理员确认你的职责，或在顶部切换组织。"
          }}
        </p>
        <button
          v-if="consoleStatus === 'error'"
          class="button"
          :disabled="state.busy"
          @click="checkConsole"
        >
          重试加载工作台
        </button>
        <RouterLink to="/account">账号与安全</RouterLink>
      </section>
      <section
        v-if="
          !workspaceAllowed && state.phase === 'authenticated' && !passwordPage
        "
        class="panel stack content-workspace"
      >
        <h1>
          {{
            state.identity?.context ? "当前组织无法访问此功能" : "请先选择组织"
          }}
        </h1>
        <p class="muted">在顶部选择其他组织，或返回工作台查看可用功能。</p>
        <RouterLink to="/home">返回工作台</RouterLink>
      </section>
      <nav
        v-if="
          workspace === 'privacy' &&
          state.phase === 'authenticated' &&
          !passwordPage
        "
        class="settings-breadcrumb"
        aria-label="设置路径"
      >
        <RouterLink to="/account">账号与安全</RouterLink
        ><span aria-hidden="true">/</span><span>隐私与数据</span>
      </nav>
      <h1
        v-if="
          state.phase === 'authenticated' &&
          !passwordPage &&
          workspaceAllowed &&
          workspace !== 'home' &&
          workspace !== 'account'
        "
        ref="heading"
        tabindex="-1"
      >
        {{ title }}
      </h1>
      <BrandJourney v-if="state.phase !== 'authenticated' || passwordPage" />
      <section
        v-if="
          state.phase !== 'authenticated' ||
          passwordPage ||
          workspace === 'account'
        "
        class="panel account-panel"
        :aria-busy="state.busy"
        aria-labelledby="page-title"
      >
        <div class="page-heading">
          <p class="eyebrow">
            {{
              state.phase === "authenticated"
                ? "ACCOUNT / 账号"
                : "WELCOME / 欢迎"
            }}
          </p>
          <h1 id="page-title" ref="heading" tabindex="-1">{{ title }}</h1>
          <p v-if="state.phase === 'anonymous'" class="muted">
            欢迎回来，从这里开启新的一步。
          </p>
          <p
            v-else-if="state.phase === 'authenticated' && passwordPage"
            class="muted"
          >
            {{
              mustChange
                ? "临时密码仅用于首次验证。完成改密后，请使用新密码重新登录。"
                : "修改后所有旧会话将失效，需要重新登录。"
            }}
          </p>
        </div>
        <div
          v-if="message"
          ref="errorSummary"
          class="notice"
          role="status"
          aria-live="polite"
          tabindex="-1"
        >
          <p>{{ message }}</p>
          <ul v-if="Object.keys(state.fields).length">
            <li v-for="(value, key) in state.fields" :key="key">{{ value }}</li>
          </ul>
          <p v-if="state.retryAfter">
            请求较频繁。Retry-After：{{
              state.retryAfter
            }}（秒数或服务器指定时间），请稍后再试。
          </p>
          <p v-if="state.requestId" class="request-id">
            请求编号：{{ state.requestId }}
          </p>
        </div>
        <div
          v-if="state.phase === 'loading'"
          class="status-block"
          role="status"
        >
          <span class="loading-mark" aria-hidden="true"></span>
          <p>正在安全连接，请稍候…</p>
        </div>
        <div v-else-if="state.phase === 'unknown'" class="stack">
          <p>
            为保护账号，已隐藏身份与组织信息。重新查询只会读取当前状态，不会重放登录或改密请求。
          </p>
          <button class="button" :disabled="state.busy" @click="retry">
            重新查询会话
          </button>
        </div>
        <form
          v-else-if="state.phase === 'anonymous'"
          class="stack"
          @submit.prevent="login"
        >
          <div class="field">
            <label for="login-name">登录名</label>
            <input
              id="login-name"
              v-model="loginName"
              name="username"
              autocomplete="username"
              autocapitalize="none"
              :spellcheck="false"
              required
              :disabled="state.busy"
              :aria-invalid="!!state.fields.login_name"
              aria-describedby="login-help"
            />
            <p id="login-help" class="field-help">
              登录名由管理员提供，不是显示姓名。
            </p>
          </div>
          <div class="field">
            <label for="login-password">密码</label>
            <input
              id="login-password"
              v-model="password"
              name="password"
              type="password"
              autocomplete="current-password"
              required
              :disabled="state.busy"
              :aria-invalid="!!state.fields.password"
            />
          </div>
          <button
            class="button login-submit"
            type="submit"
            :disabled="state.busy"
          >
            {{ state.busy ? "正在登录…" : "登录" }}
            <BrandIcon name="arrow-right" />
          </button>
          <div class="login-help">
            <BrandIcon name="shield-check" />
            <p class="field-help">
              账号由组织管理员开通，不提供自行注册。<br />忘记密码或临时密码已过期？请联系组织管理员重置。
            </p>
          </div>
        </form>
        <template v-else-if="state.identity">
          <form
            v-if="passwordPage"
            class="stack"
            @submit.prevent="changePassword"
          >
            <div class="field">
              <label for="current-password">当前密码</label>
              <input
                id="current-password"
                v-model="currentPassword"
                name="current-password"
                type="password"
                autocomplete="current-password"
                required
                :disabled="state.busy"
                :aria-invalid="!!state.fields.current_password"
              />
            </div>
            <div class="field">
              <label for="new-password">新密码</label>
              <input
                id="new-password"
                v-model="newPassword"
                name="new-password"
                type="password"
                autocomplete="new-password"
                required
                aria-describedby="password-help"
                :disabled="state.busy"
                :aria-invalid="!!state.fields.new_password"
              />
              <p id="password-help" class="field-help">
                6–128 个字符，最多 512
                字节。建议使用不与其他网站重复的长密码，支持粘贴。
              </p>
            </div>
            <div class="field">
              <label for="confirm-password">确认新密码</label>
              <input
                id="confirm-password"
                v-model="confirmation"
                name="confirm-password"
                type="password"
                autocomplete="new-password"
                required
                :disabled="state.busy"
                :aria-invalid="!!localError"
              />
            </div>
            <button class="button" type="submit" :disabled="state.busy">
              {{ state.busy ? "正在更新…" : "更新密码并重新登录" }}
            </button>
            <button
              v-if="!mustChange"
              class="button secondary"
              type="button"
              :disabled="state.busy"
              @click="closePassword"
            >
              取消修改
            </button>
          </form>
          <div v-else class="stack">
            <div class="identity">
              <span class="account-avatar" aria-hidden="true">{{
                Array.from(state.identity.user.display_name)[0]
              }}</span>
              <p class="field-help">显示姓名</p>
              <h2>{{ state.identity.user.display_name }}</h2>
            </div>
            <p class="muted">在这里管理登录安全与个人数据。</p>
            <section class="settings-section">
              <div>
                <h2>登录安全</h2>
                <p class="field-help">
                  定期检查账号安全，避免在共享设备上保持登录。
                </p>
              </div>
              <button
                class="button secondary"
                :disabled="state.busy"
                @click="openPassword"
              >
                修改密码
              </button>
            </section>
            <section class="settings-section">
              <div>
                <h2>隐私与数据</h2>
                <p class="field-help">
                  管理本人账号删除申请，查看处理进度与数据保留说明。
                </p>
              </div>
              <RouterLink class="button secondary settings-link" to="/privacy"
                >管理隐私与数据</RouterLink
              >
            </section>
            <details class="account-diagnostics">
              <summary>高级信息</summary>
              <p class="account-id">账号 ID · {{ state.identity.user.id }}</p>
              <p>{{ organizationName || "尚未选择组织" }}</p>
              <p class="field-help">以下技术标识用于排查访问权限问题。</p>
              <ul class="capabilities">
                <li
                  v-for="capability in state.identity.context?.capabilities ||
                  []"
                  :key="capability"
                >
                  <code>{{ capability }}</code>
                </li>
              </ul>
              <p v-if="state.identity.context?.student_conflict" class="notice">
                当前职责与学生学习权限冲突，请联系管理员确认。
              </p>
              <button class="text-button" :disabled="state.busy" @click="retry">
                重新检查账号信息
              </button>
            </details>
          </div>
          <div class="session-footer">
            <span class="field-help">{{
              mustChange
                ? "首次登录 · 尚未完成密码设置"
                : "使用共享设备时，请在离开前退出。"
            }}</span>
            <button class="text-button" :disabled="state.busy" @click="logout">
              退出登录
            </button>
          </div>
        </template>
      </section>

      <ContentWorkspace
        ref="contentWorkspace"
        :reading-target="readingTarget"
        @reading-pending="readingPending = $event"
        v-if="
          workspace === 'content' &&
          state.phase === 'authenticated' &&
          state.identity?.context?.org_id &&
          !passwordPage &&
          (canReadContent || canLearn)
        "
        :key="`${state.identity.user.id}:${state.identity.context.org_id}:${state.formEpoch}`"
        :identity="state.identity"
        :request="businessRequest"
        @dirty="contentDirty = $event"
      />
      <section
        v-if="
          workspace === 'content' &&
          canSafety &&
          !canReadContent &&
          state.phase === 'authenticated' &&
          state.identity?.context?.org_id &&
          !passwordPage
        "
        class="panel content-workspace"
      >
        <BusinessSafetyPage
          :key="`${state.identity.user.id}:${state.identity.context.org_id}:${state.formEpoch}:safety`"
          :request="businessRequest"
          :capabilities="state.identity.context.capabilities"
          :database-mode="consoleDatabaseMode"
          :locked="false"
          :recovery-scope="`${state.identity.user.id}:${state.identity.context.org_id}`"
          @dirty="safetyDirty = $event"
          @unknown="safetyUnknown = $event"
        />
      </section>
      <AssessmentWorkspace
        v-if="
          workspace === 'assessment' &&
          canAssessment &&
          state.phase === 'authenticated' &&
          state.identity?.context?.org_id &&
          !passwordPage
        "
        :key="`${state.identity.user.id}:${state.identity.context.org_id}:${state.formEpoch}`"
        :identity="state.identity"
        :request="businessRequest"
        @dirty="assessmentDirty = $event"
        @unknown="assessmentUnknown = $event"
      />
      <LearningWorkspace
        v-if="
          workspace === 'learning' &&
          canLearn &&
          state.phase === 'authenticated' &&
          state.identity?.context?.org_id &&
          !passwordPage
        "
        :key="`${state.identity.user.id}:${state.identity.context.org_id}:${state.formEpoch}`"
        :identity="state.identity"
        :request="businessRequest"
        @dirty="learningDirty = $event"
        @unknown="learningUnknown = $event"
        @read="openReading"
      />
      <TeacherWorkspace
        v-if="
          workspace === 'teaching' &&
          canTeach &&
          state.phase === 'authenticated' &&
          state.identity?.context?.org_id &&
          !passwordPage
        "
        :key="`${state.identity.user.id}:${state.identity.context.org_id}:${state.formEpoch}`"
        :identity="state.identity"
        :request="businessRequest"
        @dirty="teachingDirty = $event"
        @unknown="teachingUnknown = $event"
        @open-assessment="selectWorkspace('assessment')"
      />
      <TrainingWorkspace
        v-if="
          workspace === 'training' &&
          canTraining &&
          state.phase === 'authenticated' &&
          state.identity?.context?.org_id &&
          !passwordPage
        "
        :key="
          state.identity.user.id +
          ':' +
          state.identity.context.org_id +
          ':' +
          state.formEpoch
        "
        :identity="state.identity"
        :request="businessRequest"
        @dirty="trainingDirty = $event"
        @unknown="trainingUnknown = $event"
          @reading="openReading"
      />
      <PrivacyWorkspace
        v-if="
          workspace === 'privacy' &&
          state.phase === 'authenticated' &&
          state.identity &&
          !passwordPage
        "
        :key="`${state.identity.user.id}:${state.formEpoch}`"
        :identity="state.identity"
        :request="globalRequest"
        @unknown="privacyUnknown = $event"
      />
    </main>
    <footer class="site-footer">
      知阶 KnowLadder
      <span aria-hidden="true">·</span> 账号安全，从每一次登录开始。
    </footer>
  </template>
</template>
