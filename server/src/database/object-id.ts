import { ObjectId, type Db, type Document } from "mongodb";
import { OBJECT_ID_PATHS, NATURAL_KEYS } from "./object-id-paths";

/** Logical models use canonical hex IDs. Only this boundary produces stored BSON IDs. */
export const objectIdPattern = /^[0-9a-f]{24}$/;
export const newId = (): string => new ObjectId().toHexString();
const roleCodes = ["student", "teacher", "content_editor", "content_reviewer", "org_admin", "platform_ops"];
// Stable catalogue identities, independent of display names and process startup.
export const ROLE_IDS = Object.fromEntries(roleCodes.map((code, i) => [code, new ObjectId("6a00000000000000" + String(i + 1).padStart(8, "0"))]));
const roleNames = new Map(Object.entries(ROLE_IDS).map(([name, id]) => [id.toHexString(), name]));
const rawDatabases = new WeakMap<object, Db>();
const wrappedDatabases = new WeakMap<object, Db>();
const mixedPaths: Record<string, string[]> = {
  audit_events: ["actor_id", "resource_id"],
  content_idempotency: ["resource_id"],
  idempotency_records: ["resource_id"],
  administration_operations: ["actor_id"],
};
const dynamicRoots: Record<string, string[]> = {
  authorization_requests: ["payload"],
  administration_operations: ["before", "desired"],
  content_idempotency: ["result"],
  idempotency_records: ["result", "response"],
};
const dynamicNames = new Set([
  "id", "_id", "org_id", "user_id", "member_id", "subject_member_id", "actor_org_id",
  "target_org_id", "organization_ids", "user_ids", "member_ids", "org_ids",
  "grant_id", "grant_ids", "approval_id", "operation_id", "resource_id", "owner_version_id",
  "textbook_id", "textbook_edition_id", "question_id", "question_version_id", "chapter_id",
  "parent_id", "subject_id", "stage_id", "knowledge_point_id", "knowledge_point_ids",
  "resource_ids", "session_id", "session_item_id", "submission_id", "grading_run_id",
  "paper_id", "quiz_id", "class_id", "class_ids", "created_by", "contributors",
  "submitted_by", "published_by", "access_revoked_by", "retired_by",
  "actorOrgId", "userId", "memberId", "orgId", "grantId", "approvalId", "operationId",
]);
function plain(value: unknown): value is Document {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function normalized(path: string) { return path.replace(/\.\d+(?=\.|$)/g, "[]").replace(/\.\$\[[^\]]*\]/g, "[]").replace(/\.\$(?=\.|$)/g, "[]"); }
function idPath(name: string, path: string): boolean {
  const paths = OBJECT_ID_PATHS[name] ?? [];
  return paths.includes(normalized(path)) || paths.includes(normalized(path) + "[]") || paths.includes(normalized(path).replace(/\[\]$/, ""));
}
function flexiblePath(name: string, path: string): boolean {
  if (mixedPaths[name]?.includes(path)) return true;
  return !!dynamicRoots[name]?.some(root => path.startsWith(root + ".")) &&
    dynamicNames.has(path.split(".").at(-1)!.replaceAll("[]", ""));
}
function scalar(name: string, path: string, value: unknown, strict = true): unknown {
  if (value === null || value === undefined || value instanceof ObjectId) return value;
  if (name === "member_roles" && path.replace(/\[\]$/, "") === "role_id" && typeof value === "string" && ROLE_IDS[value]) return ROLE_IDS[value];
  if (typeof value === "string" && objectIdPattern.test(value)) return new ObjectId(value);
  if (strict) throw new Error("OBJECT_ID_VALUE_REQUIRED:" + name + ":" + path);
  return value;
}
function expression(name: string, value: any, target = ""): any {
  if (Array.isArray(value)) return value.map(v => expression(name, v, target));
  if (!plain(value)) {
    if (typeof value === "string" && !value.startsWith("$") && (idPath(name, target) || flexiblePath(name, target)))
      return scalar(name, target, value, idPath(name, target));
    return value;
  }
  const output: Document = {};
  for (const [op, operand] of Object.entries(value)) {
    if (["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in"].includes(op) && Array.isArray(operand)) {
      const field = operand.find(v => typeof v === "string" && v.startsWith("$") && !v.startsWith("$$"));
      const fieldPath = field?.slice(1) ?? target;
      output[op] = operand.map(v => expression(name, v, fieldPath));
    } else if (op === "$literal") output[op] = encodeValue(name, target, operand);
    else output[op] = expression(name, operand, target);
  }
  return output;
}
function encodeValue(name: string, path: string, value: any): any {
  if (Array.isArray(value)) return value.map(v => encodeValue(name, path.endsWith("[]") ? path : path + "[]", v));
  if (!plain(value)) {
    if (idPath(name, path)) return scalar(name, path, value);
    if (flexiblePath(name, path)) return scalar(name, path, value, false);
    return value;
  }
  const output: Document = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === "$expr") output[key] = expression(name, v);
    else if (key.startsWith("$")) {
      if (["$exists", "$type", "$size", "$regex", "$options", "$jsonSchema"].includes(key)) output[key] = v;
      else output[key] = encodeValue(name, path, v);
    } else output[key] = encodeValue(name, path ? path + "." + key : key, v);
  }
  return output;
}
export function encodeDocument(name: string, value: Document): Document {
  const natural = NATURAL_KEYS[name];
  const source = { ...value };
  if (natural && typeof source._id === "string") {
    source[natural] = source._id;
    delete source._id;
    if (name === "roles") {
      if (!ROLE_IDS[source.code]) throw new Error("UNKNOWN_ROLE_CODE");
      source._id = ROLE_IDS[source.code];
    }
  }
  return encodeValue(name, "", source);
}
export function encodeFilter(name: string, value: Document = {}): Document {
  const out: Document = {};
  for (const [key, v] of Object.entries(value)) {
    if (["$and", "$or", "$nor"].includes(key)) out[key] = (v as Document[]).map(row => encodeFilter(name, row));
    else if (key === "$expr") out[key] = expression(name, v);
    else if (key === "_id" && NATURAL_KEYS[name]) out[NATURAL_KEYS[name]] = v;
    else out[key] = key.startsWith("$") ? v : encodeValue(name, key, v);
  }
  return out;
}
function encodeUpdate(name: string, value: Document | Document[]): Document | Document[] {
  if (Array.isArray(value)) return value.map(stage => {
    const result: Document = {};
    for (const [op, fields] of Object.entries(stage)) {
      if (["$set", "$addFields"].includes(op)) result[op] = Object.fromEntries(Object.entries(fields as Document).map(([field, v]) => [
        field === "_id" && NATURAL_KEYS[name] ? NATURAL_KEYS[name] : field,
        expression(name, v, field === "_id" && NATURAL_KEYS[name] ? NATURAL_KEYS[name] : field),
      ]));
      else result[op] = fields;
    }
    return result;
  });
  if (!Object.keys(value).some(key => key.startsWith("$"))) return encodeDocument(name, value);
  const out: Document = {};
  for (const [op, fields] of Object.entries(value)) {
    if (["$set", "$setOnInsert", "$push", "$addToSet", "$pull", "$pullAll"].includes(op)) {
      out[op] = Object.fromEntries(Object.entries(fields as Document).map(([field, v]) => {
        const target = field === "_id" && NATURAL_KEYS[name] ? NATURAL_KEYS[name] : field;
        return [target, encodeValue(name, target, v)];
      }));
    } else out[op] = fields;
  }
  return out;
}
export function decodeDocument(value: any, name = ""): any {
  if (value instanceof ObjectId) return value.toHexString();
  if (Array.isArray(value)) return value.map(v => decodeDocument(v));
  if (!plain(value)) return value;
  const result: Document = Object.fromEntries(Object.entries(value).map(([k,v]) => [k, decodeDocument(v)]));
  if (name === "member_roles" && typeof result.role_id === "string") result.role_id = roleNames.get(result.role_id) ?? result.role_id;
  const natural = NATURAL_KEYS[name];
  if (natural && result._id !== undefined) {
    if (result[natural] !== undefined) result._id = result[natural];
    else if (name === "roles") result._id = roleNames.get(result._id) ?? result._id;
  }
  return result;
}
function pipeline(name: string, stages: Document[]): Document[] {
  const aliases = new Map<string,string>();
  const match = (filter: Document): Document => Object.fromEntries(Object.entries(filter).map(([key,value])=>{
    if(["$and","$or","$nor"].includes(key)) return [key,value.map(match)];
    const [prefix,...tail]=key.split("."); const foreign=aliases.get(prefix!);
    if(foreign){const field=tail.filter(p=>!/^\d+$/.test(p)).join(".");return [key,encodeFilter(foreign,{[field]:value})[field]];}
    return Object.entries(encodeFilter(name,{[key]:value}))[0]!;
  }));
  return stages.map(stage => {
    if (stage.$match) return { $match: match(stage.$match) };
    if (stage.$lookup) {
      const lookup = { ...stage.$lookup };
      if(lookup.from && lookup.as) aliases.set(lookup.as,lookup.from);
      if (lookup.pipeline) lookup.pipeline = pipeline(lookup.from, lookup.pipeline);
      if (lookup.let) lookup.let = expression(name, lookup.let);
      return { $lookup: lookup };
    }
    if (stage.$facet) return { $facet: Object.fromEntries(Object.entries(stage.$facet).map(([key, v]) => [key, pipeline(name, v as Document[])])) };
    if (stage.$set || stage.$addFields) return (encodeUpdate(name, [stage]) as Document[])[0]!;
    return expression(name, stage);
  });
}
function cursor(raw: any, name: string): any {
  let wrapped: any;
  wrapped = new Proxy(raw, { get(target, key) {
    if (key === Symbol.asyncIterator) return async function* () { for await (const row of target) yield decodeDocument(row, name); };
    if (key === "toArray") return async () => (await target.toArray()).map((row: any) => decodeDocument(row, name));
    if (key === "next" || key === "tryNext") return async () => decodeDocument(await target[key](), name);
    if (key === "forEach") return async (fn: any) => { for await (const row of wrapped) if (await fn(row) === false) break; };
    if (key === "map") return (fn: any) => cursor(target.map((row: any) => fn(decodeDocument(row, name))), "");
    const item = Reflect.get(target, key, target);
    if (typeof item !== "function") return item;
    return (...args: any[]) => { const result = item.apply(target, args); return result === target ? wrapped : result; };
  } });
  return wrapped;
}
function collection(raw: any, name: string): any {
  if (!OBJECT_ID_PATHS[name]) throw new Error("UNREGISTERED_OBJECT_ID_COLLECTION:" + name);
  const overrides = new Map<PropertyKey, any>();
  return new Proxy(raw, { set(_target,key,value){overrides.set(key,value);return true;}, get(target, key) {
    if(overrides.has(key)) return overrides.get(key);
    if (key === "find") return (filter: Document = {}, options?: Document) => cursor(target.find(encodeFilter(name, filter), options), name);
    if (key === "aggregate") return (stages: Document[], options?: Document) => cursor(target.aggregate(pipeline(name, stages), options), name);
    if (key === "findOne") return async (filter: Document = {}, options?: Document) => decodeDocument(await target.findOne(encodeFilter(name, filter), options), name);
    if (key === "insertOne" || key === "insertMany") return async (rows: any, options?: Document) => decodeDocument(await target[key](
      key === "insertMany" ? rows.map((row: Document) => encodeDocument(name, row)) : encodeDocument(name, rows), options));
    if (["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"].includes(String(key)))
      return async (filter: Document, update: Document, options?: Document) => decodeDocument(await target[key](
        encodeFilter(name, filter), encodeUpdate(name, update), options), key.toString().startsWith("findOne") ? name : "");
    if (["deleteOne", "deleteMany", "findOneAndDelete", "countDocuments"].includes(String(key)))
      return async (filter: Document = {}, options?: Document) => decodeDocument(await target[key](encodeFilter(name, filter), options), name);
    if (key === "distinct") return async (field: string, filter: Document = {}, options?: Document) => decodeDocument(await target.distinct(field, encodeFilter(name, filter), options));
    if (key === "bulkWrite") return async (operations: Document[], options?: Document) => target.bulkWrite(operations.map(operation => {
      const [op, data] = Object.entries(operation)[0]!;
      const converted = { ...data };
      if (data.filter) converted.filter = encodeFilter(name, data.filter);
      if (data.document) converted.document = encodeDocument(name, data.document);
      if (data.update) converted.update = encodeUpdate(name, data.update);
      if (data.replacement) converted.replacement = encodeDocument(name, data.replacement);
      return { [op]: converted };
    }), options);
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
export function rawDatabase(db: Db): Db { return rawDatabases.get(db) ?? db; }
/** Explicitly wrap an application DB; never patch MongoClient or driver prototypes. */
export function objectIdDatabase(db: Db): Db {
  if (rawDatabases.has(db)) return db;
  const existing = wrappedDatabases.get(db);
  if (existing) return existing;
  const collections = new Map<string, any>();
  const overrides = new Map<PropertyKey, any>();
  const wrapped = new Proxy(db, { set(_target,key,value){overrides.set(key,value);return true;}, get(target, key) {
    if(overrides.has(key)) return overrides.get(key);
    if (key === "collection") return (name: string, options?: Document) => {
      if (options) return collection(target.collection(name, options), name);
      if (!collections.has(name)) collections.set(name, collection(target.collection(name), name));
      return collections.get(name);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  wrappedDatabases.set(db, wrapped); rawDatabases.set(wrapped, db);
  return wrapped;
}
