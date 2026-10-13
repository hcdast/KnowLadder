const {objectIdDatabase, rawDatabase, decodeDocument, newId} = require("../server/dist/database/object-id.js");
const OID = /^[0-9a-f]{24}$/;
"use strict";
const storageAccess=require("./storage-access.cjs");
const { MongoClient, BSON } = require('../server/node_modules/mongodb');
const { fs, path, crypto, ensure, hash, privateDirectory, openFile, writeAll, createArchive, readArchive, CHUNK } = require('./system-backup-archive.cjs');
const schema = require('../server/dist/migrations/schema.js');
const control = require('../server/dist/operations/control.js');
const ledgerApi = require('../server/dist/operations/ledger.js');
const { fileReferenced } = require('../server/dist/files/references.js');
const MAX_DB = 256 * 1024 ** 2, MAX_FILES = 1024 ** 3, MAX_FILE = 10 * 1024 ** 2;
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AREAS = ['tmp', 'quarantine', 'ready'];
// Restore is a locked disaster-recovery copy, never an authorization rollback or an approval replay.
const SKIP_IMPORT = new Set(['operational_state','operational_writers','backup_restore_runs','member_roles','member_capability_grants','administrative_grants','authorization_requests','administration_operations','administration_guard','object_id_allocations','auth_email_challenges','auth_invitations','auth_mail_outbox']);
function exact(value, fields) { ensure(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === fields.slice().sort().join('|')); }
async function requireReplicaSet(db) { ensure(typeof (await db.admin().command({ hello: 1 })).setName === 'string', 'LOCAL_REPLICA_SET_REQUIRED'); }
function uriDatabase(uri, restore = false) {
  ensure(typeof uri === 'string');
  const match = /^mongodb:\/\/([^/]+)\/([^?]+)(?:\?.*)?$/.exec(uri); ensure(match && !match[1].includes('@'), 'LOCAL_REPLICA_SET_REQUIRED');
  ensure(match[1].split(',').every(host => /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)), 'LOCAL_REPLICA_SET_REQUIRED');
  const name = decodeURIComponent(match[2]); ensure((restore ? /^kl_restore_[\w-]+$/ : /^kl_(test|restore)_[\w-]+$/).test(name), 'LOCAL_DATABASE_REQUIRED'); return name;
}
async function fileRoot(root, empty = false) {
  root = await privateDirectory(root);
  const names = await fs.readdir(root);
  if (empty) ensure(names.length === 0, 'RESTORE_TARGET_NOT_EMPTY');
  else ensure(names.every(name => AREAS.includes(name)), 'UNKNOWN_STORAGE_ENTRY');
  for (const area of AREAS) { if (empty) await fs.mkdir(path.join(root, area), { mode: 0o700 }); await privateDirectory(path.join(root, area), root); }
  return root;
}
async function filesInventory(root, resources, checkpoint = () => {}) {
  const owners = new Map();
  for (const row of resources) for (const key of new Set([row.storage_key, row.upload_storage_key, ...(row.upload_storage_keys || [])].filter(Boolean))) {
    checkpoint();
    ensure(KEY.test(key)); ensure(!owners.has(key) || owners.get(key)._id === row._id, 'AMBIGUOUS_STORAGE_KEY'); owners.set(key, row);
  }
  let total = 0; const descriptors = [];
  for (const area of AREAS) for (const key of (await storageAccess.entries(root,area))) {
    checkpoint();
    ensure(KEY.test(key), 'UNKNOWN_STORAGE_ENTRY'); ensure(descriptors.length < 1000, 'BACKUP_LIMIT_EXCEEDED');
    const handle = await storageAccess.openSource(root,area,key);
    try {
      const before = await handle.stat(); ensure(before.size <= MAX_FILE, 'BACKUP_LIMIT_EXCEEDED'); total += before.size; ensure(total <= MAX_FILES, 'BACKUP_LIMIT_EXCEEDED');
      const digest = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(CHUNK); let offset = 0;
      for (;;) { checkpoint(); const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset); if (!bytesRead) break; digest.update(buffer.subarray(0, bytesRead)); offset += bytesRead; }
      const after = await handle.stat(); ensure(offset === before.size && before.mtimeMs === after.mtimeMs && before.size === after.size);
      const checksum = digest.digest('hex'), row = owners.get(key);
      let classification = !row ? 'orphan' : 'unresolved';
      if (row && row.storage_key === key && area === 'ready' && row.status === 'ready' && row.scan_status === 'clean' && !row.deleted_at && row.size === offset && row.checksum === checksum) classification = 'ready';
      else if (row && area === 'quarantine' && row.storage_key === key && row.status === 'quarantined' && row.size === offset && row.checksum === checksum) classification = 'quarantined';
      descriptors.push({ area, key, size: offset, checksum, classification, resource_id: row?._id || null });
    } finally { await handle.close(); }
  }
  const missing = resources.filter(row => !row.deleted_at && ['ready','quarantined'].includes(row.status) && !descriptors.some(f => f.key === row.storage_key && f.area === (row.status === 'ready' ? 'ready' : 'quarantine'))).map(row => row._id);
  return { descriptors, missing, total };
}
async function emitBytes(archive, kind, identity, bytes) {
  for (let offset = 0, part = 0; offset < bytes.length || part === 0; offset += CHUNK, part++) await archive.frame({ kind, ...identity, part, last: offset + CHUNK >= bytes.length, data: bytes.subarray(offset, offset + CHUNK).toString('base64') });
}
async function registerPublishedBackup(db, file, key, root, maintenanceToken, gate, replayed, checkpoint) {
  const handle = await openFile(file);
  try {
    const { manifest, manifestHash } = await authenticate(handle, key, undefined, undefined, checkpoint);
    ensure(manifest.environment_id === gate.environmentId && manifest.source_database === db.databaseName && manifest.source_cluster_hash === await ledgerApi.readDatabaseClusterIdentity(db) && manifest.source_root_hash === hash(root), 'BACKUP_SOURCE_MISMATCH');
    try {
      await control.assertMaintenance(db, maintenanceToken);
      checkpoint();
      await ledgerApi.registerCompletedBackup(db, { backupId: manifest.backup_id, manifestHash, createdAt: new Date(manifest.created_at), dbBytes: manifest.db_bytes, fileCount: manifest.files.length, ledgerSequence: manifest.ledger_sequence, maintenanceToken });
    } catch (error) {
      if (error.message === 'BACKUP_MAINTENANCE_TIMEOUT') ensure(false, 'BACKUP_MAINTENANCE_TIMEOUT');
      ensure(false, 'BACKUP_PUBLISHED_UNREGISTERED:' + manifest.backup_id + ':retry the same authenticated file under maintenance; never overwrite');
    }
    return { command: 'backup', backup_id: manifest.backup_id, manifest_hash: manifestHash, created_at: manifest.created_at, db_bytes: manifest.db_bytes, files: manifest.files.length, unresolved: manifest.files.filter(f => !['ready','quarantined'].includes(f.classification)).length + manifest.missing.length, registered: true, replayed };
  } finally { await handle.close(); }
}

async function backup({ client, db, file, key, root, maintenanceToken }) {
  db = objectIdDatabase(db);
  await requireReplicaSet(db);
  ensure(/^kl_test_[\w-]+$/.test(db.databaseName), 'LOCAL_DATABASE_REQUIRED');
  const gate = await control.assertMaintenance(db, maintenanceToken);
  const maintenance = await db.collection('operational_state').findOne({ _id: 'environment', mode: 'maintenance', maintenance_token: maintenanceToken, environment_id: gate.environmentId });
  ensure(maintenance?.updated_at instanceof Date && Number.isFinite(maintenance.updated_at.getTime()), 'BACKUP_MAINTENANCE_TIMEOUT');
  const maintenanceDeadline = maintenance.updated_at.getTime() + 30 * 60 * 1000;
  const checkpoint = () => ensure(Date.now() < maintenanceDeadline, 'BACKUP_MAINTENANCE_TIMEOUT');
  checkpoint();
  await schema.assertSchema(db);
  if (process.env.KL_STANDALONE_RECOVERY_ENABLED === 'true') await require('../server/dist/training/standalone-recovery-lifecycle').assertRecoveryQuiescent(db);
  root = await storageAccess.sourceRoot(root); const registry = schema.systemBackupRegistry();
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name);
  ensure(names.length === registry.collections.length + registry.excluded.filter(n => !registry.collections.includes(n)).length && names.every(n => registry.collections.includes(n) || registry.excluded.includes(n)), 'UNKNOWN_COLLECTION');
  const safety = await ledgerApi.readSafetyLedger(gate.environmentId, 0); ensure(!safety.pending, 'SUPPRESSION_LEDGER_REQUIRED');
  let published = false;
  try { await fs.lstat(file); published = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (published) return registerPublishedBackup(db, file, key, root, maintenanceToken, gate, true, checkpoint);
  const manifest = { format: 1, backup_id: crypto.randomUUID(), environment_id: gate.environmentId, source_database: db.databaseName, source_cluster_hash: await ledgerApi.readDatabaseClusterIdentity(db), source_root_hash: hash(root), created_at: new Date().toISOString(), registry, ledger_sequence: safety.sequence, db_bytes: 0, counts: {}, files: [], missing: [] };
  const archive = await createArchive(file, key, checkpoint); const session = client.startSession(); const resources = [];
  try {
    await archive.frame({ kind: 'header', manifest });
    session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    const deadline = Date.now() + 45000;
    for (const name of registry.collections.filter(n => !registry.excluded.includes(n))) {
      checkpoint();
      manifest.counts[name] = 0;
      for await (const row of rawDatabase(db).collection(name).find({}, { session, maxTimeMS: 45000, promoteValues: false, promoteLongs: false }).batchSize(20)) {
        ensure(Date.now() < deadline, 'BACKUP_SNAPSHOT_TIMEOUT');
        const bytes = BSON.serialize(row); manifest.db_bytes += bytes.length; ensure(manifest.db_bytes <= MAX_DB, 'BACKUP_LIMIT_EXCEEDED');
        await emitBytes(archive, 'db', { collection: name, index: manifest.counts[name]++ }, bytes);
        if (name === 'file_resources') resources.push(decodeDocument(BSON.deserialize(bytes), name));
      }
    }
    ensure(Date.now() < deadline, 'BACKUP_SNAPSHOT_TIMEOUT'); await session.commitTransaction();
    const inventory = await filesInventory(root, resources, checkpoint); manifest.files = inventory.descriptors; manifest.missing = inventory.missing;
    for (const descriptor of manifest.files) {
      checkpoint();
      const handle = await storageAccess.openSource(root,descriptor.area,descriptor.key);
      try {
        const digest = crypto.createHash('sha256'); let position = 0, part = 0; const buffer = Buffer.allocUnsafe(CHUNK);
        do { const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, descriptor.size - position), position); ensure(bytesRead > 0 || descriptor.size === 0); const bytes = buffer.subarray(0, bytesRead); digest.update(bytes); position += bytesRead; await archive.frame({ kind: 'file', area: descriptor.area, key: descriptor.key, part: part++, last: position === descriptor.size, data: bytes.toString('base64') }); } while (position < descriptor.size);
        ensure(digest.digest('hex') === descriptor.checksum && (await handle.stat()).size === descriptor.size);
      } finally { await handle.close(); }
    }
    const finalInventory = await filesInventory(root, resources, checkpoint); ensure(JSON.stringify(finalInventory.descriptors) === JSON.stringify(manifest.files));
    const finalGate = await control.assertMaintenance(db, maintenanceToken); ensure(finalGate.revision === gate.revision);
    const latest = await ledgerApi.readSafetyLedger(gate.environmentId, safety.sequence); ensure(!latest.pending && latest.sequence === safety.sequence, 'SUPPRESSION_LEDGER_REQUIRED');
    checkpoint();
    await archive.publish(manifest);
    return await registerPublishedBackup(db, file, key, root, maintenanceToken, gate, false, checkpoint);
  } catch (e) { if (session.inTransaction()) await session.abortTransaction(); await archive.abort(); throw e; } finally { await session.endSession(); }
}
async function authenticate(handle, key, onDocument = async () => {}, onFile = async () => {}, checkpoint = () => {}) {
  const supported = schema.supportedSystemBackupRegistries(); let registry = null, header = null, active = null, dbBytes = 0, totalFiles = 0, filePhase = false, lastCollection = -1, counts = null; const files = []; const fileKeys = new Set(); const markers = new Set();
  const result = await readArchive(handle, key, async record => {
    if (!header) {
      exact(record, ['kind','manifest']); ensure(record.kind === 'header'); header = record.manifest;
      exact(header, ['format','backup_id','environment_id','source_database','source_cluster_hash','source_root_hash','created_at','registry','ledger_sequence','db_bytes','counts','files','missing']);
      registry = supported.find(candidate => JSON.stringify(header.registry) === JSON.stringify(candidate));
      ensure(registry, 'BACKUP_REGISTRY_UNSUPPORTED');
      counts = Object.fromEntries(registry.collections.filter(name => !registry.excluded.includes(name)).map(name => [name, 0]));
      return;
    }
    ensure(record.kind === 'db' || record.kind === 'file'); exact(record, record.kind === 'db' ? ['kind','collection','index','part','last','data'] : ['kind','area','key','part','last','data']);
    ensure(Number.isSafeInteger(record.part) && record.part >= 0 && typeof record.last === 'boolean' && typeof record.data === 'string' && record.data.length <= Math.ceil(CHUNK / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(record.data));
    const bytes = Buffer.from(record.data, 'base64'); ensure(bytes.toString('base64') === record.data && bytes.length <= CHUNK);
    const identity = record.kind === 'db' ? record.collection + ':' + record.index : record.area + ':' + record.key;
    if (!active) {
      ensure(record.part === 0);
      if (record.kind === 'db') { const index = Object.keys(counts).indexOf(record.collection); ensure(!filePhase && index >= lastCollection && index >= 0 && record.index === counts[record.collection]); lastCollection = index; }
      else { filePhase = true; ensure(AREAS.includes(record.area) && KEY.test(record.key) && !fileKeys.has(identity) && files.length < 1000); fileKeys.add(identity); }
      active = { identity, kind: record.kind, parts: [], size: 0, part: 0, hash: crypto.createHash('sha256') };
    }
    ensure(active.identity === identity && active.kind === record.kind && record.part === active.part++); active.size += bytes.length;
    ensure(active.size <= (record.kind === 'db' ? 16 * 1024 ** 2 : MAX_FILE), 'BACKUP_LIMIT_EXCEEDED'); active.hash.update(bytes);
    if (record.kind === 'db') { dbBytes += bytes.length; ensure(dbBytes <= MAX_DB, 'BACKUP_LIMIT_EXCEEDED'); active.parts.push(bytes); }
    else { totalFiles += bytes.length; ensure(totalFiles <= MAX_FILES, 'BACKUP_LIMIT_EXCEEDED'); await onFile(record, bytes); }
    if (record.last) {
      if (record.kind === 'db') {
        const doc = BSON.deserialize(Buffer.concat(active.parts), { promoteLongs: false, promoteValues: false });
        if (record.collection === 'schema_migrations') {
          const version = Number(doc.version);
          ensure(Number.isSafeInteger(version) && !markers.has(version) && registry.checksums[String(version)] === doc.checksum &&
            doc.status === 'completed' && doc.completed_at instanceof Date && Number.isFinite(doc.completed_at.getTime()), 'BACKUP_SCHEMA_MARKER_INVALID');
          markers.add(version);
        }
        counts[record.collection]++; await onDocument(record.collection, doc);
      }
      else files.push({ area: record.area, key: record.key, size: active.size, checksum: active.hash.digest('hex') });
      active = null;
    }
  }, checkpoint);
  ensure(header && !active); const manifest = result.manifest;
  exact(manifest, ['format','backup_id','environment_id','source_database','source_cluster_hash','source_root_hash','created_at','registry','ledger_sequence','db_bytes','counts','files','missing']);
  ensure(manifest.format === 1 && KEY.test(manifest.backup_id) && UUID.test(manifest.environment_id) && /^kl_test_[\w-]+$/.test(manifest.source_database) && /^[a-f0-9]{64}$/.test(manifest.source_cluster_hash) && /^[a-f0-9]{64}$/.test(manifest.source_root_hash) && typeof manifest.created_at === 'string' && Number.isFinite(Date.parse(manifest.created_at)));
  ensure(Number.isSafeInteger(manifest.ledger_sequence) && manifest.ledger_sequence >= 0 && JSON.stringify(manifest.registry) === JSON.stringify(registry) && manifest.db_bytes === dbBytes && JSON.stringify(manifest.counts) === JSON.stringify(counts));
  ensure(Object.keys(registry.checksums).filter(version => Number(version) >= 10).every(version => markers.has(Number(version))), 'BACKUP_SCHEMA_MARKER_INVALID');
  for (const field of ['format','backup_id','environment_id','source_database','source_cluster_hash','source_root_hash','created_at','registry','ledger_sequence']) ensure(JSON.stringify(header[field]) === JSON.stringify(manifest[field]));
  ensure(Array.isArray(manifest.files) && manifest.files.length === files.length && Array.isArray(manifest.missing) && manifest.missing.every(id => OID.test(id)));
  manifest.files.forEach((f, index) => { exact(f, ['area','key','size','checksum','classification','resource_id']); ensure(['ready','quarantined','unresolved','orphan'].includes(f.classification) && (f.resource_id === null || OID.test(f.resource_id))); for (const field of ['area','key','size','checksum']) ensure(f[field] === files[index][field]); });
  return result;
}
function transform(name, row) {
  const now = new Date();
  if (name === 'users') { row.status = 'disabled'; row.must_change_password = true; row.temporary_password_expires_at = new Date(0); row.credential_version = Number(row.credential_version) + 1; row.identity_revision = Number(row.identity_revision) + 1; row.updated_at = now; }
  if (name === 'auth_email_identities') { row.state = 'needs_reverify'; row.verified_at = null; row.revision = Number(row.revision) + 1; row.updated_at = now; }
  if (name === 'organization_members') { row.status = 'disabled'; row.authorization_revision = Number(row.authorization_revision) + 1; row.updated_at = now; }
  if (name === 'outbox_events' && row.status === 'running') { row.status = 'pending'; row.lease_owner = row.lease_token = row.lease_until = null; row.available_at = now; row.updated_at = now; }
  if (name === 'knowledge_import_jobs') { row.preview=[]; row.warnings=[]; row.lease_token=row.lease_until=null; if(row.status!=='applied'){row.status='failed';row.error_code='IMPORT_RESTORE_INVALIDATED';row.generation=Number(row.generation)+1;row.revision=Number(row.revision)+1;} row.updated_at=now; }
  if (name === 'knowledge_outbox') { row.status = 'pending'; row.generation = Number(row.generation) + 1; row.lease_token = row.lease_until = null; row.error_code = ''; row.updated_at = now; }
  if (name === 'student_projection_states') { row.lease_owner = row.lease_token = row.lease_until = null; }
  if (name === 'learning_projection_builds' && row.status === 'building') { row.status = 'abandoned'; row.updated_at = now; }
  if (name === 'file_resources') {
    row.lease_token = row.lease_until = row.upload_lease_token = row.upload_lease_until = row.deletion_lease_token = row.deletion_lease_until = null;
    if (row.scan_status === 'scanning') { row.scan_status = Number(row.scan_attempt) < 3 ? 'queued' : 'failed'; row.error_code = 'SCAN_INTERRUPTED'; row.available_at = now; row.updated_at = now; }
  }
  return row;
}
async function restore({ client, db, file, key, root }) {
  db = objectIdDatabase(db);
  await requireReplicaSet(db);
  ensure(/^kl_restore_[\w-]+$/.test(db.databaseName));
  const handle = await openFile(file); let output = null;
  try {
    const verified = await authenticate(handle, key), manifest = verified.manifest;
    ensure(process.env.KL_ENVIRONMENT_ID === manifest.environment_id, 'ENVIRONMENT_MISMATCH');
    ensure(db.databaseName !== manifest.source_database && hash(path.resolve(root)) !== manifest.source_root_hash, 'RESTORE_SOURCE_TARGET_COLLISION');
    const safety = await ledgerApi.readSafetyLedger(manifest.environment_id, manifest.ledger_sequence);
    ensure((await db.listCollections({}, { nameOnly: true }).toArray()).length === 0, 'RESTORE_TARGET_NOT_EMPTY');
    root = await fileRoot(root, true); await schema.initializeRestoreSchema(db);
    const restoreId = newId(); await control.quarantineRestore(db, { environmentId: manifest.environment_id, restoreId });
    const now = new Date(); const run = { _id: restoreId, environment_id: manifest.environment_id, status: 'quarantined', manifest_hash: verified.manifestHash, file_root_hash: hash(await fs.realpath(root)), ledger_sequence: safety.sequence, revision: 0, checks: { schema: false, files: false, ledger: false, identities: false, smoke: false }, created_at: now, updated_at: now };
    await db.collection('backup_restore_runs').insertOne(run);
    try {
      const second = await authenticate(handle, key, async (name, row) => { if (!SKIP_IMPORT.has(name) && name !== 'knowledge_sources') await db.collection(name).insertOne(transform(name, row)); }, async (record, bytes) => {
        if (record.part === 0) output = await fs.open(path.join(root, record.area, record.key), 'wx', 0o600);
        await writeAll(output, bytes); if (record.last) { await output.sync(); await output.close(); output = null; }
      });
      ensure(second.manifestHash === verified.manifestHash);
      const emailMarker = await db.collection('schema_migrations').findOne({ version: 22 });
      if (manifest.registry.version < 22) {
        ensure(!emailMarker, 'BACKUP_REGISTRY_UNSUPPORTED');
        await db.collection('schema_migrations').insertOne({ _id: newId(), version: 22, checksum: schema.AUTH_EMAIL_CHECKSUM, status: 'completed', lease_token: null, lease_until: null, created_at: now, started_at: now, completed_at: now, failed_at: null });
      } else ensure(emailMarker?.status === 'completed' && emailMarker.checksum === schema.AUTH_EMAIL_CHECKSUM && emailMarker.completed_at instanceof Date, 'BACKUP_REGISTRY_UNSUPPORTED');
      // Apply external holds/erasures before any reconciliation or physical deletion.
      const latest = await ledgerApi.readSafetyLedger(manifest.environment_id, safety.sequence); await ledgerApi.applySafetyLedger(db, latest);
      await db.collection('backup_restore_runs').updateOne({ _id: restoreId }, { $set: { ledger_sequence: latest.sequence, updated_at: new Date() } });
      return { command: 'restore', restore_id: restoreId, status: 'quarantined', manifest_hash: verified.manifestHash, ledger_sequence: latest.sequence, pending: latest.pending };
    } catch (error) { await db.collection('backup_restore_runs').updateOne({ _id: restoreId }, { $set: { status: 'failed', updated_at: new Date() } }); throw error; }
  } finally { if (output) await output.close(); await handle.close(); }
}
async function reconcileDeletedFiles(db, manifest, root, minimumSequence) {
  return ledgerApi.runWithCurrentSafetyLedger(manifest.environment_id, minimumSequence, async safety => {
    await ledgerApi.applySafetyLedger(db, safety);
    if (safety.pending) return safety;
    const deleted = new Set(safety.entries.filter(entry => entry.state === 'committed' && entry.action === 'file.deleted').map(entry => entry.resourceId));
    for (const id of deleted) {
      const row = await db.collection('file_resources').findOne({ _id: id });
      if (!row || row.legal_hold || !(row.retention_until instanceof Date) || row.retention_until > new Date()) continue;
      // Source deletion evidence does not prove an older restored snapshot is unreferenced.
      const session = db.client.startSession(); let authorized = false;
      try {
        await session.withTransaction(async () => {
          authorized = false;
          const state = await db.collection('operational_state').findOne({ _id: 'environment', environment_id: manifest.environment_id, mode: 'restore_quarantined' }, { session });
          ensure(state, 'RESTORE_QUARANTINED');
          if (await fileReferenced(db, id, session)) return;
          const ownerCollection = row.owner_type === 'textbook' ? 'textbook_editions' : row.owner_type === 'question' ? 'question_versions' : row.owner_type === 'coursework' ? 'coursework_heads' : null;
          if (!ownerCollection) return;
          const owner = await db.collection(ownerCollection).findOne({ _id: row.owner_version_id, org_id: row.org_id }, { session });
          const coursework = row.owner_type === 'coursework';
          if (!owner || (coursework && (process.env.KL_COURSEWORK_FILES_ENABLED !== 'true' || owner.user_id !== row.created_by)) || !Number.isSafeInteger(coursework ? owner.revision : owner.access_revision)) return;
          ensure((await db.collection(ownerCollection).updateOne({ _id: owner._id, org_id: row.org_id, ...(coursework ? { revision: owner.revision } : { access_revision: owner.access_revision }) }, { $inc: coursework ? { revision: 1 } : { access_revision: 1 } }, { session })).matchedCount === 1, 'OWNER_FENCE_CONFLICT');
          ensure((await db.collection('operational_state').updateOne({ _id: 'environment', mode: 'restore_quarantined', restore_id: state.restore_id }, { $inc: { access_fence: 1 } }, { session })).matchedCount === 1, 'RESTORE_QUARANTINED');
          authorized = true;
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      } finally { await session.endSession(); }
      if (!authorized) continue;
      const descriptors = manifest.files.filter(descriptor => descriptor.resource_id === id);
      for (const descriptor of descriptors) {
        const filename = path.join(root, descriptor.area, descriptor.key); let handle;
        try { handle = await openFile(filename, root); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        try {
          const before = await handle.stat(), digest = crypto.createHash('sha256');
          for await (const bytes of handle.createReadStream({ autoClose: false })) digest.update(bytes);
          ensure(before.size === descriptor.size && digest.digest('hex') === descriptor.checksum);
          const current = await fs.lstat(filename); ensure(current.ino === before.ino && current.dev === before.dev && current.nlink === 1 && !current.isSymbolicLink());
        } finally { await handle.close(); }
        await fs.unlink(filename);
      }
      await db.collection('file_resources').updateOne({ _id: id, legal_hold: false }, { $set: { status: 'deleting', deleted_at: row.deleted_at || new Date(), deletion_lease_token: null, deletion_lease_until: null, updated_at: new Date() } });
    }
    return safety;
  });
}

async function verifyRestore({ db, file, key, root, restoreId, apply = false }) {
  db = objectIdDatabase(db);
  await requireReplicaSet(db);
  const handle = await openFile(file);
  try {
    const { manifest, manifestHash } = await authenticate(handle, key);
    const state = await db.collection('operational_state').findOne({ _id: 'environment' });
    const run = await db.collection('backup_restore_runs').findOne({ _id: restoreId });
    ensure(state?.mode === 'restore_quarantined' && state.restore_id === restoreId && run && run.status !== 'failed' && run.manifest_hash === manifestHash && run.environment_id === manifest.environment_id, 'RESTORE_QUARANTINED');
    root = await fileRoot(root);
    ensure(run.file_root_hash === hash(await fs.realpath(root)), 'RESTORE_FILE_ROOT_MISMATCH');
    const safety = apply ? await reconcileDeletedFiles(db, manifest, root, manifest.ledger_sequence) : await ledgerApi.readSafetyLedger(manifest.environment_id, manifest.ledger_sequence);
    await schema.assertSchema(db);
    const registry = schema.systemBackupRegistry();
    ensure((await db.listCollections({}, { nameOnly: true }).toArray()).every(row => registry.collections.includes(row.name) || registry.excluded.includes(row.name)), 'UNKNOWN_COLLECTION');
    const resources = await db.collection('file_resources').find({}).toArray(); const inventory = await filesInventory(root, resources);
    const suppressed = new Set(resources.filter(row => row.deleted_at && !row.legal_hold).map(row => row._id));
    const expected = manifest.files.filter(descriptor => !suppressed.has(descriptor.resource_id));
    let files = manifest.missing.filter(id => !suppressed.has(id)).length === 0 && inventory.missing.length === 0 && inventory.descriptors.length === expected.length;
    for (const descriptor of expected) { const actual = inventory.descriptors.find(f => f.area === descriptor.area && f.key === descriptor.key); if (!actual || actual.checksum !== descriptor.checksum || actual.size !== descriptor.size || !['ready','quarantined'].includes(actual.classification)) files = false; }
    const emptyAuthorization = ['member_roles', 'member_capability_grants', 'administrative_grants',
      'authorization_requests', 'administration_operations', 'auth_sessions', 'auth_email_challenges', 'auth_invitations', 'auth_mail_outbox'];
    const identities = await db.collection('users').countDocuments({ status: { $ne: 'disabled' } }) === 0
      && await db.collection('organization_members').countDocuments({ status: { $ne: 'disabled' } }) === 0
      && await db.collection('auth_email_identities').countDocuments({ $or: [{ state: { $ne: 'needs_reverify' } }, { verified_at: { $ne: null } }] }) === 0
      && await db.collection('administration_guard').countDocuments({ _id: 'administration', state: 'idle', operation_id: null, recovery_token: null,
        'blocked_targets.user_ids': [], 'blocked_targets.member_ids': [], 'blocked_targets.org_ids': [],
        'blocked_targets.global': false, affected_orgs: [] }) === 1
      && (await Promise.all(emptyAuthorization.map(name => db.collection(name).findOne({}, { projection: { _id: 1 } })))).every(row => row === null);
    const noWriters = await db.collection('operational_writers').countDocuments({ state: 'running' }) === 0;
    const noKnowledgeLeases = process.env.KL_KNOWLEDGE_ENABLED !== 'true' || (await db.collection('knowledge_outbox').countDocuments({ $or: [{ status: 'running' }, { lease_token: { $ne: null } }, { lease_until: { $ne: null } }] }) === 0);
    const noImportLeases = process.env.KL_KNOWLEDGE_IMPORT_ENABLED !== "true" || (await db.collection("knowledge_import_jobs").countDocuments({$or:[{status:"running"},{lease_token:{$ne:null}},{lease_until:{$ne:null}}]})===0);
    let recoveryFresh=true;
    if(process.env.KL_STANDALONE_RECOVERY_ENABLED==='true') {
      const recovery=require('../server/dist/training/standalone-recovery-lifecycle.js');
      await recovery.assertRecoveryQuiescent(db);
      recoveryFresh=(await Promise.all(recovery.RECOVERY_COLLECTIONS.filter(name=>name!=='training_standalone_writer').map(name=>db.collection(name).countDocuments({})))).every(count=>count===0);
    }
    const noLeases = recoveryFresh && noImportLeases && noKnowledgeLeases && await db.collection('outbox_events').countDocuments({ status: 'running' }) === 0 && await db.collection('student_projection_states').countDocuments({ lease_token: { $ne: null } }) === 0 && await db.collection('learning_projection_builds').countDocuments({ status: 'building' }) === 0;
    const ledgerCurrent = !safety.pending && (apply || safety.sequence === run.ledger_sequence);
    const checks = { schema: true, files, identities, ledger: ledgerCurrent, smoke: noWriters && noLeases && files && identities && ledgerCurrent };
    let blockedReferences = 0;
    for (const row of resources) if (row.status === 'deleting' && !row.deleted_at && await fileReferenced(db, row._id, undefined)) blockedReferences++;
    if (blockedReferences) { files = false; checks.files = false; checks.smoke = false; }
    const ready = Object.values(checks).every(Boolean);
    const remainingActions = [...(!files ? ['FILE_RECONCILIATION_REQUIRED'] : []), ...(blockedReferences ? ['FILE_REFERENCE_RECONCILIATION_REQUIRED'] : []), ...(!ledgerCurrent ? ['SAFETY_LEDGER_RECONCILIATION_REQUIRED'] : [])];
    if (apply) ensure((await db.collection('backup_restore_runs').updateOne({ _id: restoreId, revision: run.revision }, { $set: { status: ready ? 'ready' : 'quarantined', checks, ledger_sequence: safety.sequence, updated_at: new Date() }, $inc: { revision: 1 } })).matchedCount === 1, 'RESTORE_REVISION_CONFLICT');
    return { command: apply ? 'verify' : 'inspect', restore_id: restoreId, status: ready ? 'ready' : 'quarantined', manifest_hash: manifestHash, ledger_sequence: safety.sequence, checks, environment_revision: state.revision, blocked_references: blockedReferences, remaining_actions: remainingActions };
  } finally { await handle.close(); }
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') { console.log('LOCAL/SYNTHETIC: inspect --file <encrypted> (SYSTEM_BACKUP_KEY only; no DB connection). backup|restore --file <encrypted>. verify --file <encrypted> --restore-id <ObjectId>. release --file <encrypted> --restore-id <ObjectId> --actor <actor> --reason <reason>. Commands require MONGODB_URI and managed independent ledger. Backup reads FILE_STORAGE_DRIVER (local FILE_STORAGE_ROOT or S3); restore/verify require an explicit offline local FILE_STORAGE_ROOT. Restore never uploads to live S3 or grants identities.'); return; }
  ensure(['backup','restore','inspect','verify','release'].includes(command)); const options = {};
  for (let i = 0; i < args.length; i += 2) { ensure(['--file','--restore-id','--actor','--reason'].includes(args[i]) && args[i + 1] && !Object.hasOwn(options, args[i])); options[args[i]] = args[i + 1]; }
  const allowed = command === 'inspect' || command === 'backup' || command === 'restore' ? ['--file'] : command === 'verify' ? ['--file','--restore-id'] : ['--file','--restore-id','--actor','--reason'];
  ensure(Object.keys(options).every(option => allowed.includes(option)), 'INVALID_COMMAND_OPTIONS');
  if (command === 'verify' || command === 'release') ensure(OID.test(options['--restore-id'] || ''), 'RESTORE_ID_REQUIRED');
  ensure(options['--file'] && /^[a-fA-F0-9]{64}$/.test(process.env.SYSTEM_BACKUP_KEY || ''), 'BACKUP_KEY_REQUIRED');
  const key = Buffer.from(process.env.SYSTEM_BACKUP_KEY, 'hex'); delete process.env.SYSTEM_BACKUP_KEY;
  let client;
  try {
    if (command === 'inspect') {
      const handle = await openFile(path.resolve(options['--file']));
      try {
        const { manifest, manifestHash } = await authenticate(handle, key);
        console.log(JSON.stringify({ command: 'inspect', format: manifest.format, backup_id: manifest.backup_id, schema_version: manifest.registry.version, created_at: manifest.created_at, manifest_hash: manifestHash, db_bytes: manifest.db_bytes, counts: manifest.counts, file_count: manifest.files.length, file_bytes: manifest.files.reduce((sum, file) => sum + file.size, 0), unresolved_files: manifest.files.filter(file => !['ready','quarantined'].includes(file.classification)).length, missing_files: manifest.missing.length, ledger_checkpoint: manifest.ledger_sequence, latest_ledger_verified: false }));
      } finally { await handle.close(); }
      return;
    }
    const name = uriDatabase(process.env.MONGODB_URI, command !== 'backup'); client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 }); await client.connect(); const db = objectIdDatabase(client.db(name));
    ensure(typeof (await db.admin().command({ hello: 1 })).setName === 'string', 'LOCAL_REPLICA_SET_REQUIRED');
    const input = { client, db, file: path.resolve(options['--file']), key, root: process.env.FILE_STORAGE_ROOT, restoreId: options['--restore-id'], maintenanceToken: process.env.KL_MAINTENANCE_TOKEN };
    let report;
    if (command === 'backup') report = await backup(input);
    else if (command === 'restore') report = await restore(input);
    else if (command === 'release') {
      ensure(options['--actor'] && options['--reason']); const evidence = await verifyRestore({ ...input, apply: true }); ensure(evidence.status === 'ready', 'RESTORE_READINESS_FAILED');
      report = await control.releaseRestoredLocal(client, db, { restoreId: input.restoreId, actor: options['--actor'], reason: options['--reason'], expectedRevision: evidence.environment_revision, manifestHash: evidence.manifest_hash, ledgerSequence: evidence.ledger_sequence });
    } else report = await verifyRestore({ ...input, apply: command === 'verify' });
    console.log(JSON.stringify(report));
  } finally { key.fill(0); if (client) await client.close(); }
}
module.exports = { backup, restore, verifyRestore, authenticate, uriDatabase, filesInventory };
if (require.main === module) main().catch(error => { console.error(error.safe ? error.message : 'BACKUP_OPERATION_FAILED: target remains isolated; sensitive details withheld'); process.exitCode = 1; });
