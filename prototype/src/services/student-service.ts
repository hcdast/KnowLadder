import { computed, reactive, ref, watch } from "vue";
import { demo, uid, wait } from "./core";
import { availableResources, chapterId, type Resource } from "./catalogue";
export interface Question {
  id: string;
  version: number;
  prompt: string;
  type: "single" | "multiple" | "numeric";
  options: string[];
  knowledge: string;
}
export interface Session {
  id: string;
  mode: "practice" | "quiz";
  chapterId: string;
  questions: Question[];
  answers: Record<string, string>;
  saved: Record<string, string>;
  marks: string[];
  revision: number;
  draftVersion: number;
  savedVersion: number;
  status: "in_progress" | "submitted";
  local:
    | "clean"
    | "dirty"
    | "saving"
    | "save_failed"
    | "conflict"
    | "submitting"
    | "confirmation_pending";
  message: string;
  savedAt: string;
  deadline: number | null;
  submissionId: string;
  requestKey: string;
  current: number;
  seen: boolean;
}
export interface Submission {
  id: string;
  sessionId: string;
  mode: Session["mode"];
  chapterId: string;
  state: "pending" | "completed" | "unreleased" | "failed" | "review";
  createdAt: string;
  requestKey: string;
  deadline: boolean;
}
interface Review {
  question: Question;
  answer: string;
  correctAnswer: string;
  correct: boolean;
  explanation: string;
}
interface FrozenRequest {
  key: string;
  revision: number;
  answers: Record<string, string>;
}
const rubrics = new Map<string, Resource[]>(),
  grades = new Map<string, Review[]>(),
  requests = new Map<string, FrozenRequest>();
const saving = new Map<string, Promise<boolean>>(),
  submitting = new Map<string, Promise<string | null>>();
let creating: Promise<Session | null> | null = null;
const reportSnapshot = ref<string[] | null>(null);
let activeSession = "";
export const student = reactive({
  sessions: [] as Session[],
  submissions: [] as Submission[],
  createMessage: "",
  creating: false,
  filters: { textbook: "", search: "", mistake: "", mode: "", period: "all" },
  positions: {} as Record<string, number>,
  reportUpdated: "",
});
export const textbooks = computed(() =>
  availableResources("textbook").map((r) => ({
    id: r.id,
    title: r.title,
    version: r.version,
    source: r.source,
    chapters: r.chapters.map((c) => ({ ...c })),
  })),
);
export const chapters = computed(() =>
  textbooks.value.flatMap((b) =>
    b.chapters.map((c) => ({
      ...c,
      textbook: b.title,
      textbookId: b.id,
      version: b.version,
    })),
  ),
);
export const defaultChapterId = chapterId;
export const quizId = "equations-check";
export const quizWindow = reactive({
  opens: Date.now() - 3600000,
  closes: Date.now() + 86400000,
});
export function getChapter(id: string) {
  return chapters.value.find((c) => c.id === id);
}
export function getSession(id: string) {
  return student.sessions.find((s) => s.id === id);
}
export function getSubmission(id: string) {
  return student.submissions.find((s) => s.id === id);
}
export function sessionPath(s: Session) {
  return `/student/${s.mode === "quiz" ? "quiz" : "practice"}/sessions/${s.id}`;
}
function displayQuestion(q: Resource): Question {
  return {
    id: q.id,
    version: q.version,
    prompt: q.prompt,
    type: q.questionType,
    options: [...q.options],
    knowledge: q.knowledge,
  };
}
function eligible(id: string, difficulty: string, type: string) {
  const chapter = getChapter(id);
  return chapter
    ? availableResources("question").filter(
        (q) =>
          q.knowledge === chapter.knowledge &&
          q.difficulty === difficulty &&
          (type === "all" || q.questionType === type),
      )
    : [];
}
export function questionCount(id: string, difficulty: string, type: string) {
  return demo.fault === "no-questions"
    ? 0
    : eligible(id, difficulty, type).length;
}
function makeSession(
  mode: Session["mode"],
  id: string,
  questions: Resource[],
  seen: boolean,
): Session {
  const s: Session = {
    id: uid(),
    mode,
    chapterId: id,
    questions: questions.map(displayQuestion),
    answers: {},
    saved: {},
    marks: [],
    revision: 0,
    draftVersion: 0,
    savedVersion: 0,
    status: "in_progress",
    local: "clean",
    message: "",
    savedAt: "",
    deadline:
      mode === "quiz" ? Math.min(Date.now() + 600000, quizWindow.closes) : null,
    submissionId: "",
    requestKey: "",
    current: 0,
    seen,
  };
  rubrics.set(
    s.id,
    questions.map((q) =>
      structuredClone({
        ...q,
        options: [...q.options],
        chapters: q.chapters.map((c) => ({ ...c })),
        history: [...q.history],
      }),
    ),
  );
  student.sessions.push(s);
  return getSession(s.id)!;
}
export function createSession(
  mode: Session["mode"],
  id: string,
  difficulty = "基础",
  type = "all",
  seen = false,
): Promise<Session | null> {
  if (creating) return creating;
  const epoch = demo.epoch;
  student.creating = true;
  student.createMessage = "";
  creating = (async () => {
    await wait(350);
    if (epoch !== demo.epoch) return null;
    if (demo.fault === "offline") {
      student.createMessage =
        "连接失败，未创建会话、未扣除次数。请恢复连接后重试。";
      return null;
    }
    if (mode === "quiz") {
      const existing = student.sessions.find((s) => s.mode === "quiz");
      if (existing) return existing;
      if (Date.now() < quizWindow.opens || Date.now() >= quizWindow.closes) {
        student.createMessage = "测验不在开放时间内。";
        return null;
      }
    }
    const qs =
      demo.fault === "no-questions" ? [] : eligible(id, difficulty, type);
    if (!qs.length) {
      student.createMessage =
        "当前章节、难度与题型组合没有可用题目。请调整范围，不会使用其他范围补题。";
      return null;
    }
    const s = makeSession(mode, id, qs, seen);
    if (demo.fault === "deadline" && mode === "quiz") s.deadline = Date.now();
    return s;
  })().finally(() => {
    if (epoch === demo.epoch) {
      creating = null;
      student.creating = false;
    }
  });
  return creating;
}
export function isLocked(s: Session) {
  return (
    s.status !== "in_progress" ||
    ["submitting", "confirmation_pending"].includes(s.local) ||
    (s.deadline !== null && Date.now() >= s.deadline)
  );
}
function syncDirty() {
  const s = getSession(activeSession);
  demo.dirty =
    !!s &&
    (s.local === "confirmation_pending" ||
      s.local === "submitting" ||
      (s.status === "in_progress" && s.draftVersion !== s.savedVersion));
}
export function setActiveSession(id: string) {
  activeSession = id;
  syncDirty();
}
export function changeAnswer(s: Session, id: string, answer: string) {
  if (isLocked(s) || !s.questions.some((q) => q.id === id)) return;
  s.answers[id] = answer;
  s.draftVersion++;
  if (!["conflict", "save_failed", "saving"].includes(s.local))
    s.local = "dirty";
  syncDirty();
  if (!["conflict", "save_failed"].includes(s.local)) void saveAnswers(s);
}
export function toggleMark(s: Session, id: string) {
  if (s.marks.includes(id)) s.marks = s.marks.filter((v) => v !== id);
  else s.marks.push(id);
}
export function saveAnswers(s: Session): Promise<boolean> {
  const existing = saving.get(s.id);
  if (existing) return existing;
  if (
    s.status !== "in_progress" ||
    s.local === "confirmation_pending" ||
    s.local === "conflict"
  )
    return Promise.resolve(false);
  const epoch = demo.epoch;
  const task = (async () => {
    while (s.draftVersion !== s.savedVersion) {
      if (s.deadline !== null && Date.now() >= s.deadline) {
        s.message = "已到截止时间，本地未确认保存的答案不会补交。";
        return false;
      }
      const version = s.draftVersion,
        revision = s.revision,
        answers = { ...s.answers };
      if (s.local !== "submitting") s.local = "saving";
      await wait(450);
      if (epoch !== demo.epoch) return false;
      if (s.deadline !== null && Date.now() >= s.deadline) {
        s.message = "保存未在截止前确认，不计入截止提交。";
        return false;
      }
      if (demo.fault === "offline") {
        s.local = "save_failed";
        s.message = "尚未保存，请勿关闭页面。草稿仅保留在当前内存中。";
        return false;
      }
      if (demo.fault === "conflict") {
        s.revision = revision + 1;
        const first = s.questions[0];
        if (first)
          s.saved = {
            ...s.saved,
            [first.id]: first.type === "numeric" ? "9" : "C",
          };
        s.local = "conflict";
        s.message = "模拟另一设备已写入新的 revision。请比较并明确选择版本。";
        return false;
      }
      s.saved = answers;
      s.revision = revision + 1;
      s.savedVersion = version;
      s.savedAt = new Date().toLocaleTimeString();
      syncDirty();
    }
    if (s.local !== "submitting") s.local = "clean";
    s.message = "";
    syncDirty();
    return true;
  })().finally(() => {
    if (epoch === demo.epoch) saving.delete(s.id);
  });
  saving.set(s.id, task);
  return task;
}
export async function retrySave(s: Session) {
  if (demo.fault === "offline") demo.fault = "normal";
  return saveAnswers(s);
}
export async function resolveConflict(s: Session, local: boolean) {
  if (isLocked(s) || s.local !== "conflict") return false;
  if (demo.fault === "conflict") demo.fault = "normal";
  if (!local) {
    s.answers = { ...s.saved };
    s.draftVersion++;
    s.savedVersion = s.draftVersion;
    s.local = "clean";
    s.message = "";
    syncDirty();
    return true;
  }
  s.local = "dirty";
  return saveAnswers(s);
}
function numeric(value: string) {
  const text = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  let [whole, fraction = ""] = text.replace(/^[+-]/, "").split(".");
  whole = (whole || "0").replace(/^0+(?=\d)/, "");
  fraction = fraction.replace(/0+$/, "");
  const magnitude = whole + (fraction ? "." + fraction : "");
  return (text.startsWith("-") && magnitude !== "0" ? "-" : "") + magnitude;
}
function correct(type: Question["type"], answer: string, expected: string) {
  if (type === "numeric")
    return numeric(answer) !== null && numeric(answer) === numeric(expected);
  if (type === "multiple")
    return (
      [...new Set(answer.split(",").filter(Boolean))].sort().join(",") ===
      [...new Set(expected.split(",").filter(Boolean))].sort().join(",")
    );
  return answer === expected;
}
function accept(s: Session, request: FrozenRequest, deadline: boolean): string {
  if (s.submissionId) return s.submissionId;
  const id = uid();
  grades.set(
    id,
    (rubrics.get(s.id) || []).map((q) => ({
      question: displayQuestion(q),
      answer: request.answers[q.id] || "",
      correctAnswer: q.correctAnswer,
      correct: correct(
        q.questionType,
        request.answers[q.id] || "",
        q.correctAnswer,
      ),
      explanation: q.explanation,
    })),
  );
  student.submissions.unshift({
    id,
    sessionId: s.id,
    mode: s.mode,
    chapterId: s.chapterId,
    state: "pending",
    createdAt: new Date().toISOString(),
    requestKey: request.key,
    deadline,
  });
  s.submissionId = id;
  s.status = "submitted";
  s.local = "clean";
  syncDirty();
  const epoch = demo.epoch,
    fault = demo.fault;
  void wait(1100).then(() => {
    if (epoch !== demo.epoch) return;
    const result = getSubmission(id);
    if (!result || result.state !== "pending") return;
    result.state =
      fault === "unreleased"
        ? "unreleased"
        : fault === "failed"
          ? "failed"
          : fault === "review"
            ? "review"
            : "completed";
    if (result.state === "completed" && reportSnapshot.value === null)
      student.reportUpdated = new Date().toISOString();
  });
  return id;
}
export function submitSession(s: Session): Promise<string | null> {
  if (s.local === "confirmation_pending") return Promise.resolve(null);
  if (s.submissionId) return Promise.resolve(s.submissionId);
  const running = submitting.get(s.id);
  if (running) return running;
  if (
    s.local === "conflict" &&
    (s.deadline === null || Date.now() < s.deadline)
  )
    return Promise.resolve(null);
  const epoch = demo.epoch;
  s.local = "submitting";
  syncDirty();
  const task = (async () => {
    const inflight = saving.get(s.id);
    if (inflight) await inflight;
    if (epoch !== demo.epoch) return null;
    const overdue = s.deadline !== null && Date.now() >= s.deadline;
    if (!overdue) {
      if (s.local === "conflict" || s.local === "save_failed") return null;
      if (!(await saveAnswers(s))) return null;
      if (epoch !== demo.epoch) return null;
    }
    let request = requests.get(s.id);
    if (!request) {
      request = {
        key: uid(),
        revision: s.revision,
        answers: { ...(overdue ? s.saved : s.answers) },
      };
      requests.set(s.id, request);
    }
    s.requestKey = request.key;
    s.local = "submitting";
    await wait(450);
    if (epoch !== demo.epoch) return null;
    if (demo.fault === "offline") {
      requests.delete(s.id);
      s.requestKey = "";
      s.local = "save_failed";
      s.message =
        "连接不可用，演示服务已确认此请求未受理且不会迟到生效。恢复后可重试。";
      syncDirty();
      return null;
    }
    const nowOverdue = s.deadline !== null && Date.now() >= s.deadline;
    const id = accept(
      s,
      nowOverdue ? { ...request, answers: { ...s.saved } } : request,
      nowOverdue,
    );
    if (demo.fault === "lost-response") {
      s.local = "confirmation_pending";
      s.message =
        "正在确认是否提交成功。原请求已冻结，请使用同一请求查询，不要重复交卷。";
      syncDirty();
      return null;
    }
    return id;
  })().finally(() => {
    if (epoch === demo.epoch) {
      submitting.delete(s.id);
      if (s.local === "submitting" && !s.submissionId)
        s.local = s.draftVersion === s.savedVersion ? "clean" : "dirty";
      syncDirty();
    }
  });
  submitting.set(s.id, task);
  return task;
}
export async function confirmSubmission(s: Session) {
  const epoch = demo.epoch;
  await wait(350);
  if (epoch !== demo.epoch) return null;
  if (s.submissionId) {
    s.local = "clean";
    s.message = "";
    syncDirty();
    return s.submissionId;
  }
  return submitSession(s);
}
export async function recoverResult(id: string) {
  const epoch = demo.epoch;
  await wait(350);
  if (epoch !== demo.epoch) return;
  const result = getSubmission(id);
  if (!result || result.state === "pending") return;
  result.state = "completed";
  if (reportSnapshot.value === null)
    student.reportUpdated = new Date().toISOString();
}
export function resultDetails(id: string) {
  return getSubmission(id)?.state === "completed" ? grades.get(id) || [] : [];
}
export const published = computed(() =>
  student.submissions.filter((s) => s.state === "completed"),
);
export function reportEvidence() {
  const sources =
    reportSnapshot.value === null
      ? published.value
      : published.value.filter((s) => reportSnapshot.value!.includes(s.id));
  return sources.flatMap((s) =>
    resultDetails(s.id).map((item) => ({ ...item, submission: s })),
  );
}
export function refreshReport() {
  reportSnapshot.value = null;
  if (demo.fault === "stale") demo.fault = "normal";
  student.reportUpdated = new Date().toISOString();
}
export function mistakes() {
  return published.value.flatMap((s) =>
    resultDetails(s.id)
      .filter((item) => !item.correct)
      .map((item) => ({ ...item, submission: s })),
  );
}
watch(
  () => demo.fault,
  (fault) => {
    if (fault === "deadline")
      student.sessions
        .filter((s) => s.mode === "quiz" && s.status === "in_progress")
        .forEach((s) => {
          s.deadline = Date.now();
        });
    if (fault === "stale") {
      const previous = published.value.slice(1);
      reportSnapshot.value = previous.map((s) => s.id);
      student.reportUpdated = previous[0]?.createdAt || "";
    } else {
      reportSnapshot.value = null;
      if (published.value.length)
        student.reportUpdated = new Date().toISOString();
    }
  },
  { flush: "sync" },
);
function reset() {
  rubrics.clear();
  grades.clear();
  requests.clear();
  saving.clear();
  submitting.clear();
  creating = null;
  reportSnapshot.value = null;
  activeSession = "";
  student.sessions = [];
  student.submissions = [];
  student.creating = false;
  student.createMessage = "";
  student.filters = {
    textbook: "",
    search: "",
    mistake: "",
    mode: "",
    period: "all",
  };
  student.positions = {};
  student.reportUpdated = "";
  quizWindow.opens = Date.now() - 3600000;
  quizWindow.closes = Date.now() + 86400000;
  if (demo.scenario === "returning") {
    const qs = eligible(chapterId, "基础", "all");
    if (!qs.length) return;
    const history = makeSession("practice", chapterId, qs, false);
    history.answers = Object.fromEntries(
      qs.map((q, i) => [q.id, i === 0 ? q.correctAnswer : ""]),
    );
    history.saved = { ...history.answers };
    const id = accept(
      history,
      { key: uid(), revision: 1, answers: { ...history.answers } },
      false,
    );
    getSubmission(id)!.state = "completed";
    makeSession("practice", chapterId, qs, true);
    demo.readChapterId = chapterId;
    student.reportUpdated = new Date().toISOString();
  }
  if (demo.fault === "stale") {
    reportSnapshot.value = [];
    student.reportUpdated = "";
  }
}
watch(() => demo.epoch, reset, { flush: "sync" });
reset();
