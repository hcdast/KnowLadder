"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { fixture, Browser, status } = require("./helpers.cjs");
const { newId } = require("../dist/database/object-id");
async function setup(t, env = {}, authorRoles = ["teacher"]) {
  const f = await fixture(t, { env: { KL_TRAINING_ENABLED: "true", ...env } });
  f.org = (
    await f.ops.createOrganization(f.context, {
      name: "职业培训隔离验收",
      kind: "school",
    })
  ).organization_id;
  const now = new Date();
  f.subject = newId();
  await f.db.collection("subjects").insertOne({
    _id: f.subject,
    code: "training-" + f.subject,
    name: "职业沟通",
    created_at: now,
    updated_at: now,
  });
  f.actor = async (roles, caps = []) => {
    const browser = new Browser(f.browser.base),
      user = await f.authenticated(browser);
    await f.ops.setMembership(f.context, {
      user_id: user.user_id,
      org_id: f.org,
      roles,
    });
    const member = await f.db
      .collection("organization_members")
      .findOne({ user_id: user.user_id, org_id: f.org });
    for (const capability of caps) {
      const m = await f.db
        .collection("organization_members")
        .findOne({ _id: member._id });
      await f.ops.setCapability(f.context, {
        org_id: f.org,
        member_id: member._id,
        capability,
        granted: true,
        expected_revision: m.authorization_revision,
        valid_to: new Date(Date.now() + 3600000),
      });
    }
    return { browser, user, member: member._id };
  };
  f.author = await f.actor(authorRoles, [
    "training:report-edit",
    "course:edit",
    "course:assign",
    "task:manage",
    "coursework:grade",
    "ai:generate",
    "ai:manage",
  ]);
  f.reviewer = await f.actor(
    ["teacher"],
    ["course:review", "training:report-review"],
  );
  f.student = await f.actor(["student"], ["ai:assist"]);
  f.stranger = await f.actor(["student"]);
  f.classId = newId();
  await f.db.collection("classes").insertOne({
    _id: f.classId,
    org_id: f.org,
    name: "培训班",
    year_label: "2026",
    status: "active",
    revision: 1,
    created_by: f.author.user.user_id,
    created_at: now,
    updated_at: now,
  });
  for (const actor of [f.author, f.reviewer])
    await f.db.collection("teaching_assignments").insertOne({
      _id: newId(),
      org_id: f.org,
      class_id: f.classId,
      member_id: actor.member,
      subject_id: f.subject,
      status: "active",
      revision: 1,
      valid_from: null,
      valid_to: null,
      created_at: now,
      updated_at: now,
    });
  await f.db.collection("class_members").insertOne({
    _id: newId(),
    org_id: f.org,
    class_id: f.classId,
    member_id: f.student.member,
    kind: "student",
    status: "active",
    valid_from: null,
    valid_to: null,
    created_at: now,
    updated_at: now,
  });
  f.req = (a, p, b, key = randomUUID()) =>
    a.browser.request("/training" + p, {
      method: b === undefined ? "GET" : "POST",
      body: b,
      headers: { "X-Org-Id": f.org, "Idempotency-Key": key },
    });
  f.good = async (a, p, b, key) => {
    const r = await f.req(a, p, b, key);
    status(r, 200);
    return r.data.data;
  };
  return f;
}
function attachmentMetadata(f, head, state = "ready", scan = "clean") {
  const ctx = { orgId: f.org, userId: f.student.user.user_id };
  const input = {
    owner_type: "coursework",
    owner_version_id: head._id,
    display_name: "原创.txt",
    size: 12,
    mime: "text/plain",
    checksum: "a".repeat(64),
  };
  const now = new Date();
  const file = {
    _id: newId(),
    org_id: ctx.orgId,
    owner_type: input.owner_type,
    owner_version_id: input.owner_version_id,
    created_by: ctx.userId,
    display_name: input.display_name,
    storage_key: randomUUID(),
    declared_size: input.size,
    declared_mime: input.mime,
    declared_checksum: input.checksum,
    size: null,
    mime: null,
    checksum: null,
    status: "pending",
    scan_status: "awaiting_upload",
    scan_attempt: 0,
    lease_token: null,
    lease_until: null,
    available_at: now,
    uploaded_at: null,
    error_code: null,
    created_at: now,
    updated_at: now,
    upload_key: null,
    upload_lease_token: null,
    upload_lease_until: null,
    upload_storage_key: null,
    upload_storage_keys: [],
    upload_owner_revision: null,
    upload_result_revision: null,
    retention_until: null,
    legal_hold: false,
    deletion_requested_at: null,
    deletion_requested_by: null,
    deletion_requested_reason: null,
    deleted_at: null,
    deletion_lease_token: null,
    deletion_lease_until: null,
    deletion_attempt: 0,
    scan_engine_version: null,
    scan_database_version: null,
    scan_database_updated_at: null,
    scanned_at: null,
  };
  if (state !== "pending")
    Object.assign(file, {
      status: state,
      scan_status: scan,
      size: 12,
      mime: "text/plain",
      checksum: input.checksum,
      uploaded_at: now,
      upload_result_revision: head.revision,
    });
  return file;
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
async function dispositionFixture(t) {
  const env = await setupCourseworkLedger(t),
    storage = await courseworkPrivateChild(env, "files");
  const f = await setup(t, {
    ...env,
    KL_COURSEWORK_FILES_ENABLED: "true",
    KL_TRAINING_REPORTS_ENABLED: "true",
    FILE_STORAGE_ROOT: storage,
  });
  await require("../dist/files/config").storageRoot();
  let task = await f.good(f.author, "/tasks", {
    class_id: f.classId,
    subject_id: f.subject,
    title: "受控清理",
    target_type: "coursework",
    target_id: null,
    due_at: new Date(Date.now() + 120000).toISOString(),
    body: "原创题面",
    rubric: [{ key: "q", title: "质量", weight: 100 }],
  });
  task = await f.good(f.author, "/tasks/" + task._id + "/actions", {
    action: "publish",
    expected_revision: task.revision,
  });
  const head = await f.good(f.student, "/tasks/" + task._id + "/coursework", {
    action: "save",
    expected_revision: 0,
    body: "原创正文",
  });
  const file = attachmentMetadata(f, head);
  file.retention_until = new Date(0);
  await f.db.collection("file_resources").insertOne(file);
  const fs = require("node:fs/promises"),
    path = require("node:path");
  const bytes = Buffer.from("original controlled erasure bytes");
  const filenames = [];
  for (const area of ["tmp", "quarantine", "ready"]) {
    const name = path.join(storage, area, file.storage_key);
    await fs.writeFile(name, bytes, { mode: 0o600 });
    filenames.push(name);
  }
  let report = await f.good(f.author, "/reports", {
    class_id: f.classId,
    subject_id: f.subject,
    task_id: null,
    title: "原创派生报告",
    body: "仅以当前服务端事实撰写，证据不足。",
  });
  report = await f.good(f.author, "/reports/" + report._id + "/actions", {
    action: "request-review",
    expected_revision: report.revision,
  });
  report = await f.good(f.reviewer, "/reports/" + report._id + "/actions", {
    action: "publish",
    expected_revision: report.revision,
    note: "独立确认原创事实",
  });
  for (const app of f.apps.splice(0)) await app.close();
  const control = require("../dist/operations/control");
  await control.registerEnvironment(f.client, f.db, {
    environmentId: env.KL_ENVIRONMENT_ID,
    fileRoot: storage,
    actor: "disposition-test",
    reason: "original isolated bytes",
  });
  return { f, env, storage, head, file, filenames, bytes, control, report };
}
async function maintenance(f, control) {
  const actor = { actor: "disposition-test", reason: "isolated maintenance" };
  await control.drainEnvironment(f.client, f.db, {
    ...actor,
    expectedRevision: (await control.getOperationalState(f.db)).revision,
  });
  return control.enterMaintenance(f.client, f.db, {
    ...actor,
    expectedRevision: (await control.getOperationalState(f.db)).revision,
  });
}
test(
  "受控清理：维护态、引用拒绝、CAS、原操作重试、真实字节与账本",
  { timeout: 180000 },
  async (t) => {
    const { f, env, head, file, filenames, control } =
      await dispositionFixture(t);
    const {
      scheduleCourseworkCleanup,
    } = require("../dist/files/coursework-cleanup");
    const actor = {
      actor: "disposition-test",
      reason: "remove unused original file",
    };
    await assert.rejects(
      scheduleCourseworkCleanup(f.client, f.db, {
        ...actor,
        fileId: file._id,
        expectedRevision: head.revision,
        maintenanceToken: randomUUID(),
      }),
      /OPERATIONS_MAINTENANCE_REQUIRED/,
    );
    const m = await maintenance(f, control);
    const input = {
      ...actor,
      fileId: file._id,
      expectedRevision: head.revision,
      maintenanceToken: m.token,
    };
    await f.db
      .collection("coursework_heads")
      .updateOne({ _id: head._id }, { $set: { file_ids: [file._id] } });
    await assert.rejects(
      scheduleCourseworkCleanup(f.client, f.db, input),
      /FILE_REFERENCED/,
    );
    assert.equal(
      (
        await require("../dist/operations/ledger").readSafetyLedger(
          env.KL_ENVIRONMENT_ID,
          0,
        )
      ).pending,
      false,
    );
    await f.db
      .collection("coursework_heads")
      .updateOne({ _id: head._id }, { $set: { file_ids: [] } });
    const tokenFile = require("node:path").join(
      await courseworkPrivateChild(env, "tokens"),
      "maintenance.token",
    );
    await require("node:fs/promises").writeFile(tokenFile, m.token, {
      mode: 0o600,
    });
    const cli = await require("node:util").promisify(
      require("node:child_process").execFile,
    )(
      process.execPath,
      [
        "dist/operations/cli.js",
        "coursework-cleanup",
        "--actor",
        actor.actor,
        "--reason",
        actor.reason,
        "--file-id",
        file._id,
        "--expected-revision",
        String(head.revision),
        "--token-file",
        tokenFile,
      ],
      {
        cwd: require("node:path").resolve(__dirname, ".."),
        env: { ...process.env, MONGODB_URI: f.uri },
        windowsHide: true,
        timeout: 30000,
      },
    );
    assert.equal(JSON.parse(cli.stdout).scheduled, true);
    assert.equal(cli.stdout.includes(m.token), false);
    assert.equal(
      (await scheduleCourseworkCleanup(f.client, f.db, input)).replayed,
      true,
    );
    await control.leaveMaintenance(f.client, f.db, {
      ...actor,
      token: m.token,
    });
    assert.equal(
      await require("../dist/files/worker").processDeletion(f.db),
      true,
    );
    for (const name of filenames)
      await assert.rejects(require("node:fs/promises").access(name), {
        code: "ENOENT",
      });
    assert.ok(
      (await f.db.collection("file_resources").findOne({ _id: file._id }))
        .deleted_at instanceof Date,
    );
    const ledger = await require("../dist/operations/ledger").readSafetyLedger(
      env.KL_ENVIRONMENT_ID,
      0,
    );
    assert.equal(ledger.pending, false);
    assert.ok(
      ledger.entries.some(
        (x) => x.action === "file.deleted" && x.state === "committed",
      ),
    );
  },
);
test(
  "擦除主体：保全解除再处置、报告派生擦除、幂等及完整旧备份抑制",
  { timeout: 240000 },
  async (t) => {
    const { f, env, storage, head, file, filenames, bytes, control, report } =
      await dispositionFixture(t);
    const actor = {
        actor: "disposition-test",
        reason: "review approved hold release",
      },
      privacy = require("../dist/privacy/execution");
    await require("../dist/files/files.service").setFileHold(f.client, f.db, {
      ...actor,
      fileId: file._id,
      hold: true,
    });
    const now = new Date(),
      id = newId(),
      user = f.student.user.user_id;
    await f.db
      .collection("privacy_deletion_requests")
      .insertOne({
        _id: id,
        user_id: user,
        scope: "account",
        policy_revision: "local_privacy_v1",
        status: "requested",
        revision: 0,
        plan_hash: null,
        actor: null,
        reason_code: null,
        deleted_categories: [],
        retained_categories: [],
        retention_basis: null,
        remaining_actions: [],
        created_at: now,
        updated_at: now,
        lease_token: null,
        lease_until: null,
        ledger_sequence: null,
        completed_steps: [],
      });
    const plan = await privacy.inspectPrivacyRequest(f.db, id);
    await privacy.approvePrivacyRequest(f.client, f.db, {
      ...actor,
      requestId: id,
      expectedRevision: plan.revision,
      planHash: plan.plan_hash,
      retentionBasis: "local_hold_and_provenance",
    });
    const backup = require("../../ops/system-backup.cjs"),
      fs = require("node:fs/promises"),
      path = require("node:path"),
      key = require("node:crypto").randomBytes(32),
      packageFile = path.join(
        await courseworkPrivateChild(env, "packages"),
        "held-old.klb",
      );
    const m = await maintenance(f, control);
    await backup.backup({
      client: f.client,
      db: f.db,
      file: packageFile,
      key,
      root: storage,
      maintenanceToken: m.token,
    });
    await control.leaveMaintenance(f.client, f.db, {
      ...actor,
      token: m.token,
    });
    await privacy.executePrivacyRequest(f.client, f.db, {
      ...actor,
      requestId: id,
    });
    assert.equal(
      (await f.db.collection("users").findOne({ _id: user })).privacy_state,
      "erased",
    );
    assert.equal(
      await f.db.collection("training_reports").findOne({ _id: report._id }),
      null,
    );
    assert.equal(
      await f.db
        .collection("training_report_versions")
        .countDocuments({ report_id: report._id }),
      0,
    );
    for (const name of filenames)
      assert.deepEqual(await fs.readFile(name), bytes);
    const m2 = await maintenance(f, control);
    const input = {
      ...actor,
      requestId: id,
      basis: "approved synthetic hold basis has ended",
      maintenanceToken: m2.token,
    };
    await assert.rejects(
      privacy.reprocessErasedCoursework(f.client, f.db, input),
      /PRIVACY_FILE_HELD/,
    );
    await f.db
      .collection("file_resources")
      .updateOne(
        { _id: file._id },
        { $set: { retention_until: new Date(Date.now() + 60000) } },
      );
    await assert.rejects(
      privacy.reprocessErasedCoursework(f.client, f.db, {
        ...input,
        releaseFileId: file._id,
      }),
      /PRIVACY_FILE_HELD/,
    );
    await f.db
      .collection("file_resources")
      .updateOne({ _id: file._id }, { $set: { retention_until: new Date(0) } });
    await fs.unlink(filenames[2]);
    await fs.mkdir(filenames[2]);
    await assert.rejects(
      privacy.reprocessErasedCoursework(f.client, f.db, {
        ...input,
        releaseFileId: file._id,
      }),
      /PRIVACY_FILE_PATH_UNSAFE/,
    );
    assert.deepEqual(
      (await f.db.collection("privacy_deletion_requests").findOne({ _id: id }))
        .remaining_actions,
      ["resume_coursework_disposition"],
    );
    await assert.rejects(
      control.leaveMaintenance(f.client, f.db, { ...actor, token: m2.token }),
      /PRIVACY|DISPOSITION/,
    );
    // Isolated fault fixture advances the two persisted leases; no production clock is replaced.
    await fs.rmdir(filenames[2]);
    await fs.writeFile(filenames[2], bytes, { mode: 0o600 });
    await f.db
      .collection("privacy_deletion_requests")
      .updateOne({ _id: id }, { $set: { lease_until: new Date(0) } });
    await f.db
      .collection("file_resources")
      .updateOne(
        { _id: file._id },
        { $set: { deletion_lease_until: new Date(0) } },
      );
    const tokenFile = path.join(
      await courseworkPrivateChild(env, "tokens"),
      "maintenance.token",
    );
    await fs.writeFile(tokenFile, m2.token, { mode: 0o600 });
    const cli = await require("node:util").promisify(
      require("node:child_process").execFile,
    )(
      process.execPath,
      [
        "dist/operations/cli.js",
        "coursework-reprocess",
        "--actor",
        actor.actor,
        "--reason",
        actor.reason,
        "--request-id",
        id,
        "--basis",
        input.basis,
        "--token-file",
        tokenFile,
      ],
      {
        cwd: path.resolve(__dirname, ".."),
        env: { ...process.env, MONGODB_URI: f.uri },
        windowsHide: true,
        timeout: 60000,
      },
    );
    assert.equal(JSON.parse(cli.stdout).reprocessed, true);
    assert.equal(cli.stdout.includes(m2.token), false);
    assert.equal(
      (
        await privacy.reprocessErasedCoursework(f.client, f.db, {
          ...input,
          releaseFileId: file._id,
        })
      ).replayed,
      true,
    );
    assert.equal(
      await f.db.collection("coursework_heads").findOne({ _id: head._id }),
      null,
    );
    for (const name of filenames)
      await assert.rejects(fs.access(name), { code: "ENOENT" });
    assert.equal(
      (await f.db.collection("users").findOne({ _id: user })).status,
      "disabled",
    );
    const restoreRoot = await courseworkPrivateChild(env, "restored"),
      name = "kl_restore_disposition_" + randomUUID().replaceAll("-", ""),
      restoreClient = new (require("mongodb").MongoClient)(
        f.uri.replace(/\/kl_test_[^?]+/, "/" + name),
      );
    await restoreClient.connect();
    const restoreDb = require("../dist/database/object-id").objectIdDatabase(
      restoreClient.db(),
    );
    t.after(async () => {
      assert.equal(restoreDb.databaseName, name);
      await restoreDb.dropDatabase();
      await restoreClient.close();
    });
    process.env.FILE_STORAGE_ROOT = restoreRoot;
    try {
      const restored = await backup.restore({
        client: restoreClient,
        db: restoreDb,
        file: packageFile,
        key,
        root: restoreRoot,
      });
      const verified = await backup.verifyRestore({
        db: restoreDb,
        file: packageFile,
        key,
        root: restoreRoot,
        restoreId: restored.restore_id,
        apply: true,
      });
      assert.equal(verified.status, "ready");
      assert.equal(
        (await restoreDb.collection("users").findOne({ _id: user }))
          .privacy_state,
        "erased",
      );
      assert.equal(
        await restoreDb
          .collection("coursework_heads")
          .findOne({ _id: head._id }),
        null,
      );
      assert.equal(
        await restoreDb
          .collection("training_reports")
          .findOne({ _id: report._id }),
        null,
      );
      assert.equal(
        await restoreDb
          .collection("training_report_versions")
          .countDocuments({ report_id: report._id }),
        0,
      );
      for (const area of ["tmp", "quarantine", "ready"])
        assert.deepEqual(await fs.readdir(path.join(restoreRoot, area)), []);
    } finally {
      process.env.FILE_STORAGE_ROOT = storage;
      key.fill(0);
    }
  },
);
