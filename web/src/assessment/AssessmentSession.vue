<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ApiError, type BusinessRequest, type Identity } from '../session';
import type { Answer, Item, SessionPage, Recovery, Resolution, ResultItem, ResultPage, SavedAnswer, Session, Submission, SubmissionReceipt } from './types';
const props = defineProps<{ sessionId: string; identity: Identity; request: BusinessRequest }>();
const emit = defineEmits<{ dirty: [value: boolean]; unknown: [value: boolean] }>();
const meta = ref<Session>(), items = ref<Item[]>([]), baseline = ref<Record<string, string>>({});
const current = ref(0), busy = ref(false), saving = ref(false), frozen = ref(false), message = ref(''), error = ref('');
const result = ref<Submission>(), results = ref<ResultItem[]>([]), resultCursor = ref<string | null>(null);
const fields = ref<Record<string, string>>({}), conflict = ref(false), remote = ref<{ session: Session; items: Item[] }>();
const comparing = ref(false), resultBusy = ref(false); let resultGeneration = 0;
const pending = ref<Recovery>(), storageBlocked = ref(false); let pendingBody: unknown;
const life = new AbortController(); let alive = true, generation = 0, queue: Promise<void> = Promise.resolve(), timer = 0;
let observedAt = 0, serverAt = 0; const tick = ref(0);
const storageKey = `assessment-recovery:${props.identity.user.id}:${props.identity.context?.org_id}`;
const dirty = computed(() => items.value.some(item => JSON.stringify(item.answer) !== baseline.value[item.id]));
const item = computed(() => items.value[current.value]);
const remaining = computed(() => { tick.value; return meta.value?.deadline_at ? Math.max(0, Math.ceil((Date.parse(meta.value.deadline_at) - serverAt - (performance.now() - observedAt)) / 1000)) : null; });
const editable = computed(() => meta.value?.status === 'in_progress' && !frozen.value && !pending.value && !storageBlocked.value && !busy.value);
watch(dirty, v => emit('dirty', v)); watch(() => !!pending.value || storageBlocked.value, v => emit('unknown', v));
function remember(value?: Recovery) {
  try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey); }
  catch { throw new Error(value ? '无法保存安全恢复元数据，未发送请求；本地作答保留，请恢复浏览器存储后重试。' : '无法清除安全恢复元数据，已保留原请求编号；请恢复浏览器存储后查询原请求，不要重复提交。'); }
  pending.value = value;
}
function clearSensitive() { resultGeneration++; items.value = []; baseline.value = {}; results.value = []; result.value = undefined; resultCursor.value = null; remote.value = undefined; }
function fail(cause: unknown) {
  if (!alive) return;
  error.value = cause instanceof Error ? cause.message : '请求未完成';
  fields.value = cause instanceof ApiError ? cause.fields : {};
  if (cause instanceof ApiError) {
    error.value += ` ${cause.code}${cause.retryAfter ? `；请等待 ${cause.retryAfter} 秒再重试` : ''}${cause.requestId ? `（${cause.requestId}）` : ''}`;
    if ([401, 403, 404].includes(cause.status) || ['CONTENT_UNAVAILABLE', 'QUESTION_EMBARGOED'].includes(cause.code)) { generation++; clearSensitive(); frozen.value = true; }
    if (cause.code === 'REVISION_CONFLICT') { conflict.value = true; frozen.value = true; window.clearTimeout(timer); error.value += ' 本地作答保留且不会自动覆盖远端。请读取远端并明确选择保留或丢弃本地修改。'; void compareRemote(); }
  }
}
function adopt(value: Session) { meta.value = value; serverAt = Date.parse(value.server_time); observedAt = performance.now(); }
async function readItems(value: Session, token: number) {
  const loaded: Item[] = []; let cursor: string | null = null;
  do {
    const q = new URLSearchParams({ limit: '50', session_revision: String(value.revision) }); if (cursor) q.set('cursor', cursor);
    const page = await props.request<SessionPage>(`/sessions/${value.id}/items?${q}`, { signal: life.signal });
    if (!alive || token !== generation) return;
    if (page.session_revision !== value.revision) throw new ApiError(409, '题项修订已变化，请重新读取。', {}, '', '', 'REVISION_CONFLICT');
    loaded.push(...page.items); cursor = page.next_cursor;
  } while (cursor);
  if (loaded.length !== value.item_count) throw new Error('题项尚未完整读取，请重试。');
  return loaded;
}
async function compareRemote() {
  if (comparing.value || pending.value) return;
  comparing.value = true; remote.value = undefined; const token = generation;
  try {
    const value = await props.request<Session>(`/sessions/${props.sessionId}`, { signal: life.signal });
    if (!alive || token !== generation) return;
    const loaded = await readItems(value, token);
    if (loaded && alive && token === generation) remote.value = { session: value, items: loaded };
  } catch (cause) {
    if (alive && token === generation) { error.value = cause instanceof Error ? cause.message : '读取远端失败，请重试'; fields.value = cause instanceof ApiError ? cause.fields : {}; if (cause instanceof ApiError && ([401, 403, 404].includes(cause.status) || ['CONTENT_UNAVAILABLE', 'QUESTION_EMBARGOED'].includes(cause.code))) { generation++; clearSensitive(); } }
  } finally { if (alive) comparing.value = false; }
}
async function resolveConflict(keepLocal: boolean) {
  const snapshot = remote.value; if (!snapshot || pending.value || saving.value) return;
  if (keepLocal && snapshot.session.status !== 'in_progress') return;
  const local = new Map(items.value.filter(row => JSON.stringify(row.answer) !== baseline.value[row.id]).map(row => [row.id, row.answer]));
  adopt(snapshot.session);
  baseline.value = Object.fromEntries(snapshot.items.map(row => [row.id, JSON.stringify(row.answer)]));
  items.value = snapshot.items.map(row => keepLocal && local.has(row.id) ? { ...row, answer: local.get(row.id)! } : row);
  conflict.value = false; remote.value = undefined; frozen.value = false; error.value = ''; fields.value = {};
  message.value = keepLocal ? '已保留本地修改，并以远端修订为基线；请检查后手动保存。' : '已丢弃本地修改，采用服务器作答。';
  if (snapshot.session.submission_id) { clearSensitive(); await loadResult(snapshot.session.submission_id); }
}
function answerText(answer: Answer, row: Item) { return answer === null ? '未作答' : 'value' in answer ? answer.value : answer.selected_option_ids.map(id => row.options.find(option => option.id === id)?.text || id).join('、'); }
async function load() {
  if (busy.value || saving.value || comparing.value) return;
  if (dirty.value && !window.confirm('重新读取将放弃未保存的本地作答。是否继续？')) return;
  busy.value = true; const token = ++generation; error.value = ''; fields.value = {}; clearSensitive();
  try {
    const value = await props.request<Session>(`/sessions/${props.sessionId}`, { signal: life.signal }); if (!alive || token !== generation) return; adopt(value);
    if (value.submission_id) { await loadResult(value.submission_id); return; }
    const loaded = await readItems(value, token); if (!loaded) return;
    items.value = loaded; baseline.value = Object.fromEntries(loaded.map(row => [row.id, JSON.stringify(row.answer)])); current.value = 0; conflict.value = false; frozen.value = !!pending.value; message.value = storageBlocked.value ? '无法读取安全恢复元数据，已禁止保存和交卷；请恢复浏览器存储并重新读取页面，不要清除存储后重复提交。' : '已读取服务器确认的作答；刷新前未确认的输入无法恢复。';
  } catch (cause) { fail(cause); } finally { if (alive) busy.value = false; }
}
function changed(answer: Answer) { if (!item.value || !editable.value) return; item.value.answer = answer; window.clearTimeout(timer); timer = window.setTimeout(() => { void flush().catch(fail); }, 650); }
function choice(id: string, checked: boolean) { const row = item.value; if (!row) return; const selected = row.answer && 'selected_option_ids' in row.answer ? row.answer.selected_option_ids : []; changed({ selected_option_ids: row.question_type === 'single' ? [id] : checked ? [...selected.filter(value => value !== id), id].sort() : selected.filter(value => value !== id) }); }
function checked(id: string) { const answer = item.value?.answer; return !!answer && 'selected_option_ids' in answer && answer.selected_option_ids.includes(id); }
function flush() {
  window.clearTimeout(timer);
  const run = async () => {
    if (storageBlocked.value) throw new Error('无法读取安全恢复元数据，已禁止保存；请先恢复浏览器存储并重新读取页面。');
    if (!alive || pending.value || !meta.value || meta.value.status !== 'in_progress') { if (pending.value) throw new Error('请先恢复待确认的保存请求。'); return; }
    if (conflict.value) throw new Error('请先核对远端修订并选择如何处理本地作答。');
    saving.value = true;
    if (dirty.value) { error.value = ''; fields.value = {}; }
    try {
      for (const row of items.value) {
        if (JSON.stringify(row.answer) === baseline.value[row.id]) continue;
        const answer = JSON.parse(JSON.stringify(row.answer)) as Answer;
        const p: Recovery = { user: props.identity.user.id, org: props.identity.context!.org_id, operation: 'answer.save', resource_id: row.id, session_id: props.sessionId, key: crypto.randomUUID(), expected_revision: meta.value.revision };
        pendingBody = { expected_revision: p.expected_revision, answer }; remember(p);
        try { const saved = await props.request<SavedAnswer>(`/sessions/${props.sessionId}/answers/${row.id}`, { method: 'PUT', body: pendingBody, idempotencyKey: p.key, signal: life.signal }); if (!alive) return; meta.value.revision = saved.revision; baseline.value[row.id] = JSON.stringify(answer); remember(); pendingBody = undefined; message.value = `服务器已保存 · ${saved.saved_at}`; }
        catch (cause) { if (alive && cause instanceof ApiError && [400, 404, 409, 413, 422, 429].includes(cause.status) && !['COMMIT_OUTCOME_UNKNOWN', 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_RESULT_INVALID', 'IDENTITY_CHANGED'].includes(cause.code)) { remember(); pendingBody = undefined; } if (alive && cause instanceof ApiError && cause.code === 'REVISION_CONFLICT') conflict.value = true; throw cause; }
      }
    } finally { if (alive) saving.value = false; }
  };
  const next = queue.then(run); queue = next.catch(() => {}); return next;
}
async function submit() {
  if (!meta.value || busy.value || frozen.value || pending.value || storageBlocked.value) return;
  if (!window.confirm('交卷后不能修改作答。确认保存全部作答并交卷？')) return;
  frozen.value = true; error.value = '';
  try { await flush(); if (!alive || !meta.value) return; if (dirty.value) throw new Error('仍有未确认作答，请先保存。'); const p: Recovery = { user: props.identity.user.id, org: props.identity.context!.org_id, operation: 'session.submit', resource_id: props.sessionId, session_id: props.sessionId, key: crypto.randomUUID(), expected_revision: meta.value.revision }; pendingBody = { expected_revision: p.expected_revision, answers: [] }; remember(p); await replay(true); }
  catch (cause) { fail(cause); if (!pending.value && !conflict.value) frozen.value = false; }
}
async function replay(firstAttempt = false) {
  const p = pending.value; if (!p || busy.value || saving.value || storageBlocked.value) return;
  try { remember(p); } catch (cause) { fail(cause); return; }
  if (p.operation === 'session.submit') pendingBody = { expected_revision: p.expected_revision, answers: [] };
  if (pendingBody === undefined) { error.value = '原作答正文没有保存在浏览器中，只能查询原请求；不会用新正文重放。'; return; }
  busy.value = true; error.value = ''; fields.value = {}; message.value = '';
  try { const value = await props.request<SavedAnswer | SubmissionReceipt>(p.operation === 'session.submit' ? `/sessions/${props.sessionId}/submissions` : `/sessions/${props.sessionId}/answers/${p.resource_id}`, { method: p.operation === 'session.submit' ? 'POST' : 'PUT', body: pendingBody, idempotencyKey: p.key, signal: life.signal }); if (!alive) return; if (p.operation === 'answer.save') { const sent = pendingBody as { answer: Answer }; baseline.value[p.resource_id] = JSON.stringify(sent.answer); if (meta.value) meta.value.revision = value.revision; } remember(); pendingBody = undefined; frozen.value = false; message.value = 'submission_id' in value ? '服务器已确认交卷，正在查询评分结果。' : `服务器已保存 · ${value.saved_at}`; if ('submission_id' in value) { if (meta.value) { meta.value.status = value.session_status; meta.value.revision = value.revision; meta.value.submission_id = value.submission_id; } clearSensitive(); await loadResult(value.submission_id); } }
  catch (cause) { if (firstAttempt && alive && cause instanceof ApiError && [400, 404, 409, 413, 422, 429].includes(cause.status) && !['COMMIT_OUTCOME_UNKNOWN', 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_RESULT_INVALID', 'IDENTITY_CHANGED'].includes(cause.code)) { try { remember(); pendingBody = undefined; frozen.value = false; } catch (storageCause) { fail(storageCause); return; } } fail(cause); } finally { if (alive) busy.value = false; }
}
async function recover() {
  const p = pending.value; if (!p || busy.value || saving.value) return; busy.value = true;
  let reload = false;
  try {
    const q = new URLSearchParams({ operation: p.operation, resource_id: p.resource_id, key: p.key });
    const value = await props.request<Resolution>(`/me/idempotency-requests?${q}`, { signal: life.signal });
    if (!alive) return;
    if (value.status === 'resolved') {
      const sent = pendingBody as { answer: Answer } | undefined;
      if (p.operation === 'answer.save' && sent && 'saved_at' in value.result && meta.value) {
        remember();
        baseline.value[p.resource_id] = JSON.stringify(sent.answer);
        meta.value.revision = value.result.revision;
        pendingBody = undefined; frozen.value = false;
        message.value = `原保存已确认 · ${value.result.saved_at}；其余本地修改保留，请检查后保存或交卷。`;
        error.value = ''; fields.value = {};
      } else {
        remember(); pendingBody = undefined; frozen.value = false; reload = true;
        message.value = '原请求已确认，请重新读取服务器状态。';
      }
    } else message.value = '原请求仍未知。请继续查询；交卷可原键重试，保存仅在本页保留原正文时可重试。';
  } catch (cause) { fail(cause); } finally { if (alive) busy.value = false; }
  if (reload) await load();
}
async function loadResult(id = result.value?.id || meta.value?.submission_id || '', next = false) {
  if (!id || (next && (resultBusy.value || !resultCursor.value))) return;
  const token = generation, requestToken = ++resultGeneration;
  const previous = next ? results.value : [], cursor = next ? resultCursor.value : null, revision = next ? result.value?.effective_grading_revision : null;
  resultBusy.value = true; results.value = []; result.value = undefined; resultCursor.value = null;
  const currentRequest = () => alive && token === generation && requestToken === resultGeneration;
  try {
    const value = await props.request<Submission>(`/submissions/${id}`, { signal: life.signal }); if (!currentRequest()) return;
    result.value = value; if (value.release_status !== 'released') return;
    const append = next && revision === value.effective_grading_revision;
    const q = new URLSearchParams({ limit: '20', grading_revision: String(value.effective_grading_revision) }); if (append && cursor) q.set('cursor', cursor);
    const page = await props.request<ResultPage>(`/submissions/${id}/items?${q}`, { signal: life.signal }); if (!currentRequest()) return;
    if (page.grading_revision !== value.effective_grading_revision) throw new ApiError(409, '评分修订已变化，请刷新结果。');
    results.value = append ? [...previous, ...page.items] : page.items; resultCursor.value = page.next_cursor;
  } catch (cause) { if (currentRequest()) { result.value = undefined; results.value = []; resultCursor.value = null; fail(cause); } }
  finally { if (currentRequest()) resultBusy.value = false; }
}
async function download(fileId: string) { const row = item.value; if (!row) return; const token = generation; try { const blob = await props.request<Blob>(`/sessions/${props.sessionId}/items/${row.id}/files/${fileId}/content`, { responseType: 'blob', signal: life.signal }); if (!alive || token !== generation) return; const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = fileId; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (cause) { fail(cause); } }
let clock = 0;
onMounted(() => { try { const value = JSON.parse(sessionStorage.getItem(storageKey) || 'null') as Recovery | null; if (value?.session_id === props.sessionId && value.user === props.identity.user.id && value.org === props.identity.context?.org_id && ['answer.save', 'session.submit'].includes(value.operation)) pending.value = value; } catch { storageBlocked.value = true; message.value = '无法读取安全恢复元数据，已禁止保存和交卷；请恢复浏览器存储并重新读取页面，不要清除存储后重复提交。'; } clock = window.setInterval(() => tick.value++, 1000); void load(); });
onBeforeUnmount(() => { alive = false; generation++; life.abort(); window.clearInterval(clock); window.clearTimeout(timer); clearSensitive(); emit('dirty', false); emit('unknown', false); });
</script>
<template>
  <section class="stack content-section" aria-label="练测会话" :aria-busy="busy">
    <header><h3>{{ meta?.mode === 'quiz' ? '考试作答' : '练习作答' }}</h3><p class="field-help">会话 {{ sessionId }} · 服务端修订 {{ meta?.revision }} · {{ meta?.status }}</p><p v-if="remaining !== null" role="timer">预计剩余 {{ remaining }} 秒；截止以服务器为准，归零后请查询状态。</p></header>
    <p v-if="error" class="notice" role="alert">{{ error }}</p><p v-if="message" role="status">{{ message }}</p>
    <ul v-if="Object.keys(fields).length" class="notice" role="alert"><li v-for="(text, name) in fields" :key="name">{{ name }}：{{ text }}</li></ul>
    <section v-if="conflict" class="notice stack" aria-label="作答冲突处理">
      <h4>检测到其他设备修改</h4><p>本地基线修订 {{ meta?.revision }}；本地修改尚未覆盖服务器。</p>
      <button class="button secondary" :disabled="comparing || busy || saving || !!pending" @click="compareRemote">{{ comparing ? '正在读取远端…' : '重新读取远端对比' }}</button>
      <template v-if="remote"><p>远端修订 {{ remote.session.revision }} · {{ remote.session.status }}</p>
        <article v-for="row in remote.items" :key="row.id"><h4>{{ row.position }}. {{ row.title }}</h4><p>远端作答：{{ answerText(row.answer, row) }}</p><p>本地作答：{{ answerText(items.find(local => local.id === row.id)?.answer ?? null, row) }}</p></article>
        <div class="actions"><button class="button secondary" :disabled="busy || saving || !!pending || remote.session.status !== 'in_progress'" @click="resolveConflict(true)">保留本地修改，采用远端修订后手动保存</button><button class="button secondary" :disabled="busy || saving || !!pending" @click="resolveConflict(false)">丢弃本地修改，采用远端作答</button></div>
      </template>
    </section>
    <div class="actions"><button class="button secondary" :disabled="busy || saving || comparing" @click="load">重新读取服务器状态</button><button v-if="pending" class="button secondary" :disabled="busy || saving" @click="recover">查询原请求结果</button><button v-if="pending" class="button secondary" :disabled="busy || saving || (pending.operation === 'answer.save' && pendingBody === undefined)" @click="replay()">原键重试</button></div>
    <template v-if="item && !result"><nav class="content-toolbar" aria-label="题目导航"><button v-for="(row, index) in items" :key="row.id" class="button secondary" :aria-current="current === index ? 'page' : undefined" @click="current = index">{{ index + 1 }}{{ row.answer ? ' · 已填' : '' }}</button></nav><section class="stack"><h3>{{ current + 1 }}. {{ item.title }}</h3><p class="reading-body">{{ item.prompt }}</p><p class="field-help">满分 {{ item.max_score }} · {{ dirty ? '有未确认作答' : '作答已与服务器一致' }}</p><fieldset class="content-fields" :disabled="!editable"><legend>你的作答</legend><div v-if="item.question_type === 'numeric'" class="field"><label :for="`answer-${item.id}`">数值（支持十进制与科学计数法，不含单位）</label><input :id="`answer-${item.id}`" :value="item.answer && 'value' in item.answer ? item.answer.value : ''" maxlength="100" autocomplete="off" @input="changed({ value: ($event.target as HTMLInputElement).value })" /></div><label v-for="option in item.options" v-else :key="option.id" class="check-label"><input :type="item.question_type === 'single' ? 'radio' : 'checkbox'" :name="item.id" :checked="checked(option.id)" @change="choice(option.id, ($event.target as HTMLInputElement).checked)" />{{ option.text }}</label><button type="button" class="text-button" @click="changed(null)">清空本题作答</button></fieldset><div class="actions"><button v-for="file in item.resource_ids" :key="file" class="button secondary" @click="download(file)">下载题目附件 {{ file }}</button></div></section><div class="actions"><button class="button secondary" :disabled="!editable || saving || !dirty" @click="flush().catch(fail)">{{ saving ? '正在串行保存…' : '保存作答' }}</button><button class="button" :disabled="!editable || saving" @click="submit">确认交卷</button></div></template>
    <section v-if="result" class="stack" aria-label="评分结果"><h3>批改与发布</h3><p>批改状态：{{ result.grading_status }} · 发布状态：{{ result.release_status }}</p><p v-if="result.error_code">原因：{{ result.error_code }}。无需重新交卷，请等待管理员复核。</p><p v-if="result.release_status === 'released'">总分 {{ result.total_score }} / {{ result.max_score }} · 有效评分修订 {{ result.effective_grading_revision }}</p><p v-else>当前不能展示成绩与解析；既有提交保留，请稍后查询。</p><p class="field-help">学情在独立入口按当前可见证据异步生成；评分结果发布不代表学情报告已生成。</p><button class="button secondary" :disabled="resultBusy" @click="loadResult(result.id)">刷新评分结果</button><article v-for="row in results" :key="row.id" class="stack content-section"><h4>{{ row.title }}</h4><p class="reading-body">{{ row.prompt }}</p><p>你的作答：{{ row.student_answer }}</p><p>判定 {{ row.verdict }} · {{ row.score }} / {{ row.max_score }}</p><p>标准答案：{{ row.standard_answer }}</p><p class="reading-body">{{ row.explanation }}</p></article><button v-if="resultCursor" class="button secondary" :disabled="resultBusy" @click="loadResult(result.id, true)">加载更多结果</button></section>
  </section>
</template>
