import { courseworkMaintenanceFence } from "../files/coursework-cleanup";
import type { Db, Document } from "mongodb";
import { randomUUID } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import { storageRoot, storagePath } from "../files/config";
import { runInTxn } from "../database/txn";
import { readSafetyLedger } from "../operations/ledger";
const LEASE = 120000;
type Row = Document & { _id: string };
const rows = (db: Db, name: string) => db.collection<Row>(name);
export async function courseworkFilesHeld(
  db: Db,
  userId: string,
  session?: import("mongodb").ClientSession,
) {
  const any = await rows(db, "file_resources").findOne(
    { owner_type: "coursework", created_by: userId },
    { session, projection: { _id: 1 } },
  );
  if (any && process.env.KL_COURSEWORK_FILES_ENABLED !== "true")
    throw Error("PRIVACY_COURSEWORK_FILES_DISABLED");
  return !!(await rows(db, "file_resources").findOne(
    {
      owner_type: "coursework",
      created_by: userId,
      $or: [{ legal_hold: true }, { retention_until: { $gt: new Date() } }],
    },
    { session, projection: { _id: 1 } },
  ));
}
async function foreignReference(
  db: Db,
  file: Row,
  session: import("mongodb").ClientSession,
) {
  for (const name of ["textbook_editions", "question_versions", "chapters"])
    if (
      await rows(db, name).findOne(
        { resource_ids: file._id },
        { session, projection: { _id: 1 } },
      )
    )
      throw Error("PRIVACY_COURSEWORK_FILE_FOREIGN_REFERENCE");
  if (
    (await rows(db, "courses").findOne(
      { "lessons.file_id": file._id },
      { session, projection: { _id: 1 } },
    )) ||
    (await rows(db, "assessment_resource_references").findOne(
      { file_id: file._id },
      { session, projection: { _id: 1 } },
    ))
  )
    throw Error("PRIVACY_COURSEWORK_FILE_FOREIGN_REFERENCE");
  for (const name of ["coursework_heads", "coursework_submissions"])
    if (
      await rows(db, name).findOne(
        {
          file_ids: file._id,
          $or: [
            { user_id: { $ne: file.created_by } },
            { org_id: { $ne: file.org_id } },
          ],
        },
        { session, projection: { _id: 1 } },
      )
    )
      throw Error("PRIVACY_COURSEWORK_FILE_FOREIGN_REFERENCE");
}
/** Called only after the committed subject erasure fence, before removing its graph. */
export async function eraseCourseworkFileBytes(
  db: Db,
  userId: string,
  requestId: string,
  renew: () => Promise<void> = async () => {},
  maintenanceToken?: string,
) {
  if (
    !(await rows(db, "file_resources").findOne(
      { owner_type: "coursework", created_by: userId },
      { projection: { _id: 1 } },
    ))
  )
    return;
  if (process.env.KL_COURSEWORK_FILES_ENABLED !== "true")
    throw Error("PRIVACY_COURSEWORK_FILES_DISABLED");
  const state = await rows(db, "operational_state").findOne({
    _id: "environment",
  });
  if (
    !state ||
    ![
      "active",
      "restore_quarantined",
      ...(maintenanceToken ? ["maintenance"] : []),
    ].includes(state.mode)
  )
    throw Error("PRIVACY_FILE_ENVIRONMENT_REQUIRED");
  if (
    await rows(db, "operational_writers").findOne(
      { state: "running", kind: { $ne: "privacy" } },
      { projection: { _id: 1 } },
    )
  )
    throw Error("PRIVACY_FILE_WRITERS_MUST_STOP");
  if (maintenanceToken) await courseworkMaintenanceFence(db, maintenanceToken);
  const tombstone = await rows(db, "privacy_tombstones").findOne({
    user_id: userId,
    request_id: requestId,
  });
  const ledger = await readSafetyLedger(
    state.environment_id,
    tombstone?.ledger_sequence ?? 0,
  );
  if (
    !tombstone ||
    ledger.pending ||
    !ledger.entries.some(
      (x) =>
        x.action === "subject.erase" &&
        x.subjectId === userId &&
        x.privacyRequestId === requestId &&
        x.state === "committed" &&
        x.sequence === tombstone.ledger_sequence,
    )
  )
    throw Error("PRIVACY_FILE_ERASURE_PROOF_REQUIRED");
  if (await courseworkFilesHeld(db, userId)) return;
  const root = await storageRoot();
  for await (const candidate of rows(db, "file_resources").find({
    owner_type: "coursework",
    created_by: userId,
  })) {
    await renew();
    if (maintenanceToken)
      await courseworkMaintenanceFence(db, maintenanceToken);
    if (candidate.deleted_at) {
      for (const key of new Set(
        [
          candidate.storage_key,
          candidate.upload_storage_key,
          ...candidate.upload_storage_keys,
        ].filter((x) => typeof x === "string"),
      ))
        for (const area of ["tmp", "quarantine", "ready"] as const) {
          try {
            await lstat(await storagePath(area, key, root));
            throw Error("PRIVACY_FILE_TOMBSTONE_HAS_BYTES");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      continue;
    }
    const token = randomUUID();
    const file = await runInTxn(
      db.client,
      async (session) => {
        if (maintenanceToken)
          await courseworkMaintenanceFence(db, maintenanceToken, session);
        const subject = await rows(db, "users").findOne(
          { _id: userId, privacy_state: { $in: ["erasing", "erased"] } },
          { session },
        );
        if (!subject) throw Error("PRIVACY_FILE_SUBJECT_NOT_FROZEN");
        const current = await rows(db, "file_resources").findOne(
          { _id: candidate._id, owner_type: "coursework", created_by: userId },
          { session },
        );
        if (!current) throw Error("PRIVACY_FILE_CONFLICT");
        if (current.legal_hold || current.retention_until > new Date())
          throw Error("PRIVACY_FILE_HELD");
        const now = new Date();
        if (
          [
            current.upload_lease_until,
            current.lease_until,
            current.deletion_lease_until,
          ].some((x) => x instanceof Date && x > now)
        )
          throw Error("PRIVACY_FILE_WRITER_BUSY");
        const owner = await rows(db, "coursework_heads").findOne(
          {
            _id: current.owner_version_id,
            org_id: current.org_id,
            user_id: userId,
          },
          { session },
        );
        if (!owner || !Number.isSafeInteger(owner.revision))
          throw Error("PRIVACY_FILE_OWNER_INVALID");
        await foreignReference(db, current, session);
        const keys = [
          ...new Set(
            [
              current.storage_key,
              current.upload_storage_key,
              ...current.upload_storage_keys,
            ].filter((x) => typeof x === "string"),
          ),
        ];
        if (
          await rows(db, "file_resources").findOne(
            {
              _id: { $ne: current._id },
              $or: [
                { storage_key: { $in: keys } },
                { upload_storage_key: { $in: keys } },
                { upload_storage_keys: { $in: keys } },
              ],
            },
            { session, projection: { _id: 1 } },
          )
        )
          throw Error("PRIVACY_FILE_KEY_SHARED");
        await rows(db, "coursework_heads").updateOne(
          { _id: owner._id, revision: owner.revision },
          { $inc: { revision: 1 }, $set: { updated_at: now } },
          { session },
        );
        const claimed = await rows(db, "file_resources").findOneAndUpdate(
          { _id: current._id, updated_at: current.updated_at },
          {
            $set: {
              status: "deleting",
              deletion_lease_token: token,
              deletion_lease_until: new Date(now.getTime() + LEASE),
              updated_at: now,
            },
          },
          { session, returnDocument: "after" },
        );
        if (!claimed) throw Error("PRIVACY_FILE_CONFLICT");
        return claimed;
      },
      { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } },
    );
    for (const key of new Set(
      [
        file.storage_key,
        file.upload_storage_key,
        ...file.upload_storage_keys,
      ].filter((x) => typeof x === "string"),
    ))
      for (const area of ["tmp", "quarantine", "ready"] as const) {
        await renew();
        const now = new Date();
        if (
          (
            await rows(db, "file_resources").updateOne(
              {
                _id: file._id,
                deletion_lease_token: token,
                deletion_lease_until: { $gt: now },
                legal_hold: false,
              },
              {
                $set: {
                  deletion_lease_until: new Date(now.getTime() + LEASE),
                  updated_at: now,
                },
              },
            )
          ).matchedCount !== 1
        )
          throw Error("PRIVACY_FILE_LEASE_LOST");
        const filename = await storagePath(area, key, root);
        try {
          const info = await lstat(filename);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
            throw Error("PRIVACY_FILE_PATH_UNSAFE");
          await unlink(filename);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    await renew();
    if (
      (
        await rows(db, "file_resources").updateOne(
          {
            _id: file._id,
            deletion_lease_token: token,
            deletion_lease_until: { $gt: new Date() },
            legal_hold: false,
          },
          {
            $set: {
              deleted_at: new Date(),
              deletion_lease_token: null,
              deletion_lease_until: null,
              updated_at: new Date(),
              display_name: "[erased]",
              error_code: null,
            },
          },
        )
      ).matchedCount !== 1
    )
      throw Error("PRIVACY_FILE_LEASE_LOST");
  }
}
