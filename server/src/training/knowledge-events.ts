import type { ClientSession, Db } from "mongodb";
import { newId } from "../database/object-id";

export function knowledgeEnabled() {
  return process.env.KL_KNOWLEDGE_ENABLED === "true";
}

/** Coalesced source outbox, written in the source mutation's transaction. No raw text. */
export async function enqueueKnowledge(
  db: Db,
  ctx: { orgId: string; session: ClientSession },
  kind: "textbook" | "course",
  ownerId: string,
) {
  if (!knowledgeEnabled()) return;
  const now = new Date();
  await db.collection("knowledge_outbox").updateOne(
    { org_id: ctx.orgId, kind, owner_id: ownerId },
    {
      $setOnInsert: {
        _id: newId(),
        org_id: ctx.orgId,
        kind,
        owner_id: ownerId,
        created_at: now,
        access_revision: 0,
      },
      $set: {
        status: "pending",
        lease_token: null,
        lease_until: null,
        error_code: "",
        updated_at: now,
      },
      $inc: { generation: 1 },
    },
    { upsert: true, session: ctx.session },
  );
}
