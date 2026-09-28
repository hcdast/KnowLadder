<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ApiError, type BusinessRequest } from "../session";
import type { components } from "../api/schema";
type Event = components["schemas"]["LearningReadingEvent"];
type Result = components["schemas"]["LearningReadingResult"];
type Progress = components["schemas"]["LearningReadingProgress"];
type Page = components["schemas"]["LearningReadingPage"];
const props = defineProps<{ request: BusinessRequest; editionId: string; editionRevision: number; chapterId: string; body: string }>();
const emit = defineEmits<{ pending: [value: boolean]; error: [cause: unknown] }>();
const bodyElement = ref<HTMLElement>();
const ready = ref(false), saving = ref(false), comparing = ref(false), conflicted = ref(false);
const message = ref(""), measurement = ref(""), offset = ref(0), completed = ref(false);
const confirmed = ref({ offset: 0, completed: false });
const revision = ref(0), remote = ref<Progress>(), frozen = ref<Event>();
const changed = computed(() => offset.value !== confirmed.value.offset || completed.value !== confirmed.value.completed);
const pending = computed(() => changed.value || !!frozen.value || saving.value || conflicted.value);
watch(pending, value => emit("pending", value), { flush: "sync" });
const life = new AbortController();
let alive = true, debounce = 0, maximum = 0, frame = 0, restoreFrame = 0, restoring = false;
let flight: Promise<void> | undefined;
const waits = new Map<number, () => void>();
function clearTimers() { window.clearTimeout(debounce); window.clearTimeout(maximum); debounce = 0; maximum = 0; }
function legal(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= props.body.length && !(value > 0 && value < props.body.length && /[\uD800-\uDBFF]/.test(props.body[value - 1]!) && /[\uDC00-\uDFFF]/.test(props.body[value]!));
}
function boundary(value: number) { return legal(value) ? value : Math.max(0, value - 1); }
function textNode() {
  const element = bodyElement.value;
  if (!element || element.textContent !== props.body) return;
  return element.firstChild?.nodeType === Node.TEXT_NODE ? element.firstChild as Text : undefined;
}
function characterRect(node: Text, value: number) {
  const range = document.createRange();
  const start = boundary(Math.min(value, Math.max(0, props.body.length - 1)));
  range.setStart(node, start);
  range.setEnd(node, Math.min(props.body.length, start + ((props.body.codePointAt(start) || 0) > 0xffff ? 2 : 1)));
  return Array.from(range.getClientRects()).find(rect => rect.height > 0 && rect.width > 0);
}
function measure() {
  if (!ready.value || restoring || !alive) return;
  const node = textNode();
  if (node && props.body.length) {
    // The body is one verbatim pre-wrapped Text node. Search by line, then
    // inspect visible characters; every offset addresses the original UTF-16.
    let low = 0, high = props.body.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2), rect = characterRect(node, mid);
      if (!rect) break;
      if (rect.bottom <= 0) low = mid + 1; else high = mid;
    }
    for (let index = boundary(low); index < props.body.length;) {
      const rect = characterRect(node, index);
      if (rect && rect.top >= window.innerHeight) break;
      if (rect && rect.bottom > 0 && rect.right > 0 && rect.left < window.innerWidth) { offset.value = index; measurement.value = ""; return; }
      index += (props.body.codePointAt(index) || 0) > 0xffff ? 2 : 1;
    }
  }
  offset.value = confirmed.value.offset;
  measurement.value = "当前无法测量可见正文字符；保留已确认位置（未记录时为章节起点），不估算滚动进度。";
}
async function restore(value: number) {
  restoring = true; window.cancelAnimationFrame(frame); frame = 0;
  await nextTick();
  if (!alive) return;
  const node = textNode(), rect = node && props.body.length ? characterRect(node, value) : undefined;
  if (rect) window.scrollBy({ top: rect.top, behavior: "instant" });
  else measurement.value = "无法定位正文字符，保留确认位置；可继续阅读后手动保存。";
  window.cancelAnimationFrame(restoreFrame);
  restoreFrame = window.requestAnimationFrame(() => { restoring = false; });
}
function fail(cause: unknown) {
  if (!alive) return;
  message.value = cause instanceof Error ? cause.message : "阅读进度请求未完成";
  if (cause instanceof ApiError) {
    message.value += `${cause.retryAfter ? `；请等待 Retry-After：${cause.retryAfter} 后重试` : ""}${cause.requestId ? `（请求编号 ${cause.requestId}）` : ""}`;
    if ([401, 403, 404].includes(cause.status) || cause.code === "CONTENT_UNAVAILABLE") {
      alive = false; ready.value = false; clearTimers(); life.abort();
      window.cancelAnimationFrame(frame); window.cancelAnimationFrame(restoreFrame); frame = 0; restoreFrame = 0; restoring = false;
      for (const [timer, resolve] of waits) { window.clearTimeout(timer); resolve(); } waits.clear();
      frozen.value = undefined; remote.value = undefined; offset.value = 0; completed.value = false; confirmed.value = { offset: 0, completed: false };
      revision.value = 0; measurement.value = ""; conflicted.value = false; saving.value = false; comparing.value = false;
      emit("pending", false); emit("error", cause);
    } else if (cause.code === "READING_CONTENT_CHANGED") {
      clearTimers(); frozen.value = undefined; remote.value = undefined; conflicted.value = true;
      message.value += " 请重新加载教材后继续阅读；不会把旧位置写入新正文。";
    }
  }
}
async function head() {
  const query = new URLSearchParams({ textbook_edition_id: props.editionId, chapter_id: props.chapterId });
  const page = await props.request<Page>(`/me/reading-progress?${query}`, { signal: life.signal });
  if (!alive) return;
  if (page.textbook_edition_id !== props.editionId || page.edition_revision !== props.editionRevision) throw new ApiError(409, "教材修订已改变，请重新加载教材；不会把旧位置写入新正文。", {}, "", "", "READING_CONTENT_CHANGED");
  const value = page.items.find(item => item.chapter_id === props.chapterId);
  if (!value) throw new Error("服务端未返回当前章节进度，请重试读取。");
  if (value.edition_revision !== props.editionRevision || (value.position && !legal(value.position.offset_utf16))) throw new ApiError(409, "进度不属于当前正文的合法字符位置，请重新加载教材。", {}, "", "", "READING_CONTENT_CHANGED");
  return value;
}
function adopt(value: Progress) { revision.value = value.progress_revision; offset.value = value.position?.offset_utf16 ?? 0; completed.value = value.completed ?? false; confirmed.value = { offset: offset.value, completed: completed.value }; }
async function initialize() {
  if (!alive || comparing.value || ready.value) return;
  comparing.value = true; message.value = "正在读取最后确认的阅读位置…";
  try { const value = await head(); if (!alive || !value) return; adopt(value); ready.value = true; message.value = value.position ? "已恢复服务端确认的阅读位置。" : "此章节尚未记录阅读位置。"; await restore(offset.value); }
  catch (cause) { fail(cause); }
  finally { if (alive) comparing.value = false; }
}
async function compare() {
  if (comparing.value || !alive) return;
  comparing.value = true; remote.value = undefined;
  try { const value = await head(); if (alive) remote.value = value; }
  catch (cause) { fail(cause); }
  finally { if (alive) comparing.value = false; }
}
function schedule() {
  if (!ready.value || conflicted.value || frozen.value || !changed.value) return;
  window.clearTimeout(debounce); debounce = window.setTimeout(() => { void flush(); }, 2000);
  if (!maximum) maximum = window.setTimeout(() => { void flush(); }, 5000);
}
function scroll() { if (restoring || frame || !ready.value) return; frame = window.requestAnimationFrame(() => { frame = 0; measure(); schedule(); }); }
function resize() { if (ready.value) void restore(offset.value); }
async function send() {
  const event = frozen.value;
  if (!event || !alive) return;
  saving.value = true; message.value = "正在确认阅读进度…";
  try {
    const result = await props.request<Result>("/behavior-events", { method: "POST", body: event, signal: life.signal });
    if (!alive) return;
    if (result.event_id !== event.event_id) throw new Error("阅读事件回执不匹配，请恢复原请求。");
    revision.value = result.progress_revision; confirmed.value = { offset: event.position.offset_utf16, completed: event.completed };
    // A replay receipt is historical: read the current head before a new event.
    const latest = await head();
    if (!alive || !latest) return;
    frozen.value = undefined;
    if (latest.progress_revision !== result.progress_revision) { conflicted.value = true; remote.value = latest; clearTimers(); message.value = "另一设备已更新阅读进度。自动保存已停止，请明确选择。"; }
    else message.value = "阅读位置与已读状态已获服务端确认。";
  } catch (cause) {
    if (!alive) return;
    if (cause instanceof ApiError && cause.status === 409 && cause.code === "READING_REVISION_CONFLICT") { frozen.value = undefined; conflicted.value = true; clearTimers(); fail(cause); await compare(); }
    else { fail(cause); if (frozen.value) message.value += " 原事件结果待确认；仅可重试相同事件，期间不会发送新事件。"; }
  } finally { if (alive) saving.value = false; }
}
function flush(): Promise<void> {
  clearTimers();
  if (flight) return flight;
  if (!alive || !ready.value || conflicted.value || !props.body.length) return Promise.resolve();
  if (!frozen.value && changed.value) frozen.value = { event_type: "reading_progress_set", event_id: crypto.randomUUID(), textbook_edition_id: props.editionId, chapter_id: props.chapterId, edition_revision: props.editionRevision, expected_revision: revision.value, position: { kind: "text_offset", offset_utf16: offset.value }, completed: completed.value };
  if (!frozen.value) return Promise.resolve();
  flight = send().finally(() => { flight = undefined; if (alive) schedule(); });
  return flight;
}
async function resolve(keepLocal: boolean) {
  const value = remote.value;
  if (!value || saving.value || comparing.value) return;
  if (keepLocal && !window.confirm("确认以本页位置和已读状态覆盖当前服务器进度？")) return;
  if (keepLocal) { revision.value = value.progress_revision; confirmed.value = { offset: value.position?.offset_utf16 ?? 0, completed: value.completed ?? false }; }
  else { adopt(value); await restore(offset.value); }
  conflicted.value = false; remote.value = undefined; message.value = keepLocal ? "已明确选择本页进度，正在确认保存。" : "已采用服务器进度。";
  if (keepLocal) await flush();
}
function mark() { if (!ready.value || conflicted.value || frozen.value || !props.body.length) return; measure(); completed.value = !completed.value; void flush(); }
function saveNow() { measure(); void flush(); }
async function beforeLeave() {
  if (!alive) return true;
  if (!conflicted.value && !frozen.value) measure();
  if (!pending.value) return true;
  let timeout = 0, expired = false;
  await Promise.race([
    (async () => { await flush(); if (alive && !expired && changed.value && !conflicted.value && !frozen.value) await flush(); })(),
    new Promise<void>(resolve => { timeout = window.setTimeout(() => { expired = true; resolve(); }, 5000); waits.set(timeout, resolve); }),
  ]);
  window.clearTimeout(timeout); waits.delete(timeout);
  return !alive || !pending.value || window.confirm("阅读进度尚未确认。离开不会撤销已发送事件，未确认的本地位置可能丢失；确定仍要离开？");
}
function beforeUnload(event: BeforeUnloadEvent) { if (pending.value) { event.preventDefault(); event.returnValue = ""; } }
onMounted(() => { window.addEventListener("scroll", scroll, { passive: true }); window.addEventListener("resize", resize); window.addEventListener("beforeunload", beforeUnload); void initialize(); });
onBeforeUnmount(() => { alive = false; clearTimers(); life.abort(); window.cancelAnimationFrame(frame); window.cancelAnimationFrame(restoreFrame); for (const [timer, resolve] of waits) { window.clearTimeout(timer); resolve(); } waits.clear(); window.removeEventListener("scroll", scroll); window.removeEventListener("resize", resize); window.removeEventListener("beforeunload", beforeUnload); frozen.value = undefined; remote.value = undefined; emit("pending", false); });
defineExpose({ beforeLeave });
</script>

<template>
  <p ref="bodyElement" class="reading-body">{{ body }}</p>
  <section class="content-section stack" aria-label="阅读进度" :aria-busy="saving || comparing">
    <p role="status">{{ message }}</p>
    <p v-if="measurement" class="notice" role="status">{{ measurement }}</p>
    <p class="field-help">{{ completed ? '已标记已读' : '未标记已读' }} · 已确认 UTF-16 位置 {{ confirmed.offset }} · 进度修订 {{ revision }}。已读仅由你明确标记，回读允许位置向前移动；附件不自动计入进度。</p>
    <p class="field-help">刷新将从服务端最后确认位置恢复；未确认本地位置可能丢失。正文和位置不保存到浏览器存储。</p>
    <p v-if="!body.length" class="notice">此章节没有正文，不能登记正文阅读位置或已读状态；附件阅读不计入进度。</p>
    <div class="actions">
      <button v-if="!ready" class="button secondary" :disabled="comparing" @click="initialize">重试读取阅读进度</button>
      <button class="button secondary" :disabled="!ready || saving || conflicted || !!frozen || !body.length" @click="mark">{{ completed ? '取消已读' : '标记已读' }}</button>
      <button class="button secondary" :disabled="!ready || saving || conflicted || !!frozen || !body.length" @click="saveNow">保存当前阅读位置</button>
      <button v-if="frozen" class="button" :disabled="saving" @click="flush">使用原事件恢复确认</button>
    </div>
    <div v-if="conflicted" class="notice stack" role="alert">
      <p>检测到跨设备或正文修订冲突，自动保存已暂停，本页位置仍保留在内存。</p>
      <p v-if="remote">服务器位置 {{ remote.position?.offset_utf16 ?? 0 }} · {{ remote.completed ? '已读' : '未读' }} · 修订 {{ remote.progress_revision }}</p>
      <div class="actions"><button class="button secondary" :disabled="comparing" @click="compare">重新读取服务器进度</button><button class="button secondary" :disabled="!remote || comparing" @click="resolve(false)">采用服务器位置</button><button class="button" :disabled="!remote || comparing" @click="resolve(true)">明确用本页进度覆盖</button></div>
    </div>
  </section>
</template>
