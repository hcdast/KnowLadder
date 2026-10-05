"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, randomBytes, createHash } = require("node:crypto");
const { mkdtemp, mkdir, rm, realpath } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { MongoClient } = require("mongodb");
const { fixture, guardedUri } = require("./helpers.cjs");
const {
  assessmentFixture,
  good,
  practice,
} = require("./assessment-helpers.cjs");
const {
  newId,
  rawDatabase,
  objectIdDatabase,
} = require("../dist/database/object-id");
const privacy = require("../dist/privacy/execution.js");
const { PRIVACY_POLICY_REVISION } = require("../dist/privacy/schema.js");
const {
  registerEnvironment,
  quarantineRestore,
  enterMaintenance,
  leaveMaintenance,
} = require("../dist/operations/control.js");
const {
  readSafetyLedger,
  reserveSafetyIntent,
  reconcileSafetyIntent,
  safetyOperationId,
} = require("../dist/operations/ledger.js");
const { V3_DEFAULTS } = require("../dist/migrations/content-v3.js");
const {
  executeAdministrationOperation,
} = require("../dist/administration/operations.js");
const exec = promisify(execFile);
const operator = {
  actor: "privacy-integration",
  reason: "本地隐私生命周期真实副本集验收",
};
async function grantAccountManagement(f, memberId, orgId) {
  const member = await f.db
    .collection("organization_members")
    .findOne({ _id: memberId, org_id: orgId, status: "active" });
  assert.ok(member);
  const scope = { kind: "organization_ids", organization_ids: [orgId] },
    grantId = newId();
  const receipt = await executeAdministrationOperation({
    client: f.client,
    db: f.db,
    actor: f.context.actor,
    reason: "Explicit local account management authorization",
    action: "capability.grant.account:manage",
    key: randomUUID(),
    targets: {
      user_ids: [member.user_id],
      member_ids: [memberId],
      org_ids: [orgId],
    },
    before: {},
    payload: {
      grant_id: grantId,
      member_id: memberId,
      capability: "account:manage",
      scope,
    },
    audit: { org_id: orgId, resource_id: grantId },
    apply: async ({ session, operation_id, now }) => {
      const role = await f.db
        .collection("member_roles")
        .findOne(
          { member_id: memberId, org_id: orgId, role_id: "org_admin" },
          { session },
        );
      assert.ok(role, "Account management requires a real org_admin role");
      await f.db.collection("administrative_grants").insertOne(
        {
          _id: grantId,
          subject_member_id: memberId,
          actor_org_id: orgId,
          capability: "account:manage",
          scope,
          scope_key: createHash("sha256")
            .update(JSON.stringify(scope))
            .digest("hex"),
          delegate_capabilities: [],
          status: "active",
          revision: 1,
          valid_from: now,
          valid_to: null,
          operation_id,
          authority: "cli",
          approval_id: null,
          created_at: now,
          updated_at: now,
        },
        { session },
      );
      await f.db
        .collection("organization_members")
        .updateOne(
          { _id: memberId, status: "active" },
          { $inc: { authorization_revision: 1 }, $set: { updated_at: now } },
          { session },
        );
      await f.db
        .collection("users")
        .updateOne(
          { _id: member.user_id, status: "active", privacy_state: "active" },
          { $inc: { identity_revision: 1 }, $set: { updated_at: now } },
          { session },
        );
      return { grant_id: grantId };
    },
  });
  return { grantId, operationId: receipt.operation_id };
}

// Isolated real control MongoDB and encrypted mirrored ledger, never a success mock.
// Like the other integration fixtures, run with --test-concurrency=1 (process.env).
async function setupLedger(t) {
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
async function setup(t, assessment = false) {
  const env = {
    ...(await setupLedger(t)),
    KL_TRAINING_ENABLED: "true",
    KL_TRAINING_PHASE2_ENABLED: "true",
  };
  const f = assessment
    ? await assessmentFixture(t, { env })
    : await fixture(t, { app: false, env });
  f.environmentId = env.KL_ENVIRONMENT_ID;
  f.register = async (fileRoot = null) => {
    // Registration requires all real API writer leases to have been released.
    for (const app of f.apps.splice(0)) await app.close();
    await registerEnvironment(f.client, f.db, {
      environmentId: f.environmentId,
      fileRoot,
      ...operator,
    });
    assert.equal(
      (
        await f.db
          .collection("operational_state")
          .findOne({ _id: "environment" })
      ).mode,
      "active",
    );
  };
  return f;
}
async function deletionRequest(f, userId) {
  const now = new Date();
  const row = {
    _id: newId(),
    user_id: userId,
    scope: "account",
    policy_revision: PRIVACY_POLICY_REVISION,
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
  };
  await f.db.collection("privacy_deletion_requests").insertOne(row);
  return row;
}
async function approve(f, row) {
  const plan = await privacy.inspectPrivacyRequest(f.db, row._id);
  await privacy.approvePrivacyRequest(f.client, f.db, {
    requestId: row._id,
    expectedRevision: plan.revision,
    planHash: plan.plan_hash,
    retentionBasis: plan.assessment_held
      ? "local_hold_and_provenance"
      : "local_minimal_provenance",
    ...operator,
  });
  return plan;
}
const execute = (f, row) =>
  privacy.executePrivacyRequest(f.client, f.db, {
    requestId: row._id,
    ...operator,
  });
async function capture(db, names) {
  const result = {};
  const collections = (await db.listCollections().toArray())
    .filter((row) => !names || names.includes(row.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const { name, options } of collections)
    result[name] = {
      options,
      indexes: await rawDatabase(db).collection(name).listIndexes().toArray(),
      rows: await rawDatabase(db)
        .collection(name)
        .find()
        .sort({ _id: 1 })
        .toArray(),
    };
  return result;
}
async function learningRow(f, actor = f.student) {
  const row = {
    _id: newId(),
    org_id: actor.org,
    member_id: actor.memberId,
    chapter_id: f.chapterId,
    edition_id: f.book.id,
    edition_revision: f.book.revision,
    position: { kind: "text_offset", offset_utf16: 0 },
    completed: false,
    revision: 1,
    updated_at: new Date(),
    cleared_at: null,
  };
  await f.db.collection("reading_progress").insertOne(row);
  return row;
}
async function assessed(f) {
  const session = await practice(f);
  const submitted = await good(
    f.student,
    `/sessions/${session.id}/submissions`,
    {
      method: "POST",
      body: { expected_revision: session.revision, answers: [] },
    },
    202,
  );
  const { processOne } = require("../dist/assessment/worker.js");
  for (let attempt = 0; attempt < 10; attempt++) {
    const row = await f.db
      .collection("submissions")
      .findOne({ _id: submitted.submission_id });
    if (row.grading_status === "completed") return session;
    assert.ok(["pending", "running"].includes(row.grading_status));
    await processOne(f.db);
  }
  assert.fail("真实评分 worker 未完成，不得伪造成功");
}
async function assertFrozen(f, userId, state) {
  const user = await f.db.collection("users").findOne({ _id: userId });
  assert.equal(user.privacy_state, state);
  assert.equal(user.status, "disabled");
  const members = await f.db
    .collection("organization_members")
    .find({ user_id: userId })
    .toArray();
  assert.ok(members.length > 0);
  assert.ok(members.every((row) => row.status === "disabled"));
  assert.equal(
    await f.db.collection("auth_sessions").countDocuments({ user_id: userId }),
    0,
  );
  const tombstone = await f.db
    .collection("privacy_tombstones")
    .findOne({ user_id: userId });
  assert.ok(tombstone);
  assert.equal(tombstone.state, state === "erased" ? "erased" : "blocking");
}
async function assertSingleIntent(f, row) {
  const ledger = await readSafetyLedger(f.environmentId, 0);
  const intents = ledger.entries.filter(
    (entry) => entry.privacyRequestId === row._id,
  );
  assert.equal(intents.length, 1);
  assert.equal(intents[0].action, "subject.erase");
  assert.equal(intents[0].subjectId, row.user_id);
  assert.equal(intents[0].state, "committed");
  assert.equal(ledger.pending, false);
  return ledger;
}
const graphNames = [
  "sessions",
  "session_items",
  "submissions",
  "answers",
  "grading_runs",
  "grading_results",
  "outbox_events",
  "consumer_receipts",
  "assessment_resource_references",
  "attempt_counters",
  "quiz_audiences",
];

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
test(
  "二期隐私：冻结班级派生图擦除及旧快照最新账本抑制",
  { timeout: 240000 },
  async (t) => {
    const f = await setup(t),
      user = await f.user(),
      other = await f.user(),
      org = (
        await f.ops.createOrganization(f.context, {
          name: "二期隐私隔离",
          kind: "school",
        })
      ).organization_id;
    for (const u of [user, other])
      await f.ops.setMembership(f.context, {
        user_id: u.user_id,
        org_id: org,
        roles: ["student"],
      });
    const member = await f.db
        .collection("organization_members")
        .findOne({ user_id: user.user_id, org_id: org }),
      survivor = await f.db
        .collection("organization_members")
        .findOne({ user_id: other.user_id, org_id: org }),
      classId = newId(),
      subject = newId(),
      now = new Date();
    await f.db.collection("classes").insertOne({
      _id: classId,
      org_id: org,
      name: "隐私班",
      year_label: "2026",
      status: "active",
      revision: 1,
      created_by: other.user_id,
      created_at: now,
      updated_at: now,
    });
    await f.db.collection("class_members").insertOne({
      _id: newId(),
      org_id: org,
      class_id: classId,
      member_id: member._id,
      kind: "student",
      status: "active",
      valid_from: null,
      valid_to: null,
      created_at: now,
      updated_at: now,
    });
    const base = () => ({
        _id: newId(),
        org_id: org,
        revision: 1,
        created_at: now,
        updated_at: now,
      }),
      scope = { class_id: classId, subject_id: subject },
      authored = {
        author_id: other.user_id,
        contributors: [other.user_id],
        reviewer_id: null,
      };
    const lesson = {
      ...base(),
      ...scope,
      ...authored,
      title: "隐私课次",
      course_id: newId(),
      teacher_member_id: survivor._id,
      location_id: newId(),
      start_at: new Date(0),
      end_at: new Date(3600000),
      original_session_id: null,
      recipients: [member._id],
      status: "ended",
      note: "派生个人信息",
    };
    const path = {
      ...base(),
      ...scope,
      ...authored,
      title: "冻结路径",
      course_ids: [lesson.course_id],
      task_ids: [],
      attendance_bp: 8000,
      grade_min: 60,
      status: "published",
      note: "派生个人信息",
    };
    const assignment = {
      ...base(),
      ...scope,
      path_id: path._id,
      user_id: other.user_id,
      member_id: survivor._id,
      rules_json: JSON.stringify({
        contributors: [other.user_id],
        title: path.title,
      }),
    };
    const certificate = {
      ...base(),
      ...scope,
      path_id: path._id,
      assignment_id: assignment._id,
      user_id: other.user_id,
      member_id: survivor._id,
      issuer_id: other.user_id,
      number: "PRIVACY-" + newId(),
      token_hash: "a".repeat(64),
      evidence_json: "{}",
      evidence_hash: "b".repeat(64),
      status: "issued",
      note: "派生个人信息",
    };
    const attendance = {
      ...base(),
      ...scope,
      ...authored,
      session_id: lesson._id,
      status: "confirmed",
      entries: [{ member_id: member._id, status: "present" }],
      note: "派生个人信息",
    };
    const events = [
      ["training_sessions", lesson],
      ["training_paths", path],
      ["training_path_assignments", assignment],
      ["training_certificates", certificate],
      ["training_attendance", attendance],
      [
        "training_certificate_events",
        {
          ...base(),
          ...scope,
          certificate_id: certificate._id,
          user_id: other.user_id,
          actor_id: other.user_id,
          action: "issued",
          note: "派生个人信息",
        },
      ],
      [
        "training_leave_requests",
        {
          ...base(),
          ...scope,
          session_id: lesson._id,
          user_id: other.user_id,
          member_id: survivor._id,
          status: "approved",
          reason: "派生个人信息",
          note: "",
        },
      ],
    ];
    for (const [name, row] of events)
      await f.db.collection(name).insertOne(row);
    for (const [name, idField, head] of [
      ["training_session_versions", "session_id", lesson],
      ["training_path_versions", "path_id", path],
      ["training_attendance_versions", "attendance_id", attendance],
    ])
      await f.db.collection(name).insertOne({
        ...base(),
        ...scope,
        [idField]: head._id,
        ...(name === "training_attendance_versions"
          ? { session_id: lesson._id }
          : {}),
        payload_json: JSON.stringify(head),
        author_id: other.user_id,
      });
    const outbox = {
      ...base(),
      user_id: other.user_id,
      member_id: survivor._id,
      source_type: "certificate",
      source_id: certificate._id,
      message: "结业证书已签发",
      status: "delivered",
      lease_token: null,
      lease_until: null,
    };
    await f.db.collection("training_notification_outbox").insertOne(outbox);
    await f.db.collection("training_notifications").insertOne({
      ...base(),
      user_id: other.user_id,
      member_id: survivor._id,
      event_id: outbox._id,
      source_type: "certificate",
      source_id: certificate._id,
      message: outbox.message,
      read_at: null,
    });
    await f.db
      .collection("training_idempotency")
      .insertOne({
        ...base(),
        user_id: other.user_id,
        operation: "phase2.path-create",
        resource_id: classId,
        key: randomUUID(),
        request_hash: "c".repeat(64),
        result_json: JSON.stringify(path),
      });
    const env = { KL_SAFETY_LEDGER_ROOT: process.env.KL_SAFETY_LEDGER_ROOT },
      sourceRoot = await courseworkPrivateChild(env, "source-files"),
      sourceFs = require("node:fs/promises"),
      sourcePath = require("node:path");
    for (const area of ["tmp", "quarantine", "ready"])
      await sourceFs.mkdir(sourcePath.join(sourceRoot, area), { mode: 0o700 });
    await f.register(sourceRoot);
    const backup = require("../../ops/system-backup.cjs"),
      packageFile = sourcePath.join(
        await courseworkPrivateChild(env, "packages"),
        "phase2-old.klb",
      ),
      encryptionKey = randomBytes(32),
      maintenance = await enterMaintenance(f.client, f.db, {
        ...operator,
        expectedRevision: (
          await f.db
            .collection("operational_state")
            .findOne({ _id: "environment" })
        ).revision,
      });
    await backup.backup({
      client: f.client,
      db: f.db,
      file: packageFile,
      key: encryptionKey,
      root: sourceRoot,
      maintenanceToken: maintenance.token,
    });
    await leaveMaintenance(f.client, f.db, {
      ...operator,
      token: maintenance.token,
    });
    const archive = await capture(f.db),
      row = await deletionRequest(f, user.user_id);
    await approve(f, row);
    await execute(f, row);
    const ledger = await assertSingleIntent(f, row),
      proof = ledger.entries.find((e) => e.privacyRequestId === row._id);
    const graph = [
      "training_sessions",
      "training_session_versions",
      "training_attendance",
      "training_attendance_versions",
      "training_leave_requests",
      "training_paths",
      "training_path_versions",
      "training_path_assignments",
      "training_certificates",
      "training_certificate_events",
      "training_notification_outbox",
      "training_notifications",
      "training_idempotency",
    ];
    for (const name of graph)
      assert.equal(await f.db.collection(name).countDocuments({}), 0, name);
    const targetName = "kl_restore_phase2_" + randomUUID().replaceAll("-", ""),
      restoreClient = new MongoClient(f.uri),
      target = objectIdDatabase(restoreClient.db(targetName));
    await restoreClient.connect();
    t.after(async () => {
      assert.match(targetName, /^kl_restore_phase2_[a-f0-9]{32}$/);
      await target.dropDatabase();
      await restoreClient.close();
    });
    await require("../dist/migrations/schema").initializeRestoreSchema(target);
    await quarantineRestore(target, {
      environmentId: f.environmentId,
      restoreId: newId(),
    });
    for (const [name, saved] of Object.entries(archive)) {
      if (
        [
          "operational_state",
          "operational_writers",
          "backup_restore_runs",
          "administration_guard",
          "administration_operations",
          "administrative_grants",
          "authorization_requests",
          "member_roles",
          "member_capability_grants",
        ].includes(name)
      )
        continue;
      if (saved.rows.length)
        await rawDatabase(target).collection(name).insertMany(saved.rows);
    }
    await privacy.suppressRestoredSubject(
      target,
      user.user_id,
      row._id,
      proof.sequence,
    );
    for (const name of graph)
      assert.equal(
        await target.collection(name).countDocuments({}),
        0,
        "旧快照 " + name,
      );
    assert.equal(
      (await target.collection("users").findOne({ _id: other.user_id })).status,
      "active",
    );
    assert.equal(
      (
        await target
          .collection("operational_state")
          .findOne({ _id: "environment" })
      ).mode,
      "restore_quarantined",
    );
    const encryptedName =
        "kl_restore_phase2_package_" + randomUUID().replaceAll("-", ""),
      encryptedClient = new MongoClient(f.uri),
      encryptedTarget = objectIdDatabase(encryptedClient.db(encryptedName)),
      restoreRoot = await courseworkPrivateChild(env, "restored-files");
    await encryptedClient.connect();
    t.after(async () => {
      assert.match(encryptedName, /^kl_restore_phase2_package_[a-f0-9]{32}$/);
      await encryptedTarget.dropDatabase();
      await encryptedClient.close();
    });
    const restored = await backup.restore({
      client: encryptedClient,
      db: encryptedTarget,
      file: packageFile,
      key: encryptionKey,
      root: restoreRoot,
    });
    const verified = await backup.verifyRestore({
      db: encryptedTarget,
      file: packageFile,
      key: encryptionKey,
      root: restoreRoot,
      restoreId: restored.restore_id,
      apply: true,
    });
    assert.equal(verified.status, "ready");
    for (const name of graph)
      assert.equal(
        await encryptedTarget.collection(name).countDocuments({}),
        0,
        "加密旧包 " + name,
      );
    assert.equal(
      (await encryptedTarget.collection("users").findOne({ _id: user.user_id }))
        .privacy_state,
      "erased",
    );
    encryptionKey.fill(0);
  },
);
