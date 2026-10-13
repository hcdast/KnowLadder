import { availableWorkspaces, canUseStudentLearning, createEntryCoordinator, parseReturnTo, readPreference, targetAllowed, writePreference } from "../src/auth/entry";
import type { Identity } from "../src/session";
import type { ConsoleContext } from "../src/administration/types";
import { createApp, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import TrainingWorkspace from "../src/training/TrainingWorkspace.vue";
import { ApiError, type BusinessRequest } from "../src/session";
const user = "111111111111111111111111", other = "222222222222222222222222", org = "333333333333333333333333";
const identity = (caps: string[], userId = user): Identity => ({ user: { id: userId, login_name: "boundary", display_name: "边界" }, organizations: [{ id: org, name: "边界组织", kind: "school" }], context: { org_id: org, member_id: "444444444444444444444444", capabilities: caps, student_conflict: false }, must_change_password: false } as Identity);
const consoleContext = { actor_org_id: org, menus: ["users", "business"], capabilities: ["account:manage", "assessment:manage"], grants: [] } as unknown as ConsoleContext;
const results: { name: string; passed: boolean; detail?: string }[] = [];
function assert(ok: unknown, message: string) { if (!ok) throw Error(message); }
function run(name: string, behavior: () => void) {
  try { behavior(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) }); }
}
run("逐路由白名单拒绝外部、编码绕过、token、未知query与重复值", () => {
  for (const value of ["https://evil.invalid/content", "//evil.invalid/content", "/%2f%2fevil.invalid", "/content#token", "/auth/reset?token=x", "/unknown", "/training?tab=constructor", "/training?tab=courses&tab=tasks", "/training?tab=%2563ourses", "/content?returnTo=/learning", "/console/users/new?password=x", "/training?tab=%2fcourses", "/console/users/../organizations", "/content?token=secret"])
    assert(parseReturnTo(value) === undefined, `未拒绝 ${value}`);
  assert(parseReturnTo("/training?tab=tasks") === "/training?tab=tasks", "培训tab未保留");
  assert(parseReturnTo(`/console/authorizations/new?user_id=${user}&member_id=${other}`)?.includes(`user_id=${user}`), "真实管理预选目标被拒绝");
});
run("首次匿名意图在安全步骤后重新判权", () => {
  const coordinator = createEntryCoordinator();
  coordinator.capture("/training?tab=tasks");
  const actor = identity(["site:edit"]);
  actor.must_change_password = true;
  assert(!coordinator.decide(actor, null).target, "绕过首次改密");
  actor.must_change_password = false;
  assert(coordinator.decide(actor, null).target === "/training?tab=tasks", "安全步骤吞掉匿名合法意图");
  const denied = createEntryCoordinator(); denied.capture("/teaching");
  assert(denied.decide(actor, null).denied, "登录后未重新判权");
});
run("已知旧账号绑定目标；换账号丢弃资源意图", () => {
  const coordinator = createEntryCoordinator();
  coordinator.identify(identity(["learning:self"]));
  coordinator.capture(`/console/users/${user}`);
  assert(coordinator.decide(identity(["site:edit"], other), consoleContext).target === "/training", "换号仍恢复原资源");
});
run("普通业务入口不等待ConsoleContext，只有实际管理候选需要它", () => {
  const actor = identity(["learning:self", "ai:assist"]);
  const coordinator = createEntryCoordinator();
  const preference = { orgId: org, workspace: "/console/overview" as const };
  assert(!coordinator.needsManagementContext(actor, "/learning", preference, false), "业务页面被管理偏好阻塞");
  assert(!coordinator.needsManagementContext(actor, "/home", undefined, true), "默认有权业务需要管理接口");
  coordinator.capture("/training?tab=tasks");
  assert(!coordinator.needsManagementContext(actor, "/login", preference, true), "原业务意图被管理偏好阻塞");
  assert(coordinator.decide(actor, null, preference).target === "/training?tab=tasks", "普通意图未在无管理响应时落地");
  assert(coordinator.needsManagementContext(actor, "/home", preference, true), "当前组织管理偏好未等待实时菜单");
  coordinator.capture(`/console/users/${user}`);
  assert(coordinator.needsManagementContext(actor, "/login", undefined, true), "管理原目标未等待实时菜单");
  assert(!createEntryCoordinator().needsManagementContext(actor, "/home", { orgId: other, workspace: "/console/overview" }, true), "跨组织偏好阻塞普通入口");
});
run("换号等待组织期间不得重捕获旧URL，确认组织后使用新账号业务默认", () => {
  const coordinator = createEntryCoordinator();
  coordinator.identify(identity(["teaching:class"]));
  coordinator.capture("/teaching");
  const next = identity(["learning:self"], other);
  next.organizations.push({ ...next.organizations[0]!, id: "555555555555555555555555" });
  next.context = null;
  assert(coordinator.identify(next), "未识别换号");
  coordinator.capture("/teaching");
  assert(!coordinator.decide(next, null).target, "无组织就进入旧目标");
  coordinator.capture("/teaching");
  next.context = identity(["learning:self"], other).context;
  assert(!coordinator.needsManagementContext(next, "/teaching", undefined, true), "新账号默认仍等待旧页面管理上下文");
  const decision = coordinator.decide(next, null);
  assert(decision.target === "/learning" && !decision.denied, "多组织换号恢复旧teaching并制造403，而非新账号学习默认");
});
run("被拒目标终态不会因恢复身份重新请求原目标", () => {
  for (const status of [403, 404] as const) {
    const coordinator = createEntryCoordinator(); const actor = identity(["learning:self"]);
    coordinator.identify(actor); coordinator.capture("/learning"); coordinator.reject(status);
    coordinator.capture("/learning");
    assert(!coordinator.decide(actor, consoleContext).target && coordinator.outcome?.status === status, "身份恢复清除了拒绝终态");
    assert(Object.keys(coordinator.outcome!).every(key => ["status", "reason", "userId"].includes(key)), "终态携带资源或私有内容");
    coordinator.explicitNavigation();
    assert(coordinator.decide(actor, consoleContext).target === "/learning", "明确新操作无法恢复有权入口");
  }
});
run("业务优先、有效偏好、仅培训与零组织入口", () => {
  const actor = identity(["teaching:class", "learning:self", "ai:assist"]);
  assert(createEntryCoordinator().decide(actor, consoleContext).target === "/teaching", "默认管理压过业务");
  assert(createEntryCoordinator().decide(actor, consoleContext, { orgId: org, workspace: "/training" }).target === "/training", "有效偏好未使用");
  assert(createEntryCoordinator().decide(actor, consoleContext, { orgId: other, workspace: "/training" }).target === "/teaching", "跨组织偏好被当作当前权限");
  assert(createEntryCoordinator().decide(identity(["course:assign"]), null).target === "/training", "仅培训停在空首页");
  const zero = identity([]); zero.organizations = []; zero.context = null;
  assert(createEntryCoordinator().decide(zero, null).target === "/account", "零组织未到账号页");
  const multiple = identity([]); multiple.context = null;
  assert(!createEntryCoordinator().decide(multiple, null).target, "无有效组织上下文仍选择业务");
});
run("学生冲突与实时管理菜单不能由角色或旧上下文补齐", () => {
  const conflict = identity(["learning:self", "content:edit"]);
  assert(!availableWorkspaces(conflict, null).includes("/learning"), "学生冲突未阻止本人学习");
  assert(!availableWorkspaces(conflict, null).includes("/training"), "冲突的本人学习经training旁路进入");
  const studentConflict = identity(["learning:self"]);
  studentConflict.context!.student_conflict = true;
  assert(!availableWorkspaces(studentConflict, null).includes("/training"), "student_conflict只读本人权限自动进入培训");
  assert(createEntryCoordinator().decide(studentConflict, null).target === "/home", "冲突且无管理权限仍自动选择会被服务端403的培训");
  assert(!targetAllowed("/training", studentConflict, null), "原training意图未重新检查学生冲突");
  const assistOnly = identity(["learning:self", "ai:assist"]);
  assistOnly.context!.student_conflict = true;
  assert(!availableWorkspaces(assistOnly, null).includes("/training"), "ai:assist把被禁止的本人学习误作管理职责");
  assert(!canUseStudentLearning(identity(["learning:self", "ai:generate"])), "培训生成管理兼任本人学习未遵守服务端冲突规则");
  const trainingManager = identity(["learning:self", "site:edit"]);
  trainingManager.context!.student_conflict = true;
  assert(availableWorkspaces(trainingManager, null).includes("/training"), "学生冲突错误禁用了明确培训管理能力");
  assert(createEntryCoordinator().decide(trainingManager, null).target === "/training", "明确培训管理职责未得到真实可用落点");
  assert(!targetAllowed("/console/users/new", identity([]), null), "未读取菜单就允许管理目标");
  assert(!targetAllowed("/console/users/new", identity([]), { ...consoleContext, actor_org_id: other }), "旧组织菜单获得权限");
  assert(!targetAllowed("/console/audit", identity([]), consoleContext), "未返回audit菜单仍允许");
  assert(targetAllowed("/console/users/new", identity([]), consoleContext), "当前菜单目标被拒绝");
  assert(!targetAllowed("/console/business/content", identity([]), consoleContext), "business菜单被误作所有模块权限");
});
run("偏好仅保存当前user下最小组织/工作区；坏存储不授予权限", () => {
  const key = `knowladder-entry:${user}`;
  const previous = localStorage.getItem(key);
  try {
    const oversized = { orgId: org, workspace: "/training" as const, resource: "private", token: "secret" };
    writePreference(user, oversized);
    const stored = JSON.parse(localStorage.getItem(key)!);
    assert(Object.keys(stored).sort().join(",") === "orgId,workspace", "偏好保存资源或秘密");
    localStorage.setItem(key, JSON.stringify({ orgId: org, workspace: "/console/users/new", token: "secret" }));
    assert(readPreference(user)?.workspace === undefined, "资源路径被当作工作区偏好");
    localStorage.setItem(key, "{bad"); assert(readPreference(user) === undefined, "坏存储未安全忽略");
  } finally { if (previous === null) localStorage.removeItem(key); else localStorage.setItem(key, previous); }
});
async function verifyTrainingConsumer() {
  const name = "实际培训消费者在学生冲突下保留网站编辑、不预加载被禁止的学生课程/任务/答疑";
  const stage = document.createElement("section");
  document.body.append(stage);
  const actor = identity(["learning:self", "ai:assist", "site:edit"]);
  const recoveryKey = `kl-training:${actor.user.id}:${actor.context!.org_id}`;
  const previousRecovery = sessionStorage.getItem(recoveryKey);
  sessionStorage.removeItem(recoveryKey);
  actor.context!.student_conflict = true;
  const forbidden: string[] = [];
  let siteLoaded: (() => void) | undefined;
  const ready = new Promise<void>(resolve => { siteLoaded = resolve; });
  const request: BusinessRequest = async <T,>(path: string) => {
    let data: unknown;
    if (path === "/training/catalog") data = { classes: [], subjects: [], assignments: [], quizzes: [] };
    else if (path === "/training/ai/status") data = { profile: null };
    else if (path === "/site/drafts") { data = { items: [] }; siteLoaded?.(); }
    else {
      forbidden.push(path);
      throw new ApiError(403, "学生冲突禁止本人学习请求");
    }
    // Fixed in-process fixture shapes; the actual mounted consumer selects the endpoints.
    return data as T;
  };
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/training", component: { render: () => null } }] });
  await router.push("/training?tab=site");
  const app = createApp(TrainingWorkspace, { identity: actor, request }).use(router);
  let timeout = 0;
  try {
    app.mount(stage);
    await Promise.race([ready, new Promise<void>((_, reject) => { timeout = window.setTimeout(() => reject(Error("网站编辑未能加载")), 5000); })]);
    await nextTick();
    await nextTick();
    const form = Array.from(stage.querySelectorAll("form")).find(element => element.textContent?.includes("新增网站内容草稿"));
    assert(form?.querySelector("input") && form.querySelector("textarea"), "真正有权网站编辑表单被学生预加载403卸载");
    assert(!stage.textContent?.includes("我的学习工作台"), "学生冲突仍暴露本人学习操作");
    assert(forbidden.length === 0, `真实组件发出无权请求：${forbidden.join(",")}`);
    results.push({ name, passed: true });
  } catch (error) { results.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) }); }
  finally {
    window.clearTimeout(timeout); app.unmount(); stage.remove();
    if (previousRecovery === null) sessionStorage.removeItem(recoveryKey);
    else sessionStorage.setItem(recoveryKey, previousRecovery);
  }
  const output = document.querySelector<HTMLElement>("#results")!;
  output.textContent = JSON.stringify({ passed: results.filter(row => row.passed).length, failed: results.filter(row => !row.passed).length, results }, null, 2);
  output.dataset.complete = "true";
}
void verifyTrainingConsumer();
