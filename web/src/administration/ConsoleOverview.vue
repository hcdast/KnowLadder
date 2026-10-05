<script setup lang="ts">
import BrandIcon from '../components/BrandIcon.vue';
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import type { BusinessRequest } from "../session";
import type { Approval, Audit, ConsoleContext, Page } from "./types";
import { consoleActionLabel, consoleBusinessModules, consoleCapabilityLabel, consoleDateLabel, consoleRoleLabel, consoleScopeLabel } from "./presentation";
import PageHeader from "./components/PageHeader.vue";
import ResourceTable from "./components/ResourceTable.vue";
import StatusBadge from "./components/StatusBadge.vue";
const props = defineProps<{ context: ConsoleContext; request: BusinessRequest }>();
const approvals = ref<Approval[]>([]), operations = ref<Audit[]>([]);
const approvalCursor = ref<string | null>(null), operationCursor = ref<string | null>(null);
const approvalBusy = ref(false), operationBusy = ref(false), approvalError = ref(""), operationError = ref("");
const canApprovals = computed(() => props.context.menus.includes("approvals"));
const canOperations = computed(() => props.context.menus.includes("audit"));
const business = computed(() => consoleBusinessModules(props.context));
const businessLabels = { content: "教材题库", assessment: "考试管理", reports: "报告管理", safety: "安全处置" };
const life = new AbortController(); let alive = true;
async function loadApprovals(next = false) {
  if (!canApprovals.value || approvalBusy.value) return;
  approvalBusy.value = true; approvalError.value = "";
  try { const q = new URLSearchParams({ status: "pending", limit: "10" }); if (next && approvalCursor.value) q.set("cursor", approvalCursor.value);
    const page = await props.request<Page<Approval>>(`/console/approvals?${q}`, { signal: life.signal }); if (alive) { approvals.value = page.items; approvalCursor.value = page.next_cursor; }
  } catch (cause) { if (alive && !life.signal.aborted) approvalError.value = cause instanceof Error ? cause.message : "待审批记录读取失败"; }
  finally { if (alive) approvalBusy.value = false; }
}
async function loadOperations(next = false) {
  if (!canOperations.value || operationBusy.value) return;
  operationBusy.value = true; operationError.value = "";
  try { const q = new URLSearchParams({ limit: "10" }); if (next && operationCursor.value) q.set("cursor", operationCursor.value);
    const page = await props.request<Page<Audit>>(`/console/audit?${q}`, { signal: life.signal }); if (alive) { operations.value = page.items; operationCursor.value = page.next_cursor; }
  } catch (cause) { if (alive && !life.signal.aborted) operationError.value = cause instanceof Error ? cause.message : "可见操作读取失败"; }
  finally { if (alive) operationBusy.value = false; }
}
function refresh() { void loadApprovals(); void loadOperations(); }
onMounted(refresh); onBeforeUnmount(() => { alive = false; life.abort(); });
</script>
<template>
  <section class="admin-page">
    <PageHeader title="工作台" description="当前管理身份可见的任务与操作。列表按服务端游标分页，不推算全库统计或时间排序。"><template #actions><button class="button secondary" :disabled="approvalBusy || operationBusy" @click="refresh">更新任务</button></template></PageHeader>
    <section class="admin-welcome" aria-label="知阶管理工作台介绍">
      <div><p class="eyebrow">KNOWLADDER / 知阶</p><h2>让每一步学习，都有支持。</h2><p>连接教学资源与组织协作，从今天的待办开始。</p></div>
      <div class="admin-welcome-steps" aria-hidden="true"><span><BrandIcon name="book-open" /></span><span><BrandIcon name="graduation-cap" /></span><span><BrandIcon name="chart-no-axes-combined" /></span></div>
    </section>
    <div class="admin-overview-grid">
      <div class="admin-overview-primary">
        <section v-if="canApprovals" class="admin-card"><div class="admin-section-header"><h2>待审批任务</h2><RouterLink to="/console/approvals">进入审批中心</RouterLink></div>
          <div v-if="approvalError" class="notice" role="alert">{{ approvalError }} <button class="text-button" @click="loadApprovals()">重试读取</button></div>
          <ResourceTable v-else :headers="['申请动作', '目标', '申请时间', '操作']" :busy="approvalBusy" :empty="!approvals.length" empty-label="暂无待处理申请"><tr v-for="approval in approvals" :key="approval.id"><td>{{ consoleActionLabel(approval.action) }}<div><StatusBadge :status="approval.status" /></div></td><td class="admin-resource-id">{{ approval.target_user_id || approval.target_member_id || '申请中登记的目标' }}</td><td>{{ consoleDateLabel(approval.created_at) }}</td><td><RouterLink :to="`/console/approvals/${approval.id}`">查看申请</RouterLink></td></tr></ResourceTable>
          <div class="admin-pagination"><button class="button secondary" :disabled="approvalBusy" @click="loadApprovals()">返回首批</button><button class="button secondary" :disabled="approvalBusy || !approvalCursor" @click="loadApprovals(true)">下一批</button></div>
        </section>
        <section v-if="canOperations" class="admin-card"><div class="admin-section-header"><h2>可见操作记录</h2><RouterLink to="/console/audit">查看操作审计</RouterLink></div><p class="admin-meta">当前权限可见的审计记录；不是全库数量或最新时间排行。</p>
          <div v-if="operationError" class="notice" role="alert">{{ operationError }} <button class="text-button" @click="loadOperations()">重试读取</button></div>
          <ResourceTable v-else :headers="['动作', '目标', '记录时间', '关联']" :busy="operationBusy" :empty="!operations.length" empty-label="暂无可见操作记录"><tr v-for="operation in operations" :key="operation.id"><td>{{ consoleActionLabel(operation.action) }}</td><td class="admin-resource-id">{{ operation.resource_id || operation.target_org_id || '未提供目标标识' }}</td><td>{{ consoleDateLabel(operation.created_at) }}</td><td><RouterLink :to="`/console/audit/${operation.id}`">查看记录</RouterLink></td></tr></ResourceTable>
          <div class="admin-pagination"><button class="button secondary" :disabled="operationBusy" @click="loadOperations()">返回首批</button><button class="button secondary" :disabled="operationBusy || !operationCursor" @click="loadOperations(true)">下一批</button></div>
        </section>
        <section class="admin-card"><h2>常用任务</h2><div class="admin-shortcuts"><RouterLink v-if="context.menus.includes('users')" to="/console/users/new">新建用户</RouterLink><RouterLink v-if="context.menus.includes('organizations')" to="/console/organizations">查看组织与成员</RouterLink><RouterLink v-if="context.menus.includes('authorizations')" to="/console/authorizations/new">授予精确授权</RouterLink><RouterLink v-for="module in business" :key="module" :to="`/console/business/${module}`">{{ businessLabels[module] }}</RouterLink></div><p v-if="!canApprovals && !canOperations" class="admin-meta">当前职责不包含治理任务或操作登记读取，未请求这些数据。请从有权的业务入口开始。</p></section>
      </div>
      <aside class="admin-card admin-responsibilities" aria-label="本人管理职责"><h2>本人管理职责</h2><p v-if="context.capabilities.includes('platform:govern') && !context.menus.includes('users')" class="admin-meta">管理治理授权，不具备用户目录职责。受保护人员须从明确目标进入申请，不可给自己补齐账号管理权。</p><p>{{ context.roles.map(consoleRoleLabel).join('、') || '无基础角色' }}</p><ul class="admin-capability-list"><li v-for="capability in context.capabilities" :key="capability">{{ consoleCapabilityLabel(capability) }}</li></ul><details><summary>授权范围与身份诊断</summary><div class="stack"><p class="admin-meta">管理组织 {{ context.actor_org_id }} · 成员 {{ context.actor_member_id }} · 数据库 {{ context.database_mode }}</p><div v-for="grant in context.grants" :key="grant.id"><strong>{{ consoleCapabilityLabel(grant.capability) }}</strong><p class="admin-meta">{{ consoleScopeLabel(grant.scope.kind) }}{{ grant.scope.organization_ids.length ? '：' + grant.scope.organization_ids.join('、') : '' }}<br>{{ consoleDateLabel(grant.valid_from) }} → {{ grant.valid_to ? consoleDateLabel(grant.valid_to) : '无自动到期' }}</p></div><p class="admin-meta">治理能力不包含教材、答案或报告读取；每项业务独立匹配授权范围。</p></div></details></aside>
    </div>
  </section>
</template>
