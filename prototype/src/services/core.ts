import { reactive } from "vue";
export type Role = "student" | "editor" | "reviewer";
export type Fault =
  | "normal"
  | "offline"
  | "conflict"
  | "lost-response"
  | "deadline"
  | "unreleased"
  | "failed"
  | "review"
  | "stale"
  | "no-questions"
  | "forbidden"
  | "expired";
export const faults: { value: Fault; label: string }[] = [
  { value: "normal", label: "正常流程" },
  { value: "offline", label: "保存断网" },
  { value: "conflict", label: "多设备冲突" },
  { value: "lost-response", label: "交卷响应丢失" },
  { value: "deadline", label: "测验到期" },
  { value: "unreleased", label: "成绩待发布" },
  { value: "failed", label: "批改失败" },
  { value: "review", label: "等待复核" },
  { value: "stale", label: "报告更新中" },
  { value: "no-questions", label: "范围内无题" },
  { value: "forbidden", label: "权限失效" },
  { value: "expired", label: "登录过期" },
];
const initialScenario =
  new URLSearchParams(window.location.search).get("scenario") === "returning"
    ? "returning"
    : "first";
export const demo = reactive({
  role: "student" as Role,
  fault: "normal" as Fault,
  epoch: 0,
  scenario: initialScenario as "first" | "returning",
  readChapterId: "",
  dirty: false,
});
export function resetDemo(
  scenario: "first" | "returning" = "first",
  role: Role = "student",
  fault: Fault = "normal",
) {
  demo.dirty = false;
  demo.role = role;
  demo.scenario = scenario;
  demo.fault = fault;
  demo.readChapterId = "";
  demo.epoch++;
}
export const uid = () => crypto.randomUUID();
export const wait = (ms = 300) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
