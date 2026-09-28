"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { MongoClient } = require("mongodb");
const { guardedUri } = require("./helpers.cjs");
const { assessmentFixture, practice, good } = require("./assessment-helpers.cjs");

const skip = !process.env.TEST_MONGODB_URI || process.env.TEST_MONGODB_FAILPOINTS !== "true"
  ? "需要显式 kl_test_ URI、kl-test-faults 三个 127.0.0.1 节点、每节点 enableTestCommands=true；须串行运行"
  : false;
const CONSUMER = "learning_projection_v1";
const details = [["learning_projection_inputs", "inputs"], ["mastery_evidence", "evidence"],
  ["mastery_snapshots", "mastery"], ["mistake_entries", "mistakes"], ["report_snapshots", "reports"]];
async function until(work, description, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await work();
    if (result) return result;
    await delay(100);
  }
  assert.fail(description);
}
function directUri(uri, host) {
  const match = /^(mongodb:\/\/)([^/]+)(\/[^?]+)(?:\?(.*))?$/.exec(uri);
  assert.ok(match);
  const credentials = match[2].includes("@") ? `${match[2].split("@").slice(0, -1).join("@")}@` : "";
  const query = new URLSearchParams(match[4]);
  query.delete("replicaSet");
  query.set("directConnection", "true");
  return `${match[1]}${credentials}${host}${match[3]}?${query}`;
}
async function topology() {
  const uri = guardedUri(process.env.TEST_MONGODB_URI);
  assert.match(uri, /^mongodb:\/\/[^/]+\/kl_test_[^?]+(?:\?|$)/);
  const hosts = /^mongodb:\/\/([^/]+)\//.exec(uri)[1].split("@").pop().split(",");
  assert.equal(hosts.length, 3);
  assert.equal(new Set(hosts).size, 3);
  for (const host of hosts) assert.match(host, /^127\.0\.0\.1:\d+$/);
  // Validate all members, not only today's primary, before any destructive command.
  for (const host of hosts) {
    const client = new MongoClient(directUri(uri, host), { serverSelectionTimeoutMS: 10000 });
    try {
      const hello = await client.db("admin").command({ hello: 1 });
      assert.equal(hello.setName, "kl-test-faults");
      assert.deepEqual([...hello.hosts].sort(), [...hosts].sort());
      assert.equal((await client.db("admin").command({ getParameter: 1, enableTestCommands: 1 })).enableTestCommands, true);
    } finally { await client.close(); }
  }
}
async function graded(f) {
  const session = await practice(f);
  const receipt = await good(f.student, `/sessions/${session.id}/submissions`, {
    method: "POST", body: { expected_revision: session.revision, answers: [] },
  }, 202);
  const { processOne } = require("../dist/assessment/worker.js");
  for (let attempt = 0; attempt < 20; attempt++) {
    const submission = await f.db.collection("submissions").findOne({ _id: receipt.submission_id });
    if (submission.grading_status === "completed") {
      assert.equal((await good(f.student, `/submissions/${submission._id}`)).release_status, "released");
      return submission;
    }
    assert.ok(["pending", "running"].includes(submission.grading_status));
    assert.equal(await processOne(f.db), true);
  }
  assert.fail("真实 HTTP 作答的评分未完成");
}

for (const fault of ["publication-write", "commit-unknown", "step-down"]) {
  test(`LF ${fault}: 学情真实发布事务故障后仅完整 generation 与唯一 receipt`, {
    skip, concurrency: false, timeout: 180000,
  }, async t => {
    await topology();
    const f = await assessmentFixture(t);
    const submission = await graded(f);
    const event = await f.db.collection("outbox_events").findOne({
      target_consumer: CONSUMER, event_type: "GradeFinalized", "payload.submission_id": submission._id,
    });
    assert.ok(event);
    assert.equal(event.status, "pending");
    const scope = { org_id: f.org, member_id: f.student.memberId, subject_id: f.subject };
    const receiptFilter = { org_id: f.org, consumer_name: CONSUMER, event_id: event._id };
    const head = () => f.db.collection("learning_projection_heads").findOne(scope);
    const noPublication = async () => {
      assert.equal((await head())?.active_generation ?? null, null);
      assert.equal(await f.db.collection("consumer_receipts").countDocuments(receiptFilter), 0);
      assert.notEqual((await f.db.collection("outbox_events").findOne({ _id: event._id })).status, "processed");
      assert.equal(await f.db.collection("learning_projection_builds").countDocuments({ ...scope, status: "complete" }), 0);
    };
    const complete = async () => {
      const published = await head();
      assert.ok(published?.active_generation);
      const build = await f.db.collection("learning_projection_builds").findOne({ ...scope, generation: published.active_generation });
      assert.equal(build.status, "complete");
      assert.deepEqual(build.actual_counts, build.expected_counts);
      assert.equal(build.expected_counts.inputs, 1);
      assert.equal(build.expected_counts.evidence, 3);
      for (const [name, key] of details) assert.equal(
        await f.db.collection(name).countDocuments({ ...scope, generation: published.active_generation }), build.expected_counts[key]);
      assert.equal(await f.db.collection("learning_projection_heads").countDocuments(scope), 1);
      assert.equal(await f.db.collection("learning_projection_builds").countDocuments({ ...scope, status: "complete" }), 1);
      assert.equal(await f.db.collection("consumer_receipts").countDocuments(receiptFilter), 1);
      assert.equal((await f.db.collection("outbox_events").findOne({ _id: event._id })).status, "processed");
      assert.equal((await f.db.collection("student_projection_states").findOne({ org_id: f.org, member_id: f.student.memberId })).lease_token, null);
      return published.active_generation;
    };
    const appName = `kl-learning-fault-${randomUUID()}`;
    const worker = new MongoClient(f.uri, { appName, serverSelectionTimeoutMS: 15000, socketTimeoutMS: 20000 });
    const hello = await f.db.admin().command({ hello: 1 });
    const direct = new MongoClient(directUri(f.uri, hello.primary), { serverSelectionTimeoutMS: 15000, socketTimeoutMS: 15000 });
    const admin = direct.db("admin");
    let configured = false, entered = false, unknownObserved = false, changedPrimary = false, faultCount;
    let publicationSession;
    const configure = async data => {
      const result = await admin.command({ configureFailPoint: "failCommand", mode: { times: 1 }, data: { appName, ...data } });
      configured = true;
      faultCount = result.count;
    };
    try {
      await worker.connect();
      const db = worker.db();
      // These barriers only schedule server faults. Every operation and exception
      // comes from the real driver; no fabricated result, error or clock mutation.
      const startSession = worker.startSession.bind(worker);
      worker.startSession = (...args) => {
        const session = startSession(...args);
        const commit = session.commitTransaction.bind(session);
        session.commitTransaction = async (...commitArgs) => {
          if (fault === "commit-unknown" && session === publicationSession && !entered) {
            entered = true;
            await configure({ failCommands: ["commitTransaction"],
              writeConcernError: { code: 64, codeName: "WriteConcernFailed", errmsg: "isolated learning commit acknowledgement fault" },
              errorLabels: ["UnknownTransactionCommitResult"] });
          }
          try { return await commit(...commitArgs); }
          catch (error) {
            if (fault === "commit-unknown" && session === publicationSession && error.hasErrorLabel?.("UnknownTransactionCommitResult")) {
              // Independent connection observes committed state while the actual
              // driver's commit call has failed and before withTransaction retries.
              await complete();
              unknownObserved = true;
            }
            throw error;
          }
        };
        return session;
      };
      const collection = db.collection.bind(db);
      db.collection = (name, ...args) => {
        const real = collection(name, ...args);
        if (name !== "learning_projection_heads") return real;
        return new Proxy(real, { get(target, property) {
          if (property === "updateOne") return async (...arguments_) => {
            const [, update, options] = arguments_;
            const publishing = !!update.$set?.active_generation && !!options?.session;
            if (publishing) publicationSession = options.session;
            if (publishing && fault === "publication-write" && !entered) {
              entered = true;
              await noPublication();
              // Non-transient server error aborts a transaction whose build-complete
              // write has already occurred, immediately before the active-head write.
              await configure({ failCommands: ["update"], errorCode: 2 });
            }
            const result = await target.updateOne(...arguments_);
            if (publishing && fault === "step-down" && !entered) {
              entered = true;
              await noPublication();
              try { await admin.command({ replSetStepDown: 20, force: true }); }
              catch (error) { assert.ok(["MongoNetworkError", "MongoServerError"].includes(error.name)); }
              await until(async () => {
                try {
                  const next = await f.db.admin().command({ hello: 1 });
                  return next.isWritablePrimary && next.me !== hello.primary;
                } catch { return false; }
              }, "必须观察到真实不同 primary");
              changedPrimary = true;
              await noPublication();
            }
            return result;
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        } });
      };
      const { processOne } = require("../dist/learning/worker.js");
      assert.equal(await processOne(db), true);
      assert.equal(entered, true, "故障必须精准抵达最终 publication 事务");
      if (configured) await admin.command({ waitForFailPoint: "failCommand", timesEntered: faultCount + 1, maxTimeMS: 3000 });
      if (fault === "publication-write") {
        await noPublication();
        assert.equal(await f.db.collection("learning_projection_builds").countDocuments({ ...scope, status: "abandoned" }), 1);
        assert.equal((await f.db.collection("outbox_events").findOne({ _id: event._id })).error_code, "PROJECTION_FAILED");
      }
      if (fault === "commit-unknown") assert.equal(unknownObserved, true, "必须证明真实 commit 错误时事务已提交");
      if (fault === "step-down") assert.equal(changedPrimary, true);
      if (configured) {
        await admin.command({ configureFailPoint: "failCommand", mode: "off" });
        configured = false;
      }
      // Recovery obeys database time: do not edit available_at, leases, original
      // grades, event status, retry budgets or the projection's scheduling fields.
      await until(async () => {
        const row = await f.db.collection("outbox_events").findOne({ _id: event._id });
        if (row.status === "processed") return true;
        assert.ok(["pending", "running"].includes(row.status));
        const eligible = await f.db.collection("outbox_events").findOne({ _id: event._id, $or: [
          { status: "pending", $expr: { $lte: ["$available_at", "$$NOW"] } },
          { status: "running", $expr: { $lte: ["$lease_until", "$$NOW"] } },
        ] });
        if (eligible) await processOne(f.db);
        return false;
      }, "学情发布未在自然退避/租约到期后恢复", 75000);
      const generation = await complete();
      assert.equal(await processOne(f.db), false);
      assert.equal(await complete(), generation, "重复消费不得重建或产生第二 receipt");
      assert.deepEqual(await f.db.collection("submissions").findOne({ _id: submission._id }), submission, "故障恢复不得改写原评分提交");
    } finally {
      try {
        if (configured) await admin.command({ configureFailPoint: "failCommand", mode: "off" });
      } finally { await Promise.all([worker.close(), direct.close()]); }
    }
  });
}
