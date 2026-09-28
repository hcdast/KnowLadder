import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Database } from '../database/database';
import { ApiRequest, fail } from '../errors';
import { AssessmentSources } from '../content/assessment-sources';
import type { FileResource } from '../content/contracts';
import { FilesService } from '../files/files.service';
import { AssessmentAccess } from './access';
import type { AssessmentContext, AssessmentSession, SessionItem } from './contracts';
import { recordLearningFeedback } from '../learning/tracking';

@ApiTags('评估附件')
@ApiCookieAuth('session')
@Controller('api/v1')
export class AssessmentFilesController {
  constructor(readonly database: Database, readonly access: AssessmentAccess, readonly files: FilesService) {}
  private async file(ctx: AssessmentContext, versionId: string, fileId: string) {
    const file = await this.database.db.collection<FileResource>('file_resources').findOne({ _id: fileId, org_id: ctx.orgId, owner_type: 'question', owner_version_id: versionId, status: 'ready', scan_status: 'clean', deletion_requested_at: null, deleted_at: null }, { session: ctx.session });
    if (!file) fail(404, 'NOT_FOUND', '附件不存在或不可用');
    return file;
  }
  @Get('admin/assessment-questions/:version_id/files/:file_id/content')
  @ApiOperation({ summary: '独立评估管理能力预览已授权题目附件' })
  async preview(@Req() req: ApiRequest, @Param('version_id') versionId: string, @Param('file_id') fileId: string, @Res() res: Response) {
    await this.files.deliverAuthorized(req,res,prepare=>this.access.run(req, false, async ctx => {
      if (!ctx.capabilities.some(c => c === 'assessment:manage' || c === 'assessment:review')) fail(403, 'FORBIDDEN', '未获评估管理能力');
      const source = await new AssessmentSources(this.database.db).question(ctx, versionId, false);
      if (!source.resource_ids.includes(fileId)) fail(404, 'NOT_FOUND', '附件不属于题目版本');
      const file=await this.file(ctx,versionId,fileId);
      await prepare(file);
      await recordLearningFeedback(this.database.db,ctx,[source.question_id]);
      return file;
    }));
  }
  @Get('sessions/:id/items/:item_id/files/:file_id/content')
  @ApiOperation({ summary: '本人会话冻结题项附件；逐次检查授权及考试保密' })
  async download(@Req() req: ApiRequest, @Param('id') id: string, @Param('item_id') itemId: string, @Param('file_id') fileId: string, @Res() res: Response) {
    const file = await this.access.run(req, false, async ctx => {
      this.access.require(ctx, 'learning:self');
      const row = await this.database.db.collection<AssessmentSession>('sessions').findOne({ _id: id, org_id: ctx.orgId, user_id: ctx.userId, member_id: ctx.memberId }, { session: ctx.session });
      if (!row || row.status === 'cancelled') fail(404, 'NOT_FOUND', '会话不存在');
      const item = await this.database.db.collection<SessionItem>('session_items').findOne({ _id: itemId, org_id: ctx.orgId, session_id: id }, { session: ctx.session });
      if (!item || !item.snapshot.resource_ids.includes(fileId)) fail(404, 'NOT_FOUND', '题项附件不存在');
      const sources = new AssessmentSources(this.database.db);
      if (row.mode === 'quiz') {
        if (ctx.capabilities.some(c => ['content:edit', 'content:review', 'assessment:manage', 'assessment:review'].includes(c))) fail(403, 'FORBIDDEN', '考试职责冲突');
        if (!await this.database.db.collection('quiz_audiences').findOne({ org_id: ctx.orgId, quiz_id: row.quiz_id, member_id: ctx.memberId }, { session: ctx.session })) fail(404, 'NOT_FOUND', '考试受众资格无效');
      } else {
        if (!row.textbook_edition_id) fail(409, 'CONTENT_UNAVAILABLE', '教材范围不可用');
        await sources.textbook(ctx, row.textbook_edition_id, false);
      }
      // Check the whole session, not just one item: embargo/revocation cannot be bypassed with a file URL.
      const items = await this.database.db.collection<SessionItem>('session_items').find({ org_id: ctx.orgId, session_id: id }, { session: ctx.session }).limit(51).toArray();
      if (items.length !== row.item_count || items.length > 50) fail(409, 'CONTENT_UNAVAILABLE', '会话题项不完整');
      for (const source of [...items].sort((a, b) => a.snapshot.question_version_id.localeCompare(b.snapshot.question_version_id))) await sources.question(ctx, source.snapshot.question_version_id, false);
      await sources.guard(ctx, items.map(i => i.snapshot.question_version_id), row.mode, row.quiz_id ?? undefined);
      return this.file(ctx, item.snapshot.question_version_id, fileId);
    });
    await this.files.deliver(req, file, res);
  }
}
