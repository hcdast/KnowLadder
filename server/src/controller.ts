import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  HttpCode,
} from "@nestjs/common";
import {
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";
import { AuthService } from "./auth.service";
import { Database } from "./database/database";
import { ApiRequest } from "./errors";
import { LoginDto, ChangePasswordDto, EmptyDto } from "./dto";
@ApiTags("身份认证")
@ApiCookieAuth("session")
@ApiHeader({
  name: "X-CSRF-Token",
  required: false,
  description: "所有写请求必需；GET /auth/csrf 获取",
})
@ApiHeader({
  name: "Origin",
  required: false,
  description: "所有写请求必须与 APP_ORIGIN 完全一致",
})
@ApiResponse({ status: 401, description: "凭据错误或会话已失效" })
@ApiResponse({ status: 403, description: "Origin/CSRF/组织权限拒绝" })
@ApiResponse({ status: 422, description: "请求结构不合法或未知字段" })
@ApiResponse({ status: 429, description: "限流；Retry-After 指示等待秒数" })
@ApiResponse({ status: 503, description: "依赖不可用；不要自动重放凭据请求" })
@Controller("api/v1")
export class ApiController {
  constructor(
    private readonly auth: AuthService,
    private readonly database: Database,
  ) {}
  private result(data: unknown, req: ApiRequest) {
    return { data, request_id: req.requestId };
  }
  @Get("auth/csrf")
  @ApiOperation({ summary: "获取同步CSRF token" })
  async csrf(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.result(await this.auth.getCsrf(req, res), req);
  }
  @Post("auth/login")
  @HttpCode(200)
  @ApiOperation({ summary: "登录并轮换Cookie与CSRF" })
  async login(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() body: LoginDto,
  ) {
    return this.result(
      await this.auth.login(req, res, body.login_name, body.password),
      req,
    );
  }
  @Post("auth/refresh")
  @HttpCode(200)
  @ApiOperation({ summary: "续期但不突破绝对有效期" })
  async refresh(@Req() req: ApiRequest, @Body() _body: EmptyDto) {
    return this.result(await this.auth.refresh(req), req);
  }
  @Post("auth/logout")
  @HttpCode(204)
  @ApiOperation({ summary: "确认服务端撤销会话后清除Cookie" })
  async logout(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() _body: EmptyDto,
  ) {
    await this.auth.logout(req, res);
  }
  @Post("auth/change-password")
  @HttpCode(204)
  @ApiOperation({ summary: "改密并撤销全部会话，须重新登录" })
  async change(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() body: ChangePasswordDto,
  ) {
    await this.auth.changePassword(
      req,
      res,
      body.current_password,
      body.new_password,
    );
  }
  @Get("me")
  @ApiHeader({
    name: "X-Org-Id",
    required: false,
    description: "组织UUID；每次验证当前成员和角色",
  })
  @ApiOperation({ summary: "当前身份与可用组织" })
  async me(@Req() req: ApiRequest) {
    return this.result(await this.auth.me(req), req);
  }
  @Get("health/live")
  @ApiOperation({ summary: "进程存活探针" })
  live(@Req() req: ApiRequest) {
    return this.result({ status: "ok" }, req);
  }
  @Get("health/ready")
  @ApiOperation({ summary: "真实数据库、副本集及迁移就绪探针" })
  async ready(@Req() req: ApiRequest) {
    await this.database.ready();
    return this.result({ status: "ok" }, req);
  }
}
