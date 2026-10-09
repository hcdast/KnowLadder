import { createHash } from "node:crypto";

/** Pure index preparation. Callers must authorize sources before using any output. */
export const KNOWLEDGE_INDEX_VERSION = 1;
export const KNOWLEDGE_LIMITS = Object.freeze({
  chunkCharacters: 800,
  overlapCharacters: 100,
  maxChunks: 128,
  maxSourceCharacters: 89600,
  maxQueryCharacters: 256,
  maxQueryTerms: 64,
  maxCandidates: 200,
  maxResults: 5,
});

export interface KnowledgeChunk {
  ordinal: number;
  start_utf16: number;
  end_utf16: number;
  text: string;
  content_hash: string;
  terms: string[];
}

function invalid(code: string): never {
  throw Object.assign(new Error(code), { code });
}

function validUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (n >= 0xdc00 && n <= 0xdfff) return false;
  }
  return true;
}

export function knowledgeHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function terms(text: string): string[] {
  const found = new Set<string>();
  const normalized = text.normalize("NFKC").toLowerCase();
  for (const match of normalized.matchAll(/[\p{Script=Han}]+|[a-z0-9]+/gu)) {
    const token = match[0];
    if (/^\p{Script=Han}/u.test(token)) {
      const points = Array.from(token);
      if (points.length === 1) found.add(points[0]!);
      else
        for (let i = 0; i < points.length - 1; i++)
          found.add(points[i]! + points[i + 1]!);
    } else found.add(token);
  }
  return [...found].sort();
}

export function knowledgeQueryTerms(query: string): string[] {
  if (
    typeof query !== "string" ||
    !validUnicode(query) ||
    Array.from(query).length > KNOWLEDGE_LIMITS.maxQueryCharacters
  )
    invalid("KNOWLEDGE_QUERY_INVALID");
  const result = terms(query);
  if (!result.length) invalid("KNOWLEDGE_QUERY_EMPTY");
  if (result.length > KNOWLEDGE_LIMITS.maxQueryTerms)
    invalid("KNOWLEDGE_QUERY_LIMIT");
  return result;
}

export function prepareKnowledgeChunks(body: string): KnowledgeChunk[] {
  if (typeof body !== "string" || !validUnicode(body))
    invalid("KNOWLEDGE_SOURCE_INVALID");
  // Check UTF-16 size before allocating the code-point array.
  if (body.length > KNOWLEDGE_LIMITS.maxSourceCharacters * 2)
    invalid("KNOWLEDGE_SOURCE_LIMIT");
  const points = Array.from(body);
  if (points.length > KNOWLEDGE_LIMITS.maxSourceCharacters)
    invalid("KNOWLEDGE_SOURCE_LIMIT");
  if (!body.trim()) return [];
  const offsets = [0];
  for (const point of points)
    offsets.push(offsets[offsets.length - 1]! + point.length);
  const chunks: KnowledgeChunk[] = [];
  const step =
    KNOWLEDGE_LIMITS.chunkCharacters - KNOWLEDGE_LIMITS.overlapCharacters;
  for (let start = 0; start < points.length; start += step) {
    if (chunks.length >= KNOWLEDGE_LIMITS.maxChunks)
      invalid("KNOWLEDGE_CHUNK_LIMIT");
    const end = Math.min(
      start + KNOWLEDGE_LIMITS.chunkCharacters,
      points.length,
    );
    const text = body.slice(offsets[start], offsets[end]);
    chunks.push({
      ordinal: chunks.length,
      start_utf16: offsets[start]!,
      end_utf16: offsets[end]!,
      text,
      content_hash: knowledgeHash(text),
      terms: terms(text),
    });
    if (end === points.length) break;
  }
  return chunks;
}

export interface KnowledgeCandidate {
  source_key: string;
  chunk: KnowledgeChunk;
}

/** Rank only bounded, already authorized/current candidates; never establishes access. */
export function rankKnowledgeCandidates(
  query: string,
  candidates: KnowledgeCandidate[],
) {
  const queryTerms = knowledgeQueryTerms(query);
  if (candidates.length > KNOWLEDGE_LIMITS.maxCandidates)
    invalid("KNOWLEDGE_CANDIDATE_LIMIT");
  const seen = new Set<string>();
  return candidates
    .map((candidate) => {
      const key = `${candidate.source_key}:${candidate.chunk.ordinal}`;
      if (seen.has(key)) invalid("KNOWLEDGE_CANDIDATE_DUPLICATE");
      seen.add(key);
      const matches = new Set(candidate.chunk.terms);
      const score = queryTerms.filter((term) => matches.has(term)).length;
      return { ...candidate, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.source_key < b.source_key
          ? -1
          : a.source_key > b.source_key
            ? 1
            : 0) ||
        a.chunk.ordinal - b.chunk.ordinal,
    )
    .slice(0, KNOWLEDGE_LIMITS.maxResults);
}

export function knowledgeChunkMatches(
  body: string,
  chunk: KnowledgeChunk,
): boolean {
  if (
    !Number.isSafeInteger(chunk.start_utf16) ||
    !Number.isSafeInteger(chunk.end_utf16) ||
    chunk.start_utf16 < 0 ||
    chunk.end_utf16 <= chunk.start_utf16 ||
    chunk.end_utf16 > body.length
  )
    return false;
  const text = body.slice(chunk.start_utf16, chunk.end_utf16);
  return (
    validUnicode(text) &&
    text === chunk.text &&
    knowledgeHash(text) === chunk.content_hash
  );
}
