"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");
const { MongoClient } = require("mongodb");
const { assessmentFixture, practice, good } = require("./assessment-helpers.cjs");
const { guardedUri } = require("./helpers.cjs");
const { executeAdministrationOperation, recoverAdministrationOperation, AdministrationNeedsRecovery } = require("../dist/administration/operations.js");
const { processOne: gradeOne } = require("../dist/assessment/worker.js");
const { processOne: learnOne, processDue } = require("../dist/learning/worker.js");

const LEARNING = "learning_projection_v1";
const derived = ["learning_projection_inputs", "mastery_evidence", "mastery_snapshots", "mistake_entries", "report_snapshots"];
const memberScope = (f, actor = f.student) => ({ org_id: actor.org, member_id: actor.memberId });
const scope = (f, actor = f.student, subject = f.subject) => ({ ...memberScope(f, actor), subject_id: subject });
const same = (actual, expected, message) => assert.ok(isDeepStrictEqual(actual, expected), message);

function localUri(value) {
  const uri = guardedUri(value);
  const authority = /^mongodb:\/\/([^/]+)\//.exec(uri)?.[1];
  assert.ok(authority, "竞态验收只允许显式本地 MongoDB URI");
  for (const host of authority.split("@").pop().split(",")) assert.match(host, /^(127\.0\.0\.1|localhost):\d+$/);
  return uri;
}
async function until(work, message, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await work();
    if (value) return value;
    await delay(50);
  }
  assert.fail(message);
}
async function rows(f, collection, filter) {
  return f.db.collection(collection).find(filter).sort({ _id: 1 }).toArray();
}
async function accepted(f, consumer) {
  const session = await practice(f);
  const receipt = await good(f.student, `/sessions/${session.id}/submissions`, {
    method: "POST", body: { expected_revision: session.revision, answers: [] },
  }, 202);
  if (consumer === LEARNING) assert.equal(await gradeOne(f.db), true);
  const submission = await f.db.collection("submissions").findOne({ _id: receipt.submission_id });
  const run = await f.db.collection("grading_runs").findOne({ submission_id: submission._id, revision: 1 });
  const event = await f.db.collection("outbox_events").findOne({
    "payload.submission_id": submission._id, target_consumer: consumer,
    event_type: consumer === LEARNING ? "GradeFinalized" : "SubmissionAccepted",
  });
  assert.ok(event);
  assert.equal(event.status, "pending");
  assert.equal(event.attempt, 0);
  return { submission, run, event, consumer };
}

// This is an invocation-local scheduling barrier, not a fake Mongo implementation.
// Each intercepted method completes its real driver call, then waits; its exact
// result is returned unchanged. No process/global timer or prototype is patched.
function suspendedWorker(f, target, stage) {
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  let claimed = false, memberAcquired = false, reached = false, finished = false, renewalIsolated = false;
  const db = new Proxy(f.db, { get(realDb, property) {
    if (property === "collection") return (name, ...args) => {
      const real = realDb.collection(name, ...args);
      return new Proxy(real, { get(collection, method) {
        const value = Reflect.get(collection, method, collection);
        if (typeof value !== "function") return value;
        if (!["findOneAndUpdate", "findOne"].includes(method)) return value.bind(collection);
        return async (...parameters) => {
          const result = await value.apply(collection, parameters);
          if (name === "administration_guard" && method === "findOne" && result?.operation_id &&
            (result.blocked_targets.user_ids.includes(f.student.user.user_id) || result.blocked_targets.org_ids.includes(f.org))) {
            renewalIsolated = true;
          }
          const eventClaim = name === "outbox_events" && method === "findOneAndUpdate" &&
            result?._id === target.event._id && result.status === "running";
          const memberClaim = claimed && name === "student_projection_states" && method === "findOneAndUpdate" &&
            result?.member_id === f.student.memberId && typeof result.lease_token === "string";
          if (eventClaim) claimed = true;
          if (memberClaim) memberAcquired = true;
          const startup = target.consumer === LEARNING ? memberClaim : eventClaim;
          const working = target.consumer === LEARNING
            ? memberAcquired && name === "learning_projection_heads" && method === "findOne" && !parameters[1]?.session
            : claimed && name === "submissions" && method === "findOne" && result?._id === target.submission._id &&
              !parameters[1]?.session && !parameters[1]?.projection;
          if (!reached && (stage === "startup" ? startup : working)) {
            reached = true;
            entered.resolve();
            await released.promise;
          }
          return result;
        };
      } });
    };
    const value = Reflect.get(realDb, property, realDb);
    return typeof value === "function" ? value.bind(realDb) : value;
  } });
  const processOne = target.consumer === LEARNING ? learnOne : gradeOne;
  const result = processOne(db).then(value => { finished = true; return value; }, error => { finished = true; throw error; });
  // Attach a rejection observer immediately; a failed startup must not become an
  // unhandled rejection while the parent is waiting for the scheduling barrier.
  result.catch(() => {});
  return {
    result,
    release: () => released.resolve(),
    async waitForRenewalIsolation() {
      // While main processing is held, only its real renewal loop can observe
      // this guard. Wait for that observation before snapshotting lease facts.
      await until(() => renewalIsolated, "真实续租路径必须观察管理隔离", 20000);
    },
    async wait() {
      await until(() => {
        assert.ok(!finished, "真实 worker 必须到达指定 claim 后屏障，而不是提前退出");
        return reached;
      }, "真实 worker 未到达 claim 后屏障", 20000);
      await entered.promise;
      const event = await f.db.collection("outbox_events").findOne({ _id: target.event._id });
      assert.equal(event.status, "running");
      assert.ok(typeof event.lease_token === "string");
      assert.ok(await f.db.collection("outbox_events").findOne({ _id: event._id, $expr: { $gt: ["$lease_until", "$$NOW"] } }));
      const state = await f.db.collection("student_projection_states").findOne(memberScope(f));
      if (target.consumer === LEARNING) {
        assert.ok(typeof state.lease_token === "string");
        assert.ok(await f.db.collection("student_projection_states").findOne({ ...memberScope(f), $expr: { $gt: ["$lease_until", "$$NOW"] } }));
      }
      return { event, state };
    },
  };
}
async function expire(f, target, claim) {
  // Observe real server time. Never edit attempt, available_at, lease_until,
  // status, projection scheduling fields, or application/database clocks.
  await until(async () => {
    const expired = { $lte: ["$lease_until", "$$NOW"] };
    const event = await f.db.collection("outbox_events").findOne({
      _id: target.event._id, status: "running", lease_token: claim.event.lease_token, $expr: expired,
    });
    if (!event) return false;
    if (target.consumer === LEARNING && !await f.db.collection("student_projection_states").findOne({
      ...memberScope(f), lease_token: claim.state.lease_token, $expr: expired,
    })) return false;
    assert.equal(event.lease_until.getTime(), claim.event.lease_until.getTime(), "隔离或启动屏障期间不得偷偷续租");
    return true;
  }, "未续租的真实事件/成员原 token 租约必须自然到期");
}

async function businessFacts(f, target) {
  const facts = {
    submission: await f.db.collection("submissions").findOne({ _id: target.submission._id }),
    run: await f.db.collection("grading_runs").findOne({ _id: target.run._id }),
    results: await rows(f, "grading_results", { grading_run_id: target.run._id }),
    finalized: (await rows(f, "outbox_events", { event_type: "GradeFinalized", "payload.grading_run_id": target.run._id }))
      .map(event => ({ _id: event._id, aggregate_id: event.aggregate_id, aggregate_version: event.aggregate_version, payload: event.payload })),
    receipts: await rows(f, "consumer_receipts", { event_id: target.event._id }),
    head: await f.db.collection("learning_projection_heads").findOne(scope(f)),
    builds: await rows(f, "learning_projection_builds", scope(f)),
  };
  const state = await f.db.collection("student_projection_states").findOne(memberScope(f));
  facts.state = state ? { projection_revision: state.projection_revision, publication_fence: state.publication_fence } : null;
  for (const name of derived) facts[name] = await rows(f, name, scope(f));
  return facts;
}

async function isolate(f, kind, actor = f.student) {
  const userId = actor.user.user_id, operation_id = randomUUID();
  const user = await f.db.collection("users").findOne({ _id: userId });
  const before = { user_id: userId, identity_revision: user.identity_revision, credential_version: user.credential_version,
    status: user.status, privacy_state: user.privacy_state };
  const desired = { ...before, identity_revision: before.identity_revision + 1 };
  const targets = { user_ids: kind === "subject" ? [userId] : [], member_ids: [],
    org_ids: kind === "org" ? [actor.org] : [], global: false };
  let written;
  await assert.rejects(executeAdministrationOperation({ client: f.client, db: f.db, operation_id,
    actor: "iam-worker-race-operator", reason: "合成主体管理 fence 真实写后中断", action: "iam.verify.worker-fence",
    before, payload: desired, targets,
    apply: async ({ session }) => {
      written = await f.db.collection("users").updateOne({ _id: userId, identity_revision: before.identity_revision },
        { $inc: { identity_revision: 1 } }, { session });
      throw new Error("IAM_WORKER_RACE_AFTER_REAL_FENCE_ACK");
    },
  }), error => error instanceof AdministrationNeedsRecovery && error.operation_id === operation_id);
  assert.equal(written?.modifiedCount, 1, "管理隔离必须来自真实目标写后失败");
  const operation = await f.db.collection("administration_operations").findOne({ _id: operation_id });
  assert.equal(operation.mode, "standalone");
  assert.equal(operation.status, "needs_recovery");
  same(operation.before, before, "核心保存规范化 before，不手造操作意图或回执");
  same(operation.desired, desired, "核心保存规范化 desired，不手造操作 hash");
  const guard = await f.db.collection("administration_guard").findOne({ _id: "administration" });
  assert.equal(guard.state, "needs_recovery");
  assert.equal(guard.operation_id, operation_id);
  assert.equal(guard.recovery_token, null);
  same(guard.blocked_targets, targets, "真实 guard 必须隔离请求的主体/组织范围");
  const verify = async (db, session) => {
    const current = await db.collection("users").findOne({ _id: userId }, { session });
    for (const field of ["identity_revision", "credential_version", "status", "privacy_state"]) {
      assert.equal(current[field], desired[field], `恢复必须核对目标 ${field}，不能误启用或改变凭据`);
    }
    assert.equal((await db.collection("organization_members").findOne({ _id: actor.memberId, user_id: userId, org_id: actor.org }, { session })).status, "active");
    assert.equal((await db.collection("organizations").findOne({ _id: actor.org }, { session })).status, "active");
  };
  await verify(f.db);
  return {
    async recover() {
      // A separate real writer re-reads immutable intent and target facts. No
      // stale approvals, fabricated callbacks/results or force-clearing guard.
      const client = new MongoClient(localUri(f.uri), { serverSelectionTimeoutMS: 5000 });
      try {
        await client.connect();
        const db = client.db();
        await recoverAdministrationOperation({ client, db, operation_id, actor: "iam-worker-race-recovery",
          reason: "独立 writer 核对原不可变 fence 目标后前向完成",
          revalidate: async (op, session) => {
            assert.equal(op._id, operation_id);
            assert.equal(op.status, "needs_recovery");
            same(op.before, before, "恢复 before 必须保持不可变");
            same(op.desired, desired, "恢复 desired 必须保持不可变");
            same(op.targets, targets, "恢复不得扩大隔离范围");
            await verify(db, session);
          },
          finish: async (_op, session) => { await verify(db, session); return { user_id: userId }; },
          verify: async (_op, session) => { await verify(db, session); },
        });
        assert.equal((await db.collection("administration_operations").findOne({ _id: operation_id })).status, "applied");
        const released = await db.collection("administration_guard").findOne({ _id: "administration" });
        assert.equal(released.state, "idle");
        assert.equal(released.operation_id, null);
        assert.equal(released.recovery_token, null);
      } finally { await client.close(); }
    },
  };
}
async function returnedClaim(f, target, beforeAttempt) {
  const event = await f.db.collection("outbox_events").findOne({ _id: target.event._id });
  assert.equal(event.status, "pending");
  assert.equal(event.attempt, beforeAttempt, "只返还刚领取的一次 attempt，保留已有真实 attempt");
  assert.equal(event.error_code, null);
  assert.equal(event.processed_at, null);
  for (const key of ["lease_owner", "lease_token", "lease_until"]) assert.equal(event[key], null);
  if (target.consumer === LEARNING) {
    const state = await f.db.collection("student_projection_states").findOne(memberScope(f));
    for (const key of ["lease_owner", "lease_token", "lease_until"]) assert.equal(state[key], null);
  }
}
async function projectAll(f) {
  for (let n = 0; n < 40; n++) if (!await learnOne(f.db)) {
    assert.equal(await f.db.collection("outbox_events").countDocuments({ target_consumer: LEARNING, status: { $ne: "processed" } }), 0);
    return;
  }
  assert.fail("真实学情队列未收敛");
}
async function published(f, target, attempt) {
  const event = await f.db.collection("outbox_events").findOne({ _id: target.event._id });
  assert.equal(event.status, "processed");
  assert.equal(event.attempt, attempt);
  assert.equal(await f.db.collection("consumer_receipts").countDocuments({ event_id: target.event._id }), 1);
  const submission = await f.db.collection("submissions").findOne({ _id: target.submission._id });
  assert.equal(submission.grading_status, "completed");
  assert.equal(submission.effective_grading_revision, 1);
  assert.equal(submission.total_score.toString(), "0.00");
  const results = await rows(f, "grading_results", { grading_run_id: target.run._id });
  assert.equal(results.length, 3);
  for (const row of results) { assert.equal(row.score.toString(), "0.00"); assert.equal(row.verdict, "unanswered"); }
  const head = await f.db.collection("learning_projection_heads").findOne(scope(f));
  assert.ok(head.active_generation);
  assert.equal(head.failure_attempts, 0);
  assert.equal(head.error_code, null);
  assert.equal(head.rebuild_requested, false);
  const build = await f.db.collection("learning_projection_builds").findOne({ ...scope(f), generation: head.active_generation });
  assert.equal(build.status, "complete");
  same(build.actual_counts, build.expected_counts, "仅完整 generation 可发布");
  assert.equal(await f.db.collection("learning_projection_inputs").countDocuments({ ...scope(f), generation: head.active_generation, submission_id: submission._id }), 1);
  assert.equal(await f.db.collection("mastery_evidence").countDocuments({ ...scope(f), generation: head.active_generation, submission_id: submission._id }), 3);
  const visible = await good(f.student, `/submissions/${submission._id}`);
  assert.equal(visible.release_status, "released");
  assert.equal(visible.total_score, "0.00");
  const report = await good(f.student, `/me/reports?subject_id=${f.subject}&period=7d`);
  assert.equal(report.source_watermark, `learning_v1:${head.active_generation}`);
  const count = await f.db.collection("submissions").countDocuments({ ...memberScope(f), grading_status: "completed" });
  assert.equal(report.activity.submission_count, count);
  assert.equal(report.activity.attempt_count, count * 3);
  assert.equal(report.activity.unanswered_count, count * 3);
  await projectAll(f);
}
async function resume(f, target, attempt) {
  assert.equal(await (target.consumer === LEARNING ? learnOne(f.db) : gradeOne(f.db)), true);
  await projectAll(f);
  await published(f, target, attempt);
}

// The reachable after-claim isolation race is standalone's partially applied
// management operation. Replica-set rollback/atomic publication is exercised by
// administration-operations and the original worker suites, not faked here.
test("IAM standalone：claim 后管理隔离、自然过期/接管/processed 与到期投影公平消费", {
  concurrency: false, timeout: 600000,
}, async parent => {
  localUri(process.env.TEST_STANDALONE_MONGODB_URI);
  const f = await assessmentFixture(parent, { topology: "standalone", env: { FILE_SCAN_ENABLED: "false" } });
  for (const consumer of ["grading_v1", LEARNING]) {
    await parent.test(`${consumer} 已工作 claim 后主体隔离：不发布并返还本次 attempt`, async () => {
      const target = await accepted(f, consumer), worker = suspendedWorker(f, target, "working");
      try {
        const claim = await worker.wait();
        assert.equal(claim.event.attempt, 1);
        const facts = await businessFacts(f, target);
        const isolation = await isolate(f, "subject");
        worker.release();
        assert.equal(await worker.result, false);
        await returnedClaim(f, target, 0);
        same(await businessFacts(f, target), facts, "主体隔离不得更新评分、投影 head/generation、输入 revision、失败预算或 receipt");
        assert.equal(await (consumer === LEARNING ? learnOne(f.db) : gradeOne(f.db)), false);
        await returnedClaim(f, target, 0);
        await isolation.recover();
        await resume(f, target, 1);
      } finally { worker.release(); await worker.result.catch(() => {}); }
    });

    await parent.test(`${consumer} 新 token 不被旧 worker 退还，组织隔离下已过期原 token 仍只退一次`, async () => {
      const target = await accepted(f, consumer), old = suspendedWorker(f, target, "startup");
      let current;
      try {
        const first = await old.wait();
        await expire(f, target, first);
        current = suspendedWorker(f, target, "working");
        let second = await current.wait();
        assert.equal(second.event.attempt, 2, "必须经过两个真实 worker 的领取");
        assert.notEqual(second.event.lease_token, first.event.lease_token);
        if (consumer === LEARNING) assert.notEqual(second.state.lease_token, first.state.lease_token);
        const facts = await businessFacts(f, target);
        const isolation = await isolate(f, "org");
        await current.waitForRenewalIsolation();
        second = await current.wait();
        assert.equal(second.event.attempt, 2);
        old.release();
        assert.equal(await old.result, false);
        same(await f.db.collection("outbox_events").findOne({ _id: target.event._id }), second.event, "旧 token 不得退还新 worker 的 attempt 或清除其 lease");
        if (consumer === LEARNING) same(await f.db.collection("student_projection_states").findOne(memberScope(f)), second.state, "旧成员 token 不得清除后继真实成员 lease");
        // The old worker is held before renewal starts. The current worker has
        // entered its real renewal loop, whose administration gate now prevents
        // renewal writes; its original token must still expire without takeover.
        await expire(f, target, second);
        current.release();
        assert.equal(await current.result, false);
        await returnedClaim(f, target, 1);
        same(await businessFacts(f, target), facts, "已过期但未再接管的本 worker 隔离暂停不得误发布或消耗失败预算");
        await isolation.recover();
        await resume(f, target, 2);
      } finally {
        old.release(); current?.release();
        await Promise.allSettled([old.result, ...(current ? [current.result] : [])]);
      }
    });

    await parent.test(`${consumer} 后继真实消费 processed 后，隔离旧 worker 不得退款或重写发布`, async () => {
      const target = await accepted(f, consumer), old = suspendedWorker(f, target, "startup");
      try {
        const first = await old.wait();
        await expire(f, target, first);
        assert.equal(await (consumer === LEARNING ? learnOne(f.db) : gradeOne(f.db)), true);
        await projectAll(f);
        const processed = await f.db.collection("outbox_events").findOne({ _id: target.event._id });
        assert.equal(processed.status, "processed");
        assert.equal(processed.attempt, 2);
        const facts = await businessFacts(f, target);
        const state = await f.db.collection("student_projection_states").findOne(memberScope(f));
        const isolation = await isolate(f, "org");
        old.release();
        assert.equal(await old.result, false);
        same(await f.db.collection("outbox_events").findOne({ _id: target.event._id }), processed, "processed 事件不得被过时 worker 退回 pending 或退还 attempt");
        same(await f.db.collection("student_projection_states").findOne(memberScope(f)), state, "旧 worker 不得改变后继发布的成员状态");
        same(await businessFacts(f, target), facts, "后继实际评分/generation/receipt 不得被旧 worker 改写");
        await isolation.recover();
        assert.equal(await (consumer === LEARNING ? learnOne(f.db) : gradeOne(f.db)), false);
        await published(f, target, 2);
      } finally { old.release(); await old.result.catch(() => {}); }
    });
  }

  await parent.test("51 个真实 HTTP 生成的隔离到期 heads 在前：processDue 仍发布正常成员且不改隔离 head", async () => {
    const blocked = await f.actor();
    const now = (await f.db.command({ hello: 1 })).localTime;
    const subjects = Array.from({ length: 51 }, () => randomUUID());
    await f.db.collection("subjects").insertMany(subjects.map((id, index) => ({
      _id: id, code: `iam-prefix-${index}`, name: `隔离到期学科 ${index}`, created_at: now, updated_at: now,
    })));
    // Let the real student HTTP read create all legal zero-input pending heads,
    // scope revisions and member state. No hand-constructed head/schema defaults.
    for (const subject of subjects) {
      const response = await good(blocked, `/me/reports?subject_id=${subject}&period=7d`);
      assert.equal(response.status, "insufficient_evidence");
      assert.equal(response.source_watermark, null);
    }
    const target = await accepted(f, "grading_v1");
    assert.equal(await gradeOne(f.db), true);
    const updating = await good(f.student, `/me/reports?subject_id=${f.subject}&period=7d`);
    assert.equal(updating.status, "updating");
    const filter = memberScope(f, blocked);
    const blockedHeads = await rows(f, "learning_projection_heads", filter);
    assert.equal(blockedHeads.length, 51);
    for (const head of blockedHeads) { assert.equal(head.rebuild_requested, true); assert.equal(head.active_generation, null); }
    const normalBefore = await f.db.collection("learning_projection_heads").findOne(scope(f));
    const due = await f.db.collection("learning_projection_heads").find({ rule_version: "learning_v1", $expr: { $lte: ["$next_check_at", "$$NOW"] } })
      .sort({ next_check_at: 1, _id: 1 }).toArray();
    assert.equal(due.length, 52);
    assert.ok(due.slice(0, 51).every(head => head.member_id === blocked.memberId), "至少跨完整 50 行 cursor batch 的隔离前缀");
    assert.equal(due[51].member_id, f.student.memberId);
    const stateBefore = await f.db.collection("student_projection_states").findOne(filter);
    const scopesBefore = await rows(f, "learning_scope_states", { org_id: f.org, subject_id: { $in: subjects } });
    const isolation = await isolate(f, "subject", blocked);
    assert.equal(await processDue(f.db), 1, "检查隔离行不应耗尽 50 个实际处理名额");
    same(await rows(f, "learning_projection_heads", filter), blockedHeads, "不能通过改变 next_check_at/rebuild_requested/error/retry/generation 绕开隔离前缀");
    same(await f.db.collection("student_projection_states").findOne(filter), stateBefore, "隔离 heads 不得被领取成员 lease 或增加 publication_fence");
    same(await rows(f, "learning_scope_states", { org_id: f.org, subject_id: { $in: subjects } }), scopesBefore, "隔离 heads 不得触碰 scope revisions");
    for (const name of [...derived, "learning_projection_builds"]) assert.equal(await f.db.collection(name).countDocuments(filter), 0);
    const normalAfter = await f.db.collection("learning_projection_heads").findOne(scope(f));
    assert.ok(normalAfter.active_generation);
    assert.notEqual(normalAfter.active_generation, normalBefore.active_generation);
    assert.equal(normalAfter.error_code, null);
    assert.equal(normalAfter.failure_attempts, 0);
    assert.equal(normalAfter.rebuild_requested, false);
    const report = await good(f.student, `/me/reports?subject_id=${f.subject}&period=7d`);
    assert.equal(report.source_watermark, `learning_v1:${normalAfter.active_generation}`);
    assert.equal(report.activity.submission_count, await f.db.collection("submissions").countDocuments({ ...memberScope(f), grading_status: "completed" }));
    await isolation.recover();
    await until(async () => {
      if (!await f.db.collection("learning_projection_heads").countDocuments({ ...filter, active_generation: null })) return true;
      await processDue(f.db);
      return false;
    }, "解除隔离后全部真实到期 heads 必须恢复发布", 90000);
    const recovered = await rows(f, "learning_projection_heads", filter);
    for (const head of recovered) {
      assert.ok(head.active_generation);
      assert.equal(head.failure_attempts, 0);
      assert.equal(head.rebuild_requested, false);
      const build = await f.db.collection("learning_projection_builds").findOne({ ...filter, subject_id: head.subject_id, generation: head.active_generation });
      assert.equal(build.status, "complete");
      assert.equal(build.expected_counts.inputs, 0);
      assert.equal(build.expected_counts.evidence, 0);
      const reports = await rows(f, "report_snapshots", { ...filter, subject_id: head.subject_id, generation: head.active_generation });
      assert.equal(reports.length, 2);
      for (const row of reports) { assert.equal(row.submission_count, 0); assert.equal(row.attempt_count, 0); }
    }
    await projectAll(f);
    assert.equal((await f.db.collection("submissions").findOne({ _id: target.submission._id })).grading_status, "completed");
  });
});
