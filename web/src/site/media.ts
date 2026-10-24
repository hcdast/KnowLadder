// Public website variants from UI34.7. Master files and raw clips are not page assets.
const cdn = "http://cdn.zhihexu.cn/knowladder/";
export const mediaURL = (file: string) => cdn + file;
export const siteMedia = {
  hero: mediaURL("h01-hero-lifelong-desktop.webp"),
  heroMobile: mediaURL("h01-hero-lifelong-mobile.webp"),
  ai: mediaURL("a01-ai-source-review.webp"),
  personal: mediaURL("r01-product-personal.webp"),
  course: mediaURL("r02-product-course.webp"),
  review: mediaURL("r03-product-review.webp"),
  teaching: mediaURL("r04-product-teaching.webp"),
  emptyCourse: mediaURL("e01-empty-course.webp"),
  emptyNote: mediaURL("e02-empty-note.webp"),
  emptyPlan: mediaURL("e03-empty-plan.webp"),
};
export const sceneMedia: Record<string, { src: string; alt: string }> = {
  early: {
    src: mediaURL("s01-scene-early.webp"),
    alt: "亲子在桌边共同观察树叶的学习场景示意",
  },
  school: {
    src: mediaURL("s02-scene-school.webp"),
    alt: "学生共同观察模型承重的探究场景示意",
  },
  university: {
    src: mediaURL("s03-scene-university.webp"),
    alt: "专业学习与共同研究的场景示意",
  },
  career: {
    src: mediaURL("s04-scene-career.webp"),
    alt: "在工作中整理与应用所学的场景示意",
  },
  life: {
    src: mediaURL("s05-scene-life.webp"),
    alt: "通过日常艺术创作持续学习的场景示意",
  },
  senior: {
    src: mediaURL("s06-scene-senior.webp"),
    alt: "长者自主学习数字生活技能的场景示意",
  },
};
const covers: Record<string, string> = {
  "story-observer": "c01-course-story-observer.webp",
  "water-observer": "c02-course-water-observer.webp",
  "source-comparison": "c03-course-source-comparison.webp",
  "work-improvement": "c04-course-work-improvement.webp",
  "creative-week": "c05-course-creative-week.webp",
  "digital-confidence": "c06-course-digital-confidence.webp",
};
export const courseCover = (id: string) =>
  covers[id] ? mediaURL(covers[id]!) : undefined;
export const localMediaFallback = (url: string) =>
  url.startsWith(cdn) && /^(?:r0[1-4]-|v0[1-3]-)/.test(url.slice(cdn.length))
    ? "/website/" + url.split("/").at(-1)
    : undefined;
export const mediaVideos = {
  tour: {
    base: "v03-product-tour",
    title: "从学习到授课，一起看一遍。",
    eyebrow: "30 秒产品导览",
    duration: 30,
    caption: "实际产品界面 · 示例数据 · 无配音",
    steps: [
      "从个人空间继续学习，打开原创课程。",
      "阅读、练习与实践回顾，记录自己的理解。",
      "查看笔记与复习历史，切换示例教师查看已发布反馈。",
    ],
  },
  brand: {
    base: "v01-brand-learning",
    title: "每一步，都算数。",
    eyebrow: "15 秒品牌短片",
    duration: 15,
    caption: "AI 生成场景示意 · 无配音",
    steps: [
      "好奇，是第一步：亲子共读与观察。",
      "把所学，用在生活里：整理与书写实践材料。",
      "成长，可以贯穿一生：自主探索数字生活。",
    ],
  },
  ai: {
    base: "v02-ai-review-motion",
    title: "从资料到草稿，再到人工复核。",
    eyebrow: "5 秒概念动效",
    duration: 5,
    caption: "AI 生成流程示意 · 非实际审核记录",
    steps: [
      "三组纸张与连接路径表示资料整理与复核的概念。",
      "画面不是实际产品界面或模型回复，纸面线条不作为可读正文。",
    ],
  },
} as const;
