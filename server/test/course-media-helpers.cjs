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
const { newId } = require("../dist/database/object-id");
const { readFile } = require("node:fs/promises");

// Run all server test files with --test-concurrency=1: fixtures mutate process.env.
const license = () => ({ source: "真实集成验收自有内容授权", granted: true, expires_at: null });
// Test privileges use the real audited CLI path, including the applied-operation gate.
async function memberGrant(f, memberId, capability) {
  const member = await f.db.collection("organization_members").findOne({ _id: memberId });
  return f.ops.setCapability(f.context, { org_id: member.org_id, member_id: memberId, capability,
    granted: true, expected_revision: member.authorization_revision, valid_to: new Date(Date.now() + 3600000) });
}
async function setup(t, options = {}) {
  const f = await fixture(t, options);
  const organization = await f.ops.createOrganization(f.context, { name: "内容验收组织", kind: "school" });
  f.org = organization.organization_id;
  const now = new Date();
  f.stage = newId(); f.subject = newId(); f.knowledge = newId();
  // Explicit test fixtures, never inserted by the production migration or API.
  await f.db.collection("education_stages").insertOne({ _id: f.stage, code: "test-stage", name: "验收学段", created_at: now, updated_at: now });
  await f.db.collection("subjects").insertOne({ _id: f.subject, code: "test-subject", name: "验收学科", created_at: now, updated_at: now });
  await f.db.collection("knowledge_points").insertOne({ _id: f.knowledge, code: "test-knowledge", name: "验收知识点", subject_id: f.subject, created_at: now, updated_at: now });
  f.actor = async (roles, org = f.org) => {
    const browser = new Browser(f.browser.base);
    const user = await f.authenticated(browser);
    await f.ops.setMembership(f.context, { user_id: user.user_id, org_id: org, roles,
      ...(roles.includes("content_reviewer") ? { reviewer_valid_to: new Date(Date.now() + 7 * 86400000) } : {}) });
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
  return { client_key: randomUUID(), parent_id: null, position: 0, title: "章节", body: "真实阅读正文", knowledge_point_ids: [f.knowledge], resource_ids: [], ...changes };
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
async function privateStorage(t) {
  const root = await mkdtemp(join(process.env.TEST_FILE_STORAGE_PARENT || tmpdir(), "knowladder-content-test-"));
  t.after(async () => {
    assert.equal(require("node:path").dirname(require("node:path").resolve(root)), require("node:path").resolve(process.env.TEST_FILE_STORAGE_PARENT || tmpdir()));
    assert.ok(require("node:path").basename(root).startsWith("knowladder-content-test-"));
    await rm(root, { recursive: true, force: true });
  });
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
async function uploadAttachment(f, book, bytes, name) {
      const owner = await detail(f, book.id);
      const body = { owner_type: "textbook", owner_version_id: book.id, expected_revision: owner.revision, display_name: name,
        size: bytes.length, mime: "video/mp4", checksum: createHash("sha256").update(bytes).digest("hex") };
      const record = await good(f.editor, "/admin/files", { method: "POST", body });
      assert.equal(record.status, "pending"); assert.equal(record.scan_status, "awaiting_upload");
      const recovered = await good(f.editor, `/admin/files?owner_type=textbook&owner_version_id=${book.id}&limit=1`);
      assert.equal(recovered.items.length, 1);
      assert.equal(recovered.owner_revision, record.owner_revision);
      assert.ok(!("storage_key" in recovered.items[0]));
      const browser = f.editor.browser;
      const response = await fetch(`${browser.base}/api/v1/admin/files/${record.id}/content`, { method: "PUT", headers: {
        Cookie: [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; "), Origin: process.env.APP_ORIGIN || ORIGIN,
        "X-CSRF-Token": browser.csrf, "X-Org-Id": f.org, "Idempotency-Key": randomUUID(),
        "X-Owner-Revision": String(record.owner_revision), "Content-Type": "application/octet-stream",
      }, body: bytes, signal: AbortSignal.timeout(30000) });
      assert.equal(response.status, 200); await response.arrayBuffer();
      error(await request(f.student, `/files/${record.id}/content`), 404);
      await exec(process.execPath, [join(__dirname, "../dist/files/worker.js"), "once"], { env: { ...process.env }, timeout: 120000 });
      return { record, state: await good(f.editor, `/admin/files/${record.id}`) };
    }

async function setupCourseworkLedger(t) {
  const { mkdtemp, mkdir, rm, realpath } = require("node:fs/promises");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const { MongoClient } = require("mongodb");
  const { randomBytes } = require("node:crypto");
  const { guardedUri } = require("./helpers.cjs");
  const exec = require("node:util").promisify(
    require("node:child_process").execFile,
  );
  const source = guardedUri(process.env.TEST_MONGODB_URI);
  const controlName = `kl_control_privacy_${randomUUID().replaceAll("-", "")}`;
  const controlUri = source.replace(
    /(mongodb(?:\+srv)?:\/\/[^/]+\/)[^?]+/,
    `$1${controlName}`,
  );
  const parent = await realpath(
    process.env.TEST_FILE_STORAGE_PARENT || tmpdir(),
  );
  const root = await mkdtemp(join(parent, "knowladder-privacy-ledger-"));
  const primary = join(root, "primary"),
    mirror = join(root, "mirror");
  const control = new MongoClient(controlUri, {
    serverSelectionTimeoutMS: 5000,
  });
  let connected = false;
  t.after(async () => {
    try {
      if (connected) {
        assert.equal(control.db().databaseName, controlName);
        assert.match(controlName, /^kl_control_privacy_[a-f0-9]{32}$/);
        await control.db().dropDatabase();
      }
    } finally {
      await control.close();
      assert.equal(require("node:path").dirname(require("node:path").resolve(root)), parent);
      assert.ok(require("node:path").basename(root).startsWith("knowladder-privacy-ledger-"));
      await rm(root, { recursive: true, force: true });
    }
  });
  await mkdir(primary, { mode: 0o700 });
  await mkdir(mirror, { mode: 0o700 });
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($path in @($env:KL_TEST_PRIVATE_ROOT,$env:KL_TEST_PRIVATE_PRIMARY,$env:KL_TEST_PRIVATE_MIRROR)) {
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
}`;
    await exec(
      join(
        process.env.SystemRoot || "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        env: {
          ...process.env,
          KL_TEST_PRIVATE_ROOT: root,
          KL_TEST_PRIVATE_PRIMARY: primary,
          KL_TEST_PRIVATE_MIRROR: mirror,
        },
        windowsHide: true,
        timeout: 10000,
      },
    );
    const {
      assertWindowsPrivateDirectory,
    } = require("../dist/security/private-directory.js");
    await assertWindowsPrivateDirectory(primary);
    await assertWindowsPrivateDirectory(mirror);
  }
  await control.connect();
  connected = true;
  assert.ok(
    (await control.db("admin").command({ hello: 1 })).setName,
    "control 必须是真实副本集",
  );
  return {
    KL_ENVIRONMENT_ID: randomUUID(),
    KL_CONTROL_MONGODB_URI: controlUri,
    KL_SAFETY_LEDGER_ROOT: primary,
    KL_SAFETY_LEDGER_MIRROR_ROOT: mirror,
    KL_SAFETY_LEDGER_KEY: randomBytes(32).toString("hex"),
  };
}
async function courseworkPrivateChild(env, name) {
  const fs = require("node:fs/promises"),
    path = require("node:path");
  const folder = path.join(path.dirname(env.KL_SAFETY_LEDGER_ROOT), name);
  await fs.mkdir(folder, { mode: 0o700 });
  if (process.platform === "win32") {
    const script =
      "$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')));Set-Acl -LiteralPath $env:KL_TEST_FILES_PRIVATE -AclObject $acl";
    await require("node:util").promisify(
      require("node:child_process").execFile,
    )(
      path.join(
        process.env.SystemRoot,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        env: { ...process.env, KL_TEST_FILES_PRIVATE: folder },
        windowsHide: true,
      },
    );
  }
  return folder;
}

module.exports={setup,createBook,detail,chapter,chapters,publish,good,uploadAttachment,memberGrant,setupCourseworkLedger,courseworkPrivateChild};

async function courseMedia(t, extra={}) {
 const env=await setupCourseworkLedger(t), storage=await courseworkPrivateChild(env,"files");
 const f=await setup(t,{env:{...env,KL_TRAINING_ENABLED:"true",FILE_SCAN_ENABLED:"true",FILE_STORAGE_ROOT:storage,CLAMSCAN_PATH:process.env.TEST_CLAMSCAN_PATH,CLAMAV_DATABASE:process.env.TEST_CLAMAV_DATABASE,SCAN_DATABASE_MAX_AGE_HOURS:"168",...extra}});
 const bytes=await readFile(join(__dirname,"../../ops/artifacts/training-validation/revision103-original-video.mp4"));
 assert.equal(createHash("sha256").update(bytes).digest("hex"),"a6dd136561334e9dc6fd96f0b3640014c2f40cf0b11e0a1f1acb371588441ab9");
 const book=await createBook(f); await chapters(f,book.id,[chapter(f)]);
 const clean=await uploadAttachment(f,book,bytes,"原创课程视频.mp4");
 assert.equal(clean.state.status,"ready"); assert.equal(clean.state.scan_status,"clean");
 let owner=await detail(f,book.id);
 await good(f.editor,"/admin/textbook-editions/"+book.id,{method:"PATCH",body:{expected_revision:owner.revision,resource_ids:[clean.record.id]}});
 await publish(f,book.id);
 const author=await f.actor(["teacher"]), reviewer=await f.actor(["teacher"]);
 for(const [actor,caps] of [[author,["course:edit","course:assign"]],[reviewer,["course:review"]]]){
  const member=await f.db.collection("organization_members").findOne({user_id:actor.user.user_id,org_id:f.org});actor.member=member._id;
  for(const cap of caps)await memberGrant(f,member._id,cap);
 }
 const studentMember=await f.db.collection("organization_members").findOne({user_id:f.student.user.user_id,org_id:f.org});f.student.member=studentMember._id;
 const classId=newId(),now=new Date();
 await f.db.collection("classes").insertOne({_id:classId,org_id:f.org,name:"原创媒体班",year_label:"2026",status:"active",revision:1,created_by:author.user.user_id,created_at:now,updated_at:now});
 for(const a of [author,reviewer])await f.db.collection("teaching_assignments").insertOne({_id:newId(),org_id:f.org,class_id:classId,member_id:a.member,subject_id:f.subject,status:"active",revision:1,valid_from:null,valid_to:null,created_at:now,updated_at:now});
 await f.db.collection("class_members").insertOne({_id:newId(),org_id:f.org,class_id:classId,member_id:f.student.member,kind:"student",status:"active",valid_from:null,valid_to:null,created_at:now,updated_at:now});
 let course=await good(author,"/training/courses",{method:"POST",body:{code:"original-media",title:"原创视频课程验收",subject_id:f.subject,version_no:1,lessons:[{key:"video-one",title:"原创视频课节",kind:"video",required:true,body:"原创合成教学演示",file_id:clean.record.id,owner_version_id:book.id}]}});
 course=await good(author,"/training/courses/"+course._id+"/actions",{method:"POST",body:{action:"request-review",expected_revision:course.revision}});
 course=await good(reviewer,"/training/courses/"+course._id+"/actions",{method:"POST",body:{action:"publish",expected_revision:course.revision,note:"独立审核原创媒体"}});
 await good(author,"/training/courses/"+course._id+"/assign",{method:"POST",body:{class_id:classId}});
 return {f,env,storage,bytes,book,file:clean.record,course,author,reviewer,classId};
}
module.exports.courseMedia=courseMedia;
