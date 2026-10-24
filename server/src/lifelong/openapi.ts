import type { OpenAPIObject } from "@nestjs/swagger";
import { ACTIVITY_KINDS, FIELDS, STAGES, SUPPORT_SCOPES } from "./schema";

export function lifelongOpenApi(document: OpenAPIObject) {
  const d = document as any;
  const string = { type: "string" },
    identifier = { type: "string", pattern: "^[a-f0-9]{24}$" };
  const revision = { type: "integer", minimum: 1 },
    time = { type: "string", format: "date-time" };
  const nullable = (s: any) => ({ ...s, nullable: true });
  const enumeration = (values: readonly string[]) => ({
    type: "string",
    enum: [...values],
  });
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const array = (items: any) => ({ type: "array", items });
  const shape = (properties: Record<string, any>) => ({
    type: "object",
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
  });
  const recordBase = {
    id: identifier,
    revision,
    created_at: time,
    updated_at: time,
  };
  const goalInput = {
    title: { ...string, minLength: 1, maxLength: 120 },
    stage: nullable(enumeration(STAGES)),
    field: enumeration(FIELDS),
    outcome: { ...string, maxLength: 4000 },
    due_on: nullable({ ...string, format: "date" }),
    state: enumeration(["active", "completed", "paused"]),
    template_id: nullable(string),
  };
  const activityInput = {
    goal_id: nullable(identifier),
    kind: enumeration(ACTIVITY_KINDS),
    title: { ...string, minLength: 1, maxLength: 120 },
    note: { ...string, maxLength: 4000 },
    reflection: { ...string, maxLength: 4000 },
    occurred_on: { ...string, format: "date" },
    minutes: { type: "integer", minimum: 0, maximum: 1440 },
  };
  const supportInput = {
    label: string,
    scopes: array(enumeration(SUPPORT_SCOPES)),
    goal_ids: array(identifier),
    activity_ids: array(identifier),
    expires_at: time,
    assurance_id: nullable(identifier),
  };
  const support = {
    id: identifier,
    label: string,
    perspective: enumeration(["owner", "supporter"]),
    scopes: array(enumeration(SUPPORT_SCOPES)),
    goal_ids: array(identifier),
    activity_ids: array(identifier),
    basis: enumeration(["adult_self_consent", "verified_guardian"]),
    state: enumeration(["pending", "active", "revoked", "expired"]),
    expires_at: time,
    invite_expires_at: time,
    revision,
  };
  const assuranceInput = {
    org_id: identifier,
    user_id: identifier,
    guardian_user_id: identifier,
    evidence_reference: string,
    policy_version: string,
    transition_at: time,
    expires_at: time,
  };
  const assurance = {
    id: identifier,
    state: enumeration(["pending", "approved", "rejected", "revoked"]),
    expires_at: time,
    transition_at: time,
    revision,
  };
  const learning = shape({
    goal_id: identifier,
    revision,
    completed_unit_ids: array(string),
    next_unit_id: nullable(string),
    state: enumeration(["active", "completed"]),
  });
  const course = {
    id: string,
    version: revision,
    title: string,
    stage: enumeration(STAGES),
    field: enumeration(FIELDS),
    summary: string,
    audience: string,
    prerequisites: string,
    outcome: string,
    materials: string,
    support: string,
    minutes: { type: "integer" },
    unit_count: { type: "integer" },
    format: enumeration(["reading_practice"]),
    level: string,
    provider: string,
    source: string,
    updated_on: { type: "string", format: "date" },
    completion: string,
    learning: nullable(ref("LifelongCourseLearning")),
  };
  const schemas: Record<string, any> = {
    LifelongCourseLearning: learning,
    LifelongCourse: shape(course),
    LifelongCourseDetail: shape({
      ...course,
      units: array(ref("LifelongCourseUnit")),
    }),
    LifelongCourseUnit: shape({
      id: string,
      title: string,
      minutes: { type: "integer" },
      objective: string,
      paragraphs: array(string),
      steps: array(string),
      question: string,
      options: array(string),
      explanation: string,
      practice: string,
    }),
    LifelongCoursePage: shape({ items: array(ref("LifelongCourse")) }),
    LifelongCourseEnroll: shape({ version: revision }),
    LifelongCourseComplete: shape({
      version: revision,
      goal_id: identifier,
      revision,
      answer: { type: "integer", minimum: 0, maximum: 2 },
      practice: { ...string, minLength: 1, maxLength: 2000 },
      reflection: { ...string, minLength: 1, maxLength: 1000 },
    }),
    LifelongGoalInput: shape(goalInput),
    LifelongGoalUpdate: shape({ ...goalInput, revision }),
    LifelongGoal: shape({ ...recordBase, ...goalInput }),
    LifelongActivityInput: shape(activityInput),
    LifelongActivityUpdate: shape({ ...activityInput, revision }),
    LifelongActivity: shape({
      ...recordBase,
      ...activityInput,
      evidence: enumeration(["self_reported"]),
    }),
    LifelongFeedback: shape({
      id: identifier,
      revision,
      created_at: time,
      relation_id: identifier,
      activity_id: identifier,
      note: string,
      evidence: enumeration(["supporter_feedback"]),
    }),
    LifelongSupportInput: shape(supportInput),
    LifelongSupport: shape(support),
    LifelongAssuranceInput: shape(assuranceInput),
    LifelongAssurance: shape(assurance),
    LifelongAssuranceReview: shape({
      ...assurance,
      ...assuranceInput,
      proposer_user_id: identifier,
      reviewer_user_id: nullable(identifier),
    }),
    LifelongRevision: shape({ revision }),
    LifelongCode: shape({ code: { ...string, minLength: 43, maxLength: 43 } }),
    LifelongOperation: shape({
      operation_id: identifier,
      resource_id: identifier,
      revision,
    }),
    LifelongSupportCreated: shape({
      operation_id: identifier,
      resource_id: identifier,
      revision,
      invitation_code: nullable(string),
    }),
    LifelongReceipt: shape({
      state: enumeration(["applied", "cancelled"]),
      operation_id: identifier,
      resource_id: identifier,
      revision,
    }),
    LifelongInvitationCode: shape({ invitation_code: string }),
    LifelongEmpty: shape({}),
    LifelongParticipant: shape({
      user_id: identifier,
      display_name: string,
      adult_admitted: { type: "boolean" },
    }),
    LifelongInvitationPreview: shape({
      label: string,
      scopes: array(enumeration(SUPPORT_SCOPES)),
      basis: enumeration(["adult_self_consent"]),
      expires_at: time,
      selected_goal_count: { type: "integer" },
      selected_activity_count: { type: "integer" },
    }),
    LifelongShared: shape({
      relation: ref("LifelongSupport"),
      goals: array(ref("LifelongGoal")),
      activities: array(ref("LifelongActivity")),
      feedback: array(ref("LifelongFeedback")),
      feedback_truncated: { type: "boolean" },
    }),
    LifelongTemplate: shape({
      id: string,
      stage: enumeration(STAGES),
      field: enumeration(FIELDS),
      title: string,
      outcome: string,
      resource: string,
      activity: enumeration(ACTIVITY_KINDS),
      steps: array(string),
      reflection: string,
      support: string,
    }),
    LifelongCapabilities: shape({
      enabled: { type: "boolean" },
      adult_admitted: { type: "boolean" },
      support_basis: enumeration(["explicit_selected_records"]),
      guardian_basis: enumeration(["independent_institutional_review"]),
      templates: array(ref("LifelongTemplate")),
    }),
    LifelongFeedbackInput: shape({
      activity_id: identifier,
      note: { ...string, minLength: 1, maxLength: 4000 },
    }),
    LifelongReviewInput: shape({
      revision,
      decision: enumeration(["approved", "rejected", "revoked"]),
    }),
  };
  for (const name of [
    "Goal",
    "Activity",
    "Feedback",
    "Support",
    "Assurance",
    "AssuranceReview",
    "Participant",
  ])
    schemas[`Lifelong${name}Page`] = shape({
      items: array(ref(`Lifelong${name}`)),
      next_cursor: nullable(string),
    });
  Object.assign(d.components.schemas, schemas);
  // Replace controller dispatch placeholders with the actual finite API contract.
  for (const path of Object.keys(d.paths))
    if (path.startsWith("/api/v1/personal/")) delete d.paths[path];
  const studyInput = {
    title: { ...string, minLength: 1, maxLength: 120 },
    note: { ...string, maxLength: 4000 },
    bookmarked: { type: "boolean" },
    course_id: nullable(string),
    course_version: nullable(revision),
    unit_id: nullable(string),
    due_on: nullable({ ...string, format: "date" }),
  };
  Object.assign(d.components.schemas, {
    LifelongStudyInput: shape(studyInput),
    LifelongStudyUpdate: shape({ ...studyInput, revision }),
    LifelongStudyItem: shape({
      ...recordBase,
      ...studyInput,
      source_available: { type: "boolean" },
      source_title: nullable(string),
      reviewed_on: nullable({ ...string, format: "date" }),
      review_count: { type: "integer", minimum: 0 },
      review_note: { ...string, maxLength: 4000 },
      suggested_interval_days: { type: "integer", enum: [1, 3, 7, 14, 30] },
    }),
    LifelongStudyPage: shape({
      items: array(ref("LifelongStudyItem")),
      next_cursor: nullable(string),
    }),
    LifelongStudyReview: shape({
      answer: nullable({ type: "integer", minimum: 0, maximum: 2 }),
      revision,
      reviewed_on: { ...string, format: "date" },
      next_due_on: nullable({ ...string, format: "date" }),
      note: { ...string, minLength: 1, maxLength: 4000 },
    }),
  });
  const agendaInput = {
    title: { ...string, minLength: 1, maxLength: 120 },
    note: { ...string, maxLength: 4000 }, scheduled_on: { ...string, format: "date" },
    planned_minutes: { type: "integer", minimum: 0, maximum: 1440 },
    kind: enumeration(["reading", "course", "review", "practice", "project"]),
    source_kind: enumeration(["none", "goal", "course", "study"]),
    source_id: nullable(string), source_version: nullable(revision), unit_id: nullable(string),
  };
  const weekReview = {
    week_start: { ...string, format: "date" },
    highlights: { ...string, maxLength: 4000 }, challenges: { ...string, maxLength: 4000 }, adjustment: { ...string, maxLength: 4000 },
  };
  Object.assign(d.components.schemas, {
    LifelongAgendaInput: shape(agendaInput),
    LifelongAgendaUpdate: shape({ ...agendaInput, revision }),
    LifelongAgendaState: shape({ revision, state: enumeration(["planned", "completed", "paused", "cancelled"]), note: { ...string, maxLength: 4000 }, completed_on: nullable({ ...string, format: "date" }) }),
    LifelongAgenda: shape({ ...recordBase, ...agendaInput,
      state: enumeration(["planned", "completed", "paused", "cancelled"]), completion_note: string,
      completed_on: nullable({ ...string, format: "date" }), source_available: { type: "boolean" }, source_title: nullable(string), evidence: enumeration(["self_reported"]),
    }),
    LifelongAgendaPage: shape({ items: array(ref("LifelongAgenda")), next_cursor: nullable(string) }),
    LifelongWeekReviewInput: shape({ ...weekReview, revision: { type: "integer", minimum: 0 } }),
    LifelongWeekReview: shape({ ...recordBase, ...weekReview }),
    LifelongWeekReviewPage: shape({ items: array(ref("LifelongWeekReview")), next_cursor: nullable(string) }),
    LifelongWeekOverview: shape({ week_start: { ...string, format: "date" }, week_end: { ...string, format: "date" }, as_of: { ...string, format: "date" },
      total: { type: "integer" }, completed: { type: "integer" }, paused: { type: "integer" }, cancelled: { type: "integer" }, overdue: { type: "integer" }, planned_minutes: { type: "integer" }, truncated: { type: "boolean" }, review: nullable(ref("LifelongWeekReview")),
    }),
    LifelongReviewEvent: shape({ id: identifier, study_item_id: identifier, reviewed_on: { ...string, format: "date" }, next_due_on: nullable({ ...string, format: "date" }), note: string, ordinal: revision, created_at: time }),
    LifelongReviewEventPage: shape({ items: array(ref("LifelongReviewEvent")), next_cursor: nullable(string) }),
  });
  const operation = (
    path: string,
    method: string,
    response: string,
    input?: string,
    paged = false,
  ) => {
    const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: ["key", "course", "unit"].includes(m[1]!) ? string : identifier,
    }));
    if (paged)
      parameters.push(
        ...([
          { name: "cursor", in: "query", required: false, schema: string },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 50 },
          },
        ] as any[]),
      );
    if (input && !path.endsWith("/preview") && !path.endsWith("/cancel"))
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
      } as any);
    d.paths[`/api/v1/personal/${path}`] ??= {};
    d.paths[`/api/v1/personal/${path}`][method] = {
      tags: ["个人终身学习"],
      security: [{ session: [] }],
      parameters,
      ...(input
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: ref(input) } },
            },
          }
        : {}),
      responses: {
        200: {
          description: "本人或当前明确授权范围；不包含组织私有材料或推定掌握度",
          content: {
            "application/json": {
              schema: shape({ data: ref(response), request_id: string }),
            },
          },
        },
        401: { description: "会话失效" },
        403: { description: "准入或当前权限不足" },
        404: { description: "记录不存在或授权失效" },
        409: { description: "修订或请求编号冲突" },
        422: { description: "输入无效" },
        429: { description: "请求频繁" },
        503: { description: "功能未开放或事务不可用" },
      },
    };
  };
  operation("agenda", "get", "LifelongAgendaPage", undefined, true);
  d.paths["/api/v1/personal/agenda"].get.parameters.push({ name: "week_start", in: "query", schema: { ...string, format: "date" } });
  operation("agenda", "post", "LifelongOperation", "LifelongAgendaInput");
  operation("agenda/{id}", "patch", "LifelongOperation", "LifelongAgendaUpdate");
  operation("agenda/{id}/state", "post", "LifelongOperation", "LifelongAgendaState");
  operation("agenda/{id}/remove", "post", "LifelongOperation", "LifelongRevision");
  operation("week-overview", "get", "LifelongWeekOverview");
  d.paths["/api/v1/personal/week-overview"].get.parameters.push(...["week_start", "as_of"].map(name => ({ name, in: "query", required: true, schema: { ...string, format: "date" } })));
  operation("week-reviews", "get", "LifelongWeekReviewPage", undefined, true);
  operation("week-reviews", "post", "LifelongOperation", "LifelongWeekReviewInput");
  operation("week-reviews/{id}/remove", "post", "LifelongOperation", "LifelongRevision");
  operation("review-history", "get", "LifelongReviewEventPage", undefined, true);
  operation("study-items/{id}/reviews", "get", "LifelongReviewEventPage", undefined, true);
  operation("study-items", "get", "LifelongStudyPage", undefined, true);
  d.paths["/api/v1/personal/study-items"].get.parameters.push(
    ...[
      {
        name: "filter",
        in: "query",
        schema: enumeration(["all", "bookmarked", "due"]),
      },
      { name: "as_of", in: "query", schema: { ...string, format: "date" } },
      { name: "q", in: "query", schema: { ...string, maxLength: 120 } },
    ],
  );
  operation("study-items", "post", "LifelongOperation", "LifelongStudyInput");
  operation(
    "study-items/{id}",
    "patch",
    "LifelongOperation",
    "LifelongStudyUpdate",
  );
  operation(
    "study-items/{id}/review",
    "post",
    "LifelongOperation",
    "LifelongStudyReview",
  );
  operation(
    "study-items/{id}/remove",
    "post",
    "LifelongOperation",
    "LifelongRevision",
  );
  operation("capabilities", "get", "LifelongCapabilities");
  operation("courses", "get", "LifelongCoursePage");
  d.paths["/api/v1/personal/courses"].get.parameters.push(
    ...[
      {
        name: "stage",
        in: "query",
        required: false,
        schema: enumeration(STAGES),
      },
      {
        name: "field",
        in: "query",
        required: false,
        schema: enumeration(FIELDS),
      },
      {
        name: "q",
        in: "query",
        required: false,
        schema: { ...string, maxLength: 120 },
      },
    ],
  );
  operation("courses/{course}", "get", "LifelongCourseDetail");
  operation(
    "courses/{course}/enroll",
    "post",
    "LifelongOperation",
    "LifelongCourseEnroll",
  );
  operation(
    "courses/{course}/units/{unit}/complete",
    "post",
    "LifelongOperation",
    "LifelongCourseComplete",
  );
  operation("operations/{key}", "get", "LifelongReceipt");
  operation(
    "operations/{key}/cancel",
    "post",
    "LifelongReceipt",
    "LifelongEmpty",
  );
  for (const [kind, name] of [
    ["goals", "Goal"],
    ["activities", "Activity"],
    ["feedback", "Feedback"],
  ]) {
    operation(kind!, "get", `Lifelong${name}Page`, undefined, true);
    operation(
      `${kind}/{id}/remove`,
      "post",
      "LifelongOperation",
      "LifelongRevision",
    );
    if (kind !== "feedback") {
      operation(kind!, "post", "LifelongOperation", `Lifelong${name}Input`);
      operation(
        `${kind}/{id}`,
        "patch",
        "LifelongOperation",
        `Lifelong${name}Update`,
      );
    }
  }
  operation("supports", "get", "LifelongSupportPage", undefined, true);
  operation(
    "supports",
    "post",
    "LifelongSupportCreated",
    "LifelongSupportInput",
  );
  operation(
    "support-invitation/preview",
    "post",
    "LifelongInvitationPreview",
    "LifelongCode",
  );
  operation(
    "support-invitation/accept",
    "post",
    "LifelongOperation",
    "LifelongCode",
  );
  operation(
    "supports/{id}/revoke",
    "post",
    "LifelongOperation",
    "LifelongRevision",
  );
  operation("supports/{id}/records", "get", "LifelongShared");
  operation("supports/{id}/invitation", "get", "LifelongInvitationCode");
  operation(
    "supports/{id}/feedback",
    "post",
    "LifelongOperation",
    "LifelongFeedbackInput",
  );
  operation("assurances", "get", "LifelongAssurancePage", undefined, true);
  operation(
    "assurances",
    "post",
    "LifelongOperation",
    "LifelongAssuranceInput",
  );
  operation(
    "institutions/{org}/assurances",
    "get",
    "LifelongAssuranceReviewPage",
    undefined,
    true,
  );
  operation(
    "assurances/{id}/review",
    "post",
    "LifelongOperation",
    "LifelongReviewInput",
  );
  operation(
    "institutions/{org}/participants",
    "get",
    "LifelongParticipantPage",
    undefined,
    true,
  );
}
