import type {
  OpenAPIObject,
  SchemaObject,
} from "@nestjs/swagger/dist/interfaces/open-api-spec.interface";
export function surveyOpenApi(d: OpenAPIObject) {
  const schemas = d.components!.schemas!,
    id: SchemaObject = { type: "string", pattern: "^[a-f0-9]{24}$" },
    date: SchemaObject = { type: "string", format: "date-time" },
    num: SchemaObject = { type: "integer", minimum: 1 },
    bool: SchemaObject = { type: "boolean" },
    key: SchemaObject = { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" };
  const obj = (
      properties: Record<string, any>,
      required = Object.keys(properties),
    ): SchemaObject => ({
      type: "object",
      additionalProperties: false,
      properties,
      required,
    }),
    text = (maxLength: number) => ({ type: "string", maxLength }),
    ref = (name: string) => ({ $ref: "#/components/schemas/" + name });
  schemas.SurveyQuestion = obj(
    {
      id: key,
      title: text(500),
      required: bool,
      kind: { type: "string", enum: ["choice", "rating", "text"] },
      options: {
        type: "array",
        maxItems: 10,
        items: obj({ id: key, title: text(120) }),
      },
    },
    ["id", "title", "required", "kind"],
  );
  schemas.SurveyDraft = obj({
    title: text(120),
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: ref("SurveyQuestion"),
    },
    opens_at: date,
    closes_at: date,
  });
  schemas.SurveyAnswer = obj({
    question_id: key,
    value: { oneOf: [text(1000), { type: "integer", minimum: 1, maximum: 5 }] },
  });
  const metadata = {
    _id: id,
    course_id: id,
    title: text(120),
    revision: num,
    published_revision: { type: "integer", minimum: 0 },
    status: { type: "string", enum: ["draft", "open", "closed"] },
    opens_at: date,
    closes_at: date,
  };
  schemas.SurveyMetadata = obj(metadata);
  schemas.SurveySubmissionReceipt = obj({
    survey_id: id,
    response_id: id,
    submitted_at: date,
  });
  schemas.SurveyOwnResponse = obj({
    _id: id,
    survey_id: id,
    frozen_revision: num,
    answers: { type: "array", maxItems: 20, items: ref("SurveyAnswer") },
    submitted_at: date,
  });
  schemas.SurveyDetail = obj({
    ...metadata,
    questions: { type: "array", maxItems: 20, items: ref("SurveyQuestion") },
    response: { nullable: true, allOf: [ref("SurveyOwnResponse")] },
  });
  const summary = obj({
    respondents: { type: "integer", minimum: 0 },
    questions: {
      type: "array",
      maxItems: 20,
      items: obj({
        question_id: key,
        kind: { type: "string", enum: ["choice", "rating", "text"] },
        answered: { type: "integer", minimum: 0 },
        counts: {
          type: "object",
          additionalProperties: { type: "integer", minimum: 0 },
        },
        rating_sum: { type: "integer", minimum: 0 },
        rating_mean: { type: "number", nullable: true },
      }),
    },
  });
  schemas.SurveyResults = obj({
    summary,
    items: {
      type: "array",
      maxItems: 50,
      items: obj({
        _id: id,
        member_id: id,
        answers: { type: "array", maxItems: 20, items: ref("SurveyAnswer") },
        submitted_at: date,
      }),
    },
    next_cursor: { ...id, nullable: true },
  });
  const base = "/api/v1/training/surveys",
    mode = {
      name: "mode",
      in: "query",
      required: false,
      schema: { type: "string", enum: ["manage", "learner"] },
    },
    course = { name: "course_id", in: "query", required: true, schema: id };
  function operation(
    path: string,
    method: "get" | "post" | "put",
    name: string,
    response: any,
    input?: any,
    params: any[] = [],
  ) {
    const parameters: any[] = [
      { name: "X-Org-Id", in: "header", required: true, schema: id },
      ...params,
    ];
    if (path.includes(":id")) throw Error("Invalid OpenAPI path");
    if (path.includes("{id}"))
      parameters.push({ name: "id", in: "path", required: true, schema: id });
    if (input && name !== "surveyReceipt")
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
      });
    const op: any = {
      operationId: name,
      tags: ["课程实名反馈"],
      security: [{ session: [] }],
      parameters,
      responses: {
        "200": {
          description: "当前课程权限下的实名反馈；功能默认关闭",
          content: {
            "application/json": {
              schema: obj({
                data: response,
                request_id: { type: "string", format: "uuid" },
              }),
            },
          },
        },
      },
    };
    if (input)
      op.requestBody = {
        required: true,
        content: { "application/json": { schema: input } },
      };
    (d.paths[path] ??= {})[method] = op;
  }
  operation(
    base,
    "get",
    "surveyList",
    obj({
      items: { type: "array", maxItems: 50, items: ref("SurveyMetadata") },
      truncated: bool,
    }),
    undefined,
    [course, mode],
  );
  operation(
    base,
    "post",
    "surveyCreate",
    ref("SurveyMetadata"),
    obj({ course_id: id, draft: ref("SurveyDraft") }),
  );
  operation(
    base + "/{id}",
    "get",
    "surveyRead",
    ref("SurveyDetail"),
    undefined,
    [mode],
  );
  operation(
    base + "/{id}",
    "put",
    "surveyEdit",
    ref("SurveyMetadata"),
    obj({ expected_revision: num, draft: ref("SurveyDraft") }),
  );
  operation(
    base + "/{id}/actions",
    "post",
    "surveyAction",
    ref("SurveyMetadata"),
    obj({
      expected_revision: num,
      action: { type: "string", enum: ["publish", "close"] },
    }),
  );
  operation(
    base + "/{id}/responses",
    "post",
    "surveySubmit",
    ref("SurveySubmissionReceipt"),
    obj({
      expected_revision: num,
      answers: { type: "array", maxItems: 20, items: ref("SurveyAnswer") },
    }),
  );
  operation(
    base + "/{id}/results",
    "get",
    "surveyResults",
    ref("SurveyResults"),
    undefined,
    [{ name: "cursor", in: "query", required: false, schema: id }],
  );
  operation(
    base + "/receipts/query",
    "post",
    "surveyReceipt",
    {
      oneOf: [
        obj({ status: { type: "string", enum: ["not_found"] } }),
        obj({
          status: { type: "string", enum: ["applied"] },
          result: {
            oneOf: [ref("SurveyMetadata"), ref("SurveySubmissionReceipt")],
          },
        }),
      ],
    },
    obj({
      key: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
      operation: {
        type: "string",
        enum: [
          "survey.create",
          "survey.edit",
          "survey.action",
          "survey.submit",
        ],
      },
      resource_id: id,
    }),
  );
}
