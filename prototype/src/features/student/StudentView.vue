<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { demo } from "../../services/core";
import {
  chapters,
  createSession,
  defaultChapterId,
  getChapter,
  getSubmission,
  mistakes,
  published,
  questionCount,
  quizId,
  quizWindow,
  refreshReport,
  reportEvidence,
  sessionPath,
  setActiveSession,
  student,
  textbooks,
} from "../../services/student-service";
import SessionView from "./SessionView.vue";
import ResultView from "./ResultView.vue";
const route = useRoute(),
  router = useRouter();
const page = computed(() => String(route.meta.page));
const selectedChapter = ref(defaultChapterId),
  difficulty = ref("基础"),
  type = ref("all"),
  agreed = ref(false),
  error = ref("");
const active = computed(() =>
  student.sessions.filter(
    (s) => s.status === "in_progress" || s.local === "confirmation_pending",
  ),
);
const quizSession = computed(() =>
  student.sessions.find((s) => s.mode === "quiz"),
);
const chapter = computed(() => getChapter(String(route.params.chapterId)));
const count = computed(() =>
  questionCount(selectedChapter.value, difficulty.value, type.value),
);
const bookList = computed(() =>
  textbooks.value.filter(
    (b) =>
      (!student.filters.textbook || b.id === student.filters.textbook) &&
      (b.title.includes(student.filters.search) ||
        b.chapters.some((c) => c.title.includes(student.filters.search))),
  ),
);
const evidence = computed(() => reportEvidence());
const correctCount = computed(
  () => evidence.value.filter((e) => e.correct).length,
);
const mistakeList = computed(() =>
  mistakes().filter(
    (m) =>
      (!student.filters.mistake ||
        m.question.knowledge.includes(student.filters.mistake)) &&
      (!student.filters.mode || m.submission.mode === student.filters.mode) &&
      (student.filters.period === "all" ||
        Date.now() - new Date(m.submission.createdAt).getTime() < 86400000),
  ),
);
const knowledgeRows = computed(() =>
  [...new Set(evidence.value.map((e) => e.question.knowledge))].map((name) => {
    const rows = evidence.value.filter((e) => e.question.knowledge === name);
    return {
      name,
      total: rows.length,
      right: rows.filter((e) => e.correct).length,
      chapter: chapters.value.find((c) => c.knowledge === name),
    };
  }),
);
const sourceBack = computed(() => {
  const from = String(route.query.from || "");
  if (from === "mistakes") return "/student/mistakes";
  if (from === "growth") return "/student/growth";
  if (getSubmission(from)) return `/student/submissions/${from}`;
  return "/student/textbooks";
});
const nextChapter = computed(() => {
  const index = chapters.value.findIndex((c) => c.id === chapter.value?.id);
  return index >= 0 ? chapters.value[index + 1] : null;
});
function clearFilters() {
  student.filters.textbook = "";
  student.filters.search = "";
}
async function start(mode: "practice" | "quiz") {
  error.value = "";
  if (mode === "quiz" && !agreed.value) {
    error.value = "请先确认测验规则。";
    return;
  }
  const origin = route.fullPath;
  const s = await createSession(
    mode,
    mode === "quiz" ? defaultChapterId : selectedChapter.value,
    mode === "quiz" ? "基础" : difficulty.value,
    mode === "quiz" ? "all" : type.value,
    route.query.seen === "1",
  );
  if (
    s &&
    route.fullPath === origin &&
    demo.role === "student" &&
    !["forbidden", "expired"].includes(demo.fault)
  )
    await router.push(
      s.submissionId && s.local !== "confirmation_pending"
        ? `/student/submissions/${s.submissionId}`
        : sessionPath(s),
    );
}
function rememberScroll() {
  if (page.value === "S03" && chapter.value)
    student.positions[chapter.value.id] = window.scrollY;
}
window.addEventListener("scroll", rememberScroll, { passive: true });
onBeforeUnmount(() => window.removeEventListener("scroll", rememberScroll));
watch(
  () => route.fullPath,
  async () => {
    error.value = "";
    student.createMessage = "";
    if (!["S05", "S07"].includes(page.value)) setActiveSession("");
    if (page.value === "S04")
      selectedChapter.value =
        typeof route.query.chapter === "string"
          ? route.query.chapter
          : demo.readChapterId || defaultChapterId;
    if (page.value === "S03" && chapter.value) {
      demo.readChapterId = chapter.value.id;
      await nextTick();
      window.scrollTo(0, student.positions[chapter.value.id] || 0);
    }
  },
  { immediate: true },
);
const stateNames: Record<string, string> = {
  pending: "批改中",
  completed: "结果已发布",
  unreleased: "成绩待发布",
  failed: "批改暂未完成",
  review: "等待复核",
};
const stateLabel = (state: string) => stateNames[state] || state;
</script>
<template>
  <SessionView
    v-if="page === 'S05' || page === 'S07'"
    :key="`${page}-${route.params.sessionId}`"
  />
  <ResultView
    v-else-if="page === 'S08'"
    :key="String(route.params.submissionId)"
  />
  <div v-else class="stack">
    <template v-if="page === 'S01'">
      <header class="page-header">
        <div>
          <p class="eyebrow">YOUR LEARNING JOURNEY</p>
          <h1 tabindex="-1">一步一步，学得更明白。</h1>
          <p class="muted">不急着赶路，让每一次练习都有收获。</p>
        </div>
        <span class="tag">七年级 · 数学原创示例</span>
      </header>
      <section class="panel welcome">
        <div>
          <p class="eyebrow">
            {{
              active.length
                ? "接着上次，继续向前"
                : demo.readChapterId
                  ? "今天，从这一页开始"
                  : "第一步，从一本书开始"
            }}
          </p>
          <h2>
            {{
              active.length
                ? "还有一组练习等你完成"
                : demo.readChapterId
                  ? getChapter(demo.readChapterId)?.title || "继续探索教材"
                  : "选择教材，开启你的学习旅程"
            }}
          </h2>
          <p>读懂一个概念，再用几道题检验自己的理解。</p>
          <RouterLink
            v-if="active[0]"
            class="button"
            :to="sessionPath(active[0])"
            >{{
              active[0].local === "confirmation_pending"
                ? "继续确认提交状态"
                : active[0].mode === "quiz"
                  ? "继续测验"
                  : "继续练习"
            }}</RouterLink
          ><RouterLink
            v-else-if="demo.readChapterId && getChapter(demo.readChapterId)"
            class="button"
            :to="`/student/chapters/${demo.readChapterId}`"
            >继续阅读</RouterLink
          ><RouterLink v-else class="button" to="/student/textbooks"
            >选择教材</RouterLink
          >
        </div>
        <div class="step-art" aria-hidden="true">
          <span>01<br /><small>读懂</small></span
          ><span>02<br /><small>练习</small></span
          ><span>03<br /><small>进步</small></span>
        </div>
      </section>
      <div class="split">
        <section class="panel stack">
          <h2>给自己一次小检验</h2>
          <h3>等式的性质 · 小测验</h3>
          <p class="muted">单选 / 多选 / 数值填空 · 10 分钟 · 1 次机会</p>
          <RouterLink
            class="button secondary"
            :to="`/student/quizzes/${quizId}`"
            >查看测验说明</RouterLink
          >
        </section>
        <section class="panel stack">
          <h2>下一步，有据可循</h2>
          <p>
            {{
              published.length
                ? "回顾已经发布的作答证据，找到值得再练习的地方。"
                : "还没有足够的作答证据。完成一次基础练习后，再来看适合你的建议。"
            }}
          </p>
          <RouterLink class="button ghost" to="/student/growth">{{
            published.length ? "查看学情与建议" : "了解我的学习起点"
          }}</RouterLink>
        </section>
      </div>
      <section class="stack">
        <h2>最近的学习记录</h2>
        <div v-if="!student.submissions.length" class="empty-state">
          <h3>新的开始，还没有作答记录</h3>
          <p>这里将记录每次提交，不用空白数据推断你的能力。</p>
        </div>
        <RouterLink
          v-for="s in student.submissions"
          :key="s.id"
          class="list-row panel"
          :to="`/student/submissions/${s.id}`"
          ><div>
            <strong>{{
              s.mode === "quiz" ? "等式的性质 · 测验" : "等式的性质 · 基础练习"
            }}</strong>
            <p class="muted">{{ new Date(s.createdAt).toLocaleString() }}</p>
          </div>
          <span class="tag">{{ stateLabel(s.state) }} →</span></RouterLink
        >
      </section>
    </template>
    <template v-else-if="page === 'S02'">
      <header class="page-header">
        <div>
          <p class="eyebrow">TEXTBOOKS · 我的课本</p>
          <h1 tabindex="-1">从理解开始，把知识连起来。</h1>
          <p class="muted">知阶原创数学演示教材，非正式教材或扫描件。</p>
        </div>
      </header>
      <section class="panel form-grid">
        <label class="field"
          >教材版本<select v-model="student.filters.textbook">
            <option value="">全部已授权版本</option>
            <option v-for="b in textbooks" :key="b.id" :value="b.id">
              {{ b.title }} · v{{ b.version }}
            </option>
          </select></label
        ><label class="field"
          >查找教材或章节<input
            v-model="student.filters.search"
            type="search"
            placeholder="例如：等式的性质"
        /></label>
      </section>
      <section v-if="!bookList.length" class="empty-state">
        <h2>
          {{ textbooks.length ? "没有匹配的教材或章节" : "暂无可用教材" }}
        </h2>
        <p>
          {{
            textbooks.length
              ? "试试其他关键词或清空筛选。"
              : "仅展示已发布、授权有效且资源就绪的教材。"
          }}
        </p>
        <button
          v-if="textbooks.length"
          class="button secondary"
          @click="clearFilters"
        >
          清空筛选</button
        ><RouterLink v-else class="button" to="/student">返回首页</RouterLink>
      </section>
      <section v-for="book in bookList" :key="book.id" class="panel stack">
        <div class="section-heading">
          <div>
            <span class="eyebrow">ORIGINAL DEMO · 已授权</span>
            <h2>{{ book.title }}</h2>
          </div>
          <span class="tag"
            >v{{ book.version }} · {{ book.chapters.length }} 节</span
          >
        </div>
        <p class="muted">{{ book.source }}</p>
        <RouterLink
          v-for="(c, index) in book.chapters.filter(
            (c) =>
              !student.filters.search ||
              book.title.includes(student.filters.search) ||
              c.title.includes(student.filters.search),
          )"
          :key="c.id"
          class="list-row"
          :to="`/student/chapters/${c.id}`"
          ><div>
            <span class="chapter-number">{{
              String(index + 1).padStart(2, "0")
            }}</span
            ><strong>{{ c.title }}</strong>
          </div>
          <span
            >{{
              demo.readChapterId === c.id ? "上次读到这里" : "开始阅读"
            }}
            →</span
          ></RouterLink
        >
      </section>
    </template>
    <template v-else-if="page === 'S03'">
      <section v-if="!chapter" class="empty-state">
        <h1 tabindex="-1">此章节暂不可访问</h1>
        <p>资源可能已下线或链接不属于当前演示。不会展示未授权内容。</p>
        <RouterLink class="button" to="/student/textbooks"
          >返回教材目录</RouterLink
        >
      </section>
      <template v-else
        ><header class="page-header">
          <div>
            <p class="eyebrow">
              {{ chapter.textbook }} / v{{ chapter.version }}
            </p>
            <h1 tabindex="-1">{{ chapter.title }}</h1>
            <p class="muted">原创示例 · 阅读位置不代表已掌握</p>
          </div>
          <RouterLink class="button ghost" :to="sourceBack">{{
            route.query.from ? "返回来源" : "返回目录"
          }}</RouterLink>
        </header>
        <div class="reading-layout">
          <aside class="panel">
            <h2>章节目录</h2>
            <nav class="stack" aria-label="章节导航">
              <RouterLink
                v-for="c in chapters.filter(
                  (c) => c.textbookId === chapter!.textbookId,
                )"
                :key="c.id"
                :aria-current="c.id === chapter.id ? 'page' : undefined"
                :to="`/student/chapters/${c.id}`"
                >{{ c.title }}</RouterLink
              >
            </nav>
          </aside>
          <article class="reading panel">
            <p class="eyebrow">先理解，再应用</p>
            <h2>{{ chapter.title }}</h2>
            <p
              v-for="(paragraph, index) in chapter.body.split('\n')"
              :key="index"
              class="reading-paragraph"
            >
              {{ paragraph }}
            </p>
            <div class="notice">
              <strong>停下来，想一想</strong>
              <p>
                每次变形后，等式两边还保持相等吗？试着把你的解代回原式检验。
              </p>
            </div>
            <div class="actions">
              <RouterLink
                class="button"
                :to="`/student/practice?chapter=${chapter.id}&from=${route.query.from || 'chapter'}`"
                >练习本节</RouterLink
              ><RouterLink
                v-if="nextChapter"
                class="button secondary"
                :to="`/student/chapters/${nextChapter.id}`"
                >下一节：{{ nextChapter.title }}</RouterLink
              >
            </div>
          </article>
          <aside class="panel stack">
            <h2>本节知识点</h2>
            <span class="tag">{{ chapter.knowledge }}</span>
            <p class="muted">先从基础题开始，用作答发现还需要巩固的地方。</p>
            <p>
              {{ questionCount(chapter.id, "基础", "all") }} 道基础示例题可练习
            </p>
          </aside>
        </div></template
      >
    </template>
    <template v-else-if="page === 'S04'">
      <header class="page-header">
        <div>
          <p class="eyebrow">PRACTICE · 自主练习</p>
          <h1 tabindex="-1">选好起点，专注这一小步。</h1>
          <p class="muted">
            提交后查看解析；提升与挑战暂无题时不会用基础题替代。
          </p>
        </div>
        <RouterLink class="button secondary" :to="`/student/quizzes/${quizId}`"
          >查看小测验</RouterLink
        >
      </header>
      <div v-if="active.length" class="notice">
        <strong>你有 {{ active.length }} 个进行中或待确认会话</strong>
        <div class="actions">
          <RouterLink
            v-for="s in active"
            :key="s.id"
            class="button ghost"
            :to="sessionPath(s)"
            >{{
              s.local === "confirmation_pending"
                ? "继续确认提交"
                : s.mode === "quiz"
                  ? "继续已有测验"
                  : "继续已有练习"
            }}</RouterLink
          >
        </div>
        <p>下方开始练习会新建独立记录，不覆盖已有会话。</p>
      </div>
      <form class="panel stack" @submit.prevent="start('practice')">
        <h2>练习设置</h2>
        <div class="form-grid">
          <label class="field"
            >章节与知识点<select v-model="selectedChapter" required>
              <option value="" disabled>请选择章节</option>
              <option v-for="c in chapters" :key="c.id" :value="c.id">
                {{ c.textbook }} v{{ c.version }} / {{ c.title }}
              </option>
            </select></label
          ><label class="field"
            >题型<select v-model="type">
              <option value="all">全部题型</option>
              <option value="single">单选</option>
              <option value="multiple">多选</option>
              <option value="numeric">数值填空</option>
            </select></label
          >
        </div>
        <fieldset>
          <legend>选择难度</legend>
          <div class="difficulty-grid">
            <label
              v-for="level in ['基础', '提升', '挑战']"
              :key="level"
              class="option"
              ><input
                v-model="difficulty"
                type="radio"
                name="difficulty"
                :value="level"
              /><span
                ><strong>{{ level }}</strong
                ><small>{{
                  level === "基础"
                    ? "理解概念，练稳基本功"
                    : level === "提升"
                      ? "综合应用，进一步探索"
                      : "挑战更复杂的问题"
                }}</small></span
              ></label
            >
          </div>
        </fieldset>
        <p class="notice">
          范围：{{
            getChapter(selectedChapter)?.knowledge || "未选择有效章节"
          }}
          · {{ difficulty }} · {{ count }} 题<span
            v-if="route.query.seen === '1'"
          >
            · 已见题重练，原成绩保留</span
          >
        </p>
        <div v-if="count === 0" class="notice warning">
          <strong>当前范围没有可用题目</strong>
          <p>可以调整难度、题型或返回章节。不会扩大范围补题。</p>
          <button
            v-if="demo.fault === 'no-questions'"
            type="button"
            class="button secondary"
            @click="demo.fault = 'normal'"
          >
            恢复可用题目（演示）
          </button>
        </div>
        <p v-if="student.createMessage" class="notice error" role="alert">
          {{ student.createMessage }}
        </p>
        <div class="actions">
          <button class="button" :disabled="student.creating || count === 0">
            {{ student.creating ? "正在创建…" : "开始练习" }}</button
          ><RouterLink
            class="button secondary"
            :to="
              getChapter(selectedChapter)
                ? `/student/chapters/${selectedChapter}`
                : '/student/textbooks'
            "
            >返回章节</RouterLink
          ><RouterLink
            v-if="route.query.from === 'mistakes'"
            class="button ghost"
            to="/student/mistakes"
            >返回错题</RouterLink
          >
        </div>
        <button
          v-if="demo.fault === 'offline'"
          type="button"
          class="button secondary"
          @click="demo.fault = 'normal'"
        >
          恢复连接（演示）
        </button>
      </form>
      <RouterLink
        v-if="
          route.query.from === 'growth' ||
          getSubmission(String(route.query.from))
        "
        class="button ghost"
        :to="sourceBack"
        >返回来源</RouterLink
      >
    </template>
    <template v-else-if="page === 'S06'">
      <section v-if="route.params.quizId !== quizId" class="empty-state">
        <h1 tabindex="-1">此演示记录不存在</h1>
        <RouterLink class="button" to="/student/practice"
          >返回练测入口</RouterLink
        >
      </section>
      <template v-else
        ><header class="page-header">
          <div>
            <p class="eyebrow">QUIZ · 测验说明</p>
            <h1 tabindex="-1">等式的性质 · 小测验</h1>
            <p class="muted">用一小段专注的时间，检验你的理解。</p>
          </div>
          <span class="tag">原创示例测验</span>
        </header>
        <section class="panel stack">
          <h2>开始前，请了解这些规则</h2>
          <dl class="quiz-facts">
            <div>
              <dt>范围与题型</dt>
              <dd>等式的性质 · 基础 · 单选、多选、数值填空</dd>
            </div>
            <div>
              <dt>题量 / 时长</dt>
              <dd>
                {{ questionCount(defaultChapterId, "基础", "all") }} 题 / 最长
                10 分钟
              </dd>
            </div>
            <div>
              <dt>开放时间</dt>
              <dd>
                {{ new Date(quizWindow.opens).toLocaleString() }} —
                {{ new Date(quizWindow.closes).toLocaleString() }}（{{
                  Intl.DateTimeFormat().resolvedOptions().timeZone
                }}）
              </dd>
            </div>
            <div>
              <dt>次数</dt>
              <dd>
                允许 1 次 · 已成功创建
                {{ quizSession ? 1 : 0 }} 次（恢复会话不重复扣次）
              </dd>
            </div>
            <div>
              <dt>成绩规则</dt>
              <dd>
                {{
                  demo.fault === "unreleased"
                    ? "当前演示场景：批改后等待模拟发布。"
                    : "示例批改完成后发布；异常场景可待复核或待发布。"
                }}
                考试期间不提供答案或解析。
              </dd>
            </div>
          </dl>
          <div class="notice warning">
            倒计时来自演示服务时钟。离开页面不暂停计时，截止仅提交此前确认保存的答案。刷新将丢失演示记录，不承诺离线交卷。
          </div>
          <p v-if="quizWindow.closes - Date.now() < 600000">
            距关闭不足完整时长，本次将在窗口关闭时提前截止。
          </p>
          <p
            v-if="error || student.createMessage"
            class="notice error"
            role="alert"
          >
            {{ error || student.createMessage }}
          </p>
          <template v-if="quizSession"
            ><RouterLink
              class="button"
              :to="
                quizSession.submissionId &&
                quizSession.local !== 'confirmation_pending'
                  ? `/student/submissions/${quizSession.submissionId}`
                  : sessionPath(quizSession)
              "
              >{{
                quizSession.submissionId &&
                quizSession.local !== "confirmation_pending"
                  ? "查看本次结果"
                  : "继续已有测验"
              }}</RouterLink
            >
            <p class="muted">
              已使用本次机会，不会新建第二次测验或重置截止时间。
            </p></template
          ><template v-else
            ><label class="option"
              ><input
                v-model="agreed"
                type="checkbox"
              />我已了解计时、截止与成绩规则</label
            ><button
              class="button"
              :disabled="student.creating"
              @click="start('quiz')"
            >
              {{ student.creating ? "正在创建…" : "开始测验" }}
            </button></template
          ><button
            v-if="demo.fault === 'offline'"
            class="button secondary"
            @click="demo.fault = 'normal'"
          >
            恢复连接（演示）</button
          ><RouterLink class="button ghost" to="/student/practice"
            >返回练测入口</RouterLink
          >
        </section></template
      >
    </template>
    <template v-else-if="page === 'S09'">
      <header class="page-header">
        <div>
          <p class="eyebrow">GROWTH · 学情与建议</p>
          <h1 tabindex="-1">看见积累，找到下一步。</h1>
          <p class="muted">本次演示 · 已公开的原创数学作答 · 非正式能力诊断</p>
        </div>
        <RouterLink
          v-if="getSubmission(String(route.query.from))"
          class="button ghost"
          :to="`/student/submissions/${route.query.from}`"
          >返回本次结果</RouterLink
        >
      </header>
      <div v-if="demo.fault === 'stale'" class="notice warning">
        <strong>报告更新中，当前数据不包含最新发布结果</strong>
        <p>下方仅展示旧证据；不要把旧报告视作最新作答的评价。</p>
        <button class="button secondary" @click="refreshReport">
          更新报告（演示）
        </button>
      </div>
      <section v-if="!evidence.length" class="empty-state">
        <span class="tag">待诊断</span>
        <h2>先了解你的起点，不急着下结论。</h2>
        <p>
          当前没有可公开使用的作答证据，不能推断为 0%
          掌握。待发布、待复核或批改失败的记录不会计入。
        </p>
        <RouterLink
          class="button"
          :to="`/student/practice?chapter=${defaultChapterId}&from=growth`"
          >先做诊断练习</RouterLink
        >
      </section>
      <template v-else
        ><section class="panel stack">
          <h2>已公开的作答证据</h2>
          <p>
            <strong>{{ evidence.length }}</strong> 次题目作答 ·
            {{ correctCount }} 次答对 · 本次示例作答正确率
            {{ Math.round((correctCount / evidence.length) * 100) }}%
          </p>
          <p class="muted">
            生成时间：{{
              student.reportUpdated
                ? new Date(student.reportUpdated).toLocaleString()
                : "尚未生成"
            }}。包含重练，不能当作独立能力样本；正确率不是掌握度。
          </p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>知识点</th>
                  <th>作答证据</th>
                  <th>答对</th>
                  <th>建议</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in knowledgeRows" :key="row.name">
                  <td>{{ row.name }}</td>
                  <td>{{ row.total }} 次</td>
                  <td>{{ row.right }} 次</td>
                  <td>
                    {{
                      row.right === row.total
                        ? "保持练习，扩大证据"
                        : "回顾概念，再做基础题"
                    }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <section
          v-for="row in knowledgeRows"
          :key="row.name"
          class="panel stack"
        >
          <span class="eyebrow">建议 · 可以跳过</span>
          <h2>
            {{ row.name }}：{{
              row.right === row.total ? "继续巩固" : "回到概念，再走一步"
            }}
          </h2>
          <p>
            依据：公开作答 {{ row.total }} 次，其中
            {{
              row.total - row.right
            }}
            次未答对。建议先回顾章节，再用新的练习检验理解。
          </p>
          <div v-if="row.chapter" class="actions">
            <RouterLink
              class="button"
              :to="`/student/chapters/${row.chapter.id}?from=growth`"
              >回顾章节</RouterLink
            ><RouterLink
              class="button secondary"
              :to="`/student/practice?chapter=${row.chapter.id}&seen=1&from=growth`"
              >针对练习</RouterLink
            >
          </div>
          <div v-else class="notice warning">
            原建议章节已不可用，请重新选择已授权教材。<RouterLink
              to="/student/textbooks"
              >选择教材</RouterLink
            >
          </div>
        </section></template
      ><RouterLink class="button ghost" to="/student/textbooks"
        >自主选择教材</RouterLink
      >
    </template>
    <template v-else-if="page === 'S10'">
      <header class="page-header">
        <div>
          <p class="eyebrow">REVIEW · 我的错题</p>
          <h1 tabindex="-1">回头看一眼，是为了走得更稳。</h1>
          <p class="muted">
            仅包含已公开的示例结果，重练不会修改原成绩与题目版本。
          </p>
        </div>
      </header>
      <div class="panel form-grid">
        <label class="field"
          >知识点筛选<input
            v-model="student.filters.mistake"
            type="search"
            placeholder="输入知识点" /></label
        ><label class="field"
          >来源<select v-model="student.filters.mode">
            <option value="">全部来源</option>
            <option value="practice">自主练习</option>
            <option value="quiz">测验</option>
          </select></label
        ><label class="field"
          >时间<select v-model="student.filters.period">
            <option value="all">本次演示全部记录</option>
            <option value="today">最近 24 小时</option>
          </select></label
        >
      </div>
      <section v-if="!mistakeList.length" class="empty-state">
        <h2>
          {{ mistakes().length ? "没有符合筛选的错题" : "当前没有可回顾错题" }}
        </h2>
        <p>这不代表全部掌握，可以继续章节学习或调整筛选。</p>
        <RouterLink class="button" to="/student/textbooks"
          >继续章节学习</RouterLink
        ><button
          v-if="mistakes().length"
          class="button secondary"
          @click="
            student.filters.mistake = '';
            student.filters.mode = '';
            student.filters.period = 'all';
          "
        >
          清空错题筛选
        </button>
      </section>
      <article
        v-for="item in mistakeList"
        :key="`${item.submission.id}-${item.question.id}`"
        class="panel stack"
      >
        <div class="section-heading">
          <span class="tag"
            >{{ item.question.knowledge }} · v{{ item.question.version }}</span
          ><span class="muted"
            >{{ item.submission.mode === "quiz" ? "测验" : "练习" }} ·
            {{ new Date(item.submission.createdAt).toLocaleString() }}</span
          >
        </div>
        <h2 class="formula">{{ item.question.prompt }}</h2>
        <details>
          <summary>展开我的作答与解析</summary>
          <p>
            我的答案：{{ item.answer || "未答" }} · 参考答案：{{
              item.correctAnswer
            }}
          </p>
          <p>{{ item.explanation }}</p>
        </details>
        <div class="actions">
          <RouterLink
            class="button"
            :to="`/student/practice?chapter=${item.submission.chapterId}&seen=1&from=mistakes`"
            >同类练习（新记录）</RouterLink
          ><RouterLink
            class="button secondary"
            :to="`/student/chapters/${item.submission.chapterId}?from=mistakes`"
            >回到教材</RouterLink
          ><RouterLink
            class="button ghost"
            :to="`/student/submissions/${item.submission.id}`"
            >查看原结果</RouterLink
          >
        </div>
      </article>
    </template>
  </div>
</template>
<style scoped>
.welcome {
  display: flex;
  justify-content: space-between;
  gap: 2rem;
  background: linear-gradient(110deg, #edf3e8, #f7f8f1);
  padding: 2.4rem;
}
.welcome h2 {
  font-size: 1.7rem;
  max-width: 28rem;
}
.step-art {
  display: flex;
  align-items: end;
  gap: 0.5rem;
  min-width: 180px;
  padding-top: 1rem;
}
.step-art span {
  display: flex;
  flex-direction: column;
  justify-content: center;
  text-align: center;
  width: 65px;
  background: #d1dfc6;
  border-radius: 12px 12px 0 0;
  height: 90px;
  font-size: 1.5rem;
  color: #356047;
}
.step-art span:nth-child(2) {
  height: 130px;
  background: #bbd4b5;
}
.step-art span:nth-child(3) {
  height: 170px;
  background: #91b599;
}
.step-art small {
  font-size: 0.75rem;
}
.chapter-number {
  display: inline-block;
  margin-right: 1.2rem;
  color: #7c8d7d;
  font-size: 1.2rem;
}
.reading-layout {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr) 200px;
  gap: 1rem;
  align-items: start;
}
.reading-paragraph {
  white-space: pre-wrap;
  line-height: 2.1;
}
.difficulty-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
}
.difficulty-grid small {
  display: block;
  font-size: 0.75rem;
  margin-top: 0.4rem;
}
.option:has(input:checked) {
  background: #edf6f0;
  border-color: #287a63;
}
fieldset {
  border: 0;
  padding: 0;
  margin: 0;
}
legend {
  font-weight: 650;
  margin-bottom: 0.7rem;
}
.quiz-facts > div {
  display: grid;
  grid-template-columns: 130px 1fr;
  gap: 1rem;
  padding: 1rem 0;
  border-bottom: 1px solid #e4e7df;
}
.quiz-facts dt {
  font-weight: 650;
}
.quiz-facts dd {
  margin: 0;
}
.list-row {
  color: inherit;
  text-decoration: none;
}
details summary {
  cursor: pointer;
  font-weight: 600;
}
.reading-layout nav a[aria-current="page"] {
  font-weight: 700;
  color: #246e56;
}
@media (max-width: 1000px) {
  .reading-layout {
    grid-template-columns: 1fr;
  }
  .reading-layout > aside {
    order: 0;
  }
  .reading-layout > article {
    order: 1;
  }
  .reading-layout > aside:last-child {
    order: 2;
  }
}
@media (max-width: 640px) {
  .welcome {
    padding: 1.5rem;
  }
  .step-art {
    display: none;
  }
  .difficulty-grid {
    grid-template-columns: 1fr;
  }
  .quiz-facts > div {
    grid-template-columns: 1fr;
    gap: 0.3rem;
  }
  .page-header h1 {
    font-size: 1.7rem;
  }
}
</style>
