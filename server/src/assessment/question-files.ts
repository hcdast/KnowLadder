import type { Db } from 'mongodb';
import type { Response } from 'express';
import { ApiRequest, fail } from '../errors';
import { AssessmentSources } from '../content/assessment-sources';
import type { FileResource } from '../content/contracts';
import { FilesService } from '../files/files.service';
import { recordLearningFeedback } from '../learning/tracking';
import { AssessmentAccess } from './access';
import type { AssessmentContext } from './contracts';

export async function questionAttachment(db: Db, ctx: AssessmentContext, versionId: string, fileId: string): Promise<FileResource> {
  const file = await db.collection<FileResource>('file_resources').findOne({ _id: fileId, org_id: ctx.orgId,
    owner_type: 'question', owner_version_id: versionId, status: 'ready', scan_status: 'clean',
    deletion_requested_at: null, deleted_at: null }, { session: ctx.session });
  if (!file) fail(404, 'NOT_FOUND', '附件不存在或不可用');
  return file;
}

/** Both organization and scoped platform previews use the same license/file gate. */
export async function previewAssessmentAttachment(access: AssessmentAccess, files: FilesService, req: ApiRequest,
  versionId: string, fileId: string, response: Response): Promise<void> {
  await files.deliverAuthorized(req, response, prepare => access.run(req, false, async ctx => {
    if (!ctx.capabilities.some(capability => capability === 'assessment:manage' || capability === 'assessment:review'))
      fail(403, 'FORBIDDEN', '未获评估管理能力');
    const source = await new AssessmentSources(access.database.db).question(ctx, versionId, false);
    if (!source.resource_ids.includes(fileId)) fail(404, 'NOT_FOUND', '附件不属于题目版本');
    const file = await questionAttachment(access.database.db, ctx, versionId, fileId);
    await prepare(file);
    await recordLearningFeedback(access.database.db, ctx, [source.question_id]);
    if (ctx.platform) await access.platform.audit(ctx.platform, 'assessment.question.file.read', 'question', versionId,
      ['assessment:manage', 'assessment:review']);
    return file;
  }));
}
