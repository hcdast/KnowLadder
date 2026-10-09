import { fail } from "../errors";
import * as v from "./validation";
export type SurveyQuestion = {
  id: string;
  title: string;
  required: boolean;
  kind: "choice" | "rating" | "text";
  options: { id: string; title: string }[];
};
export type SurveyAnswer = { question_id: string; value: string | number };
export type SurveyDraft = {
  title: string;
  questions: SurveyQuestion[];
  opens_at: Date;
  closes_at: Date;
};
const key = (input: unknown): string => {
  const s = v.text(input, 64);
  if (!/^[A-Za-z0-9_-]+$/.test(s))
    fail(422, "INVALID_SURVEY_KEY", "题项编号格式无效");
  return s;
};
export function surveyDraft(input: unknown): SurveyDraft {
  const o = v.object(input, ["title", "questions", "opens_at", "closes_at"]);
  if (
    !Array.isArray(o.questions) ||
    !o.questions.length ||
    o.questions.length > 20
  )
    fail(422, "INVALID_SURVEY_QUESTIONS", "问卷须有1至20题");
  const questions: SurveyQuestion[] = o.questions.map((raw: unknown) => {
    const q = v.object(raw, ["id", "title", "required", "kind", "options"]);
    if (
      typeof q.required !== "boolean" ||
      !["choice", "rating", "text"].includes(q.kind)
    )
      fail(422, "INVALID_SURVEY_QUESTION", "题型或必答标记无效");
    let options: { id: string; title: string }[] = [];
    if (q.kind === "choice") {
      if (
        !Array.isArray(q.options) ||
        q.options.length < 2 ||
        q.options.length > 10
      )
        fail(422, "INVALID_SURVEY_OPTIONS", "单选须有2至10项");
      options = q.options.map((raw: unknown) => {
        const a = v.object(raw, ["id", "title"]);
        return { id: key(a.id), title: v.text(a.title, 120).trim() };
      });
      if (new Set(options.map((a) => a.id)).size !== options.length)
        fail(422, "INVALID_SURVEY_OPTIONS", "选项编号重复");
    } else if (
      q.options !== undefined &&
      (!Array.isArray(q.options) || q.options.length)
    )
      fail(422, "INVALID_SURVEY_OPTIONS", "此题型不接受选项");
    return {
      id: key(q.id),
      title: v.text(q.title, 500).trim(),
      required: q.required,
      kind: q.kind,
      options,
    };
  });
  if (new Set(questions.map((q) => q.id)).size !== questions.length)
    fail(422, "INVALID_SURVEY_QUESTIONS", "题目编号重复");
  const opens_at = v.date(o.opens_at),
    closes_at = v.date(o.closes_at);
  if (opens_at >= closes_at)
    fail(422, "INVALID_SURVEY_WINDOW", "结束时间须晚于开始时间");
  return { title: v.text(o.title, 120).trim(), questions, opens_at, closes_at };
}
export function surveyAnswers(
  questions: SurveyQuestion[],
  input: unknown,
): SurveyAnswer[] {
  if (!Array.isArray(input) || input.length > 20)
    fail(422, "INVALID_SURVEY_ANSWERS", "答案数量无效");
  const seen = new Set<string>();
  const answers: SurveyAnswer[] = [];
  for (const raw of input) {
    const a = v.object(raw, ["question_id", "value"]),
      id = key(a.question_id),
      q = questions.find((q) => q.id === id);
    if (!q || seen.has(id))
      fail(422, "INVALID_SURVEY_ANSWERS", "未知或重复题目答案");
    seen.add(id);
    let value: string | number;
    if (q.kind === "rating") value = v.integer(a.value, 1, 5);
    else if (q.kind === "choice") {
      value = key(a.value);
      if (!q.options.some((x) => x.id === value))
        fail(422, "INVALID_SURVEY_ANSWERS", "答案不是有效选项");
    } else {
      value = v.text(a.value, 1000, true).trim();
      if (!value) {
        if (q.required) fail(422, "SURVEY_REQUIRED", "请回答必答题");
        continue;
      }
    }
    answers.push({ question_id: id, value });
  }
  if (
    questions.some(
      (q) => q.required && !answers.some((a) => a.question_id === q.id),
    )
  )
    fail(422, "SURVEY_REQUIRED", "请回答全部必答题");
  return questions.flatMap((q) =>
    answers.filter((a) => a.question_id === q.id),
  );
}
export function requireSurveyWindow(
  status: string,
  opens: Date,
  closes: Date,
  now: Date,
): void {
  if (status !== "open" || now < opens || now >= closes)
    fail(409, "SURVEY_NOT_OPEN", "问卷尚未开放或已结束");
}
export function surveyTransition(
  status: string,
  action: unknown,
  closes: Date,
  now: Date,
): "open" | "closed" {
  if (action === "publish" && status === "draft" && now < closes) return "open";
  if (action === "close" && status === "open") return "closed";
  fail(409, "SURVEY_STATE_CONFLICT", "当前状态不允许该操作");
}
export function surveySummary(
  questions: SurveyQuestion[],
  responses: SurveyAnswer[][],
) {
  const summary = questions.map((q) => ({
    question_id: q.id,
    kind: q.kind,
    answered: 0,
    counts:
      q.kind === "choice"
        ? Object.fromEntries(q.options.map((o) => [o.id, 0]))
        : q.kind === "rating"
          ? Object.fromEntries([1, 2, 3, 4, 5].map((n) => [String(n), 0]))
          : {},
    rating_sum: 0,
  }));
  for (const response of responses) {
    const answers = surveyAnswers(questions, response);
    for (const a of answers) {
      const s = summary.find((s) => s.question_id === a.question_id)!;
      s.answered++;
      if (s.kind !== "text") s.counts[String(a.value)]++;
      if (s.kind === "rating") s.rating_sum += a.value as number;
    }
  }
  return {
    respondents: responses.length,
    questions: summary.map((s) => ({
      ...s,
      rating_mean:
        s.kind === "rating" && s.answered ? s.rating_sum / s.answered : null,
    })),
  };
}
