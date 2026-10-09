const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const { setup } = require("./training-isolated-helpers.cjs");
const { processKnowledgeOne } = require("../dist/training/knowledge-worker");
test(
  "授权知识库：原创合成资料经真实系统发送gpt-5.5并验证引用及不重复派发",
  { timeout: 180000 },
  async (t) => {
    if (process.env.KL_REAL_KNOWLEDGE_AUTHORIZED !== "true") {
      t.skip("仅明确原创真实模型验证授权后运行");
      return;
    }
    const destination = path.resolve(
      __dirname,
      "../../ops/artifacts/training-validation/revision137-knowledge-real.json",
    );
    const descriptor = fs.openSync(destination, "wx");
    const report = {
      version: 1,
      transport: "real-system-http",
      model: "gpt-5.5",
      material: "original-synthetic",
      request_attempts: 0,
      max_request_attempts: 1,
      cost_usd: null,
      billing: "unknown-provider-billing-ignored-by-user",
      human_quality: "not_reviewed",
      status: "started",
      started_at: new Date().toISOString(),
    };
    const save = () => {
      fs.ftruncateSync(descriptor, 0);
      fs.writeSync(
        descriptor,
        JSON.stringify(report, null, 2) + "\n",
        0,
        "utf8",
      );
      fs.fsyncSync(descriptor);
    };
    save();
    t.after(() => {
      report.finished_at = new Date().toISOString();
      save();
      fs.closeSync(descriptor);
    });
    const f = await setup(t, {
      KL_KNOWLEDGE_ENABLED: "true",
      KL_AI_POLICY_ENABLED: "false",
      KL_AI_LEARNING_REPORTS_ENABLED: "false",
      KL_AI_ENDPOINT: process.env.KL_AI_ENDPOINT,
      KL_AI_MODEL: process.env.KL_AI_MODEL,
      KL_AI_API_KEY: process.env.KL_AI_API_KEY,
    });
    let course = await f.good(f.author, "/courses", {
      code: "original-rag-live",
      title: "原创沟通培训",
      subject_id: f.subject,
      version_no: 1,
      lessons: [
        [
          "confirm",
          "复述确认",
          "原创培训材料甲：沟通时先用自己的话复述对方需求，再请对方确认，减少理解偏差。",
        ],
        [
          "listen",
          "主动倾听",
          "原创培训材料乙：主动倾听时让对方先完整表达，再用开放问题澄清目标，最后核对下一步行动。",
        ],
      ].map(([key, title, body]) => ({
        key,
        title,
        body,
        kind: "text",
        required: true,
        file_id: null,
        owner_version_id: null,
      })),
    });
    course = await f.good(f.author, `/courses/${course._id}/actions`, {
      action: "request-review",
      expected_revision: course.revision,
    });
    course = await f.good(f.reviewer, `/courses/${course._id}/actions`, {
      action: "publish",
      expected_revision: course.revision,
      note: "确认原创合成学习材料",
    });
    await f.good(f.author, `/courses/${course._id}/assign`, {
      class_id: f.classId,
    });
    assert.equal(await processKnowledgeOne(f.db), true);
    await f.good(f.author, "/ai/config", {
      enabled: true,
      daily_limit: 1,
      expected_revision: 0,
    });
    const query =
      "培训沟通中，复述确认和主动倾听如何配合？仅依据资料给出两点简短提示并引用来源。";
    const scope = ["confirm", "listen"].map((lesson_key) => ({
      kind: "course-text",
      id: course._id,
      lesson_key,
    }));
    const preview = await f.good(f.student, "/knowledge/search", {
      query,
      scope,
    });
    assert.equal(preview.citations.length, 2);
    const nativeFetch = global.fetch;
    global.fetch = async (url, options) => {
      if (String(url) !== process.env.KL_AI_ENDPOINT)
        return nativeFetch(url, options);
      assert.ok(report.request_attempts < 1, "仅授权本轮一次真实派发");
      report.request_attempts++;
      save();
      const sent = JSON.parse(options.body),
        data = JSON.parse(sent.messages[1].content);
      assert.equal(data.sources.length, 2);
      for (const identity of [
        f.org,
        f.student.member,
        f.student.user.user_id,
        course._id,
      ])
        assert.equal(options.body.includes(identity), false);
      const response = await nativeFetch(url, options);
      report.http_status = response.status;
      try {
        const value = await response.clone().json(),
          usage = value.usage;
        if (usage)
          report.usage = {
            prompt_tokens: usage.prompt_tokens ?? null,
            completion_tokens: usage.completion_tokens ?? null,
            reasoning_tokens:
              usage.completion_tokens_details?.reasoning_tokens ?? null,
          };
      } catch {}
      save();
      return response;
    };
    t.after(() => {
      global.fetch = nativeFetch;
    });
    let job = await f.good(f.student, "/ai/jobs", {
      kind: "assist",
      context_id: course._id,
      prompt: query,
      knowledge_scope: scope,
      knowledge_fingerprint: preview.fingerprint,
    });
    job = await f.good(f.student, `/ai/jobs/${job.id}/dispatch`, {
      expected_revision: job.revision,
    });
    report.status = job.status;
    report.error_code = job.error_code;
    report.output = job.output;
    report.citations = job.citations;
    report.evidence_count = job.knowledge_evidence?.length ?? 0;
    save();
    assert.equal(job.status, "succeeded");
    assert.ok(job.output);
    assert.ok(job.citations.length);
    assert.equal(job.knowledge_evidence.length, 2);
    assert.equal(
      (await f.good(f.student, `/ai/jobs/${job.id}`)).output,
      job.output,
    );
    await f.good(f.student, `/ai/jobs/${job.id}/dispatch`, {
      expected_revision: job.revision,
    });
    assert.equal(report.request_attempts, 1);
    report.repeat_dispatch = "no-second-provider-call";
    save();
  },
);
