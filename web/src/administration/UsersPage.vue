<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { ConsolePageProps, Organization, Page, Receipt, User } from "./types";
import { consoleRoleLabel } from "./presentation";
import { availablePeopleRoles, isUserId, organizationKindLabel, sameUserName, type UserMembership } from "./peopleSelection";
import PageHeader from "./components/PageHeader.vue";
import ResourceTable from "./components/ResourceTable.vue";
import StatusBadge from "./components/StatusBadge.vue";

const props = defineProps<ConsolePageProps & { exactLookupOnly?: boolean }>();
const emit = defineEmits<{ dirty: [value: boolean] }>();
const route = useRoute(), router = useRouter();
const creating = computed(() => route.meta.consoleMode === "create");
const hasDirectory = computed(() => !props.exactLookupOnly && props.context.menus.includes("users"));
const governing = computed(() => props.context.capabilities.includes("platform:govern"));
const platformAccounts = computed(() => props.context.capabilities.includes("account:platform-manage"));
const users = ref<User[]>([]), selected = ref<User>(), organizations = ref<Organization[]>([]), relations = ref<UserMembership[]>([]);
const cursor = ref<string | null>(null), orgCursor = ref<string | null>(null), relationCursor = ref<string | null>(null);
const busy = ref(false), error = ref(""), loaded = ref(false), queryKind = ref("login"), query = ref(""), appliedLogin = ref("");
const organizationsLoading = ref(false), organizationError = ref(""), relationsLoading = ref(false), relationError = ref(""), relationsReady = ref(false);
const login = ref(""), display = ref(""), organization = ref(platformAccounts.value ? "" : props.context.actor_org_id), roles = ref<string[]>(["student"]), roleExpiry = ref(""), reason = ref("");
const formError = ref(""), actionError = ref(""), actionKind = ref<"status" | "password-reset">(), result = ref<Receipt>();
const selectableOrganizations = computed(() => organizations.value.filter(item => platformAccounts.value || item.id === props.context.actor_org_id));
const targetOrganization = computed(() => selectableOrganizations.value.find(item => item.id === organization.value));
const roleOptions = computed(() => availablePeopleRoles(props.context, targetOrganization.value));
const reviewerAdded = computed(() => roles.value.includes("content_reviewer"));
const ownAccount = computed(() => relations.value.some(member => member.id === props.context.actor_member_id));
const protectionKnown = computed(() => typeof selected.value?.protected_account === "boolean");
const protectedAccount = computed(() => selected.value?.protected_account === true);
const completeInfluence = computed(() => relationsReady.value && !relationCursor.value && !relationError.value);
const canOperate = computed(() => !!selected.value && protectionKnown.value && !ownAccount.value && (!protectedAccount.value || governing.value));
const canStatus = computed(() => canOperate.value && (platformAccounts.value || governing.value && protectedAccount.value));
const canReset = computed(() => canOperate.value && (hasDirectory.value || governing.value && protectedAccount.value));
const initialOrganization = platformAccounts.value ? "" : props.context.actor_org_id;
const dirty = computed(() => !!reason.value || creating.value && !result.value && !!(login.value || display.value || roleExpiry.value || organization.value !== initialOrganization || roles.value.length !== 1 || roles.value[0] !== "student"));
watch(dirty, value => emit("dirty", value), { flush: "sync" });
const life = new AbortController(); let alive = true, generation = 0, relationGeneration = 0, listController = new AbortController();
watch([queryKind, query], () => { generation++; listController.abort(); listController = new AbortController(); busy.value = false; cursor.value = null; users.value = []; loaded.value = false; error.value = ""; }, { flush: "sync" });
watch(organization, () => { roles.value = roles.value.filter(role => roleOptions.value.includes(role)); });
function fail(cause: unknown, target = error) {
  if (alive && !(cause instanceof DOMException && cause.name === "AbortError")) target.value = cause instanceof Error ? cause.message : "请求失败，请重试。";
}
async function loadUsers(next = false) {
  if (!hasDirectory.value || busy.value) return;
  const token = ++generation; busy.value = true; error.value = "";
  try {
    const filter = next ? appliedLogin.value : query.value.trim();
    const params = new URLSearchParams({ limit: "20" });
    if (filter) params.set("login_name", filter);
    if (next && cursor.value) params.set("cursor", cursor.value);
    const page = await props.request<Page<User>>(`/console/users?${params}`, { signal: listController.signal });
    if (alive && token === generation) { users.value = next ? [...users.value, ...page.items] : page.items; cursor.value = page.next_cursor; appliedLogin.value = filter; loaded.value = true; }
  } catch (cause) { if (token === generation) fail(cause); }
  finally { if (alive && token === generation) busy.value = false; }
}
async function findUser() {
  if (hasDirectory.value && queryKind.value === "login") { await loadUsers(); return; }
  const id = query.value.trim();
  if (!isUserId(id)) { error.value = "请输入完整有效的用户 ID。"; return; }
  await router.push(`/console/users/${encodeURIComponent(id)}`);
}
async function loadOrganizations(next = false) {
  if (organizationsLoading.value) return;
  organizationsLoading.value = true; organizationError.value = "";
  try {
    const params = new URLSearchParams({ limit: "20" }); if (next && orgCursor.value) params.set("cursor", orgCursor.value);
    const page = await props.request<Page<Organization>>(`/console/organizations?${params}`, { signal: life.signal });
    if (alive) { organizations.value = next ? [...organizations.value, ...page.items] : page.items; orgCursor.value = page.next_cursor; }
  } catch (cause) { fail(cause, organizationError); }
  finally { if (alive) organizationsLoading.value = false; }
}
async function loadUser(id: string) {
  if (!isUserId(id)) { error.value = "用户 ID 格式无效。"; return; }
  busy.value = true; error.value = ""; relationGeneration++; relationsLoading.value = false; relations.value = []; relationCursor.value = null; relationsReady.value = false;
  try {
    const user = await props.request<User>(`/console/users/${encodeURIComponent(id)}`, { signal: life.signal });
    if (!alive) return;
    selected.value = user;
    await loadRelations();
  } catch (cause) { fail(cause); }
  finally { if (alive) busy.value = false; }
}
async function loadRelations(next = false) {
  const user = selected.value; if (!user || relationsLoading.value) return;
  const token = relationGeneration; relationsLoading.value = true; relationError.value = "";
  try {
    const params = new URLSearchParams({ limit: "20" }); if (next && relationCursor.value) params.set("cursor", relationCursor.value);
    const page = await props.request<Page<UserMembership>>(`/console/users/${encodeURIComponent(user.id)}/members?${params}`, { signal: life.signal });
    if (alive && token === relationGeneration && selected.value?.id === user.id) { relations.value = next ? [...relations.value, ...page.items] : page.items; relationCursor.value = page.next_cursor; relationsReady.value = true; }
  } catch (cause) { if (token === relationGeneration) fail(cause, relationError); }
  finally { if (alive && token === relationGeneration) relationsLoading.value = false; }
}
async function createUser() {
  if (!hasDirectory.value || busy.value || props.locked || result.value) return;
  formError.value = "";
  if (!targetOrganization.value) { formError.value = "请从有权目录选择目标组织。"; return; }
  if (!roles.value.length || roles.value.some(role => !roleOptions.value.includes(role))) { formError.value = "请核对该组织允许的角色。"; return; }
  busy.value = true;
  try {
    const receipt = await props.write("/console/users", { login_name: login.value.trim(), display_name: display.value.trim(), org_id: organization.value, roles: [...roles.value], reason: reason.value.trim(), ...(reviewerAdded.value ? { valid_to: new Date(roleExpiry.value).toISOString() } : {}) }, "POST", true);
    if (!receipt || !alive) return;
    if (receipt.status === "applied" || receipt.status === "pending" && receipt.approval_id) { result.value = { operation_id: receipt.operation_id, status: receipt.status, approval_id: receipt.approval_id, user_id: receipt.user_id }; reason.value = ""; }
    else formError.value = "操作尚未确定生效，请保留当前页面并按原操作编号核查。";
  } catch (cause) { fail(cause, formError); }
  finally { if (alive) busy.value = false; }
}
async function submitAction() {
  const user = selected.value, kind = actionKind.value;
  if (!user || !kind || busy.value || props.locked || !completeInfluence.value || !(kind === "status" ? canStatus.value : canReset.value)) return;
  busy.value = true; actionError.value = "";
  try {
    const receipt = await props.write(`/console/users/${encodeURIComponent(user.id)}/${kind}`, { expected_identity_revision: user.identity_revision, ...(kind === "status" ? { status: user.status === "active" ? "disabled" : "active" } : {}), reason: reason.value.trim() }, kind === "status" ? "PUT" : "POST", kind === "password-reset");
    if (!receipt || !alive) return;
    if (receipt.status === "applied" || receipt.status === "pending" && receipt.approval_id) {
      result.value = { operation_id: receipt.operation_id, status: receipt.status, approval_id: receipt.approval_id }; reason.value = ""; actionKind.value = undefined;
      if (receipt.status === "applied") await loadUser(user.id);
    } else actionError.value = "结果仍待核查；未清除当前操作草稿，请按原编号确认结果。";
  } catch (cause) { fail(cause, actionError); }
  finally { if (alive) busy.value = false; }
}
onMounted(() => {
  if (creating.value) { if (hasDirectory.value) void loadOrganizations(); return; }
  if (props.resourceId) { void loadUser(props.resourceId); return; }
  if (hasDirectory.value) void loadUsers();
});
onBeforeUnmount(() => { alive = false; generation++; life.abort(); listController.abort(); emit("dirty", false); });
</script>

<template>
  <section class="admin-page" :aria-busy="busy">
    <PageHeader :title="creating ? '创建用户' : selected ? selected.display_name : hasDirectory ? '用户' : '明确用户定位'" :description="creating ? '创建账号与初始成员身份，不设置默认名称或可回放密码。' : selected ? '查看账号、组织身份与操作影响；账号状态和组织成员状态彼此独立。' : hasDirectory ? '使用精确登录名或用户 ID 查询有权账号，不提供模糊搜索或全库计数。' : '治理职责不提供用户目录，仅定位已知用户。'">
      <template #actions><RouterLink v-if="!creating && !selected && hasDirectory" class="button" to="/console/users/new">创建用户</RouterLink><RouterLink v-else class="button secondary" to="/console/users">返回用户定位</RouterLink></template>
    </PageHeader>
    <p v-if="error" class="notice" role="alert">{{ error }}</p>
    <button v-if="error && resourceId && !creating" class="button secondary" :disabled="busy" @click="loadUser(resourceId)">重试用户详情</button>

    <template v-if="!creating && !resourceId">
      <form class="admin-toolbar" @submit.prevent="findUser">
        <div v-if="hasDirectory" class="field"><label for="user-query-kind">查询方式</label><select id="user-query-kind" v-model="queryKind"><option value="login">精确登录名</option><option value="id">用户 ID</option></select></div>
        <div class="field"><label for="user-query">{{ hasDirectory && queryKind === 'login' ? '登录名（留空读取目录）' : '明确用户 ID' }}</label><input id="user-query" v-model="query" :required="!hasDirectory || queryKind === 'id'" autocomplete="off" /></div>
        <button class="button secondary" :disabled="busy">查询</button>
      </form>
      <p v-if="hasDirectory && appliedLogin && loaded" class="field-help">当前条件：精确登录名 {{ appliedLogin }} <button type="button" class="text-button" @click="query = ''; loadUsers()">清除条件</button></p>
      <template v-if="hasDirectory">
        <ResourceTable :headers="['用户', '账号状态', '操作']" :busy="busy" :empty="loaded && !users.length" empty-label="当前查询范围没有用户。">
          <tr v-for="user in users" :key="user.id"><td><RouterLink :to="`/console/users/${user.id}`">{{ user.display_name }}</RouterLink><span class="admin-meta">{{ user.login_name }}</span><code v-if="sameUserName(users, user)" class="admin-meta">{{ user.id }}</code></td><td><StatusBadge :status="user.status" :label="user.status === 'active' ? '已启用' : undefined" /></td><td><RouterLink class="text-button" :to="`/console/users/${user.id}`">查看详情</RouterLink></td></tr>
        </ResourceTable>
        <div v-if="loaded" class="admin-toolbar"><span class="field-help">已载入 {{ users.length }} 条，非用户总数。</span><button v-if="cursor" class="button secondary" :disabled="busy" @click="loadUsers(true)">加载下一页用户</button></div>
      </template>
      <p v-else class="admin-empty">请输入已知用户 ID。不会调用用户列表或登录名查询接口。</p>
    </template>

    <template v-if="creating">
      <p v-if="!hasDirectory" class="notice" role="alert">当前职责没有创建用户权限，未读取用户或组织目录。</p>
      <section v-else-if="result" class="admin-card stack" aria-labelledby="create-user-result"><h2 id="create-user-result">{{ result.status === 'pending' ? '创建申请已提交' : '账号已创建' }}</h2><StatusBadge :status="result.status" /><p>{{ result.status === 'pending' ? '初始敏感身份需另一位合格管理员独立审批；批准应用前不交付可用密码。' : '账号与初始成员已生效。请先完成上方一次性凭据交付，再离开此页。' }}</p><p>操作编号 <code>{{ result.operation_id }}</code></p><RouterLink v-if="result.approval_id" class="button secondary" :to="`/console/approvals/${result.approval_id}`">查看审批记录</RouterLink><RouterLink v-if="result.status === 'applied' && result.user_id" class="button secondary" :to="`/console/users/${result.user_id}`">查看用户详情</RouterLink></section>
      <form v-else class="admin-form" @submit.prevent="createUser">
        <p v-if="formError" class="notice" role="alert">{{ formError }}</p>
        <fieldset class="stack" :disabled="busy || locked">
          <section class="admin-form-section stack"><h2>基础信息</h2><div class="field"><label for="new-user-login">登录名</label><input id="new-user-login" v-model="login" required minlength="3" maxlength="64" aria-describedby="new-user-login-help" autocomplete="off" /><p id="new-user-login-help" class="field-help">3–64 位字母、数字、下划线或连字符。</p></div><div class="field"><label for="new-user-name">显示名称</label><input id="new-user-name" v-model="display" required maxlength="100" /></div></section>
          <section class="admin-form-section stack"><h2>初始组织身份</h2><div class="field"><label for="new-user-org">目标组织</label><select id="new-user-org" v-model="organization" :disabled="organizationsLoading" required><option value="">选择有权组织</option><option v-for="item in selectableOrganizations" :key="item.id" :value="item.id">{{ item.name }} · {{ organizationKindLabel(item.kind) }} · {{ item.id }}</option></select></div><p v-if="organizationError" class="notice" role="alert">{{ organizationError }}</p><button v-if="orgCursor || organizationError" type="button" class="button secondary" :disabled="organizationsLoading" @click="loadOrganizations(!!orgCursor)">{{ orgCursor ? '加载下一页组织' : '重试组织目录' }}</button><p v-if="organizationsLoading" class="field-help" role="status">正在读取组织目录…</p><fieldset><legend>角色</legend><label v-for="role in roleOptions" :key="role" class="admin-role-option"><input v-model="roles" type="checkbox" :value="role" /> {{ consoleRoleLabel(role) }}</label></fieldset><div v-if="reviewerAdded" class="field"><label for="new-user-review-expiry">内容审核身份截止时间</label><input id="new-user-review-expiry" v-model="roleExpiry" type="datetime-local" required /></div><p class="field-help">角色仅提供其基础职责，不自动授予独立管理权。内容审核身份有明确期限；平台身份仅治理者可向当前平台组织申请。组织账号管理员只能创建本组织用户；可见业务目录不扩大账号创建范围。</p></section>
          <section class="admin-form-section stack"><h2>理由与结果预览</h2><div class="field"><label for="new-user-reason">创建理由</label><textarea id="new-user-reason" v-model="reason" required maxlength="512" /></div><p>{{ display || '待填写姓名' }} · {{ login || '待填写登录名' }} → {{ targetOrganization?.name || '待选择组织' }} · {{ roles.map(consoleRoleLabel).join('、') || '待选择角色' }}</p><p class="field-help">敏感身份先提交独立审批；普通创建仅在已生效回执后提供首次改密凭据。</p></section>
          <div class="admin-savebar"><RouterLink class="button secondary" to="/console/users">取消</RouterLink><button class="button" :disabled="!roles.length || !reason.trim() || !login.trim() || !display.trim() || !targetOrganization">提交创建</button></div>
        </fieldset>
      </form>
    </template>

    <template v-if="selected && !creating">
      <section class="admin-card stack"><h2>账号信息</h2><dl class="admin-detail-grid"><dt>显示名称</dt><dd>{{ selected.display_name }}</dd><dt>登录名</dt><dd>{{ selected.login_name }}</dd><dt>全局账号状态</dt><dd><StatusBadge :status="selected.status" :label="selected.status === 'active' ? '已启用' : undefined" /></dd><dt>用户 ID</dt><dd><code>{{ selected.id }}</code></dd></dl><p v-if="protectedAccount" class="notice">受保护账号。变更须由平台治理人员提出申请，再由独立管理员审批；保护规则涵盖敏感身份、独立授权及在途审批，本页不推断具体授权明细。</p><p v-else-if="!protectionKnown" class="notice">当前响应没有可靠保护判定，账号操作不可用。请重试详情读取，不能将缺失字段视为普通账号。</p><p v-if="ownAccount" class="field-help">这是当前管理账号，不能在后台重置、停用或降权本人；修改本人密码请使用顶栏账号菜单。</p><p v-if="protectedAccount && !governing" class="field-help">当前身份不能直接变更此账号。请将上述用户 ID 交由另一位平台治理管理员定位并提交独立申请。</p></section>
      <section class="stack"><h2>{{ platformAccounts || governing ? '组织成员与跨组织影响范围' : '当前有权组织成员关系' }}</h2><p class="field-help">全局停启撤销账号会话并影响所有组织登录；组织成员停用只影响对应组织。{{ !platformAccounts && !governing ? '当前职责只返回本组织关系，不能据此断言用户唯一归属；重置资格由服务端再次核验。' : '' }}</p><ResourceTable :headers="['组织', '角色', '成员状态', '操作']" :busy="relationsLoading" :empty="relationsReady && !relations.length" empty-label="此用户没有当前可见成员关系。"><tr v-for="member in relations" :key="member.id"><td><RouterLink :to="`/console/organizations/${member.org_id}`">{{ member.organization_name || '名称未提供' }}</RouterLink><code class="admin-meta">{{ member.org_id }}</code></td><td>{{ member.roles.map(consoleRoleLabel).join('、') || '无有效角色' }}<details v-if="member.role_assignments?.length"><summary>角色期限</summary><p v-for="assignment in member.role_assignments" :key="assignment.role_id" class="field-help">{{ consoleRoleLabel(assignment.role_id) }}：{{ assignment.valid_from || '未设置起始时间' }} → {{ assignment.valid_to || '无自动到期' }}</p></details></td><td><StatusBadge :status="member.status" :label="member.status === 'active' ? '已启用' : undefined" /></td><td><RouterLink v-if="member.id !== context.actor_member_id && (!protectedAccount || governing) && protectionKnown" class="text-button" :to="`/console/organizations/${member.org_id}/members/${member.id}/edit?user_id=${selected.id}`">{{ protectedAccount ? '独立变更申请' : '查看与编辑成员' }}</RouterLink><span v-else class="field-help">{{ member.id === context.actor_member_id ? '本人管理身份' : '需治理人员处理' }}</span></td></tr></ResourceTable><p v-if="relationError" class="notice" role="alert">影响范围读取失败：{{ relationError }}</p><div class="admin-toolbar"><span v-if="relationCursor || !relationsReady || relationError" class="field-help">关系尚未完整读取，不能提交账号影响操作。</span><button v-if="relationCursor || !relationsReady || relationError" class="button secondary" :disabled="busy || relationsLoading" @click="loadRelations(!!relationCursor)">{{ relationError ? '重试影响范围' : '加载下一页关系' }}</button></div></section>
      <section v-if="canStatus || canReset" class="admin-card stack"><div class="admin-toolbar"><h2>账号操作</h2><details class="admin-more"><summary>更多操作</summary><div class="stack"><button v-if="canStatus" type="button" class="text-button" :disabled="busy || locked" @click="actionKind = 'status'">{{ protectedAccount ? '申请全局' : '全局' }}{{ selected.status === 'active' ? '停用' : '启用' }}</button><button v-if="canReset" type="button" class="text-button" :disabled="busy || locked" @click="actionKind = 'password-reset'">{{ protectedAccount ? '申请重置密码' : '重置密码' }}</button></div></details></div><p v-if="result" role="status"><StatusBadge :status="result.status" /> · 操作 <code>{{ result.operation_id }}</code> <RouterLink v-if="result.approval_id" :to="`/console/approvals/${result.approval_id}`">查看审批记录</RouterLink></p><form v-if="actionKind" class="stack" @submit.prevent="submitAction"><p>{{ actionKind === 'status' ? `目标全局状态：${selected.status === 'active' ? '已停用' : '已启用'}。影响该账号全部组织登录并撤销旧会话。` : '重置全部组织共用的登录密码，不会自动启用账号；新密码仅首次确定响应交付，首次登录必须改密。' }}</p><p v-if="protectedAccount" class="field-help">本次仅提出独立审批申请，提交申请不代表操作生效。</p><p v-if="actionError" class="notice" role="alert">{{ actionError }}</p><div class="field"><label for="user-action-reason">操作理由</label><textarea id="user-action-reason" v-model="reason" :disabled="busy || locked" required maxlength="512" /></div><div class="admin-savebar"><button type="button" class="button secondary" :disabled="busy || locked" @click="actionKind = undefined">收起操作（保留理由）</button><button class="button" :disabled="busy || locked || !reason.trim() || !completeInfluence">{{ protectedAccount ? '提交独立审批申请' : '继续确认操作' }}</button></div><p class="field-help">密码再验确认取消会保留理由。遇到版本冲突请重读账号详情并核对，不自动覆盖最新状态。</p><button v-if="actionError" type="button" class="text-button" :disabled="busy" @click="loadUser(selected.id)">重新读取当前账号版本（保留理由）</button></form></section>
    </template>
  </section>
</template>
