import { createApp, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import StudyNotebook from "../src/personal/StudyNotebook.vue";
import { ApiError, type GlobalRequest } from "../src/session";
const stage = document.querySelector<HTMLElement>("#stage")!,
  output = document.querySelector<HTMLElement>("#results")!;
const results: { name: string; passed: boolean; message?: string }[] = [];
const day = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const item = {
  id: "111111111111111111111111",
  title: "区分事实和推断",
  note: "保留自己的理解",
  bookmarked: true,
  course_id: "original",
  course_version: 1,
  unit_id: "first",
  source_available: true,
  source_title: "原创 · 首个单元",
  due_on: day(),
  reviewed_on: null,
  review_count: 0,
  suggested_interval_days: 1,
  review_note: "",
  revision: 1,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};
const course = {
  id: "original",
  version: 1,
  units: [
    {
      id: "first",
      title: "首个单元",
      question: "哪项是事实？",
      options: ["记录", "猜测", "未知"],
      explanation: "检查观察记录",
    },
  ],
};
function assert(v: unknown, m: string): asserts v {
  if (!v) throw Error(m);
}
async function settle() {
  for (let i = 0; i < 25; i++) {
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
function input(label: string, value: string) {
  const l = [...stage.querySelectorAll("label")].find(
    (l) => l.firstChild?.textContent?.trim() === label,
  );
  const e = l?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    "input,textarea",
  );
  assert(e, `缺少输入${label}`);
  e.value = value;
  e.dispatchEvent(new Event("input", { bubbles: true }));
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
  } finally {
    stage.replaceChildren();
  }
}
async function mount(
  options: {
    mode?: "today" | "notebook";
    url?: string;
    read?: (path: string) => unknown;
    write?: (path: string, body: any) => unknown;
  } = {},
) {
  const calls: { path: string; body?: any; method?: string }[] = [],
    dirty = ref(false),
    mode = ref(options.mode ?? "notebook");
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/personal", component: { render: () => null } }],
  });
  await router.push(options.url ?? "/personal?tab=notes");
  const request: GlobalRequest = async <T>(path: string) => {
    calls.push({ path });
    const custom = options.read?.(path);
    if (custom !== undefined) return (await custom) as T;
    if (path.startsWith("/personal/study-items?"))
      return { items: [item], next_cursor: null } as T;
    if (path === "/personal/courses/original") return course as T;
    throw Error(path);
  };
  const component = ref<InstanceType<typeof StudyNotebook>>();
  const app = createApp({
    render: () =>
      h(StudyNotebook, {
        ref: component,
        request,
        locked: false,
        mode: mode.value,
        onDirty: (v: boolean) => (dirty.value = v),
        write: async (path, body, method) => {
          calls.push({ path, body, method });
          const custom = options.write?.(path, body);
          if (custom !== undefined) return (await custom) as any;
          return { operation_id: item.id, resource_id: item.id, revision: 2 };
        },
      }),
  });
  app.use(router);
  app.mount(stage);
  await settle();
  return { app, calls, dirty, mode, component, router };
}
await run("课程深链：关联当前版本、保存收藏/日期和私人笔记", async () => {
  const f = await mount({
    url: "/personal?tab=notes&course=original&unit=first",
  });
  assert(stage.textContent?.includes("已关联原创课程单元 v1"), "未关联来源");
  input("我的笔记", "比较原文与推断");
  input("复习日期（可选）", day());
  const check = stage.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  )!;
  check.checked = true;
  check.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  assert(f.dirty.value, "未向父组件报告草稿");
  await click("保存笔记");
  const call = f.calls.find((c) => c.body);
  assert(
    call?.body.course_id === "original" &&
      call.body.course_version === 1 &&
      call.body.unit_id === "first",
    "来源版本丢失",
  );
  assert(call.body.bookmarked && call.body.due_on === day(), "收藏/日期未保存");
  assert(!f.dirty.value, "成功后草稿未清理");
  f.app.unmount();
});
await run("今日复习：真实日期筛选、回看与独立再练和回顾", async () => {
  const f = await mount({ mode: "today" });
  assert(
    f.calls[0]?.path.includes(`filter=due&as_of=${day()}`),
    "未按设备日期筛选",
  );
  await click("开始复习");
  assert(stage.textContent?.includes("哪项是事实"), "未载入原单元再练");
  const radio = stage.querySelector<HTMLInputElement>('input[type="radio"]')!;
  radio.checked = true;
  radio.dispatchEvent(new Event("change", { bubbles: true }));
  input("复习回顾", "这次能用记录解释事实");
  await settle();
  await click("保存复习回顾");
  const c = f.calls.find((c) => c.path.endsWith("/review"));
  assert(
    c?.body.answer === 0 && c.body.note.includes("解释"),
    "复习答题或回顾未送达",
  );
  assert(
    !f.calls.some((c) => c.path.includes("/complete")),
    "复习不应修改课程完成",
  );
  f.app.unmount();
});
await run("复习失败或请求待确认：保留作答与回顾草稿", async () => {
  const g = await mount({ write: () => Promise.resolve(undefined) });
  await click("开始复习");
  const radio = stage.querySelector<HTMLInputElement>('input[type="radio"]')!;
  radio.checked = true;
  radio.dispatchEvent(new Event("change", { bubbles: true }));
  input("复习回顾", "还需要再看依据");
  await settle();
  await click("保存复习回顾");
  assert(
    g.calls.some((c) => c.path.endsWith("/review")),
    "未提交复习请求",
  );
  assert(
    g.dirty.value && stage.textContent?.includes("复习："),
    "未知请求丢失草稿",
  );
  g.app.unmount();
});
await run("编辑、移除确认与重新加载", async () => {
  const f = await mount();
  await click("编辑笔记");
  input("笔记标题", "修改重点");
  await settle();
  await click("保存笔记");
  assert(
    f.calls.some((c) => c.method === "PATCH" && c.body.revision === 1),
    "未带修订编辑",
  );
  await click("移除");
  assert(!f.calls.some((c) => c.path.endsWith("/remove")), "未确认就移除");
  await click("确认移除");
  assert(
    f.calls.some((c) => c.path.endsWith("/remove") && c.body.revision === 1),
    "移除请求缺修订",
  );
  f.app.unmount();
});
await run("筛选、分页与撤权后清除旧笔记", async () => {
  let denied = false;
  const f = await mount({
    read: (path) =>
      path.startsWith("/personal/study-items?")
        ? denied
          ? Promise.reject(new ApiError(403, "FORBIDDEN", "当前不可访问"))
          : { items: [item], next_cursor: "next-page" }
        : undefined,
  });
  const select = stage.querySelector<HTMLSelectElement>("select")!;
  select.value = "bookmarked";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  input("查找笔记", "证据");
  await settle();
  await click("查找");
  assert(
    f.calls.some(
      (c) => c.path.includes("filter=bookmarked") && c.path.includes("q="),
    ),
    "筛选未发送",
  );
  await click("加载更多笔记");
  assert(
    f.calls.some((c) => c.path.includes("cursor=next-page")),
    "未使用分页游标",
  );
  denied = true;
  await f.component.value!.refresh();
  await settle();
  assert(!stage.textContent?.includes("保留自己的理解"), "撤权后仍显示旧笔记");
  assert(button("保存笔记").disabled, "读取失权后仍可提交");
  f.app.unmount();
});
await run("来源撤回后不提供回看/再练，卸载清除草稿标记", async () => {
  const f = await mount({
    read: (path) =>
      path.startsWith("/personal/study-items?")
        ? {
            items: [{ ...item, source_available: false, source_title: null }],
            next_cursor: null,
          }
        : undefined,
  });
  assert(stage.textContent?.includes("原课程版本已不可用"), "未标记来源撤回");
  assert(
    ![...stage.querySelectorAll("button")].some(
      (b) => b.textContent === "开始复习",
    ),
    "撤回后仍可再练",
  );
  await click("编辑笔记");
  input("我的笔记", "私人备注");
  await settle();
  assert(f.dirty.value, "未标脏");
  f.app.unmount();
  assert(!f.dirty.value, "卸载残留草稿状态");
});
await run("逐次复习历史与显式采用规则日期，不补造早期记录", async () => {
  const f = await mount({ read: path => path.includes('/reviews?') ? {items:[{id:'event',ordinal:4,reviewed_on:day(),note:'真实第四次回顾',next_due_on:null}],next_cursor:null}:undefined });
  try {
    await click('查看复习历史'); assert(stage.textContent?.includes('真实第四次回顾')&&stage.textContent?.includes('不补造历史'),'缺少真实历史或边界说明');
    await click('收起历史'); await click('开始复习');
    const adopt=[...stage.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.startsWith('采用建议日期：'));assert(adopt&&!adopt.disabled,'未提供规则日期');adopt.click();await settle();
    const next=[...stage.querySelectorAll('label')].find(l=>l.textContent?.includes('下次复习日期'))?.querySelector<HTMLInputElement>('input');assert(next?.value&&next.value>day(),'未显式采用后续日期');
    assert(!f.calls.some(c=>c.body),'查看历史与采用日期不能自动写入');
  } finally { f.app.unmount(); }
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
