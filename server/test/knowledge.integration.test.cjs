const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./training-isolated-helpers.cjs");
const { status } = require("./helpers.cjs");
const { processKnowledgeOne } = require("../dist/training/knowledge-worker");
const { rawDatabase, objectIdDatabase } = require("../dist/database/object-id");
const { ObjectId, MongoClient } = require("mongodb");
const { TrainingService } = require("../dist/training/training.service");
const { enqueueKnowledge } = require("../dist/training/knowledge-events");
const { randomUUID } = require("node:crypto");
async function course(f, code, body) {
  let c = await f.good(f.author, "/courses", {
    code,
    title: "原创培训 " + code,
    subject_id: f.subject,
    version_no: 1,
    lessons: (Array.isArray(body) ? body : [body]).map((text, index) => ({
      key: index ? `text-${index}` : "intro",
      title: "原创正文",
      kind: "text",
      required: true,
      body: text,
      file_id: null,
      owner_version_id: null,
    })),
  });
  c = await f.good(f.author, `/courses/${c._id}/actions`, {
    action: "request-review",
    expected_revision: c.revision,
  });
  c = await f.good(f.reviewer, `/courses/${c._id}/actions`, {
    action: "publish",
    expected_revision: c.revision,
    note: "独立确认原创来源",
  });
  await f.good(f.author, `/courses/${c._id}/assign`, { class_id: f.classId });
  return c;
}
test(
  "知识库：真实迁移/来源outbox/索引/授权检索/多来源AI与撤权（供应商为受控传输）",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t, {
      KL_KNOWLEDGE_ENABLED: "true",
      KL_AI_ENDPOINT: "https://provider.invalid/chat",
      KL_AI_MODEL: "transport-test",
      KL_AI_API_KEY: "transport-test-value",
    });
    const c1 = await course(f, "rag-one", "原创培训：有效沟通需要复述确认。"),
      c2 = await course(f, "rag-two", "原创培训：主动倾听需要澄清目标。");
    const scope = [c1, c2].map((c) => ({
      kind: "course-text",
      id: c._id,
      lesson_key: "intro",
    }));
    const query = { query: "培训", scope };
    await t.test("v17严格Schema、BSON身份及未就绪索引拒绝", async () => {
      const marker = await f.db
        .collection("schema_migrations")
        .findOne({ version: 17 });
      assert.equal(marker.status, "completed");
      status(await f.req(f.student, "/knowledge/search", query), 409);
      const outcomes = await Promise.all([
        processKnowledgeOne(f.db),
        processKnowledgeOne(f.db),
      ]);
      assert.deepEqual(outcomes, [true, true]);
      assert.equal(await processKnowledgeOne(f.db), false);
      const stored = await rawDatabase(f.db)
        .collection("knowledge_sources")
        .findOne({ source_id: new ObjectId(c1._id) });
      assert.ok(stored._id instanceof ObjectId);
      assert.ok(stored.org_id instanceof ObjectId);
      assert.equal(stored.chunks.length, 1);
      await assert.rejects(
        rawDatabase(f.db)
          .collection("knowledge_sources")
          .updateOne({ _id: stored._id }, { $set: { answer: "不得入库" } }),
      );
    });
    await t.test(
      "授权范围、严格类型、精确引用、空证据及检索不占预算",
      async () => {
        const found = await f.good(f.student, "/knowledge/search", query);
        assert.equal(found.status, "grounded");
        assert.equal(found.citations.length, 2);
        for (const citation of found.citations) {
          assert.equal(citation.start_utf16, 0);
          assert.equal(citation.end_utf16, citation.text.length);
        }
        assert.equal(
          (
            await f.good(f.student, "/knowledge/search", {
              query: "biology",
              scope,
            })
          ).status,
          "insufficient-evidence",
        );
        status(await f.req(f.stranger, "/knowledge/search", query), 404);
        const outsider = await f.actor(["student"], ["ai:assist"]);
        status(await f.req(outsider, "/knowledge/search", query), 404);
        const otherOrg = (
          await f.ops.createOrganization(f.context, {
            name: "知识库隔离第二组织",
            kind: "school",
          })
        ).organization_id;
        await f.ops.setMembership(f.context, {
          user_id: f.student.user.user_id,
          org_id: otherOrg,
          roles: ["student"],
        });
        status(
          await f.student.browser.request("/training/knowledge/search", {
            method: "POST",
            body: query,
            headers: { "X-Org-Id": otherOrg },
          }),
          404,
        );
        status(
          await f.req(f.student, "/knowledge/search", {
            query: "培训",
            scope: [{ kind: "answer", id: c1._id }],
          }),
          422,
        );
        status(
          await f.req(f.student, "/knowledge/search", { query: "?", scope }),
          422,
        );
        status(
          await f.req(f.student, "/knowledge/search", {
            query: Array.from({ length: 65 }, (_, i) => `${i}`).join(" "),
            scope,
          }),
          422,
        );
        const options = await f.good(f.student, "/knowledge/sources");
        assert.equal(options.items.length, 2);
        assert.equal(
          (await f.good(outsider, "/knowledge/sources")).items.length,
          0,
        );
        assert.equal(
          await f.db
            .collection("ai_usage_ledger")
            .countDocuments({ org_id: f.org }),
          0,
        );
      },
    );
    await f.good(f.author, "/ai/config", {
      enabled: true,
      daily_limit: 10,
      expected_revision: 0,
    });
    const original = global.fetch;
    let calls = 0;
    t.after(() => {
      global.fetch = original;
    });
    global.fetch = async (url, options) => {
      if (url !== "https://provider.invalid/chat")
        return original(url, options);
      calls++;
      const sent = JSON.parse(options.body),
        payload = JSON.parse(sent.messages[1].content);
      assert.equal(payload.sources.length, 2);
      assert.ok(!options.body.includes(f.student.member));
      assert.ok(
        payload.sources.every((source) => source.text.includes("原创培训")),
      );
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  text: "先复述确认，再澄清目标。",
                  source_keys: ["evidence-1", "evidence-2"],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    };
    let grounded = await f.good(f.student, "/knowledge/search", query);
    const jobInput = {
      kind: "assist",
      context_id: c1._id,
      prompt: "培训",
      knowledge_scope: scope,
      knowledge_fingerprint: grounded.fingerprint,
    };
    await t.test(
      "明确预览绑定、证据不足不创建任务；派发和读取重新校验",
      async () => {
        status(
          await f.req(f.student, "/ai/jobs", {
            ...jobInput,
            knowledge_fingerprint: "0".repeat(64),
          }),
          409,
        );
        status(
          await f.req(f.student, "/ai/jobs", {
            ...jobInput,
            prompt: "biology",
          }),
          422,
        );
        assert.equal(
          await f.db.collection("ai_jobs").countDocuments({ org_id: f.org }),
          0,
        );
        let job = await f.good(f.student, "/ai/jobs", jobInput);
        assert.equal(calls, 0);
        const dispatchKey = randomUUID();
        job = await f.good(
          f.student,
          `/ai/jobs/${job.id}/dispatch`,
          { expected_revision: job.revision },
          dispatchKey,
        );
        assert.equal(job.status, "succeeded");
        assert.equal(job.knowledge_evidence.length, 2);
        assert.equal(calls, 1);
        assert.equal(
          (await f.good(f.student, `/ai/jobs/${job.id}`)).output,
          job.output,
        );
        await f.db
          .collection("class_courses")
          .updateOne(
            { org_id: f.org, course_id: c2._id },
            { $set: { status: "ended" } },
          );
        status(await f.req(f.student, `/ai/jobs/${job.id}`), 404);
        assert.equal((await f.good(f.student, "/ai/jobs")).items.length, 0);
        const receipt = await f.good(f.student, "/receipts/query", {
          key: dispatchKey,
        });
        assert.equal(receipt.status, "confirmed");
        assert.equal(receipt.result.output, "");
        assert.deepEqual(receipt.result.citations, []);
        await f.db
          .collection("class_courses")
          .updateOne(
            { org_id: f.org, course_id: c2._id },
            { $set: { status: "active" } },
          );
      },
    );
    await t.test(
      "旧索引哈希拒绝、重建幂等、竞争worker只有一方处理",
      async () => {
        await f.db.collection("courses").updateOne(
          { _id: c2._id },
          {
            $inc: { revision: 1 },
            $set: { "lessons.0.body": "原创培训：来源已修订。" },
          },
        );
        status(await f.req(f.student, "/knowledge/search", query), 409);
        const key = randomUUID(),
          input = { source: scope[1] };
        const first = await f.good(f.author, "/knowledge/rebuild", input, key),
          again = await f.good(f.author, "/knowledge/rebuild", input, key);
        assert.deepEqual(first, again);
        status(await f.req(f.student, "/knowledge/rebuild", input), 403);
        const processed = await Promise.all([
          processKnowledgeOne(f.db),
          processKnowledgeOne(f.db),
        ]);
        assert.equal(processed.filter(Boolean).length, 1);
        grounded = await f.good(f.student, "/knowledge/search", query);
        assert.equal(grounded.citations.length, 2);
        await f.db
          .collection("knowledge_sources")
          .updateOne(
            { org_id: f.org, source_id: c2._id },
            { $set: { "chunks.0.terms": ["biology"] } },
          );
        status(await f.req(f.student, "/knowledge/search", query), 409);
        await f.good(f.author, "/knowledge/rebuild", input);
        assert.equal(await processKnowledgeOne(f.db), true);
        status(await f.req(f.student, "/ai/jobs", jobInput), 409);
        const information = await f.good(f.author, "/knowledge/status");
        assert.equal(information.items.length, 2);
      },
    );
    await t.test(
      "领取后新重建事件使旧代次失效，不覆盖新pending任务",
      async () => {
        await f.good(f.author, "/knowledge/rebuild", { source: scope[0] });
        let intercepted = 0;
        const hooked = new Proxy(f.db, {
          get(target, property) {
            if (property === "collection")
              return (name) => {
                const collection = target.collection(name);
                if (name !== "knowledge_outbox") return collection;
                return new Proxy(collection, {
                  get(inner, method) {
                    if (method === "findOneAndUpdate")
                      return async (...args) => {
                        const event = await inner.findOneAndUpdate(...args);
                        if (event && intercepted++ === 0)
                          await f.good(f.author, "/knowledge/rebuild", {
                            source: scope[0],
                          });
                        return event;
                      };
                    const value = Reflect.get(inner, method);
                    return typeof value === "function"
                      ? value.bind(inner)
                      : value;
                  },
                });
              };
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        assert.equal(await processKnowledgeOne(hooked), true);
        assert.equal(intercepted, 1);
        const pending = await f.db
          .collection("knowledge_outbox")
          .findOne({ org_id: f.org, owner_id: c1._id });
        assert.equal(pending.status, "pending");
        assert.equal(pending.lease_token, null);
        status(await f.req(f.student, "/knowledge/search", query), 409);
        assert.equal(await processKnowledgeOne(f.db), true);
        assert.equal(
          (await f.good(f.student, "/knowledge/search", query)).fingerprint,
          grounded.fingerprint,
        );
      },
    );
    await t.test("知识worker：有效租约不抢占、过期唯一重领及领取后失效拒绝提交", async () => {
      await f.good(f.author,"/knowledge/rebuild",{source:scope[0]});
      const owner={org_id:f.org,owner_id:c1._id};
      const oldToken=randomUUID();
      await f.db.collection("knowledge_outbox").updateOne(owner,{$set:{status:"running",lease_token:oldToken,lease_until:new Date(Date.now()+60000)}});
      assert.equal(await processKnowledgeOne(f.db),false,"有效租约不抢占");
      await f.db.collection("knowledge_outbox").updateOne(owner,{$set:{lease_until:new Date(0)}});
      const claimed=await Promise.all([processKnowledgeOne(f.db),processKnowledgeOne(f.db)]);
      assert.equal(claimed.filter(Boolean).length,1,"过期任务唯一重领");
      let event=await f.db.collection("knowledge_outbox").findOne(owner);
      assert.equal(event.status,"completed");assert.equal(event.lease_token,null);
      await f.good(f.author,"/knowledge/rebuild",{source:scope[0]});
      let hits=0;
      const expiring=new Proxy(f.db,{get(target,key){
        if(key === "collection") return name=>{
          const coll=target.collection(name);if(name!=="knowledge_outbox")return coll;
          return new Proxy(coll,{get(inner,method){
            if(method === "findOneAndUpdate") return async(...args)=>{
              const result=await inner.findOneAndUpdate(...args);
              if(result && hits++===0) await f.db.collection(name).updateOne({_id:result._id,lease_token:result.lease_token},{$set:{lease_until:new Date(0)}});
              return result;
            };
            const value=Reflect.get(inner,method);return typeof value === "function" ? value.bind(inner):value;
          }});
        };
        const value=Reflect.get(target,key);return typeof value === "function" ? value.bind(target):value;
      }});
      const before=await f.db.collection("knowledge_sources").findOne({source_id:c1._id});
      assert.equal(await processKnowledgeOne(expiring),true);assert.equal(hits,1);
      event=await f.db.collection("knowledge_outbox").findOne(owner);
      assert.equal(event.status,"running","旧租约不能标完成或失败");
      assert.deepEqual(await f.db.collection("knowledge_sources").findOne({source_id:c1._id}),before,"失效领取不能覆盖索引");
      status(await f.req(f.student,"/knowledge/search",query),409);
      assert.equal(await processKnowledgeOne(f.db),true);
      assert.equal((await f.good(f.student,"/knowledge/search",query)).status,"grounded");
    });
    await t.test("教师多来源备课与学习读权检索独立于模型生成能力", async () => {
      assert.equal(
        (await f.good(f.author, "/knowledge/search", query)).citations.length,
        2,
      );
      const key = randomUUID();
      let prepared = await f.good(
        f.author,
        "/ai/jobs",
        {
          ...jobInput,
          kind: "prepare",
          knowledge_fingerprint: grounded.fingerprint,
        },
        key,
      );
      prepared = await f.good(f.author, `/ai/jobs/${prepared.id}/dispatch`, {
        expected_revision: prepared.revision,
      });
      assert.equal(prepared.status, "succeeded");
      assert.equal(prepared.knowledge_evidence.length, 2);
    });
    await t.test(
      "完成事务中的来源事件交错产生真实写冲突，重试停止旧结果",
      async () => {
        let job = await f.good(f.student, "/ai/jobs", {
          ...jobInput,
          knowledge_fingerprint: grounded.fingerprint,
        });
        const writer = new MongoClient(f.uri);
        await writer.connect();
        const writerDb = objectIdDatabase(writer.db());
        assert.equal(writerDb.databaseName, f.db.databaseName);
        assert.match(writerDb.databaseName, /^kl_test_/);
        const originalCol = TrainingService.prototype.col,
          providerFetch = global.fetch;
        let finishing = false,
          interleaved = 0,
          conflicts = 0;
        TrainingService.prototype.col = function (name) {
          const collection = originalCol.call(this, name);
          if (name !== "knowledge_outbox") return collection;
          return new Proxy(collection, {
            get(target, method) {
              if (method === "findOne")
                return async (...args) => {
                  const event = await target.findOne(...args);
                  if (
                    finishing &&
                    event?.owner_id === c2._id &&
                    interleaved === 0
                  ) {
                    interleaved++;
                    const session = writer.startSession();
                    try {
                      await session.withTransaction(() =>
                        enqueueKnowledge(
                          writerDb,
                          { orgId: f.org, session },
                          "course",
                          c2._id,
                        ),
                      );
                    } finally {
                      await session.endSession();
                    }
                  }
                  return event;
                };
              if (method === "updateOne")
                return async (...args) => {
                  try {
                    return await target.updateOne(...args);
                  } catch (error) {
                    if (error.hasErrorLabel?.("TransientTransactionError"))
                      conflicts++;
                    throw error;
                  }
                };
              const value = Reflect.get(target, method);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        };
        global.fetch = async (url, options) => {
          const response = await providerFetch(url, options);
          if (url === "https://provider.invalid/chat") finishing = true;
          return response;
        };
        try {
          job = await f.good(f.student, `/ai/jobs/${job.id}/dispatch`, {
            expected_revision: job.revision,
          });
          assert.equal(interleaved, 1);
          assert.ok(conflicts >= 1, "必须捕获真实事务冲突");
          assert.equal(job.status, "failed");
          assert.equal(job.error_code, "CONTEXT_CHANGED");
          assert.equal(job.output, "");
          assert.equal(
            (
              await f.db
                .collection("ai_usage_ledger")
                .findOne({ org_id: f.org })
            ).reserved,
            0,
          );
        } finally {
          TrainingService.prototype.col = originalCol;
          global.fetch = providerFetch;
          await writer.close();
        }
        assert.equal(await processKnowledgeOne(f.db), true);
      },
    );
    await t.test(
      "调用中撤权停止结果交付并结算，不把任务留在running",
      async () => {
        let job = await f.good(f.student, "/ai/jobs", {
          ...jobInput,
          knowledge_fingerprint: grounded.fingerprint,
        });
        global.fetch = async (url, options) => {
          if (url !== "https://provider.invalid/chat")
            return original(url, options);
          calls++;
          await f.db
            .collection("class_courses")
            .updateOne(
              { org_id: f.org, course_id: c2._id },
              { $set: { status: "ended" } },
            );
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      text: "过期资料结果",
                      source_keys: ["evidence-1"],
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          );
        };
        job = await f.good(f.student, `/ai/jobs/${job.id}/dispatch`, {
          expected_revision: job.revision,
        });
        assert.equal(job.status, "failed");
        assert.equal(job.output, "");
        assert.equal(job.error_code, "CONTEXT_CHANGED");
        const ledger = await f.db
          .collection("ai_usage_ledger")
          .findOne({ org_id: f.org });
        assert.equal(ledger.reserved, 0);
      },
    );
    await t.test("退役事件清除派生原文且学生不能检索旧索引", async () => {
      await f.good(f.reviewer, `/courses/${c2._id}/actions`, {
        action: "retire",
        expected_revision: c2.revision + 1,
        note: "原创资料退役",
      });
      assert.equal(await processKnowledgeOne(f.db), true);
      assert.equal(
        await f.db
          .collection("knowledge_sources")
          .countDocuments({ owner_id: c2._id, org_id: f.org }),
        0,
      );
      status(await f.req(f.student, "/knowledge/search", query), 404);
    });
    await t.test("OpenAPI包含来源/证据/检索与可选AI预览绑定", async () => {
      const response = await original(`${f.browser.base}/api/openapi.json`),
        document = await response.json();
      assert.equal(response.status, 200);
      assert.equal(
        document.paths["/api/v1/training/knowledge/search"].post.requestBody
          .content["application/json"].schema.required.length,
        2,
      );
      const input =
        document.paths["/api/v1/training/ai/jobs"].post.requestBody.content[
          "application/json"
        ].schema;
      assert.ok(input.properties.knowledge_scope);
      assert.ok(!input.required.includes("knowledge_scope"));
      const fs = require("node:fs");
      fs.writeFileSync(
        "../ops/artifacts/training-validation/revision137-knowledge-openapi.json",
        JSON.stringify(document, null, 2),
      );
    });
    await t.test("真实204候选拒绝而非截断，检索不预留预算", async () => {
      const selected = [];
      for (let i = 0; i < 4; i++) {
        const c = await course(
          f,
          `capacity-${i}`,
          Array(3).fill("training ".repeat(1333)),
        );
        for (let lesson = 0; lesson < 3; lesson++)
          selected.push({
            kind: "course-text",
            id: c._id,
            lesson_key: lesson ? `text-${lesson}` : "intro",
          });
        assert.equal(await processKnowledgeOne(f.db), true);
      }
      const before = await f.db
        .collection("ai_usage_ledger")
        .findOne({ org_id: f.org });
      const refused = await f.req(f.student, "/knowledge/search", {
        query: "training",
        scope: selected,
      });
      status(refused, 422);
      assert.equal(refused.data.error.code, "KNOWLEDGE_CANDIDATE_LIMIT");
      const after = await f.db
        .collection("ai_usage_ledger")
        .findOne({ org_id: f.org });
      assert.deepEqual(after, before);
    });
  },
);
