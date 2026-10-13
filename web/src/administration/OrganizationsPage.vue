<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import type { ConsolePageProps, Member, Organization, Page, Receipt, User } from "./types";
import { consoleRoleLabel } from "./presentation";
import { availablePeopleRoles, canAddPeopleRole, isUserId, organizationKindLabel, type UserMembership } from "./peopleSelection";
import PageHeader from "./components/PageHeader.vue";
import ResourceTable from "./components/ResourceTable.vue";
import StatusBadge from "./components/StatusBadge.vue";
import PeopleUserPicker from "./PeopleUserPicker.vue";
import InvitationsPanel from "./InvitationsPanel.vue";

const props = defineProps<ConsolePageProps & { emailActions?: boolean }>();
const emit = defineEmits<{ dirty: [value: boolean] }>();
const route = useRoute();
const mode = computed(() => String(route.meta.consoleMode || "detail"));
const creating = computed(() => mode.value === "create"), editing = computed(() => mode.value === "edit");
const invitations = computed(() => mode.value === "invitations");
const organizationId = computed(() => props.resourceId || ""), memberId = computed(() => String(route.params.memberId || ""));
const platformAccounts = computed(() => props.context.capabilities.includes("account:platform-manage"));
const governing = computed(() => props.context.capabilities.includes("platform:govern"));
const localAccounts = computed(() => props.context.capabilities.includes("account:manage") && organizationId.value === props.context.actor_org_id);
const canReadMembers = computed(() => platformAccounts.value || governing.value || localAccounts.value);
const canAssociate = computed(() => platformAccounts.value || governing.value);
const organizations = ref<Organization[]>([]), members = ref<Member[]>([]), selected = ref<Member>(), targetUser = ref<User>(), userMemberships = ref<UserMembership[]>([]);
const orgCursor = ref<string | null>(null), memberCursor = ref<string | null>(null), organizationsLoaded = ref(false), membersLoaded = ref(false);
const organizationsLoading = ref(false), busy = ref(false), error = ref(""), organizationError = ref(""), formError = ref("");
const roles = ref<string[]>([]), status = ref("active"), reason = ref(""), roleExpiry = ref(""), baseline = ref(""), result = ref<Receipt>();
const allRelationsReady = ref(false);
const targetOrganization = computed(() => organizations.value.find(item => item.id === organizationId.value) || props.context.target_organizations.items.find(item => item.id === organizationId.value));
const roleOptions = computed(() => availablePeopleRoles(props.context, targetOrganization.value, selected.value?.roles));
const reviewerAdded = computed(() => roles.value.includes("content_reviewer") && !selected.value?.roles.includes("content_reviewer"));
const ownAccount = computed(() => selected.value?.id === props.context.actor_member_id || userMemberships.value.some(member => member.id === props.context.actor_member_id));
const protectionKnown = computed(() => typeof targetUser.value?.protected_account === "boolean");
const protectedAccount = computed(() => targetUser.value?.protected_account === true);
const alreadyMember = computed(() => creating.value && userMemberships.value.some(member => member.org_id === organizationId.value));
const sensitiveGain = computed(() => reviewerAdded.value || roles.value.includes("platform_ops") && !selected.value?.roles.includes("platform_ops"));
const invalidPlatformRole = computed(() => roles.value.includes("platform_ops") && (!governing.value || targetOrganization.value?.kind !== "platform" || targetOrganization.value.id !== props.context.actor_org_id));
const canWriteTarget = computed(() => !!targetUser.value && targetUser.value.status === "active" && protectionKnown.value && allRelationsReady.value && !ownAccount.value && !invalidPlatformRole.value && (!protectedAccount.value || governing.value) && (creating.value ? canAssociate.value : canReadMembers.value) && (platformAccounts.value || localAccounts.value && !creating.value || governing.value && (protectedAccount.value || sensitiveGain.value)));
const dirty = computed(() => !result.value && (!!reason.value || !!roleExpiry.value || creating.value && (!!targetUser.value || roles.value.length > 0) || editing.value && !!selected.value && JSON.stringify([roles.value, status.value]) !== baseline.value));
watch(dirty, value => emit("dirty", value), { flush: "sync" });
const life = new AbortController(); let alive = true;
function fail(cause: unknown, target = error) {
  if (alive && !(cause instanceof DOMException && cause.name === "AbortError")) target.value = cause instanceof Error ? cause.message : "请求失败，请重试。";
}
async function loadOrganizations(next = false) {
  if (organizationsLoading.value) return;
  organizationsLoading.value = true; organizationError.value = "";
  try {
    const params = new URLSearchParams({ limit: "20" }); if (next && orgCursor.value) params.set("cursor", orgCursor.value);
    const page = await props.request<Page<Organization>>(`/console/organizations?${params}`, { signal: life.signal });
    if (alive) { organizations.value = next ? [...organizations.value, ...page.items] : page.items; orgCursor.value = page.next_cursor; organizationsLoaded.value = true; }
  } catch (cause) { fail(cause, organizationError); }
  finally { if (alive) organizationsLoading.value = false; }
}
async function resolveOrganization() {
  if (targetOrganization.value) return;
  await loadOrganizations();
  while (alive && !targetOrganization.value && orgCursor.value && !organizationError.value) await loadOrganizations(true);
  if (alive && !targetOrganization.value && !organizationError.value) organizationError.value = "目标组织不在当前可见目录中。";
}
async function loadMembers(next = false) {
  if (!organizationId.value || !canReadMembers.value || busy.value) return;
  busy.value = true; error.value = "";
  try {
    const params = new URLSearchParams({ limit: "20" }); if (next && memberCursor.value) params.set("cursor", memberCursor.value);
    const page = await props.request<Page<Member>>(`/console/organizations/${encodeURIComponent(organizationId.value)}/members?${params}`, { signal: life.signal });
    if (alive) { members.value = next ? [...members.value, ...page.items] : page.items; memberCursor.value = page.next_cursor; membersLoaded.value = true; }
  } catch (cause) { fail(cause); }
  finally { if (alive) busy.value = false; }
}
async function loadPerson(id: string, preserveDraft = false) {
  if (!isUserId(id)) { formError.value = "目标用户 ID 格式无效。"; return; }
  busy.value = true; formError.value = ""; allRelationsReady.value = false;
  try {
    const user = await props.request<User>(`/console/users/${encodeURIComponent(id)}`, { signal: life.signal });
    const relations: UserMembership[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ limit: "20" }); if (cursor) params.set("cursor", cursor);
      const page = await props.request<Page<UserMembership>>(`/console/users/${encodeURIComponent(id)}/members?${params}`, { signal: life.signal });
      if (!alive) return;
      relations.push(...page.items); cursor = page.next_cursor;
    } while (cursor);
    if (!alive) return;
    if (editing.value) {
      const current = relations.find(member => member.id === memberId.value && member.org_id === organizationId.value);
      if (!current) { formError.value = "目标成员不属于当前用户和组织，或已不可见。"; return; }
      selected.value = { ...current, user_id: user.id, display_name: user.display_name };
      baseline.value = JSON.stringify([current.roles, current.status]);
      if (!preserveDraft) { roles.value = [...current.roles]; status.value = current.status; reason.value = ""; roleExpiry.value = ""; }
    }
    targetUser.value = user; userMemberships.value = relations; allRelationsReady.value = true;
  } catch (cause) { fail(cause, formError); }
  finally { if (alive) busy.value = false; }
}
async function choosePerson(user: User) {
  if (busy.value || props.locked || targetUser.value?.id === user.id) return;
  if (dirty.value && !window.confirm("切换关联用户将放弃当前关联草稿，确定继续？")) return;
  await loadPerson(user.id);
  if (allRelationsReady.value && targetUser.value?.id === user.id) { roles.value = ["student"]; reason.value = ""; roleExpiry.value = ""; }
}
async function loadMemberEditor() {
  if (!canReadMembers.value || !memberId.value) return;
  const userId = typeof route.query.user_id === "string" ? route.query.user_id : "";
  if (userId) { await loadPerson(userId); return; }
  await loadMembers();
  let member = members.value.find(item => item.id === memberId.value);
  while (alive && !member && memberCursor.value && !error.value) { await loadMembers(true); member = members.value.find(item => item.id === memberId.value); }
  if (member) await loadPerson(member.user_id);
  else if (alive && !error.value) formError.value = "目标成员不存在或不在当前可见组织中。";
}
async function submit() {
  const user = targetUser.value, member = selected.value;
  if (!user || busy.value || props.locked || !canWriteTarget.value || alreadyMember.value || !targetOrganization.value || result.value) return;
  formError.value = "";
  if (!roles.value.length && status.value !== "disabled") { formError.value = "已启用成员至少需要一个角色。"; return; }
  if (roles.value.some(role => !roleOptions.value.includes(role))) { formError.value = "请重新核对当前组织的可用角色。"; return; }
  busy.value = true;
  try {
    const period = reviewerAdded.value ? { valid_to: new Date(roleExpiry.value).toISOString() } : {};
    const receipt = await props.write(member ? `/console/members/${encodeURIComponent(member.id)}` : `/console/organizations/${encodeURIComponent(organizationId.value)}/members`, member ? { roles: [...roles.value], status: status.value, expected_revision: member.authorization_revision, reason: reason.value.trim(), ...period } : { user_id: user.id, roles: [...roles.value], reason: reason.value.trim(), ...period }, member ? "PUT" : "POST");
    if (!receipt || !alive) return;
    if (receipt.status === "applied" || receipt.status === "pending" && receipt.approval_id) result.value = { operation_id: receipt.operation_id, status: receipt.status, approval_id: receipt.approval_id };
    else formError.value = "结果仍待核查，请保留草稿并按原操作编号确认，不重复新建请求。";
  } catch (cause) { fail(cause, formError); }
  finally { if (alive) busy.value = false; }
}
onMounted(() => {
  if (!organizationId.value) { void loadOrganizations(); return; }
  void resolveOrganization();
  if (editing.value) void loadMemberEditor();
  else if (!creating.value && !invitations.value) void loadMembers();
});
onBeforeUnmount(() => { alive = false; life.abort(); emit("dirty", false); });
</script>

<template>
  <section class="admin-page" :aria-busy="busy || organizationsLoading">
    <PageHeader :title="!organizationId ? '组织与成员' : creating ? `关联成员 · ${targetOrganization?.name || '目标组织'}` : editing ? `成员详情与编辑 · ${targetOrganization?.name || '目标组织'}` : targetOrganization?.name || '目标组织成员'" :description="!organizationId ? '只读组织目录；选择组织后查看当前有权成员，不显示未经服务端提供的成员总数。' : '此处显示的是操作目标组织，与顶栏当前管理身份分开。'">
      <template #actions><RouterLink v-if="organizationId && !creating && !editing && canAssociate" class="button" :to="`/console/organizations/${organizationId}/members/new`">关联已有用户</RouterLink><RouterLink v-if="organizationId && canReadMembers && !invitations" class="button secondary" :to="`/console/organizations/${organizationId}/invitations`">管理邮箱邀请</RouterLink><RouterLink v-if="organizationId" class="button secondary" :to="creating || editing || invitations ? `/console/organizations/${organizationId}` : '/console/organizations'">{{ creating || editing || invitations ? '返回组织成员' : '返回组织目录' }}</RouterLink></template>
    </PageHeader>
    <p v-if="organizationId" class="admin-meta">目标组织 <code>{{ organizationId }}</code><template v-if="targetOrganization"> · {{ organizationKindLabel(targetOrganization.kind) }} · <StatusBadge :status="targetOrganization.status || ''" :label="targetOrganization.status === 'active' ? '已启用' : undefined" /></template></p>
    <p v-if="organizationError" class="notice" role="alert">{{ organizationError }}</p>
    <button v-if="organizationError" class="button secondary" :disabled="organizationsLoading" @click="organizationId ? resolveOrganization() : loadOrganizations()">重试组织目录</button>
    <p v-if="error" class="notice" role="alert">{{ error }}</p>

    <template v-if="!organizationId">
      <div class="admin-toolbar"><span class="field-help">当前可见组织，不提供网页创建、删除或假计数。</span><button class="button secondary" :disabled="organizationsLoading" @click="loadOrganizations()">刷新目录</button></div>
      <ResourceTable :headers="['组织名称', '类型', '状态', '操作']" :busy="organizationsLoading" :empty="organizationsLoaded && !organizations.length" empty-label="当前职责范围没有可见组织。"><tr v-for="item in organizations" :key="item.id"><td><RouterLink :to="`/console/organizations/${item.id}`">{{ item.name }}</RouterLink><code v-if="organizations.some(other => other.id !== item.id && other.name === item.name)" class="admin-meta">{{ item.id }}</code></td><td>{{ organizationKindLabel(item.kind) }}</td><td><StatusBadge :status="item.status || ''" :label="item.status === 'active' ? '已启用' : undefined" /></td><td><RouterLink class="text-button" :to="`/console/organizations/${item.id}`">查看组织</RouterLink></td></tr></ResourceTable><div v-if="organizationsLoaded" class="admin-toolbar"><span class="field-help">已载入 {{ organizations.length }} 条，非组织总数。</span><button v-if="orgCursor" class="button secondary" :disabled="organizationsLoading" @click="loadOrganizations(true)">加载下一页组织</button></div>
    </template>
    <template v-else-if="invitations"><InvitationsPanel v-if="targetOrganization" :context="context" :request="request" :write="write" :locked="locked" :organization="targetOrganization" :email-actions="emailActions === true" @dirty="emit('dirty', $event)" /></template>

    <template v-else-if="!creating && !editing">
      <p v-if="!canReadMembers" class="admin-empty">当前身份只能查看组织目录，没有此组织的成员读取或账号管理职责；未调用成员接口。</p>
      <template v-else><div class="admin-toolbar"><h2>组织成员</h2><button class="button secondary" :disabled="busy" @click="loadMembers()">刷新成员</button></div><ResourceTable :headers="['成员姓名', '角色', '成员状态', '操作']" :busy="busy" :empty="membersLoaded && !members.length" empty-label="当前组织没有可见成员。"><tr v-for="member in members" :key="member.id"><td><RouterLink :to="`/console/organizations/${organizationId}/members/${member.id}/edit?user_id=${member.user_id}`">{{ member.display_name }}</RouterLink><code v-if="members.some(other => other.id !== member.id && other.display_name === member.display_name)" class="admin-meta">{{ member.user_id }}</code></td><td>{{ member.roles.map(consoleRoleLabel).join('、') || '无有效角色' }}</td><td><StatusBadge :status="member.status" :label="member.status === 'active' ? '已启用' : undefined" /></td><td><RouterLink class="text-button" :to="`/console/organizations/${organizationId}/members/${member.id}/edit?user_id=${member.user_id}`">查看与编辑</RouterLink></td></tr></ResourceTable><div v-if="membersLoaded" class="admin-toolbar"><span class="field-help">已载入 {{ members.length }} 条，非成员总数。</span><button v-if="memberCursor" class="button secondary" :disabled="busy" @click="loadMembers(true)">加载下一页成员</button></div><button v-if="error" class="button secondary" :disabled="busy" @click="loadMembers()">重试成员读取</button><p class="field-help">接口提供成员姓名和用户 ID，不提供登录名；本页不猜测登录名。成员停用仅影响此组织，不等于全局账号停用。</p></template>
    </template>

    <template v-else>
      <p v-if="creating && !canAssociate || editing && !canReadMembers" class="notice" role="alert">当前身份没有此操作职责，未读取人员数据。</p>
      <section v-else-if="result" class="admin-card stack"><h2>{{ result.status === 'pending' ? '成员变更申请已提交' : '成员操作已生效' }}</h2><StatusBadge :status="result.status" /><p>{{ result.status === 'pending' ? '需另一位合格管理员独立审批；审批应用前成员角色与状态不变。' : '此操作仅涉及目标组织成员，不修改全局登录密码或账号状态。' }}</p><p>操作编号 <code>{{ result.operation_id }}</code></p><RouterLink v-if="result.approval_id" class="button secondary" :to="`/console/approvals/${result.approval_id}`">查看审批记录</RouterLink><RouterLink class="button secondary" :to="`/console/organizations/${organizationId}`">返回组织成员</RouterLink></section>
      <form v-else class="admin-form" @submit.prevent="submit">
        <p v-if="formError" class="notice" role="alert">{{ formError }}</p>
        <section v-if="creating && canAssociate" class="admin-form-section stack"><h2>选择已有用户</h2><p class="field-help">从当前有权目录或精确目标定位选择。平台治理者没有目录权时只能按明确用户 ID 定位。</p><PeopleUserPicker :context="context" :request="request" :locked="locked || busy" :selected="targetUser" @select="choosePerson" /></section>
        <section v-if="targetUser" class="admin-form-section stack"><h2>目标人员与保护规则</h2><p><strong>{{ targetUser.display_name }}</strong> · {{ targetUser.login_name }} <StatusBadge :status="targetUser.status" :label="targetUser.status === 'active' ? '账号已启用' : undefined" /></p><p class="admin-meta">用户 <code>{{ targetUser.id }}</code><template v-if="selected"> · 成员 <code>{{ selected.id }}</code></template></p><p v-if="protectedAccount" class="notice">此用户受保护。敏感身份、独立授权或在途审批可能触发保护，服务端已确认保护判定；只能由治理人员提出独立审批申请，不会直接变更。</p><p v-if="!protectionKnown" class="notice">缺少可靠的服务端保护判定，不能提交变更。请重试人员详情。</p><p v-if="protectedAccount && !governing" class="field-help">当前身份不能变更此受保护人员。请由另一位平台治理管理员按上述用户 ID 提出独立申请；不展示必定失败的直接提交入口。</p><p v-if="ownAccount" class="field-help">不能给本人扩大角色、停用或降权本人管理身份，后台不提供本人管理身份变更。</p><p v-if="targetUser.status !== 'active'" class="field-help">该用户全局账号未启用，当前不能关联或修改组织成员；请先由有权人员核对账号状态。</p><p v-if="alreadyMember" class="notice">该用户已经属于此组织，请从成员列表进入现有成员详情，不能重复关联。</p><p v-if="selected" class="field-help">当前服务端状态：{{ selected.status === 'active' ? '已启用' : '已停用' }}；角色：{{ selected.roles.map(consoleRoleLabel).join('、') || '无有效角色' }}。版本已内部读取，不要求手填。</p><button type="button" class="text-button" :disabled="busy || locked" @click="loadPerson(targetUser.id, true)">重读当前人员与权限版本（保留编辑内容）</button></section>
        <p v-if="busy" class="field-help" role="status">正在读取完整目标人员关系或处理操作，请稍候…</p>
        <button v-if="formError && !targetUser && editing" type="button" class="button secondary" :disabled="busy" @click="loadMemberEditor()">重试成员详情</button>
        <template v-if="targetUser && (!protectedAccount || governing) && protectionKnown && !ownAccount && targetUser.status === 'active' && !alreadyMember">
          <fieldset class="stack" :disabled="busy || locked || !allRelationsReady">
            <section class="admin-form-section stack"><h2>{{ creating ? '初始成员角色' : '完整角色与成员状态' }}</h2><fieldset><legend>角色（保留未变更角色期限及独立授权规则）</legend><label v-for="role in roleOptions" :key="role" class="admin-role-option"><input v-model="roles" type="checkbox" :value="role" :disabled="!selected?.roles.includes(role) && !canAddPeopleRole(context, targetOrganization, role)" /> {{ consoleRoleLabel(role) }}</label></fieldset><div v-if="reviewerAdded" class="field"><label for="member-review-expiry">新增内容审核身份截止时间</label><input id="member-review-expiry" v-model="roleExpiry" type="datetime-local" required /></div><div v-if="selected" class="field"><label for="member-status">组织成员状态</label><select id="member-status" v-model="status"><option value="active">已启用</option><option value="disabled">已停用</option></select></div><details v-if="selected?.role_assignments?.length"><summary>现有角色期限</summary><p v-for="assignment in selected.role_assignments" :key="assignment.role_id" class="field-help">{{ consoleRoleLabel(assignment.role_id) }}：{{ assignment.valid_from || '未设置起始时间' }} → {{ assignment.valid_to || '无自动到期' }}</p></details><p class="field-help">停用成员只撤销本组织有效访问，服务端仍按现有规则处理失去身份前提的独立授权，不按 CLI 整表清权。新增内容审核身份必须独立审批且明确截止时间；平台运营无自动管理权。</p><p v-if="governing && !platformAccounts && !localAccounts && !protectedAccount && !sensitiveGain" class="field-help">治理职责不能替代普通账号管理；普通关联或普通角色变更需账号管理人员。治理者可按目录提出新增敏感身份的独立审批申请。</p></section>
            <p v-if="invalidPlatformRole" class="notice">平台运营身份只能由治理人员在当前平台组织申请或保留；请核对目标组织及完整角色，不能跨平台组织提交此身份。</p>
            <section class="admin-form-section stack"><h2>理由与变更预览</h2><div class="field"><label for="member-reason">操作理由</label><textarea id="member-reason" v-model="reason" required maxlength="512" /></div><p>{{ targetUser.display_name }} → {{ targetOrganization?.name || organizationId }}；{{ roles.map(consoleRoleLabel).join('、') || '无角色' }}；{{ status === 'active' ? '已启用' : '已停用' }}。</p><p v-if="protectedAccount || sensitiveGain" class="field-help">本次提交独立审批申请，回执 pending 不代表权限已生效。</p></section>
            <div class="admin-savebar"><RouterLink class="button secondary" :to="`/console/organizations/${organizationId}`">取消</RouterLink><button v-if="canWriteTarget" class="button" :disabled="!reason.trim() || (!roles.length && status !== 'disabled') || !targetOrganization">{{ protectedAccount || sensitiveGain ? '提交独立审批申请' : creating ? '确认关联成员' : '保存成员变更' }}</button></div>
          </fieldset>
          <p class="field-help">取消密码确认会保留表单。遇到版本冲突请重读当前版本并核对服务端状态；不会自动覆盖编辑内容。</p>
        </template>
      </form>
    </template>
  </section>
</template>
