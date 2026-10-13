<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { ApiError } from "../session";
import { hasEmailTokenFragment, policyUrl, retryAt, type ActivationResult, type EmailAction, type EmailCapabilities, type EmailClient, type EmailFlow, type EmailPurpose, type InvitationInspection } from "./email";

const props = defineProps<{
  client: EmailClient; flow: EmailFlow; phase: "loading" | "anonymous" | "authenticated" | "unknown";
  userId?: string; locked?: boolean;
  beforeAuthSwitch: () => Promise<boolean>;
  sessionChanged: (budget: number, expectedUserId?: string | null) => Promise<boolean>;
  recoverSession: () => Promise<void>;
}>();
const emit = defineEmits<{ dirty: [value: boolean]; unknown: [value: boolean]; active: [value: boolean]; sessionUncertain: []; login: []; completed: [result: ActivationResult | undefined] }>();
const route = useRoute(), router = useRouter();
const capabilities = ref<EmailCapabilities>(), configError = ref(""), busy = ref(false), message = ref(""), error = ref("");
const fields = ref<Record<string, string>>({}), requestId = ref(""), retryUntil = ref(0), clock = ref(Date.now()), unknown = ref(false), accountSwitch = ref(false);
const email = ref(""), displayName = ref(""), password = ref(""), confirmation = ref(""), showPassword = ref(false);
const ageBand = ref(""), acceptedTerms = ref(false), acceptedPrivacy = ref(false), inspection = ref<InvitationInspection>(), inspected = ref(false), done = ref(false);
const summary = ref<HTMLElement>(), loginName = ref("");
let controller = new AbortController(), generation = 0, timer = 0, alive = true;
const purpose = computed<EmailPurpose>(() => ["/forgot-password", "/reset-password"].includes(route.path) ? "reset" : route.path === "/accept-invitation" ? "invite" : route.path === "/verify-email" && props.flow.purpose === "bind" ? "bind" : "register");
const requesting = computed(() => ["/register", "/forgot-password"].includes(route.path));
const token = computed(() => { clock.value; return props.flow.read(purpose.value); });
const title = computed(() => route.path === "/register" ? "创建成年个人账号" : route.path === "/forgot-password" ? "找回密码" : purpose.value === "reset" ? "设置新密码" : purpose.value === "bind" ? "确认本人邮箱" : purpose.value === "invite" ? "机构邀请" : "验证邮箱并激活账号");
const policiesReady = computed(() => !!capabilities.value?.terms_version && !!capabilities.value?.privacy_notice_version && !!policyUrl(capabilities.value.terms_url) && !!policyUrl(capabilities.value.privacy_notice_url));
const admissionReady = computed(() => ageBand.value === "adult" && acceptedTerms.value && acceptedPrivacy.value && policiesReady.value);
const available = computed(() => {
  const caps = capabilities.value;
  if (!caps) return false;
  if (requesting.value) return caps.email_actions && (route.path !== "/register" || caps.public_registration);
  if (purpose.value === "register") return caps.email_actions && caps.public_registration;
  if (purpose.value === "invite" && inspection.value?.action === "activate") return caps.invitations && policiesReady.value;
  return true;
});
const blocked = computed(() => busy.value || props.locked || unknown.value || props.phase === "unknown" || props.phase === "loading" || retryUntil.value > clock.value || !available.value);
const activation = computed(() => !requesting.value && (purpose.value === "register" || purpose.value === "invite" && inspection.value?.action === "activate"));
const dirty = computed(() => !done.value && !!(email.value || displayName.value || password.value || confirmation.value || ageBand.value || acceptedTerms.value || acceptedPrivacy.value));
watch(dirty, value => emit("dirty", value), { flush: "sync" });
watch(unknown, value => emit("unknown", value), { flush: "sync" });
watch(busy, value => emit("active", value), { flush: "sync" });
function clearPasswords() { password.value = ""; confirmation.value = ""; showPassword.value = false; }
async function loadCapabilities() {
  if (busy.value) return;
  configError.value = ""; const stamp = generation;
  try {
    const result = await props.client.capabilities(controller.signal);
    if (!alive || stamp !== generation) return;
    if (result.terms_version !== capabilities.value?.terms_version || result.privacy_notice_version !== capabilities.value?.privacy_notice_version) { acceptedTerms.value = false; acceptedPrivacy.value = false; }
    capabilities.value = result;
  } catch { if (alive && stamp === generation) { capabilities.value = undefined; configError.value = "暂时无法确认邮箱服务和当前政策，请重新查询。不会提交邮箱操作。"; } }
}
function resetForm() {
  generation++; controller.abort(); controller = new AbortController(); busy.value = false;
  email.value = ""; displayName.value = ""; clearPasswords(); ageBand.value = ""; acceptedTerms.value = false; acceptedPrivacy.value = false;
  inspection.value = undefined; inspected.value = false; done.value = false; loginName.value = ""; message.value = ""; error.value = ""; fields.value = {}; requestId.value = ""; unknown.value = false; accountSwitch.value = false;
}
async function enter() {
  resetForm();
  if (hasEmailTokenFragment(route.hash)) await router.replace({ path: route.path, query: {}, hash: "" });
  await loadCapabilities();
}
async function failure(cause: unknown, consuming: boolean) {
  if (cause instanceof ApiError) {
    error.value = cause.message; fields.value = cause.fields; requestId.value = cause.requestId;
    if (cause.status === 429) retryUntil.value = retryAt(cause.retryAfter);
    if ([401, 403].includes(cause.status)) emit("sessionUncertain");
    if (cause.code === "AUTH_ACCOUNT_SWITCH_REQUIRED") accountSwitch.value = true;
    if (cause.code === "ADMISSION_POLICY_CHANGED") { acceptedTerms.value = false; acceptedPrivacy.value = false; capabilities.value = undefined; configError.value = "政策版本已更新，请重新查询并阅读后再次明确确认。"; }
    if (["EMAIL_ACTION_INVALID", "INVITATION_UNAVAILABLE"].includes(cause.code)) { props.flow.clear(); inspected.value = false; }
    if (consuming && cause.status >= 500) unknown.value = true;
  } else {
    error.value = cause instanceof DOMException && cause.name === "TimeoutError" ? "请求超时。" : "网络中断，无法确认请求结果。";
    if (consuming) unknown.value = true;
  }
  if (unknown.value) error.value += " 不会自动重放，请只读查询会话；如链接已使用，请重新打开邮件或重新申请。";
  if (unknown.value && !requesting.value && (activation.value || purpose.value === "reset")) emit("sessionUncertain");
  await nextTick(); summary.value?.focus();
}
async function perform<T>(action: EmailAction, body: unknown, consuming: boolean, onSuccess: (value: T, remaining: number) => Promise<void> | void) {
  if (blocked.value) return;
  busy.value = true; error.value = ""; message.value = ""; fields.value = {}; requestId.value = "";
  const current = generation, deadline = performance.now() + (activation.value ? 30000 : 15000);
  try {
    const pending = props.client.post<T>(action, body, controller.signal, Math.min(15000, deadline - performance.now()));
    clearPasswords();
    const value = await pending;
    if (!alive || current !== generation) return;
    await onSuccess(value, deadline - performance.now());
  } catch (cause) { if (alive && current === generation) await failure(cause, consuming); }
  finally { clearPasswords(); if (alive && current === generation) busy.value = false; }
}
async function submitRequest() {
  if (route.path === "/register" && (ageBand.value !== "adult" || !policiesReady.value)) return;
  if (route.path === "/register" && props.phase === "authenticated") { accountSwitch.value = true; return; }
  await perform(route.path === "/register" ? "/auth/register-email" : "/auth/password-reset/request", {
    email: email.value.trim(), ...(route.path === "/register" ? { age_band: "adult", terms_version: capabilities.value!.terms_version, privacy_notice_version: capabilities.value!.privacy_notice_version } : {}),
  }, true, () => { message.value = "申请已受理。如该邮箱符合条件，系统会尝试投递邮件；受理不代表已送达。请检查邮箱与垃圾邮件。"; retryUntil.value = Date.now() + 60000; });
}
async function inspect() {
  if (!token.value) return;
  await perform<InvitationInspection>("/auth/invitations/inspect", { token: token.value }, false, value => { inspection.value = value; inspected.value = true; props.flow.expireAt(value.expires_at); });
}
async function switchAccount() {
  if (busy.value || props.locked || props.phase !== "authenticated") return;
  if (!window.confirm("此操作需要退出当前账号。退出不会撤回已到达服务端的写入；邮件凭证仅保留在本流程内存中。确定退出并切换？")) return;
  if (await props.beforeAuthSwitch()) accountSwitch.value = false;
}
async function submitConfirmation() {
  if (!token.value || done.value) return;
  if (activation.value) {
    if (!admissionReady.value || password.value !== confirmation.value) return;
    if (props.phase === "authenticated") { accountSwitch.value = true; return; }
    const action = purpose.value === "invite" ? "/auth/invitations/activate" : "/auth/activate-email";
    await perform<ActivationResult>(action, { token: token.value, age_band: "adult", terms_version: capabilities.value!.terms_version,
      privacy_notice_version: capabilities.value!.privacy_notice_version, accepted_terms: true, display_name: displayName.value.trim(), new_password: password.value }, true,
    async (result, remaining) => {
      props.flow.clear(); done.value = true; loginName.value = result.login_name;
      const confirmed = await props.sessionChanged(remaining, result.user_id);
      if (!confirmed) { unknown.value = true; message.value = "服务端已确认激活，但新会话尚待核对。请只读重新查询，不能再次提交激活。"; return; }
      message.value = `账号已激活。备用用户名：${result.login_name}。邮箱无法收信时仍可用此用户名和密码登录。`;
      emit("completed", result);
    });
  } else if (purpose.value === "reset") {
    if (password.value !== confirmation.value) return;
    await perform("/auth/password-reset/confirm", { token: token.value, new_password: password.value }, true, async (_, remaining) => {
      props.flow.clear(); done.value = true; message.value = "密码已更新，所有旧会话已失效，请使用新密码重新登录。";
      if (!await props.sessionChanged(remaining, null)) { unknown.value = true; message.value += " 当前会话尚待只读核对，不会再次提交重置。"; return; }
      emit("completed", undefined);
    });
  } else if (purpose.value === "bind") {
    if (props.phase !== "authenticated") { emit("login"); return; }
    const expectedUserId = props.userId;
    await perform("/auth/email-binding/confirm", { token: token.value }, true, async (_, remaining) => {
      props.flow.clear(); done.value = true; message.value = "邮箱绑定已确认，旧恢复凭证已失效。";
      if (!await props.sessionChanged(remaining, expectedUserId)) { unknown.value = true; message.value += " 本人状态尚待只读核对，不会再次绑定。"; return; }
      emit("completed", undefined);
    });
  } else if (inspection.value?.action === "accept") {
    if (props.phase !== "authenticated") { emit("login"); return; }
    const expectedUserId = props.userId;
    await perform("/auth/invitations/accept", { token: token.value }, true, async (_, remaining) => {
      props.flow.clear(); done.value = true; message.value = "邀请已接受，成员关系已由服务端确认。当前职责以重新查询后的授权为准。";
      if (!await props.sessionChanged(remaining, expectedUserId)) { unknown.value = true; message.value += " 当前职责尚待只读核对，不会再次接受。"; return; }
      emit("completed", undefined);
    });
  }
}
async function recover() { if (busy.value || props.locked) return; await props.recoverSession(); }
async function beforeLeave(preserveIntent = false) {
  if (done.value) { if (!preserveIntent) props.flow.clear(); return true; }
  if (busy.value || unknown.value) { if (!window.confirm("邮件请求结果仍待确认；离开不会取消已提交操作，也不会自动重发。确定离开？")) return false; }
  if (dirty.value && !window.confirm("当前邮箱表单尚未完成，确定放弃本地输入？")) return false;
  if (!preserveIntent) props.flow.clear();
  clearPasswords(); return true;
}
function cancel() { if (busy.value) return; void beforeLeave().then(allowed => { if (allowed) void router.push("/login"); }); }
defineExpose({ beforeLeave });
watch(() => [route.path, props.flow.scope] as const, (value, previous) => {
  if (value[0] !== previous[0] || value[1] && value[1] !== previous[1]) void enter();
});
watch(() => props.userId, () => { clearPasswords(); });
onMounted(() => {
  const referrer = document.head.querySelector<HTMLMetaElement>('meta[name="referrer"]');
  if (referrer) referrer.content = "no-referrer"; else { const element = document.createElement("meta"); element.name = "referrer"; element.content = "no-referrer"; document.head.append(element); }
  timer = window.setInterval(() => { clock.value = Date.now(); }, 1000); void enter();
});
onBeforeUnmount(() => { alive = false; generation++; controller.abort(); window.clearInterval(timer); clearPasswords(); emit("dirty", false); emit("unknown", false); emit("active", false); });
</script>

<template>
  <section class="email-auth card" :aria-busy="busy">
    <header><h1>{{ done ? unknown || phase === 'unknown' ? '操作已确认，会话待核对' : busy ? '操作已确认，正在核对会话' : loginName ? '账号激活已完成' : '邮件确认已完成' : title }}</h1><p v-if="!done">使用真实邮箱确认；不会自动消费邮件链接或重复提交。</p><p v-else>邮件操作已由服务端确认，凭证已从本流程内存清除；不会再次提交。</p></header>
    <div v-if="error" ref="summary" class="notice danger" role="alert" tabindex="-1"><p>{{ error }}</p><ul v-if="Object.keys(fields).length"><li v-for="(text, key) in fields" :key="key">{{ text }}</li></ul><small v-if="requestId">请求编号：{{ requestId }}</small></div>
    <p v-if="message" class="notice" role="status">{{ message }}</p>
    <p v-if="retryUntil > clock" role="status">请等待 {{ Math.ceil((retryUntil - clock) / 1000) }} 秒后再操作。</p>
    <div v-if="configError || !capabilities" class="notice"><p>{{ configError || '正在确认邮箱服务能力…' }}</p><button type="button" :disabled="busy || locked" @click="loadCapabilities">重新查询邮箱服务</button></div>
    <p v-else-if="!available" class="notice">当前邮箱动作未开放或邮件服务已停用。已验证邮箱和备用用户名的密码登录不受发信开关影响；机构账号可联系管理员恢复，无机构个人账号需等待邮件服务恢复。</p>
    <p v-if="capabilities && (activation || route.path === '/register') && !policiesReady" class="notice">当前条款或隐私告知缺少有效版本 / 安全链接，不能创建或激活账号。请重新查询邮件服务；不会使用旧版本勾选替代本次收件人的明确确认。</p>
    <p v-if="capabilities && !capabilities.email_actions && available && !requesting" class="notice">新邮件申请已停用。此处只确认已有邮件凭证 / 已登记邀请；是否仍有效由服务端实时核验，不表示邮件能够重新投递。</p>
    <div v-if="phase === 'unknown' || unknown" class="notice"><p>当前会话或上一请求结果尚未确认。只读查询不会重放邮件操作。</p><button type="button" :disabled="busy || locked" @click="recover">只读查询会话</button></div>
    <div v-if="!done && (accountSwitch || (activation || route.path === '/register') && phase === 'authenticated')" class="notice"><p>当前浏览器已登录。新账号注册 / 激活需要明确退出；找回其他账号也不能覆盖当前会话。</p><button type="button" :disabled="busy || locked || phase !== 'authenticated'" @click="switchAccount">确认退出当前账号</button></div>
    <form v-if="requesting && !done" @submit.prevent="submitRequest">
      <fieldset :disabled="blocked"><label>邮箱<input v-model="email" type="email" maxlength="254" autocomplete="email" required /></label>
        <template v-if="route.path === '/register'"><label>准入声明<select v-model="ageBand" required><option value="">请选择</option><option value="adult">我明确声明已成年</option><option value="minor">我未成年</option></select></label><p v-if="ageBand !== 'adult'">未成年或未声明者不能自助注册，请联系机构使用受控开户流程；此声明不是年龄或监护验证。</p><p>申请不创建可登录账号。实际收件人必须在最终激活页重新接受当时的条款和隐私告知。</p></template>
        <button type="submit" :disabled="route.path === '/register' && (ageBand !== 'adult' || !policiesReady || phase === 'authenticated')">{{ busy ? '正在受理…' : '申请验证邮件' }}</button>
      </fieldset>
    </form>
    <template v-else-if="!done">
      <p v-if="!token" class="notice">邮件凭证不存在或已过期。清除地址后刷新会丢失内存凭证，请重新打开邮件；不要将凭证复制到其他输入框。</p>
      <template v-else>
        <template v-if="purpose === 'invite'"><button v-if="!inspected" type="button" :disabled="blocked" @click="inspect">查看邀请（不接受）</button><div v-if="inspection"><h2>{{ inspection.organization.name }}</h2><p>邀请状态：{{ inspection.state }} · 有效至 {{ new Date(inspection.expires_at).toLocaleString() }}</p><p>机构和职责由邀请固定，不能在此修改。接受前服务端会重新检查审批与权限。</p><p v-if="inspection.action === 'accept'">此邀请用于已有账号。请登录并确认本人已绑定对应验证邮箱；旧账号没有邮箱时，先在账号安全页绑定，不能创建第二账号。</p><button v-if="inspection.action === 'accept'" type="button" :disabled="busy || locked" @click="emit('login')">{{ phase === 'authenticated' ? '明确退出并登录其他已有账号' : '登录已有账号后继续' }}</button><RouterLink v-if="inspection.action === 'accept' && phase === 'authenticated'" to="/account">到本人账号安全绑定邮箱</RouterLink></div></template>
        <button v-if="purpose === 'bind' && phase !== 'authenticated'" type="button" :disabled="busy || locked" @click="emit('login')">登录绑定申请的本人账号</button>
        <form v-if="purpose !== 'invite' || inspected" @submit.prevent="submitConfirmation"><fieldset :disabled="blocked || activation && phase === 'authenticated'">
          <template v-if="activation"><label>成年声明<select v-model="ageBand" required><option value="">请选择</option><option value="adult">我明确声明已成年</option><option value="minor">我未成年</option></select></label><p v-if="ageBand !== 'adult'">未成年或未声明者不可激活自助账号，请联系机构受控开户；不会伪造监护确认。</p><label class="check"><input v-model="acceptedTerms" type="checkbox" required />我已阅读并接受 <a :href="policyUrl(capabilities?.terms_url)" target="_blank" rel="noreferrer noopener">当前条款（{{ capabilities?.terms_version }}）</a></label><label class="check"><input v-model="acceptedPrivacy" type="checkbox" required />我已阅读 <a :href="policyUrl(capabilities?.privacy_notice_url)" target="_blank" rel="noreferrer noopener">隐私告知（{{ capabilities?.privacy_notice_version }}）</a></label><label>显示名<input v-model="displayName" autocomplete="nickname" maxlength="100" required /></label></template>
          <template v-if="activation || purpose === 'reset'"><label>新密码<input v-model="password" :type="showPassword ? 'text' : 'password'" autocomplete="new-password" minlength="6" maxlength="128" required /></label><button type="button" :aria-pressed="showPassword" @click="showPassword = !showPassword">{{ showPassword ? '隐藏密码' : '显示密码' }}</button><label>确认新密码<input v-model="confirmation" :type="showPassword ? 'text' : 'password'" autocomplete="new-password" minlength="6" maxlength="128" required /></label><p v-if="confirmation && password !== confirmation" role="status">两次密码不一致。</p></template>
          <button type="submit" :disabled="activation && !admissionReady || (activation || purpose === 'reset') && password !== confirmation || purpose === 'invite' && inspection?.action === 'accept' && phase !== 'authenticated' || purpose === 'bind' && phase !== 'authenticated'">{{ busy ? '正在确认…' : activation ? '明确确认并激活' : purpose === 'reset' ? '确认重置密码' : purpose === 'bind' ? '确认绑定本人邮箱' : '接受机构邀请' }}</button>
        </fieldset></form>
      </template>
    </template>
    <p v-if="loginName">请保存备用用户名：<strong>{{ loginName }}</strong></p>
    <footer><RouterLink v-if="done && phase === 'authenticated' && !unknown && !busy" class="button" to="/account">进入账号与安全</RouterLink><RouterLink v-else-if="phase === 'authenticated' && !done" to="/account">本人账号与安全</RouterLink><RouterLink to="/login">返回登录</RouterLink><button v-if="!done" type="button" :disabled="busy" @click="cancel">取消并清除邮件凭证</button></footer>
  </section>
</template>
<style scoped>
.email-auth{max-width:36rem;margin:2rem auto;padding:clamp(1rem,4vw,2rem)}h1{font-size:1.5rem}form,fieldset{display:grid;gap:1rem}fieldset{border:0;padding:0;margin:1rem 0;min-width:0}label{display:grid;gap:.4rem}input,select{width:100%;box-sizing:border-box;min-height:2.75rem}.check{display:flex;align-items:flex-start;flex-wrap:wrap}.check input{width:1.2rem;min-height:1.2rem;margin-top:.2rem}.notice{padding:1rem;border:1px solid var(--border,#c8d0db);border-radius:.5rem;overflow-wrap:anywhere}.danger{border-color:#b42318}footer{display:flex;flex-wrap:wrap;gap:1rem;margin-top:1.5rem}button{min-height:2.75rem}a{overflow-wrap:anywhere}p{line-height:1.65}
</style>
