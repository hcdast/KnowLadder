<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
const route = useRoute();
const pageHeading = ref<HTMLElement>();
watch(() => route.path, async () => {await nextTick();pageHeading.value?.focus();});
const pages: Record<
  string,
  {
    title: string;
    subtitle: string;
    items: { title: string; body: string; tag: string }[];
  }
> = {
  "/features": {
    title: "从课程到反馈，让培训形成闭环",
    subtitle: "围绕真实教学流程组织功能，帮助教师看见进度，帮助学员完成目标。",
    items: [
      {
        title: "组织与班级",
        body: "成员权限、授课关系与班级管理，按当前组织隔离数据。",
        tag: "已有能力",
      },
      {
        title: "课程与学习",
        body: "版本审核、班级分配与课节完成确认。当前本地版本优先支持文本课程。",
        tag: "本地实现",
      },
      {
        title: "作业与评估",
        body: "任务截止、作业重交、评分维度与教师反馈；考试沿用现有评估服务。",
        tag: "本地实现",
      },
    ],
  },
  "/ai-teaching": {
    title: "AI 融入教学，教师掌握决定权",
    subtitle: "基于授权资料提供建议，让每一次生成都有来源、边界和审核。",
    items: [
      {
        title: "学习助教",
        body: "从已分配课程资料中回答问题，展示引用；不读取考试答案。",
        tag: "配置后启用",
      },
      {
        title: "教师备课与题目建议",
        body: "围绕课程资料生成草稿，供教师修改和审核。模型结果不会自动发布。",
        tag: "配置后启用",
      },
      {
        title: "培训报告建议",
        body: "根据班级任务汇总生成建议，避免发送学员个人身份资料。",
        tag: "配置后启用",
      },
    ],
  },
  "/solutions": {
    title: "为持续学习的组织设计",
    subtitle: "当前先完成成人职业培训的本地闭环，再逐步拓展更多场景。",
    items: [
      {
        title: "成人职业培训",
        body: "知识课程、实践作业、教师点评，形成可跟踪的学习路径。",
        tag: "当前场景",
      },
      {
        title: "企业内部培训",
        body: "复用组织与权限体系；岗位路径、证书与多组织运营列入后续计划。",
        tag: "规划中",
      },
      {
        title: "学校教学",
        body: "已有练测与学习报告基础，未成年人场景需另行完成隐私准入。",
        tag: "待准入",
      },
    ],
  },
  "/help": {
    title: "开始使用知阶",
    subtitle: "用清晰的步骤，完成第一次学习或授课。",
    items: [
      {
        title: "获取账号",
        body: "由组织管理员开通账号。首次登录按提示修改临时密码。",
        tag: "01",
      },
      {
        title: "进入组织",
        body: "选择所属组织，在工作区查看已获得授权的功能。",
        tag: "02",
      },
      {
        title: "开始培训",
        body: "学员打开课程与任务，教师创建草稿并交由独立审核人发布。",
        tag: "03",
      },
    ],
  },
  "/about": {
    title: "让学习有方向，让成长有依据",
    subtitle: "知阶 KnowLadder 致力于将教学内容、学习过程与反馈连接起来。",
    items: [
      {
        title: "尊重教学判断",
        body: "AI 提供建议，教师审核内容，培训结果以真实记录为依据。",
        tag: "教学",
      },
      {
        title: "清晰的数据边界",
        body: "组织隔离、最小授权、可追溯操作，保障协作边界。",
        tag: "信任",
      },
      {
        title: "诚实的能力说明",
        body: "区分已具备、本地验证、配置后启用与后续规划，不展示虚构客户案例。",
        tag: "透明",
      },
    ],
  },
  "/contact": {
    title: "一起规划适合你的培训系统",
    subtitle: "咨询服务需由组织配置处理负责人和信息保留期限后开放。",
    items: [],
  },
};
const page = computed(() => pages[route.path]);
const published = ref<{ title: string; body: string } | null>(null),
  consultation = ref(false),
  message = ref(""),
  busy = ref(false),
  name = ref(""),
  contact = ref(""),
  kind = ref("enterprise"),
  consent = ref(false),
  receipt = ref(""),
  received = ref(false),
  retentionDays = ref<number | null>(null);
let generation = 0;
watch(
  () => route.path,
  async (path) => {
    const token = ++generation;
    published.value = null;
    consultation.value = false;
    message.value = "";
    try {
      const res = await fetch(
        "/api/v1/site/pages/" + (path === "/" ? "home" : path.slice(1)),
        { credentials: "omit" },
      );
      if (res.ok) {
        const data = (await res.json()).data;
        if (token === generation) {
          published.value = data.page;
          consultation.value = data.consultation_enabled;
          retentionDays.value = data.retention_days;
        }
      }
    } catch {
      /* Static product information remains available without pretending a service write succeeded. */
    }
  },
  { immediate: true },
);
async function submit() {
  if (busy.value || received.value) return;
  busy.value = true;
  message.value = "";
  if (!receipt.value) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    receipt.value = Array.from(bytes, (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  }
  try {
    const r = await fetch("/api/v1/site/consultations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        receipt: receipt.value,
        contact: contact.value,
        name: name.value,
        kind: kind.value,
        consent: consent.value,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || "提交失败");
    message.value = "咨询已收到，请保存回执编号以查询处理状态。";
    received.value = true;
    contact.value = "";
    name.value = "";
  } catch (e) {
    message.value =
      e instanceof Error ? e.message : "结果待确认，请保留回执编号后查询。";
  } finally {
    busy.value = false;
  }
}
async function query() {
  if (!receipt.value) return;
  busy.value = true;
  try {
    const r = await fetch("/api/v1/site/consultations/" + receipt.value, {
      credentials: "omit",
    });
    const d = await r.json();
    message.value = r.ok
      ? (
          { new: "已收到", contacted: "已联系", closed: "已结束" } as Record<
            string,
            string
          >
        )[d.data.status] || d.data.status
      : d.error?.message || "查询失败";
  } catch {
    message.value = "连接失败，请稍后查询。";
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="public-site">
    <header class="public-header">
      <RouterLink class="public-brand" to="/"
        ><img class="brand-mark" src="/visuals/logo.svg" alt="" width="40" height="40" />知阶<span>KnowLadder</span></RouterLink
      >
      <nav aria-label="网站导航">
        <RouterLink to="/features">产品功能</RouterLink
        ><RouterLink to="/ai-teaching">AI 教学</RouterLink
        ><RouterLink to="/solutions">解决方案</RouterLink
        ><RouterLink to="/help">使用帮助</RouterLink>
      </nav>
      <RouterLink class="public-login" to="/login">进入工作区 ↗</RouterLink>
    </header>
    <main id="main-content" tabindex="-1">
      <template v-if="route.path === '/'">
        <section class="public-hero">
          <div>
            <p class="eyebrow">AI × 教学 × 持续成长</p>
            <h1 ref="pageHeading" tabindex="-1">让知识成为能力，<br />让成长<span>步步可见。</span></h1>
            <p class="hero-copy">
              连接课程、实践与反馈的教学培训平台。<br />让 AI
              辅助学习，让教师专注于真正有价值的指导。
            </p>
            <div class="hero-actions">
              <RouterLink class="public-primary" to="/login"
                >进入学习工作区 <span>→</span></RouterLink
              ><RouterLink class="public-secondary" to="/features"
                >了解产品</RouterLink
              >
            </div>
            <p class="hero-note">当前开放本地验证版本 · AI 需配置后启用</p>
          </div>
          <div class="journey-visual" aria-label="课程、实践和反馈形成学习路径">
            <img class="learning-path-art" src="/visuals/learning-path.svg" width="800" height="420" alt="从书页到练习再到完成确认的阶梯学习路径" decoding="async" />
            <div class="visual-top">
              <span>你的成长路径</span
              ><span class="visual-label">教学流程示意</span>
            </div>
            <div class="path-step">
              <span>01</span>
              <div>
                <strong>理解知识</strong>
                <p>学习课程 · 确认课节完成</p>
              </div>
              <b>↗</b>
            </div>
            <div class="path-step">
              <span>02</span>
              <div>
                <strong>投入实践</strong>
                <p>完成任务 · 提交实践作业</p>
              </div>
              <b>↗</b>
            </div>
            <div class="path-step accent">
              <span>03</span>
              <div>
                <strong>获得反馈</strong>
                <p>教师点评 · 调整学习方向</p>
              </div>
              <b>✦</b>
            </div>
            <p class="visual-foot">AI 提供建议，教师审核与发布。</p>
          </div>
        </section>
        <section class="public-section">
          <p class="eyebrow">一条完整的学习链路</p>
          <h2>把教学的每一个环节连接起来</h2>
          <div class="feature-grid">
            <article>
              <span class="feature-num">01 / CONTENT</span>
              <h3>课程有结构</h3>
              <p>
                管理课程版本与课节，经独立审核后分配给班级，保持教学资料一致。
              </p>
              <RouterLink to="/features">查看课程能力 →</RouterLink>
            </article>
            <article>
              <span class="feature-num">02 / PRACTICE</span>
              <h3>学习有行动</h3>
              <p>从班级任务到实践作业，明确截止时间，记录提交与重交过程。</p>
              <RouterLink to="/features">查看培训闭环 →</RouterLink>
            </article>
            <article>
              <span class="feature-num">03 / INTELLIGENCE</span>
              <h3>指导有帮助</h3>
              <p>
                在授权资料范围内生成教学建议，保留来源，让 AI
                成为教师与学员的助手。
              </p>
              <RouterLink to="/ai-teaching">了解 AI 教学 →</RouterLink>
            </article>
          </div>
        </section>
        <section class="public-band">
          <div>
            <p class="eyebrow">以真实记录支持持续改进</p>
            <h2>从“学过”走向“用过”，<br />再走向更好的下一次。</h2>
            <p>
              课节完成、作业反馈与知识掌握分开呈现，帮助你正确理解培训结果。
            </p>
          </div>
          <RouterLink class="public-primary" to="/solutions"
            >找到适用场景 →</RouterLink
          >
        </section>
      </template>
      <template v-else-if="page"
        ><section class="subpage-hero">
          <p class="eyebrow">KNOWLADDER / 知阶</p>
          <h1 ref="pageHeading" tabindex="-1">{{ page.title }}</h1>
          <p>{{ page.subtitle }}</p>
        </section>
        <section v-if="page.items.length" class="public-section feature-grid">
          <article v-for="item in page.items" :key="item.title">
            <span class="page-tag">{{ item.tag }}</span>
            <h2>{{ item.title }}</h2>
            <p>{{ item.body }}</p>
          </article>
        </section>
        <section v-if="route.path === '/contact'" class="public-section">
          <form
            v-if="consultation"
            class="contact-form"
            @submit.prevent="submit"
          >
            <label>你的称呼<input v-model="name" maxlength="80" /></label
            ><label
              >联系电话或邮箱<input
                v-model="contact"
                required
                maxlength="200" /></label
            ><label
              >咨询类型<select v-model="kind">
                <option value="enterprise">企业培训</option>
                <option value="school">学校教学</option>
                <option value="other">其他场景</option>
              </select></label
            ><label class="consent"
              ><input
                v-model="consent"
                type="checkbox"
                required
              />同意将上述信息用于本次咨询联系，保留
              {{ retentionDays }} 天后删除。</label
            ><button class="public-primary" :disabled="busy || received">
              {{ busy ? "正在提交…" : "提交咨询" }}
            </button>
          </form>
          <p v-else>
            咨询表单尚未开放。已有账号可直接进入工作区，或联系你的组织管理员。
          </p>
          <button
            v-if="received"
            type="button"
            class="public-secondary"
            @click="
              receipt = '';
              received = false;
              consent = false;
              message = '';
            "
          >
            发起新的咨询
          </button>
          <div class="receipt-query">
            <label
              >咨询回执编号<input
                v-model="receipt"
                pattern="[a-f0-9]{64}"
                maxlength="64" /></label
            ><button
              class="public-secondary"
              :disabled="busy || !receipt"
              @click="query"
            >
              查询处理状态
            </button>
          </div>
          <p role="status">{{ message }}</p>
        </section>
      </template>
      <section v-if="published" class="public-section published-note">
        <h2>{{ published.title }}</h2>
        <p>{{ published.body }}</p>
      </section>
    </main>
    <footer class="public-footer">
      <div>
        <RouterLink class="public-brand" to="/"
          ><img class="brand-mark" src="/visuals/logo.svg" alt="" width="40" height="40" />知阶<span>KnowLadder</span></RouterLink
        >
        <p>每一步学习，都有方向。</p>
      </div>
      <nav aria-label="页脚导航">
        <RouterLink to="/about">关于知阶</RouterLink
        ><RouterLink to="/help">使用帮助</RouterLink
        ><RouterLink to="/contact">联系咨询</RouterLink
        ><RouterLink to="/login">工作区登录</RouterLink>
      </nav>
      <p class="footer-note">本地验证版本 · 具体功能以工作区授权与配置为准</p>
    </footer>
  </div>
</template>
<style scoped>
.public-site {
  min-height: 100vh;
  min-height: 100svh;
  display: flex;
  flex-direction: column;
  background: #f3f8fa;
  color: #172a3a;
  font-family: Inter, "Microsoft YaHei", sans-serif;
}
.public-site > main {
  flex: 1;
}
.learning-path-art { display: block; width: 100%; height: auto; border-radius: 1rem; margin-bottom: 1rem; }
.public-header,
.public-footer {
  max-width: 1280px;
  width: 100%;
  margin: 0 auto;
  flex-shrink: 0;
  padding: 28px 48px;
  display: flex;
  align-items: center;
  gap: 40px;
}
.public-brand {
  font-size: 25px;
  font-weight: 750;
  letter-spacing: 2px;
  color: #193e31;
  text-decoration: none;
  display: flex;
  align-items: center;
  gap: 12px;
}
.public-brand span {
  font-size: 12px;
  letter-spacing: 0.5px;
}
.public-header nav {
  display: flex;
  gap: 28px;
  margin-left: auto;
}
.public-header nav a,
.public-footer nav a {
  color: #41584b;
  text-decoration: none;
  font-size: 14px;
}
.public-header .router-link-active {
  color: #13794b;
}
.public-login {
  background: #1d4635;
  color: white !important;
  padding: 12px 20px;
  border-radius: 8px;
  text-decoration: none;
  white-space: nowrap;
  font-size: 14px;
}
.public-hero {
  max-width: 1280px;
  margin: auto;
  display: grid;
  grid-template-columns: 1.15fr 1fr;
  gap: 70px;
  padding: 85px 48px 110px;
  align-items: center;
}
.eyebrow {
  font-size: 12px;
  letter-spacing: 2px;
  font-weight: 600;
  color: #267454;
}
.public-hero h1 {
  font-size: clamp(38px, 4.4vw, 64px);
  line-height: 1.35;
  letter-spacing: -2px;
  margin: 22px 0;
}
.public-hero h1 span {
  color: #267454;
}
.hero-copy {
  font-size: 17px;
  line-height: 1.9;
  color: #53685c;
}
.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 32px;
}
.public-primary,
.public-secondary {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  gap: 24px;
  border-radius: 8px;
  padding: 14px 22px;
  font-size: 14px;
  text-decoration: none;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid #d0d8cf;
}
.public-primary {
  background: #214c37;
  color: #fff;
  border-color: #214c37;
}
.public-secondary {
  background: transparent;
  color: #244b36;
}
.public-primary:hover {
  background: #326246;
}
.hero-note {
  font-size: 12px;
  color: #6e7d72;
  margin-top: 20px;
}
.journey-visual {
  background: #f0f2e9;
  border: 1px solid #dfe5d8;
  border-radius: 22px;
  padding: 30px;
  box-shadow: 0 24px 65px #19412712;
  transform: rotate(-2deg);
}
.visual-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 14px;
  margin-bottom: 28px;
}
.visual-label {
  font-size: 10px;
  color: #708068;
  border: 1px solid #cdd8c8;
  padding: 4px 8px;
  border-radius: 20px;
}
.path-step {
  background: #fff;
  border: 1px solid #e2e8df;
  border-radius: 12px;
  padding: 22px;
  display: flex;
  align-items: center;
  gap: 18px;
  margin-top: 14px;
}
.path-step > span {
  font-family: monospace;
  font-size: 23px;
  color: #7c967d;
}
.path-step strong {
  font-size: 18px;
}
.path-step p {
  font-size: 12px;
  color: #728071;
  margin: 9px 0 0;
}
.path-step b {
  margin-left: auto;
  color: #5b815e;
}
.path-step.accent {
  background: #244b36;
  color: #fff;
}
.accent p,
.accent b,
.accent > span {
  color: #cadbbc;
}
.visual-foot {
  font-size: 12px;
  color: #708068;
  margin-top: 25px;
}
.public-section {
  max-width: 1280px;
  margin: auto;
  padding: 70px 48px;
}
.public-section > h2 {
  font-size: 32px;
  margin: 18px 0 38px;
}
.feature-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 24px;
}
.feature-grid article {
  background: white;
  border: 1px solid #e1e6df;
  border-radius: 12px;
  padding: 32px;
}
.feature-grid h3,
.feature-grid h2 {
  font-size: 22px;
  margin: 24px 0 15px;
}
.feature-grid p {
  font-size: 14px;
  line-height: 1.9;
  color: #627265;
}
.feature-grid a {
  display: inline-block;
  margin-top: 20px;
  font-size: 13px;
  color: #267454;
  text-decoration: none;
}
.feature-num {
  font-size: 11px;
  letter-spacing: 1px;
  color: #7c947a;
}
.public-band {
  max-width: 1184px;
  margin: 50px auto 80px;
  background: #edf0e6;
  border-radius: 16px;
  padding: 55px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 40px;
}
.public-band h2 {
  font-size: 34px;
  line-height: 1.6;
}
.public-band p {
  color: #66775f;
  line-height: 1.8;
  font-size: 14px;
}
.public-footer {
  border-top: 1px solid #e0e6dc;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 20px 40px;
  padding-top: 32px;
  padding-bottom: 24px;
}
.public-footer p {
  font-size: 12px;
  color: #72816f;
}
.public-footer nav {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 24px;
  margin-left: auto;
}
.footer-note {
  grid-column: 1 / -1;
  text-align: center;
  margin: 0;
}
.subpage-hero {
  max-width: 1280px;
  margin: auto;
  padding: 80px 48px 25px;
}
.subpage-hero h1 {
  font-size: 42px;
  line-height: 1.5;
  max-width: 900px;
}
.subpage-hero > p:last-child {
  color: #627265;
  line-height: 1.9;
  max-width: 750px;
}
.page-tag {
  background: #edf4e9;
  color: #3d7950;
  font-size: 11px;
  border-radius: 20px;
  padding: 6px 10px;
}
.contact-form {
  max-width: 600px;
  display: grid;
  gap: 20px;
}
.contact-form label,
.receipt-query label {
  display: grid;
  gap: 8px;
  font-size: 14px;
}
.contact-form input,
.contact-form select,
.receipt-query input {
  background: white;
  border: 1px solid #ccd6ca;
  border-radius: 7px;
  padding: 12px;
  color: #244b36;
}
.contact-form .consent {
  display: flex;
  align-items: flex-start;
  line-height: 1.8;
}
.consent input {
  margin-top: 6px;
}
.receipt-query {
  margin-top: 38px;
  max-width: 600px;
  display: grid;
  gap: 12px;
}
.published-note p {
  white-space: pre-wrap;
  line-height: 1.9;
}
.public-site a:focus-visible,
.public-site button:focus-visible,
.public-site input:focus-visible,
.public-site select:focus-visible {
  outline: 3px solid #669c65;
  outline-offset: 4px;
}
@media (max-width: 900px) {
  .public-header {
    padding: 20px 24px;
    flex-wrap: wrap;
    gap: 20px;
  }
  .public-header nav {
    order: 3;
    width: 100%;
    justify-content: space-between;
    gap: 8px;
  }
  .public-login {
    margin-left: auto;
  }
  .public-hero {
    padding: 48px 24px 65px;
    grid-template-columns: 1fr;
    gap: 45px;
  }
  .journey-visual {
    transform: none;
  }
  .public-section {
    padding: 45px 24px;
  }
  .feature-grid {
    grid-template-columns: 1fr;
  }
  .public-band {
    margin: 24px;
    border-radius: 12px;
    padding: 28px;
    flex-direction: column;
    align-items: flex-start;
  }
  .public-band h2 {
    font-size: 26px;
  }
  .public-footer {
    padding: 28px 24px;
    grid-template-columns: minmax(0, 1fr);
    gap: 24px;
  }
  .public-footer nav {
    margin-left: 0;
    flex-wrap: wrap;
    justify-content: flex-start;
    gap: 12px 20px;
  }
  .subpage-hero {
    padding: 48px 24px 10px;
  }
  .subpage-hero h1 {
    font-size: 32px;
  }
  .public-brand {
    font-size: 22px;
  }
}
@media (max-width: 24rem) {
  .public-hero h1 {
    font-size: 32px;
    letter-spacing: -1px;
  }
}
</style>
