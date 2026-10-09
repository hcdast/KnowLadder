<script setup lang="ts">
import BrandIcon from '../components/BrandIcon.vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ApiError, type BusinessRequest, type Identity } from "../session";
import ImportProvenance from "./ImportProvenance.vue";
import TextbookImport from "./TextbookImport.vue";
import FileUpload from "./FileUpload.vue";
import ReadingProgress from "./ReadingProgress.vue";
import ResourceTable from "../administration/components/ResourceTable.vue";
import StatusBadge from "../administration/components/StatusBadge.vue";
import type { AuditEvent, Chapter, ChapterPage, ContentOptions, FileRecord, Kind, Page, ReaderChapter, Version } from "./types";
const props = defineProps<{ identity: Identity; request: BusinessRequest; readingTarget?: { editionId: string; chapterId: string }; platform?: boolean; consolePresentation?: boolean }>();
const versionStatusLabels: Record<Version["status"], string> = { draft: "草稿", review: "待审核", published: "已发布", retired: "已停用" };
const emit = defineEmits<{ dirty: [value: boolean]; readingPending: [value: boolean] }>();
const readingProgress = ref<InstanceType<typeof ReadingProgress>>();
let leaving: Promise<boolean> | undefined;
function beforeLeave(): Promise<boolean> {
  if (!leaving) leaving = (readingProgress.value?.beforeLeave() ?? Promise.resolve(true)).finally(() => { leaving = undefined; });
  return leaving;
}
defineExpose({ beforeLeave });
const capabilities = computed(() => props.identity.context?.capabilities || []);
const manage = computed(() => capabilities.value.some(value => ["content:edit", "content:review"].includes(value)));
const canEdit = computed(() => capabilities.value.includes("content:edit"));
const canReview = computed(() => capabilities.value.includes("content:review"));
const learner = computed(() => !props.platform && capabilities.value.includes("learning:self") && !props.identity.context?.student_conflict && !capabilities.value.some(cap => ["content:edit", "content:review", "assessment:manage", "assessment:review"].includes(cap)));
const canRead = computed(() => !props.platform && (manage.value || learner.value));
const mode = ref<"manage" | "read">(manage.value ? "manage" : "read");
const kind = ref<Kind>("textbook");
const status = ref("");
const textbookFilter = ref("");
const items = ref<Version[]>([]);
const cursor = ref<string | null>(null);
const selected = ref<Version>();
const versionHeading = ref<HTMLElement>();
const saveNotice = ref<HTMLElement>();
const chapterHeading = ref<HTMLElement>();
const draft = ref<Version>();
const original = ref("");
const pendingSave = ref<{ value: Version; metadataRevision?: number }>();
const source = ref<Version>();
const audit = ref<AuditEvent[]>([]);
const auditCursor = ref<string | null>(null);
const auditBusy = ref(false);
let auditController: AbortController | undefined;
function resetAudit() {
  auditController?.abort();
  auditController = undefined;
  auditBusy.value = false;
  audit.value = []; auditCursor.value = null;
}
const fileEpoch = ref(0);
const options = ref<ContentOptions>({ education_stages: [], subjects: [], knowledge_points: [] });
const loading = ref(false);
const error = ref("");
let reportedCause: unknown;
const fieldErrors = ref<Record<string, string>>({});
watch(error, value => { reportedCause = undefined; if (!value) fieldErrors.value = {}; }, { flush: "sync" });
function focusField(field: string) {
  const names: Record<string, string> = creating.value
    ? { title: "new-title", prompt: "new-prompt", answer: "new-answer", options: "new-options", subject_id: "new-subject", question_type: "new-type", edition_code: "new-edition", textbook_id: "existing-identity", question_id: "existing-identity", textbook: "new-stage", license: "new-source" }
    : { title: "content-name", prompt: "question-prompt", answer: "question-answer", explanation: "question-explanation", subject_id: "question-subject", question_type: "question-type", knowledge_point_ids: "question-knowledge", knowledge_weights: "question-knowledge", difficulty_basis: "difficulty-basis", difficulty: "difficulty", scoring_rule: "max-score", license: "license-source", reason: "review-reason", retention_until: "file-retention" };
  const chapter = /^chapters\.(\d+)\.(title|body|knowledge_point_ids|resource_ids|parent_id)/.exec(field);
  const chapterId = chapter ? draft.value?.chapters?.[Number(chapter[1])]?.id : undefined;
  const parts: Record<string, string> = { title: "title", body: "body", knowledge_point_ids: "knowledge", resource_ids: "files", parent_id: "parent" };
  const weight = /^knowledge_weights\.(\d+)\./.exec(field);
  const weightId = weight ? draft.value?.knowledge_weights?.[Number(weight[1])]?.knowledge_point_id : undefined;
  const option = /^options\.(\d+)\.(id|text)/.exec(field);
  const id = chapter && chapterId ? `chapter-${parts[chapter[2] || ""]}-${chapterId}` : weightId ? `weight-${weightId}` : option && !creating.value ? `option-${option[2]}-${option[1]}` : names[field.split(".")[0] || ""];
  const target = id ? document.getElementById(id) : null;
  let details = target?.closest("details");
  while (details) {
    details.open = true;
    details = details.parentElement?.closest("details") ?? null;
  }
  target?.focus();
}
const notice = ref("");
const conflict = ref(false);
const errorSummary = ref<HTMLElement>();
const createDialog = ref<HTMLDialogElement>();
const createTitle = ref("");
const stageId = ref("");
const subjectId = ref("");
const editionCode = ref("");
const licenseSource = ref("");
const existingIdentity = ref("");
const createQuestionType = ref<"single" | "multiple" | "numeric">("single");
const createPrompt = ref("");
const createOptions = ref("");
const createAnswer = ref("");
const reason = ref("");
const creating = ref(false);
const cloneCodes = new Map<string, string>();
const preview = ref(false);
const readerChapters = ref<Chapter[]>([]);
const readerChapter = ref<ReaderChapter>();
const knowledge = ref<unknown>();
let knowledgeSerial = 0;
const localLicenseExpiry = computed(() => {
  const expiry = draft.value?.license.expires_at;
  if (!expiry) return "";
  const date = new Date(expiry);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
});
function updateLicenseExpiry(event: Event) {
  if (!draft.value) return;
  const value = (event.target as HTMLInputElement).value;
  if (value === localLicenseExpiry.value) return;
  draft.value.license.expires_at = value ? new Date(value).toISOString() : null;
}
let life = new AbortController();
let alive = true;
let serial = 0;
let dialogTrigger: HTMLElement | null = null;
const retries = new Map<string, string>();
const importDirty = ref(false);
const draftDirty = computed(() => !!pendingSave.value || (!!draft.value && JSON.stringify(draft.value) !== original.value) || (creating.value && !!(createTitle.value || licenseSource.value || createPrompt.value || createOptions.value || createAnswer.value)));
const dirty = computed(() => draftDirty.value || importDirty.value);
const savedResourceIds = computed(() => {
  const value = original.value ? JSON.parse(original.value) as Version : undefined;
  return [...(value?.resource_ids || []), ...(value?.chapters || []).flatMap(chapter => chapter.resource_ids)];
});
const editable = computed(() => !!draft.value && !selected.value?.access_revoked_at && draft.value.status === "draft" && canEdit.value);
const selfReview = computed(() => !!selected.value && (selected.value.created_by === props.identity.user.id || selected.value.contributors.includes(props.identity.user.id)));
const route = computed(() => kind.value === "textbook" ? "textbook-editions" : "question-versions");
watch(dirty, value => emit("dirty", value));
watch(error, async value => { if (value) { await nextTick(); errorSummary.value?.focus(); } });
watch(() => draft.value?.knowledge_point_ids?.join(","), () => {
  if (!draft.value || kind.value !== "question") return;
  const current = draft.value.knowledge_weights || [];
  draft.value.knowledge_weights = (draft.value.knowledge_point_ids || []).map(id => current.find(item => item.knowledge_point_id === id) || { knowledge_point_id: id, weight_bps: 0 });
});
function scoringStrategy() {
  if (draft.value?.scoring_rule) draft.value.scoring_rule.strategy = draft.value.question_type === "single" ? "single_exact" : draft.value.question_type === "multiple" ? "multiple_exact_set" : "numeric_exact_decimal";
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = ""; } }
onMounted(() => { window.addEventListener("beforeunload", beforeUnload); void initialize(); });
onBeforeUnmount(() => { alive = false; serial++; life.abort(); resetAudit(); retries.clear(); window.removeEventListener("beforeunload", beforeUnload); emit("dirty", false); emit("readingPending", false); });
function mayLeave() { return !dirty.value || window.confirm("有尚未保存的本地草稿，确定放弃并离开？"); }
async function mutation<T>(path: string, method: "POST" | "PATCH" | "PUT", body: unknown): Promise<T> {
  const fingerprint = JSON.stringify([path, method, body]);
  const key = retries.get(fingerprint) || crypto.randomUUID();
  retries.set(fingerprint, key);
  const result = await props.request<T>(path, { method, body, idempotencyKey: key, signal: life.signal });
  retries.delete(fingerprint);
  return result;
}
function report(cause: unknown) {
  if (!alive || (cause instanceof DOMException && cause.name === "AbortError")) return;
  conflict.value = cause instanceof ApiError && cause.status === 409 && cause.code !== "CONTENT_UNAVAILABLE";
  error.value = cause instanceof Error ? cause.message : "请求未完成";
  if (cause instanceof ApiError) {
    fieldErrors.value = cause.fields;
    error.value += `${cause.retryAfter ? ` 请等待 Retry-After：${cause.retryAfter} 后重试。` : ""}${cause.requestId ? `（请求编号 ${cause.requestId}）` : ""}`;
  }
  if (cause instanceof ApiError && ([401, 403, 404].includes(cause.status) || cause.code === "CONTENT_UNAVAILABLE")) {
    serial += 1; knowledgeSerial += 1;
    life.abort(); life = new AbortController();
    loading.value = false; resetAudit();
    selected.value = undefined; draft.value = undefined; source.value = undefined; readerChapters.value = []; readerChapter.value = undefined; knowledge.value = undefined; audit.value = []; items.value = [];
    pendingSave.value = undefined; original.value = ""; auditCursor.value = null; cursor.value = null; retries.clear();
    error.value = "当前内容不可访问，请重新确认组织及权限。";
  }
  if (conflict.value) error.value += " 本地草稿未被覆盖。请复制需保留的内容后重新加载最新版本，再合并修改；不会盲目重放。";
  reportedCause = cause;
}
function clearRecoveredError(cause: unknown) {
  if (cause === undefined || cause !== reportedCause) return;
  error.value = "";
  fieldErrors.value = {};
  conflict.value = false;
}
async function initialize() {
  if (!manage.value && !learner.value) { notice.value = "当前身份没有许可阅读资格或内容编辑 / 审核读取权，未请求教材正文。"; return; }
  if (manage.value) {
    try { const result = await props.request<ContentOptions>("/admin/content-options", { signal: life.signal }); if (alive) options.value = result; } catch (cause) { report(cause); }
  }
  await loadList();
  if (alive && props.readingTarget) await openReadingTarget(props.readingTarget);
}
async function loadList(next = false) {
  if (!alive || loading.value || mode.value === "read" && !canRead.value || mode.value === "manage" && !manage.value) return;
  loading.value = true; error.value = "";
  const token = ++serial;
  try {
    const query = new URLSearchParams({ limit: "20" });
    if (mode.value === "manage" && status.value) query.set("status", status.value);
    if (mode.value === "manage" && kind.value === "textbook" && textbookFilter.value.trim()) query.set("textbook_id", textbookFilter.value.trim());
    if (next && cursor.value) query.set("cursor", cursor.value);
    const result = await props.request<Page<Version>>(`/${mode.value === "manage" ? "admin/" : ""}${mode.value === "manage" ? route.value : "textbook-editions"}?${query}`, { signal: life.signal });
    if (!alive || token !== serial) return;
    items.value = next ? [...items.value, ...result.items] : result.items;
    cursor.value = result.next_cursor;
  } catch (cause) { report(cause); }
  finally { if (alive) loading.value = false; }
}
async function navigate(nextMode: "manage" | "read", nextKind: Kind = "textbook") {
  if (nextMode === "read" && !canRead.value) return;
  if (loading.value || !mayLeave() || !await beforeLeave() || !alive || loading.value) return;
  const trigger = document.activeElement instanceof HTMLButtonElement ? document.activeElement : undefined;
  resetAudit();
  mode.value = nextMode; kind.value = nextKind; selected.value = undefined; draft.value = undefined;
  pendingSave.value = undefined;
  source.value = undefined; readerChapter.value = undefined; readerChapters.value = []; knowledge.value = undefined;
  items.value = []; cursor.value = null; status.value = ""; notice.value = ""; await loadList();
  await nextTick();
  if (alive && !error.value && mode.value === nextMode && kind.value === nextKind && trigger?.isConnected && !trigger.disabled && document.activeElement === document.body) trigger.focus();
}
async function openVersion(id: string, force = false, readingLeaveConfirmed = false) {
  if (loading.value || (!force && !mayLeave()) || (!readingLeaveConfirmed && !await beforeLeave()) || !alive || loading.value) return;
  const openingDetail = !selected.value;
  resetAudit();
  loading.value = true; error.value = ""; conflict.value = false; preview.value = false;
  const token = ++serial;
  readerChapters.value = []; readerChapter.value = undefined; knowledge.value = undefined; source.value = undefined;
  try {
    const result = mode.value === "manage"
      ? await props.request<Version>(`/admin/${route.value}/${id}`, { signal: life.signal })
      : await readerEdition(id);
    if (!result || !alive || token !== serial) return;
    let chapters: Chapter[] = [];
    if (kind.value === "textbook" && !result.access_revoked_at) chapters = await loadChapters(id, result.revision);
    if (!alive || token !== serial) return;
    selected.value = result;
    if (openingDetail) {
      await nextTick();
      if (!alive || token !== serial || selected.value?.id !== id) return;
      versionHeading.value?.focus();
    }
    pendingSave.value = undefined;
    if (mode.value === "read") { readerChapters.value = chapters; return; }
    draft.value = result.access_revoked_at ? undefined : JSON.parse(JSON.stringify({ ...result, ...(kind.value === "textbook" ? { chapters } : {}) }));
    if (draft.value && kind.value === "question") {
      draft.value.knowledge_weights ||= []; draft.value.difficulty_basis ||= "";
      draft.value.options ||= []; draft.value.knowledge_point_ids ||= [];
    }
    original.value = JSON.stringify(draft.value) || "";
    fileEpoch.value += 1;
    await loadAudit(false);
    if (!alive || token !== serial) return;
    if (result.source_version_id && !result.access_revoked_at) {
      const previous = await props.request<Version>(`/admin/${route.value}/${result.source_version_id}`, { signal: life.signal });
      if (alive && token === serial) source.value = previous;
    }
  } catch (cause) { if (alive && token === serial) report(cause); }
  finally { if (alive && token === serial) loading.value = false; }
}
async function loadChapters(id: string, revision?: number) {
  const chapters: Chapter[] = [];
  let next: string | null = null;
  do {
    const query = new URLSearchParams({ limit: "50" });
    if (next) query.set("cursor", next);
    if (revision !== undefined) query.set("edition_revision", String(revision));
    const page = await props.request<ChapterPage>(`/${mode.value === "manage" ? "admin/" : ""}textbook-editions/${id}/chapters?${query}`, { signal: life.signal });
    if (!alive) throw new DOMException("已离开页面", "AbortError");
    if (revision !== undefined && revision !== page.edition_revision) throw new ApiError(409, "目录修订已改变，请重新加载完整目录。");
    revision = page.edition_revision; chapters.push(...page.items); next = page.next_cursor;
  } while (next);
  const ordered: Chapter[] = [];
  const visit = (parent: string | null) => chapters.filter(chapter => chapter.parent_id === parent).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).forEach(chapter => { ordered.push(chapter); visit(chapter.id); });
  visit(null);
  return ordered;
}
async function loadAudit(next = true) {
  if (!selected.value || auditBusy.value) return;
  const token = serial;
  const request = new AbortController();
  auditController = request;
  auditBusy.value = true;
  const current = () => alive && token === serial && auditController === request && !request.signal.aborted;
  try {
    const query = new URLSearchParams({ resource_type: kind.value, resource_id: selected.value.id, limit: "20" });
    if (next && auditCursor.value) query.set("cursor", auditCursor.value);
    const page = await props.request<Page<AuditEvent>>(`/admin/audit-events?${query}`, { signal: request.signal });
    if (!current()) return;
    audit.value = next ? [...audit.value, ...page.items] : page.items; auditCursor.value = page.next_cursor;
  } catch (cause) { if (current()) report(cause); }
  finally {
    if (alive && auditController === request) {
      auditController = undefined;
      auditBusy.value = false;
    }
  }
}
async function save() {
  if (!draft.value || !editable.value || loading.value || conflict.value || importDirty.value) return;
  loading.value = true; error.value = "";
  try {
    pendingSave.value ||= { value: JSON.parse(JSON.stringify(draft.value)) as Version };
    const plan = pendingSave.value;
    const value = plan.value;
    const body = kind.value === "textbook" ? { title: value.title, license: value.license, resource_ids: value.resource_ids } : { title: value.title, license: value.license, resource_ids: value.resource_ids, subject_id: value.subject_id, question_type: value.question_type, prompt: value.prompt, options: value.question_type === "numeric" ? [] : value.options, answer: value.answer, explanation: value.explanation, knowledge_point_ids: value.knowledge_point_ids, difficulty: value.difficulty, scoring_rule: value.scoring_rule ?? null, knowledge_weights: value.knowledge_weights || [], difficulty_basis: value.difficulty_basis || "" };
    if (plan.metadataRevision === undefined) {
      const saved = await mutation<Version>(`/admin/${route.value}/${value.id}`, "PATCH", { ...body, expected_revision: value.revision });
      if (!alive) return;
      plan.metadataRevision = saved.revision;
      draft.value.revision = saved.revision;
    }
    if (kind.value === "textbook") {
      const chapters = (value.chapters || []).map((chapter, position) => ({ ...(chapter.id.startsWith("new:") ? {client_key:chapter.id} : {id:chapter.id}), ...(chapter.parent_id?.startsWith("new:") ? {parent_client_key:chapter.parent_id} : {parent_id:chapter.parent_id}), position, title: chapter.title, body: chapter.body, knowledge_point_ids: chapter.knowledge_point_ids, resource_ids: chapter.resource_ids }));
      const updated = await mutation<Version>(`/admin/${route.value}/${value.id}/chapters`, "PUT", { expected_revision: plan.metadataRevision, chapters });
      if (!alive) return;
      draft.value.revision = updated.revision;
    }
    pendingSave.value = undefined;
    notice.value = "草稿已保存。送审前请确认授权和附件。";
    loading.value = false; await openVersion(value.id, true);
    await nextTick();
    if (alive && !error.value && selected.value?.id === value.id && document.activeElement === document.body) saveNotice.value?.focus();
  } catch (cause) {
    if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 429) pendingSave.value = undefined;
    report(cause);
  }
  finally { if (alive) loading.value = false; }
}
function newChapter() {
  draft.value?.chapters?.push({ id: `new:${crypto.randomUUID()}`, parent_id: null, position: draft.value.chapters.length, title: "", body: "", knowledge_point_ids: [], resource_ids: [] });
}
function moveChapter(index: number, step: number) {
  const chapters = draft.value?.chapters;
  if (!chapters || index + step < 0 || index + step >= chapters.length) return;
  const [chapter] = chapters.splice(index, 1); if (chapter) chapters.splice(index + step, 0, chapter);
}
function removeChapter(id: string) {
  if (!draft.value?.chapters) return;
  draft.value.chapters = draft.value.chapters.filter(chapter => chapter.id !== id);
  draft.value.chapters.forEach(chapter => { if (chapter.parent_id === id) chapter.parent_id = null; });
}
function revisionChanged(revision: number) {
  if (!draft.value || !selected.value) return;
  draft.value.revision = revision; selected.value.revision = revision;
  const baseline = JSON.parse(original.value) as Version; baseline.revision = revision; original.value = JSON.stringify(baseline);
}
function bindFile(file: FileRecord) {
  if (draft.value && !draft.value.resource_ids.includes(file.id)) draft.value.resource_ids.push(file.id);
}
async function transition(action: "submit-review" | "return" | "publish" | "retire" | "revoke-access") {
  if (!selected.value || loading.value || dirty.value || conflict.value) return;
  if (["return", "retire", "revoke-access"].includes(action) && !reason.value.trim()) { error.value = "请填写本次操作原因。"; return; }
  const confirmation = action === "revoke-access" ? "撤销后学生与管理者均不能读取原文及附件，且不可原地恢复。确认撤销授权？" : action === "retire" ? "撤回后学生立即停止访问；合法授权下管理预览仍可使用。确认撤回发布？" : action === "publish" ? "确认授权仍有效且所有附件扫描通过，并发布此版本？" : action === "return" ? "确认退回作者修改？" : "确认提交审核？提交后无法继续编辑。";
  if (!window.confirm(confirmation)) return;
  loading.value = true; error.value = "";
  try {
    await mutation(`/admin/${route.value}/${selected.value.id}/${action}`, "POST", { ...(action === "revoke-access" ? { expected_access_revision: selected.value.access_revision } : { expected_revision: selected.value.revision }), ...(reason.value.trim() ? { reason: reason.value.trim() } : {}) });
    if (!alive) return;
    loading.value = false; reason.value = ""; notice.value = "版本状态已更新。"; await openVersion(selected.value.id, true);
  } catch (cause) { report(cause); }
  finally { if (alive) loading.value = false; }
}
function openCreate() {
  if (!mayLeave()) return;
  dialogTrigger = document.activeElement as HTMLElement;
  createTitle.value = ""; editionCode.value = ""; licenseSource.value = ""; existingIdentity.value = "";
  createPrompt.value = ""; createOptions.value = ""; createAnswer.value = "";
  creating.value = true;
  createDialog.value?.showModal();
}
function closeCreate() { creating.value = false; createDialog.value?.close(); dialogTrigger?.focus(); }
function onCreateClosed() {
  creating.value = false;
  dialogTrigger?.focus();
}
async function create(clone = false) {
  if (loading.value || (clone && (!selected.value || !mayLeave()))) return;
  if (clone && selected.value?.status !== "published") { error.value = "仅已发布版本可复制；草稿请直接编辑，待审核版本请先完成审核。"; return; }
  loading.value = true; error.value = "";
  try {
    const old = selected.value;
    if (clone && old && kind.value === "textbook" && !cloneCodes.has(old.id)) {
      const code = window.prompt("新版本号（附件将清空，需重新上传）");
      if (!code?.trim()) return;
      cloneCodes.set(old.id, code.trim());
    }
    const license = clone && old ? old.license : { source: licenseSource.value, granted: false, expires_at: null };
    let body: unknown;
    if (kind.value === "textbook") body = clone && old ? { title: old.title, source_edition_id: old.id, edition_code: cloneCodes.get(old.id) } : { title: createTitle.value, ...(existingIdentity.value.trim() ? { textbook_id: existingIdentity.value.trim() } : { textbook: { title: createTitle.value, stage_id: stageId.value, subject_id: subjectId.value, source: licenseSource.value } }), edition_code: editionCode.value, license };
    else body = clone && old ? { source_version_id: old.id } : { ...(existingIdentity.value.trim() ? { question_id: existingIdentity.value.trim() } : {}), title: createTitle.value, subject_id: subjectId.value, question_type: createQuestionType.value, prompt: createPrompt.value, options: createQuestionType.value === "numeric" ? [] : createOptions.value.split("\n").filter(text => text.trim()).map((text, index) => ({ id: String.fromCharCode(65 + index), text: text.trim() })), answer: createAnswer.value, explanation: "", knowledge_point_ids: [], difficulty: "基础", license };
    const result = await mutation<Version>(`/admin/${route.value}`, "POST", body);
    if (!alive) return;
    if (clone && old) cloneCodes.delete(old.id);
    closeCreate(); notice.value = result.copy_notice || "新草稿已创建，请完善内容、正确答案与授权信息。";
    loading.value = false; await openVersion(result.id, true);
  } catch (cause) { report(cause); }
  finally { if (alive) loading.value = false; }
}
async function readChapter(id: string) {
  if (loading.value || !await beforeLeave() || !alive || loading.value) return;
  const token = ++serial;
  knowledgeSerial += 1;
  knowledge.value = undefined;
  readerChapter.value = undefined;
  loading.value = true; error.value = "";
  try {
    const result = await props.request<ReaderChapter>(`/chapters/${id}`, { signal: life.signal });
    if (!alive || token !== serial) return;
    if (result.textbook_edition_id !== selected.value?.id || result.edition_revision !== selected.value?.revision) throw new ApiError(409, "章节与已加载目录的教材版本不一致，请重新加载完整目录。");
    readerChapter.value = result;
    await nextTick();
    if (alive && token === serial && readerChapter.value?.id === id) chapterHeading.value?.focus();
  } catch (cause) { if (token === serial) report(cause); }
  finally { if (alive && token === serial) loading.value = false; }
}
async function readerEdition(id: string) {
  let next: string | null = null;
  do {
    const query = new URLSearchParams({ limit: "50" });
    if (next) query.set("cursor", next);
    const page = await props.request<Page<Version>>(`/textbook-editions?${query}`, { signal: life.signal });
    if (!alive) return;
    const found = page.items.find(item => item.id === id);
    if (found) return found;
    next = page.next_cursor;
  } while (next);
  throw new ApiError(404, "目标教材当前不可阅读。");
}
async function openReadingTarget(target: { editionId: string; chapterId: string }) {
  if (!learner.value || loading.value || !mayLeave() || !await beforeLeave() || !alive || loading.value) return;
  mode.value = "read"; kind.value = "textbook"; draft.value = undefined; original.value = ""; pendingSave.value = undefined;
  await openVersion(target.editionId, true, true);
  if (alive && selected.value?.id === target.editionId && readerChapters.value.some(chapter => chapter.id === target.chapterId)) await readChapter(target.chapterId);
  else if (alive && !error.value) report(new ApiError(404, "目标章节当前不可阅读。"));
}
watch(() => props.readingTarget, target => { if (target) void openReadingTarget(target); });
async function readKnowledge(id: string) {
  const chapterId = readerChapter.value?.id;
  if (!chapterId || loading.value) return;
  const navigationToken = serial;
  const token = ++knowledgeSerial;
  knowledge.value = undefined;
  try {
    const result = await props.request<unknown>(`/knowledge-points/${id}`, { signal: life.signal });
    if (alive && navigationToken === serial && token === knowledgeSerial && readerChapter.value?.id === chapterId) knowledge.value = result;
  } catch (cause) {
    if (navigationToken === serial && token === knowledgeSerial && readerChapter.value?.id === chapterId) report(cause);
  }
}
async function download(id: string) {
  const token = serial;
  error.value = "";
  try {
    const blob = await props.request<Blob>(`/${mode.value === "manage" ? "admin/" : ""}files/${id}/content`, { responseType: "blob", signal: life.signal });
    if (!alive || token !== serial) return;
    const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = `附件-${id}`; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (cause) { if (alive && token === serial) report(cause); }
}
</script>

<template>
  <section class="content-workspace stack" :class="consolePresentation ? 'admin-card' : ['panel', 'learning-surface', mode === 'read' ? 'student-content' : 'editor-content']" :aria-labelledby="consolePresentation ? undefined : 'content-title'" :aria-label="consolePresentation ? '教学内容工作区' : undefined" :aria-busy="loading">
    <div v-if="!consolePresentation" class="page-heading"><p class="eyebrow"><BrandIcon name="book-open" />CONTENT / 教学内容</p><h2 id="content-title">{{ mode === 'manage' ? '教材与题库管理' : '我的教材' }}</h2><p class="muted">当前组织内的真实内容。权限、授权和扫描结果均以服务端校验为准。</p></div>
    <nav class="actions" :class="{ 'admin-toolbar': consolePresentation }" aria-label="内容导航">
      <button v-if="manage" class="button secondary" :aria-pressed="mode === 'manage' && kind === 'textbook'" :disabled="loading" @click="navigate('manage', 'textbook')">教材管理</button>
      <button v-if="manage" class="button secondary" :aria-pressed="mode === 'manage' && kind === 'question'" :disabled="loading" @click="navigate('manage', 'question')">题库管理</button>
      <button v-if="canRead" class="button secondary" :aria-pressed="mode === 'read'" :disabled="loading" @click="navigate('read')">{{ manage ? '教材阅读预览（不记录学情）' : '学生阅读' }}</button>
    </nav>
    <div v-if="error" ref="errorSummary" class="notice" tabindex="-1" role="alert"><p>{{ error }}</p><ul v-if="Object.keys(fieldErrors).length"><li v-for="(message, field) in fieldErrors" :key="field"><button class="text-button" @click="focusField(String(field))">{{ field }}：{{ message }}（定位字段）</button></li></ul><button v-if="conflict && selected" class="button secondary" :disabled="loading" @click="openVersion(selected.id)">放弃本地草稿并重新加载</button></div>
    <p v-if="notice" ref="saveNotice" tabindex="-1" class="notice" role="status">{{ notice }}</p>
    <p v-if="loading" role="status">正在请求真实数据，请稍候…</p>
    <template v-if="!selected">
      <details v-if="consolePresentation && mode === 'manage' && kind === 'textbook'" class="content-section"><summary>高级定位</summary><div class="field"><label for="textbook-filter">教材身份 ID 筛选（可选）</label><input id="textbook-filter" v-model="textbookFilter" :disabled="loading" /><p class="field-help">仅在已知教材身份 ID 时填写；不填写则按版本状态浏览全部教材。</p></div></details>
      <div v-else-if="mode === 'manage' && kind === 'textbook'" class="field"><label for="textbook-filter">教材身份 ID 筛选（可选）</label><input id="textbook-filter" v-model="textbookFilter" :disabled="loading" /></div>
      <form v-if="mode === 'manage'" class="content-toolbar" :class="{ 'admin-toolbar': consolePresentation }" @submit.prevent="loadList()"><div class="field"><label for="version-status">版本状态</label><select id="version-status" v-model="status" :disabled="loading"><option value="">全部状态</option><option value="draft">草稿</option><option value="review">待审核</option><option value="published">已发布</option><option value="retired">已停用</option></select></div><button class="button secondary" :disabled="loading">筛选</button><button v-if="canEdit" type="button" class="button" :disabled="loading" @click="openCreate">{{ kind === 'textbook' ? '新建教材版本' : '新建题目' }}</button></form>
      <ResourceTable v-if="consolePresentation && mode === 'manage'" :headers="['标题', kind === 'textbook' ? '版本号 / 修订' : '修订', '状态', '操作']" :busy="loading" :empty="!items.length" :empty-label="error ? '版本列表未能读取，请确认权限或重新筛选。' : '当前没有符合条件的版本。可调整筛选，或创建第一份草稿。'">
        <tr v-for="item in items" :key="item.id">
          <td>{{ item.title }}</td>
          <td><template v-if="kind === 'textbook'">{{ item.edition_code || '未填写版本号' }} · </template>修订 {{ item.revision }}</td>
          <td><StatusBadge :status="item.status" :label="versionStatusLabels[item.status]" /></td>
          <td><button class="button secondary" :disabled="loading" @click="openVersion(item.id)">查看与编辑</button></td>
        </tr>
      </ResourceTable>
      <template v-else>
        <p v-if="!loading && !items.length" class="content-empty">{{ mode === 'manage' ? '当前没有符合条件的版本。可调整筛选，或创建第一份草稿。' : '当前没有可阅读的已发布教材。请联系组织管理员确认内容发布与授权。' }}</p>
        <ul v-else class="content-list"><li v-for="item in items" :key="item.id"><div><h3>{{ item.title }}</h3><p class="field-help">{{ item.edition_code || `题目版本 ${item.id}` }} · {{ mode === 'read' ? '已发布' : versionStatusLabels[item.status] }}</p></div><button class="button secondary" :disabled="loading" @click="openVersion(item.id)">{{ mode === 'manage' ? '查看与编辑' : '开始阅读' }}</button></li></ul>
      </template>
      <button v-if="cursor" class="button secondary" :disabled="loading" @click="loadList(true)">加载更多</button>
    </template>
    <template v-else>
      <div class="actions"><button class="button secondary" :disabled="loading" @click="navigate(mode, kind)">返回列表</button><button class="button secondary" :disabled="loading" @click="openVersion(selected.id)">重新加载版本</button></div>
      <header class="stack"><h2 ref="versionHeading" tabindex="-1">{{ selected.title }}</h2><template v-if="consolePresentation"><p class="field-help"><template v-if="selected.edition_code">版本号 {{ selected.edition_code }} · </template>修订 {{ selected.revision }} · <StatusBadge :status="mode === 'read' ? 'published' : selected.status" :label="mode === 'read' ? '已发布' : versionStatusLabels[selected.status]" /></p><details><summary>高级定位</summary><p class="field-help">版本 ID：{{ selected.id }}</p></details></template><p v-else class="field-help">版本 ID：{{ selected.id }} · 修订 {{ selected.revision }} · {{ mode === 'read' ? '已发布' : selected.status }}</p></header>
      <p v-if="selected.access_revoked_at" class="notice">授权已撤销，原文、答案和附件不可读取。原因：{{ selected.access_revoked_reason }}</p>
      <p v-if="selected.retired_reason" class="notice">撤回原因：{{ selected.retired_reason }}</p>
      <template v-if="mode === 'manage' && draft">
        <p class="field-help">作者：{{ selected.created_by }}<br />贡献者：{{ selected.contributors.join('、') || '暂无其他贡献者' }}</p>
        <p v-if="!editable" class="notice">此版本只读。仅有编辑能力的账号可修改草稿；已发布版本可复制，待审核版本须先完成审核。</p>
        <p v-if="dirty" role="status">有未保存的本地修改。先保存，再上传附件或送审。</p>
        <p v-if="pendingSave" class="notice" role="status">保存结果尚未确认，已冻结本次内容与幂等键。再次点击恢复保存将继续原请求，不会重复创建修订。也可保留内容后重新加载核对服务端状态。</p>
        <form class="stack" :autocomplete="consolePresentation ? 'off' : undefined" novalidate @submit.prevent="save">
          <fieldset class="stack content-fields" :disabled="!editable || loading || conflict || !!pendingSave || importDirty">
            <legend>版本内容</legend>
            <div class="field"><label for="content-name">标题</label><input id="content-name" v-model="draft.title" maxlength="200" required /></div>
            <div class="content-columns"><div class="field"><label for="license-source">授权来源</label><input id="license-source" v-model="draft.license.source" required /></div><div class="field"><label for="license-expiry">授权到期时间（可选，本地时间）</label><input id="license-expiry" type="datetime-local" :value="localLicenseExpiry" @input="updateLicenseExpiry" /></div></div>
            <label class="check-label"><input v-model="draft.license.granted" type="checkbox" />确认已取得内容使用授权</label>
            <template v-if="kind === 'question'">
              <div class="content-columns"><div class="field"><label for="question-subject">学科</label><select id="question-subject" v-model="draft.subject_id"><option v-for="item in options.subjects" :key="item.id" :value="item.id">{{ item.name }}</option></select></div><div class="field"><label for="question-type">题型</label><select id="question-type" v-model="draft.question_type" @change="scoringStrategy"><option value="single">单选题</option><option value="multiple">多选题</option><option value="numeric">数值题</option></select></div><div class="field"><label for="difficulty">难度</label><select id="difficulty" v-model="draft.difficulty"><option>基础</option><option>提升</option><option>挑战</option></select></div></div>
              <div class="field"><label for="question-prompt">题干</label><textarea id="question-prompt" v-model="draft.prompt" rows="5" required maxlength="20000" /></div>
              <template v-if="draft.question_type !== 'numeric'"><div v-for="(option, index) in draft.options" :key="index" class="content-toolbar"><label :for="`option-id-${index}`">选项标识</label><input :id="`option-id-${index}`" v-model="option.id" required /><label :for="`option-text-${index}`">选项内容</label><input :id="`option-text-${index}`" v-model="option.text" required /><button type="button" class="button secondary" @click="draft.options?.splice(index, 1)">删除选项 {{ index + 1 }}</button></div><button type="button" class="button secondary" :disabled="(draft.options?.length || 0) >= 12" @click="draft.options?.push({id: String.fromCharCode(65 + draft.options.length), text: ''})">新增选项</button></template>
              <div class="field"><label for="question-answer">正确答案</label><input id="question-answer" v-model="draft.answer" required :inputmode="draft.question_type === 'numeric' ? 'decimal' : 'text'" /><p class="field-help">单选填选项标识；多选使用英文逗号分隔标识（如 A,B）；数值题填写数值。</p></div>
              <div class="field"><label for="question-explanation">解析</label><textarea id="question-explanation" v-model="draft.explanation" rows="4" /></div>
              <div class="field"><label for="question-knowledge">知识点（可多选）</label><select id="question-knowledge" v-model="draft.knowledge_point_ids" multiple><option v-for="point in options.knowledge_points.filter(point => point.subject_id === draft?.subject_id)" :key="point.id" :value="point.id">{{ point.name }}</option></select></div>
              <div v-for="weight in draft.knowledge_weights" :key="weight.knowledge_point_id" class="field"><label :for="`weight-${weight.knowledge_point_id}`">{{ options.knowledge_points.find(point => point.id === weight.knowledge_point_id)?.name || weight.knowledge_point_id }} 权重（基点）</label><input :id="`weight-${weight.knowledge_point_id}`" v-model.number="weight.weight_bps" type="number" min="1" max="10000" step="1" /></div>
              <p class="field-help">权重合计 {{ (draft.knowledge_weights || []).reduce((sum, weight) => sum + Number(weight.weight_bps), 0) }} / 10000。送审要求每项为正整数且总和为 10000。</p>
              <div class="field"><label for="difficulty-basis">难度依据</label><textarea id="difficulty-basis" v-model="draft.difficulty_basis" rows="3" maxlength="2000" /><p class="field-help">请填写真实教研依据。未完善的草稿可以保存，不能送审。</p></div>
              <button v-if="!draft.scoring_rule" type="button" class="button secondary" @click="draft.scoring_rule = {version: 1, strategy: 'single_exact', max_score: '1'}; scoringStrategy()">配置评分规则</button>
              <div v-else class="content-section stack"><p>规则版本 1 · {{ draft.scoring_rule.strategy }}（全对得分，不支持部分分或容差）</p><div class="field"><label for="max-score">满分（十进制文本，最多两位小数，0 &lt; 分值 ≤ 100）</label><input id="max-score" v-model="draft.scoring_rule.max_score" inputmode="decimal" maxlength="6" /></div><p class="field-help">数值答案保留原始十进制文本，不以 JavaScript 浮点数定义精确评分。</p></div>
            </template>
            <template v-else>
              <section v-for="(chapter, index) in draft.chapters" :key="chapter.id" class="content-section stack"><h3>章节 {{ index + 1 }}</h3><div class="field"><label :for="`chapter-title-${chapter.id}`">章节标题</label><input :id="`chapter-title-${chapter.id}`" v-model="chapter.title" required maxlength="200" /></div><div class="field"><label :for="`chapter-parent-${chapter.id}`">父级章节</label><select :id="`chapter-parent-${chapter.id}`" v-model="chapter.parent_id"><option :value="null">顶级章节</option><option v-for="parent in draft.chapters?.filter(item => item.id !== chapter.id)" :key="parent.id" :value="parent.id">{{ parent.title || '未命名章节' }}</option></select><p class="field-help">服务端校验父级与循环；删除父级后，直属子章移至顶级。</p></div><div class="field"><label :for="`chapter-body-${chapter.id}`">章节正文</label><textarea :id="`chapter-body-${chapter.id}`" v-model="chapter.body" rows="8" maxlength="20000" /></div><div class="field"><label :for="`chapter-knowledge-${chapter.id}`">章节知识点</label><select :id="`chapter-knowledge-${chapter.id}`" v-model="chapter.knowledge_point_ids" multiple><option v-for="point in options.knowledge_points" :key="point.id" :value="point.id">{{ point.name }}</option></select></div><div class="field"><label :for="`chapter-files-${chapter.id}`">章节附件（先上传并通过扫描）</label><select :id="`chapter-files-${chapter.id}`" v-model="chapter.resource_ids" multiple><option v-for="id in draft.resource_ids" :key="id" :value="id">{{ id }}</option></select></div><div class="actions"><button type="button" class="button secondary" :disabled="index === 0" @click="moveChapter(index, -1)">上移</button><button type="button" class="button secondary" :disabled="index === (draft.chapters?.length || 0) - 1" @click="moveChapter(index, 1)">下移</button><button type="button" class="button secondary" @click="removeChapter(chapter.id)">删除章节</button></div></section>
              <button type="button" class="button secondary" :disabled="(draft.chapters?.length || 0) >= 100" @click="newChapter">新增章节</button>
            </template>
          </fieldset>
          <button v-if="editable" type="submit" class="button" :disabled="loading || !draftDirty || conflict || importDirty">{{ pendingSave ? '恢复原保存请求' : '保存草稿' }}</button>
        </form>
        <ImportProvenance v-if="kind === 'textbook' && !selected.access_revoked_at && !platform" :key="selected.id+':'+selected.revision" :request="request" :owner-id="selected.id" />
        <TextbookImport v-if="kind === 'textbook' && editable && !platform" :key="`${selected.id}:${identity.context?.org_id}:${identity.user.id}`" :request="request" :version="draft" :scope="`${identity.user.id}:${identity.context?.org_id}`" :blocked="draftDirty || loading || conflict" @dirty="importDirty = $event" @applied="openVersion(selected.id, true)" />
        <section class="content-section stack"><h3>正文附件引用</h3><p v-if="!draft.resource_ids.length" class="field-help">尚未绑定附件。复制版本不会沿用旧附件，必须重新上传。</p><ul class="content-list"><li v-for="id in draft.resource_ids" :key="id"><span>{{ id }}</span><div class="actions"><button class="button secondary" @click="download(id)">管理附件预览（下载）</button><button v-if="editable" class="button secondary" :disabled="loading || conflict || !!pendingSave || importDirty" @click="draft.resource_ids = draft.resource_ids.filter(value => value !== id); draft.chapters?.forEach(chapter => chapter.resource_ids = chapter.resource_ids.filter(value => value !== id))">取消绑定</button></div></li></ul><FileUpload :key="`${selected.id}:${fileEpoch}`" :request="request" :kind="kind" :owner-id="selected.id" :revision="draft.revision" :disabled="dirty || loading || conflict" :editable="editable" :can-delete="capabilities.includes('file:delete')" :bound-ids="savedResourceIds" :local-ids="[...(draft.resource_ids || []), ...(draft.chapters || []).flatMap(chapter => chapter.resource_ids)]" @revision="revisionChanged" @ready="bindFile" @error="report" @recovered="clearRecoveredError" /></section>
        <button v-if="kind === 'question'" class="button secondary" :aria-expanded="preview" @click="preview = !preview">{{ preview ? '收起学生预览' : '学生预览（不含答案）' }}</button>
        <section v-if="preview && kind === 'question'" class="content-section stack" aria-label="学生题目预览"><h3>{{ draft.title }}</h3><p class="reading-body">{{ draft.prompt }}</p><label v-for="option in draft.question_type === 'numeric' ? [] : draft.options" :key="option.id" class="check-label"><input :type="draft.question_type === 'single' ? 'radio' : 'checkbox'" name="student-preview" />{{ option.id }}. {{ option.text }}</label><div v-if="draft.question_type === 'numeric'" class="field"><label for="preview-number">你的答案</label><input id="preview-number" inputmode="decimal" /></div><p class="field-help">仅预览题面，不提交作答、不显示答案或评分。</p></section>
        <details class="content-section"><summary>版本前后对比（源版本只读）</summary><p v-if="!source" class="field-help">此版本没有源版本。</p><div v-else class="content-columns"><section><h3>源版本</h3><pre class="content-json">{{ JSON.stringify(source, null, 2) }}</pre></section><section><h3>当前本地版本</h3><pre class="content-json">{{ JSON.stringify(draft, null, 2) }}</pre></section></div></details>
        <section class="content-section stack"><h3>审核与发布</h3><p v-if="selfReview" class="field-help">作者及贡献者不可审核自己的版本。请由另一位真实审核账号登录处理。</p><p v-if="dirty" class="field-help">保存所有本地修改后才能送审。</p><div class="field"><label for="review-reason">审核说明 / 退回或停止使用原因</label><textarea id="review-reason" v-model="reason" rows="3" maxlength="2000" :disabled="loading" /></div><div class="actions"><button v-if="editable" class="button" :disabled="loading || dirty || conflict" @click="transition('submit-review')">提交审核</button><button v-if="canReview && selected.status === 'review'" class="button secondary" :disabled="loading || selfReview || conflict" @click="transition('return')">退回修改</button><button v-if="canReview && selected.status === 'review'" class="button" :disabled="loading || selfReview || conflict" @click="transition('publish')">确认授权并发布</button><button v-if="canEdit && selected.status === 'published'" class="button secondary" :disabled="loading || conflict" @click="create(true)">复制为新版本（附件需重传）</button><button v-if="capabilities.includes('content:retire') && selected.status === 'published'" class="button secondary" :disabled="loading || dirty || conflict" @click="transition('retire')">撤回发布</button><button v-if="capabilities.includes('content:revoke')" class="button secondary" :disabled="loading || dirty || conflict" @click="transition('revoke-access')">撤销访问授权（不可恢复）</button></div></section>
      </template>
      <template v-else-if="mode === 'read'">
        <div class="reader-layout"><nav aria-label="教材目录" class="stack"><h3>目录</h3><p v-if="!readerChapters.length">这份教材暂无章节，请联系内容管理员。</p><ol class="chapter-navigation"><li v-for="chapter in readerChapters" :key="chapter.id" :class="{ 'chapter-child': chapter.parent_id }"><button class="text-button" :disabled="loading" :aria-current="readerChapter?.id === chapter.id ? 'page' : undefined" @click="readChapter(chapter.id)">{{ chapter.title }}</button><p v-if="chapter.parent_id" class="field-help">上级：{{ readerChapters.find(parent => parent.id === chapter.parent_id)?.title }}</p></li></ol></nav><article class="stack"><template v-if="readerChapter"><h3 ref="chapterHeading" tabindex="-1">{{ readerChapter.title }}</h3><ReadingProgress v-if="learner" :key="`${selected.id}:${readerChapter.id}:${readerChapter.edition_revision}`" ref="readingProgress" :request="request" :edition-id="selected.id" :edition-revision="readerChapter.edition_revision" :chapter-id="readerChapter.id" :body="readerChapter.body" @pending="emit('readingPending', $event)" @error="report" /><p v-else class="reading-body">{{ readerChapter.body }}</p><h4 v-if="readerChapter.knowledge_point_ids.length">关联知识点</h4><div class="actions"><button v-for="id in readerChapter.knowledge_point_ids" :key="id" class="button secondary" @click="readKnowledge(id)">查看知识点 {{ id }}</button></div><pre v-if="knowledge" class="content-json">{{ JSON.stringify(knowledge, null, 2) }}</pre><h4 v-if="readerChapter.resource_ids.length">章节附件</h4><button v-for="id in readerChapter.resource_ids" :key="id" class="button secondary" @click="download(id)">下载附件 {{ id }}</button></template><p v-else class="content-empty">从目录选择章节开始阅读。</p></article></div><section v-if="selected.resource_ids?.length" class="content-section stack"><h3>教材附件</h3><button v-for="id in selected.resource_ids" :key="id" class="button secondary" @click="download(id)">下载教材附件 {{ id }}</button></section>
      </template>
      <details v-if="mode === 'manage'" class="content-section"><summary>审计记录（含归属文件事件）</summary><p v-if="!audit.length">暂无可见审计记录。</p><ol><li v-for="event in audit" :key="event.id">{{ event.created_at }} · {{ event.action }} · 操作人 {{ event.actor_id }}<p>{{ event.reason }}</p><p class="field-help">{{ event.resource_type }} / {{ event.resource_id }} · 内容修订 {{ event.revision_before ?? '历史未记录' }} → {{ event.revision_after ?? '历史未记录' }} · 访问修订 {{ event.access_revision_before ?? '历史未记录' }} → {{ event.access_revision_after ?? '历史未记录' }}</p><p class="field-help">请求编号：{{ event.request_id }}</p></li></ol><button v-if="auditCursor" class="button secondary" :disabled="auditBusy || loading" @click="loadAudit()">加载更多审计记录</button></details>
    </template>
    <dialog ref="createDialog" class="content-dialog" aria-labelledby="new-content-title" @close="onCreateClosed" @cancel="loading && $event.preventDefault()">
      <form class="stack" :autocomplete="consolePresentation ? 'off' : undefined" @submit.prevent="create(false)">
        <h2 id="new-content-title">{{ kind === 'textbook' ? '新建教材版本' : '新建题目' }}</h2>
        <div v-if="error" class="notice" role="alert"><p>{{ error }}</p><ul v-if="Object.keys(fieldErrors).length"><li v-for="(message, field) in fieldErrors" :key="field"><button type="button" class="text-button" @click="focusField(String(field))">{{ field }}：{{ message }}（定位字段）</button></li></ul></div>
        <p v-if="!options.subjects.length || (kind === 'textbook' && !options.education_stages.length)" class="notice">基础目录为空。请运维使用目录导入 CLI 导入真实学段、学科和知识点后刷新页面；系统不会创建示例数据。</p>
        <div class="field"><label for="new-title">标题</label><input id="new-title" v-model="createTitle" autofocus required maxlength="200" /></div>
        <details v-if="consolePresentation" class="content-section"><summary>高级定位</summary><div class="field"><label for="existing-identity">已有{{ kind === 'textbook' ? '教材' : '题目' }}身份 ID（可选）</label><input id="existing-identity" v-model="existingIdentity" /><p class="field-help">仅在已知同组织身份 ID 时填写，可创建不复制来源的空草稿；常规新建请留空，使用学科{{ kind === 'textbook' ? '与学段' : '' }}选择。</p></div></details>
        <div v-else class="field"><label for="existing-identity">已有{{ kind === 'textbook' ? '教材' : '题目' }}身份 ID（可选）</label><input id="existing-identity" v-model="existingIdentity" /><p class="field-help">填写同组织身份 ID 可创建不复制来源的空草稿；留空则创建新身份。</p></div>
        <div v-if="kind === 'textbook' && !existingIdentity.trim()" class="field"><label for="new-stage">学段</label><select id="new-stage" v-model="stageId" required><option value="" disabled>选择学段</option><option v-for="item in options.education_stages" :key="item.id" :value="item.id">{{ item.name }}</option></select></div>
        <div class="field"><label for="new-subject">学科</label><select id="new-subject" v-model="subjectId" required><option value="" disabled>选择学科</option><option v-for="item in options.subjects" :key="item.id" :value="item.id">{{ item.name }}</option></select></div>
        <div v-if="kind === 'textbook'" class="field"><label for="new-edition">版本号</label><input id="new-edition" v-model="editionCode" required /></div>
        <template v-else>
          <div class="field"><label for="new-type">题型</label><select id="new-type" v-model="createQuestionType"><option value="single">单选题</option><option value="multiple">多选题</option><option value="numeric">数值题</option></select></div>
          <div class="field"><label for="new-prompt">题干（可稍后完善）</label><textarea id="new-prompt" v-model="createPrompt" rows="4" maxlength="20000" /></div>
          <div v-if="createQuestionType !== 'numeric'" class="field"><label for="new-options">选项内容（可选，每行一项，依次标记 A、B…）</label><textarea id="new-options" v-model="createOptions" rows="4" /></div>
          <div class="field"><label for="new-answer">正确答案（可稍后完善）</label><input id="new-answer" v-model="createAnswer" /><p class="field-help">单选填标识，多选填英文逗号分隔标识；数值题填数值。</p></div>
        </template>
        <div class="field"><label for="new-source">内容来源</label><input id="new-source" v-model="licenseSource" required /></div>
        <p class="field-help">新版本以未授权草稿创建。请完善内容并确认授权后送审。</p>
        <div class="actions"><button class="button" :disabled="loading || !options.subjects.length || (kind === 'textbook' && !options.education_stages.length)">创建草稿</button><button type="button" class="button secondary" :disabled="loading" @click="closeCreate">取消</button></div>
      </form>
    </dialog>
  </section>
</template>
