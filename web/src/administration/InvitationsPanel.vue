<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ConsolePageProps, Organization, Page, Receipt } from "./types";
import { availablePeopleRoles } from "./peopleSelection";
import { consoleRoleLabel } from "./presentation";
import PageHeader from "./components/PageHeader.vue";
import ResourceTable from "./components/ResourceTable.vue";
import StatusBadge from "./components/StatusBadge.vue";

interface Invitation {
  id: string; org_id: string; state: string; revision: number; expires_at: string; roles: string[]; valid_to: string | null;
  target_user_id: string | null; approval_id: string | null; delivery_status: string;
}
const props = defineProps<ConsolePageProps & { organization: Organization; emailActions: boolean }>();
const emit = defineEmits<{ dirty: [value: boolean] }>();
const items = ref<Invitation[]>([]), cursor = ref<string | null>(null), loading = ref(false), writing = ref(false), error = ref(""), formError = ref(""), message = ref("");
const email = ref(""), roles = ref<string[]>([]), roleExpiry = ref(""), reason = ref(""), receipt = ref<Receipt>();
let generation = 0, controller = new AbortController(), alive = true;
const canManage = computed(() => props.context.capabilities.includes("account:platform-manage") || props.context.capabilities.includes("platform:govern") || props.organization.id === props.context.actor_org_id && props.context.capabilities.includes("account:manage"));
const roleOptions = computed(() => availablePeopleRoles(props.context, props.organization));
const sensitive = computed(() => roles.value.includes("platform_ops") || roles.value.includes("content_reviewer"));
const requiresExpiry = computed(() => roles.value.includes("content_reviewer"));
const expiryValid = computed(() => !requiresExpiry.value || Number.isFinite(Date.parse(roleExpiry.value)) && Date.parse(roleExpiry.value) > Date.now());
watch(requiresExpiry, value => { if (!value) roleExpiry.value = ""; });
const dirty = computed(() => !!email.value || roles.value.length > 0 || !!roleExpiry.value || !!reason.value);
const blocked = computed(() => props.locked || writing.value || !canManage.value);
watch(dirty, value => emit("dirty", value), { flush: "sync" });
async function load(next = false) {
  if (loading.value || props.locked || !canManage.value) return;
  loading.value = true; error.value = ""; const stamp = generation;
  try {
    const query = new URLSearchParams({ limit: "20" }); if (next && cursor.value) query.set("cursor", cursor.value);
    const result = await props.request<Page<Invitation>>(`/console/organizations/${props.organization.id}/invitations?${query}`, { signal: controller.signal });
    if (alive && stamp === generation) { items.value = next ? [...items.value, ...result.items] : result.items; cursor.value = result.next_cursor; }
  } catch (cause) { if (alive && stamp === generation && !(cause instanceof DOMException && cause.name === "AbortError")) error.value = cause instanceof Error ? cause.message : "邀请目录查询失败。"; }
  finally { if (alive && stamp === generation) loading.value = false; }
}
async function create() {
  if (blocked.value || !props.emailActions || !roles.value.length || !expiryValid.value) return;
  formError.value = ""; receipt.value = undefined;
  if (sensitive.value && !props.context.capabilities.includes("platform:govern")) { formError.value = "敏感职责需要平台治理与独立审批，不能通过普通邮箱邀请直接授予。"; return; }
  if (!window.confirm(`向 ${email.value.trim()} 发起 ${props.organization.name} 邀请，职责为 ${roles.value.map(consoleRoleLabel).join('、')}。新用户只能接受非敏感职责；已验证的受保护目标必须先经过独立审批。邮件受理不代表送达或加入。确定发起？`)) return;
  let validTo: string | null = null;
  if (requiresExpiry.value) { const value = Date.parse(roleExpiry.value); if (!Number.isFinite(value) || value <= Date.now()) { formError.value = "新增内容审核职责必须明确填写有效的未来截止时间。"; return; } validTo = new Date(value).toISOString(); }
  writing.value = true; const stamp = generation;
  try {
    const result = await props.write(`/console/organizations/${props.organization.id}/invitations`, { email: email.value.trim(), roles: [...roles.value], ...(requiresExpiry.value ? { valid_to: validTo } : {}), reason: reason.value.trim() });
    if (!alive || stamp !== generation || !result) return;
    receipt.value = result;
    if (result.status !== "applied" && !(result.status === "pending" && result.approval_id)) { formError.value = "邀请结果仍待确认，已保留草稿。请按管理台原请求编号只读查询，不要重新创建。"; return; }
    message.value = result.status === "pending" ? "邀请授权申请正在等待独立审批，尚未加入，也不代表邮件已送达。" : `邀请操作已登记。${result.delivery_status === "accepted" ? "邮件受理入队，非投递成功。" : "请核对真实投递状态。"}操作登记不代表已加入，以实际接受结果为准。`;
    email.value = ""; roles.value = []; roleExpiry.value = ""; reason.value = ""; await load();
  } catch (cause) { if (alive && stamp === generation) formError.value = cause instanceof Error ? cause.message : "邀请提交结果待确认。请使用管理台原请求编号查询，不要重新创建。"; }
  finally { if (alive && stamp === generation) writing.value = false; }
}
async function revoke(item: Invitation) {
  if (blocked.value || item.state !== "pending") return;
  if (!reason.value.trim()) { formError.value = "请先填写撤销原因。"; return; }
  if (!window.confirm(`确定撤销 ${props.organization.name} 的邀请 ${item.id}（修订 ${item.revision}）？此操作使邀请链接和待发邮件失效；已被邮件服务器接受的邮件不能追回。不会删除已存在成员或撤销已接受成员职责。`)) return;
  writing.value = true; formError.value = ""; const stamp = generation;
  try {
    const result = await props.write(`/console/invitations/${item.id}/revoke`, { expected_revision: item.revision, reason: reason.value.trim() });
    if (!alive || stamp !== generation || !result) return;
    receipt.value = result;
    if (result.status !== "applied" && !(result.status === "pending" && result.approval_id)) { formError.value = "撤销结果仍待确认，已保留原因。请沿原编号查询，不重复撤销。"; return; }
    message.value = result.status === "pending" ? "撤销操作等待审批，邀请尚未确认撤销。" : "撤销操作已登记，请核对邀请状态；不会自动重新发送。";
    reason.value = ""; await load();
  } catch (cause) { if (alive && stamp === generation) formError.value = cause instanceof Error ? cause.message : "撤销结果待确认。请用原编号查询，不重复撤销。"; }
  finally { if (alive && stamp === generation) writing.value = false; }
}
function prepareReissue(item: Invitation) {
  if (blocked.value || !["revoked", "expired"].includes(item.state)) return;
  if (!window.confirm(`重新发起 ${props.organization.name} 邀请将创建一份全新邀请和邮件凭证，不会恢复或重放旧邀请 ${item.id}。需要重新输入目标邮箱、原因并核验职责；${dirty.value ? '会替换当前未提交草稿。' : ''}确定准备新邀请？`)) return;
  email.value = ""; roles.value = [...item.roles]; roleExpiry.value = ""; reason.value = ""; receipt.value = undefined; message.value = "已准备全新邀请草稿。请重新输入目标邮箱并明确提交；不会自动重发旧链接。";
}
function discard() {
  if (props.locked || writing.value || !window.confirm("确定删除当前未提交邀请草稿？这只清除本地输入，不撤销任何服务端邀请或待确认原请求。")) return;
  email.value = ""; roles.value = []; roleExpiry.value = ""; reason.value = ""; formError.value = "";
}
async function beforeLeave() {
  if (writing.value && !window.confirm("邀请操作结果尚未确认；离开不撤销已提交写入。请保留管理台原编号查询。确定离开？")) return false;
  return !dirty.value || window.confirm("邀请草稿尚未提交，确定放弃本地输入？");
}
defineExpose({ beforeLeave });
watch([() => props.organization.id, () => props.context.actor_org_id], () => {
  generation++; controller.abort(); controller = new AbortController(); loading.value = false; writing.value = false; items.value = []; cursor.value = null; email.value = ""; roles.value = []; roleExpiry.value = ""; reason.value = ""; receipt.value = undefined; error.value = ""; message.value = ""; void load();
});
onMounted(() => { void load(); });
onBeforeUnmount(() => { alive = false; generation++; controller.abort(); emit("dirty", false); });
</script>
<template>
  <section class="invitations-panel">
    <PageHeader title="机构邮箱邀请" :description="`${organization.name} · 邀请不等于已经加入，敏感职责仍经独立审批。`" />
    <p v-if="!canManage" class="admin-error" role="alert">当前账号没有此组织邀请管理职责。</p>
    <p v-if="!emailActions" class="admin-alert">新邮件邀请尚未开放。已有邀请仍可只读核对或明确撤销，不会伪造投递或加入结果。</p>
    <p class="admin-alert">目标已是本组织成员（包括停用成员）时，应进入 <RouterLink :to="`/console/organizations/${organization.id}`">现有成员管理</RouterLink> 编辑，不能重复邀请来替换角色或独立授权。</p>
    <p v-if="error" class="admin-error" role="alert">{{ error }}</p><p v-if="formError" class="admin-error" role="alert">{{ formError }}</p><p v-if="message" class="admin-alert" role="status">{{ message }}</p>
    <p v-if="receipt" class="admin-alert">操作编号：{{ receipt.operation_id }} · {{ receipt.status === 'pending' ? receipt.approval_id ? '等待审批' : '结果待确认' : receipt.status === 'applied' ? '操作已登记' : receipt.status }}<span v-if="receipt.approval_id"> · 审批编号：{{ receipt.approval_id }}</span><span v-if="receipt.invitation_id"> · 邀请编号：{{ receipt.invitation_id }}</span><span v-if="receipt.delivery_status"> · 邮件状态：{{ receipt.delivery_status === 'accepted' ? '受理入队（非送达）' : receipt.delivery_status }}</span></p>
    <form class="admin-form" @submit.prevent="create"><fieldset :disabled="blocked"><label>目标邮箱<input v-model="email" type="email" maxlength="254" autocomplete="off" required /></label><fieldset><legend>邀请职责（接受者不可编辑）</legend><label v-for="role in roleOptions" :key="role" class="role-option"><input v-model="roles" type="checkbox" :value="role" />{{ consoleRoleLabel(role) }}</label></fieldset><p v-if="sensitive">敏感或受保护目标只能是已存在且已验证邮箱的确定用户，由平台治理申请后独立审批。未固定身份的新邮箱不能直接获得敏感职责。</p><label>新增内容审核职责截止时间（必须是未来时间）<input v-model="roleExpiry" type="datetime-local" :disabled="!requiresExpiry" :required="requiresExpiry" /></label><p v-if="!requiresExpiry">普通职责不接受此期限字段；实际权限仍按成员状态与当前授权实时核验。</p><p v-else-if="!expiryValid" role="status">内容审核职责必须明确填写有效的未来截止时间，未填写或已到期时不能提交。</p><label>发起 / 撤销原因<textarea v-model="reason" maxlength="512" required /></label><button type="submit" :disabled="!roles.length || !emailActions || !expiryValid">{{ writing ? '正在确认…' : '核对并发起全新邀请' }}</button><button type="button" @click="discard">删除未提交草稿</button></fieldset></form>
    <div class="admin-actions"><button type="button" :disabled="loading || locked" @click="load()">只读刷新邀请状态</button></div>
    <ResourceTable :headers="['邀请', '职责', '状态与期限', '邮件 / 审批', '操作']" :busy="loading" :empty="!items.length" empty-label="尚无可见邀请">
      <tr v-for="item in items" :key="item.id"><td><code>{{ item.id }}</code><p>修订 {{ item.revision }}</p></td><td>{{ item.roles.map(consoleRoleLabel).join('、') }}</td><td><StatusBadge :status="item.state" /><p>邀请有效至 {{ new Date(item.expires_at).toLocaleString() }}</p><p>职责有效至 {{ item.valid_to ? new Date(item.valid_to).toLocaleString() : '不限期（仍实时鉴权）' }}</p></td><td>{{ item.delivery_status === 'accepted' ? '受理入队（非送达）' : item.delivery_status }}<p v-if="item.approval_id">审批 {{ item.approval_id }}</p></td><td><button v-if="item.state === 'pending'" type="button" :disabled="blocked" @click="revoke(item)">确认撤销邀请</button><button v-if="['revoked', 'expired'].includes(item.state)" type="button" :disabled="blocked" @click="prepareReissue(item)">准备重新发起</button><span v-if="item.state === 'accepted'">已接受；成员职责需单独管理</span></td></tr>
    </ResourceTable>
    <button v-if="cursor" type="button" :disabled="loading || locked" @click="load(true)">加载更多邀请</button>
  </section>
</template>
<style scoped>
.invitations-panel{display:grid;gap:1rem}.admin-form>fieldset{display:grid;gap:1rem;border:0;padding:0;min-width:0}.admin-form label{display:grid;gap:.4rem}.admin-form fieldset fieldset{display:flex;flex-wrap:wrap;gap:1rem}.admin-form .role-option{display:flex;align-items:center;gap:.4rem}.role-option input{width:auto}input,textarea{max-width:100%;box-sizing:border-box}button{min-height:2.5rem}code{overflow-wrap:anywhere}
</style>
