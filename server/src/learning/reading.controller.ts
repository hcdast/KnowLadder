import { Body, Controller, Get, Header, HttpCode, Post, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { ApiRequest } from '../errors';
import { ReadingService } from './reading.service';

@ApiTags('阅读进度')
@ApiCookieAuth('session')
@ApiHeader({ name: 'X-Org-Id', required: true })
@Controller('api/v1')
export class ReadingController {
  constructor(readonly reading: ReadingService) {}
  @Get('me/reading-progress') @Header('Cache-Control', 'private, no-store')
  async progress(@Req() req: ApiRequest, @Query() query: unknown) {
    return { data: await this.reading.progress(req, query), request_id: req.requestId };
  }
  @Post('behavior-events') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  async record(@Req() req: ApiRequest, @Body() body: unknown) {
    return { data: await this.reading.record(req, body), request_id: req.requestId };
  }
}
