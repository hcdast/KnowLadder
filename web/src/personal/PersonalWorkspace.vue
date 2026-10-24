<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";
import { RouterLink, useRoute } from "vue-router";
import { ApiError, type GlobalRequest, type Identity } from "../session";
import type { components } from "../api/schema";
import GuardianReview from "./GuardianReview.vue";
import CourseCenter from "./CourseCenter.vue";
import StudyNotebook from "./StudyNotebook.vue";
import WeekPlanner from "./WeekPlanner.vue";
type S = components["schemas"];
type Goal = S["LifelongGoal"];
type Activity = S["LifelongActivity"];
type Support = S["LifelongSupport"];
type Page<T> = { items: T[]; next_cursor: string | null };
const props = defineProps<{ identity: Identity; request: GlobalRequest }>();
const emit = defineEmits<{
  dirty: [value: boolean];
  unknown: [value: boolean];
}>();
const stages = {
  early: "启蒙成长",
  school: "学校学习",
  higher: "大学与专业",
  career: "职业发展",
  life: "兴趣生活",
  senior: "银龄学习",
};
const fields = {
  language: "语言与阅读",
  science: "数理与科学",
  humanities: "人文与社会",
  arts: "艺术与创作",
  health: "运动与健康素养",
  digital: "数字与AI素养",
  career: "职业技能",
  life: "生活与家庭",
};
const kinds = {
  reading: "阅读",
  course: "课程学习",
  practice: "练习",
  project: "探究项目",
  creation: "创作与作品",
  offline: "线下实践",
  reflection: "回顾与反思",
};
const scopeNames: Record<string, string> = {
  goals: "指定目标",
  activities: "指定活动",
  feedback: "支持反馈",
};
const statusNames: Record<string, string> = {
  pending: "待接受",
  active: "关系已建立",
  revoked: "已撤回",
  expired: "已到期",
  approved: "已核验",
  rejected: "未通过",
};
const route = useRoute();
const courseCenter = ref<InstanceType<typeof CourseCenter>>();
const studyNotebook = ref<InstanceType<typeof StudyNotebook>>();
const weekPlanner = ref<InstanceType<typeof WeekPlanner>>();
const tab = ref(
    route.query.tab === "plan" ? "plan" : route.query.tab === "notes" ? "notes" : route.query.tab === "courses" || route.query.course ? "courses" : "start",
  ),
  busy = ref(false),
  loading = ref(false),
  error = ref(""),
  notice = ref(""),
  blocked = ref(false);
const cap = ref<S["LifelongCapabilities"]>(),
  goals = ref<Goal[]>([]),
  activities = ref<Activity[]>([]),
  feedback = ref<S["LifelongFeedback"][]>([]),
  supports = ref<Support[]>([]),
  assurances = ref<S["LifelongAssurance"][]>([]);
const cursors = reactive<Record<string, string | null>>({
  goals: null,
  activities: null,
  feedback: null,
  supports: null,
  assurances: null,
});
const editingGoal = ref<Goal>(),
  editingActivity = ref<Activity>(),
  selectedTemplate = ref<S["LifelongTemplate"]>();
const newGoal = (): S["LifelongGoalInput"] => ({
  title: "",
  stage: null,
  field: "life",
  outcome: "",
  due_on: null,
  state: "active",
  template_id: null,
});
const newActivity = (): S["LifelongActivityInput"] => ({
  title: "",
  goal_id: null,
  kind: "reading",
  note: "",
  reflection: "",
  occurred_on: new Date().toISOString().slice(0, 10),
  minutes: 0,
});
const goalForm = reactive(newGoal()),
  activityForm = reactive(newActivity());
const dirtySections = reactive<Record<string, boolean>>({});
const dirty = computed(() => Object.values(dirtySections).some(Boolean));
const sharing = reactive({
  label: "",
  goal_ids: [] as string[],
  activity_ids: [] as string[],
  feedback: false,
  days: 7,
  assurance_id: "",
});
const invitationCode = ref(""),
  invitationPreview = ref<S["LifelongInvitationPreview"]>(),
  displayedCode = ref(""),
  shared = ref<S["LifelongShared"]>(),
  feedbackText = ref(""),
  feedbackRelation = ref(""),
  feedbackActivity = ref("");
const storageKey = `personal-recovery:${props.identity.user.id}`;
const leavePrompt = ref(""),
  leaveCancel = ref<HTMLButtonElement>(),
  leaveConfirm = ref<HTMLButtonElement>();
let resolveLeave: ((value: boolean) => void) | undefined,
  leaveFocus: HTMLElement | null = null;
async function beforeLeave(): Promise<boolean> {
  if (!dirty.value && !pendingKey.value && !storageBlocked.value) return true;
  if (resolveLeave || busy.value) return false;
  leaveFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  leavePrompt.value = [
    dirty.value ? "个人学习表单尚未保存，离开会放弃未保存的修改。" : "",
    pendingKey.value || storageBlocked.value
      ? "请求结果待确认。离开不会取消操作，请保留原请求恢复记录。"
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const answer = new Promise<boolean>((resolve) => {
    resolveLeave = resolve;
  });
  await nextTick();
  leaveCancel.value?.focus();
  return answer;
}
function answerLeave(value: boolean) {
  const resolve = resolveLeave;
  resolveLeave = undefined;
  leavePrompt.value = "";
  if (!value) void nextTick(() => leaveFocus?.focus());
  resolve?.(value);
}
defineExpose({ beforeLeave });
const pendingKey = ref<string>(),
  storageBlocked = ref(false);
let retry:
  { path: string; body: unknown; method: "POST" | "PATCH" } | undefined;
const life = new AbortController();
let alive = true,
  requestEpoch = 0,
  poll = 0;
const locked = computed(
  () =>
    busy.value ||
    loading.value ||
    blocked.value ||
    !!pendingKey.value ||
    storageBlocked.value,
);
const canReview = computed(
  () =>
    !!props.identity.context?.capabilities.includes("organization:admin") &&
    props.identity.organizations.some(
      (o) => o.id === props.identity.context?.org_id && o.kind === "school",
    ),
);
watch(dirty, (v) => emit("dirty", v), { flush: "sync" });
watch(
  [pendingKey, storageBlocked],
  () => emit("unknown", !!pendingKey.value || storageBlocked.value),
  { flush: "sync" },
);
function remember(key?: string) {
  try {
    if (key) sessionStorage.setItem(storageKey, key);
    else sessionStorage.removeItem(storageKey);
    storageBlocked.value = false;
  } catch {
    storageBlocked.value = true;
    throw new Error("恢复记录不可用，已暂停提交，请恢复浏览器会话存储后重试。");
  }
  pendingKey.value = key;
}
function failure(cause: unknown) {
  if (!alive || blocked.value) return;
  error.value =
    cause instanceof Error ? cause.message : "暂时无法完成，请重试。";
  if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
    blocked.value = true;
    goals.value = [];
    activities.value = [];
    feedback.value = [];
    supports.value = [];
    shared.value = undefined;
    displayedCode.value = "";
  }
}
async function page(kind: string, more = false) {
  const cursor = more ? cursors[kind] : null;
  const result = await props.request<
    Page<
      Goal | Activity | S["LifelongFeedback"] | Support | S["LifelongAssurance"]
    >
  >(
    `/personal/${kind}?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    { signal: life.signal },
  );
  if (!alive || blocked.value) return;
  const target = (
    { goals, activities, feedback, supports, assurances } as Record<
      string,
      { value: unknown[] }
    >
  )[kind]!;
  target.value = more ? [...target.value, ...result.items] : result.items;
  cursors[kind] = result.next_cursor;
}
async function refresh() {
  if (loading.value || !alive || blocked.value) return;
  const mountedCourses = courseCenter.value;
  const mountedNotebook = studyNotebook.value;
  const mountedPlanner = weekPlanner.value;
  loading.value = true;
  ++requestEpoch;
  error.value = "";
  shared.value = undefined;
  displayedCode.value = "";
  try {
    cap.value = await props.request<S["LifelongCapabilities"]>(
      "/personal/capabilities",
      { signal: life.signal },
    );
    if (cap.value.enabled)
      await Promise.all(
        ["goals", "activities", "feedback", "supports", "assurances"].map((k) =>
          page(k),
        ),
      );
    if (alive && cap.value.enabled) await mountedCourses?.refresh();
    if (alive && cap.value.enabled) await mountedNotebook?.refresh();
    if (alive && cap.value.enabled) await mountedPlanner?.refresh();
  } catch (cause) {
    failure(cause);
  } finally {
    if (alive) loading.value = false;
  }
}
async function more(kind: string) {
  loading.value = true;
  try {
    await page(kind, true);
  } catch (cause) {
    failure(cause);
  } finally {
    if (alive) loading.value = false;
  }
}
function resetForms(kind = tab.value) {
  if (kind === "goals") {
    Object.assign(goalForm, newGoal());
    editingGoal.value = undefined;
    selectedTemplate.value = undefined;
  } else if (kind === "activities") {
    Object.assign(activityForm, newActivity());
    editingActivity.value = undefined;
  }
  dirtySections[kind] = false;
}
function savedDraft(path: string) {
  if (path.startsWith("/personal/agenda")) weekPlanner.value?.resetDraft("agenda");
  if (path.startsWith("/personal/week-reviews")) weekPlanner.value?.resetDraft("week");
  if (path.startsWith("/personal/study-items")) studyNotebook.value?.resetDraft();
  if (/^\/personal\/courses\//.test(path)) courseCenter.value?.resetDraft();
  if (/^\/personal\/goals(?:\/[a-f0-9]{24})?$/.test(path)) resetForms("goals");
  else if (/^\/personal\/activities(?:\/[a-f0-9]{24})?$/.test(path))
    resetForms("activities");
  else if (path === "/personal/supports") {
    Object.assign(sharing, {
      label: "",
      goal_ids: [],
      activity_ids: [],
      feedback: false,
      days: 7,
      assurance_id: "",
    });
    dirtySections.support = false;
  } else if (/\/supports\/[a-f0-9]{24}\/feedback$/.test(path)) {
    feedbackText.value = "";
    dirtySections.feedback = false;
  }
}
async function write(
  path: string,
  body: unknown,
  method: "POST" | "PATCH" = "POST",
  repeat = false,
) {
  if (
    !alive ||
    blocked.value ||
    busy.value ||
    loading.value ||
    storageBlocked.value ||
    (pendingKey.value && !repeat)
  )
    return;
  busy.value = true;
  ++requestEpoch;
  error.value = "";
  notice.value = "";
  try {
    if (!repeat) {
      remember(crypto.randomUUID());
      retry = { path, body: structuredClone(body), method };
    }
    const result = await props.request<
      S["LifelongOperation"] & { invitation_code?: string | null }
    >(path, {
      method,
      body,
      idempotencyKey: pendingKey.value,
      signal: life.signal,
      notFound: "lookup",
    });
    remember();
    retry = undefined;
    savedDraft(path);
    invitationCode.value = "";
    invitationPreview.value = undefined;
    if (!alive) return;
    notice.value = "已保存。";
    await refresh();
    if (result.invitation_code) displayedCode.value = result.invitation_code;
    return result;
  } catch (cause) {
    if (!alive) return;
    if (
      cause instanceof ApiError &&
      cause.status >= 400 &&
      cause.status < 500 &&
      ![408, 409].includes(cause.status)
    ) {
      try {
        remember();
        retry = undefined;
      } catch (storageCause) {
        failure(storageCause);
      }
    }
    failure(cause);
  } finally {
    if (alive) busy.value = false;
  }
}
async function recover(cancel = false) {
  if (!pendingKey.value || busy.value || blocked.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await props.request<S["LifelongReceipt"]>(
      `/personal/operations/${encodeURIComponent(pendingKey.value)}${cancel ? "/cancel" : ""}`,
      {
        method: cancel ? "POST" : "GET",
        ...(cancel ? { body: {}, idempotencyKey: pendingKey.value } : {}),
        signal: life.signal,
        notFound: "lookup",
      },
    );
    remember();
    if (result.state === "applied" && retry) savedDraft(retry.path);
    retry = undefined;
    notice.value =
      result.state === "applied"
        ? "原请求已完成，已重新读取记录。"
        : "原请求已终止，晚到的相同请求也不会再写入。可重新确认表单后提交。";
    await refresh();
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404)
      error.value =
        "暂未找到已完成结果。请稍后查询，或终止原请求后重新提交；不要直接换编号重试。";
    else failure(cause);
  } finally {
    if (alive) busy.value = false;
  }
}
function retryWrite() {
  if (retry) void write(retry.path, retry.body, retry.method, true);
}
function startTemplate(item: S["LifelongTemplate"]) {
  if (
    dirtySections.goals &&
    !window.confirm("当前表单尚未保存，是否改用这个活动样板？")
  )
    return;
  resetForms("goals");
  selectedTemplate.value = item;
  Object.assign(goalForm, {
    title: item.title,
    stage: item.stage,
    field: item.field,
    outcome: item.outcome,
    template_id: item.id,
  });
  tab.value = "goals";
  dirtySections.goals = true;
}
function editGoal(item: Goal) {
  if (dirtySections.goals && !window.confirm("放弃当前未保存目标？")) return;
  resetForms("goals");
  editingGoal.value = item;
  for (const key of Object.keys(newGoal()) as (keyof S["LifelongGoalInput"])[])
    (goalForm as Record<string, unknown>)[key] = item[key];
  tab.value = "goals";
}
function editActivity(item: Activity) {
  if (dirtySections.activities && !window.confirm("放弃当前未保存活动？"))
    return;
  resetForms("activities");
  editingActivity.value = item;
  for (const key of Object.keys(
    newActivity(),
  ) as (keyof S["LifelongActivityInput"])[])
    (activityForm as Record<string, unknown>)[key] = item[key];
  tab.value = "activities";
}
function relatedActivity(item: Goal) {
  if (dirtySections.activities && !window.confirm("放弃当前未保存活动？"))
    return;
  resetForms("activities");
  activityForm.goal_id = item.id;
  dirtySections.activities = true;
  tab.value = "activities";
}
async function remove(kind: string, item: { id: string; revision: number }) {
  if (
    window.confirm(
      "确认移除此记录？它将不再出现在个人空间或支持者的可读范围内。",
    )
  )
    await write(`/personal/${kind}/${item.id}/remove`, {
      revision: item.revision,
    });
}
async function invite() {
  const scopes = [
    ...(sharing.goal_ids.length ? ["goals"] : []),
    ...(sharing.activity_ids.length ? ["activities"] : []),
    ...(sharing.feedback ? ["feedback"] : []),
  ];
  await write("/personal/supports", {
    label: sharing.label,
    scopes,
    goal_ids: [...sharing.goal_ids],
    activity_ids: [...sharing.activity_ids],
    expires_at: new Date(Date.now() + sharing.days * 86400000).toISOString(),
    assurance_id: sharing.assurance_id || null,
  });
}
async function preview() {
  if (locked.value) return;
  busy.value = true;
  error.value = "";
  invitationPreview.value = undefined;
  try {
    invitationPreview.value = await props.request<
      S["LifelongInvitationPreview"]
    >("/personal/support-invitation/preview", {
      method: "POST",
      body: { code: invitationCode.value.trim() },
      signal: life.signal,
      notFound: "lookup",
    });
  } catch (cause) {
    failure(cause);
  } finally {
    if (alive) busy.value = false;
  }
}
async function showCode(item: Support) {
  if (locked.value) return;
  busy.value = true;
  try {
    displayedCode.value = (
      await props.request<S["LifelongInvitationCode"]>(
        `/personal/supports/${item.id}/invitation`,
        { signal: life.signal, notFound: "lookup" },
      )
    ).invitation_code;
  } catch (cause) {
    displayedCode.value = "";
    failure(cause);
  } finally {
    if (alive) busy.value = false;
  }
}
async function readShared(item: Support, polling = false) {
  if (!alive || busy.value || loading.value || blocked.value || document.hidden)
    return;
  if (
    !polling &&
    dirtySections.feedback &&
    feedbackRelation.value !== item.id
  ) {
    error.value = "请先保存或清空当前支持反馈草稿，再切换支持关系。";
    return;
  }
  const epoch = ++requestEpoch;
  if (!polling) shared.value = undefined;
  error.value = "";
  if (!polling) busy.value = true;
  try {
    const result = await props.request<S["LifelongShared"]>(
      `/personal/supports/${item.id}/records`,
      { signal: life.signal, notFound: "lookup" },
    );
    if (alive && epoch === requestEpoch) shared.value = result;
  } catch (cause) {
    if (alive && epoch === requestEpoch) {
      shared.value = undefined;
      feedbackText.value = "";
      feedbackActivity.value = "";
      dirtySections.feedback = false;
      failure(cause);
    }
  } finally {
    if (alive && !polling) busy.value = false;
  }
}
function visibility() {
  displayedCode.value = "";
  invitationCode.value = "";
  invitationPreview.value = undefined;
  if (document.hidden) {
    ++requestEpoch;
    shared.value = undefined;
  }
}
watch(tab, () => {
  ++requestEpoch;
  shared.value = undefined;
  displayedCode.value = "";
  invitationCode.value = "";
  invitationPreview.value = undefined;
});
async function exportRecords() {
  if (locked.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result: Record<string, unknown> = {
      exported_at: new Date().toISOString(),
      scope: "本人个人目标、活动、笔记收藏复习、周计划及周回顾和支持反馈；不含机构记录、认证成绩或他人档案",
      evidence: "自述与支持反馈分列",
    };
    for (const kind of ["goals", "activities", "feedback", "study-items", "agenda", "week-reviews", "review-history"]) {
      const items: unknown[] = [];
      let cursor: string | null = null,
        pages = 0;
      do {
        const p: Page<unknown> = await props.request(
          `/personal/${kind}?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          { signal: life.signal },
        );
        items.push(...p.items);
        cursor = p.next_cursor;
        if (++pages >= 200 && cursor)
          throw new Error(
            "记录较多，本次导出未生成，请联系管理员安排完整导出。",
          );
      } while (cursor);
      result[kind] = items;
    }
    result.course_learning = (
      await props.request<S["LifelongCoursePage"]>("/personal/courses", {
        signal: life.signal,
      })
    ).items
      .filter((course) => course.learning)
      .map((course) => ({
        course_id: course.id,
        version: course.version,
        title: course.title,
        learning: course.learning,
      }));
    if (!alive) return;
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(result, null, 2)], {
          type: "application/json",
        }),
      ),
      anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `KnowLadder-个人学习-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice.value =
      "已生成个人目标、活动、笔记复习历史、周计划及周回顾与支持反馈导出。导出文件包含你的记录，请自行妥善保存。";
  } catch (cause) {
    failure(cause);
  } finally {
    if (alive) busy.value = false;
  }
}
watch(
  () => [route.query.tab, route.query.course],
  () => {
    if (route.query.tab === "plan") tab.value = "plan";
    else if (route.query.tab === "notes") tab.value = "notes";
    else if (route.query.tab === "courses" || route.query.course)
      tab.value = "courses";
  },
);
onMounted(() => {
  try {
    const key = sessionStorage.getItem(storageKey);
    if (key) {
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) storageBlocked.value = true;
      else pendingKey.value = key;
    }
  } catch {
    storageBlocked.value = true;
  }
  void refresh();
  document.addEventListener("visibilitychange", visibility);
  poll = window.setInterval(() => {
    if (shared.value) void readShared(shared.value.relation, true);
  }, 30000);
});
onBeforeUnmount(() => {
  answerLeave(false);
  alive = false;
  emit("dirty", false);
  emit("unknown", false);
  life.abort();
  window.clearInterval(poll);
  document.removeEventListener("visibilitychange", visibility);
});
</script>

<template>
  <section class="personal-space" aria-labelledby="personal-heading">
    <header class="personal-heading">
      <div>
        <p class="eyebrow">我的终身学习</p>
        <h1 id="personal-heading">把每一次好奇，变成成长的记录</h1>
        <p>
          目标、阅读、实践和回顾，由自己连接。加入或离开组织，不改变这些个人记录的归属。
        </p>
      </div>
      <button
        class="button secondary"
        :disabled="busy || loading || blocked"
        @click="refresh"
      >
        重新读取
      </button>
    </header>
    <p v-if="loading" role="status">正在读取个人空间…</p>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <div v-if="leavePrompt" class="personal-leave-backdrop">
      <section
        class="recovery personal-leave-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="personal-leave-heading"
        aria-describedby="personal-leave-description"
        @keydown.esc.prevent="answerLeave(false)"
      >
        <h2 id="personal-leave-heading">离开当前学习？</h2>
        <p id="personal-leave-description">{{ leavePrompt }}</p>
        <div class="actions">
          <button
            ref="leaveCancel"
            @click="answerLeave(false)"
            @keydown.shift.tab.prevent="leaveConfirm?.focus()"
          >
            继续当前学习</button
          ><button
            ref="leaveConfirm"
            @click="answerLeave(true)"
            @keydown.tab.prevent="leaveCancel?.focus()"
          >
            确认离开
          </button>
        </div>
      </section>
    </div>
    <section
      v-if="pendingKey || storageBlocked"
      class="recovery"
      aria-label="请求恢复"
    >
      <h2>先确认上一次提交</h2>
      <p>
        结果尚未确认，已暂停新提交。恢复记录仅保存请求编号，不保存正文或邀请代码。
      </p>
      <div class="actions">
        <button :disabled="busy || storageBlocked" @click="recover()">
          查询原结果</button
        ><button
          :disabled="busy || storageBlocked || !retry"
          @click="retryWrite"
        >
          沿用原编号重试</button
        ><button :disabled="busy || storageBlocked" @click="recover(true)">
          终止未完成请求
        </button>
      </div>
    </section>
    <p v-if="cap && !cap.enabled" class="notice">
      当前环境尚未开放个人学习空间。可以继续探索学习方向，或使用已有授权的组织工作区。
    </p>
    <template v-if="cap?.enabled && !blocked">
      <nav class="personal-tabs" aria-label="个人学习功能">
        <button
          v-for="(label, key) in {
            start: '学习起点',
            courses: '内容中心',
            notes: '笔记与复习',
            plan: '周计划',
            goals: '我的目标',
            activities: '学习与实践',
            portfolio: '成长档案',
            support: '家人与伙伴',
            ...(canReview ? { review: '监护关系核验' } : {}),
          }"
          :key="key"
          :aria-pressed="tab === key"
          :disabled="busy"
          @click="tab = key"
        >
          {{ label }}
        </button>
      </nav>
      <CourseCenter
        ref="courseCenter"
        v-show="tab === 'start' || tab === 'courses'"
        :request="request"
        :locked="locked"
        :write="write"
        :mode="tab === 'start' ? 'continue' : 'catalog'"
        @dirty="dirtySections.courses = $event"
        @browse="tab = 'courses'"
      />
      <WeekPlanner ref="weekPlanner" v-show="tab === 'start' || tab === 'plan'" :request="request" :locked="locked" :write="write" :mode="tab === 'start' ? 'home' : 'week'" @dirty="dirtySections.plan = $event" @browse="tab = 'plan'" />
      <StudyNotebook
        ref="studyNotebook"
        v-show="tab === 'start' || tab === 'notes'"
        :request="request" :locked="locked" :write="write"
        :mode="tab === 'start' ? 'today' : 'notebook'"
        @dirty="dirtySections.notes = $event" @browse="tab = 'notes'"
      />
      <section v-if="tab === 'start'" class="stack">
        <div class="section-heading">
          <h2>选一个小目标，今天就开始</h2>
          <RouterLink to="/training?tab=discover"
            >查看组织已授权课程 →</RouterLink
          >
        </div>
        <p>
          下列为 KnowLadder
          原创活动提示，可跨阶段使用；阶段是方向选择，不作年龄或监护证明。
        </p>
        <div class="template-grid">
          <article
            v-for="item in cap.templates"
            :key="item.id"
            class="personal-card"
          >
            <span class="tag"
              >{{ stages[item.stage] }} · {{ fields[item.field] }}</span
            >
            <h3>{{ item.title }}</h3>
            <p>{{ item.outcome }}</p>
            <details>
              <summary>阅读原创活动与步骤</summary>
              <p>{{ item.resource }}</p>
              <ol>
                <li v-for="step in item.steps" :key="step">{{ step }}</li>
              </ol>
              <p>{{ item.reflection }}</p>
              <small>{{ item.support }}</small>
            </details>
            <button :disabled="locked" @click="startTemplate(item)">
              用这个活动建立目标
            </button>
          </article>
        </div>
      </section>
      <section v-if="tab === 'goals'" class="personal-columns">
        <form
          class="personal-card stack"
          @input="dirtySections[tab] = true"
          @change="dirtySections[tab] = true"
          @submit.prevent="
            write(
              editingGoal
                ? `/personal/goals/${editingGoal.id}`
                : '/personal/goals',
              {
                ...goalForm,
                ...(editingGoal ? { revision: editingGoal.revision } : {}),
              },
              editingGoal ? 'PATCH' : 'POST',
            )
          "
        >
          <h2>{{ editingGoal ? "调整学习目标" : "建立我的目标" }}</h2>
          <fieldset :disabled="locked">
            <label
              >目标名称<input
                v-model="goalForm.title"
                required
                maxlength="120" /></label
            ><label
              >学习方向<select v-model="goalForm.stage">
                <option :value="null">暂不选择</option>
                <option v-for="(label, key) in stages" :key="key" :value="key">
                  {{ label }}
                </option>
              </select></label
            ><label
              >学习领域<select v-model="goalForm.field">
                <option v-for="(label, key) in fields" :key="key" :value="key">
                  {{ label }}
                </option>
              </select></label
            ><label
              >我希望做到<textarea
                v-model="goalForm.outcome"
                maxlength="4000"
                rows="3"
              /></label
            ><label
              >计划日期（可选）<input
                type="date"
                :value="goalForm.due_on || ''"
                @input="
                  goalForm.due_on =
                    ($event.target as HTMLInputElement).value || null
                " /></label
            ><label
              >目标状态<select v-model="goalForm.state">
                <option value="active">进行中</option>
                <option value="paused">暂时放下</option>
                <option value="completed">已完成</option>
              </select></label
            ><button type="submit">
              {{ editingGoal ? "保存调整" : "保存目标" }}</button
            ><button type="button" class="secondary" @click="resetForms()">
              清空表单
            </button>
          </fieldset>
          <details v-if="selectedTemplate">
            <summary>回看活动提示</summary>
            <p>{{ selectedTemplate.resource }}</p>
            <ol>
              <li v-for="step in selectedTemplate.steps" :key="step">
                {{ step }}
              </li>
            </ol>
            <p>{{ selectedTemplate.support }}</p>
          </details>
        </form>
        <div class="stack">
          <h2>我的目标</h2>
          <p v-if="!goals.length">
            还没有目标。从一个小问题开始，也可以先记录一次活动。
          </p>
          <article v-for="item in goals" :key="item.id" class="personal-card">
            <span class="tag"
              >{{ fields[item.field] }} ·
              {{
                { active: "进行中", paused: "暂时放下", completed: "已完成" }[
                  item.state
                ]
              }}</span
            >
            <h3>{{ item.title }}</h3>
            <p class="preserve">{{ item.outcome }}</p>
            <p v-if="item.due_on">计划日期：{{ item.due_on }}</p>
            <div class="actions">
              <RouterLink
                v-if="item.template_id?.startsWith('course:')"
                :to="{
                  path: '/personal',
                  query: {
                    tab: 'courses',
                    course: item.template_id.split(':')[1],
                  },
                }"
                >打开学习课程</RouterLink
              >
              <button v-else :disabled="locked" @click="editGoal(item)">
                调整</button
              ><button :disabled="locked" @click="remove('goals', item)">
                移除</button
              ><button :disabled="locked" @click="relatedActivity(item)">
                记录相关活动
              </button>
            </div>
          </article>
          <button
            v-if="cursors.goals"
            :disabled="locked"
            @click="more('goals')"
          >
            加载更多目标
          </button>
        </div>
      </section>
      <section v-if="tab === 'activities'" class="personal-columns">
        <form
          class="personal-card"
          @input="dirtySections[tab] = true"
          @change="dirtySections[tab] = true"
          @submit.prevent="
            write(
              editingActivity
                ? `/personal/activities/${editingActivity.id}`
                : '/personal/activities',
              {
                ...activityForm,
                ...(editingActivity
                  ? { revision: editingActivity.revision }
                  : {}),
              },
              editingActivity ? 'PATCH' : 'POST',
            )
          "
        >
          <h2>{{ editingActivity ? "补充活动与回顾" : "记录一次学习" }}</h2>
          <fieldset :disabled="locked">
            <label
              >活动名称<input
                v-model="activityForm.title"
                required
                maxlength="120" /></label
            ><label
              >活动形式<select v-model="activityForm.kind">
                <option v-for="(label, key) in kinds" :key="key" :value="key">
                  {{ label }}
                </option>
              </select></label
            ><label
              >关联目标<select v-model="activityForm.goal_id">
                <option :value="null">独立活动</option>
                <option v-for="item in goals" :key="item.id" :value="item.id">
                  {{ item.title }}
                </option>
              </select></label
            ><button v-if="cursors.goals" type="button" @click="more('goals')">
              加载更多可选目标</button
            ><label
              >活动日期<input
                v-model="activityForm.occurred_on"
                type="date"
                required
                :max="new Date().toISOString().slice(0, 10)" /></label
            ><label
              >投入分钟（可填0）<input
                v-model.number="activityForm.minutes"
                type="number"
                min="0"
                max="1440"
                required /></label
            ><label
              >我读了、做了或创作了什么<textarea
                v-model="activityForm.note"
                rows="4"
                maxlength="4000"
              /></label
            ><label
              >收获、困惑与下一步<textarea
                v-model="activityForm.reflection"
                rows="4"
                maxlength="4000"
              />
            </label>
            <p class="field-help">
              记录属于本人自述。请勿填入他人隐私、机构私有材料或未经授权的作品；文件上传暂不在此入口提供。
            </p>
            <button type="submit">保存活动与回顾</button
            ><button type="button" @click="resetForms()">清空表单</button>
          </fieldset>
        </form>
        <div class="stack">
          <h2>学习与实践记录</h2>
          <p v-if="!activities.length">
            阅读、练习、创作、探究和线下实践，都可以从这里留下一条记录。
          </p>
          <article
            v-for="item in activities"
            :key="item.id"
            class="personal-card"
          >
            <span class="tag">{{ kinds[item.kind] }} · 本人自述</span>
            <h3>{{ item.title }}</h3>
            <p>{{ item.occurred_on }} · {{ item.minutes }} 分钟</p>
            <p class="preserve">{{ item.note }}</p>
            <h4 v-if="item.reflection">我的回顾</h4>
            <p class="preserve">{{ item.reflection }}</p>
            <div class="actions">
              <button :disabled="locked" @click="editActivity(item)">
                补充与调整</button
              ><button :disabled="locked" @click="remove('activities', item)">
                移除
              </button>
            </div>
          </article>
          <button
            v-if="cursors.activities"
            :disabled="locked"
            @click="more('activities')"
          >
            加载更多活动
          </button>
        </div>
      </section>
      <section v-if="tab === 'portfolio'" class="stack">
        <div class="section-heading">
          <h2>成长档案</h2>
          <button :disabled="locked" @click="exportRecords">
            导出我的学习记录
          </button>
        </div>
        <p>
          按事实类型回看成长。本人自述与支持者反馈分别展示，不据此计算统一掌握度、正式分数或证书。
        </p>
        <div class="personal-summary">
          <div v-for="(label, key) in kinds" :key="key">
            <strong>{{
              activities.filter((a) => a.kind === key).length
            }}</strong
            ><span>{{ label }}</span>
          </div>
        </div>
        <small
          >以上仅统计已加载的
          {{ activities.length }} 条活动；投入时长不代表掌握程度。</small
        ><button
          v-if="cursors.activities"
          :disabled="locked"
          @click="more('activities')"
        >
          加载更多档案活动
        </button>
        <h3>我的回顾</h3>
        <article
          v-for="item in activities.filter((a) => a.reflection)"
          :key="item.id"
          class="personal-card"
        >
          <h4>{{ item.title }} · {{ item.occurred_on }}</h4>
          <p class="preserve">{{ item.reflection }}</p>
        </article>
        <h3>收到的支持反馈</h3>
        <p v-if="!feedback.length">
          还没有支持反馈。你可以只分享选定记录，并随时撤回后续访问。
        </p>
        <article v-for="item in feedback" :key="item.id" class="personal-card">
          <span class="tag"
            >支持者反馈 ·
            {{ new Date(item.created_at).toLocaleDateString("zh-CN") }}</span
          >
          <p class="preserve">{{ item.note }}</p>
          <button :disabled="locked" @click="remove('feedback', item)">
            移除此反馈
          </button>
        </article>
        <button
          v-if="cursors.feedback"
          :disabled="locked"
          @click="more('feedback')"
        >
          加载更多反馈
        </button>
        <p>
          机构考试、课程进度和证书仍在原授权工作区。<RouterLink to="/privacy"
            >查看账号隐私与删除申请</RouterLink
          >
        </p>
      </section>
      <section v-if="tab === 'support'" class="stack">
        <p v-if="dirtySections.feedback && !shared" class="notice">
          有尚未保存的支持反馈。重新打开原关系可继续；也可<button
            :disabled="locked"
            @click="
              feedbackText = '';
              feedbackActivity = '';
              dirtySections.feedback = false;
            "
          >
            清空反馈草稿</button
          >后切换其他关系。
        </p>
        <h2>家人与学习伙伴</h2>
        <p>
          每次仅分享明确选定的记录；新记录不会自动加入。可随时撤回后续访问。成年本人支持关系不等于监护；监护需机构独立核验，到期或成年转段自动停止读取。
        </p>
        <div class="personal-columns">
          <form
            class="personal-card"
            @input="dirtySections[tab] = true"
            @change="dirtySections[tab] = true"
            @submit.prevent="invite"
          >
            <h3>选择我愿意分享的内容</h3>
            <fieldset :disabled="locked">
              <label
                >关系名称<input
                  v-model="sharing.label"
                  maxlength="120"
                  required
                  placeholder="例如：家庭阅读伙伴" /></label
              ><label
                >授权依据<select v-model="sharing.assurance_id">
                  <option v-if="cap.adult_admitted" value="">
                    成年本人邀请支持者
                  </option>
                  <option
                    v-for="item in assurances.filter(
                      (a) =>
                        a.state === 'approved' &&
                        Date.parse(a.expires_at) > Date.now() &&
                        Date.parse(a.transition_at) > Date.now(),
                    )"
                    :key="item.id"
                    :value="item.id"
                  >
                    已核验监护关系 · 有效至
                    {{ new Date(item.expires_at).toLocaleDateString("zh-CN") }}
                  </option>
                </select></label
              >
              <p
                v-if="
                  !cap.adult_admitted &&
                  !assurances.some((a) => a.state === 'approved')
                "
              >
                当前没有可用的关系核验记录。个人目标与活动可独立使用；支持关系需先满足对应准入条件。
              </p>
              <fieldset>
                <legend>指定目标</legend>
                <label v-for="item in goals" :key="item.id" class="check"
                  ><input
                    v-model="sharing.goal_ids"
                    type="checkbox"
                    :value="item.id"
                  />{{ item.title }}</label
                ><button
                  v-if="cursors.goals"
                  type="button"
                  @click="more('goals')"
                >
                  更多目标
                </button>
              </fieldset>
              <fieldset>
                <legend>指定活动</legend>
                <label v-for="item in activities" :key="item.id" class="check"
                  ><input
                    v-model="sharing.activity_ids"
                    type="checkbox"
                    :value="item.id"
                  />{{ item.title }}</label
                ><button
                  v-if="cursors.activities"
                  type="button"
                  @click="more('activities')"
                >
                  更多活动
                </button>
              </fieldset>
              <label class="check"
                ><input
                  v-model="sharing.feedback"
                  type="checkbox"
                  :disabled="!sharing.activity_ids.length"
                />允许对选定活动写支持反馈</label
              ><label
                >有效天数<input
                  v-model.number="sharing.days"
                  type="number"
                  min="1"
                  max="90"
                  required
              /></label>
              <p>监护核验可能更早到期，请选择不超过该期限的天数。</p>
              <button
                type="submit"
                :disabled="
                  (!cap.adult_admitted && !sharing.assurance_id) ||
                  !(sharing.goal_ids.length + sharing.activity_ids.length) ||
                  sharing.goal_ids.length > 20 ||
                  sharing.activity_ids.length > 20
                "
              >
                确认范围并建立支持关系
              </button>
            </fieldset>
          </form>
          <div class="stack">
            <form
              v-if="cap.adult_admitted"
              class="personal-card"
              @submit.prevent="preview"
            >
              <h3>接受成年人的学习邀请</h3>
              <fieldset :disabled="locked">
                <label
                  >邀请代码<input
                    v-model="invitationCode"
                    autocomplete="off"
                    maxlength="43"
                    required
                    @input="invitationPreview = undefined" /></label
                ><button type="submit">先查看支持范围</button>
              </fieldset>
              <div v-if="invitationPreview">
                <p>
                  {{ invitationPreview.label }}：{{
                    invitationPreview.scopes
                      .map((s) => scopeNames[s])
                      .join("、")
                  }}；{{ invitationPreview.selected_goal_count }} 个目标 /
                  {{ invitationPreview.selected_activity_count }} 条活动。有效至
                  {{
                    new Date(invitationPreview.expires_at).toLocaleString(
                      "zh-CN",
                    )
                  }}。
                </p>
                <button
                  type="button"
                  :disabled="locked"
                  @click="
                    write('/personal/support-invitation/accept', {
                      code: invitationCode.trim(),
                    })
                  "
                >
                  确认接受此范围
                </button>
              </div>
            </form>
            <section v-if="displayedCode" class="personal-card">
              <h3>邀请代码</h3>
              <p>
                请自行交给希望邀请的成年人。代码最多24小时有效且仅能接受一次；不要公开发布。
              </p>
              <output class="invitation-code">{{ displayedCode }}</output
              ><button @click="displayedCode = ''">隐藏代码</button>
            </section>
            <h3>我的支持关系</h3>
            <p v-if="!supports.length">尚无支持关系，记录默认仅本人可见。</p>
            <article
              v-for="item in supports"
              :key="item.id"
              class="personal-card"
            >
              <h4>{{ item.label }}</h4>
              <p>
                {{
                  item.perspective === "owner" ? "我分享的内容" : "我支持的学习"
                }}
                · {{ statusNames[item.state] }} ·
                {{
                  item.basis === "verified_guardian"
                    ? "机构核验监护"
                    : "成年本人授权"
                }}
              </p>
              <p>
                {{ item.scopes.map((s) => scopeNames[s]).join("、") }}，至
                {{ new Date(item.expires_at).toLocaleString("zh-CN") }}
              </p>
              <p v-if="item.basis === 'verified_guardian'">
                每次读取都会重新核验。核验到期、撤销或成年转段后，关系记录仍保留，后续访问立即停止。
              </p>
              <div class="actions">
                <button
                  v-if="
                    item.state === 'pending' && item.perspective === 'owner'
                  "
                  :disabled="locked"
                  @click="showCode(item)"
                >
                  显示邀请代码</button
                ><button
                  v-if="item.state === 'active'"
                  :disabled="locked"
                  @click="readShared(item)"
                >
                  查看当前可读记录</button
                ><button
                  v-if="['pending', 'active'].includes(item.state)"
                  :disabled="locked"
                  @click="
                    write(`/personal/supports/${item.id}/revoke`, {
                      revision: item.revision,
                    })
                  "
                >
                  撤回此关系
                </button>
              </div>
            </article>
            <button
              v-if="cursors.supports"
              :disabled="locked"
              @click="more('supports')"
            >
              更多支持关系</button
            ><button
              v-if="cursors.assurances"
              :disabled="locked"
              @click="more('assurances')"
            >
              更多核验记录
            </button>
          </div>
        </div>
        <section v-if="shared" class="personal-card">
          <h3>{{ shared.relation.label }} · 当前可读内容</h3>
          <button :disabled="locked" @click="readShared(shared.relation)">
            重新核对访问范围
          </button>
          <article v-for="item in shared.goals" :key="item.id">
            <h4>{{ item.title }}</h4>
            <p class="preserve">{{ item.outcome }}</p>
          </article>
          <article v-for="item in shared.activities" :key="item.id">
            <h4>{{ item.title }} · 本人自述</h4>
            <p class="preserve">{{ item.note }}</p>
            <p class="preserve">{{ item.reflection }}</p>
          </article>
          <article v-for="item in shared.feedback" :key="item.id">
            <span>支持者反馈</span>
            <p class="preserve">{{ item.note }}</p>
          </article>
          <p v-if="shared.feedback_truncated">
            此处只显示最近100条反馈；学习者可在本人档案分页查看或导出。
          </p>
          <form
            v-if="
              shared.relation.perspective === 'supporter' &&
              shared.relation.scopes.includes('feedback')
            "
            @input="
              dirtySections.feedback = true;
              feedbackRelation = shared.relation.id;
            "
            @change="
              dirtySections.feedback = true;
              feedbackRelation = shared.relation.id;
            "
            @submit.prevent="
              write(`/personal/supports/${shared.relation.id}/feedback`, {
                activity_id: feedbackActivity,
                note: feedbackText,
              }).then((result) => {
                if (result) {
                  feedbackText = '';
                  feedbackActivity = '';
                }
              })
            "
          >
            <fieldset :disabled="locked">
              <label
                >反馈对应的活动<select v-model="feedbackActivity" required>
                  <option value="" disabled>请选择活动</option>
                  <option
                    v-for="item in shared.activities"
                    :key="item.id"
                    :value="item.id"
                  >
                    {{ item.title }}
                  </option>
                </select></label
              ><label
                >具体观察与建议<textarea
                  v-model="feedbackText"
                  required
                  maxlength="4000"
                  rows="3"
                /></label
              ><button type="submit">保存支持反馈</button>
              <button
                type="button"
                @click="
                  feedbackText = '';
                  feedbackActivity = '';
                  dirtySections.feedback = false;
                "
              >
                清空反馈草稿
              </button>
            </fieldset>
          </form>
        </section>
      </section>
      <GuardianReview
        v-if="tab === 'review' && canReview && identity.context"
        :org-id="identity.context.org_id"
        :user-id="identity.user.id"
        :request="request"
        :locked="locked"
        :write="write"
        @dirty="dirtySections.review = $event"
      />
    </template>
  </section>
</template>

<style scoped>
.personal-leave-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: 1rem;
  background: #142c4566;
}
.personal-leave-dialog {
  width: min(100%, 32rem);
  box-sizing: border-box;
  max-height: 85vh;
  overflow: auto;
  background: white;
  border: 1px solid #bdd0df;
  border-radius: 14px;
  padding: 1.3rem;
  box-shadow: 0 12px 40px #142c4533;
}
.personal-space {
  max-width: 1200px;
  margin: 0 auto;
  padding: clamp(16px, 3vw, 36px);
  color: #18334d;
}
.personal-heading,
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
h1 {
  font-size: clamp(1.6rem, 3vw, 2.4rem);
  max-width: 27ch;
  line-height: 1.3;
}
p,
li {
  line-height: 1.75;
}
.eyebrow {
  color: #14669a;
  letter-spacing: 0.12em;
  font-weight: 650;
}
.personal-tabs,
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.65rem;
  margin: 1rem 0;
}
.personal-tabs {
  border-bottom: 1px solid #d5e2e9;
  padding-bottom: 1rem;
}
button {
  min-height: 44px;
  padding: 0.6rem 1rem;
  border: 1px solid #b4c9d9;
  border-radius: 9px;
  background: #fff;
  color: #183f60;
  font: inherit;
  cursor: pointer;
}
button[aria-pressed="true"],
button[type="submit"] {
  color: #fff;
  background: #14669a;
  border-color: #14669a;
}
button:disabled {
  opacity: 0.55;
  cursor: default;
}
a {
  color: #12649b;
}
.template-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1rem;
}
.personal-columns {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr);
  gap: 1.5rem;
  align-items: start;
}
.personal-card {
  border: 1px solid #cfdde6;
  border-radius: 14px;
  padding: 1.3rem;
  background: #fff;
  min-width: 0;
  overflow-wrap: anywhere;
}
.personal-card h2,
.personal-card h3 {
  margin-top: 0.25rem;
}
.template-grid .personal-card {
  background: #f8fbfd;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.template-grid .personal-card > button {
  margin-top: auto;
}
fieldset {
  display: grid;
  gap: 1rem;
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
}
fieldset fieldset {
  border: 1px solid #d5e1e9;
  padding: 1rem;
  border-radius: 8px;
  max-height: 240px;
  overflow: auto;
}
label {
  display: grid;
  gap: 0.45rem;
  font-weight: 550;
}
input,
textarea,
select {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  min-height: 44px;
  padding: 0.65rem;
  font: inherit;
  color: inherit;
  border: 1px solid #a9bdcc;
  border-radius: 7px;
  background: #fff;
}
textarea {
  resize: vertical;
}
.check {
  display: flex;
  align-items: center;
  font-weight: 400;
  min-height: 44px;
}
.check input {
  width: 20px;
  min-height: 20px;
  height: 20px;
  flex-shrink: 0;
}
.stack {
  display: grid;
  gap: 1rem;
}
.tag {
  color: #3b637e;
  font-size: 0.85rem;
}
.preserve {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.personal-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.8rem;
}
.personal-summary div {
  display: grid;
  padding: 1rem;
  background: #edf5fa;
  border-radius: 10px;
}
.personal-summary strong {
  font-size: 1.6rem;
}
.notice,
.recovery {
  padding: 1rem;
  background: #eef6fc;
  border-radius: 10px;
  margin: 1rem 0;
}
.error {
  background: #fff1eb;
  color: #813b24;
}
.invitation-code {
  display: block;
  overflow-wrap: anywhere;
  padding: 1rem;
  background: #f1f6fa;
  user-select: all;
}
details {
  margin: 0.5rem 0;
}
summary {
  cursor: pointer;
  min-height: 44px;
  line-height: 1.7;
}
:is(button, a, input, select, textarea, summary):focus-visible {
  outline: 3px solid #168bd0;
  outline-offset: 3px;
}
small,
.field-help {
  color: #415d72;
  line-height: 1.65;
}
@media (max-width: 850px) {
  .template-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .personal-columns {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 480px) {
  .template-grid {
    grid-template-columns: 1fr;
  }
  .personal-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .personal-card {
    padding: 1rem;
  }
}
</style>
