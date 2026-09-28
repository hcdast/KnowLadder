"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { Decimal128 } = require("mongodb");
const { fixture } = require("./helpers.cjs");
const { AssessmentSources } = require("../dist/content/assessment-sources.js");
const { fileReferenced } = require("../dist/files/references.js");
const { processDeletion } = require("../dist/files/worker.js");
const { V3_DEFAULTS } = require("../dist/migrations/content-v3.js");
const code = expected => error => error.getResponse?.().error?.code === expected || error.getResponse?.().code === expected;
async function setup(t, env = {}) {
  const f = await fixture(t, { app: false, env });
  f.org = randomUUID(); f.user = randomUUID(); f.member = randomUUID();
  f.sources = new AssessmentSources(f.db);
  f.tx = async (work, changes = {}) => {
    const session = f.client.startSession();
    try { return await session.withTransaction(() => work({ orgId: f.org, userId: f.user, memberId: f.member, capabilities: ["learning:self"], session, requestId: randomUUID(), ...changes })); }
    finally { await session.endSession(); }
  };
  const now = new Date(); const subject = randomUUID(); const knowledge = randomUUID();
  await f.db.collection("subjects").insertOne({ _id: subject, code: "assessment-security", name: "安全验收", created_at: now, updated_at: now });
  await f.db.collection("knowledge_points").insertOne({ _id: knowledge, code: "assessment-security", name: "安全验收", subject_id: subject, created_at: now, updated_at: now });
  f.question = { _id: randomUUID(), org_id: f.org, title: "安全题", status: "published", revision: 1,
    created_by: randomUUID(), contributors: [], created_at: now, updated_at: now, submitted_by: randomUUID(), submitted_at: now,
    published_by: randomUUID(), published_at: now, source_version_id: null, license: { source: "自主测试材料", granted: true, expires_at: null }, resource_ids: [], notes: "",
    ...V3_DEFAULTS.question_versions, question_id: randomUUID(), version_no: 1, subject_id: subject, question_type: "single", prompt: "选择一项", options: [{ id: "A", text: "甲" }, { id: "B", text: "乙" }], answer: "A", explanation: "测试解析",
    knowledge_point_ids: [knowledge], difficulty: "基础", scoring_rule: { version: 1, strategy: "single_exact", max_score: "1" }, knowledge_weights: [{ knowledge_point_id: knowledge, weight_bps: 10000 }], difficulty_basis: "测试依据" };
  await f.db.collection("question_versions").insertOne(f.question);
  f.quiz = async () => {
    const row = { _id: randomUUID(), org_id: f.org, created_at: now, updated_at: now, title: "保密考试", subject_id: subject, status: "published", revision: 1, created_by: randomUUID(), contributors: [], published_by: randomUUID(), published_at: now,
      opens_at: new Date(now.getTime() - 60000), closes_at: new Date(now.getTime() + 60000), release_at: new Date(now.getTime() + 120000), duration_seconds: 60, max_attempts: 1, published_paper_id: randomUUID(), visibility_revision: 0 };
    await f.db.collection("quizzes").insertOne(row); return row;
  };
  f.file = async () => {
    const bytes = Buffer.from("保留快照附件");
    const row = { _id: randomUUID(), org_id: f.org, owner_type: "question", owner_version_id: f.question._id, created_by: f.user, display_name: "snapshot.txt", storage_key: randomUUID(), declared_size: bytes.length, declared_mime: "text/plain", declared_checksum: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length, mime: "text/plain", checksum: createHash("sha256").update(bytes).digest("hex"), status: "ready", scan_status: "clean", scan_attempt: 1, lease_token: null, lease_until: null, available_at: now, uploaded_at: now, error_code: null, created_at: now, updated_at: now, ...V3_DEFAULTS.file_resources };
    await f.db.collection("file_resources").insertOne(row);
    await f.db.collection("question_versions").updateOne({ _id: f.question._id }, { $set: { resource_ids: [row._id] } });
    return row;
  };
  return f;
}

function gate(t) {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  t.after(release);
  return { promise, release };
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("并发事务未到达预期屏障")), 10000);
    })]);
  } finally { clearTimeout(timer); }
}

// Observe an actual driver write conflict; never replace a query result or
// emulate a transaction. Only the worker gets this forwarding wrapper.
function observeOwnerConflict(db, notify) {
  return new Proxy(db, { get(target, key) {
    if (key === "collection") return (name, ...args) => {
      const collection = target.collection(name, ...args);
      if (name !== "question_versions") return collection;
      return new Proxy(collection, { get(c, method) {
        if (method === "updateOne") return async (...input) => {
          try { return await c.updateOne(...input); }
          catch (error) {
            if (error.code === 112 && error.hasErrorLabel?.("TransientTransactionError")) notify();
            throw error;
          }
        };
        const value = Reflect.get(c, method);
        return typeof value === "function" ? value.bind(c) : value;
      } });
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

// Pause only the first real lease renewal, after the claim transaction committed.
// Every operation still reaches MongoDB unchanged; no successful result is mocked.
function pauseClaimedDeletion(db, claimed, resume) {
  let paused = false;
  return new Proxy(db, { get(target, key) {
    if (key === "collection") return (name, ...args) => {
      const collection = target.collection(name, ...args);
      if (name !== "file_resources") return collection;
      return new Proxy(collection, { get(c, method) {
        if (method === "updateOne") return async (...input) => {
          if (!paused && input[0].status === "deleting" && !input[2]?.session) {
            paused = true;
            claimed.release();
            await bounded(resume.promise);
          }
          return c.updateOne(...input);
        };
        const value = Reflect.get(c, method);
        return typeof value === "function" ? value.bind(c) : value;
      } });
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

async function frozenBinding(f, type, snapshot) {
  const now = new Date();
  const base = { org_id: f.org, created_at: now, updated_at: now };
  const parentId = randomUUID(), referenceId = randomUUID();
  const isPaper = type === "paper_item";
  const parentCollection = isPaper ? "papers" : "sessions";
  const itemCollection = isPaper ? "paper_items" : "session_items";
  const parent = isPaper
    ? { ...base, _id: parentId, quiz_id: (await f.quiz())._id, revision: 1, status: "frozen" }
    : { ...base, _id: parentId, user_id: f.user, member_id: f.member, mode: "practice", quiz_id: null, paper_id: null,
      textbook_edition_id: null, chapter_id: null, knowledge_point_ids: snapshot.knowledge_point_ids, difficulty: null,
      status: "in_progress", revision: 1, started_at: now, deadline_at: null, submitted_at: null, submission_id: null, item_count: 1 };
  const item = { ...base, _id: referenceId, [isPaper ? "paper_id" : "session_id"]: parentId,
    position: 0, snapshot, max_score: Decimal128.fromString(snapshot.scoring_rule.max_score) };
  return {
    parentCollection, itemCollection, parentId, referenceId,
    async stage(ctx) {
      await f.db.collection(parentCollection).insertOne(parent, { session: ctx.session });
      // Match production: management stages paper items before reference checks;
      // session freezing stages each item only after its reference succeeds.
      if (isPaper) await f.db.collection(itemCollection).insertOne(item, { session: ctx.session });
    },
    async reference(ctx) {
      await f.sources.reference(ctx, snapshot, type, referenceId);
      if (!isPaper) await f.db.collection(itemCollection).insertOne(item, { session: ctx.session });
    },
  };
}

async function cleanupIntent(f, file) {
  // An old accepted cleanup intent is injected deliberately, without using
  // the public scheduling guard. This exercises the worker's independent fence.
  await f.db.collection("file_resources").updateOne({ _id: file._id }, { $set: {
    retention_until: new Date(0), available_at: new Date(0), deletion_requested_at: new Date(0),
    deletion_requested_by: f.user, deletion_requested_reason: "并发验收旧清理意图",
  } });
}
test("评估来源安全：正式v4约束、当前许可、披露竞争与保留引用", { concurrency: false, timeout: 180000 }, async t => {
  await t.test("学习/独立评估/worker同事务授权，跨组织及内容权限不冒充", async t => {
    const f = await setup(t);
    for (const changes of [{}, { capabilities: ["assessment:manage"] }, { userId: "system:assessment", capabilities: ["assessment:worker"] }]) {
      const result = await f.tx(ctx => f.sources.question(ctx, f.question._id, true), changes);
      assert.equal(result.answer, "A"); assert.match(result.display_digest, /^[a-f0-9]{64}$/);
    }
    await assert.rejects(f.tx(ctx => f.sources.question(ctx, f.question._id, true), { capabilities: ["content:edit"] }), code("FORBIDDEN"));
    await assert.rejects(f.tx(ctx => f.sources.question(ctx, f.question._id, true), { capabilities: ["assessment:worker"] }), code("FORBIDDEN"));
    await assert.rejects(f.tx(ctx => f.sources.question(ctx, f.question._id, true), { orgId: randomUUID() }), code("CONTENT_UNAVAILABLE"));
    await f.db.collection("question_versions").updateOne({ _id: f.question._id }, { $set: { status: "retired" } });
    await f.tx(ctx => f.sources.question(ctx, f.question._id, false));
    await assert.rejects(f.tx(ctx => f.sources.question(ctx, f.question._id, true)), code("CONTENT_UNAVAILABLE"));
    await f.db.collection("question_versions").updateOne({ _id: f.question._id }, { $set: { "license.expires_at": new Date(0).toISOString() } });
    await assert.rejects(f.tx(ctx => f.sources.question(ctx, f.question._id, false)), code("CONTENT_UNAVAILABLE"));
    await f.db.collection("question_versions").updateOne({ _id: f.question._id }, { $set: { "license.expires_at": null, access_revoked_at: new Date() } });
    await assert.rejects(f.tx(ctx => f.sources.question(ctx, f.question._id, false)), code("CONTENT_UNAVAILABLE"));
  });
  await t.test("并发发布与聚合反馈恰一获准；披露永久阻止新考试", async t => {
    const f = await setup(t); const quiz = await f.quiz();
    await f.tx(ctx => f.sources.guard(ctx, [f.question._id], "practice"));
    const results = await Promise.allSettled([
      f.tx(ctx => f.sources.guard(ctx, [f.question._id], "publish", quiz._id)),
      f.tx(ctx => f.sources.guard(ctx, [f.question._id], "feedback")),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const row = await f.db.collection("assessment_question_states").findOne({ question_version_id: f.question._id });
    assert.equal(row.answer_disclosed, row.embargo_quiz_id === null);
    if (row.answer_disclosed) await assert.rejects(f.tx(ctx => f.sources.guard(ctx, [f.question._id], "publish", quiz._id)), code("QUESTION_EMBARGOED"));
    else {
      await assert.rejects(f.tx(ctx => f.sources.guard(ctx, [f.question._id], "practice")), code("QUESTION_EMBARGOED"));
      await assert.rejects(f.tx(ctx => f.sources.guard(ctx, [f.question._id], "feedback")), code("QUESTION_EMBARGOED"));
      await f.tx(ctx => f.sources.guard(ctx, [f.question._id], "quiz", quiz._id));
      await assert.rejects(f.tx(ctx => f.sources.guard(ctx, [f.question._id], "quiz", randomUUID())), code("QUESTION_EMBARGOED"));
    }
  });
  await t.test("整份反馈原子检查，后项保密使前项披露回滚", async t => {
    const f = await setup(t); const quiz = await f.quiz();
    const second = { ...f.question, _id: randomUUID(), question_id: randomUUID() };
    await f.db.collection("questions").insertMany([f.question, second].map(question => ({
      _id: question.question_id, org_id: question.org_id, next_version_no: 2,
      created_at: question.created_at, updated_at: question.updated_at,
    })));
    await f.db.collection("question_versions").insertOne(second);
    const ids = [f.question._id, second._id].sort();
    await f.tx(ctx => f.sources.guard(ctx, [ids[1]], "publish", quiz._id));
    await assert.rejects(f.tx(ctx => f.sources.guard(ctx, ids, "feedback")), code("QUESTION_EMBARGOED"));
    assert.equal(await f.db.collection("assessment_question_states").countDocuments({ question_version_id: ids[0] }), 0);
  });
  await t.test("引用阻断worker且不依赖当前来源合法性；清理先提交拒绝新引用", async t => {
    const f = await setup(t); const file = await f.file(); let snapshot;
    await f.tx(async ctx => { snapshot = await f.sources.question(ctx, f.question._id, true); await f.sources.reference(ctx, snapshot, "session_item", randomUUID()); });
    await f.db.collection("question_versions").updateOne({ _id: f.question._id }, { $set: { resource_ids: [], status: "retired", access_revoked_at: new Date() } });
    await f.db.collection("file_resources").updateOne({ _id: file._id }, { $set: { retention_until: new Date(0), available_at: new Date(0), deletion_requested_at: new Date(0), deletion_requested_by: f.user, deletion_requested_reason: "安全验收" } });
    assert.equal(await f.tx(ctx => fileReferenced(f.db, file._id, ctx.session)), true);
    assert.equal(await processDeletion(f.db), false);
    assert.equal((await f.db.collection("file_resources").findOne({ _id: file._id })).deleted_at, null);
    await f.db.collection("question_versions").updateOne({ _id: f.question._id }, { $set: { resource_ids: [file._id], status: "published", access_revoked_at: null } });
    await assert.rejects(f.tx(ctx => f.sources.reference(ctx, snapshot, "paper_item", randomUUID())), code("FILE_NOT_READY"));
    assert.equal(await f.db.collection("assessment_resource_references").countDocuments(), 1);
  });
  await t.test("附件摘要按内容而非UUID，附件改变产生不同摘要", async t => {
    const f = await setup(t); const file = await f.file(); const original = await f.tx(ctx => f.sources.question(ctx, f.question._id, true));
    const next = { ...file, _id: randomUUID(), storage_key: randomUUID() }; await f.db.collection("file_resources").insertOne(next);
    const renamed = { ...original, resource_ids: [next._id] };
    assert.equal(await f.sources.digest(renamed), original.display_digest);
    await f.db.collection("file_resources").updateOne({ _id: next._id }, { $set: { checksum: "f".repeat(64) } });
    assert.notEqual(await f.sources.digest(renamed), original.display_digest);
  });
  for (const type of ["session_item", "paper_item"]) {
    await t.test(`${type}正常来源仍挂附件：未提交引用不允许删除领取`, async t => {
      const f = await setup(t, { FILE_STORAGE_ROOT: "" });
      const file = await f.file();
      const snapshot = await f.tx(ctx => f.sources.question(ctx, f.question._id, true));
      const frozen = await frozenBinding(f, type, snapshot);
      const ready = gate(t), commit = gate(t);
      const binding = f.tx(async ctx => {
        await frozen.stage(ctx);
        await frozen.reference(ctx);
        ready.release();
        await bounded(commit.promise);
      }).then(() => null, error => error);
      try {
        await bounded(ready.promise);
        await cleanupIntent(f, file);
        assert.equal(await f.db.collection("assessment_resource_references").countDocuments(), 0);
        // The committed content reference already protects the file. In the
        // normal model deletion cannot win while a source still owns this ID.
        assert.equal(await processDeletion(f.db), false);
        commit.release();
        assert.equal(await binding, null);
      } finally { commit.release(); await binding; }
      const retained = await f.db.collection("file_resources").findOne({ _id: file._id });
      assert.equal(retained.status, "ready");
      assert.equal(retained.deleted_at, null);
      assert.equal(retained.deletion_attempt, 0);
      assert.equal(retained.deletion_lease_token, null);
      assert.equal(retained.deletion_lease_until, null);
      assert.deepEqual((await f.db.collection(frozen.itemCollection).findOne({ _id: frozen.referenceId })).snapshot, snapshot);
      assert.equal(await f.db.collection("assessment_resource_references").countDocuments({ reference_type: type, reference_id: frozen.referenceId, file_id: file._id }), 1);
      assert.equal(await f.db.collection("audit_events").countDocuments({ action: "file.deletion.claim" }), 0);
    });
    await t.test(`${type}引用先提交：worker真实写冲突后重读并拒绝领取`, async t => {
      const f = await setup(t, { FILE_STORAGE_ROOT: "" });
      const file = await f.file();
      const snapshot = await f.tx(ctx => f.sources.question(ctx, f.question._id, true));
      // Maintenance-fault injection, not a public assessment operation: detach
      // the owner then restore it inside the binding transaction. Without this,
      // fileReferenced stops deletion before it can reach the shared owner fence.
      await f.db.collection("question_versions").updateOne({ _id: f.question._id }, { $set: { resource_ids: [] } });
      const ready = gate(t), commit = gate(t), conflict = gate(t);
      const frozen = await frozenBinding(f, type, snapshot);
      const binding = f.tx(async ctx => {
        await frozen.stage(ctx);
        await f.db.collection("question_versions").updateOne({ _id: f.question._id }, { $set: { resource_ids: [file._id] } }, { session: ctx.session });
        await frozen.reference(ctx);
        ready.release();
        await bounded(commit.promise);
      });
      const bindingResult = binding.then(() => null, error => error);
      let workerResult;
      try {
        await bounded(ready.promise);
        assert.equal(await f.db.collection("assessment_resource_references").countDocuments(), 0);
        assert.equal(await f.db.collection(frozen.parentCollection).countDocuments({ _id: frozen.parentId }), 0);
        assert.equal(await f.db.collection(frozen.itemCollection).countDocuments({ _id: frozen.referenceId }), 0);
        await cleanupIntent(f, file);
        workerResult = processDeletion(observeOwnerConflict(f.db, conflict.release)).then(value => ({ value }), error => ({ error }));
        await bounded(conflict.promise);
        commit.release();
        assert.equal(await bindingResult, null);
        assert.deepEqual(await bounded(workerResult), { value: false });
      } finally {
        commit.release();
        await bindingResult;
        if (workerResult) await workerResult;
      }
      const retained = await f.db.collection("file_resources").findOne({ _id: file._id });
      assert.equal(retained.status, "ready");
      assert.equal(retained.deleted_at, null);
      assert.equal(retained.deletion_attempt, 0);
      assert.equal(retained.deletion_lease_token, null);
      assert.equal(retained.deletion_lease_until, null);
      assert.equal(await f.db.collection(frozen.parentCollection).countDocuments({ _id: frozen.parentId }), 1);
      assert.deepEqual((await f.db.collection(frozen.itemCollection).findOne({ _id: frozen.referenceId })).snapshot, snapshot);
      assert.equal(await f.db.collection("assessment_resource_references").countDocuments({ reference_type: type, reference_id: frozen.referenceId, file_id: file._id }), 1);
      assert.equal(await f.db.collection("audit_events").countDocuments({ action: "file.deletion.claim" }), 0);
    });
    await t.test(`${type}删除先领取：有效租约期间旧快照重试失败并完整回滚`, async t => {
      const f = await setup(t, { FILE_STORAGE_ROOT: "" });
      const file = await f.file();
      const snapshot = await f.tx(ctx => f.sources.question(ctx, f.question._id, true));
      await f.db.collection("question_versions").updateOne({ _id: f.question._id }, { $set: { resource_ids: [] } });
      // Same maintenance-fault boundary as above; normal attached sources
      // cannot legitimately reach a deletion claim before binding.
      const frozen = await frozenBinding(f, type, snapshot);
      const read = gate(t), resume = gate(t);
      const claimedGate = gate(t), finishDeletion = gate(t);
      let attempts = 0;
      const binding = f.tx(async ctx => {
        attempts++;
        // Establish a real snapshot before the worker commits its claim.
        await f.db.collection("question_versions").findOne({ _id: f.question._id }, { session: ctx.session });
        if (attempts === 1) { read.release(); await bounded(resume.promise); }
        await frozen.stage(ctx);
        await f.db.collection("question_versions").updateOne({ _id: f.question._id }, { $set: { resource_ids: [file._id] } }, { session: ctx.session });
        await frozen.reference(ctx);
      });
      const bindingResult = binding.then(() => null, error => error);
      let workerResult;
      try {
        await bounded(read.promise);
        await cleanupIntent(f, file);
        workerResult = processDeletion(pauseClaimedDeletion(f.db, claimedGate, finishDeletion)).then(value => ({ value }), error => ({ error }));
        await bounded(claimedGate.promise);
        const active = await f.db.collection("file_resources").findOne({ _id: file._id });
        assert.equal(active.status, "deleting");
        assert.equal(active.deleted_at, null);
        assert.equal(active.deletion_attempt, 1);
        assert.match(active.deletion_lease_token, /^[a-f0-9-]{36}$/);
        assert.ok(active.deletion_lease_until > new Date());
        assert.equal(active.error_code, null);
        assert.equal(await f.db.collection("audit_events").countDocuments({ action: "file.deletion.claim", resource_id: file._id }), 1);
        resume.release();
        assert.ok(code("FILE_NOT_READY")(await bounded(bindingResult)), "删除领取后引用必须因FILE_NOT_READY失败");
        assert.equal(await f.db.collection(frozen.parentCollection).countDocuments({ _id: frozen.parentId }), 0);
        assert.equal(await f.db.collection(frozen.itemCollection).countDocuments({ _id: frozen.referenceId }), 0);
        assert.equal(await f.db.collection("assessment_resource_references").countDocuments(), 0);
        finishDeletion.release();
        assert.deepEqual(await bounded(workerResult), { value: true });
      } finally {
        resume.release(); finishDeletion.release();
        await bindingResult;
        if (workerResult) await workerResult;
      }
      assert.ok(attempts >= 2, "旧快照必须经历真实事务冲突及重试");
      const claimed = await f.db.collection("file_resources").findOne({ _id: file._id });
      assert.equal(claimed.status, "deleting");
      assert.equal(claimed.deletion_attempt, 1);
      // This is a transaction test: no filesystem or scanner is configured.
      // A claimed deletion must remain unavailable even when physical deletion fails.
      assert.equal(claimed.error_code, "FILE_DELETE_FAILED");
      assert.equal(claimed.deleted_at, null);
      assert.equal(claimed.deletion_lease_token, null);
      assert.equal(claimed.deletion_lease_until, null);
      assert.ok(claimed.available_at > claimed.updated_at);
      assert.equal(await f.db.collection(frozen.parentCollection).countDocuments({ _id: frozen.parentId }), 0);
      assert.equal(await f.db.collection(frozen.itemCollection).countDocuments({ _id: frozen.referenceId }), 0);
      assert.equal(await f.db.collection("audit_events").countDocuments({ action: "file.deletion.retry", resource_id: file._id }), 1);
      assert.equal(await f.db.collection("audit_events").countDocuments({ action: "file.deletion.completed", resource_id: file._id }), 0);
      assert.equal(await f.db.collection("assessment_resource_references").countDocuments(), 0);
      assert.deepEqual((await f.db.collection("question_versions").findOne({ _id: f.question._id })).resource_ids, []);
      assert.equal(await f.db.collection("audit_events").countDocuments({ action: "file.deletion.claim", resource_id: file._id }), 1);
    });
  }
});
