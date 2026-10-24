import { fail } from "../errors";
import type { TrainingService } from "./training.service";
type Context = Parameters<TrainingService["courseAccess"]>[0];
export async function currentWork(
  t: TrainingService,
  ctx: Context,
  submissionId: string,
  teacher = false,
  write = false,
) {
  t.require(ctx, teacher ? "coursework:grade" : "learning:self");
  const sub = await t.row(ctx, "coursework_submissions", submissionId);
  if (
    !teacher &&
    (sub.user_id !== ctx.userId || sub.member_id !== ctx.memberId)
  )
    fail(404, "NOT_FOUND", "作品不可访问");
  const task = await t.taskAccess(ctx, sub.task_id, teacher, write);
  if (
    task.target_type !== "coursework" ||
    task.status !== "published" ||
    !task.recipients.includes(sub.member_id)
  )
    fail(404, "NOT_FOUND", "作品任务不可访问");
  if (teacher)
    await t.learnerCurrent(
      ctx,
      sub.user_id,
      sub.member_id,
      task.class_id,
      write,
    );
  const head = await t.row(ctx, "coursework_heads", sub.head_id);
  if (
    head.current_submission_id !== sub._id ||
    head.task_id !== task._id ||
    head.member_id !== sub.member_id ||
    head.user_id !== sub.user_id
  )
    fail(404, "NOT_FOUND", "作品已撤回或已有新版本");
  if (write) {
    await t.fenceTaskFacts(ctx, task);
    await t.cas(ctx, "coursework_heads", head, head.revision, {});
  }
  const feedback = head.current_feedback_id
    ? await t
        .col("coursework_feedback")
        .findOne(
          {
            _id: head.current_feedback_id,
            org_id: ctx.orgId,
            submission_id: sub._id,
            status: "published",
          },
          { session: ctx.session },
        )
    : null;
  return { sub, task, head, feedback };
}
