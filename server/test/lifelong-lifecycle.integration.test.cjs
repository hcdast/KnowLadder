"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, randomBytes } = require("node:crypto");
const { MongoClient } = require("mongodb");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { setup } = require("./lifelong-fixture.cjs");
const {
  newId,
  rawDatabase,
  objectIdDatabase,
} = require("../dist/database/object-id");
const privacy = require("../dist/privacy/execution");
const control = require("../dist/operations/control");
const ledger = require("../dist/operations/ledger");
const backup = require("../../ops/system-backup.cjs");
const archive = require("../../ops/system-backup-archive.cjs");
const schema = require("../dist/migrations/schema");
async function protect(root) {
  await fs.chmod(root, 0o700);
  if (process.platform !== "win32") return;
  const script =
    "$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule);Set-Acl -LiteralPath $env:KL_TEST_PRIVATE_ROOT -AclObject $acl";
  await promisify(execFile)(
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
    { windowsHide: true, env: { ...process.env, KL_TEST_PRIVATE_ROOT: root } },
  );
}
const operator = {
  actor: "lifelong-isolated-trial",
  reason: "原创全龄隔离数据生命周期验收，无真实身份凭证",
};
test(
  "终身学习生命周期：v25计划/复习历史加密备份、账号擦除与v22/v23/v24历史包恢复",
  { timeout: 240000 },
  async (t) => {
    const f = await setup(t),
      owner = await f.person(),
      partner = await f.person();
    // Safety-ledger policy deliberately rejects every directory inside the checkout.
    const parent = await fs.realpath(
      process.env.TEST_FILE_STORAGE_PARENT || require("node:os").homedir(),
    );
    const root = await fs.mkdtemp(path.join(parent, "lifelong-lifecycle-"));
    t.after(async () => {
      assert.equal(path.dirname(root), parent);
      assert.ok(path.basename(root).startsWith("lifelong-lifecycle-"));
      await fs.rm(root, { recursive: true, force: true });
    });
    await protect(root);
    if (process.platform === "win32")
      await require("../dist/security/private-directory").assertWindowsPrivateDirectory(
        root,
      );
    const child = async (name) => {
      const p = path.join(root, name);
      await fs.mkdir(p, { mode: 0o700 });
      await protect(p);
      return p;
    };
    const source = await child("source");
    const archives = await child("archives");
    for (const name of ["tmp", "quarantine", "ready"])
      await fs.mkdir(path.join(source, name), { mode: 0o700 });
    const envId = randomUUID(),
      controlName = `kl_control_${randomUUID().replaceAll("-", "")}`;
    const values = {
      KL_CONTROL_MONGODB_URI: f.uri.replace(
        /\/kl_test_[^?]+/,
        `/${controlName}`,
      ),
      KL_ENVIRONMENT_ID: envId,
      KL_SAFETY_LEDGER_ROOT: await child("ledger"),
      KL_SAFETY_LEDGER_MIRROR_ROOT: await child("mirror"),
      KL_SAFETY_LEDGER_KEY: randomBytes(32).toString("hex"),
      FILE_STORAGE_ROOT: source,
    };
    const previous = new Map(
      Object.keys(values).map((k) => [k, process.env[k]]),
    );
    Object.assign(process.env, values);
    const targets = [];
    t.after(async () => {
      const cleanupClient = new MongoClient(f.uri);
      try {
        await cleanupClient.connect();
        for (const name of [controlName, ...targets]) {
          assert.match(name, /^kl_(control|restore)_[a-f0-9]{32}$/);
          await cleanupClient.db(name).dropDatabase();
        }
      } finally {
        for (const [k, v] of previous) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        await cleanupClient.close();
      }
    });
    assert.ok(
      new MongoClient(values.KL_CONTROL_MONGODB_URI).options.replicaSet,
      "Ledger must use an explicit replicaSet URI",
    );
    if (process.platform === "win32") {
      const {
        assertWindowsPrivateDirectory,
      } = require("../dist/security/private-directory");
      await assertWindowsPrivateDirectory(values.KL_SAFETY_LEDGER_ROOT);
      await assertWindowsPrivateDirectory(values.KL_SAFETY_LEDGER_MIRROR_ROOT);
    }
    const goal = await f.good(owner, "/goals", f.goal()),
      activity = await f.good(
        owner,
        "/activities",
        f.activity(goal.resource_id),
      );
    const otherGoal = await f.good(partner, "/goals", f.goal("保留他人的目标")),
      otherActivity = await f.good(
        partner,
        "/activities",
        f.activity(otherGoal.resource_id),
      );
    // Course progress uses the same v23 ownership/backup graph, including permanent unit receipts.
    const course = require("../dist/lifelong/courses").LEARNING_COURSES[0],
      unit = course.units[0];
    const enrolled = {};
    for (const [label, person] of [
      ["owner", owner],
      ["partner", partner],
    ]) {
      enrolled[label] = await f.good(person, `/courses/${course.id}/enroll`, {
        version: course.version,
      });
      await f.good(person, `/courses/${course.id}/units/${unit.id}/complete`, {
        version: course.version,
        goal_id: enrolled[label].resource_id,
        revision: 1,
        answer: unit.answer,
        practice: "隔离原创故事复述练习",
        reflection: "区分原文与想象",
      });
    }
    for (const person of [owner, partner]) {
      const note = await f.good(person, "/study-items", {
        title: "保留个人理解",
        note: "私人复习笔记",
        bookmarked: true,
        course_id: course.id,
        course_version: course.version,
        unit_id: unit.id,
        due_on: "2026-10-15",
      });
      await f.good(person, `/study-items/${note.resource_id}/review`, {
        revision: 1, answer: unit.answer, reviewed_on: "2026-10-15", next_due_on: "2026-10-18", note: "真实新增回顾记录",
      });
      await f.good(person, "/agenda", {
        title: "跨课程安排", note: "仅本人计划", scheduled_on: "2026-10-15", planned_minutes: 20, kind: "course",
        source_kind: "course", source_id: course.id, source_version: course.version, unit_id: unit.id,
      });
      await f.good(person, "/week-reviews", {
        week_start: "2026-10-12", revision: 0, highlights: "本周完成第一步", challenges: "还有问题", adjustment: "安排下周复习",
      });
    }
    const input = (activityId) => ({
      label: "隔离学习支持",
      scopes: ["activities", "feedback"],
      goal_ids: [],
      activity_ids: [activityId],
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      assurance_id: null,
    });
    const support = await f.good(
      owner,
      "/supports",
      input(activity.resource_id),
    );
    await f.good(partner, "/support-invitation/accept", {
      code: support.invitation_code,
    });
    await f.good(partner, `/supports/${support.resource_id}/feedback`, {
      activity_id: activity.resource_id,
      note: "隔离伙伴的反馈",
    });
    const reverse = await f.good(
      partner,
      "/supports",
      input(otherActivity.resource_id),
    );
    await f.good(owner, "/support-invitation/accept", {
      code: reverse.invitation_code,
    });
    await f.good(owner, `/supports/${reverse.resource_id}/feedback`, {
      activity_id: otherActivity.resource_id,
      note: "将被删除的反馈作者",
    });
    // A realistic strict document also exercises erasure of a guardian/provenance subject.
    const now = new Date(),
      assuranceId = newId();
    await f.db.collection("lifelong_assurances").insertOne({
      _id: assuranceId,
      user_id: partner.id,
      guardian_user_id: owner.id,
      org_id: newId(),
      proposer_user_id: partner.id,
      reviewer_user_id: null,
      evidence_reference: "isolated-not-real-proof",
      policy_version: "isolated-v1",
      transition_at: new Date(Date.now() + 86400000),
      expires_at: new Date(Date.now() + 3600000),
      state: "pending",
      revision: 1,
      created_at: now,
      updated_at: now,
    });
    for (const app of f.apps.splice(0)) await app.close();
    await control.registerEnvironment(f.client, f.db, {
      environmentId: envId,
      fileRoot: source,
      ...operator,
    });
    let state = await control.getOperationalState(f.db);
    const gate = await control.enterMaintenance(f.client, f.db, {
      expectedRevision: state.revision,
      ...operator,
    });
    const file = path.join(archives, "v25.klb"),
      key = randomBytes(32);
    await backup.backup({
      client: f.client,
      db: f.db,
      file,
      key,
      root: source,
      maintenanceToken: gate.token,
    });
    const handle = await archive.openFile(file);
    let verified;
    try {
      verified = await backup.authenticate(handle, key);
    } finally {
      await handle.close();
    }
    assert.equal(verified.manifest.registry.version, 25);
    assert.equal(verified.manifest.counts.lifelong_study_items, 2);
    for (const name of ["lifelong_agenda", "lifelong_week_reviews", "lifelong_review_events"])
      assert.equal(verified.manifest.counts[name], 2, name);
    assert.equal(verified.manifest.counts.lifelong_feedback, 2);
    assert.equal(verified.manifest.counts.lifelong_goals, 4);
    assert.equal(verified.manifest.counts.lifelong_activities, 4);
    await control.leaveMaintenance(f.client, f.db, {
      token: gate.token,
      ...operator,
    });
    const requestId = newId();
    await f.db.collection("privacy_deletion_requests").insertOne({
      _id: requestId,
      user_id: owner.id,
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
    const plan = await privacy.inspectPrivacyRequest(f.db, requestId);
    for (const name of [
      "lifelong_study_items",
      "lifelong_agenda", "lifelong_week_reviews", "lifelong_review_events",
      "lifelong_goals",
      "lifelong_activities",
      "lifelong_receipts",
      "lifelong_supports",
      "lifelong_feedback",
      "lifelong_assurances",
    ])
      assert.ok(plan.categories[name] > 0, name);
    await privacy.approvePrivacyRequest(f.client, f.db, {
      requestId,
      expectedRevision: plan.revision,
      planHash: plan.plan_hash,
      retentionBasis: "local_minimal_provenance",
      ...operator,
    });
    await privacy.executePrivacyRequest(f.client, f.db, {
      requestId,
      ...operator,
    });
    async function erased(db) {
      for (const name of ["lifelong_agenda", "lifelong_week_reviews", "lifelong_review_events"])
        assert.equal(await db.collection(name).countDocuments({ user_id: partner.id }), 1, name);
      assert.equal(
        await db
          .collection("lifelong_study_items")
          .countDocuments({ user_id: partner.id }),
        1,
      );
      for (const name of [
        "lifelong_study_items",
        "lifelong_agenda", "lifelong_week_reviews", "lifelong_review_events",
        "lifelong_goals",
        "lifelong_activities",
        "lifelong_receipts",
      ])
        assert.equal(
          await db.collection(name).countDocuments({ user_id: owner.id }),
          0,
          name,
        );
      assert.equal(
        await db.collection("lifelong_supports").countDocuments({
          $or: [{ user_id: owner.id }, { supporter_user_id: owner.id }],
        }),
        0,
      );
      assert.equal(
        await db.collection("lifelong_feedback").countDocuments({
          $or: [{ user_id: owner.id }, { actor_user_id: owner.id }],
        }),
        0,
      );
      assert.equal(
        await db
          .collection("lifelong_assurances")
          .countDocuments({ guardian_user_id: owner.id }),
        0,
      );
      assert.equal(
        await db
          .collection("lifelong_goals")
          .countDocuments({ user_id: partner.id }),
        2,
      );
      assert.equal(
        await db.collection("lifelong_receipts").countDocuments({
          user_id: partner.id,
          resource_id: enrolled.partner.resource_id,
          operation: require("../dist/lifelong/courses").unitOperation(
            course,
            unit,
          ),
        }),
        1,
      );
    }
    await erased(f.db);
    const name = `kl_restore_${randomUUID().replaceAll("-", "")}`;
    targets.push(name);
    const target = objectIdDatabase(f.client.db(name)),
      targetRoot = await child("target-v23");
    const restored = await backup.restore({
      client: f.client,
      db: target,
      file,
      key,
      root: targetRoot,
    });
    assert.equal(restored.status, "quarantined");
    await erased(target);
    assert.equal(
      (await target.collection("users").findOne({ _id: owner.id }))
        .privacy_state,
      "erased",
    );
    // Manufacture an exact encrypted historical v22 package from a separate empty fixture,
    // keeping the real source records in the v23 archive above. No near-match registry accepted.
    for (const historicalVersion of [22, 23, 24]) {
      const emptyName = `kl_restore_${randomUUID().replaceAll("-", "")}`;
      targets.push(emptyName);
      const emptyDb = objectIdDatabase(f.client.db(emptyName));
      const oldRegistry = schema
        .supportedSystemBackupRegistries()
        .find((r) => r.version === historicalVersion);
      assert.ok(oldRegistry);
      assert.equal(oldRegistry.collections.includes("lifelong_study_items"), historicalVersion >= 24);
      assert.ok(!oldRegistry.collections.includes("lifelong_agenda"));
      const { BSON } = require("mongodb"),
        frames = [];
      for (const collection of oldRegistry.collections.filter(
        (n) => !oldRegistry.excluded.includes(n),
      ))
        for await (const row of rawDatabase(f.db)
          .collection(collection)
          .find({}, { promoteValues: false, promoteLongs: false })) {
          if (
            collection === "schema_migrations" &&
            Number(row.version) > historicalVersion
          )
            continue;
          frames.push({ name: collection, bytes: BSON.serialize(row) });
        }
      const counts = Object.fromEntries(
        oldRegistry.collections
          .filter((n) => !oldRegistry.excluded.includes(n))
          .map((n) => [n, 0]),
      );
      for (const frame of frames) counts[frame.name]++;
      const oldFile = path.join(archives, `v${historicalVersion}.klb`),
        writer = await archive.createArchive(oldFile, key);
      const oldManifest = {
        ...verified.manifest,
        backup_id: randomUUID(),
        registry: oldRegistry,
        created_at: new Date().toISOString(),
        ledger_sequence: (await ledger.readSafetyLedger(envId, 0)).sequence,
        counts,
        db_bytes: frames.reduce((n, f) => n + f.bytes.length, 0),
        files: [],
        missing: [],
      };
      try {
        await writer.frame({ kind: "header", manifest: oldManifest });
        const indexes = {};
        for (const frame of frames)
          (await writer.frame({
            kind: "db",
            collection: frame.name,
            index: (indexes[frame.name] ??= 0),
            part: 0,
            last: true,
            data: frame.bytes.toString("base64"),
          }),
            indexes[frame.name]++);
        await writer.publish(oldManifest);
      } catch (cause) {
        await writer.abort();
        throw cause;
      }
      await backup.restore({
        client: f.client,
        db: emptyDb,
        file: oldFile,
        key,
        root: await child(`target-historical-v${historicalVersion}`),
      });
      assert.equal(
        (await emptyDb.collection("schema_migrations").findOne({ version: 23 }))
          .checksum,
        schema.LIFELONG_CHECKSUM,
      );
      assert.equal(
        await emptyDb.collection("lifelong_study_items").countDocuments(),
        historicalVersion >= 24 ? 1 : 0,
      );
      await schema.assertSchema(emptyDb);
      assert.equal(
        (await emptyDb.collection("schema_migrations").findOne({ version: 24 }))
          .checksum,
        schema.STUDY_CHECKSUM,
      );
      await schema.assertSchema(emptyDb);
      for (const name of ["lifelong_agenda", "lifelong_week_reviews", "lifelong_review_events"])
        assert.equal(await emptyDb.collection(name).countDocuments(), 0, name);
      assert.equal((await emptyDb.collection("schema_migrations").findOne({ version: 25 })).checksum, schema.PLANNING_CHECKSUM);
    }
    key.fill(0);
  },
);
