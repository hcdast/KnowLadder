import { MongoClient, type Db } from 'mongodb';
import { assertSchema } from '../migrations/schema';
import type { ReadingEvent, ReadingProgress } from './reading.contracts';
import { acquireWriter, assertOperationalAccess, type WriterRegistration } from '../operations/control';

const DAY = 86400000;
function requireIsolatedDatabase(db: Db): void {
  if (!/^kl_test_[a-zA-Z0-9_-]+$/.test(db.databaseName)) throw new Error('READING_CLEANUP_ISOLATED_DATABASE_REQUIRED');
}
/** Bounded local retention job. Receipts and revision tombstones are never deleted. */
export async function cleanupReading(db: Db, apply = false): Promise<{ events: number; progress: number; applied: boolean }> {
  // Isolation refusal must precede every query or write, including the
  // operational-state probe, so a denied database never sees any I/O.
  if (apply) requireIsolatedDatabase(db);
  await assertOperationalAccess(db);
  const clock = await db.aggregate<{ now: Date }>([{ $documents: [{}] }, { $project: { _id: 0, now: '$$NOW' } }]).next();
  if (!(clock?.now instanceof Date)) throw new Error('DATABASE_TIME_UNAVAILABLE');
  const eventCutoff = new Date(clock.now.getTime() - 90 * DAY);
  const progressCutoff = new Date(clock.now.getTime() - 180 * DAY);
  const events = db.collection<ReadingEvent>('behavior_events');
  const progress = db.collection<ReadingProgress>('reading_progress');
  const eventRows = await events.find({ server_received_at: { $lte: eventCutoff } }).sort({ server_received_at: 1, _id: 1 }).limit(500).project<{ _id: string }>({ _id: 1 }).toArray();
  const progressRows = await progress.find({ cleared_at: null, updated_at: { $lte: progressCutoff } }).sort({ updated_at: 1, _id: 1 }).limit(500).project<{ _id: string; revision: number }>({ _id: 1, revision: 1 }).toArray();
  if (!apply) return { events: eventRows.length, progress: progressRows.length, applied: false };
  const removed = eventRows.length ? await events.deleteMany({ _id: { $in: eventRows.map(row => row._id) }, server_received_at: { $lte: eventCutoff } }) : { deletedCount: 0 };
  let cleared = 0;
  for (const row of progressRows) {
    if (!Number.isSafeInteger(row.revision + 1)) throw new Error('READING_REVISION_EXHAUSTED');
    // This single-document CAS competes with event transactions, so no fresh
    // position can be erased and no pre-clear expected_revision can resurrect it.
    const result = await progress.updateOne({ _id: row._id, revision: row.revision, cleared_at: null, updated_at: { $lte: progressCutoff } },
      [{ $set: { position: null, completed: null, revision: { $add: ['$revision', 1] }, cleared_at: '$$NOW', updated_at: '$$NOW' } }]);
    cleared += result.modifiedCount;
  }
  return { events: removed.deletedCount, progress: cleared, applied: true };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply') || args.length > 1 || process.env.NODE_ENV === 'production' || !process.env.MONGODB_URI) throw new Error('READING_CLEANUP_LOCAL_ONLY');
  const client = new MongoClient(process.env.MONGODB_URI, { readPreference: 'primary', writeConcern: { w: 'majority' } });
  let writer: WriterRegistration | undefined;
  try {
    const db = client.db(), apply = args.includes('--apply');
    if (apply) requireIsolatedDatabase(db);
    await client.connect(); await assertSchema(db);
    if (apply) writer = await acquireWriter(db, 'reading');
    else await assertOperationalAccess(db);
    console.log(JSON.stringify(await cleanupReading(db, apply)));
  }
  finally { try { await writer?.release(); } finally { await client.close(); } }
}
if (require.main === module) main().catch(() => { console.error('阅读清理失败，请检查隔离环境与数据库状态'); process.exitCode = 1; });
