import { reactive, watch } from "vue";
import { demo } from "./core";
export type ResourceType = "textbook" | "question";
export type ContentStatus = "draft" | "review" | "published" | "retired";
export interface Chapter {
  id: string;
  title: string;
  body: string;
  knowledge: string;
}
export interface Resource {
  id: string;
  type: ResourceType;
  title: string;
  version: number;
  status: ContentStatus;
  author: string;
  authorized: boolean;
  fileStatus: "pending" | "quarantined" | "ready" | "deleting";
  source: string;
  chapters: Chapter[];
  questionType: "single" | "multiple" | "numeric";
  prompt: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
  knowledge: string;
  difficulty: "基础" | "提升" | "挑战";
  notes: string;
  history: string[];
  revision: number;
}
export const textbookId = "10000000-0000-4000-8000-000000000001";
export const chapterId = "10000000-0000-4000-8000-000000000011";
export function blankResource(type: ResourceType): Resource {
  return {
    id: crypto.randomUUID(),
    type,
    title: "",
    version: 1,
    status: "draft",
    author: demo.role,
    authorized: false,
    fileStatus: "pending",
    source: "",
    chapters: [],
    questionType: "single",
    prompt: "",
    options: ["", "", "", ""],
    correctAnswer: "",
    explanation: "",
    knowledge: "等式的性质",
    difficulty: "基础",
    notes: "",
    history: [],
    revision: 1,
  };
}
function seed(): Resource[] {
  const textbook: Resource = {
    ...blankResource("textbook"),
    id: textbookId,
    title: "数学 · 七年级上册",
    status: "published",
    author: "editor",
    authorized: true,
    fileStatus: "ready",
    source: "知阶原创演示内容，非正式教材",
    chapters: [
      {
        id: chapterId,
        title: "等式的性质",
        knowledge: "等式的性质",
        body: `等式像一架保持平衡的天平。在等式两边同时加上或减去同一个数，等式仍然成立。
例如：x + 3 = 7，两边同时减去 3，得到 x = 4。
等式两边同时乘以同一个数，或除以同一个不为零的数，等式仍然成立。
学习目标：用等式的性质解简单的一元一次方程，并检验答案。`,
      },
      {
        id: "10000000-0000-4000-8000-000000000012",
        title: "一元一次方程",
        knowledge: "一元一次方程",
        body: `只含有一个未知数，且未知数的次数是 1 的方程，叫作一元一次方程。
解方程时每一步都要保持等式两边相等。把解代回原式，可以检查左右两边是否相等。`,
      },
    ],
  };
  const questions = [
    {
      title: "保持等式平衡",
      prompt: "解方程 2x + 3 = 7，x 的值是？",
      options: ["1", "2", "3", "4"],
      correctAnswer: "B",
      explanation: "两边同时减去 3，得到 2x = 4；两边同时除以 2，得到 x = 2。",
      questionType: "single" as const,
    },
    {
      title: "选择等价变形",
      prompt: "由 x + 3 = 7 可以得到哪些等式？（多选）",
      options: ["x = 4", "x + 5 = 9", "x = 10", "2x + 6 = 14"],
      correctAnswer: "A,B,D",
      explanation:
        "两边同时减 3、加 2 或乘 2 都保持相等。只改变一边不能保证相等。",
      questionType: "multiple" as const,
    },
    {
      title: "用代入检验答案",
      prompt: "解方程 3x = 12，填写 x 的值。",
      options: [],
      correctAnswer: "4",
      explanation: "两边同时除以 3，得到 x = 4。代入可得 3 × 4 = 12。",
      questionType: "numeric" as const,
    },
  ].map((q, i): Resource => ({
    ...blankResource("question"),
    ...q,
    id: `20000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    status: "published",
    author: "editor",
    authorized: true,
    fileStatus: "ready",
    source: "知阶原创示例",
    knowledge: "等式的性质",
  }));
  return [textbook, ...questions];
}
export const catalogue = reactive<{ resources: Resource[] }>({
  resources: seed(),
});
watch(
  () => demo.epoch,
  () => {
    catalogue.resources = seed();
  },
  { flush: "sync" },
);
export function availableResources(type: ResourceType) {
  return catalogue.resources.filter(
    (r) =>
      r.type === type &&
      r.status === "published" &&
      r.authorized &&
      r.fileStatus === "ready",
  );
}
