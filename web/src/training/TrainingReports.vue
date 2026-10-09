<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ApiError, type BusinessRequest } from "../session";
type Row = Record<string, any>;
const detailHeading = ref<HTMLElement>();
const actionStatus = ref<HTMLElement>();
const props = defineProps<{
  request: BusinessRequest;
  write: (path: string, body: unknown) => Promise<any>;
  caps: string[];
  catalog: { classes: Row[]; subjects: Row[]; assignments: Row[] };
  blocked: boolean;
  recovered: Row | null;
  userId: string;
}>();
const aiEnabled = ref(false), aiJob = ref<Row | null>(null), acceptConfirmed = ref(false);
const aiDraft = computed(() => {try{return aiJob.value?.status === "succeeded" ? JSON.parse(aiJob.value.output) : null;}catch{return null;}});
const emit = defineEmits<{ dirty: [boolean] }>();
const items = ref<Row[]>([]),
  selected = ref<Row | null>(null),
  classId = ref(""),
  subjectId = ref(""),
  title = ref(""),
  body = ref(""),
  taskId = ref(""),
  note = ref(""),
  message = ref(""),
  busy = ref(false),
  dirty = ref(false);
const canEdit = computed(() => props.caps.includes("training:report-edit")),
  canReview = computed(
    () =>
      props.caps.includes("training:report-review") &&
      selected.value?.author_id !== props.userId &&
      !selected.value?.contributors.includes(props.userId),
  );
const subjects = computed(() =>
  props.catalog.subjects.filter((s) =>
    props.catalog.assignments.some(
      (a) => a.class_id === classId.value && a.subject_id === s.id,
    ),
  ),
);
const facts = computed(() => {
  try {
    return JSON.parse(selected.value?.facts_json ?? "null");
  } catch {
    return null;
  }
});
const labels: Record<string, string> = {
  draft: "草稿",
  review: "待独立审核",
  published: "已发布",
  retired: "已撤回",
};
let timer = 0,
  epoch = 0,
  alive = true;
function mark() {
  dirty.value = true;
  emit("dirty", true);
}
function clear() {
  epoch++;
  items.value = [];
  selected.value = null;
  aiJob.value = null;
  acceptConfirmed.value = false;
  title.value = "";
  body.value = "";
  note.value = "";
  classId.value = "";
  subjectId.value = "";
  taskId.value = "";
  dirty.value = false;
  emit("dirty", false);
}
async function read<T>(path: string) {
  const e = epoch;
  const data = await props.request<T>(path);
  if (!alive || e !== epoch) throw new DOMException("视图已变化", "AbortError");
  return data;
}
function failure(e: unknown) {
  if (!alive || (e instanceof DOMException && e.name === "AbortError")) return;
  if (e instanceof ApiError && [401, 403, 404, 410].includes(e.status)) clear();
  message.value = e instanceof Error ? e.message : "报告读取失败";
}
async function load() {
  busy.value = true;
  try {
    items.value = (await read<{ items: Row[] }>("/training/reports")).items;
  } catch (e) {
    failure(e);
  } finally {
    busy.value = false;
  }
}
async function open(row: Row) {
  if (dirty.value) {
    message.value = "请先保存当前草稿，再切换报告。";
    return;
  }
  busy.value = true;
  try {
    const data = await read<Row>("/training/reports/" + row._id);
    aiJob.value = null;
    acceptConfirmed.value = false;
    selected.value = data;
    title.value = data.title;
    body.value = data.body;
    classId.value = data.class_id;
    subjectId.value = data.subject_id;
    taskId.value = data.task_id ?? "";
    note.value = "";
    message.value = "";
    await loadAi();
    await nextTick();
    if (alive && selected.value?._id === row._id && document.activeElement === document.body) detailHeading.value?.focus();
  } catch (e) {
    failure(e);
  } finally {
    busy.value = false;
  }
}
function newDraft() {
  if (dirty.value) {
    message.value = "请先保存当前草稿。";
    return;
  }
  selected.value = null;
  title.value = "";
  body.value = "";
  taskId.value = "";
  note.value = "";
}
async function save() {
  const path = selected.value
    ? "/training/reports/" + selected.value._id + "/actions"
    : "/training/reports";
  const payload = selected.value
    ? {
        action: "edit",
        expected_revision: selected.value.revision,
        title: title.value,
        body: body.value,
      }
    : {
        class_id: classId.value,
        subject_id: subjectId.value,
        task_id: taskId.value || null,
        title: title.value,
        body: body.value,
      };
  const row = await props.write(path, payload);
  if (row && alive) {
    selected.value = row;
    dirty.value = false;
    emit("dirty", false);
    message.value = "草稿已保存";
    await load();
    await nextTick();
    if (alive && selected.value?._id === row._id && document.activeElement === document.body) actionStatus.value?.focus();
  }
}
async function act(action: string) {
  if (!selected.value || dirty.value) {
    message.value = "请先保存正文。";
    return;
  }
  const row = await props.write(
    "/training/reports/" + selected.value._id + "/actions",
    {
      action,
      expected_revision: selected.value.revision,
      ...(["publish", "reject"].includes(action) ? { note: note.value } : {}),
    },
  );
  if (row && alive) {
    selected.value = row;
    aiJob.value = null;
    acceptConfirmed.value = false;
    message.value = "报告状态已更新";
    await load();
    await nextTick();
    if (alive && selected.value?._id === row._id && document.activeElement === document.body) actionStatus.value?.focus();
  }
}
async function loadAi() {
  const status = await read<Row>("/training/ai/status");
  aiEnabled.value = !!status.learning_reports_enabled;
  if (!aiEnabled.value || !selected.value) return;
  const jobs = await read<{items:Row[]}>("/training/ai/jobs");
  aiJob.value = jobs.items.find(j=>j.kind === "learning-report" && j.context_id === selected.value?._id) ?? null;
}
async function aiAction(action: "create" | "dispatch" | "accept") {
  if (!selected.value || dirty.value || busy.value) return;
  const currentEpoch = epoch, reportId = selected.value._id;
  busy.value = true;
  try {
    if(action === "accept") {
      if(!aiJob.value || !acceptConfirmed.value)return;
      const row = await props.write("/training/ai/jobs/"+aiJob.value.id+"/accept-report",{expected_revision:selected.value.revision});
      if(row && alive && currentEpoch===epoch && selected.value?._id===reportId){
        selected.value=row;body.value=row.body;aiJob.value=null;acceptConfirmed.value=false;
        message.value="AI建议已写入草稿，请核对正文后提交独立审核。";
      }
    } else {
      const row = await props.write(action === "create" ? "/training/ai/jobs" : "/training/ai/jobs/"+aiJob.value?.id+"/dispatch",
        action === "create" ? {kind:"learning-report",context_id:reportId,prompt:"解读匿名有效学情"} : {expected_revision:aiJob.value?.revision});
      if(row && alive && currentEpoch===epoch && selected.value?._id===reportId){aiJob.value=row;acceptConfirmed.value=false;}
    }
  } catch(e){failure(e);} finally{busy.value=false;}
}
watch(
  () => props.recovered,
  async (row) => {
    if(row?.id && row.kind === "learning-report"){await loadAi();return;}
    if (!row?._id) return;
    dirty.value = false;
    emit("dirty", false);
    await open(row);
    await load();
  },
  { immediate: true },
);
onMounted(() => {
  void load();
  timer = window.setInterval(async () => {
    if (!selected.value) return;
    try {
      await read("/training/reports/" + selected.value._id);
      if(aiJob.value){try{aiJob.value=await read<Row>("/training/ai/jobs/"+aiJob.value.id);}catch(e){aiJob.value=null;acceptConfirmed.value=false;throw e;}}
    } catch (e) {
      failure(e);
    }
  }, 30000);
});
onBeforeUnmount(() => {
  alive = false;
  epoch++;
  window.clearInterval(timer);
  emit("dirty", false);
});
</script>
<template>
  <section class="panel" aria-label="报告审核发布" :aria-busy="busy">
    <h3>培训与学情报告</h3>
    <p class="muted">
      报告区分培训完成情况与知识掌握情况。正文由教师确认，送审后由独立审核人发布。
    </p>
    <p v-if="message" ref="actionStatus" role="status" tabindex="-1" class="notice">{{ message }}</p>
    <div class="actions">
      <button class="button secondary" :disabled="busy" @click="load">
        刷新报告列表</button
      ><button
        v-if="canEdit"
        class="button secondary"
        :disabled="blocked"
        @click="newDraft"
      >
        新建报告
      </button>
    </div>
    <ul>
      <li v-for="row in items" :key="row._id">
        <button class="text-button" :disabled="busy" @click="open(row)">
          {{ row.title }} · {{ labels[row.status] }}
        </button>
      </li>
    </ul>
    <p v-if="!items.length && !busy" class="muted">暂无可访问的报告。</p>
    <form v-if="canEdit || selected" @submit.prevent="save">
      <h4 v-if="selected" ref="detailHeading" tabindex="-1">{{ selected.title }}</h4>
      <div v-if="!selected" class="form-grid">
        <label
          >班级<select
            v-model="classId"
            required
            @change="
              subjectId = '';
              mark();
            "
          >
            <option value="">请选择</option>
            <option v-for="c in catalog.classes" :key="c.id" :value="c.id">
              {{ c.name }}
            </option>
          </select></label
        ><label
          >学科<select v-model="subjectId" required @change="mark">
            <option value="">请选择</option>
            <option v-for="s in subjects" :key="s.id" :value="s.id">
              {{ s.name }}
            </option>
          </select></label
        ><label
          >关联任务编号（可选）<input
            v-model="taskId"
            pattern="[a-f0-9]{24}"
            @input="mark"
        /></label>
      </div>
      <p v-if="selected">
        状态：{{ labels[selected.status] }} · 事实日期：{{
          new Date(selected.facts_at).toLocaleString()
        }}
      </p>
      <div v-if="facts" class="notice">
        <p>
          有效学情：{{
            facts.learning.status === "ready" ? "已有有效证据" : "证据不足"
          }}；班级人数 {{ facts.learning.roster_count }}，有投影证据
          {{ facts.learning.projected_count }}。
        </p>
        <p>
          近30天有效提交 {{ facts.learning.submission_count_30d }}；达到掌握分类
          {{ facts.learning.mastery_bands.mastered }}。
        </p>
        <p v-if="facts.training">
          培训任务：{{ facts.training.title }}；{{ facts.training.target_type === 'quiz' ? '已提交人数' : '完成人数' }}
          {{
            facts.training.completion_count == null
              ? "证据未接入"
              : facts.training.completion_count
          }}，完成数不代表掌握数。
        </p>
      </div>
      <section v-if="canEdit && caps.includes('ai:generate') && selected?.status === 'draft' && aiEnabled" aria-label="AI学情解读" class="notice">
        <h4>AI学情解读</h4>
        <p class="muted">只发送符合最小群组要求的匿名聚合。AI解释与建议需教师核对，系统事实保持独立。</p>
        <button v-if="!aiJob || ['failed','cancelled'].includes(aiJob.status) || aiJob.error_code === 'CONTEXT_CHANGED'" type="button" class="button secondary" :disabled="blocked || busy || dirty" @click="aiAction('create')">准备AI解读</button>
        <button v-if="aiJob?.status === 'queued'" type="button" class="button secondary" :disabled="blocked || busy || dirty" @click="aiAction('dispatch')">调用模型生成建议</button>
        <p v-if="aiJob && ['running','unknown'].includes(aiJob.status)" role="status">调用结果尚未确认，请核对原请求或联系管理员恢复；不要重新派发。</p>
        <p v-if="aiJob?.error_code" role="status">结果不可使用：{{ aiJob.error_code }}。请刷新事实并核对任务。</p>
        <template v-if="aiDraft">
          <p>{{ aiDraft.interpretation }}</p>
          <ul><li v-for="(suggestion,index) in aiDraft.suggestions" :key="index">{{ suggestion }}</li></ul>
          <label><input type="checkbox" v-model="acceptConfirmed" />我已核对建议，同意替换当前草稿正文</label>
          <button type="button" class="button secondary" :disabled="blocked || busy || dirty || !acceptConfirmed" @click="aiAction('accept')">采纳到报告草稿</button>
        </template>
      </section>
      <label
        >报告标题<input
          v-model="title"
          maxlength="200"
          required
          :disabled="!canEdit || (!!selected && selected.status !== 'draft')"
          @input="mark"
      /></label>
      <label
        >报告正文<textarea
          v-model="body"
          maxlength="12000"
          rows="9"
          :disabled="!canEdit || (!!selected && selected.status !== 'draft')"
          @input="mark"
        />
      </label>
      <div
        class="actions"
        v-if="canEdit && (!selected || selected.status === 'draft')"
      >
        <button class="button" :disabled="blocked || busy">保存草稿</button
        ><button
          v-if="selected"
          type="button"
          class="button secondary"
          :disabled="blocked || busy || dirty"
          @click="act('refresh-facts')"
        >
          刷新事实</button
        ><button
          v-if="selected"
          type="button"
          class="button secondary"
          :disabled="blocked || busy || dirty"
          @click="act('request-review')"
        >
          提交独立审核
        </button>
      </div>
      <p v-if="selected?.status === 'review' && !canReview" class="muted">
        正文已冻结，请由未参与编写的审核人处理。
      </p>
      <template v-if="canReview && selected?.status === 'review'"
        ><label
          >审核意见<textarea v-model="note" maxlength="2000" rows="3" />
        </label>
        <div class="actions">
          <button
            type="button"
            class="button"
            :disabled="blocked || busy || !note.trim()"
            @click="act('publish')"
          >
            审核并发布</button
          ><button
            type="button"
            class="button secondary"
            :disabled="blocked || busy || !note.trim()"
            @click="act('reject')"
          >
            退回修改
          </button>
        </div></template
      >
      <button
        v-if="canEdit && selected?.status === 'published'"
        type="button"
        class="button secondary"
        :disabled="blocked || busy"
        @click="act('retire')"
      >
        撤回报告
      </button>
      <p v-if="selected?.review_note" class="muted">
        审核意见：{{ selected.review_note }}
      </p>
    </form>
  </section>
</template>
