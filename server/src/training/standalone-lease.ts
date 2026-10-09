import { initializeStandaloneJournal } from './standalone-schema';
import { createHash, randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';

/** Infrastructure only: does not make business writes transactional or enable training. */
export class StandaloneLease {
  constructor(private readonly db: Db) {}
  private collection() { return this.db.collection('training_standalone_leases'); }
  async initialize() {
    await initializeStandaloneJournal(this.db, 'leases');
  }
  async claim(resource: string, owner: string, ttl = 30000) {
    if (!resource || resource.length > 256 || !owner || owner.length > 128 || !Number.isInteger(ttl) || ttl < 1000 || ttl > 60000)
      throw Error('STANDALONE_LEASE_INPUT');
    const token = randomUUID();
    // A single-document server-clock CAS prevents two processes taking the lease.
    let row;
    try {
      row = await this.collection().findOneAndUpdate(
        { resource, $expr: { $lte: ['$until', '$$NOW'] } },
        [{ $set: { owner, token, generation: { $add: [{ $ifNull: ['$generation', 0] }, 1] }, until: { $add: ['$$NOW', ttl] } } }],
        { returnDocument: 'after' },
      );
      if (!row) {
        // First insert starts expired; acquisition always uses server-clock CAS.
        try { await this.collection().insertOne({ resource, owner: '', token: '', generation: 0, until: new Date(0) }); }
        catch (e) { if ((e as {code?:number}).code !== 11000) throw e; }
        row = await this.collection().findOneAndUpdate(
          { resource, $expr: { $lte: ['$until', '$$NOW'] } },
          [{ $set: { owner, token, generation: { $add: ['$generation', 1] }, until: { $add: ['$$NOW', ttl] } } }],
          { returnDocument: 'after' },
        );
      }
    } catch { throw Error('STANDALONE_LEASE_UNAVAILABLE'); }
    return row ? {resource, owner, token, generation: row.generation as number} : null;
  }
  async renew(lease: {resource:string;owner:string;token:string;generation:number}, ttl=30000) {
    if (!Number.isInteger(ttl) || ttl < 1000 || ttl > 60000) throw Error('STANDALONE_LEASE_INPUT');
    return (await this.collection().updateOne(
      {...lease, $expr: {$gt:['$until','$$NOW']}},
      [{$set:{until:{$add:['$$NOW',ttl]}}}],
    )).matchedCount === 1;
  }
  async release(lease: {resource:string;owner:string;token:string;generation:number}) {
    return (await this.collection().updateOne({...lease}, {$set:{until:new Date(0)}})).matchedCount === 1;
  }
  static key(scope: string, resource: string) {
    return createHash('sha256').update(JSON.stringify([scope,resource])).digest('hex');
  }
}