import { installShutdown, notifyReady, validateRuntimeFlags, finishRuntimeFailure } from '../runtime/process-lifecycle';
import {isCourseworkFile,fileOwnerCollection} from './owner';
import {requireEvidenceSubject} from '../assessment/subject-access';
import { objectIdDatabase } from "../database/object-id";
import { newId } from "../database/object-id";
import { MongoClient, type ClientSession, type Db, type Document } from 'mongodb';
import { randomUUID, createHash } from 'node:crypto';
import { rename, readdir, lstat, unlink, statfs } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { CONTENT_COLLECTIONS, licensed, type BaseVersion, type FileResource } from '../content/contracts';
import { assertSchema } from '../migrations/schema';
import { assertScanner, scanWithHealth } from './scanner';
import { fileConfig, fileScanEnabled, openPrivate, storagePath, storageRoot } from './config';
import { fileReferenced } from './references';
import { touchContentLearningScope } from '../learning/tracking';
import { acquireWriter, assertOperationalAccess, type WriterRegistration } from '../operations/control';
import { confirmSafetyIntent, reserveManagedSafetyIntent, safetyOperationId } from '../operations/ledger';
import { runInTxn } from '../database/txn';
import { assertAdministrationAccess } from '../administration/authorization';

const MAX_ATTEMPTS = 3;
const DELETE_LEASE_MS = 120000;
const AREAS = ['tmp', 'quarantine', 'ready'] as const;
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const retryAt = (attempt: number) => new Date(Date.now() + Math.min(300000, 10000 * 2 ** Math.min(attempt, 5)));
function administrationBlocked(error: unknown) {
  return error instanceof Error && ['Administration target is isolated pending explicit recovery',
    'Administration operation is unfinished for this target','Coursework subject is frozen for erasure','Coursework file owner mismatch'].includes(error.message);
}

async function transaction<T>(db: Db, work: (session: ClientSession) => Promise<T>) {
  await assertOperationalAccess(db);
  return runInTxn(db.client, work, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
}
async function guardFile(db: Db, row: FileResource, session?: ClientSession) {
  if(isCourseworkFile(row) && !await db.collection<Document & {_id:string}>("users").findOne({_id:row.created_by,$or:[{privacy_state:"active"},{privacy_state:{$exists:false}}]},{session,projection:{_id:1}}))throw Error("Coursework subject is frozen for erasure");
  await assertAdministrationAccess(db, row.created_by, row.org_id, session);
  if (typeof row.upload_actor_user_id === 'string')
    await assertAdministrationAccess(db, row.upload_actor_user_id,
      typeof row.upload_actor_org_id === 'string' ? row.upload_actor_org_id : row.org_id, session);
}
async function guardOwner(db: Db, row: FileResource, session?: ClientSession) {
  const owner = await db.collection<BaseVersion>(fileOwnerCollection(row)).findOne(
    { _id: row.owner_version_id, org_id: row.org_id }, { session, projection: { created_by: 1, user_id:1, revision: 1, access_revision: 1 } });
  if(isCourseworkFile(row) && (!owner || owner.user_id!==row.created_by))throw Error('Coursework file owner mismatch');
  if (owner) await assertAdministrationAccess(db, isCourseworkFile(row) ? owner.user_id : owner.created_by, row.org_id, session);
  return owner;
}

async function ownerFence(db: Db, row: FileResource, session: ClientSession, requireLicense: boolean) {
  const owners = db.collection<BaseVersion>(fileOwnerCollection(row));
  const owner = await owners.findOne({ _id: row.owner_version_id, org_id: row.org_id }, { session });
  await guardFile(db, row, session);
  if (owner) await assertAdministrationAccess(db, isCourseworkFile(row) ? owner.user_id : owner.created_by, owner.org_id, session);
  if(isCourseworkFile(row)){
    if(!owner || owner.user_id!==row.created_by || process.env.KL_COURSEWORK_FILES_ENABLED!=="true")return null;
    await requireEvidenceSubject(db,session,owner.user_id,owner.org_id);
    const changed=await owners.updateOne({_id:owner._id,org_id:owner.org_id,revision:owner.revision},{$inc:{revision:1},$set:{updated_at:new Date()}},{session});
    if(changed.modifiedCount!==1)throw Error("OWNER_FENCE_CONFLICT");
    return {...owner,access_revision:owner.revision};
  }
  if (!owner || !Number.isSafeInteger(owner.access_revision) || (requireLicense && !licensed(owner))) return null;
  await touchContentLearningScope(db,{orgId:row.org_id,userId:'system:files',session},row.owner_type,owner,true);
  const changed = await owners.updateOne({ _id: owner._id, org_id: owner.org_id, access_revision: owner.access_revision }, { $inc: { access_revision: 1 } }, { session });
  if (changed.modifiedCount !== 1) throw new Error('OWNER_FENCE_CONFLICT');
  return owner;
}

async function audit(db: Db, session: ClientSession, row: FileResource, action: string, reason: string, owner: BaseVersion | null, advanced = false) {
  await db.collection<Document & { _id: string }>('audit_events').insertOne({
    _id: newId(), org_id: row.org_id, actor_id: 'file-worker', action,
    resource_type: 'file', resource_id: row._id, owner_type: row.owner_type, owner_version_id: row.owner_version_id,
    revision_before: owner?.revision ?? null, revision_after: owner ? owner.revision + (isCourseworkFile(row) && advanced ? 1 : 0) : null,
    access_revision_before: isCourseworkFile(row) ? null : owner?.access_revision ?? null,
    access_revision_after: !isCourseworkFile(row) && owner ? owner.access_revision + (advanced ? 1 : 0) : null,
    reason, request_id: randomUUID(), created_at: new Date(),
  }, { session });
}

async function integrity(area: 'quarantine' | 'ready', row: FileResource) {
  const handle = await openPrivate(area, row.storage_key);
  try {
    const hash = createHash('sha256'); let size = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    return size === row.size && hash.digest('hex') === row.checksum;
  } finally { await handle.close(); }
}

export async function processOne(db: Db) {
  if (!fileScanEnabled()) return false;
  await assertOperationalAccess(db);
  const files = db.collection<FileResource>('file_resources');
  // One health-checked scan performs five bounded engine invocations. The lease
  // covers all of them, rather than only the final malware scan.
  const now = new Date(); const token = randomUUID(); const leaseMs = fileConfig().timeout * 5 + 120000;
  let row: FileResource | null = null;
  for await (const candidate of files.find({ status: 'quarantined', scan_attempt: { $lt: MAX_ATTEMPTS },
    available_at: { $lte: now }, scan_status: 'queued' }).sort({ available_at: 1, _id: 1 }).batchSize(20)) {
    try { await guardFile(db, candidate); await guardOwner(db, candidate); }
    catch (error) { if (administrationBlocked(error)) continue; throw error; }
    row = await files.findOneAndUpdate({ _id: candidate._id, status: 'quarantined', scan_attempt: { $lt: MAX_ATTEMPTS },
      available_at: { $lte: now }, scan_status: 'queued' }, {
      $set: { scan_status: 'scanning', lease_token: token, lease_until: new Date(now.getTime() + leaseMs), updated_at: now },
      $inc: { scan_attempt: 1 },
    }, { returnDocument: 'after' });
    if (row) break;
  }
  if (!row) return false;
  const fence = { _id: row._id, status: 'quarantined' as const, scan_status: 'scanning' as const, lease_token: token };
  let result: 'clean' | 'infected' | 'failed' = 'failed';
  let moved = false;
  let metadata: { engine_version: string; database_version: string; database_updated_at: Date } | undefined;
  let scannedAt: Date | undefined;
  let stage = 'integrity';
  try {
    if (await integrity('quarantine', row)) {
      stage = 'scan';
      const scanned = await scanWithHealth(await storagePath('quarantine', row.storage_key));
      result = scanned.result;
      if (scanned.health) { metadata = scanned.health; scannedAt = new Date(); }
    }
    if (result === 'clean') {
      stage = 'post-scan-integrity';
      if (!(await integrity('quarantine', row))) result = 'failed';
    }
    if (result === 'clean') stage = 'publish';
    if (result === 'clean') {
      await guardFile(db, row);
      await guardOwner(db, row);
      const renewed = await files.updateOne({ ...fence, lease_until: { $gt: new Date() } }, { $set: { lease_until: new Date(Date.now() + leaseMs), updated_at: new Date() } });
      if (renewed.modifiedCount !== 1) return true;
      await rename(await storagePath('quarantine', row.storage_key), await storagePath('ready', row.storage_key));
      moved = true;
      await transaction(db, async session => {
        const live = await files.findOne({ ...fence, lease_until: { $gt: new Date() } }, { session });
        if (!live) return;
        await guardFile(db, live, session);
        const owner = await ownerFence(db, live, session, true);
        if (!owner) return;
        const changed = await files.updateOne({ ...fence, lease_until: { $gt: new Date() } }, { $set: {
          status: 'ready', scan_status: 'clean', lease_token: null, lease_until: null, error_code: null,
          scan_engine_version: metadata!.engine_version, scan_database_version: metadata!.database_version,
          scan_database_updated_at: metadata!.database_updated_at, scanned_at: scannedAt!, updated_at: new Date(),
        } }, { session });
        if (changed.modifiedCount !== 1) throw new Error('SCAN_LEASE_LOST');
        await audit(db, session, live, 'file.scan.clean', '文件通过完整性校验及有效病毒库扫描', owner, true);
      });
      return true;
    }
  } catch (error) {
    if (administrationBlocked(error)) {
      // This lease never published an authorized clean result. Return only its
      // attempt; after a physical rename, keep the interrupted scanning row
      // for reconcile to move bytes back before any fresh health-checked scan.
      const at = new Date();
      await files.updateOne({ ...fence, scan_attempt: row.scan_attempt },
        { $inc: { scan_attempt: -1 }, $set: moved
          ? { lease_until: new Date(0), updated_at: at }
          : { scan_status: 'queued', lease_token: null, lease_until: null, available_at: at, updated_at: at } });
      return true;
    }
    console.warn(JSON.stringify({ event: 'file.worker.failed', file_id: row._id, stage, moved }));
    if (moved) return true;
    result = 'failed';
  }
  if (result === 'failed') console.warn(JSON.stringify({ event: 'file.worker.scan-unconfirmed', file_id: row._id, stage, attempt: row.scan_attempt }));
  const retry = result === 'failed' && row.scan_attempt < MAX_ATTEMPTS;
  try {
    await transaction(db, async session => {
      await guardFile(db, row, session);
      const owner = await guardOwner(db, row, session);
      const changed = await files.updateOne({ ...fence, lease_until: { $gt: new Date() } }, { $set: {
        scan_status: retry ? 'queued' : result, lease_token: null, lease_until: null,
        error_code: result === 'infected' ? 'MALWARE_DETECTED' : 'SCAN_FAILED', available_at: retryAt(row.scan_attempt), updated_at: new Date(),
        ...(metadata ? { scan_engine_version: metadata.engine_version, scan_database_version: metadata.database_version, scan_database_updated_at: metadata.database_updated_at, scanned_at: scannedAt! } : {}),
      } }, { session });
      if (changed.modifiedCount) {
        await audit(db, session, row, retry ? 'file.scan.retry' : `file.scan.${result}`, result === 'infected' ? '扫描拒绝恶意文件' : '扫描未成功确认，禁止交付', owner);
      }
    });
  } catch (error) {
    if (!administrationBlocked(error)) throw error;
    // A genuine failed/infected scan already spent this attempt. Preserve its
    // quarantine until recovery; do not pretend the file passed scanning.
    await files.updateOne({ ...fence, scan_attempt: row.scan_attempt },
      { $set: { lease_until: new Date(0), updated_at: new Date() } });
    return true;
  }
  return true;
}


export async function processDeletion(db: Db) {
  await assertOperationalAccess(db);
  const files = db.collection<FileResource>('file_resources');
  const now = new Date(); const token = randomUUID();
  // Expired uploads/scans may be reclaimed, but never race a live filesystem writer.
  const eligible = {
    deleted_at: null, legal_hold: false, retention_until: { $type: 'date' as const, $lte: now },
    deletion_requested_at: { $type: 'date' as const }, available_at: { $lte: now },
    $and: [
      { $or: [{ deletion_lease_until: null }, { deletion_lease_until: { $lte: now } }] },
      { $or: [{ upload_lease_until: null }, { upload_lease_until: { $lte: now } }] },
      { $or: [{ lease_until: null }, { lease_until: { $lte: now } }] },
    ],
  };
  let claimed: FileResource | null = null;
  for await (const candidate of files.find(eligible).sort({ retention_until: 1 })) {
    try {
    claimed = await transaction(db, async session => {
      const row = await files.findOne({ _id: candidate._id, ...eligible }, { session });
      if (!row) return null;
      await guardFile(db, row, session);
      if (await fileReferenced(db, row._id, session)) return null;
      const owner = await ownerFence(db, row, session, false);
      if (!owner) return null;
      const updated = await files.findOneAndUpdate({ _id: row._id, ...eligible }, {
        $set: { status: 'deleting', deletion_lease_token: token, deletion_lease_until: new Date(Date.now() + DELETE_LEASE_MS), lease_token: null, lease_until: null, upload_lease_token: null, upload_lease_until: null, updated_at: new Date() },
        $inc: { deletion_attempt: 1 },
      }, { session, returnDocument: 'after' });
      if (!updated) throw new Error('DELETE_CLAIM_CONFLICT');
      await audit(db, session, updated, 'file.deletion.claim', '领取已到期、无引用且无保全的显式删除申请', owner, true);
      return updated;
    }) ?? null;
    } catch (error) { if (administrationBlocked(error)) continue; throw error; }
    if (claimed) break;
  }
  if (!claimed) return false;
  const row = claimed;
  // The deleting lease is reversible metadata. Reserve only for its winner, before any unlink.
  // Reservation failure leaves the lease to expire; bytes remain untouched for a safe retry.
  const reservation=await reserveManagedSafetyIntent(db,{operationId:safetyOperationId(`file.deleted:${row._id}:${row.deletion_attempt}`),action:'file.deleted',resourceId:row._id,resourceType:'file'});
  const fence = { _id: row._id, status: 'deleting' as const, deleted_at: null, legal_hold: false, deletion_lease_token: token };
  let failed = false;
  try {
    for (const key of new Set([row.storage_key, row.upload_storage_key, ...row.upload_storage_keys].filter((value): value is string => typeof value === 'string'))) {
      for (const area of AREAS) {
        await assertOperationalAccess(db);
        await guardFile(db, row);
        await guardOwner(db, row);
        const live = await files.updateOne({ ...fence, deletion_lease_until: { $gt: new Date() } }, { $set: { deletion_lease_until: new Date(Date.now() + DELETE_LEASE_MS), updated_at: new Date() } });
        if (!live.matchedCount) return true;
        try { await unlink(await storagePath(area, key)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
  } catch { failed = true; }
  const completedDeletion=await transaction(db, async session => {
    await guardFile(db, row, session);
    const completed = new Date();
    const changed = await files.updateOne({ ...fence, deletion_lease_until: { $gt: completed } }, { $set: {
      deletion_lease_token: null, deletion_lease_until: null, updated_at: completed,
      error_code: failed ? 'FILE_DELETE_FAILED' : null, available_at: failed ? retryAt(row.deletion_attempt) : completed,
      ...(failed ? {} : { deleted_at: completed }),
    } }, { session });
    if (changed.modifiedCount) {
      const owner = await db.collection<BaseVersion>(fileOwnerCollection(row)).findOne({ _id: row.owner_version_id, org_id: row.org_id }, { session });
      await audit(db, session, row, failed ? 'file.deletion.retry' : 'file.deletion.completed', failed ? '物理删除失败，保留禁止下载的墓碑并等待重试' : '所有存储路径已删除或不存在，保留资源墓碑', owner);
    }
    return !failed && changed.modifiedCount===1;
  });
  if(completedDeletion && reservation)await confirmSafetyIntent(db,reservation);
  return true;
}

export async function reconcile(db: Db) {
  await assertOperationalAccess(db);
  const files = db.collection<FileResource>('file_resources'); let repaired = 0; let removed = 0; const now = new Date();
  for await (const row of files.find({ status: 'ready' })) {
    try { await guardFile(db, row); await guardOwner(db, row); }
    catch (error) { if (administrationBlocked(error)) continue; throw error; }
    let valid = false; try { valid = await integrity('ready', row); } catch {}
    if (!valid) {
      const changed = await files.updateOne({ _id: row._id, status: 'ready', storage_key: row.storage_key }, { $set: { status: 'quarantined', scan_status: 'failed', error_code: 'READY_FILE_MISSING_OR_CORRUPT', updated_at: now } });
      repaired += changed.modifiedCount;
    }
  }
  // Re-scan interrupted filesystem/DB commits; a directory name is not evidence of a clean scan.
  for await (const candidate of files.find({ status: 'quarantined', scan_status: 'scanning', lease_until: { $lte: now } })) {
    const token = randomUUID();
    try { await guardFile(db, candidate); await guardOwner(db, candidate); }
    catch (error) { if (administrationBlocked(error)) continue; throw error; }
    const row = await files.findOneAndUpdate({ _id: candidate._id, status: 'quarantined', scan_status: 'scanning', lease_token: candidate.lease_token, lease_until: { $lte: now } }, { $set: { lease_token: token, lease_until: new Date(Date.now() + 120000) } }, { returnDocument: 'after' });
    if (!row) continue;
    const fence = { _id: row._id, status: 'quarantined' as const, scan_status: 'scanning' as const, lease_token: token };
    try {
      let ready = false; try { ready = await integrity('ready', row); } catch {}
      if (ready) {
        const live = await files.updateOne({ ...fence, lease_until: { $gt: new Date() } }, { $set: { lease_until: new Date(Date.now() + 120000), updated_at: new Date() } });
        if (!live.matchedCount) continue;
        await rename(await storagePath('ready', row.storage_key), await storagePath('quarantine', row.storage_key));
      }
      const valid = await integrity('quarantine', row);
      await guardFile(db, row);
      await files.updateOne({ ...fence, lease_until: { $gt: new Date() } }, { $set: { scan_status: valid && row.scan_attempt < MAX_ATTEMPTS ? 'queued' : 'failed', lease_token: null, lease_until: null, available_at: now, error_code: valid ? 'SCAN_INTERRUPTED' : 'FILE_MISSING_OR_CORRUPT', updated_at: now } });
    } catch (error) {
      if (administrationBlocked(error)) continue;
      try { await guardFile(db, row); await guardOwner(db, row); }
      catch (blocked) { if (administrationBlocked(blocked)) continue; throw blocked; }
      await files.updateOne({ ...fence, lease_until: { $gt: new Date() } }, { $set: { scan_status: 'failed', lease_token: null, lease_until: null, error_code: 'RECONCILE_FAILED', updated_at: now } });
    }
    repaired++;
  }
  const root = await storageRoot();
  for (const area of AREAS) {
    for (const entry of await readdir(`${root}/${area}`, { withFileTypes: true })) {
      if (!entry.isFile() || !KEY.test(entry.name)) continue;
      const filename = await storagePath(area, entry.name);
      let info; try { info = await lstat(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (info.isSymbolicLink() || info.mtimeMs > Date.now() - 86400000) continue;
      // Registration commits before creating bytes. Preserve every registered key, including
      // failed uploads, expired leases and tombstones; only explicit deletion may remove them.
      if (await files.findOne({ $or: [{ storage_key: entry.name }, { upload_storage_key: entry.name }, { upload_storage_keys: entry.name }, { upload_lease_token: entry.name }, { lease_token: entry.name }] }, { projection: { _id: 1 } })) continue;
      try { await unlink(filename); removed++; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  return { repaired, removed };
}

export async function usage(db: Db) {
  await assertOperationalAccess(db);
  const root = await storageRoot();
  const disk = await statfs(root, { bigint: true });
  const areas: Record<string, { count: number; bytes: string }> = {};
  for (const area of AREAS) {
    let count = 0; let bytes = 0n;
    for (const entry of await readdir(`${root}/${area}`, { withFileTypes: true })) {
      if (!entry.isFile() || !KEY.test(entry.name)) continue;
      try { const info = await lstat(await storagePath(area, entry.name), { bigint: true }); if (info.isFile() && !info.isSymbolicLink()) { count++; bytes += info.size; } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    areas[area] = { count, bytes: bytes.toString() };
  }
  const resources = await db.collection<FileResource>('file_resources').aggregate([
    { $group: { _id: { status: '$status', scan_status: '$scan_status', deleted: { $ne: [{ $ifNull: ['$deleted_at', null] }, null] } }, count: { $sum: 1 }, bytes: { $sum: { $ifNull: ['$size', 0] } } } },
    { $sort: { '_id.status': 1, '_id.scan_status': 1, '_id.deleted': 1 } },
  ]).toArray();
  return { measured_at: new Date(), disk: { total_bytes: (disk.blocks * disk.bsize).toString(), available_bytes: (disk.bavail * disk.bsize).toString() }, areas, resources };
}

async function main() {
  validateRuntimeFlags();
  const command = process.argv[2];
  if (
    process.argv.length !== 3 ||
    !["once", "run", "reconcile", "cleanup", "usage"].includes(command)
  )
    throw new Error("用法：worker.js once|run|reconcile|cleanup|usage");
  const scanEnabled = fileScanEnabled();
  if ((command === "once" || command === "run") && !scanEnabled) {
    console.log("文件扫描已关闭；跳过文件worker扫描与周期维护");
    return;
  }
  await storageRoot();
  if (command === "once" || command === "run") await assertScanner();
  if (!process.env.MONGODB_URI) throw new Error("必须配置MONGODB_URI");
  const client = new MongoClient(process.env.MONGODB_URI, {
    readPreference: "primary",
    writeConcern: { w: "majority" },
  });
  await client.connect();
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  const dispose = installShutdown(stop);
  let writer: WriterRegistration | undefined;
  try {
    const db = objectIdDatabase(client.db());
    await assertSchema(db);
    writer = await acquireWriter(db, "files");
    if (command === "reconcile") {
      console.log(JSON.stringify(await reconcile(db)));
      return;
    }
    if (command === "cleanup") {
      console.log(JSON.stringify({ processed: await processDeletion(db) }));
      return;
    }
    if (command === "usage") {
      console.log(JSON.stringify(await usage(db)));
      return;
    }
    notifyReady();
    let lastReconcile = 0;
    do {
      if (stopping || (await writer.stopRequested())) break;
      if (Date.now() - lastReconcile > 60000) {
        await reconcile(db);
        lastReconcile = Date.now();
      }
      const deleted = await processDeletion(db);
      const processed = await processOne(db);
      if (command === "once") {
        console.log(JSON.stringify({ processed, deleted }));
        break;
      }
      if (!processed && !deleted) await sleep(1000);
    } while (!stopping);
  } finally {
    try {
      await writer?.release();
    } finally {
      try {
        await client.close();
      } finally {
        dispose();
      }
    }
  }
}
if (require.main === module)
  main().catch((error) => {
    finishRuntimeFailure("files-worker", error);
  });
