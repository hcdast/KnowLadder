import {
  Catch,
  ExceptionFilter,
  HttpException,
  ArgumentsHost,
} from "@nestjs/common";
import type { Request, Response } from "express";
export type ApiRequest = Request & { requestId: string };
export function fail(status: number, code: string, message: string): never {
  throw new HttpException({ code, message }, status);
}
@Catch()
export class SafeErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<ApiRequest>();
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
    }
    if (status === 429 && !response.hasHeader("Retry-After")) response.setHeader("Retry-After", "300");
    response
      .status(status)
      .json({ error: body, request_id: request.requestId });
  }
}
