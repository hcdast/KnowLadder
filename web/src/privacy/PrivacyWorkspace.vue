<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ApiError, type GlobalRequest, type Identity } from "../session";
import type { components } from "../api/schema";
type RequestView = components["schemas"]["PrivacyRequestView"];
type RequestPage = components["schemas"]["PrivacyRequestPage"];
type DeletionInput = components["schemas"]["PrivacyDeletionInput"];
type Recovery = { operation: "privacy.deletion.request"; key: string; scope: DeletionInput["scope"]; policy_revision: DeletionInput["policy_revision"] };
const props = defineProps<{ identity: Identity; request: GlobalRequest }>();
const emit = defineEmits<{ unknown: [value: boolean] }>();
const policy: DeletionInput["policy_revision"] = "local_privacy_v1";
const storageKey = `privacy-recovery:${props.identity.user.id}:account`;
const pending = ref<Recovery>(), storageBlocked = ref(false), denied = ref(false);
const password = ref(""), acknowledged = ref(false), busy = ref(false), loaded = ref(false);
const message = ref(""), notice = ref(""), cooldown = ref(0);
const records = ref<RequestView[]>([]), cursor = ref<string | null>(null), detail = ref<RequestView>();
const detailHeading = ref<HTMLElement>();
const life = new AbortController();
let alive = true, timer = 0;
const unknown = computed(() => !!pending.value || storageBlocked.value);
const locked = computed(() => busy.value || denied.value || cooldown.value > 0);
watch(unknown, value => emit("unknown", value), { flush: "sync" });
const statusLabels: Record<RequestView["status"], string> = {
  requested: "已申请，待审核", reviewing: "审核中", rejected: "申请被拒绝", approved: "已批准，尚未完成删除",
  blocking: "账号冻结中", erasing: "正在删除", failed: "执行中断，等待处理", completed: "删除完成",
  completed_with_retention: "处理完成，部分证据保留",
};
const categoryLabels: Record<string, string> = {
  lifelong_goals: "个人终身学习目标", lifelong_activities: "个人活动与学习回顾", lifelong_supports: "家人与伙伴支持关系",
  lifelong_feedback: "学习支持反馈", lifelong_assurances: "机构监护关系核验", lifelong_receipts: "个人学习请求恢复凭据",
  recommendations: "个人学习推荐", behavior_events: "个人行为记录", reading_progress: "阅读进度",
  learning_projection_inputs: "学情计算输入", mastery_evidence: "掌握度证据", mastery_snapshots: "掌握度快照",
  mistake_entries: "个人错题", report_snapshots: "学习报告快照", learning_projection_retirements: "学情旧版本记录",
  learning_projection_builds: "学情计算记录", learning_projection_heads: "学情版本索引", student_projection_states: "学情计算状态",
  learning_attempt_contexts: "练习关联信息", learning_question_states: "个人题目状态",
  content_idempotency: "内容请求恢复凭据", idempotency_records: "业务请求恢复凭据", auth_sessions: "登录会话",
  consumer_receipts: "练测事件处理凭据", outbox_events: "练测事件", grading_results: "评分结果", grading_runs: "评分记录",
  answers: "个人作答", assessment_resource_references: "练测资源引用", session_items: "练测题目记录",
  submissions: "交卷记录", sessions: "练测会话", attempt_counters: "练测次数记录", quiz_audiences: "考试参与范围记录",
  member_roles: "成员角色授权",
  member_capability_grants: "成员能力授权",
  identity_tombstone: "不可逆身份删除标记", membership_provenance: "组织成员关系溯源",
  audit_provenance: "审计来源证据", shared_content_and_files: "共享内容与文件",
  privacy_receipts: "隐私申请处理凭据", held_assessment_facts: "受保留要求约束的练测事实",
};
function category(value: string) { return Object.hasOwn(categoryLabels, value) ? categoryLabels[value] : "其他数据类别（由本地审批人员核对）"; }
function remaining(value: string) { return value === "resume_erasure" ? "继续执行尚未完成的数据删除" : value === "review_policy" ? "核对删除政策后继续处理" : value === "review_retention" ? "核对保留依据与保留要求后继续处理（账号保持冻结）" : "其他待处理事项（由本地审批人员核对）"; }
function retention(value: string) { return value === "local_minimal_provenance" ? "本地最小必要溯源证据保留" : value === "local_hold_and_provenance" ? "本地保留要求与必要溯源证据" : "保留依据已登记，请由本地审批人员核对"; }
function date(value: string) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? "时间待确认" : parsed.toLocaleString("zh-CN"); }
function remember(value?: Recovery) {
  try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey); }
  catch { storageBlocked.value = true; throw new Error("recovery_storage_unavailable"); }
  pending.value = value; storageBlocked.value = false;
}
function fail(cause: unknown) {
  if (!alive) return;
  message.value = storageBlocked.value
    ? "无法安全读写恢复记录。已阻止新申请，请恢复浏览器会话存储后重新打开本页；不要清除存储后重复提交。"
    : "暂时无法确认结果。请重新查询；申请重试必须重新输入密码并沿用原请求编号。";
  if (!(cause instanceof ApiError)) return;
  if (cause.status === 429) {
    const seconds = /^\d+$/.test(cause.retryAfter) ? Number(cause.retryAfter) : NaN;
    const until = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(cause.retryAfter) || Date.now() + 60000;
    window.clearInterval(timer); cooldown.value = Math.max(1, Math.ceil((until - Date.now()) / 1000));
    timer = window.setInterval(() => { cooldown.value = Math.max(0, Math.ceil((until - Date.now()) / 1000)); if (!cooldown.value) window.clearInterval(timer); }, 1000);
    message.value = "请求较频繁，请等待后再试。原申请编号保持不变。";
  } else if ([401, 403].includes(cause.status)) {
    denied.value = true; life.abort(); password.value = ""; records.value = []; detail.value = undefined; cursor.value = null;
    message.value = "账号或权限已变化，已退出隐私视图。请重新确认会话；无法访问不表示删除已完成。";
  } else if (cause.status === 404) message.value = "当前申请不可访问，请刷新本人申请列表。";
  else if ([400, 413, 422].includes(cause.status)) message.value = "申请未获确认，请核对当前密码和政策确认后使用原编号重试。";
  else if (cause.status === 409) message.value = "申请状态或原请求存在冲突，请查询已有申请并联系本地审批人员；不要换编号重复提交。";
}
async function load(next = false) {
  if (locked.value || (next && !cursor.value)) return;
  busy.value = true; message.value = "";
  const pageCursor = next ? cursor.value : null;
  if (!next) { cursor.value = null; records.value = []; loaded.value = false; }
  try {
    const query = new URLSearchParams({ limit: "20" }); if (pageCursor) query.set("cursor", pageCursor);
    const page = await props.request<RequestPage>(`/privacy/deletion-requests?${query}`, { signal: life.signal });
    if (!alive || denied.value) return;
    records.value = next ? [...records.value, ...page.items.filter(item => !records.value.some(old => old.id === item.id))] : page.items;
    cursor.value = page.next_cursor; loaded.value = true;
  } catch (cause) { fail(cause); }
  finally { if (alive) busy.value = false; }
}
async function openDetail(id: string) {
  if (locked.value) return;
  busy.value = true; message.value = ""; detail.value = undefined;
  try {
    const value = await props.request<RequestView>(`/privacy/deletion-requests/${encodeURIComponent(id)}`, { signal: life.signal });
    if (!alive || denied.value) return;
    detail.value = value;
    const index = records.value.findIndex(item => item.id === value.id); if (index >= 0) records.value[index] = value;
    await nextTick(); if (alive) detailHeading.value?.focus();
  } catch (cause) { fail(cause); }
  finally { if (alive) busy.value = false; }
}
async function submit() {
  if (locked.value || storageBlocked.value || !password.value || !acknowledged.value) return;
  busy.value = true; message.value = ""; notice.value = "";
  let accepted = false;
  try {
    const operation: Recovery = pending.value || { operation: "privacy.deletion.request", key: crypto.randomUUID(), scope: "account", policy_revision: policy };
    remember(operation);
    const body: DeletionInput = { scope: operation.scope, policy_revision: operation.policy_revision, current_password: password.value };
    const request = props.request<RequestView>("/privacy/deletion-requests", { method: "POST", idempotencyKey: operation.key, body, signal: life.signal });
    password.value = "";
    let result: RequestView;
    try { result = await request; } finally { body.current_password = ""; }
    if (!alive || denied.value) return;
    detail.value = result;
    notice.value = "服务器已确认申请（HTTP 202），不表示已批准或删除完成。请查看下方真实状态。";
    remember(); accepted = true; acknowledged.value = false;
    await nextTick(); if (alive) detailHeading.value?.focus();
  } catch (cause) {
    fail(cause);
    // 409 为确定性拒绝（已有处理中申请或键冲突）：服务器从未受理该 key，
    // 保留恢复记录会把页面永久锁死在“恢复原申请”，须释放；未知结果仍保留原 key。
    if (cause instanceof ApiError && cause.status === 409) {
      try { remember(); } catch (storageCause) { fail(storageCause); }
    }
  }
  finally { password.value = ""; if (alive) busy.value = false; }
  if (accepted && alive && !denied.value) await load();
}
function beforeUnload(event: BeforeUnloadEvent) { if (unknown.value || busy.value) { event.preventDefault(); event.returnValue = ""; } }
onMounted(() => {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    if (value !== null) {
      if (typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_recovery");
      const saved = value as Partial<Recovery>;
      if (saved.operation !== "privacy.deletion.request" || saved.scope !== "account" || saved.policy_revision !== policy || typeof saved.key !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(saved.key) || Object.keys(saved).some(key => !["operation", "key", "scope", "policy_revision"].includes(key))) throw new Error("invalid_recovery");
      pending.value = { operation: saved.operation, key: saved.key, scope: saved.scope, policy_revision: saved.policy_revision };
    }
  } catch (cause) { storageBlocked.value = true; fail(cause); }
  window.addEventListener("beforeunload", beforeUnload); void load();
});
onBeforeUnmount(() => {
  alive = false; life.abort(); window.clearInterval(timer); password.value = ""; records.value = []; detail.value = undefined; cursor.value = null;
  window.removeEventListener("beforeunload", beforeUnload); emit("unknown", false);
});
</script>

<template>
  <section class="panel content-workspace stack" aria-labelledby="privacy-title" :aria-busy="busy">
    <header class="page-heading">
      <p class="eyebrow">PRIVACY / 账号隐私</p><h2 id="privacy-title">本人账号删除申请</h2>
      <p class="muted">这是本地隔离／合成数据环境的真实隐私流程，不是生产服务准入或法律合规承诺。无需选择组织。</p>
    </header>
    <section class="notice" aria-label="申请前须知">
      <p>申请范围为此账号在全局所有组织中的个人数据，不仅是当前组织。提交申请不会立即删除数据。</p>
      <p>审批和执行仅由授权人员通过独立本地 CLI 完成；此页面没有管理员删除能力。执行开始后账号将不可逆冻结，会话失效，不能凭本页恢复账号。</p>
      <p>共享内容、附件来源和必要审计证据可能保留。处理结果以已删除、保留及待处理类别为准；保留证据不等于彻底删除。</p>
      <p>账号冻结或删除后，本页不提供匿名查询令牌。无法登录或查询失败不能作为删除完成的证据。</p>
    </section>
    <p v-if="message" class="notice" role="alert">{{ message }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <p v-if="cooldown" role="status">请等待 {{ cooldown }} 秒后重试。</p>
    <section v-if="pending || storageBlocked" class="notice" aria-label="原申请恢复">
      <p v-if="pending">原申请结果待确认，安全恢复记录已保留。列表中的相似申请不能证明原请求结果；请重新输入当前密码，沿用原编号和原政策重试。不会自动重发，也不会创建替代请求。</p>
      <p v-if="storageBlocked">恢复存储不可用，已禁止提交。请恢复会话存储后重新打开本页，不要清除记录。</p>
    </section>
    <form class="stack content-section" @submit.prevent="submit">
      <h3>{{ pending ? '恢复原申请' : '提交账号删除申请' }}</h3>
      <p class="field-help">政策版本：{{ policy }}。密码只用于此次验证，不写入恢复记录；每次发送后清空。</p>
      <label class="check-label"><input v-model="acknowledged" type="checkbox" required :disabled="locked || storageBlocked" />我已理解全局范围、不可逆冻结、CLI 审批和证据保留说明。</label>
      <div class="field"><label for="privacy-password">当前密码</label><input id="privacy-password" v-model="password" type="password" autocomplete="current-password" required :disabled="locked || storageBlocked" aria-describedby="privacy-password-help" /><p id="privacy-password-help" class="field-help">未知结果恢复也须重新输入密码；恢复时原请求编号保持不变。</p></div>
      <div class="actions"><button class="button" type="submit" :disabled="locked || storageBlocked || !acknowledged || !password">{{ busy ? '正在请求…' : pending ? '使用原编号重试申请' : '提交申请（不立即删除）' }}</button></div>
    </form>
    <section class="stack content-section" aria-labelledby="privacy-list-title">
      <h3 id="privacy-list-title">我的申请</h3>
      <div class="actions"><button class="button secondary" :disabled="locked" @click="load()">刷新本人申请列表</button></div>
      <p v-if="busy" role="status">正在向服务器确认状态…</p>
      <p v-if="loaded && !records.length" class="content-empty">当前没有可见申请。如需删除账号，请先阅读说明并提交申请；空列表不会解除未知请求的恢复要求。</p>
      <ul class="content-list"><li v-for="item in records" :key="item.id"><div><p>{{ statusLabels[item.status] || '状态待确认' }}</p><p class="field-help">申请时间：{{ date(item.created_at) }}</p><p class="request-id">申请编号：{{ item.id }}</p></div><button class="button secondary" :disabled="locked" :aria-label="`查看 ${date(item.created_at)} 的申请详情`" @click="openDetail(item.id)">查看详情</button></li></ul>
      <button v-if="cursor" class="button secondary" :disabled="locked" @click="load(true)">加载更多申请</button>
    </section>
    <section v-if="detail" class="stack content-section" aria-labelledby="privacy-detail-title">
      <h3 id="privacy-detail-title" ref="detailHeading" tabindex="-1">申请详情：{{ statusLabels[detail.status] || '状态待确认' }}</h3>
      <p class="request-id">申请编号：{{ detail.id }} · 修订 {{ detail.revision }}</p><p class="field-help">最后更新：{{ date(detail.updated_at) }}</p>
      <div class="actions"><button class="button secondary" :disabled="locked" @click="openDetail(detail.id)">重新查询此申请</button></div>
      <h4>已删除类别</h4><ul v-if="detail.deleted_categories.length"><li v-for="(value, index) in detail.deleted_categories" :key="index">{{ category(value) }}</li></ul><p v-else class="muted">服务器尚未报告已删除类别。</p>
      <h4>保留类别</h4><ul v-if="detail.retained_categories.length"><li v-for="(value, index) in detail.retained_categories" :key="index">{{ category(value) }}</li></ul><p v-else class="muted">服务器未报告保留类别；不据此推断全部删除。</p>
      <p v-if="detail.retention_basis" class="field-help">保留依据：{{ retention(detail.retention_basis) }}。</p>
      <h4>待处理事项与类别</h4><template v-if="detail.remaining_actions.length"><p>以下事项仍待处理，当前结果不代表全部处理完成。</p><ul><li v-for="(value, index) in detail.remaining_actions" :key="index">{{ remaining(value) }}</li></ul></template><p v-else class="muted">服务器当前未报告待处理事项。</p>
    </section>
  </section>
</template>
