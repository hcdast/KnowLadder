import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Document } from "mongodb";
import { fail } from "../errors";
import * as v from "./validation";

// These joins establish the candidate scope. Course/media authorization still runs
// before any title, subject name, preview or comparison data is returned.
export function learnerLinks(org: string, member: string, now: Date): Document[] {
  return [
    { $match: { org_id: org, status: "active" } },
    { $lookup: { from: "class_members", let: { clazz: "$class_id" }, pipeline: [
      { $match: { org_id: org, member_id: member, status: "active",
        $expr: { $eq: ["$class_id", "$$clazz"] }, $and: [
          { $or: [{ valid_from: null }, { valid_from: { $lte: now } }] },
          { $or: [{ valid_to: null }, { valid_to: { $gte: now } }] },
        ] } }, { $limit: 1 }, { $project: { _id: 1 } },
    ], as: "_learner_members" } },
    { $match: { "_learner_members.0": { $exists: true } } },
    { $lookup: { from: "classes", localField: "class_id", foreignField: "_id",
      pipeline: [{ $match: { org_id: org, status: "active" } }, { $project: { _id: 1 } }], as: "_learner_classes" } },
    { $match: { "_learner_classes.0": { $exists: true } } },
    { $limit: 1 }, { $project: { _id: 1, class_id: 1, revision: 1, org_id: 1 } },
  ];
}

export function discoveryQuery(raw: unknown) {
  const q = v.object(raw, ["cursor", "limit", "q", "subject_id", "format", "sort"]);
  const limit = q.limit === undefined ? 20 : v.integer(Number(v.text(q.limit, 2)), 1, 50);
  const term = q.q === undefined ? "" : v.text(q.q, 100, true).normalize("NFKC").trim();
  const subject = q.subject_id === undefined ? "" : v.id(q.subject_id);
  const format = q.format === undefined ? "" : v.text(q.format, 10);
  const sort = q.sort === undefined ? "newest" : v.text(q.sort, 10);
  if (format && !["text", "pdf", "video", "audio"].includes(format)) fail(422, "INVALID_INPUT", "内容形态无效");
  if (!["newest", "oldest"].includes(sort)) fail(422, "INVALID_INPUT", "目录排序无效");
  return { limit, term, subject, format, sort, cursor: q.cursor };
}

// Candidate positions can belong to a source with unusable media. Encrypt them
// instead of putting an undisclosed resource ID in a readable signed token.
export function discoveryCursor(secret: string, scope: unknown, raw: unknown) {
  const key = createHash("sha256").update("training-discovery-cursor-v1\0").update(secret).digest();
  const binding = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
  let after: string | null = null;
  if (raw !== undefined) {
    try {
      const encoded = v.text(raw, 2000);
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw Error();
      const b = Buffer.from(encoded, "base64url");
      if (b.length < 29) throw Error();
      const cipher = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      cipher.setAAD(Buffer.from(binding)); cipher.setAuthTag(b.subarray(12, 28));
      const value = JSON.parse(Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString("utf8"));
      if (!Number.isSafeInteger(value.expires) || value.expires < Date.now()) throw Error();
      after = v.id(value.after);
    } catch { fail(422, "CURSOR_INVALID", "目录分页已失效，请重新查找"); }
  }
  return { after, next: (id: string) => {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(binding));
    const body = Buffer.concat([cipher.update(JSON.stringify({ after: id, expires: Date.now() + 1800000 })), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  } };
}
