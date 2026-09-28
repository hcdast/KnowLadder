<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import ConfirmDialog from "../../components/ConfirmDialog.vue";
import { demo } from "../../services/core";
import {
  changeAnswer,
  confirmSubmission,
  getSession,
  isLocked,
  quizId,
  resolveConflict,
  retrySave,
  saveAnswers,
  setActiveSession,
  submitSession,
  toggleMark,
} from "../../services/student-service";
const route = useRoute(),
  router = useRouter();
let mounted = true;
const session = computed(() => getSession(String(route.params.sessionId)));
const valid = computed(
  () =>
    session.value &&
    session.value.mode === (route.meta.page === "S07" ? "quiz" : "practice"),
);
const question = computed(
  () => session.value?.questions[session.value.current],
);
const now = ref(Date.now()),
  confirmOpen = ref(false),
  localConflict = ref(false),
  busy = ref(false),
  leaveMessage = ref("");
const labels = {
  clean: "已保存 · 演示内存",
  dirty: "有更改尚未保存",
  saving: "正在保存",
  save_failed: "尚未保存，请勿关闭页面",
  conflict: "版本冲突，需要选择",
  submitting: "正在提交，答案已锁定",
  confirmation_pending: "正在确认是否提交成功",
};
const remaining = computed(() =>
  Math.max(
    0,
    Math.ceil(((session.value?.deadline || now.value) - now.value) / 1000),
  ),
);
const clock = computed(
  () =>
    `${Math.floor(remaining.value / 60)
      .toString()
      .padStart(2, "0")}:${(remaining.value % 60).toString().padStart(2, "0")}`,
);
const locked = computed(() => {
  now.value;
  return !session.value || isLocked(session.value);
});
const unanswered = computed(
  () =>
    session.value?.questions
      .map((q, i) => ({ q, i }))
      .filter(({ q }) => !session.value?.answers[q.id]?.trim()) || [],
);
const timer = window.setInterval(() => {
  now.value = Date.now();
}, 250);
watch(
  () => session.value?.id,
  (id) => {
    leaveMessage.value = "";
    setActiveSession(valid.value ? id || "" : "");
  },
  { immediate: true },
);
watch(
  () => session.value?.local,
  (state) => {
    if (state === "clean" || state === "saving") leaveMessage.value = "";
  },
);
watch(
  [remaining, () => session.value?.status],
  () => {
    const s = session.value;
    if (
      s &&
      valid.value &&
      s.mode === "quiz" &&
      s.status === "in_progress" &&
      remaining.value === 0 &&
      !busy.value &&
      s.local !== "confirmation_pending"
    )
      void finish();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  mounted = false;
  window.clearInterval(timer);
  setActiveSession("");
});
function select(answer: string) {
  if (session.value && question.value)
    changeAnswer(session.value, question.value.id, answer);
}
function multiple(letter: string, checked: boolean) {
  const values = (session.value?.answers[question.value!.id] || "")
    .split(",")
    .filter(Boolean);
  select(
    (checked
      ? [...new Set([...values, letter])]
      : values.filter((v) => v !== letter)
    )
      .sort()
      .join(","),
  );
}
function jump(index: number) {
  if (session.value) session.value.current = index;
  confirmOpen.value = false;
}
async function finish() {
  const s = session.value;
  if (!s || busy.value) return;
  busy.value = true;
  confirmOpen.value = false;
  const id = await submitSession(s);
  busy.value = false;
  if (id && mounted) await router.push(`/student/submissions/${id}`);
}
async function restore() {
  const s = session.value;
  if (!s || busy.value) return;
  busy.value = true;
  const id = await confirmSubmission(s);
  busy.value = false;
  if (id && mounted) await router.push(`/student/submissions/${id}`);
}
async function leave() {
  const s = session.value;
  if (!s || busy.value) return;
  leaveMessage.value = "";
  busy.value = true;
  const ok = await saveAnswers(s);
  busy.value = false;
  if (ok && mounted)
    await router.push(
      s.mode === "quiz"
        ? `/student/quizzes/${quizId}`
        : `/student/practice?chapter=${s.chapterId}`,
    );
  else if (!ok && mounted)
    leaveMessage.value =
      "未能确认保存，仍停留当前页。可恢复连接或解决冲突后再离开。";
}
async function keepLocal() {
  if (session.value) await resolveConflict(session.value, true);
  localConflict.value = false;
}
</script>
<template>
  <section v-if="!valid" class="empty-state">
    <h1 tabindex="-1">此演示记录不存在</h1>
    <p>刷新会重置内存记录。请从首页创建会话，不会自动创建或显示其他记录。</p>
    <RouterLink class="button" to="/student">返回学生首页</RouterLink>
  </section>
  <div v-else-if="session" class="stack">
    <header class="page-header">
      <div>
        <p class="eyebrow">
          {{ session.mode === "quiz" ? "QUIZ · 测验" : "PRACTICE · 自主练习" }}
        </p>
        <h1 tabindex="-1">
          {{
            session.mode === "quiz" ? "等式的性质 · 小测验" : "把每一步，练扎实"
          }}
        </h1>
        <p class="muted">
          {{ session.questions.length }} 题 ·
          {{ session.seen ? "已见题重练，生成独立记录" : "基础练习" }} ·
          提交后查看示例解析
        </p>
      </div>
      <div
        v-if="session.mode === 'quiz'"
        class="timer"
        role="timer"
        aria-label="剩余作答时间"
      >
        {{ clock }}<small>演示服务时钟 · 离开不暂停</small>
      </div>
    </header>
    <div class="notice" role="status" aria-live="polite">
      <strong>{{ labels[session.local] }}</strong
      ><span v-if="session.savedAt">
        · 最近确认 {{ session.savedAt }} · revision {{ session.revision }}</span
      >
      <p v-if="session.message">{{ session.message }}</p>
      <small>仅当前演示内存保存，刷新、关闭页面会重置；不是云端存储。</small>
    </div>
    <div
      v-if="session.mode === 'quiz' && remaining === 0"
      class="notice warning"
      role="alert"
    >
      已到截止时间，正在获取最终状态。仅使用截止前确认保存的答案，不能补答。<button
        v-if="!busy && session.status === 'in_progress'"
        class="button secondary"
        @click="restore"
      >
        确认最终状态
      </button>
    </div>
    <div v-if="session.local === 'confirmation_pending'" class="panel stack">
      <h2>受理结果未知，请勿重复交卷</h2>
      <p>使用原始请求正文与同一幂等键恢复。确认前不会创建第二条成绩。</p>
      <code class="request-key">{{ session.requestKey }}</code
      ><button class="button" :disabled="busy" @click="restore">
        {{ busy ? "正在查询…" : "确认最终状态" }}
      </button>
    </div>
    <div v-else-if="session.status === 'submitted'" class="panel">
      <h2>本次会话已结束</h2>
      <RouterLink
        class="button"
        :to="`/student/submissions/${session.submissionId}`"
        >查看原提交结果</RouterLink
      >
    </div>
    <template v-else>
      <div v-if="session.local === 'save_failed'" class="actions">
        <button class="button" :disabled="busy" @click="retrySave(session)">
          恢复连接并重试保存（演示）
        </button>
      </div>
      <section
        v-if="session.local === 'conflict'"
        class="panel stack"
        aria-label="修订冲突"
      >
        <h2>本地草稿与服务器版本不同</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>题号</th>
                <th>本地草稿</th>
                <th>服务器版本（模拟）</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(q, index) in session.questions" :key="q.id">
                <td>{{ index + 1 }}</td>
                <td>{{ session.answers[q.id] || "未答" }}</td>
                <td>{{ session.saved[q.id] || "未答" }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="actions">
          <button
            class="button"
            :disabled="locked"
            @click="localConflict = true"
          >
            确认使用本地草稿</button
          ><button
            class="button secondary"
            :disabled="locked"
            @click="resolveConflict(session, false)"
          >
            保留服务器版本
          </button>
        </div>
      </section>
      <div class="question-layout">
        <section v-if="question" class="question-card stack">
          <div class="section-heading">
            <span class="tag"
              >第 {{ session.current + 1 }} / {{ session.questions.length }} 题
              ·
              {{
                question.type === "single"
                  ? "单选"
                  : question.type === "multiple"
                    ? "多选"
                    : "数值填空"
              }}</span
            ><button
              class="button ghost"
              :aria-pressed="session.marks.includes(question.id)"
              @click="toggleMark(session, question.id)"
            >
              {{
                session.marks.includes(question.id)
                  ? "已标记 · 取消标记"
                  : "标记此题"
              }}
            </button>
          </div>
          <h2 class="formula">{{ question.prompt }}</h2>
          <fieldset :disabled="locked">
            <legend class="sr-only">第 {{ session.current + 1 }} 题作答</legend>
            <template v-if="question.type !== 'numeric'"
              ><label
                v-for="(option, index) in question.options"
                :key="`${question.id}-${index}`"
                class="option"
                ><input
                  v-if="question.type === 'single'"
                  type="radio"
                  :name="question.id"
                  :value="String.fromCharCode(65 + index)"
                  :checked="
                    session.answers[question.id] ===
                    String.fromCharCode(65 + index)
                  "
                  @change="select(String.fromCharCode(65 + index))"
                /><input
                  v-else
                  type="checkbox"
                  :checked="
                    (session.answers[question.id] || '')
                      .split(',')
                      .includes(String.fromCharCode(65 + index))
                  "
                  @change="
                    multiple(
                      String.fromCharCode(65 + index),
                      ($event.target as HTMLInputElement).checked,
                    )
                  "
                /><span
                  >{{ String.fromCharCode(65 + index) }}. {{ option }}</span
                ></label
              ></template
            ><label v-else class="field"
              >你的答案<input
                :key="question.id"
                inputmode="decimal"
                autocomplete="off"
                :value="session.answers[question.id] || ''"
                placeholder="输入整数或有限小数"
                @input="select(($event.target as HTMLInputElement).value)"
              /><small
                >支持整数和有限小数，不支持分数式或公式等价判定。</small
              ></label
            >
          </fieldset>
          <div class="actions">
            <button
              class="button secondary"
              :disabled="session.current === 0"
              @click="session.current--"
            >
              上一题</button
            ><button
              v-if="session.current < session.questions.length - 1"
              class="button"
              @click="session.current++"
            >
              下一题</button
            ><button
              v-else
              class="button"
              :disabled="locked || session.local === 'conflict'"
              @click="confirmOpen = true"
            >
              {{ session.mode === "quiz" ? "检查并交卷" : "结束并提交" }}
            </button>
          </div>
        </section>
        <aside class="panel stack">
          <h2>答题卡</h2>
          <p class="muted">
            已答 {{ session.questions.length - unanswered.length }} /
            {{ session.questions.length }} · 标记 {{ session.marks.length }}
          </p>
          <nav class="question-nav" aria-label="题号导航">
            <button
              v-for="(q, index) in session.questions"
              :key="q.id"
              :aria-current="session.current === index ? 'step' : undefined"
              :class="{
                current: session.current === index,
                answered: !!session.answers[q.id],
              }"
              @click="jump(index)"
            >
              {{ index + 1
              }}<small
                >{{ session.answers[q.id] ? "已答" : "未答"
                }}{{ session.marks.includes(q.id) ? " · 标记" : "" }}</small
              >
            </button>
          </nav>
          <button
            class="button"
            :disabled="locked || session.local === 'conflict'"
            @click="confirmOpen = true"
          >
            {{ session.mode === "quiz" ? "检查并交卷" : "结束并提交" }}</button
          ><button
            class="button secondary"
            :disabled="locked || busy"
            @click="leave"
          >
            保存并离开
          </button>
          <p v-if="leaveMessage" role="alert">{{ leaveMessage }}</p>
          <small class="muted"
            >测验计时不会因暂时离开而暂停。离页提示不保证系统关闭后的恢复。</small
          >
        </aside>
      </div>
    </template>
    <ConfirmDialog
      v-model="confirmOpen"
      title="交卷前，再检查一次"
      confirm-text="确认提交"
      @confirm="finish"
      ><p>
        已答 {{ session.questions.length - unanswered.length }} 题，未答
        {{ unanswered.length }} 题。提交后不可修改本次答案。
      </p>
      <p v-if="!unanswered.length">
        全部题目已有作答，仍可取消并回到答题卡检查。
      </p>
      <div class="actions">
        <button
          v-for="item in unanswered"
          :key="item.q.id"
          class="button secondary"
          @click="jump(item.i)"
        >
          返回第 {{ item.i + 1 }} 题（未答）
        </button>
      </div></ConfirmDialog
    >
    <ConfirmDialog
      v-model="localConflict"
      title="用本地草稿覆盖模拟服务器版本？"
      confirm-text="确认并重新保存"
      @confirm="keepLocal"
      ><p>
        将使用当前 revision
        重新保存上表中的本地答案。此操作不会自动合并另一设备的答案。
      </p></ConfirmDialog
    >
  </div>
</template>
<style scoped>
.timer {
  font-size: 2rem;
  font-variant-numeric: tabular-nums;
  font-weight: 750;
}
.timer small {
  display: block;
  font-size: 0.7rem;
  font-weight: 400;
}
.request-key {
  overflow-wrap: anywhere;
}
.question-nav button small {
  display: block;
  font-size: 0.65rem;
}
.question-nav button.current {
  outline: 2px solid var(--primary, #24756f);
  outline-offset: 2px;
}
.question-nav button.answered {
  background: #e6f3ed;
}
fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.option {
  cursor: pointer;
}
.option:has(input:checked) {
  background: #edf6f0;
  border-color: #287a63;
}
.question-card h2 {
  font-size: 1.3rem;
  line-height: 1.8;
}
</style>
