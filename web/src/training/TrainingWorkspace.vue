<script setup lang="ts">
import TrainingBatchAssign from "./TrainingBatchAssign.vue";
import TrainingWorkbench from "./TrainingWorkbench.vue";
import LearningDiscovery from "./LearningDiscovery.vue";
import LearningPaths from "./LearningPaths.vue";
import GrowthWorkspace from "./GrowthWorkspace.vue";
import LearningStudio from "./LearningStudio.vue";
import CourseMetadata from "./CourseMetadata.vue";
import TrainingSurveys from "./TrainingSurveys.vue";
import TrainingKnowledge from "./TrainingKnowledge.vue";
import { parseQuestionCandidate, type Candidate } from "./question-candidate";
import TrainingPhase2 from "./TrainingPhase2.vue";
import TrainingReports from "./TrainingReports.vue";
import CourseworkAttachments from "./CourseworkAttachments.vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { ApiError, type BusinessRequest, type Identity } from "../session";
import { canUseStudentLearning } from "../auth/entry";
type Row = Record<string, any>;
const props = defineProps<{ identity: Identity; request: BusinessRequest }>();
const emit = defineEmits<{ dirty: [boolean]; unknown: [boolean]; reading:[{editionId:string;chapterId:string}] }>();
const lifetime = new AbortController();
let viewEpoch = 0;
const request: BusinessRequest = async <T,>(path: string, options = {}) => {
  const epoch = viewEpoch;
  try {
    const result = await props.request<T>(path, {
      ...options,
      signal: lifetime.signal,
    });
    if (lifetime.signal.aborted || epoch !== viewEpoch)
      throw new DOMException("视图权限已变化", "AbortError");
    return result;
  } catch (e) {
    if (
      epoch === viewEpoch &&
      e instanceof ApiError &&
      ([401, 403, 404].includes(e.status) || e.code === "CONTEXT_CHANGED")
    )
      clearSensitiveViews();
    throw e;
  }
};
function selectTrainingTab(next: string) {
  if (next === "discover" && !canLearner.value) next = "courses";
  if ((reportDirty.value || batchDirty.value || surveyDirty.value || batchUnknown.value || surveyUnknown.value) && next !== tab.value) {
    message.value = "请先保存当前表单，再切换功能。";
    return;
  }
  tab.value = next;
  if (next === "ai" && !readLoaded.value.ai) void loadAi();
}
async function openKnowledgeCourse(target:{id:string;lessonKey:string}){
  selectTrainingTab("courses");
  if(tab.value !== "courses")return;
  await openCourse(target.id);await nextTick();
  if(course.value?._id === target.id)document.getElementById(`training-lesson-${target.lessonKey}`)?.focus();
}
const reportEpoch = ref(0),
  reportDirty = ref(false),
  batchDirty = ref(false), surveyDirty = ref(false), batchUnknown = ref(false), surveyUnknown = ref(false),
  reportReceipt = ref<Row | null>(null),
  phase2Receipt = ref<Row | null>(null), knowledgeReceipt = ref<Row | null>(null), studioReceipt = ref<Row | null>(null), growthReceipt = ref<Row | null>(null);
const growthTarget=ref<{kind:string;id:string}>();
const studioTarget=ref<{kind:string;id:string}>();
const editableLessons = ref<Row[]>([]);
const canLearner = computed(() => canUseStudentLearning(props.identity));
const canAssist = computed(() => canLearner.value && has("ai:assist"));
const canCourses = computed(() =>
  canLearner.value || caps.value.some((x) =>
    [
      "course:edit",
      "course:review",
      "course:assign",
      "task:manage",
      "coursework:grade",
      "ai:generate",
    ].includes(x),
  ),
);
const canTasks = computed(() =>
  canLearner.value || caps.value.some((x) =>
    [
      "task:manage",
      "coursework:grade",
      "ai:generate",
    ].includes(x),
  ),
);
const caps = computed(() => props.identity.context?.capabilities || []),
  has = (cap: string) => caps.value.includes(cap);
const discoveryRevoked = ref(false);
const route = useRoute();
const tab = ref(
    ["workbench", "discover", "courses", "tasks", "ai", "site", "reports", "phase2", "knowledge", "studio", "growth"].includes(
      String(route.query.tab),
    ) && (String(route.query.tab) !== "discover" || canLearner.value)
      ? String(route.query.tab)
      : canLearner.value ? "workbench" : "courses",
  ),
  courses = ref<Row[]>([]),
  tasks = ref<Row[]>([]),
  course = ref<Row | null>(null),
  courseLearnerView = ref(false),
  work = ref<Row | null>(null),
  submissions = ref<Row[]>([]),
  ai = ref<Row | null>(null),
  aiJob = ref<Row | null>(null),
  siteDrafts = ref<Row[]>([]),
  leads = ref<Row[]>([]),
  busy = ref(false),
  message = ref(""),
  dirty = ref(false);
type ReadModule = "catalog" | "courses" | "tasks" | "ai";
const readBusy = ref<Record<ReadModule, boolean>>({ catalog: false, courses: false, tasks: false, ai: false });
const readLoaded = ref<Record<ReadModule, boolean>>({ catalog: false, courses: false, tasks: false, ai: false });
const readErrors = ref<Record<ReadModule, string>>({ catalog: "", courses: "", tasks: "", ai: "" });
const actionBusy = computed(() => busy.value || tab.value === "ai" && readBusy.value.ai);
const visibleCourses = computed(() => has("course:review") && !has("course:edit") && reviewOnly.value ? courses.value.filter(row => row.status === "review") : courses.value);
const reviewOnly = ref(true), createCourseOpen = ref(false);
const metadata = ref({ objectives: '', audience: '', prerequisites: '', difficulty: 'introductory', estimated_minutes: 30, instructor: '', language: '中文' });
const clonedLessons = ref<Row[] | null>(null);
async function openNewCourse() { clonedLessons.value = null; createCourseOpen.value = true; await nextTick(); document.getElementById('new-course-title')?.focus(); }
async function newCourseVersion() {
  if (!course.value) return;
  code.value = course.value.code; title.value = course.value.title; subject.value = course.value.subject_id; version.value = course.value.version_no + 1;
  clonedLessons.value = course.value.lessons.map((l: Row) => ({ ...l }));
  metadata.value = { objectives: '', audience: '', prerequisites: '', difficulty: 'introductory', estimated_minutes: 30, instructor: '', language: '中文', ...(course.value.metadata || {}) };
  createCourseOpen.value = true; changed(); await nextTick(); document.getElementById('new-course-title')?.focus();
}
const mediaUrls = ref<Record<string, string>>({});
const mediaPlayers: Record<string, HTMLMediaElement | null> = {};
let authorizationTimer = 0;
const lessonKind = ref("text"),
  fileId = ref(""),
  ownerId = ref("");
const title = ref(""),
  code = ref(""),
  subject = ref(""),
  classId = ref(""),
  lessonTitle = ref(""),
  lessonBody = ref(""),
  version = ref(1),
  courseEdit = ref(false),
  taskTitle = ref(""),
  taskBody = ref(""),
  due = ref(""),
  target = ref("coursework"),
  taskTarget = ref(""),
  draft = ref(""),
  comments = ref(""),
  scores = ref<Record<string, number>>({}),
  aiPrompt = ref(""),
  aiKind = ref("assist"),
  dailyLimit = ref(20),
  sitePage = ref("home"),
  siteTitle = ref(""),
  siteBody = ref("");
const catalog = ref<{
  classes: Row[];
  subjects: Row[];
  assignments: Row[];
  quizzes: Row[];
  phase2_enabled?: boolean;
  studio_enabled?: boolean;
  growth_enabled?: boolean;
  knowledge_enabled?: boolean; surveys_enabled?: boolean;
}>({ classes: [], subjects: [], assignments: [], quizzes: [] });
const feedbackComments = ref<Record<string, string>>({});
const labels: Record<string, string> = {
  draft: "草稿",
  review: "待审核",
  published: "已发布",
  retired: "已退役",
  cancelled: "已取消",
  queued: "等待生成",
  running: "正在生成",
  succeeded: "生成完成",
  failed: "生成失败",
  unknown: "结果待确认",
};
const aiCurrency = ref(""),
  aiDailyMoney = ref("0"),
  aiMaxMoney = ref("0"),
  aiKinds = ref<string[]>([]);
function moneyToMicro(value: string) {
  if (!/^\d{1,7}(?:\.\d{1,6})?$/.test(value))
    throw new Error("金额需为非负数，最多6位小数");
  const [whole, decimal = ""] = value.split(".");
  return Number(BigInt(whole!) * 1000000n + BigInt(decimal.padEnd(6, "0")));
}
function moneyDisplay(value: number) {
  return (value / 1000000).toFixed(6);
}
const aiKindLabels: Record<string, string> = {
  assist: "学习答疑",
  prepare: "教师备课",
  questions: "题目建议",
  report: "任务报告",
};
const recoveryJobs = ref<Row[]>([]);
const recoveryTruncated = ref(false);
const aiJobs = ref<Row[]>([]),
  acceptCourse = ref(""),
  acceptTitle = ref(""),
  acceptKey = ref("ai-lesson"),
  acceptBody = ref("");
const questionType = ref("numeric"),
  questionTitle = ref(""),
  questionPrompt = ref(""),
  questionAnswer = ref(""),
  questionExplanation = ref(""),
  questionOptions = ref([{id:"a",text:""},{id:"b",text:""}]),
  questionDraftId = ref("");
const questionRule = ref<Candidate['scoring_rule']|null>(null);
const confirmCandidateLoad = ref(false);
const structuredCandidate = computed(() => aiJob.value?.status === 'succeeded' && aiJob.value.kind === 'questions' ? parseQuestionCandidate(aiJob.value.output) : null);
function loadCandidate() {
  const q=structuredCandidate.value;if(!q)return;
  questionType.value=q.question_type;questionPrompt.value=q.prompt;questionAnswer.value=q.answer;questionExplanation.value=q.explanation;questionOptions.value=q.options.map(o=>({...o}));questionRule.value={...q.scoring_rule};questionDraftId.value='';confirmCandidateLoad.value=false;changed();
}
watch(() => aiJob.value?.id, () => { confirmCandidateLoad.value=false; questionDraftId.value=''; });
function addQuestionOption() { let n=1; while(questionOptions.value.some(o=>o.id==='option_'+n))n++; questionOptions.value.push({id:'option_'+n,text:''}); changed(); }
watch(questionType,()=>{if(questionType.value !== 'numeric' && questionOptions.value.length<2)questionOptions.value=[{id:'a',text:''},{id:'b',text:''}]; if(questionRule.value && questionRule.value.strategy!==({single:'single_exact',multiple:'multiple_exact_set',numeric:'numeric_exact_decimal'} as Record<string,string>)[questionType.value])questionRule.value=null;});
async function acceptQuestion() {
  if (!aiJob.value) return;
  const result = await write(
    "/training/ai/jobs/" + aiJob.value.id + "/accept-question",
    {
      question: {
        title: questionTitle.value,
        subject_id: courses.value.find((c) => c.id === aiJob.value!.context_id)
          ?.subject_id,
        question_type: questionType.value,
        prompt: questionPrompt.value,
        answer: questionAnswer.value,
        explanation: questionExplanation.value,
        difficulty: "基础",
        options:
          questionType.value === "numeric"
            ? []
            : questionOptions.value.map(o=>({...o})),
        ...(questionRule.value ? {scoring_rule:{...questionRule.value}} : {}),
        knowledge_point_ids: [],
      },
    },
  );
  if (result) questionDraftId.value = result.id;
}
const scope =
  "kl-training:" +
  props.identity.user.id +
  ":" +
  props.identity.context?.org_id;
type Pending = { path: string; key: string; hash: string };
const selectedFiles = ref<string[]>([]);
const fileUnknown = ref(false);
const cancelTaskConfirm = ref<string | null>(null);
const recoveryReloadConfirm = ref(false);
let clockTimer = 0;
let clockAnchor = 0;
let clockServer = 0;
const serverClock = ref(0);
function syncWorkClock() {
  clockServer = new Date(work.value?.server_now).getTime();
  clockAnchor = performance.now();
  serverClock.value = clockServer;
}
const workExpired = computed(
  () =>
    !!work.value &&
    (!Number.isFinite(serverClock.value) ||
      serverClock.value >= new Date(work.value.task.due_at).getTime()),
);
const workStatus = computed(() =>
  !work.value?.head?.current_submission_id
    ? work.value?.head
      ? "草稿未提交"
      : "尚未提交"
    : work.value.feedback?.length
      ? "已收到教师反馈"
      : "已提交，待教师批阅",
);
const pending = ref<Pending | null>(null),
  storageBlocked = ref(false);
try {
  const p = JSON.parse(sessionStorage.getItem(scope) || "null");
  if (
    p &&
    typeof p.path === "string" &&
    (p.path.startsWith("/training/") || p.path.startsWith("/site/")) &&
    typeof p.key === "string" &&
    /^[A-Za-z0-9_-]{8,128}$/.test(p.key) &&
    /^[a-f0-9]{64}$/.test(p.hash) &&
    Object.keys(p).every((key) => ["path", "key", "hash"].includes(key))
  )
    pending.value = p;
  else if (p) throw new Error("恢复元数据无效");
} catch {
  storageBlocked.value = true;
  message.value = "无法读取恢复记录，写入冻结；请核查原请求。";
}
watch([dirty, reportDirty, batchDirty, surveyDirty], ([d, r, b, s]) => emit("dirty", d || r || b || s));
watch([batchUnknown,surveyUnknown,pending,storageBlocked,fileUnknown],()=>emit("unknown",batchUnknown.value || surveyUnknown.value || !!pending.value || storageBlocked.value || fileUnknown.value));
watch(
  pending,
  (p) => {
    emit("unknown", !!p || storageBlocked.value || fileUnknown.value || batchUnknown.value || surveyUnknown.value);
    try {
      if (p) sessionStorage.setItem(scope, JSON.stringify(p));
      else sessionStorage.removeItem(scope);
    } catch {
      storageBlocked.value = true;
      emit("unknown", true);
      message.value = "恢复记录无法保存，写入冻结。";
    }
  },
  { immediate: true, flush: "sync" },
);
async function hash(body: unknown) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(body)),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
function clearSensitiveViews() {
  discoveryRevoked.value = true;
  readLoaded.value = { catalog: false, courses: false, tasks: false, ai: false };
  knowledgeReceipt.value = null;
  studioReceipt.value = null;
  growthReceipt.value = null; growthTarget.value=undefined;studioTarget.value=undefined;
  reportEpoch.value++;
  reportDirty.value = false; batchDirty.value=false; surveyDirty.value=false;
  reportReceipt.value = null;
  viewEpoch++;
  cancelTaskConfirm.value = null;
  clearMedia();
  selectedFiles.value = [];
  course.value = null;
  work.value = null;
  submissions.value = [];
  courses.value = [];
  tasks.value = [];
  aiJob.value = null;
  aiJobs.value = [];
  ai.value = null;
  recoveryJobs.value = [];
  recoveryTruncated.value = false;
  siteDrafts.value = [];
  leads.value = [];
  editableLessons.value = [];
  clonedLessons.value = null;
  metadata.value = { objectives: '', audience: '', prerequisites: '', difficulty: 'introductory', estimated_minutes: 30, instructor: '', language: '中文' };
  catalog.value = { classes: [], subjects: [], assignments: [], quizzes: [] };
  draft.value = "";
  comments.value = "";
  feedbackComments.value = {};
  scores.value = {};
  lessonBody.value = "";
  title.value = "";
  lessonTitle.value = "";
  taskBody.value = "";
  taskTitle.value = "";
  aiPrompt.value = "";
  acceptBody.value = "";
  questionTitle.value = "";
  questionPrompt.value = "";
  questionAnswer.value = "";
  questionExplanation.value = "";
  questionOptions.value = [{id:"a",text:""},{id:"b",text:""}];
  questionRule.value = null;
  confirmCandidateLoad.value = false;
  questionDraftId.value = "";
  siteTitle.value = "";
  siteBody.value = "";
  dirty.value = false;
}
function changed() {
  dirty.value = true;
}
function reloadForRecovery() {
  if (!pending.value || busy.value || storageBlocked.value) return;
  recoveryReloadConfirm.value = true;
}
function confirmRecoveryReload() {
  if (!pending.value || busy.value || storageBlocked.value) return;
  try {
    sessionStorage.setItem(scope, JSON.stringify(pending.value));
  } catch {
    storageBlocked.value = true;
    message.value = "恢复编号无法保存，未重新载入；请先查询原请求。";
    return;
  }
  window.removeEventListener("beforeunload", unload);
  window.location.reload();
}
async function queryReceipt() {
  if (!pending.value || busy.value) return;
  busy.value = true;
  try {
    const data = await request<{ status: string; result?: Row }>(
      pending.value.path.startsWith("/training/growth/") ? "/training/growth/receipts/query" : pending.value.path.startsWith("/training/studio/") ? "/training/studio/receipts/query" : pending.value.path.startsWith("/training/phase2/") ? "/training/phase2/receipts/query" : "/training/receipts/query",
      { method: "POST", body: { key: pending.value.key } },
    );
    if (data.status === "confirmed") {
      if (pending.value.path.startsWith("/training/reports") && data.result)
        reportReceipt.value = data.result;
      if (pending.value.path.startsWith('/training/phase2/') && data.result) phase2Receipt.value = data.result;
      if (pending.value.path.startsWith('/training/studio/')) {studioReceipt.value = { ...data };growthReceipt.value={...data};}
      if(pending.value.path.startsWith('/training/growth/'))growthReceipt.value={...data};
      if ((pending.value.path.startsWith("/training/knowledge/") || pending.value.path.startsWith("/training/ai/jobs")) && data.result) knowledgeReceipt.value = data.result;
      pending.value = null;
      recoveryReloadConfirm.value = false;
      dirty.value = false;
      message.value = "原请求已确认保存，请刷新查看最新记录。";
    } else
      message.value =
        "尚未查到回执，不能推定失败；请保留原编号并以相同表单内容重试。";
  } catch (e) {
    message.value = e instanceof Error ? e.message : "回执查询失败";
  } finally {
    busy.value = false;
  }
}
async function loadRecovery() {
  if (!has("ai:manage")) {
    recoveryJobs.value = [];
    return;
  }
  try {
    const queue = await request<{ items: Row[]; truncated: boolean }>(
      "/training/ai/recovery",
    );
    recoveryJobs.value = queue.items;
    recoveryTruncated.value = queue.truncated;
  } catch (e) {
    recoveryJobs.value = [];
    recoveryTruncated.value = false;
    throw e;
  }
}
async function refreshRecovery() {
  if (busy.value) return;
  busy.value = true;
  try {
    await loadRecovery();
  } catch (e) {
    message.value = e instanceof Error ? e.message : "恢复队列查询失败";
  } finally {
    busy.value = false;
  }
}
async function recoverJob(job: Row) {
  const result = await write("/training/ai/jobs/" + job.id + "/recover", {
    expected_revision: job.revision,
  });
  if (!result) return;
  try {
    await loadRecovery();
    ai.value = await request("/training/ai/status");
  } catch (e) {
    message.value =
      e instanceof Error ? e.message : "恢复后刷新失败，请重新查询";
  }
}
async function load() {
  if (busy.value) return;
  await Promise.all([
    readModule("catalog", async () => { catalog.value = await request("/training/catalog"); }),
    ...(canCourses.value ? [readModule("courses", async () => { courses.value = (await request<{ items: Row[] }>("/training/courses")).items; })] : []),
    ...(canTasks.value ? [readModule("tasks", async () => { tasks.value = (await request<{ items: Row[] }>("/training/tasks")).items; })] : []),
    ...(tab.value === "ai" ? [loadAi()] : []),
  ]);
}
async function readModule(name: ReadModule, read: () => Promise<void>) {
  if (readBusy.value[name] || lifetime.signal.aborted) return;
  readBusy.value[name] = true; readErrors.value[name] = "";
  try { await read(); if (!lifetime.signal.aborted) readLoaded.value[name] = true; }
  catch (cause) { if (!lifetime.signal.aborted && !(cause instanceof DOMException && cause.name === "AbortError")) readErrors.value[name] = cause instanceof Error ? cause.message : "读取失败，请重试。"; }
  finally { readBusy.value[name] = false; }
}
async function loadAi() {
  await readModule("ai", async () => {
    ai.value = await request("/training/ai/status");
    if (ai.value?.profile && !dirty.value) {
      dailyLimit.value = ai.value.profile.ai_daily_limit;
      aiKinds.value = [...(ai.value.profile.ai_enabled_kinds ?? [])];
      aiCurrency.value = ai.value.profile.ai_currency ?? "";
      aiDailyMoney.value = moneyDisplay(
        ai.value.profile.ai_daily_budget_micro ?? 0,
      );
      aiMaxMoney.value = moneyDisplay(
        ai.value.profile.ai_max_request_micro ?? 0,
      );
    }
    if (has("ai:manage")) await loadRecovery();
    if (canAssist.value || has("ai:generate"))
      aiJobs.value = (
        await request<{ items: Row[] }>("/training/ai/jobs")
      ).items;
  });
}
async function write(path: string, body: unknown, done?: () => Promise<void>) {
  if (batchDirty.value || surveyDirty.value || batchUnknown.value || surveyUnknown.value) { message.value = "请先完成当前批次/反馈表单或核对原编号，再操作其他写入。"; return; }
  if (actionBusy.value || storageBlocked.value || fileUnknown.value) return;
  const fingerprint = await hash(body);
  if (busy.value || lifetime.signal.aborted) return;
  if (
    pending.value &&
    (pending.value.path !== path || pending.value.hash !== fingerprint)
  ) {
    message.value =
      "上一笔请求结果待确认。请先查询结果，或重新填写完全相同的内容后按原按钮重试。";
    return;
  }
  busy.value = true;
  message.value = "";
  pending.value = pending.value || {
    path,
    key: crypto.randomUUID(),
    hash: fingerprint,
  };
  const operation = pending.value;
  try {
    if (storageBlocked.value)
      throw new Error("恢复记录无法持久保存，未发送请求。");
    const result = await request<Row>(path, {
      method: "POST",
      body,
      idempotencyKey: operation.key,
    });
    if (pending.value?.key === operation.key) {
      pending.value = null;
      dirty.value = false;
      message.value = "操作已保存。";
    }
    if (done) await done();
    return result;
  } catch (e) {
    if (pending.value?.key !== operation.key) return;
    if (
      e instanceof ApiError &&
      e.status < 500 &&
      (![401, 403, 404, 408].includes(e.status) ||
        e.code === "REPORT_SELF_REVIEW") &&
      ![
        "IDEMPOTENCY_CONFLICT",
        "IDEMPOTENCY_RESULT_INVALID",
        "IDENTITY_CHANGED",
      ].includes(e.code)
    )
      pending.value = null;
    message.value =
      (e instanceof Error ? e.message : "连接中断") +
      (pending.value ? "；结果待确认，请查询后使用原请求重试。" : "");
  } finally {
    if (!pending.value || pending.value.key === operation.key)
      busy.value = false;
  }
}
function clearMedia() {
  Object.values(mediaUrls.value).forEach((url) => URL.revokeObjectURL(url));
  mediaUrls.value = {};
  for (const key of Object.keys(mediaPlayers)) delete mediaPlayers[key];
}
watch(
  () => route.query.tab,
  (value) => {
    if (["workbench", "discover", "courses", "tasks", "ai", "site", "reports", "phase2", "knowledge", "studio", "growth"].includes(String(value)))
      selectTrainingTab(String(value));
  },
);
async function openCourse(id: string, learner=false) {
  if (reportDirty.value || batchDirty.value || surveyDirty.value || batchUnknown.value || surveyUnknown.value) { message.value = "请先保存课程反馈或查询原编号，再切换课程。"; return; }
  if (dirty.value && !window.confirm("当前表单尚未保存，确定切换？")) return;
  busy.value = true;
  try {
    clearMedia();
    course.value = null;
    courseLearnerView.value = learner;
    course.value = await request("/training/courses/" + id + (learner?"?mode=learner":""));
    courseEdit.value = false;
    dirty.value = false;
    work.value = null;
  } catch (e) {
    message.value = e instanceof Error ? e.message : "课程加载失败";
  } finally {
    busy.value = false;
  }
}
function openDiscoveryCourse(id: string) {
  selectTrainingTab("courses");
  if (tab.value === "courses") void openCourse(id, true);
}
async function openGrowthWork(id:string){selectTrainingTab('tasks');if(tab.value!=='tasks')return;work.value=null;submissions.value=[];if(canLearner.value)await openWork({_id:id});else await grading({_id:id});}
function openGrowthMeetup(id:string){selectTrainingTab('studio');if(tab.value==='studio')studioTarget.value={kind:'meetups',id};}
function openGrowthSource(target:{kind:string;id:string}){if(target.kind==='work'){void openGrowthWork(target.id);return;}if(target.kind==='meetup'){openGrowthMeetup(target.id);return;}growthTarget.value=target;selectTrainingTab('growth');}
async function createCourse() {
  const result = await write("/training/courses", {
    code: code.value,
    title: title.value,
    subject_id: subject.value,
    version_no: version.value,
    ...(catalog.value.studio_enabled ? { metadata: metadata.value } : {}),
    lessons: clonedLessons.value || [
      {
        key: "lesson-1",
        title: lessonTitle.value,
        kind: lessonKind.value,
        required: true,
        body: lessonBody.value,
        file_id: lessonKind.value !== "text" ? fileId.value : null,
        owner_version_id: lessonKind.value !== "text" ? ownerId.value : null,
      },
    ],
  });
  if (result) {
    course.value = result;
    createCourseOpen.value = false;
    clonedLessons.value = null;
    courses.value = (
      await request<{ items: Row[] }>("/training/courses")
    ).items;
  }
}
async function courseAction(action: string) {
  if (!course.value) return;
  const body: Row = { expected_revision: course.value.revision, action };
  if (["publish", "reject", "retire"].includes(action))
    body.note = comments.value;
  if (action === "edit") {
    if (catalog.value.studio_enabled) body.metadata = metadata.value;
    body.title = title.value;
    body.lessons = editableLessons.value.map((l) => ({
      ...l,
      file_id: l.kind === "text" ? null : l.file_id,
      owner_version_id: l.kind === "text" ? null : l.owner_version_id,
    }));
  }
  const result = await write(
    "/training/courses/" + course.value._id + "/actions",
    body,
  );
  if (result) {
    course.value = result;
    courseEdit.value = false;
    courses.value = (
      await request<{ items: Row[] }>("/training/courses")
    ).items;
  }
}
function editCourse() {
  if (!course.value) return;
  metadata.value = { objectives: '', audience: '', prerequisites: '', difficulty: 'introductory', estimated_minutes: 30, instructor: '', language: '中文', ...(course.value.metadata || {}) };
  title.value = course.value.title;
  lessonTitle.value = course.value.lessons[0].title;
  lessonBody.value = course.value.lessons[0].body;
  editableLessons.value = course.value.lessons.map((l: Row) => ({ ...l }));
  courseEdit.value = true;
}
function addLesson() {
  if (editableLessons.value.length >= 100) return;
  editableLessons.value.push({
    key: crypto.randomUUID(),
    title: "",
    kind: "text",
    required: true,
    body: "",
    file_id: null,
    owner_version_id: null,
  });
  changed();
}
async function downloadLesson(l: Row) {
  if (!course.value) return;
  busy.value = true;
  try {
    await request(courseReadPath());
    const blob = await request<Blob>("/files/" + l.file_id + "/content", {
      responseType: "blob",
    });
    if (mediaUrls.value[l.key]) URL.revokeObjectURL(mediaUrls.value[l.key]!);
    mediaUrls.value[l.key] = URL.createObjectURL(blob);
  } catch (e) {
    message.value = e instanceof Error ? e.message : "文件不可访问";
  } finally {
    busy.value = false;
  }
}
function restoreMedia(event: Event, key: string) {
  const player = event.target as HTMLMediaElement;
  mediaPlayers[key] = player;
  const position =
    course.value?.progress?.find((p: any) => p.lesson_key === key)?.position ||
    0;
  if (Number.isFinite(player.duration))
    player.currentTime = Math.min(position, player.duration);
}
async function savePlayback(key: string) {
  if (!course.value || !mediaPlayers[key]) return;
  await write(
    "/training/courses/" + course.value._id + "/progress",
    {
      lesson_key: key,
      position: Math.floor(mediaPlayers[key]!.currentTime),
      complete: false,
    },
    async () => {
      course.value = await request(courseReadPath());
    },
  );
}
function courseReadPath() {
  return "/training/courses/" + course.value!._id + (courseLearnerView.value ? "?mode=learner" : "");
}
async function recheck() {
  if (busy.value) return;
  try {
    if (course.value)
      course.value = await request(courseReadPath());
    if (work.value) {
      work.value = await request(
        "/training/tasks/" + work.value.task._id + "/coursework",
      );
      syncWorkClock();
    }
    if (aiJob.value)
      aiJob.value = await request("/training/ai/jobs/" + aiJob.value.id);
  } catch {
    course.value = null;
    work.value = null;
    aiJob.value = null;
    acceptBody.value = "";
    Object.values(mediaUrls.value).forEach((url) => URL.revokeObjectURL(url));
    mediaUrls.value = {};
    message.value = "资料授权暂时无法确认，已隐藏内容；请重新加载。";
  }
}
async function complete(key: string) {
  if (!course.value) return;
  await write(
    "/training/courses/" + course.value._id + "/progress",
    { lesson_key: key, position: 0, complete: true },
    async () => {
      course.value = await request(courseReadPath());
    },
  );
}
async function createTask() {
  if (!Number.isFinite(new Date(due.value).getTime())) {
    message.value = "请填写有效的截止时间。";
    return;
  }
  const result = await write("/training/tasks", {
    class_id: classId.value,
    subject_id: subject.value,
    title: taskTitle.value,
    target_type: target.value,
    target_id: target.value === "coursework" ? null : taskTarget.value,
    due_at: new Date(due.value).toISOString(),
    body: taskBody.value,
    rubric:
      target.value === "coursework"
        ? [{ key: "quality", title: "综合质量", weight: 100 }]
        : [],
  });
  if (result)
    tasks.value = (await request<{ items: Row[] }>("/training/tasks")).items;
}
async function taskAction(t: Row, action: string) {
  if (action === "cancel" && cancelTaskConfirm.value !== t._id) {
    cancelTaskConfirm.value = t._id;
    return;
  }
  await write(
    "/training/tasks/" + t._id + "/actions",
    { action, expected_revision: t.revision },
    async () => {
      cancelTaskConfirm.value = null;
      tasks.value = (await request<{ items: Row[] }>("/training/tasks")).items;
      work.value = null;
      submissions.value = [];
      draft.value = "";
    },
  );
}
async function openWork(t: Row) {
  if (dirty.value && !window.confirm("当前表单尚未保存，确定切换？")) return;
  busy.value = true;
  try {
    work.value = await request("/training/tasks/" + t._id + "/coursework");
    syncWorkClock();
    draft.value = work.value?.head?.draft || "";
    selectedFiles.value = work.value?.head?.file_ids || [];
    dirty.value = false;
  } catch (e) {
    message.value = e instanceof Error ? e.message : "作业加载失败";
  } finally {
    busy.value = false;
  }
}
async function saveWork(action: string) {
  if (!work.value || workExpired.value) {
    message.value = "已到截止时间，作业只读；如需补交请联系教师。";
    return;
  }
  await write(
    "/training/tasks/" + work.value.task._id + "/coursework",
    {
      expected_revision: work.value.head?.revision || 0,
      action,
      body: draft.value,
      ...(work.value.attachments_enabled
        ? { file_ids: selectedFiles.value }
        : {}),
    },
    async () => {
      work.value = await request(
        "/training/tasks/" + work.value!.task._id + "/coursework",
      );
      syncWorkClock();
    },
  );
}
async function grading(t: Row) {
  busy.value = true;
  try {
    submissions.value = (
      await request<{ items: Row[] }>(
        "/training/tasks/" + t._id + "/submissions",
      )
    ).items;
  } catch (e) {
    message.value = e instanceof Error ? e.message : "加载失败";
  } finally {
    busy.value = false;
  }
}
async function downloadWorkFile(id: string) {
  busy.value = true;
  try {
    const blob = await request<Blob>(
      "/training/coursework-files/" + id + "/content",
      { responseType: "blob" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "作业附件";
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    message.value = e instanceof Error ? e.message : "附件不可访问";
  } finally {
    busy.value = false;
  }
}
async function grade(item: Row, publish: boolean) {
  await write(
    "/training/tasks/" + item.submission.task_id + "/feedback",
    {
      head_revision: item.head.revision,
      submission_id: item.submission._id,
      comments: feedbackComments.value[item.submission._id] || "",
      scores: (
        tasks.value.find((t) => t._id === item.submission.task_id)?.rubric || []
      ).map((r: any) => ({
        key: r.key,
        score: scores.value[item.submission._id + ":" + r.key] ?? 0,
      })),
      publish,
    },
    async () => {
      submissions.value = (
        await request<{ items: Row[] }>(
          "/training/tasks/" + item.submission.task_id + "/submissions",
        )
      ).items;
    },
  );
}
async function generate() {
  const context =
    aiKind.value === "report" ? taskTarget.value : course.value?._id;
  if (!context) {
    message.value = "请先选择课程；报告需要填写任务编号。";
    return;
  }
  aiJob.value =
    (await write("/training/ai/jobs", {
      kind: aiKind.value,
      context_id: context,
      prompt: aiPrompt.value,
    })) || aiJob.value;
}
async function dispatch() {
  if (!aiJob.value) return;
  const result = await write(
    "/training/ai/jobs/" + aiJob.value.id + "/dispatch",
    { expected_revision: aiJob.value.revision },
  );
  if (result && result.revision >= (aiJob.value?.revision || 0))
    aiJob.value = result;
}
async function selectAi(id: string) {
  busy.value = true;
  try {
    aiJob.value = await request("/training/ai/jobs/" + id);
    acceptBody.value = aiJob.value?.output || "";
  } catch (e) {
    aiJob.value = null;
    message.value = e instanceof Error ? e.message : "结果不可访问";
  } finally {
    busy.value = false;
  }
}
async function acceptAi() {
  const c = courses.value.find((x) => x.id === acceptCourse.value);
  if (!c || !aiJob.value) {
    message.value = "请选择目标草稿";
    return;
  }
  await write("/training/ai/jobs/" + aiJob.value.id + "/accept", {
    course_id: c.id,
    expected_revision: c.revision,
    lesson_key: acceptKey.value,
    title: acceptTitle.value,
    body: acceptBody.value,
  });
  courses.value = (await request<{ items: Row[] }>("/training/courses")).items;
}
async function queryAi() {
  if (!aiJob.value) return;
  try {
    aiJob.value = await request("/training/ai/jobs/" + aiJob.value.id);
    acceptBody.value = aiJob.value?.output || "";
    if (
      aiJob.value &&
      aiJob.value.status !== "queued" &&
      pending.value?.path ===
        "/training/ai/jobs/" + aiJob.value.id + "/dispatch"
    ) {
      pending.value = null;
      busy.value = false;
      message.value =
        "已确认模型调用已受理，可查询进度或取消；取消不代表未产生费用。";
    }
  } catch (e) {
    message.value = e instanceof Error ? e.message : "查询失败";
  }
}
async function cancelAi() {
  if (!aiJob.value) return;
  const result = await write(
    "/training/ai/jobs/" + aiJob.value.id + "/cancel",
    { expected_revision: aiJob.value.revision },
  );
  if (result) aiJob.value = result;
}
async function configureAi(enabled: boolean) {
  let policy = {};
  try {
    if (enabled && ai.value?.policy_enabled)
      policy = {
        enabled_kinds: aiKinds.value,
        currency: aiCurrency.value.toUpperCase(),
        daily_budget_micro: moneyToMicro(aiDailyMoney.value),
        max_request_micro: moneyToMicro(aiMaxMoney.value),
      };
  } catch (e) {
    message.value = e instanceof Error ? e.message : "金额无效";
    return;
  }
  await write(
    "/training/ai/config",
    {
      enabled,
      daily_limit: dailyLimit.value,
      ...policy,
      expected_revision: ai.value?.profile?.revision || 0,
    },
    async () => {
      ai.value = await request("/training/ai/status");
    },
  );
}
async function loadSite() {
  busy.value = true;
  try {
    if (has("site:edit") || has("site:review"))
      siteDrafts.value = (
        await request<{ items: Row[] }>("/site/drafts")
      ).items;
    if (has("site:lead-read"))
      leads.value = (await request<{ items: Row[] }>("/site/leads")).items;
  } catch (e) {
    message.value = e instanceof Error ? e.message : "加载失败";
  } finally {
    busy.value = false;
  }
}
async function siteCreate() {
  await write("/site/drafts", {
    page_key: sitePage.value,
    title: siteTitle.value,
    body: siteBody.value,
  });
  await loadSite();
}
async function sitePublish(row: Row) {
  await write("/site/drafts/" + row._id + "/publish", {
    expected_revision: row.revision,
  });
  await loadSite();
}
function unload(e: BeforeUnloadEvent) {
  if (dirty.value || reportDirty.value || batchDirty.value || surveyDirty.value || batchUnknown.value || surveyUnknown.value || pending.value || fileUnknown.value) {
    e.preventDefault();
    e.returnValue = "";
  }
}
onMounted(() => {
  if (has("ai:generate") && !canAssist.value) aiKind.value = "prepare";
  void load().then(() => {
    if (tab.value === "site") void loadSite();
  });
  clockTimer = window.setInterval(() => {
    serverClock.value = clockServer + performance.now() - clockAnchor;
  }, 1000);
  authorizationTimer = window.setInterval(() => void recheck(), 30000);
  window.addEventListener("beforeunload", unload);
});
onBeforeUnmount(() => {
  lifetime.abort();
  window.clearInterval(authorizationTimer);
  window.clearInterval(clockTimer);
  Object.values(mediaUrls.value).forEach((url) => URL.revokeObjectURL(url));
  window.removeEventListener("beforeunload", unload);
  emit("dirty", false);
  emit("unknown", false);
});
</script>
<template>
  <section class="training-workspace panel" :aria-busy="busy">
    <div class="training-top">
      <div>
        <p v-if="!canLearner" class="eyebrow">TRAINING / 培训工作区</p>
        <h2>{{ canLearner ? '学习与任务' : has('course:review') && !has('course:edit') ? '课程审核' : '课程、实践与反馈' }}</h2>
      </div>
      <button class="button secondary" :disabled="busy" @click="load">
        刷新工作区
      </button>
    </div>
    <nav class="training-tabs" aria-label="学习与教学功能">
      <button v-if="catalog.growth_enabled && (canLearner || has('coursework:grade') || has('task:manage'))" :aria-pressed="tab === 'growth'" @click="growthTarget=undefined;selectTrainingTab('growth')">成长档案与学习通知</button>
      <button v-if="catalog.studio_enabled && (canLearner || has('task:manage') || has('coursework:grade'))" :aria-pressed="tab === 'studio'" @click="selectTrainingTab('studio')">实践、答疑与共学</button>
      <button v-if="canLearner" :aria-pressed="tab === 'workbench'" @click="selectTrainingTab('workbench')">我的学习</button>
      <button v-if="canLearner" :aria-pressed="tab === 'discover'" @click="selectTrainingTab('discover')">发现资源</button>
      <button
        v-for="t in [
          ['courses', '课程学习'],
          ['tasks', '任务与作业'],
          ['ai', 'AI 助手'],
        ]"
        :key="t[0]"
        :aria-pressed="tab === t[0]"
        @click="selectTrainingTab(t[0]!)"
      >
        {{ t[0] === 'courses' && !canLearner ? has('course:review') && !has('course:edit') ? '课程审核' : '课程管理' : t[1] }}</button
      ><button
        v-if="has('site:edit') || has('site:review') || has('site:lead-read')"
        :aria-pressed="tab === 'site'"
        @click="
          selectTrainingTab('site');
          if (tab === 'site') loadSite();
        "
      >
        网站管理
      </button>
      <button
        v-if="
          caps.some((x) =>
            [
              'training:report-edit',
              'training:report-review',
              'teaching:report',
            ].includes(x),
          )
        "
        :aria-pressed="tab === 'reports'"
        @click="selectTrainingTab('reports')"
      >
        报告发布
      </button>
    </nav>
    <GrowthWorkspace v-if="tab==='growth' && catalog.growth_enabled" :key="'growth'+reportEpoch" :request="request" :write="write" :caps="caps" :recovered="growthReceipt" :initial-target="growthTarget" :initial-page="growthTarget?'notifications':undefined" :context-key="identity.user.id+':'+identity.context?.org_id" :blocked="busy || storageBlocked || fileUnknown || batchDirty || surveyDirty" @dirty="reportDirty=$event" @work="openGrowthWork" @course="openDiscoveryCourse" @meetup="openGrowthMeetup" />
    <LearningStudio v-if="tab === 'studio' && catalog.studio_enabled" :key="'studio'+reportEpoch" :request="request" :write="write" :caps="caps" :recovered="studioReceipt" :initial-target="studioTarget" :context-key="identity.user.id+':'+identity.context?.org_id" :blocked="busy || storageBlocked || fileUnknown || batchDirty || surveyDirty" @dirty="reportDirty=$event" @work="openGrowthWork" @tasks="selectTrainingTab('tasks');load()" @course="openDiscoveryCourse" @reading="emit('reading', $event)" />
    <p v-if="message" role="status" class="notice">{{ message }}</p>
    <div v-if="readErrors.catalog" class="notice" role="status">授课目录：{{ readErrors.catalog }} <button class="text-button" :disabled="readBusy.catalog" @click="load">重试目录</button></div>
    <p v-if="pending" class="notice">
      请求结果待确认 ·
      {{
        pending.key
      }}。请刷新核对课程、任务或提交记录；重试须使用相同表单内容。<button
        class="text-button"
        :disabled="busy"
        @click="queryReceipt"
      >
        按原编号查询回执
      </button>
      <button
        class="text-button"
        :disabled="busy || storageBlocked"
        @click="reloadForRecovery"
      >
        保留编号并重新载入
      </button>
      <span class="field-help"
        >重新载入不保留未确认的正文，建议优先查询回执。</span
      >
    </p>
    <section
      v-if="pending && recoveryReloadConfirm"
      class="notice"
      aria-label="确认重新载入"
    >
      <p>重新载入只保留原请求编号，不保留未确认的表单正文。建议先查询回执。</p>
      <button
        class="button secondary"
        :disabled="busy || storageBlocked"
        @click="confirmRecoveryReload"
      >
        确认重新载入
      </button>
      <button class="button secondary" @click="recoveryReloadConfirm = false">
        取消重新载入
      </button>
    </section>
    <div v-if="tab === 'workbench' && canLearner" class="actions"><button class="button" @click="selectTrainingTab('courses')">继续课程学习</button><button class="button secondary" @click="selectTrainingTab('tasks')">查看任务与作业</button></div>
    <TrainingWorkbench v-if="tab==='workbench' && canLearner" :key="reportEpoch" :request="request" :embedded="true" @course="selectTrainingTab('courses');openCourse($event,true)" @tasks="selectTrainingTab('tasks')" @phase2="selectTrainingTab('phase2')" />
    <LearningDiscovery v-if="tab === 'discover' && canLearner && !discoveryRevoked" :request="request" :context-key="identity.user.id + ':' + identity.context?.org_id" @course="openDiscoveryCourse" />
    <LearningPaths v-if="tab === 'discover' && canLearner && !discoveryRevoked && catalog.phase2_enabled" :request="request" :context-key="identity.user.id + ':' + identity.context?.org_id" @course="openDiscoveryCourse" @tasks="selectTrainingTab('tasks')" @phase2="selectTrainingTab('phase2')" />
    <p v-if="tab === 'discover' && discoveryRevoked" role="alert">当前学习权限已变化，请重新确认身份后查看资源。</p>
    <button v-if="catalog.knowledge_enabled && (canLearner || has('ai:generate') || has('content:edit') || has('content:review') || has('ai:manage'))" class="button secondary" :aria-pressed="tab === 'knowledge'" @click="selectTrainingTab('knowledge')">知识检索与答疑</button>
    <TrainingKnowledge v-if="tab === 'knowledge' && catalog.knowledge_enabled" :key="reportEpoch" :request="request" :write="write" :caps="caps" :blocked="busy || storageBlocked || fileUnknown" :recovered="knowledgeReceipt" @reading="emit('reading', $event)" @course="openKnowledgeCourse" />
    <button v-if="catalog.phase2_enabled && (caps.some(x=>x.startsWith('training:')) || canLearner)" class="button secondary" @click="selectTrainingTab('phase2')">课表、结业与通知</button>
    <TrainingPhase2 v-if="tab === 'phase2' && catalog.phase2_enabled" :key="reportEpoch" :user-id="identity.user.id" :receipt="phase2Receipt" :request="request" :write="write" :caps="caps" :catalog="catalog" :growth-enabled="catalog.growth_enabled" :context-key="identity.user.id+':'+identity.context?.org_id" :growth-receipt="growthReceipt" @growth-source="openGrowthSource" :blocked="busy || storageBlocked || fileUnknown" @dirty="reportDirty = $event" />
    <TrainingReports
      v-if="tab === 'reports'"
      :key="reportEpoch"
      :request="request"
      :write="write"
      :caps="caps"
      :catalog="catalog"
      :recovered="reportReceipt"
      :user-id="identity.user.id"
      :blocked="busy || storageBlocked || fileUnknown"
      @dirty="reportDirty = $event"
    />
    <template v-if="tab === 'courses'"
      ><div class="training-grid">
        <aside>
          <h3>{{ has('course:review') && !has('course:edit') ? '待审核课程' : canLearner ? '我的课程' : '课程列表' }}</h3>
          <button v-if="has('course:edit')" class="button" :disabled="busy || readBusy.catalog" @click="openNewCourse">新建课程</button>
          <label v-if="has('course:review') && !has('course:edit')"><input v-model="reviewOnly" type="checkbox" />只看待审核</label>
          <p v-if="readBusy.courses" role="status">正在读取课程…</p>
          <p v-else-if="readErrors.courses" role="status">{{ readErrors.courses }} <button class="text-button" @click="load">重新读取课程</button></p>
          <p v-else-if="readLoaded.courses && !visibleCourses.length" class="muted">{{ has('course:review') && !has('course:edit') && reviewOnly ? '暂无待审核课程，可取消勾选查看其他课程。' : canLearner ? '暂无已分配课程，请联系教师确认学习安排。' : '暂无课程，可以创建草稿。' }}</p>
          <button
            v-for="c in visibleCourses"
            :key="c.id"
            class="course-card"
            :aria-pressed="course?._id === c.id"
            :disabled="busy"
            @click="openCourse(c.id)"
          >
            <strong>{{ c.title }}</strong
            ><span>版本 {{ c.version_no }} · {{ c.lesson_count }} 课节</span
            ><span>{{ labels[c.status] || c.status }}</span>
          </button>
        </aside>
        <div v-if="course" class="course-detail">
          <TrainingBatchAssign v-if="has('course:assign') && course.status === 'published'" :key="'batch'+course._id+reportEpoch" :course-id="course._id" :user-id="identity.user.id" :org-id="identity.context!.org_id" :classes="catalog.classes" :request="request" :blocked="busy || storageBlocked || fileUnknown || !!pending || surveyDirty" @dirty="batchDirty=$event" @unknown="batchUnknown=$event" />
          <TrainingSurveys v-if="catalog.surveys_enabled && (has('course:edit') || canLearner)" :key="course._id + reportEpoch" :course-id="course._id" :user-id="identity.user.id" :request="request" :manage="has('course:edit')" :blocked="busy || storageBlocked || fileUnknown || batchDirty" @dirty="surveyDirty = $event" @unknown="surveyUnknown = $event" />
          <p class="muted">
            课程版本 {{ course.version_no }} ·
            {{ labels[course.status] || course.status }}
          </p>
          <h3>{{ course.title }}</h3>
          <CourseMetadata v-if="course.metadata" :model-value="course.metadata" readonly />
          <button v-if="has('course:edit') && ['published','retired'].includes(course.status)" class="button secondary" :disabled="busy" @click="newCourseVersion">基于此版本创建草稿</button>
          <div
            class="actions"
            v-if="has('course:edit') || has('course:review')"
          >
            <button
              v-if="has('course:edit') && course.status === 'draft'"
              class="button secondary"
              :disabled="busy"
              @click="editCourse"
            >
              编辑草稿</button
            ><button
              v-if="has('course:edit') && course.status === 'draft'"
              class="button"
              :disabled="busy"
              @click="courseAction('request-review')"
            >
              提交审核</button
            ><template v-if="has('course:review') && course.status === 'review'"
              ><label
                >审核说明<input v-model="comments" maxlength="4000" /></label
              ><button
                class="button"
                :disabled="busy"
                @click="courseAction('publish')"
              >
                独立审核并发布</button
              ><button
                class="button secondary"
                :disabled="busy"
                @click="courseAction('reject')"
              >
                退回修改
              </button></template
            ><button
              v-if="has('course:review') && course.status === 'published'"
              class="button secondary"
              :disabled="busy || !comments"
              @click="courseAction('retire')"
            >
              退役课程
            </button>
          </div>
          <form
            v-if="courseEdit"
            class="training-form"
            @submit.prevent="courseAction('edit')"
          >
            <label
              >课程标题<input
                v-model="title"
                required
                maxlength="200"
                @input="changed"
            /></label>
            <CourseMetadata v-if="catalog.studio_enabled" v-model="metadata" :disabled="busy" @update:model-value="changed" />
            <fieldset v-for="(l, index) in editableLessons" :key="l.key">
              <legend>课节 {{ index + 1 }}</legend>
              <details><summary>预览本课节</summary><h4>{{ l.title || '尚未填写标题' }}</h4><p style="white-space:pre-wrap;overflow-wrap:anywhere">{{ l.body || '尚未填写正文' }}</p><p v-if="l.kind !== 'text'">媒体需保存后通过授权读取预览。</p></details>
              <label
                >课节标题<input
                  v-model="l.title"
                  required
                  maxlength="200"
                  @input="changed" /></label
              ><label
                >课节类型<select v-model="l.kind" @change="changed">
                  <option value="text">文本</option>
                  <option value="pdf">PDF</option>
                  <option value="video">MP4 视频</option>
                  <option value="audio">MP3 音频</option>
                </select></label
              ><label
                ><input
                  v-model="l.required"
                  type="checkbox"
                  @change="changed"
                />必修课节</label
              ><template v-if="l.kind !== 'text'"
                ><label
                  >私有文件编号<input
                    v-model="l.file_id"
                    required
                    pattern="[a-f0-9]{24}"
                    @input="changed" /></label
                ><label
                  >已发布教材版本编号<input
                    v-model="l.owner_version_id"
                    required
                    pattern="[a-f0-9]{24}"
                    @input="changed" /></label></template
              ><label
                >课节正文<textarea
                  v-model="l.body"
                  :required="l.kind === 'text'"
                  maxlength="16000"
                  rows="6"
                  @input="changed"
                /></label
              ><button
                type="button"
                class="button secondary"
                :disabled="busy || editableLessons.length === 1"
                @click="
                  editableLessons.splice(index, 1);
                  changed();
                "
              >
                移除课节
              </button>
            </fieldset>
            <button
              type="button"
              class="button secondary"
              :disabled="busy || editableLessons.length >= 100"
              @click="addLesson"
            >
              增加课节</button
            ><button class="button" :disabled="busy">保存草稿</button>
          </form>
          <article
            v-for="lesson in course.lessons"
            :key="lesson.key"
            :id="`training-lesson-${lesson.key}`"
            tabindex="-1"
            class="lesson"
          >
            <p class="eyebrow">
              {{ lesson.required ? "必修课节" : "选修课节" }}
            </p>
            <h4>{{ lesson.title }}</h4>
            <p class="lesson-body">{{ lesson.body }}</p>
            <template v-if="lesson.kind !== 'text'"
              ><button
                class="button secondary"
                :disabled="busy"
                @click="downloadLesson(lesson)"
              >
                授权读取媒体资料</button
              ><video
                v-if="lesson.kind === 'video' && mediaUrls[lesson.key]"
                :src="mediaUrls[lesson.key]"
                controls
                preload="metadata"
                @loadedmetadata="restoreMedia($event, lesson.key)"
                style="max-width: 100%"
              /><audio
                v-if="lesson.kind === 'audio' && mediaUrls[lesson.key]"
                :src="mediaUrls[lesson.key]"
                controls
                preload="metadata"
                @loadedmetadata="restoreMedia($event, lesson.key)"
              /><button
                v-if="
                  canLearner &&
                  ['video', 'audio'].includes(lesson.kind) &&
                  mediaUrls[lesson.key]
                "
                class="button secondary"
                :disabled="busy"
                @click="savePlayback(lesson.key)"
              >
                保存播放位置</button
              ><a
                v-if="mediaUrls[lesson.key]"
                :href="mediaUrls[lesson.key]"
                download="课程资料"
                >保存课程资料</a
              ></template
            ><template v-if="canLearner"
              ><p
                v-if="
                  course.progress?.some(
                    (p: any) => p.lesson_key === lesson.key && p.completed_at,
                  )
                "
                class="completed"
              >
                ✓ 已确认完成
              </p>
              <button
                v-else
                class="button secondary"
                :disabled="busy"
                @click="complete(lesson.key)"
              >
                确认已学习本课节
              </button></template
            >
          </article>
          <p class="field-help">
            课节完成记录表示学习确认，不代表知识掌握或考试通过。
          </p>
          <form
            v-if="has('course:assign') && course.status === 'published'"
            class="training-form"
            @submit.prevent="
              write('/training/courses/' + course!._id + '/assign', {
                class_id: classId,
              })
            "
          >
            <label
              >分配到培训班<select v-model="classId" required>
                <option disabled value="">请选择班级</option>
                <option v-for="c in catalog.classes" :key="c.id" :value="c.id">
                  {{ c.name }}
                </option>
              </select></label
            ><button class="button" :disabled="busy">分配已发布版本</button>
          </form>
        </div>
        <div v-else class="training-empty">
          <h3>选择一门课程，开始你的下一步</h3>
          <p>学习已分配的资料，完成实践任务，并查看教师反馈。</p>
        </div>
      </div>
      <details v-if="has('course:edit')" :open="createCourseOpen" class="training-create" @toggle="createCourseOpen = ($event.target as HTMLDetailsElement).open">
        <summary>创建新课程草稿</summary>
        <form class="training-form" @submit.prevent="createCourse">
          <CourseMetadata v-if="catalog.studio_enabled" v-model="metadata" :disabled="busy" @update:model-value="changed" />
          <p v-if="clonedLessons">已复制 {{ clonedLessons.length }} 个课节。新草稿建立后可逐课编辑，并重新提交独立审核。</p>
          <label
            >课程代码<input
              v-model="code"
              required
              maxlength="100"
              @input="changed" /></label
          ><label
            >课程标题<input
              id="new-course-title" v-model="title"
              required
              maxlength="200"
              @input="changed" /></label
          ><label
            >授课学科<select v-model="subject" required @change="changed">
              <option disabled value="">请选择学科</option>
              <option v-for="s in catalog.subjects" :key="s.id" :value="s.id">
                {{ s.name }}
              </option>
            </select></label
          ><label
            >版本号<input
              v-model.number="version"
              type="number"
              required
              min="1"
              @input="changed" /></label
          ><label v-if="!clonedLessons"
            >第一课节标题<input
              v-model="lessonTitle"
              required
              maxlength="200"
              @input="changed" /></label
          ><label v-if="!clonedLessons"
            >课节类型<select v-model="lessonKind">
              <option value="text">文本</option>
              <option value="pdf">已扫描 PDF</option>
              <option value="video">已扫描 MP4 视频</option>
              <option value="audio">已扫描 MP3 音频</option>
            </select></label
          ><template v-if="!clonedLessons && lessonKind !== 'text'"
            ><label
              >私有文件编号<input
                v-model="fileId"
                required
                pattern="[a-f0-9]{24}" /></label
            ><label
              >已发布教材版本编号<input
                v-model="ownerId"
                required
                pattern="[a-f0-9]{24}" /></label></template
          ><label v-if="!clonedLessons"
            >课节正文<textarea
              v-model="lessonBody"
              required
              maxlength="16000"
              rows="8"
              @input="changed"
            /></label
          ><button class="button" :disabled="busy">创建草稿</button>
        </form>
      </details></template
    >
    <template v-if="tab === 'tasks'"
      ><p v-if="readBusy.tasks" role="status">正在读取任务…</p><p v-else-if="readErrors.tasks" role="status">{{ readErrors.tasks }} <button class="text-button" @click="load">重新读取任务</button></p><p v-else-if="readLoaded.tasks && !tasks.length" class="muted">暂无当前可访问任务。</p><div class="task-list">
        <article v-for="t in tasks" :key="t._id" class="task-card">
          <div>
            <span class="eyebrow">{{
              t.target_type === "coursework"
                ? "实践作业"
                : t.target_type === "course"
                  ? "课程任务"
                  : "考试任务"
            }}</span>
            <h3>{{ t.title }}</h3>
            <p>{{ t.body }}</p>
            <p class="field-help">
              截止 {{ new Date(t.due_at).toLocaleString() }} ·
              {{ labels[t.status] || t.status }} · 任务编号 {{ t._id }}
            </p>
          </div>
          <div class="actions">
            <button
              v-if="has('task:manage') && t.status === 'draft'"
              class="button"
              :disabled="busy"
              @click="taskAction(t, 'publish')"
            >
              发布任务</button
            ><button
              v-if="
                has('task:manage') && ['draft', 'published'].includes(t.status)
              "
              class="button secondary"
              :disabled="busy"
              @click="taskAction(t, 'cancel')"
            >
              取消任务</button
            ><button
              v-if="canLearner && t.target_type === 'coursework'"
              class="button"
              :disabled="busy"
              @click="openWork(t)"
            >
              打开作业</button
            ><button
              v-if="has('coursework:grade') && t.target_type === 'coursework'"
              class="button secondary"
              :disabled="busy"
              @click="grading(t)"
            >
              查看提交与批阅</button
            ><button
              v-if="t.target_type === 'course' && canLearner"
              class="button secondary"
              @click="
                tab = 'courses';
                openCourse(t.target_id);
              "
            >
              学习课程</button
            ><RouterLink v-if="t.target_type === 'quiz'" to="/assessment"
              >进入考试工作区</RouterLink
            >
          </div>
          <div
            v-if="cancelTaskConfirm === t._id"
            role="group"
            aria-label="确认取消任务"
          >
            <p>
              取消后学员不能继续访问该任务；已提交记录保留。确认取消“{{
                t.title
              }}”？
            </p>
            <button
              class="button"
              :disabled="busy"
              @click="taskAction(t, 'cancel')"
            >
              确认取消任务
            </button>
            <button
              class="button secondary"
              :disabled="busy"
              @click="cancelTaskConfirm = null"
            >
              保留任务
            </button>
          </div>
        </article>
        <p v-if="!tasks.length" class="muted">暂无可访问的培训任务。</p>
      </div>
      <form
        v-if="work"
        class="training-form"
        @submit.prevent="saveWork('submit')"
      >
        <h3>{{ work.task.title }}</h3>
        <p role="status">
          {{ workStatus }}{{ workExpired ? " · 已截止，只读" : "" }}
        </p>
        <button
          type="button"
          class="button secondary"
          :disabled="busy"
          @click="recheck"
        >
          刷新作业状态
        </button>
        <label
          >作业正文<textarea
            v-model="draft"
            :readonly="workExpired"
            required
            maxlength="16000"
            rows="8"
            @input="changed"
          />
        </label>
        <p class="field-help">
          截止前可重新提交；每次提交保存独立版本，反馈只对应当前提交。
        </p>
        <div class="actions">
          <button
            type="button"
            class="button secondary"
            :disabled="busy || workExpired || fileUnknown"
            @click="saveWork('save')"
          >
            保存草稿</button
          ><button class="button" :disabled="busy || workExpired">
            {{ work.head?.submission_no ? "重新提交" : "提交作业" }}
          </button>
        </div>
        <CourseworkAttachments
          v-if="work.attachments_enabled && work.head"
          :key="work.task._id"
          :identity="identity"
          :request="request"
          :task-id="work.task._id"
          :revision="work.head.revision"
          :selected="selectedFiles"
          :disabled="busy || workExpired || !!pending || storageBlocked"
          @selection="
            selectedFiles = $event;
            changed();
          "
          @revision="work.head.revision = $event"
          @unknown="
            fileUnknown = $event;
            emit('unknown', $event || !!pending || storageBlocked);
          "
        />
        <p v-if="work.attachments_enabled && !work.head" class="field-help">
          先保存作业草稿，再上传附件。
        </p>
        <p>已提交 {{ work.head?.submission_no || 0 }} 次</p>
        <p v-if="work.head?.submission_no && !work.head.current_submission_id" role="status">当前作品已撤回，教师队列与附件停止交付；本人历史保留，可在截止前重新提交。</p>
        <details v-if="catalog.studio_enabled && work.head?.current_submission_id"><summary>撤回当前作品</summary><p>撤回后移出教师批阅队列，当前反馈不再展示。本人历史与必要审计保留。</p><button type="button" class="button secondary" :disabled="busy || workExpired" @click="saveWork('withdraw')">确认撤回作品</button></details>
        <article v-for="f in work.feedback" :key="f._id" class="lesson">
          <h4>教师反馈 · {{ f.score }} 分</h4>
          <p>{{ f.comments }}</p>
        </article>
      </form>
      <article
        v-for="item in submissions"
        :key="item.submission._id"
        class="lesson"
      >
        <h3>第 {{ item.submission.submission_no }} 次提交</h3>
        <p class="lesson-body">{{ item.submission.body }}</p>
        <button
          v-for="id in item.submission.file_ids || []"
          :key="id"
          type="button"
          class="button secondary"
          :disabled="busy"
          @click="downloadWorkFile(id)"
        >
          下载提交附件
        </button>
        <label
          >教师评语<textarea
            v-model="feedbackComments[item.submission._id]"
            maxlength="8000"
            rows="3"
            @input="changed"
          /></label
        ><label
          v-for="r in tasks.find((t) => t._id === item.submission.task_id)
            ?.rubric || []"
          :key="r.key"
          >{{ r.title }}（权重 {{ r.weight }}%）<input
            v-model.number="scores[item.submission._id + ':' + r.key]"
            type="number"
            min="0"
            max="100"
        /></label>
        <div class="actions">
          <button
            class="button secondary"
            :disabled="busy"
            @click="grade(item, false)"
          >
            保存反馈草稿</button
          ><button class="button" :disabled="busy" @click="grade(item, true)">
            发布教师反馈
          </button>
        </div>
        <p v-for="f in item.feedback" :key="f._id">
          {{ labels[f.status] || f.status }} · {{ f.score }} 分 ·
          {{ f.comments }}
        </p>
      </article>
      <details v-if="has('task:manage')" class="training-create">
        <summary>创建培训任务</summary>
        <form class="training-form" @submit.prevent="createTask">
          <label
            >任务标题<input
              v-model="taskTitle"
              required
              maxlength="200"
              @input="changed" /></label
          ><label
            >培训班<select v-model="classId" required>
              <option disabled value="">请选择班级</option>
              <option v-for="c in catalog.classes" :key="c.id" :value="c.id">
                {{ c.name }}
              </option>
            </select></label
          ><label
            >授课学科<select v-model="subject" required>
              <option disabled value="">请选择学科</option>
              <option v-for="s in catalog.subjects" :key="s.id" :value="s.id">
                {{ s.name }}
              </option>
            </select></label
          ><label
            >任务类型<select v-model="target">
              <option value="coursework">实践作业</option>
              <option value="course">学习课程</option>
              <option value="quiz">已有考试</option>
            </select></label
          ><label v-if="target !== 'coursework'"
            >已发布目标<select v-model="taskTarget" required>
              <option disabled value="">请选择目标</option>
              <template v-if="target === 'course'"
                ><option
                  v-for="c in courses.filter((x) => x.status === 'published')"
                  :key="c.id"
                  :value="c.id"
                >
                  {{ c.title }}
                </option></template
              ><template v-else
                ><option
                  v-for="q in catalog.quizzes"
                  :key="q._id"
                  :value="q._id"
                >
                  {{ q.title }}
                </option></template
              >
            </select></label
          ><label
            >截止时间<input
              v-model="due"
              type="datetime-local"
              required /></label
          ><label
            >任务说明<textarea
              v-model="taskBody"
              maxlength="16000"
              rows="4"
              @input="changed"
            />
          </label>
          <p class="field-help">
            本页面使用综合质量评分（100%）；API
            支持多个评分维度，权重之和须为100。
          </p>
          <button class="button" :disabled="busy">保存任务草稿</button>
        </form>
      </details></template
    >
    <template v-if="tab === 'ai'"
      ><p v-if="readBusy.ai || !readLoaded.ai && !readErrors.ai" role="status">正在读取 AI 配置与任务…</p><p v-else-if="readErrors.ai" role="alert">{{ readErrors.ai }} <button class="text-button" :disabled="readBusy.ai" @click="loadAi">重新读取 AI</button></p><div class="ai-banner">
        <h3>有来源的教学建议</h3>
        <p>AI 输出供人工检查；不自动发布内容、作业评分或考试答案。</p>
        <p v-if="readLoaded.ai && !readBusy.ai && !readErrors.ai">
          {{
            ai?.configured && ai?.enabled
              ? "已配置并启用"
              : "AI 尚未配置并启用，当前不能生成"
          }}
        </p>
      </div>
      <form class="training-form" @submit.prevent="generate"><fieldset class="content-fields" :disabled="actionBusy || !readLoaded.ai || !!readErrors.ai">
        <label
          >使用场景<select v-model="aiKind">
            <option v-if="canAssist" value="assist">课程学习助教</option>
            <template v-if="has('ai:generate')"
              ><option value="prepare">教师备课草稿</option>
              <option value="questions">题目建议草稿</option>
              <option value="report">任务报告建议</option></template
            >
          </select></label
        >
        <p class="field-help">
          当前课程：{{ course?.title || "请在课程页先选择课程" }}
        </p>
        <label v-if="aiKind === 'report'"
          >任务编号<input
            v-model="taskTarget"
            pattern="[a-f0-9]{24}"
            required /></label
        ><label
          >你的问题或生成要求<textarea
            v-model="aiPrompt"
            required
            maxlength="4000"
            rows="5"
            @input="changed"
          /></label
        ><button
          class="button"
          :disabled="
            actionBusy ||
            !ai?.enabled ||
            !ai?.configured ||
            (ai?.policy_enabled && !ai?.enabled_kinds?.includes(aiKind))
          "
        >
          创建生成任务
        </button>
      </fieldset></form>
      <div class="actions">
        <button
          v-for="j in aiJobs"
          :key="j.id"
          class="button secondary"
          :disabled="actionBusy"
          @click="selectAi(j.id)"
        >
          {{ j.kind }} · {{ labels[j.status] || j.status }} ·
          {{ j.id.slice(-6) }}
        </button>
      </div>
      <article v-if="aiJob" class="lesson">
        <h3>生成任务 · {{ labels[aiJob.status] || aiJob.status }}</h3>
        <p class="field-help">任务编号 {{ aiJob.id }}</p>
        <div class="actions">
          <button
            v-if="aiJob.status === 'queued'"
            class="button"
            :disabled="actionBusy"
            @click="dispatch"
          >
            开始生成</button
          ><button class="button secondary" @click="queryAi">查询结果</button
          ><button
            v-if="['queued', 'running'].includes(aiJob.status)"
            class="button secondary"
            :disabled="actionBusy"
            @click="cancelAi"
          >
            取消任务
          </button>
        </div>
        <p class="lesson-body">{{ aiJob.output }}</p>
        <ul>
          <li v-for="c in aiJob.citations" :key="c.key">
            来源：{{ c.title }}（{{ c.key }}）
          </li>
        </ul>
        <form
          v-if="
            aiJob.status === 'succeeded' &&
            !['assist', 'learning-report'].includes(aiJob.kind) &&
            has('course:edit')
          "
          class="training-form"
          @submit.prevent="acceptAi"
        >
          <h4>检查并采纳为课程草稿课节</h4>
          <label
            >目标草稿<select v-model="acceptCourse" required>
              <option disabled value="">选择本人同学科草稿</option>
              <option
                v-for="c in courses.filter((x) => x.status === 'draft')"
                :key="c.id"
                :value="c.id"
              >
                {{ c.title }} · 版本 {{ c.version_no }}
              </option>
            </select></label
          ><label
            >课节标识<input
              v-model="acceptKey"
              required
              pattern="[a-z0-9_-]{1,64}" /></label
          ><label
            >课节标题<input
              v-model="acceptTitle"
              required
              maxlength="200" /></label
          ><label
            >教师修订后的正文<textarea
              v-model="acceptBody"
              required
              maxlength="12000"
              rows="6"
              @input="changed"
            /></label
          ><button class="button" :disabled="actionBusy">采纳为草稿课节</button>
          <p class="field-help">
            结构化候选可载入题库草稿表单；普通建议文本需人工编辑。进入正式题库仍须核对并独立审核。
          </p>
        </form>
        <form
          v-if="
            aiJob.status === 'succeeded' &&
            aiJob.kind === 'questions' &&
            has('content:edit')
          "
          class="training-form"
          @submit.prevent="acceptQuestion"
        >
          <h4>人工核对后保存为真实题库草稿</h4>
          <template v-if="structuredCandidate">
            <button type="button" class="button secondary" :disabled="actionBusy" @click="confirmCandidateLoad = true">载入结构化候选</button>
            <div v-if="confirmCandidateLoad" class="notice">
              <p>载入会替换当前题干、选项、参考答案和解析。请核对后再保存。</p>
              <button type="button" class="button" @click="loadCandidate">确认载入</button>
              <button type="button" class="button secondary" @click="confirmCandidateLoad = false">取消载入</button>
            </div>
            <p class="field-help">格式检查通过。答案与教学解析仍需人工核对。</p>
          </template>
          <label
            >题目标题<input
              v-model="questionTitle"
              required
              maxlength="200"
              @input="changed" /></label
          ><label
            >题型<select v-model="questionType" @change="changed">
              <option value="numeric">数值题</option>
              <option value="single">单选题</option>
              <option value="multiple">多选题</option>
            </select></label
          ><label
            >教师确认后的题干<textarea
              v-model="questionPrompt"
              required
              maxlength="20000"
              rows="5"
              @input="changed"
            /></label
          ><template v-if="questionType !== 'numeric'">
            <div v-for="(option,index) in questionOptions" :key="index">
              <label>选项标识<input v-model="option.id" required maxlength="20" @input="changed" /></label>
              <label>选项内容<input v-model="option.text" required maxlength="2000" @input="changed" /></label>
              <button type="button" class="button secondary" :disabled="questionOptions.length <= 2 || busy" @click="questionOptions.splice(index,1); changed()">删除选项</button>
            </div>
            <button type="button" class="button secondary" :disabled="questionOptions.length >= 10 || busy" @click="addQuestionOption()">添加选项</button>
          </template
          ><label
            >参考答案<input
              v-model="questionAnswer"
              maxlength="2000"
              @input="changed" /></label
          ><label
            >解析<textarea
              v-model="questionExplanation"
              maxlength="20000"
              rows="4"
              @input="changed"
            /></label
          ><button class="button" :disabled="actionBusy">保存为题库草稿</button>
          <p class="field-help">
            草稿不会自动发布。请在内容工作区补全来源授权、知识点、评分规则和难度依据，再按独立审核流程发布。
          </p>
          <p v-if="questionDraftId">
            草稿编号：{{ questionDraftId }} ·
            <RouterLink to="/content">进入内容工作区</RouterLink>
          </p>
        </form>
        <button
          v-if="aiJob.status === 'running' && has('ai:manage')"
          class="button secondary"
          :disabled="actionBusy"
          @click="
            write('/training/ai/jobs/' + aiJob.id + '/recover', {
              expected_revision: aiJob.revision,
            }).then(queryAi)
          "
        >
          核对超时调用（60秒后）
        </button>
        <p v-if="aiJob.error_code" class="notice">
          结果未确认，请检查服务配置。系统不会自动重复派发。
        </p>
      </article>
      <section
        v-if="has('ai:manage')"
        class="lesson"
        aria-labelledby="ai-recovery-heading"
      >
        <h3 id="ai-recovery-heading">组织 AI 恢复队列</h3>
        <p v-if="ai?.profile" class="field-help">
          今日次数上限 {{ ai.profile.ai_daily_limit }} · 预留
          {{ ai.usage?.reserved || 0 }} · 已用 {{ ai.usage?.used || 0 }} ·
          结果未知 {{ ai.usage?.unknown || 0 }}
        </p>
        <p v-if="ai?.policy_enabled && ai?.profile" class="field-help">
          {{ ai.profile.ai_currency }} 金额预留
          {{ moneyDisplay(ai.usage?.reserved_micro || 0) }} · 已调用上界
          {{ moneyDisplay(ai.usage?.spent_micro || 0) }} · 结果未知
          {{ moneyDisplay(ai.usage?.unknown_micro || 0) }}
        </p>
        <p class="field-help">
          排队任务尚未调用模型，取消后释放预留次数。调用超过60秒可核对为结果未知，仍计入预算；系统不会再次派发。队列只显示状态，不显示用户问题或生成正文。
        </p>
        <button
          type="button"
          class="button secondary"
          :disabled="actionBusy"
          @click="refreshRecovery"
        >
          刷新恢复队列
        </button>
        <p v-if="readLoaded.ai && !readBusy.ai && !readErrors.ai && !recoveryJobs.length">当前没有待处理的 AI 任务。</p>
        <p v-if="recoveryTruncated" class="notice">
          仅显示最早的100项，处理后刷新查看后续任务。
        </p>
        <article v-for="job in recoveryJobs" :key="job.id" class="lesson">
          <h4>
            {{ labels[job.status] }} · {{ aiKindLabels[job.kind] || job.kind }}
          </h4>
          <p class="field-help">
            任务编号：{{ job.id }} · 创建于
            {{ new Date(job.created_at).toLocaleString() }}
          </p>
          <button
            type="button"
            class="button secondary"
            :disabled="actionBusy || !job.recoverable"
            @click="recoverJob(job)"
          >
            {{
              job.status === "queued" ? "取消排队并释放次数" : "核对为结果未知"
            }}
          </button>
          <p v-if="!job.recoverable" class="field-help">
            调用尚未超过60秒，请稍后刷新。
          </p>
        </article>
      </section>
      <form
        v-if="has('ai:manage')"
        class="training-form"
        @submit.prevent="configureAi(true)"
      >
        <h3>组织 AI 开关与日预算</h3>
        <fieldset v-if="ai?.policy_enabled">
          <legend>允许使用的能力与金额上限</legend>
          <label v-for="(label, kind) in aiKindLabels" :key="kind"
            ><input
              v-model="aiKinds"
              type="checkbox"
              :value="kind"
              @change="changed"
            />{{ label }}</label
          ><label
            >预算币种<input
              v-model="aiCurrency"
              pattern="[A-Z]{3}"
              maxlength="3"
              placeholder="CNY / USD"
              @input="changed" /></label
          ><label
            >每日金额上限<input
              v-model="aiDailyMoney"
              inputmode="decimal"
              @input="changed" /></label
          ><label
            >单次金额上限<input
              v-model="aiMaxMoney"
              inputmode="decimal"
              @input="changed"
          /></label>
          <p class="field-help">
            按单次上限预留；调用结果未知仍占用。这里显示预算占用上界，实际供应商费用须另行对账。
          </p>
        </fieldset>
        <label
          >每日生成次数上限<input
            v-model.number="dailyLimit"
            type="number"
            min="0"
            max="10000"
            required
        /></label>
        <p class="field-help">
          模型和凭据通过服务端环境配置管理，不在浏览器中保存。
        </p>
        <div class="actions">
          <button class="button" :disabled="actionBusy">启用</button
          ><button
            type="button"
            class="button secondary"
            :disabled="actionBusy"
            @click="configureAi(false)"
          >
            停用
          </button>
        </div>
      </form></template
    >
    <template v-if="tab === 'site'"
      ><form
        v-if="has('site:edit')"
        class="training-form"
        @submit.prevent="siteCreate"
      >
        <h3>新增网站内容草稿</h3>
        <label
          >页面<select v-model="sitePage">
            <option
              v-for="p in [
                'home',
                'features',
                'ai-teaching',
                'solutions',
                'help',
                'about',
                'contact',
              ]"
              :key="p"
            >
              {{ p }}
            </option>
          </select></label
        ><label
          >标题<input
            v-model="siteTitle"
            required
            maxlength="200"
            @input="changed" /></label
        ><label
          >补充内容<textarea
            v-model="siteBody"
            required
            maxlength="12000"
            rows="6"
            @input="changed"
          /></label
        ><button class="button" :disabled="busy">保存内容草稿</button>
      </form>
      <article v-for="d in siteDrafts" :key="d._id" class="lesson">
        <h3>{{ d.title }} · {{ labels[d.status] || d.status }}</h3>
        <p class="lesson-body">{{ d.body }}</p>
        <button
          v-if="has('site:review') && d.status === 'draft'"
          class="button"
          :disabled="busy"
          @click="sitePublish(d)"
        >
          独立审核并发布
        </button>
      </article>
      <article v-for="l in leads" :key="l._id" class="lesson">
        <h3>{{ l.name || "咨询联系人" }}</h3>
        <p>{{ l.contact }} · {{ l.kind }} · {{ l.status }}</p>
        <p class="field-help">
          保留至 {{ new Date(l.expires_at).toLocaleString() }}
        </p>
        <div class="actions">
          <button
            v-for="status in ['contacted', 'closed']"
            :key="status"
            class="button secondary"
            :disabled="busy || l.status === status"
            @click="
              write('/site/leads/' + l._id + '/status', {
                expected_revision: l.revision,
                status,
              }).then(loadSite)
            "
          >
            {{ status === "contacted" ? "标记已联系" : "结束咨询" }}
          </button>
        </div>
      </article></template
    >
  </section>
</template>
<style scoped>
.training-workspace {
  width: 100%;
  max-width: 1180px;
  padding: 32px;
  grid-column: 1/-1;
}
.training-top {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  align-items: center;
}
.training-top h2 {
  margin: 8px 0 22px;
}
.training-tabs {
  display: flex;
  border-bottom: 1px solid #dbe4dc;
  gap: 12px;
  margin-bottom: 28px;
  flex-wrap: wrap;
}
.training-tabs button {
  border: 0;
  background: none;
  padding: 14px 16px;
  font-size: 14px;
  color: #546c5b;
  cursor: pointer;
}
.training-tabs button[aria-pressed="true"] {
  border-bottom: 3px solid #286546;
  color: #245a3c;
  font-weight: 700;
}
.training-grid {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: 32px;
}
.course-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: #f8faf6;
  border: 1px solid #d9e3d8;
  border-radius: 10px;
  padding: 20px;
  width: 100%;
  text-align: left;
  margin: 12px 0;
  color: #244b36;
  cursor: pointer;
}
.course-card span {
  font-size: 12px;
  color: #6d7c6b;
}
.course-card[aria-pressed="true"] {
  border-color: #487c50;
  background: #eff5e9;
}
.course-detail > h3 {
  font-size: 26px;
}
.lesson {
  border: 1px solid #e0e7dc;
  border-radius: 10px;
  padding: 24px;
  margin: 20px 0;
}
.lesson h4 {
  font-size: 20px;
  margin: 12px 0;
}
.lesson-body {
  white-space: pre-wrap;
  line-height: 1.9;
  font-size: 15px;
}
.completed {
  color: #28754c;
  font-size: 14px;
}
.training-empty {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 260px;
  padding: 40px;
  background: #f7f9f4;
  border-radius: 12px;
  color: #526a59;
}
.training-empty h3 {
  font-size: 24px;
}
.training-form {
  display: grid;
  gap: 18px;
  margin: 24px 0;
  max-width: 740px;
}
.training-form label,
.lesson label {
  display: grid;
  gap: 8px;
  font-size: 14px;
  margin-bottom: 12px;
}
.training-form input,
.training-form textarea,
.training-form select,
.lesson input,
.lesson textarea,
.actions input {
  border: 1px solid #cad8c7;
  background: white;
  padding: 12px;
  border-radius: 7px;
  font: inherit;
  color: #244b36;
  max-width: 100%;
  box-sizing: border-box;
}
.actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}
.training-create {
  margin: 35px 0;
  border-top: 1px solid #dce5d9;
  padding-top: 25px;
}
.training-create summary {
  cursor: pointer;
  font-weight: 700;
  color: #286546;
}
.task-card {
  border: 1px solid #dbe5d8;
  padding: 24px;
  border-radius: 10px;
  margin: 16px 0;
  display: flex;
  justify-content: space-between;
  gap: 24px;
  flex-wrap: wrap;
}
.task-card h3 {
  margin: 14px 0;
}
.ai-banner {
  padding: 26px;
  background: #edf4e8;
  border-radius: 12px;
}
.ai-banner h3 {
  font-size: 24px;
  margin: 0 0 16px;
}
.ai-banner p {
  line-height: 1.8;
  color: #4f6954;
}
button:focus-visible,
summary:focus-visible {
  outline: 3px solid #699b62;
  outline-offset: 4px;
}
@media (max-width: 760px) {
  .training-workspace {
    padding: 20px;
  }
  .training-grid {
    grid-template-columns: 1fr;
  }
  .training-top {
    flex-wrap: wrap;
  }
  .training-tabs {
    gap: 0;
  }
  .training-tabs button {
    padding: 12px;
  }
  .lesson {
    padding: 18px;
  }
  .training-empty {
    padding: 24px;
  }
}
</style>
