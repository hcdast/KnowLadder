import { Body, Controller, Get, Header, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { ApiRequest } from '../errors';
import { TeachingService } from './teaching.service';

@ApiTags('教师班级与授课')
@ApiCookieAuth('session')
@ApiHeader({ name: 'X-Org-Id', required: true })
@Controller('api/v1/teacher')
export class TeachingController {
  constructor(readonly teaching: TeachingService) {}

  private async result(req: ApiRequest, work: Promise<unknown>) {
    return { data: await work, request_id: req.requestId };
  }

  @Post('classes')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  createClass(@Req() req: ApiRequest, @Body() body: unknown) {
    return this.result(req, this.teaching.createClass(req, body));
  }

  @Patch('classes/:id')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  patchClass(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.result(req, this.teaching.patchClass(req, id, body));
  }

  @Post('classes/:id/members')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  addMembers(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.result(req, this.teaching.addMembers(req, id, body));
  }

  @Post('classes/:id/members/remove')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  removeMembers(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.result(req, this.teaching.removeMembers(req, id, body));
  }

  @Post('assignments')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  createAssignment(@Req() req: ApiRequest, @Body() body: unknown) {
    return this.result(req, this.teaching.createAssignment(req, body));
  }

  @Post('assignments/:id/end')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  endAssignment(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.result(req, this.teaching.endAssignment(req, id, body));
  }

  @Get('classes')
  @Header('Cache-Control', 'private, no-store')
  listClasses(@Req() req: ApiRequest) {
    return this.result(req, this.teaching.listClasses(req));
  }

  @Get('classes/:id/roster')
  @Header('Cache-Control', 'private, no-store')
  roster(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.result(req, this.teaching.roster(req, id));
  }

  @Get('classes/:id/subjects/:subjectId/report')
  @Header('Cache-Control', 'private, no-store')
  classReport(
    @Req() req: ApiRequest,
    @Param('id') id: string,
    @Param('subjectId') subjectId: string,
  ) {
    return this.result(req, this.teaching.classSubjectReport(req, id, subjectId));
  }

  @Get('classes/:id/subjects/:subjectId/students/:memberId/report')
  @Header('Cache-Control', 'private, no-store')
  studentReport(
    @Req() req: ApiRequest,
    @Param('id') id: string,
    @Param('subjectId') subjectId: string,
    @Param('memberId') memberId: string,
    @Query('period') period?: string,
  ) {
    return this.result(req, this.teaching.studentSubjectReport(req, id, subjectId, memberId, period));
  }

}
