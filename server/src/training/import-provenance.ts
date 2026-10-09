// Migration-safe validation: no imports of Nest services or content access.
function object(v: any, keys: string[]) {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    throw Error("Invalid import proof");
  return v;
}
function text(v: any, _name: string, max: number, empty = false) {
  if (
    typeof v !== "string" ||
    v.length > max ||
    v.includes("\u0000") ||
    (!empty && !v.trim())
  )
    throw Error("Invalid import proof");
  return v;
}
function license(v: any) {
  const x = object(v, ["source", "granted", "expires_at"]);
  const source = text(x.source, "source", 1000, true);
  if (x.granted !== true) throw Error("Invalid import license");
  if (
    x.expires_at !== null &&
    (typeof x.expires_at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
        x.expires_at,
      ) ||
      !Number.isFinite(Date.parse(x.expires_at)))
  )
    throw Error("Invalid import license expiry");
  return {
    source,
    granted: true,
    expires_at:
      x.expires_at === null ? null : new Date(x.expires_at).toISOString(),
  };
}
export function provenanceRecord(
  job: any,
  revision: number,
  chapterIds: any[],
  raw: string,
  createdAt: Date,
) {
  const body = object(JSON.parse(raw), [
    "license",
    "rights_type",
    "proof_reference",
    "usage_restrictions",
  ]);
  const permission = license(body.license),
    rights = text(body.rights_type, "rights_type", 32),
    proof = text(body.proof_reference, "proof_reference", 1000),
    restrictions = text(
      body.usage_restrictions,
      "usage_restrictions",
      1000,
      true,
    );
  if (
    !permission.granted ||
    !permission.source.trim() ||
    !["original", "authorized", "public-domain"].includes(rights)
  )
    throw Error("Invalid shared import license");
  return {
    _id: job._id,
    org_id: job.org_id,
    owner_id: job.owner_id,
    file_id: job.file_id,
    source_hash: job.source_hash,
    applied_revision: revision,
    chapter_ids: chapterIds,
    license_json: JSON.stringify({
      license: permission,
      rights_type: rights,
      proof_reference: proof,
      usage_restrictions: restrictions,
    }),
    created_at: createdAt,
  };
}
