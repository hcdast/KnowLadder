import { Injectable } from "@nestjs/common";
import { ApiRequest, fail } from "../errors";
import { TrainingService } from "./training.service";
import {
  KnowledgeSourceService,
  type KnowledgeSource,
} from "./knowledge-source.service";
import { enqueueKnowledge, knowledgeEnabled } from "./knowledge-events";
import {
  KNOWLEDGE_INDEX_VERSION,
  KNOWLEDGE_LIMITS,
  knowledgeChunkMatches,
  knowledgeHash,
  prepareKnowledgeChunks,
  knowledgeQueryTerms,
  rankKnowledgeCandidates,
  type KnowledgeCandidate,
} from "./knowledge-text";
import * as v from "./validation";
type Context = Parameters<TrainingService["courseAccess"]>[0];
export function knowledgeSourceKey(source: KnowledgeSource) {
  return `${source.kind}:${source.id}:${source.kind === "course-text" ? source.lesson_key : ""}`;
}
@Injectable()
export class KnowledgeService {
  constructor(
    readonly training: TrainingService,
    readonly sources: KnowledgeSourceService,
  ) {}
  enabled() {
    if (!knowledgeEnabled()) fail(503, "KNOWLEDGE_DISABLED", "知识库尚未启用");
  }
  scope(input: unknown): KnowledgeSource[] {
    if (!Array.isArray(input) || !input.length || input.length > 20)
      fail(422, "KNOWLEDGE_SCOPE_LIMIT", "请选择1至20个来源");
    const sources = input.map((item) => this.sources.parse(item));
    if (new Set(sources.map(knowledgeSourceKey)).size !== sources.length)
      fail(422, "KNOWLEDGE_SCOPE_DUPLICATE", "来源不可重复");
    return sources;
  }
  async ground(ctx: Context, query: string, input: unknown, write = false) {
    this.enabled();
    try {
      knowledgeQueryTerms(query);
    } catch (error) {
      if (
        typeof (error as any).code === "string" &&
        (error as any).code.startsWith("KNOWLEDGE_QUERY_")
      )
        fail(422, (error as any).code, "查询须包含关键词且在256字符、64词以内");
      throw error;
    }
    const scope = this.scope(input),
      candidates: KnowledgeCandidate[] = [],
      states: any[] = [],
      originals = new Map<string, any>();
    for (const source of scope) {
      // Authorize/read original first; never reveal index metadata for forbidden sources.
      const original = await this.sources.read(ctx, source, write);
      const row = await this.training.col("knowledge_sources").findOne(
        {
          org_id: ctx.orgId,
          kind: source.kind,
          source_id: source.id,
          lesson_key: source.kind === "course-text" ? source.lesson_key : "",
        },
        { session: ctx.session },
      );
      const event = await this.training.col("knowledge_outbox").findOne(
        {
          org_id: ctx.orgId,
          kind: source.kind === "chapter" ? "textbook" : "course",
          owner_id: original.owner_id,
        },
        { session: ctx.session },
      );
      if (!row || !event || event.status !== "completed")
        fail(
          409,
          "KNOWLEDGE_INDEX_PENDING",
          "来源索引未就绪，请等待或申请重建",
        );
      if (write) {
        const fenced = await this.training
          .col("knowledge_outbox")
          .updateOne(
            {
              _id: event._id,
              org_id: ctx.orgId,
              status: "completed",
              generation: event.generation,
            },
            { $inc: { access_revision: 1 } },
            { session: ctx.session },
          );
        if (fenced.modifiedCount !== 1)
          fail(409, "CONTEXT_CHANGED", "知识来源更新状态已变化");
      }
      if (
        row.status !== "ready" ||
        row.index_version !== KNOWLEDGE_INDEX_VERSION ||
        row.owner_id !== original.owner_id ||
        row.source_revision !== original.revision ||
        row.source_hash !== original.content_hash
      )
        fail(409, "KNOWLEDGE_INDEX_STALE", "知识来源已变化，请重建后检索");
      if (
        !Array.isArray(row.chunks) ||
        candidates.length + row.chunks.length > KNOWLEDGE_LIMITS.maxCandidates
      )
        fail(422, "KNOWLEDGE_CANDIDATE_LIMIT", "候选分片超限，请缩小范围");
      // Validate complete deterministic chunk/term structure, not just individual excerpts.
      if (
        JSON.stringify(row.chunks) !==
        JSON.stringify(prepareKnowledgeChunks(original.body))
      )
        fail(409, "KNOWLEDGE_INDEX_STALE", "索引分片或关键词与原文不一致");
      const key = knowledgeSourceKey(source);
      originals.set(key, original);
      states.push({
        source,
        revision: original.revision,
        hash: original.content_hash,
      });
      for (const chunk of row.chunks) {
        if (!knowledgeChunkMatches(original.body, chunk))
          fail(409, "KNOWLEDGE_INDEX_STALE", "索引引用与原文不一致");
        candidates.push({ source_key: key, chunk });
      }
    }
    const ranked = rankKnowledgeCandidates(query, candidates);
    const citations = ranked.map((item, index) => {
      const original = originals.get(item.source_key);
      return {
        key: `evidence-${index + 1}`,
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
    });
    const fingerprint = knowledgeHash(
      JSON.stringify({
        query,
        states,
        citations,
        index_version: KNOWLEDGE_INDEX_VERSION,
      }),
    );
    return {
      status: citations.length ? "grounded" : "insufficient-evidence",
      citations,
      fingerprint,
    };
  }
  async search(req: ApiRequest, input: unknown) {
    this.enabled();
    const o = v.object(input, ["query", "scope"]),
      query = v.text(o.query, 512);
    return this.training.run(req, false, (ctx) =>
      this.ground(ctx, query, o.scope),
    );
  }
  async options(req: ApiRequest) {
    this.enabled();
    return this.training.run(req, false, async (ctx) => {
      const rows = await this.training
        .col("knowledge_sources")
        .find({ org_id: ctx.orgId }, { session: ctx.session })
        .sort({ kind: 1, title: 1, _id: 1 })
        .limit(201)
        .toArray();
      const items = [];
      for (const row of rows.slice(0, 200)) {
        const source: KnowledgeSource =
          row.kind === "chapter"
            ? { kind: "chapter", id: row.source_id }
            : {
                kind: "course-text",
                id: row.source_id,
                lesson_key: row.lesson_key,
              };
        try {
          const original = await this.sources.read(ctx, source);
          items.push({
            source,
            title: original.title,
            revision: original.revision,
            current:
              row.source_revision === original.revision &&
              row.source_hash === original.content_hash,
          });
        } catch (error) {
          if (![403, 404].includes((error as any).status)) throw error;
        }
      }
      return { items, truncated: rows.length > 200 };
    });
  }
  async rebuild(req: ApiRequest, input: unknown) {
    this.enabled();
    const o = v.object(input, ["source"]),
      source = this.sources.parse(o.source);
    return this.training.run(req, true, async (ctx) => {
      this.training.require(ctx, "ai:manage");
      let original: { owner_id: string; revision: number };
      if (source.kind === "chapter") {
        const chapter = await this.training.row(ctx, "chapters", source.id);
        const owner = await this.sources.content.access.owner(
          ctx,
          "textbook",
          chapter.textbook_edition_id,
          "manage",
        );
        original = { owner_id: owner._id, revision: owner.revision };
      } else {
        const course = await this.training.courseAccess(
          ctx,
          source.id,
          true,
          true,
        );
        original = { owner_id: course._id, revision: course.revision };
      }
      return this.training.idem(
        ctx,
        req,
        "knowledge.rebuild",
        source.id,
        o,
        async () => {
          await enqueueKnowledge(
            this.training.db,
            ctx,
            source.kind === "chapter" ? "textbook" : "course",
            original.owner_id,
          );
          const event = await this.training.col("knowledge_outbox").findOne(
            {
              org_id: ctx.orgId,
              owner_id: original.owner_id,
              kind: source.kind === "chapter" ? "textbook" : "course",
            },
            { session: ctx.session },
          );
          await this.training.access.audit(
            ctx,
            source.kind === "chapter" ? "textbook" : "course",
            original.owner_id,
            "training.knowledge.rebuild",
            "申请重建授权知识索引",
            { revision_after: original.revision },
          );
          return { status: "pending", generation: event!.generation };
        },
      );
    });
  }
  async status(req: ApiRequest) {
    this.enabled();
    return this.training.run(req, false, async (ctx) => {
      this.training.require(ctx, "ai:manage");
      const rows = await this.training
        .col("knowledge_outbox")
        .find({ org_id: ctx.orgId }, { session: ctx.session })
        .sort({ updated_at: -1, _id: 1 })
        .limit(101)
        .toArray();
      const items = [];
      for (const row of rows.slice(0, 100)) {
        try {
          if (row.kind === "course") {
            const course = await this.training.courseAccess(
              ctx,
              row.owner_id,
              true,
            );
            items.push({
              kind: row.kind,
              owner_id: row.owner_id,
              title: course.title,
              status: row.status,
              error_code: row.error_code,
              generation: row.generation,
              updated_at: row.updated_at,
              source: course.lessons.find(
                (lesson: any) => lesson.kind === "text",
              )
                ? {
                    kind: "course-text",
                    id: course._id,
                    lesson_key: course.lessons.find(
                      (lesson: any) => lesson.kind === "text",
                    ).key,
                  }
                : null,
            });
          } else {
            const owner = await this.sources.content.access.owner(
              ctx,
              "textbook",
              row.owner_id,
              "manage",
            );
            const chapter = await this.training
              .col("chapters")
              .findOne(
                { org_id: ctx.orgId, textbook_edition_id: owner._id },
                { session: ctx.session },
              );
            items.push({
              kind: row.kind,
              owner_id: row.owner_id,
              title: owner.title,
              status: row.status,
              error_code: row.error_code,
              generation: row.generation,
              updated_at: row.updated_at,
              source: chapter ? { kind: "chapter", id: chapter._id } : null,
            });
          }
        } catch (error) {
          if (![403, 404].includes((error as any).status)) throw error;
        }
      }
      return {
        items,
        truncated: rows.length > 100,
        index_version: KNOWLEDGE_INDEX_VERSION,
      };
    });
  }
}
