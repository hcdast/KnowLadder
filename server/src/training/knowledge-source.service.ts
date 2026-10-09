import { Injectable } from "@nestjs/common";
import { ContentService } from "../content/content.service";
import { fail } from "../errors";
import { TrainingService } from "./training.service";
import * as v from "./validation";
import {
  knowledgeHash,
  knowledgeQueryTerms,
  prepareKnowledgeChunks,
  rankKnowledgeCandidates,
  KNOWLEDGE_LIMITS,
  type KnowledgeCandidate,
} from "./knowledge-text";

export type KnowledgeSource =
  | { kind: "chapter"; id: string }
  | { kind: "course-text"; id: string; lesson_key: string };

/** Current source authority; an index record is never accepted as permission. */
@Injectable()
export class KnowledgeSourceService {
  constructor(
    readonly training: TrainingService,
    readonly content: ContentService,
  ) {}

  parse(input: unknown): KnowledgeSource {
    const o = v.object(input, ["kind", "id", "lesson_key"]);
    const id = v.id(o.id);
    if (o.kind === "chapter" && o.lesson_key === undefined)
      return { kind: o.kind, id };
    if (o.kind === "course-text")
      return { kind: o.kind, id, lesson_key: v.text(o.lesson_key, 64) };
    fail(422, "KNOWLEDGE_SOURCE_INVALID", "仅允许教材章节和课程纯文本课时");
  }

  /** Bounded original-source grounding for the future index/dispatch integration. */
  async ground(
    ctx: Parameters<TrainingService["courseAccess"]>[0],
    query: string,
    inputs: unknown[],
  ) {
    knowledgeQueryTerms(query);
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 20)
      fail(422, "KNOWLEDGE_SCOPE_LIMIT", "请选择1至20个知识来源");
    const sources = inputs.map((input) => this.parse(input));
    const key = (source: KnowledgeSource) =>
      `${source.kind}:${source.id}:${source.kind === "course-text" ? source.lesson_key : ""}`;
    if (new Set(sources.map(key)).size !== sources.length)
      fail(422, "KNOWLEDGE_SCOPE_DUPLICATE", "知识来源不可重复");
    const candidates: KnowledgeCandidate[] = [];
    const originals = new Map<
      string,
      Awaited<ReturnType<KnowledgeSourceService["read"]>>
    >();
    for (const source of sources) {
      const original = await this.read(ctx, source);
      const chunks = prepareKnowledgeChunks(original.body);
      if (candidates.length + chunks.length > KNOWLEDGE_LIMITS.maxCandidates)
        fail(422, "KNOWLEDGE_CANDIDATE_LIMIT", "候选分片超限，请缩小检索范围");
      const sourceKey = key(source);
      originals.set(sourceKey, original);
      for (const chunk of chunks)
        candidates.push({ source_key: sourceKey, chunk });
    }
    const ranked = rankKnowledgeCandidates(query, candidates);
    return {
      status: ranked.length ? "grounded" : "insufficient-evidence",
      citations: ranked.map((item) => {
        const original = originals.get(item.source_key)!;
        return {
          source: original.source,
          title: original.title,
          revision: original.revision,
          owner_id: original.owner_id,
          source_hash: original.content_hash,
          start_utf16: item.chunk.start_utf16,
          end_utf16: item.chunk.end_utf16,
          content_hash: item.chunk.content_hash,
          text: item.chunk.text,
        };
      }),
    };
  }

  async read(
    ctx: Parameters<TrainingService["courseAccess"]>[0],
    source: KnowledgeSource,
    write = false,
  ) {
    if (source.kind === "chapter") {
      // ContentAccess.owner enforces both current publication and license/revocation.
      this.content.access.require(ctx, "read");
      const chapter = await this.training
        .col("chapters")
        .findOne(
          { _id: source.id, org_id: ctx.orgId },
          { session: ctx.session },
        );
      if (!chapter) fail(404, "NOT_FOUND", "知识来源不可访问");
      const owner = await this.content.access.owner(
        ctx,
        "textbook",
        chapter.textbook_edition_id,
        "read",
      );
      if (write) {
        const changed = await this.training
          .col("textbook_editions")
          .updateOne(
            {
              _id: owner._id,
              org_id: ctx.orgId,
              revision: owner.revision,
              access_revision: owner.access_revision,
            },
            { $inc: { access_revision: 1 } },
            { session: ctx.session },
          );
        if (changed.matchedCount !== 1)
          fail(409, "CONTEXT_CHANGED", "知识来源授权已变化");
      }
      return this.project(
        source,
        chapter.title,
        chapter.body,
        owner.revision,
        owner._id,
      );
    }
    if (source.kind !== "course-text")
      fail(422, "KNOWLEDGE_SOURCE_INVALID", "知识来源类型无效");
    const teacher = ctx.capabilities.some((capability) =>
      [
        "training:schedule-manage",
        "training:path-edit",
        "training:path-review",
        "training:certificate-issue",
        "course:edit",
        "course:review",
        "course:assign",
        "task:manage",
        "coursework:grade",
        "ai:generate",
      ].includes(capability),
    );
    if (!teacher) this.training.require(ctx, "learning:self");
    const course = await this.training.courseAccess(
      ctx,
      source.id,
      teacher,
      write,
    );
    if (course.status !== "published")
      fail(404, "NOT_FOUND", "知识来源不可访问");
    const lesson = course.lessons.find(
      (item: any) => item.key === source.lesson_key,
    );
    if (!lesson || lesson.kind !== "text")
      fail(404, "NOT_FOUND", "纯文本课时不存在");
    if (write) {
      const changed = await this.training
        .col("courses")
        .updateOne(
          {
            _id: course._id,
            org_id: ctx.orgId,
            revision: course.revision,
            status: "published",
          },
          { $inc: { revision: 0 } },
          { session: ctx.session },
        );
      if (changed.matchedCount !== 1)
        fail(409, "CONTEXT_CHANGED", "知识来源已变化");
    }
    return this.project(
      source,
      lesson.title,
      lesson.body,
      course.revision,
      course._id,
    );
  }

  private project(
    source: KnowledgeSource,
    title: string,
    body: string,
    revision: number,
    ownerId: string,
  ) {
    if (typeof body !== "string" || typeof title !== "string")
      fail(409, "KNOWLEDGE_SOURCE_INVALID", "知识来源正文无效");
    // Deliberate allowlist: no answers, attachments, grading or personal fields.
    return {
      source,
      title,
      body,
      revision,
      owner_id: ownerId,
      content_hash: knowledgeHash(body),
    };
  }
}
