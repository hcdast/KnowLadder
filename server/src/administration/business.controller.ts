import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ContentService } from '../content/content.service';
import { AssessmentService } from '../assessment/assessment.service';
import { FilesService, type RegisterFile, type ScheduleDeletion } from '../files/files.service';
import { ApiRequest, fail } from '../errors';
import { object, text } from '../assessment/dto';
import { bindPlatformBusinessRequest, PlatformBusinessAccess, type BusinessModule } from './platform-access';
import { PlatformReportService } from './report.service';
import { previewAssessmentAttachment } from '../assessment/question-files';
const CONTENT_READ = ['content:edit', 'content:review'];
const CONTENT_METADATA = [...CONTENT_READ, 'content:retire', 'content:revoke'];
const FILE_METADATA = [...CONTENT_READ, 'file:delete'];
const CONTENT_ALL = [...CONTENT_METADATA, 'file:delete'];
const ASSESSMENT_READ = ['assessment:manage', 'assessment:review'];

@ApiTags('平台跨组织业务')
@ApiCookieAuth('session')
@ApiHeader({ name: 'X-Org-Id', required: true, description: '有效平台组织' })
@ApiHeader({ name: 'X-Target-Org-Id', required: true, description: '单个目标业务组织' })
@Controller('api/v1/console/business')
export class PlatformBusinessController {
  constructor(readonly content: ContentService, readonly assessment: AssessmentService, readonly files: FilesService,
    readonly reports: PlatformReportService, readonly access: PlatformBusinessAccess) {}
  private result(req: ApiRequest, module: BusinessModule, work: () => Promise<unknown>, accepted?: readonly string[]) {
    bindPlatformBusinessRequest(req, module, accepted ?? (module === 'content' ? CONTENT_READ : module === 'assessment' ? ASSESSMENT_READ : ['report:read']));
    return work().then(data => ({ data, request_id: req.requestId }));
  }

  @Get('content/admin/content-options') contentOptions(@Req() req: ApiRequest) { return this.result(req, 'content', () => this.content.options(req)); }
  @Get('content/admin/textbook-editions') textbooks(@Req() req: ApiRequest, @Query() q: unknown) { return this.result(req, 'content', () => this.content.list(req, 'textbook', q), CONTENT_METADATA); }
  @Get('content/admin/textbook-editions/:id') textbook(@Req() req: ApiRequest, @Param('id') key: string) { return this.result(req, 'content', () => this.content.detail(req, 'textbook', key), CONTENT_METADATA); }
  @Get('content/admin/textbook-editions/:id/chapters') chapters(@Req() req: ApiRequest, @Param('id') key: string, @Query() q: unknown) { return this.result(req, 'content', () => this.content.chapterPage(req, key, q, false)); }
  @Post('content/admin/textbook-editions') @HttpCode(200) createTextbook(@Req() req: ApiRequest, @Body() body: unknown) { return this.result(req, 'content', () => this.content.create(req, 'textbook', body), ['content:edit']); }
  @Patch('content/admin/textbook-editions/:id') patchTextbook(@Req() req: ApiRequest, @Param('id') key: string, @Body() body: unknown) { return this.result(req, 'content', () => this.content.patch(req, 'textbook', key, body), ['content:edit']); }
  @Put('content/admin/textbook-editions/:id/chapters') saveChapters(@Req() req: ApiRequest, @Param('id') key: string, @Body() body: unknown) { return this.result(req, 'content', () => this.content.chapters(req, key, body), ['content:edit']); }
  @Post('content/admin/textbook-editions/:id/submit-review') @HttpCode(200) submitTextbook(@Req() req: ApiRequest, @Param('id') key: string, @Body() body: unknown) { return this.result(req, 'content', () => this.content.transition(req, 'textbook', key, 'submit-review', body), ['content:edit']); }
  @Post('content/admin/textbook-editions/:id/return') @HttpCode(200) returnTextbook(@Req() req: ApiRequest, @Param('id') key: string, @Body() body: unknown) { return this.result(req, 'content', () => this.content.transition(req, 'textbook', key, 'return', body), ['content:review']); }
  @Post('content/admin/textbook-editions/:id/publish') @HttpCode(200) publishTextbook(@Req() req: ApiRequest, @Param('id') key: string, @Body() body: unknown) { return this.result(req, 'content', () => this.content.transition(req, 'textbook', key, 'publish', body), ['content:review']); }
  @Post('content/admin/textbook-editions/:id/retire') @HttpCode(200) retireTextbook(@Req() req: ApiRequest, @Param('id') key: string, @Body() body: unknown) { return this.result(req, 'content', () => this.content.stop(req, 'textbook', key, 'retire', body), ['content:retire']); }
  @Post('content/admin/textbook-editions/:id/revoke-access') @HttpCode(200) revokeTextbook(@Req() req: ApiRequest, @Param('id') key: string, @Body() body: unknown) { return this.result(req, 'content', () => this.content.stop(req, 'textbook', key, 'revoke-access', body), ['content:revoke']); }

  @Get('content/admin/question-versions') questions(@Req() req: ApiRequest, @Query() q: unknown) { return this.result(req, 'content', () => this.content.list(req, 'question', q), CONTENT_METADATA); }
  @Get('content/admin/question-versions/:id') question(@Req() req: ApiRequest, @Param('id') key: string) { return this.result(req, 'content', () => this.content.detail(req, 'question', key), CONTENT_METADATA); }
  @Post('content/admin/question-versions') @HttpCode(200) createQuestion(@Req() req: ApiRequest, @Body() body: unknown) { return this.result(req, 'content', () => this.content.create(req, 'question', body), ['content:edit']); }
  @Patch('content/admin/question-versions/:id') patchQuestion(@Req() req: ApiRequest, @Param('id') key: string, @Body() body: unknown) { return this.result(req, 'content', () => this.content.patch(req, 'question', key, body), ['content:edit']); }
  @Post('content/admin/question-versions/:id/submit-review') @HttpCode(200) submitQuestion(@Req() req: ApiRequest, @Param('id') key: string, @Body() body: unknown) { return this.result(req, 'content', () => this.content.transition(req, 'question', key, 'submit-review', body), ['content:edit']); }
  @Post('content/admin/question-versions/:id/return') @HttpCode(200) returnQuestion(@Req() req: ApiRequest, @Param('id') key: string, @Body() body: unknown) { return this.result(req, 'content', () => this.content.transition(req, 'question', key, 'return', body), ['content:review']); }
  @Post('content/admin/question-versions/:id/publish') @HttpCode(200) publishQuestion(@Req() req: ApiRequest, @Param('id') key: string, @Body() body: unknown) { return this.result(req, 'content', () => this.content.transition(req, 'question', key, 'publish', body), ['content:review']); }
  @Post('content/admin/question-versions/:id/retire') @HttpCode(200) retireQuestion(@Req() req: ApiRequest, @Param('id') key: string, @Body() body: unknown) { return this.result(req, 'content', () => this.content.stop(req, 'question', key, 'retire', body), ['content:retire']); }
  @Post('content/admin/question-versions/:id/revoke-access') @HttpCode(200) revokeQuestion(@Req() req: ApiRequest, @Param('id') key: string, @Body() body: unknown) { return this.result(req, 'content', () => this.content.stop(req, 'question', key, 'revoke-access', body), ['content:revoke']); }
  @Get('content/admin/audit-events') contentAudit(@Req() req: ApiRequest, @Query() q: unknown) { return this.result(req, 'content', () => this.content.audits(req, q)); }

  @Post('content/admin/files') @HttpCode(200) register(@Req() req: ApiRequest, @Body() body: RegisterFile) { return this.result(req, 'content', () => this.files.register(req, body), ['content:edit']); }
  @Get('content/admin/files') listFiles(@Req() req: ApiRequest, @Query() q: Record<string, unknown>) { return this.result(req, 'content', () => this.files.list(req, q), FILE_METADATA); }
  @Put('content/admin/files/:id/content') upload(@Req() req: ApiRequest, @Param('id') key: string) { return this.result(req, 'content', () => this.files.upload(req, key), ['content:edit']); }
  @Get('content/admin/files/:id') file(@Req() req: ApiRequest, @Param('id') key: string) { return this.result(req, 'content', () => this.files.status(req, key), FILE_METADATA); }
  @Post('content/admin/files/:id/schedule-deletion') @HttpCode(200) deleteFile(@Req() req: ApiRequest, @Param('id') key: string, @Body() body: ScheduleDeletion) { return this.result(req, 'content', () => this.files.scheduleDeletion(req, key, body), ['file:delete']); }
  @Get('content/admin/files/:id/content') preview(@Req() req: ApiRequest, @Param('id') key: string, @Res() res: Response) {
    bindPlatformBusinessRequest(req, 'content', CONTENT_READ);
    return this.files.download(req, key, res, true);
  }

  @Get('assessment/admin/quizzes') quizzes(@Req() req: ApiRequest, @Query() q: unknown) { return this.result(req, 'assessment', () => this.assessment.adminQuizzes(req, q)); }
  @Get('assessment/admin/quizzes/:id') quiz(@Req() req: ApiRequest, @Param('id') key: string) { return this.result(req, 'assessment', () => this.assessment.adminQuiz(req, key)); }
  @Post('assessment/quizzes') @HttpCode(200) createQuiz(@Req() req: ApiRequest, @Body() body: unknown) { return this.result(req, 'assessment', () => this.assessment.createQuiz(req, body), ['assessment:manage']); }
  @Patch('assessment/quizzes/:id') patchQuiz(@Req() req: ApiRequest, @Param('id') key: string, @Body() body: unknown) { return this.result(req, 'assessment', () => this.assessment.patchQuiz(req, key, body), ['assessment:manage']); }
  @Post('assessment/quizzes/:id/publish') @HttpCode(200) publishQuiz(@Req() req: ApiRequest, @Param('id') key: string, @Body() body: unknown) { return this.result(req, 'assessment', () => this.assessment.publishQuiz(req, key, body), ['assessment:review']); }
  @Get('assessment/admin/assessment-members') members(@Req() req: ApiRequest, @Query() q: unknown) { return this.result(req, 'assessment', () => this.assessment.members(req, q), ['assessment:manage']); }
  @Get('assessment/admin/assessment-questions') assessmentQuestions(@Req() req: ApiRequest, @Query() q: unknown) { return this.result(req, 'assessment', () => this.assessment.questions(req, q)); }
  @Get('assessment/admin/assessment-questions/:id') assessmentQuestion(@Req() req: ApiRequest, @Param('id') key: string) { return this.result(req, 'assessment', () => this.assessment.question(req, key)); }
  @Get('assessment/admin/assessment-questions/:version_id/files/:file_id/content')
  async assessmentAttachment(@Req() req: ApiRequest, @Param('version_id') versionId: string,
    @Param('file_id') fileId: string, @Res() res: Response) {
    bindPlatformBusinessRequest(req, 'assessment', ASSESSMENT_READ);
    await previewAssessmentAttachment(this.assessment.access, this.files, req, versionId, fileId, res);
  }
  @Get('assessment/admin/submissions') submissions(@Req() req: ApiRequest, @Query() q: unknown) {
    return this.result(req, 'assessment', async () => {
      const result = await this.assessment.adminSubmissions(req, q);
      await this.access.run(req, 'assessment', ctx => this.access.audit(ctx, 'assessment.submissions.read', 'submission', 'list', ['assessment:review']));
      return result;
    }, ['assessment:review']);
  }
  @Get('assessment/admin/submissions/:id') submission(@Req() req: ApiRequest, @Param('id') key: string) {
    return this.result(req, 'assessment', async () => {
      const result = await this.assessment.adminSubmission(req, key);
      await this.access.run(req, 'assessment', ctx => this.access.audit(ctx, 'assessment.submission.read', 'submission', key, ['assessment:review']));
      return result;
    }, ['assessment:review']);
  }
  @Post('assessment/submissions/:id/regrades') @HttpCode(202) regrade(@Req() req: ApiRequest, @Param('id') key: string, @Body() body: unknown) { return this.result(req, 'assessment', () => this.assessment.regrade(req, key, body), ['assessment:review']); }
  @Get('assessment/admin/audit-events') assessmentAudit(@Req() req: ApiRequest, @Query() q: unknown) { return this.result(req, 'assessment', () => this.assessment.audits(req, q)); }

  @Get('reports/options') reportOptions(@Req() req: ApiRequest, @Query() q: unknown) { return this.result(req, 'report', () => this.reports.options(req, q)); }
  @Get('reports/classes/:classId/subjects/:subjectId') classReport(@Req() req: ApiRequest, @Param('classId') c: string, @Param('subjectId') s: string) { return this.result(req, 'report', () => this.reports.classReport(req, c, s)); }
  @Get('reports/classes/:classId/subjects/:subjectId/students/:memberId') studentReport(@Req() req: ApiRequest, @Param('classId') c: string, @Param('subjectId') s: string, @Param('memberId') m: string, @Query('period') p?: string) { return this.result(req, 'report', () => this.reports.student(req, c, s, m, p)); }

  @Get('content/requests') contentReceipt(@Req() req: ApiRequest, @Query() raw: unknown) {
    const q = object(raw, ['key', 'resource_id']);
    return this.result(req, 'content', () => this.receipt(req, q, 'content'), q.resource_id === undefined ? CONTENT_ALL : ['content:edit']);
  }
  @Get('assessment/requests') assessmentReceipt(@Req() req: ApiRequest, @Query() raw: unknown) {
    return this.result(req, 'assessment', () => this.receipt(req, raw, 'assessment'), ASSESSMENT_READ);
  }
  private async receipt(req: ApiRequest, raw: unknown, module: 'content' | 'assessment') {
    const q = object(raw, module === 'content' ? ['key', 'resource_id'] : ['key']);
    const key = text(q.key, 'key', 128);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) fail(422, 'VALIDATION_ERROR', '幂等查询键无效');
    if (q.resource_id !== undefined) {
      if (module !== 'content' || typeof q.resource_id !== 'string') fail(422, 'VALIDATION_ERROR', '文件ID无效');
      return this.files.uploadReceipt(req, key, q.resource_id);
    }
    return this.access.run(req, module, async ctx => {
      const name = module === 'content' ? 'content_idempotency' : 'idempotency_records';
      const operationPrefix = `${ctx.actorOrgId}:`;
      const rows = await this.access.database.db.collection<{ _id: string; operation: string; result: Record<string, unknown> }>(name)
        .find({ org_id: ctx.orgId, user_id: ctx.userId, key, operation: { $regex: `^${operationPrefix}` } },
          { session: ctx.session, projection: { operation: 1, result: 1 } }).limit(2).toArray();
      if (rows.length > 1) fail(409, 'IDEMPOTENCY_AMBIGUOUS', '此key对应多个资源，请联系管理员核查');
      if (!rows.length) return { status: 'unknown' };
      const operation = rows[0]?.operation.slice(operationPrefix.length);
      const allowed = module === 'content'
        ? operation?.endsWith('.retire') ? ['content:retire']
          : operation?.endsWith('.revoke-access') ? ['content:revoke']
            : operation === 'file.schedule-deletion' ? ['file:delete']
              : operation?.endsWith('.publish') || operation?.endsWith('.return') ? ['content:review']
                : operation === 'file.register' || /^(?:textbook|question)\.(?:create|patch|chapters|submit-review)$/.test(operation ?? '') ? ['content:edit'] : []
        : operation === 'quiz.publish' || operation === 'submission.regrade' ? ['assessment:review']
          : operation === 'quiz.create' || operation === 'quiz.patch' ? ['assessment:manage'] : [];
      if (!ctx.grants.some(grant => allowed.includes(grant.capability))) fail(403, 'FORBIDDEN', '操作授权已失效');
      const result = rows[0].result;
      await this.access.audit(ctx, 'business.receipt.read', 'business_receipt', rows[0]._id, allowed);
      return { status: 'resolved', result: { id: typeof result.id === 'string' ? result.id : null,
        revision: typeof result.revision === 'number' ? result.revision : null,
        status: typeof result.status === 'string' ? result.status : null } };
    });
  }
}
