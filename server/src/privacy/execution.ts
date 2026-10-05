import { courseworkMaintenanceFence } from "../files/coursework-cleanup";
import { requireActor, requireObjectId } from "../operations/contracts";
import {
  courseworkFilesHeld,
  eraseCourseworkFileBytes,
} from "./coursework-files";
import { newId } from "../database/object-id";
import { createHash, randomUUID } from "node:crypto";
import type { ClientSession, Db, Document, MongoClient } from "mongodb";
import { systemBackupRegistry } from "../migrations/schema";
import { acquireWriter, assertOperationalAccess } from "../operations/control";
import {
  confirmSafetyIntent,
  readSafetyLedger,
  reserveSafetyIntent,
  safetyOperationId,
} from "../operations/ledger";
import { hashPassword, temporaryPassword } from "../security/password";
import { runInTxn } from "../database/txn";
import { PRIVACY_POLICY_REVISION } from "./schema";

type Row = Document & { _id: string };
const collection = (db: Db, name: string) => db.collection<Row>(name);
const BATCH = 100;
const LEASE = 60_000;
const direct = (field: string, user: string): Document[] => [
  { $match: { [field]: user } },
];
const join = (
  from: string,
  local: string,
  foreignPipeline: Document[],
): Document[] => [
  {
    $lookup: {
      from,
      let: { reference: `$${local}` },
      pipeline: [
        { $match: { $expr: { $eq: ["$_id", "$$reference"] } } },
        ...foreignPipeline,
      ],
      as: "privacy_parent",
    },
  },
  { $match: { "privacy_parent.0": { $exists: true } } },
  { $unset: "privacy_parent" },
];
const member = (user: string) => direct("user_id", user);
const session = (user: string) => direct("user_id", user);
const submission = (user: string) => direct("user_id", user);
interface Step {
  name: string;
  pipeline: Document[];
  assessment?: boolean;
  archiveEmptyClasses?: boolean;
  coursework?: boolean;
}
function steps(user: string): Step[] {
  const byMember = join("organization_members", "member_id", member(user));
  const bySession = join("sessions", "session_id", session(user));
  const bySubmission = join("submissions", "submission_id", submission(user));
  const byItem = join("session_items", "reference_id", bySession);
  const byEvent = join(
    "outbox_events",
    "event_id",
    join("submissions", "payload.submission_id", submission(user)),
  );
  const reportScope: Document[] = [
    {
      $lookup: {
        from: "class_members",
        localField: "class_id",
        foreignField: "class_id",
        as: "report_members",
      },
    },
    {
      $lookup: {
        from: "organization_members",
        localField: "report_members.member_id",
        foreignField: "_id",
        as: "report_identities",
      },
    },
    {
      $match: {
        $or: [
          { author_id: user },
          { contributors: user },
          { reviewer_id: user },
          { "report_identities.user_id": user },
        ],
      },
    },
    { $unset: ["report_members", "report_identities"] },
  ];
  const phase2Scope: Document[] = [
    ...reportScope.slice(0,2),
    {$lookup:{from:'teaching_assignments',localField:'class_id',foreignField:'class_id',as:'phase2_teachers'}},
    {$lookup:{from:'organization_members',localField:'phase2_teachers.member_id',foreignField:'_id',as:'phase2_teacher_users'}},
    {$match:{$or:[{user_id:user},{issuer_id:user},{actor_id:user},{author_id:user},{contributors:user},{reviewer_id:user},{'report_identities.user_id':user},{'phase2_teacher_users.user_id':user}]}},
    {$unset:['report_members','report_identities','phase2_teachers','phase2_teacher_users']},
  ];
  return [
    ...(process.env.KL_AI_LEARNING_REPORTS_ENABLED === "true" ? [{name:"ai_jobs",pipeline:[
      ...join("training_reports","context_id",reportScope).slice(0,1),
      {$match:{$or:[{user_id:user},{kind:"learning-report","privacy_parent.0":{$exists:true}}]}},
      {$unset:"privacy_parent"},
    ]}] : []),
    ...(process.env.KL_TRAINING_PHASE2_ENABLED === 'true' ? [
      {name:'training_idempotency',pipeline:[
        {$match:{$or:[{user_id:user},{operation:{$regex:'^phase2[.]'}}]}},
        ...['classes','training_sessions','training_paths','training_path_assignments','training_attendance','training_certificates'].map((from,index)=>({$lookup:{from,let:{source:'$resource_id'},pipeline:[{$match:{$expr:{$eq:[{$toString:'$_id'},{$toString:'$$source'}]}}},...(from==='classes'?[{$set:{class_id:'$_id'}}]:[]),...phase2Scope],as:'phase2_receipt_'+index}})),
        {$match:{$or:[{user_id:user},...Array.from({length:6},(_,index)=>({['phase2_receipt_'+index+'.0']:{$exists:true}}))]}},
        {$unset:Array.from({length:6},(_,index)=>'phase2_receipt_'+index)},
      ]},
      ...['training_notification_outbox','training_notifications'].map(name=>({name,pipeline:[
        ...['training_sessions','training_paths','training_certificates','training_leave_requests','training_tasks'].map((from,index)=>({$lookup:{from,let:{source:'$source_id'},pipeline:[{$match:{$expr:{$eq:['$_id','$$source']}}},...phase2Scope],as:'phase2_source_'+index}})),
        {$match:{$or:[{user_id:user},...Array.from({length:5},(_,index)=>({['phase2_source_'+index+'.0']:{$exists:true}}))]}},
        {$unset:Array.from({length:5},(_,index)=>'phase2_source_'+index)},
      ]})),
      {name:'training_certificate_events',pipeline:[...join('training_certificates','certificate_id',phase2Scope).slice(0,1),{$match:{$or:[{user_id:user},{actor_id:user},{'privacy_parent.0':{$exists:true}}]}},{$unset:'privacy_parent'}]},
      ...['training_certificates','training_leave_requests','training_path_assignments','training_attendance_versions','training_session_versions','training_path_versions','training_attendance','training_sessions','training_paths'].map(name=>({name,pipeline:phase2Scope})),
    ] : []),
    ...(process.env.KL_TRAINING_REPORTS_ENABLED === "true"
      ? [
          { name: "training_report_versions", pipeline: reportScope },
          { name: "training_reports", pipeline: reportScope },
        ]
      : []),
    ...(process.env.KL_TRAINING_ENABLED === "true"
      ? [
          {
            name: "coursework_feedback",
            coursework: true,
            pipeline: [
              {
                $lookup: {
                  from: "coursework_submissions",
                  localField: "submission_id",
                  foreignField: "_id",
                  as: "training_parent",
                },
              },
              {
                $match: {
                  $or: [
                    { author_id: user },
                    { "training_parent.user_id": user },
                  ],
                },
              },
              { $unset: "training_parent" },
            ],
          },
          ...[
            "coursework_submissions",
            "coursework_heads",
            "course_progress",
            "training_idempotency",
            "ai_jobs",
          ].filter(name=>(name!=='training_idempotency'||process.env.KL_TRAINING_PHASE2_ENABLED!=='true') && (name!=='ai_jobs'||process.env.KL_AI_LEARNING_REPORTS_ENABLED!=='true')).map((name) => ({
            name,
            coursework:
              name === "coursework_submissions" || name === "coursework_heads",
            pipeline: direct("user_id", user),
          })),
        ]
      : []),
    ...[
      "recommendations",
      "behavior_events",
      "reading_progress",
      "learning_projection_inputs",
      "mastery_evidence",
      "mastery_snapshots",
      "mistake_entries",
      "report_snapshots",
      "learning_projection_retirements",
      "learning_projection_builds",
      "learning_projection_heads",
      "student_projection_states",
    ].map((name) => ({ name, pipeline: byMember })),
    ...[
      "learning_attempt_contexts",
      "learning_question_states",
      "content_idempotency",
      "idempotency_records",
      "auth_sessions",
    ].map((name) => ({ name, pipeline: direct("user_id", user) })),
    { name: "consumer_receipts", pipeline: byEvent, assessment: true },
    {
      name: "outbox_events",
      pipeline: join("submissions", "payload.submission_id", submission(user)),
      assessment: true,
    },
    {
      name: "grading_results",
      pipeline: join("grading_runs", "grading_run_id", bySubmission),
      assessment: true,
    },
    { name: "grading_runs", pipeline: bySubmission, assessment: true },
    { name: "answers", pipeline: bySession, assessment: true },
    {
      name: "assessment_resource_references",
      pipeline: [{ $match: { reference_type: "session_item" } }, ...byItem],
      assessment: true,
    },
    { name: "session_items", pipeline: bySession, assessment: true },
    { name: "submissions", pipeline: submission(user), assessment: true },
    { name: "sessions", pipeline: session(user), assessment: true },
    { name: "attempt_counters", pipeline: byMember, assessment: true },
    { name: "quiz_audiences", pipeline: byMember, assessment: true },
    { name: "class_members", pipeline: byMember, archiveEmptyClasses: true },
    // A removed identity cannot remain a grant subject, applicant, reviewer or
    // beneficiary of an authorization waiting to be applied.
    {
      name: "administrative_grants",
      pipeline: join("organization_members", "subject_member_id", member(user)),
    },
    {
      name: "authorization_requests",
      pipeline: [
        {
          $match: {
            status: { $ne: "applied" },
            $or: [
              { requester_user_id: user },
              { approver_user_id: user },
              { beneficiary_user_id: user },
            ],
          },
        },
      ],
    },
    { name: "teaching_assignments", pipeline: byMember },
    { name: "member_roles", pipeline: byMember },
    { name: "member_capability_grants", pipeline: byMember },
  ];
}
async function redactAdministrationProvenance(
  db: Db,
  user: string,
  session?: ClientSession,
) {
  const now = new Date();
  const memberIds = (
    await collection(db, "organization_members")
      .find({ user_id: user }, { session, projection: { _id: 1 } })
      .toArray()
  ).map((row) => row._id);
  // Terminal applied and void receipts preserve operation/audit evidence.
  // Neither may replay; remove personal state while retaining IDs/status/hash.
  await collection(db, "authorization_requests").updateMany(
    {
      status: "applied",
      reason: { $ne: "[redacted]" },
      $or: [
        { requester_user_id: user },
        { approver_user_id: user },
        { beneficiary_user_id: user },
      ],
    },
    {
      $set: { payload: {}, reason: "[redacted]", updated_at: now },
      $inc: { revision: 1 },
    },
    { session },
  );
  await collection(db, "administration_operations").updateMany(
    {
      status: { $in: ["applied", "void"] },
      reason: { $ne: "[redacted]" },
      $or: [
        { actor_id: user },
        { "targets.user_ids": user },
        { "targets.member_ids": { $in: memberIds } },
      ],
    },
    {
      $set: {
        before: {},
        desired: {},
        reason: "[redacted]",
        key: null,
        updated_at: now,
      },
      $inc: { revision: 1 },
    },
    { session },
  );
}
async function assertKnown(db: Db) {
  const registry = systemBackupRegistry();
  const known = new Set([...registry.collections, ...registry.excluded]);
  const names = await db.listCollections({}, { nameOnly: true }).toArray();
  if (names.some((row) => !known.has(row.name)))
    throw new Error("PRIVACY_UNKNOWN_DATASET");
}
async function managed(db: Db) {
  await assertOperationalAccess(db);
  const state = await db
    .collection("operational_state")
    .findOne({ _id: "environment" as never });
  if (
    !state?.environment_id ||
    state.mode !== "active" ||
    !/^kl_test_[a-zA-Z0-9_-]+$/.test(db.databaseName) ||
    process.env.KL_ENVIRONMENT_ID !== state.environment_id
  )
    throw new Error("PRIVACY_LOCAL_ENVIRONMENT_REQUIRED");
}
async function request(db: Db, id: string) {
  const row = await collection(db, "privacy_deletion_requests").findOne({
    _id: id,
  });
  if (!row) throw new Error("PRIVACY_REQUEST_NOT_FOUND");
  if (row.policy_revision !== PRIVACY_POLICY_REVISION)
    throw new Error("PRIVACY_POLICY_UNKNOWN");
  return row;
}
async function held(
  db: Db,
  user: string,
  transactionSession?: ClientSession,
): Promise<boolean> {
  if (await courseworkFilesHeld(db, user, transactionSession)) return true;
  const references = await collection(db, "assessment_resource_references")
    .aggregate(
      [
        { $match: { reference_type: "session_item" } },
        ...join(
          "session_items",
          "reference_id",
          join("sessions", "session_id", session(user)),
        ),
        {
          $lookup: {
            from: "file_resources",
            localField: "file_id",
            foreignField: "_id",
            as: "files",
          },
        },
        {
          $match: {
            $or: [
              { "files.legal_hold": true },
              { "files.retention_until": { $gt: new Date() } },
            ],
          },
        },
        { $limit: 1 },
        { $project: { _id: 1 } },
      ],
      { maxTimeMS: 15000, session: transactionSession },
    )
    .toArray();
  return references.length > 0;
}
async function plan(db: Db, row: Row, transactionSession?: ClientSession) {
  if (!transactionSession) await assertKnown(db);
  const hold = await held(db, row.user_id, transactionSession);
  const hash = createHash("sha256").update(
    `${row._id}:${row.policy_revision}:${hold}`,
  );
  const categories: Record<string, number> = {};
  for (const step of steps(row.user_id)) {
    let count = 0;
    const cursor = collection(db, step.name).aggregate(
      [
        ...step.pipeline,
        { $project: { _id: 1, revision: 1, updated_at: 1 } },
        { $sort: { _id: 1 } },
      ],
      { batchSize: BATCH, maxTimeMS: 15000, session: transactionSession },
    );
    for await (const item of cursor) {
      count++;
      hash.update(JSON.stringify(item));
    }
    categories[step.name] = count;
    hash.update(`${step.name}:${count}`);
  }
  if (process.env.KL_COURSEWORK_FILES_ENABLED === "true") {
    let count = 0;
    for await (const item of collection(db, "file_resources")
      .find(
        { owner_type: "coursework", created_by: row.user_id },
        {
          session: transactionSession,
          projection: {
            _id: 1,
            updated_at: 1,
            legal_hold: 1,
            retention_until: 1,
            deleted_at: 1,
          },
        },
      )
      .sort({ _id: 1 })) {
      count++;
      hash.update(JSON.stringify(item));
    }
    categories.coursework_file_bytes = count;
    hash.update("coursework_file_bytes:" + count);
  }
  return {
    request_id: row._id,
    revision: row.revision,
    policy_revision: row.policy_revision,
    plan_hash: hash.digest("hex"),
    categories,
    assessment_held: hold,
    retained_categories: [
      "identity_tombstone",
      "membership_provenance",
      "audit_provenance",
      "administration_provenance",
      "shared_content_and_files",
      "privacy_receipts",
      ...(hold ? ["held_assessment_facts", "held_coursework_facts"] : []),
    ],
    remaining_actions: [] as string[],
  };
}
/** Read-only, complete registry classification. No operational registration or status mutation. */
export async function inspectPrivacyRequest(db: Db, requestId: string) {
  return plan(db, await request(db, requestId));
}
function operator(actor: string, reason: string) {
  if (
    !actor?.trim() ||
    !reason?.trim() ||
    actor.length > 128 ||
    reason.length > 512 ||
    /[\x00-\x1f\x7f]/.test(actor + reason)
  )
    throw new Error("PRIVACY_OPERATOR_REQUIRED");
}
async function transaction<T>(
  client: MongoClient,
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  return runInTxn(client, work, {
    readConcern: { level: "snapshot" },
    writeConcern: { w: "majority" },
    maxCommitTimeMS: 15000,
  });
}
export async function approvePrivacyRequest(
  _client: MongoClient,
  db: Db,
  input: {
    requestId: string;
    expectedRevision: number;
    planHash: string;
    actor: string;
    reason: string;
    retentionBasis?: string;
  },
) {
  operator(input.actor, input.reason);
  await managed(db);
  const current = await request(db, input.requestId);
  const inspected = await plan(db, current);
  if (
    current.revision !== input.expectedRevision ||
    inspected.plan_hash !== input.planHash
  )
    throw new Error("PRIVACY_PLAN_STALE");
  if (
    !input.retentionBasis ||
    !["local_minimal_provenance", "local_hold_and_provenance"].includes(
      input.retentionBasis,
    ) ||
    (inspected.assessment_held &&
      input.retentionBasis !== "local_hold_and_provenance")
  )
    throw new Error("PRIVACY_RETENTION_BASIS_REQUIRED");
  const ledger = await readSafetyLedger(process.env.KL_ENVIRONMENT_ID!, 0);
  if (
    ledger.entries.some(
      (entry) =>
        entry.action === "subject.erase" &&
        entry.subjectId === current.user_id &&
        entry.state === "pending",
    )
  )
    throw new Error("PRIVACY_PENDING_INTENT_REQUIRES_RECONCILIATION");
  const result = await collection(
    db,
    "privacy_deletion_requests",
  ).findOneAndUpdate(
    {
      _id: input.requestId,
      revision: input.expectedRevision,
      ledger_sequence: null,
      lease_token: null,
      status: { $in: ["requested", "reviewing", "approved", "failed"] },
    },
    {
      $set: {
        status: "approved",
        plan_hash: input.planHash,
        actor: input.actor,
        reason_code: input.reason,
        retention_basis: input.retentionBasis,
        retained_categories: inspected.retained_categories,
        remaining_actions: [],
        updated_at: new Date(),
      },
      $inc: { revision: 1 },
    },
    { returnDocument: "after" },
  );
  if (!result) throw new Error("PRIVACY_REVISION_CONFLICT");
  return {
    request_id: result._id,
    status: result.status,
    revision: result.revision,
  };
}
export async function rejectPrivacyRequest(
  _client: MongoClient,
  db: Db,
  input: {
    requestId: string;
    expectedRevision: number;
    actor: string;
    reason: string;
  },
) {
  operator(input.actor, input.reason);
  await managed(db);
  const result = await collection(
    db,
    "privacy_deletion_requests",
  ).findOneAndUpdate(
    {
      _id: input.requestId,
      revision: input.expectedRevision,
      status: { $in: ["requested", "reviewing"] },
    },
    {
      $set: {
        status: "rejected",
        actor: input.actor,
        reason_code: input.reason,
        remaining_actions: [],
        updated_at: new Date(),
      },
      $inc: { revision: 1 },
    },
    { returnDocument: "after" },
  );
  if (!result) throw new Error("PRIVACY_REVISION_CONFLICT");
  return {
    request_id: result._id,
    status: result.status,
    revision: result.revision,
  };
}
async function freeze(
  db: Db,
  user: string,
  requestId: string,
  sequence: number,
  session?: ClientSession,
) {
  const now = new Date();
  const options = { session };
  await collection(db, "privacy_tombstones").updateOne(
    { user_id: user },
    {
      $setOnInsert: {
        _id: newId(),
        user_id: user,
        epoch: randomUUID(),
        request_id: requestId,
        created_at: now,
        state: "blocking",
      },
      $max: { ledger_sequence: sequence },
      $set: { updated_at: now },
    },
    { ...options, upsert: true },
  );
  await collection(db, "users").updateOne(
    { _id: user, privacy_state: { $ne: "erased" } },
    {
      $set: { privacy_state: "erasing", status: "disabled", updated_at: now },
      $inc: { identity_revision: 1, credential_version: 1 },
    },
    options,
  );
  await collection(db, "organization_members").updateMany(
    { user_id: user },
    {
      $set: { status: "disabled", updated_at: now },
      $inc: { authorization_revision: 1 },
    },
    options,
  );
  await collection(db, "auth_sessions").deleteMany({ user_id: user }, options);
}
async function eraseStep(
  client: MongoClient,
  db: Db,
  row: Row,
  step: Step,
  token: string,
) {
  for (;;) {
    const finished = await transaction(client, async (session) => {
      const now = new Date();
      const lease = await collection(db, "privacy_deletion_requests").updateOne(
        { _id: row._id, lease_token: token, lease_until: { $gt: now } },
        {
          $set: {
            lease_until: new Date(now.getTime() + LEASE),
            updated_at: now,
          },
        },
        { session },
      );
      if (!lease.matchedCount) throw new Error("PRIVACY_LEASE_LOST");
      const ids = await collection(db, step.name)
        .aggregate(
          [
            ...step.pipeline,
            { $sort: { _id: 1 } },
            { $limit: BATCH },
            { $project: { _id: 1, class_id: 1, ...(step.name === "ai_jobs" ? {context_id:1} : {}) } },
          ],
          { session, maxTimeMS: 15000 },
        )
        .toArray();
      if (ids.length) {
        if(step.name === "ai_jobs" && process.env.KL_AI_LEARNING_REPORTS_ENABLED === "true")
          await collection(db,"training_idempotency").deleteMany({operation:{$regex:"^ai[.]"},resource_id:{$in:[...ids.map(item=>String(item._id)),...ids.map(item=>String(item.context_id))]}},{session});
        if (step.name === "coursework_feedback")
          await collection(db, "coursework_heads").updateMany(
            { current_feedback_id: { $in: ids.map((item) => item._id) } },
            {
              $set: { current_feedback_id: null, updated_at: new Date() },
              $inc: { revision: 1 },
            },
            { session },
          );
        await collection(db, step.name).deleteMany(
          { _id: { $in: ids.map((item) => item._id) } },
          { session },
        );
        if (step.archiveEmptyClasses) {
          const classIds = [
            ...new Set(
              ids
                .map((item) => item.class_id)
                .filter((value): value is string => typeof value === "string"),
            ),
          ];
          for (const classId of classIds) {
            if (
              await collection(db, "class_members").countDocuments(
                { class_id: classId, status: "active" },
                { session, maxTimeMS: 15000 },
              )
            )
              continue;
            await collection(db, "classes").updateOne(
              { _id: classId, status: "active" },
              {
                $set: { status: "archived", updated_at: now },
                $inc: { revision: 1 },
              },
              { session },
            );
          }
        }
        await collection(db, "privacy_step_receipts").updateOne(
          { request_id: row._id, step: step.name },
          {
            $setOnInsert: {
              _id: newId(),
              request_id: row._id,
              step: step.name,
              created_at: now,
            },
            $inc: { deleted_count: ids.length },
          },
          { session, upsert: true },
        );
        return false;
      }
      await collection(db, "privacy_deletion_requests").updateOne(
        { _id: row._id, lease_token: token },
        {
          $addToSet: {
            completed_steps: step.name,
            deleted_categories: step.name,
          },
        },
        { session },
      );
      return true;
    });
    if (finished) return;
  }
}
export async function executePrivacyRequest(
  client: MongoClient,
  db: Db,
  input: { requestId: string; actor: string; reason: string },
) {
  await managed(db);
  const writer = await acquireWriter(db, "privacy");
  try {
    return await executeRegistered(client, db, input);
  } finally {
    await writer.release();
  }
}
async function executeRegistered(
  client: MongoClient,
  db: Db,
  input: { requestId: string; actor: string; reason: string },
) {
  operator(input.actor, input.reason);
  await managed(db);
  await assertKnown(db);
  let row = await request(db, input.requestId);
  if (["completed", "completed_with_retention"].includes(row.status))
    return { request_id: row._id, status: row.status };
  if (!["approved", "blocking", "erasing", "failed"].includes(row.status))
    throw new Error("PRIVACY_APPROVAL_REQUIRED");
  const frozen = await collection(db, "privacy_tombstones").findOne({
    user_id: row.user_id,
    request_id: row._id,
  });
  if (!frozen && row.plan_hash !== (await plan(db, row)).plan_hash)
    throw new Error("PRIVACY_PLAN_STALE");
  const token = randomUUID(),
    now = new Date();
  const leased = await collection(
    db,
    "privacy_deletion_requests",
  ).findOneAndUpdate(
    {
      _id: row._id,
      revision: row.revision,
      $or: [{ lease_until: null }, { lease_until: { $lte: now } }],
    },
    {
      $set: {
        lease_token: token,
        lease_until: new Date(now.getTime() + LEASE),
        updated_at: now,
      },
    },
    { returnDocument: "after" },
  );
  if (!leased) throw new Error("PRIVACY_LEASE_BUSY");
  row = leased;
  try {
    if (
      (await collection(db, "administration_operations").findOne(
        { status: { $in: ["pending", "applying", "needs_recovery"] } },
        { projection: { _id: 1 } },
      )) ||
      !(await collection(db, "administration_guard").findOne(
        { _id: "administration", state: "idle", operation_id: null },
        { projection: { _id: 1 } },
      ))
    )
      throw new Error("PRIVACY_ADMINISTRATION_PENDING");
    const ledger = await readSafetyLedger(process.env.KL_ENVIRONMENT_ID!, 0);
    const abortedAttempts = ledger.entries.filter(
      (entry) =>
        entry.action === "subject.erase" &&
        entry.privacyRequestId === row._id &&
        entry.state === "aborted",
    ).length;
    const operationId = safetyOperationId(
      JSON.stringify([
        row._id,
        row.plan_hash,
        row.policy_revision,
        row.retention_basis,
        abortedAttempts,
      ]),
    );
    if (
      ledger.entries.some(
        (entry) =>
          entry.action === "subject.erase" &&
          entry.subjectId === row.user_id &&
          entry.state === "pending" &&
          entry.operationId !== operationId,
      )
    )
      throw new Error("PRIVACY_PENDING_INTENT_REQUIRES_RECONCILIATION");
    const reservation = await reserveSafetyIntent(db, {
      operationId,
      action: "subject.erase",
      subjectId: row.user_id,
      privacyRequestId: row._id,
      privacyPolicyRevision: row.policy_revision,
      privacyRetentionBasis: row.retention_basis,
    });
    await transaction(client, async (session) => {
      if (
        await collection(db, "administration_operations").findOne(
          { status: { $in: ["pending", "applying", "needs_recovery"] } },
          { session, projection: { _id: 1 } },
        )
      )
        throw new Error("PRIVACY_ADMINISTRATION_PENDING");
      // Serialize the erasure fence with administration's global CAS guard. A
      // pending change must retain its immutable operation record for recovery,
      // not be silently deleted by the privacy cleanup.
      const guard = await collection(db, "administration_guard").updateOne(
        { _id: "administration", state: "idle", operation_id: null },
        { $inc: { revision: 1 }, $set: { updated_at: new Date() } },
        { session },
      );
      if (guard.modifiedCount !== 1)
        throw new Error("PRIVACY_ADMINISTRATION_PENDING");
      const lock = await collection(db, "privacy_deletion_requests").updateOne(
        { _id: row._id, lease_token: token, lease_until: { $gt: new Date() } },
        {
          $set: {
            status: "erasing",
            ledger_sequence: reservation.sequence,
            updated_at: new Date(),
          },
          $inc: { revision: 1 },
        },
        { session },
      );
      if (!lock.matchedCount) throw new Error("PRIVACY_LEASE_LOST");
      if (!frozen) {
        const subject = await collection(db, "users").updateOne(
          { _id: row.user_id, privacy_state: "active" },
          { $inc: { identity_revision: 1 } },
          { session },
        );
        if (!subject.matchedCount) throw new Error("PRIVACY_SUBJECT_BLOCKED");
        if (row.plan_hash !== (await plan(db, row, session)).plan_hash)
          throw new Error("PRIVACY_PLAN_STALE");
      }
      await freeze(db, row.user_id, row._id, reservation.sequence, session);
    });
    await confirmSafetyIntent(db, reservation);
    const hold = await held(db, row.user_id);
    await eraseCourseworkFileBytes(db, row.user_id, row._id, async () => {
      const at = new Date();
      if (
        (
          await collection(db, "privacy_deletion_requests").updateOne(
            { _id: row._id, lease_token: token, lease_until: { $gt: at } },
            {
              $set: {
                lease_until: new Date(at.getTime() + LEASE),
                updated_at: at,
              },
            },
          )
        ).matchedCount !== 1
      )
        throw Error("PRIVACY_LEASE_LOST");
    });
    // Preserve the complete dependency graph when retention applies.
    for (const step of steps(row.user_id))
      if (!(hold && (step.assessment || step.coursework)))
        await eraseStep(client, db, row, step, token);
    const password = await hashPassword(temporaryPassword());
    await transaction(client, async (session) => {
      const check = await collection(db, "privacy_deletion_requests").findOne(
        { _id: row._id, lease_token: token, lease_until: { $gt: new Date() } },
        { session },
      );
      if (!check) throw new Error("PRIVACY_LEASE_LOST");
      await redactAdministrationProvenance(db, row.user_id, session);
      await collection(db, "users").updateOne(
        { _id: row.user_id },
        {
          $set: {
            login_key: `deleted_${row.user_id}`,
            display_name: "已删除账户",
            password_hash: password,
            privacy_state: "erased",
            status: "disabled",
            must_change_password: false,
            temporary_password_expires_at: null,
            password_changed_at: new Date(),
            updated_at: new Date(),
          },
        },
        { session },
      );
      await collection(db, "privacy_tombstones").updateOne(
        { user_id: row.user_id },
        { $set: { state: "erased", updated_at: new Date() } },
        { session },
      );
      await collection(db, "privacy_deletion_requests").updateOne(
        { _id: row._id, lease_token: token },
        {
          $set: {
            status: "completed_with_retention",
            retained_categories: [
              "identity_tombstone",
              "membership_provenance",
              "audit_provenance",
              "administration_provenance",
              "shared_content_and_files",
              "privacy_receipts",
              ...(hold
                ? ["held_assessment_facts", "held_coursework_facts"]
                : []),
            ],
            remaining_actions: [],
            lease_token: null,
            lease_until: null,
            updated_at: new Date(),
          },
          $inc: { revision: 1 },
        },
        { session },
      );
    });
    return { request_id: row._id, status: "completed_with_retention" };
  } catch (error) {
    await collection(db, "privacy_deletion_requests").updateOne(
      { _id: row._id, lease_token: token },
      {
        $set: {
          status: "failed",
          remaining_actions: ["resume_erasure"],
          lease_token: null,
          lease_until: null,
          updated_at: new Date(),
        },
        $inc: { revision: 1 },
      },
    );
    throw error;
  }
}
/** Only quarantine permits replay; never produces a new external intention. */
export async function suppressRestoredSubject(
  db: Db,
  userId: string,
  requestId: string | null,
  sequence: number,
): Promise<void> {
  const state = await db
    .collection("operational_state")
    .findOne({ _id: "environment" as never });
  if (state?.mode !== "restore_quarantined")
    throw new Error("PRIVACY_RESTORE_QUARANTINE_REQUIRED");
  await assertKnown(db);
  let row = await collection(db, "privacy_deletion_requests").findOne(
    requestId
      ? { _id: requestId, user_id: userId }
      : { user_id: userId, policy_revision: PRIVACY_POLICY_REVISION },
    { sort: { created_at: -1 } },
  );
  const tombstone = await collection(db, "privacy_tombstones").findOne({
    user_id: userId,
  });
  let id = row?._id ?? requestId ?? tombstone?.request_id ?? newId();
  await freeze(db, userId, id, sequence);
  // The authority is outside the restored archive and remains available after source loss.
  // Never accept caller-supplied policy/basis as evidence of an approved erasure.
  const ledger = await readSafetyLedger(state.environment_id, sequence);
  const proof = ledger.entries.find(
    (entry) =>
      entry.action === "subject.erase" &&
      entry.subjectId === userId &&
      entry.sequence === sequence &&
      entry.state === "committed" &&
      (!requestId || entry.privacyRequestId === requestId),
  );
  if (
    proof?.privacyRequestId &&
    proof.privacyPolicyRevision === PRIVACY_POLICY_REVISION &&
    ["local_minimal_provenance", "local_hold_and_provenance"].includes(
      proof.privacyRetentionBasis ?? "",
    )
  ) {
    id = proof.privacyRequestId;
    const now = new Date();
    const existing = await collection(db, "privacy_deletion_requests").findOne({
      _id: id,
    });
    if (
      existing &&
      (existing.user_id !== userId ||
        existing.policy_revision !== proof.privacyPolicyRevision)
    )
      throw new Error("PRIVACY_RESTORE_PROOF_CONFLICT");
    await collection(db, "privacy_deletion_requests").updateOne(
      { _id: id },
      {
        $setOnInsert: {
          user_id: userId,
          scope: "account",
          policy_revision: proof.privacyPolicyRevision,
          revision: 0,
          plan_hash: null,
          created_at: now,
          deleted_categories: [],
          retained_categories: [],
          completed_steps: [],
        },
        $set: {
          status: "blocking",
          actor: "safety_ledger",
          reason_code: "verified_erasure_replay",
          retention_basis: proof.privacyRetentionBasis,
          remaining_actions: ["resume_erasure"],
          lease_token: null,
          lease_until: null,
          ledger_sequence: sequence,
          updated_at: now,
        },
      },
      { upsert: true },
    );
    await collection(db, "privacy_tombstones").updateOne(
      { user_id: userId },
      { $set: { request_id: id, updated_at: now } },
    );
    row = await collection(db, "privacy_deletion_requests").findOne({
      _id: id,
    });
  }
  // Unknown historical policies stay blocked, with identity and every session already fenced.
  if (!row || row.policy_revision !== PRIVACY_POLICY_REVISION)
    throw new Error("PRIVACY_POLICY_UNKNOWN");
  const hold = await held(db, userId);
  if (
    !["local_minimal_provenance", "local_hold_and_provenance"].includes(
      row.retention_basis,
    ) ||
    (hold && row.retention_basis !== "local_hold_and_provenance")
  ) {
    await collection(db, "privacy_deletion_requests").updateOne(
      { _id: row._id },
      {
        $set: {
          status: "blocking",
          remaining_actions: ["review_retention"],
          updated_at: new Date(),
        },
        $inc: { revision: 1 },
      },
    );
    throw new Error("PRIVACY_RETENTION_BASIS_REQUIRED");
  }
  if (
    !proof?.privacyRequestId ||
    proof.privacyPolicyRevision !== PRIVACY_POLICY_REVISION ||
    proof.privacyRetentionBasis !== row.retention_basis
  ) {
    await collection(db, "privacy_deletion_requests").updateOne(
      { _id: row._id },
      {
        $set: {
          status: "blocking",
          remaining_actions: ["resume_erasure"],
          updated_at: new Date(),
        },
        $inc: { revision: 1 },
      },
    );
    throw new Error("PRIVACY_RESTORE_PROOF_REQUIRED");
  }
  await eraseCourseworkFileBytes(db, userId, id);
  for (const step of steps(userId)) {
    if (hold && (step.assessment || step.coursework)) continue;
    for (;;) {
      const finished = await transaction(db.client, async (session) => {
        const ids = await collection(db, step.name)
          .aggregate(
            [
              ...step.pipeline,
              { $limit: BATCH },
              { $project: { _id: 1, class_id: 1 } },
            ],
            { maxTimeMS: 15000, session },
          )
          .toArray();
        if (!ids.length) {
          await collection(db, "privacy_deletion_requests").updateOne(
            { _id: id },
            {
              $addToSet: {
                completed_steps: step.name,
                deleted_categories: step.name,
              },
            },
            { session },
          );
          return true;
        }
        if (step.name === "coursework_feedback")
          await collection(db, "coursework_heads").updateMany(
            { current_feedback_id: { $in: ids.map((item) => item._id) } },
            {
              $set: { current_feedback_id: null, updated_at: new Date() },
              $inc: { revision: 1 },
            },
            { session },
          );
        await collection(db, step.name).deleteMany(
          { _id: { $in: ids.map((item) => item._id) } },
          { session },
        );
        if (step.archiveEmptyClasses) {
          const classIds = [
            ...new Set(
              ids
                .map((item) => item.class_id)
                .filter((value): value is string => typeof value === "string"),
            ),
          ];
          const now = new Date();
          for (const classId of classIds) {
            if (
              await collection(db, "class_members").countDocuments(
                { class_id: classId, status: "active" },
                { session, maxTimeMS: 15000 },
              )
            )
              continue;
            await collection(db, "classes").updateOne(
              { _id: classId, status: "active" },
              {
                $set: { status: "archived", updated_at: now },
                $inc: { revision: 1 },
              },
              { session },
            );
          }
        }
        await collection(db, "privacy_step_receipts").updateOne(
          { request_id: id, step: step.name },
          {
            $setOnInsert: {
              _id: newId(),
              request_id: id,
              step: step.name,
              created_at: new Date(),
            },
            $inc: { deleted_count: ids.length },
          },
          { session, upsert: true },
        );
        return false;
      });
      if (finished) break;
    }
  }
  await redactAdministrationProvenance(db, userId);
  const password = await hashPassword(temporaryPassword());
  await collection(db, "users").updateOne(
    { _id: userId },
    {
      $set: {
        login_key: `deleted_${userId}`,
        display_name: "已删除账户",
        password_hash: password,
        status: "disabled",
        privacy_state: "erased",
        must_change_password: false,
        temporary_password_expires_at: null,
        password_changed_at: new Date(),
        updated_at: new Date(),
      },
    },
  );
  await collection(db, "privacy_tombstones").updateOne(
    { user_id: userId },
    { $set: { state: "erased", updated_at: new Date() } },
  );
  await collection(db, "privacy_deletion_requests").updateOne(
    { _id: row._id },
    {
      $set: {
        status: "completed_with_retention",
        ledger_sequence: sequence,
        retained_categories: [
          "identity_tombstone",
          "membership_provenance",
          "audit_provenance",
          "administration_provenance",
          "shared_content_and_files",
          "privacy_receipts",
          ...(hold ? ["held_assessment_facts", "held_coursework_facts"] : []),
        ],
        remaining_actions: [],
        lease_token: null,
        lease_until: null,
        updated_at: new Date(),
      },
      $inc: { revision: 1 },
    },
  );
}

/** Revisit only the retained coursework graph of an already erased subject. */
export async function reprocessErasedCoursework(
  client: MongoClient,
  db: Db,
  input: {
    requestId: string;
    releaseFileId?: string;
    actor: string;
    reason: string;
    basis: string;
    maintenanceToken: string;
  },
) {
  requireActor(input);
  requireObjectId(input.requestId);
  if (input.releaseFileId) requireObjectId(input.releaseFileId);
  if (
    typeof input.basis !== "string" ||
    !input.basis.trim() ||
    input.basis.length > 500 ||
    /[\x00-\x1f]/.test(input.basis)
  )
    throw Error("PRIVACY_RETENTION_BASIS_REQUIRED");
  const gate = await courseworkMaintenanceFence(db, input.maintenanceToken);
  await assertKnown(db);
  const row = await request(db, input.requestId),
    subject = await collection(db, "users").findOne({
      _id: row.user_id,
      privacy_state: "erased",
      status: "disabled",
    });
  if (!subject) throw Error("PRIVACY_ERASED_SUBJECT_REQUIRED");
  const tombstone = await collection(db, "privacy_tombstones").findOne({
    user_id: row.user_id,
    request_id: row._id,
    state: "erased",
  });
  const ledger = await readSafetyLedger(
    gate.environmentId,
    tombstone?.ledger_sequence ?? 0,
  );
  if (
    !tombstone ||
    !ledger.entries.some(
      (e) =>
        e.action === "subject.erase" &&
        e.subjectId === row.user_id &&
        e.privacyRequestId === row._id &&
        e.sequence === tombstone.ledger_sequence &&
        e.state === "committed",
    )
  )
    throw Error("PRIVACY_RESTORE_PROOF_REQUIRED");
  const reprocessId = safetyOperationId(
    JSON.stringify([
      "erased.coursework.reprocess",
      row._id,
      input.actor,
      input.reason,
      input.basis,
    ]),
  );
  if (
    await collection(db, "audit_events").findOne({
      request_id: reprocessId,
      action: "privacy.coursework.reprocess",
    })
  )
    return { request_id: row._id, reprocessed: true, replayed: true };
  if (ledger.pending) throw Error("OPERATIONS_PENDING_LEDGER");
  if (input.releaseFileId) {
    const file = await collection(db, "file_resources").findOne({
      _id: input.releaseFileId,
      owner_type: "coursework",
      created_by: row.user_id,
    });
    if (
      !file ||
      file.deleted_at ||
      file.status === "deleting" ||
      file.retention_until > new Date()
    )
      throw Error("PRIVACY_FILE_HELD");
    const operationId = safetyOperationId(
      JSON.stringify([
        "erased.coursework.hold-release",
        row._id,
        file._id,
        input.actor,
        input.reason,
        input.basis,
      ]),
    );
    const reservation = await reserveSafetyIntent(db, {
      operationId,
      action: "file.hold",
      resourceType: "file",
      resourceId: file._id,
      hold: false,
    });
    await transaction(client, async (session) => {
      await courseworkMaintenanceFence(db, input.maintenanceToken, session);
      if (
        await collection(db, "audit_events").findOne(
          {
            request_id: operationId,
            action: "privacy.coursework.hold-release",
          },
          { session },
        )
      )
        return;
      const owner = await collection(db, "coursework_heads").findOne(
        {
          _id: file.owner_version_id,
          user_id: row.user_id,
          org_id: file.org_id,
        },
        { session },
      );
      if (!owner) throw Error("PRIVACY_FILE_OWNER_INVALID");
      if (
        (
          await collection(db, "coursework_heads").updateOne(
            { _id: owner._id, revision: owner.revision },
            { $inc: { revision: 1 } },
            { session },
          )
        ).matchedCount !== 1
      )
        throw Error("PRIVACY_FILE_CONFLICT");
      if (
        (
          await collection(db, "file_resources").updateOne(
            {
              _id: file._id,
              updated_at: file.updated_at,
              deleted_at: null,
              status: { $ne: "deleting" },
            },
            { $set: { legal_hold: false, updated_at: new Date() } },
            { session },
          )
        ).matchedCount !== 1
      )
        throw Error("PRIVACY_FILE_CONFLICT");
      await collection(db, "audit_events").insertOne(
        {
          _id: newId(),
          org_id: file.org_id,
          actor_id: input.actor,
          action: "privacy.coursework.hold-release",
          resource_id: file._id,
          reason: input.reason + "; " + input.basis,
          request_id: operationId,
          created_at: new Date(),
        },
        { session },
      );
    });
    await confirmSafetyIntent(db, reservation);
  }
  if (await courseworkFilesHeld(db, row.user_id))
    throw Error("PRIVACY_FILE_HELD");
  const operationId = safetyOperationId(
    JSON.stringify([
      "erased.coursework.reprocess",
      row._id,
      input.actor,
      input.reason,
      input.basis,
    ]),
  );
  if (
    await collection(db, "audit_events").findOne({
      request_id: operationId,
      action: "privacy.coursework.reprocess",
    })
  )
    return { request_id: row._id, reprocessed: true, replayed: true };
  const token = randomUUID(),
    now = new Date();
  await transaction(client, async (session) => {
    await courseworkMaintenanceFence(db, input.maintenanceToken, session);
    if (
      (
        await collection(db, "privacy_deletion_requests").updateOne(
          {
            _id: row._id,
            $or: [{ lease_until: null }, { lease_until: { $lte: now } }],
          },
          {
            $set: {
              lease_token: token,
              lease_until: new Date(now.getTime() + LEASE),
              remaining_actions: ["resume_coursework_disposition"],
              updated_at: now,
            },
          },
          { session },
        )
      ).matchedCount !== 1
    )
      throw Error("PRIVACY_LEASE_LOST");
  });
  const renew = async () => {
    await courseworkMaintenanceFence(db, input.maintenanceToken);
    const at = new Date();
    if (
      (
        await collection(db, "privacy_deletion_requests").updateOne(
          { _id: row._id, lease_token: token, lease_until: { $gt: at } },
          {
            $set: {
              lease_until: new Date(at.getTime() + LEASE),
              updated_at: at,
            },
          },
        )
      ).matchedCount !== 1
    )
      throw Error("PRIVACY_LEASE_LOST");
  };
  await eraseCourseworkFileBytes(
    db,
    row.user_id,
    row._id,
    renew,
    input.maintenanceToken,
  );
  for (const step of steps(row.user_id).filter((x) => x.coursework))
    await eraseStep(client, db, row, step, token);
  await transaction(client, async (session) => {
    await courseworkMaintenanceFence(db, input.maintenanceToken, session);
    await collection(db, "audit_events").insertOne(
      {
        _id: newId(),
        org_id: null,
        actor_id: input.actor,
        action: "privacy.coursework.reprocess",
        resource_id: row._id,
        reason: input.reason + "; " + input.basis,
        request_id: operationId,
        created_at: new Date(),
      },
      { session },
    );
    if (
      (
        await collection(db, "privacy_deletion_requests").updateOne(
          { _id: row._id, lease_token: token },
          {
            $set: {
              retained_categories: row.retained_categories.filter(
                (x: string) => x !== "held_coursework_facts",
              ),
              remaining_actions: [],
              lease_token: null,
              lease_until: null,
              updated_at: new Date(),
            },
            $inc: { revision: 1 },
          },
          { session },
        )
      ).matchedCount !== 1
    )
      throw Error("PRIVACY_LEASE_LOST");
  });
  return { request_id: row._id, reprocessed: true, replayed: false };
}
