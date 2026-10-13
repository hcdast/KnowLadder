import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ApiRequest } from '../errors';
import { AdministrationService } from './administration.service';

@Controller('api/v1/console')
export class AdministrationController {
  constructor(readonly administration: AdministrationService) {}
  private result(req: ApiRequest, data: unknown, res?: Response) {
    if (res && data && typeof data === 'object' && 'status' in data && data.status === 'pending') res.status(202);
    return { data, request_id: req.requestId };
  }
  @Get('context')
  async context(@Req() req: ApiRequest) { return this.result(req, await this.administration.context(req)); }
  @Get('users')
  async users(@Req() req: ApiRequest, @Query() query: unknown) { return this.result(req, await this.administration.users(req, query)); }
  @Get('users/:userId')
  async user(@Req() req: ApiRequest, @Param('userId') userId: string) { return this.result(req, await this.administration.user(req, userId)); }
  @Get('users/:userId/members')
  async userMembers(@Req() req: ApiRequest, @Param('userId') userId: string, @Query() query: unknown) { return this.result(req, await this.administration.userMembers(req, userId, query)); }
  @Post('users') @HttpCode(200)
  async createUser(@Req() req: ApiRequest, @Body() body: unknown, @Res({ passthrough: true }) res: Response) { return this.result(req, await this.administration.createUser(req, body), res); }
  @Get('organizations')
  async organizations(@Req() req: ApiRequest, @Query() query: unknown) { return this.result(req, await this.administration.organizations(req, query)); }
  @Get('organizations/:orgId/members')
  async members(@Req() req: ApiRequest, @Param('orgId') orgId: string, @Query() query: unknown) { return this.result(req, await this.administration.members(req, orgId, query)); }
  @Post('organizations/:orgId/members') @HttpCode(200)
  async addMember(@Req() req: ApiRequest, @Param('orgId') orgId: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) { return this.result(req, await this.administration.addMember(req, orgId, body), res); }
  @Get('organizations/:orgId/invitations')
  async invitations(@Req() req: ApiRequest, @Param('orgId') orgId: string, @Query() query: unknown) { return this.result(req, await this.administration.invitations(req, orgId, query)); }
  @Post('organizations/:orgId/invitations') @HttpCode(200)
  async createInvitation(@Req() req: ApiRequest, @Param('orgId') orgId: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) { return this.result(req, await this.administration.createInvitation(req, orgId, body), res); }
  @Post('invitations/:invitationId/revoke') @HttpCode(200)
  async revokeInvitation(@Req() req: ApiRequest, @Param('invitationId') invitationId: string, @Body() body: unknown) { return this.result(req, await this.administration.revokeInvitation(req, invitationId, body)); }
  @Put('members/:memberId')
  async updateMember(@Req() req: ApiRequest, @Param('memberId') memberId: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) { return this.result(req, await this.administration.updateMember(req, memberId, body), res); }
  @Put('users/:userId/status')
  async userStatus(@Req() req: ApiRequest, @Param('userId') userId: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) { return this.result(req, await this.administration.userStatus(req, userId, body), res); }
  @Post('users/:userId/password-reset') @HttpCode(200)
  async resetPassword(@Req() req: ApiRequest, @Param('userId') userId: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) { return this.result(req, await this.administration.passwordReset(req, userId, body), res); }
  @Get('grants')
  async grants(@Req() req: ApiRequest, @Query() query: unknown) { return this.result(req, await this.administration.grants(req, query)); }
  @Post('grants') @HttpCode(200)
  async createGrant(@Req() req: ApiRequest, @Body() body: unknown, @Res({ passthrough: true }) res: Response) { return this.result(req, await this.administration.createGrant(req, body), res); }
  @Post('grants/:grantId/revoke') @HttpCode(200)
  async revokeGrant(@Req() req: ApiRequest, @Param('grantId') grantId: string, @Body() body: unknown) { return this.result(req, await this.administration.revokeGrant(req, grantId, body)); }
  @Get('approvals')
  async approvals(@Req() req: ApiRequest, @Query() query: unknown) { return this.result(req, await this.administration.approvals(req, query)); }
  @Get('approvals/:approvalId')
  async approval(@Req() req: ApiRequest, @Param('approvalId') approvalId: string) { return this.result(req, await this.administration.approvalDetail(req, approvalId)); }
  @Post('approvals/:approvalId/decision') @HttpCode(200)
  async decide(@Req() req: ApiRequest, @Param('approvalId') approvalId: string, @Body() body: unknown) { return this.result(req, await this.administration.decide(req, approvalId, body)); }
  @Get('operations')
  async operations(@Req() req: ApiRequest, @Query() query: unknown) { return this.result(req, await this.administration.operations(req, query)); }
  @Get('operations/:operationId')
  async operation(@Req() req: ApiRequest, @Param('operationId') operationId: string) { return this.result(req, await this.administration.operation(req, operationId)); }
  @Get('audit')
  async audit(@Req() req: ApiRequest, @Query() query: unknown) { return this.result(req, await this.administration.audit(req, query)); }
}
