import { Body, Controller, Get, Header, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { ApiRequest } from '../errors';
import { AssessmentService } from './assessment.service';

@ApiTags('练习与考试')
@ApiCookieAuth('session')
@ApiHeader({ name: 'X-Org-Id', required: true })
@Controller('api/v1')
export class AssessmentController {
  constructor(readonly assessment: AssessmentService) {}
  private async result(req: ApiRequest, work: Promise<unknown>) {
    return { data: await work, request_id: req.requestId };
  }

  @Get('practice-options') @Header('Cache-Control', 'private, no-store')
  practiceOptions(@Req() req: ApiRequest, @Query() query: unknown) {
    return this.result(req, this.assessment.practiceOptions(req, query));
  }

  @Post('practice-sessions') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  createPractice(@Req() req: ApiRequest, @Body() body: unknown) {
    return this.result(req, this.assessment.createPractice(req, body));
  }

  @Get('quizzes') @Header('Cache-Control', 'private, no-store')
  listQuizzes(@Req() req: ApiRequest, @Query() query: unknown) {
    return this.result(req, this.assessment.listQuizzes(req, query));
  }

  @Get('quizzes/:id') @Header('Cache-Control', 'private, no-store')
  quiz(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.result(req, this.assessment.quiz(req, id));
  }

  @Get('me/sessions') @Header('Cache-Control', 'private, no-store')
  listSessions(@Req() req: ApiRequest, @Query() query: unknown) {
    return this.result(req, this.assessment.listSessions(req, query));
  }

  @Post('quizzes/:id/sessions') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  startQuiz(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.result(req, this.assessment.startQuiz(req, id, body));
  }

  @Get('sessions/:id') @Header('Cache-Control', 'private, no-store')
  session(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.result(req, this.assessment.session(req, id));
  }

  @Get('sessions/:id/items') @Header('Cache-Control', 'private, no-store')
  sessionItems(@Req() req: ApiRequest, @Param('id') id: string, @Query() query: unknown) {
    return this.result(req, this.assessment.sessionItems(req, id, query));
  }

  @Put('sessions/:id/answers/:session_item_id') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  saveAnswer(@Req() req: ApiRequest, @Param('id') id: string, @Param('session_item_id') itemId: string, @Body() body: unknown) {
    return this.result(req, this.assessment.saveAnswer(req, id, itemId, body));
  }

  @Post('sessions/:id/submissions') @HttpCode(202) @Header('Cache-Control', 'private, no-store')
  submit(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.result(req, this.assessment.submit(req, id, body));
  }

  @Get('submissions/:id') @Header('Cache-Control', 'private, no-store')
  submission(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.result(req, this.assessment.submission(req, id));
  }

  @Get('submissions/:id/items') @Header('Cache-Control', 'private, no-store')
  submissionItems(@Req() req: ApiRequest, @Param('id') id: string, @Query() query: unknown) {
    return this.result(req, this.assessment.submissionItems(req, id, query));
  }

  @Get('me/idempotency-requests') @Header('Cache-Control', 'private, no-store')
  idempotency(@Req() req: ApiRequest, @Query() query: unknown) {
    return this.result(req, this.assessment.idempotency(req, query));
  }

  @Get('admin/quizzes') @Header('Cache-Control', 'private, no-store')
  adminQuizzes(@Req() req: ApiRequest, @Query() query: unknown) {
    return this.result(req, this.assessment.adminQuizzes(req, query));
  }

  @Get('admin/quizzes/:id') @Header('Cache-Control', 'private, no-store')
  adminQuiz(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.result(req, this.assessment.adminQuiz(req, id));
  }

  @Post('quizzes') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  createQuiz(@Req() req: ApiRequest, @Body() body: unknown) {
    return this.result(req, this.assessment.createQuiz(req, body));
  }

  @Patch('quizzes/:id') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  patchQuiz(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.result(req, this.assessment.patchQuiz(req, id, body));
  }

  @Post('quizzes/:id/publish') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  publishQuiz(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.result(req, this.assessment.publishQuiz(req, id, body));
  }

  @Get('admin/assessment-members') @Header('Cache-Control', 'private, no-store')
  members(@Req() req: ApiRequest, @Query() query: unknown) {
    return this.result(req, this.assessment.members(req, query));
  }

  @Get('admin/assessment-questions') @Header('Cache-Control', 'private, no-store')
  questions(@Req() req: ApiRequest, @Query() query: unknown) {
    return this.result(req, this.assessment.questions(req, query));
  }

  @Get('admin/assessment-questions/:version_id') @Header('Cache-Control', 'private, no-store')
  question(@Req() req: ApiRequest, @Param('version_id') versionId: string) {
    return this.result(req, this.assessment.question(req, versionId));
  }

  @Get('admin/submissions') @Header('Cache-Control', 'private, no-store')
  adminSubmissions(@Req() req: ApiRequest, @Query() query: unknown) {
    return this.result(req, this.assessment.adminSubmissions(req, query));
  }

  @Get('admin/submissions/:id') @Header('Cache-Control', 'private, no-store')
  adminSubmission(@Req() req: ApiRequest, @Param('id') id: string) {
    return this.result(req, this.assessment.adminSubmission(req, id));
  }

  @Post('submissions/:id/regrades') @HttpCode(202) @Header('Cache-Control', 'private, no-store')
  regrade(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.result(req, this.assessment.regrade(req, id, body));
  }
}
