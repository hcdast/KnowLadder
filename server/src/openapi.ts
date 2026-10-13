const traceUuid = { type: "string" as const, format: "uuid" };
import type {
  OpenAPIObject,
  SchemaObject,
} from "@nestjs/swagger/dist/interfaces/open-api-spec.interface";
import { accountSecurityProperties } from "./auth-email/openapi";
const string: SchemaObject = { type: "string" };
const resourceId: SchemaObject = { type: "string", pattern: "^[0-9a-f]{24}$" };
const date: SchemaObject = { type: "string", format: "date-time" };
const boolean: SchemaObject = { type: "boolean" };
const object = (properties: Record<string, SchemaObject>): SchemaObject => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const array = (items: SchemaObject): SchemaObject => ({ type: "array", items });
const wrap = (data: SchemaObject) => object({ data, request_id: traceUuid });
export function completeOpenApi(document: OpenAPIObject): OpenAPIObject {
  const schemas: Record<string, SchemaObject> = {
    "/api/v1/auth/csrf": object({
      csrf_token: { ...string, pattern: "^[A-Za-z0-9_-]{43}$" },
      expires_at: date,
    }),
    "/api/v1/auth/login": object({
      user_id: resourceId,
      must_change_password: boolean,
      session_expires_at: date,
    }),
    "/api/v1/auth/refresh": object({ session_expires_at: date }),
    "/api/v1/me": object({
      user: object({ id: resourceId, display_name: string, ...accountSecurityProperties }),
      organizations: array(
        object({
          id: resourceId,
          name: string,
          kind: { type: "string", enum: ["school", "personal", "platform"] },
        }),
      ),
      context: {
        ...object({ org_id: resourceId, capabilities: array(string), student_conflict: boolean }),
        nullable: true,
      },
      must_change_password: boolean,
    }),
    "/api/v1/health/live": object({ status: { type: "string", enum: ["ok"] } }),
    "/api/v1/health/ready": object({
      status: { type: "string", enum: ["ok"] },
    }),
  };
  const error: SchemaObject = object({
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message"],
      properties: {
        code: string,
        message: string,
        fields: { type: "object", additionalProperties: string },
        operation_id: resourceId,
      },
    },
    request_id: traceUuid,
  });
  document.components ??= {};
  document.components.schemas ??= {};
  document.components.schemas.ApiError = error;
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      const operation = item?.[method];
      if (!operation) continue;
      if (method !== "get") {
        for (const parameter of operation.parameters ?? []) {
          if ("name" in parameter && parameter.in === "header") {
            if (parameter.name === "Origin") parameter.required = true;
            if (parameter.name === "X-CSRF-Token") {
              parameter.required = !path.endsWith("/logout");
              parameter.description = path.endsWith("/logout")
                ? "有效会话时必需；不存在或已退出的会话允许省略"
                : "必需；GET /auth/csrf 获取当前会话token";
            }
          }
        }
      }
      if (schemas[path] || path === "/api/v1/auth/logout" || path === "/api/v1/auth/change-password") {
        const status = schemas[path] ? "200" : "204";
        operation.responses[status] = {
          description: status === "204" ? "操作已确认，无正文" : "请求成功",
          headers: {
            "X-Request-Id": { schema: traceUuid },
            "Cache-Control": { schema: { type: "string", enum: ["no-store"] } },
          },
          ...(schemas[path]
            ? { content: { "application/json": { schema: wrap(schemas[path]) } } }
            : {}),
        };
      }
      for (const code of ["401", "403", "404", "409", "413", "416", "422", "429", "503"])
        operation.responses[code] = {
          description: "安全错误响应；写请求不可自动重放",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiError" },
            },
          },
          ...(code === "429"
            ? { headers: { "Retry-After": { schema: { type: "string" } } } }
            : {}),
        };
    }
  }
  return document;
}
