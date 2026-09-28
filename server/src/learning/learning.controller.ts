import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { ApiRequest } from '../errors';
import { LearningService } from './learning.service';
@ApiTags('学情与错题')
@ApiCookieAuth('session')
@ApiHeader({ name: 'X-Org-Id', required: true })
@Controller('api/v1')
export class LearningController {
  constructor(readonly learning: LearningService) {}
  private async result(req: ApiRequest, work: Promise<unknown>) { return { data: await work, request_id: req.requestId }; }
  @Get('me/mastery') @Header('Cache-Control', 'private, no-store')
  mastery(@Req() req: ApiRequest, @Query() query: unknown) { return this.result(req, this.learning.mastery(req, query)); }
  @Get('me/reports') @Header('Cache-Control', 'private, no-store')
  reports(@Req() req: ApiRequest, @Query() query: unknown) { return this.result(req, this.learning.reports(req, query)); }
  @Get('me/mistakes') @Header('Cache-Control', 'private, no-store')
  mistakes(@Req() req: ApiRequest, @Query() query: unknown) { return this.result(req, this.learning.mistakes(req, query)); }
  @Get('me/mistakes/:id') @Header('Cache-Control', 'private, no-store')
  mistake(@Req() req: ApiRequest, @Param('id') id: string) { return this.result(req, this.learning.mistake(req, id)); }
  @Post('me/mistakes/:id/practice-sessions') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  practice(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) { return this.result(req, this.learning.practice(req, id, body)); }
}
