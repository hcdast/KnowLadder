"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  surveyDraft,
  surveyAnswers,
  requireSurveyWindow,
  surveyTransition,
  surveySummary,
} = require("../dist/training/survey-contract");
const draft = () => ({
  title: "原创课程反馈",
  opens_at: "2026-10-01T00:00:00Z",
  closes_at: "2026-11-01T00:00:00Z",
  questions: [
    {
      id: "choice",
      title: "讲解是否清晰",
      kind: "choice",
      required: true,
      options: [
        { id: "yes", title: "清晰" },
        { id: "no", title: "需改进" },
      ],
    },
    { id: "rating", title: "体验评分", kind: "rating", required: true },
    { id: "text", title: "改进建议", kind: "text", required: false },
  ],
});
const valid = () => [
  { question_id: "choice", value: "yes" },
  { question_id: "rating", value: 4 },
];
const rejects = (f, code) =>
  assert.throws(
    f,
    (e) => e.getStatus() === 422 && (!code || e.getResponse().code === code),
  );
test("问卷草稿拒未知字段、重复编号、过多题项和错误窗口", () => {
  const d = surveyDraft(draft());
  assert.equal(d.questions.length, 3);
  assert.deepEqual(d.questions[1].options, []);
  rejects(() => surveyDraft({ ...draft(), anonymous: true }));
  let x = draft();
  x.questions[1].id = "choice";
  rejects(() => surveyDraft(x));
  x = draft();
  x.questions[0].options[1].id = "yes";
  rejects(() => surveyDraft(x));
  x = draft();
  x.questions = Array.from({ length: 21 }, (_, i) => ({
    ...x.questions[1],
    id: "q" + i,
  }));
  rejects(() => surveyDraft(x));
  rejects(() => surveyDraft({ ...draft(), closes_at: draft().opens_at }));
  rejects(() => surveyDraft({ ...draft(), title: "x".repeat(121) }));
  x = draft();
  x.questions[1].options = [{ id: "x", title: "不应接受" }];
  rejects(() => surveyDraft(x));
});
test("提交严格匹配冻结题项、必答和取值，不容许评分/正文越界", () => {
  const q = surveyDraft(draft()).questions;
  assert.deepEqual(surveyAnswers(q, valid().reverse()), valid());
  rejects(() => surveyAnswers(q, [{ question_id: "rating", value: 4 }]));
  for (const value of [0, 6, 1.5, "4", NaN])
    rejects(() =>
      surveyAnswers(q, [valid()[0], { question_id: "rating", value }]),
    );
  rejects(() => surveyAnswers(q, [...valid(), valid()[0]]));
  rejects(() =>
    surveyAnswers(q, [...valid(), { question_id: "other", value: 1 }]),
  );
  rejects(() =>
    surveyAnswers(q, [{ question_id: "choice", value: "missing" }, valid()[1]]),
  );
  rejects(() =>
    surveyAnswers(q, [
      ...valid(),
      { question_id: "text", value: "x".repeat(1001) },
    ]),
  );
  rejects(() => surveyAnswers(q, [{ ...valid()[0], extra: true }, valid()[1]]));
  assert.deepEqual(
    surveyAnswers(q, [...valid(), { question_id: "text", value: "   " }]),
    valid(),
  );
  q[2].required = true;
  rejects(
    () => surveyAnswers(q, [...valid(), { question_id: "text", value: "  " }]),
    "SURVEY_REQUIRED",
  );
});
test("窗口左闭右开，发布冻结且关闭后不可重开", () => {
  const d = surveyDraft(draft());
  requireSurveyWindow("open", d.opens_at, d.closes_at, d.opens_at);
  for (const [status, now] of [
    ["draft", d.opens_at],
    ["closed", d.opens_at],
    ["open", new Date(d.opens_at - 1)],
    ["open", d.closes_at],
  ])
    assert.throws(
      () => requireSurveyWindow(status, d.opens_at, d.closes_at, now),
      (e) => e.getResponse().code === "SURVEY_NOT_OPEN",
    );
  assert.equal(
    surveyTransition("draft", "publish", d.closes_at, d.opens_at),
    "open",
  );
  assert.equal(
    surveyTransition("open", "close", d.closes_at, d.closes_at),
    "closed",
  );
  for (const [status, action] of [
    ["closed", "publish"],
    ["open", "publish"],
    ["draft", "close"],
    ["draft", "bad"],
  ])
    assert.throws(() =>
      surveyTransition(status, action, d.closes_at, d.opens_at),
    );
  assert.throws(() =>
    surveyTransition("draft", "publish", d.closes_at, d.closes_at),
  );
});
test("汇总从当前存活受理答案计算，空数据不虚构均分，正文不进入汇总", () => {
  const q = surveyDraft(draft()).questions;
  const r = [
    valid(),
    [
      { question_id: "choice", value: "no" },
      { question_id: "rating", value: 2 },
      { question_id: "text", value: "原创建议正文" },
    ],
  ];
  const all = surveySummary(q, r);
  assert.equal(all.respondents, 2);
  assert.deepEqual(all.questions[0].counts, { yes: 1, no: 1 });
  assert.equal(all.questions[1].rating_mean, 3);
  assert.equal(all.questions[2].answered, 1);
  assert.ok(!JSON.stringify(all).includes("原创建议正文"));
  const deleted = surveySummary(q, [r[0]]);
  assert.equal(deleted.respondents, 1);
  assert.equal(deleted.questions[1].rating_mean, 4);
  const empty = surveySummary(q, []);
  assert.equal(empty.respondents, 0);
  assert.equal(empty.questions[1].rating_mean, null);
  assert.throws(() =>
    surveySummary(q, [[{ question_id: "rating", value: 500 }]]),
  );
});
