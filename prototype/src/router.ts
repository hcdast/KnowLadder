import { createRouter, createWebHistory } from "vue-router";
import { nextTick } from "vue";
import { demo } from "./services/core";
const student = () => import("./features/student/StudentView.vue");
const admin = () => import("./features/admin/AdminView.vue");
const pages = [
  ["/student", "S01"],
  ["/student/textbooks", "S02"],
  ["/student/chapters/:chapterId", "S03"],
  ["/student/practice", "S04"],
  ["/student/practice/sessions/:sessionId", "S05"],
  ["/student/quizzes/:quizId", "S06"],
  ["/student/quiz/sessions/:sessionId", "S07"],
  ["/student/submissions/:submissionId", "S08"],
  ["/student/growth", "S09"],
  ["/student/mistakes", "S10"],
  ["/admin", "A01"],
  ["/admin/textbooks", "A02"],
  ["/admin/questions/:versionId", "A03"],
  ["/admin/reviews/:resourceType/:versionId", "A04"],
];
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      name: "landing",
      component: () => import("./features/LandingView.vue"),
    },
    ...pages.map(([path, page]) => ({
      path,
      name: page,
      component: page.startsWith("S") ? student : admin,
      meta: { page },
    })),
    {
      path: "/:pathMatch(.*)*",
      name: "not-found",
      component: () => import("./features/NotFoundView.vue"),
    },
  ],
  scrollBehavior(to, _from, saved) {
    return saved ?? (to.meta.page === "S03" ? false : { top: 0 });
  },
});
router.beforeEach((to, from) => {
  if (demo.scenario === "returning" && to.query.scenario !== "returning")
    return {
      path: to.path,
      query: { ...to.query, scenario: "returning" },
      hash: to.hash,
    };
  if (demo.scenario === "first" && to.query.scenario) {
    const query = { ...to.query };
    delete query.scenario;
    return { path: to.path, query, hash: to.hash };
  }
  if (to.fullPath !== from.fullPath && demo.dirty) {
    if (!window.confirm("有修改尚未保存。离开可能丢失本页输入，确定离开吗？"))
      return false;
    demo.dirty = false;
  }
});
router.afterEach(async () => {
  await nextTick();
  document
    .querySelector<HTMLElement>("main h1")
    ?.focus({ preventScroll: true });
});
