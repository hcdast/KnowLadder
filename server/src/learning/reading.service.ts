import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Database } from '../database/database';
import { ApiRequest, fail } from '../errors';
import { canonical, id, integer, object } from '../content/dto';
import { AssessmentSources } from '../content/assessment-sources';
import type { AssessmentContext } from '../assessment/contracts';
import type { ChapterRecord, TextbookVersion } from '../content/contracts';
import { LearningAccess } from './access';
import type { ReadingEvent, ReadingEventInput, ReadingPage, ReadingProgress, ReadingResult } from './reading.contracts';
import { requireEvidenceSubject } from '../assessment/subject-access';

function eventInput(raw: unknown): ReadingEventInput {
  if (Buffer.byteLength(JSON.stringify(raw) ?? '', 'utf8') > 2048) fail(413, 'PAYLOAD_TOO_LARGE', '阅读事件不得超过2KiB');
  const value = object(raw, ['event_type', 'event_id', 'textbook_edition_id', 'chapter_id', 'edition_revision', 'expected_revision', 'position', 'completed']);
  if (value.event_type !== 'reading_progress_set' || typeof value.completed !== 'boolean') fail(422, 'VALIDATION_ERROR', '须明确提交阅读位置与完成标记');
  const position = object(value.position, ['kind', 'offset_utf16']);
  if (position.kind !== 'text_offset') fail(422, 'VALIDATION_ERROR', '仅支持正文UTF-16位置');
  return { event_type: 'reading_progress_set', event_id: id(value.event_id, 'event_id'),
    textbook_edition_id: id(value.textbook_edition_id, 'textbook_edition_id'), chapter_id: id(value.chapter_id, 'chapter_id'),
    edition_revision: integer(value.edition_revision, 'edition_revision'), expected_revision: integer(value.expected_revision, 'expected_revision', 0),
    position: { kind: 'text_offset', offset_utf16: integer(position.offset_utf16, 'offset_utf16', 0) }, completed: value.completed };
}

@Injectable()
export class ReadingService {
  constructor(readonly database: Database, readonly access: LearningAccess) {}
  private async edition(ctx: AssessmentContext, editionId: string): Promise<TextbookVersion> {
    await new AssessmentSources(this.database.db).textbook(ctx, editionId, true);
    const row = await this.database.db.collection<TextbookVersion>('textbook_editions').findOne({ _id: editionId, org_id: ctx.orgId }, { session: ctx.session });
    if (!row) fail(409, 'CONTENT_UNAVAILABLE', '教材不可用');
    return row;
  }
  async progress(req: ApiRequest, raw: unknown): Promise<ReadingPage> {
    const query = object(raw, ['textbook_edition_id', 'chapter_id', 'cursor', 'limit']);
    const editionId = id(query.textbook_edition_id, 'textbook_edition_id');
    const chapterId = query.chapter_id === undefined ? undefined : id(query.chapter_id, 'chapter_id');
    const limit = query.limit === undefined ? 20 : typeof query.limit === 'string' && /^[1-9]\d*$/.test(query.limit) ? integer(Number(query.limit), 'limit', 1, 50) : integer(query.limit, 'limit', 1, 50);
    return this.access.run(req, false, async ctx => {
      const edition = await this.edition(ctx, editionId);
      const cursor = this.access.cursor(ctx, 'reading-progress', { textbook_edition_id: editionId, chapter_id: chapterId ?? null }, String(edition.revision), query.cursor, limit);
      const chapters = await this.database.db.collection<ChapterRecord>('chapters').find({ org_id: ctx.orgId, textbook_edition_id: editionId,
        ...(chapterId ? { _id: chapterId } : {}), ...(cursor.after ? { _id: { $gt: cursor.after, ...(chapterId ? { $eq: chapterId } : {}) } } : {}),
      }, { session: ctx.session }).sort({ _id: 1 }).limit(limit + 1).toArray();
      if (chapterId && !chapters.length && !cursor.after) fail(404, 'NOT_FOUND', '章节不存在');
      const page = chapters.slice(0, limit);
      const rows = await this.database.db.collection<ReadingProgress>('reading_progress').find({ org_id: ctx.orgId, member_id: ctx.memberId, edition_id: editionId, chapter_id: { $in: page.map(ch => ch._id) } }, { session: ctx.session }).toArray();
      const byChapter = new Map(rows.map(row => [row.chapter_id, row]));
      return { textbook_edition_id: editionId, edition_revision: edition.revision,
        items: page.map(chapter => {
          const row = byChapter.get(chapter._id);
          const current = row?.edition_revision === edition.revision && row.cleared_at === null;
          return { chapter_id: chapter._id, edition_revision: edition.revision, position: current ? row.position : null,
            completed: current ? row.completed : null, progress_revision: row?.revision ?? 0, updated_at: current ? row.updated_at.toISOString() : null };
        }), next_cursor: chapters.length > limit ? cursor.next(page[page.length - 1]._id) : null };
    }, false);
  }
  async record(req: ApiRequest, raw: unknown): Promise<ReadingResult> {
    const input = eventInput(raw);
    return this.access.run(req, true, async ctx => {
      await requireEvidenceSubject(this.database.db, ctx.session, ctx.userId);
      const edition = await this.edition(ctx, input.textbook_edition_id);
      if (edition.revision !== input.edition_revision) fail(409, 'READING_CONTENT_CHANGED', '教材修订已变化');
      const chapter = await this.database.db.collection<ChapterRecord>('chapters').findOne({ _id: input.chapter_id, org_id: ctx.orgId, textbook_edition_id: edition._id }, { session: ctx.session });
      if (!chapter) fail(404, 'NOT_FOUND', '章节不存在');
      const offset = input.position.offset_utf16;
      if (!chapter.body.length || offset > chapter.body.length || offset > 0 && offset < chapter.body.length &&
        chapter.body.charCodeAt(offset - 1) >= 0xd800 && chapter.body.charCodeAt(offset - 1) <= 0xdbff &&
        chapter.body.charCodeAt(offset) >= 0xdc00 && chapter.body.charCodeAt(offset) <= 0xdfff) fail(422, 'VALIDATION_ERROR', '位置不在正文合法UTF-16边界');
      return this.access.idempotentKey(ctx, input.event_id, 'learning.reading_progress_set', ctx.memberId, input, async () => {
        const progress = this.database.db.collection<ReadingProgress>('reading_progress');
        const filter = { org_id: ctx.orgId, member_id: ctx.memberId, chapter_id: chapter._id };
        const previous = await progress.findOne(filter, { session: ctx.session });
        if ((previous?.revision ?? 0) !== input.expected_revision) fail(409, 'READING_REVISION_CONFLICT', '阅读进度已变化，请读取后明确选择');
        const now = await this.access.now(ctx), revision = input.expected_revision + 1;
        if (!Number.isSafeInteger(revision)) fail(409, 'READING_REVISION_CONFLICT', '阅读修订已达到上限');
        const fields = { edition_id: edition._id, edition_revision: edition.revision, position: input.position, completed: input.completed, revision, updated_at: now, cleared_at: null };
        if (previous) {
          const updated = await progress.updateOne({ ...filter, revision: input.expected_revision }, { $set: fields }, { session: ctx.session });
          if (updated.matchedCount !== 1) fail(409, 'READING_REVISION_CONFLICT', '阅读进度已变化');
        } else await progress.insertOne({ _id: randomUUID(), ...filter, ...fields }, { session: ctx.session });
        await this.database.db.collection<ReadingEvent>('behavior_events').insertOne({ _id: randomUUID(), ...filter,
          event_id: input.event_id, event_type: input.event_type, request_hash: createHash('sha256').update(canonical(input)).digest('hex'),
          edition_id: edition._id, edition_revision: edition.revision, expected_revision: input.expected_revision,
          position: input.position, completed: input.completed, server_received_at: now, progress_revision: revision,
        }, { session: ctx.session });
        return { event_id: input.event_id, progress_revision: revision, server_received_at: now.toISOString() };
      });
    }, false);
  }
}
