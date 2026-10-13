import {
  Catch,
  ExceptionFilter,
  HttpException,
  ArgumentsHost,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { MongoError, MongoNetworkError, MongoServerSelectionError } from "mongodb";
const DIAGNOSTIC_ROUTES: Record<string, true> = {
  "/api/v1/me": true,
  "/api/v1/auth/login": true,
  "/api/v1/site/pages/:key": true,
  "/api/v1/site/consultations": true,
  "/api/v1/site/consultations/:receipt": true,
  "/api/v1/submissions/:id": true,
  "/api/v1/submissions/:id/items": true,
  "/api/v1/me/mastery": true,
  "/api/v1/me/reports": true,
  "/api/v1/me/mistakes": true,
};
const DATABASE_DIAGNOSTIC_CODES = new Set([6, 7, 13, 18, 50, 89, 91, 112, 189, 251, 262, 11000, 11600, 11602, 13435]);
export type ApiRequest = Request & { requestId: string };
export function fail(status: number, code: string, message: string): never {
  throw new HttpException({ code, message }, status);
}
@Catch()
export class SafeErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<ApiRequest>();
    let unexpected = false;
    let status = 503;
    let body: Record<string, unknown> = {
      code: "DEPENDENCY_UNAVAILABLE",
      message: "服务暂不可用，请稍后重试",
    };
    if (
      error instanceof Error && "code" in error && error.code === "ADMINISTRATION_NEEDS_RECOVERY" &&
      "status" in error && error.status === 503 && "operation_id" in error &&
      typeof error.operation_id === "string" &&
      /^[0-9a-f]{24}$/.test(error.operation_id)
    ) {
      body = { code: "ADMINISTRATION_NEEDS_RECOVERY", message: "管理结果尚未确认，目标已隔离；请保留原幂等键并按操作编号人工核对恢复", operation_id: error.operation_id };
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      const value = error.getResponse();
      if (typeof value === "object" && "code" in value)
        body = value as Record<string, unknown>;
      else
        body = {
          code: status === 404 ? "NOT_FOUND" : "INVALID_REQUEST",
          message: status === 404 ? "接口不存在" : "请求无效",
        };
    } else if (
      typeof error === "object" &&
      error &&
      "type" in error &&
      error.type === "entity.too.large"
    ) {
      status = 413;
      body = { code: "PAYLOAD_TOO_LARGE", message: "请求正文过大" };
    } else if (error instanceof SyntaxError) {
      status = 422;
      body = { code: "VALIDATION_ERROR", message: "请求正文格式错误" };
    } else unexpected = true;
    if (unexpected) {
      const route = request.route?.path;
      const requestId = request.requestId;
      const databaseCode = error instanceof MongoError ? error.code : undefined;
      console.error(JSON.stringify({
        event: "api_unexpected_error",
        request_id: typeof requestId === "string" && /^[0-9a-f-]{36}$/.test(requestId) ? requestId : "unavailable",
        route: typeof route === "string" && DIAGNOSTIC_ROUTES[route] === true ? route : "other",
        phase: "exception_filter",
        error_category: error instanceof MongoServerSelectionError ? "database_selection"
          : error instanceof MongoNetworkError ? "database_network"
          : error instanceof MongoError ? "database"
          : error instanceof TypeError ? "type_error"
          : error instanceof RangeError ? "range_error"
          : error instanceof Error ? "unexpected_error" : "unknown",
        code: typeof databaseCode === "number" && DATABASE_DIAGNOSTIC_CODES.has(databaseCode)
          ? databaseCode : "UNCLASSIFIED",
        transient_transaction: error instanceof MongoError && error.hasErrorLabel("TransientTransactionError"),
        commit_outcome_unknown: error instanceof MongoError && error.hasErrorLabel("UnknownTransactionCommitResult"),
      }));
    }
    if (status === 429 && !response.hasHeader("Retry-After")) response.setHeader("Retry-After", "300");
    response
      .status(status)
      .json({ error: body, request_id: request.requestId });
  }
}
