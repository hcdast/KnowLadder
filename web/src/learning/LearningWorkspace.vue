<script setup lang="ts">
import BrandIcon from '../components/BrandIcon.vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ApiError, type BusinessRequest, type Identity } from '../session';
import AssessmentSession from '../assessment/AssessmentSession.vue';
import type { Answer, Editions, Mastery, Mistake, Mistakes, PracticeOptions, Quizzes, Recommendation, Recommendations, Recovery, Reports, Session, Submission } from './types';
const props = defineProps<{ identity: Identity; request: BusinessRequest }>();
const emit = defineEmits<{ dirty: [value: boolean]; unknown: [value: boolean]; read: [target: { editionId: string; chapterId: string }] }>();
const caps = props.identity.context?.capabilities || [];
const allowed = caps.includes('learning:self') && !caps.some(c => ['content:edit', 'content:review', 'assessment:manage', 'assessment:review'].includes(c));
const mistakeHeading = ref<HTMLElement>();
const mode = ref<'mastery' | 'mistakes' | 'recommendations'>('mastery');
const period = ref<'mastery' | '7d' | '30d'>('mastery'), status = ref<'active' | 'resolved' | 'all'>('active');
const subject = ref(''), subjectInput = ref(''), edition = ref(''), options = ref<PracticeOptions>();
const books = ref<Editions['items']>([]), quizzes = ref<Quizzes['items']>([]);
const bookCursor = ref<string | null>(null), quizCursor = ref<string | null>(null);
const mastery = ref<Mastery>(), reports = ref<Reports>(), mistakes = ref<Mistakes>(), detail = ref<Mistake>(), recommendations = ref<Recommendations>();
const selectedSession = ref(''), childDirty = ref(false), childUnknown = ref(false);
const busy = ref(false), catalogueBusy = ref(false), writeBusy = ref(false), error = ref(''), notice = ref(''), denied = ref(false);
const pending = ref<Recovery>(), storageBlocked = ref(false), cooldown = ref(0);
const storageKey = `learning-recovery:${props.identity.user.id}:${props.identity.context?.org_id}`;
const life = new AbortController(); let alive = true, serial = 0, timer = 0;
let readController = new AbortController();
const objectUrls = new Set<string>(), downloadTimers = new Set<number>(), unavailablePractice = ref<string[]>([]);
const unknown = computed(() => !!pending.value || storageBlocked.value || childUnknown.value);
const locked = computed(() => busy.value || catalogueBusy.value || writeBusy.value || unknown.value || cooldown.value > 0 || denied.value);
const subjects = computed(() => [...new Set([...quizzes.value.map(q => q.subject_id), ...(options.value ? [options.value.subject_id] : []), ...(subject.value ? [subject.value] : [])])]);
function subjectLabel(id: string) {
  if (id === options.value?.subject_id && options.value.subject_name) return options.value.subject_name;
  if (id === options.value?.subject_id) return `教材「${books.value.find(book => book.id === edition.value)?.title || '当前教材'}」的学科`;
  const quiz = quizzes.value.find(row => row.subject_id === id);
  return quiz ? `考试「${quiz.title}」的学科` : '已知学科';
}
const current = computed(() => mode.value === 'recommendations' ? recommendations.value : mode.value === 'mistakes' ? mistakes.value : period.value === 'mastery' ? mastery.value : reports.value);
const ready = computed(() => current.value && readyStatus(current.value.status));
const rows = computed(() => period.value === 'mastery' ? mastery.value?.items || [] : reports.value?.mastery || []);
watch(childDirty, value => emit('dirty', value), { flush: 'sync' });
watch(unknown, value => emit('unknown', value), { flush: 'sync' });
function clearViews() { mastery.value = undefined; reports.value = undefined; mistakes.value = undefined; detail.value = undefined; recommendations.value = undefined; }
function remember(value?: Recovery) {
  try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey); }
  catch { storageBlocked.value = true; throw new Error('安全恢复存储不可用。请恢复存储后重试原请求，不要清除存储或重新创建。'); }
  storageBlocked.value = false; pending.value = value;
}
function fail(cause: unknown) {
  if (!alive) return;
  error.value = cause instanceof Error ? cause.message : '请求未完成，请重试。';
  if (!(cause instanceof ApiError)) return;
  error.value += ` ${cause.code} ${cause.requestId}`;
  if (cause.status === 429) {
    const seconds = Number(cause.retryAfter), date = Date.parse(cause.retryAfter);
    const until = Number.isFinite(seconds) && cause.retryAfter.trim() ? Date.now() + Math.max(0, seconds) * 1000 : Number.isFinite(date) ? date : Date.now() + 60000;
    window.clearInterval(timer); cooldown.value = Math.max(1, Math.ceil((until - Date.now()) / 1000));
    timer = window.setInterval(() => { cooldown.value = Math.max(0, Math.ceil((until - Date.now()) / 1000)); if (!cooldown.value) window.clearInterval(timer); }, 1000);
  }
  if ([401, 403, 404].includes(cause.status)) {
    serial++; readController.abort(); life.abort(); denied.value = true; clearViews(); books.value = []; quizzes.value = []; options.value = undefined; subject.value = ''; subjectInput.value = ''; edition.value = ''; selectedSession.value = ''; childDirty.value = false; childUnknown.value = false;
    window.clearInterval(timer); for (const id of downloadTimers) window.clearTimeout(id); for (const url of objectUrls) URL.revokeObjectURL(url); objectUrls.clear();
  }
}
function canLeave() { if (unknown.value) { error.value = '请先使用原请求编号确认创建或作答结果。'; return false; } return !childDirty.value || window.confirm('存在未保存作答，确定放弃并返回学情？'); }
async function navigate(value: typeof mode.value) {
  if (writeBusy.value || !canLeave()) return;
  const trigger = document.activeElement instanceof HTMLButtonElement ? document.activeElement : undefined;
  selectedSession.value = ''; childDirty.value = false; childUnknown.value = false; mode.value = value; clearViews(); await load();
  await nextTick();
  if (alive && !denied.value && mode.value === value && trigger?.isConnected && !trigger.disabled && document.activeElement === document.body) trigger.focus();
}
async function catalogue(next: 'books' | 'quizzes' | null = null) {
  if (!allowed || denied.value || catalogueBusy.value || cooldown.value) return;
  catalogueBusy.value = true; error.value = '';
  try {
    if (next !== 'quizzes') { const q = new URLSearchParams({ limit: '50' }); if (next === 'books' && bookCursor.value) q.set('cursor', bookCursor.value); const page = await props.request<Editions>(`/textbook-editions?${q}`, { signal: life.signal }); if (!alive || denied.value) return; books.value = next ? [...books.value, ...page.items] : page.items; bookCursor.value = page.next_cursor; }
    if (next !== 'books') { const q = new URLSearchParams({ limit: '50' }); if (next === 'quizzes' && quizCursor.value) q.set('cursor', quizCursor.value); const page = await props.request<Quizzes>(`/quizzes?${q}`, { signal: life.signal }); if (!alive || denied.value) return; quizzes.value = next ? [...quizzes.value, ...page.items] : page.items; quizCursor.value = page.next_cursor; }
  } catch (cause) { fail(cause); } finally { if (alive) catalogueBusy.value = false; }
}
async function chooseEdition() {
  clearViews(); options.value = undefined;
  if (!edition.value) { await load(); return; }
  const token = ++serial; busy.value = true; error.value = '';
  try { const value = await props.request<PracticeOptions>(`/practice-options?${new URLSearchParams({ textbook_edition_id: edition.value })}`, { signal: life.signal }); if (!alive || token !== serial) return; options.value = value; subject.value = value.subject_id; }
  catch (cause) { if (token === serial) fail(cause); }
  finally { if (alive && token === serial) busy.value = false; }
  if (alive && token === serial && options.value) await load();
}
async function choosePeriod(value: 'mastery' | '7d' | '30d', event: Event) {
  const trigger = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : undefined;
  period.value = value; await load(); await nextTick();
  if (alive && !denied.value && mode.value === 'mastery' && period.value === value && trigger?.isConnected && !trigger.disabled && document.activeElement === document.body) trigger.focus();
}
async function chooseSubject() { if (options.value?.subject_id !== subject.value) { edition.value = ''; options.value = undefined; } await load(); }
async function load(next = false, retry = true) {
  if (!allowed || denied.value || cooldown.value || writeBusy.value) return;
  readController.abort(); readController = new AbortController(); const token = ++serial;
  const old = current.value; if (!next) clearViews(); else detail.value = undefined;
  if (!next) unavailablePractice.value = [];
  if (mode.value === 'recommendations' ? !edition.value : !subject.value) { busy.value = false; return; }
  busy.value = true; error.value = '';
  try {
    const q = new URLSearchParams();
    if (mode.value === 'recommendations') q.set('textbook_edition_id', edition.value); else q.set('subject_id', subject.value);
    if (mode.value === 'mastery' && period.value !== 'mastery') q.set('period', period.value);
    else if (mode.value !== 'recommendations') { q.set('limit', '20'); if (next && old && 'next_cursor' in old && old.next_cursor) q.set('cursor', old.next_cursor); }
    if (mode.value === 'mastery' && period.value === 'mastery' && edition.value) q.set('textbook_edition_id', edition.value);
    if (mode.value === 'mistakes') q.set('status', status.value);
    const path = mode.value === 'mastery' && period.value !== 'mastery' ? 'reports' : mode.value;
    const value = await props.request<Mastery | Reports | Mistakes | Recommendations>(`/me/${path}?${q}`, { signal: readController.signal });
    if (!alive || token !== serial) return;
    if (next && old?.source_watermark !== value.source_watermark) throw new ApiError(409, '数据版本已变化，正在从首页重新读取。', {}, '', '', 'PROJECTION_CHANGED');
    if (mode.value === 'recommendations') recommendations.value = value as Recommendations;
    else if (mode.value === 'mistakes') { const page = value as Mistakes; mistakes.value = { ...page, items: next && readyStatus(page.status) ? [...(mistakes.value?.items || []), ...page.items] : page.items }; }
    else if (period.value === 'mastery') { const page = value as Mastery; mastery.value = { ...page, items: next && readyStatus(page.status) ? [...(mastery.value?.items || []), ...page.items] : page.items }; }
    else reports.value = value as Reports;
  } catch (cause) {
    if (!alive || token !== serial) return;
    clearViews();
    if (cause instanceof ApiError && cause.status === 409 && cause.code === 'PROJECTION_CHANGED' && retry) { notice.value = '学情版本已变化，已丢弃旧页并从首页重读。'; await load(false, false); }
    else fail(cause);
  } finally { if (alive && token === serial) busy.value = false; }
}
function readyStatus(value: string) { return value === 'ready' || value === 'insufficient_evidence'; }
async function openMistake(id: string) {
  if (locked.value) return; const token = ++serial; busy.value = true; detail.value = undefined; error.value = '';
  try { const value = await props.request<Mistake>(`/me/mistakes/${encodeURIComponent(id)}`, { signal: life.signal }); if (!alive || token !== serial) return; if (value.source_watermark !== mistakes.value?.source_watermark) throw new ApiError(409, '错题证据已变化', {}, '', '', 'PROJECTION_CHANGED'); if (readyStatus(value.status)) { detail.value = value; await nextTick(); if (alive && token === serial && !denied.value && detail.value?.id === id) mistakeHeading.value?.focus(); } else { clearViews(); notice.value = '错题证据正在更新或暂不可用，请重新读取。'; } }
  catch (cause) { if (!alive || token !== serial) return; if (cause instanceof ApiError && cause.status === 409 && cause.code === 'PROJECTION_CHANGED') { clearViews(); notice.value = '错题版本已变化，已重新读取列表。'; await load(); } else fail(cause); }
  finally { if (alive && token === serial) busy.value = false; }
}
async function download(fileId: string) {
  const row = detail.value; if (!row || locked.value) return; const token = serial; busy.value = true;
  try {
    const submission = await props.request<Submission>(`/submissions/${row.submission_id}`, { signal: life.signal });
    if (!alive || token !== serial) return;
    const blob = await props.request<Blob>(`/sessions/${submission.session_id}/items/${row.question.id}/files/${fileId}/content`, { signal: life.signal, responseType: 'blob' });
    if (!alive || token !== serial) return;
    const url = URL.createObjectURL(blob); objectUrls.add(url); const link = document.createElement('a'); link.href = url; link.download = `附件-${fileId}`; link.click();
    const timeout = window.setTimeout(() => { URL.revokeObjectURL(url); objectUrls.delete(url); downloadTimers.delete(timeout); }, 1000); downloadTimers.add(timeout);
  } catch (cause) { if (token === serial) fail(cause); } finally { if (alive && token === serial) busy.value = false; }
}
async function create(operation: Recovery['operation'], resource: string) {
  if (locked.value || pending.value) return;
  try { remember({ operation, resource, key: crypto.randomUUID() }); await replay(true); } catch (cause) { fail(cause); }
}
async function replay(firstAttempt = false) {
  const value = pending.value; if (!value || writeBusy.value || cooldown.value || denied.value) return;
  try { remember(value); } catch (cause) { fail(cause); return; }
  writeBusy.value = true; error.value = ''; let refresh = false;
  try {
    const route = value.operation === 'learning.mistake.practice' ? 'mistakes' : 'recommendations';
    const result = await props.request<Session>(`/me/${route}/${encodeURIComponent(value.resource)}/practice-sessions`, { method: 'POST', body: {}, idempotencyKey: value.key, signal: life.signal });
    if (!alive || denied.value) return;
    remember(); clearViews(); selectedSession.value = result.id; notice.value = '服务器已确认新练习。使用当前合法版本，历史错题不会被改写。刷新后可到“练习、考试与结果 → 我的会话”恢复；尚未保存作答不会恢复。';
  } catch (cause) {
    if (!alive) return;
    // Network/5xx/ambiguous conflicts retain the same key, including across refresh.
    if (cause instanceof ApiError && cause.status === 409 && (['RECOMMENDATION_EXPIRED', 'RECOMMENDATION_ALREADY_ACCEPTED', 'PRACTICE_SOURCE_UNAVAILABLE', 'PROJECTION_CHANGED'].includes(cause.code) || (firstAttempt && cause.code === 'CONTENT_UNAVAILABLE'))) {
      try { remember(); } catch (storageCause) { fail(storageCause); return; }
      if (cause.code === 'PRACTICE_SOURCE_UNAVAILABLE' && value.operation === 'learning.mistake.practice') unavailablePractice.value.push(value.resource);
      refresh = value.operation === 'learning.recommendation.practice' || cause.code === 'PROJECTION_CHANGED';
    }
    fail(cause);
  } finally { if (alive) writeBusy.value = false; }
  if (alive && refresh && !denied.value) { notice.value = error.value; await load(); }
}
function readCard(card: Recommendation) { if (!locked.value && card.chapter_id) emit('read', { editionId: card.textbook_edition_id, chapterId: card.chapter_id }); }
function answer(value: Answer) { return value === null ? '未作答' : 'selected_option_ids' in value ? value.selected_option_ids.join('、') || '未选择' : value.value || '未作答'; }
function pointName(id: string) { return options.value?.knowledge_points.find(p => p.id === id)?.name || id; }
function beforeUnload(event: BeforeUnloadEvent) { if (unknown.value || childDirty.value) { event.preventDefault(); event.returnValue = ''; } }
onMounted(() => {
  if (!allowed) return;
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (value !== null) {
      const v = value as Partial<Recovery>;
      if (!v || !['learning.mistake.practice', 'learning.recommendation.practice'].includes(v.operation || '') || typeof v.resource !== 'string' || !/^[0-9a-f]{24}$/.test(v.resource) || typeof v.key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(v.key) || Object.keys(v).some(k => !['operation', 'resource', 'key'].includes(k))) throw new Error('安全恢复元数据格式无效，请联系支持，不要重新创建。');
      pending.value = v as Recovery;
    }
    const assessment = JSON.parse(sessionStorage.getItem(`assessment-recovery:${props.identity.user.id}:${props.identity.context?.org_id}`) || 'null') as import('../assessment/types').Recovery | null;
    if (assessment && assessment.user === props.identity.user.id && assessment.org === props.identity.context?.org_id && ['answer.save', 'session.submit'].includes(assessment.operation) && typeof assessment.session_id === 'string' && /^[0-9a-f]{24}$/.test(assessment.session_id)) {
      selectedSession.value = assessment.session_id;
      notice.value = '已恢复原测评会话，请先确认待处理作答或交卷结果。';
    }
  } catch (cause) { storageBlocked.value = true; fail(cause); }
  window.addEventListener('beforeunload', beforeUnload); void catalogue();
});
onBeforeUnmount(() => { alive = false; serial++; life.abort(); readController.abort(); window.clearInterval(timer); for (const id of downloadTimers) window.clearTimeout(id); for (const url of objectUrls) URL.revokeObjectURL(url); objectUrls.clear(); clearViews(); books.value = []; quizzes.value = []; options.value = undefined; window.removeEventListener('beforeunload', beforeUnload); emit('dirty', false); emit('unknown', false); });
</script>

<template>
  <section class="panel content-workspace stack learning-surface" aria-labelledby="learning-title">
    <header class="page-heading"><p class="eyebrow"><BrandIcon name="chart-no-axes-combined" />我的学习</p><h2 id="learning-title">学情与报告</h2><p class="muted">查看学习表现、回顾错题，找到下一步练习方向。</p><details><summary>掌握度如何计算</summary><p>基于近90天的合格首次作答，至少5道独立题目才提供诊断。重复练习可更新错题状态，不会刷高首次证据。</p></details></header>
    <p v-if="!allowed" class="notice" role="alert">当前身份不具备独立学生学情权限，兼任内容或评估管理者不能访问此工作台。</p>
    <template v-else>
      <nav class="content-toolbar" aria-label="学情导航"><button class="button secondary" :disabled="writeBusy || busy || denied" :aria-pressed="mode === 'mastery'" @click="navigate('mastery')">学情与报告</button><button class="button secondary" :disabled="writeBusy || busy || denied" :aria-pressed="mode === 'mistakes'" @click="navigate('mistakes')">错题</button><button class="button secondary" :disabled="writeBusy || busy || denied" :aria-pressed="mode === 'recommendations'" @click="navigate('recommendations')">下一步推荐</button></nav>
      <p v-if="error" class="notice" role="alert">{{ error }}</p><p v-if="notice" class="notice" role="status">{{ notice }}</p><p v-if="cooldown" role="status">服务端限流，请等待 {{ cooldown }} 秒再重试。</p>
      <section v-if="pending" class="notice stack" aria-label="恢复原创建请求"><p>创建结果尚待确认，不代表失败。刷新后仍可用原请求编号与空正文恢复，不会改用新编号。</p><button class="button secondary" :disabled="writeBusy || cooldown > 0 || denied" @click="replay()">{{ writeBusy ? '正在确认…' : '使用原请求编号确认 / 重试' }}</button></section>
      <p v-if="storageBlocked" class="notice" role="alert">安全恢复存储不可用，已阻止新建练习。请恢复浏览器存储后重新载入；不要删除原请求记录。</p>
      <p v-if="denied" class="notice">当前资源或身份已不可访问，敏感内容已清除。请重新确认身份与组织后进入。</p>
      <AssessmentSession v-if="selectedSession" :key="selectedSession" :session-id="selectedSession" :identity="identity" :request="request" @dirty="childDirty = $event" @unknown="childUnknown = $event" />
      <template v-else-if="!denied">
        <div class="content-columns"><div class="field"><label for="learning-edition">教材版本（推荐必选）</label><select id="learning-edition" v-model="edition" :disabled="locked" @change="chooseEdition"><option value="">不限定教材 / 考试学科</option><option v-for="book in books" :key="book.id" :value="book.id">{{ book.title }} · {{ book.edition_code }}</option></select><button v-if="bookCursor" class="text-button" :disabled="locked" @click="catalogue('books')">加载更多真实教材</button></div><div class="field"><label for="learning-subject">学科</label><select id="learning-subject" v-model="subject" :disabled="locked || mode === 'recommendations'" @change="chooseSubject"><option value="">选择教材或考试学科</option><option v-for="id in subjects" :key="id" :value="id">{{ subjectLabel(id) }}</option></select><p class="field-help">从教材或可见考试选择学科，历史编号可在下方高级定位中查询。</p><button v-if="quizCursor" class="text-button" :disabled="locked" @click="catalogue('quizzes')">加载更多考试学科</button></div></div>
        <details v-if="mode !== 'recommendations'"><summary>按已知学科编号读取（含历史考试）</summary><form class="stack" @submit.prevent="subject = subjectInput; chooseSubject()"><label for="learning-subject-id">真实学科编号</label><input id="learning-subject-id" v-model="subjectInput" :disabled="locked" required pattern="[0-9a-f]{24}" /><p class="field-help">历史会话接口不返回学科编号；请使用已知真实编号，系统不推测考试归属。</p><button class="button secondary" :disabled="locked">读取学科</button></form></details>
        <button class="text-button" :disabled="locked" @click="catalogue()">重新读取教材与考试目录</button>
        <nav v-if="mode === 'mastery'" class="content-toolbar" aria-label="报告窗口"><button v-for="tab in (['mastery', '7d', '30d'] as const)" :key="tab" class="button secondary" :disabled="locked" :aria-pressed="period === tab" @click="choosePeriod(tab, $event)">{{ tab === 'mastery' ? '90天掌握度' : tab === '7d' ? '最近7天报告' : '最近30天报告' }}</button></nav>
        <div v-if="mode === 'mistakes'" class="field"><label for="mistake-status">错题状态</label><select id="mistake-status" v-model="status" :disabled="locked" @change="load()"><option value="active">待解决</option><option value="resolved">已解决</option><option value="all">全部</option></select></div>
        <div class="actions"><button class="button secondary" :disabled="locked || (mode === 'recommendations' ? !edition : !subject)" @click="load()">重新读取当前视图</button></div>
        <p v-if="busy || catalogueBusy" role="status">正在读取真实数据…</p>
        <p v-else-if="!current && !error">{{ mode === 'recommendations' ? '请选择真实教材，查看当前可用建议。' : '请选择学科；可通过教材或考试目录获取真实学科。' }}</p>
        <template v-if="current">
          <p v-if="!ready" class="notice" role="status">{{ current.status === 'updating' ? '学情正在更新；本页不显示旧证据。请稍后重试。' : '学情暂不可用，本页不使用旧值或演示数据。请稍后重试。' }}</p>
          <template v-else>
            <p v-if="current.status === 'insufficient_evidence'" class="notice">当前证据不足，待诊断不等于0分。请完成当前合法练习或等待可见成绩生成。</p>
            <section v-if="mode === 'mastery'" class="stack" aria-label="学情与报告内容">
              <p v-if="reports" class="field-help">报告统计整个所选学科，不按教材缩小范围；活动窗口以服务器生成时间为截止，90天掌握度单独展示。不提供排名、趋势或未经实现的进步百分比。</p>
              <section v-if="reports" class="content-section stack"><h3>{{ reports.period === '7d' ? '近7天' : '近30天' }}活动（与90天掌握度不同）</h3><template v-if="reports.activity"><dl class="learning-facts"><div><dt>有效提交</dt><dd>{{ reports.activity.submission_count }}</dd></div><div><dt>作答次数（可含重复）</dt><dd>{{ reports.activity.attempt_count }}</dd></div><div><dt>正确 / 错误 / 未答</dt><dd>{{ reports.activity.correct_count }} / {{ reports.activity.incorrect_count }} / {{ reports.activity.unanswered_count }}</dd></div><div><dt>独立首次题数</dt><dd>{{ reports.activity.independent_question_count }}</dd></div><div><dt>首次证据正确率</dt><dd>{{ reports.activity.correctness === null ? '待诊断' : `${reports.activity.correctness}%` }}</dd></div><div><dt>精确分子 / 分母</dt><dd>{{ reports.activity.numerator }} / {{ reports.activity.denominator }}</dd></div></dl></template><p v-else>当前没有可展示的活动证据；不将未知值当作零。</p></section>
              <h3>90天掌握度 · 首次记录作答</h3><p v-if="!rows.length">暂无可见独立证据。完成真实练习后，等待服务器生成诊断。</p><ul class="content-list"><li v-for="row in rows" :key="row.knowledge_point_id"><div class="stack"><h4>{{ pointName(row.knowledge_point_id) }}</h4><p>{{ row.mastery === null ? '待诊断（不足5道合格首次题）' : `掌握度 ${row.mastery}%` }} · {{ row.independent_question_count }} 道独立首次题</p><p>精确分子 / 分母：{{ row.numerator }} / {{ row.denominator }}</p><p class="field-help">最后证据：{{ row.last_evidence_at }} · {{ row.status === 'weak' ? '薄弱' : row.status === 'developing' ? '巩固中' : row.status === 'mastered' ? '已掌握' : '证据不足' }}</p></div></li></ul><button v-if="mastery?.next_cursor" class="button secondary" :disabled="locked" @click="load(true)">加载更多掌握度</button>
            </section>
            <section v-else-if="mode === 'mistakes' && mistakes" class="stack" aria-label="错题列表"><p>当前可见 {{ mistakes.total }} 道错题。按题目身份归并；最新有效作答决定是否已解决。</p><p v-if="!mistakes.items.length">当前筛选没有可见错题。可切换状态或在完成练习后重新读取。</p><ul class="content-list"><li v-for="row in mistakes.items" :key="row.id"><div><h3>{{ row.title }}</h3><p>{{ row.status === 'active' ? '待解决' : '已解决' }} · 最后作答 {{ row.last_attempt_at }}</p></div><button class="button secondary" :disabled="locked" @click="openMistake(row.id)">查看原作答与有效解析</button></li></ul><button v-if="mistakes.next_cursor" class="button secondary" :disabled="locked" @click="load(true)">加载更多错题</button>
              <article v-if="detail" class="content-section stack" aria-label="错题详情"><h3 ref="mistakeHeading" tabindex="-1">{{ detail.question.title }}</h3><p class="reading-body">{{ detail.question.prompt }}</p><ul><li v-for="option in detail.question.options" :key="option.id">{{ option.id }}. {{ option.text }}</li></ul><p>原作答：{{ answer(detail.student_answer) }}</p><p>当前有效标准答案：{{ detail.standard_answer }}</p><p class="reading-body">有效解析：{{ detail.explanation || '当前有效版本未提供解析。' }}</p><p>得分 {{ detail.score }} / {{ detail.question.max_score }} · 有效评分修订 {{ detail.grading_revision }} · {{ detail.verdict === 'correct' ? '正确' : detail.verdict === 'incorrect' ? '错误' : '未答' }}</p><div class="actions"><button v-for="file in detail.question.resource_ids" :key="file" class="button secondary" :disabled="locked" @click="download(file)">下载原题附件 {{ file }}</button></div><p class="field-help">重练使用当前合法已发布版本，题面可能变化；原题及原作答不会被覆盖。重复练习影响错题解决状态，不刷高首次掌握度证据。</p><p v-if="unavailablePractice.includes(detail.id)" class="notice">当前没有合法已发布版本可供重练，请等待内容更新。</p><button class="button" :disabled="locked || unavailablePractice.includes(detail.id)" @click="create('learning.mistake.practice', detail.id)">使用当前版本重练</button></article>
            </section>
            <section v-else-if="mode === 'recommendations' && recommendations" class="stack" aria-label="推荐内容"><p>本期不使用先修关系，不推断先修已满足；知识图谱尚未参与推荐。</p><p v-if="!recommendations.items.length">{{ recommendations.empty_reason === 'NO_ELIGIBLE_CONTENT' ? '当前无合法候选内容。可换一本教材或在内容更新后重试。' : '当前没有可展示推荐，请稍后重新读取。' }}</p><ol class="content-list"><li v-for="card in recommendations.items.slice(0, 3)" :key="card.id"><div class="stack"><h3>{{ card.kind === 'reading' ? '关联章节阅读' : `${card.difficulty}练习 · ${card.count}题` }}</h3><p>{{ card.reason }}</p><p>合格首次题 {{ card.independent_question_count }} 道 · {{ card.mastery === null ? '待诊断' : `掌握度 ${card.mastery}%` }}</p><button v-if="card.kind === 'reading'" class="button secondary" :disabled="locked || !card.chapter_id" @click="readCard(card)">阅读关联章节</button><button v-else class="button" :disabled="locked" @click="create('learning.recommendation.practice', card.id)">接受练习推荐</button><p class="field-help">有效至 {{ card.expires_at }}</p></div></li></ol><p class="field-help">候选不足时不凑题；接受时由服务器重新核验，过期后刷新候选。阅读导航不承诺24小时去重。</p></section>
          </template>
          <p class="field-help">规则 {{ current.rule_version }}<template v-if="'generated_at' in current"> · 生成时间 {{ current.generated_at ?? '尚未生成' }}</template></p>
        </template>
      </template>
    </template>
  </section>
</template>
<style scoped>
.learning-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, var(--layout-min)), 1fr)); gap: var(--space-4); margin: 0; }
.learning-facts dt { color: var(--color-muted); font-size: var(--text-small); }
.learning-facts dd { margin: 0; overflow-wrap: anywhere; }
h3, h4 { margin: 0; }
.content-list > li, .content-list > li > div { min-width: 0; }
</style>
