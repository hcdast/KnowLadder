import TrainingPhase2 from "../src/training/TrainingPhase2.vue";
import { createApp, h, nextTick, reactive } from "vue";
import GrowthWorkspace from "../src/training/GrowthWorkspace.vue";
import GrowthInbox from "../src/training/GrowthInbox.vue";
import { ApiError, type BusinessRequest } from "../src/session";
import "../src/styles.css";
const stage = document.querySelector<HTMLElement>("#stage")!,
  results: { name: string; passed: boolean; detail?: string }[] = [];
function assert(v: unknown, m: string): asserts v {
  if (!v) throw Error(m);
}
async function settle() {
  await nextTick();
  await new Promise((r) => setTimeout(r, 30));
  await nextTick();
}
const work = {
    id: "submission",
    source_id: "task",
    kind: "work",
    title: "观察作品",
    subject_id: "subject",
    class_id: "class",
    subject_name: "科学",
    at: "2026-10-16T08:00:00Z",
    verification: "teacher_feedback",
    body: "三个叶片的观察",
    submission_no: 2,
    feedback: { comments: "补充时间", score: 82 },
  },
  share = {
    _id: "share",
    revision: 1,
    label: "请教师指导",
    perspective: "owner",
    submission_ids: ["submission"],
    expires_at: "2026-10-20T08:00:00Z",
    revoked_at: null,
  },
  question = {
    _id: "question",
    revision: 1,
    title: "如何核验",
    body: "我重复计数",
    status: "open",
    messages: [],
    work_context: { task_id: "task", submission_id: "submission" },
  },
  notification = {
    _id: "notice",
    revision: 1,
    created_at: "2026-10-16T09:00:00Z",
    message: "教师已答复你的问题",
    event_kind: "question",
    read_at: null,
    target: { kind: "question", id: "question" },
  };
const empty = { items: [], next_cursor: null };
function base(p: string): any {
  if (p === "/training/studio/catalog")
    return { pairs: [{ subject_id: "subject", subject_name: "科学" }] };
  if (p.includes("/portfolio?")) return { ...empty, items: [work] };
  if (p.includes("/recipients?"))
    return {
      items: [{ member_id: "teacher", name: "观察教师" }],
      truncated: false,
    };
  if (p.includes("/shares?")) return { ...empty, items: [share] };
  if (p.endsWith("/shares/share")) return { share, items: [work] };
  if (p.includes("/inbox?")) return { ...empty, items: [notification] };
  if (p.endsWith("/preferences"))
    return { revision: 0, question: true, feedback: true, meetup: true };
  if (p.endsWith("/questions/question")) return question;
  return empty;
}
function req(fn: (p: string) => unknown): BusinessRequest {
  return async <T>(p: string) => (await fn(p)) as T;
}
async function mount(
  extra: Record<string, unknown> = {},
  component: any = GrowthWorkspace,
) {
  const props = reactive({
    contextKey: "a",
    caps: ["learning:self"],
    blocked: false,
    request: req(base),
    write: async () => undefined,
    ...extra,
  });
  const app = createApp({ render: () => h(component, props) });
  app.mount(stage);
  await settle();
  return {
    props,
    close() {
      app.unmount();
      stage.replaceChildren();
    },
  };
}
async function click(text: string) {
  const b = [...stage.querySelectorAll("button")].find(
    (x) => x.textContent?.trim() === text,
  );
  assert(b, "缺按钮 " + text);
  assert(!b.disabled, "按钮禁用 " + text);
  b.click();
  await settle();
}
function field(label: string) {
  const l = [...stage.querySelectorAll("label")].find(
    (x) =>
      x.firstChild?.textContent?.trim() === label ||
      x.textContent?.trim() === label,
  );
  assert(l, "缺字段 " + label);
  const e = l.querySelector<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >("input,select,textarea");
  assert(e, "缺控件");
  return e;
}
async function input(label: string, value: string, event = "input") {
  const e = field(label);
  e.value = value;
  e.dispatchEvent(new Event(event, { bubbles: true }));
  await settle();
}
async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (e) {
    results.push({ name, passed: false, detail: String(e) });
  }
}
await run("档案事实/核实标签和教师反馈独立显示，筛选应用真实字段", async () => {
  const calls: string[] = [];
  const f = await mount({
    request: req((p) => {
      calls.push(p);
      return base(p);
    }),
  });
  try {
    assert(
      stage.textContent?.includes("当前教师反馈已发布") &&
        stage.textContent?.includes("作品版本 2") &&
        stage.textContent?.includes("补充时间"),
      "事实展示缺失",
    );
    await input("创建时期起", "2026-10-01");
    await input("学习领域", "subject", "change");
    await click("应用档案筛选");
    assert(
      calls.some(
        (p) =>
          p.includes("from=2026-10-01") && p.includes("subject_id=subject"),
      ),
      "筛选未传",
    );
  } finally {
    f.close();
  }
});
await run(
  "指定分享只能使用勾选作品与教师，草稿阻止切页，成功后读取分享",
  async () => {
    const writes: any[] = [];
    const f = await mount({
      write: async (p: string, b: any) => {
        writes.push([p, b]);
        return share;
      },
    });
    try {
      const checkbox = stage.querySelector<HTMLInputElement>(
        "input[type=checkbox]",
      )!;
      checkbox.click();
      await settle();
      await input("分享说明", "核验实践");
      await input("指定授课教师", "teacher", "change");
      await input("到期时间（未来30天以内）", "2026-10-20T16:00");
      await click("学习通知");
      assert(stage.textContent?.includes("请先保存或明确放弃"), "草稿可丢弃");
      await click("确认选定范围并分享");
      assert(
        writes[0][1].submission_ids.join() === "submission" &&
          writes[0][1].recipient_member_id === "teacher",
        "分享范围错误",
      );
      assert(stage.textContent?.includes("我的分享"), "保存后未读分享");
    } finally {
      f.close();
    }
  },
);
await run(
  "具体作品提问携带版本定位，返回真实答疑并使用当前修订回复",
  async () => {
    const writes: any[] = [];
    let current: any = question;
    const f = await mount({
      request: req((p) =>
        p.endsWith("/questions/question") ? current : base(p),
      ),
      write: async (p: string, b: any) => {
        writes.push([p, b]);
        if (p.endsWith("/actions"))
          current = {
            ...current,
            revision: 2,
            status: "answered",
            messages: [{ _id: "m", role: "learner", body: b.body }],
          };
        return current;
      },
    });
    try {
      await click("针对这版作品提问");
      assert(
        document.activeElement === stage.querySelector('[tabindex="-1"]'),
        "提问焦点丢失",
      );
      await input("问题标题", "事实核验");
      await input("问题和已尝试的方法", "重复三次计数");
      await click("提交作品关联问题");
      assert(
        writes[0][1].submission_id === "submission" &&
          writes[0][1].class_id === "class",
        "作品来源缺失",
      );
      await input("回复与追问", "补充条件");
      await click("发送会话回复");
      assert(
        writes[1][1].expected_revision === 1 &&
          stage.textContent?.includes("补充条件"),
        "回复丢失或旧修订",
      );
    } finally {
      f.close();
    }
  },
);
await run("分享读取和撤回共用原写入口，撤回后清除详情", async () => {
  const writes: any[] = [];
  let revoked = false;
  const f = await mount({
    initialPage: "shares",
    request: req((p) =>
      p.includes("/shares?")
        ? {
            ...empty,
            items: [{ ...share, revoked_at: revoked ? "now" : null }],
          }
        : base(p),
    ),
    write: async (p: string, b: any) => {
      writes.push([p, b]);
      revoked = true;
      return { ...share, revoked_at: "now" };
    },
  });
  try {
    await click("读取这份分享");
    assert(stage.textContent?.includes("三个叶片的观察"), "分享未显示");
    stage.querySelector("details")!.open = true;
    await click("确认撤回分享");
    assert(
      writes[0][0].endsWith("/shares/share/revoke") &&
        writes[0][1].expected_revision === 1,
      "撤回合同错误",
    );
    assert(!stage.textContent?.includes("三个叶片的观察"), "撤回仍有正文");
  } finally {
    f.close();
  }
});
await run("通知偏好/CAS和未读筛选，查看来源先鉴权", async () => {
  const writes: any[] = [],
    calls: string[] = [],
    events: any[] = [];
  const f = await mount(
    {
      request: req((p) => {
        calls.push(p);
        return base(p);
      }),
      write: async (p: string, b: any) => {
        writes.push([p, b]);
        return { revision: 1, ...b };
      },
      onSource: (v: any) => events.push(v),
    },
    GrowthInbox,
  );
  try {
    const checkbox = field("答疑动态") as HTMLInputElement;
    checkbox.click();
    await settle();
    await click("保存通知偏好");
    assert(
      writes[0][1].question === false && writes[0][1].expected_revision === 0,
      "偏好未保存",
    );
    await click("标记这条已读");
    assert(writes[1][1].expected_revision === 1, "已读CAS缺失");
    await click("查看通知来源");
    assert(
      calls.some((p) => p.endsWith("/questions/question")) &&
        events[0].id === "question",
      "来源未核对",
    );
    (field("只看未读") as HTMLInputElement).click();
    await settle();
    assert(
      calls.some((p) => p.includes("unread=true")),
      "未读筛选未传",
    );
  } finally {
    f.close();
  }
});
await run("切身份时取消迟到请求并清空正文，来源撤权停止轮询", async () => {
  let release!: (v: unknown) => void;
  let f = await mount({
    request: req((p) =>
      p.includes("/portfolio?") ? new Promise((r) => (release = r)) : base(p),
    ),
  });
  try {
    f.props.contextKey = "b";
    f.props.request = req(() => ({ ...empty, pairs: [] }));
    await settle();
    release({ ...empty, items: [work] });
    await settle();
    assert(!stage.textContent?.includes("三个叶片的观察"), "迟到私有正文回填");
  } finally {
    f.close();
  }
  const original = window.setInterval;
  let tick = () => {},
    denied = false,
    calls = 0;
  window.setInterval = ((fn: TimerHandler) => {
    tick = fn as () => void;
    return 778801;
  }) as typeof window.setInterval;
  f = await mount({
    request: req((p) => {
      calls++;
      if (denied) throw new ApiError(403, "授权已结束");
      return base(p);
    }),
  });
  try {
    denied = true;
    tick();
    await settle();
    const n = calls;
    tick();
    await settle();
    assert(
      calls === n && !stage.textContent?.includes("三个叶片的观察"),
      "撤权未清空或还在重试",
    );
  } finally {
    f.close();
    window.setInterval = original;
  }
});
await run("未知写入保留草稿，回执确认后明确放弃才重读", async () => {
  let writes = 0;
  const f = await mount({
    write: async () => {
      writes++;
      return undefined;
    },
  });
  try {
    await click("针对这版作品提问");
    await input("问题标题", "我的未确认问题");
    await input("问题和已尝试的方法", "重复计数");
    await click("提交作品关联问题");
    f.props.recovered = { status: "confirmed" };
    await settle();
    assert(field("问题标题").value === "我的未确认问题", "回执吞草稿");
    stage.querySelector("details")!.open = true;
    await click("放弃本页草稿并重新读取");
    assert(
      writes === 1 && !stage.querySelector("textarea"),
      "重读重写或未清草稿",
    );
  } finally {
    f.close();
  }
});
await run(
  "导出使用完整受权服务结果，不直接下载当前首屏，正文保持纯文本",
  async () => {
    const calls: string[] = [];
    let downloads = 0;
    const old = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      downloads++;
    };
    const f = await mount({
      request: req((p) => {
        calls.push(p);
        if (p.includes("/portfolio/export?"))
          return {
            items: [work],
            count: 1,
            exported_at: new Date().toISOString(),
            filters: { kind: "work" },
          };
        return p.includes("/portfolio?")
          ? {
              ...empty,
              items: [{ ...work, body: "<img src=x onerror=alert(1)>" }],
            }
          : base(p);
      }),
    });
    try {
      assert(
        !stage.querySelector("img") &&
          stage.textContent?.includes("<img src=x"),
        "正文被渲染为HTML",
      );
      await click("导出当前筛选档案");
      assert(
        downloads === 1 &&
          calls.some((p) => p.includes("/portfolio/export?kind=work")),
        "只导出首屏或未重核",
      );
    } finally {
      f.close();
      HTMLAnchorElement.prototype.click = old;
    }
  },
);
await run("现有教务站内通知接入同一学习通知组件，并阻止丢弃偏好草稿",async()=>{
  const f=await mount({caps:["learning:self"],catalog:{classes:[],subjects:[],assignments:[]},userId:"student",receipt:null,growthEnabled:true,request:req(p=>p.startsWith("/training/phase2/")?empty:base(p)),write:async()=>({revision:1})},TrainingPhase2);
  try{await click("站内通知");assert(stage.textContent?.includes("接收哪些学习动态"),"原通知页未接新动态");(field("答疑动态") as HTMLInputElement).click();await settle();await click("课表与考勤");assert(stage.textContent?.includes("请先保存当前表单，再切换功能"),"原教务页丢弃偏好");await click("保存通知偏好");await click("课表与考勤");assert(!stage.querySelector(".growth-inbox"),"学习通知错误显示在其他教务页");}finally{f.close();}
});
document.querySelector<HTMLElement>("#results")!.textContent = JSON.stringify(
  {
    passed: results.filter((x) => x.passed).length,
    failed: results.filter((x) => !x.passed).length,
    results,
  },
  null,
  2,
);
document.querySelector<HTMLElement>("#results")!.dataset.complete = "true";
