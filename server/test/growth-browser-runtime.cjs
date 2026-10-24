// Disposable synthetic accounts and actual Mongo/HTTP only; never connects to an existing service.
"use strict";
process.env.TEST_FILE_STORAGE_PARENT = require("node:os").homedir();
if (process.platform === "win32")
  process.env.PSModulePath = require("node:path").join(
    process.env.SystemRoot,
    "System32/WindowsPowerShell/v1.0/Modules",
  );
const { MongoMemoryReplSet } = require("mongodb-memory-server-core"),
  { pathToFileURL } = require("node:url");
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  { studioFixture } = require("./studio-fixture.cjs");
const root = path.resolve(__dirname, "../.."),
  origin = "http://localhost:5195",
  controlFile = path.join(root, "ops/artifacts/growth-275-control.json"),
  resultFile = path.join(root, "ops/artifacts/growth-275-http.json");
(async () => {
  let rs, f, vite;
  const cleanups = [],
    calls = [];
  try {
    fs.mkdirSync(path.dirname(controlFile), { recursive: true });
    fs.writeFileSync(controlFile, "{}");
    rs = await MongoMemoryReplSet.create({
      binary: { version: "8.0.17" },
      replSet: { count: 1, storageEngine: "wiredTiger" },
      instanceOpts: [{ args: ["--wiredTigerCacheSizeGB", "0.25"] }],
    });
    process.env.TEST_MONGODB_URI = rs.getUri("kl_test_studio_browser");
    f = await studioFixture(
      { after: (cb) => cleanups.push(cb) },
      { KL_LEARNING_GROWTH_ENABLED: "true" },
    );
    let question = await f.question();
    await f.good(f.author, `/studio/questions/${question._id}/actions`, {
      action: "reply",
      expected_revision: question.revision,
      body: "先记录颜色、数量和形状，再请同伴核验。",
    });
    await f.meetup(2);
    await f.good(f.student, "/studio/notes", {
      title: "观察的起点",
      body: "区分事实和主观判断。",
      source_kind: "course",
      source_id: f.course._id,
      lesson_key: "observe",
      due_on: "2026-11-01",
    });
    let task = await f.good(f.author, "/tasks", {
      class_id: f.classId,
      subject_id: f.subject,
      title: "制作观察记录卡",
      target_type: "coursework",
      target_id: null,
      due_at: new Date(Date.now() + 86400000).toISOString(),
      body: "观察一种植物，提交事实记录与实践回顾。",
      rubric: [
        { key: "process", title: "实践过程", weight: 40 },
        { key: "outcome", title: "作品质量", weight: 40 },
        { key: "reflection", title: "反思改进", weight: 20 },
      ],
    });
    await f.good(f.author, `/tasks/${task._id}/actions`, {
      action: "publish",
      expected_revision: task.revision,
    });
    const head = await f.good(f.student, `/tasks/${task._id}/coursework`, {
      action: "submit",
      expected_revision: 0,
      body: "我观察了三片叶子，记录颜色、形状和数量；下一次会补充时间与观察条件。",
    });
    await f.good(f.author, `/tasks/${task._id}/feedback`, {
      head_revision: head.revision,
      submission_id: head.current_submission_id,
      comments: "事实与判断已分开，建议补充观察条件。",
      scores: [
        { key: "process", score: 80 },
        { key: "outcome", score: 90 },
        { key: "reflection", score: 70 },
      ],
      publish: true,
    });
    await f.good(f.student, `/courses/${f.course._id}/progress`, {
      lesson_key: "observe",
      position: 0,
      complete: true,
    });
    const { createServer } = await import(
        pathToFileURL(
          path.join(root, "web/node_modules/vite/dist/node/index.js"),
        )
      ),
      vue = (
        await import(
          pathToFileURL(
            path.join(
              root,
              "web/node_modules/@vitejs/plugin-vue/dist/index.mjs",
            ),
          )
        )
      ).default;
    vite = await createServer({
      configFile: false,
      root: path.join(root, "web"),
      plugins: [
        vue(),
        {
          name: "isolated-studio",
          configureServer(server) {
            server.middlewares.use((req, res, next) => {
              const url = new URL(req.url, origin);
              if (!url.pathname.startsWith("/api/")) return next();
              if (req.headers.origin && req.headers.origin !== origin) {
                res.writeHead(403).end();
                return;
              }
              let control = {};
              try {
                control = JSON.parse(fs.readFileSync(controlFile, "utf8"));
              } catch {}
              const actor =
                control.actor === "teacher"
                  ? f.author
                  : control.actor === "reviewer"
                    ? f.reviewer
                    : f.student;
              const headers = {
                ...req.headers,
                host: new URL(f.browser.base).host,
                origin: "http://127.0.0.1:5174",
                cookie: [...actor.browser.cookies]
                  .map(([k, v]) => `${k}=${v}`)
                  .join("; "),
              };
              const outgoing = http.request(
                new URL(req.url, f.browser.base),
                { method: req.method, headers },
                (upstream) => {
                  calls.push({
                    method: req.method,
                    path: url.pathname,
                    status: upstream.statusCode,
                    actor: control.actor || "student",
                  });
                  fs.writeFileSync(
                    resultFile,
                    JSON.stringify(
                      { fixture: "isolated-real-http-and-mongo", calls },
                      null,
                      2,
                    ),
                  );
                  const responseHeaders = { ...upstream.headers };
                  delete responseHeaders["set-cookie"];
                  res.writeHead(upstream.statusCode, responseHeaders);
                  upstream.pipe(res);
                },
              );
              outgoing.on("error", () => {
                if (!res.headersSent) res.writeHead(502);
                res.end();
              });
              req.pipe(outgoing);
            });
          },
        },
      ],
      server: { host: "localhost", port: 5195, strictPort: true },
      clearScreen: false,
    });
    await vite.listen();
    console.log("GROWTH_TRIAL_READY http://localhost:5195/training?tab=growth");
    let working = false,
      revoked = false,
      started = false;
    await new Promise((resolve) => {
      const timer = setInterval(async () => {
        if (working) return;
        working = true;
        try {
          const control = JSON.parse(fs.readFileSync(controlFile, "utf8"));
          if (control.startActivities && !started) {
            await f.db
              .collection("learning_meetups")
              .updateMany(
                { org_id: f.org },
                {
                  $set: {
                    enrollment_closes_at: new Date(Date.now() - 3000),
                    starts_at: new Date(Date.now() - 2000),
                    ends_at: new Date(Date.now() - 1000),
                  },
                },
              );
            started = true;
            console.log("GROWTH_TRIAL_ACTIVITIES_ENDED");
          }
          if (control.revoke && !revoked) {
            await f.db
              .collection("class_members")
              .updateOne(
                { member_id: f.student.member },
                { $set: { status: "ended" } },
              );
            revoked = true;
            console.log("GROWTH_TRIAL_REVOKED");
          }
          if (control.stop) {
            clearInterval(timer);
            resolve();
          }
        } catch (e) {
          console.error("GROWTH_TRIAL_CONTROL", e.code || e.name);
        } finally {
          working = false;
        }
      }, 250);
    });
  } finally {
    await vite?.close();
    for (const cb of cleanups.reverse()) await cb();
    await rs?.stop();
    fs.rmSync(controlFile, { force: true });
  }
})().catch((e) => {
  console.error("GROWTH_TRIAL_FAILED", e.code || e.name);
  process.exitCode = 1;
});
