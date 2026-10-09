import { createHash, randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { objectIdDatabase, rawDatabase } from "../database/object-id";
import {
  standaloneJournalSpec,
  initializeStandaloneJournal,
} from "./standalone-schema";
import {
  AssignmentRecoveryPlans,
  assignmentPlanValidator,
} from "./assignment-recovery-plan";
import {
  initializeAssignmentKnowledgeSignals,
  assignmentSignalValidator,
} from "./assignment-knowledge-signal";
import {
  StandaloneWriterAdmission,
  writerAdmissionValidator,
} from "./standalone-writer-admission";
const schema = (validator: object, key: Record<string, number>) => ({
  validator,
  indexes: [
    {
      key,
      unique: true,
      name: Object.entries(key)
        .map(([k, v]) => k + "_" + v)
        .join("_"),
    },
  ],
});
export const STANDALONE_RECOVERY_SCHEMAS = {
  training_standalone_leases: schema(
    standaloneJournalSpec("leases").validator,
    { resource: 1 },
  ),
  training_standalone_operations: schema(
    standaloneJournalSpec("operations").validator,
    { scope: 1, key: 1 },
  ),
  training_assignment_recovery_plans: schema(assignmentPlanValidator(), {
    orgId: 1,
    userId: 1,
    key: 1,
  }),
  training_standalone_knowledge_signals: schema(assignmentSignalValidator(), {
    identity: 1,
  }),
  training_standalone_writer: schema(writerAdmissionValidator(), { key: 1 }),
};
export const RECOVERY_COLLECTIONS = Object.keys(STANDALONE_RECOVERY_SCHEMAS);
export const RECOVERY_CHECKSUM = createHash("sha256")
  .update(
    JSON.stringify({
      version: 21,
      schemas: STANDALONE_RECOVERY_SCHEMAS,
      restore: "omit-only-when-quiescent-v1",
    }),
  )
  .digest("hex");
export function recoveryEnabled() {
  return process.env.KL_STANDALONE_RECOVERY_ENABLED === "true";
}
export async function initializeRecovery(db: Db) {
  db = rawDatabase(db);
  await initializeStandaloneJournal(db, "leases");
  await initializeStandaloneJournal(db, "operations");
  await new AssignmentRecoveryPlans(db).initialize();
  await initializeAssignmentKnowledgeSignals(db);
  await new StandaloneWriterAdmission(db).initialize();
}
export async function assertRecoveryQuiescent(db: Db) {
  db = rawDatabase(db);
  if (
    await db
      .collection("training_standalone_operations")
      .findOne({ state: { $ne: "completed" } })
  )
    throw Error("RECOVERY_OPERATIONS_PENDING");
  if (
    await db
      .collection("training_standalone_leases")
      .findOne({ $expr: { $gt: ["$until", "$$NOW"] } })
  )
    throw Error("RECOVERY_LEASE_ACTIVE");
  await new StandaloneWriterAdmission(db).assertReadable();
}
/** Control-only extension. Does NOT grant standalone admission to existing training APIs. */
export async function migrateRecovery(db: Db) {
  db = rawDatabase(db);
  if (process.env.NODE_ENV === "production")
    throw Error("RECOVERY_PRODUCTION_NOT_APPROVED");
  if (await db.collection("operational_writers").findOne({ state: "running" }))
    throw Error("RECOVERY_WRITERS_RUNNING");
  const { OBJECT_ID_CHECKSUM } = await import("../migrations/schema");
  const prior = await db
    .collection("schema_migrations")
    .findOne({
      version: 10,
      status: "completed",
      checksum: OBJECT_ID_CHECKSUM,
    });
  if (!prior) throw Error("RECOVERY_V10_REQUIRED");
  const token = randomUUID();
  const markers = db.collection("schema_migrations");
  const old = await markers.findOne({ version: 21 });
  if (old && old.checksum !== RECOVERY_CHECKSUM)
    throw Error("RECOVERY_CHECKSUM_MISMATCH");
  if (!old)
    await markers.insertOne({
      version: 21,
      checksum: RECOVERY_CHECKSUM,
      status: "pending",
      created_at: new Date(),
      started_at: null,
      completed_at: null,
      failed_at: null,
      lease_token: null,
      lease_until: null,
    });
  const held = await markers.findOneAndUpdate(
    {
      version: 21,
      checksum: RECOVERY_CHECKSUM,
      $or: [
        { status: { $in: ["pending", "failed"] } },
        { status: "running", $expr: { $lte: ["$lease_until", "$$NOW"] } },
      ],
    },
    [
      {
        $set: {
          status: "running",
          started_at: "$$NOW",
          lease_token: token,
          lease_until: { $add: ["$$NOW", 120000] },
          failed_at: null,
        },
      },
    ],
    { returnDocument: "after" },
  );
  if (!held) {
    if (old?.status === "completed") {
      await initializeRecovery(db);
      return;
    }
    throw Error("RECOVERY_MIGRATION_BUSY");
  }
  try {
    await initializeRecovery(db);
    const result = await markers.updateOne(
      {
        version: 21,
        lease_token: token,
        status: "running",
        $expr: { $gt: ["$lease_until", "$$NOW"] },
      },
      {
        $set: {
          status: "completed",
          completed_at: new Date(),
          lease_token: null,
          lease_until: null,
        },
      },
    );
    if (result.modifiedCount !== 1) throw Error("RECOVERY_MIGRATION_STALE");
  } catch (e) {
    await markers.updateOne(
      { version: 21, lease_token: token, status: "running" },
      {
        $set: {
          status: "failed",
          failed_at: new Date(),
          lease_token: null,
          lease_until: null,
        },
      },
    );
    throw e;
  }
}
export function assertRecoveryConfiguration() {
  if (
    recoveryEnabled() &&
    (process.env.NODE_ENV === "production" ||
      process.env.KL_MONGO_ALLOW_STANDALONE !== "true")
  )
    throw Error("RECOVERY_NONPRODUCTION_STANDALONE_ONLY");
}
/** Stop admission before checking writer rows; no lease expiry or blind ownership reset. */
export async function withRecoveryMigration<T>(
  db: Db,
  work: () => Promise<T>,
): Promise<T> {
  const control = objectIdDatabase(rawDatabase(db));
  const states = control.collection<any>("operational_state");
  const before = await states.findOne({ _id: "environment" });
  if (!before || !["unregistered", "active"].includes(before.mode))
    throw Error("RECOVERY_MIGRATION_STATE");
  const owner =
    process.env.KL_MANAGED_WRITER_OWNER ?? "recovery-schema-" + randomUUID();
  const transientEnvironment = before.environment_id ?? randomUUID();
  if (
    await control
      .collection("operational_writers")
      .findOne({ state: "running" })
  )
    throw Error("RECOVERY_WRITERS_RUNNING");
  const claimed = await states.updateOne(
    {
      _id: "environment",
      mode: before.mode,
      revision: before.revision,
      access_fence: before.access_fence,
    },
    {
      $set: {
        mode: "draining",
        environment_id: transientEnvironment,
        owner,
        updated_at: new Date(),
      },
      $inc: { revision: 1, access_fence: 1 },
    },
  );
  if (claimed.modifiedCount !== 1) throw Error("RECOVERY_MIGRATION_BUSY");
  try {
    if (
      await control
        .collection("operational_writers")
        .findOne({ state: "running" })
    )
      throw Error("RECOVERY_WRITERS_RUNNING");
    return await work();
  } finally {
    const released = await states.updateOne(
      {
        _id: "environment",
        mode: "draining",
        owner,
        revision: before.revision + 1,
      },
      {
        $set: {
          mode: before.mode,
          environment_id: before.environment_id,
          owner: before.owner,
          revision:
            before.mode === "unregistered"
              ? before.revision
              : before.revision + 2,
          updated_at: new Date(),
        },
        $inc: { access_fence: 1 },
      },
    );
    if (released.modifiedCount !== 1)
      throw Error("RECOVERY_MIGRATION_GUARD_CHANGED");
  }
}
