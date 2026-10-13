import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ApiRequest } from '../errors';
import { ActivateEmailDto, EmailTokenDto } from './dto';
import { AuthInvitationsService } from './invitations';

@Controller('api/v1/auth/invitations')
export class AuthInvitationsController {
  constructor(readonly invitations: AuthInvitationsService) {}
  @Post('inspect') @HttpCode(200)
  async inspect(@Req() req: ApiRequest, @Body() body: EmailTokenDto) {
    return { data: await this.invitations.inspect(req, body), request_id: req.requestId };
  }
  @Post('accept') @HttpCode(200)
  async accept(@Req() req: ApiRequest, @Body() body: EmailTokenDto) {
    return { data: await this.invitations.accept(req, body), request_id: req.requestId };
  }
  @Post('activate') @HttpCode(200)
  async activate(@Req() req: ApiRequest, @Body() body: ActivateEmailDto, @Res({ passthrough: true }) res: Response) {
    return { data: await this.invitations.activate(req, body, res), request_id: req.requestId };
  }
}
