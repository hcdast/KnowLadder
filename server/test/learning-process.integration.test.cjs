"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fork, spawn } = require("node:child_process");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { assessmentFixture, practice, good } = require("./assessment-helpers.cjs");
const { guardedUri } = require("./helpers.cjs");

const CONSUMER = "learning_projection_v1";
const details = [
  ["learning_projection_inputs", "inputs"], ["mastery_evidence", "evidence"],
  ["mastery_snapshots", "mastery"], ["mistake_entries", "mistakes"],
  ["report_snapshots", "reports"],
];
async function until(work, description, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await work();
    if (result) return result;
    await delay(100);
  }
  assert.fail(description);
}
function monitor(child) {
  let closed, failure;
  const messages = [];
  let stdout = "";
  child.on("message", message => messages.push(message));
  child.on("error", () => { failure = true; });
  child.on("close", (code, signal) => { closed = { code, signal }; });
  child.stdout?.on("data", chunk => { stdout += chunk.toString(); });
  return {
    child,
    async message(type) {
      return until(() => {
        assert.ok(!failure && !closed && !messages.some(message => message.type === "failed"), "学情子进程提前失败");
        return messages.find(message => message.type === type);
      }, `子进程未到达 ${type}`, 20000);
    },
    async finish() {
      const result = await until(() => {
        assert.ok(!failure, "无法启动学情子进程");
        return closed;
      }, "学情 CLI 未在期限内退出", 30000);
      assert.equal(result.code, 0, "学情 CLI 应成功退出");
      assert.equal(result.signal, null);
      return JSON.parse(stdout.trim());
    },
    async stop() {
      if (!closed) assert.equal(child.kill("SIGKILL"), true, "应成功终止已知测试子进程");
      return until(() => closed, "学情子进程未在终止后退出", 10000);
    },
  };
}
async function once(uri) {
  const worker = monitor(spawn(process.execPath, [path.join(__dirname, "../dist/learning/worker.js"), "once"], {
    env: { ...process.env, MONGODB_URI: guardedUri(uri) },
    stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
  }));
  try { return await worker.finish(); }
  finally { await worker.stop(); }
}
async function acceptedAndGraded(f) {
  const session = await practice(f);
  const receipt = await good(f.student, `/sessions/${session.id}/submissions`, {
    method: "POST", body: { expected_revision: session.revision, answers: [] },
  }, 202);
  const { processOne } = require("../dist/assessment/worker.js");
  for (let attempt = 0; attempt < 20; attempt++) {
    const submission = await f.db.collection("submissions").findOne({ _id: receipt.submission_id });
    if (submission.grading_status === "completed") {
      const result = await good(f.student, `/submissions/${receipt.submission_id}`);
      assert.equal(result.release_status, "released");
      return receipt.submission_id;
    }
    assert.ok(["pending", "running"].includes(submission.grading_status));
    assert.equal(await processOne(f.db), true);
  }
  assert.fail("真实评分未完成");
}

test("S4-02 真实进程在明细写入后被杀：自然租约到期才恢复并由 CLI 发布一次", {
  concurrency: false, timeout: 180000,
}, async t => {
  const uri = guardedUri(process.env.TEST_MONGODB_URI);
  const authority = /^mongodb:\/\/([^/]+)\//.exec(uri)?.[1];
  assert.ok(authority, "进程验收须显式提供隔离三节点 URI");
  const hosts = authority.split("@").pop().split(",");
  assert.equal(hosts.length, 3);
  for (const host of hosts) assert.match(host, /^127\.0\.0\.1:\d+$/);
  const f = await assessmentFixture(t);
  const hello = await f.db.admin().command({ hello: 1 });
  assert.ok(hello.setName);
  assert.equal(hello.hosts.length, 3);
  for (const host of hello.hosts) assert.ok(hosts.includes(host));
  assert.equal((await f.db.collection("schema_migrations").findOne({ version: 5 })).status, "completed");
  // Two genuine events let a normal worker attempt the same member independently
  // while the killed worker's first event is still protected by its own lease.
  const submissions = [await acceptedAndGraded(f), await acceptedAndGraded(f)];
  const events = await f.db.collection("outbox_events").find({
    target_consumer: CONSUMER, event_type: "GradeFinalized", "payload.submission_id": { $in: submissions },
  }).toArray();
  assert.equal(events.length, 2);
  assert.ok(events.every(event => event.status === "pending"));
  const scope = { org_id: f.org, member_id: f.student.memberId, subject_id: f.subject };
  const member = { org_id: f.org, member_id: f.student.memberId };
  const head = () => f.db.collection("learning_projection_heads").findOne({ ...scope, rule_version: "learning_v1" });
  const receipts = () => f.db.collection("consumer_receipts").countDocuments({ org_id: f.org, consumer_name: CONSUMER });
  const worker = monitor(fork(path.join(__dirname, "learning-process-child.cjs"), [], {
    env: { ...process.env, TEST_LEARNING_PROCESS_URI: f.uri },
    stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  }));
  try {
    const written = await worker.message("details-written");
    const build = await f.db.collection("learning_projection_builds").findOne({ ...scope, generation: written.generation });
    assert.equal(build.status, "building");
    assert.equal(await f.db.collection("learning_projection_inputs").countDocuments({ ...scope, generation: written.generation }), 2);
    assert.equal(await f.db.collection("mastery_evidence").countDocuments({ ...scope, generation: written.generation }), 6);
    assert.equal((await head())?.active_generation ?? null, null);
    assert.equal(await receipts(), 0);
    const killed = await worker.stop();
    // Windows reports forced termination as a nonzero code; POSIX reports SIGKILL.
    assert.ok(killed.signal === "SIGKILL" || (killed.code !== null && killed.code !== 0));
    const claimed = await f.db.collection("outbox_events").findOne({
      _id: { $in: events.map(event => event._id) }, status: "running",
    });
    assert.ok(claimed);
    const lease = await f.db.collection("student_projection_states").findOne(member);
    assert.equal(lease.lease_token, build.lease_token);
    const valid = { $gt: ["$lease_until", "$$NOW"] };
    assert.ok(await f.db.collection("outbox_events").findOne({ _id: claimed._id, $expr: valid }));
    assert.ok(await f.db.collection("student_projection_states").findOne({ ...member, $expr: valid }));
    const other = events.find(event => event._id !== claimed._id);
    const { processOne } = require("../dist/learning/worker.js");
    assert.equal(await processOne(f.db), true, "第二真实事件应尝试获取被保护的成员租约");
    const deferred = await f.db.collection("outbox_events").findOne({ _id: other._id });
    assert.equal(deferred.status, "pending");
    assert.equal(deferred.attempt, other.attempt, "成员争用不消耗失败重试次数");
    assert.equal(deferred.lease_token, null);
    const protectedEvent = await f.db.collection("outbox_events").findOne({ _id: claimed._id });
    assert.equal(protectedEvent.status, "running");
    assert.equal(protectedEvent.lease_token, claimed.lease_token);
    assert.equal(protectedEvent.attempt, claimed.attempt);
    assert.equal((await f.db.collection("student_projection_states").findOne(member)).lease_token, lease.lease_token);
    assert.ok(await f.db.collection("student_projection_states").findOne({ ...member, $expr: valid }));
    assert.equal((await head())?.active_generation ?? null, null);
    assert.equal(await receipts(), 0);
    assert.equal(await f.db.collection("learning_projection_builds").countDocuments(scope), 1);

    // Observe server-side $$NOW only. Never rewrite lease_until or advance clocks.
    await until(async () => {
      const expired = { $lte: ["$lease_until", "$$NOW"] };
      return await f.db.collection("outbox_events").findOne({ _id: claimed._id, $expr: expired }) &&
        await f.db.collection("student_projection_states").findOne({ ...member, $expr: expired });
    }, "被杀进程的事件与成员租约未自然到期");
    assert.deepEqual(await once(f.uri), { processed: true, due: 0 });
    const recovered = await f.db.collection("outbox_events").findOne({ _id: claimed._id });
    assert.equal(recovered.status, "processed");
    assert.equal(recovered.attempt, claimed.attempt + 1);
    assert.equal(await receipts(), 1);
    const published = await head();
    assert.ok(published.active_generation);
    assert.notEqual(published.active_generation, written.generation);
    assert.deepEqual(await once(f.uri), { processed: true, due: 0 });
    assert.deepEqual(await once(f.uri), { processed: false, due: 0 });
    assert.equal((await head()).active_generation, published.active_generation, "相同输入应复用已完整发布的 generation");
    assert.equal(await f.db.collection("learning_projection_heads").countDocuments(scope), 1);
    assert.equal(await f.db.collection("learning_projection_builds").countDocuments({ ...scope, status: "complete" }), 1);
    const complete = await f.db.collection("learning_projection_builds").findOne({ ...scope, generation: published.active_generation });
    assert.equal(complete.status, "complete");
    assert.deepEqual(complete.actual_counts, complete.expected_counts);
    for (const [name, key] of details) {
      assert.equal(await f.db.collection(name).countDocuments({ ...scope, generation: published.active_generation }), complete.expected_counts[key]);
    }
    assert.equal(complete.expected_counts.inputs, 2);
    assert.equal(complete.expected_counts.evidence, 6);
    for (const event of events) {
      assert.equal((await f.db.collection("outbox_events").findOne({ _id: event._id })).status, "processed");
      assert.equal(await f.db.collection("consumer_receipts").countDocuments({ org_id: f.org, consumer_name: CONSUMER, event_id: event._id }), 1);
    }
    assert.equal(await receipts(), 2);
    assert.equal((await f.db.collection("student_projection_states").findOne(member)).lease_token, null);
  } finally {
    await worker.stop();
  }
});
