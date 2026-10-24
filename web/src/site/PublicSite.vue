<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import AccountMenu from "../components/AccountMenu.vue";
import ProductTour from "./ProductTour.vue";
import SiteImage from "./SiteImage.vue";
import { siteMedia, sceneMedia } from "./media";
import LifelongExplore from "./LifelongExplore.vue";
import { learningStages } from "./lifelong";
import type { LogoutResult } from "../session";
const props = defineProps<{
  pagePath?: string;
  userName?: string;
  busy?: boolean;
  logoutResult?: LogoutResult;
}>();
const emit = defineEmits<{ login: [target?: string]; logout: []; retry: [] }>();
const route = useRoute();
const sitePath = computed(() => props.pagePath || route.path);
function login(event: MouseEvent, target?: string) {
  if (
    event.button !== 0 ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  emit("login", target);
}
const selectedProduct = ref(0);
const unavailableImages = ref<Record<string, boolean>>({});
const products = [
  {
    label: "个人学习",
    title: "下一步学习，清晰可见",
    body: "从个人空间继续学习，查看自己的安排，按节奏积累理解。",
    image: siteMedia.personal,
    alt: "实际个人学习首页，示例数据",
  },
  {
    label: "课程实践",
    title: "读过之后，再动手试一试",
    body: "阅读原创课程，完成练习与实践，留下自己的学习回顾。",
    image: siteMedia.course,
    alt: "实际课程阅读与练习界面，示例数据",
  },
  {
    label: "笔记与复习",
    title: "让自己的理解，值得再回看",
    body: "保存学习笔记，查看真实复习历史，安排下一次回顾。",
    image: siteMedia.review,
    alt: "实际私人笔记与复习界面，示例数据",
  },
  {
    label: "教学协作",
    title: "把时间留给更有价值的指导",
    body: "组织课程与实践任务，通过已发布反馈支持持续改进。",
    image: siteMedia.teaching,
    alt: "实际教师任务与反馈界面，示例数据",
  },
];
function productKeys(event: KeyboardEvent) {
  let index = selectedProduct.value;
  if (event.key === "ArrowRight") index = (index + 1) % products.length;
  else if (event.key === "ArrowLeft")
    index = (index + products.length - 1) % products.length;
  else if (event.key === "Home") index = 0;
  else if (event.key === "End") index = products.length - 1;
  else return;
  event.preventDefault();
  selectedProduct.value = index;
  (event.currentTarget as HTMLElement)
    .querySelectorAll<HTMLButtonElement>("button")
    [index]?.focus();
}
const scenes = [
  {
    title: "家庭共读与观察",
    body: "从一个问题出发，在阅读与观察中发现新的理解。",
    image: sceneMedia.early!.src,
    alt: sceneMedia.early!.alt,
  },
  {
    title: "学校探究与实践",
    body: "在共同探索中提出问题，动手验证并记录发现。",
    image: sceneMedia.school!.src,
    alt: sceneMedia.school!.alt,
  },
  {
    title: "职业实践与成长",
    body: "把所学带进工作，围绕真实问题持续改进。",
    image: sceneMedia.career!.src,
    alt: sceneMedia.career!.alt,
  },
];
const pageVisual = computed(() => {
  if (sitePath.value === "/features")
    return {
      image: siteMedia.teaching,
      alt: "实际教师课程与反馈界面，示例数据",
      caption: "让课程、任务和反馈自然衔接",
      link: "/help",
      action: "查看上手步骤",
    };
  if (sitePath.value === "/ai-teaching")
    return {
      image: siteMedia.ai,
      alt: "授权资料、草稿与人工复核的流程示意",
      caption: "建议有来源，发布有审核",
      link: "/features",
      action: "查看产品功能",
    };
  if (sitePath.value === "/solutions")
    return {
      image: scenes[2]!.image,
      alt: scenes[2]!.alt,
      caption: "一起学习，让协作更有方向",
      link: "/contact",
      action: "了解咨询方式",
    };
  if (sitePath.value === "/help")
    return {
      image: products[0]!.image,
      alt: products[0]!.alt,
      caption: "统一登录，进入你的学习工作区",
      link: "/#tour",
      action: "观看界面导览",
    };
  if (sitePath.value === "/about")
    return {
      image: scenes[0]!.image,
      alt: scenes[0]!.alt,
      caption: "从每一次学习，走向新的成长",
      link: "/features",
      action: "探索产品",
    };
  return undefined;
});
const faqs = [
  {
    question: "学员、教师和管理员需要分别登录吗？",
    answer:
      "使用同一个登录入口。登录后，系统根据账号权限和所属组织展示可用工作区，无需提前选择角色。",
  },
  {
    question: "如何获取账号？",
    answer:
      "机构账号由组织管理员开通。个人注册开放时，登录界面会显示注册入口。首次使用临时密码登录后，按提示设置自己的密码。",
  },
  {
    question: "AI 生成的内容会直接发布吗？",
    answer:
      "不会。AI 需完成配置后启用，基于授权资料提供建议；生成内容由教师修改、审核，再按实际流程发布。",
  },
  {
    question: "支持哪些课程内容？",
    answer:
      "课程可包含文本与已启用的媒体内容。可用资源、上传和播放能力以组织配置及课程授权为准。",
  },
];
const pageHeading = ref<HTMLElement>();
watch(
  () => sitePath.value,
  async () => {
    await nextTick();
    pageHeading.value?.focus();
  },
);
const pages: Record<
  string,
  {
    title: string;
    subtitle: string;
    items: { title: string; body: string; tag: string }[];
  }
> = {
  "/features": {
    title: "连接内容、实践与反馈，支持持续学习",
    subtitle: "围绕真实教学流程组织功能，帮助教师看见进度，帮助学员完成目标。",
    items: [
      {
        title: "组织与班级",
        body: "成员权限、授课关系与班级管理，按当前组织隔离数据。",
        tag: "组织协作",
      },
      {
        title: "课程与学习",
        body: "课程版本审核、班级分配与课节完成确认，支持文本和已启用的媒体课节。",
        tag: "课程学习",
      },
      {
        title: "作业与评估",
        body: "任务截止、作业重交、评分维度与教师反馈；考试沿用现有评估服务。",
        tag: "实践与反馈",
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
    title: "让各阶段的学习，都有适合的支持",
    subtitle:
      "从启蒙成长到银龄学习，连接自主学习与家庭、学校、组织、社区支持。以下为场景方向，实际资源与功能按授权和准入开放。",
    items: learningStages.map((stage) => ({
      title: stage.name,
      body: stage.description + stage.activities + "。",
      tag: "学习场景",
    })),
  },
  "/help": {
    title: "开始使用知阶",
    subtitle: "用清晰的步骤，完成第一次学习或授课。",
    items: [
      {
        title: "获取账号",
        body: "使用管理员提供的账号或激活邀请；开放个人注册时可自主注册。首次登录按提示设置密码。",
        tag: "01",
      },
      {
        title: "进入组织",
        body: "系统按账号权限展示工作区，多组织账号可选择当前组织。",
        tag: "02",
      },
      {
        title: "开始学习或教学",
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
        body: "AI 提供建议，教师审核内容，学习反馈以真实记录为依据。",
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
    title: "一起规划适合你的学习支持",
    subtitle: "咨询服务需由组织配置处理负责人和信息保留期限后开放。",
    items: [],
  },
};
const page = computed(() => pages[sitePath.value]);
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
  () => sitePath.value,
  async (path) => {
    const token = ++generation;
    published.value = null;
    consultation.value = false;
    message.value = "";
    // Explore is a static direction guide; it is not an editable/published site page.
    if (path === "/explore") return;
    try {
      const res = await fetch(
        "/api/v1/site/pages/" + (path === "/" ? "home" : path.slice(1)),
        {
          credentials: "omit",
        },
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
        ><img
          class="brand-mark"
          src="/visuals/logo.svg"
          alt=""
          width="40"
          height="40"
        />知阶<span>KnowLadder</span></RouterLink
      >
      <nav aria-label="网站导航">
        <RouterLink to="/explore">探索学习</RouterLink>
        <RouterLink to="/features">产品功能</RouterLink
        ><RouterLink to="/ai-teaching">AI 教学</RouterLink
        ><RouterLink to="/solutions">解决方案</RouterLink
        ><RouterLink to="/help">使用帮助</RouterLink>
      </nav>
      <AccountMenu
        v-if="userName"
        :name="userName"
        :busy="busy"
        @logout="emit('logout')"
      />
      <a v-else class="public-login" href="/login" @click="login"
        >{{ busy ? "正在处理…" : "登录 / 进入工作区" }}
        <span aria-hidden="true">↗</span></a
      >
    </header>
    <main id="main-content" tabindex="-1">
      <div
        v-if="logoutResult && logoutResult !== 'none'"
        class="public-session-status"
        role="status"
      >
        {{
          logoutResult === "pending"
            ? "正在退出登录…"
            : logoutResult === "confirmed"
              ? "已退出登录。"
              : logoutResult === "connection-unavailable"
                ? "已退出登录，登录连接暂不可用。"
                : "退出结果尚未确认，请重新连接核对。"
        }}
        <button
          v-if="logoutResult === 'unconfirmed'"
          class="public-secondary"
          :disabled="busy"
          @click="emit('retry')"
        >
          重新连接
        </button>
        <button
          v-if="logoutResult === 'unconfirmed' && userName"
          class="public-secondary"
          :disabled="busy"
          @click="emit('logout')"
        >
          再次退出
        </button>
      </div>

      <template v-if="sitePath === '/'">
        <section class="public-hero">
          <div class="hero-text">
            <p class="eyebrow">
              <span class="eyebrow-dot"></span> AI 支持 · 全龄终身学习
            </p>
            <h1 ref="pageHeading" tabindex="-1">
              让知识成为能力，<br />让成长<span>步步可见。</span>
            </h1>
            <p class="hero-copy">
              从启蒙、学校与专业学习，到职业发展、兴趣生活与银龄学习。<br />连接知识、实践与反馈，让每个阶段的成长都有支持。
            </p>
            <div class="hero-actions">
              <a class="public-primary" href="/login" @click="login"
                >{{ userName ? "进入我的工作区" : "开始使用知阶" }}
                <span aria-hidden="true">→</span></a
              ><RouterLink class="public-secondary" to="/explore"
                >探索学习方向 →</RouterLink
              >
            </div>
            <div class="hero-benefits">
              <span>课程与任务</span><span>教师审核发布</span
              ><span>按组织授权</span>
            </div>
          </div>
          <figure class="hero-product">
            <SiteImage
              :src="siteMedia.hero"
              :mobile-src="siteMedia.heroMobile"
              alt="书页与浅木台阶连接成成长路径的品牌主视觉"
              :width="2400"
              :height="1500"
              priority
            />
            <figcaption>每一步，都算数。</figcaption>
          </figure>
        </section>
        <section class="public-section">
          <LifelongExplore @enter="login" />
        </section>
        <section class="workflow-strip" aria-label="教学闭环">
          <span>让教学环节自然相连</span>
          <ol>
            <li>课程学习</li>
            <li>实践任务</li>
            <li>教师反馈</li>
            <li>持续改进</li>
          </ol>
        </section>
        <section id="product" class="public-section product-section">
          <div class="section-heading">
            <div>
              <p class="eyebrow">一套平台，连接不同的教学角色</p>
              <h2>各有所需，协作有序。</h2>
            </div>
            <p>
              统一登录，按权限进入工作区。<br />清晰的流程，让学习和教学顺畅衔接。
            </p>
          </div>
          <div
            class="product-tabs"
            role="tablist"
            aria-label="产品界面"
            @keydown="productKeys"
          >
            <button
              v-for="(product, index) in products"
              :id="'product-tab-' + index"
              :key="product.label"
              role="tab"
              :aria-selected="selectedProduct === index"
              :aria-controls="'product-panel-' + index"
              :tabindex="selectedProduct === index ? 0 : -1"
              @click="selectedProduct = index"
            >
              {{ product.label }}
            </button>
          </div>
          <div
            v-for="(product, index) in products"
            v-show="selectedProduct === index"
            :id="'product-panel-' + index"
            :key="product.label"
            class="product-panel"
            role="tabpanel"
            :aria-labelledby="'product-tab-' + index"
            tabindex="0"
          >
            <div class="product-description">
              <span class="page-tag">{{ product.label }}</span>
              <h3>{{ product.title }}</h3>
              <p>{{ product.body }}</p>
              <RouterLink to="/features"
                >了解产品功能 <span aria-hidden="true">→</span></RouterLink
              ><small>示例环境中的实际界面；功能以账号授权与配置为准。</small>
            </div>
            <figure>
              <SiteImage
                :src="product.image"
                :alt="product.alt"
                :width="1600"
                :height="1000"
              />
              <figcaption>
                实际产品界面 · 示例数据
                <a
                  v-if="!unavailableImages[product.image]"
                  :href="product.image"
                  target="_blank"
                  rel="noopener"
                  >查看完整界面 ↗</a
                >
              </figcaption>
            </figure>
          </div>
        </section>
        <ProductTour />
        <ProductTour kind="brand" />
        <section class="ai-section">
          <div class="public-section ai-inner">
            <div>
              <p class="eyebrow">AI 辅助，让教学更从容</p>
              <h2>AI 提供建议，<br />教师掌握决定权。</h2>
              <p>
                基于授权资料生成教学草稿，保留来源与审核环节，把重复整理的时间留给真正的指导。
              </p>
              <RouterLink class="public-secondary" to="/ai-teaching"
                >了解 AI 教学 →</RouterLink
              ><small>AI 能力需配置后启用。</small>
            </div>
            <div class="ai-visual">
              <SiteImage
                :src="siteMedia.ai"
                alt="授权资料、草稿与人工复核的流程示意"
                :width="1920"
                :height="1080"
              /><small>流程示意 · 非实际模型输出</small>
              <ol class="ai-flow">
                <li>
                  <span>01</span>
                  <div>
                    <strong>选择授权资料</strong>
                    <p>课程与知识资料，明确生成范围。</p>
                  </div>
                </li>
                <li>
                  <span>02</span>
                  <div>
                    <strong>生成教学建议</strong>
                    <p>辅助备课与学习，展示内容来源。</p>
                  </div>
                </li>
                <li>
                  <span>03</span>
                  <div>
                    <strong>教师修改与审核</strong>
                    <p>保留教学判断，经审核后发布。</p>
                  </div>
                </li>
              </ol>
            </div>
          </div>
        </section>
        <section class="public-section">
          <div class="section-heading">
            <div>
              <p class="eyebrow">学习，发生在不同的场景里</p>
              <h2>让自主学习与教学协作顺畅衔接。</h2>
            </div>
            <RouterLink to="/solutions">查看解决方案 →</RouterLink>
          </div>
          <div class="scene-grid">
            <article v-for="scene in scenes" :key="scene.title">
              <img
                v-if="!unavailableImages[scene.image]"
                :src="scene.image"
                :alt="scene.alt"
                width="960"
                height="720"
                loading="lazy"
                decoding="async"
                @error="unavailableImages[scene.image] = true"
              />
              <div v-else class="image-fallback">{{ scene.title }}</div>
              <div>
                <small>AI 场景示意</small>
                <h3>{{ scene.title }}</h3>
                <p>{{ scene.body }}</p>
                <RouterLink to="/solutions">了解场景 →</RouterLink>
              </div>
            </article>
          </div>
        </section>
        <section class="public-section getting-started">
          <div>
            <p class="eyebrow">从第一次登录开始</p>
            <h2>三步，开启新的学习旅程。</h2>
            <RouterLink to="/help">查看使用帮助 →</RouterLink>
          </div>
          <ol>
            <li>
              <span>01</span>
              <div>
                <h3>获取你的账号</h3>
                <p>使用机构提供的账号；开放个人注册时，也可自主注册。</p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <h3>进入所属工作区</h3>
                <p>系统按账号权限展示入口，多组织账号可切换当前组织。</p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <h3>开始学习或授课</h3>
                <p>查看课程与任务，完成实践，在反馈中持续进步。</p>
              </div>
            </li>
          </ol>
        </section>
        <section class="public-section faq-section">
          <div>
            <p class="eyebrow">你可能想了解</p>
            <h2>常见问题</h2>
            <p>
              更多操作说明，请前往<RouterLink to="/help">使用帮助</RouterLink>。
            </p>
          </div>
          <div>
            <details v-for="faq in faqs" :key="faq.question">
              <summary>{{ faq.question }}</summary>
              <p>{{ faq.answer }}</p>
            </details>
          </div>
        </section>
        <section class="public-band">
          <div>
            <p class="eyebrow">每一步学习，都有方向</p>
            <h2>让下一次进步，从这里开始。</h2>
            <p>连接内容、实践与反馈，建立属于你的成长路径。</p>
          </div>
          <a class="public-primary" href="/login" @click="login"
            >{{ userName ? "进入工作区" : "登录知阶" }} →</a
          >
        </section>
      </template>
      <template v-else-if="sitePath === '/explore'"
        ><section class="subpage-hero">
          <h1 ref="pageHeading" tabindex="-1">探索终身学习</h1>
          <p>为自己探索，也为他人的学习提供适当支持。</p>
        </section>
        <div class="public-section"><LifelongExplore @enter="login" /></div
      ></template>
      <template v-else-if="page"
        ><section
          class="subpage-hero"
          :class="{ 'subpage-visual': pageVisual }"
        >
          <div>
            <p class="eyebrow">KNOWLADDER / 知阶</p>
            <h1 ref="pageHeading" tabindex="-1">{{ page.title }}</h1>
            <p>{{ page.subtitle }}</p>
            <RouterLink
              v-if="pageVisual"
              class="public-secondary"
              :to="pageVisual.link"
              >{{ pageVisual.action }} →</RouterLink
            >
          </div>
          <figure v-if="pageVisual">
            <img
              v-if="!unavailableImages[pageVisual.image]"
              :src="pageVisual.image"
              :alt="pageVisual.alt"
              width="1200"
              height="760"
              @error="unavailableImages[pageVisual.image] = true"
            />
            <div v-else class="image-fallback">{{ pageVisual.caption }}</div>
            <figcaption>{{ pageVisual.caption }}</figcaption>
          </figure>
        </section>
        <section v-if="page.items.length" class="public-section feature-grid">
          <article v-for="item in page.items" :key="item.title">
            <span class="page-tag">{{ item.tag }}</span>
            <h2>{{ item.title }}</h2>
            <p>{{ item.body }}</p>
          </article>
        </section>
        <section v-if="sitePath === '/contact'" class="public-section">
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
      <ProductTour v-if="sitePath === '/ai-teaching'" kind="ai" />
      <ProductTour v-if="sitePath === '/about'" kind="brand" />
      <ProductTour v-if="sitePath === '/help'" />
      <section v-if="published" class="public-section published-note">
        <h2>{{ published.title }}</h2>
        <p>{{ published.body }}</p>
      </section>
    </main>
    <footer class="public-footer">
      <div>
        <RouterLink class="public-brand" to="/"
          ><img
            class="brand-mark"
            src="/visuals/logo.svg"
            alt=""
            width="40"
            height="40"
          />知阶<span>KnowLadder</span></RouterLink
        >
        <p>每一步学习，都有方向。</p>
      </div>
      <nav aria-label="页脚导航">
        <RouterLink to="/about">关于知阶</RouterLink
        ><RouterLink to="/help">使用帮助</RouterLink
        ><RouterLink to="/contact">联系咨询</RouterLink
        ><a href="/login" @click="login">工作区登录</a>
      </nav>
      <p class="footer-note">本地验证版本 · 具体功能以工作区授权与配置为准</p>
    </footer>
  </div>
</template>

<style scoped>
.image-fallback {
  display: grid;
  place-items: center;
  aspect-ratio: 1200 / 760;
  background: #edf4fb;
  padding: 24px;
  font-size: 14px;
  color: #5c7589;
  line-height: 1.8;
}
:global(html:has(.public-site)) {
  scrollbar-gutter: stable;
}
.public-site {
  min-height: 100vh;
  min-height: 100svh;
  display: flex;
  flex-direction: column;
  background: #fff;
  color: #20384a;
  font-family: Inter, "Microsoft YaHei", sans-serif;
  --site-blue: #1263b0;
  --site-teal: #087f78;
}
.public-site > main {
  flex: 1;
}
.public-site a {
  color: var(--site-blue);
}
.public-header,
.public-footer {
  width: 100%;
  max-width: 1280px;
  margin: auto;
  padding: 24px 40px;
  display: flex;
  align-items: center;
  gap: 32px;
}
.public-header {
  min-height: 92px;
}
.public-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #20384a !important;
  font-size: 24px;
  font-weight: 750;
  white-space: nowrap;
  text-decoration: none;
}
.public-brand span {
  font-size: 12px;
  letter-spacing: 0.3px;
}
.public-header > nav {
  display: flex;
  gap: 25px;
  margin-left: auto;
}
.public-header nav a,
.public-footer nav a {
  color: #526a7d;
  text-decoration: none;
  font-size: 14px;
}
.public-header nav a:hover,
.public-header nav a.router-link-active {
  color: var(--site-blue);
}
.public-login {
  white-space: nowrap;
  border: 1px solid #d3e0ea;
  border-radius: 9px;
  padding: 12px 16px;
  text-decoration: none;
  font-size: 14px;
  font-weight: 600;
  display: flex;
  gap: 18px;
}
.public-hero {
  max-width: 1280px;
  margin: auto;
  padding: 68px 40px 78px;
  display: grid;
  grid-template-columns: 1fr 1.07fr;
  gap: 45px;
  align-items: center;
  background: radial-gradient(ellipse at 78% 55%, #e7f1ff, transparent 62%);
}
.eyebrow {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 1px;
  color: var(--site-teal);
  line-height: 1.8;
}
.eyebrow-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--site-teal);
}
.public-hero h1 {
  font-size: clamp(32px, 3.5vw, 49px);
  line-height: 1.4;
  letter-spacing: -1.8px;
  margin: 20px 0;
  color: #19354b;
}
.public-hero h1 span {
  color: var(--site-blue);
}
.hero-copy {
  font-size: 16px;
  line-height: 1.9;
  color: #536b7d;
}
.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 28px 0;
}
.public-primary,
.public-secondary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 22px;
  border: 1px solid #d2e0eb;
  border-radius: 9px;
  padding: 13px 20px;
  text-decoration: none;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  min-height: 46px;
}
.public-primary {
  background: var(--site-blue);
  border-color: var(--site-blue);
  color: #fff !important;
}
.public-primary:hover {
  background: #0d5194;
}
.public-secondary {
  background: #fff;
  color: var(--site-blue);
}
.hero-benefits {
  display: flex;
  flex-wrap: wrap;
  gap: 17px;
  color: #63798b;
  font-size: 12px;
}
.hero-benefits span:before {
  content: "✓";
  color: var(--site-teal);
  margin-right: 5px;
}
.ai-visual {
  min-width: 0;
}
.ai-visual > small {
  display: block;
  margin: 0.6rem 0 1rem;
  color: #536b7d;
}
.hero-product {
  margin: 0;
  background: #fff;
  border: 1px solid #d3e1ec;
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 18px 55px #17427020;
  transform: perspective(1600px) rotateY(-3deg);
}
.product-window-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: #f5f8fc;
  color: #647a8c;
  font-size: 11px;
  border-bottom: 1px solid #dfe8ef;
}
.window-dots {
  color: #b6c7d8;
  letter-spacing: 3px;
}
.product-window-tag {
  margin-left: auto;
  border: 1px solid #dbe5ed;
  border-radius: 4px;
  padding: 2px 5px;
}
.hero-product img {
  width: 100%;
  height: auto;
  display: block;
}
.hero-product figcaption {
  padding: 12px 16px;
  font-size: 11px;
  color: #63798a;
  display: flex;
  gap: 8px;
}
.caption-check {
  color: var(--site-teal);
}
.workflow-strip {
  border-top: 1px solid #e4ecf3;
  border-bottom: 1px solid #e4ecf3;
  background: #f8fafc;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 60px;
  padding: 24px 40px;
  font-size: 13px;
  color: #627b8e;
}
.workflow-strip ol {
  display: flex;
  gap: 46px;
  margin: 0;
  padding: 0;
  list-style: none;
  color: #334f64;
  font-weight: 600;
}
.workflow-strip li + li:before {
  content: "→";
  position: relative;
  left: -23px;
  color: #a4b6c6;
}
.public-section {
  max-width: 1280px;
  width: 100%;
  margin: auto;
  padding: 72px 40px;
}
.subpage-visual {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 48px;
  align-items: center;
}
.subpage-visual > div {
  min-width: 0;
}
.subpage-visual figure {
  margin: 0;
  border: 1px solid #d9e4ed;
  border-radius: 14px;
  overflow: hidden;
  background: white;
  box-shadow: 0 12px 38px #17427014;
}
.subpage-visual img {
  display: block;
  width: 100%;
  height: auto;
}
.subpage-visual figcaption {
  padding: 12px 16px;
  font-size: 12px;
  color: #63798a;
}
.subpage-visual .public-secondary {
  margin-top: 14px;
}
@media (max-width: 800px) {
  .subpage-visual {
    grid-template-columns: 1fr;
    gap: 28px;
  }
}
.section-heading {
  display: flex;
  justify-content: space-between;
  align-items: end;
  gap: 30px;
  margin-bottom: 28px;
}
.public-site h2 {
  font-size: 30px;
  line-height: 1.5;
  letter-spacing: -0.8px;
  margin: 9px 0 12px;
}
.section-heading > p,
.public-site p {
  line-height: 1.85;
}
.section-heading > p {
  font-size: 14px;
  color: #62798b;
  margin: 0;
}
.section-heading > a {
  font-size: 14px;
  text-decoration: none;
  white-space: nowrap;
}
.product-tabs {
  display: flex;
  gap: 8px;
  padding: 6px;
  background: #edf3f8;
  border: 1px solid #e0e9f1;
  border-radius: 12px;
  width: max-content;
  max-width: 100%;
  margin-bottom: 26px;
}
.product-tabs button {
  background: transparent;
  color: #566e80;
  border: 0;
  border-radius: 8px;
  padding: 12px 26px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.product-tabs button[aria-selected="true"] {
  background: #fff;
  color: var(--site-blue);
  box-shadow: 0 2px 8px #193b5910;
}
.product-panel {
  display: grid;
  grid-template-columns: 0.8fr 1.5fr;
  gap: 40px;
  align-items: center;
  background: #f6f9fc;
  border: 1px solid #e2ebf3;
  padding: 32px;
  border-radius: 18px;
}
.product-description h3 {
  font-size: 25px;
  line-height: 1.5;
  margin: 18px 0;
}
.product-description p {
  color: #587184;
  font-size: 14px;
}
.product-description a {
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
  display: inline-flex;
  gap: 22px;
  margin: 14px 0;
}
.product-description small {
  display: block;
  color: #75899a;
  font-size: 11px;
  line-height: 1.8;
  margin-top: 20px;
}
.product-panel figure {
  margin: 0;
  border: 1px solid #d9e4ed;
  border-radius: 10px;
  overflow: hidden;
  background: #fff;
  box-shadow: 0 8px 28px #1836500c;
}
.product-panel img {
  width: 100%;
  height: auto;
  display: block;
}
.product-panel figcaption {
  text-align: center;
  font-size: 11px;
  color: #647d8f;
  padding: 10px;
}
.page-tag {
  display: inline-block;
  background: #e5f2f1;
  color: var(--site-teal);
  padding: 5px 9px;
  border-radius: 6px;
  font-size: 12px;
}
.ai-section {
  background: #eff7f8;
  border-block: 1px solid #e1edef;
}
.ai-inner {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 100px;
  align-items: center;
}
.ai-inner > div > p:not(.eyebrow) {
  font-size: 14px;
  color: #597487;
  max-width: 420px;
}
.ai-inner small {
  display: block;
  color: #688293;
  margin-top: 16px;
  font-size: 11px;
}
.ai-flow {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 16px;
}
.ai-flow li {
  display: flex;
  gap: 18px;
  padding: 22px 24px;
  background: #fff;
  border: 1px solid #d9e7e9;
  border-radius: 12px;
}
.ai-flow li > span {
  background: #e7f3f2;
  color: var(--site-teal);
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  font-size: 13px;
  flex-shrink: 0;
}
.ai-flow strong {
  font-size: 16px;
}
.ai-flow p {
  font-size: 13px;
  color: #6a8293;
  margin: 6px 0 0;
}
.scene-grid,
.feature-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 22px;
}
.scene-grid article {
  border: 1px solid #e1e9f0;
  border-radius: 14px;
  overflow: hidden;
  background: #fff;
}
.scene-grid img {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 3/2;
  object-fit: cover;
}
.scene-grid article > div {
  padding: 23px;
}
.scene-grid h3 {
  font-size: 19px;
  margin: 0 0 12px;
}
.scene-grid p {
  color: #5c7587;
  font-size: 14px;
  min-height: 52px;
}
.scene-grid a {
  font-size: 13px;
  text-decoration: none;
  font-weight: 600;
}
.getting-started {
  border-top: 1px solid #e8eef3;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 60px;
}
.getting-started > div > a {
  display: inline-block;
  font-size: 14px;
  margin-top: 16px;
  text-decoration: none;
}
.getting-started ol {
  padding: 0;
  margin: 0;
  list-style: none;
  display: grid;
  gap: 26px;
}
.getting-started li {
  display: flex;
  gap: 22px;
}
.getting-started li > span {
  color: #8ba3b8;
  font-size: 22px;
  font-weight: 600;
}
.getting-started h3 {
  font-size: 16px;
  margin: 0 0 8px;
}
.getting-started p {
  font-size: 14px;
  color: #647c8e;
  margin: 0;
}
.faq-section {
  background: #f8fafc;
  border: 1px solid #e3ebf2;
  border-radius: 18px;
  display: grid;
  grid-template-columns: 0.85fr 1.4fr;
  gap: 70px;
  max-width: 1200px;
  padding: 40px;
  margin: 0 auto 64px;
}
.faq-section > div > p {
  font-size: 14px;
  color: #647c8e;
}
.faq-section details {
  padding: 17px 0;
  border-bottom: 1px solid #dce6ef;
}
.faq-section details:last-child {
  border: 0;
}
.faq-section summary {
  cursor: pointer;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.6;
}
.faq-section details p {
  font-size: 14px;
  color: #5a7488;
  margin: 14px 0 3px;
}
.public-band {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 35px;
  max-width: 1200px;
  margin: 0 auto 64px;
  padding: 36px 40px;
  background: #eaf2fb;
  border: 1px solid #d9e5f2;
  border-radius: 18px;
}
.public-band p {
  font-size: 14px;
  color: #536e85;
  margin: 8px 0;
}
.public-band h2 {
  font-size: 26px;
}
.public-band .public-primary {
  flex-shrink: 0;
}
.public-footer {
  flex-wrap: wrap;
  justify-content: space-between;
  border-top: 1px solid #e0e8f0;
  padding-top: 35px;
  padding-bottom: 24px;
}
.public-footer > div > p {
  font-size: 12px;
  color: #7a8fa0;
  margin: 12px 0;
}
.public-footer nav {
  display: flex;
  gap: 25px;
  flex-wrap: wrap;
}
.footer-note {
  width: 100%;
  text-align: center;
  font-size: 11px;
  color: #748a9d;
  padding-top: 20px;
  border-top: 1px solid #edf2f6;
  margin: 0;
}
.subpage-hero {
  max-width: 1280px;
  width: 100%;
  margin: auto;
  padding: 65px 40px 20px;
}
.subpage-hero h1 {
  font-size: clamp(28px, 3vw, 44px);
  margin: 20px 0;
  line-height: 1.4;
  text-wrap: balance;
}
.subpage-hero > div > p:not(.eyebrow) {
  font-size: 16px;
  color: #637b8e;
  max-width: 760px;
}
.feature-grid article {
  padding: 28px;
  border: 1px solid #dfe8f0;
  border-radius: 14px;
  background: #f8fafc;
}
.feature-grid h2 {
  font-size: 22px;
}
.feature-grid p {
  font-size: 14px;
  color: #597184;
}
.contact-form {
  max-width: 560px;
  display: grid;
  gap: 18px;
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
  min-width: 0;
  width: 100%;
  padding: 12px;
  border: 1px solid #c9d7e2;
  border-radius: 8px;
  background: #fff;
  font-size: 16px;
}
.contact-form .consent {
  display: flex;
  align-items: flex-start;
  line-height: 1.8;
}
.contact-form .consent input {
  width: auto;
  margin-top: 6px;
}
.receipt-query {
  display: flex;
  align-items: end;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 28px;
}
.receipt-query label {
  flex: 1;
  max-width: 500px;
  min-width: 180px;
}
.published-note {
  border-top: 1px solid #e3ebf2;
}
.published-note p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.public-session-status {
  max-width: 1200px;
  margin: 12px auto;
  padding: 14px 20px;
  background: #fff7e7;
  border: 1px solid #ebd9ad;
  border-radius: 10px;
  font-size: 14px;
  display: flex;
  gap: 14px;
  align-items: center;
  flex-wrap: wrap;
}
.public-session-status button {
  padding: 7px 12px;
  font-size: 13px;
}
.public-site :is(a, button, summary):focus-visible {
  outline: 3px solid #9ccaf5;
  outline-offset: 4px;
}
.public-site button:disabled {
  opacity: 0.6;
  cursor: wait;
}
@media (min-width: 900px) {
  .public-site > main > .feature-grid {
    padding-top: 32px;
  }
}
@media (max-width: 1000px) {
  .public-header,
  .public-footer {
    padding: 20px 24px;
    gap: 20px;
  }
  .public-header nav {
    gap: 16px;
  }
  .public-brand span {
    display: none;
  }
  .public-hero {
    padding: 50px 24px;
    gap: 25px;
  }
  .public-section {
    padding: 56px 24px;
  }
  .public-hero h1 {
    font-size: 36px;
  }
  .ai-inner {
    gap: 44px;
  }
  .product-panel {
    gap: 24px;
    padding: 24px;
  }
  .faq-section,
  .public-band {
    margin-left: 24px;
    margin-right: 24px;
    width: auto;
  }
  .workflow-strip {
    gap: 25px;
  }
  .workflow-strip ol {
    gap: 32px;
  }
  .workflow-strip li + li:before {
    left: -16px;
  }
}
@media (max-width: 767px) {
  .public-header {
    flex-wrap: wrap;
    gap: 16px;
  }
  .public-header > nav {
    order: 3;
    width: 100%;
    margin: 0;
    justify-content: space-between;
    gap: 12px;
  }
  .public-header > .public-login,
  .public-header > :last-child:not(nav) {
    margin-left: auto;
  }
  .public-hero {
    grid-template-columns: 1fr;
    padding-top: 28px;
    gap: 34px;
  }
  .hero-text {
    max-width: 600px;
  }
  .public-hero h1 {
    font-size: 40px;
  }
  .hero-product {
    transform: none;
  }
  .workflow-strip {
    display: block;
    padding: 24px;
    text-align: center;
  }
  .workflow-strip ol {
    justify-content: center;
    margin-top: 18px;
    gap: 24px;
    flex-wrap: wrap;
  }
  .workflow-strip li + li:before {
    left: -12px;
  }
  .section-heading {
    display: block;
  }
  .section-heading > a {
    display: block;
    margin-top: 16px;
  }
  .public-site h2 {
    font-size: 26px;
  }
  .product-panel {
    grid-template-columns: 1fr;
  }
  .product-description small {
    margin-top: 10px;
  }
  .product-description h3 {
    font-size: 23px;
    margin: 14px 0;
  }
  .scene-grid {
    grid-template-columns: 1fr;
    gap: 24px;
  }
  .scene-grid article {
    display: grid;
    grid-template-columns: 1fr 1.2fr;
  }
  .scene-grid img {
    height: 100%;
    aspect-ratio: auto;
    min-height: 200px;
  }
  .scene-grid p {
    min-height: 0;
  }
  .ai-inner,
  .getting-started,
  .faq-section {
    grid-template-columns: 1fr;
    gap: 30px;
  }
  .feature-grid {
    grid-template-columns: 1fr;
  }
  .faq-section {
    padding: 28px 24px;
  }
  .public-band {
    display: block;
    padding: 28px 24px;
  }
  .public-band .public-primary {
    margin-top: 18px;
  }
  .public-footer nav {
    gap: 20px;
  }
  .public-session-status {
    margin-inline: 20px;
  }
  .public-header nav a {
    font-size: 13px;
  }
}
@media (max-width: 420px) {
  .public-header,
  .public-footer {
    padding: 18px 20px;
  }
  .public-brand {
    font-size: 21px;
    gap: 8px;
  }
  .public-brand img {
    width: 34px;
    height: 34px;
  }
  .public-login {
    padding: 10px 12px;
    font-size: 12px;
    gap: 8px;
  }
  .public-header nav {
    gap: 7px;
  }
  .public-header nav a {
    font-size: 12px;
  }
  .public-hero {
    padding: 30px 20px 36px;
  }
  .public-hero h1 {
    font-size: 32px;
    letter-spacing: -1.1px;
  }
  .hero-copy {
    font-size: 14px;
  }
  .eyebrow {
    font-size: 11px;
    letter-spacing: 0.4px;
  }
  .hero-benefits {
    gap: 12px;
    font-size: 11px;
  }
  .public-primary,
  .public-secondary {
    padding: 12px 15px;
    gap: 14px;
  }
  .product-window-bar {
    font-size: 10px;
    gap: 6px;
  }
  .window-dots {
    letter-spacing: 1px;
  }
  .public-section {
    padding: 40px 20px;
  }
  .public-site h2 {
    font-size: 24px;
  }
  .product-tabs {
    width: 100%;
  }
  .product-tabs button {
    flex: 1;
    padding: 11px 7px;
    font-size: 13px;
  }
  .product-panel {
    padding: 18px;
    gap: 20px;
  }
  .product-description h3 {
    font-size: 22px;
  }
  .scene-grid article {
    display: block;
  }
  .scene-grid img {
    aspect-ratio: 3/2;
    min-height: 0;
    height: auto;
  }
  .scene-grid article > div {
    padding: 20px;
  }
  .faq-section,
  .public-band {
    margin: 0 20px 40px;
    padding: 24px 20px;
  }
  .public-footer {
    gap: 20px;
  }
  .public-footer nav {
    gap: 15px;
  }
  .public-footer nav a {
    font-size: 12px;
  }
  .public-band h2 {
    font-size: 23px;
  }
  .ai-flow li {
    padding: 18px 16px;
  }
  .ai-flow {
    gap: 12px;
  }
  .workflow-strip ol {
    gap: 22px;
    font-size: 12px;
  }
  .hero-actions {
    gap: 10px;
  }
  .hero-actions a {
    font-size: 13px;
  }
}
@media (prefers-reduced-motion: reduce) {
  * {
    scroll-behavior: auto !important;
  }
}
</style>
