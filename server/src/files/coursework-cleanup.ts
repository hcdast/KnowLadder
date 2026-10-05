import type { Db, MongoClient, Document, ClientSession } from "mongodb";
import { newId } from "../database/object-id";
import { requireActor, requireObjectId } from "../operations/contracts";
import { assertMaintenance } from "../operations/control";
import {
  reserveSafetyIntent,
  confirmSafetyIntent,
  safetyOperationId,
  readSafetyLedger,
} from "../operations/ledger";
import { runInTxn } from "../database/txn";
import { fileReferenced } from "./references";
async function fenceCleanupSubject(
  db: Db,
  session: ClientSession,
  userId: string,
  orgId: string,
) {
  const user = await db
    .collection<Row>("users")
    .findOne(
      { _id: userId, status: "active", privacy_state: "active" },
      { session },
    );
  if (
    !user ||
    (await db
      .collection("privacy_tombstones")
      .findOne({ user_id: userId }, { session })) ||
    !(await db
      .collection<Row>("organization_members")
      .findOne(
        { user_id: userId, org_id: orgId, status: "active" },
        { session },
      ))
  )
    throw Error("FILE_SUBJECT_BLOCKED");
  if (
    (
      await db
        .collection<Row>("users")
        .updateOne(
          {
            _id: userId,
            status: "active",
            privacy_state: "active",
            identity_revision: user.identity_revision,
          },
          { $inc: { identity_revision: 1 } },
          { session },
        )
    ).matchedCount !== 1
  )
    throw Error("FILE_SUBJECT_BLOCKED");
}
type Row = Document & { _id: string };
export async function courseworkMaintenanceFence(
  db: Db,
  token: string,
  session?: ClientSession,
) {
  const state = await assertMaintenance(db, token);
  if (
    await db
      .collection("operational_writers")
      .findOne({ state: "running" }, { session })
  )
    throw Error("OPERATIONS_WRITERS_RUNNING");
  if (
    session &&
    (
      await db
        .collection<Row>("operational_state")
        .updateOne(
          { _id: "environment", mode: "maintenance", maintenance_token: token },
          { $inc: { access_fence: 1 } },
          { session },
        )
    ).matchedCount !== 1
  )
    throw Error("OPERATIONS_MAINTENANCE_REQUIRED");
  return state;
}
export async function scheduleCourseworkCleanup(
  client: MongoClient,
  db: Db,
  input: {
    fileId: string;
    expectedRevision: number;
    actor: string;
    reason: string;
    maintenanceToken: string;
  },
) {
  requireObjectId(input.fileId);
  requireActor(input);
  if (process.env.KL_COURSEWORK_FILES_ENABLED !== "true")
    throw Error("COURSEWORK_FILES_DISABLED");
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  )
    throw Error("FILE_REVISION_INVALID");
  const gate = await courseworkMaintenanceFence(db, input.maintenanceToken);
  const operationId = safetyOperationId(
    JSON.stringify([
      "coursework.cleanup",
      input.fileId,
      input.expectedRevision,
      input.actor,
      input.reason,
    ]),
  );
  const files = db.collection<Row>("file_resources"),
    heads = db.collection<Row>("coursework_heads");
  const receipt = await db
    .collection<Row>("audit_events")
    .findOne({ request_id: operationId, action: "file.coursework.cleanup" });
  if (receipt) {
    const safety = await readSafetyLedger(gate.environmentId, 0);
    const entry = safety.entries.find((e) => e.operationId === operationId);
    if (!entry) throw Error("FILE_CLEANUP_RECEIPT_INVALID");
    await confirmSafetyIntent(db, {
      operationId,
      sequence: entry.sequence,
      environmentId: gate.environmentId,
    });
    return {
      fileId: input.fileId,
      operationId,
      scheduled: true,
      replayed: true,
    };
  }
  const before = await files.findOne({
    _id: input.fileId,
    owner_type: "coursework",
  });
  if (!before) throw Error("FILE_NOT_FOUND");
  const owner = await heads.findOne({
    _id: before.owner_version_id,
    org_id: before.org_id,
    user_id: before.created_by,
  });
  if (!owner || owner.revision !== input.expectedRevision)
    throw Error("FILE_OWNER_REVISION_CONFLICT");
  const until = before.retention_until ?? new Date();
  if (
    before.legal_hold ||
    until > new Date() ||
    before.deleted_at ||
    before.status === "deleting"
  )
    throw Error("FILE_DELETE_BLOCKED");
  await runInTxn(
    client,
    async (session) => {
      await courseworkMaintenanceFence(db, input.maintenanceToken, session);
      await fenceCleanupSubject(db, session, owner.user_id, owner.org_id);
      if (await fileReferenced(db, before._id, session))
        throw Error("FILE_REFERENCED");
    },
    { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } },
  );
  // Durable retention intent protects old backups; physical worker commits its own file.deleted intent.
  const reservation = await reserveSafetyIntent(db, {
    operationId,
    action: "file.retention",
    resourceId: input.fileId,
    resourceType: "file",
    retentionUntil: until,
  });
  await runInTxn(
    client,
    async (session) => {
      await courseworkMaintenanceFence(db, input.maintenanceToken, session);
      if (
        await db
          .collection<Row>("audit_events")
          .findOne(
            { request_id: operationId, action: "file.coursework.cleanup" },
            { session },
          )
      )
        return;
      const live = await files.findOne(
        {
          _id: input.fileId,
          owner_type: "coursework",
          updated_at: before.updated_at,
          legal_hold: false,
          deleted_at: null,
        },
        { session },
      );
      if (
        !live ||
        live.status === "deleting" ||
        live.retention_until > new Date() ||
        [
          live.lease_until,
          live.upload_lease_until,
          live.deletion_lease_until,
        ].some((x) => x instanceof Date && x > new Date())
      )
        throw Error("FILE_DELETE_BLOCKED");
      await fenceCleanupSubject(db, session, owner.user_id, owner.org_id);
      if (await fileReferenced(db, live._id, session))
        throw Error("FILE_REFERENCED");
      if (
        (
          await heads.updateOne(
            { _id: owner._id, revision: input.expectedRevision },
            { $inc: { revision: 1 }, $set: { updated_at: new Date() } },
            { session },
          )
        ).matchedCount !== 1
      )
        throw Error("FILE_OWNER_REVISION_CONFLICT");
      if (
        (
          await files.updateOne(
            { _id: live._id, updated_at: live.updated_at },
            {
              $max: { retention_until: until },
              $set: {
                deletion_requested_at: new Date(),
                deletion_requested_by: null,
                deletion_requested_reason: input.reason,
                updated_at: new Date(),
              },
            },
            { session },
          )
        ).matchedCount !== 1
      )
        throw Error("FILE_DELETE_CONFLICT");
      await db
        .collection<Row>("audit_events")
        .insertOne(
          {
            _id: newId(),
            org_id: live.org_id,
            actor_id: input.actor,
            action: "file.coursework.cleanup",
            resource_type: "file",
            resource_id: live._id,
            owner_type: "coursework",
            owner_version_id: owner._id,
            revision_before: owner.revision,
            revision_after: owner.revision + 1,
            access_revision_before: null,
            access_revision_after: null,
            reason: input.reason,
            request_id: operationId,
            created_at: new Date(),
          },
          { session },
        );
    },
    { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } },
  );
  await confirmSafetyIntent(db, reservation);
  const ledger = await readSafetyLedger(gate.environmentId, 0);
  if (ledger.pending) throw Error("OPERATIONS_PENDING_LEDGER");
  return {
    fileId: input.fileId,
    operationId,
    scheduled: true,
    replayed: false,
  };
}
