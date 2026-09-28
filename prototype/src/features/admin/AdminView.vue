<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import ConfirmDialog from "../../components/ConfirmDialog.vue";
import { demo } from "../../services/core";
import {
  catalogue,
  type Resource,
  type ResourceType,
} from "../../services/catalogue";
import {
  AdminError,
  copyResource,
  createResource,
  previousResource,
  resourceById,
  reviewResource,
  saveResource,
  simulateRemoteChange,
  submitResource,
  validateResource,
  type Problems,
} from "../../services/admin-service";
const route = useRoute();
const router = useRouter();
const page = computed(() => String(route.meta.page));
const draft = ref<Resource>();
const expectedRevision = ref(0);
const message = ref("");
const errors = ref<Problems>({});
const conflict = ref(false);
const summary = ref<HTMLElement>();
const filterType = ref("all");
const filterStatus = ref("all");
const search = ref("");
const reason = ref("");
const fileLabel = ref("未选择文件；此处不上传真实文件");
const confirmation = ref(false);
const pendingAction = ref<"publish" | "return" | "retain">("publish");
const statusNames = {
  draft: "草稿",
  review: "待审核",
  published: "已发布",
  retired: "已退役",
};
const chapterFields = ["id", "title", "body", "knowledge"] as const;
const chapterLabels = {
  id: "稳定章节 ID",
  title: "章节标题",
  body: "章节正文",
  knowledge: "关联知识点",
};
const rows = computed(() =>
  catalogue.resources.filter(
    (item) =>
      (filterType.value === "all" || item.type === filterType.value) &&
      (filterStatus.value === "all" || item.status === filterStatus.value) &&
      item.title.includes(search.value),
  ),
);
const canEdit = computed(
  () => demo.role === "editor" && draft.value?.status === "draft",
);
const canReview = computed(
  () =>
    demo.role === "reviewer" &&
    draft.value?.status === "review" &&
    draft.value.author !== demo.role,
);
const previous = computed(() =>
  draft.value ? previousResource(draft.value.id) : undefined,
);
const reviewChecks = computed(() =>
  draft.value ? validateResource(draft.value) : {},
);
const knowledgeOptions = computed(() => [
  ...new Set(
    catalogue.resources
      .filter((item) => item.type === "textbook")
      .flatMap((item) => item.chapters.map((chapter) => chapter.knowledge)),
  ),
]);
function editPath(resource: Resource) {
  return resource.type === "textbook"
    ? `/admin/textbooks?versionId=${resource.id}`
    : `/admin/questions/${resource.id}`;
}
function reviewPath(resource: Resource) {
  return `/admin/reviews/${resource.type}/${resource.id}`;
}
function clearFeedback() {
  message.value = "";
  errors.value = {};
  conflict.value = false;
}
function load() {
  clearFeedback();
  draft.value = undefined;
  expectedRevision.value = 0;
  reason.value = "";
  fileLabel.value = "未选择文件；此处不上传真实文件";
  confirmation.value = false;
  filterType.value =
    route.query.type === "question" || route.query.type === "textbook"
      ? route.query.type
      : page.value === "A02"
        ? "textbook"
        : "all";
  let type: ResourceType;
  let id: string;
  if (page.value === "A01") return;
  if (page.value === "A04") {
    if (
      route.params.resourceType !== "textbook" &&
      route.params.resourceType !== "question"
    )
      return;
    type = route.params.resourceType;
    id = String(route.params.versionId);
  } else {
    type = page.value === "A02" ? "textbook" : "question";
    id = String(
      page.value === "A02"
        ? route.query.versionId || ""
        : route.params.versionId || "",
    );
  }
  const resource = resourceById(id, type);
  if (resource) {
    draft.value = copyResource(resource);
    expectedRevision.value = resource.revision;
  }
}
watch(() => [route.fullPath, demo.epoch], load, { immediate: true });
watch(
  () => demo.epoch,
  () => {
    filterType.value = "all";
    filterStatus.value = "all";
    search.value = "";
  },
);
function dirty() {
  if (canEdit.value) demo.dirty = true;
}
async function fail(error: unknown) {
  const epoch = demo.epoch;
  message.value = error instanceof Error ? error.message : "操作失败，请重试。";
  errors.value = error instanceof AdminError ? error.fields : {};
  conflict.value = error instanceof AdminError && error.conflict;
  await nextTick();
  if (epoch === demo.epoch) summary.value?.focus();
}
function openResource(resource: Resource) {
  router.push(editPath(resource));
}
function create(type: ResourceType, original?: Resource) {
  try {
    const resource = createResource(type, original);
    openResource(resource);
  } catch (error) {
    fail(error);
  }
}
function save() {
  if (!draft.value) return;
  clearFeedback();
  try {
    draft.value = saveResource(draft.value, expectedRevision.value);
    expectedRevision.value = draft.value.revision;
    demo.dirty = false;
    message.value = "草稿已保存到本次演示内存。刷新或重置会清除。";
  } catch (error) {
    fail(error);
  }
}
function submit() {
  if (!draft.value) return;
  clearFeedback();
  if (demo.dirty) {
    fail(new AdminError("请先保存本地修改，再送审。"));
    return;
  }
  try {
    draft.value = submitResource(draft.value.id, expectedRevision.value);
    expectedRevision.value = draft.value.revision;
    router.push(reviewPath(draft.value));
  } catch (error) {
    fail(error);
  }
}
function reload() {
  if (
    demo.dirty &&
    !window.confirm("重新加载会丢弃未保存的本地修改，确定继续？")
  )
    return;
  demo.dirty = false;
  load();
  message.value =
    "已加载最新 revision，请重新核对。模拟冲突场景需切换回正常流程后再操作。";
}
function simulate() {
  if (!draft.value) return;
  try {
    simulateRemoteChange(draft.value.id);
    fail(
      new AdminError(
        "已模拟协作者更新。当前页面仍固定旧 revision，旧预览不能保存或发布。",
        {},
        true,
      ),
    );
  } catch (error) {
    fail(error);
  }
}
function requestAction(action: "publish" | "return" | "retain") {
  if (action === "return" && !reason.value.trim()) {
    fail(new AdminError("请填写退回原因。", { reason: "退回原因必填。" }));
    return;
  }
  pendingAction.value = action;
  confirmation.value = true;
}
function confirmAction() {
  confirmation.value = false;
  if (!draft.value) return;
  try {
    if (pendingAction.value === "retain") {
      const latest = resourceById(draft.value.id, draft.value.type);
      if (!latest || latest.status !== "draft" || !canEdit.value)
        throw new AdminError(
          "当前版本已不再是可编辑草稿，不能保留后覆盖，请重新加载。",
        );
      expectedRevision.value = latest.revision;
      demo.dirty = true;
      conflict.value = false;
      errors.value = {};
      message.value =
        "本地草稿已保留并对齐最新 revision；尚未保存。下一次保存将覆盖当前草稿内容，请核对后操作。冲突场景请切回正常流程。";
      return;
    }
    draft.value = reviewResource(
      draft.value.id,
      draft.value.type,
      expectedRevision.value,
      pendingAction.value,
      reason.value,
    );
    expectedRevision.value = draft.value.revision;
    demo.dirty = false;
    errors.value = {};
    conflict.value = false;
    message.value =
      pendingAction.value === "publish"
        ? "发布成功。学生目录现在可见此授权版本，既有练习快照不变。"
        : "已退回草稿，编辑可按意见修改后重新送审。";
  } catch (error) {
    fail(error);
  }
}
function addChapter() {
  draft.value?.chapters.push({
    id: crypto.randomUUID(),
    title: "",
    body: "",
    knowledge: "",
  });
  dirty();
}
function moveChapter(index: number, direction: number) {
  if (!draft.value) return;
  const list = draft.value.chapters;
  const target = index + direction;
  if (target < 0 || target >= list.length) return;
  [list[index], list[target]] = [list[target], list[index]];
  dirty();
}
function selectFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  fileLabel.value = file
    ? `${file.name} · ${file.size.toLocaleString()} 字节（仅本地文件元数据，未上传）`
    : "未选择文件";
  if (file && draft.value) {
    draft.value.fileStatus = "pending";
    dirty();
  }
}
function focusField(key: string) {
  document.getElementById(key)?.focus();
}
</script>

<template>
  <section>
    <header class="page-header">
      <div>
        <p class="eyebrow">CONTENT STUDIO · 内容管理演示</p>
        <h1 tabindex="-1">
          {{
            page === "A01"
              ? "内容工作台"
              : page === "A02"
                ? "教材与章节"
                : page === "A03"
                  ? "题目编辑"
                  : "审核与发布"
          }}
        </h1>
        <p class="muted">
          所有保存、授权与资源状态均为内存演示，不连接正式后端，不上传文件。
        </p>
      </div>
      <RouterLink v-if="page !== 'A01'" class="button ghost" to="/admin"
        >返回工作台</RouterLink
      >
    </header>
    <div
      v-if="message"
      ref="summary"
      tabindex="-1"
      role="status"
      class="notice"
      :class="Object.keys(errors).length || conflict ? 'error' : ''"
    >
      <strong>{{ message }}</strong>
      <ul v-if="Object.keys(errors).length">
        <li v-for="(error, key) in errors" :key="key">
          <button
            v-if="page !== 'A04' || key === 'reason'"
            class="button ghost"
            @click="focusField(String(key))"
          >
            {{ error }}</button
          ><span v-else>{{ error }} 请退回编辑，在内容详情中修正。</span>
        </li>
      </ul>
    </div>
    <div v-if="conflict" class="notice warning">
      <p>
        旧 revision
        的操作会被拒绝。重新加载会采用远端版本；保留草稿只更新本地保存基线，不会自动保存。
      </p>
      <div class="actions">
        <button class="button secondary" @click="reload">
          重新加载最新版本</button
        ><button
          v-if="page !== 'A04' && canEdit"
          class="button secondary"
          @click="requestAction('retain')"
        >
          保留本地草稿并重新核对
        </button>
      </div>
    </div>
    <template
      v-if="page === 'A01' || (page === 'A02' && !route.query.versionId)"
    >
      <div class="panel stack">
        <div class="section-heading">
          <h2>版本目录</h2>
          <div class="actions">
            <button
              class="button"
              :disabled="demo.role !== 'editor'"
              @click="create('textbook')"
            >
              新建教材</button
            ><button
              class="button secondary"
              :disabled="demo.role !== 'editor'"
              @click="create('question')"
            >
              新建题目
            </button>
          </div>
        </div>
        <p v-if="demo.role !== 'editor'" class="notice">
          当前身份可查看内容。新建与编辑需要切换为「内容编辑」；审核发布需要「内容审核」。
        </p>
        <div class="form-grid">
          <label class="field"
            >搜索标题<input
              v-model="search"
              placeholder="查找教材或题目" /></label
          ><label class="field"
            >资源类型<select v-model="filterType">
              <option value="all">全部类型</option>
              <option value="textbook">教材</option>
              <option value="question">题目</option>
            </select></label
          ><label class="field"
            >版本状态<select v-model="filterStatus">
              <option value="all">全部状态</option>
              <option value="draft">草稿</option>
              <option value="review">待审核</option>
              <option value="published">已发布</option>
            </select></label
          >
        </div>
        <div v-if="!rows.length" class="empty-state">
          <h3>没有匹配内容</h3>
          <p>调整筛选条件，或使用内容编辑身份新建版本。</p>
        </div>
        <div class="content-list">
          <article v-for="resource in rows" :key="resource.id" class="list-row">
            <div>
              <span class="tag">{{
                resource.type === "textbook" ? "教材" : "题目"
              }}</span>
              <h3>{{ resource.title || "未命名草稿" }}</h3>
              <p class="muted">
                v{{ resource.version }} · {{ statusNames[resource.status] }} ·
                作者 {{ resource.author }} · revision {{ resource.revision }}
              </p>
            </div>
            <div class="actions">
              <button class="button secondary" @click="openResource(resource)">
                {{
                  resource.status === "draft" ? "编辑草稿" : "查看版本"
                }}</button
              ><RouterLink class="button ghost" :to="reviewPath(resource)"
                >审核详情</RouterLink
              >
            </div>
          </article>
        </div>
      </div>
    </template>
    <div v-else-if="!draft" class="empty-state panel">
      <h2>资源不存在或类型不匹配</h2>
      <p>
        此链接可能已失效，或演示重置后该版本已清除。审核只支持 textbook 与
        question。
      </p>
      <RouterLink class="button" to="/admin">安全返回内容工作台</RouterLink>
    </div>
    <template v-else>
      <div class="panel">
        <div class="section-heading">
          <h2>
            {{ draft.title || "未命名草稿" }}
            <span class="tag">{{ statusNames[draft.status] }}</span>
          </h2>
          <span>v{{ draft.version }} · revision {{ expectedRevision }}</span>
        </div>
        <p class="muted">
          版本 ID：{{ draft.id }} · 作者：{{ draft.author }} ·
          {{ draft.type === "textbook" ? "教材版本" : "题目版本" }}
        </p>
        <p v-if="draft.notes" class="notice warning">
          最新意见：{{ draft.notes }}
        </p>
        <div class="actions">
          <button
            v-if="draft.status === 'published'"
            class="button"
            :disabled="demo.role !== 'editor'"
            @click="create(draft.type, draft)"
          >
            复制创建新版本</button
          ><button
            v-if="draft.status !== 'published' && draft.status !== 'retired'"
            class="button ghost"
            @click="simulate"
          >
            模拟别人修改此版本</button
          ><button class="button ghost" @click="reload">
            重新加载最新版本
          </button>
        </div>
        <p v-if="draft.status === 'published'" class="notice">
          已发布内容不可原地修改。复制会创建独立草稿，保留原版本和学生旧会话。
        </p>
      </div>
      <template v-if="page !== 'A04'">
        <p v-if="!canEdit" class="notice warning">
          当前只读：{{
            demo.role !== "editor"
              ? "编辑需要内容编辑身份。"
              : "审核中版本已冻结，须退回后再编辑。"
          }}
        </p>
        <div class="admin-grid">
          <form
            class="panel stack"
            @submit.prevent="save"
            @input="dirty"
            @change="dirty"
          >
            <fieldset :disabled="!canEdit" class="stack">
              <legend>版本内容</legend>
              <label class="field" for="title"
                >标题<input
                  id="title"
                  v-model="draft.title"
                  :aria-invalid="!!errors.title"
                  aria-describedby="title-error"
                /><small id="title-error" class="field-error">{{
                  errors.title
                }}</small></label
              >
              <template v-if="draft.type === 'textbook'">
                <div id="chapters" tabindex="-1">
                  <div class="section-heading">
                    <h3>章节结构 · {{ draft.chapters.length }} 章</h3>
                    <button
                      class="button secondary"
                      type="button"
                      @click="addChapter"
                    >
                      添加章节
                    </button>
                  </div>
                  <p class="field-error">{{ errors.chapters }}</p>
                </div>
                <article
                  v-for="(chapter, index) in draft.chapters"
                  :key="index"
                  class="panel stack"
                >
                  <div class="section-heading">
                    <h3>第 {{ index + 1 }} 章</h3>
                    <div class="actions">
                      <button
                        type="button"
                        class="button ghost"
                        :disabled="index === 0"
                        @click="moveChapter(index, -1)"
                      >
                        上移</button
                      ><button
                        type="button"
                        class="button ghost"
                        :disabled="index === draft.chapters.length - 1"
                        @click="moveChapter(index, 1)"
                      >
                        下移</button
                      ><button
                        type="button"
                        class="button ghost"
                        @click="
                          draft.chapters.splice(index, 1);
                          dirty();
                        "
                      >
                        删除章节
                      </button>
                    </div>
                  </div>
                  <label
                    v-for="field in chapterFields"
                    :key="field"
                    class="field"
                    :for="`chapter-${index}-${field}`"
                    >{{ chapterLabels[field]
                    }}<textarea
                      v-if="field === 'body'"
                      :id="`chapter-${index}-${field}`"
                      v-model="chapter[field]"
                      rows="5"
                      :aria-invalid="!!errors[`chapter-${index}-${field}`]"
                      :aria-describedby="`chapter-${index}-${field}-error`"
                    ></textarea
                    ><input
                      v-else
                      :id="`chapter-${index}-${field}`"
                      v-model="chapter[field]"
                      :aria-invalid="!!errors[`chapter-${index}-${field}`]"
                      :aria-describedby="`chapter-${index}-${field}-error`"
                    /><small
                      :id="`chapter-${index}-${field}-error`"
                      class="field-error"
                      >{{ errors[`chapter-${index}-${field}`] }}</small
                    ></label
                  >
                </article>
                <RouterLink class="button ghost" to="/admin"
                  >进入题库关联题目 →</RouterLink
                >
              </template>
              <template v-else>
                <div class="form-grid">
                  <label class="field"
                    >题型<select v-model="draft.questionType">
                      <option value="single">单选题</option>
                      <option value="multiple">多选题</option>
                      <option value="numeric">数值题</option>
                    </select></label
                  ><label class="field"
                    >难度<select v-model="draft.difficulty">
                      <option>基础</option>
                      <option>提升</option>
                      <option>挑战</option>
                    </select></label
                  >
                </div>
                <label class="field" for="prompt"
                  >题干<textarea
                    id="prompt"
                    v-model="draft.prompt"
                    rows="4"
                    :aria-invalid="!!errors.prompt"
                    aria-describedby="prompt-error"
                  ></textarea
                  ><small id="prompt-error" class="field-error">{{
                    errors.prompt
                  }}</small></label
                >
                <div
                  v-if="draft.questionType !== 'numeric'"
                  id="options"
                  tabindex="-1"
                  class="stack"
                >
                  <h3>选项</h3>
                  <p class="field-error">{{ errors.options }}</p>
                  <label
                    v-for="(_, index) in draft.options"
                    :key="index"
                    class="field"
                    :for="`option-${index}`"
                    >选项 {{ String.fromCharCode(65 + index)
                    }}<input
                      :id="`option-${index}`"
                      v-model="draft.options[index]"
                      :aria-invalid="!!errors[`option-${index}`]"
                      :aria-describedby="`option-${index}-error`"
                    /><small
                      :id="`option-${index}-error`"
                      class="field-error"
                      >{{ errors[`option-${index}`] }}</small
                    ></label
                  >
                  <div class="actions">
                    <button
                      type="button"
                      class="button ghost"
                      :disabled="draft.options.length >= 6"
                      @click="
                        draft.options.push('');
                        dirty();
                      "
                    >
                      添加选项</button
                    ><button
                      type="button"
                      class="button ghost"
                      :disabled="draft.options.length <= 2"
                      @click="
                        draft.options.pop();
                        dirty();
                      "
                    >
                      删除末项
                    </button>
                  </div>
                </div>
                <label class="field" for="correctAnswer"
                  >标准答案<input
                    id="correctAnswer"
                    v-model="draft.correctAnswer"
                    :placeholder="
                      draft.questionType === 'numeric'
                        ? '例如：4'
                        : '单选 B；多选 A,B,D'
                    "
                    :aria-invalid="!!errors.correctAnswer"
                    aria-describedby="correctAnswer-error"
                  /><small id="correctAnswer-error" class="field-error">{{
                    errors.correctAnswer
                  }}</small></label
                >
                <p class="muted">
                  评分演示：{{
                    draft.questionType === "numeric"
                      ? "数值相等得分。"
                      : draft.questionType === "multiple"
                        ? "选项集合完全一致得分，不计顺序，无部分分。"
                        : "选择标准选项得分。"
                  }}
                </p>
                <label class="field" for="explanation"
                  >答案解析<textarea
                    id="explanation"
                    v-model="draft.explanation"
                    rows="3"
                    :aria-invalid="!!errors.explanation"
                    aria-describedby="explanation-error"
                  ></textarea
                  ><small id="explanation-error" class="field-error">{{
                    errors.explanation
                  }}</small></label
                >
                <label class="field" for="knowledge"
                  >关联知识点<input
                    id="knowledge"
                    v-model="draft.knowledge"
                    list="knowledge-list"
                    :aria-invalid="!!errors.knowledge"
                    aria-describedby="knowledge-error"
                  /><small id="knowledge-error" class="field-error">{{
                    errors.knowledge
                  }}</small></label
                ><datalist id="knowledge-list">
                  <option
                    v-for="knowledge in knowledgeOptions"
                    :key="knowledge"
                    :value="knowledge"
                  ></option>
                </datalist>
              </template>
              <h3>来源、授权与文件状态（模拟）</h3>
              <label class="field" for="source"
                >来源及授权说明<textarea
                  id="source"
                  v-model="draft.source"
                  :aria-invalid="!!errors.source"
                  aria-describedby="source-error"
                ></textarea
                ><small id="source-error" class="field-error">{{
                  errors.source
                }}</small></label
              >
              <label class="field" for="authorized"
                ><span
                  ><input
                    id="authorized"
                    v-model="draft.authorized"
                    type="checkbox"
                    :aria-invalid="!!errors.authorized"
                    aria-describedby="authorized-error"
                  />
                  我确认本演示内容授权有效</span
                ><small id="authorized-error" class="field-error">{{
                  errors.authorized
                }}</small></label
              >
              <label class="field"
                >选择示例文件（不上传）<input
                  type="file"
                  @change="selectFile"
                /><small>{{ fileLabel }}</small></label
              >
              <label class="field" for="fileStatus"
                >扫描 / 资源状态模拟<select
                  id="fileStatus"
                  v-model="draft.fileStatus"
                  :aria-invalid="!!errors.fileStatus"
                  aria-describedby="fileStatus-error"
                >
                  <option value="pending">pending · 等待扫描</option>
                  <option value="quarantined">quarantined · 已隔离</option>
                  <option value="ready">ready · 模拟可用</option>
                  <option value="deleting">deleting · 正在删除</option></select
                ><small id="fileStatus-error" class="field-error">{{
                  errors.fileStatus
                }}</small></label
              >
            </fieldset>
            <div class="actions">
              <button class="button" type="submit" :disabled="!canEdit">
                保存草稿</button
              ><button
                class="button secondary"
                type="button"
                :disabled="!canEdit"
                @click="submit"
              >
                送审</button
              ><RouterLink class="button ghost" :to="reviewPath(draft)"
                >查看审核详情</RouterLink
              >
            </div>
            <p class="muted">
              {{
                demo.dirty
                  ? "有未保存修改，离页将要求确认。"
                  : "当前无未保存修改。"
              }}
            </p>
          </form>
          <aside class="panel reading">
            <p class="eyebrow">STUDENT PREVIEW</p>
            <h2>学生预览</h2>
            <p class="muted">预览未发布草稿；此区不展示标准答案与解析。</p>
            <h3>{{ draft.title || "内容标题" }}</h3>
            <template v-if="draft.type === 'textbook'"
              ><section v-for="chapter in draft.chapters" :key="chapter.id">
                <h3>{{ chapter.title || "章节标题" }}</h3>
                <p style="white-space: pre-wrap">
                  {{ chapter.body || "章节正文将在这里显示。" }}
                </p>
                <span class="tag">{{
                  chapter.knowledge || "未关联知识点"
                }}</span>
              </section></template
            ><template v-else
              ><p style="white-space: pre-wrap">
                {{ draft.prompt || "填写题干，实时查看学生阅读效果。" }}
              </p>
              <div v-if="draft.questionType !== 'numeric'" class="stack">
                <div
                  v-for="(option, index) in draft.options"
                  :key="index"
                  class="option"
                >
                  {{ String.fromCharCode(65 + index) }}.
                  {{ option || "待填写选项" }}
                </div>
              </div>
              <label v-else class="field"
                >学生作答区域<input
                  disabled
                  placeholder="填写数值答案" /></label
            ></template>
          </aside>
        </div>
      </template>
      <template v-else>
        <p class="notice">
          审核固定资源类型、版本 ID 与 revision
          {{ expectedRevision }}。发布前仍会再次校验；旧预览不能发布。
        </p>
        <div class="split">
          <section class="panel stack">
            <h2>当前版本核验</h2>
            <p>
              授权：{{ draft.authorized ? "有效（模拟）" : "未授权" }} ·
              文件：{{ draft.fileStatus }}
            </p>
            <p>来源：{{ draft.source || "未填写" }}</p>
            <template v-if="draft.type === 'textbook'"
              ><h3>教材章节结构 · {{ draft.chapters.length }} 章</h3>
              <article v-for="chapter in draft.chapters" :key="chapter.id">
                <h4>{{ chapter.title }}</h4>
                <p class="muted">{{ chapter.id }} · {{ chapter.knowledge }}</p>
                <p style="white-space: pre-wrap">{{ chapter.body }}</p>
              </article></template
            ><template v-else
              ><h3>题目与评分核验</h3>
              <p>
                题型：{{ draft.questionType }} · {{ draft.difficulty }} ·
                {{ draft.knowledge }}
              </p>
              <p>{{ draft.prompt }}</p>
              <p
                v-for="(option, index) in draft.questionType === 'numeric'
                  ? []
                  : draft.options"
                :key="index"
              >
                {{ String.fromCharCode(65 + index) }}. {{ option }}
              </p>
              <p><strong>标准答案：</strong>{{ draft.correctAnswer }}</p>
              <p><strong>解析：</strong>{{ draft.explanation }}</p>
              <p>
                评分规则：{{
                  draft.questionType === "multiple"
                    ? "选项集合完全匹配得分"
                    : draft.questionType === "numeric"
                      ? "数值相等得分"
                      : "标准选项匹配得分"
                }}
              </p></template
            >
            <div
              class="notice"
              :class="Object.keys(reviewChecks).length ? 'warning' : ''"
            >
              <strong>{{
                Object.keys(reviewChecks).length
                  ? "发布前需修正以下项目"
                  : "按资源类型的完整性校验通过"
              }}</strong>
              <ul>
                <li v-for="(error, key) in reviewChecks" :key="key">
                  {{ error }}
                </li>
              </ul>
            </div>
          </section>
          <section class="panel stack">
            <h2>前一版本比较</h2>
            <template v-if="previous"
              ><h3>{{ previous.title }} · v{{ previous.version }}</h3>
              <p>原版本 ID：{{ previous.id }}</p>
              <p>来源：{{ previous.source }}</p>
              <p>
                授权：{{ previous.authorized ? "有效" : "未授权" }} ·
                {{ previous.fileStatus }}
              </p>
              <template v-if="previous.type === 'textbook'"
                ><article
                  v-for="chapter in previous.chapters"
                  :key="chapter.id"
                >
                  <h4>{{ chapter.title }} · {{ chapter.knowledge }}</h4>
                  <p>{{ chapter.body }}</p>
                </article></template
              ><template v-else
                ><p>{{ previous.prompt }}</p>
                <p v-for="(option, index) in previous.options" :key="index">
                  {{ String.fromCharCode(65 + index) }}. {{ option }}
                </p>
                <p>答案：{{ previous.correctAnswer }}</p>
                <p>解析：{{ previous.explanation }}</p></template
              ></template
            >
            <p v-else class="empty-state">
              这是首个版本，没有可比较的前一版本。
            </p>
            <h3>版本历史</h3>
            <ol v-if="draft.history.length">
              <li v-for="(entry, index) in draft.history" :key="index">
                {{ entry }}
              </li>
            </ol>
            <p v-else class="muted">初始演示版本，暂无操作历史。</p>
          </section>
        </div>
        <section class="panel stack">
          <h2>审核意见</h2>
          <p v-if="!canReview" class="notice warning">
            {{
              demo.role !== "reviewer"
                ? "请切换顶部「内容审核」身份后操作；内容编辑不能自审发布。"
                : draft.author === demo.role
                  ? "禁止自审：当前审核者就是版本作者。"
                  : "当前版本不是待审核状态，无可执行审核动作。"
            }}
          </p>
          <label class="field" for="reason"
            >意见（退回必填，发布选填）<textarea
              id="reason"
              v-model="reason"
              :disabled="!canReview"
              rows="3"
              :aria-invalid="!!errors.reason"
              aria-describedby="reason-error"
              @input="canReview && (demo.dirty = true)"
            ></textarea
            ><small id="reason-error" class="field-error">{{
              errors.reason
            }}</small></label
          >
          <div class="actions">
            <button
              class="button"
              :disabled="!canReview"
              @click="requestAction('publish')"
            >
              批准并发布</button
            ><button
              class="button secondary"
              :disabled="!canReview"
              @click="requestAction('return')"
            >
              退回修改</button
            ><RouterLink class="button ghost" :to="editPath(draft)"
              >返回内容详情</RouterLink
            >
          </div>
        </section>
      </template>
    </template>
    <ConfirmDialog
      v-model="confirmation"
      :title="
        pendingAction === 'publish'
          ? '确认发布此版本？'
          : pendingAction === 'return'
            ? '确认退回修改？'
            : '明确保留本地草稿？'
      "
      :confirm-text="
        pendingAction === 'publish'
          ? '确认发布'
          : pendingAction === 'return'
            ? '确认退回'
            : '保留并继续编辑'
      "
      @confirm="confirmAction"
      ><p>
        {{
          pendingAction === "publish"
            ? "将再次核验 revision、授权与资源状态。成功后学生目录可见该版本，旧会话不变。"
            : pendingAction === "return"
              ? "版本将恢复为草稿，审核意见会写入演示历史。"
              : "保留本地内容并采用最新 revision 作为基线；下次保存将覆盖协作者的草稿字段。尚未保存，请先核对差异。"
        }}
      </p></ConfirmDialog
    >
  </section>
</template>
