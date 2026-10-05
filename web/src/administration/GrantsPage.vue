<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import type { ConsolePageProps, Grant, Organization, Page, Receipt } from "./types";
import { baseRoleDirectory, eligibleEntry, requiresOwnOrganization, responsibilityDescription, type AuthorizationMember } from "./governancePresentation";
import { consoleCapabilityLabel, consoleRoleLabel, consoleScopeLabel, consoleStatusLabel } from "./presentation";
import AuthorizationTargetPicker from "./AuthorizationTargetPicker.vue";
import PageHeader from "./components/PageHeader.vue";
import ResourceTable from "./components/ResourceTable.vue";
import StatusBadge from "./components/StatusBadge.vue";
const props = defineProps<ConsolePageProps>(); const emit = defineEmits<{ dirty: [value: boolean] }>();
const route = useRoute(), router = useRouter();
const creating = computed(() => route.meta.consoleMode === "create"), editing = computed(() => route.meta.consoleMode === "edit");
const governing = computed(() => props.context.capabilities.includes("platform:govern"));
const canWrite = computed(() => governing.value || props.context.capabilities.includes("authorization:delegate"));
const canLocate = computed(() => governing.value || props.context.capabilities.some(cap => ["account:platform-manage", "account:manage"].includes(cap)));
const target = ref<AuthorizationMember>(), grants = ref<Grant[]>([]), organizations = ref<Organization[]>([]);
const cursor = ref<string | null>(null), orgCursor = ref<string | null>(null), filterStatus = ref("");
const busy = ref(false), organizationBusy = ref(false), loaded = ref(false), error = ref(""), organizationError = ref(""), formError = ref("");
const step = ref(0), selection = ref(""), scope = ref<"organization_ids" | "all_organizations">("organization_ids");
const organizationIds = ref<string[]>([]), delegateCapabilities = ref<string[]>([]), validFrom = ref(""), validTo = ref(""), reason = ref("");
const revokeTarget = ref<Grant>(), revokeReason = ref("");
const protectedRoles = ref<string[]>([]), protectedStatus = ref("active"), protectedReason = ref(""), protectedExpiry = ref(""), protectedBaseline = ref("");
const life = new AbortController(); let alive = true;
const initialUserId = typeof route.query.user_id === "string" ? route.query.user_id : undefined;
const initialMemberId = editing.value ? props.resourceId : typeof route.query.member_id === "string" ? route.query.member_id : undefined;
const entry = computed(() => props.context.catalog.find(item => `${item.storage_kind}:${item.capability}` === selection.value));
const targetOrganization = computed(() => organizations.value.find(item => item.id === target.value?.org_id));
const availableEntries = computed(() => target.value ? props.context.catalog.filter(item => eligibleEntry(item, target.value!, targetOrganization.value?.kind, props.context.catalog)) : []);
const ownScope = computed(() => !!entry.value && (requiresOwnOrganization(entry.value) || !governing.value));
const requiresExpiry = computed(() => !!entry.value && entry.value.capability !== "platform:govern" && (entry.value.sensitive || entry.value.storage_kind === "administrative" && (scope.value === "all_organizations" || target.value?.org_id !== props.context.actor_org_id)));
const reviewerAdded = computed(() => protectedRoles.value.includes("content_reviewer") && !target.value?.roles.includes("content_reviewer"));
const roleOptions = computed(() => baseRoleDirectory.filter(item => item.role !== "platform_ops" || targetOrganization.value?.kind === "platform" && target.value?.org_id === props.context.actor_org_id || target.value?.roles.includes(item.role)).map(item => item.role));
const protectedDirty = computed(() => !!protectedReason.value || !!protectedExpiry.value || !!target.value && JSON.stringify([protectedRoles.value, protectedStatus.value]) !== protectedBaseline.value);
const dirty = computed(() => creating.value && !!(target.value || selection.value || validFrom.value || validTo.value || reason.value) || editing.value && protectedDirty.value || !!revokeReason.value);
watch(dirty, value => emit("dirty", value));
watch(selection, () => {
  delegateCapabilities.value = []; scope.value = "organization_ids";
  organizationIds.value = ownScope.value && target.value ? [target.value.org_id] : [];
  if (entry.value?.capability === "platform:govern") validTo.value = "";
});
watch(filterStatus, () => { grants.value = []; cursor.value = null; loaded.value = false; });
const stepNames = ["定位成员", "选择职责", "组织范围", "有效期限", "委派清单", "核对预览"];
const validPeriod = computed(() => !!validFrom.value && Number.isFinite(Date.parse(validFrom.value)) && (!validTo.value || Number.isFinite(Date.parse(validTo.value)) && Date.parse(validTo.value) > Date.parse(validFrom.value)) && (!requiresExpiry.value || !!validTo.value));
const stepReady = computed(() => {
  if (step.value === 0) return !!target.value && target.value.status === "active" && target.value.user_status === "active" && target.value.id !== props.context.actor_member_id;
  if (step.value === 1) return !!entry.value && availableEntries.value.includes(entry.value);
  if (step.value === 2) return scope.value === "all_organizations" ? governing.value && !!entry.value?.allowed_scopes.includes(scope.value) : !!organizationIds.value.length;
  if (step.value === 3) return validPeriod.value;
  if (step.value === 4) return entry.value?.capability !== "authorization:delegate" || !!delegateCapabilities.value.length;
  return !!reason.value.trim();
});
const grantReady = computed(() => !!target.value && target.value.status === "active" && target.value.user_status === "active" && target.value.id !== props.context.actor_member_id && !!entry.value && availableEntries.value.includes(entry.value) && validPeriod.value && !!reason.value.trim() && (scope.value === "all_organizations" ? governing.value && entry.value.allowed_scopes.includes(scope.value) : !!organizationIds.value.length) && (entry.value.capability !== "authorization:delegate" || !!delegateCapabilities.value.length));
function fail(cause: unknown, destination = error) {
  if (alive && !(cause instanceof DOMException && cause.name === "AbortError")) destination.value = cause instanceof Error ? cause.message : "请求失败";
}
async function load(next = false) {
  const memberId = target.value?.id || (!creating.value && !editing.value ? props.resourceId : undefined);
  if (busy.value || !memberId) return;
  busy.value = true; error.value = "";
  try {
    const q = new URLSearchParams({ limit: "20", subject_member_id: memberId }); if (filterStatus.value) q.set("status", filterStatus.value); if (next && cursor.value) q.set("cursor", cursor.value);
    const page = await props.request<Page<Grant>>(`/console/grants?${q}`, { signal: life.signal });
    if (alive) { grants.value = next ? [...grants.value, ...page.items] : page.items; cursor.value = page.next_cursor; loaded.value = true; }
  } catch (cause) { fail(cause); } finally { if (alive) busy.value = false; }
}
async function loadOrganizations(next = false) {
  if (organizationBusy.value) return;
  organizationBusy.value = true; organizationError.value = "";
  try {
    const q = new URLSearchParams({ limit: "20" }); if (next && orgCursor.value) q.set("cursor", orgCursor.value);
    const page = await props.request<Page<Organization>>(`/console/organizations?${q}`, { signal: life.signal });
    if (alive) { organizations.value = next ? [...organizations.value, ...page.items] : page.items; orgCursor.value = page.next_cursor; }
  } catch (cause) { fail(cause, organizationError); } finally { if (alive) organizationBusy.value = false; }
}
function chooseMember(member: AuthorizationMember | undefined) {
  if (busy.value) return;
  if (editing.value && member && props.resourceId && member.id !== props.resourceId) {
    formError.value = "当前编辑页绑定指定成员，请继续分页定位该成员，或从授权列表进入另一成员的编辑页。";
    return;
  }
  if (editing.value && protectedDirty.value && target.value?.id !== member?.id && !window.confirm("放弃当前未提交的成员变更？")) return;
  target.value = member; selection.value = ""; grants.value = []; cursor.value = null; loaded.value = false; revokeTarget.value = undefined; revokeReason.value = "";
  if (member) {
    protectedRoles.value = [...member.roles]; protectedStatus.value = member.status; protectedReason.value = ""; protectedExpiry.value = "";
    protectedBaseline.value = JSON.stringify([protectedRoles.value, protectedStatus.value]);
    if (!creating.value && !editing.value) void load();
  }
}
async function followReceipt(receipt: Receipt) {
  if (!alive) return;
  reason.value = ""; validFrom.value = ""; validTo.value = ""; selection.value = ""; protectedReason.value = ""; protectedExpiry.value = ""; target.value = undefined; emit("dirty", false);
  await router.push(receipt.approval_id ? `/console/approvals/${encodeURIComponent(receipt.approval_id)}` : "/console/authorizations");
}
async function grant() {
  const member = target.value, item = entry.value; if (!member || !item || busy.value || props.locked || !canWrite.value || !grantReady.value) return;
  busy.value = true; formError.value = "";
  try {
    const receipt = await props.write("/console/grants", { subject_member_id: member.id, capability: item.capability, scope: { kind: scope.value, organization_ids: scope.value === "all_organizations" ? [] : [...organizationIds.value] }, ...(item.capability === "authorization:delegate" ? { delegate_capabilities: [...delegateCapabilities.value] } : {}), valid_from: new Date(validFrom.value).toISOString(), valid_to: validTo.value ? new Date(validTo.value).toISOString() : null, expected_revision: member.authorization_revision, reason: reason.value });
    if (receipt && alive) await followReceipt(receipt);
  } catch (cause) { fail(cause, formError); } finally { if (alive) busy.value = false; }
}
async function revoke() {
  const row = revokeTarget.value; if (!row || busy.value || props.locked || !canWrite.value || !revokeReason.value.trim()) return;
  busy.value = true; formError.value = "";
  let completed = false;
  try {
    const receipt = await props.write(`/console/grants/${encodeURIComponent(row.id)}/revoke`, { expected_revision: row.revision, reason: revokeReason.value });
    if (!receipt || !alive) return;
    revokeReason.value = ""; revokeTarget.value = undefined; completed = true;
    if (receipt.approval_id) await router.push(`/console/approvals/${encodeURIComponent(receipt.approval_id)}`);
  } catch (cause) { fail(cause, formError); } finally { if (alive) busy.value = false; }
  if (completed && alive && !props.locked) await load();
}
function discardRevoke() {
  if (busy.value || revokeReason.value && !window.confirm("放弃当前撤销目标与理由？")) return;
  revokeTarget.value = undefined; revokeReason.value = "";
}
async function updateProtectedMember() {
  const member = target.value; if (!member || !governing.value || busy.value || props.locked || !protectedReason.value.trim() || !protectedRoles.value.length && protectedStatus.value !== "disabled" || reviewerAdded.value && !protectedExpiry.value) return;
  busy.value = true; formError.value = "";
  try {
    const receipt = await props.write(`/console/members/${encodeURIComponent(member.id)}`, { roles: [...protectedRoles.value], status: protectedStatus.value, expected_revision: member.authorization_revision, reason: protectedReason.value, ...(reviewerAdded.value ? { valid_to: new Date(protectedExpiry.value).toISOString() } : {}) }, "PUT");
    if (receipt && alive) await followReceipt(receipt);
  } catch (cause) { fail(cause, formError); } finally { if (alive) busy.value = false; }
}
onMounted(() => {
  if (governing.value || props.context.capabilities.some(cap => ["account:platform-manage", "account:manage"].includes(cap))) void loadOrganizations();
  else { organizations.value = props.context.target_organizations.items; orgCursor.value = null; }
  if (!creating.value && !editing.value && props.resourceId) void load();
});
onBeforeUnmount(() => { alive = false; life.abort(); emit("dirty", false); });
</script>
<template>
  <section class="admin-page stack" :aria-busy="busy">
    <PageHeader :title="creating ? '授予精确授权' : editing ? '治理成员变更' : '角色与授权'" :description="creating ? '选择目标、职责、范围与期限后核对完整授权元组。' : editing ? '修改完整角色与成员状态，保留独立能力并使用当前权限版本提交。' : '基础角色说明与角色派生能力分开；独立授权按目标成员分页读取。'">
      <template #actions><RouterLink v-if="!creating && !editing && canWrite && canLocate" class="button" :to="{ path: '/console/authorizations/new', query: target ? { user_id: target.user_id, member_id: target.id } : {} }">授予权限</RouterLink><RouterLink v-if="creating || editing" class="button secondary" to="/console/authorizations">返回授权列表</RouterLink></template>
    </PageHeader>
    <p v-if="error" class="notice" role="alert">{{ error }}</p><p v-if="formError" class="notice" role="alert">{{ formError }}。版本冲突时重新读取并核对目标，不会自动覆盖。</p>
    <p v-if="locked" class="notice" role="status">当前存在待确认请求或安全锁定。草稿保留，但不能开始新的写入；请先处理工作区的原请求状态。</p>
    <template v-if="creating">
      <p v-if="!canWrite" class="notice">当前职责不允许授予授权，未提供写入入口。</p>
      <p v-else-if="!canLocate" class="notice">需组织账号管理职责才能定位人员。仅有精确委派职责不提供人员目录或新授权向导；请由有权治理者安排相应目录职责。已有精确授权的读取与撤销仍按真实委派权限校验。</p>
      <template v-else>
        <ol class="authorization-steps" aria-label="授权步骤"><li v-for="(name, index) in stepNames" :key="name" :aria-current="index === step ? 'step' : undefined"><span>{{ index + 1 }}</span>{{ name }}</li></ol>
        <section v-if="step === 0" class="admin-card stack"><h2>1. 定位用户并选择成员身份</h2><AuthorizationTargetPicker :context="context" :request="request" :disabled="busy || locked" :initial-user-id="initialUserId" :initial-member-id="initialMemberId" :selected-id="target?.id" @select="chooseMember" /><p v-if="target?.id === context.actor_member_id" class="notice">不能给本人管理身份新增授权。服务端还会校验同一用户的其他成员身份，禁止自提权。</p></section>
        <section v-if="step === 1" class="admin-card stack"><h2>2. 选择管理职责</h2><p v-if="target">目标：{{ target.display_name }} · {{ target.organization_name }}</p>
          <div class="field"><label for="grant-capability">当前服务端目录中符合目标身份的职责</label><select id="grant-capability" v-model="selection" :disabled="busy || locked" required><option value="">请选择，不自动授予业务能力</option><option v-for="item in availableEntries" :key="`${item.storage_kind}:${item.capability}`" :value="`${item.storage_kind}:${item.capability}`">{{ consoleCapabilityLabel(item.capability) }} · {{ item.storage_kind === 'member' ? '组织成员能力' : '独立管理职责' }}</option></select></div>
          <p v-if="!targetOrganization" class="notice">尚未读取目标组织类型，不能凭名称推断管理身份。请继续读取可见组织目录。</p><p v-if="organizationError" class="notice" role="alert">{{ organizationError }}</p><button v-if="orgCursor || organizationError" type="button" class="button secondary" :disabled="organizationBusy" @click="loadOrganizations(!!orgCursor)">{{ orgCursor ? '继续读取组织目录' : '重试组织目录' }}</button>
          <template v-if="entry"><p>{{ responsibilityDescription(entry.capability) }}</p><p class="field-help">身份要求：{{ entry.required_roles.map(consoleRoleLabel).join('、') || (entry.storage_kind === 'member' ? '有效组织成员' : '有效平台成员') }}。{{ entry.sensitive ? '必须经过独立审批；治理以外的敏感授权须明确截止时间。' : '是否需要审批仍以精确组织范围和服务端判断为准。' }}</p></template>
        </section>
        <section v-if="step === 2" class="admin-card stack"><h2>3. 选择组织范围</h2><p v-if="ownScope">此职责仅限目标成员所在组织：{{ target?.organization_name }}。不会跨组织组合能力。</p>
          <template v-else><div class="field"><label for="grant-scope">范围类型</label><select id="grant-scope" v-model="scope" :disabled="busy || locked"><option v-if="entry?.allowed_scopes.includes('organization_ids')" value="organization_ids">明确组织集合</option><option v-if="governing && entry?.allowed_scopes.includes('all_organizations')" value="all_organizations">所有组织（含未来组织）</option></select></div><fieldset v-if="scope === 'organization_ids'" :disabled="busy || locked"><legend>选择可见组织</legend><label v-for="org in organizations" :key="org.id" class="authorization-check"><input v-model="organizationIds" type="checkbox" :value="org.id" />{{ org.name }}</label></fieldset></template>
          <p v-if="scope === 'all_organizations'" class="notice">所有组织授权持续涵盖未来新增的有效组织。请确认该职责确实需要此范围；默认不会选择所有组织。</p><p v-if="organizationError" class="notice" role="alert">{{ organizationError }}</p><button v-if="!ownScope && (orgCursor || organizationError)" type="button" class="button secondary" :disabled="organizationBusy" @click="loadOrganizations(!!orgCursor)">{{ orgCursor ? '加载更多组织' : '重试组织目录' }}</button>
        </section>
        <section v-if="step === 3" class="admin-card stack"><h2>4. 设置有效期限</h2><div class="field"><label for="grant-from">开始时间</label><input id="grant-from" v-model="validFrom" type="datetime-local" :disabled="busy || locked" required /></div><div class="field"><label for="grant-to">截止时间{{ requiresExpiry ? '（必填）' : '（可留空）' }}</label><input id="grant-to" v-model="validTo" type="datetime-local" :disabled="busy || locked || entry?.capability === 'platform:govern'" :required="requiresExpiry" /></div><p class="field-help">治理权无自动到期；其他敏感授权、跨管理组织或全部组织的管理授权必须明确期限。截止时间必须晚于开始时间。</p></section>
        <section v-if="step === 4" class="admin-card stack"><h2>5. 核对委派边界</h2><fieldset v-if="entry?.capability === 'authorization:delegate'" :disabled="busy || locked"><legend>服务端目录允许委派的清单（至少一项）</legend><label v-for="capability in entry.delegate_capabilities || []" :key="capability" class="authorization-check"><input v-model="delegateCapabilities" type="checkbox" :value="capability" />{{ consoleCapabilityLabel(capability) }}</label></fieldset><p v-else>此职责不携带额外委派清单。拥有能力不等于有权委派该能力。</p></section>
        <section v-if="step === 5" class="admin-card stack"><h2>6. 核对本次授权</h2><dl class="authorization-summary"><dt>受益成员</dt><dd>{{ target?.display_name }} · {{ target?.organization_name }}</dd><dt>职责</dt><dd>{{ consoleCapabilityLabel(entry?.capability || '') }}</dd><dt>组织范围</dt><dd>{{ consoleScopeLabel(scope) }}{{ scope === 'organization_ids' ? `：${organizationIds.map(id => organizations.find(org => org.id === id)?.name || id).join('、')}` : '' }}</dd><dt>有效期限</dt><dd>{{ validFrom }} → {{ validTo || '无自动到期' }}</dd><dt>委派清单</dt><dd>{{ delegateCapabilities.map(consoleCapabilityLabel).join('、') || '无' }}</dd></dl><div class="field"><label for="grant-reason">授权理由</label><textarea id="grant-reason" v-model="reason" :disabled="busy || locked" required /></div><p class="field-help">提交后仍需单次密码确认。申请待审批、已批准、正在应用均不等于授权已生效。服务端再次校验目标版本、独立性和最后治理者保护。</p></section>
        <footer class="admin-savebar"><RouterLink class="button secondary" to="/console/authorizations">取消并返回</RouterLink><button v-if="step > 0" type="button" class="button secondary" :disabled="busy || locked" @click="step--">上一步</button><button v-if="step < 5" type="button" class="button" :disabled="busy || locked || !stepReady" @click="step++">下一步</button><button v-else type="button" class="button" :disabled="busy || locked || !grantReady" @click="grant">核对并提交授权</button></footer>
      </template>
    </template>
    <template v-else-if="editing">
      <p v-if="!governing" class="notice">受保护成员变更需要治理职责，未提供修改入口。</p><template v-else><section class="admin-card stack"><h2>定位受保护成员</h2><AuthorizationTargetPicker :context="context" :request="request" :disabled="busy || locked || !!target" :initial-user-id="initialUserId" :initial-member-id="initialMemberId" :selected-id="target?.id" @select="chooseMember" /></section>
        <section v-if="target" class="admin-card stack" aria-labelledby="protected-organization-title">
          <h2 id="protected-organization-title">目标组织身份确认</h2>
          <p v-if="targetOrganization">组织：{{ targetOrganization.name }} · {{ targetOrganization.kind === 'platform' ? '平台组织' : '组织成员身份' }}。新增角色按已确认的组织类型开放，已有角色保持原值。</p>
          <p v-else class="notice">尚未读取目标组织类型，不能按组织名称推断平台身份。已有角色仍保留，确认类型前不开放新增平台运维角色。</p>
          <p v-if="organizationBusy" role="status">正在读取可见组织目录…</p>
          <p v-if="organizationError" class="notice" role="alert">{{ organizationError }}</p>
          <button v-if="orgCursor || organizationError" type="button" class="button secondary" :disabled="busy || organizationBusy" @click="loadOrganizations(!!orgCursor)">{{ orgCursor ? '继续读取下一批组织并定位' : '重试组织目录' }}</button>
          <p v-if="!targetOrganization && !organizationBusy && !organizationError && !orgCursor" class="field-help">已读取的可见目录没有此组织类型证据；不能新增仅限平台身份的角色。可返回列表核对当前目标与管理职责。</p>
        </section>
        <form v-if="target" class="admin-form" @submit.prevent="updateProtectedMember"><section class="admin-form-section stack"><h2>{{ target.display_name }} · {{ target.organization_name }}</h2><p class="field-help">停用只影响此组织成员身份；不等于全局账号停用。角色变化保留独立能力，失去必要身份时能力不再有效。</p><fieldset :disabled="busy || locked"><legend>完整基础角色</legend><label v-for="role in roleOptions" :key="role" class="authorization-check"><input v-model="protectedRoles" type="checkbox" :value="role" />{{ consoleRoleLabel(role) }}</label></fieldset><div class="field"><label for="protected-status">组织成员状态</label><select id="protected-status" v-model="protectedStatus" :disabled="busy || locked"><option value="active">已启用</option><option value="disabled">已停用</option></select></div><div v-if="reviewerAdded" class="field"><label for="protected-expiry">新增审核角色的明确截止时间</label><input id="protected-expiry" v-model="protectedExpiry" type="datetime-local" :disabled="busy || locked" required /></div><div class="field"><label for="protected-reason">治理变更理由</label><textarea id="protected-reason" v-model="protectedReason" :disabled="busy || locked" required /></div></section><section class="admin-form-section"><h2>影响对照</h2><p>角色：{{ target.roles.map(consoleRoleLabel).join('、') || '无' }} → {{ protectedRoles.map(consoleRoleLabel).join('、') || '无' }}</p><p>成员状态：{{ consoleStatusLabel(target.status) }} → {{ consoleStatusLabel(protectedStatus) }}</p><p class="field-help">按已读取的当前版本提交CAS，不自动重基。管理身份自改、最后治理者降权由服务端拒绝；受保护变化需要独立审批与已有会话重验。</p></section><footer class="admin-savebar"><RouterLink class="button secondary" to="/console/authorizations">取消并返回</RouterLink><button class="button" :disabled="busy || locked || !protectedReason.trim() || !protectedRoles.length && protectedStatus !== 'disabled'">核对并提交治理变更</button></footer></form></template>
    </template>
    <template v-else>
      <section class="admin-card stack"><h2>选择授权目标</h2><AuthorizationTargetPicker :context="context" :request="request" :disabled="busy || !!revokeTarget" :initial-user-id="initialUserId" :initial-member-id="initialMemberId" :selected-id="target?.id" @select="chooseMember" /></section>
      <section v-if="target" class="stack"><h2>{{ target.display_name }} · {{ target.organization_name }}</h2><h3>基础角色及角色派生能力</h3><p class="field-help">下表是角色派生规则，不是额外授权。仅在账号、成员和角色期限均有效时生效。</p><ResourceTable :headers="['基础角色', '职责说明', '角色派生规则']" :empty="!target.roles.length" empty-label="此成员没有有效基础角色。"><tr v-for="role in target.roles" :key="role"><td>{{ consoleRoleLabel(role) }}</td><td>{{ baseRoleDirectory.find(item => item.role === role)?.description || '现有成员角色，以服务端目录为准。' }}</td><td>{{ baseRoleDirectory.find(item => item.role === role)?.capabilities.map(consoleCapabilityLabel).join('、') || '未提供' }}</td></tr></ResourceTable><RouterLink v-if="governing" class="button secondary" :to="{ path: `/console/authorizations/${encodeURIComponent(target.id)}/edit`, query: { user_id: target.user_id } }">治理成员角色与状态</RouterLink></section>
      <section class="stack"><h2>独立授权</h2><p v-if="!target && !resourceId" class="admin-empty">请先选择目标成员。此接口不提供全库授权列表，未查询时不显示虚假“0条”。</p><template v-else><form class="admin-toolbar" @submit.prevent="load()"><div class="field"><label for="grant-status-filter">授权状态</label><select id="grant-status-filter" v-model="filterStatus" :disabled="busy"><option value="">全部可见状态</option><option value="active">有效授权</option><option value="pending">待生效</option><option value="revoked">已撤销</option></select></div><button class="button secondary" :disabled="busy">查询授权</button></form><p class="admin-meta">当前条件：{{ filterStatus ? consoleStatusLabel(filterStatus) : '全部可见状态' }} · 按服务端游标读取，不代表时间倒序或全库数量。</p>
        <ResourceTable :headers="['职责', '组织范围', '有效期限', '状态', '操作']" :busy="busy" :empty="loaded && !grants.length && !error" empty-label="当前成员及条件没有独立授权。"><tr v-for="row in grants" :key="row.id"><td><strong>{{ consoleCapabilityLabel(row.capability) }}</strong><small v-if="row.delegate_capabilities?.length" class="admin-meta">委派：{{ row.delegate_capabilities.map(consoleCapabilityLabel).join('、') }}</small><details><summary>授权标识</summary><p>{{ row.id }} · {{ row.capability }}</p></details></td><td>{{ consoleScopeLabel(row.scope.kind) }}<small v-if="row.scope.organization_ids.length" class="admin-meta">{{ row.scope.organization_ids.map(id => organizations.find(org => org.id === id)?.name || id).join('、') }}</small></td><td>{{ row.valid_from }}<small class="admin-meta">至 {{ row.valid_to || '无自动到期' }}</small></td><td><StatusBadge :status="row.status" :label="row.status === 'pending' ? '待生效' : undefined" /></td><td><button v-if="row.status === 'active' && canWrite" type="button" class="button secondary" :disabled="busy || locked || !!revokeTarget" @click="revokeTarget = row; formError = ''">撤销</button><span v-else class="admin-meta">—</span></td></tr></ResourceTable><button v-if="cursor" type="button" class="button secondary" :disabled="busy" @click="load(true)">加载更多授权</button></template>
      </section>
      <section v-if="revokeTarget" class="admin-card admin-danger stack" aria-labelledby="authorization-revoke-title"><h2 id="authorization-revoke-title">撤销影响核对</h2><p>目标：{{ target?.display_name || revokeTarget.subject_member_id }} · {{ consoleCapabilityLabel(revokeTarget.capability) }}</p><p>范围：{{ consoleScopeLabel(revokeTarget.scope.kind) }} · {{ revokeTarget.scope.organization_ids.join('、') || '包含未来有效组织' }}</p><p>期限：{{ revokeTarget.valid_from }} → {{ revokeTarget.valid_to || '无自动到期' }}</p><p>撤销生效后立即失去该授权，已有会话与每次请求将重新校验。其他角色派生能力和独立授权不交叉合并；最后治理者与自改保护仍由服务端强制执行。</p><div class="field"><label for="grant-revoke-reason">撤销理由</label><textarea id="grant-revoke-reason" v-model="revokeReason" :disabled="busy || locked" required /></div><div class="actions"><button type="button" class="button secondary" :disabled="busy" @click="discardRevoke">放弃撤销草稿</button><button type="button" class="button" :disabled="busy || locked || !revokeReason.trim()" @click="revoke">核对并撤销</button></div><p class="field-help">最终密码确认取消时，本段目标和理由仍保留。</p></section>
      <details class="admin-card"><summary>固定职责目录说明（非自定义角色编辑器）</summary><section class="stack"><h2>基础角色</h2><ResourceTable :headers="['角色', '职责', '派生能力']"><tr v-for="item in baseRoleDirectory" :key="item.role"><td>{{ consoleRoleLabel(item.role) }}</td><td>{{ item.description }}</td><td>{{ item.capabilities.map(consoleCapabilityLabel).join('、') }}</td></tr></ResourceTable><h2>当前身份可见的独立授权目录</h2><div v-for="item in context.catalog" :key="`${item.storage_kind}:${item.capability}`" class="authorization-directory"><h3>{{ consoleCapabilityLabel(item.capability) }} · {{ item.storage_kind === 'member' ? '组织成员能力' : '管理职责' }}</h3><p>{{ responsibilityDescription(item.capability) }}</p><p class="admin-meta">身份要求：{{ item.required_roles.map(consoleRoleLabel).join('、') || (item.storage_kind === 'member' ? '有效组织成员' : '有效平台成员') }}。{{ item.sensitive ? '独立审批，明确有效期（治理权不自动到期）' : '按目标组织和范围由服务端判断审批规则' }}。{{ item.delegatable ? '仅在已有委派清单内可委派' : '不可普通委派' }}。</p></div><p v-if="!context.catalog.length" class="admin-empty">当前职责没有可授予的目录项；查看授权不代表可新增权限。</p></section></details>
    </template>
  </section>
</template>
<style scoped>
.authorization-steps { display: flex; flex-wrap: wrap; gap: 1rem; list-style: none; padding: 0; margin: 0; }
.authorization-steps li { display: flex; align-items: center; gap: .5rem; color: #667085; }
.authorization-steps li[aria-current="step"] { color: #174ea6; font-weight: 600; }
.authorization-steps span { border: 1px solid #e4e7ec; border-radius: 50%; width: 1.75rem; height: 1.75rem; display: grid; place-items: center; }
.authorization-check { display: inline-flex; align-items: center; gap: .5rem; margin: .5rem 1rem .5rem 0; }
.authorization-summary { display: grid; grid-template-columns: minmax(5rem, 8rem) minmax(0, 1fr); gap: .75rem; }
.authorization-summary dd { margin: 0; overflow-wrap: anywhere; }
.authorization-directory { border-top: 1px solid #e4e7ec; padding: 1rem 0; }
.admin-empty { text-align: left; padding: 16px !important; background: var(--color-canvas); border: 1px solid var(--color-border); border-radius: 6px; }
</style>
