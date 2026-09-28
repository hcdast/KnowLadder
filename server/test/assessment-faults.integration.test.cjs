"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { fork } = require("node:child_process");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { MongoClient } = require("mongodb");
const { guardedUri, status } = require("./helpers.cjs");

const enabled = process.env.TEST_MONGODB_FAILPOINTS === "true";
const skip = !process.env.TEST_MONGODB_URI || !enabled
  ? "需要隔离 kl-test-faults 三节点、enableTestCommands=1、TEST_MONGODB_FAILPOINTS=true 及显式 kl_test_ URI"
  : false;

async function isolatedTopology() {
  const uri = guardedUri(process.env.TEST_MONGODB_URI);
  const authority = /^mongodb:\/\/([^/]+)\//.exec(uri)?.[1];
  assert.ok(authority, "故障测试不接受 SRV 或隐式数据库");
  const hosts = authority.split("@").pop().split(",");
  assert.equal(hosts.length, 3, "故障测试必须显式指定三节点");
  for (const host of hosts) assert.match(host, /^127\.0\.0\.1:\d+$/);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    const hello = await client.db("admin").command({ hello: 1 });
    assert.equal(hello.setName, "kl-test-faults", "拒绝在普通开发副本集执行故障命令");
    assert.equal(hello.hosts.length, 3);
    for (const host of hello.hosts) assert.ok(hosts.includes(host));
    const parameters = await client.db("admin").command({ getParameter: 1, enableTestCommands: 1 });
    assert.equal(parameters.enableTestCommands, true, "须使用 KL_MONGO_TEST_COMMANDS=true 启动独立实例");
  } finally {
    await client.close();
  }
}

async function primaryClient(uri) {
  const discovery = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  try {
    const hello = await discovery.db("admin").command({ hello: 1 });
    assert.equal(hello.setName, "kl-test-faults");
    assert.match(hello.primary, /^127\.0\.0\.1:\d+$/);
    const match = /^(mongodb:\/\/)([^/]+)(\/[^?]+)(?:\?(.*))?$/.exec(uri);
    const credentials = match[2].includes("@") ? `${match[2].split("@").slice(0, -1).join("@")}@` : "";
    const query = new URLSearchParams(match[4]);
    query.delete("replicaSet");
    query.set("directConnection", "true");
    const direct = new MongoClient(`${match[1]}${credentials}${hello.primary}${match[3]}?${query}`, {
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 15000,
    });
    try {
      await direct.connect();
      return direct;
    } catch (error) {
      await direct.close();
      throw error;
    }
  } finally {
    await discovery.close();
  }
}

async function withFailPoint(uri, data, work, mode = "alwaysOn") {
  const client = await primaryClient(uri);
  const admin = client.db("admin");
  let configured = false;
  try {
    const result = await admin.command({ configureFailPoint: "failCommand", mode, data });
    configured = true;
    await work();
    // Prove an actual matching MongoDB command hit the fault, not a fetch timeout.
    await admin.command({ waitForFailPoint: "failCommand", timesEntered: result.count + 1, maxTimeMS: 3000 });
  } finally {
    try {
      if (configured) await admin.command({ configureFailPoint: "failCommand", mode: "off" });
    } finally {
      await client.close();
    }
  }
}

async function waitUntil(work, description, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await work();
    if (result) return result;
    await delay(100);
  }
  assert.fail(description);
}

function startPausedWorker(uri) {
  const appName = `kl-fault-child-${randomUUID()}`;
  const child = fork(path.join(__dirname, "assessment-fault-child.cjs"), [], {
    env: { ...process.env, TEST_FAULT_URI: guardedUri(uri), TEST_FAULT_APP_NAME: appName },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  const messages = [];
  let exit;
  let failure;
  child.on("message", (message) => messages.push(message));
  child.on("error", (error) => { failure = error; });
  child.on("exit", (code, signal) => { exit = { code, signal }; });
  return {
    child,
    appName,
    async message(type) {
      return waitUntil(() => {
        if (failure) throw failure;
        const found = messages.find((message) => message.type === type);
        if (found) return found;
        assert.ok(!exit && !messages.some((message) => message.type === "failed"), "故障子进程提前结束");
        return null;
      }, `子进程未发送 ${type}`, 20000);
    },
    async stop() {
      if (!exit) child.kill("SIGKILL");
      await waitUntil(() => exit, "已知故障子进程未退出", 10000);
    },
    async finish() {
      await this.message("done");
      await waitUntil(() => exit, "故障子进程未正常清理退出", 10000);
      assert.equal(exit.code, 0);
    },
  };
}

async function setup(t) {
  await isolatedTopology();
  const { assessmentFixture } = require("./assessment-helpers.cjs");
  const f = await assessmentFixture(t, { publishedQuiz: true });
  return { ...f, student: f.student.browser, reviewer: f.reviewer.browser };
}
async function post(f, browser, route, body, key = randomUUID()) {
  // The commit-confirmation budget is 15s; the ordinary Browser helper's 15s
  // fetch deadline would mask the precise server-side unknown-commit result.
  const response = await fetch(`${browser.base}/api/v1${route}`, {
    method: "POST",
    headers: {
      "X-Org-Id": f.orgId,
      "Idempotency-Key": key,
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1:5174",
      "X-CSRF-Token": browser.csrf,
      Cookie: [...browser.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
    redirect: "error",
  });
  return { status: response.status, data: await response.json() };
}
async function start(f, key = randomUUID()) {
  const response = await post(f, f.student, `/quizzes/${f.quizId}/sessions`, {}, key);
  status(response, 200);
  return response.data.data;
}
async function submit(f, session, key = randomUUID()) {
  return post(f, f.student, `/sessions/${session.id}/submissions`, { expected_revision: session.revision, answers: [] }, key);
}
async function accepted(f) {
  const session = await start(f);
  const response = await submit(f, session);
  status(response, 202);
  return { session, receipt: response.data.data };
}
async function assertOnce(f, sessionId, submissionId) {
  const scope = { org_id: f.orgId, session_id: sessionId };
  assert.equal(await f.db.collection("submissions").countDocuments(scope), 1);
  assert.equal(await f.db.collection("grading_runs").countDocuments({ org_id: f.orgId, submission_id: submissionId }), 1);
  assert.equal(await f.db.collection("outbox_events").countDocuments({ org_id: f.orgId, event_type: "SubmissionAccepted", "payload.submission_id": submissionId }), 1);
  const counters = await f.db.collection("attempt_counters").find({ org_id: f.orgId, quiz_id: f.quizId }).toArray();
  assert.equal(counters.length, 1);
  assert.equal(counters[0].allocated, 1);
  assert.equal(await f.db.collection("sessions").countDocuments({ org_id: f.orgId, quiz_id: f.quizId }), 1);
}

test("AF01 commitTransaction 已提交但确认未知：原 key 恢复只受理一次", { skip, timeout: 120000 }, async (t) => {
  const f = await setup(t);
  const session = await start(f);
  const key = randomUUID();
  let committed;
  await withFailPoint(f.uri, {
    failCommands: ["commitTransaction"],
    writeConcernError: { code: 91, codeName: "ShutdownInProgress", errmsg: "isolated commit acknowledgement fault" },
    errorLabels: ["UnknownTransactionCommitResult"],
  }, async () => {
    const response = await submit(f, session, key);
    status(response, 503);
    assert.equal(response.data.error.code, "COMMIT_OUTCOME_UNKNOWN");
    committed = await f.db.collection("submissions").findOne({ org_id: f.orgId, session_id: session.id });
    assert.ok(committed, "必须证明 commit 已实际生效，而非普通断网/事务未提交");
    assert.equal(await f.db.collection("idempotency_records").countDocuments({ org_id: f.orgId, operation: "session.submit", resource_id: session.id, key }), 1);
  });
  const query = new URLSearchParams({ operation: "session.submit", resource_id: session.id, key });
  // ShutdownInProgress invalidates the driver's primary/pool until monitoring
  // rediscovers it. A transient 503 is not proof that the original commit failed.
  // Poll the same key within a bound, preserving every uniqueness assertion below.
  const recovered = await waitUntil(async () => {
    const response = await f.student.request(`/me/idempotency-requests?${query}`, { headers: { "X-Org-Id": f.orgId } });
    if (response.status === 503) {
      assert.ok(["DEPENDENCY_UNAVAILABLE", "COMMIT_OUTCOME_UNKNOWN"].includes(response.data.error.code));
      return null;
    }
    status(response, 200);
    return response;
  }, "原幂等键在数据库恢复后仍无法查询", 30000);
  status(recovered, 200);
  assert.equal(recovered.data.data.status, "resolved");
  assert.equal(recovered.data.data.result.submission_id, committed._id);
  const replay = await submit(f, session, key);
  status(replay, 202);
  assert.equal(replay.data.data.submission_id, committed._id);
  await assertOnce(f, session.id, committed._id);
});

test("AF02 commitTransaction 连接被关闭后重放原 key 不重复次数或提交", { skip, timeout: 120000 }, async (t) => {
  const f = await setup(t);
  const key = randomUUID();
  let response;
  await withFailPoint(f.uri, { failCommands: ["commitTransaction"], closeConnection: true }, async () => {
    response = await post(f, f.student, `/quizzes/${f.quizId}/sessions`, {}, key);
    assert.ok([200, 503].includes(response.status));
    if (response.status === 503) assert.equal(response.data.error.code, "COMMIT_OUTCOME_UNKNOWN");
  }, { times: 1 });
  const session = await start(f, key);
  if (response.status === 200) assert.equal(session.id, response.data.data.id);
  const result = await submit(f, session);
  status(result, 202);
  await assertOnce(f, session.id, result.data.data.submission_id);
});

test("AF03 primary stepDown 后原 start/submit key 恢复不重新扣次", { skip, timeout: 120000 }, async (t) => {
  const f = await setup(t);
  const startKey = randomUUID();
  const submitKey = randomUUID();
  const session = await start(f, startKey);
  const receipt = await submit(f, session, submitKey);
  status(receipt, 202);
  const direct = await primaryClient(f.uri);
  const previous = (await direct.db("admin").command({ hello: 1 })).me;
  try {
    try {
      await direct.db("admin").command({ replSetStepDown: 20, force: true });
    } catch (error) {
      // A successful stepdown may close this socket. Topology observation below
      // is mandatory; an arbitrary command failure alone cannot pass this test.
      assert.ok(["MongoNetworkError", "MongoServerError"].includes(error.name));
    }
    await waitUntil(async () => {
      try {
        const hello = await f.client.db("admin").command({ hello: 1 });
        return hello.isWritablePrimary && hello.me !== previous;
      } catch { return false; }
    }, "必须观察到不同节点成为 primary");
    const recovered = await start(f, startKey);
    assert.equal(recovered.id, session.id);
    const replay = await submit(f, session, submitKey);
    status(replay, 202);
    assert.equal(replay.data.data.submission_id, receipt.data.data.submission_id);
    await assertOnce(f, session.id, receipt.data.data.submission_id);
  } finally {
    await direct.close();
  }
});

test("AF04 worker 真实领取后被终止：租约到期才可重新领取并完成", { skip, timeout: 120000 }, async (t) => {
  const f = await setup(t);
  const { receipt } = await accepted(f);
  const worker = startPausedWorker(f.uri);
  try {
    const claim = await worker.message("claimed");
    const row = await f.db.collection("outbox_events").findOne({ _id: claim.id });
    assert.equal(row.lease_token, claim.token);
    assert.equal(row.status, "running");
    await worker.stop();
    const { processOne } = require("../dist/assessment/worker.js");
    await processOne(f.db);
    assert.equal((await f.db.collection("outbox_events").findOne({ _id: claim.id })).lease_token, claim.token);
    assert.equal(await f.db.collection("grading_results").countDocuments({ org_id: f.orgId }), 0);
    await waitUntil(() => f.db.collection("outbox_events").findOne({ _id: claim.id, $expr: { $lte: ["$lease_until", "$$NOW"] } }), "真实数据库租约未到期");
    await processOne(f.db);
    const completed = await f.db.collection("outbox_events").findOne({ _id: claim.id });
    assert.equal(completed.status, "processed");
    assert.equal(completed.attempt, row.attempt + 1);
    assert.equal((await f.db.collection("submissions").findOne({ _id: receipt.submission_id })).grading_status, "completed");
    assert.equal(await f.db.collection("consumer_receipts").countDocuments({ event_id: claim.id }), 1);
  } finally {
    await worker.stop();
  }
});

for (const failure of [false, true]) {
  test(`AF05 过期旧 worker ${failure ? "真实 Mongo 错误" : "成功迟到"}不得覆盖重批新目标`, { skip, timeout: 150000 }, async (t) => {
    const f = await setup(t);
    const { receipt } = await accepted(f);
    const worker = startPausedWorker(f.uri);
    try {
      const claim = await worker.message("claimed");
      await waitUntil(() => f.db.collection("outbox_events").findOne({ _id: claim.id, $expr: { $lte: ["$lease_until", "$$NOW"] } }), "真实数据库租约未到期");
      const { processOne } = require("../dist/assessment/worker.js");
      await processOne(f.db);
      const completed = await f.db.collection("submissions").findOne({ _id: receipt.submission_id });
      assert.equal(completed.grading_status, "completed");
      const regrade = await post(f, f.reviewer, `/submissions/${completed._id}/regrades`, { expected_revision: completed.revision, reason: "隔离故障验收旧 worker 不覆盖新评分目标" });
      status(regrade, 202);
      const target = await f.db.collection("submissions").findOne({ _id: completed._id });
      assert.equal(target.requested_grading_revision, completed.requested_grading_revision + 1);
      const resume = async () => {
        worker.child.send({ type: "resume" });
        await worker.finish();
      };
      if (failure) {
        await withFailPoint(f.uri, { failCommands: ["find"], appName: worker.appName, errorCode: 13 }, resume, { times: 1 });
      } else {
        await resume();
      }
      assert.deepEqual(await f.db.collection("submissions").findOne({ _id: completed._id }), target);
      assert.equal(await f.db.collection("consumer_receipts").countDocuments({ event_id: claim.id }), 1);
      const newRun = await f.db.collection("grading_runs").findOne({ _id: regrade.data.data.grading_run_id });
      assert.equal(newRun.status, "pending");
      assert.equal(await f.db.collection("grading_results").countDocuments({ grading_run_id: newRun._id }), 0);
      await processOne(f.db);
      const final = await f.db.collection("submissions").findOne({ _id: completed._id });
      assert.equal(final.grading_status, "completed");
      assert.equal(final.effective_grading_revision, target.requested_grading_revision);
    } finally {
      await worker.stop();
    }
  });
}

for (const failure of [false, true]) {
  test(`AF06 当前有效租约旧 target ${failure ? "真实 Mongo 错误" : "成功迟到"}仅结束重投事件`, { skip, timeout: 120000 }, async (t) => {
    const f = await setup(t);
    const { receipt } = await accepted(f);
    const { processOne } = require("../dist/assessment/worker.js");
    assert.equal(await processOne(f.db), true);
    const completed = await f.db.collection("submissions").findOne({ _id: receipt.submission_id });
    assert.equal(completed.grading_status, "completed");
    const oldEvent = await f.db.collection("outbox_events").findOne({ event_type: "SubmissionAccepted", "payload.submission_id": completed._id });
    const oldRun = await f.db.collection("grading_runs").findOne({ _id: oldEvent.payload.grading_run_id });
    assert.equal(oldRun.status, "completed");
    const oldResults = await f.db.collection("grading_results").find({ grading_run_id: oldRun._id }).sort({ _id: 1 }).toArray();
    const oldReceipts = await f.db.collection("consumer_receipts").find({ event_id: oldEvent._id }).toArray();
    assert.equal(oldReceipts.length, 1);
    // Isolated recovery injection, not a public API flow: requeue only the
    // delivered event, preserving its terminal run, results and receipt.
    const replay = await f.db.collection("outbox_events").updateOne({ _id: oldEvent._id, status: "processed" }, {
      $set: { status: "pending", processed_at: null, available_at: new Date(0) },
    });
    assert.equal(replay.modifiedCount, 1);
    const worker = startPausedWorker(f.uri);
    try {
      const claim = await worker.message("claimed");
      assert.equal(claim.id, oldEvent._id);
      assert.notEqual(claim.token, oldEvent.lease_token);
      const regrade = await post(f, f.reviewer, `/submissions/${completed._id}/regrades`, {
        expected_revision: completed.revision, reason: "隔离恢复重投事件：有效租约旧目标不得污染新目标",
      });
      status(regrade, 202);
      const target = await f.db.collection("submissions").findOne({ _id: completed._id });
      assert.equal(target.requested_grading_revision, oldRun.revision + 1);
      const newRun = await f.db.collection("grading_runs").findOne({ _id: regrade.data.data.grading_run_id });
      const newEvent = await f.db.collection("outbox_events").findOne({ "payload.grading_run_id": newRun._id, event_type: "RegradeRequested" });
      assert.equal(newRun.status, "pending");
      assert.equal(newEvent.status, "pending");
      const resume = async () => {
        assert.ok(await f.db.collection("outbox_events").findOne({
          _id: claim.id, status: "running", lease_token: claim.token,
          $expr: { $gt: ["$lease_until", "$$NOW"] },
        }), "旧 target 必须在真实数据库租约仍有效时恢复");
        worker.child.send({ type: "resume" });
        await worker.finish();
      };
      if (failure) {
        await withFailPoint(f.uri, { failCommands: ["find"], appName: worker.appName, errorCode: 13 }, resume, { times: 1 });
      } else {
        await resume();
      }
      const ended = await f.db.collection("outbox_events").findOne({ _id: claim.id });
      assert.equal(ended.status, "failed");
      assert.equal(ended.error_code, "STALE_GRADING_TARGET");
      assert.equal(ended.lease_token, null);
      assert.equal(ended.lease_until, null);
      assert.deepEqual(await f.db.collection("submissions").findOne({ _id: completed._id }), target);
      assert.deepEqual(await f.db.collection("grading_runs").findOne({ _id: oldRun._id }), oldRun);
      assert.deepEqual(await f.db.collection("grading_runs").findOne({ _id: newRun._id }), newRun);
      assert.deepEqual(await f.db.collection("outbox_events").findOne({ _id: newEvent._id }), newEvent);
      assert.deepEqual(await f.db.collection("grading_results").find({ grading_run_id: oldRun._id }).sort({ _id: 1 }).toArray(), oldResults);
      assert.deepEqual(await f.db.collection("consumer_receipts").find({ event_id: claim.id }).toArray(), oldReceipts);
      assert.equal(await f.db.collection("grading_results").countDocuments({ grading_run_id: newRun._id }), 0);
      assert.equal(await f.db.collection("outbox_events").countDocuments({ event_type: "GradeFinalized", "payload.grading_run_id": oldRun._id }), 1);
      assert.equal(await processOne(f.db), true);
      const final = await f.db.collection("submissions").findOne({ _id: completed._id });
      assert.equal(final.grading_status, "completed");
      assert.equal(final.effective_grading_revision, target.requested_grading_revision);
      assert.equal(await f.db.collection("consumer_receipts").countDocuments({ event_id: newEvent._id }), 1);
    } finally {
      await worker.stop();
    }
  });
}

for (const operation of ["start", "submit"]) {
  test(`AF07 ${operation} commitTransaction 阻塞期间真实切主，原 key 恢复仅受理一次`, { skip, timeout: 150000 }, async (t) => {
    const f = await setup(t);
    const startKey = randomUUID();
    const submitKey = randomUUID();
    let session = operation === "submit" ? await start(f, startKey) : null;
    const direct = await primaryClient(f.uri);
    const admin = direct.db("admin");
    const previous = (await admin.command({ hello: 1 })).me;
    let configured = false;
    let pending;
    let settled = false;
    let first;
    try {
      const point = await admin.command({
        configureFailPoint: "failCommand", mode: { times: 1 },
        data: { failCommands: ["commitTransaction"], blockConnection: true, blockTimeMS: 15000 },
      });
      configured = true;
      // Attach both handlers immediately: even a failed assertion must drain
      // this bounded HTTP operation before fixture/database teardown.
      pending = (operation === "start"
        ? post(f, f.student, `/quizzes/${f.quizId}/sessions`, {}, startKey)
        : submit(f, session, submitKey)).then(
        (response) => { settled = true; return { response }; },
        (error) => { settled = true; return { error }; },
      );
      await admin.command({ waitForFailPoint: "failCommand", timesEntered: point.count + 1, maxTimeMS: 10000 });
      assert.equal(settled, false, "必须在真实 commit 命令阻塞、HTTP 尚未返回时切主");
      try {
        await admin.command({ replSetStepDown: 20, force: true });
      } catch (error) {
        assert.ok(["MongoNetworkError", "MongoServerError"].includes(error.name));
      }
      await waitUntil(async () => {
        try {
          const hello = await f.client.db("admin").command({ hello: 1 });
          return hello.isWritablePrimary && hello.me !== previous;
        } catch { return false; }
      }, "阻塞 commit 期间必须观察到不同节点成为 primary");
      first = await pending;
      assert.ok(!first.error, "真实切主应由 API 返回受理或可恢复失败，而非客户端超时");
      assert.ok([operation === "start" ? 200 : 202, 503].includes(first.response.status));
    } finally {
      try {
        if (configured) await admin.command({ configureFailPoint: "failCommand", mode: "off" });
      } finally {
        if (pending) await pending;
        await direct.close();
      }
    }
    const recovered = await waitUntil(async () => {
      const response = operation === "start"
        ? await post(f, f.student, `/quizzes/${f.quizId}/sessions`, {}, startKey)
        : await submit(f, session, submitKey);
      if (response.status === 503) return null;
      status(response, operation === "start" ? 200 : 202);
      return response;
    }, "切主后原幂等键未恢复");
    if (first.response.status !== 503) {
      assert.deepEqual(recovered.data.data, first.response.data.data);
    }
    let submissionId;
    if (operation === "start") {
      session = recovered.data.data;
      const submitted = await submit(f, session, submitKey);
      status(submitted, 202);
      submissionId = submitted.data.data.submission_id;
    } else {
      submissionId = recovered.data.data.submission_id;
    }
    assert.equal((await start(f, startKey)).id, session.id);
    const replay = await submit(f, session, submitKey);
    status(replay, 202);
    assert.equal(replay.data.data.submission_id, submissionId);
    await assertOnce(f, session.id, submissionId);
    assert.equal(await f.db.collection("idempotency_records").countDocuments({ org_id: f.orgId, operation: "session.submit", resource_id: session.id, key: submitKey }), 1);
  });
}
