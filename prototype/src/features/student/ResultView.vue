<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
import {
  getSubmission,
  recoverResult,
  resultDetails,
} from "../../services/student-service";
import { wait } from "../../services/core";
const route = useRoute(),
  busy = ref(false),
  notice = ref("");
const submission = computed(() =>
  getSubmission(String(route.params.submissionId)),
);
const details = computed(() =>
  submission.value ? resultDetails(submission.value.id) : [],
);
const right = computed(() => details.value.filter((q) => q.correct).length);
const labels = {
  pending: "已提交，正在示例批改",
  completed: "每一次练习，都有新的发现",
  unreleased: "已受理 · 成绩待发布",
  failed: "批改暂未完成",
  review: "已受理 · 等待复核",
};
async function refresh() {
  if (busy.value) return;
  busy.value = true;
  await wait(350);
  notice.value =
    submission.value?.state === "pending"
      ? "仍在处理中，请稍后手动刷新。"
      : "已获取当前状态，不会重新提交答案。";
  busy.value = false;
}
async function recover() {
  if (!submission.value || busy.value) return;
  busy.value = true;
  await recoverResult(submission.value.id);
  busy.value = false;
}
</script>
<template>
  <section v-if="!submission" class="empty-state">
    <h1 tabindex="-1">此演示记录不存在</h1>
    <p>刷新后内存记录已重置，或当前链接不属于本次演示。</p>
    <RouterLink class="button" to="/student">返回学生首页</RouterLink>
  </section>
  <div v-else class="stack">
    <header class="page-header">
      <div>
        <p class="eyebrow">RESULT · 提交与结果</p>
        <h1 tabindex="-1">{{ labels[submission.state] }}</h1>
        <p class="muted">
          {{ submission.mode === "quiz" ? "测验" : "练习" }} · 受理于
          {{ new Date(submission.createdAt).toLocaleString() }} · 原创示例批改
        </p>
      </div>
      <span class="tag">已受理</span>
    </header>
    <div v-if="submission.deadline" class="notice warning">
      本次为截止提交，只包含截止前已确认保存的答案；未保存的本地补答未计入成绩。
    </div>
    <section v-if="submission.state !== 'completed'" class="panel stack">
      <h2>{{ labels[submission.state] }}</h2>
      <p v-if="submission.state === 'pending'">
        本次答案已冻结，正在演示异步批改。无需再次交卷。
      </p>
      <p v-else-if="submission.state === 'unreleased'">
        成绩尚未公开。本页、学情及错题均不提供本次分数、正确答案或解析。
      </p>
      <p v-else-if="submission.state === 'failed'">
        示例批改发生故障，原提交仍被保留。恢复批改不会新建成绩，也不需要重新作答。
      </p>
      <p v-else>等待示例复核完成；在此之前不将本次记录用作学情证据。</p>
      <div class="actions">
        <button class="button secondary" :disabled="busy" @click="refresh">
          {{ busy ? "正在查询…" : "刷新状态" }}</button
        ><button
          v-if="submission.state !== 'pending'"
          class="button"
          :disabled="busy"
          @click="recover"
        >
          {{
            submission.state === "unreleased"
              ? "模拟发布成绩"
              : submission.state === "failed"
                ? "恢复批改（演示）"
                : "完成复核（演示）"
          }}</button
        ><RouterLink class="button ghost" to="/student">返回首页</RouterLink>
      </div>
      <p role="status">{{ notice }}</p>
    </section>
    <template v-else>
      <section class="panel result-summary">
        <div>
          <span class="eyebrow">本次作答正确率</span>
          <p class="score">
            {{ details.length ? Math.round((right / details.length) * 100) : 0
            }}<small>%</small>
          </p>
          <p>
            {{ right }} / {{ details.length }} 题答对 · 按实际示例作答逐题计算
          </p>
        </div>
        <div>
          <h2>
            {{
              right === details.length
                ? "这次练习，完成得很扎实"
                : "找到下一步，就是进步"
            }}
          </h2>
          <p>
            这只说明本次
            {{
              details.length
            }}
            题的作答表现，不等于知识点掌握度。重练会生成新的记录，不覆盖本次结果。
          </p>
          <div class="actions">
            <RouterLink
              class="button"
              :to="`/student/growth?from=${submission.id}`"
              >查看学情与建议</RouterLink
            ><RouterLink
              class="button secondary"
              :to="`/student/practice?chapter=${submission.chapterId}&seen=1&from=${submission.id}`"
              >针对练习</RouterLink
            >
          </div>
        </div>
      </section>
      <section class="stack">
        <div class="section-heading">
          <h2>逐题回顾</h2>
          <span class="muted">冻结题目版本 · 示例解析</span>
        </div>
        <article
          v-for="(item, index) in details"
          :key="item.question.id"
          class="panel stack"
        >
          <div class="section-heading">
            <h3>第 {{ index + 1 }} 题</h3>
            <span class="tag">{{
              item.correct ? "答对" : item.answer ? "待巩固" : "未作答"
            }}</span>
          </div>
          <p class="formula">{{ item.question.prompt }}</p>
          <ul v-if="item.question.options.length">
            <li v-for="(option, i) in item.question.options" :key="i">
              {{ String.fromCharCode(65 + i) }}. {{ option }}
            </li>
          </ul>
          <p>
            你的答案：<strong>{{ item.answer || "未答" }}</strong
            >　参考答案：<strong>{{ item.correctAnswer }}</strong>
          </p>
          <p class="notice">{{ item.explanation }}</p>
          <small class="muted"
            >题目 v{{ item.question.version }} ·
            {{ item.question.knowledge }}</small
          >
        </article>
      </section>
      <div class="actions">
        <RouterLink
          class="button secondary"
          :to="`/student/chapters/${submission.chapterId}?from=${submission.id}`"
          >回到教材</RouterLink
        ><RouterLink class="button secondary" to="/student/mistakes"
          >回顾错题</RouterLink
        ><RouterLink class="button ghost" to="/student">返回首页</RouterLink>
      </div>
    </template>
  </div>
</template>
<style scoped>
.result-summary {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 2rem;
  align-items: center;
}
.score {
  font-size: 4rem;
  font-weight: 750;
  line-height: 1.2;
  color: #276957;
  margin: 0.7rem 0;
}
.score small {
  font-size: 1.3rem;
}
@media (max-width: 640px) {
  .result-summary {
    grid-template-columns: 1fr;
    gap: 0.6rem;
  }
}
</style>
