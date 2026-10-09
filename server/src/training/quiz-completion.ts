import { HttpException } from "@nestjs/common";
import type { Db } from "mongodb";
import type {
  AssessmentContext,
  AssessmentSession,
  Quiz,
  SessionItem,
  Submission,
} from "../assessment/contracts";
import { AssessmentSources } from "../content/assessment-sources";
import { fail } from "../errors";

/** Internal aggregate only. Accepted submission is completion, never a score or mastery claim. */
export async function quizTaskCompletion(
  db: Db,
  ctx: AssessmentContext,
  quizId: string,
  subjectId: string,
  recipients: string[],
  now: Date,
) {
  const options = { session: ctx.session };
  const quiz = await db
    .collection<Quiz>("quizzes")
    .findOne({ _id: quizId, org_id: ctx.orgId }, options);
  if (
    !quiz ||
    quiz.subject_id !== subjectId ||
    !["published", "closed", "archived"].includes(quiz.status)
  )
    fail(409, "REPORT_FACTS_CHANGED", "测验来源已不可用");
  const sessions = await db
    .collection<AssessmentSession>("sessions")
    .find(
      {
        org_id: ctx.orgId,
        quiz_id: quizId,
        mode: "quiz",
        member_id: { $in: recipients },
        status: { $in: ["submitted", "expired"] },
        submission_id: { $ne: null },
      },
      options,
    )
    .sort({ _id: 1 })
    .limit(601)
    .toArray();
  if (sessions.length > 600)
    fail(409, "REPORT_FACTS_CAPACITY", "测验完成事实超过上限");
  const completed = new Set<string>();
  const source: unknown[] = [
    [quiz._id, quiz.revision, quiz.visibility_revision, quiz.status],
  ];
  let next: Date | null = null;
  const sources = new AssessmentSources(db);
  for (const row of sessions) {
    if (
      row.paper_id !== quiz.published_paper_id ||
      !(await db.collection("quiz_audiences").findOne(
        {
          org_id: ctx.orgId,
          quiz_id: quizId,
          member_id: row.member_id,
        },
        options,
      ))
    )
      continue;
    const member = await db.collection("organization_members").findOne(
      {
        _id: row.member_id as never,
        org_id: ctx.orgId,
        user_id: row.user_id,
        status: "active",
      },
      options,
    );
    const user = await db.collection("users").findOne(
      {
        _id: row.user_id as never,
        status: "active",
        $or: [
          { privacy_state: "active" },
          { privacy_state: { $exists: false } },
        ],
      },
      options,
    );
    if (!member || !user) continue;
    const submission = await db.collection<Submission>("submissions").findOne(
      {
        _id: row.submission_id!,
        org_id: ctx.orgId,
        session_id: row._id,
        member_id: row.member_id,
        user_id: row.user_id,
        quiz_id: quizId,
        mode: "quiz",
      },
      options,
    );
    if (
      !submission ||
      !(submission.submitted_at instanceof Date) ||
      submission.submitted_at > now ||
      !(row.submitted_at instanceof Date) ||
      row.submitted_at.getTime() !== submission.submitted_at.getTime()
    )
      fail(503, "INVALID_STUDENT_EVIDENCE", "测验提交证据不完整");
    const items = await db
      .collection<SessionItem>("session_items")
      .find({ org_id: ctx.orgId, session_id: row._id }, options)
      .sort({ position: 1 })
      .limit(51)
      .toArray();
    if (
      !items.length ||
      items.length > 50 ||
      items.length !== row.item_count ||
      items.some(
        (item, index) =>
          item.position !== index || item.snapshot.subject_id !== subjectId,
      )
    )
      fail(503, "INVALID_STUDENT_EVIDENCE", "测验题项证据不完整");
    // Already authorized report targets only; no student capability is added to HTTP identity.
    const learner: AssessmentContext = {
      ...ctx,
      userId: row.user_id,
      memberId: row.member_id,
      capabilities: ["learning:self"],
      platform: undefined,
    };
    const versions = [
      ...new Set(items.map((item) => item.snapshot.question_version_id)),
    ].sort();
    try {
      for (const version of versions) {
        const question = await sources.question(learner, version, false);
        if (
          question.subject_id !== subjectId ||
          items.some(
            (item) =>
              item.snapshot.question_version_id === version &&
              item.snapshot.question_id !== question.question_id,
          )
        )
          fail(503, "INVALID_STUDENT_EVIDENCE", "测验题项与来源身份不一致");
      }
      // No answer/score delivery: the quiz's own embargo must not hide accepted completion.
      await sources.guard(learner, versions, "quiz", quizId);
      const boundary = await sources.nextCheckAt(
        learner,
        versions,
        null,
        quizId,
        now,
      );
      if (boundary && (!next || boundary < next)) next = boundary;
    } catch (error) {
      if (
        error instanceof HttpException &&
        [403, 404, 409, 422].includes(error.getStatus())
      )
        continue;
      throw error;
    }
    completed.add(row.member_id);
    source.push([
      row.member_id,
      row._id,
      submission._id,
      submission.submitted_at,
    ]);
  }
  return { count: completed.size, source, next };
}
