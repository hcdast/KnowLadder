<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { ApiError, type BusinessRequest } from "../session";
type Row = Record<string, any>;
type Pending = {
  path: string;
  method: "POST" | "PUT";
  key: string;
  hash: string;
  operation: string;
  resource_id: string;
};
const props = defineProps<{
  courseId: string;
  userId: string;
  request: BusinessRequest;
  manage: boolean;
  blocked: boolean;
}>();
const emit = defineEmits<{ dirty: [boolean]; unknown: [boolean] }>();
const rows = ref<Row[]>([]),
  selected = ref<Row | null>(null),
  results = ref<Row | null>(null),
  message = ref(""),
  busy = ref(false),
  status = ref<HTMLElement>(),
  answers = ref<Record<string, string | number>>({}),
  editing = ref(false),
  title = ref("课程反馈"),
  opens = ref(new Date().toISOString().slice(0, 16)),
  closes = ref(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16));
const questions = ref<Row[]>([
  {
    id: "rating",
    title: "本次课程满意度",
    kind: "rating",
    required: true,
    options: [],
  },
  {
    id: "text",
    title: "希望改进的方面",
    kind: "text",
    required: false,
    options: [],
  },
]);
const pending = ref<Pending | null>(null),
  storageBlocked = ref(false);
let pendingBody: unknown = null;
const lifetime = new AbortController();
let epoch = 0;
const storageKey = computed(
  () => "kl-survey:" + props.userId + ":" + props.courseId,
);
const disabled = computed(
  () => busy.value || props.blocked || storageBlocked.value || !!pending.value,
);
const req: BusinessRequest = async <T,>(path: string, options = {}) => {
  const version = epoch;
  try {
    const r = await props.request<T>(path, {
      ...options,
      signal: lifetime.signal,
    });
    if (version !== epoch || lifetime.signal.aborted)
      throw new DOMException("视图已变化", "AbortError");
    return r;
  } catch (e) {
    if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
      rows.value = [];
      selected.value = null;
      results.value = null;
      answers.value = {};
      editing.value = false;
      emit("dirty", false);
    }
    throw e;
  }
};
async function focusMessage(text: string) {
  message.value = text;
  await nextTick();
  status.value?.focus();
}
function error(e: unknown) {
  return e instanceof Error ? e.message : "请求失败";
}
async function load() {
  if (busy.value) return;
  busy.value = true;
  try {
    const data = await req<Row>(
      "/training/surveys?course_id=" +
        props.courseId +
        "&mode=" +
        (props.manage ? "manage" : "learner"),
    );
    rows.value = data.items;
    message.value = data.truncated ? "只显示前50份问卷，请按课程核对。" : "";
  } catch (e) {
    rows.value = [];
    message.value = error(e);
  } finally {
    busy.value = false;
  }
}
async function open(id: string) {
  if (disabled.value) return;
  busy.value = true;
  try {
    selected.value = await req<Row>(
      "/training/surveys/" +
        id +
        "?mode=" +
        (props.manage ? "manage" : "learner"),
    );
    answers.value = {};
    results.value = null;
    editing.value = false;
    emit("dirty", false);
    await focusMessage("已打开问卷。");
  } catch (e) {
    await focusMessage(error(e));
  } finally {
    busy.value = false;
  }
}
function persist(p: Pending | null) {
  try {
    if (p) sessionStorage.setItem(storageKey.value, JSON.stringify(p));
    else sessionStorage.removeItem(storageKey.value);
  } catch {
    storageBlocked.value = true;
    throw new Error("无法保存原编号恢复记录，写入已停止。");
  }
}
async function digest(body: unknown) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(body)),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
async function send(
  path: string,
  body: unknown,
  operation: string,
  resource_id: string,
  method: "POST" | "PUT" = "POST",
) {
  if (disabled.value) return;
  busy.value = true;
  try {
    const p: Pending = {
      path,
      method,
      key: crypto.randomUUID(),
      hash: await digest(body),
      operation,
      resource_id,
    };
    persist(p);
    pending.value = p;
    pendingBody = body;
    emit("unknown", true);
    await dispatch(p, body);
  } catch (e) {
    await focusMessage(
      error(e) + (pending.value ? "；结果待确认，请查询原编号。" : ""),
    );
  } finally {
    busy.value = false;
  }
}
async function dispatch(p: Pending, body: unknown) {
  try {
    await req<Row>(p.path, { method: p.method, body, idempotencyKey: p.key });
    persist(null);
    pending.value = null;
    pendingBody = null;
    emit("unknown", false);
    emit("dirty", false);
    editing.value = false;
    answers.value = {};
    selected.value = null;
    results.value = null;
    await focusMessage("已保存，请从列表重新打开查看。");
  } catch (e) {
    if (
      e instanceof ApiError &&
      e.status < 500 &&
      ![401, 403, 404, 408].includes(e.status) &&
      !["IDEMPOTENCY_CONFLICT", "IDENTITY_CHANGED"].includes(e.code)
    ) {
      persist(null);
      pending.value = null;
      pendingBody = null;
      emit("unknown", false);
    }
    throw e;
  }
}
async function recover() {
  const p = pending.value;
  if (!p || busy.value) return;
  busy.value = true;
  try {
    const r = await req<Row>("/training/surveys/receipts/query", {
      method: "POST",
      body: { key: p.key, operation: p.operation, resource_id: p.resource_id },
    });
    if (r.status === "applied") {
      persist(null);
      pending.value = null;
      pendingBody = null;
      emit("unknown", false);
      editing.value = false;
      answers.value = {};
      selected.value = null;
      results.value = null;
      emit("dirty", false);
      await focusMessage("原请求已生效。");
    } else
      await focusMessage(
        "尚未查到回执。当前页面可显式重试同一内容；刷新后需保留原编号继续核查。",
      );
  } catch (e) {
    await focusMessage(error(e));
  } finally {
    busy.value = false;
  }
  if (!pending.value) await load();
}
async function retry() {
  const p = pending.value;
  if (!p || pendingBody === null || busy.value || props.blocked) return;
  busy.value = true;
  try {
    if ((await digest(pendingBody)) !== p.hash)
      throw new Error("原内容已变化，不能重试。");
    await dispatch(p, pendingBody);
  } catch (e) {
    await focusMessage(error(e));
  } finally {
    busy.value = false;
  }
  if (!pending.value) await load();
}
function add(kind: string) {
  if (questions.value.length >= 20) return;
  questions.value.push({
    id: "q_" + crypto.randomUUID().replaceAll("-", ""),
    title: "",
    kind,
    required: true,
    options:
      kind === "choice"
        ? [
            { id: "a", title: "" },
            { id: "b", title: "" },
          ]
        : [],
  });
  emit("dirty", true);
}
async function save() {
  try {
    const draft = {
      title: title.value,
      opens_at: new Date(opens.value + ":00Z").toISOString(),
      closes_at: new Date(closes.value + ":00Z").toISOString(),
      questions: questions.value,
    };
    await send(
      selected.value
        ? "/training/surveys/" + selected.value._id
        : "/training/surveys",
      selected.value
        ? { expected_revision: selected.value.revision, draft }
        : { course_id: props.courseId, draft },
      selected.value ? "survey.edit" : "survey.create",
      selected.value ? selected.value._id : props.courseId,
      selected.value ? "PUT" : "POST",
    );
  } catch (e) {
    await focusMessage(error(e));
  }
  if (!pending.value) await load();
}
function edit() {
  if (disabled.value) return;
  editing.value = true;
  if (selected.value) {
    title.value = selected.value.title;
    opens.value = new Date(selected.value.opens_at).toISOString().slice(0, 16);
    closes.value = new Date(selected.value.closes_at)
      .toISOString()
      .slice(0, 16);
    questions.value = JSON.parse(JSON.stringify(selected.value.questions));
  }
  emit("dirty", true);
}
async function action(action: string) {
  const s = selected.value;
  if (!s) return;
  await send(
    "/training/surveys/" + s._id + "/actions",
    { action, expected_revision: s.revision },
    "survey.action",
    s._id,
  );
  if (!pending.value) await load();
}
async function submit() {
  const s = selected.value;
  if (!s) return;
  const data = s.questions
    .filter(
      (q: Row) =>
        answers.value[q.id] !== undefined && answers.value[q.id] !== "",
    )
    .map((q: Row) => ({
      question_id: q.id,
      value:
        q.kind === "rating" ? Number(answers.value[q.id]) : answers.value[q.id],
    }));
  await send(
    "/training/surveys/" + s._id + "/responses",
    { expected_revision: s.revision, answers: data },
    "survey.submit",
    s._id,
  );
  if (!pending.value) await load();
}
async function summary(cursor?: string) {
  if (!selected.value || disabled.value) return;
  busy.value = true;
  try {
    results.value = await req<Row>(
      "/training/surveys/" +
        selected.value._id +
        "/results" +
        (cursor ? "?cursor=" + cursor : ""),
    );
    await focusMessage("反馈汇总已读取。");
  } catch (e) {
    results.value = null;
    await focusMessage(error(e));
  } finally {
    busy.value = false;
  }
}
onMounted(async () => {
  try {
    const raw = sessionStorage.getItem(storageKey.value);
    if (raw) {
      const p = JSON.parse(raw);
      if (
        !p ||
        !["POST", "PUT"].includes(p.method) ||
        !/^[-a-zA-Z0-9_]{8,128}$/.test(p.key) ||
        !/^\/training\/surveys(?:\/[a-f0-9]{24}(?:\/(?:actions|responses))?)?$/.test(
          p.path,
        ) ||
        !/^survey\.(create|edit|action|submit)$/.test(p.operation) ||
        !/^([a-f0-9]{24})$/.test(p.resource_id) ||
        !/^([a-f0-9]{64})$/.test(p.hash)
      )
        throw new Error("恢复记录无效，请保留原编号人工核查。");
      pending.value = p;
      emit("unknown", true);
    }
  } catch (e) {
    storageBlocked.value = true;
    message.value = error(e);
  }
  await load();
});
const timer = setInterval(async () => {
  if (!selected.value || busy.value || pending.value) return;
  try {
    await req(
      "/training/surveys/" +
        selected.value._id +
        "?mode=" +
        (props.manage ? "manage" : "learner"),
    );
  } catch (e) {
    message.value = error(e);
  }
}, 15000);
watch(
  () => [props.courseId, props.userId],
  () => {
    epoch++;
    selected.value = null;
    rows.value = [];
    results.value = null;
    answers.value = {};
    editing.value = false;
  },
);
onBeforeUnmount(() => {
  epoch++;
  clearInterval(timer);
  lifetime.abort();
});
</script>
<template>
  <section class="surveys" aria-label="课程实名反馈">
    <h4>课程反馈</h4>
    <p ref="status" tabindex="-1" role="status" aria-live="polite">
      {{ message }}
    </p>
    <div v-if="pending">
      <p>请求结果待确认 · 原编号 {{ pending.key }}</p>
      <button :disabled="busy" @click="recover">查询原编号</button
      ><button
        :disabled="busy || pendingBody === null || blocked"
        @click="retry"
      >
        重试原内容
      </button>
    </div>
    <button :disabled="busy" @click="load">刷新问卷</button
    ><button
      v-if="manage"
      :disabled="disabled"
      @click="
        selected = null;
        edit();
      "
    >
      新建反馈
    </button>
    <ul>
      <li v-for="r in rows" :key="r._id">
        <button :disabled="disabled" @click="open(r._id)">
          {{ r.title }} ·
          {{
            { draft: "草稿", open: "已发布", closed: "已关闭" }[
              r.status as string
            ]
          }}
        </button>
      </li>
    </ul>
    <p v-if="!rows.length && !busy">暂无可访问问卷。</p>
    <form v-if="editing" @submit.prevent="save" @input="emit('dirty', true)">
      <label
        >标题<input
          v-model="title"
          required
          maxlength="120"
          :disabled="disabled" /></label
      ><label
        >开放时间（UTC）<input
          v-model="opens"
          type="datetime-local"
          required
          :disabled="disabled" /></label
      ><label
        >结束时间（UTC）<input
          v-model="closes"
          type="datetime-local"
          required
          :disabled="disabled"
      /></label>
      <fieldset v-for="(q, i) in questions" :key="q.id" :disabled="disabled">
        <legend>题目 {{ i + 1 }}</legend>
        <label>题干<input v-model="q.title" required maxlength="500" /></label
        ><label><input v-model="q.required" type="checkbox" />必答</label
        ><label v-for="o in q.options" :key="o.id"
          >选项 {{ o.id
          }}<input v-model="o.title" required maxlength="120" /></label
        ><button type="button" @click="questions.splice(i, 1)">删除题目</button>
      </fieldset>
      <button
        type="button"
        :disabled="disabled || questions.length >= 20"
        @click="add('choice')"
      >
        添加单选</button
      ><button
        type="button"
        :disabled="disabled || questions.length >= 20"
        @click="add('rating')"
      >
        添加评分</button
      ><button
        type="button"
        :disabled="disabled || questions.length >= 20"
        @click="add('text')"
      >
        添加文本
      </button>
      <p>发布后题目冻结；实名反馈不影响成绩与结业。</p>
      <button :disabled="disabled">保存草稿</button>
    </form>
    <div v-else-if="selected">
      <h5>{{ selected.title }}</h5>
      <p>{{ selected.opens_at }} 至 {{ selected.closes_at }} · UTC</p>
      <template v-if="manage"
        ><button
          v-if="selected.status === 'draft'"
          :disabled="disabled"
          @click="edit"
        >
          编辑草稿</button
        ><button
          v-if="selected.status === 'draft'"
          :disabled="disabled"
          @click="action('publish')"
        >
          确认实名可见并冻结发布</button
        ><button
          v-if="selected.status === 'open'"
          :disabled="disabled"
          @click="action('close')"
        >
          确认关闭反馈</button
        ><button :disabled="disabled" @click="summary()">
          读取汇总
        </button></template
      >
      <form
        v-else-if="!selected.response && selected.status === 'open'"
        @submit.prevent="submit"
        @input="emit('dirty', true)"
      >
        <p>
          这是实名反馈，授课老师可查看答案。请勿填写敏感信息。只允许提交一次，不影响成绩。
        </p>
        <fieldset
          v-for="q in selected.questions"
          :key="q.id"
          :disabled="disabled"
        >
          <legend>{{ q.title }} {{ q.required ? "（必答）" : "" }}</legend>
          <template v-if="q.kind === 'choice'"
            ><label v-for="o in q.options" :key="o.id"
              ><input
                v-model="answers[q.id]"
                type="radio"
                :name="q.id"
                :value="o.id"
                :required="q.required"
              />{{ o.title }}</label
            ></template
          ><label v-else-if="q.kind === 'rating'"
            >评分<select v-model="answers[q.id]" :required="q.required">
              <option value="">请选择</option>
              <option v-for="n in 5" :key="n" :value="n">{{ n }}分</option>
            </select></label
          ><label v-else
            >建议<textarea
              v-model="answers[q.id]"
              maxlength="1000"
              :required="q.required"
            />
          </label>
        </fieldset>
        <button :disabled="disabled">确认提交一次</button>
      </form>
      <div v-else-if="selected.response">
        <p>已提交：{{ selected.response.submitted_at }}</p>
        <p v-for="a in selected.response.answers" :key="a.question_id">
          {{
            selected.questions.find((q: Row) => q.id === a.question_id)?.title
          }}：{{ a.value }}
        </p>
      </div>
      <p v-else-if="!manage">问卷已结束。</p>
      <div v-if="results">
        <p>受理反馈 {{ results.summary.respondents }} 份</p>
        <p v-for="q in results.summary.questions" :key="q.question_id">
          {{
            selected.questions.find((x: Row) => x.id === q.question_id)?.title
          }}：已回答 {{ q.answered }}，{{
            q.rating_mean === null ? "无评分均值" : "均分 " + q.rating_mean
          }}
          <span v-for="(count, key) in q.counts" :key="key"
            >{{ key }}：{{ count }}
          </span>
        </p>
        <article v-for="r in results.items" :key="r._id">
          <p>成员 {{ r.member_id }} · {{ r.submitted_at }}</p>
          <p v-for="a in r.answers" :key="a.question_id">{{ a.value }}</p>
        </article>
        <button
          v-if="results.next_cursor"
          :disabled="disabled"
          @click="summary(results.next_cursor)"
        >
          下一页文本
        </button>
      </div>
    </div>
  </section>
</template>
<style scoped>
.surveys {
  margin-block: 1rem;
  padding: 1rem;
  border: 1px solid #d4dae2;
  border-radius: 0.6rem;
  overflow-wrap: anywhere;
}
.surveys label {
  display: block;
  margin-block: 0.6rem;
}
.surveys input:not([type="radio"]):not([type="checkbox"]),
.surveys textarea,
.surveys select {
  width: 100%;
  box-sizing: border-box;
}
.surveys fieldset {
  min-width: 0;
  margin-block: 1rem;
}
.surveys button {
  margin: 0.25rem;
  max-width: 100%;
  white-space: normal;
}
.surveys textarea {
  min-height: 6rem;
}
</style>
