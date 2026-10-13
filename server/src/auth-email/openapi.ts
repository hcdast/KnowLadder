import type { OpenAPIObject, SchemaObject } from "@nestjs/swagger/dist/interfaces/open-api-spec.interface";
const text: SchemaObject = { type: "string" };
const date: SchemaObject = { type: "string", format: "date-time" };
const object = (properties: Record<string, SchemaObject>): SchemaObject => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
export const accountSecurityProperties: Record<string, SchemaObject> = {
  login_name: text,
  email: object({ state: { type: "string", enum: ["unbound", "verified", "needs_reverify"] }, masked: { ...text, nullable: true } }),
  admission: object({
    state: { type: "string", enum: ["not_recorded", "adult_self_declared"] },
    age_band: { type: "string", enum: ["adult"], nullable: true },
    source: { type: "string", enum: ["public_register", "invite_activate"], nullable: true },
    terms_version: { ...text, nullable: true }, privacy_notice_version: { ...text, nullable: true }, accepted_at: { ...date, nullable: true },
  }),
};
export const emailActivationSchema = object({
  user_id: { type: "string", pattern: "^[0-9a-f]{24}$" }, login_name: text, session_expires_at: date,
});
export function extendAuthEmailOpenApi(document: OpenAPIObject) {
  const responses: Record<string, { status: string; schema?: SchemaObject }> = {
    "capabilities": { status: "200", schema: object({
      email_password_login: { type: "boolean" }, email_actions: { type: "boolean" }, public_registration: { type: "boolean" }, invitations: { type: "boolean" },
      terms_version: { ...text, nullable: true }, privacy_notice_version: { ...text, nullable: true },
      terms_url: { ...text, format: "uri", nullable: true }, privacy_notice_url: { ...text, format: "uri", nullable: true },
    }) },
    "register-email": { status: "202", schema: object({ accepted: { type: "boolean", enum: [true] } }) },
    "activate-email": { status: "200", schema: emailActivationSchema },
    "password-reset/request": { status: "202", schema: object({ accepted: { type: "boolean", enum: [true] } }) },
    "password-reset/confirm": { status: "204" },
    "email-binding/request": { status: "202", schema: object({ accepted: { type: "boolean", enum: [true] } }) },
    "email-binding/confirm": { status: "204" }, "email-binding/remove": { status: "204" },
  };
  for (const [path, response] of Object.entries(responses)) {
    const operation = document.paths[`/api/v1/auth/${path}`]?.[path === "capabilities" ? "get" : "post"];
    if (!operation) throw new Error("EMAIL_OPENAPI_ROUTE_MISSING");
    if (path === "capabilities") {
      operation.security = [];
      operation.parameters = [];
    }
    operation.responses[response.status] = {
      description: response.status === "202" ? "统一受理，不代表邮件已送达" : response.status === "204" ? "操作确认，无正文" : "成功",
      headers: { "Cache-Control": { schema: { type: "string", enum: ["no-store"] } }, "X-Request-Id": { schema: { type: "string", format: "uuid" } } },
      ...(response.schema ? { content: { "application/json": { schema: object({ data: response.schema, request_id: { type: "string", format: "uuid" } }) } } } : {}),
    };
  }
}
