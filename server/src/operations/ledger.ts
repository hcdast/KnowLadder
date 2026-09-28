import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import type { ClientSession, Db, Document } from 'mongodb';
import { setTimeout as delay } from 'node:timers/promises';
import { assertLocalEnvironment, requireActor } from './contracts';
import { assertMaintenance } from './control';
import { suppressRestoredSubject } from '../privacy/execution';
import { assertWindowsPrivateDirectory } from '../security/private-directory';
export type SafetyAction = 'subject.erase' | 'content.revoke' | 'file.hold' | 'file.retention' | 'file.deleted';
export interface SafetyIntent { operationId: string; action: SafetyAction; subjectId?: string; resourceId?: string; resourceType?: 'textbook' | 'question' | 'file'; revision?: number; retentionUntil?: Date; hold?: boolean; privacyRequestId?: string; privacyPolicyRevision?: 'local_privacy_v1'; privacyRetentionBasis?: 'local_minimal_provenance' | 'local_hold_and_provenance'; }
export interface SafetyReservation { operationId: string; sequence: number; environmentId: string; }
export interface SafetyLedger { environmentId: string; sequence: number; pending: boolean; entries: Array<SafetyIntent & { sequence: number; state: 'pending' | 'committed' | 'aborted' }>; }
type Row = Document & { _id: string };
type StoredIntent = Omit<SafetyIntent, 'retentionUntil'> & { retentionUntil?: string };
interface DatabaseBinding { databaseName: string; cluster: string; }
interface Event { version: 1; environmentId: string; source: string; sourceCluster: string; generation: number; sequence: number; previous: string | null; intent: StoredIntent | null; state: 'pending' | 'committed' | 'aborted' | 'genesis'; baseline: string | null; actor: string | null; reason: string | null; }
interface Head extends Row { source: string; sourceCluster: string; roots: string[]; fileRoot: string | null; generation: number; sequence: number; hash: string; lock: string | null; ownerLaunchToken: string | null; acceptedDatabases: DatabaseBinding[]; }
interface LedgerConfiguration { environmentId: string; roots: string[]; key: Buffer; uri: string; }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function safetyOperationId(value: string): string { if (!value || value.length > 8192) deny(); const hex = digest(value); return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`; }
function deny(): never { throw new Error('SAFETY_LEDGER_UNAVAILABLE'); }
function id(value: unknown): asserts value is string { if (typeof value !== 'string' || !uuid.test(value)) deny(); }
function integer(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 0) deny(); }
function normalize(intent: SafetyIntent): StoredIntent {
  if (!intent || Object.keys(intent).some(k => !['operationId','action','subjectId','resourceId','resourceType','revision','retentionUntil','hold','privacyRequestId','privacyPolicyRevision','privacyRetentionBasis'].includes(k))) deny();
  id(intent.operationId); const result: StoredIntent = { operationId: intent.operationId, action: intent.action };
  if (intent.action === 'subject.erase') { id(intent.subjectId); result.subjectId = intent.subjectId; if (intent.resourceId !== undefined || intent.resourceType !== undefined) deny(); }
  else { id(intent.resourceId); result.resourceId = intent.resourceId; if (intent.subjectId !== undefined) deny();
    if (intent.action === 'content.revoke') { if (!['textbook','question'].includes(intent.resourceType ?? '')) deny(); }
    else if (!['file.hold','file.retention','file.deleted'].includes(intent.action) || intent.resourceType !== 'file') deny(); result.resourceType = intent.resourceType;
  }
  if (intent.privacyRequestId !== undefined || intent.privacyPolicyRevision !== undefined || intent.privacyRetentionBasis !== undefined) {
    id(intent.privacyRequestId);
    if (intent.action !== 'subject.erase' || intent.privacyPolicyRevision !== 'local_privacy_v1' || !['local_minimal_provenance','local_hold_and_provenance'].includes(intent.privacyRetentionBasis ?? '')) deny();
    result.privacyRequestId = intent.privacyRequestId; result.privacyPolicyRevision = intent.privacyPolicyRevision; result.privacyRetentionBasis = intent.privacyRetentionBasis;
  }
  if (intent.revision !== undefined) { integer(intent.revision); result.revision = intent.revision; }
  if (intent.action === 'file.hold') { if (typeof intent.hold !== 'boolean') deny(); result.hold = intent.hold; } else if (intent.hold !== undefined) deny();
  if (intent.action === 'file.retention') { if (!(intent.retentionUntil instanceof Date) || !Number.isFinite(intent.retentionUntil.getTime())) deny(); result.retentionUntil = intent.retentionUntil.toISOString(); } else if (intent.retentionUntil !== undefined) deny(); return result;
}
function hydrate(intent: StoredIntent): SafetyIntent { return { ...intent, ...(intent.retentionUntil === undefined ? {} : { retentionUntil: new Date(intent.retentionUntil) }) } as SafetyIntent; }
function intentOnly(entry: SafetyLedger['entries'][number]): SafetyIntent { const { sequence: _sequence, state: _state, ...intent } = entry; return intent; }
function inside(base: string, child: string) { const relative = path.relative(base, child); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
async function privateRoot(value: string | undefined, create: boolean) {
  if (!value || !path.isAbsolute(value)) deny(); const root = path.resolve(value);
  if ([process.cwd(), path.resolve(__dirname, '../../..')].some(base => inside(base, root))) deny();
  if (create) await mkdir(root, { recursive: true, mode: 0o700 }); let cursor = root;
  for (;;) { const info = await lstat(cursor); if (info.isSymbolicLink() || !info.isDirectory()) deny();
    if (process.platform !== 'win32' && ((info.mode & (cursor === root ? 0o077 : 0o022)) !== 0 || (info.uid !== process.getuid!() && info.uid !== 0))) deny();
    if (path.dirname(cursor) === cursor) break; cursor = path.dirname(cursor);
  }
  const actual = path.resolve(await realpath(root)); if ((process.platform === 'win32' ? actual.toLowerCase() !== root.toLowerCase() : actual !== root)) deny();
  if (process.platform === 'win32') await assertWindowsPrivateDirectory(root); return root;
}
async function configuration(createRoots: boolean): Promise<LedgerConfiguration> {
  const environmentId = process.env.KL_ENVIRONMENT_ID; id(environmentId); const rawKey = process.env.KL_SAFETY_LEDGER_KEY; if (!rawKey || !/^[0-9a-f]{64}$/i.test(rawKey)) deny();
  const roots = await Promise.all([privateRoot(process.env.KL_SAFETY_LEDGER_ROOT,createRoots), privateRoot(process.env.KL_SAFETY_LEDGER_MIRROR_ROOT,createRoots)]); if (inside(roots[0], roots[1]) || inside(roots[1], roots[0])) deny();
  const uri = process.env.KL_CONTROL_MONGODB_URI; if (!uri || !/^mongodb:\/\//.test(uri)) deny();
  const parsed = new MongoClient(uri);
  if (!parsed.options.hosts?.length || parsed.options.hosts.some(host => !host.host || !['localhost','127.0.0.1','::1'].includes(host.host)) || !/^kl_control_[a-zA-Z0-9_-]+$/.test(parsed.db().databaseName) || !parsed.options.replicaSet || parsed.options.tlsAllowInvalidCertificates || parsed.options.tlsAllowInvalidHostnames || parsed.options.tlsInsecure) deny();
  return { environmentId, roots, key: Buffer.from(rawKey, 'hex'), uri };
}
const safeDomainErrors: Record<string, true> = {
  OPERATIONS_PENDING_LEDGER:true, OPERATIONS_LEDGER_NOT_CURRENT:true, OPERATIONS_RESTORE_NOT_VALIDATED:true,
  OPERATIONS_WRITERS_RUNNING:true, OPERATIONS_REVISION_CONFLICT:true, OPERATIONS_MAINTENANCE_REQUIRED:true,
  OPERATIONS_LOCAL_ONLY:true, OPERATIONS_LOOPBACK_REQUIRED:true, OPERATIONS_ENVIRONMENT_MISMATCH:true,
  OPERATIONS_INVALID_ID:true, OPERATIONS_ACTOR_REASON_REQUIRED:true, OPERATIONS_STATE_MISSING:true,
  BACKUP_MAINTENANCE_TIMEOUT:true,
};
async function authority<T>(work: (db: Db, config: LedgerConfiguration) => Promise<T>, createRoots = false): Promise<T> {
  let client: MongoClient | undefined;
  try { const config = await configuration(createRoots); client = new MongoClient(config.uri, { appName:process.env.KL_OPERATION_LAUNCH_TOKEN ? 'knowladder-ledger-managed' : 'knowladder-ledger-control', serverSelectionTimeoutMS: 5000, readConcern: { level: 'majority' }, writeConcern: { w: 'majority', j: true } }); await client.connect(); const hello = await client.db('admin').command({ hello: 1 }); if (!hello.setName) deny(); return await work(client.db(), config); }
  catch (error) {
    // Forward only fixed public machine codes, never driver/FS messages, causes or metadata.
    if (error instanceof Error && Object.hasOwn(safeDomainErrors,error.message)) throw new Error(error.message);
    return deny();
  } finally { try { await client?.close(); } catch { deny(); } }
}
const uuidSchema = { bsonType:'string', pattern:uuid.source };
const counterSchema = { bsonType:['int','long','double'], minimum:0, maximum:Number.MAX_SAFE_INTEGER, multipleOf:1 };
const headSchema = {
  $jsonSchema: { bsonType:'object', additionalProperties:false,
    required:['_id','source','sourceCluster','roots','fileRoot','generation','sequence','hash','lock','ownerLaunchToken','acceptedDatabases'],
    properties: {
      _id:uuidSchema, source:{bsonType:'string',pattern:'^kl_test_[a-zA-Z0-9_-]+$',maxLength:63}, sourceCluster:{bsonType:'string',pattern:'^[0-9a-f]{64}$'},
      roots:{bsonType:'array',minItems:2,maxItems:2,uniqueItems:true,items:{bsonType:'string',minLength:1,maxLength:4096}}, fileRoot:{bsonType:['string','null'],minLength:1,maxLength:4096},
      generation:counterSchema, sequence:counterSchema, hash:{bsonType:'string',pattern:'^[0-9a-f]{64}$'},
      lock:{bsonType:['string','null'],pattern:uuid.source}, ownerLaunchToken:{bsonType:['string','null'],pattern:uuid.source},
      acceptedDatabases:{bsonType:'array',minItems:1,maxItems:1024,uniqueItems:true,items:{bsonType:'object',additionalProperties:false,required:['databaseName','cluster'],properties:{databaseName:{bsonType:'string',pattern:'^kl_(test|restore)_[a-zA-Z0-9_-]+$',maxLength:63},cluster:{bsonType:'string',pattern:'^[0-9a-f]{64}$'}}}},
    },
  },
  $expr:{$and:[{$gte:['$generation','$sequence']},{$or:[{$ne:['$lock',null]},{$eq:['$ownerLaunchToken',null]}]},{$in:[{databaseName:'$source',cluster:'$sourceCluster'},'$acceptedDatabases']}]},
};
async function initialize(control: Db) {
  try { await control.createCollection('safety_ledger_heads', { validator: headSchema, validationLevel: 'strict', validationAction: 'error' }); } catch (error) { if ((error as { code?: number }).code !== 48) throw error; }
  const info = await control.listCollections({ name: 'safety_ledger_heads' }, { nameOnly:false }).next(); if (!info || !('options' in info) || JSON.stringify(info.options?.validator) !== JSON.stringify(headSchema) || info.options?.validationLevel !== 'strict' || info.options?.validationAction !== 'error') deny(); await control.collection('safety_ledger_heads').createIndex({ source: 1 }, { unique: true });
}
async function store(event: Event, config: LedgerConfiguration) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', config.key, iv); cipher.setAAD(Buffer.from(`KL_SAFETY_LEDGER_V1:${config.environmentId}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(event), 'utf8'), cipher.final()]); const bytes = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]); const hash = digest(bytes);
  for (const root of config.roots) { const handle = await open(path.join(root, `${hash}.ledger`), 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    if (process.platform !== 'win32') { const directory = await open(root, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  }
  return hash;
}
async function load(hash: string, config: LedgerConfiguration): Promise<Event> {
  if (!/^[0-9a-f]{64}$/.test(hash)) deny(); const copies: Buffer[] = [];
  for (const root of config.roots) { const filename = path.join(root, `${hash}.ledger`); const info = await lstat(filename); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 32768 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) deny();
    const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); try { const actual = await file.stat(); if (actual.ino !== info.ino || actual.dev !== info.dev) deny(); copies.push(await file.readFile()); } finally { await file.close(); }
  }
  if (!copies[0].equals(copies[1]) || digest(copies[0]) !== hash || copies[0].length < 29) deny(); const bytes = copies[0]; const decipher = createDecipheriv('aes-256-gcm', config.key, bytes.subarray(0,12)); decipher.setAAD(Buffer.from(`KL_SAFETY_LEDGER_V1:${config.environmentId}`)); decipher.setAuthTag(bytes.subarray(12,28));
  const event = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')) as Event;
  if (Object.keys(event).sort().join(',') !== 'actor,baseline,environmentId,generation,intent,previous,reason,sequence,source,sourceCluster,state,version' || event.version !== 1 || event.environmentId !== config.environmentId || !/^kl_(test|restore)_[a-zA-Z0-9_-]+$/.test(event.source) || !/^[0-9a-f]{64}$/.test(event.sourceCluster)) deny(); integer(event.generation); integer(event.sequence);
  if (event.baseline !== null && !/^[0-9a-f]{64}$/.test(event.baseline)) deny(); if (event.intent !== null && JSON.stringify(normalize(hydrate(event.intent))) !== JSON.stringify(event.intent)) deny(); return event;
}
async function snapshot(control: Db, config: LedgerConfiguration, environmentId: string) {
  if (environmentId !== config.environmentId) deny(); const head = await control.collection<Head>('safety_ledger_heads').findOne({ _id: environmentId });
  if (!head || JSON.stringify(head.roots) !== JSON.stringify(config.roots)) deny(); integer(head.generation); integer(head.sequence);
  const events: Event[] = []; let hash: string | null = head.hash;
  for (let generation = head.generation; generation >= 0; generation--) { if (!hash) deny(); const event = await load(hash, config); if (event.generation !== generation || !head.acceptedDatabases.some(binding => binding.databaseName === event.source && binding.cluster === event.sourceCluster)) deny(); events.push(event); hash = event.previous; }
  if (hash !== null) deny(); events.reverse();
  const entries = new Map<string, SafetyLedger['entries'][number]>(); const baselines = new Map<string, string>(); const origins = new Map<string,string>(); let sequence = 0;
  for (const event of events) {
    if (event.generation === 0) { if (event.source !== head.source || event.sourceCluster !== head.sourceCluster || event.state !== 'genesis' || event.intent !== null || event.sequence !== 0 || event.baseline !== null) deny(); continue; }
    if (!event.intent || !event.baseline) deny(); const intent = hydrate(event.intent); const prior = entries.get(intent.operationId);
    const origin = `${event.sourceCluster}:${event.source}`;
    if (event.state === 'pending') { if (prior || event.sequence !== sequence + 1) deny(); sequence++; baselines.set(intent.operationId, event.baseline); origins.set(intent.operationId,origin); }
    else if (!['committed','aborted'].includes(event.state) || !prior || prior.state !== 'pending' || prior.sequence !== event.sequence || JSON.stringify(normalize(intentOnly(prior))) !== JSON.stringify(event.intent) || baselines.get(intent.operationId) !== event.baseline || origins.get(intent.operationId) !== origin) deny();
    entries.set(intent.operationId, { ...intent, sequence: event.sequence, state: event.state as 'pending'|'committed'|'aborted' });
  }
  if (head.sequence !== sequence) deny(); const values = [...entries.values()];
  const ledger: SafetyLedger = { environmentId, sequence, pending: values.some(entry => entry.state === 'pending'), entries: values }; return { head, ledger, baselines, origins };
}
async function locked<T>(control: Db, environmentId: string, work: (token: string) => Promise<T>): Promise<T> {
  const token = randomUUID(); let acquired = false;
  const ownerLaunchToken = process.env.KL_OPERATION_LAUNCH_TOKEN ?? null; if (ownerLaunchToken !== null) id(ownerLaunchToken);
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await control.collection<Head>('safety_ledger_heads').updateOne({ _id:environmentId, lock:null },{ $set:{ lock:token, ownerLaunchToken } })).modifiedCount === 1) { acquired = true; break; }
    await delay(50);
  }
  if (!acquired) deny();
  try { return await work(token); } finally { if ((await control.collection<Head>('safety_ledger_heads').updateOne({ _id:environmentId, lock:token },{ $set:{ lock:null, ownerLaunchToken:null } })).modifiedCount !== 1) deny(); }
}
// Internal supervisor-only hook: caller must own and have observed the launched child's exit.
export async function releaseOwnedLedgerLock(environmentId: string, launchToken: string): Promise<void> {
  id(environmentId); id(launchToken);
  await authority(async (control,config) => {
    if (config.environmentId !== environmentId) deny();
    await snapshot(control,config,environmentId);
    await control.collection<Head>('safety_ledger_heads').updateOne({ _id:environmentId, ownerLaunchToken:launchToken, lock:{ $ne:null } },{ $set:{ lock:null, ownerLaunchToken:null } });
  });
}
async function sourceState(db: Db, intent: SafetyIntent, session?: ClientSession) {
  // Erasure starts with an atomic privacy_state+tombstone barrier. Unrelated auth
  // revision/session changes are not evidence of that irreversible barrier.
  if (intent.action === 'subject.erase') return { user: await db.collection<Row>('users').findOne({ _id: intent.subjectId },{ session, projection:{ _id:1, privacy_state:1 } }), tombstone: await db.collection<Row>('privacy_tombstones').findOne({ user_id: intent.subjectId },{session}) };
  const collection = intent.resourceType === 'textbook' ? 'textbook_editions' : intent.resourceType === 'question' ? 'question_versions' : 'file_resources';
  const projection = intent.action === 'content.revoke' ? { _id:1, access_revoked_at:1, access_revision:1 } : { _id:1, owner_type:1, owner_version_id:1, legal_hold:1, retention_until:1, deletion_requested_at:1, deleted_at:1, status:1 };
  return db.collection<Row>(collection).findOne({ _id:intent.resourceId },{session,projection});
}
function fingerprint(value: unknown, intent: SafetyIntent) {
  if (intent.action === 'content.revoke' && value !== null) { const { access_revision: _fence, ...effect } = value as Row; return digest(JSON.stringify(effect)); }
  return digest(JSON.stringify(value));
}
async function applied(db: Db, intent: SafetyIntent, sequence: number, session?: ClientSession) {
  const value = await sourceState(db, intent, session);
  if (intent.action === 'subject.erase') { const state = value as { user: Row | null; tombstone: Row | null }; return !!state.tombstone && state.tombstone.request_id === (intent.privacyRequestId ?? intent.operationId) && state.tombstone.ledger_sequence >= sequence && ['blocking','erasing','erased'].includes(state.tombstone.state); }
  const row = value as Row | null; if (!row) return false;
  if (intent.action === 'content.revoke') return row.access_revoked_at instanceof Date && (intent.revision === undefined || row.access_revision >= intent.revision);
  if (intent.action === 'file.hold') return row.legal_hold === intent.hold;
  if (intent.action === 'file.retention') return row.retention_until instanceof Date && row.retention_until.getTime() >= intent.retentionUntil!.getTime();
  return row.deleted_at instanceof Date;
}
async function commitAbortFence(db: Db, intent: SafetyIntent, sequence: number, baseline: string, maintenanceToken: string) {
  const session = db.client.startSession();
  try {
    // This transaction contains no external ledger writes. A committed fence defeats
    // old server-side snapshots even when their submitting process has already exited.
    await session.withTransaction(async () => {
      if ((await db.collection<Row>('operational_state').updateOne({_id:'environment',mode:'maintenance',maintenance_token:maintenanceToken},{$inc:{access_fence:1}},{session})).modifiedCount !== 1) deny();
      if (await db.collection('operational_writers').countDocuments({state:'running'},{session})) deny();
      let collection: string; let resourceId: string;
      if (intent.action === 'subject.erase') { collection = 'users'; resourceId = intent.subjectId!; }
      else if (intent.action === 'content.revoke') { collection = intent.resourceType === 'textbook' ? 'textbook_editions' : 'question_versions'; resourceId = intent.resourceId!; }
      else {
        const file = await db.collection<Row>('file_resources').findOne({_id:intent.resourceId},{session,projection:{owner_type:1,owner_version_id:1}});
        if (!file || !['textbook','question'].includes(file.owner_type)) deny(); id(file.owner_version_id);
        collection = file.owner_type === 'textbook' ? 'textbook_editions' : 'question_versions'; resourceId = file.owner_version_id;
      }
      const increment = intent.action === 'subject.erase' ? {identity_revision:1} : {access_revision:1};
      if ((await db.collection<Row>(collection).updateOne({_id:resourceId},{$inc:increment},{session})).modifiedCount !== 1) deny();
      if (await applied(db,intent,sequence,session) || fingerprint(await sourceState(db,intent,session),intent) !== baseline) deny();
    },{readConcern:{level:'snapshot'},writeConcern:{w:'majority',j:true},readPreference:'primary'});
  } finally { await session.endSession(); }
}
async function sourceEnvironment(db: Db) {
  assertLocalEnvironment(db);
  if (!/^kl_(?:test|restore)_[a-zA-Z0-9_-]+$/.test(db.databaseName)) deny(); const state = await db.collection<Row>('operational_state').findOne({ _id: 'environment' });
  if (!state || !['active','draining','maintenance'].includes(state.mode)) deny(); id(state.environment_id); return state.environment_id;
}
export async function readDatabaseClusterIdentity(db: Db): Promise<string> {
  assertLocalEnvironment(db);
  try {
    const config = await db.client.db('local').collection('system.replset').findOne({});
    const identity = config?.settings?.replicaSetId;
    if (!identity || typeof identity.toHexString !== 'function' || !/^[0-9a-f]{24}$/.test(identity.toHexString())) deny();
    return digest(identity.toHexString());
  } catch { return deny(); }
}
async function accepted(head: Head, db: Db) {
  const cluster = await readDatabaseClusterIdentity(db);
  if (!head.acceptedDatabases.some(binding => binding.databaseName === db.databaseName && binding.cluster === cluster)) deny();
  return cluster;
}
export async function registerSafetyLedger(db: Db, environmentId: string, fileRoot: string | null): Promise<void> {
  id(environmentId); assertLocalEnvironment(db,environmentId); if (!/^kl_test_[a-zA-Z0-9_-]+$/.test(db.databaseName)) deny();
  await authority(async (control, config) => {
    if (config.environmentId !== environmentId || (fileRoot !== null && (!path.isAbsolute(fileRoot) || config.roots.some(root => inside(path.resolve(fileRoot),root) || inside(root,path.resolve(fileRoot)))))) deny();
    await initialize(control); await initializeCompletedBackups(control); const existing = await control.collection<Head>('safety_ledger_heads').findOne({ _id: environmentId });
    if (existing) { const { head } = await snapshot(control,config,environmentId); await accepted(head,db); if (head.source !== db.databaseName || head.fileRoot !== fileRoot) deny(); return; }
    // Lost authority must never silently create a new genesis over existing checkpoints.
    for (const root of config.roots) if ((await readdir(root)).length !== 0) deny();
    const cluster = await readDatabaseClusterIdentity(db);
    const hash = await store({ version:1, environmentId, source:db.databaseName, sourceCluster:cluster, generation:0, sequence:0, previous:null, intent:null, state:'genesis', baseline:null, actor:null, reason:null }, config);
    await control.collection<Head>('safety_ledger_heads').insertOne({ _id:environmentId, source:db.databaseName, sourceCluster:cluster, roots:config.roots, fileRoot, generation:0, sequence:0, hash, lock:null, ownerLaunchToken:null, acceptedDatabases:[{databaseName:db.databaseName,cluster}] });
  },true);
}
export async function reserveSafetyIntent(db: Db, intent: SafetyIntent): Promise<SafetyReservation> {
  const normalized = normalize(intent); const environmentId = await sourceEnvironment(db);
  return authority(async (control,config) => locked(control,environmentId,async token => {
    const { head, ledger, origins } = await snapshot(control,config,environmentId); const cluster = await accepted(head,db); const prior = ledger.entries.find(entry => entry.operationId === intent.operationId);
    if (prior) { if (origins.get(intent.operationId) !== `${cluster}:${db.databaseName}` || prior.state === 'aborted' || JSON.stringify(normalize(intentOnly(prior))) !== JSON.stringify(normalized)) deny(); return { operationId:intent.operationId, sequence:prior.sequence, environmentId }; }
    const sequence = head.sequence + 1; integer(sequence); const baseline = fingerprint(await sourceState(db,intent),intent);
    const hash = await store({ version:1, environmentId, source:db.databaseName, sourceCluster:cluster, generation:head.generation+1, sequence, previous:head.hash, intent:normalized, state:'pending', baseline, actor:null, reason:null },config);
    if ((await control.collection<Head>('safety_ledger_heads').updateOne({ _id:environmentId, hash:head.hash, lock:token },{ $set:{ hash, sequence, generation:head.generation+1 } })).modifiedCount !== 1) deny();
    return { operationId:intent.operationId, sequence, environmentId };
  }));
}
export async function reserveManagedSafetyIntent(db: Db, intent: SafetyIntent): Promise<SafetyReservation | null> {
  normalize(intent); const state = await db.collection<Row>('operational_state').findOne({ _id:'environment' }); if (state?.mode === 'unregistered') return null; return reserveSafetyIntent(db,intent);
}
async function finish(db: Db, reservation: SafetyReservation, decision: 'committed'|'aborted', reconciliation?: { maintenanceToken: string; actor: string; reason: string }) {
  id(reservation.operationId); id(reservation.environmentId); integer(reservation.sequence); if (await sourceEnvironment(db) !== reservation.environmentId) deny();
  await authority(async (control,config) => locked(control,reservation.environmentId,async token => {
    const { head,ledger,baselines,origins } = await snapshot(control,config,reservation.environmentId); const cluster = await accepted(head,db); const entry = ledger.entries.find(row => row.operationId === reservation.operationId); if (!entry || entry.sequence !== reservation.sequence || origins.get(entry.operationId) !== `${cluster}:${db.databaseName}`) deny();
    if (entry.state === decision) return; if (entry.state !== 'pending') deny(); const intent = intentOnly(entry); const effect = await applied(db,intent,entry.sequence);
    if (decision === 'committed') { if (!effect) deny(); }
    else { if (!reconciliation || effect || intent.action === 'file.deleted') deny(); await assertMaintenance(db,reconciliation.maintenanceToken);
      // Commit the source fence first. A crash before durable abort leaves pending,
      // and retry excludes fence counters from the effect-only baseline.
      await commitAbortFence(db,intent,entry.sequence,baselines.get(intent.operationId)!,reconciliation.maintenanceToken);
    }
    const hash = await store({ version:1, environmentId:reservation.environmentId, source:db.databaseName, sourceCluster:cluster, generation:head.generation+1, sequence:entry.sequence, previous:head.hash, intent:normalize(intent), state:decision, baseline:baselines.get(intent.operationId)!, actor:reconciliation?.actor ?? null, reason:reconciliation?.reason ?? null },config);
    if ((await control.collection<Head>('safety_ledger_heads').updateOne({ _id:head._id, hash:head.hash, lock:token },{ $set:{ hash,generation:head.generation+1 } })).modifiedCount !== 1) deny();
  }));
}
export async function confirmSafetyIntent(db: Db, reservation: SafetyReservation): Promise<void> { await finish(db,reservation,'committed'); }
export async function readSafetyLedger(environmentId: string, minimumSequence: number): Promise<SafetyLedger> {
  id(environmentId); integer(minimumSequence); return authority(async (control,config) => { const { ledger } = await snapshot(control,config,environmentId); if (ledger.sequence < minimumSequence) deny(); return ledger; });
}
export async function inspectSafetyLedger(db: Db): Promise<SafetyLedger> {
  const environmentId = await sourceEnvironment(db);
  return authority(async (control,config) => { const result = await snapshot(control,config,environmentId); await accepted(result.head,db); return result.ledger; });
}
export async function reconcileSafetyIntent(db: Db, input: { operationId: string; decision: 'commit'|'abort'; maintenanceToken: string; actor: string; reason: string }): Promise<void> {
  await assertMaintenance(db,input.maintenanceToken); requireActor(input);
  if (!['commit','abort'].includes(input.decision)) deny();
  const ledger = await inspectSafetyLedger(db); const entry = ledger.entries.find(row => row.operationId === input.operationId); if (!entry) deny();
  await finish(db,{ operationId:entry.operationId, sequence:entry.sequence, environmentId:ledger.environmentId },input.decision === 'commit' ? 'committed' : 'aborted',input);
}
export async function runWithCurrentSafetyLedger<T>(environmentId: string, minimumSequence: number, work: (ledger: SafetyLedger, authorizeDatabase: (db: Db) => Promise<void>) => Promise<T>): Promise<T> {
  id(environmentId); integer(minimumSequence);
  return authority(async (control,config) => locked(control,environmentId,async token => {
    const { head,ledger } = await snapshot(control,config,environmentId); if (ledger.sequence < minimumSequence) deny();
    return work(ledger, async db => {
      assertLocalEnvironment(db,environmentId);
      const state = await db.collection<Row>('operational_state').findOne({_id:'environment'});
      if (!/^kl_restore_[a-zA-Z0-9_-]+$/.test(db.databaseName) || state?.mode !== 'restore_quarantined' || state.environment_id !== environmentId) deny();
      const binding = {databaseName:db.databaseName,cluster:await readDatabaseClusterIdentity(db)};
      if ((await control.collection<Head>('safety_ledger_heads').updateOne({ _id:environmentId, lock:token },{ $addToSet:{ acceptedDatabases:binding } })).matchedCount !== 1) deny();
    });
  }));
}
export async function applySafetyLedger(db: Db, ledger: SafetyLedger): Promise<object> {
  assertLocalEnvironment(db,ledger.environmentId);
  const state = await db.collection<Row>('operational_state').findOne({ _id:'environment' });
  if (!/^kl_restore_[a-zA-Z0-9_-]+$/.test(db.databaseName) || state?.mode !== 'restore_quarantined' || state.environment_id !== ledger.environmentId) deny();
  const authoritative = await readSafetyLedger(ledger.environmentId,ledger.sequence); if (JSON.stringify(authoritative) !== JSON.stringify(ledger)) deny(); let appliedCount = 0;
  const entries = ledger.entries.filter(entry => entry.state !== 'aborted');
  for (const entry of [...entries.filter(row => row.action === 'file.hold' || row.action === 'file.retention'), ...entries.filter(row => row.action !== 'file.hold' && row.action !== 'file.retention')]) {
    if (entry.action === 'subject.erase') { await suppressRestoredSubject(db,entry.subjectId!,entry.privacyRequestId ?? entry.operationId,entry.sequence); }
    else if (entry.action === 'content.revoke') { await db.collection<Row>(entry.resourceType === 'textbook' ? 'textbook_editions' : 'question_versions').updateOne({ _id:entry.resourceId, access_revoked_at:null },{ $set:{ access_revoked_at:new Date(), access_revoked_reason:'safety-ledger restore suppression', updated_at:new Date() }, $inc:{ access_revision:1 } }); }
    else if (entry.action === 'file.hold') { if (entry.hold) await db.collection<Row>('file_resources').updateOne({ _id:entry.resourceId },{ $set:{ legal_hold:true, updated_at:new Date() } }); }
    else if (entry.action === 'file.retention') { await db.collection<Row>('file_resources').updateOne({ _id:entry.resourceId },{ $max:{ retention_until:entry.retentionUntil! }, $set:{ updated_at:new Date() } }); }
    else {
      await db.collection<Row>('file_resources').updateOne({ _id:entry.resourceId },[{ $set:{ status:'deleting', deletion_requested_at:{ $ifNull:['$deletion_requested_at',{ $ifNull:['$deleted_at','$$NOW'] }] }, updated_at:'$$NOW' } }]);
    }
    appliedCount++;
  }
  return { environmentId:ledger.environmentId, sequence:ledger.sequence, pending:ledger.pending, applied:appliedCount };
}
export interface CompletedBackupInput {
  backupId: string; manifestHash: string; createdAt: Date; dbBytes: number; fileCount: number; ledgerSequence: number; maintenanceToken: string;
}
interface CompletedBackupRecord extends Row {
  environmentId: string; databaseName: string; cluster: string; manifestHash: string; createdAt: Date; completedAt: Date; dbBytes: number; fileCount: number; ledgerSequence: number;
}
export type LatestCompletedBackup = {status:'not_recorded'} | {
  status:'recorded'; backupId:string; environmentId:string; manifestHash:string; createdAt:Date; completedAt:Date; dbBytes:number; fileCount:number; ledgerSequence:number;
};
const completedBackupSchema = {$jsonSchema:{bsonType:'object',additionalProperties:false,
  required:['_id','environmentId','databaseName','cluster','manifestHash','createdAt','completedAt','dbBytes','fileCount','ledgerSequence'],
  properties:{
    _id:uuidSchema,environmentId:uuidSchema,databaseName:{bsonType:'string',pattern:'^kl_(test|restore)_[a-zA-Z0-9_-]+$',maxLength:63},
    cluster:{bsonType:'string',pattern:'^[0-9a-f]{64}$'},manifestHash:{bsonType:'string',pattern:'^[0-9a-f]{64}$'},
    createdAt:{bsonType:'date'},completedAt:{bsonType:'date'},dbBytes:counterSchema,fileCount:counterSchema,ledgerSequence:counterSchema,
  },
}};
async function assertCompletedBackupSchema(control: Db) {
  const info = await control.listCollections({name:'completed_backups'},{nameOnly:false}).next();
  if (!info || !('options' in info) || !info.options || JSON.stringify(info.options.validator) !== JSON.stringify(completedBackupSchema) || info.options.validationLevel !== 'strict' || info.options.validationAction !== 'error') deny();
}
async function initializeCompletedBackups(control: Db) {
  try { await control.createCollection('completed_backups',{validator:completedBackupSchema,validationLevel:'strict',validationAction:'error'}); }
  catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 48) throw error; }
  await assertCompletedBackupSchema(control);
  await control.collection('completed_backups').createIndex({environmentId:1,databaseName:1,cluster:1,completedAt:-1,_id:-1});
}
async function completedBackupDeadline(db: Db, maintenanceToken: string): Promise<number> {
  await assertMaintenance(db,maintenanceToken);
  const state = await db.collection<Row>('operational_state').findOne({_id:'environment',mode:'maintenance',maintenance_token:maintenanceToken});
  if (!state || !(state.updated_at instanceof Date) || !Number.isFinite(state.updated_at.getTime())) deny();
  const deadline = state.updated_at.getTime() + 30 * 60 * 1000;
  if (Date.now() >= deadline) throw new Error('BACKUP_MAINTENANCE_TIMEOUT');
  return deadline;
}
export async function registerCompletedBackup(db: Db, input: CompletedBackupInput): Promise<void> {
  if (!input || Object.keys(input).some(key => !['backupId','manifestHash','createdAt','dbBytes','fileCount','ledgerSequence','maintenanceToken'].includes(key))) deny();
  id(input.backupId); id(input.maintenanceToken);
  if (typeof input.manifestHash !== 'string' || !/^[0-9a-f]{64}$/.test(input.manifestHash) || !(input.createdAt instanceof Date) || !Number.isFinite(input.createdAt.getTime())) deny();
  integer(input.dbBytes); integer(input.fileCount); integer(input.ledgerSequence);
  const environmentId = await sourceEnvironment(db); const deadline = await completedBackupDeadline(db,input.maintenanceToken);
  await authority(async (control,config) => locked(control,environmentId,async () => {
    const {head,ledger} = await snapshot(control,config,environmentId); const cluster = await accepted(head,db);
    await completedBackupDeadline(db,input.maintenanceToken); await assertCompletedBackupSchema(control);
    const existing = await control.collection<CompletedBackupRecord>('completed_backups').findOne({_id:input.backupId});
    const metadata = {manifestHash:input.manifestHash,createdAt:input.createdAt,dbBytes:input.dbBytes,fileCount:input.fileCount,ledgerSequence:input.ledgerSequence};
    if (existing) {
      if (existing.environmentId !== environmentId || existing.databaseName !== db.databaseName || existing.cluster !== cluster || JSON.stringify({manifestHash:existing.manifestHash,createdAt:existing.createdAt,dbBytes:existing.dbBytes,fileCount:existing.fileCount,ledgerSequence:existing.ledgerSequence}) !== JSON.stringify(metadata)) deny();
      if (Date.now() >= deadline) throw new Error('BACKUP_MAINTENANCE_TIMEOUT');
      return;
    }
    if (ledger.pending || ledger.sequence < input.ledgerSequence) deny();
    // Caller has authenticated the fully published package. Never index a staging path.
    await completedBackupDeadline(db,input.maintenanceToken);
    if (Date.now() >= deadline) throw new Error('BACKUP_MAINTENANCE_TIMEOUT');
    await control.collection<CompletedBackupRecord>('completed_backups').insertOne({_id:input.backupId,environmentId,databaseName:db.databaseName,cluster,...metadata,completedAt:new Date()});
  }));
}
export async function readLatestCompletedBackup(db: Db): Promise<LatestCompletedBackup> {
  assertLocalEnvironment(db);
  const state = await db.collection<Row>('operational_state').findOne({_id:'environment'});
  const quarantined = state?.mode === 'restore_quarantined' && /^kl_restore_/.test(db.databaseName);
  const environmentId = quarantined ? state.environment_id : await sourceEnvironment(db); id(environmentId);
  assertLocalEnvironment(db,environmentId);
  return authority<LatestCompletedBackup>(async (control,config) => {
    const {head} = await snapshot(control,config,environmentId);
    // Quarantine may inspect the environment's authenticated recovery packages without
    // becoming an authorized source writer or claiming this target produced a backup.
    const filter = quarantined ? {environmentId} : {environmentId,databaseName:db.databaseName,cluster:await accepted(head,db)};
    // Both schema checking and querying are read-only; missing authority/schema fails closed.
    await assertCompletedBackupSchema(control);
    const record = await control.collection<CompletedBackupRecord>('completed_backups').findOne(filter,{sort:{completedAt:-1,_id:-1}});
    if (!record) return {status:'not_recorded'};
    return {status:'recorded',backupId:record._id,environmentId:record.environmentId,manifestHash:record.manifestHash,createdAt:record.createdAt,completedAt:record.completedAt,dbBytes:record.dbBytes,fileCount:record.fileCount,ledgerSequence:record.ledgerSequence};
  });
}
