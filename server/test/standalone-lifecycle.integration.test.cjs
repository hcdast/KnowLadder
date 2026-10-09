"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fixture } = require("./helpers.cjs");
const schema = require("../dist/migrations/schema");
const recovery = require("../dist/training/standalone-recovery-lifecycle");
const {
  AssignmentRecoveryPlans,
} = require("../dist/training/assignment-recovery-plan");
const {
  AssignmentRecoveryRunner,
} = require("../dist/training/assignment-recovery-runner");
const {
  StandaloneWriterAdmission,
} = require("../dist/training/standalone-writer-admission");
const { newId } = require("../dist/database/object-id");
const env = {
  KL_STANDALONE_MANAGED_API_ENABLED: "false",
  KL_STANDALONE_RECOVERY_ENABLED: "true",
  KL_TRAINING_ENABLED: "false",
  KL_MANAGED_WRITER_OWNER: "managed-11111111-1111-4111-a111-111111111111",
};
test(
  "standalone recovery: real v10/control migration, drift and restore isolation",
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t, { topology: "standalone", app: false, env });
    const raw = f.client.db();
    await schema.assertSchema(f.db);
    await f.migrate(f.uri);
    await schema.assertSchema(f.db);
    const inspection = await schema.inspectMigration(f.uri);
    assert.equal(inspection.target_version, 21);
    assert.equal(inspection.checksum, recovery.RECOVERY_CHECKSUM);
    assert.equal(
      await raw
        .collection("schema_migrations")
        .countDocuments({ version: 21, status: "completed" }),
      1,
    );
    const registry = schema.systemBackupRegistry();
    for (const name of recovery.RECOVERY_COLLECTIONS) {
      assert.ok(registry.collections.includes(name));
      assert.ok(registry.excluded.includes(name));
    }
    process.env.KL_STANDALONE_RECOVERY_ENABLED = "false";
    assert.equal(schema.systemBackupRegistry().version, 10);
    assert.ok(
      !schema
        .systemBackupRegistry()
        .collections.includes("training_assignment_recovery_plans"),
    );
    process.env.KL_STANDALONE_RECOVERY_ENABLED = "true";
    await recovery.assertRecoveryQuiescent(f.db);
    const control = new StandaloneWriterAdmission(raw);
    const ticket = await control.reserve("synthetic-owner");
    await control.begin(ticket);
    await assert.rejects(recovery.assertRecoveryQuiescent(f.db), /BLOCKED/);
    await control.complete(ticket);
    const operation =
      require("../dist/training/standalone-operation").StandaloneOperation;
    const journal = new operation(raw);
    await journal.prepare("scope", "synthetic-key", { id: "synthetic" }, [
      "effect",
    ]);
    await assert.rejects(recovery.assertRecoveryQuiescent(f.db), /PENDING/);
    const hold = await journal.claim("scope", "synthetic-key");
    await journal.acknowledge(hold, 0, "effect");
    await journal.complete(hold);
    await recovery.assertRecoveryQuiescent(f.db);
    const restored = f.client.db("kl_test_restore_" + newId());
    t.after(async () => {
      const client = new (require("mongodb").MongoClient)(f.uri);
      await client.connect();
      try {
        await client.db(restored.databaseName).dropDatabase();
      } finally {
        await client.close();
      }
    });
    await schema.initializeRestoreSchema(restored);
    for (const name of recovery.RECOVERY_COLLECTIONS)
      assert.equal(await restored.collection(name).countDocuments(), 0);
    await new StandaloneWriterAdmission(restored).initialize();
    await recovery.assertRecoveryQuiescent(restored);
    for (const name of recovery.RECOVERY_COLLECTIONS.filter(
      (x) => x !== "training_standalone_writer",
    ))
      assert.equal(await restored.collection(name).countDocuments(), 0);
    assert.equal(
      await restored
        .collection("training_standalone_writer")
        .countDocuments({ state: "idle", generation: 0 }),
      1,
    );
    await raw.command({
      collMod: "training_assignment_recovery_plans",
      validationAction: "warn",
    });
    await assert.rejects(recovery.initializeRecovery(raw), /SCHEMA/);
  },
);
test(
  "standalone recovery: complete business schemas and privacy classification",
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t, { topology: "standalone", app: false, env });
    const raw = f.client.db();
    const plan = {
      orgId: newId(),
      userId: newId(),
      memberId: newId(),
      courseId: newId(),
      classId: newId(),
      subjectId: newId(),
      courseRevision: 1,
      key: "synthetic-assignment-key",
      timestamp: new Date(),
    };
    const business = require("../dist/training/schema").trainingSchemas(
      schema.OBJECT_ID_SCHEMAS,
    );
    for (const name of ["class_courses", "training_idempotency"]) {
      await raw.createCollection(name, {
        validator: business[name].validator,
        validationLevel: "strict",
        validationAction: "error",
      });
      await raw.collection(name).createIndexes(business[name].indexes);
    }
    await raw.command({
      collMod: "audit_events",
      validator: business.audit_events.validator,
      validationLevel: "strict",
      validationAction: "error",
    });
    const runner = new AssignmentRecoveryRunner(f.db, raw);
    const result = await runner.runProtected(
      plan,
      process.env.KL_MANAGED_WRITER_OWNER,
      async () => {},
    );
    assert.equal(result.status, "assigned");
    assert.deepEqual(
      await runner.runProtected(
        plan,
        process.env.KL_MANAGED_WRITER_OWNER,
        async () => {},
      ),
      result,
    );
    assert.equal(
      await f.db
        .collection("class_courses")
        .countDocuments({ course_id: plan.courseId }),
      1,
    );
    const audit = await f.db
      .collection("audit_events")
      .findOne({ resource_id: plan.courseId });
    assert.match(
      audit.request_id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // Remove test-only business extension before base-only privacy registry inspection.
    await raw.collection("class_courses").drop();
    await raw.collection("training_idempotency").drop();
    await raw.command({
      collMod: "audit_events",
      validator: schema.OBJECT_ID_SCHEMAS.audit_events.validator,
    });
    await raw
      .collection("audit_events")
      .deleteMany({ resource_type: "course" });
    const request = {
      _id: newId(),
      user_id: plan.userId,
      scope: "account",
      policy_revision: require("../dist/privacy/schema")
        .PRIVACY_POLICY_REVISION,
      status: "requested",
      revision: 0,
      plan_hash: null,
      actor: null,
      reason_code: null,
      deleted_categories: [],
      retained_categories: [],
      retention_basis: null,
      remaining_actions: [],
      created_at: new Date(),
      updated_at: new Date(),
      lease_token: null,
      lease_until: null,
      ledger_sequence: null,
      completed_steps: [],
    };
    await raw
      .collection("privacy_deletion_requests")
      .insertOne(
        require("../dist/database/object-id").encodeDocument(
          "privacy_deletion_requests",
          request,
        ),
      );
    const review =
      await require("../dist/privacy/execution").inspectPrivacyRequest(
        f.db,
        request._id,
      );
    assert.equal(review.categories.training_assignment_recovery_plans, 1);
    process.env.KL_STANDALONE_MANAGED_API_ENABLED = "true";
    await assert.rejects(
      f.db
        .collection("training_assignment_recovery_plans")
        .deleteMany({ userId: plan.userId }),
      /MANAGED_WRITER_REQUIRED/,
    );
    process.env.KL_STANDALONE_MANAGED_API_ENABLED = "false";
    assert.equal(
      await f.db
        .collection("training_assignment_recovery_plans")
        .deleteMany({ userId: plan.userId })
        .then((x) => x.deletedCount),
      1,
    );
    process.env.KL_STANDALONE_RECOVERY_ENABLED = "true";
    await assert.rejects(
      new AssignmentRecoveryPlans(raw).read(plan.orgId, plan.userId, plan.key),
      /NOT_FOUND/,
    );
  },
);
test(
  "standalone control migration: stopped writers, failed initialization/resume and registration race",
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t, {
      topology: "standalone",
      app: false,
      env: { ...env, KL_STANDALONE_RECOVERY_ENABLED: "false" },
    });
    const raw = f.client.db();
    process.env.KL_STANDALONE_RECOVERY_ENABLED = "true";
    await raw.createCollection("training_assignment_recovery_plans");
    await assert.rejects(f.migrate(f.uri), /SCHEMA/);
    assert.equal(
      (await raw.collection("schema_migrations").findOne({ version: 21 }))
        .status,
      "failed",
    );
    assert.equal(
      (
        await f.db
          .collection("operational_state")
          .findOne({ _id: "environment" })
      ).mode,
      "unregistered",
    );
    await raw.collection("training_assignment_recovery_plans").drop();
    await f.migrate(f.uri);
    await schema.assertSchema(f.db);
    const control = require("../dist/operations/control");
    const writer = await control.acquireWriter(f.db, "api");
    try {
      await assert.rejects(f.migrate(f.uri), /WRITERS_RUNNING/);
    } finally {
      await writer.release();
    }
    // Pause registration after its admission fence but before its row insert. Migration drains
    // the environment; registration must fail its final state/revision check and stay stopped.
    const col = f.db.collection("operational_writers"),
      original = col.insertOne;
    let release, paused;
    const seen = new Promise((resolve) => {
      paused = resolve;
    });
    const go = new Promise((resolve) => {
      release = resolve;
    });
    col.insertOne = async (...args) => {
      paused();
      await go;
      return original(...args);
    };
    const registering = control.acquireWriter(f.db, "api");
    registering.catch(() => {});
    await seen;
    await recovery.withRecoveryMigration(raw, async () => {
      release();
      await assert.rejects(registering, /REVISION_CONFLICT/);
      assert.equal(
        await f.db
          .collection("operational_writers")
          .countDocuments({ state: "running" }),
        0,
      );
    });
    col.insertOne = original;
    assert.equal(
      (
        await f.db
          .collection("operational_state")
          .findOne({ _id: "environment" })
      ).mode,
      "unregistered",
    );
  },
);
