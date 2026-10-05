"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { mkdtemp, rm, readFile, lstat, realpath } = require("node:fs/promises");
const { join } = require("node:path");
const { execFile, fork } = require("node:child_process");
const { promisify } = require("node:util");
const { ORIGIN, status, error, guardedUri } = require("./helpers.cjs");
const { assessmentFixture, good, request, practice } = require("./assessment-helpers.cjs");
const { administrativeGrant } = require("./administration-helpers.cjs");
const { executeAdministrationOperation, recoverAdministrationOperation } = require("../dist/administration/operations.js");
const { reconcile } = require("../dist/files/worker.js");
const exec = promisify(execFile);

// Run in an independent Node 24 process with --test-concurrency=1. Required:
// FILE_SCAN_ENABLED=true, TEST_STANDALONE_MONGODB_URI (localhost/kl_test_),
// TEST_CLAMSCAN_PATH, TEST_CLAMAV_DATABASE, SCAN_DATABASE_MAX_AGE_HOURS,
// TEST_FILE_STORAGE_PARENT (a trusted ancestor, e.g. C:/ on Windows).
// These tests never skip missing/expired real ClamAV infrastructure and use no infected samples.
async function setup(t) {
  assert.equal(process.env.FILE_SCAN_ENABLED, "true", "必须显式开启真实文件扫描验收");
  for (const key of ["TEST_STANDALONE_MONGODB_URI", "TEST_CLAMSCAN_PATH", "TEST_CLAMAV_DATABASE", "SCAN_DATABASE_MAX_AGE_HOURS", "TEST_FILE_STORAGE_PARENT"])
    assert.ok(process.env[key], `缺少 ${key}：真实扫描验收不能skip或伪造clean`);
  assert.ok(/^mongodb:\/\/(?:127\.0\.0\.1|localhost):\d+\//.test(guardedUri(process.env.TEST_STANDALONE_MONGODB_URI)), "扫描竞态验收仅允许本地回环MongoDB");
  const parent = await realpath(process.env.TEST_FILE_STORAGE_PARENT);
  const root = await mkdtemp(join(parent, "kl-test-iam-scan-"));
  const children = new Set();
  t.after(async () => {
    await Promise.all([...children].map(child => child.stop()));
    await rm(root, { recursive: true, force: true });
  });
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:KL_TEST_PRIVATE_ROOT -AclObject $acl`;
    await exec(join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { env: { ...process.env, KL_TEST_PRIVATE_ROOT: root }, windowsHide: true, timeout: 10000 });
    const { assertWindowsPrivateDirectory } = require("../dist/security/private-directory.js");
    await assertWindowsPrivateDirectory(root);
  }
  const f = await assessmentFixture(t, { topology: "standalone", env: {
    FILE_SCAN_ENABLED: "true", FILE_STORAGE_ROOT: root,
    CLAMSCAN_PATH: process.env.TEST_CLAMSCAN_PATH, CLAMAV_DATABASE: process.env.TEST_CLAMAV_DATABASE,
  } });
  f.root = root;
  f.children = children;
  f.files = f.db.collection("file_resources");
  f.platform = (await f.ops.createOrganization(f.context, { name: "IAM 文件平台合成组织", kind: "platform" })).organization_id;
  f.delegate = await f.actor(["platform_ops"], [], f.platform);
  f.unscoped = await f.actor(["platform_ops"], [], f.platform);
  f.otherStudent = await f.actor();
  await administrativeGrant(f, f.delegate, "content:edit", [f.org]);
  await administrativeGrant(f, f.delegate, "assessment:manage", [f.org]);
  return f;
}
function headers(actor, extra = {}) {
  return { Cookie: [...actor.browser.cookies].map(([key, value]) => `${key}=${value}`).join("; "), "X-Org-Id": actor.org, ...extra };
}
const platformPath = id => `/console/business/content/admin/files/${id}/content`;
const platformHeaders = f => ({ "X-Target-Org-Id": f.org });
async function attachment(f, title) {
  const question = await good(f.editor, "/admin/question-versions", { method: "POST", body: {
    title, subject_id: f.subject, question_type: "single", prompt: "阅读原创附件，选出整数一",
    options: [{ id: "A", text: "一" }, { id: "B", text: "二" }], answer: "A", explanation: "原创整数一说明",
    knowledge_point_ids: [f.knowledge], knowledge_weights: [{ knowledge_point_id: f.knowledge, weight_bps: 10000 }],
    difficulty: "挑战", difficulty_basis: "真实扫描隔离竞态验收", scoring_rule: { version: 1, strategy: "single_exact", max_score: "1" },
    license: { source: "本测试自主创作的纯文本附件", granted: true, expires_at: null },
  } });
  const bytes = Buffer.from(`原创附件：${title}。整数一位于整数二之前。\n`, "utf8");
  const file = await good(f.editor, "/admin/files", { method: "POST", body: {
    owner_type: "question", owner_version_id: question.id, expected_revision: question.revision,
    display_name: "原创扫描隔离.txt", size: bytes.length, mime: "text/plain", checksum: createHash("sha256").update(bytes).digest("hex"),
  } });
  assert.equal(file.status, "pending");
  assert.equal(file.scan_status, "awaiting_upload");
  const response = await fetch(`${f.editor.browser.base}/api/v1/admin/files/${file.id}/content`, { method: "PUT", headers: headers(f.editor, {
    Origin: ORIGIN, "X-CSRF-Token": f.editor.browser.csrf, "Idempotency-Key": randomUUID(),
    "X-Owner-Revision": String(file.owner_revision), "Content-Type": "application/octet-stream",
  }), body: bytes, signal: AbortSignal.timeout(120000) });
  const body = await response.json();
  status({ status: response.status, data: body }, 200);
  assert.equal(body.data.status, "quarantined");
  assert.equal(body.data.scan_status, "queued");
  const row = await f.files.findOne({ _id: file.id });
  assert.equal(row.scan_attempt, 0);
  assert.deepEqual(await readFile(join(f.root, "quarantine", row.storage_key)), bytes);
  await assert.rejects(lstat(join(f.root, "ready", row.storage_key)), { code: "ENOENT" });
  return { question, file, bytes, storageKey: row.storage_key };
}
function scanChild(f, attached, cutpoint = "none", env = {}) {
  const child = fork(join(__dirname, "administration-scan-child.cjs"), [f.uri, attached.file.id, attached.storageKey, cutpoint], {
    env: { ...process.env, ...env }, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  });
  const barrier = Promise.withResolvers(), exited = Promise.withResolvers();
  // Failures are observed by wait/finish; avoid unhandled rejection during parent DB assertions.
  barrier.promise.catch(() => undefined);
  exited.promise.catch(() => undefined);
  let result, atBarrier = false, finished = false;
  const timer = setTimeout(() => child.kill(), 600000);
  child.on("message", message => {
    if (message?.type === "barrier" && message.cutpoint === cutpoint) {
      atBarrier = true;
      barrier.resolve();
    } else if (message?.type === "result" && typeof message.consumed === "boolean") result = message;
  });
  child.once("error", () => {
    finished = true;
    clearTimeout(timer);
    barrier.reject(new Error("真实扫描子进程启动失败"));
    exited.reject(new Error("真实扫描子进程启动失败"));
  });
  child.once("exit", code => {
    finished = true;
    clearTimeout(timer);
    if (!atBarrier && cutpoint !== "none") barrier.reject(new Error("真实扫描未到指定I/O屏障；请检查真实引擎/病毒库及私有目录"));
    if (code === 0 && result) exited.resolve(result.consumed);
    else exited.reject(new Error("真实扫描子进程失败；未伪造结果或静默跳过"));
  });
  const handle = {
    wait: () => barrier.promise,
    resume: () => child.send({ type: "resume", cutpoint }),
    finish: () => exited.promise,
    stop: async () => {
      if (!finished) child.kill();
      await exited.promise.catch(() => undefined);
      f.children.delete(handle);
    },
  };
  f.children.add(handle);
  return handle;
}
async function scan(f, attached, env) {
  const child = scanChild(f, attached, "none", env);
  try { assert.equal(await child.finish(), true); }
  finally { await child.stop(); }
}
async function isolate(f) {
  const userId = f.editor.user.user_id;
  const before = await f.db.collection("users").findOne({ _id: userId }, { projection: { display_name: 1, status: 1 } });
  const operationId = randomUUID(), displayName = `原创附件隔离核对-${operationId}`;
  await assert.rejects(executeAdministrationOperation({ client: f.client, db: f.db, operation_id: operationId,
    actor: "iam-scan-isolation-test", reason: "真实目标写ack后保留管理恢复屏障", action: "iam.verify.scan.metadata",
    targets: { user_ids: [userId] }, before: { user_id: userId, display_name: before.display_name },
    payload: { user_id: userId, display_name: displayName },
    apply: async ({ session, now }) => {
      const changed = await f.db.collection("users").updateOne({ _id: userId, display_name: before.display_name, status: "active" },
        { $set: { display_name: displayName, updated_at: now } }, { session });
      assert.equal(changed.modifiedCount, 1);
      throw new Error("Actual metadata write acknowledged; explicit recovery required");
    },
  }), exception => exception.code === "ADMINISTRATION_NEEDS_RECOVERY");
  assert.equal((await f.db.collection("administration_operations").findOne({ _id: operationId })).status, "needs_recovery");
  const guard = await f.db.collection("administration_guard").findOne({ _id: "administration" });
  assert.equal(guard.state, "needs_recovery");
  assert.equal(guard.operation_id, operationId);
  assert.ok(guard.blocked_targets.user_ids.includes(userId));
  return async () => {
    await recoverAdministrationOperation({ client: f.client, db: f.db, operation_id: operationId,
      actor: "iam-scan-explicit-recovery", reason: "核对真实写和不可变目标后显式解除隔离",
      revalidate: async operation => {
        assert.equal(operation.action, "iam.verify.scan.metadata");
        assert.deepEqual(operation.targets, { user_ids: [userId], member_ids: [], org_ids: [], global: false });
        assert.deepEqual(operation.before, { user_id: userId, display_name: before.display_name });
        assert.deepEqual(operation.desired, { user_id: userId, display_name: displayName });
      },
      finish: async () => null,
      verify: async (_operation, session) => {
        const current = await f.db.collection("users").findOne({ _id: userId }, { session, projection: { display_name: 1, status: 1 } });
        assert.equal(current.display_name, displayName);
        assert.equal(current.status, before.status);
      },
    });
    assert.equal((await f.db.collection("administration_operations").findOne({ _id: operationId })).status, "applied");
    assert.equal((await f.db.collection("administration_guard").findOne({ _id: "administration" })).state, "idle");
  };
}
async function notDeliverable(f, attached) {
  for (const range of [false, true]) {
    const response = await request(f.delegate, platformPath(attached.file.id), { headers: { ...platformHeaders(f), ...(range ? { Range: "bytes=0-3" } : {}) } });
    error(response, 409);
    assert.equal(response.data.error.code, "FILE_NOT_READY");
  }
  assert.equal(await f.db.collection("audit_events").countDocuments({ resource_id: attached.file.id, action: "file.scan.clean" }), 0);
  const row = await f.files.findOne({ _id: attached.file.id });
  assert.equal(row.status, "quarantined");
  assert.equal(row.scanned_at, null);
  assert.equal(row.scan_engine_version, null);
  assert.equal(row.scan_database_version, null);
}
async function deliver(actor, path, bytes, extra = {}) {
  for (const range of [false, true]) {
    const response = await fetch(`${actor.browser.base}/api/v1${path}`, { headers: headers(actor, { ...extra, ...(range ? { Range: "bytes=0-3" } : {}) }), signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, range ? 206 : 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), range ? bytes.subarray(0, 4) : bytes);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
}
async function healthyDelivery(f, attached, attempts) {
  await scan(f, attached);
  await readyDelivery(f, attached, attempts);
}
async function readyDelivery(f, attached, attempts) {
  const row = await f.files.findOne({ _id: attached.file.id });
  assert.equal(row.status, "ready");
  assert.equal(row.scan_status, "clean");
  assert.equal(row.scan_attempt, attempts);
  assert.equal(row.lease_token, null);
  assert.equal(row.lease_until, null);
  assert.match(row.scan_engine_version, /^\d+\.\d+/);
  assert.match(row.scan_database_version, /^\d+$/);
  assert.ok(row.scan_database_updated_at instanceof Date);
  assert.ok(Date.now() - row.scan_database_updated_at.getTime() <= Number(process.env.SCAN_DATABASE_MAX_AGE_HOURS) * 3600000);
  assert.ok(row.scanned_at instanceof Date);
  assert.deepEqual(await readFile(join(f.root, "ready", attached.storageKey)), attached.bytes);
  await assert.rejects(lstat(join(f.root, "quarantine", attached.storageKey)), { code: "ENOENT" });
  assert.equal(await f.db.collection("audit_events").countDocuments({ resource_id: attached.file.id, action: "file.scan.clean" }), 1);
  await deliver(f.delegate, platformPath(attached.file.id), attached.bytes, platformHeaders(f));
  error(await request(f.unscoped, platformPath(attached.file.id), { headers: platformHeaders(f) }), 403);
  error(await request(f.delegate, platformPath(attached.file.id), { headers: { "X-Target-Org-Id": f.platform } }), 403);
  const base = `/admin/question-versions/${attached.question.id}`;
  const current = await good(f.editor, base);
  const bound = await good(f.editor, base, { method: "PATCH", body: { expected_revision: current.revision, resource_ids: [attached.file.id] } });
  const review = await good(f.editor, `${base}/submit-review`, { method: "POST", body: { expected_revision: bound.revision } });
  await good(f.contentReviewer, `${base}/publish`, { method: "POST", body: { expected_revision: review.revision } });
  const platformAssessmentPath = `/console/business/assessment/admin/assessment-questions/${attached.question.id}/files/${attached.file.id}/content`;
  await deliver(f.delegate, platformAssessmentPath, attached.bytes, platformHeaders(f));
  error(await request(f.unscoped, platformAssessmentPath, { headers: platformHeaders(f) }), 403);
  // The growing fixture has other published questions, so select all matching questions
  // and locate this exact frozen attachment instead of relying on random sampling.
  const count = await f.db.collection("question_versions").countDocuments({ org_id: f.org, status: "published", difficulty: "挑战" });
  const session = await practice(f, { count, difficulty: "挑战" });
  const item = (await good(f.student, `/sessions/${session.id}/items`)).items.find(row => row.resource_ids.includes(attached.file.id));
  assert.ok(item, "本人会话必须冻结本场景实际扫描的附件");
  const path = `/sessions/${session.id}/items/${item.id}/files/${attached.file.id}/content`;
  await deliver(f.student, path, attached.bytes);
  error(await request(f.otherStudent, path), 404);
  error(await request(f.student, `/files/${attached.file.id}/content`), 404);
}

test("IAM standalone 文件扫描：真实ClamAV、管理隔离竞态与本人/平台安全交付", { concurrency: false, timeout: 1800000 }, async t => {
  const f = await setup(t);
  await t.test("claim和rename前四次隔离不耗失败预算，过期但未夺租的原token也能退还", async () => {
    const attached = await attachment(f, "多次隔离不耗扫描预算");
    for (const [index, cutpoint] of ["claimed", "claimed", "before-rename", "claimed"].entries()) {
      const child = scanChild(f, attached, cutpoint);
      try {
        await child.wait();
        const claimed = await f.files.findOne({ _id: attached.file.id });
        assert.equal(claimed.scan_status, "scanning");
        assert.equal(claimed.scan_attempt, 1);
        if (index === 1) assert.equal((await f.files.updateOne({ _id: claimed._id, lease_token: claimed.lease_token, scan_status: "scanning" }, { $set: { lease_until: new Date(0) } })).modifiedCount, 1);
        const release = await isolate(f);
        await notDeliverable(f, attached);
        assert.deepEqual(await readFile(join(f.root, "quarantine", attached.storageKey)), attached.bytes);
        await assert.rejects(lstat(join(f.root, "ready", attached.storageKey)), { code: "ENOENT" });
        child.resume();
        assert.equal(await child.finish(), true);
        const paused = await f.files.findOne({ _id: attached.file.id });
        assert.equal(paused.scan_status, "queued");
        assert.equal(paused.scan_attempt, 0);
        assert.equal(paused.lease_token, null);
        assert.equal(paused.lease_until, null);
        await notDeliverable(f, attached);
        const blocked = scanChild(f, attached);
        try { assert.equal(await blocked.finish(), false); }
        finally { await blocked.stop(); }
        await release();
      } finally { await child.stop(); }
    }
    await healthyDelivery(f, attached, 1);
  });
  await t.test("真实rename后隔离不发布clean，ready字节必须退回quarantine后重新健康扫描", async () => {
    const attached = await attachment(f, "rename后管理隔离");
    const child = scanChild(f, attached, "after-rename");
    try {
      await child.wait();
      const claimed = await f.files.findOne({ _id: attached.file.id });
      assert.equal(claimed.scan_status, "scanning");
      assert.equal(claimed.scan_attempt, 1);
      assert.deepEqual(await readFile(join(f.root, "ready", attached.storageKey)), attached.bytes);
      await assert.rejects(lstat(join(f.root, "quarantine", attached.storageKey)), { code: "ENOENT" });
      const release = await isolate(f);
      child.resume();
      assert.equal(await child.finish(), true);
      const interrupted = await f.files.findOne({ _id: attached.file.id });
      assert.equal(interrupted.scan_status, "scanning");
      assert.equal(interrupted.scan_attempt, 0);
      assert.ok(interrupted.lease_token === claimed.lease_token, "rename后的原租约留作恢复证据");
      assert.ok(interrupted.lease_until <= new Date());
      await notDeliverable(f, attached);
      assert.equal((await reconcile(f.db)).repaired, 0, "隔离未解除不得搬动恢复中的物理字节");
      assert.deepEqual(await readFile(join(f.root, "ready", attached.storageKey)), attached.bytes);
      await release();
      await notDeliverable(f, attached);
      assert.equal((await reconcile(f.db)).repaired, 1);
      const queued = await f.files.findOne({ _id: attached.file.id });
      assert.equal(queued.scan_status, "queued");
      assert.equal(queued.scan_attempt, 0);
      assert.equal(queued.error_code, "SCAN_INTERRUPTED");
      assert.equal(queued.lease_token, null);
      assert.deepEqual(await readFile(join(f.root, "quarantine", attached.storageKey)), attached.bytes);
      await assert.rejects(lstat(join(f.root, "ready", attached.storageKey)), { code: "ENOENT" });
      await notDeliverable(f, attached);
      await healthyDelivery(f, attached, 1);
    } finally { await child.stop(); }
  });
  await t.test("原clean扫描失租后遇隔离，不能退款或回退独立新worker的token/attempt", async () => {
    const attached = await attachment(f, "新扫描owner的租约保护");
    const stale = scanChild(f, attached, "before-rename");
    let winner;
    try {
      await stale.wait();
      const first = await f.files.findOne({ _id: attached.file.id });
      assert.equal((await f.files.updateOne({ _id: first._id, lease_token: first.lease_token, scan_status: "scanning" }, { $set: { lease_until: new Date(0) } })).modifiedCount, 1);
      assert.equal((await reconcile(f.db)).repaired, 1);
      winner = scanChild(f, attached, "claimed");
      await winner.wait();
      const second = await f.files.findOne({ _id: attached.file.id });
      assert.ok(second.lease_token !== first.lease_token, "独立新worker必须持有新租约");
      assert.equal(second.scan_attempt, 2);
      const release = await isolate(f);
      stale.resume();
      assert.equal(await stale.finish(), true);
      const live = await f.files.findOne({ _id: attached.file.id });
      assert.equal(live.scan_status, "scanning");
      assert.equal(live.scan_attempt, 2);
      assert.ok(live.lease_token === second.lease_token, "旧worker不得清除新owner租约");
      assert.ok(live.lease_until.getTime() === second.lease_until.getTime(), "旧worker不得过期新owner租约");
      assert.deepEqual(await readFile(join(f.root, "quarantine", attached.storageKey)), attached.bytes);
      await notDeliverable(f, attached);
      winner.resume();
      assert.equal(await winner.finish(), true);
      const returned = await f.files.findOne({ _id: attached.file.id });
      assert.equal(returned.scan_attempt, 1, "只能退还新worker自身被隔离的一次尝试");
      assert.equal(returned.scan_status, "queued");
      assert.equal(returned.lease_token, null);
      await release();
      await healthyDelivery(f, attached, 2);
    } finally {
      await stale.stop();
      if (winner) await winner.stop();
    }
  });
  await t.test("新worker已完成ready/clean后，旧clean扫描遇隔离不得回退已发布事实", async () => {
    const attached = await attachment(f, "新扫描已经发布后的旧owner保护");
    const stale = scanChild(f, attached, "before-rename");
    try {
      await stale.wait();
      const first = await f.files.findOne({ _id: attached.file.id });
      assert.equal((await f.files.updateOne({ _id: first._id, lease_token: first.lease_token, scan_status: "scanning" }, { $set: { lease_until: new Date(0) } })).modifiedCount, 1);
      assert.equal((await reconcile(f.db)).repaired, 1);
      await scan(f, attached);
      const completed = await f.files.findOne({ _id: attached.file.id });
      assert.equal(completed.status, "ready");
      assert.equal(completed.scan_status, "clean");
      assert.equal(completed.scan_attempt, 2);
      const release = await isolate(f);
      stale.resume();
      assert.equal(await stale.finish(), true);
      const preserved = await f.files.findOne({ _id: attached.file.id });
      assert.equal(preserved.status, "ready");
      assert.equal(preserved.scan_status, "clean");
      assert.equal(preserved.scan_attempt, 2, "不能退还已经由新worker完成的历史尝试");
      assert.equal(preserved.lease_token, null);
      assert.equal(preserved.lease_until, null);
      assert.ok(preserved.scanned_at.getTime() === completed.scanned_at.getTime(), "旧owner不得替换新worker扫描证据");
      assert.ok(preserved.scan_engine_version === completed.scan_engine_version);
      assert.ok(preserved.scan_database_version === completed.scan_database_version);
      assert.deepEqual(await readFile(join(f.root, "ready", attached.storageKey)), attached.bytes);
      await assert.rejects(lstat(join(f.root, "quarantine", attached.storageKey)), { code: "ENOENT" });
      assert.equal(await f.db.collection("audit_events").countDocuments({ resource_id: attached.file.id, action: "file.scan.clean" }), 1);
      await release();
      await readyDelivery(f, attached, 2);
    } finally { await stale.stop(); }
  });
  await t.test("真实缺失引擎遇隔离仍消耗失败预算且不终止worker，三次失败不交付", async () => {
    const attached = await attachment(f, "真实非clean引擎故障");
    const env = { CLAMSCAN_PATH: join(f.root, "missing-real-clamscan.exe") };
    await assert.rejects(lstat(env.CLAMSCAN_PATH), { code: "ENOENT" });
    const child = scanChild(f, attached, "claimed", env);
    try {
      await child.wait();
      const release = await isolate(f);
      child.resume();
      assert.equal(await child.finish(), true, "真实非clean扫描遇隔离不能令worker进程失败");
      const failed = await f.files.findOne({ _id: attached.file.id });
      assert.equal(failed.scan_status, "scanning");
      assert.equal(failed.scan_attempt, 1, "真实失败不能作为隔离暂停退款");
      assert.ok(failed.lease_until <= new Date());
      await notDeliverable(f, attached);
      assert.deepEqual(await readFile(join(f.root, "quarantine", attached.storageKey)), attached.bytes);
      await release();
      assert.equal((await reconcile(f.db)).repaired, 1);
      await scan(f, attached, env);
      const retry = await f.files.findOne({ _id: attached.file.id });
      assert.equal(retry.scan_attempt, 2);
      assert.equal(retry.scan_status, "queued");
      assert.equal(retry.error_code, "SCAN_FAILED");
      assert.ok(retry.available_at > new Date());
      assert.equal((await f.files.updateOne({ _id: retry._id, scan_status: "queued", scan_attempt: 2 }, { $set: { available_at: new Date(0) } })).modifiedCount, 1);
      await scan(f, attached, env);
      const exhausted = await f.files.findOne({ _id: attached.file.id });
      assert.equal(exhausted.scan_attempt, 3);
      assert.equal(exhausted.scan_status, "failed");
      assert.equal(exhausted.error_code, "SCAN_FAILED");
      assert.equal(exhausted.lease_token, null);
      await notDeliverable(f, attached);
      assert.deepEqual(await readFile(join(f.root, "quarantine", attached.storageKey)), attached.bytes);
      await assert.rejects(lstat(join(f.root, "ready", attached.storageKey)), { code: "ENOENT" });
      assert.equal(await f.db.collection("audit_events").countDocuments({ resource_id: attached.file.id, action: "file.scan.failed" }), 1);
      // Exercise subsequent real work, rather than merely asserting a promise did not throw.
      const healthy = await attachment(f, "故障之后继续真实扫描");
      await healthyDelivery(f, healthy, 1);
    } finally { await child.stop(); }
  });
});
