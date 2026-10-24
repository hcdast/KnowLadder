<script setup lang="ts">
import BrandIcon from "../components/BrandIcon.vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ApiError, type BusinessRequest, type Identity } from "../session";
import type {
  QuizDraftSummary,
  TeachingClass,
  TeachingClassList,
  TeachingClassSubjectReport,
  TeachingQuizRecovery,
  TeachingRoster,
  TeachingStudentSubjectReport,
} from "./types";

const props = defineProps<{ identity: Identity; request: BusinessRequest }>();
const emit = defineEmits<{
  dirty: [value: boolean];
  unknown: [value: boolean];
  openAssessment: [];
}>();

const caps = props.identity.context?.capabilities || [];
const canTeach = caps.includes("teaching:class");
const canReport = caps.includes("teaching:report");
const canManage = caps.includes("assessment:manage");

const view = ref<
  "classes" | "roster" | "class-report" | "student-report" | "quiz"
>("classes");
const classes = ref<TeachingClass[]>([]);
const selectedClass = ref<TeachingClass>();
const classHeading = ref<HTMLElement>();
const quizHeading = ref<HTMLElement>();
const roster = ref<TeachingRoster>();
const subjectId = ref("");
const teachingCatalog = ref<{ subjects: { id: string; name: string }[]; assignments: { class_id: string; subject_id: string }[] }>({ subjects: [], assignments: [] });
const subjectsBusy = ref(false), subjectsError = ref("");
const classSubjects = computed(() => teachingCatalog.value.subjects.filter(subject => teachingCatalog.value.assignments.some(assignment => assignment.class_id === selectedClass.value?.id && assignment.subject_id === subject.id)));
const classReport = ref<TeachingClassSubjectReport>();
const studentId = ref("");
const studentName = ref("");
const studentPeriod = ref<"7d" | "30d">("30d");
const studentReport = ref<TeachingStudentSubjectReport>();

const quizTitle = ref("");
const quizSubject = ref("");
const quizOpens = ref("");
const quizCloses = ref("");
const quizRelease = ref("");
const quizDuration = ref(600);
const quizAttempts = ref(1);
const quizItems = ref("");
const quizMinutes = computed({ get: () => quizDuration.value / 60, set: value => { quizDuration.value = value * 60; } });
const quizCandidates = ref<{ id: string; title: string; subject_id: string }[]>([]);
const candidateBusy = ref(false), candidateError = ref("");
const selectedQuestionIds = computed({ get: () => quizItems.value.split(/[\s,，]+/).filter(Boolean), set: ids => { quizItems.value = ids.join(" "); } });
const createdQuiz = ref<QuizDraftSummary>();

const busy = ref(false);
const writeBusy = ref(false);
const error = ref("");
const notice = ref("");
const denied = ref(false);
const cooldown = ref(0);
const pending = ref<TeachingQuizRecovery>();
const storageBlocked = ref(false);
let pendingBody: unknown;

const life = new AbortController();
let alive = true;
let serial = 0;
let timer = 0;
const storageKey = `teaching-quiz-recovery:${props.identity.user.id}:${props.identity.context?.org_id}`;

const unknown = computed(() => !!pending.value || storageBlocked.value);
const locked = computed(
  () =>
    busy.value || candidateBusy.value ||
    writeBusy.value ||
    unknown.value ||
    cooldown.value > 0 ||
    denied.value,
);
const dirty = computed(
  () =>
    view.value === "quiz" &&
    !createdQuiz.value &&
    !!(quizTitle.value || quizItems.value || quizSubject.value),
);

watch(dirty, (value) => emit("dirty", value));
watch(unknown, (value) => emit("unknown", value), { flush: "sync" });

function fail(cause: unknown) {
  if (!alive) return;
  error.value = cause instanceof Error ? cause.message : "请求未完成，请重试。";
  if (!(cause instanceof ApiError)) return;
  error.value += ` ${cause.code} ${cause.requestId}`;
  if (cause.status === 429) {
    const seconds = Number(cause.retryAfter);
    const date = Date.parse(cause.retryAfter);
    const until =
      Number.isFinite(seconds) && cause.retryAfter.trim()
        ? Date.now() + Math.max(0, seconds) * 1000
        : Number.isFinite(date)
          ? date
          : Date.now() + 60000;
    window.clearInterval(timer);
    cooldown.value = Math.max(1, Math.ceil((until - Date.now()) / 1000));
    timer = window.setInterval(() => {
      cooldown.value = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      if (!cooldown.value) window.clearInterval(timer);
    }, 1000);
  }
  if ([401, 403, 404].includes(cause.status)) {
    serial++;
    life.abort();
    denied.value = true;
    classes.value = [];
    selectedClass.value = undefined;
    clearDetail();
    createdQuiz.value = undefined;
    subjectId.value = "";
    quizSubject.value = "";
    quizTitle.value = "";
    quizItems.value = "";
    pendingBody = undefined;
  }
}

function clearDetail() {
  teachingCatalog.value = { subjects: [], assignments: [] };
  quizCandidates.value = [];
  roster.value = undefined;
  classReport.value = undefined;
  studentReport.value = undefined;
  studentId.value = "";
  studentName.value = "";
}

function clearPending() {
  sessionStorage.removeItem(storageKey);
  pending.value = undefined;
  pendingBody = undefined;
}

function remember(value?: TeachingQuizRecovery) {
  try {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
    else sessionStorage.removeItem(storageKey);
  } catch {
    storageBlocked.value = true;
    throw new Error(
      "无法保存安全恢复元数据，未发送出卷请求；请恢复浏览器存储后重试。",
    );
  }
  pending.value = value;
  storageBlocked.value = false;
}

async function loadClasses() {
  if (!canTeach || denied.value || busy.value || cooldown.value) return;
  const token = ++serial;
  busy.value = true;
  error.value = "";
  try {
    const page = await props.request<TeachingClassList>("/teacher/classes", {
      signal: life.signal,
    });
    if (!alive || token !== serial) return;
    classes.value = page.items;
    notice.value = page.items.length
      ? ""
      : "当前没有有效授课班。授课关系由组织管理员维护。";
  } catch (cause) {
    if (token === serial) fail(cause);
  } finally {
    if (alive && token === serial) busy.value = false;
  }
}

async function openClass(row: TeachingClass) {
  if (locked.value && !!pending.value) return;
  if (dirty.value && !window.confirm("出卷表单尚未提交，确定离开？")) return;
  selectedClass.value = row;
  subjectId.value = "";
  clearDetail();
  createdQuiz.value = undefined;
  quizSubject.value = subjectId.value;
  view.value = "roster";
  await nextTick();
  if (alive && selectedClass.value?.id === row.id && view.value === "roster") {
    classHeading.value?.focus();
  }
  await Promise.all([loadRoster(), loadSubjects(row.id)]);
}

async function loadSubjects(classId: string) {
  subjectsBusy.value = true; subjectsError.value = "";
  try {
    const value = await props.request<typeof teachingCatalog.value>("/training/catalog", { signal: life.signal });
    if (!alive || denied.value || selectedClass.value?.id !== classId) return;
    teachingCatalog.value = value;
    if (classSubjects.value.length === 1) subjectId.value = classSubjects.value[0]!.id;
  } catch (cause) {
    if (alive && selectedClass.value?.id === classId) { subjectsError.value = "授课学科暂未读取，请重试。"; if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) fail(cause); }
  } finally { if (alive && selectedClass.value?.id === classId) subjectsBusy.value = false; }
}

async function loadRoster() {
  const clazz = selectedClass.value;
  if (!clazz || !canTeach || denied.value || cooldown.value) return;
  const token = ++serial;
  busy.value = true;
  error.value = "";
  roster.value = undefined;
  try {
    const value = await props.request<TeachingRoster>(
      `/teacher/classes/${encodeURIComponent(clazz.id)}/roster`,
      { signal: life.signal },
    );
    if (!alive || token !== serial) return;
    roster.value = value;
  } catch (cause) {
    if (token === serial) fail(cause);
  } finally {
    if (alive && token === serial) busy.value = false;
  }
}

async function loadClassReport() {
  const clazz = selectedClass.value;
  const subject = subjectId.value.trim();
  if (!clazz || !canReport || !subject || denied.value || cooldown.value)
    return;
  if (!/^[0-9a-f]{24}$/.test(subject)) {
    error.value = "请输入合法的学科编号（24位）。";
    return;
  }
  const token = ++serial;
  busy.value = true;
  error.value = "";
  classReport.value = undefined;
  studentReport.value = undefined;
  view.value = "class-report";
  try {
    const value = await props.request<TeachingClassSubjectReport>(
      `/teacher/classes/${encodeURIComponent(clazz.id)}/subjects/${encodeURIComponent(subject)}/report`,
      { signal: life.signal },
    );
    if (!alive || token !== serial) return;
    classReport.value = value;
    quizSubject.value = subject;
  } catch (cause) {
    if (token === serial) fail(cause);
  } finally {
    if (alive && token === serial) busy.value = false;
  }
}

async function openStudent(memberId: string, displayName: string) {
  const clazz = selectedClass.value;
  const subject = subjectId.value.trim() || quizSubject.value.trim();
  if (!clazz || !canReport || !subject) {
    error.value = "请先填写本班授课学科编号（24位），再查看单生报告。";
    return;
  }
  studentId.value = memberId;
  studentName.value = displayName;
  await loadStudentReport();
}

async function loadStudentReport() {
  const clazz = selectedClass.value;
  const subject = subjectId.value.trim() || quizSubject.value.trim();
  if (
    !clazz ||
    !studentId.value ||
    !canReport ||
    !subject ||
    denied.value ||
    cooldown.value
  )
    return;
  const token = ++serial;
  busy.value = true;
  error.value = "";
  studentReport.value = undefined;
  view.value = "student-report";
  try {
    const q = new URLSearchParams({ period: studentPeriod.value });
    const value = await props.request<TeachingStudentSubjectReport>(
      `/teacher/classes/${encodeURIComponent(clazz.id)}/subjects/${encodeURIComponent(subject)}/students/${encodeURIComponent(studentId.value)}/report?${q}`,
      { signal: life.signal },
    );
    if (!alive || token !== serial) return;
    studentReport.value = value;
  } catch (cause) {
    if (token === serial) fail(cause);
  } finally {
    if (alive && token === serial) busy.value = false;
  }
}

function copyRosterIds() {
  const ids = roster.value?.items.map((row) => row.member_id) || [];
  if (!ids.length) {
    notice.value = "当前名册没有可复制的成员。";
    return;
  }
  const text = ids.join("\n");
  void navigator.clipboard.writeText(text).then(
    () => {
      notice.value = `已复制 ${ids.length} 个成员 ID。可在「练习、考试与结果」管理台粘贴为显式受众（与 source_class_ids 互斥）。`;
    },
    () => {
      notice.value = `无法写入剪贴板。成员 ID：${ids.join("、")}`;
    },
  );
}

async function startQuizFromClass() {
  if (!canManage || !selectedClass.value) return;
  const classId = selectedClass.value.id;
  if (
    dirty.value &&
    view.value === "quiz" &&
    !window.confirm("放弃当前未提交出卷表单？")
  )
    return;
  createdQuiz.value = undefined;
  quizTitle.value = selectedClass.value
    ? `${selectedClass.value.name} 考试`
    : "";
  quizSubject.value = subjectId.value.trim();
  const now = new Date();
  const open = new Date(now.getTime() + 60 * 60 * 1000);
  const close = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const release = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  const local = (value: Date) =>
    new Date(value.getTime() - value.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  quizOpens.value = local(open);
  quizCloses.value = local(close);
  quizRelease.value = local(release);
  quizDuration.value = 600;
  quizAttempts.value = 1;
  quizItems.value = "";
  view.value = "quiz";
  notice.value =
    "参加人员按当前班级名册确定。先创建草稿，再由独立审核人员发布考试。";
  void loadQuizCandidates();
  await nextTick();
  if (alive && !denied.value && view.value === "quiz" && selectedClass.value?.id === classId && document.activeElement === document.body) quizHeading.value?.focus();
}

async function loadQuizCandidates() {
  if (!canManage || denied.value || candidateBusy.value || !quizSubject.value) return;
  const classId = selectedClass.value?.id, subject = quizSubject.value;
  candidateBusy.value = true; candidateError.value = ""; quizCandidates.value = [];
  try {
    const page = await props.request<{ items: typeof quizCandidates.value }>(`/admin/assessment-questions?subject_id=${encodeURIComponent(subject)}&limit=50`, { signal: life.signal });
    if (alive && !denied.value && classId === selectedClass.value?.id && subject === quizSubject.value) quizCandidates.value = page.items;
  } catch (cause) { if (alive && !denied.value && classId === selectedClass.value?.id && subject === quizSubject.value) { candidateError.value = cause instanceof Error ? cause.message : "题目读取失败。"; fail(cause); } }
  finally { candidateBusy.value = false; }
}
function changeQuizSubject() {
  quizItems.value = "";
  if (candidateBusy.value) return;
  void loadQuizCandidates();
}
function cancelClassQuiz() {
  if (locked.value || dirty.value && !window.confirm("放弃当前未提交的考试草稿？")) return;
  quizTitle.value = ""; quizSubject.value = ""; quizItems.value = ""; quizCandidates.value = []; view.value = "roster";
}

function toIso(local: string) {
  if (!local) return "";
  return new Date(local).toISOString();
}

async function createQuizDraft() {
  const clazz = selectedClass.value;
  if (
    !canManage ||
    !clazz ||
    writeBusy.value || candidateBusy.value ||
    pending.value ||
    storageBlocked.value ||
    denied.value
  )
    return;
  const subject = quizSubject.value.trim();
  const itemIds = quizItems.value
    .split(/[\s,，]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (!subject || !/^[0-9a-f]{24}$/.test(subject)) {
    error.value = "出卷需要合法学科编号（24位）（须与授课 assignment 一致）。";
    return;
  }
  if (!quizTitle.value.trim()) {
    error.value = "请填写考试标题。";
    return;
  }
  if (!Number.isInteger(quizDuration.value) || quizDuration.value < 60 || quizDuration.value > 7200) { error.value = "考试时长须为1至120分钟，精确到秒。"; return; }
  if (!itemIds.length || itemIds.some((id) => !/^[0-9a-f]{24}$/.test(id))) {
    error.value =
      "至少提供 1 个合法题目版本编号（24位）（可稍后在评估管理台增删）。";
    return;
  }
  const body = {
    title: quizTitle.value.trim(),
    subject_id: subject,
    opens_at: toIso(quizOpens.value),
    closes_at: toIso(quizCloses.value),
    release_at: toIso(quizRelease.value),
    duration_seconds: quizDuration.value,
    max_attempts: quizAttempts.value,
    items: itemIds.map((question_version_id) => ({ question_version_id })),
    source_class_ids: [clazz.id],
  };
  writeBusy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const metadata: TeachingQuizRecovery = {
      path: "/quizzes",
      method: "POST",
      key: crypto.randomUUID(),
    };
    remember(metadata);
    pendingBody = structuredClone(body);
    const saved = await props.request<QuizDraftSummary>("/quizzes", {
      method: "POST",
      body: pendingBody,
      idempotencyKey: metadata.key,
      signal: life.signal,
    });
    if (!alive) return;
    clearPending();
    createdQuiz.value = saved;
    notice.value = `草稿已创建：${saved.id}（修订 ${saved.revision}）。请到「练习、考试与结果」继续编排或交由独立审核发布。`;
  } catch (cause) {
    if (
      cause instanceof ApiError &&
      [400, 404, 409, 413, 422, 429].includes(cause.status) &&
      ![
        "IDEMPOTENCY_CONFLICT",
        "IDEMPOTENCY_RESULT_INVALID",
        "IDENTITY_CHANGED",
      ].includes(cause.code)
    ) {
      try {
        clearPending();
      } catch {
        /* keep blocked */
      }
    }
    fail(cause);
  } finally {
    if (alive) writeBusy.value = false;
  }
}

async function recoverQuizWrite() {
  const request = pending.value;
  if (!request || pendingBody === undefined || writeBusy.value || denied.value)
    return;
  writeBusy.value = true;
  error.value = "";
  try {
    const saved = await props.request<QuizDraftSummary>(request.path, {
      method: request.method,
      body: pendingBody,
      idempotencyKey: request.key,
      signal: life.signal,
    });
    if (!alive) return;
    clearPending();
    createdQuiz.value = saved;
    view.value = "quiz";
    notice.value = `原出卷请求已确认：${saved.id}。请到评估工作台继续处理。`;
  } catch (cause) {
    fail(cause);
  } finally {
    if (alive) writeBusy.value = false;
  }
}

function backToClasses() {
  if (dirty.value && !window.confirm("出卷表单尚未提交，确定返回班级列表？"))
    return;
  selectedClass.value = undefined;
  clearDetail();
  createdQuiz.value = undefined;
  view.value = "classes";
}

function beforeUnload(event: BeforeUnloadEvent) {
  if (unknown.value || dirty.value) {
    event.preventDefault();
    event.returnValue = "";
  }
}

onMounted(() => {
  if (!canTeach) return;
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (raw) {
      const value = JSON.parse(raw) as TeachingQuizRecovery;
      if (
        !value ||
        typeof value.key !== "string" ||
        !/^[A-Za-z0-9_-]{8,128}$/.test(value.key) ||
        value.path !== "/quizzes" ||
        value.method !== "POST" ||
        Object.keys(value).some(
          (key) => !["path", "method", "key"].includes(key),
        )
      )
        throw new Error("恢复元数据无效");
      pending.value = value;
      notice.value =
        "检测到未确认的出卷请求。刷新后仅保留安全元数据；若当时未丢失正文，可在本页恢复；否则请保留原编号由管理员核实服务端幂等记录。";
    }
  } catch {
    storageBlocked.value = true;
    error.value =
      "无法读取安全恢复元数据，已禁止出卷写入；请核实此前操作，不要清除存储后重复提交。";
  }
  window.addEventListener("beforeunload", beforeUnload);
  void loadClasses();
});

onBeforeUnmount(() => {
  alive = false;
  serial++;
  life.abort();
  window.clearInterval(timer);
  pendingBody = undefined;
  window.removeEventListener("beforeunload", beforeUnload);
  emit("dirty", false);
  emit("unknown", false);
});
</script>

<template>
  <section
    class="panel content-workspace stack learning-surface"
    aria-labelledby="teaching-title"
    :aria-busy="busy || writeBusy"
  >
    <header class="page-heading">
      <p class="eyebrow">
        <BrandIcon name="graduation-cap" />TEACHING / 教师工作台
      </p>
      <h2 id="teaching-title">班级、名册与学科报告</h2>
      <p class="muted">
        查看自己的授课班、学生名册与学习报告，按授权安排考试。
      </p>
    </header>

    <p v-if="!canTeach" class="notice" role="alert">
      当前身份不具备 teaching:class，无法进入教师工作台。
    </p>
    <template v-else>
      <nav class="content-toolbar" aria-label="教师导航">
        <button
          class="button secondary"
          :disabled="locked && !!pending"
          :aria-pressed="view === 'classes'"
          @click="backToClasses"
        >
          授课班列表
        </button>
        <button
          v-if="selectedClass"
          class="button secondary"
          :disabled="locked && !!pending"
          :aria-pressed="view === 'roster'"
          @click="
            view = 'roster';
            loadRoster();
          "
        >
          名册
        </button>
        <button
          v-if="selectedClass && canReport"
          class="button secondary"
          :disabled="locked && !!pending"
          :aria-pressed="view === 'class-report'"
          @click="loadClassReport()"
        >
          班级报告
        </button>
        <button
          v-if="selectedClass && canManage"
          class="button secondary"
          :disabled="locked && !!pending"
          :aria-pressed="view === 'quiz'"
          @click="startQuizFromClass"
        >
          从班级出卷
        </button>
      </nav>

      <p v-if="error" class="notice" role="alert">{{ error }}</p>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
      <p v-if="cooldown" role="status">
        服务端限流，请等待 {{ cooldown }} 秒再重试。
      </p>
      <p v-if="denied" class="notice">
        当前资源或身份已不可访问。请重新确认身份与组织后进入。
      </p>

      <section
        v-if="pending || storageBlocked"
        class="notice stack"
        aria-label="出卷请求恢复"
      >
        <p v-if="pending">
          原出卷请求编号 {{ pending.key }}。已冻结新建出卷，不能换编号重复提交。
        </p>
        <p v-if="pending && pendingBody === undefined">
          页面刷新后未保留请求正文，不能自动重放。请保留原编号核实服务端记录。
        </p>
        <p v-if="storageBlocked">恢复存储不可用，已禁止出卷写入。</p>
        <div class="actions">
          <button
            v-if="pending && pendingBody !== undefined"
            class="button"
            :disabled="writeBusy"
            @click="recoverQuizWrite"
          >
            以原编号和原正文恢复出卷
          </button>
        </div>
      </section>

      <template v-if="!denied">
        <section
          v-if="view === 'classes'"
          class="stack content-section"
          aria-label="授课班"
        >
          <div class="actions">
            <button
              class="button secondary"
              :disabled="locked"
              @click="loadClasses()"
            >
              刷新班级列表
            </button>
          </div>
          <p v-if="busy" role="status">正在读取授课班…</p>
          <p v-else-if="!classes.length" class="content-empty">
            暂无可见授课班。
          </p>
          <ul class="content-list">
            <li v-for="row in classes" :key="row.id">
              <div>
                <p>{{ row.name }} · {{ row.year_label }}</p>
                <details><summary>版本与定位信息</summary><p class="field-help">班级 {{ row.id }} · 修订 {{ row.revision }}</p></details>
              </div>
              <button
                class="button secondary"
                :disabled="locked"
                @click="openClass(row)"
              >
                打开名册
              </button>
            </li>
          </ul>
        </section>

        <section
          v-else-if="selectedClass"
          class="stack content-section"
          aria-label="当前班级"
        >
          <h3 ref="classHeading" tabindex="-1">{{ selectedClass.name }} · {{ selectedClass.year_label }}</h3>
          <details><summary>班级定位信息</summary><p class="field-help">班级编号 {{ selectedClass.id }}</p></details>

          <div class="field">
            <label for="teaching-subject">授课学科</label>
            <select id="teaching-subject" v-model="subjectId" :disabled="locked || subjectsBusy"><option value="">{{ subjectsBusy ? '正在读取授课学科…' : '选择本班授课学科' }}</option><option v-for="item in classSubjects" :key="item.id" :value="item.id">{{ item.name }}</option></select>
            <p v-if="subjectsError" role="status">{{ subjectsError }}</p>
            <button v-if="subjectsError" class="text-button" :disabled="subjectsBusy || locked" @click="loadSubjects(selectedClass.id)">重新读取学科</button>
            <p v-else-if="!subjectsBusy && !classSubjects.length" class="field-help">暂无可用授课学科，请联系组织管理员确认授课关系。</p>
            <details><summary>按已知学科编号定位</summary><input v-model="subjectId" aria-label="授课学科编号" :disabled="locked || subjectsBusy" pattern="[0-9a-f]{24}" /><p class="field-help">仅用于已知授课编号；报告和出卷仍由服务端核验本班授课权限。</p></details>
          </div>

          <template v-if="view === 'roster'">
            <div class="actions">
              <button
                class="button secondary"
                :disabled="locked"
                @click="loadRoster()"
              >
                刷新名册
              </button>
              <button
                class="button secondary"
                :disabled="locked || !roster?.items.length"
                @click="copyRosterIds"
              >
                复制成员 ID
              </button>
              <button
                v-if="canReport"
                class="button secondary"
                :disabled="locked || !subjectId.trim()"
                @click="loadClassReport()"
              >
                读取班级学科报告
              </button>
              <button
                v-if="canManage"
                class="button"
                :disabled="locked"
                @click="startQuizFromClass"
              >
                从本班出卷
              </button>
            </div>
            <p v-if="busy" role="status">正在读取名册…</p>
            <p v-else-if="roster && !roster.items.length" class="content-empty">
              名册为空。
            </p>
            <ul v-if="roster" class="content-list">
              <li v-for="row in roster.items" :key="row.member_id">
                <div>
                  <p>{{ row.display_name }}</p>
                  <details><summary>成员定位信息</summary><p class="field-help">{{ row.member_id }}</p></details>
                </div>
                <button
                  v-if="canReport"
                  class="button secondary"
                  :disabled="locked || !subjectId.trim()"
                  @click="openStudent(row.member_id, row.display_name)"
                >
                  单生报告
                </button>
              </li>
            </ul>
            <p v-if="!canReport" class="field-help">
              未授予 teaching:report 时仅可查看名册；不可读取班级或单生报告。
            </p>
            <p v-if="!canManage" class="field-help">
              未授予 assessment:manage 时不能从班出卷。可将成员 ID
              复制后交由已授权编排者使用显式受众。
            </p>
          </template>

          <template v-else-if="view === 'class-report'">
            <div class="actions">
              <button
                class="button secondary"
                :disabled="locked || !subjectId.trim()"
                @click="loadClassReport()"
              >
                重新读取班级报告
              </button>
              <button
                class="button secondary"
                :disabled="locked"
                @click="cancelClassQuiz"
              >
                返回名册
              </button>
            </div>
            <p v-if="busy" role="status">正在读取班级报告…</p>
            <template v-if="classReport">
              <p
                v-if="classReport.status === 'insufficient'"
                class="notice"
                role="status"
              >
                当前没有可展示投影样本；不以假零分填充。
              </p>
              <dl class="learning-facts">
                <div>
                  <dt>在册学生</dt>
                  <dd>{{ classReport.roster_count }}</dd>
                </div>
                <div>
                  <dt>有投影人数</dt>
                  <dd>{{ classReport.projected_count }}</dd>
                </div>
                <div>
                  <dt>近 7 / 30 天提交合计</dt>
                  <dd>
                    {{ classReport.submission_count_7d }} /
                    {{ classReport.submission_count_30d }}
                  </dd>
                </div>
              </dl>
              <h4>掌握度分档</h4>
              <dl class="learning-facts">
                <div>
                  <dt>证据不足</dt>
                  <dd>{{ classReport.mastery_bands.insufficient_evidence }}</dd>
                </div>
                <div>
                  <dt>薄弱</dt>
                  <dd>{{ classReport.mastery_bands.weak }}</dd>
                </div>
                <div>
                  <dt>巩固中</dt>
                  <dd>{{ classReport.mastery_bands.developing }}</dd>
                </div>
                <div>
                  <dt>已掌握</dt>
                  <dd>{{ classReport.mastery_bands.mastered }}</dd>
                </div>
              </dl>
              <h4>薄弱知识点 Top</h4>
              <p v-if="!classReport.weak_knowledge_points.length" class="muted">
                暂无薄弱知识点汇总。
              </p>
              <ul v-else class="content-list">
                <li
                  v-for="row in classReport.weak_knowledge_points"
                  :key="row.knowledge_point_id"
                >
                  <div>
                    <p>{{ row.title }}</p>
                    <p class="field-help">
                      {{ row.knowledge_point_id }} · {{ row.student_count }} 人
                    </p>
                  </div>
                </li>
              </ul>
              <p class="field-help">
                规则 {{ classReport.rule_version }} · 学科
                {{ classReport.subject_id }}
              </p>
            </template>
          </template>

          <template v-else-if="view === 'student-report'">
            <div class="actions">
              <button
                class="button secondary"
                :disabled="locked"
                :aria-pressed="studentPeriod === '7d'"
                @click="
                  studentPeriod = '7d';
                  loadStudentReport();
                "
              >
                近 7 天
              </button>
              <button
                class="button secondary"
                :disabled="locked"
                :aria-pressed="studentPeriod === '30d'"
                @click="
                  studentPeriod = '30d';
                  loadStudentReport();
                "
              >
                近 30 天
              </button>
              <button
                class="button secondary"
                :disabled="locked"
                @click="cancelClassQuiz"
              >
                返回名册
              </button>
            </div>
            <h4>{{ studentName || "学生" }} · 学科绑定报告</h4>
            <p class="field-help">成员 {{ studentId }}</p>
            <p v-if="busy" role="status">正在读取单生报告…</p>
            <template v-if="studentReport">
              <p v-if="studentReport.status === 'updating'" class="notice">
                学情正在更新；本页不显示旧证据。
              </p>
              <p
                v-else-if="studentReport.status === 'unavailable'"
                class="notice"
              >
                学情暂不可用。
              </p>
              <p
                v-else-if="studentReport.status === 'insufficient_evidence'"
                class="notice"
              >
                证据不足，待诊断不等于 0 分。
              </p>
              <template
                v-if="
                  studentReport.status === 'ready' ||
                  studentReport.status === 'insufficient_evidence'
                "
              >
                <section v-if="studentReport.activity" class="stack">
                  <h4>活动（{{ studentReport.period }}）</h4>
                  <dl class="learning-facts">
                    <div>
                      <dt>有效提交</dt>
                      <dd>{{ studentReport.activity.submission_count }}</dd>
                    </div>
                    <div>
                      <dt>作答次数</dt>
                      <dd>{{ studentReport.activity.attempt_count }}</dd>
                    </div>
                    <div>
                      <dt>正确 / 错误 / 未答</dt>
                      <dd>
                        {{ studentReport.activity.correct_count }} /
                        {{ studentReport.activity.incorrect_count }} /
                        {{ studentReport.activity.unanswered_count }}
                      </dd>
                    </div>
                    <div>
                      <dt>首次证据正确率</dt>
                      <dd>
                        {{
                          studentReport.activity.correctness === null
                            ? "待诊断"
                            : `${studentReport.activity.correctness}%`
                        }}
                      </dd>
                    </div>
                    <div>
                      <dt>精确分子 / 分母</dt>
                      <dd>
                        {{ studentReport.activity.numerator }} /
                        {{ studentReport.activity.denominator }}
                      </dd>
                    </div>
                  </dl>
                </section>
                <p v-else class="muted">当前周期没有可展示活动证据。</p>
                <h4>90 天掌握度</h4>
                <p v-if="!studentReport.mastery.length">暂无可见独立证据。</p>
                <ul v-else class="content-list">
                  <li
                    v-for="row in studentReport.mastery"
                    :key="row.knowledge_point_id"
                  >
                    <div class="stack">
                      <p>{{ row.knowledge_point_id }}</p>
                      <p>
                        {{
                          row.mastery === null
                            ? "待诊断"
                            : `掌握度 ${row.mastery}%`
                        }}
                        · {{ row.independent_question_count }} 道独立首次题
                      </p>
                      <p class="field-help">
                        {{ row.status }} · 最后证据 {{ row.last_evidence_at }}
                      </p>
                    </div>
                  </li>
                </ul>
              </template>
              <p class="field-help">
                规则 {{ studentReport.rule_version }} · 生成
                {{ studentReport.generated_at || "尚未生成" }}
              </p>
            </template>
          </template>

          <template v-else-if="view === 'quiz' && canManage">
            <h4 ref="quizHeading" tabindex="-1">从班级创建考试草稿</h4>
            <p class="field-help">
              参加人员来自当前班级名册。选题后创建草稿，交由独立审核人员发布。
            </p>
            <form class="stack" @submit.prevent="createQuizDraft">
              <fieldset
                class="content-fields stack"
                :disabled="locked || !!createdQuiz"
              >
                <div class="field">
                  <label for="quiz-from-class-title">考试标题</label>
                  <input
                    id="quiz-from-class-title"
                    v-model="quizTitle"
                    required
                    maxlength="200"
                  />
                </div>
                <div class="field">
                  <label for="quiz-from-class-subject">授课学科</label>
                  <select id="quiz-from-class-subject" v-model="quizSubject" required :disabled="candidateBusy" @change="changeQuizSubject"><option disabled value="">选择学科</option><option v-for="subject in classSubjects" :key="subject.id" :value="subject.id">{{ subject.name }}</option></select>
                  <details><summary>按已知学科编号定位</summary><label for="quiz-subject-id">学科编号</label><input id="quiz-subject-id" v-model="quizSubject" pattern="[0-9a-f]{24}" :disabled="candidateBusy" @change="changeQuizSubject" /></details>
                </div>
                <div class="content-columns">
                  <div class="field">
                    <label for="quiz-from-class-opens">开放时间（本地时区）</label>
                    <input
                      id="quiz-from-class-opens"
                      v-model="quizOpens"
                      type="datetime-local"
                      required
                    />
                  </div>
                  <div class="field">
                    <label for="quiz-from-class-closes">关闭时间（本地时区）</label>
                    <input
                      id="quiz-from-class-closes"
                      v-model="quizCloses"
                      type="datetime-local"
                      required
                    />
                  </div>
                  <div class="field">
                    <label for="quiz-from-class-release">成绩发布时间（本地时区）</label>
                    <input
                      id="quiz-from-class-release"
                      v-model="quizRelease"
                      type="datetime-local"
                      required
                    />
                  </div>
                  <div class="field">
                    <label for="quiz-from-class-duration">时长（分钟）</label>
                    <input
                      id="quiz-from-class-duration"
                      v-model.number="quizMinutes"
                      type="number"
                      min="1"
                      max="120"
                      step="any"
                      required
                    />
                  </div>
                  <div class="field">
                    <label for="quiz-from-class-attempts">最多参加次数</label>
                    <input
                      id="quiz-from-class-attempts"
                      v-model.number="quizAttempts"
                      type="number"
                      min="1"
                      max="3"
                      required
                    />
                  </div>
                </div>
                <div class="field">
                  <h5>选择题目 · 已选 {{ selectedQuestionIds.length }} 题</h5>
                  <p v-if="candidateBusy" role="status">正在读取可用题目…</p><p v-if="candidateError" role="alert">{{ candidateError }}</p>
                  <p v-if="!candidateBusy && !candidateError && !quizCandidates.length">选择学科后读取可用题目；暂无题目时可到考试管理完善题库。</p>
                  <label v-for="question in quizCandidates" :key="question.id" class="check-label"><input v-model="selectedQuestionIds" type="checkbox" :value="question.id" :disabled="!selectedQuestionIds.includes(question.id) && selectedQuestionIds.length >= 50" />{{ question.title }}</label>
                  <button type="button" class="button secondary" :disabled="candidateBusy || !quizSubject" @click="loadQuizCandidates">重新读取题目（最多50题）</button>
                  <details><summary>按已知题目版本编号选题</summary><label for="quiz-from-class-items">题目版本编号（空格或逗号分隔）</label><textarea id="quiz-from-class-items" v-model="quizItems" rows="3" /></details>
                </div>
                <details><summary>班级定位信息</summary><p>{{ selectedClass.id }}</p></details>
              </fieldset>
              <div class="actions">
                <button
                  class="button"
                  type="submit"
                  :disabled="locked || !!createdQuiz"
                >
                  创建考试草稿
                </button>
                <button
                  type="button"
                  class="button secondary"
                  :disabled="writeBusy"
                  @click="emit('openAssessment')"
                >
                  打开评估工作台
                </button>
                <button
                  type="button"
                  class="button secondary"
                  :disabled="locked"
                  @click="cancelClassQuiz"
                >
                  取消并返回名册
                </button>
              </div>
            </form>
            <p v-if="createdQuiz" class="notice" role="status">
              已创建草稿 {{ createdQuiz.title }} · {{ createdQuiz.id }} · 状态
              {{ createdQuiz.status }}
              <template v-if="createdQuiz.source_class_ids?.length">
                · 班级来源
                {{ createdQuiz.source_class_ids.join("、") }}</template
              >
            </p>
          </template>
        </section>
      </template>
    </template>
  </section>
</template>

<style scoped>
.learning-facts {
  display: grid;
  grid-template-columns: repeat(
    auto-fit,
    minmax(min(100%, var(--layout-min)), 1fr)
  );
  gap: var(--space-4);
  margin: 0;
}
.learning-facts dt {
  color: var(--color-muted);
  font-size: var(--text-small);
}
.learning-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
h3,
h4 {
  margin: 0;
}
.content-list > li,
.content-list > li > div {
  min-width: 0;
}
</style>
