"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { mkdtemp, rm, readFile, realpath } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { ORIGIN, error } = require("./helpers.cjs");
const { assessmentFixture, request, good, grant, createQuiz, practice } = require("./assessment-helpers.cjs");
const exec = promisify(execFile);

// Like content.integration.test.cjs, use private real storage and the actual scanner process.
// Run test files with --test-concurrency=1 because fixtures temporarily set process.env.
async function setup(t) {
  for (const key of ["TEST_CLAMSCAN_PATH", "TEST_CLAMAV_DATABASE", "SCAN_DATABASE_MAX_AGE_HOURS"])
    assert.ok(process.env[key], `缺少 ${key}：真实扫描验收不得跳过或伪造成功`);
  // Windows TEMP may use ADMINI~1. Match the native realpath used by the
  // production storage guard instead of weakening its canonical-path check.
  const parent = await realpath(process.env.TEST_FILE_STORAGE_PARENT || tmpdir());
  const root = await mkdtemp(join(parent, "knowladder-assessment-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
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
    // Fail before database fixtures and expensive scanner startup if the chosen
    // parent permits path replacement. Keep the production ACL policy intact.
    const { assertWindowsPrivateDirectory } = require("../dist/security/private-directory.js");
    await assertWindowsPrivateDirectory(root);
  }
  const f = await assessmentFixture(t, { env: { FILE_STORAGE_ROOT: root,
    CLAMSCAN_PATH: process.env.TEST_CLAMSCAN_PATH, CLAMAV_DATABASE: process.env.TEST_CLAMAV_DATABASE } });
  f.root = root;
  return f;
}
function headers(actor) {
  return { Cookie: [...actor.browser.cookies].map(([key, value]) => `${key}=${value}`).join("; "), "X-Org-Id": actor.org };
}
async function attachmentQuestion(f, title) {
  const question = await good(f.editor, "/admin/question-versions", { method: "POST", body: {
    title, subject_id: f.subject, question_type: "single", prompt: "阅读原创附件，选出一", options: [{ id: "A", text: "一" }, { id: "B", text: "二" }],
    answer: "A", explanation: "原创附件说明整数一", knowledge_point_ids: [f.knowledge],
    knowledge_weights: [{ knowledge_point_id: f.knowledge, weight_bps: 10000 }], difficulty: "挑战", difficulty_basis: "隔离附件验收范围",
    scoring_rule: { version: 1, strategy: "single_exact", max_score: "1" },
    license: { source: "本测试自主编写的原创附件", granted: true, expires_at: null },
  } });
  const bytes = Buffer.from(`原创冻结附件：${title}。整数一位于整数二之前。\n`, "utf8");
  const file = await good(f.editor, "/admin/files", { method: "POST", body: {
    owner_type: "question", owner_version_id: question.id, expected_revision: question.revision,
    display_name: "原创题目.txt", size: bytes.length, mime: "text/plain", checksum: createHash("sha256").update(bytes).digest("hex"),
  } });
  assert.equal(file.status, "pending"); assert.equal(file.scan_status, "awaiting_upload");
  const uploaded = await fetch(`${f.editor.browser.base}/api/v1/admin/files/${file.id}/content`, { method: "PUT", headers: {
    ...headers(f.editor), Origin: ORIGIN, "X-CSRF-Token": f.editor.browser.csrf, "Idempotency-Key": randomUUID(),
    "X-Owner-Revision": String(file.owner_revision), "Content-Type": "application/octet-stream",
  }, body: bytes, signal: AbortSignal.timeout(30000) });
  if (uploaded.status !== 200) {
    const failure = await uploaded.json();
    const code = failure?.error?.code;
    assert.fail(`附件上传HTTP ${uploaded.status}${typeof code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? ` (${code})` : ""}`);
  }
  await uploaded.arrayBuffer();
  await exec(process.execPath, [join(__dirname, "../dist/files/worker.js"), "once"], { env: { ...process.env }, timeout: 120000 });
  const scanned = await good(f.editor, `/admin/files/${file.id}`);
  assert.equal(scanned.status, "ready"); assert.equal(scanned.scan_status, "clean");
  assert.ok(scanned.scanned_at); assert.ok(scanned.scan_engine_version); assert.ok(scanned.scan_database_version);
  const base = `/admin/question-versions/${question.id}`;
  const current = await good(f.editor, base);
  const bound = await good(f.editor, base, { method: "PATCH", body: { expected_revision: current.revision, resource_ids: [file.id] } });
  const review = await good(f.editor, `${base}/submit-review`, { method: "POST", body: { expected_revision: bound.revision } });
  const published = await good(f.contentReviewer, `${base}/publish`, { method: "POST", body: { expected_revision: review.revision } });
  assert.equal(published.status, "published");
  return { question: published, file, bytes };
}
const pathFor = (session, item, fileId) => `/sessions/${session.id}/items/${item.id}/files/${fileId}/content`;
async function delivered(actor, path, bytes) {
  for (const range of [false, true]) {
    const response = await fetch(`${actor.browser.base}/api/v1${path}`, { headers: { ...headers(actor), ...(range ? { Range: "bytes=0-3" } : {}) }, signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, range ? 206 : 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), range ? bytes.subarray(0, 4) : bytes);
    if (range) assert.equal(response.headers.get("content-range"), `bytes 0-3/${bytes.length}`);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("content-disposition"), /^attachment/);
    assert.match(response.headers.get("content-security-policy"), /sandbox/);
  }
}
async function denied(actor, path, status, code) {
  for (const range of [false, true]) {
    const response = await request(actor, path, { headers: range ? { Range: "bytes=0-3" } : {} });
    error(response, status);
    if (code) assert.equal(response.data.error.code, code);
  }
}

test("评估冻结附件：真实ClamAV、本人HTTP交付及两端引用保护", { concurrency: false, timeout: 900000 }, async t => {
  await t.test("管理题目附件无效Range不登记反馈、不取消已预占首次，合法交付才登记", async t => {
    const f = await setup(t);
    const attachment = await attachmentQuestion(f, "Range曝光原子性");
    f.student = await f.actor(["student", "content_editor"]);
    const session = await practice(f, { difficulty: "挑战", count: 1 });
    const filter = { org_id: f.org, user_id: f.student.user.user_id, question_id: attachment.question.question_id };
    const before = await f.db.collection("learning_question_states").findOne(filter);
    assert.equal(before.feedback_seen, false);
    const path = `/admin/files/${attachment.file.id}/content`;
    for (const range of ["bytes=0-1,3-4", "bytes=-0", `bytes=${attachment.bytes.length}-`]) {
      const response = await request(f.student, path, { headers: { Range: range } });
      error(response, 416);
      assert.equal(response.data.error.code, "RANGE_NOT_SATISFIABLE");
      assert.deepEqual(await f.db.collection("learning_question_states").findOne(filter), before);
    }
    const accepted = await good(f.student, `/sessions/${session.id}/submissions`, { method: "POST", body: { expected_revision: session.revision, answers: [] } }, 202);
    const attempt = await f.db.collection("learning_attempt_contexts").findOne({ submission_id: accepted.submission_id, question_id: attachment.question.question_id });
    assert.equal(attempt.qualification, "first");
    await delivered(f.student, path, attachment.bytes);
    assert.equal((await f.db.collection("learning_question_states").findOne(filter)).feedback_seen, true);
    assert.deepEqual(await f.db.collection("learning_attempt_contexts").findOne({ _id: attempt._id }), attempt);
    for (const capability of ["assessment:manage", "assessment:review"]) {
      f.student = await f.actor(["student"], [capability]);
      const ownSession = await practice(f, { difficulty: "挑战", count: 1 });
      const ownFilter = { ...filter, user_id: f.student.user.user_id };
      const ownBefore = await f.db.collection("learning_question_states").findOne(ownFilter);
      assert.equal(ownBefore.feedback_seen, false);
      const previewPath = `/admin/assessment-questions/${attachment.question.id}/files/${attachment.file.id}/content`;
      const rejected = await request(f.student, previewPath, { headers: { Range: "bytes=0-1,3-4" } });
      error(rejected, 416);
      assert.equal(rejected.data.error.code, "RANGE_NOT_SATISFIABLE");
      assert.deepEqual(await f.db.collection("learning_question_states").findOne(ownFilter), ownBefore);
      // Direct file preview must be sufficient: no question/detail page was read.
      await delivered(f.student, previewPath, attachment.bytes);
      assert.equal((await f.db.collection("learning_question_states").findOne(ownFilter)).feedback_seen, true);
      const ownAccepted = await good(f.student, `/sessions/${ownSession.id}/submissions`, { method: "POST", body: { expected_revision: ownSession.revision, answers: [] } }, 202);
      const ownAttempt = await f.db.collection("learning_attempt_contexts").findOne({ submission_id: ownAccepted.submission_id, question_id: attachment.question.question_id });
      assert.equal(ownAttempt.qualification, "exposed");
    }
  });
  await t.test("本人练习/考试全文与Range，跨本人/题项拒绝，整会话保密与当前许可逐次生效", async t => {
    const f = await setup(t);
    const first = await attachmentQuestion(f, "附件甲");
    const second = await attachmentQuestion(f, "附件乙");
    const session = await practice(f, { difficulty: "挑战", count: 2 });
    const items = (await good(f.student, `/sessions/${session.id}/items`)).items;
    const firstItem = items.find(item => item.resource_ids.includes(first.file.id));
    const secondItem = items.find(item => item.resource_ids.includes(second.file.id));
    assert.ok(firstItem); assert.ok(secondItem);
    const firstPath = pathFor(session, firstItem, first.file.id);
    const secondPath = pathFor(session, secondItem, second.file.id);
    await denied(f.student, `/files/${first.file.id}/content`, 404);
    await delivered(f.student, firstPath, first.bytes);
    await delivered(f.student, secondPath, second.bytes);
    const other = await f.actor();
    await denied(other, firstPath, 404);
    await denied(f.student, pathFor(session, firstItem, second.file.id), 404);
    await denied(f.student, pathFor(session, firstItem, randomUUID()), 404);
    const otherSession = await practice({ ...f, student: other }, { difficulty: "挑战", count: 2 });
    await denied(f.student, pathFor(otherSession, firstItem, first.file.id), 404);
    await denied(other, pathFor(otherSession, firstItem, first.file.id), 404);

    // Expiring a DIFFERENT item must also block this file URL, without changing scanned bytes.
    await f.db.collection("question_versions").updateOne({ _id: second.question.id }, { $set: { "license.expires_at": new Date(0).toISOString() } });
    await denied(f.student, firstPath, 409, "CONTENT_UNAVAILABLE");
    await f.db.collection("question_versions").updateOne({ _id: second.question.id }, { $set: { "license.expires_at": null } });
    await delivered(f.student, firstPath, first.bytes);

    const quiz = await createQuiz(f, { items: [{ question_version_id: first.question.id, max_score: "1" }] });
    await denied(f.student, firstPath, 409, "QUESTION_EMBARGOED");
    await denied(f.student, secondPath, 409, "QUESTION_EMBARGOED");
    const exam = await good(f.student, `/quizzes/${quiz.id}/sessions`, { method: "POST", body: {} });
    const examItem = (await good(f.student, `/sessions/${exam.id}/items`)).items[0];
    const examPath = pathFor(exam, examItem, first.file.id);
    await delivered(f.student, examPath, first.bytes);
    await denied(other, examPath, 404);
    await denied(f.student, pathFor(exam, examItem, second.file.id), 404);
    await denied(f.student, `/files/${first.file.id}/content`, 404);
    await grant(f, f.editor, "content:revoke");
    const current = await good(f.editor, `/admin/question-versions/${first.question.id}`);
    await good(f.editor, `/admin/question-versions/${first.question.id}/revoke-access`, { method: "POST", body: {
      expected_access_revision: current.access_revision, reason: "原创附件撤销授权验收",
    } });
    await denied(f.student, examPath, 409, "CONTENT_UNAVAILABLE");
    await denied(f.student, secondPath, 409, "CONTENT_UNAVAILABLE");
  });

  for (const referenceType of ["session_item", "paper_item"]) {
    await t.test(`${referenceType}独立保留引用同时阻断HTTP清理申请与worker领取`, async t => {
      const f = await setup(t);
      const attached = await attachmentQuestion(f, `保留引用${referenceType}`);
      if (referenceType === "session_item") await practice(f, { difficulty: "挑战", count: 1 });
      else await createQuiz(f, { items: [{ question_version_id: attached.question.id, max_score: "1" }] });
      const refs = await f.db.collection("assessment_resource_references").find({ file_id: attached.file.id }).toArray();
      assert.equal(refs.length, 1); assert.equal(refs[0].reference_type, referenceType);
      const frozen = await f.db.collection(referenceType === "session_item" ? "session_items" : "paper_items").findOne({ _id: refs[0].reference_id });
      assert.deepEqual(frozen.snapshot.resource_ids, [attached.file.id]);
      await grant(f, f.editor, "file:delete");
      // Deliberate storage maintenance fault: detach the current owner and expire/revoke it.
      // Only the formally-created assessment reference now protects this genuinely scanned file.
      await f.db.collection("question_versions").updateOne({ _id: attached.question.id }, { $set: {
        resource_ids: [], status: "retired", access_revoked_at: new Date(), "license.expires_at": new Date(0).toISOString(),
      } });
      for (const collection of ["question_versions", "textbook_editions", "chapters"])
        assert.equal(await f.db.collection(collection).countDocuments({ resource_ids: attached.file.id }), 0);
      const owner = await f.db.collection("question_versions").findOne({ _id: attached.question.id });
      const response = await request(f.editor, `/admin/files/${attached.file.id}/schedule-deletion`, { method: "POST", body: {
        expected_owner_revision: owner.revision, retention_until: new Date(0).toISOString(), reason: "验证保留引用阻断清理申请",
      } });
      error(response, 409); assert.equal(response.data.error.code, "FILE_REFERENCED");
      const files = f.db.collection("file_resources");
      assert.equal((await files.findOne({ _id: attached.file.id })).deletion_requested_at, null);
      // Inject an already accepted/old cleanup request to exercise the worker's independent fence.
      await files.updateOne({ _id: attached.file.id }, { $set: { retention_until: new Date(0), available_at: new Date(0),
        deletion_requested_at: new Date(0), deletion_requested_by: f.editor.user.user_id, deletion_requested_reason: "模拟旧清理申请" } });
      const { processDeletion } = require("../dist/files/worker.js");
      assert.equal(await processDeletion(f.db), false);
      const retained = await files.findOne({ _id: attached.file.id });
      assert.equal(retained.status, "ready"); assert.equal(retained.scan_status, "clean");
      assert.equal(retained.deleted_at, null); assert.equal(retained.deletion_lease_token, null); assert.equal(retained.deletion_attempt, 0);
      assert.deepEqual(await readFile(join(f.root, "ready", retained.storage_key)), attached.bytes);
      assert.equal(await f.db.collection("audit_events").countDocuments({ resource_id: attached.file.id, action: "file.deletion.claim" }), 0);
      assert.equal(await f.db.collection("assessment_resource_references").countDocuments({ file_id: attached.file.id }), 1);
    });
  }
});
