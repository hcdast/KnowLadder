<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import type { Phase, LogoutResult } from "../session";
import type { EmailCapabilities } from "./email";
import { loginProviders, type LoginProvider } from "./providers";
const props = defineProps<{
  phase: Phase;
  busy: boolean;
  submitting?: boolean;
  message?: string;
  fields?: Record<string, string>;
  capabilities?: EmailCapabilities;
  logoutResult?: LogoutResult;
  providers?: readonly LoginProvider[];
}>();
const emit = defineEmits<{
  submit: [credentials: { login_name: string; password: string }];
  retry: [];
}>();
const username = ref(""),
  password = ref(""),
  visible = ref(false),
  notice = ref<HTMLElement>();
const unavailable = computed(() => props.busy || props.phase !== "anonymous");
watch(
  () => props.phase,
  () => {
    password.value = "";
    visible.value = false;
  },
);
watch(
  () => props.message,
  async (value) => {
    if (value) {
      await nextTick();
      notice.value?.focus();
    }
  },
);
onBeforeUnmount(() => {
  password.value = "";
});
function submit() {
  if (props.busy || props.phase !== "anonymous") return;
  emit("submit", { login_name: username.value, password: password.value });
  password.value = "";
  visible.value = false;
}
</script>
<template>
  <div class="simple-login">
    <form
      v-if="phase !== 'authenticated' || submitting"
      :aria-busy="busy"
      @submit.prevent="submit"
    >
      <div
        v-if="message && (phase === 'anonymous' || submitting)"
        ref="notice"
        class="login-notice"
        role="status"
        tabindex="-1"
      >
        {{ message }}
      </div>
      <label for="login-name">{{
        capabilities?.email_password_login ? "用户名或邮箱" : "用户名"
      }}</label>
      <input
        id="login-name"
        v-model="username"
        name="username"
        :placeholder="
          capabilities?.email_password_login
            ? '请输入用户名或已验证邮箱'
            : '请输入用户名'
        "
        autocomplete="username"
        autocapitalize="none"
        :spellcheck="false"
        required
        :disabled="unavailable"
        :aria-invalid="!!fields?.login_name"
      />
      <p v-if="fields?.login_name" class="login-field-error">
        {{ fields.login_name }}
      </p>
      <div class="password-label">
        <label for="login-password">密码</label
        ><RouterLink v-if="capabilities?.email_actions" to="/forgot-password"
          >忘记密码？</RouterLink
        >
      </div>
      <div class="password-control">
        <input
          id="login-password"
          v-model="password"
          name="password"
          placeholder="请输入密码"
          :type="visible ? 'text' : 'password'"
          autocomplete="current-password"
          required
          :disabled="unavailable"
          :aria-invalid="!!fields?.password"
        />
        <button
          type="button"
          :aria-label="visible ? '隐藏密码' : '显示密码'"
          :aria-pressed="visible"
          :disabled="unavailable"
          @click="visible = !visible"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
            <circle cx="12" cy="12" r="3" />
            <path v-if="visible" d="m3 3 18 18" />
          </svg>
        </button>
      </div>
      <p v-if="fields?.password" class="login-field-error">
        {{ fields.password }}
      </p>
      <button class="button login-submit" type="submit" :disabled="unavailable">
        {{ submitting ? "正在登录…" : "登录" }}
      </button>
      <div
        v-if="(providers || loginProviders).length"
        class="login-providers"
        aria-label="其他登录方式"
      >
        <p>或使用其他方式</p>
        <button
          v-for="provider in providers || loginProviders"
          :key="provider.id"
          type="button"
          :disabled="unavailable"
          @click="provider.start()"
        >
          {{ provider.label }}
        </button>
      </div>
      <p
        v-if="capabilities?.public_registration && capabilities.email_actions"
        class="registration"
      >
        还没有账号？ <RouterLink to="/register">注册个人账号</RouterLink>
      </p>
      <div class="login-footer">
        <p
          v-if="phase === 'loading' && !submitting"
          class="login-connecting"
          role="status"
        >
          {{
            logoutResult === "pending"
              ? "正在退出登录，请稍候…"
              : "正在连接，连接后即可登录…"
          }}
        </p>
        <div v-else-if="phase === 'unknown'" class="login-unavailable">
          <p role="status">
            {{
              logoutResult === "unconfirmed"
                ? "退出结果尚未确认，请重新连接核对。"
                : "连接暂不可用，请重试。"
            }}
          </p>
          <div class="login-recovery">
            <button type="button" :disabled="busy" @click="emit('retry')">
              重新连接
            </button>
            <RouterLink to="/">返回首页</RouterLink>
          </div>
        </div>
        <details v-else class="login-guidance">
          <summary>需要登录帮助？</summary>
          <p>
            机构账号请使用管理员提供的用户名。邮箱登录需先完成本人邮箱验证。首次登录按提示设置新密码。
          </p>
          <p>
            无法找回密码时，请通过已知联系方式联系组织管理员；无需提供旧密码。
          </p>
          <RouterLink to="/help">查看使用帮助</RouterLink>
        </details>
      </div>
    </form>
    <slot name="return-flow" />
  </div>
</template>
<style scoped>
.simple-login {
  color: #263d50;
}
.simple-login form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.simple-login label {
  font-size: 14px;
  font-weight: 600;
}
.simple-login input {
  width: 100%;
  min-width: 0;
  border: 1px solid #c5d3df;
  border-radius: 9px;
  background: #fff;
  padding: 10px 12px;
  color: #172e40;
  font-size: 16px;
  height: 44px;
  min-height: 44px;
  line-height: 22px;
}
.simple-login input:disabled {
  background: #f7f9fc;
  color: #63798a;
  cursor: not-allowed;
}
.simple-login input::placeholder {
  color: #748697;
  font-size: 14px;
}
.simple-login input:focus-visible {
  outline: 3px solid #9ccaf5;
  outline-offset: 2px;
}
.password-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 8px;
}
.password-label a,
.simple-login a {
  color: #1263b0;
  font-size: 13px;
}
.password-control {
  position: relative;
}
.password-control input {
  padding-right: 50px;
}
.password-control button {
  position: absolute;
  right: 4px;
  top: 1px;
  width: 42px;
  height: 42px;
  border: 0;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  color: #496075;
}
.password-control svg {
  width: 21px;
  height: 21px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
}
.login-submit {
  margin-top: 12px;
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 44px;
  padding: 9px 14px;
  font-size: 15px;
  font-weight: 600;
  width: 100%;
  background: #1263b0;
  border-color: #1263b0;
}
.registration {
  text-align: center;
  font-size: 13px;
  margin: 12px 0 0;
}
.login-guidance {
  margin: 0;
  font-size: 13px;
  color: #536a7c;
}
.login-guidance summary {
  cursor: pointer;
  min-height: 32px;
}
.login-guidance p {
  line-height: 1.8;
}
.login-footer {
  min-height: 64px;
  padding-top: 8px;
  font-size: 13px;
  line-height: 20px;
}
.login-connecting {
  color: #63798a;
}
.login-unavailable {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  color: #8c4f19;
}
.login-recovery {
  display: grid;
  gap: 4px;
  text-align: center;
}
.login-recovery button {
  border: 1px solid #c5d3df;
  border-radius: 6px;
  padding: 4px 10px;
  background: white;
  color: #1263b0;
  font-size: 13px;
  line-height: 20px;
}
.login-notice {
  padding: 12px;
  background: #fff7e7;
  border: 1px solid #ebd9ad;
  border-radius: 8px;
  font-size: 14px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.login-field-error {
  font-size: 13px;
  color: #a3332c;
  margin: 0;
}
.login-providers {
  display: grid;
  gap: 10px;
  text-align: center;
}
.login-providers button {
  padding: 12px;
  background: #fff;
  border: 1px solid #c5d3df;
  border-radius: 8px;
}
.login-providers p {
  color: #64798a;
  font-size: 13px;
}
button:focus-visible,
summary:focus-visible,
a:focus-visible {
  outline: 3px solid #9ccaf5;
  outline-offset: 3px;
}
button:disabled {
  cursor: wait;
  opacity: 0.65;
}
</style>
