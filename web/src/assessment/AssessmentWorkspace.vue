<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ApiError, type BusinessRequest, type Identity } from '../session';
import AssessmentAdmin from './AssessmentAdmin.vue';
import AssessmentSession from './AssessmentSession.vue';
import type { Page, PracticeOptions, StudentQuiz, Recovery, Resolution, Session } from './types';
const props = defineProps<{ identity: Identity; request: BusinessRequest }>();
const emit = defineEmits<{ dirty: [value: boolean]; unknown: [value: boolean] }>();
const caps = props.identity.context?.capabilities || [];
const learner = caps.includes('learning:self');
const admin = caps.some(c => ['assessment:manage', 'assessment:review'].includes(c));
const mode = ref(learner ? 'practice' : 'admin');
const busy = ref(false), error = ref(''), childDirty = ref(false), childUnknown = ref(false);
const fields = ref<Record<string, string>>({});
const sessions = ref<Session[]>([]), quizzes = ref<StudentQuiz[]>([]), books = ref<{ id: string; title: string }[]>([]);
const cursor = ref<string | null>(null), bookCursor = ref<string | null>(null), selectedSession = ref('');
const edition = ref(''), chapter = ref(''), knowledge = ref<string[]>([]), difficulty = ref(''), count = ref(5);
const options = ref<PracticeOptions>();
const pending = ref<Recovery>(), storageBlocked = ref(false);
let pendingBody: unknown;
const life = new AbortController(); let alive = true, serial = 0;
const storageKey = `assessment-recovery:${props.identity.user.id}:${props.identity.context?.org_id}`;
const dirty = computed(() => childDirty.value);
const unknown = computed(() => !!pending.value || storageBlocked.value || childUnknown.value);
watch(dirty, v => emit('dirty', v)); watch(unknown, v => emit('unknown', v));
function remember(value?: Recovery) {
  try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey); }
  catch { throw new Error(value ? '无法保存安全恢复元数据，未发送请求；请恢复浏览器存储后重试。' : '无法清除安全恢复元数据，已保留原请求编号；请恢复浏览器存储后查询原请求，不要重复创建。'); }
  pending.value = value;
}
function fail(cause: unknown) { if (alive) { error.value = cause instanceof Error ? `${cause.message}${cause instanceof ApiError ? ` ${cause.code} ${cause.requestId}${cause.retryAfter ? `；请等待 ${cause.retryAfter} 秒再重试` : ''}` : ''}` : '请求未完成'; fields.value = cause instanceof ApiError ? cause.fields : {}; } }
function leave() { if (unknown.value) { error.value = '请先确认原请求结果，再离开本测评。未知请求不会自动取消。'; return false; } return !dirty.value || window.confirm('存在未保存作答或草稿，确定放弃并继续？'); }
async function navigate(value: string) { if (busy.value || !leave()) return; mode.value = value; selectedSession.value = ''; cursor.value = null; serial++; error.value = ''; await load(); }
async function load(next = false) {
  if (busy.value || mode.value === 'admin') return;
  busy.value = true; const token = ++serial;
  try {
    const q = new URLSearchParams({ limit: '20' }); if (next && cursor.value) q.set('cursor', cursor.value);
    if (mode.value === 'sessions') { const page = await props.request<Page<Session>>(`/me/sessions?${q}`, { signal: life.signal }); if (alive && token === serial) { sessions.value = next ? [...sessions.value, ...page.items] : page.items; cursor.value = page.next_cursor; } }
    else if (mode.value === 'quizzes') { const page = await props.request<Page<StudentQuiz>>(`/quizzes?${q}`, { signal: life.signal }); if (alive && token === serial) { quizzes.value = next ? [...quizzes.value, ...page.items] : page.items; cursor.value = page.next_cursor; } }
    else await loadBooks();
  } catch (cause) { fail(cause); } finally { if (alive) busy.value = false; }
}
async function loadBooks(next = false) {
  try { const q = new URLSearchParams({ limit: '50' }); if (next && bookCursor.value) q.set('cursor', bookCursor.value); const page = await props.request<Page<{ id: string; title: string }>>(`/textbook-editions?${q}`, { signal: life.signal }); if (alive) { books.value = next ? [...books.value, ...page.items] : page.items; bookCursor.value = page.next_cursor; } } catch (cause) { fail(cause); }
}
async function loadOptions() {
  const token = ++serial; options.value = undefined; knowledge.value = []; error.value = '';
  if (!edition.value) return;
  try { const q = new URLSearchParams({ textbook_edition_id: edition.value }); if (chapter.value) q.set('chapter_id', chapter.value); const result = await props.request<PracticeOptions>(`/practice-options?${q}`, { signal: life.signal }); if (alive && token === serial) options.value = result; } catch (cause) { fail(cause); }
}
async function create(quiz?: StudentQuiz) {
  if (busy.value || pending.value || storageBlocked.value) return;
  try {
    pendingBody = quiz ? {} : { textbook_edition_id: edition.value, ...(chapter.value ? { chapter_id: chapter.value } : {}), knowledge_point_ids: [...knowledge.value], ...(difficulty.value ? { difficulty: difficulty.value } : {}), count: count.value };
    remember({ user: props.identity.user.id, org: props.identity.context!.org_id, operation: quiz ? 'quiz.start' : 'practice.create', resource_id: quiz?.id || 'new', key: crypto.randomUUID() });
    await replay(true);
  } catch (cause) { fail(cause); }
}
async function replay(firstAttempt = false) {
  const p = pending.value; if (!p || pendingBody === undefined || busy.value || storageBlocked.value) return;
  try { remember(p); } catch (cause) { fail(cause); return; }
  busy.value = true; error.value = '';
  try { const result = await props.request<Session>(p.operation === 'quiz.start' ? `/quizzes/${p.resource_id}/sessions` : '/practice-sessions', { method: 'POST', body: pendingBody, idempotencyKey: p.key, signal: life.signal }); if (!alive) return; remember(); pendingBody = undefined; selectedSession.value = result.id; }
  catch (cause) { if (firstAttempt && alive && cause instanceof ApiError && [400, 404, 409, 413, 422, 429].includes(cause.status) && !['COMMIT_OUTCOME_UNKNOWN', 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_RESULT_INVALID', 'IDENTITY_CHANGED'].includes(cause.code)) { try { remember(); pendingBody = undefined; } catch (storageCause) { fail(storageCause); return; } } fail(cause); }
  finally { if (alive) busy.value = false; }
}
async function recover() {
  const p = pending.value; if (!p || busy.value) return; busy.value = true;
  try { const q = new URLSearchParams({ operation: p.operation, resource_id: p.resource_id, key: p.key }); const result = await props.request<Resolution>(`/me/idempotency-requests?${q}`, { signal: life.signal }); if (!alive) return; if (result.status === 'resolved') { const id = 'session_id' in result.result ? result.result.session_id : result.result.id; remember(); pendingBody = undefined; selectedSession.value = id; } else error.value = '服务器尚未确认原请求；未知不代表失败。请继续查询，不要重新创建。'; } catch (cause) { fail(cause); } finally { if (alive) busy.value = false; }
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value || unknown.value) { event.preventDefault(); event.returnValue = ''; } }
onMounted(() => { try { const value = JSON.parse(sessionStorage.getItem(storageKey) || 'null') as Recovery | null; if (value && value.user === props.identity.user.id && value.org === props.identity.context?.org_id) { if (value.operation === 'session.submit' || value.operation === 'answer.save') selectedSession.value = value.session_id || value.resource_id; else pending.value = value; } if (admin && sessionStorage.getItem(`assessment-admin-recovery:${props.identity.user.id}:${props.identity.context?.org_id}`)) mode.value = 'admin'; } catch { storageBlocked.value = true; error.value = '无法读取安全恢复元数据，已禁止创建请求；请恢复浏览器存储并重新读取页面，不要清除存储后重复提交。'; } window.addEventListener('beforeunload', beforeUnload); void load(); });
onBeforeUnmount(() => { alive = false; serial++; life.abort(); window.removeEventListener('beforeunload', beforeUnload); emit('dirty', false); emit('unknown', false); });
</script>
<template>
  <section class="panel content-workspace stack" aria-labelledby="assessment-title">
    <header class="page-heading"><p class="eyebrow">练习与测评</p><h2 id="assessment-title">从作答到反馈，每一步都有记录</h2><p class="muted">次数、截止与成绩由服务器确认。尚未保存的作答不会在刷新后恢复。</p></header>
    <nav class="content-toolbar" aria-label="测评导航">
      <button v-if="learner" class="button secondary" :aria-pressed="mode === 'practice'" @click="navigate('practice')">开始练习</button>
      <button v-if="learner" class="button secondary" :aria-pressed="mode === 'quizzes'" @click="navigate('quizzes')">参加考试</button>
      <button v-if="learner" class="button secondary" :aria-pressed="mode === 'sessions'" @click="navigate('sessions')">我的会话</button>
      <button v-if="admin" class="button secondary" :aria-pressed="mode === 'admin'" @click="navigate('admin')">考试管理与审核</button>
    </nav>
    <p v-if="error" class="notice" role="alert">{{ error }}</p>
    <ul v-if="Object.keys(fields).length" class="notice" role="alert"><li v-for="(text, name) in fields" :key="name">{{ name }}：{{ text }}</li></ul>
    <section v-if="pending" class="notice stack" aria-label="创建请求恢复"><p>创建结果待确认。已保留原请求编号，不会再次占用次数。</p><div class="actions"><button class="button secondary" :disabled="busy" @click="recover">查询原创建结果</button><button v-if="pendingBody !== undefined" class="button secondary" :disabled="busy" @click="replay()">原键重试创建</button></div></section>
    <AssessmentSession v-if="selectedSession" :key="selectedSession" :session-id="selectedSession" :identity="identity" :request="request" @dirty="childDirty = $event" @unknown="childUnknown = $event" />
    <AssessmentAdmin v-else-if="mode === 'admin'" :identity="identity" :request="request" @dirty="childDirty = $event" @unknown="childUnknown = $event" />
    <form v-else-if="mode === 'practice'" class="stack" @submit.prevent="create()">
      <div class="field"><label for="practice-edition">教材版本</label><select id="practice-edition" v-model="edition" required :disabled="!!pending" @change="chapter = ''; loadOptions()"><option value="">选择已发布教材</option><option v-for="book in books" :key="book.id" :value="book.id">{{ book.title }}</option></select><button v-if="bookCursor" type="button" class="text-button" @click="loadBooks(true)">加载更多教材</button></div>
      <template v-if="options"><div class="field"><label for="practice-chapter">章节范围</label><select id="practice-chapter" v-model="chapter" @change="loadOptions"><option value="">整个教材</option><option v-for="item in options.chapters" :key="item.id" :value="item.id">{{ item.id }}</option></select></div>
      <fieldset class="content-fields"><legend>知识点（明确选择，不自动扩大范围）</legend><label v-for="point in options.knowledge_points" :key="point.id" class="check-label"><input v-model="knowledge" type="checkbox" :value="point.id" />{{ point.name }}</label></fieldset>
      <div class="content-columns"><div class="field"><label for="practice-difficulty">难度</label><select id="practice-difficulty" v-model="difficulty"><option value="">不限</option><option v-for="value in options.difficulties" :key="value">{{ value }}</option></select></div><div class="field"><label for="practice-count">题量</label><input id="practice-count" v-model.number="count" type="number" min="1" max="20" required /></div></div></template>
      <button class="button" :disabled="busy || !!pending || !edition || !knowledge.length">创建练习</button>
    </form>
    <section v-else class="stack" :aria-busy="busy"><button class="button secondary" :disabled="busy" @click="load()">刷新列表</button><ul v-if="mode === 'quizzes'" class="content-list"><li v-for="quiz in quizzes" :key="quiz.id"><div><h3>{{ quiz.title }}</h3><p>{{ quiz.opens_at }} — {{ quiz.closes_at }}</p><p>时长 {{ quiz.duration_seconds }} 秒 · 服务端剩余次数 {{ quiz.remaining_attempts ?? '待确认' }}</p><p>发布时间 {{ quiz.release_at }}</p></div><button v-if="quiz.active_session_id" class="button secondary" @click="selectedSession = quiz.active_session_id">恢复考试</button><button v-else class="button" :disabled="busy || !!pending || quiz.can_start !== true" @click="create(quiz)">开始考试</button></li></ul><ul v-else class="content-list"><li v-for="item in sessions" :key="item.id"><div><h3>{{ item.mode === 'quiz' ? '考试' : '练习' }} · {{ item.status }}</h3><p>{{ item.started_at }} · {{ item.item_count }} 题</p></div><button class="button secondary" @click="selectedSession = item.id">{{ item.submission_id ? '查看结果' : '继续作答' }}</button></li></ul><p v-if="!busy && !(mode === 'quizzes' ? quizzes.length : sessions.length)" class="content-empty">暂无记录。可开始一次练习，或等待管理员发布考试。</p><button v-if="cursor" class="button secondary" :disabled="busy" @click="load(true)">加载更多记录</button></section>
  </section>
</template>
