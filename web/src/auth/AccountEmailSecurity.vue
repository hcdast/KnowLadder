<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ApiError } from "../session";
import { retryAt, type EmailCapabilities, type EmailClient } from "./email";
const props = defineProps<{
  client: EmailClient; userId: string; loginName: string; emailState: "unbound" | "verified" | "needs_reverify"; maskedEmail: string | null;
  locked?: boolean; sessionChanged: (budget: number, expectedUserId?: string | null) => Promise<boolean>; recoverSession: () => Promise<void>;
}>();
const emit = defineEmits<{ dirty: [value: boolean]; unknown: [value: boolean]; active: [value: boolean]; sessionUncertain: [] }>();
const capabilities = ref<EmailCapabilities>(), configError = ref(""), email = ref(""), password = ref(""), showPassword = ref(false);
const busy = ref(false), unknown = ref(false), error = ref(""), message = ref(""), requestId = ref(""), retryUntil = ref(0), clock = ref(Date.now()), summary = ref<HTMLElement>();
const dirty = computed(() => !!email.value || !!password.value);
const blocked = computed(() => busy.value || props.locked || unknown.value || retryUntil.value > clock.value || !capabilities.value);
let controller = new AbortController(), alive = true, generation = 0, timer = 0;
watch(dirty, value => emit("dirty", value), { flush: "sync" });
watch(unknown, value => emit("unknown", value), { flush: "sync" });
watch(busy, value => emit("active", value), { flush: "sync" });
async function loadCapabilities() {
  configError.value = ""; const stamp = generation;
  try { const result = await props.client.capabilities(controller.signal); if (alive && stamp === generation) capabilities.value = result; }
  catch { if (alive && stamp === generation) { capabilities.value = undefined; configError.value = "邮箱服务能力暂未确认，请重新查询。"; } }
}
async function submit(remove = false) {
  if (blocked.value || !remove && !capabilities.value?.email_actions) return;
  if (remove && !window.confirm(`确定解除 ${props.maskedEmail || '当前'} 恢复邮箱？旧邮箱恢复凭证立即失效。请保存备用用户名 ${props.loginName}；未绑定邮箱时不能通过邮件找回密码。`)) return;
  if (!remove && props.emailState !== "unbound" && !window.confirm("确定申请换绑邮箱？只有新邮箱验证成功后才替换当前邮箱，并使旧恢复凭证失效。")) return;
  busy.value = true; error.value = ""; message.value = ""; requestId.value = "";
  const stamp = generation, deadline = performance.now() + 30000, expectedUserId = props.userId;
  try {
    const pending = props.client.post(remove ? "/auth/email-binding/remove" : "/auth/email-binding/request", { expected_user_id: expectedUserId, current_password: password.value, ...(!remove ? { email: email.value.trim() } : {}) }, controller.signal);
    password.value = ""; showPassword.value = false;
    await pending;
    if (!alive || stamp !== generation) return;
    if (remove) {
      message.value = "邮箱解绑已由服务端确认，旧恢复凭证已失效。";
      if (!await props.sessionChanged(deadline - performance.now(), expectedUserId)) { unknown.value = true; message.value += " 当前身份信息仍待只读核对，不会重复解绑。"; }
    } else { message.value = "验证申请已受理，不代表邮件已送达。请在登录本人账号的浏览器打开邮件并明确确认；换绑确认前旧邮箱保持不变。"; retryUntil.value = Date.now() + 60000; }
    email.value = "";
  } catch (cause) {
    if (!alive || stamp !== generation) return;
    if (cause instanceof ApiError) {
      error.value = cause.message; requestId.value = cause.requestId;
      if (cause.status === 429) retryUntil.value = retryAt(cause.retryAfter);
      if (cause.status === 409 && cause.code === "AUTH_ACCOUNT_SWITCH_REQUIRED") { unknown.value = true; emit("sessionUncertain"); }
      if ([401, 403].includes(cause.status) && cause.code !== "INVALID_CREDENTIALS") emit("sessionUncertain");
      if (cause.status >= 500) unknown.value = true;
    } else { unknown.value = true; error.value = cause instanceof DOMException && cause.name === "TimeoutError" ? "请求超时，结果尚未确认。" : "网络中断，结果尚未确认。"; }
    if (unknown.value) error.value += " 不会自动重发。请只读查询本人邮箱状态；解绑未确认时不要重复提交。";
    await nextTick(); summary.value?.focus();
  } finally { password.value = ""; showPassword.value = false; if (alive && stamp === generation) busy.value = false; }
}
async function beforeLeave() {
  if ((busy.value || unknown.value) && !window.confirm("邮箱写请求结果仍待确认；离开不取消服务端写入，也不会重发。确定离开？")) return false;
  if (dirty.value && !window.confirm("邮箱安全表单尚未提交，确定放弃输入？")) return false;
  password.value = ""; return true;
}
defineExpose({ beforeLeave });
watch(() => props.userId, () => { generation++; controller.abort(); controller = new AbortController(); email.value = ""; password.value = ""; busy.value = false; unknown.value = false; error.value = ""; message.value = ""; capabilities.value = undefined; void loadCapabilities(); });
onMounted(() => { timer = window.setInterval(() => { clock.value = Date.now(); }, 1000); void loadCapabilities(); });
onBeforeUnmount(() => { alive = false; generation++; controller.abort(); window.clearInterval(timer); password.value = ""; emit("dirty", false); emit("unknown", false); emit("active", false); });
</script>
<template>
  <section class="email-security" :aria-busy="busy">
    <h2>邮箱与账号恢复</h2><p>登录用户名：<strong>{{ loginName }}</strong></p>
    <p>当前邮箱：{{ emailState === 'verified' ? maskedEmail : emailState === 'needs_reverify' ? `${maskedEmail || '恢复邮箱'}（需要重新验证，不能用于找回）` : '尚未绑定' }}</p>
    <div v-if="error" ref="summary" class="notice danger" role="alert" tabindex="-1">{{ error }}<small v-if="requestId">请求编号：{{ requestId }}</small></div><p v-if="message" role="status" class="notice">{{ message }}</p>
    <div v-if="configError || !capabilities"><p>{{ configError || '正在确认邮件服务能力…' }}</p><button type="button" :disabled="busy || locked" @click="loadCapabilities">重新查询邮件能力</button></div>
    <p v-else-if="!capabilities.email_actions" class="field-help">暂未开放绑定或更换邮箱，现有登录方式仍可使用。</p>
    <details><summary>登录与账号恢复说明</summary><p>已验证邮箱或用户名均可用于密码登录。邮件申请关闭不会停用现有密码登录；未绑定邮箱不能通过邮件找回。受保护机构账号恢复仍需独立审批。</p></details>
    <p v-if="retryUntil > clock" role="status">请等待 {{ Math.ceil((retryUntil - clock) / 1000) }} 秒后再次申请。</p>
    <div v-if="unknown" class="notice"><p>请先核对邮箱状态。此查询不会重放原操作。</p><button type="button" :disabled="busy || locked" @click="recoverSession">只读查询本人状态</button></div>
    <form v-if="capabilities?.email_actions" @submit.prevent="submit(false)"><fieldset :disabled="blocked"><label>新邮箱<input v-model="email" type="email" maxlength="254" autocomplete="email" required /></label><label>当前密码<input v-model="password" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" maxlength="128" required /></label><button type="button" :aria-pressed="showPassword" @click="showPassword = !showPassword">{{ showPassword ? '隐藏密码' : '显示密码' }}</button><button type="submit">{{ busy ? '正在受理…' : emailState === 'unbound' ? '申请绑定邮箱' : '申请换绑并验证新邮箱' }}</button></fieldset></form>
    <form v-if="emailState !== 'unbound'" @submit.prevent="submit(true)"><fieldset :disabled="blocked"><label>解绑确认 · 当前密码<input v-model="password" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" maxlength="128" required /></label><button type="submit" class="danger">解除当前恢复邮箱</button></fieldset></form>
  </section>
</template>
<style scoped>
.email-security{display:grid;gap:.75rem;max-width:42rem}fieldset{display:grid;gap:1rem;border:0;padding:0;min-width:0}label{display:grid;gap:.4rem}input{box-sizing:border-box;width:100%;min-height:2.75rem}button{min-height:2.75rem}.notice{border:1px solid var(--border,#c8d0db);border-radius:.5rem;padding:1rem;overflow-wrap:anywhere}.danger{color:#b42318}small{display:block}p{line-height:1.6}
</style>
