import { installShutdown, notifyReady, validateRuntimeFlags, reportFailure } from '../runtime/process-lifecycle';
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { MongoClient, type Db, type Document } from "mongodb";
import { newId, objectIdDatabase } from "../database/object-id";
import { runInTxn } from "../database/txn";
import { assertSchema } from "../migrations/schema";
import {
  acquireWriter,
  assertOperationalAccess,
  type WriterRegistration,
} from "../operations/control";
import { assertAdministrationOrganizationAccess } from "../administration/authorization";
import { licensed } from "../content/contracts";
import { knowledgeEnabled } from "./knowledge-events";
import {
  KNOWLEDGE_INDEX_VERSION,
  knowledgeHash,
  prepareKnowledgeChunks,
} from "./knowledge-text";
type Row = Document & { _id: string };

export async function processKnowledgeOne(db: Db): Promise<boolean> {
  if (!knowledgeEnabled()) return false;
  await assertOperationalAccess(db);
  const token = randomUUID();
  const event = await db
    .collection<Row>("knowledge_outbox")
    .findOneAndUpdate(
      {
        $or: [
          { status: "pending" },
          { status: "running", $expr: { $lte: ["$lease_until", "$$NOW"] } },
        ],
      },
      [
        {
          $set: {
            status: "running",
            lease_token: token,
            lease_until: { $add: ["$$NOW", 30000] },
            updated_at: "$$NOW",
          },
        },
      ],
      { sort: { updated_at: 1, _id: 1 }, returnDocument: "after" },
    );
  if (!event) return false;
  const fence = {
    _id: event._id,
    generation: event.generation,
    status: "running",
    lease_token: token,
    $expr: { $gt: ["$lease_until", "$$NOW"] },
  };
  try {
    await runInTxn(db.client, async (session) => {
      await assertOperationalAccess(db);
      await assertAdministrationOrganizationAccess(db, event.org_id, session);
      const held = await db
        .collection<Row>("knowledge_outbox")
        .updateOne(fence, { $set: { updated_at: new Date() } }, { session });
      if (held.matchedCount !== 1) throw Error("KNOWLEDGE_LEASE_LOST");
      const owners = db.collection<Row>(
        event.kind === "course" ? "courses" : "textbook_editions",
      );
      const owner = await owners.findOne(
        { _id: event.owner_id, org_id: event.org_id },
        { session },
      );
      // Mutating the authority document fences concurrent edits and license revocation.
      if (owner) {
        const touched = await owners.updateOne(
          { _id: owner._id, org_id: event.org_id, revision: owner.revision },
          {
            $inc:
              event.kind === "course"
                ? { revision: 0 }
                : { access_revision: 1 },
          },
          { session },
        );
        if (touched.matchedCount !== 1) throw Error("KNOWLEDGE_SOURCE_CHANGED");
      }
      const records: Row[] = [];
      if (
        owner?.status === "published" &&
        (event.kind === "course" || licensed(owner as any))
      ) {
        const raw =
          event.kind === "course"
            ? owner.lessons
                .filter((lesson: any) => lesson.kind === "text")
                .map((lesson: any) => ({
                  id: owner._id,
                  key: lesson.key,
                  title: lesson.title,
                  body: lesson.body,
                }))
            : (
                await db
                  .collection<Row>("chapters")
                  .find(
                    { org_id: event.org_id, textbook_edition_id: owner._id },
                    { session },
                  )
                  .limit(101)
                  .toArray()
              ).map((chapter) => ({
                id: chapter._id,
                key: "",
                title: chapter.title,
                body: chapter.body,
              }));
        if (raw.length > 100) throw Error("KNOWLEDGE_SOURCE_LIMIT");
        for (const item of raw) {
          const chunks = prepareKnowledgeChunks(item.body);
          records.push({
            _id: newId(),
            org_id: event.org_id,
            kind: event.kind === "course" ? "course-text" : "chapter",
            source_id: item.id,
            lesson_key: item.key,
            owner_id: owner._id,
            source_revision: owner.revision,
            source_hash: knowledgeHash(item.body),
            index_version: KNOWLEDGE_INDEX_VERSION,
            title: item.title,
            status: "ready",
            error_code: "",
            chunks,
            updated_at: new Date(),
          });
        }
      }
      await db
        .collection("knowledge_sources")
        .deleteMany(
          { org_id: event.org_id, owner_id: event.owner_id },
          { session },
        );
      if (records.length)
        await db
          .collection<Row>("knowledge_sources")
          .insertMany(records, { session });
      const done = await db
        .collection<Row>("knowledge_outbox")
        .updateOne(
          fence,
          {
            $set: {
              status: "completed",
              lease_token: null,
              lease_until: null,
              error_code: "",
              updated_at: new Date(),
            },
          },
          { session },
        );
      if (done.modifiedCount !== 1) throw Error("KNOWLEDGE_LEASE_LOST");
    });
  } catch (error) {
    // Do not expose failed/oversize stale derivatives or overwrite a newer pending event.
    if (error instanceof Error && error.message === "KNOWLEDGE_LEASE_LOST")
      return true;
    const code =
      error instanceof Error && /^KNOWLEDGE_[A-Z_]+$/.test(error.message)
        ? error.message
        : "KNOWLEDGE_INDEX_FAILED";
    await db
      .collection<Row>("knowledge_outbox")
      .updateOne(fence, {
        $set: {
          status: "failed",
          lease_token: null,
          lease_until: null,
          error_code: code,
          updated_at: new Date(),
        },
      });
  }
  return true;
}

async function main() {
  validateRuntimeFlags();
  const command = process.argv[2];
  if (
    !["run", "once"].includes(command) ||
    !knowledgeEnabled() ||
    !process.env.MONGODB_URI
  )
    throw Error("KNOWLEDGE_WORKER_CONFIG_REQUIRED");
  const client = new MongoClient(process.env.MONGODB_URI, {
    readPreference: "primary",
    writeConcern: { w: "majority" },
  });
  await client.connect();
  let stopping = false,
    writer: WriterRegistration | undefined;
  const stop = () => {
    stopping = true;
  };
  const dispose = installShutdown(stop);
  try {
    const db = objectIdDatabase(client.db());
    await assertSchema(db);
    // Uses the existing learning writer category, preserving operational stop/backup gates.
    writer = await acquireWriter(db, "learning");
    notifyReady();
    do {
      if (stopping || (await writer.stopRequested())) break;
      const processed = await processKnowledgeOne(db);
      if (command === "once") {
        console.log(JSON.stringify({ processed }));
        break;
      }
      if (!processed) await sleep(1000);
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
    reportFailure("knowledge-worker", error);
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
