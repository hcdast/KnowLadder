import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { ApiRequest } from '../errors';
import { PrivacyService } from './privacy.service';

@ApiTags('账号隐私')
@ApiCookieAuth('session')
@Controller('api/v1/privacy/deletion-requests')
export class PrivacyController {
  constructor(readonly privacy: PrivacyService) {}

  @Post()
  @HttpCode(202)
  @Header('Cache-Control', 'private, no-store')
  async create(@Req() req: ApiRequest, @Body() body: unknown) {
    return { data: await this.privacy.create(req, body), request_id: req.requestId };
  }

  @Get()
  @Header('Cache-Control', 'private, no-store')
  async list(@Req() req: ApiRequest, @Query() query: unknown) {
    return { data: await this.privacy.list(req, query), request_id: req.requestId };
  }

  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  async detail(@Req() req: ApiRequest, @Param('id') id: string) {
    return { data: await this.privacy.detail(req, id), request_id: req.requestId };
  }
}
