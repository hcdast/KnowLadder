<script setup lang="ts">
import { computed, ref } from "vue";
import { learningFields, learningStages } from "./lifelong";
import SiteImage from "./SiteImage.vue";
import { sceneMedia } from "./media";
const emit = defineEmits<{ enter: [event: MouseEvent, target: string] }>();
const selected = ref<string>("all");
const stages = computed(() =>
  learningStages.filter(
    (stage) => selected.value === "all" || stage.id === selected.value,
  ),
);
</script>

<template>
  <section class="lifelong-explore" aria-labelledby="lifelong-heading">
    <p class="eyebrow">从好奇出发，让学习伴随一生</p>
    <h2 id="lifelong-heading">找到此刻适合你的学习方向</h2>
    <p>
      年龄、身份和学习目标会变化。你可以跨阶段探索，选择方向无需提供出生日期。
    </p>
    <div class="stage-filters" role="group" aria-label="探索学习阶段">
      <button :aria-pressed="selected === 'all'" @click="selected = 'all'">
        全部阶段
      </button>
      <button
        v-for="stage in learningStages"
        :key="stage.id"
        :aria-pressed="selected === stage.id"
        @click="selected = stage.id"
      >
        {{ stage.name }}
      </button>
    </div>
    <div class="stage-grid" aria-live="polite">
      <article v-for="stage in stages" :key="stage.id">
        <figure class="stage-picture">
          <SiteImage
            :src="sceneMedia[stage.id]!.src"
            :alt="sceneMedia[stage.id]!.alt"
          />
          <figcaption>AI 场景示意</figcaption>
        </figure>
        <h3>{{ stage.name }}</h3>
        <p>{{ stage.description }}</p>
        <p class="stage-activities">{{ stage.activities }}</p>
        <small>{{ stage.support }}</small>
      </article>
    </div>
    <h3>跨阶段的学习领域</h3>
    <ul class="field-grid">
      <li v-for="field in learningFields" :key="field.name">
        <strong>{{ field.name }}</strong
        ><span>{{ field.examples }}</span>
      </li>
    </ul>
    <p class="scope-note">
      这些方向供你探索。登录后可查看当前可学资源；课程与家庭支持等服务按实际开放范围提供。
    </p>
    <div class="context-grid">
      <article>
        <h3>为自己学习</h3>
        <p>
          从原创微课程开始，按单元阅读、练习与实践，保存回顾并继续学习。个人空间按环境开放，不依赖组织成员身份。
        </p>
        <a
          href="/personal?tab=courses"
          @click="emit('enter', $event, '/personal?tab=courses')"
          >浏览个人原创课程 →</a
        ><br /><a href="/personal" @click="emit('enter', $event, '/personal')"
          >进入个人学习空间 →</a
        ><br /><a
          href="/training?tab=discover"
          @click="emit('enter', $event, '/training?tab=discover')"
          >发现我的可学资源 →</a
        >
      </article>
      <article>
        <h3>陪伴孩子与家人</h3>
        <p>
          共同阅读、讨论和实践也是学习。支持关系只读取明确分享的记录；监护需机构独立核验，有期限并可撤回，按环境准入开放。
        </p>
        <a href="/personal" @click="emit('enter', $event, '/personal')"
          >管理家庭与学习支持 →</a
        >
      </article>
      <article>
        <h3>支持教学与组织学习</h3>
        <p>
          教师、学校、机构、企业和社区围绕学习目标提供内容、活动与反馈，按现行权限使用工作区。
        </p>
        <a href="/home" @click="emit('enter', $event, '/home')"
          >进入授权工作区 →</a
        >
      </article>
    </div>
  </section>
</template>

<style scoped>
.lifelong-explore {
  padding: 2rem 0;
  color: #172d43;
}
h2 {
  font-size: clamp(1.6rem, 3vw, 2.3rem);
  margin: 0.5rem 0 1rem;
}
p {
  line-height: 1.8;
}
.stage-picture {
  margin: -1.2rem -1.2rem 1rem;
  border-radius: 12px 12px 0 0;
  overflow: hidden;
}
.stage-picture figcaption {
  padding: 0.3rem 1rem;
  font-size: 0.75rem;
  color: #536b7d;
}
.stage-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  margin: 1.4rem 0;
}
.stage-filters button {
  padding: 0.65rem 1rem;
  min-height: 44px;
  border: 1px solid #bbcddd;
  border-radius: 24px;
  background: white;
  color: #263e56;
  cursor: pointer;
  font: inherit;
}
.stage-filters button[aria-pressed="true"] {
  background: #1263b0;
  color: white;
  border-color: #1263b0;
}
.stage-filters button:focus-visible,
a:focus-visible {
  outline: 3px solid #1263b0;
  outline-offset: 3px;
}
.stage-grid,
.context-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1rem;
  margin-bottom: 1.8rem;
}
article {
  padding: 1.2rem;
  border: 1px solid #d2dfe9;
  border-radius: 14px;
  background: #f8fbfe;
  overflow-wrap: anywhere;
}
article h3 {
  margin: 0 0 0.7rem;
  font-size: 1.15rem;
}
.stage-activities {
  color: #314c67;
}
small {
  color: #445b70;
}
.field-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1rem;
  list-style: none;
  padding: 0;
}
.field-grid li {
  display: grid;
  gap: 0.5rem;
  padding: 1rem;
  background: #f3f7fa;
  border-radius: 10px;
}
.field-grid span {
  color: #445b70;
  line-height: 1.6;
}
.scope-note {
  padding: 1rem;
  border-left: 3px solid #1263b0;
  background: #edf5fc;
}
a {
  color: #145d9b;
  line-height: 1.8;
}
@media (max-width: 760px) {
  .stage-grid,
  .context-grid,
  .field-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 480px) {
  .stage-grid,
  .context-grid,
  .field-grid {
    grid-template-columns: 1fr;
  }
}
</style>
