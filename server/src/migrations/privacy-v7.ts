import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Db, Document, IndexDescription } from "mongodb";
import { PRIVACY_V7_SCHEMAS, PRIVACY_USER_FIELDS } from "../privacy/schema";
import { OPERATIONS_V7_SCHEMAS } from "../operations/schema";
import { inspectVersion6 } from "./learning-api-v6";

type Schema = { validator: Document; indexes: IndexDescription[] };
export function privacyVersion7(baseUser: Schema) {
  const users = structuredClone(baseUser);
  const shape = users.validator.$and[0].$jsonSchema;
  Object.assign(shape.properties, PRIVACY_USER_FIELDS);
  shape.required.push(...Object.keys(PRIVACY_USER_FIELDS));
  const schemas: Record<string, Schema> = { users, ...PRIVACY_V7_SCHEMAS, ...OPERATIONS_V7_SCHEMAS };
  const checksum = createHash("sha256").update(JSON.stringify({ version: 7, schemas, defaults: { privacy_state: "active", operational_mode: "unregistered" } })).digest("hex");
  return { schemas, checksum };
}

/** Read-only counts; missing legacy user state is the sole user default. */
export async function inspectVersion7(db: Db, schemas: Record<string, Schema>, known: Record<string, Schema>) {
  const report = await inspectVersion6(db);
  const options = { maxTimeMS: 15000 };
  const collections = await db.listCollections({}, { ...options, nameOnly: false }).toArray();
  const names = new Set(collections.map(row => row.name));
  const unknown_collections = collections.filter(row => !known[row.name] || row.type !== "collection").map(row => row.name);
  let invalid_indexes = 0;
  for (const [name, schema] of Object.entries(schemas)) {
    const defaults = name === "users" ? [{ $set: { privacy_state: { $cond: [{ $eq: [{ $type: "$privacy_state" }, "missing"] }, "active", "$privacy_state"] } } }] : [];
    const [invalid] = await db.collection(name).aggregate([...defaults, { $match: { $nor: [schema.validator] } }, { $count: "n" }], options).toArray();
    report.collections[name] = { documents: await db.collection(name).countDocuments({}, options), needs_defaults: name === "users" ? await db.collection(name).countDocuments({ privacy_state: { $exists: false } }, options) : 0, invalid_types: invalid?.n ?? 0 };
    const indexes = names.has(name) ? await db.collection(name).listIndexes(options).toArray() : [];
    report.indexes[name] = indexes.map(index => index.name!);
    for (const actual of indexes) {
      if (actual.name === "_id_") continue;
      const expected = schema.indexes.find(index => index.name === actual.name);
      if (!expected || JSON.stringify(actual.key) !== JSON.stringify(expected.key) || Boolean(actual.unique) !== Boolean(expected.unique) || actual.expireAfterSeconds !== expected.expireAfterSeconds || actual.sparse || actual.hidden || actual.collation || !isDeepStrictEqual(actual.partialFilterExpression, expected.partialFilterExpression)) invalid_indexes++;
    }
    for (const index of schema.indexes) if (index.unique && name !== "users") {
      const [duplicates] = await db.collection(name).aggregate([...(index.partialFilterExpression ? [{ $match: index.partialFilterExpression }] : []), { $group: { _id: Object.fromEntries(Object.keys(index.key).map((field, i) => [`k${i}`, `$${field}`])), n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $count: "n" }], options).toArray();
      report.duplicate_keys += duplicates?.n ?? 0;
    }
    const shape = schema.validator.$jsonSchema ?? schema.validator.$and?.find((part: Document) => part.$jsonSchema)?.$jsonSchema;
    for (const [field, target] of [["user_id", "users"], ["request_id", "privacy_deletion_requests"]]) {
      if (!shape?.properties[field]) continue;
      const [invalidReference] = await db.collection(name).aggregate([{ $match: { [field]: { $exists: true, $ne: null } } }, { $lookup: { from: target, let: { id: `$${field}`, user: "$user_id" }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ["$_id", "$$id"] }, ...(field === "request_id" && shape.properties.user_id ? [{ $eq: ["$user_id", "$$user"] }] : [])] } } }], as: "reference" } }, { $match: { reference: { $size: 0 } } }, { $count: "n" }], options).toArray();
      report.invalid_references += invalidReference?.n ?? 0;
    }
  }
  return { ...report, target_version: 7, unknown_collections, invalid_indexes, new_collections: [...report.new_collections, ...Object.keys(schemas).filter(name => !names.has(name))] };
}
