import { installShutdown, notifyReady, validateRuntimeFlags, finishRuntimeFailure } from '../runtime/process-lifecycle';
import { randomUUID, createHash } from "node:crypto";
import type { Database } from "../database/database";
import type { AuthService, Identity } from "../auth.service";
import type { ContentAccess, ContentContext } from "../content/access";
import { openPrivate } from "../files/config";
import { extractInProcess } from "./import-parser-process";
import type { ImportJob } from "./import.service";
import { User } from "../database/contracts";

/** Claim is durable before local parsing. Finish checks current authority and lease. */
export async function processImportOne(
  database: Database,
  auth: AuthService,
  access: ContentAccess,
): Promise<boolean> {
  const { importSource, requireImports } = await import("./import.service");
  requireImports();
  const jobs = database.db.collection<ImportJob>("knowledge_import_jobs");
  const now = new Date();
  await database.transaction((session) =>
    jobs.updateMany(
      {
        expires_at: { $lte: now },
        status: { $in: ["queued", "running", "preview-ready"] },
      },
      {
        $set: {
          status: "failed",
          error_code: "IMPORT_PREVIEW_EXPIRED",
          preview: [],
          warnings: [],
          lease_token: null,
          lease_until: null,
          updated_at: now,
        },
        $inc: { generation: 1, revision: 1 },
      },
      { session },
    ),
  );
  const token = randomUUID();
  const job = await database.transaction((session) =>
    jobs.findOneAndUpdate(
      {
        expires_at: { $gt: new Date() },
        $or: [
          { status: "queued" },
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
            revision: { $add: ["$revision", 1] },
          },
        },
      ],
      { sort: { created_at: 1, _id: 1 }, returnDocument: "after", session },
    ),
  );
  if (!job) return false;
  const fence = {
    _id: job._id,
    generation: job.generation,
    status: "running",
    lease_token: token,
    $expr: { $gt: ["$lease_until", "$$NOW"] },
  };
  const current = async (session: any) => {
    const user = await database.db
      .collection<User>("users")
      .findOne(
        { _id: job.user_id, status: "active", privacy_state: "active" },
        { session },
      );
    if (!user) throw Error("IMPORT_ACCESS_CHANGED");
    // authorize uses the current user/member/grant DB fences, not a saved login token.
    const capabilities = await auth.authorize(
      { user } as Identity,
      job.org_id,
      "content:edit",
      session,
    );
    const member = await database.db
      .collection<any>("organization_members")
      .findOne(
        {
          _id: job.member_id,
          user_id: job.user_id,
          org_id: job.org_id,
          status: "active",
        },
        { session },
      );
    if (!member) throw Error("IMPORT_ACCESS_CHANGED");
    const ctx: ContentContext = {
      userId: job.user_id,
      orgId: job.org_id,
      capabilities,
      session,
      requestId: randomUUID(),
    };
    const source = await importSource(database, access, ctx, job);
    if (
      (
        await jobs.updateOne(
          fence,
          { $set: { updated_at: new Date() } },
          { session },
        )
      ).matchedCount !== 1
    )
      throw Error("IMPORT_LEASE_LOST");
    return source;
  };
  try {
    const source = await database.transaction(current);
    const handle = await openPrivate("ready", source.file.storage_key);
    let bytes: Buffer;
    try {
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (
      bytes.length !== source.file.size ||
      createHash("sha256").update(bytes).digest("hex") !== job.source_hash
    )
      throw Error("IMPORT_FILE_CHANGED");
    // Parsing has its own 30s wall-clock bound; renew only a still-owned, live lease.
    let renewal: Promise<unknown> = Promise.resolve(),
      leaseLost = false;
    const heartbeat = setInterval(() => {
      renewal = renewal
        .then(() =>
          database.transaction((session) =>
            jobs.updateOne(
              fence,
              [
                {
                  $set: {
                    lease_until: { $add: ["$$NOW", 30000] },
                    updated_at: "$$NOW",
                  },
                },
              ],
              { session },
            ),
          ),
        )
        .then((result: any) => {
          if (result.matchedCount !== 1) leaseLost = true;
        })
        .catch(() => {
          leaseLost = true;
        });
    }, 10000);
    let preview;
    try {
      preview = await extractInProcess(bytes, source.file.mime!);
    } finally {
      clearInterval(heartbeat);
      await renewal;
    }
    if (leaseLost) throw Error("IMPORT_LEASE_LOST");
    await database.transaction(async (session) => {
      await current(session);
      const result = await jobs.updateOne(
        fence,
        {
          $set: {
            status: "preview-ready",
            preview: preview.segments,
            warnings: preview.warnings,
            lease_token: null,
            lease_until: null,
            updated_at: new Date(),
          },
          $inc: { revision: 1 },
        },
        { session },
      );
      if (result.matchedCount !== 1) throw Error("IMPORT_LEASE_LOST");
    });
  } catch (error) {
    const code =
      error instanceof Error && /^IMPORT_[A-Z_]+$/.test(error.message)
        ? error.message
        : "IMPORT_FAILED";
    if (code !== "IMPORT_LEASE_LOST")
      await database.transaction((session) =>
        jobs.updateOne(
          fence,
          {
            $set: {
              status: "failed",
              error_code: code,
              preview: [],
              warnings: [],
              lease_token: null,
              lease_until: null,
              updated_at: new Date(),
            },
            $inc: { revision: 1 },
          },
          { session },
        ),
      );
  }
  return true;
}

async function main() {
  validateRuntimeFlags();
  const command = process.argv[2];
  if (!["run", "once"].includes(command)) throw Error("IMPORT_COMMAND");
  // Load the application before decorated providers; Database/schema imports
  // can otherwise freeze AuthService constructor metadata with an undefined token.
  const { createApp } = await import("../app");
  const { requireImports } = await import("./import.service");
  const { Database } = await import("../database/database");
  const { AuthService } = await import("../auth.service");
  const { ContentAccess } = await import("../content/access");
  requireImports();
  const app = await createApp({ shutdownHooks: false });
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  const dispose = installShutdown(stop);
  try {
    const db = app.get(Database);
    const { acquireWriter } = await import("../operations/control");
    const writer = await acquireWriter(db.db, "learning");
    try {
      notifyReady();
      do {
        if (stopped || (await writer.stopRequested())) break;
        const processed = await processImportOne(
          db,
          app.get(AuthService),
          app.get(ContentAccess),
        );
        if (command === "once") {
          console.log(JSON.stringify({ processed }));
          break;
        }
        if (!processed)
          await new Promise((resolve) => setTimeout(resolve, 1000));
      } while (!stopped);
    } finally {
      await writer.release();
    }
  } finally {
    try {
      await app.close();
    } finally {
      dispose();
    }
  }
}
if (require.main === module)
  main().catch((error) => {
    finishRuntimeFailure("import-worker", error);
  });
