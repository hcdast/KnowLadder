"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { fixture, Browser, status, error, guardedUri, ORIGIN } = require("./helpers.cjs");
const exec = promisify(execFile);

// Run all server test files with --test-concurrency=1: fixtures mutate process.env.
const license = () => ({ source: "真实集成验收自有内容授权", granted: true, expires_at: null });
async function setup(t, options = {}) {
  const f = await fixture(t, options);
  const organization = await f.ops.createOrganization(f.context, { name: "内容验收组织", kind: "school" });
  f.org = organization.organization_id;
  const now = new Date();
  f.stage = randomUUID(); f.subject = randomUUID(); f.knowledge = randomUUID();
  // Explicit test fixtures, never inserted by the production migration or API.
  await f.db.collection("education_stages").insertOne({ _id: f.stage, code: "test-stage", name: "验收学段", created_at: now, updated_at: now });
  await f.db.collection("subjects").insertOne({ _id: f.subject, code: "test-subject", name: "验收学科", created_at: now, updated_at: now });
  await f.db.collection("knowledge_points").insertOne({ _id: f.knowledge, code: "test-knowledge", name: "验收知识点", subject_id: f.subject, created_at: now, updated_at: now });
  f.actor = async (roles, org = f.org) => {
    const browser = new Browser(f.browser.base);
    const user = await f.authenticated(browser);
    await f.ops.setMembership(f.context, { user_id: user.user_id, org_id: org, roles });
    return { browser, user, org };
  };
  f.editor = await f.actor(["content_editor", "content_reviewer"]);
  f.reviewer = await f.actor(["content_reviewer"]);
  f.student = await f.actor(["student"]);
  return f;
}
function request(actor, path, { method = "GET", body, key = randomUUID(), headers = {} } = {}) {
  return actor.browser.request(path, { method, body, headers: { "X-Org-Id": actor.org,
    ...(method === "GET" ? {} : { "Idempotency-Key": key }), ...headers } });
}
async function good(actor, path, options) {
  const response = await request(actor, path, options);
  status(response, 200);
  assert.equal(typeof response.data.request_id, "string");
  return response.data.data;
}
function textbookInput(f, changes = {}) {
  return { title: "真实验收教材版本", textbook: { title: "真实验收教材", stage_id: f.stage, subject_id: f.subject, source: "自主编写" },
    edition_code: `edition-${randomUUID()}`, license: license(), ...changes };
}
async function createBook(f, changes = {}) {
  return good(f.editor, "/admin/textbook-editions", { method: "POST", body: textbookInput(f, changes) });
}
async function detail(f, id) { return good(f.editor, `/admin/textbook-editions/${id}`); }
function chapter(f, changes = {}) {
  return { id: randomUUID(), parent_id: null, position: 0, title: "章节", body: "真实阅读正文", knowledge_point_ids: [f.knowledge], resource_ids: [], ...changes };
}
async function chapters(f, id, values) {
  const current = await detail(f, id);
  return good(f.editor, `/admin/textbook-editions/${id}/chapters`, { method: "PUT", body: { expected_revision: current.revision, chapters: values } });
}
async function transition(actor, base, action, revision, reason) {
  return good(actor, `${base}/${action}`, { method: "POST", body: { expected_revision: revision, ...(reason ? { reason } : {}) } });
}
async function publish(f, id) {
  const base = `/admin/textbook-editions/${id}`;
  let row = await detail(f, id);
  await transition(f.editor, base, "submit-review", row.revision);
  row = await detail(f, id);
  await transition(f.reviewer, base, "publish", row.revision);
  return detail(f, id);
}
function noAnswer(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!["answer", "explanation", "storage_key", "storage_path"].includes(key), `学生 DTO 不应包含 ${key}`);
    noAnswer(child);
  }
}

async function privateStorage(t) {
  const root = await mkdtemp(join(process.env.TEST_FILE_STORAGE_PARENT || tmpdir(), "knowladder-content-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (process.platform === "win32") {
    // Only change the newly-created test directory; production ancestor checks remain enabled.
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
  }
  return root;
}
// Missing infrastructure is a failure, never an implicit successful mock/skip.
test("阶段二：真实内容版本、权限、幂等、章节和私有文件", { concurrency: false, timeout: 600000 }, async (t) => {
  guardedUri(process.env.TEST_MONGODB_URI);

  await t.test("C01 旧版本一账户库可无损升级且两版本checksum各自稳定", async (t) => {
    const f = await fixture(t, { migrated: false, app: false });
    const { migrateVersion1, assertSchemaVersion1, assertSchema } = require("../dist/migrations/schema.js");
    await migrateVersion1(f.uri);
    await assertSchemaVersion1(f.db);
    const { hashPassword } = require("../dist/security/password.js");
    const now = new Date();
    const user = { user_id: randomUUID() };
    const originalUser = { _id: user.user_id, login_key: "existing_v1_user", display_name: "升级前账户",
      status: "active", password_hash: await hashPassword("Old-account-password!42"), credential_version: 1,
      identity_revision: 0, must_change_password: false, temporary_password_expires_at: null,
      password_changed_at: now, created_at: now, updated_at: now };
    await f.db.collection("users").insertOne(originalUser);
    const v1 = await f.db.collection("schema_migrations").findOne({ version: 1 });
    const originalRoles = await f.db.collection("roles").find().sort({ _id: 1 }).toArray();
    assert.equal(await f.db.collection("schema_migrations").countDocuments(), 1);
    await assert.rejects(assertSchema(f.db), /content migration/i);
    await f.migrate(f.uri); await f.migrate(f.uri); await assertSchema(f.db);
    assert.deepEqual(await f.db.collection("users").findOne({ _id: user.user_id }), { ...originalUser, privacy_state: "active" });
    assert.deepEqual(await f.db.collection("schema_migrations").findOne({ version: 1 }), v1);
    assert.deepEqual(await f.db.collection("roles").find().sort({ _id: 1 }).toArray(), originalRoles);
    const rows = await f.db.collection("schema_migrations").find().sort({ version: 1 }).toArray();
    assert.deepEqual(rows.map((row) => [row.version, row.status]), [[1, "completed"], [2, "completed"], [3, "completed"], [4, "completed"], [5, "completed"], [6, "completed"], [7, "completed"]]);
    for (const row of rows) { assert.match(row.checksum, /^[a-f0-9]{64}$/); assert.equal(row.lease_token, null); }
    for (const name of ["textbooks", "textbook_editions", "chapters", "questions", "question_versions", "education_stages", "subjects", "knowledge_points", "file_resources", "content_idempotency"]) {
      assert.equal(await f.db.collection(name).countDocuments(), 0, "迁移不得偷偷写入示例内容");
      await assert.rejects(f.db.collection(name).insertOne({ _id: randomUUID(), unexpected: true }), (e) => e.code === 121);
    }
    await f.db.collection("schema_migrations").updateOne({ version: 2 }, { $set: { checksum: "0".repeat(64) } });
    await assert.rejects(f.migrate(f.uri), /checksum/i);
    await assertSchemaVersion1(f.db);
  });

  await t.test("C02 草稿写入、稳定幂等结果及正文冲突、CAS与作者自审阻断", async (t) => {
    const f = await setup(t);
    const body = textbookInput(f); const key = randomUUID();
    const book = await good(f.editor, "/admin/textbook-editions", { method: "POST", body, key });
    const repeated = await good(f.editor, "/admin/textbook-editions", { method: "POST", body, key });
    assert.deepEqual(repeated, book);
    assert.equal(await f.db.collection("textbook_editions").countDocuments({ org_id: f.org }), 1);
    error(await request(f.editor, "/admin/textbook-editions", { method: "POST", body: { ...body, title: "不同正文" }, key }), 409);
    const base = `/admin/textbook-editions/${book.id}`;
    const before = await detail(f, book.id);
    await good(f.editor, base, { method: "PATCH", body: { expected_revision: before.revision, title: "修订标题" } });
    error(await request(f.editor, base, { method: "PATCH", body: { expected_revision: before.revision, title: "旧revision" } }), 409);
    await chapters(f, book.id, [chapter(f)]);
    let current = await detail(f, book.id);
    assert.equal(current.title, "修订标题");
    await transition(f.editor, base, "submit-review", current.revision);
    current = await detail(f, book.id);
    error(await request(f.editor, `${base}/publish`, { method: "POST", body: { expected_revision: current.revision } }), 403);
    error(await request(f.editor, base, { method: "PATCH", body: { expected_revision: current.revision, title: "审核中篡改" } }), 409);
    await transition(f.reviewer, base, "return", current.revision, "内容需要修订");
    assert.equal((await detail(f, book.id)).status, "draft");
    const audit = await good(f.editor, `/admin/audit-events?resource_type=textbook&resource_id=${book.id}`);
    assert.ok(audit.items.length >= 3);
  });

  await t.test("C03 贡献者不得自审，独立审核发布后学生只读", async (t) => {
    const f = await setup(t); const book = await createBook(f);
    await chapters(f, book.id, [chapter(f)]);
    const contributor = await f.actor(["content_editor", "content_reviewer"]);
    const base = `/admin/textbook-editions/${book.id}`;
    await good(contributor, base, { method: "PATCH", body: { expected_revision: (await detail(f, book.id)).revision, title: "协同修订" } });
    await transition(f.editor, base, "submit-review", (await detail(f, book.id)).revision);
    error(await request(contributor, `${base}/publish`, { method: "POST", body: { expected_revision: (await detail(f, book.id)).revision } }), 403);
    await transition(f.reviewer, base, "publish", (await detail(f, book.id)).revision);
    const result = await good(f.student, "/textbook-editions");
    assert.ok(result.items.some((row) => row.id === book.id));
    error(await request(f.student, "/admin/textbook-editions", { method: "POST", body: textbookInput(f) }), 403);
    error(await request(f.editor, base, { method: "PATCH", body: { expected_revision: (await detail(f, book.id)).revision, title: "修改已发布" } }), 409);
  });

  await t.test("C04 跨组织枚举拒绝、未发布和过期授权不可阅读", async (t) => {
    const f = await setup(t); const book = await createBook(f); const node = chapter(f);
    await chapters(f, book.id, [node]);
    error(await request(f.student, `/textbook-editions/${book.id}/chapters`), 404);
    const otherOrg = await f.ops.createOrganization(f.context, { name: "隔离组织", kind: "school" });
    const outsider = await f.actor(["content_editor", "content_reviewer", "student"], otherOrg.organization_id);
    error(await request(outsider, `/admin/textbook-editions/${book.id}`), 404);
    error(await request(outsider, `/admin/audit-events?resource_type=textbook&resource_id=${book.id}`), 404);
    await publish(f, book.id);
    error(await request(outsider, `/chapters/${node.id}`), 404);
    error(await request(outsider, `/textbook-editions/${book.id}/chapters`), 404);
    assert.equal((await good(outsider, "/textbook-editions")).items.length, 0);
    // Expiration is mutable time state, not publication status. Simulate time having passed in stored license.
    await f.db.collection("textbook_editions").updateOne({ _id: book.id }, { $set: { "license.expires_at": new Date(Date.now() - 1000).toISOString() } });
    error(await request(f.student, `/chapters/${node.id}`), 404);
    assert.equal((await good(f.student, "/textbook-editions")).items.length, 0);
  });

  await t.test("C05 章节树拒绝cycle/orphan/重复id且失败不改变revision，版本复制重建ID", async (t) => {
    const f = await setup(t); const book = await createBook(f);
    const parent = chapter(f); const child = chapter(f, { parent_id: parent.id, title: "子章节" });
    await chapters(f, book.id, [parent, child]);
    const before = await detail(f, book.id);
    error(await request(f.editor, `/admin/textbook-editions/${book.id}/chapters`, { method: "PUT", body: { expected_revision: before.revision - 1, chapters: [parent] } }), 409);
    for (const values of [[{ ...parent, parent_id: child.id }, child], [{ ...parent, parent_id: randomUUID() }], [parent, parent]]) {
      error(await request(f.editor, `/admin/textbook-editions/${book.id}/chapters`, { method: "PUT", body: { expected_revision: before.revision, chapters: values } }), 422);
      assert.equal((await detail(f, book.id)).revision, before.revision);
    }
    const read = await publish(f, book.id);
    const tree = await good(f.student, `/textbook-editions/${book.id}/chapters`);
    assert.ok(JSON.stringify(tree).includes(parent.id));
    const content = await good(f.student, `/chapters/${child.id}`);
    assert.equal(content.body, child.body);
    const copy = await createBook(f, { textbook: undefined, textbook_id: read.textbook_id, source_edition_id: book.id, edition_code: "derived-edition" });
    assert.equal(typeof copy.copy_notice, "string");
    const copied = await f.db.collection("chapters").find({ org_id: f.org, textbook_edition_id: copy.id }).toArray();
    assert.equal(copied.length, 2);
    assert.ok(copied.every((row) => ![parent.id, child.id].includes(row._id) && row.resource_ids.length === 0));
    const copiedParent = copied.find((row) => row.parent_id === null);
    assert.equal(copied.find((row) => row.parent_id !== null).parent_id, copiedParent._id);
  });

  await t.test("C06 题型答案校验、草稿题版本审核及学生知识点响应不泄露答案", async (t) => {
    const f = await setup(t);
    const input = { title: "单选题", subject_id: f.subject, question_type: "single", prompt: "一加一等于几？",
      options: [{ id: "A", text: "一" }, { id: "B", text: "二" }], answer: "B", explanation: "整数加法", knowledge_point_ids: [f.knowledge], difficulty: "基础", license: license(), scoring_rule: { version: 1, strategy: "single_exact", max_score: "1" }, knowledge_weights: [{ knowledge_point_id: f.knowledge, weight_bps: 10000 }], difficulty_basis: "原创验收整数加法，仅验证流程" };
    for (const invalid of [{ ...input, options: [input.options[0], input.options[0]] }, { ...input, question_type: "unknown" }]) {
      error(await request(f.editor, "/admin/question-versions", { method: "POST", body: invalid }), 422);
    }
    for (const invalid of [{ ...input, answer: "Z" }, { ...input, question_type: "numeric", options: [], answer: "NaN" },
      { ...input, prompt: "", answer: "", options: [{ id: "A", text: "" }] }]) {
      const draft = await good(f.editor, "/admin/question-versions", { method: "POST", body: invalid });
      error(await request(f.editor, `/admin/question-versions/${draft.id}/submit-review`, { method: "POST", body: { expected_revision: draft.revision } }), 422);
      assert.equal((await good(f.editor, `/admin/question-versions/${draft.id}`)).status, "draft");
    }
    const question = await good(f.editor, "/admin/question-versions", { method: "POST", body: input });
    const base = `/admin/question-versions/${question.id}`;
    let current = await good(f.editor, base);
    assert.equal(current.answer, "B");
    await transition(f.editor, base, "submit-review", current.revision);
    current = await good(f.editor, base);
    await transition(f.reviewer, base, "publish", current.revision);
    error(await request(f.student, `/knowledge-points/${f.knowledge}`), 404);
    const book = await createBook(f);
    const node = chapter(f);
    await chapters(f, book.id, [node]);
    await publish(f, book.id);
    const linked = await good(f.student, `/knowledge-points/${f.knowledge}`);
    assert.ok(linked.chapters.some((row) => row.id === node.id));
    assert.equal(linked.id, f.knowledge);
    assert.ok(!("questions" in linked), "阶段二学生知识点仅返回教材章节，不暴露题库");
    noAnswer(linked);
    error(await request(f.student, base), 403);
    const numeric = await good(f.editor, "/admin/question-versions", { method: "POST", body: { ...input, title: "数值题", question_type: "numeric", options: [], answer: "2" } });
    assert.equal((await good(f.editor, `/admin/question-versions/${numeric.id}`)).question_type, "numeric");
    const multiple = await good(f.editor, "/admin/question-versions", { method: "POST", body: { ...input, title: "多选题", question_type: "multiple", answer: "A,B" } });
    assert.equal((await good(f.editor, `/admin/question-versions/${multiple.id}`)).question_type, "multiple");
  });

  await t.test("C08 审核发布重新验证授权，列表游标绑定组织和筛选", async (t) => {
    const f = await setup(t);
    const unlicensed = await createBook(f, { license: { source: "尚未授权", granted: false, expires_at: null } });
    await chapters(f, unlicensed.id, [chapter(f)]);
    const base = `/admin/textbook-editions/${unlicensed.id}`;
    let current = await detail(f, unlicensed.id);
    error(await request(f.editor, `${base}/submit-review`, { method: "POST", body: { expected_revision: current.revision } }), 422);
    await good(f.editor, base, { method: "PATCH", body: { expected_revision: current.revision, license: license() } });
    current = await detail(f, unlicensed.id);
    await transition(f.editor, base, "submit-review", current.revision);
    await f.db.collection("textbook_editions").updateOne({ _id: unlicensed.id }, { $set: { "license.expires_at": new Date(Date.now() - 1000).toISOString() } });
    current = await detail(f, unlicensed.id);
    error(await request(f.reviewer, `${base}/publish`, { method: "POST", body: { expected_revision: current.revision } }), 422);
    assert.equal((await detail(f, unlicensed.id)).status, "review");
    const a = await createBook(f); const b = await createBook(f);
    const first = await good(f.editor, "/admin/textbook-editions?status=draft&limit=1");
    assert.equal(first.items.length, 1); assert.equal(typeof first.next_cursor, "string");
    const second = await good(f.editor, `/admin/textbook-editions?status=draft&limit=1&cursor=${encodeURIComponent(first.next_cursor)}`);
    assert.equal(second.items.length, 1); assert.equal(second.next_cursor, null);
    assert.deepEqual([first.items[0].id, second.items[0].id].sort(), [a.id, b.id].sort());
    error(await request(f.editor, `/admin/textbook-editions?status=review&cursor=${encodeURIComponent(first.next_cursor)}`), 422);
    const other = await f.ops.createOrganization(f.context, { name: "游标隔离组织", kind: "school" });
    const outsider = await f.actor(["content_editor"], other.organization_id);
    error(await request(outsider, `/admin/textbook-editions?status=draft&cursor=${encodeURIComponent(first.next_cursor)}`), 422);
  });

    async function uploadAttachment(f, book, bytes, name) {
      const owner = await detail(f, book.id);
      const body = { owner_type: "textbook", owner_version_id: book.id, expected_revision: owner.revision, display_name: name,
        size: bytes.length, mime: "text/plain", checksum: createHash("sha256").update(bytes).digest("hex") };
      const record = await good(f.editor, "/admin/files", { method: "POST", body });
      assert.equal(record.status, "pending"); assert.equal(record.scan_status, "awaiting_upload");
      const recovered = await good(f.editor, `/admin/files?owner_type=textbook&owner_version_id=${book.id}&limit=1`);
      assert.equal(recovered.items.length, 1);
      assert.equal(recovered.owner_revision, record.owner_revision);
      assert.ok(!("storage_key" in recovered.items[0]));
      const browser = f.editor.browser;
      const response = await fetch(`${browser.base}/api/v1/admin/files/${record.id}/content`, { method: "PUT", headers: {
        Cookie: [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; "), Origin: ORIGIN,
        "X-CSRF-Token": browser.csrf, "X-Org-Id": f.org, "Idempotency-Key": randomUUID(),
        "X-Owner-Revision": String(record.owner_revision), "Content-Type": "application/octet-stream",
      }, body: bytes, signal: AbortSignal.timeout(30000) });
      assert.equal(response.status, 200); await response.arrayBuffer();
      error(await request(f.student, `/files/${record.id}/content`), 404);
      await exec(process.execPath, [join(__dirname, "../dist/files/worker.js"), "once"], { env: { ...process.env }, timeout: 120000 });
      return { record, state: await good(f.editor, `/admin/files/${record.id}`) };
    }
  await t.test("C07 私有文件真实上传、真实ClamAV clean扫描和Range授权下载", { timeout: 180000 }, async (t) => {
    assert.ok(process.env.TEST_CLAMSCAN_PATH, "缺少 TEST_CLAMSCAN_PATH：真实文件扫描验收未执行，不能视为通过");
    assert.ok(process.env.TEST_CLAMAV_DATABASE, "缺少 TEST_CLAMAV_DATABASE：必须使用真实官方病毒库");
    assert.ok(process.env.SCAN_DATABASE_MAX_AGE_HOURS, "缺少显式病毒库新鲜度门槛");
    const root = await privateStorage(t);
    const f = await setup(t, { env: { FILE_STORAGE_ROOT: root, CLAMSCAN_PATH: process.env.TEST_CLAMSCAN_PATH,
      ...(process.env.TEST_CLAMAV_DATABASE ? { CLAMAV_DATABASE: process.env.TEST_CLAMAV_DATABASE } : {}) } });
    const book = await createBook(f);
    await chapters(f, book.id, [chapter(f)]);
    const bytes = Buffer.from("真实私有附件扫描与下载验收\n", "utf8");
    const clean = await uploadAttachment(f, book, bytes, "验收正文.txt");
    assert.equal(clean.state.scan_status, "clean"); assert.equal(clean.state.status, "ready");
    noAnswer(clean.state);
    const previewBrowser = f.editor.browser;
    const draftPreview = await fetch(`${previewBrowser.base}/api/v1/admin/files/${clean.record.id}/content`, { headers: { Cookie: [...previewBrowser.cookies].map(([k, v]) => `${k}=${v}`).join("; "), "X-Org-Id": f.org } });
    assert.equal(draftPreview.status, 200);
    assert.deepEqual(Buffer.from(await draftPreview.arrayBuffer()), bytes);
    error(await request(f.editor, `/files/${clean.record.id}/content`), 404);
    // Bind only the verified clean resource before publication.
    const unbound = await uploadAttachment(f, book, Buffer.from("原创未绑定附件，仅管理可预览\n", "utf8"), "未绑定正文.txt");
    assert.equal(unbound.state.status, "ready"); assert.equal(unbound.state.scan_status, "clean");
    await chapters(f, book.id, [chapter(f, { body: "", resource_ids: [clean.record.id] })]);
    await publish(f, book.id);
    const published = await detail(f, book.id);
    assert.deepEqual(published.resource_ids, []);
    error(await request(f.student, `/files/${unbound.record.id}/content`), 404);
    const unboundPreview = await fetch(`${previewBrowser.base}/api/v1/admin/files/${unbound.record.id}/content`, { headers: { Cookie: [...previewBrowser.cookies].map(([k, v]) => `${k}=${v}`).join("; "), "X-Org-Id": f.org } });
    assert.equal(unboundPreview.status, 200); await unboundPreview.arrayBuffer();
    const derived = await createBook(f, { textbook: undefined, textbook_id: published.textbook_id,
      source_edition_id: book.id, edition_code: "attachment-copy" });
    assert.equal(typeof derived.copy_notice, "string");
    assert.deepEqual((await detail(f, derived.id)).resource_ids, []);
    const derivedChapters = await good(f.editor, `/admin/textbook-editions/${derived.id}/chapters`);
    assert.equal(derivedChapters.items.length, 1); assert.deepEqual(derivedChapters.items[0].resource_ids, []);
    assert.equal(derivedChapters.items[0].body, "");
    error(await request(f.editor, `/admin/textbook-editions/${derived.id}/submit-review`, { method: "POST", body: { expected_revision: derived.revision } }), 422);
    const otherOrg = await f.ops.createOrganization(f.context, { name: "附件隔离组织", kind: "school" });
    const outsider = await f.actor(["content_editor", "student"], otherOrg.organization_id);
    error(await request(outsider, `/admin/files/${clean.record.id}`), 404);
    error(await request(outsider, `/files/${clean.record.id}/content`), 404);
    const browser = f.student.browser;
    const headers = { Cookie: [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; "), "X-Org-Id": f.org };
    const full = await fetch(`${browser.base}/api/v1/files/${clean.record.id}/content`, { headers });
    assert.equal(full.status, 200); assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
    assert.equal(full.headers.get("x-content-type-options"), "nosniff");
    assert.match(full.headers.get("content-disposition"), /^attachment/);
    assert.match(full.headers.get("content-security-policy"), /sandbox/);
    const range = await fetch(`${browser.base}/api/v1/files/${clean.record.id}/content`, { headers: { ...headers, Range: "bytes=0-3" } });
    assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 4));
    assert.equal(range.headers.get("content-range"), `bytes 0-3/${bytes.length}`);
    const multiple = await fetch(`${browser.base}/api/v1/files/${clean.record.id}/content`, { headers: { ...headers, Range: "bytes=0-1,3-4" } });
    assert.equal(multiple.status, 416); await multiple.arrayBuffer();
    const stored = await f.db.collection("file_resources").findOne({ _id: clean.record.id });
    const corrupted = Buffer.from(bytes); corrupted[0] ^= 1;
    await require("node:fs/promises").writeFile(join(root, "ready", stored.storage_key), corrupted);
    for (const extra of [{}, { Range: "bytes=0-3" }]) {
      const rejected = await fetch(`${browser.base}/api/v1/files/${clean.record.id}/content`, { headers: { ...headers, ...extra } });
      assert.equal(rejected.status, 503);
      assert.equal((await rejected.json()).error.code, "FILE_UNAVAILABLE");
    }
  });
  await t.test("C16 独立真实EICAR上传、ClamAV感染隔离与禁止预览", { timeout: 180000 }, async (t) => {
    assert.ok(process.env.TEST_CLAMSCAN_PATH, "缺少 TEST_CLAMSCAN_PATH：真实感染扫描验收未执行，不能视为通过");
    assert.ok(process.env.TEST_CLAMAV_DATABASE, "缺少 TEST_CLAMAV_DATABASE：必须使用真实官方病毒库");
    assert.ok(process.env.SCAN_DATABASE_MAX_AGE_HOURS, "缺少显式病毒库新鲜度门槛");
    const root = await privateStorage(t);
    const f = await setup(t, { env: { FILE_STORAGE_ROOT: root, CLAMSCAN_PATH: process.env.TEST_CLAMSCAN_PATH,
      CLAMAV_DATABASE: process.env.TEST_CLAMAV_DATABASE } });
    const book = await createBook(f);
    await chapters(f, book.id, [chapter(f)]);
    const eicar = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
    const infected = await uploadAttachment(f, book, eicar, "eicar.txt");
    assert.equal(infected.state.scan_status, "infected");
    assert.equal(infected.state.status, "quarantined");
    error(await request(f.editor, `/admin/files/${infected.record.id}/content`), 409);
    error(await request(f.student, `/files/${infected.record.id}/content`), 404);
  });
  await t.test("C09 完整性、冻结章树、空建、撤销安全DTO及审计", async (t) => {
    const f = await setup(t); const book = await createBook(f); const base = `/admin/textbook-editions/${book.id}`;
    let saved = await chapters(f, book.id, [chapter(f, { knowledge_point_ids: [] })]);
    error(await request(f.editor, `${base}/submit-review`, { method: "POST", body: { expected_revision: saved.revision } }), 422);
    assert.equal((await detail(f, book.id)).revision, saved.revision);
    const nodes = Array.from({ length: 23 }, (_, position) => chapter(f, { position }));
    saved = await chapters(f, book.id, nodes);
    const first = await good(f.editor, `${base}/chapters?limit=20`);
    assert.equal(first.items.length, 20); assert.ok(first.next_cursor);
    const last = await good(f.editor, `${base}/chapters?limit=20&edition_revision=${first.edition_revision}&cursor=${first.next_cursor}`);
    assert.equal(last.items.length, 3); assert.equal(last.next_cursor, null);
    error(await request(f.editor, `${base}/chapters?limit=20&cursor=${first.next_cursor}`), 422);
    saved = await chapters(f, book.id, nodes);
    error(await request(f.editor, `${base}/chapters?limit=20&edition_revision=${first.edition_revision}&cursor=${first.next_cursor}`), 409);
    const empty = await createBook(f, { textbook: undefined, textbook_id: book.textbook_id });
    assert.equal((await good(f.editor, `/admin/textbook-editions/${empty.id}/chapters`)).items.length, 0);
    error(await request(f.editor, `${base}/revoke-access`, { method: "POST", body: { expected_access_revision: saved.access_revision, reason: "停止授权" } }), 403);
    const member = await f.db.collection("organization_members").findOne({ org_id: f.org, user_id: f.editor.user.user_id });
    await f.db.collection("member_capability_grants").insertOne({ _id: randomUUID(), org_id: f.org, member_id: member._id, capability: "content:revoke" });
    const published = await publish(f, book.id); const key = randomUUID();
    const stopped = await good(f.editor, `${base}/revoke-access`, { method: "POST", key, body: { expected_access_revision: published.access_revision, reason: "原创验收授权撤销" } });
    assert.equal(stopped.revision, published.revision); assert.equal(stopped.access_revision, published.access_revision + 1);
    assert.ok(!("license" in stopped)); assert.ok(!("resource_ids" in stopped));
    assert.deepEqual(await good(f.editor, `${base}/revoke-access`, { method: "POST", key, body: { expected_access_revision: published.access_revision, reason: "原创验收授权撤销" } }), stopped);
    error(await request(f.editor, `${base}/chapters`), 404); error(await request(f.student, `/chapters/${nodes[0].id}`), 404);
    error(await request(f.editor, "/admin/textbook-editions", { method: "POST", body: textbookInput(f, { textbook: undefined, textbook_id: book.textbook_id, source_edition_id: book.id }) }), 409);
    const events = await good(f.editor, `/admin/audit-events?resource_type=textbook&resource_id=${book.id}`);
    const event = events.items.find(row => row.action === "content.textbook.revoke-access");
    assert.equal(event.owner_version_id, book.id); assert.equal(event.access_revision_before, published.access_revision); assert.equal(event.access_revision_after, stopped.access_revision);
  });
  await t.test("C10 撤回独立能力与旧题缺失规则不得伪造", async (t) => {
    const f = await setup(t); const book = await createBook(f); const node = chapter(f);
    await chapters(f, book.id, [node]); const published = await publish(f, book.id); const base = `/admin/textbook-editions/${book.id}`;
    error(await request(f.editor, `${base}/retire`, { method: "POST", body: { expected_revision: published.revision, reason: "原创验收停止使用" } }), 403);
    const member = await f.db.collection("organization_members").findOne({ org_id: f.org, user_id: f.editor.user.user_id });
    await f.db.collection("member_capability_grants").insertOne({ _id: randomUUID(), org_id: f.org, member_id: member._id, capability: "content:retire" });
    const retired = await good(f.editor, `${base}/retire`, { method: "POST", body: { expected_revision: published.revision, reason: "原创验收停止使用" } });
    assert.equal(retired.status, "retired"); assert.equal(retired.revision, published.revision + 1); assert.equal(retired.access_revision, published.access_revision + 1);
    error(await request(f.student, `/chapters/${node.id}`), 404);
    assert.equal((await good(f.editor, `${base}/chapters`)).items.length, 1);
    const input = { title: "原创数值验收", subject_id: f.subject, question_type: "numeric", prompt: "1加1", options: [], answer: "2", explanation: "整数加法", knowledge_point_ids: [f.knowledge], difficulty: "基础", license: license() };
    const draft = await good(f.editor, "/admin/question-versions", { method: "POST", body: input });
    assert.equal(draft.scoring_rule, null); assert.deepEqual(draft.knowledge_weights, []); assert.equal(draft.difficulty_basis, "");
    error(await request(f.editor, `/admin/question-versions/${draft.id}/submit-review`, { method: "POST", body: { expected_revision: draft.revision } }), 422);
    const empty = await good(f.editor, "/admin/question-versions", { method: "POST", body: { title: "已有身份空草稿", question_id: draft.question_id, subject_id: f.subject, question_type: "numeric", difficulty: "基础" } });
    assert.equal(empty.version_no, 2); assert.equal(empty.prompt, ""); assert.equal(empty.answer, ""); assert.equal(empty.source_version_id, null);
    const fixed = await good(f.editor, `/admin/question-versions/${draft.id}`, { method: "PATCH", body: { expected_revision: draft.revision, scoring_rule: { version: 1, strategy: "numeric_exact_decimal", max_score: "1" }, knowledge_weights: [{ knowledge_point_id: f.knowledge, weight_bps: 10000 }], difficulty_basis: "原创验收基础整数运算" } });
    const review = await transition(f.editor, `/admin/question-versions/${draft.id}`, "submit-review", fixed.revision);
    const approved = await transition(f.reviewer, `/admin/question-versions/${draft.id}`, "publish", review.revision);
    assert.equal(approved.status, "published");
  });
  await t.test("C11 发布与撤销事务竞争只提交符合fence顺序的结果", async (t) => {
    const f = await setup(t); const book = await createBook(f); await chapters(f, book.id, [chapter(f)]);
    const base = `/admin/textbook-editions/${book.id}`; const draft = await detail(f, book.id);
    const review = await transition(f.editor, base, "submit-review", draft.revision);
    const member = await f.db.collection("organization_members").findOne({ org_id: f.org, user_id: f.editor.user.user_id });
    await f.db.collection("member_capability_grants").insertOne({ _id: randomUUID(), org_id: f.org, member_id: member._id, capability: "content:revoke" });
    const [publishResult, revokeResult] = await Promise.all([
      request(f.reviewer, `${base}/publish`, { method: "POST", body: { expected_revision: review.revision } }),
      request(f.editor, `${base}/revoke-access`, { method: "POST", body: { expected_access_revision: review.access_revision, reason: "并发原创验收" } }),
    ]);
    assert.deepEqual([publishResult.status, revokeResult.status].sort(), [200, 409]);
    const final = await detail(f, book.id);
    if (revokeResult.status === 200) { assert.equal(final.status, "review"); assert.ok(final.access_revoked_at); assert.ok(!("license" in final)); }
    else { assert.equal(final.status, "published"); assert.equal(final.access_revoked_at, null); }
    const events = await good(f.editor, `/admin/audit-events?resource_type=textbook&resource_id=${book.id}`);
    assert.equal(events.items.filter(row => ["content.textbook.publish", "content.textbook.revoke-access"].includes(row.action)).length, 1);
  });
  await t.test("C12 规则与权重非法输入事务回滚、精确数值送审边界", async (t) => {
    const f = await setup(t);
    const input = { title: "原创数值边界", subject_id: f.subject, question_type: "numeric", prompt: "精确十进制边界验收", options: [], answer: "9007199254740993", explanation: "仅验收存储不执行评分", knowledge_point_ids: [f.knowledge], difficulty: "基础", license: license(), scoring_rule: { version: 1, strategy: "numeric_exact_decimal", max_score: "100.00" }, knowledge_weights: [{ knowledge_point_id: f.knowledge, weight_bps: 10000 }], difficulty_basis: "原创边界验收" };
    const draft = await good(f.editor, "/admin/question-versions", { method: "POST", body: input }); const base = `/admin/question-versions/${draft.id}`;
    const edits = [
      { knowledge_weights: [{ knowledge_point_id: f.knowledge, weight_bps: 0 }] },
      { knowledge_weights: [{ knowledge_point_id: f.knowledge, weight_bps: 1.5 }] },
      { knowledge_weights: [{ knowledge_point_id: f.knowledge, weight_bps: 10001 }] },
      { knowledge_weights: [{ knowledge_point_id: f.knowledge, weight_bps: 5000 }, { knowledge_point_id: f.knowledge, weight_bps: 5000 }] },
      ...[0, "0", "100.01", "1e1", "1.001", "Infinity"].map(max_score => ({ scoring_rule: { ...input.scoring_rule, max_score } })),
      { scoring_rule: { ...input.scoring_rule, version: 2 } },
    ];
    const eventsBefore = await f.db.collection("audit_events").countDocuments({ owner_version_id: draft.id });
    for (const change of edits) {
      error(await request(f.editor, base, { method: "PATCH", body: { expected_revision: draft.revision, ...change } }), 422);
      const unchanged = await good(f.editor, base); assert.equal(unchanged.revision, draft.revision); assert.equal(unchanged.access_revision, draft.access_revision);
    }
    assert.equal(await f.db.collection("audit_events").countDocuments({ owner_version_id: draft.id }), eventsBefore);
    const incomplete = [
      { knowledge_weights: [{ knowledge_point_id: f.knowledge, weight_bps: 9999 }] },
      { knowledge_weights: [{ knowledge_point_id: randomUUID(), weight_bps: 10000 }] },
      { scoring_rule: { ...input.scoring_rule, strategy: "single_exact" } },
      { difficulty_basis: "" }, ...["1e101", "1e-101", "NaN", "Infinity", "0".repeat(101), "1/2"].map(answer => ({ answer })),
    ];
    for (const change of incomplete) {
      const row = await good(f.editor, "/admin/question-versions", { method: "POST", body: { ...input, ...change } });
      error(await request(f.editor, `/admin/question-versions/${row.id}/submit-review`, { method: "POST", body: { expected_revision: row.revision } }), 422);
      assert.equal((await good(f.editor, `/admin/question-versions/${row.id}`)).revision, row.revision);
    }
    for (const answer of ["1e100", "1e-100", "-0.000", "9007199254740993"]) {
      const row = await good(f.editor, "/admin/question-versions", { method: "POST", body: { ...input, answer } });
      const submitted = await transition(f.editor, `/admin/question-versions/${row.id}`, "submit-review", row.revision);
      assert.equal(submitted.answer, answer); assert.equal(submitted.status, "review");
    }
  });
  await t.test("C13 游标绑定同组织用户、教材筛选及审核前冻结修订", async (t) => {
    const f = await setup(t); const book = await createBook(f);
    const sibling = await createBook(f, { textbook: undefined, textbook_id: book.textbook_id });
    const other = await createBook(f);
    const first = await good(f.editor, `/admin/textbook-editions?textbook_id=${book.textbook_id}&limit=1`);
    assert.ok(first.next_cursor);
    error(await request(f.reviewer, `/admin/textbook-editions?textbook_id=${book.textbook_id}&limit=1&cursor=${first.next_cursor}`), 422);
    error(await request(f.editor, `/admin/textbook-editions?textbook_id=${other.textbook_id}&limit=1&cursor=${first.next_cursor}`), 422);
    const next = await good(f.editor, `/admin/textbook-editions?textbook_id=${book.textbook_id}&limit=1&cursor=${first.next_cursor}`);
    assert.deepEqual([first.items[0].id, next.items[0].id].sort(), [book.id, sibling.id].sort());
    await chapters(f, book.id, [chapter(f), chapter(f, { position: 1 })]); const base = `/admin/textbook-editions/${book.id}`;
    const tree = await good(f.editor, `${base}/chapters?limit=1`);
    error(await request(f.reviewer, `${base}/chapters?limit=1&edition_revision=${tree.edition_revision}&cursor=${tree.next_cursor}`), 422);
    const current = await detail(f, book.id); const review = await transition(f.editor, base, "submit-review", current.revision);
    error(await request(f.reviewer, `${base}/return`, { method: "POST", body: { expected_revision: review.revision, reason: " " } }), 422);
    const returned = await transition(f.reviewer, base, "return", review.revision, "原创验收重审");
    const edited = await good(f.editor, base, { method: "PATCH", body: { expected_revision: returned.revision, title: "重新编辑的原创标题" } });
    const resubmitted = await transition(f.editor, base, "submit-review", edited.revision);
    error(await request(f.reviewer, `${base}/publish`, { method: "POST", body: { expected_revision: review.revision } }), 409);
    assert.equal((await detail(f, book.id)).revision, resubmitted.revision);
  });
  await t.test("C14 发布重新验证章节完整性、知识点学科及树结构", async (t) => {
    const f = await setup(t); const book = await createBook(f); const node = chapter(f); await chapters(f, book.id, [node]);
    const base = `/admin/textbook-editions/${book.id}`; const draft = await detail(f, book.id);
    const review = await transition(f.editor, base, "submit-review", draft.revision);
    // Simulate damaged/imported backing records after review; publication must not trust the earlier validation.
    for (const change of [{ knowledge_point_ids: [] }, { body: "" }, { parent_id: randomUUID() }, { parent_id: node.id }]) {
      await f.db.collection("chapters").updateOne({ _id: node.id }, { $set: change });
      error(await request(f.reviewer, `${base}/publish`, { method: "POST", body: { expected_revision: review.revision } }), 422);
      assert.equal((await detail(f, book.id)).revision, review.revision);
      await f.db.collection("chapters").updateOne({ _id: node.id }, { $set: { knowledge_point_ids: node.knowledge_point_ids, body: node.body, parent_id: null } });
    }
    for (const [field, original] of [["stage_id", f.stage], ["subject_id", f.subject]]) {
      await f.db.collection("textbooks").updateOne({ _id: book.textbook_id }, { $set: { [field]: randomUUID() } });
      error(await request(f.reviewer, `${base}/publish`, { method: "POST", body: { expected_revision: review.revision } }), 422);
      assert.equal((await detail(f, book.id)).revision, review.revision);
      await f.db.collection("textbooks").updateOne({ _id: book.textbook_id }, { $set: { [field]: original } });
    }
    await f.db.collection("knowledge_points").updateOne({ _id: f.knowledge }, { $set: { subject_id: randomUUID() } });
    error(await request(f.reviewer, `${base}/publish`, { method: "POST", body: { expected_revision: review.revision } }), 422);
    await f.db.collection("knowledge_points").updateOne({ _id: f.knowledge }, { $set: { subject_id: f.subject } });
    assert.equal(await f.db.collection("audit_events").countDocuments({ owner_version_id: book.id, action: "content.textbook.publish" }), 0);
    assert.equal((await transition(f.reviewer, base, "publish", review.revision)).status, "published");
  });
  await t.test("C15 撤销幂等结果不随之后撤回变化且不恢复原文", async (t) => {
    const f = await setup(t); const book = await createBook(f); await chapters(f, book.id, [chapter(f)]);
    const published = await publish(f, book.id); const base = `/admin/textbook-editions/${book.id}`;
    const member = await f.db.collection("organization_members").findOne({ org_id: f.org, user_id: f.editor.user.user_id });
    await f.db.collection("member_capability_grants").insertMany(["content:revoke", "content:retire"].map(capability => ({ _id: randomUUID(), org_id: f.org, member_id: member._id, capability })));
    const key = randomUUID(); const body = { expected_access_revision: published.access_revision, reason: "原创验收撤销" };
    const revoked = await good(f.editor, `${base}/revoke-access`, { method: "POST", key, body });
    const retired = await good(f.editor, `${base}/retire`, { method: "POST", body: { expected_revision: revoked.revision, reason: "原创验收撤回" } });
    assert.equal(retired.status, "retired"); assert.equal(retired.revision, revoked.revision + 1);
    assert.deepEqual(await good(f.editor, `${base}/revoke-access`, { method: "POST", key, body }), revoked);
    assert.equal((await detail(f, book.id)).status, "retired");
    assert.ok(!("license" in retired)); assert.ok(!("resource_ids" in retired));
    error(await request(f.editor, `${base}/chapters`), 404);
  });
});
