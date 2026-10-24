<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";
import { ApiError, type BusinessRequest } from "../session";
import GrowthInbox from "./GrowthInbox.vue";
type Row = Record<string, any>;
const props = defineProps<{
  request: BusinessRequest;
  write: (path: string, body: unknown) => Promise<Row | undefined>;
  caps: string[];
  contextKey: string;
  blocked: boolean;
  recovered?: Row | null;
  initialPage?: string;
  initialTarget?: { kind: string; id: string };
}>();
const emit = defineEmits<{
  dirty: [boolean];
  work: [string];
  course: [string];
  meetup: [string];
}>();
const learner = computed(() => props.caps.includes("learning:self")),
  page = ref(props.initialPage || (learner.value ? "portfolio" : "shares"));
const filters = reactive({ kind: "work", from: "", to: "", subject_id: "" }),
  applied = ref<Row>({ kind: "work" }),
  subjects = ref<Row[]>([]);
const rows = ref<Row[]>([]),
  cursor = ref<string | null>(null),
  selection = ref<string[]>([]),
  recipients = ref<Row[]>([]),
  recipient = ref(""),
  label = ref(""),
  expires = ref("");
const questionWork = ref<Row | null>(null),
  question = ref<Row | null>(null),
  questionTitle = ref(""),
  questionBody = ref(""),
  reply = ref(""),
  shareDetail = ref<Row | null>(null);
const busy = ref(false),
  dirty = ref(false),
  childDirty = ref(false),
  error = ref(""),
  denied = ref(false),
  notice = ref(false),
  heading = ref<HTMLElement>();
const locked = computed(() => busy.value || props.blocked),
  hasDraft = computed(() => dirty.value || childDirty.value);
const verification: Record<string, string> = {
  submitted: "本人正式提交",
  teacher_feedback: "当前教师反馈已发布",
  self_confirmed: "本人确认学习",
  in_progress: "学习中",
  teacher_recorded: "教师确认参加",
};
let epoch = 0,
  alive = true,
  controller = new AbortController();
watch(hasDraft, (v) => emit("dirty", v), { flush: "sync" });
watch(
  () => props.recovered,
  (v) => {
    if (v) notice.value = true;
  },
);
function resetDraft() {
  selection.value = [];
  recipients.value = [];
  recipient.value = "";
  label.value = "";
  expires.value = "";
  questionWork.value = null;
  questionTitle.value = "";
  questionBody.value = "";
  reply.value = "";
  dirty.value = false;
}
function clear() {
  rows.value = [];
  cursor.value = null;
  question.value = null;
  shareDetail.value = null;
}
function failure(e: unknown) {
  error.value = e instanceof Error ? e.message : "成长记录读取失败";
  if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
    denied.value = true;
    clear();
    resetDraft();
    subjects.value = [];
  }
}
async function read(path: string) {
  return props.request<Row>(path, { signal: controller.signal });
}
function query(filters: Row) {
  return new URLSearchParams(
    Object.entries(filters)
      .filter(([, v]) => v)
      .map(([k, v]) => [k, String(v)]),
  );
}
async function load(more = false) {
  if (!alive || locked.value) return;
  if (page.value === "notifications") {
    if (question.value) {
      const token = epoch;
      try {
        const result = await read(
          "/training/studio/questions/" + question.value._id,
        );
        if (alive && token === epoch) question.value = result;
      } catch (e) {
        if (token === epoch) {
          question.value = null;
          failure(e);
        }
      }
    }
    return;
  }
  busy.value = true;
  error.value = "";
  const token = epoch;
  try {
    const q =
      page.value === "portfolio" ? query(applied.value) : new URLSearchParams();
    if (more && cursor.value) q.set("cursor", cursor.value);
    const result = await read(
      "/training/growth/" +
        (page.value === "portfolio" ? "portfolio" : "shares") +
        "?" +
        q,
    );
    if (!alive || token !== epoch) return;
    rows.value = more
      ? [
          ...new Map(
            [...rows.value, ...result.items].map((r) => [r.id || r._id, r]),
          ).values(),
        ]
      : result.items;
    cursor.value = result.next_cursor;
    // Scope selectors come from the current authorized catalog, not from IDs typed by a learner.
    if (!subjects.value.length && learner.value) {
      const catalog = await read("/training/studio/catalog");
      if (!alive || token !== epoch) return;
      subjects.value = [
        ...new Map<string, Row>(
          catalog.pairs.map((p: Row) => [
            p.subject_id,
            { id: p.subject_id, name: p.subject_name },
          ]),
        ).values(),
      ];
    }
    if (questionWork.value)
      await read(
        "/training/growth/recipients?submission_id=" + questionWork.value.id,
      );
    if (!alive || token !== epoch) return;
    if (shareDetail.value) {
      const detail = await read(
        "/training/growth/shares/" + shareDetail.value.share._id,
      );
      if (!alive || token !== epoch) return;
      shareDetail.value = detail;
    }
    if (question.value) {
      const detail = await read(
        "/training/studio/questions/" + question.value._id,
      );
      if (!alive || token !== epoch) return;
      question.value = detail;
    }
    denied.value = false;
  } catch (e) {
    if (token === epoch) {
      clear();
      failure(e);
    }
  } finally {
    if (alive && token === epoch) busy.value = false;
  }
}
async function select(next: string) {
  if (locked.value) return;
  if (hasDraft.value) {
    error.value = "请先保存或明确放弃当前草稿。";
    return;
  }
  page.value = next;
  clear();
  resetDraft();
  await load();
}
async function apply() {
  if (hasDraft.value) {
    error.value = "请先保存或放弃当前草稿，再筛选。";
    return;
  }
  applied.value = { ...filters };
  clear();
  await load();
}
async function save(path: string, body: Row, after?: (row: Row) => void) {
  if (locked.value) return;
  busy.value = true;
  error.value = "";
  const token = epoch;
  let ok = false;
  try {
    const result = await props.write(path, body);
    if (!alive || token !== epoch || !result) return;
    dirty.value = false;
    after?.(result);
    ok = true;
  } catch (e) {
    if (token === epoch) failure(e);
  } finally {
    if (alive && token === epoch) busy.value = false;
  }
  if (ok && alive && token === epoch) await load();
}
async function choose() {
  dirty.value = selection.value.length > 0;
  recipients.value = [];
  recipient.value = "";
  if (!selection.value.length) return;
  if (locked.value) return;
  busy.value = true;
  const token = epoch;
  try {
    const result = await read(
      "/training/growth/recipients?submission_id=" + selection.value[0],
    );
    if (!alive || token !== epoch) return;
    recipients.value = result.items;
    if (result.truncated)
      error.value = "授课安排较多，仅显示前200条候选；保存仍核验全部作品范围。";
  } catch (e) {
    if (token === epoch) failure(e);
  } finally {
    if (alive && token === epoch) busy.value = false;
  }
}
async function createShare() {
  const date = new Date(expires.value);
  if (!expires.value || !Number.isFinite(date.getTime())) {
    error.value = "请选择有效的到期时间。";
    return;
  }
  await save(
    "/training/growth/shares",
    {
      label: label.value,
      recipient_member_id: recipient.value,
      submission_ids: selection.value,
      expires_at: date.toISOString(),
    },
    () => {
      resetDraft();
      page.value = "shares";
      clear();
    },
  );
}
async function openShare(row: Row) {
  if (locked.value || hasDraft.value) return;
  busy.value = true;
  const token = epoch;
  try {
    const detail = await read("/training/growth/shares/" + row._id);
    if (!alive || token !== epoch) return;
    shareDetail.value = detail;
    await nextTick();
    heading.value?.focus();
  } catch (e) {
    if (token === epoch) {
      shareDetail.value = null;
      failure(e);
    }
  } finally {
    if (alive && token === epoch) busy.value = false;
  }
}
async function ask(row: Row) {
  if (locked.value || hasDraft.value) {
    error.value = "请先保存或放弃草稿。";
    return;
  }
  questionWork.value = row;
  question.value = null;
  await nextTick();
  heading.value?.focus();
}
async function submitQuestion() {
  if (!questionWork.value) return;
  const work = questionWork.value;
  await save(
    "/training/studio/questions",
    {
      class_id: work.class_id,
      subject_id: work.subject_id,
      course_id: null,
      submission_id: work.id,
      title: questionTitle.value,
      body: questionBody.value,
    },
    (row) => {
      questionWork.value = null;
      questionTitle.value = "";
      questionBody.value = "";
      question.value = {
        ...row,
        work_context: { task_id: work.source_id, submission_id: work.id },
        messages: [],
      };
    },
  );
}
async function questionAction(action: string) {
  if (!question.value) return;
  await save(
    "/training/studio/questions/" + question.value._id + "/actions",
    {
      action,
      expected_revision: question.value.revision,
      ...(action === "reply" ? { body: reply.value } : {}),
    },
    () => {
      reply.value = "";
    },
  );
}
async function source(target: { kind: string; id: string }) {
  if (hasDraft.value) return;
  if (target.kind === "work") {
    emit("work", target.id);
    return;
  }
  if (target.kind === "meetup") {
    emit("meetup", target.id);
    return;
  }
  if (locked.value) return;
  busy.value = true;
  const token = epoch;
  try {
    const result = await read("/training/studio/questions/" + target.id);
    if (!alive || token !== epoch) return;
    question.value = result;
    await nextTick();
    heading.value?.focus();
  } catch (e) {
    if (token === epoch) failure(e);
  } finally {
    if (alive && token === epoch) busy.value = false;
  }
}
async function exportRecords() {
  if (locked.value || hasDraft.value) return;
  busy.value = true;
  error.value = "";
  const token = epoch;
  try {
    const data = await read(
      "/training/growth/portfolio/export?" + query(applied.value),
    );
    if (!alive || token !== epoch) return;
    const blob = new Blob(
        [
          JSON.stringify(
            { format: "knowladder-institution-portfolio-v1", ...data },
            null,
            2,
          ),
        ],
        { type: "application/json;charset=utf-8" },
      ),
      url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = "knowladder-portfolio.json";
    link.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    if (token === epoch) failure(e);
  } finally {
    if (alive && token === epoch) busy.value = false;
  }
}
async function abandon() {
  if (locked.value) return;
  resetDraft();
  question.value = null;
  notice.value = false;
  await load();
}
watch(
  () => props.contextKey,
  () => {
    ++epoch;
    controller.abort();
    controller = new AbortController();
    clear();
    resetDraft();
    subjects.value = [];
    notice.value = false;
    error.value = "";
    denied.value = false;
    busy.value = false;
    childDirty.value = false;
    page.value = props.initialPage || (learner.value ? "portfolio" : "shares");
    Object.assign(filters, { kind: "work", from: "", to: "", subject_id: "" });
    applied.value = { kind: "work" };
    void load().then(() => {
      if (props.initialTarget) void source(props.initialTarget);
    });
  },
  { immediate: true },
);
const timer = window.setInterval(() => {
  if (!denied.value && !locked.value) void load();
}, 30000);
onBeforeUnmount(() => {
  alive = false;
  ++epoch;
  controller.abort();
  window.clearInterval(timer);
  clear();
  resetDraft();
  emit("dirty", false);
});
</script>
<template>
  <section class="growth-workspace" aria-label="机构成长档案" :aria-busy="busy">
    <h3>成长、作品与回应</h3>
    <p>
      按事实回看本机构学习记录。确认学习、作品反馈和参加记录分别展示，不合成为统一能力分。
    </p>
    <nav class="actions" aria-label="成长与通知">
      <button
        v-if="learner"
        :aria-pressed="page === 'portfolio'"
        :disabled="locked"
        @click="select('portfolio')"
      >
        机构成长档案</button
      ><button
        :aria-pressed="page === 'shares'"
        :disabled="locked"
        @click="select('shares')"
      >
        作品分享</button
      ><button
        :aria-pressed="page === 'notifications'"
        :disabled="locked"
        @click="select('notifications')"
      >
        学习通知
      </button>
    </nav>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="busy" role="status">正在核对成长记录…</p>
    <details v-if="hasDraft || notice">
      <summary>
        {{ notice ? "原请求已确认，草稿仍保留" : "当前有未保存的草稿" }}
      </summary>
      <p>明确放弃后才清除本页草稿并重新读取，不会重复提交。</p>
      <button :disabled="locked" @click="abandon">
        放弃本页草稿并重新读取
      </button>
    </details>
    <template v-if="page === 'portfolio'"
      ><form class="filters" @submit.prevent="apply">
        <label
          >记录类型<select
            v-model="filters.kind"
            :disabled="locked || hasDraft"
          >
            <option value="work">当前正式作品与反馈</option>
            <option value="course">课程课节记录</option>
            <option value="meetup">已确认参加的共学</option>
          </select></label
        ><label
          >创建时期起<input
            v-model="filters.from"
            type="date"
            :disabled="locked || hasDraft" /></label
        ><label
          >创建时期止<input
            v-model="filters.to"
            type="date"
            :disabled="locked || hasDraft" /></label
        ><label
          >学习领域<select
            v-model="filters.subject_id"
            :disabled="locked || hasDraft"
          >
            <option value="">全部当前领域</option>
            <option v-for="s in subjects" :key="s.id" :value="s.id">
              {{ s.name }}
            </option>
          </select></label
        ><button :disabled="locked || hasDraft">应用档案筛选</button>
      </form>
      <div class="actions">
        <button :disabled="locked || hasDraft" @click="load()">
          刷新成长档案</button
        ><button :disabled="locked || hasDraft" @click="exportRecords">
          导出当前筛选档案
        </button>
      </div>
      <p>
        导出会重新核对并读取当前筛选，最多2000条；不含附件字节或教材正文。下载的本地副本无法远程撤回。
      </p>
      <article v-for="row in rows" :key="row.id">
        <h4>{{ row.title }}</h4>
        <p>
          {{ row.subject_name }} · {{ new Date(row.at).toLocaleString() }} ·
          {{ verification[row.verification] }}
        </p>
        <p v-if="row.submission_no">作品版本 {{ row.submission_no }}</p>
        <p class="body">{{ row.body }}</p>
        <div v-if="row.feedback">
          <h5>当前教师反馈</h5>
          <p class="body">{{ row.feedback.comments }}</p>
          <p>本件作品量规分：{{ row.feedback.score }}</p>
        </div>
        <div class="actions">
          <button
            v-if="row.kind === 'work'"
            :disabled="locked || hasDraft"
            @click="emit('work', row.source_id)"
          >
            进入作品与附件</button
          ><button
            v-if="row.kind === 'work'"
            :disabled="locked || hasDraft"
            @click="ask(row)"
          >
            针对这版作品提问</button
          ><button
            v-if="row.kind === 'course'"
            :disabled="locked || hasDraft"
            @click="emit('course', row.source_id)"
          >
            回看来源课程</button
          ><button
            v-if="row.kind === 'meetup'"
            :disabled="locked || hasDraft"
            @click="emit('meetup', row.source_id)"
          >
            查看参与活动
          </button>
        </div>
        <label v-if="row.kind === 'work'"
          ><input
            v-model="selection"
            type="checkbox"
            :value="row.id"
            :disabled="
              locked ||
              !!questionWork ||
              (hasDraft && !selection.length) ||
              (selection.length >= 20 && !selection.includes(row.id))
            "
            @change="choose"
          />选择此作品给指定教师查看</label
        >
      </article>
      <form
        v-if="selection.length"
        @submit.prevent="createShare"
        @input="dirty = true"
      >
        <h4>明确作品分享范围</h4>
        <p>
          已选{{
            selection.length
          }}件当前作品，含本人作品正文和当前已发布教师反馈。仅指定授课教师可读，失权或任何作品不再有效时整体停止。
        </p>
        <label
          >分享说明<input
            v-model="label"
            required
            maxlength="120"
            :disabled="locked" /></label
        ><label
          >指定授课教师<select v-model="recipient" required :disabled="locked">
            <option value="" disabled>请选择</option>
            <option
              v-for="r in recipients"
              :key="r.member_id"
              :value="r.member_id"
            >
              {{ r.name }}
            </option>
          </select></label
        ><label
          >到期时间（未来30天以内）<input
            v-model="expires"
            type="datetime-local"
            required
            :disabled="locked" /></label
        ><button :disabled="locked || !recipient">确认选定范围并分享</button>
      </form>
    </template>
    <template v-if="page === 'shares'"
      ><div class="actions">
        <button :disabled="locked || hasDraft" @click="load()">
          刷新作品分享
        </button>
      </div>
      <p>
        收到的分享须本人有当前批阅权限；我的历史分享即使来源失效，仍可撤回。
      </p>
      <article v-for="row in rows" :key="row._id">
        <h4>{{ row.label }}</h4>
        <p>
          {{ row.perspective === "owner" ? "我的分享" : "指定给我的分享" }} ·
          {{ row.submission_ids.length }}件作品 ·
          {{
            row.revoked_at
              ? "已撤回"
              : new Date(row.expires_at).getTime() <= Date.now()
                ? "已过期"
                : "有效至 " + new Date(row.expires_at).toLocaleString()
          }}
        </p>
        <button
          v-if="
            !row.revoked_at && new Date(row.expires_at).getTime() > Date.now()
          "
          :disabled="locked || hasDraft"
          @click="openShare(row)"
        >
          读取这份分享
        </button>
        <details v-if="row.perspective === 'owner' && !row.revoked_at">
          <summary>撤回这份分享</summary>
          <p>撤回后指定教师不能再通过此分享读取；已下载副本不能远程清除。</p>
          <button
            :disabled="locked || hasDraft"
            @click="
              save(
                '/training/growth/shares/' + row._id + '/revoke',
                { expected_revision: row.revision },
                () => (shareDetail = null),
              )
            "
          >
            确认撤回分享
          </button>
        </details>
      </article>
      <section v-if="shareDetail">
        <h4 ref="heading" tabindex="-1">
          {{ shareDetail.share.label }} · 当前可读作品
        </h4>
        <article v-for="item in shareDetail.items" :key="item.id">
          <h5>{{ item.title }} · 版本{{ item.submission_no }}</h5>
          <p>{{ verification[item.verification] }}</p>
          <p class="body">{{ item.body }}</p>
          <p v-if="item.feedback" class="body">
            教师反馈：{{ item.feedback.comments }} · 量规分{{
              item.feedback.score
            }}
          </p>
        </article>
      </section>
    </template>
    <GrowthInbox
      v-if="page === 'notifications'"
      :request="request"
      :write="write"
      :context-key="contextKey"
      :blocked="locked"
      :recovered="recovered"
      @dirty="childDirty = $event"
      @source="source"
    />
    <p v-if="page !== 'notifications' && !busy && !rows.length">
      当前筛选没有可读记录。
    </p>
    <button
      v-if="cursor && page !== 'notifications'"
      :disabled="locked || hasDraft"
      @click="load(true)"
    >
      继续读取成长记录
    </button>
    <form
      v-if="questionWork"
      @submit.prevent="submitQuestion"
      @input="dirty = true"
    >
      <h4 ref="heading" tabindex="-1">
        针对{{ questionWork.title }}第{{ questionWork.submission_no }}版提问
      </h4>
      <label
        >问题标题<input
          v-model="questionTitle"
          required
          maxlength="200"
          :disabled="locked" /></label
      ><label
        >问题和已尝试的方法<textarea
          v-model="questionBody"
          required
          maxlength="4000"
          :disabled="locked"
        /></label
      ><button :disabled="locked">提交作品关联问题</button>
    </form>
    <article v-if="question && !selection.length">
      <h4 ref="heading" tabindex="-1">{{ question.title }}</h4>
      <button v-if="question.work_context" :disabled="locked || hasDraft" @click="emit('work', question.work_context.task_id)">查看关联作品与附件</button>
      <p v-if="question.work_context">
        此问题关联具体正式作品版本，撤回或重交后停止旧会话交付。
      </p>
      <p class="body">{{ question.body }}</p>
      <ol>
        <li v-for="message in question.messages" :key="message._id">
          <strong>{{
            message.role === "teacher" ? "授课教师" : "学习者"
          }}</strong>
          <p class="body">{{ message.body }}</p>
        </li>
      </ol>
      <form
        v-if="question.status !== 'closed'"
        @submit.prevent="questionAction('reply')"
        @input="dirty = true"
      >
        <label
          >回复与追问<textarea
            v-model="reply"
            maxlength="4000"
            required
            :disabled="locked"
          /></label
        ><button :disabled="locked">发送会话回复</button>
      </form>
      <button
        :disabled="locked || hasDraft"
        @click="
          questionAction(question.status === 'closed' ? 'reopen' : 'close')
        "
      >
        {{ question.status === "closed" ? "重新打开会话" : "标记会话已解决" }}
      </button>
    </article>
  </section>
</template>
<style scoped>
.growth-workspace {
  min-width: 0;
  overflow-wrap: anywhere;
}
.growth-workspace article {
  border: 1px solid #c8d9e7;
  border-radius: 12px;
  padding: 1rem;
  margin: 1rem 0;
  min-width: 0;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.7rem;
  margin: 0.8rem 0;
}
.growth-workspace button {
  min-height: 44px;
  font: inherit;
  max-width: 100%;
  white-space: normal;
  padding: 0.5rem 0.8rem;
}
.growth-workspace label {
  display: grid;
  gap: 0.4rem;
  min-width: 0;
  margin: 0.5rem 0;
}
.growth-workspace input:not([type="checkbox"]),
.growth-workspace textarea,
.growth-workspace select {
  font: inherit;
  box-sizing: border-box;
  min-height: 44px;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  padding: 0.6rem;
}
.growth-workspace input[type="checkbox"] {
  min-height: 22px;
  width: 22px;
}
.growth-workspace textarea {
  min-height: 110px;
}
.growth-workspace form {
  display: grid;
  gap: 0.5rem;
}
.filters {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: end;
}
.body {
  white-space: pre-wrap;
}
.growth-workspace summary {
  min-height: 44px;
  cursor: pointer;
}
@media (max-width: 700px) {
  .filters {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
