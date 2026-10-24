import { createApp, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import CourseCenter from "../src/personal/CourseCenter.vue";
import { ApiError, type GlobalRequest } from "../src/session";
const stage = document.querySelector<HTMLElement>("#stage")!,
  output = document.querySelector<HTMLElement>("#results")!;
const results: { name: string; passed: boolean; message?: string }[] = [];
const course = {
  id: "original",
  version: 1,
  title: "原创案例学习",
  stage: "school",
  field: "science",
  summary: "从观察到证据",
  audience: "自主学习者",
  prerequisites: "无需基础",
  outcome: "说明事实与推断",
  materials: "纸笔",
  support: "使用合成案例",
  minutes: 20,
  unit_count: 2,
  format: "reading_practice",
  level: "入门",
  provider: "本站原创",
  source: "原创",
  updated_on: "2026-10-15",
  completion: "完成不等于掌握",
  learning: null,
};
const units = ["first", "second"].map((id) => ({
  id,
  title: `${id}学习单元`,
  minutes: 10,
  objective: "区分事实与推断",
  paragraphs: ["这是实际展示的原创案例正文。", "观察记录与推断应分别说明。"],
  steps: ["阅读案例", "记录依据"],
  question: "哪项有依据？",
  options: ["观察记录", "没有依据的猜想", "未知"],
  explanation: "回到观察记录检查。",
  practice: "记录案例及依据。",
}));
function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
async function settle() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
    await nextTick();
  }
}
function button(name: string) {
  const b = [...stage.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === name,
  );
  assert(b, `缺少按钮${name}`);
  return b;
}
async function click(name: string) {
  const b = button(name);
  assert(!b.disabled, `按钮不可用${name}`);
  b.click();
  await settle();
}
async function run(name: string, work: () => Promise<void>) {
  try {
    await work();
    results.push({ name, passed: true });
  } catch (cause) {
    results.push({
      name,
      passed: false,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
async function mount(
  url = "/personal?tab=courses",
  initialJoined = false,
  custom?: (path: string) => unknown,
) {
  let learning = initialJoined
    ? {
        goal_id: "111111111111111111111111",
        revision: 1,
        completed_unit_ids: [] as string[],
        next_unit_id: "first",
        state: "active",
      }
    : null;
  const calls: { path: string; body?: unknown }[] = [],
    dirty = ref(false),
    mode = ref<"continue" | "catalog">("catalog");
  const request: GlobalRequest = async <T>(path: string) => {
    calls.push({ path });
    const override = custom?.(path);
    if (override !== undefined) return (await override) as T;
    if (path.startsWith("/personal/courses?"))
      return {
        items: path.includes("q=absent") ? [] : [{ ...course, learning }],
      } as T;
    if (path === "/personal/courses")
      return { items: [{ ...course, learning }] } as T;
    if (path === "/personal/courses/original")
      return { ...course, learning, units } as T;
    throw Error(path);
  };
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/personal", component: { render: () => null } }],
  });
  await router.push(url);
  let allow = true;
  router.beforeEach(() => allow);
  const component = ref<InstanceType<typeof CourseCenter>>();
  const app = createApp({
    render: () =>
      h(CourseCenter, {
        ref: component,
        request,
        mode: mode.value,
        locked: false,
        onDirty: (v: boolean) => (dirty.value = v),
        onBrowse: () => {
          mode.value = "catalog";
        },
        write: async (path: string, body: any) => {
          calls.push({ path, body });
          if (path.endsWith("/enroll"))
            learning = {
              goal_id: "111111111111111111111111",
              revision: 1,
              completed_unit_ids: [],
              next_unit_id: "first",
              state: "active",
            };
          else {
            assert(
              learning && body.answer >= 0 && body.practice && body.reflection,
              "未提交完整实践输入",
            );
            learning.completed_unit_ids.push("first");
            learning.next_unit_id = "second";
            learning.revision++;
          }
          return {
            operation_id: "222222222222222222222222",
            resource_id: learning!.goal_id,
            revision: learning!.revision,
          };
        },
      }),
  }).use(router);
  app.mount(stage);
  await settle();
  return {
    close: () => app.unmount(),
    calls,
    router,
    vm: component.value!,
    dirty,
    mode,
    setMode: (value: "continue" | "catalog") => {
      mode.value = value;
    },
    allow: (value: boolean) => (allow = value),
  };
}
await run("目录筛选空态、详情返回保留筛选", async () => {
  const f = await mount();
  try {
    const input = stage.querySelector<HTMLInputElement>(
      'input[type="search"]',
    )!;
    input.value = "absent";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    stage
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await settle();
    assert(stage.textContent?.includes("暂无符合条件"), "缺少真实空态");
    await click("清除筛选");
    await click("查看课程详情");
    assert(
      stage.textContent?.includes("先修要求") &&
        stage.textContent?.includes("课程目录"),
      "详情元数据缺失",
    );
    await click("返回内容中心");
    assert(
      stage.querySelector<HTMLInputElement>('input[type="search"]')!.value ===
        "",
      "清空筛选未保留",
    );
  } finally {
    f.close();
  }
});
await run("主动加入、逐单元实践、提交后下一步与独立完成状态", async () => {
  const f = await mount("/personal?tab=courses&course=original");
  try {
    await click("加入我的学习");
    await click("开始 / 继续学习");
    assert(
      stage
        .querySelector(".unit-list li:nth-child(2) button")
        ?.hasAttribute("disabled"),
      "未阻止跳过先修单元",
    );
    const radio = stage.querySelector<HTMLInputElement>('input[type="radio"]')!;
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
    for (const textarea of stage.querySelectorAll<HTMLTextAreaElement>(
      "textarea",
    )) {
      textarea.value = "我的原创案例记录与回顾";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await settle();
    assert(f.dirty.value, "草稿未上报离开保护");
    await click("保存并完成本单元");
    assert(
      stage.textContent?.includes("本单元已完成") && !f.dirty.value,
      "保存后未更新状态或清理草稿",
    );
    assert(
      f.calls.filter((c) => c.path.endsWith("/complete")).length === 1,
      "重复提交",
    );
    await click("学习下一单元");
    assert(stage.textContent?.includes("second学习单元"), "未进入下一单元");
  } finally {
    f.close();
  }
});
await run("深链限制和失败读取清空旧正文", async () => {
  let denied = false;
  const f = await mount(
    "/personal?tab=courses&course=original&unit=second",
    true,
    (path) => {
      if (denied && path === "/personal/courses/original")
        throw new ApiError(404, "课程已撤回");
    },
  );
  try {
    assert(!stage.querySelector(".unit-reading"), "深链绕过先修单元");
    await f.router.push("/personal?tab=courses&course=original&unit=first");
    await settle();
    assert(
      stage.textContent?.includes("实际展示的原创案例正文"),
      "没有读取正文",
    );
    denied = true;
    await f.vm.refresh();
    await settle();
    assert(
      !stage.textContent?.includes("实际展示的原创案例正文") &&
        stage.textContent?.includes("课程已撤回"),
      "失败后保留旧正文",
    );
  } finally {
    f.close();
  }
});
await run("同URL从首页继续学习与取消导航保留草稿", async () => {
  const f = await mount(
    "/personal?tab=courses&course=original&unit=first",
    true,
  );
  try {
    f.setMode("continue");
    await settle();
    await click("继续学习");
    assert(
      f.mode.value === "catalog" && !!stage.querySelector(".unit-reading"),
      "同URL导航不能回到学习单元",
    );
    const textarea = stage.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "保留的课程草稿";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    f.allow(false);
    await click("返回内容中心");
    assert(
      stage.querySelector<HTMLTextAreaElement>("textarea")!.value ===
        "保留的课程草稿",
      "取消离开丢失草稿",
    );
  } finally {
    f.close();
  }
});
await run("目录排序与最多三门比较，不写入学习成绩", async () => {
  const catalog = [40,10,30,20].map((minutes,index)=>({...course,id:'course-'+index,title:'课程'+index,minutes}));
  const f = await mount('/personal?tab=courses', false, path => path === '/personal/courses' ? {items:catalog} : undefined);
  try {
    const order=stage.querySelector<HTMLSelectElement>('.course-order select')!; order.value='minutes'; order.dispatchEvent(new Event('change',{bubbles:true})); await settle();
    assert(stage.querySelector('.course-grid .course-card h3')?.textContent==='课程1','预计投入排序不正确');
    for(let n=0;n<3;n++){stage.querySelector<HTMLButtonElement>('[aria-label="比较：课程'+n+'"]')!.click();await settle();}
    assert(stage.querySelector<HTMLButtonElement>('[aria-label="比较：课程3"]')!.disabled,'比较上限未生效');
    assert(stage.querySelectorAll('.course-compare .course-card').length===3,'比较缺少已选课程');
    assert(stage.querySelector('.course-compare')?.textContent?.includes('无需基础'),'未展示先修信息');
    await click('清空比较'); assert(!stage.querySelector('.course-compare'),'清空后残留比较');
    assert(!f.calls.some(c=>c.body),'比较不应提交业务写入');
  } finally { f.close(); }
});
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
