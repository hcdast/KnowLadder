import { createApp, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import SiteImage from "../src/site/SiteImage.vue";
import ProductTour from "../src/site/ProductTour.vue";
import { siteMedia } from "../src/site/media";
const stage = document.querySelector<HTMLElement>("#stage")!;
const results: { name: string; passed: boolean; message?: string }[] = [];
const assert = (value: unknown, message: string) => {
  if (!value) throw Error(message);
};
const tick = async () => {
  await nextTick();
  await nextTick();
};
async function test(name: string, action: () => Promise<void>) {
  try {
    await action();
    results.push({ name, passed: true });
  } catch (e) {
    results.push({ name, passed: false, message: String(e) });
  }
}
await test("截图 CDN 失败回退本站，双失败展示说明，切换截图恢复", async () => {
  const src = ref(siteMedia.personal);
  const app = createApp(() =>
    h(SiteImage, { src: src.value, alt: "产品界面" }),
  );
  app.mount(stage);
  try {
    stage.querySelector("img")!.dispatchEvent(new Event("error"));
    await tick();
    assert(
      stage.querySelector("img")!.getAttribute("src") ===
        "/website/r01-product-personal.webp",
      "缺少本地回退",
    );
    stage.querySelector("img")!.dispatchEvent(new Event("error"));
    await tick();
    assert(
      stage.querySelector('[role="img"]')?.textContent === "产品界面",
      "双失败未显示说明",
    );
    src.value = siteMedia.course;
    await tick();
    assert(
      stage.querySelector("img")?.getAttribute("src") === siteMedia.course,
      "新资源未恢复 CDN",
    );
  } finally {
    app.unmount();
  }
});
await test("AI 图片缺失显示替代说明，不请求不存在的本站文件", async () => {
  const app = createApp(() =>
    h(SiteImage, { src: siteMedia.ai, alt: "复核流程示意" }),
  );
  app.mount(stage);
  try {
    stage.querySelector("img")!.dispatchEvent(new Event("error"));
    await tick();
    assert(
      !stage.querySelector("img") && stage.textContent === "复核流程示意",
      "错误回退",
    );
  } finally {
    app.unmount();
  }
});
await test("三种视频均点击后加载；错误依次回退本站和文字；切换种类重置", async () => {
  const kind = ref<"tour" | "brand" | "ai">("tour");
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }],
  });
  await router.push("/");
  await router.isReady();
  const play = HTMLMediaElement.prototype.play,
    load = HTMLMediaElement.prototype.load;
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.load = () => {};
  const app = createApp(() => h(ProductTour, { kind: kind.value }));
  app.use(router);
  app.mount(stage);
  try {
    assert(!stage.querySelector("video"), "点击前加载了视频");
    stage.querySelector<HTMLButtonElement>("button")!.click();
    await tick();
    assert(
      stage.querySelector("video")!.src ===
        "http://cdn.zhihexu.cn/knowladder/v03-product-tour.mp4",
      "导览资源不匹配",
    );
    assert(
      stage
        .querySelector("track")
        ?.getAttribute("src")
        ?.endsWith("v03-product-tour.zh.vtt"),
      "缺少字幕",
    );
    assert(
      !stage.querySelector("track")!.default,
      "外挂字幕不应默认叠加内嵌字幕",
    );
    stage.querySelector("video")!.dispatchEvent(new Event("error"));
    await tick();
    assert(
      stage.querySelector("video")!.getAttribute("src") ===
        "/website/v03-product-tour.mp4",
      "缺少本站视频回退",
    );
    assert(
      stage.querySelector("track")!.getAttribute("src") ===
        "/website/v03-product-tour.zh.vtt",
      "回退字幕不匹配",
    );
    stage.querySelector("video")!.dispatchEvent(new Event("error"));
    await tick();
    assert(
      !stage.querySelector("video") && !!stage.querySelector('[role="status"]'),
      "双失败缺少文字说明",
    );
    assert(
      document.activeElement === stage.querySelector('[role="status"]'),
      "失败焦点未移到说明",
    );
    for (const value of ["brand", "ai"] as const) {
      kind.value = value;
      await tick();
      assert(!stage.querySelector("video"), "切换后未重置");
      stage.querySelector<HTMLButtonElement>("button")!.click();
      await tick();
      assert(
        stage
          .querySelector("video")!
          .getAttribute("src")
          ?.includes(
            value === "brand" ? "v01-brand-learning" : "v02-ai-review-motion",
          ),
        "种类资源不匹配",
      );
      assert(
        !!stage.querySelector("track") === (value === "brand"),
        "字幕与素材不匹配",
      );
    }
  } finally {
    app.unmount();
    HTMLMediaElement.prototype.play = play;
    HTMLMediaElement.prototype.load = load;
  }
});
const output = document.querySelector<HTMLElement>("#results")!;
output.textContent = JSON.stringify(
  {
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    results,
  },
  null,
  2,
);
output.dataset.complete = "true";
