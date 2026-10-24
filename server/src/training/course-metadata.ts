import { fail } from "../errors";
import * as v from "./validation";
import type { TrainingService } from "./training.service";
import { studioEnabled } from "./studio-schema";
import { newId } from "../database/object-id";
type Context = Parameters<TrainingService["courseAccess"]>[0];
/** Shared with course lifecycle writes: a retirement and new source use cannot both commit from stale snapshots. */
export async function fenceCourseSource(t: TrainingService, ctx: Context, courseId: string) {
  if (!studioEnabled()) return;
  const now = await t.access.now(ctx);
  await t.col("learning_source_fences").updateOne({ org_id: ctx.orgId, course_id: courseId }, {
    $setOnInsert: { _id: newId(), org_id: ctx.orgId, course_id: courseId, created_at: now },
    $set: { updated_at: now }, $inc: { revision: 1 },
  }, { upsert: true, session: ctx.session });
}
export function courseMetadata(raw: unknown) {
  const o = v.object(raw, ["objectives", "audience", "difficulty", "prerequisites", "estimated_minutes", "instructor", "language"]);
  if (!["introductory", "intermediate", "advanced"].includes(o.difficulty)) fail(422, "INVALID_INPUT", "课程难度无效");
  return { objectives: v.text(o.objectives, 2000), audience: v.text(o.audience, 1000), difficulty: o.difficulty as string,
    prerequisites: v.text(o.prerequisites, 2000, true), estimated_minutes: v.integer(o.estimated_minutes, 1, 100000),
    instructor: v.text(o.instructor), language: v.text(o.language, 80) };
}
export async function readCourseMetadata(t: TrainingService, ctx: Context, courseId: string) {
  if (!studioEnabled()) return null;
  const row = await t.col("learning_course_metadata").findOne({ org_id: ctx.orgId, course_id: courseId }, { session: ctx.session });
  if (!row) return null;
  return courseMetadata(Object.fromEntries(["objectives", "audience", "difficulty", "prerequisites", "estimated_minutes", "instructor", "language"].map(k => [k, row[k]])));
}
export async function saveCourseMetadata(t: TrainingService, ctx: Context, courseId: string, raw: unknown) {
  if (raw === undefined) return;
  if (!studioEnabled()) fail(503, "STUDIO_DISABLED", "学习拓展尚未启用");
  const metadata = courseMetadata(raw);
  const previous = await t.col("learning_course_metadata").findOne({ org_id: ctx.orgId, course_id: courseId }, { session: ctx.session });
  if (previous) await t.cas(ctx, "learning_course_metadata", previous, previous.revision, metadata);
  else await t.col("learning_course_metadata").insertOne({ ...await t.base(ctx), course_id: courseId, ...metadata }, { session: ctx.session });
}
