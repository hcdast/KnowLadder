<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useSession } from "./session";
import ContentWorkspace from "./content/ContentWorkspace.vue";
import AssessmentWorkspace from "./assessment/AssessmentWorkspace.vue";
import LearningWorkspace from "./learning/LearningWorkspace.vue";
import PrivacyWorkspace from "./privacy/PrivacyWorkspace.vue";

const { state, synchronize, mutate, businessRequest, globalRequest } = useSession();
const contentDirty = ref(false);
const assessmentDirty = ref(false);
const assessmentUnknown = ref(false);
const learningDirty = ref(false);
const learningUnknown = ref(false);
const privacyUnknown = ref(false);
const readingPending = ref(false);
const contentWorkspace = ref<{ beforeLeave: () => Promise<boolean> }>();
const readingTarget = ref<{ editionId: string; chapterId: string }>();
const workspace = ref<"content" | "assessment" | "learning" | "privacy">("content");
const navigationBusy = ref(false);
const canLearn = computed(() => {
  const caps = state.identity?.context?.capabilities || [];
  return caps.includes("learning:self") && !caps.some(value => ["content:edit", "content:review", "assessment:manage", "assessment:review"].includes(value));
});
async function selectWorkspace(value: typeof workspace.value) {
  if (value !== workspace.value && await confirmContentLeave()) { readingTarget.value = undefined; workspace.value = value; }
}
async function openReading(target: { editionId: string; chapterId: string }) {
  if (await confirmContentLeave()) { readingTarget.value = target; workspace.value = "content"; }
}
async function confirmContentLeave() {
  if (navigationBusy.value) return false;
  navigationBusy.value = true;
  const epoch = state.formEpoch;
  try {
    if (contentDirty.value && !window.confirm("内容草稿尚未保存，确定放弃本地修改并继续？")) return false;
    if ((assessmentDirty.value || learningDirty.value) && !window.confirm("练测作答或考试草稿尚未保存，确定离开？")) return false;
    if ((assessmentUnknown.value || learningUnknown.value) && !window.confirm("练测请求结果待确认。离开不会取消请求；请保留原请求恢复记录。确定继续？")) return false;
    if (privacyUnknown.value && !window.confirm("隐私申请结果待确认。离开不会取消申请；恢复时须重新输入密码并沿用原请求编号。确定继续？")) return false;
    if (workspace.value === "content" && contentWorkspace.value && !await contentWorkspace.value.beforeLeave()) return false;
    return epoch === state.formEpoch;
  } finally { navigationBusy.value = false; }
}
function clearAssessmentRecovery(keepScope?: string, keepUser?: string, keepPrivacyUser?: string) {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith('privacy-recovery:') && key !== `privacy-recovery:${keepPrivacyUser}:account`) sessionStorage.removeItem(key);
      for (const prefix of ['assessment-recovery:', 'assessment-admin-recovery:', 'learning-recovery:']) {
        if (key.startsWith(prefix) && key !== `${prefix}${keepScope}` && !(keepUser && key.startsWith(`${prefix}${keepUser}:`))) sessionStorage.removeItem(key);
      }
    }
  } catch { /* Storage may be unavailable; identity isolation still unmounts sensitive views. */ }
}
async function refreshSession() {
  if (await confirmContentLeave()) await mutate("refresh");
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
const title = computed(() =>
  state.phase === "loading"
    ? "正在确认你的身份"
    : state.phase === "unknown"
      ? "会话状态待确认"
      : state.phase === "anonymous"
        ? "登录知阶"
        : passwordPage.value
          ? mustChange.value
            ? "先设置你的专属密码"
            : "修改密码"
          : "我的账号",
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
    contentDirty.value = false; assessmentDirty.value = false; assessmentUnknown.value = false;
    learningDirty.value = false; learningUnknown.value = false; readingPending.value = false;
    privacyUnknown.value = false;
  },
);
let confirmedScope: string | undefined;
watch(() => [state.phase, state.identity?.user.id, state.identity?.context?.org_id] as const, ([phase, user, org]) => {
  // Temporary loading/unknown identities hide content but must not erase original request keys.
  if (phase === 'anonymous') { confirmedScope = undefined; clearAssessmentRecovery(); return; }
  if (phase !== 'authenticated' || !user) return;
  // Initial account hydration has no organization yet; retain only this account's recovery keys.
  if (!org) { clearAssessmentRecovery(undefined, confirmedScope ? undefined : user, user); confirmedScope = undefined; return; }
  const next = `${user}:${org}`;
  clearAssessmentRecovery(confirmedScope && confirmedScope !== next ? undefined : next, undefined, user);
  confirmedScope = next;
}, { flush: 'sync' });
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
  const pending = mutate("login", {
    login_name: loginName.value,
    password: password.value,
  });
  password.value = "";
  await pending;
}
async function changePassword() {
  localError.value = "";
  if (newPassword.value !== confirmation.value) {
    localError.value = "两次输入的新密码不一致，请重新确认。";
    return;
  }
  if (
    [...newPassword.value].length < 12 ||
    [...newPassword.value].length > 128 ||
    new TextEncoder().encode(newPassword.value).length > 512
  ) {
    localError.value =
      "新密码需为 12–128 个字符，且 UTF-8 编码不超过 512 字节。";
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
    if (state.identity?.context?.org_id && org !== state.identity.context.org_id) clearAssessmentRecovery(undefined, undefined, state.identity.user.id);
    void synchronize(org);
  }
  else (event.target as HTMLSelectElement).value = state.identity?.context?.org_id || "";
}
async function openPassword() {
  if (!await confirmContentLeave()) return;
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
  if (!await confirmContentLeave()) return;
  localError.value = "";
  void synchronize();
}
</script>

<template>
  <a class="skip-link" href="#main-content">跳至正文</a>
  <header class="app-header">
    <div class="brand" aria-label="知阶 KnowLadder">
      <span class="brand-name">知阶</span
      ><span class="brand-en">KnowLadder</span>
    </div>
    <span class="header-note">账号与安全</span>
  </header>
  <main
    id="main-content"
    :class="[
      'layout',
      { 'account-layout': state.phase === 'authenticated' && !passwordPage },
    ]"
  >
    <aside class="intro" aria-label="知阶介绍">
      <p class="eyebrow">知阶而上 · 智达未来</p>
      <h2>每一步，<br />从安心开始。</h2>
      <p>用自己的账号，连接所属组织。<br />让每一次出发，都有清晰的起点。</p>
      <div class="intro-rule"></div>
      <p class="intro-footnote">
        此处提供账号登录与安全管理。<br />账号由组织管理员开通，不提供自行注册。
      </p>
    </aside>
    <section class="panel" :aria-busy="state.busy" aria-labelledby="page-title">
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
          请输入管理员提供的登录名与密码。
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
      <div v-if="state.phase === 'loading'" class="status-block" role="status">
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
        <button class="button" type="submit" :disabled="state.busy">
          {{ state.busy ? "正在登录…" : "登录" }}
        </button>
        <p class="field-help">
          忘记密码或临时密码已过期？请联系组织管理员重置。
        </p>
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
              12–128 个字符，最多 512
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
            <p class="field-help">显示姓名</p>
            <h2>{{ state.identity.user.display_name }}</h2>
            <p class="account-id">账号 ID · {{ state.identity.user.id }}</p>
          </div>
          <section
            class="organization-section"
            aria-labelledby="organization-title"
          >
            <h2 id="organization-title">组织与权限</h2>
            <div v-if="state.identity.organizations.length" class="field">
              <label for="organization">当前组织</label>
              <select
                id="organization"
                :value="state.identity.context?.org_id || ''"
                :disabled="state.busy || navigationBusy"
                aria-describedby="organization-help"
                @change="selectOrganization"
              >
                <option value="">未选择组织</option>
                <option
                  v-for="org in state.identity.organizations"
                  :key="org.id"
                  :value="org.id"
                >
                  {{ org.name }}
                </option>
              </select>
              <p id="organization-help" class="field-help">
                仅影响当前标签页；每次切换都会重新校验访问权限。
              </p>
            </div>
            <p v-else class="muted">
              当前没有可访问的组织。如需加入组织，请联系管理员。
            </p>
            <template v-if="state.identity.context">
              <p class="capability-title">
                {{ organizationName || "当前组织" }} · 已授权能力
              </p>
              <ul
                v-if="state.identity.context.capabilities.length"
                class="capabilities"
              >
                <li
                  v-for="capability in state.identity.context.capabilities"
                  :key="capability"
                >
                  <code>{{ capability }}</code>
                </li>
              </ul>
              <p v-else class="muted">
                当前组织暂未授予任何能力，请联系管理员确认。
              </p>
            </template>
            <p v-else-if="state.identity.organizations.length" class="muted">
              选择一个组织，查看服务端确认的授权能力。
            </p>
          </section>
          <div class="actions">
            <button
              class="button secondary"
              :disabled="state.busy"
              @click="openPassword"
            >
              修改密码
            </button>
            <button
              class="button secondary"
              :disabled="state.busy"
              @click="refreshSession"
            >
              续期会话
            </button>
            <button
              class="button secondary"
              :disabled="state.busy"
              @click="retry"
            >
              刷新账号信息
            </button>
          </div>
        </div>
        <div class="session-footer">
          <span class="field-help">{{
            mustChange
              ? "首次登录 · 尚未完成密码设置"
              : "使用共享设备时，请在离开前退出。"
          }}</span>
          <button
            class="text-button"
            :disabled="state.busy"
            @click="logout"
          >
            退出登录
          </button>
        </div>
      </template>
    </section>
    <nav v-if="state.phase === 'authenticated' && state.identity && !passwordPage" class="content-workspace content-toolbar" aria-label="账号与业务导航">
      <button v-if="state.identity.context?.capabilities.some(value => ['learning:self', 'content:edit', 'content:review', 'content:retire', 'content:revoke', 'file:delete'].includes(value))" class="button secondary" :aria-pressed="workspace === 'content'" @click="selectWorkspace('content')">教材与内容工作台</button>
      <button v-if="state.identity.context?.capabilities.some(value => ['learning:self', 'assessment:manage', 'assessment:review'].includes(value))" class="button secondary" :aria-pressed="workspace === 'assessment'" @click="selectWorkspace('assessment')">练习、考试与结果</button>
      <button v-if="canLearn" class="button secondary" :disabled="navigationBusy" :aria-pressed="workspace === 'learning'" @click="selectWorkspace('learning')">学情、错题与推荐</button>
      <button class="button secondary" :disabled="navigationBusy" :aria-pressed="workspace === 'privacy'" @click="selectWorkspace('privacy')">账号隐私</button>
      <span v-if="readingPending" class="field-help" role="status">阅读位置尚未确认；切换前会先尝试保存。</span>
    </nav>
    <ContentWorkspace
      ref="contentWorkspace"
      :reading-target="readingTarget"
      @reading-pending="readingPending = $event"
      v-if="workspace === 'content' && state.phase === 'authenticated' && state.identity?.context?.org_id && !passwordPage && state.identity.context.capabilities.some(capability => ['content:edit', 'content:review', 'content:retire', 'content:revoke', 'file:delete', 'learning:self'].includes(capability))"
      :key="`${state.identity.user.id}:${state.identity.context.org_id}:${state.formEpoch}`"
      :identity="state.identity"
      :request="businessRequest"
      @dirty="contentDirty = $event"
    />
    <AssessmentWorkspace
      v-if="workspace === 'assessment' && state.phase === 'authenticated' && state.identity?.context?.org_id && !passwordPage && state.identity.context.capabilities.some(value => ['learning:self', 'assessment:manage', 'assessment:review'].includes(value))"
      :key="`${state.identity.user.id}:${state.identity.context.org_id}:${state.formEpoch}`"
      :identity="state.identity"
      :request="businessRequest"
      @dirty="assessmentDirty = $event"
      @unknown="assessmentUnknown = $event"
    />
    <LearningWorkspace
      v-if="workspace === 'learning' && canLearn && state.phase === 'authenticated' && state.identity?.context?.org_id && !passwordPage"
      :key="`${state.identity.user.id}:${state.identity.context.org_id}:${state.formEpoch}`"
      :identity="state.identity"
      :request="businessRequest"
      @dirty="learningDirty = $event"
      @unknown="learningUnknown = $event"
      @read="openReading"
    />
    <PrivacyWorkspace
      v-if="workspace === 'privacy' && state.phase === 'authenticated' && state.identity && !passwordPage"
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
