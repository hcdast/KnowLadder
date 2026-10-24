import { createApp, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import PersonalWorkspace from "../src/personal/PersonalWorkspace.vue";
import {
  ApiError,
  type GlobalRequest,
  type Identity,
  type BusinessOptions,
} from "../src/session";
const stage = document.querySelector<HTMLElement>("#stage")!;
const output = document.querySelector<HTMLElement>("#results")!;
const results: { name: string; passed: boolean; message?: string }[] = [];
const user = "111111111111111111111111",
  goalId = "222222222222222222222222",
  activityId = "333333333333333333333333",
  relationId = "444444444444444444444444";
const identity = {
  user: { id: user, login_name: "isolated", display_name: "隔离学习者" },
  organizations: [],
  context: null,
  must_change_password: false,
} as unknown as Identity;
const goal = {
  id: goalId,
  title: "具体的学习目标",
  stage: "school",
  field: "science",
  outcome: "记录事实",
  due_on: null,
  state: "active",
  template_id: null,
  revision: 1,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};
const activity = {
  id: activityId,
  goal_id: goalId,
  kind: "reading",
  title: "明确选定的活动",
  note: "仅供当前关系读取的自述",
  reflection: "我的下一步",
  occurred_on: "2026-10-15",
  minutes: 10,
  evidence: "self_reported",
  revision: 1,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};
const relation = {
  id: relationId,
  label: "学习伙伴",
  perspective: "supporter",
  scopes: ["activities", "feedback"],
  goal_ids: [],
  activity_ids: [activityId],
  basis: "adult_self_consent",
  state: "active",
  expires_at: "2090-01-01T00:00:00Z",
  invite_expires_at: "2090-01-01T00:00:00Z",
  revision: 2,
};
const storageKey = `personal-recovery:${user}`;
function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
async function settle() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
    await nextTick();
  }
}
async function click(text: string) {
  const button = [...stage.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  assert(button, `缺少按钮:${text}`);
  assert(!button.disabled, `按钮不可用:${text}`);
  button.click();
  await settle();
}
function input(label: string, value: string) {
  const element = [...stage.querySelectorAll("label")]
    .find((l) => l.textContent?.trim() === label)
    ?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea");
  assert(element, `缺少输入:${label}`);
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  return element;
}
async function run(name: string, work: () => Promise<void>) {
  try {
    sessionStorage.removeItem(storageKey);
    await work();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({
      name,
      passed: false,
      message: error instanceof Error ? error.message : "失败",
    });
  } finally {
    stage.replaceChildren();
    sessionStorage.removeItem(storageKey);
  }
}
function request(
  custom: (path: string, options: BusinessOptions) => unknown = () => undefined,
): GlobalRequest {
  return async <T>(path: string, options: BusinessOptions = {}) => {
    const override = await custom(path, options);
    if (override !== undefined) return override as T;
    if (path === "/personal/capabilities")
      return {
        enabled: true,
        adult_admitted: true,
        support_basis: "explicit_selected_records",
        guardian_basis: "independent_institutional_review",
        templates: [],
      } as T;
    if (path.startsWith("/personal/goals?"))
      return { items: [goal], next_cursor: null } as T;
    if (path.startsWith("/personal/agenda?")) return {items:[],next_cursor:null} as T;
    if (path.startsWith("/personal/week-overview?")) return {week_start:"2026-10-12",week_end:"2026-10-18",as_of:"2026-10-15",total:0,completed:0,paused:0,cancelled:0,overdue:0,planned_minutes:0,truncated:false,review:null} as T;
    if (path === "/personal/courses") return { items: [] } as T;
    if (path.startsWith("/personal/study-items?"))
      return { items: [], next_cursor: null } as T;
    if (path.startsWith("/personal/activities?"))
      return { items: [activity], next_cursor: null } as T;
    if (/^\/personal\/(feedback|supports|assurances)\?/.test(path))
      return { items: [], next_cursor: null } as T;
    throw Error(`未定义请求:${path}`);
  };
}
async function mount(
  req: GlobalRequest,
  onDirty: (value: boolean) => void = () => {},
) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: ["/personal", "/privacy", "/training"].map((path) => ({
      path,
      component: { render: () => null },
    })),
  });
  await router.push("/personal");
  const app = createApp(PersonalWorkspace, {
    identity,
    request: req,
    onDirty,
  }).use(router);
  const vm = app.mount(stage) as unknown as {
    beforeLeave: () => Promise<boolean>;
  };
  await settle();
  return Object.assign(() => app.unmount(), {
    beforeLeave: () => vm.beforeLeave(),
  });
}
await run("未开放环境只查询本人能力，不探测私人记录", async () => {
  const calls: string[] = [],
    close = await mount(
      request((path) => {
        calls.push(path);
        if (path.endsWith("capabilities"))
          return { enabled: false, adult_admitted: false, templates: [] };
      }),
    );
  try {
    assert(
      calls.length === 1 && stage.textContent?.includes("尚未开放"),
      "关闭环境仍读取私人记录或没有真实状态",
    );
  } finally {
    close();
  }
});
await run(
  "零组织真实组件可显示个人目标，证据与当前统计有明确范围",
  async () => {
    const close = await mount(request());
    try {
      await click("我的目标");
      assert(stage.textContent?.includes(goal.title), "零组织目标不可见");
      await click("成长档案");
      assert(
        stage.textContent?.includes("已加载的 1 条活动") &&
          stage.textContent?.includes("不据此计算统一掌握度"),
        "档案冒充全量或正式成绩",
      );
    } finally {
      close();
    }
  },
);
await run("超时先保留原编号且不存正文，查询applied后才解锁", async () => {
  let captured = "",
    submitted = 0;
  const close = await mount(
    request((path, options) => {
      if (path === "/personal/goals") {
        captured = options.idempotencyKey!;
        submitted++;
        assert(
          sessionStorage.getItem(storageKey) === captured,
          "写入前未保存恢复编号",
        );
        throw new ApiError(503, "隔离回包丢失");
      }
      if (path.startsWith("/personal/operations/"))
        return {
          state: "applied",
          operation_id: goalId,
          resource_id: goalId,
          revision: 1,
        };
    }),
  );
  try {
    await click("我的目标");
    input("目标名称", "不应进入浏览器存储的正文");
    stage
      .querySelector(".personal-columns form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    assert(
      captured &&
        sessionStorage.getItem(storageKey) === captured &&
        !sessionStorage.getItem(storageKey)?.includes("正文"),
      "恢复编号丢失或存储正文",
    );
    assert(
      stage.textContent?.includes("先确认上一次提交"),
      "未知结果未阻止新提交",
    );
    await click("查询原结果");
    assert(
      !sessionStorage.getItem(storageKey) && submitted === 1,
      "恢复重复写入或没有解锁",
    );
  } finally {
    close();
  }
});
await run("重挂载仅有编号仍可服务端终止，404查询不会自行重发", async () => {
  const key = crypto.randomUUID();
  sessionStorage.setItem(storageKey, key);
  let cancelled = false,
    writes = 0;
  const close = await mount(
    request((path, options) => {
      if (path === `/personal/operations/${key}`)
        throw new ApiError(404, "未找到收据");
      if (path === `/personal/operations/${key}/cancel`) {
        assert(
          options.idempotencyKey === key && options.method === "POST",
          "终止未绑定原编号",
        );
        cancelled = true;
        return {
          state: "cancelled",
          operation_id: goalId,
          resource_id: user,
          revision: 1,
        };
      }
      if (options.method === "POST") writes++;
    }),
  );
  try {
    await click("查询原结果");
    assert(
      sessionStorage.getItem(storageKey) === key && writes === 0,
      "把404误当原写未发生",
    );
    await click("终止未完成请求");
    assert(
      cancelled && !sessionStorage.getItem(storageKey),
      "原请求没有安全终止",
    );
  } finally {
    close();
  }
});
await run("恢复存储损坏时拒绝新写入，不能清空后默默重试", async () => {
  sessionStorage.setItem(storageKey, "invalid key");
  const close = await mount(request());
  try {
    await click("我的目标");
    assert(
      stage.textContent?.includes("先确认上一次提交") &&
        stage.querySelector<HTMLFieldSetElement>("form fieldset")?.disabled,
      "存储故障仍允许写入",
    );
  } finally {
    close();
  }
});
await run("家庭支持不能由无成年准入或缺少核验关系的账号自行开启", async () => {
  const close = await mount(
    request((path) =>
      path.endsWith("capabilities")
        ? { enabled: true, adult_admitted: false, templates: [] }
        : undefined,
    ),
  );
  try {
    await click("家人与伙伴");
    assert(
      !stage.textContent?.includes("接受成年人的学习邀请") &&
        stage.textContent?.includes("没有可用的关系核验"),
      "未成年人/未知身份可自行接受支持授权",
    );
  } finally {
    close();
  }
});
await run("定时重读保留反馈编辑焦点，撤权失败清空所有共享正文", async () => {
  const originalInterval = window.setInterval;
  let check: (() => unknown) | undefined;
  window.setInterval = ((
    handler: TimerHandler,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (ms === 30000 && typeof handler === "function") {
      check = () => handler(...args);
      return 0;
    }
    return originalInterval(handler, ms, ...args);
  }) as typeof window.setInterval;
  let deny = false;
  const close = await mount(
    request((path) => {
      if (path.startsWith("/personal/supports?"))
        return { items: [relation], next_cursor: null };
      if (path.endsWith("/records")) {
        if (deny) throw new ApiError(404, "支持已撤回");
        return {
          relation,
          goals: [],
          activities: [activity],
          feedback: [],
          feedback_truncated: false,
        };
      }
    }),
  );
  try {
    await click("家人与伙伴");
    await click("查看当前可读记录");
    const field = input("具体观察与建议", "正在编辑的建议");
    field.focus();
    assert(check, "未设置周期核对");
    await check();
    await settle();
    assert(
      document.activeElement === field && field.value === "正在编辑的建议",
      "定时核对丢失输入焦点或草稿",
    );
    deny = true;
    await check();
    await settle();
    assert(!stage.textContent?.includes(activity.note), "撤回后共享正文仍展示");
  } finally {
    close();
    window.setInterval = originalInterval;
  }
});
await run("保存活动不清除另一页目标草稿和离开保护", async () => {
  let dirty = false;
  const close = await mount(
    request((path, options) =>
      options.method === "POST" && path === "/personal/activities"
        ? { operation_id: activityId, resource_id: activityId, revision: 1 }
        : undefined,
    ),
    (value) => {
      dirty = value;
    },
  );
  try {
    await click("我的目标");
    input("目标名称", "需要保留的目标草稿");
    await click("学习与实践");
    input("活动名称", "独立保存活动");
    stage
      .querySelector(".personal-columns form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    await click("我的目标");
    assert(dirty, "仍有目标草稿却取消了离开保护");
    assert(
      stage.querySelector<HTMLInputElement>(".personal-columns form input")
        ?.value === "需要保留的目标草稿",
      "无关写入丢失目标草稿",
    );
  } finally {
    close();
  }
});
await run("409冲突保留原编号，必须查询或终止后才允许新提交", async () => {
  let key = "";
  const close = await mount(
    request((path, options) => {
      if (path === "/personal/goals") {
        key = options.idempotencyKey!;
        throw new ApiError(409, "原编号结果冲突");
      }
    }),
  );
  try {
    await click("我的目标");
    input("目标名称", "保留冲突恢复");
    stage
      .querySelector(".personal-columns form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    assert(
      key &&
        sessionStorage.getItem(storageKey) === key &&
        stage.textContent?.includes("先确认上一次提交"),
      "409丢失原编号或允许盲目新写",
    );
  } finally {
    close();
  }
});
await run(
  "个人学习离开保护使用页面内确认，取消保留草稿且确认后才离开",
  async () => {
    let currentDirty = false;
    const close = await mount(request(), (value) => {
      currentDirty = value;
    });
    try {
      await click("我的目标");
      input("目标名称", "不丢失我的学习草稿");
      await settle();
      const pending = close.beforeLeave();
      await settle();
      assert(
        stage.querySelector('[role="alertdialog"]') &&
          document.activeElement?.textContent?.trim() === "继续当前学习",
        "未展示确认或初始焦点错误",
      );
      await click("继续当前学习");
      assert((await pending) === false, "取消没有阻止离开");
      assert(
        stage.querySelector<HTMLInputElement>(
          '.personal-columns input[maxlength="120"]',
        )?.value === "不丢失我的学习草稿",
        "取消后草稿丢失",
      );
      const next = close.beforeLeave();
      await settle();
      await click("确认离开");
      assert(
        (await next) === true && !stage.querySelector('[role="alertdialog"]'),
        "确认没有完成或弹窗残留",
      );
    } finally {
      close();
    }
    assert(!currentDirty, "离开个人空间后遗留草稿标记阻止其他工作区导航");
  },
);
await run(
  "笔记回包丢失：保留正文草稿与原编号，回执恢复不重复写入",
  async () => {
    let submitted = 0,
      key = "";
    const close = await mount(
      request((path, options) => {
        if (path === "/personal/study-items") {
          submitted++;
          key = options.idempotencyKey!;
          throw new ApiError(503, "隔离笔记回包丢失");
        }
        if (path.startsWith("/personal/operations/"))
          return {
            state: "applied",
            operation_id: goalId,
            resource_id: activityId,
            revision: 1,
          };
      }),
    );
    try {
      await click("笔记与复习");
      input("笔记标题", "只保存在服务端的笔记标题");
      input("我的笔记", "需要保留的私人草稿");
      await settle();
      stage
        .querySelector(".study-form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      await settle();
      assert(
        key && sessionStorage.getItem(storageKey) === key,
        "未保留笔记请求编号",
      );
      assert(
        stage.querySelector<HTMLTextAreaElement>(".study-form textarea")
          ?.value === "需要保留的私人草稿",
        "未知结果清空笔记",
      );
      assert(
        !sessionStorage.getItem(storageKey)?.includes("私人草稿"),
        "浏览器恢复记录包含正文",
      );
      await click("查询原结果");
      assert(
        submitted === 1 && !sessionStorage.getItem(storageKey),
        "回执恢复重复写入或仍未解锁",
      );
      assert(
        stage.querySelector<HTMLTextAreaElement>(".study-form textarea")
          ?.value === "",
        "确认成功后未清理笔记草稿",
      );
    } finally {
      close();
    }
  },
);
await run("周计划回包丢失：原键恢复只清安排草稿，保留独立周回顾", async () => {
  let submitted=0,key='';
  const close=await mount(request((path,options)=>{
    if(path==='/personal/agenda'){submitted++;key=options.idempotencyKey!;throw new ApiError(503,'隔离安排回包丢失');}
    if(path.startsWith('/personal/operations/'))return {state:'applied',operation_id:goalId,resource_id:activityId,revision:1};
  }));
  try {
    await click('周计划');input('安排标题','原键恢复的安排');input('本周收获','独立周回顾草稿');await settle();
    stage.querySelector('.week-planner form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await settle();
    assert(key&&sessionStorage.getItem(storageKey)===key,'未保留安排原键');
    const title=stage.querySelector<HTMLInputElement>('.week-planner input[maxlength="120"]');assert(title?.value==='原键恢复的安排','未知请求清安排草稿');
    await click('查询原结果');assert(submitted===1&&!sessionStorage.getItem(storageKey),'恢复重复写或未解锁');assert(title.value==='','确认applied后未清安排草稿');
    const review=[...stage.querySelectorAll('label')].find(l=>l.firstChild?.textContent?.trim()==='本周收获')?.querySelector('textarea');assert(review?.value==='独立周回顾草稿','恢复安排误清周回顾');
  } finally {close();}
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
