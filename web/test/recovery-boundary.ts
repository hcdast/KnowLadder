import { createApp, nextTick } from "vue";
import { createRouter, createMemoryHistory } from "vue-router";
import Teacher from "../src/teaching/TeacherWorkspace.vue";
import Learning from "../src/learning/LearningWorkspace.vue";
import Attachments from "../src/training/CourseworkAttachments.vue";
import Training from "../src/training/TrainingWorkspace.vue";
import { ApiError } from "../src/session";
import "../src/styles.css";
const ids = {
  user: "111111111111111111111111",
  org: "222222222222222222222222",
  clazz: "333333333333333333333333",
  subject: "444444444444444444444444",
  question: "555555555555555555555555",
  resource: "666666666666666666666666",
  session: "777777777777777777777777",
};
const stage = document.querySelector("#stage")!;
const output = document.querySelector("#results")!;
let entries: { name: string; passed: boolean; detail: string }[] = [];
const assert = (ok: unknown, text: string) => {
  if (!ok) throw Error(text);
};
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
};
const identity = (capabilities: string[]) => ({
  user: { id: ids.user },
  context: { org_id: ids.org, capabilities },
  must_change_password: false,
});
const keys = [
  "learning-recovery:",
  "assessment-recovery:",
  "teaching-quiz-recovery:",
  "kl-training:",
].map((p) => p + ids.user + ":" + ids.org);
function clean() {
  keys.forEach((k) => sessionStorage.removeItem(k));
}
async function mounted(
  component: any,
  caps: string[],
  request: any,
  fn: (s: any) => Promise<void>,
  extra: Record<string,unknown> = {},
) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:pathMatch(.*)*", component: { template: "<div />" } }],
  });
  await router.push("/training");
  const app = createApp(component, { identity: identity(caps), request, ...extra }).use(
    router,
  );
  const vm = app.mount(stage) as any;
  try {
    await settle();
    await fn(vm.$.setupState);
  } finally {
    app.unmount();
    clean();
  }
}
async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    entries.push({ name, passed: true, detail: "PASS" });
  } catch (e) {
    entries.push({
      name,
      passed: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }
  output.textContent = JSON.stringify(
    {
      passed: entries.filter((e) => e.passed).length,
      failed: entries.filter((e) => !e.passed).length,
      entries,
    },
    null,
    2,
  );
}
async function main() {
  entries = [];
  clean();
  const button = document.querySelector("#run") as HTMLButtonElement;
  button.disabled = true;
  const teacherCaps = [
    "teaching:class",
    "teaching:report",
    "assessment:manage",
  ];
  const clazz = {
    id: ids.clazz,
    name: "合成边界班级",
    year_label: "2026",
    revision: 1,
  };
  const reject =
    (calls: any[]) =>
    async (path: string, options: any = {}) => {
      calls.push({ path, options });
      throw Error("BOUNDARY_REQUEST_REJECTED");
    };
  await run("R08-1 教师24hex学科报告到达请求边界", async () => {
    const calls: any[] = [];
    await mounted(Teacher, teacherCaps, reject(calls), async (s) => {
      s.selectedClass = clazz;
      s.subjectId = ids.subject;
      await s.loadClassReport();
      assert(
        calls.some((c) =>
          c.path.includes("/subjects/" + ids.subject + "/report"),
        ),
        "未发出正确报告请求",
      );
      assert(!stage.textContent?.includes("学科 UUID"), "仍被UUID规则拒绝");
    });
  });
  await run("R08-2 教师24hex学科通过出卷校验", async () => {
    const calls: any[] = [];
    await mounted(Teacher, teacherCaps, reject(calls), async (s) => {
      s.selectedClass = clazz;
      s.startQuizFromClass();
      s.quizSubject = ids.subject;
      s.quizItems = "bad-id";
      await s.createQuizDraft();
      assert(
        String(s.error).includes("题目版本编号"),
        "学科未通过，未进入题目版本校验",
      );
      assert(!calls.some((c) => c.path === "/quizzes"), "非法题目版本被发送");
    });
  });
  await run("R08-3 教师24hex题目版本到达出卷请求边界", async () => {
    const calls: any[] = [];
    await mounted(Teacher, teacherCaps, reject(calls), async (s) => {
      s.selectedClass = clazz;
      s.startQuizFromClass();
      s.quizSubject = ids.subject;
      s.quizItems = ids.question;
      await s.createQuizDraft();
      const c = calls.find((c) => c.path === "/quizzes");
      assert(
        c?.options.body.items[0].question_version_id === ids.question,
        "题目版本未进入真实处理器请求",
      );
      assert(s.pending?.key === c.options.idempotencyKey, "网络拒绝后原键丢失");
    });
  });
  await run("R08-4 学习24hex推荐卡恢复及原键重放", async () => {
    const key = "boundary-recommendation-key";
    sessionStorage.setItem(
      keys[0],
      JSON.stringify({
        operation: "learning.recommendation.practice",
        resource: ids.resource,
        key,
      }),
    );
    const calls: any[] = [];
    await mounted(Learning, ["learning:self"], reject(calls), async (s) => {
      assert(
        !s.storageBlocked && s.pending?.resource === ids.resource,
        "推荐恢复被拦截",
      );
      await s.replay();
      const c = calls.find(
        (c) =>
          c.path ===
          "/me/recommendations/" + ids.resource + "/practice-sessions",
      );
      assert(c?.options.idempotencyKey === key, "重放没有保持原键");
      assert(s.pending?.key === key, "拒绝后恢复键丢失");
    });
  });
  await run("R08-5 学习24hex测评会话恢复", async () => {
    sessionStorage.setItem(
      keys[1],
      JSON.stringify({
        user: ids.user,
        org: ids.org,
        operation: "session.submit",
        session_id: ids.session,
        path: "/sessions/" + ids.session + "/submissions",
        method: "POST",
        key: "boundary-submit-key",
      }),
    );
    const calls: any[] = [];
    await mounted(Learning, ["learning:self"], reject(calls), async (s) => {
      assert(s.selectedSession === ids.session, "未恢复原会话");
      assert(stage.textContent?.includes("已恢复原测评会话"), "缺少恢复提示");
      assert(
        calls.some((c) => c.path === "/sessions/" + ids.session),
        "未查询原会话",
      );
    });
  });
  await run("教师报告404清空名册和报告", async () => {
    await mounted(
      Teacher,
      teacherCaps,
      async () => {
        throw new ApiError(404, "不可访问");
      },
      async (s) => {
        s.denied = false;
        s.selectedClass = clazz;
        s.subjectId = ids.subject;
        s.roster = { items: [{ display_name: "失权后不得保留" }] };
        s.classReport = { private: "旧报告" };
        await s.loadClassReport();
        assert(
          s.denied && !s.roster && !s.classReport && !s.selectedClass,
          "失权视图未清空",
        );
        assert(!stage.textContent?.includes("失权后不得保留"), "残留名册");
      },
    );
  });
  for (const code of [
    "IDEMPOTENCY_CONFLICT",
    "IDEMPOTENCY_RESULT_INVALID",
    "IDENTITY_CHANGED",
  ])
    await run("培训不确定409保留原键 " + code, async () => {
      let writeKey = "";
      await mounted(
        Training,
        ["course:edit"],
        async (_p: string, o: any = {}) => {
          if (o.method === "POST") {
            writeKey = o.idempotencyKey;
            throw new ApiError(409, "受理待核查", {}, "", "", code);
          }
          throw Error("BOUNDARY_REQUEST_REJECTED");
        },
        async (s) => {
          await s.write("/training/courses", { title: "合成草稿" });
          assert(
            s.pending?.key === writeKey && !!writeKey,
            "不确定409清除了原键",
          );
          assert(
            JSON.parse(sessionStorage.getItem(keys[3])!).key === writeKey,
            "原键未持久保留",
          );
        },
      );
    });
  await run("培训AI来源409清空旧正文", async () => {
    await mounted(
      Training,
      ["ai:generate"],
      async (p: string) => {
        if (p.includes("/ai/jobs/"))
          throw new ApiError(409, "来源变化", {}, "", "", "CONTEXT_CHANGED");
        throw Error("BOUNDARY_REQUEST_REJECTED");
      },
      async (s) => {
        s.aiJob = {
          id: ids.resource,
          status: "succeeded",
          output: "失权旧正文",
        };
        s.acceptBody = "失权旧正文";
        await s.queryAi();
        assert(!s.aiJob && !s.acceptBody, "旧AI结果仍显示");
      },
    );
  });
  await run("培训失权后的迟到读取不能回填", async () => {
    let release: any;
    const old = new Promise((r) => (release = r));
    await mounted(
      Training,
      ["ai:generate"],
      async (p: string) => {
        if (p.endsWith("/" + ids.resource)) return old;
        if (p.endsWith("/" + ids.question)) throw new ApiError(404, "不可访问");
        throw Error("BOUNDARY_REQUEST_REJECTED");
      },
      async (s) => {
        const first = s.selectAi(ids.resource);
        await settle();
        await s.selectAi(ids.question);
        release({
          id: ids.resource,
          output: "迟到旧正文",
          status: "succeeded",
        });
        await first;
        assert(!s.aiJob && !s.acceptBody, "迟到结果恢复了失权正文");
      },
    );
  });
  await run("培训确定422允许修正后新请求", async () => {
    await mounted(
      Training,
      ["course:edit"],
      async (_p: string, o: any = {}) => {
        if (o.method === "POST") throw new ApiError(422, "字段无效");
        throw Error("BOUNDARY_REQUEST_REJECTED");
      },
      async (s) => {
        await s.write("/training/courses", { title: "" });
        assert(!s.pending, "确定输入拒绝仍冻结");
      },
    );
  });
  await run("教师恢复元数据拒绝非法键和额外正文", async () => {
    sessionStorage.setItem(
      keys[2],
      JSON.stringify({
        path: "/quizzes",
        method: "POST",
        key: { bad: true },
        body: "不应加载",
      }),
    );
    await mounted(Teacher, teacherCaps, reject([]), async (s) => {
      assert(s.storageBlocked && !s.pending, "非法恢复元数据被接受");
    });
  });
  await run("培训恢复元数据拒绝额外正文", async () => {
    sessionStorage.setItem(
      keys[3],
      JSON.stringify({
        path: "/training/courses",
        key: "boundary-extra-key",
        hash: "a".repeat(64),
        body: "不应加载",
      }),
    );
    await mounted(Training, ["course:edit"], reject([]), async (s) => {
      assert(s.storageBlocked && !s.pending, "额外正文被恢复");
    });
  });
  await run("培训周期复核AI来源变化清空正文", async () => {
    await mounted(
      Training,
      ["ai:generate"],
      async (p: string) => {
        if (p.includes("/ai/jobs/"))
          throw new ApiError(409, "来源变化", {}, "", "", "CONTEXT_CHANGED");
        throw Error("BOUNDARY_REQUEST_REJECTED");
      },
      async (s) => {
        s.aiJob = {
          id: ids.resource,
          status: "succeeded",
          output: "周期复核旧正文",
        };
        s.acceptBody = "周期复核旧正文";
        await s.recheck();
        assert(!s.aiJob && !s.acceptBody, "周期复核未清空旧正文");
      },
    );
  });
  await run("作业截止相等只读且不发送写入", async () => {
    const calls: any[] = [];
    await mounted(Training, ["learning:self"], reject(calls), async (s) => {
      s.tab = "tasks";
      s.work = {
        task: {
          _id: ids.resource,
          title: "截止验收",
          due_at: "2026-10-02T00:00:00Z",
        },
        head: null,
        feedback: [],
        server_now: "2026-10-02T00:00:00Z",
      };
      s.syncWorkClock();
      s.draft = "截止后的正文";
      await settle();
      assert(s.workExpired, "截止相等未锁定");
      assert(stage.querySelector("textarea")?.readOnly, "正文未只读");
      calls.length = 0;
      await s.saveWork("submit");
      assert(calls.length === 0, "截止仍发送写入");
      s.work.server_now = "2026-10-01T23:59:59Z";
      s.syncWorkClock();
      assert(!s.workExpired, "截止前错误锁定");
    });
  });
  await run("任务取消须确认且作业状态区分反馈", async () => {
    const calls: any[] = [];
    await mounted(Training, ["task:manage"], reject(calls), async (s) => {
      calls.length = 0;
      await s.taskAction({ _id: ids.resource, revision: 1 }, "cancel");
      assert(
        calls.length === 0 && s.cancelTaskConfirm === ids.resource,
        "未确认即发送取消",
      );
      await s.taskAction({ _id: ids.resource, revision: 1 }, "cancel");
      assert(
        calls.length === 1 && calls[0].options.body.action === "cancel",
        "确认未调用原接口",
      );
      s.work = { task: {}, head: null, feedback: [] };
      assert(s.workStatus === "尚未提交", "未提交状态错误");
      s.work.head = { current_submission_id: null };
      assert(s.workStatus === "草稿未提交", "草稿状态错误");
      s.work.head.current_submission_id = ids.resource;
      assert(s.workStatus === "已提交，待教师批阅", "待批状态错误");
      s.work.feedback = [{ score: 90 }];
      assert(s.workStatus === "已收到教师反馈", "反馈状态错误");
    });
  });
  await run("附件丢响应仅存声明原key并刷新恢复", async () => {
    const scope = 'kl-work-files:'+ids.user+':'+ids.org+':'+ids.resource;
    sessionStorage.removeItem(scope);
    const calls:any[]=[];
    const file=new File(['原创附件测试'], '原创.txt', {type:'text/plain'});
    const props={taskId:ids.resource,revision:2,selected:[],disabled:false};
    try {
      await mounted(Attachments,['learning:self'],reject(calls),async s=>{
        calls.length=0;
        await s.select({target:{files:[file],value:''}});
        assert(calls.filter(c=>c.options.method==='POST').length===1 && calls[0].path.endsWith('/files'), '未到登记请求边界');
        const saved=JSON.parse(sessionStorage.getItem(scope)||'null');
        assert(saved?.key===calls[0].options.idempotencyKey && saved.declaration.checksum.length===64,'未保存原key');
        assert(!('body' in saved)&&!('body' in saved.declaration),'保存了附件正文');
      },props);
      const original=JSON.parse(sessionStorage.getItem(scope)||'null').key;
      await mounted(Attachments,['learning:self'],reject(calls),async s=>{
        calls.length=0;
        await s.select({target:{files:[file],value:''}});
        assert(calls.filter(c=>c.options.method==='POST').length===1&&calls[0].options.idempotencyKey===original,'刷新换key重发');
      },props);
    } finally {sessionStorage.removeItem(scope);}
  });
  await run("附件非法恢复元数据冻结", async () => {
    const scope='kl-work-files:'+ids.user+':'+ids.org+':'+ids.resource;
    sessionStorage.setItem(scope,JSON.stringify({key:'bad',id:null,declaration:{body:'不应恢复'}}));
    try{await mounted(Attachments,['learning:self'],reject([]),async s=>{assert(s.storageBlocked&&!s.pending,'非法恢复未冻结');}, {taskId:ids.resource,revision:2,selected:[],disabled:false});}
    finally{sessionStorage.removeItem(scope);}
  });
  button.disabled = false;
  clean();
}
document.querySelector("#run")!.addEventListener("click", async () => {
  output.textContent = "正在运行组件验收…";
  try {
    await main();
  } catch (e) {
    output.textContent =
      "验收入口异常：" + (e instanceof Error ? e.message : String(e));
  }
});

(document.querySelector("#run") as HTMLButtonElement).disabled = false;

void main().catch((e) => {
  output.textContent =
    "验收入口异常：" + (e instanceof Error ? e.message : String(e));
});
