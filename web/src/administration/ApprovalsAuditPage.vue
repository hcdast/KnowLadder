<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import type { Approval, Audit, ConsolePageProps, Operation, Page, Receipt } from "./types";
import { consoleActionLabel, consoleCapabilityLabel, consoleRoleLabel, consoleScopeLabel, consoleStatusLabel } from "./presentation";
import PageHeader from "./components/PageHeader.vue";
import ResourceTable from "./components/ResourceTable.vue";
import StatusBadge from "./components/StatusBadge.vue";
const props = defineProps<ConsolePageProps & { mode: "approvals" | "audit"; actorUserId: string }>();
const emit = defineEmits<{ dirty: [value: boolean] }>();
type ApprovalEvidence = Approval & { updated_at?: string; payload_hash?: string };
type OperationEvidence = Operation & { updated_at?: string; step?: string };
const approvals = ref<ApprovalEvidence[]>([]), events = ref<Audit[]>([]), cursor = ref<string | null>(null);
const selected = ref<ApprovalEvidence>(), selectedEvent = ref<Audit>(), relatedOperation = ref<OperationEvidence>(), relatedApproval = ref<ApprovalEvidence>();
const busy = ref(false), relatedBusy = ref(false), error = ref(""), relatedError = ref(""), status = ref(""), reason = ref("");
const decisionError = ref(""), loaded = ref(false), decisionReceipt = ref<Receipt>();
const life = new AbortController(); let alive = true;
const detail = computed(() => !!props.resourceId);
const governing = computed(() => props.context.capabilities.includes("platform:govern"));
const independenceReason = computed(() => {
  const row = selected.value; if (!row) return "尚未读取审批详情。";
  if (row.requester_id === props.actorUserId) return "这是本人申请，不能批准或拒绝。请由另一位与受益人独立的治理者处理。";
  if (row.target_user_id === props.actorUserId || row.target_member_id === props.context.actor_member_id) return "当前身份是受益人，不能批准或拒绝此申请。";
  if (row.requester_id === row.target_user_id) return "申请人与受益人不独立；此申请不能获批，应由独立治理者重新发起。";
  return "";
});
const canDecide = computed(() => governing.value && selected.value?.status === "pending" && !independenceReason.value && !decisionReceipt.value);
watch(reason, value => emit("dirty", !!value));
watch(status, () => { cursor.value = null; approvals.value = []; loaded.value = false; });
const payloadLabels: Record<string, string> = {
  login_name: "登录名", display_name: "显示名", user_id: "目标用户", member_id: "目标成员", org_id: "目标组织", roles: "完整基础角色", status: "目标状态", capability: "职责能力", scope: "精确组织范围", delegate_capabilities: "委派清单", valid_from: "开始时间", valid_to: "截止时间", grant_id: "授权编号",
};
const changes = computed(() => {
  const payload = selected.value?.payload; if (!payload) return [];
  return Object.entries(payloadLabels).filter(([key]) => Object.hasOwn(payload, key)).map(([key, label]) => {
    const value = payload[key]; let after: string;
    if (key === "roles" && Array.isArray(value)) after = value.map(role => consoleRoleLabel(String(role))).join("、") || "无";
    else if (key === "delegate_capabilities" && Array.isArray(value)) after = value.map(capability => consoleCapabilityLabel(String(capability))).join("、") || "无";
    else if (key === "capability" && typeof value === "string") after = consoleCapabilityLabel(value);
    else if (key === "status" && typeof value === "string") after = consoleStatusLabel(value);
    else if (key === "scope" && value && typeof value === "object" && !Array.isArray(value)) {
      const scope = value as { kind?: unknown; organization_ids?: unknown };
      after = `${consoleScopeLabel(String(scope.kind || "未提供"))}${Array.isArray(scope.organization_ids) && scope.organization_ids.length ? `：${scope.organization_ids.map(String).join("、")}` : ""}`;
    } else if (key === "valid_to" && value === null) {
      after = selected.value?.action === "grant.create" ? "无自动到期"
        : selected.value?.action === "member.update" ? "未申请修改期限，沿用既有期限"
          : "未申请设置新期限，按原申请规则处理（不推断永久有效）";
    } else after = value === null ? "未提供" : typeof value === "object" ? JSON.stringify(value) : String(value);
    return { key, label, after };
  });
});
const versions = computed(() => {
  const payload = selected.value?.payload; if (!payload) return [];
  return [["expected_revision", "成员权限版本"], ["expected_identity_revision", "用户身份版本"], ["previous_grant_revision", "既有授权版本"]].filter(([key]) => Object.hasOwn(payload, key!)).map(([key, label]) => ({ label, value: payload[key!] === null ? "无既有授权" : String(payload[key!]) }));
});
function fail(cause: unknown, target = error) {
  if (alive && !(cause instanceof DOMException && cause.name === "AbortError")) target.value = cause instanceof Error ? cause.message : "请求失败";
}
async function load(next = false) {
  if (busy.value) return;
  busy.value = true; error.value = "";
  try {
    const q = new URLSearchParams({ limit: "20" }); if (next && cursor.value) q.set("cursor", cursor.value); if (props.mode === "approvals" && status.value) q.set("status", status.value);
    if (props.mode === "approvals") {
      const page = await props.request<Page<ApprovalEvidence>>(`/console/approvals?${q}`, { signal: life.signal });
      if (alive) { approvals.value = next ? [...approvals.value, ...page.items] : page.items; cursor.value = page.next_cursor; }
    } else {
      const page = await props.request<Page<Audit>>(`/console/audit?${q}`, { signal: life.signal });
      if (!alive) return;
      events.value = next ? [...events.value, ...page.items] : page.items; cursor.value = page.next_cursor;
      if (detail.value) {
        const match = page.items.find(row => row.id === props.resourceId);
        if (match) { selectedEvent.value = match; void loadRelated(); }
      }
    }
    if (alive) loaded.value = true;
  } catch (cause) { fail(cause); } finally { if (alive) busy.value = false; }
}
async function openApproval() {
  if (!props.resourceId || busy.value) return;
  busy.value = true; error.value = "";
  try {
    const row = await props.request<ApprovalEvidence>(`/console/approvals/${encodeURIComponent(props.resourceId)}`, { signal: life.signal });
    if (alive) selected.value = row;
  } catch (cause) { fail(cause); } finally { if (alive) busy.value = false; }
}
async function loadRelated() {
  const event = selectedEvent.value; if (!event || relatedBusy.value) return;
  relatedBusy.value = true; relatedError.value = "";
  try {
    if (event.operation_id) {
      try { const row = await props.request<OperationEvidence>(`/console/operations/${encodeURIComponent(event.operation_id)}`, { signal: life.signal }); if (alive) relatedOperation.value = row; }
      catch (cause) { fail(cause, relatedError); }
    }
    const approvalId = event.approval_id || relatedOperation.value?.approval_id;
    if (approvalId) {
      try { const row = await props.request<ApprovalEvidence>(`/console/approvals/${encodeURIComponent(approvalId)}`, { signal: life.signal }); if (alive) relatedApproval.value = row; }
      catch (cause) { fail(cause, relatedError); }
    }
  } finally { if (alive) relatedBusy.value = false; }
}
async function decide(decision: "approve" | "reject") {
  const row = selected.value; if (!row || busy.value || props.locked || !canDecide.value || !reason.value.trim()) return;
  busy.value = true; decisionError.value = "";
  try {
    const receipt = await props.write(`/console/approvals/${encodeURIComponent(row.id)}/decision`, { decision, expected_revision: row.revision, reason: reason.value }, "POST", decision === "approve" && ["user.create", "user.password.reset"].includes(row.action));
    if (!receipt || !alive) return;
    reason.value = ""; decisionReceipt.value = receipt;
    if (["pending", "approved", "applying", "applied", "rejected", "needs_recovery"].includes(receipt.status)) selected.value = { ...row, status: receipt.status };
  } catch (cause) { fail(cause, decisionError); } finally { if (alive) busy.value = false; }
  if (alive && decisionReceipt.value && !props.locked) await openApproval();
}
onMounted(() => {
  if (!detail.value) { void load(); return; }
  if (props.mode === "approvals") { void openApproval(); return; }
  // 路由只提供待定位编号；必须由当前身份的审计分页结果确认可见记录。
  void load();
});
onBeforeUnmount(() => { alive = false; life.abort(); emit("dirty", false); });
</script>
<template>
  <section class="admin-page stack" :aria-busy="busy">
    <PageHeader :title="mode === 'approvals' ? detail ? '审批申请详情' : '审批中心' : detail ? '审计记录详情' : '操作审计'" :description="mode === 'approvals' ? '审批与应用是不同状态，只有已生效结果才代表权限变更完成。' : '仅展示当前职责可见的最小审计证据；按服务端游标读取，不宣称时间倒序。'"><template #actions><RouterLink v-if="detail" class="button secondary" :to="`/console/${mode}`">返回{{ mode === 'approvals' ? '审批列表' : '审计列表' }}</RouterLink></template></PageHeader>
    <p v-if="error" class="notice" role="alert">读取未完成：{{ error }}</p><p v-if="busy" role="status">正在读取或处理记录…</p>
    <template v-if="!detail">
      <form class="admin-toolbar" @submit.prevent="load()"><div v-if="mode === 'approvals'" class="field"><label for="approval-status">申请状态</label><select id="approval-status" v-model="status" :disabled="busy"><option value="">全部可见状态</option><option v-for="item in ['pending','approved','applying','applied','rejected','needs_recovery']" :key="item" :value="item">{{ consoleStatusLabel(item) }}</option></select></div><button class="button secondary" :disabled="busy">{{ error ? '重试读取' : '查询' }}{{ mode === 'approvals' ? '申请' : '审计' }}</button></form>
      <p class="admin-meta">{{ mode === 'approvals' ? `当前条件：${status ? consoleStatusLabel(status) : '全部可见状态'}。状态筛选由服务端执行。` : '不提供未支持的时间筛选、导出或全库统计。' }}已载入 {{ mode === 'approvals' ? approvals.length : events.length }} 条可见记录，不代表总数。</p>
      <ResourceTable v-if="mode === 'approvals'" :headers="['申请动作', '目标标识', '状态', '申请时间', '操作']" :busy="busy" :empty="loaded && !approvals.length && !error" :empty-label="status === 'pending' ? '当前范围没有待审批申请。' : '当前条件没有可见审批申请。'"><tr v-for="row in approvals" :key="row.id"><td><RouterLink :to="`/console/approvals/${encodeURIComponent(row.id)}`">{{ consoleActionLabel(row.action) }}</RouterLink><small class="admin-meta">申请人 {{ row.requester_id }}</small></td><td>{{ row.target_user_id ? `用户 ${row.target_user_id}` : row.target_member_id ? `成员 ${row.target_member_id}` : '申请中登记的目标' }}</td><td><StatusBadge :status="row.status" /></td><td>{{ row.created_at }}</td><td><RouterLink :to="`/console/approvals/${encodeURIComponent(row.id)}`">查看</RouterLink></td></tr></ResourceTable>
      <ResourceTable v-else :headers="['动作', '操作者标识', '目标标识', '记录时间', '操作']" :busy="busy" :empty="loaded && !events.length && !error" empty-label="当前范围没有可见审计记录。"><tr v-for="event in events" :key="event.id"><td><RouterLink :to="`/console/audit/${encodeURIComponent(event.id)}`">{{ consoleActionLabel(event.action) }}</RouterLink></td><td>{{ event.actor_id }}</td><td>{{ event.resource_id || event.target_org_id || '未提供' }}</td><td>{{ event.created_at }}</td><td><RouterLink :to="`/console/audit/${encodeURIComponent(event.id)}`">详情</RouterLink></td></tr></ResourceTable>
      <button v-if="cursor" type="button" class="button secondary" :disabled="busy" @click="load(true)">加载下一批可见记录</button>
    </template>
    <template v-else-if="mode === 'approvals'">
      <button v-if="!selected || error" type="button" class="button secondary" :disabled="busy" @click="openApproval">重试读取审批详情</button>
      <template v-if="selected">
        <section class="admin-card stack"><h2>{{ consoleActionLabel(selected.action) }}</h2><p><StatusBadge :status="selected.status" /> · 申请 {{ selected.id }}</p><dl class="governance-summary"><dt>申请人</dt><dd>{{ selected.requester_id }}</dd><dt>目标用户</dt><dd>{{ selected.target_user_id || '未提供' }}</dd><dt>目标成员</dt><dd>{{ selected.target_member_id || '未提供' }}</dd><dt>申请时间</dt><dd>{{ selected.created_at }}</dd><dt>申请理由</dt><dd>{{ selected.reason }}</dd></dl></section>
        <section class="admin-card stack"><h2>申请变更对照</h2><p class="field-help">接口未提供变更前的角色、状态或授权快照；不把当前查询结果伪装成申请时的值。以下仅展示原申请值及已有CAS版本证据。</p><ResourceTable :headers="['变更项', '变更前证据', '原申请目标值']" :empty="!changes.length" empty-label="原申请未包含可展示的业务字段，请核对规范化正文。"><tr v-for="change in changes" :key="change.key"><td>{{ change.label }}</td><td>未提供变更前值</td><td>{{ change.after }}</td></tr></ResourceTable><p v-for="version in versions" :key="version.label" class="admin-meta">申请绑定的{{ version.label }}：{{ version.value }}</p><p class="field-help">能力、组织范围、期限与委派清单是同一原申请元组，批准时不能替换或交叉组合。所有组织范围涵盖未来有效组织。</p><details><summary>原始规范化申请正文与技术证据</summary><p>审批版本 {{ selected.revision }} · 原始动作 {{ selected.action }}</p><p v-if="selected.payload_hash">正文校验标识 {{ selected.payload_hash }}</p><pre class="reading-body">{{ JSON.stringify(selected.payload, null, 2) }}</pre></details></section>
        <section class="admin-card stack"><h2>审批轨迹与应用结果</h2><ol class="governance-timeline"><li><strong>申请创建</strong><span>{{ selected.created_at }} · 申请人 {{ selected.requester_id }}</span></li><li v-if="selected.approver_id"><strong>已记录审批人</strong><span>{{ selected.approver_id }}（接口未单独提供审批时间）</span></li><li v-if="selected.updated_at && selected.updated_at !== selected.created_at"><strong>状态更新时间</strong><span>{{ selected.updated_at }} · 当前为{{ consoleStatusLabel(selected.status) }}；不补造中间事件。</span></li><li v-if="decisionReceipt"><strong>本次决定回执</strong><span>操作 {{ decisionReceipt.operation_id }} · {{ consoleStatusLabel(decisionReceipt.status) }}</span></li></ol><p v-if="selected.status === 'applied'" role="status">申请已生效。后续请求仍按当前授权范围与有效期校验。</p><p v-else-if="selected.status === 'approved' || selected.status === 'applying'" class="notice">审批已批准，但应用{{ selected.status === 'applying' ? '仍在进行' : '尚未完成' }}；不能当作权限已生效。</p><p v-else-if="selected.status === 'needs_recovery'" class="notice">应用需受控核查恢复。记录审批 {{ selected.id }}{{ decisionReceipt ? ` 与操作 ${decisionReceipt.operation_id}` : '' }}，由运维使用 CLI 检查现有操作与隔离状态；Web 不自动回滚、抢占或重复应用。</p><p v-else-if="selected.status === 'pending'" class="field-help">等待独立审批，尚未授予目标能力。</p><p v-else-if="selected.status === 'rejected'" class="field-help">申请已拒绝，不会应用目标变更。</p><button type="button" class="button secondary" :disabled="busy || !!reason" @click="openApproval">刷新审批与应用状态</button></section>
        <section v-if="selected.status === 'pending' && !decisionReceipt" class="admin-savebar governance-decision" aria-labelledby="approval-decision-title"><h2 id="approval-decision-title">独立审批决定</h2><p v-if="independenceReason" class="notice">{{ independenceReason }}</p><p v-else-if="!governing" class="notice">当前职责仅能查看申请，不能作出治理审批决定。</p><p v-if="locked" class="notice">原请求待确认或安全锁定，不能开始新的决定。请先处理工作区恢复状态。</p><p v-if="decisionError" class="notice" role="alert">{{ decisionError }}</p><template v-if="governing"><div class="field"><label for="approval-reason">审批理由（批准或拒绝均必填）</label><textarea id="approval-reason" v-model="reason" :disabled="busy || locked || !canDecide" required /></div><div class="actions"><button type="button" class="button" :disabled="busy || locked || !canDecide || !reason.trim()" @click="decide('approve')">批准并申请应用</button><button type="button" class="button secondary" :disabled="busy || locked || !canDecide || !reason.trim()" @click="decide('reject')">拒绝申请</button></div></template><p class="field-help">最终密码确认会再次核对原申请状态、职责、范围、期限和委派清单。取消确认保留审批理由。批准不保证应用成功，以回执与实际状态为准。</p></section>
        <p v-if="decisionError && selected.status !== 'pending'" class="notice" role="alert">{{ decisionError }}</p>
      </template>
    </template>
    <template v-else>
      <template v-if="!selectedEvent"><section class="admin-card stack"><h2>按已有分页接口定位审计记录</h2><p>目标审计 {{ resourceId }}。服务端没有审计详情查询接口，当前页{{ loaded ? '尚未包含该记录' : '正在读取' }}；不会自动扫描全库或猜测记录内容。</p><button v-if="cursor" type="button" class="button secondary" :disabled="busy" @click="load(true)">继续读取下一批并定位</button><button v-else-if="error" type="button" class="button secondary" :disabled="busy" @click="load()">重试当前有界读取</button><p v-else-if="loaded && !busy" class="admin-empty">已读取的可见分页没有此记录。记录可能不可见或已不在当前范围，请返回列表核对。</p></section></template>
      <template v-else><section class="admin-card stack"><h2>{{ consoleActionLabel(selectedEvent.action) }}</h2><dl class="governance-summary"><dt>记录时间</dt><dd>{{ selectedEvent.created_at }}</dd><dt>操作者</dt><dd>{{ selectedEvent.actor_id }}</dd><dt>操作者组织</dt><dd>{{ selectedEvent.actor_org_id || '未提供' }}</dd><dt>目标组织</dt><dd>{{ selectedEvent.target_org_id || '未提供' }}</dd><dt>目标标识</dt><dd>{{ selectedEvent.resource_id || '未提供' }}</dd><dt>操作理由</dt><dd>{{ selectedEvent.reason || '未提供' }}</dd></dl><details><summary>请求与关联标识</summary><p>审计 {{ selectedEvent.id }}</p><p>请求 {{ selectedEvent.request_id || '未提供' }}</p><p>操作 {{ selectedEvent.operation_id || '未提供' }}</p><p>审批 {{ selectedEvent.approval_id || '未提供' }}</p></details></section>
        <section class="admin-card stack"><h2>关联证据时间线</h2><p class="field-help">仅按已有记录展示时间与状态，不推测缺失的前后事件或声称时间排序。</p><p v-if="relatedBusy" role="status">正在读取可见关联证据…</p><p v-if="relatedError" class="notice" role="alert">部分关联证据无法读取：{{ relatedError }}。这不代表对应操作失败，也不扩大当前读取权限。</p><ol class="governance-timeline"><li><strong>当前审计记录</strong><span>{{ selectedEvent.created_at }} · {{ consoleActionLabel(selectedEvent.action) }}</span></li><li v-if="relatedOperation"><strong>关联操作</strong><span>{{ relatedOperation.created_at }} · {{ consoleActionLabel(relatedOperation.action) }} · {{ consoleStatusLabel(relatedOperation.status) }}</span><span>操作 {{ relatedOperation.operation_id }}{{ relatedOperation.step ? ` · 处理步骤 ${relatedOperation.step}` : '' }}</span><span v-if="relatedOperation.updated_at">状态更新时间 {{ relatedOperation.updated_at }}</span></li><li v-if="relatedApproval"><strong>关联审批申请</strong><span>{{ relatedApproval.created_at }} · {{ consoleActionLabel(relatedApproval.action) }} · {{ consoleStatusLabel(relatedApproval.status) }}</span><RouterLink :to="`/console/approvals/${encodeURIComponent(relatedApproval.id)}`">核对原申请 {{ relatedApproval.id }}</RouterLink></li></ol><p v-if="!selectedEvent.operation_id && !selectedEvent.approval_id" class="admin-empty">此记录没有已提供的操作或审批关联，不补造时间线事件。</p><p v-if="relatedOperation?.status === 'needs_recovery' || relatedApproval?.status === 'needs_recovery'" class="notice">现有证据标记为需恢复。记录操作 {{ relatedOperation?.operation_id || selectedEvent.operation_id || '未提供' }} 与审批 {{ relatedApproval?.id || selectedEvent.approval_id || '未提供' }}，使用 CLI 受控核查；不提供自动修复按钮。</p><button v-if="relatedError" type="button" class="button secondary" :disabled="relatedBusy" @click="loadRelated">重试可见关联证据</button></section>
      </template>
    </template>
  </section>
</template>
<style scoped>
.governance-summary { display: grid; grid-template-columns: minmax(5rem, 8rem) minmax(0, 1fr); gap: .75rem; }
.governance-summary dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.governance-timeline { display: grid; gap: 1rem; padding-left: 1.25rem; margin: 0; }
.governance-timeline li { display: grid; gap: .25rem; }
.governance-timeline span { overflow-wrap: anywhere; }
.governance-decision { display: grid; gap: 1rem; }
.governance-decision .field { min-width: 0; }
</style>
