import { requireEvidenceSubject } from "../assessment/subject-access";
import type { TrainingService } from "./training.service";
import { growthEnabled } from "./growth-schema";
type Context = Parameters<TrainingService["courseAccess"]>[0];
export async function growthNotify(
  t: TrainingService,
  ctx: Context,
  kind: "question" | "feedback" | "meetup",
  sourceId: string,
  revision: number,
  members: string[],
) {
  if (!growthEnabled()) return;
  for (const memberId of [...new Set(members)]) {
    const member = await t
      .col("organization_members")
      .findOne(
        { _id: memberId, org_id: ctx.orgId, status: "active" },
        { session: ctx.session },
      );
    if (!member) continue;
    try {
      await requireEvidenceSubject(
        t.db,
        ctx.session,
        member.user_id,
        ctx.orgId,
      );
    } catch (e) {
      if ([403, 404].includes((e as any).status ?? (e as any).getStatus?.()))
        continue;
      throw e;
    }
    const preference = await t
      .col("learning_growth_preferences")
      .findOne(
        { org_id: ctx.orgId, member_id: memberId, user_id: member.user_id },
        { session: ctx.session },
      );
    if (preference?.[kind] === false) continue;
    await t
      .col("learning_growth_notifications")
      .updateOne(
        {
          org_id: ctx.orgId,
          member_id: memberId,
          event_kind: kind,
          source_id: sourceId,
          source_revision: revision,
        },
        {
          $setOnInsert: {
            ...(await t.base(ctx)),
            user_id: member.user_id,
            member_id: memberId,
            event_kind: kind,
            source_id: sourceId,
            source_revision: revision,
            read_at: null,
          },
        },
        { session: ctx.session, upsert: true },
      );
  }
}
