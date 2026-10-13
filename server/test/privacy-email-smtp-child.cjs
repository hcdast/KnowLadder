"use strict";
// Isolated real-Mongo/real-SMTP sender. Parent supplies a private one-day CA via
// NODE_EXTRA_CA_CERTS; TLS identity/certificate validation stays enabled.
const { MongoClient } = require('mongodb');
const { guardedUri } = require('./helpers.cjs');
const { objectIdDatabase } = require('../dist/database/object-id.js');
const { assertSchema } = require('../dist/migrations/schema.js');
const { acquireWriter } = require('../dist/operations/control.js');
const { MailDeliveryService } = require('../dist/auth-email/mail.js');

async function main() {
  const uri = guardedUri(process.env.MONGODB_URI);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  let writer, worker, stop;
  const stopped = new Promise(resolve => { stop = resolve; });
  process.on('message', message => { if (message?.action === 'stop') stop(); });
  const watchdog = setTimeout(stop, 60000); watchdog.unref();
  try {
    await client.connect();
    const db = objectIdDatabase(client.db());
    writer = await acquireWriter(db, 'api');
    worker = new MailDeliveryService({ db, client, ready: () => assertSchema(db),
      writerStopRequested: writer.stopRequested, writerRegistrationId: () => writer.id });
    if (process.connected) process.send({ state: 'registered', writer_id: writer.id });
    let failed = false;
    try { await worker.runOnce(); } catch { failed = true; }
    // Keep the real writer registered until the parent explicitly closes it.
    // A failed durable ACK is not silently treated as transport completion.
    if (process.connected) process.send({ state: 'run_finished', failed });
    await stopped;
  } finally {
    clearTimeout(watchdog);
    try {
      if (worker) await worker.onModuleDestroy();
      if (writer) await writer.release();
    } finally {
      await client.close();
      if (process.connected) process.disconnect();
    }
  }
}
main().catch(() => { process.exitCode = 1; if (process.connected) { process.send({ state: 'failed' }); process.disconnect(); } });
