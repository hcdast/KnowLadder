"use strict";
// Temporary isolated browser acceptance runner; removed after this session.
const { assessmentFixture, createQuestion } = require("./assessment-helpers.cjs");
const { PASSWORD } = require("./helpers.cjs");
const { mkdtemp, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { createInterface } = require("node:readline");
(async () => {
  const cleanups = [];
  let directory;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    for (const cleanup of cleanups.reverse()) await cleanup();
    if (directory) await rm(directory, { recursive: true, force: true });
    process.exit(0);
  };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  const f = await assessmentFixture({ after: fn => cleanups.push(fn) });
  // Keep dedicated exam source undisclosed by the practice result flow.
  f.examQuestion = await createQuestion(f, { title: "原创考试专用数值题", question_type: "numeric", prompt: "二加三", options: [], answer: "5", difficulty: "提升", scoring_rule: { version: 1, strategy: "numeric_exact_decimal", max_score: "5" } });
  const browserApp = await f.createApp();
  f.apps.push(browserApp);
  await browserApp.listen(3000, "127.0.0.1");
  directory = await mkdtemp(path.join(tmpdir(), "kl-s307-browser-"));
  const manifest = path.join(directory, "runtime.json");
  await writeFile(manifest, JSON.stringify({ uri: f.uri, org: f.org, book: f.book.id, subject: f.subject, studentMember: f.student.memberId, examQuestion: f.examQuestion.id, password: PASSWORD, actors: Object.fromEntries(["student", "manager", "reviewer", "editor", "contentReviewer"].map(role => [role, { login: f[role].user.login_name, userId: f[role].user.user_id }])) }), { mode: 0o600 });
  console.log(`S307 READY manifest=${manifest}`);
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (line.trim() === "stop") { await stop(); break; }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
