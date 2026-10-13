import { Body, Controller, Get, HttpCode, Post, Req, Res } from "@nestjs/common";
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { ApiRequest, fail } from "../errors";
import { AuthEmailService } from "./service";
import { ActivateEmailDto, BindEmailDto, EmailRequestDto, EmailTokenDto, RegisterEmailDto, RemoveEmailDto, ResetEmailDto } from "./dto";
@ApiTags("邮箱认证")
@ApiCookieAuth("session")
@ApiHeader({ name: "Origin", required: false, description: "写请求必须与 APP_ORIGIN 一致" })
@ApiHeader({ name: "X-CSRF-Token", required: false, description: "写请求使用当前浏览器会话的CSRF token" })
@ApiResponse({ status: 409, description: "链接失效、账号需显式切换或政策版本变化" })
@ApiResponse({ status: 503, description: "邮箱功能或真实事务不可用，不可自动重放" })
@Controller("api/v1/auth")
export class AuthEmailController {
  constructor(private readonly email: AuthEmailService) {}
  @Get("capabilities")
  @ApiOperation({ summary: "真实邮箱能力和当前政策，不含账号或服务商配置" })
  capabilities(@Req() req: ApiRequest) {
    const origin = req.get("Origin");
    if ((origin && origin !== this.email.auth.config.origin) || req.get("Sec-Fetch-Site") === "cross-site")
      fail(403, "ORIGIN_REJECTED", "请求来源无效");
    return { data: this.email.capabilities(), request_id: req.requestId };
  }
  @Post("register-email") @HttpCode(202)
  @ApiOperation({ summary: "成人邮箱注册验证申请；202不代表已送达" })
  async register(@Req() req: ApiRequest, @Body() body: RegisterEmailDto) { return { data: await this.email.register(req, body), request_id: req.requestId }; }
  @Post("activate-email") @HttpCode(200)
  @ApiOperation({ summary: "收件人最终声明成年并确认当前政策，创建无组织账号和全新会话" })
  async activate(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response, @Body() body: ActivateEmailDto) { return { data: await this.email.activate(req, res, body), request_id: req.requestId }; }
  @Post("password-reset/request") @HttpCode(202)
  @ApiOperation({ summary: "统一受理找回申请，不公开账号存在性" })
  async resetRequest(@Req() req: ApiRequest, @Body() body: EmailRequestDto) { return { data: await this.email.resetRequest(req, body.email), request_id: req.requestId }; }
  @Post("password-reset/confirm") @HttpCode(204)
  @ApiOperation({ summary: "单次找回设密并撤销全部旧会话，须重新登录" })
  async resetConfirm(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response, @Body() body: ResetEmailDto) { await this.email.resetConfirm(req, res, body.token, body.new_password); }
  @Post("email-binding/request") @HttpCode(202)
  @ApiOperation({ summary: "本人当前密码确认绑定或换绑；202不代表已送达" })
  async bindRequest(@Req() req: ApiRequest, @Body() body: BindEmailDto) { return { data: await this.email.bindRequest(req, body), request_id: req.requestId }; }
  @Post("email-binding/confirm") @HttpCode(204)
  @ApiOperation({ summary: "同一认证用户确认邮箱，撤销旧恢复链接" })
  async bindConfirm(@Req() req: ApiRequest, @Body() body: EmailTokenDto) { await this.email.bindConfirm(req, body.token); }
  @Post("email-binding/remove") @HttpCode(204)
  @ApiOperation({ summary: "本人当前密码确认解绑，撤销恢复链接，保留用户名登录" })
  async remove(@Req() req: ApiRequest, @Body() body: RemoveEmailDto) { await this.email.remove(req, body.current_password, body.expected_user_id); }
}
