<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ApiError, type BusinessRequest, type Identity } from '../session';
import type { AdminQuiz, AdminSubmission, AdminSubmissionSummary, AssessmentAudit, Candidate, Member, Page, Question, QuizSummary } from './types';
import ResourceTable from '../administration/components/ResourceTable.vue';
import StatusBadge from '../administration/components/StatusBadge.vue';
const props = defineProps<{ identity: Identity; request: BusinessRequest; recoveryScope?: string; consolePresentation?: boolean }>();
const emit = defineEmits<{ dirty: [value: boolean]; unknown: [value: boolean] }>();
const manage = props.identity.context!.capabilities.includes('assessment:manage'), review = props.identity.context!.capabilities.includes('assessment:review');
const quizzes = ref<QuizSummary[]>([]), candidates = ref<Candidate[]>([]), members = ref<Member[]>([]), submissions = ref<AdminSubmissionSummary[]>([]);
const quizCursor = ref<string | null>(null), candidateCursor = ref<string | null>(null), memberCursor = ref<string | null>(null), submissionCursor = ref<string | null>(null);
type QuizDraft = Pick<AdminQuiz, 'id' | 'title' | 'subject_id' | 'status' | 'revision' | 'opens_at' | 'closes_at' | 'release_at' | 'duration_seconds' | 'max_attempts' | 'created_by' | 'contributors' | 'audience_member_ids'> & { items: { question_version_id: string; max_score: string }[] };
const selected = ref<AdminQuiz>(), draft = ref<QuizDraft>(), preview = ref<Question>(), submission = ref<AdminSubmission>();
const original = ref(''), busy = ref(false), error = ref(''), message = ref(''), reason = ref(''), correction = ref(''), subject = ref('');
const life = new AbortController(); let alive = true, serial = 0;
type PendingWrite = { path: string; method: 'POST' | 'PATCH'; key: string; resource: string; kind: 'quiz' | 'regrade' };
const pending = ref<PendingWrite>(), storageBlocked = ref(false);
let pendingBody: unknown;
const storageKey = `assessment-admin-recovery:${props.identity.user.id}:${props.recoveryScope || props.identity.context?.org_id}`;
const locked = computed(() => !!pending.value || storageBlocked.value);
const submissionId = ref(''), submissionScope = ref('');
const audits = ref<AssessmentAudit[]>([]), auditCursor = ref<string | null>(null), auditResource = ref<{ type: string; id: string }>();
const dirty = computed(() => !!draft.value && JSON.stringify(draft.value) !== original.value);
const editable = computed(() => manage && !locked.value && !!draft.value && draft.value.status === 'draft' && (!draft.value.id || draft.value.created_by === props.identity.user.id));
const selfReview = computed(() => !!selected.value && (selected.value.created_by === props.identity.user.id || selected.value.contributors.includes(props.identity.user.id)));
const quizStatusLabels: Record<QuizSummary['status'], string> = { draft: '草稿', published: '已发布', closed: '已关闭', archived: '已归档' };
const gradingStatusLabels: Record<AdminSubmission['grading_status'], string> = { pending: '等待评分', running: '正在评分', needs_review: '待人工复核', completed: '评分完成', failed: '评分失败' };
const releaseStatusLabels: Record<AdminSubmission['release_status'], string> = { pending: '待发布', released: '已发布', withheld_access: '访问受限，暂不发布', withheld_embargo: '保密期内，暂不发布', regrading: '重批期间暂不发布' };
const questionTypeLabels: Record<Candidate['question_type'], string> = { single: '单选题', multiple: '多选题', numeric: '数值题' };
const verdictLabels: Record<'correct' | 'incorrect' | 'unanswered', string> = { correct: '正确', incorrect: '错误', unanswered: '未作答' };
function revealSubjectField(event: Event) {
  if (!props.consolePresentation) return;
  const details = (event.target as HTMLInputElement).closest('details');
  if (details) details.open = true;
}
watch(dirty, value => emit('dirty', value));
watch(locked, value => emit('unknown', value), { flush: 'sync' });
function fail(cause: unknown) { if (!alive) return; error.value = cause instanceof Error ? cause.message : '请求失败'; if (cause instanceof ApiError) { error.value += ` ${cause.code} ${cause.requestId}`; for (const [field, detail] of Object.entries(cause.fields)) error.value += ` ${field}: ${detail}`; if ([401, 403, 404].includes(cause.status) || ['CONTENT_UNAVAILABLE', 'QUESTION_EMBARGOED'].includes(cause.code)) { serial++; draft.value = undefined; selected.value = undefined; preview.value = undefined; submission.value = undefined; candidates.value = []; submissions.value = []; audits.value = []; } } }
function clearPending() {
  // Remove the durable marker before allowing another mutation.
  sessionStorage.removeItem(storageKey); pending.value = undefined; pendingBody = undefined;
}
async function mutate<T>(path: string, body: unknown, method: 'POST' | 'PATCH' = 'POST') {
  if (locked.value) throw new Error('原管理请求结果仍待确认，请使用原请求恢复。');
  const metadata: PendingWrite = { path, method, key: crypto.randomUUID(), resource: path.split('/')[2] || '', kind: path.startsWith('/submissions/') ? 'regrade' : 'quiz' };
  // No paper, answer, audience or reason is persisted. If storage fails, do not send.
  try { sessionStorage.setItem(storageKey, JSON.stringify(metadata)); }
  catch { throw new Error('无法保存安全恢复元数据，未发送管理请求；本地草稿保留，请恢复浏览器存储后重试。'); }
  pendingBody = structuredClone(body); pending.value = metadata;
  try {
    const value = await props.request<T>(path, { method, body: pendingBody, idempotencyKey: metadata.key, signal: life.signal });
    clearPending(); return value;
  } catch (cause) {
    if (cause instanceof ApiError && [400, 404, 409, 413, 422, 429].includes(cause.status) && !['IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_RESULT_INVALID', 'IDENTITY_CHANGED'].includes(cause.code)) clearPending();
    throw cause;
  }
}
function syncQuiz(value: QuizSummary) {
  const index = quizzes.value.findIndex(row => row.id === value.id);
  if (index < 0) quizzes.value.unshift(value); else quizzes.value[index] = value;
}
async function recoverWrite() {
  const request = pending.value; if (!request || pendingBody === undefined || busy.value) return;
  busy.value = true; error.value = ''; message.value = '';
  try {
    const receipt = await props.request<QuizSummary | { submission_id: string }>(request.path, { method: request.method, body: pendingBody, idempotencyKey: request.key, signal: life.signal });
    clearPending();
    if (!alive) return;
    message.value = '原请求已确认受理；以下重新查询当前资源状态。';
    if (request.kind === 'quiz' && 'id' in receipt) {
      syncQuiz(receipt);
      const value = await props.request<AdminQuiz>(`/admin/quizzes/${receipt.id}`, { signal: life.signal });
      if (alive) { selected.value = value; draft.value = structuredClone(value); original.value = JSON.stringify(value); }
    } else if ('submission_id' in receipt) await openSubmission(receipt.submission_id);
  } catch (cause) { fail(cause); } finally { if (alive) busy.value = false; }
}
async function inspectPending() {
  const request = pending.value; if (!request || busy.value) return;
  // Resource state alone cannot prove which request committed; never unlock here.
  if (!request.resource) { await loadQuizzes(); return; }
  if (request.kind === 'regrade') { await openSubmission(request.resource); return; }
  busy.value = true;
  try { const value = await props.request<AdminQuiz>(`/admin/quizzes/${request.resource}`, { signal: life.signal }); if (alive) { selected.value = value; if (!dirty.value) { draft.value = structuredClone(value); original.value = JSON.stringify(value); } } } catch (cause) { fail(cause); } finally { if (alive) busy.value = false; }
}
function mayLeave() { if (locked.value) { error.value = '请先恢复原管理请求；查询资源不会证明原请求失败。'; return false; } return !dirty.value || window.confirm('考试草稿未保存，确定放弃本地修改？'); }
async function loadQuizzes(next = false) { if (busy.value) return; busy.value = true; try { const q = new URLSearchParams({ limit: '20' }); if (next && quizCursor.value) q.set('cursor', quizCursor.value); const page = await props.request<Page<QuizSummary>>(`/admin/quizzes?${q}`, { signal: life.signal }); if (alive) { quizzes.value = next ? [...quizzes.value, ...page.items] : page.items; quizCursor.value = page.next_cursor; } } catch (cause) { fail(cause); } finally { if (alive) busy.value = false; } }
function newQuiz() { if (!mayLeave()) return; serial++; selected.value = undefined; draft.value = { id: '', title: '', subject_id: '', status: 'draft', revision: 0, opens_at: '', closes_at: '', release_at: '', duration_seconds: 600, max_attempts: 1, created_by: props.identity.user.id, contributors: [], items: [], audience_member_ids: [] }; original.value = ''; preview.value = undefined; reason.value = ''; }
async function openQuiz(id: string) { if (busy.value || ((!locked.value || dirty.value) && !mayLeave())) return; busy.value = true; const token = ++serial; preview.value = undefined; draft.value = undefined; try { const value = await props.request<AdminQuiz>(`/admin/quizzes/${id}`, { signal: life.signal }); if (alive && token === serial) { selected.value = value; draft.value = structuredClone(value); original.value = JSON.stringify(value); subject.value = value.subject_id; reason.value = ''; } } catch (cause) { fail(cause); } finally { if (alive) busy.value = false; } }
async function loadCandidates(next = false) { if (busy.value) return; busy.value = true; preview.value = undefined; try { const q = new URLSearchParams({ limit: '20' }); if (subject.value) q.set('subject_id', subject.value); if (next && candidateCursor.value) q.set('cursor', candidateCursor.value); const page = await props.request<Page<Candidate>>(`/admin/assessment-questions?${q}`, { signal: life.signal }); if (alive) { candidates.value = next ? [...candidates.value, ...page.items] : page.items; candidateCursor.value = page.next_cursor; } } catch (cause) { fail(cause); } finally { if (alive) busy.value = false; } }
async function showCandidate(id: string) { const token = ++serial; preview.value = undefined; try { const value = await props.request<Question>(`/admin/assessment-questions/${id}`, { signal: life.signal }); if (alive && token === serial) preview.value = value; } catch (cause) { fail(cause); } }
async function loadMembers(next = false) { if (busy.value || !manage) return; busy.value = true; try { const q = new URLSearchParams({ limit: '50' }); if (next && memberCursor.value) q.set('cursor', memberCursor.value); const page = await props.request<Page<Member>>(`/admin/assessment-members?${q}`, { signal: life.signal }); if (alive) { members.value = next ? [...members.value, ...page.items] : page.items; memberCursor.value = page.next_cursor; } } catch (cause) { fail(cause); } finally { if (alive) busy.value = false; } }
function addCandidate(row: Candidate) { if (!editable.value || !draft.value || draft.value.items!.length >= 50 || draft.value.items!.some(item => item.question_version_id === row.id)) return; if (draft.value.subject_id && draft.value.subject_id !== row.subject_id) { error.value = '题目学科必须一致。'; return; } draft.value.subject_id = row.subject_id; draft.value.items!.push({ question_version_id: row.id, max_score: '' }); }
function move(index: number, delta: number) { const rows = draft.value?.items; if (!rows || index + delta < 0 || index + delta >= rows.length) return; const row = rows.splice(index, 1)[0]; if (row) rows.splice(index + delta, 0, row); }
function localDate(value: string) { if (!value) return ''; const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
function setDate(field: 'opens_at' | 'closes_at' | 'release_at', event: Event) { if (draft.value) { const value = (event.target as HTMLInputElement).value; draft.value[field] = value ? new Date(value).toISOString() : ''; } }
async function save() {
  const row = draft.value; if (!row || !editable.value || busy.value) return;
  busy.value = true; error.value = ''; message.value = '';
  try {
    const body = { title: row.title, subject_id: row.subject_id, opens_at: row.opens_at, closes_at: row.closes_at, release_at: row.release_at, duration_seconds: row.duration_seconds, max_attempts: row.max_attempts, items: row.items!.map(item => ({ question_version_id: item.question_version_id, ...(item.max_score ? { max_score: item.max_score } : {}) })), audience_member_ids: [...row.audience_member_ids!], ...(row.id ? { expected_revision: row.revision } : {}) };
    const saved = await mutate<QuizSummary>(row.id ? `/quizzes/${row.id}` : '/quizzes', body, row.id ? 'PATCH' : 'POST');
    if (!alive) return;
    syncQuiz(saved);
    // The write receipt is safe metadata, not the complete editable paper.
    row.id = saved.id; row.revision = saved.revision; original.value = JSON.stringify(row);
    const value = await props.request<AdminQuiz>(`/admin/quizzes/${saved.id}`, { signal: life.signal });
    if (!alive) return;
    selected.value = value; draft.value = structuredClone(value); original.value = JSON.stringify(value);
    message.value = '草稿已保存，请由独立审核账号发布。';
  } catch (cause) { fail(cause); } finally { if (alive) busy.value = false; }
}
async function publish() {
  if (!selected.value || busy.value || locked.value || selfReview.value || dirty.value) return;
  busy.value = true; error.value = ''; message.value = '';
  try {
    const saved = await mutate<QuizSummary>(`/quizzes/${selected.value.id}/publish`, { expected_revision: selected.value.revision, reason: reason.value });
    if (!alive) return;
    syncQuiz(saved);
    const value = await props.request<AdminQuiz>(`/admin/quizzes/${saved.id}`, { signal: life.signal });
    if (alive) { selected.value = value; draft.value = structuredClone(value); original.value = JSON.stringify(value); message.value = '考试已发布，试卷与受众已冻结。'; }
  } catch (cause) { fail(cause); } finally { if (alive) busy.value = false; }
}
async function loadSubmissions(next = false) {
  if (busy.value || !review) return;
  const id = submissionId.value.trim(), scope = id ? `submission:${id}` : selected.value ? `quiz:${selected.value.id}` : '';
  if (!scope) { error.value = '请选择考试，或输入提交 ID（支持练习提交）。'; return; }
  if (next && scope !== submissionScope.value) { error.value = '查询范围已改变，请重新查询。'; return; }
  busy.value = true; submission.value = undefined;
  try {
    const q = new URLSearchParams({ limit: '20' }); q.set(id ? 'submission_id' : 'quiz_id', id || selected.value!.id);
    if (next && submissionCursor.value) q.set('cursor', submissionCursor.value);
    const page = await props.request<Page<AdminSubmissionSummary>>(`/admin/submissions?${q}`, { signal: life.signal });
    if (alive) { submissions.value = next ? [...submissions.value, ...page.items] : page.items; submissionCursor.value = page.next_cursor; submissionScope.value = scope; }
  } catch (cause) { fail(cause); } finally { if (alive) busy.value = false; }
}
async function openSubmission(id: string) { const token = ++serial; submission.value = undefined; try { const value = await props.request<AdminSubmission>(`/admin/submissions/${id}`, { signal: life.signal }); if (alive && token === serial) { const index = submissions.value.findIndex(row => row.id === value.id); if (index >= 0) { const { items: _items, grading_runs: _runs, ...summary } = value; submissions.value[index] = summary; } submission.value = value; correction.value = ''; reason.value = ''; } } catch (cause) { fail(cause); } }
async function regrade() { const row = submission.value; if (!row || busy.value || locked.value) return; busy.value = true; error.value = ''; message.value = ''; try { await mutate(`/submissions/${row.id}/regrades`, { expected_revision: row.revision, reason: reason.value, ...(correction.value ? { correction_source_version_id: correction.value } : {}) }); if (alive) { message.value = '重批已受理，旧成绩在复核期间隐藏。'; await openSubmission(row.id); } } catch (cause) { fail(cause); } finally { if (alive) busy.value = false; } }
async function loadAudit(type: string, id: string, next = false) {
  if (busy.value) return; busy.value = true;
  try { const q = new URLSearchParams({ resource_type: type, resource_id: id, limit: '20' }); if (next && auditCursor.value) q.set('cursor', auditCursor.value); const page = await props.request<Page<AssessmentAudit>>(`/admin/audit-events?${q}`, { signal: life.signal }); if (alive) { audits.value = next ? [...audits.value, ...page.items] : page.items; auditCursor.value = page.next_cursor; auditResource.value = { type, id }; } } catch (cause) { fail(cause); } finally { if (alive) busy.value = false; }
}
async function download(fileId: string) { const source = preview.value; if (!source) return; const token = serial; try { const blob = await props.request<Blob>(`/admin/assessment-questions/${source.id}/files/${fileId}/content`, { responseType: 'blob', signal: life.signal }); if (!alive || token !== serial) return; const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = fileId; a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (cause) { fail(cause); } }
onMounted(() => {
  try { const raw = sessionStorage.getItem(storageKey); if (raw) { const value = JSON.parse(raw) as PendingWrite; if (!value.key || !['POST', 'PATCH'].includes(value.method) || !['quiz', 'regrade'].includes(value.kind) || !/^\/(quizzes|submissions)(\/[^/]+)?(\/(publish|regrades))?$/.test(value.path)) throw new Error('恢复元数据无效'); pending.value = value; } }
  catch { storageBlocked.value = true; error.value = '无法读取安全恢复元数据，已禁止管理写入；请核实此前操作，不要清除存储后重复提交。'; }
  void loadQuizzes();
});
onBeforeUnmount(() => { alive = false; serial++; life.abort(); pendingBody = undefined; emit('dirty', false); emit('unknown', false); });
</script>
<template>
  <section class="stack content-section" :class="{ 'admin-card': consolePresentation }" aria-label="独立考试管理" :aria-busy="busy">
    <component :is="consolePresentation ? 'h2' : 'h3'">考试编排与独立审核</component>
    <p class="field-help">仅展示服务端授予的测评能力；内容管理权限不能替代考试授权。发布后题单与受众不可修改。</p>
    <p v-if="error" class="notice" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <div class="actions" :class="{ 'admin-toolbar': consolePresentation }">
      <button v-if="manage" class="button" :disabled="busy" @click="newQuiz">新建考试</button>
      <button class="button secondary" :disabled="busy" @click="loadQuizzes()">刷新考试列表</button>
    </div>
    <ResourceTable v-if="consolePresentation" :headers="['考试标题', '发布状态', '修订', '操作']" :busy="busy" :empty="!quizzes.length" empty-label="尚无考试。编排者可新建，审核者等待独立账号提交草稿。">
      <tr v-for="quiz in quizzes" :key="quiz.id">
        <td>{{ quiz.title }}</td><td><StatusBadge :status="quiz.status" :label="quizStatusLabels[quiz.status]" /></td><td>{{ quiz.revision }}</td>
        <td><button class="button secondary" :disabled="busy" @click="openQuiz(quiz.id)">查看考试</button></td>
      </tr>
    </ResourceTable>
    <template v-else>
      <ul class="content-list"><li v-for="quiz in quizzes" :key="quiz.id"><span>{{ quiz.title }} · {{ quiz.status }} · 修订 {{ quiz.revision }}</span><button class="button secondary" :disabled="busy" @click="openQuiz(quiz.id)">查看考试</button></li></ul>
      <p v-if="!quizzes.length && !busy" class="content-empty">尚无考试。编排者可新建，审核者等待独立账号提交草稿。</p>
    </template>
    <button v-if="quizCursor" class="button secondary" @click="loadQuizzes(true)">更多考试</button>
    <section v-if="locked" class="notice stack" aria-label="管理请求恢复"><h4>管理请求结果待确认</h4><template v-if="pending"><p>原请求 {{ pending.path }} · 编号 {{ pending.key }}。已冻结管理写入，不能换请求编号重复提交。</p><p v-if="pendingBody === undefined">页面刷新后只保留原编号，不保存题面、答案或原请求正文。<template v-if="recoveryScope">请使用平台控制台上方“按原key查询真实幂等结果”；确认后重新读取资源。</template><template v-else>当前普通管理接口不支持按原幂等编号查询结果。请保留原编号，由管理员核实服务端幂等记录，不要清除存储后重复提交。</template>资源存在、修订变化或查询无结果均不能证明原请求受理与否，因此保持冻结。</p><div class="actions"><button v-if="pendingBody !== undefined" class="button" :disabled="busy" @click="recoverWrite">以原编号和原正文恢复请求</button><button class="button secondary" :disabled="busy" @click="inspectPending">查询相关资源（保持未知）</button></div></template></section>
    <p v-if="pending && pendingBody !== undefined" class="field-help">请保留当前页面，以原编号和原正文重试确认结果；刷新会丢失原正文，届时只能受控对账，不能自动解除未知状态。</p>
    <button v-if="selected" class="button secondary" :disabled="busy" @click="loadAudit('quiz', selected.id)">查询当前考试审计</button>
    <form v-if="draft" class="stack content-section" :class="{ 'admin-card': consolePresentation }" @submit.prevent="save">
      <h3>{{ draft.id ? '考试详情' : '新建考试' }}</h3>
      <fieldset class="content-fields stack" :disabled="!editable || busy">
        <div class="field"><label for="quiz-title">考试标题</label><input id="quiz-title" v-model="draft.title" required maxlength="200" /></div>
        <p v-if="consolePresentation" class="field-help">从下方候选题加入试卷，学科 ID 会自动带入；同一考试的题目须属于同一学科。</p>
        <component :is="consolePresentation ? 'details' : 'div'" :class="consolePresentation ? 'stack' : 'field'">
          <summary v-if="consolePresentation">高级定位</summary>
          <label for="quiz-subject">学科 ID（选择题目时自动填入）</label><input id="quiz-subject" v-model="draft.subject_id" required @invalid="revealSubjectField" />
        </component>
        <div class="content-columns">
          <div v-for="field in (['opens_at','closes_at','release_at'] as const)" :key="field" class="field"><label :for="`quiz-${field}`">{{ field === 'opens_at' ? '开放时间' : field === 'closes_at' ? '关闭时间' : '成绩发布时间' }}</label><input :id="`quiz-${field}`" type="datetime-local" :value="localDate(draft[field])" required @input="setDate(field, $event)" /></div>
          <div class="field"><label for="quiz-duration">时长（秒）</label><input id="quiz-duration" v-model.number="draft.duration_seconds" type="number" min="60" max="7200" required /></div>
          <div class="field"><label for="quiz-attempts">最多参加次数</label><input id="quiz-attempts" v-model.number="draft.max_attempts" type="number" min="1" max="3" required /></div>
        </div>
        <fieldset class="content-fields"><legend>有序题单 · {{ draft.items?.length || 0 }}/50</legend><ul class="content-list"><li v-for="(row,index) in draft.items" :key="row.question_version_id"><span>{{ index + 1 }}. {{ row.question_version_id }}</span><div class="field"><label :for="`score-${index}`">满分（留空用题目满分）</label><input :id="`score-${index}`" v-model="row.max_score" inputmode="decimal" /></div><div class="actions"><button type="button" class="text-button" :disabled="index === 0" @click="move(index,-1)">上移</button><button type="button" class="text-button" :disabled="index === draft.items!.length - 1" @click="move(index,1)">下移</button><button type="button" class="text-button" @click="draft.items!.splice(index,1)">移除</button></div></li></ul></fieldset>
        <fieldset class="content-fields"><legend>显式受众 · {{ draft.audience_member_ids?.length || 0 }}/200</legend><p class="field-help">已选成员 ID：{{ draft.audience_member_ids?.join('、') || '未选择' }}</p><button type="button" class="button secondary" @click="loadMembers()">读取可参加成员</button><label v-for="member in members" :key="member.id" class="check-label"><input v-model="draft.audience_member_ids" type="checkbox" :value="member.id" />{{ member.display_name }}</label><button v-if="memberCursor" type="button" class="text-button" @click="loadMembers(true)">更多成员</button></fieldset>
      </fieldset>
      <button v-if="editable" class="button" :disabled="busy || !dirty">保存考试草稿</button>
      <p v-if="selfReview" class="field-help">作者或贡献者不能审核发布自己的考试。</p>
      <div v-if="review && selected?.status === 'draft' && !selfReview" class="stack"><div class="field"><label for="publish-reason">发布审核原因</label><input id="publish-reason" v-model="reason" :disabled="busy || locked" /></div><button type="button" class="button" :disabled="busy || locked || dirty || !reason.trim()" @click="publish">审核并发布考试</button></div>
    </form>
    <section class="stack content-section" :class="{ 'admin-card': consolePresentation }" aria-label="独立题目候选">
      <component :is="consolePresentation ? 'h2' : 'h3'">合法题目候选与勘误依据</component>
      <div class="content-toolbar" :class="{ 'admin-toolbar': consolePresentation }">
        <component :is="consolePresentation ? 'details' : 'div'" :class="consolePresentation ? 'stack' : 'field'">
          <summary v-if="consolePresentation">高级定位</summary>
          <label for="candidate-subject">按学科 ID 筛选（可留空）</label><input id="candidate-subject" v-model="subject" />
        </component>
        <button class="button secondary" :disabled="busy" @click="loadCandidates()">查询候选题</button>
      </div>
      <p v-if="consolePresentation && subject" class="field-help">当前按学科 ID 筛选；可在“高级定位”中查看、更改或清空。</p>
      <ResourceTable v-if="consolePresentation" :headers="['题目标题', '难度', '题型', '操作']" :busy="busy" :empty="!candidates.length" empty-label="暂无候选题，请查询合法题目候选；如已设置学科筛选，可在高级定位中调整。">
        <tr v-for="row in candidates" :key="row.id">
          <td>{{ row.title }}</td><td>{{ row.difficulty }}</td><td>{{ questionTypeLabels[row.question_type] }}</td>
          <td><div class="actions"><button class="button secondary" @click="showCandidate(row.id)">预览题目</button><button v-if="editable" class="button secondary" @click="addCandidate(row)">加入试卷</button><button v-if="review && submission && !locked" class="button secondary" @click="correction = row.id">选择勘误版本</button></div></td>
        </tr>
      </ResourceTable>
      <ul v-else class="content-list"><li v-for="row in candidates" :key="row.id"><span>{{ row.title }} · {{ row.difficulty }} · {{ row.question_type }}</span><div class="actions"><button class="button secondary" @click="showCandidate(row.id)">预览题目</button><button v-if="editable" class="button secondary" @click="addCandidate(row)">加入试卷</button><button v-if="review && submission && !locked" class="button secondary" @click="correction = row.id">选择勘误版本</button></div></li></ul>
      <button v-if="candidateCursor" class="button secondary" @click="loadCandidates(true)">更多候选题</button>
      <article v-if="preview" class="stack content-section"><h4>{{ preview.title }}</h4><p class="reading-body">{{ preview.prompt }}</p><p v-for="option in preview.options" :key="option.id">{{ option.id }} · {{ option.text }}</p><p>标准答案：{{ preview.answer }}</p><p class="reading-body">{{ preview.explanation }}</p><button v-for="file in preview.resource_ids" :key="file" class="button secondary" @click="download(file)">下载审核附件 {{ file }}</button></article>
    </section>
    <section v-if="review" class="stack content-section" :class="{ 'admin-card': consolePresentation }" aria-label="提交复核">
      <component :is="consolePresentation ? 'h2' : 'h3'">提交复核与重批</component>
      <p class="field-help">{{ selected ? `当前考试 ${selected.title}` : '请先选择考试，或按提交 ID 定位练习及考试提交' }}。指定提交 ID 时优先按该 ID 查询。重批不修改原试卷满分，不由客户端计算成绩。</p>
      <component :is="consolePresentation ? 'details' : 'div'" :class="consolePresentation ? 'stack' : 'field'">
        <summary v-if="consolePresentation">高级定位</summary>
        <label for="submission-id">提交 ID（含练习，可留空查询当前考试）</label><input id="submission-id" v-model="submissionId" :disabled="busy" />
      </component>
      <p v-if="consolePresentation && submissionId.trim()" class="field-help">当前优先按提交 ID 定位；清空高级定位后可查询当前考试。</p>
      <button class="button secondary" :disabled="busy || (!selected && !submissionId.trim())" @click="loadSubmissions()">查询提交记录</button>
      <ResourceTable v-if="consolePresentation" :headers="['提交 ID', '评分任务状态', '操作']" :busy="busy" :empty="!submissions.length" empty-label="暂无提交记录，请选择考试查询，或在高级定位中输入提交 ID。">
        <tr v-for="row in submissions" :key="row.id">
          <td>{{ row.id }}</td><td><StatusBadge :status="row.grading_status" :label="gradingStatusLabels[row.grading_status]" /></td>
          <td><button class="button secondary" :disabled="busy" @click="openSubmission(row.id)">复核提交</button></td>
        </tr>
      </ResourceTable>
      <ul v-else class="content-list"><li v-for="row in submissions" :key="row.id"><span>{{ row.id }} · {{ row.grading_status }}</span><button class="button secondary" :disabled="busy" @click="openSubmission(row.id)">复核提交</button></li></ul>
      <button v-if="submissionCursor" class="button secondary" :disabled="busy" @click="loadSubmissions(true)">更多提交</button>
      <form v-if="submission" class="stack" @submit.prevent="regrade">
        <div v-if="consolePresentation" class="stack">
          <p>提交 {{ submission.id }} · 修订 {{ submission.revision }}</p>
          <p>评分任务：<StatusBadge :status="submission.grading_status" :label="gradingStatusLabels[submission.grading_status]" /> · 成绩发布：<StatusBadge :status="submission.release_status" :label="releaseStatusLabels[submission.release_status]" /></p>
        </div>
        <p v-else>提交 {{ submission.id }} · 修订 {{ submission.revision }} · {{ submission.grading_status }} · {{ submission.release_status }}</p>
        <p v-if="submission.release_status === 'released'">分数 {{ submission.total_score }} / {{ submission.max_score }}</p><p v-if="submission.error_code">{{ submission.error_code }}</p>
        <h4>当前评分逐题证据</h4><p v-if="!submission.items" :class="{ 'admin-empty': consolePresentation }">当前评分证据未就绪或不可披露，请查询评分状态和审计。</p>
        <article v-for="item in submission.items" :key="item.id" class="stack content-section"><h5>{{ item.title }}</h5><p>题项 {{ item.id }} · 原题 {{ item.question_id }} · 原版本 {{ item.question_version_id }}</p><p>学生答案：{{ item.student_answer === null ? '未作答' : JSON.stringify(item.student_answer) }}</p><p>标准答案：{{ item.standard_answer }}</p><p class="reading-body">解析：{{ item.explanation }}</p><p>{{ consolePresentation ? verdictLabels[item.verdict] : item.verdict }} · {{ item.score }} / {{ item.max_score }}</p><p v-if="item.correction_source_version_id">勘误依据版本：{{ item.correction_source_version_id }}</p></article>
        <h4>评分历史（最近 50 次）</h4>
        <ResourceTable v-if="consolePresentation" :headers="['评分修订', '任务状态', '运行 ID', '原因', '发起人', '评分代码', '完成时间', '错误', '操作']" :busy="busy" :empty="!submission.grading_runs.length" empty-label="当前提交暂无评分历史。">
          <tr v-for="run in submission.grading_runs" :key="run.id">
            <td>{{ run.revision }}</td><td><StatusBadge :status="run.status" :label="gradingStatusLabels[run.status]" /></td><td>{{ run.id }}</td><td>{{ run.reason }}</td><td>{{ run.requested_by }}</td><td>{{ run.scoring_code_version }}</td><td>{{ run.completed_at || '未完成' }}</td><td>{{ run.error_code || '无' }}</td>
            <td><button type="button" class="button secondary" :disabled="busy" @click="loadAudit('grading_run', run.id)">查询评分运行审计</button></td>
          </tr>
        </ResourceTable>
        <ul v-else class="content-list"><li v-for="run in submission.grading_runs" :key="run.id"><div class="stack"><p>评分修订 {{ run.revision }} · {{ run.status }} · {{ run.id }}</p><p>原因：{{ run.reason }} · 发起人：{{ run.requested_by }}</p><p>评分代码：{{ run.scoring_code_version }} · 完成时间：{{ run.completed_at || '未完成' }} · 错误：{{ run.error_code || '无' }}</p><button type="button" class="button secondary" :disabled="busy" @click="loadAudit('grading_run', run.id)">查询评分运行审计</button></div></li></ul>
        <fieldset class="stack content-fields" :disabled="busy || locked">
          <legend>受审计重批</legend>
          <div class="field"><label for="regrade-reason">重批原因</label><input id="regrade-reason" v-model="reason" required /></div>
          <p v-if="consolePresentation" class="field-help">{{ correction ? `已选勘误依据版本：${correction}` : '未选勘误版本，将按原标准重批。可从候选题选择勘误依据，或使用高级定位。' }}</p>
          <component :is="consolePresentation ? 'details' : 'div'" :class="consolePresentation ? 'stack' : 'field'">
            <summary v-if="consolePresentation">高级定位</summary>
            <label for="correction-version">勘误来源版本（可从候选列表选择；留空按原标准重批）</label><input id="correction-version" v-model="correction" />
          </component>
          <button class="button" :disabled="!reason.trim() || ['pending','running'].includes(submission.grading_status)">发起受审计重批</button>
        </fieldset>
        <div class="actions"><button type="button" class="button secondary" :disabled="busy" @click="openSubmission(submission.id)">刷新复核状态</button><button type="button" class="button secondary" :disabled="busy" @click="loadAudit('submission', submission.id)">查询提交审计</button><button type="button" class="button secondary" :disabled="busy" @click="loadAudit('session', submission.session_id)">查询会话审计</button></div>
      </form>
    </section>
    <section v-if="auditResource" class="stack content-section" :class="{ 'admin-card': consolePresentation }" aria-label="测评审计"><component :is="consolePresentation ? 'h2' : 'h3'">审计 · {{ auditResource.type }} · {{ auditResource.id }}</component><p v-if="!audits.length" :class="{ 'admin-empty': consolePresentation }">当前资源暂无审计记录。</p><ul class="content-list"><li v-for="event in audits" :key="event.id"><div><p>{{ event.created_at }} · {{ event.action }} · 操作人 {{ event.actor_id }}</p><p>原因：{{ event.reason }}</p><p>修订 {{ event.revision_before ?? '—' }} → {{ event.revision_after ?? '—' }} · 请求 {{ event.request_id }}</p></div></li></ul><button v-if="auditCursor" class="button secondary" :disabled="busy" @click="loadAudit(auditResource.type, auditResource.id, true)">更多审计记录</button></section>
  </section>
</template>
