import { checkStep, type CheckContext } from "../runtime/check-context";
import { Agent } from "node:https";
import { readFileSync, lstatSync } from "node:fs";
import type { S3Client } from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { open, unlink, readdir, lstat, statfs, rename } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import {
  storageRoot,
  storagePath,
  openLocalPrivate,
  MAX_FILE_SIZE,
  assertUploadCapacity,
  assertLocalStorageReady,
} from "./config";
function sdk(): typeof import("@aws-sdk/client-s3") {
  return require("@aws-sdk/client-s3");
}
export const STORAGE_AREAS = ["tmp", "quarantine", "ready"] as const;
export type StorageArea = (typeof STORAGE_AREAS)[number];
export const STORAGE_KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function storageDriver(
  env: NodeJS.ProcessEnv = process.env,
): "local" | "s3" {
  const value = env.FILE_STORAGE_DRIVER ?? "local";
  if (value !== "local" && value !== "s3")
    throw Error("INVALID_CONFIG_FILE_STORAGE_DRIVER");
  return value;
}
export function s3Configuration(env: NodeJS.ProcessEnv = process.env) {
  let endpoint: URL;
  try {
    endpoint = new URL(env.S3_ENDPOINT ?? "");
  } catch {
    throw Error("INVALID_CONFIG_S3_ENDPOINT");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !["", "/"].includes(endpoint.pathname)
  )
    throw Error("INVALID_CONFIG_S3_ENDPOINT");
  const bucket = env.S3_BUCKET;
  if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
    throw Error("INVALID_CONFIG_S3_BUCKET");
  const region = env.S3_REGION ?? "us-east-1";
  if (!/^[a-z0-9-]{1,64}$/.test(region))
    throw Error("INVALID_CONFIG_S3_REGION");
  if (
    env.S3_FORCE_PATH_STYLE !== undefined &&
    env.S3_FORCE_PATH_STYLE !== "true"
  )
    throw Error("INVALID_CONFIG_S3_FORCE_PATH_STYLE");
  const prefix = env.S3_PREFIX ?? "knowladder";
  if (
    !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(prefix) ||
    prefix.length > 128
  )
    throw Error("INVALID_CONFIG_S3_PREFIX");
  if (!env.S3_ACCESS_KEY_ID || /[\s\x00-\x1f]/.test(env.S3_ACCESS_KEY_ID))
    throw Error("INVALID_CONFIG_S3_ACCESS_KEY_ID");
  if (
    !env.S3_SECRET_ACCESS_KEY ||
    /[\s\x00-\x1f]/.test(env.S3_SECRET_ACCESS_KEY)
  )
    throw Error("INVALID_CONFIG_S3_SECRET_ACCESS_KEY");
  return {
    endpoint: endpoint.origin,
    bucket,
    region,
    prefix,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  };
}
export function storageIdentity() {
  if (storageDriver() === "local") return process.env.FILE_STORAGE_ROOT ?? "";
  const c = s3Configuration();
  return "s3:" + JSON.stringify([c.endpoint, c.bucket, c.region, c.prefix]);
}
function validate(area: StorageArea, key: string) {
  if (!STORAGE_AREAS.includes(area) || !STORAGE_KEY.test(key))
    throw Error("STORAGE_KEY_INVALID");
}
function objectKey(area: StorageArea, key: string) {
  validate(area, key);
  return `${s3Configuration().prefix}/${area}/${key}`;
}
export function storageMissing(error: unknown) {
  const e = error as {
    code?: string;
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    e?.code === "ENOENT" ||
    (["NoSuchKey", "NotFound"].includes(e?.name ?? "") &&
      e?.$metadata?.httpStatusCode === 404)
  );
}
function safeS3Error(error: unknown): Error {
  const e = error as {
    name?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  if (storageMissing(error))
    return Object.assign(Error("STORAGE_OBJECT_MISSING"), { code: "ENOENT" });
  const name = e?.name ?? "";
  const code =
    name === "AccessDenied" || e?.$metadata?.httpStatusCode === 403
      ? "S3_ACCESS_DENIED"
      : e?.$metadata?.httpStatusCode === 401 ||
          ["SignatureDoesNotMatch", "InvalidAccessKeyId"].includes(name)
        ? "S3_CREDENTIALS_REJECTED"
        : ["AbortError", "TimeoutError"].includes(name)
          ? "S3_TIMEOUT"
          : ["PreconditionFailed", "ConditionalRequestConflict"].includes(name)
            ? "S3_OBJECT_CONFLICT"
            : ["NotImplemented", "MethodNotAllowed"].includes(name)
              ? "S3_CAPABILITY_UNSUPPORTED"
              : "S3_REQUEST_FAILED";
  return Error(code);
}
export function applyS3ClientCompatibility(client: S3Client, endpoint: string) {
  const hostname = new URL(endpoint).hostname;
  if (!["s3.cstcloud.cn", "s3.data.cstcloud.cn"].includes(hostname)) return;
  // Data Capsule keys are bound to a client application (S3Drive).
  client.middlewareStack.add(
    (next) => async (args) => {
      const request = args.request as { headers: Record<string, string> };
      request.headers["user-agent"] = "S3Drive";
      return next(args);
    },
    { step: "finalizeRequest", priority: "low", name: "dataCapsuleUserAgent" },
  );
}
async function withS3<T>(
  work: (client: S3Client, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  boundWholeCall = true,
): Promise<T> {
  signal?.throwIfAborted();
  const config = s3Configuration();
  let agent: Agent | undefined;
  if (process.env.S3_CA_BUNDLE) {
    const ca = process.env.S3_CA_BUNDLE;
    if (
      !path.isAbsolute(ca) ||
      !lstatSync(ca).isFile() ||
      lstatSync(ca).isSymbolicLink() ||
      lstatSync(ca).size > 262144
    )
      throw Error("INVALID_CONFIG_S3_CA_BUNDLE");
    agent = new Agent({ ca: readFileSync(ca), keepAlive: true, maxSockets: 4 });
  }
  const client = new (sdk().S3Client)({
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
    forcePathStyle: true,
    maxAttempts: 2,
    requestHandler: {
      connectionTimeout: 5000,
      requestTimeout: 30000,
      httpsAgent: agent,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  applyS3ClientCompatibility(client, config.endpoint);
  const bounded = boundWholeCall
    ? signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
    : signal ?? new AbortController().signal;
  try {
    return await work(client, bounded);
  } catch (error) {
    if (
      error instanceof Error &&
      /^(S3_|STORAGE_|INVALID_CONFIG_)/.test(error.message)
    )
      throw error;
    throw safeS3Error(error);
  } finally {
    client.destroy();
    agent?.destroy();
  }
}
export interface StorageEntry {
  key: string;
  size: number;
  modifiedAt: Date;
}
export async function storageHead(
  area: StorageArea,
  key: string,
  signal?: AbortSignal,
): Promise<StorageEntry | null> {
  validate(area, key);
  if (storageDriver() === "local") {
    try {
      const filename = await storagePath(area, key);
      const s = await lstat(filename);
      if (
        !s.isFile() ||
        s.isSymbolicLink() ||
        s.nlink !== 1 ||
        s.size > MAX_FILE_SIZE
      )
        throw Error("STORAGE_OBJECT_UNSAFE");
      return { key, size: s.size, modifiedAt: s.mtime };
    } catch (e) {
      if (storageMissing(e)) return null;
      throw e;
    }
  }
  try {
    return await withS3(async (c, signal) => {
      const r = await c.send(
        new (sdk().HeadObjectCommand)({
          Bucket: s3Configuration().bucket,
          Key: objectKey(area, key),
        }),
        { abortSignal: signal },
      );
      if (
        !Number.isSafeInteger(r.ContentLength) ||
        r.ContentLength! < 0 ||
        r.ContentLength! > MAX_FILE_SIZE ||
        !r.LastModified ||
        !Number.isFinite(r.LastModified.getTime())
      )
        throw Error("STORAGE_OBJECT_INVALID");
      return { key, size: r.ContentLength!, modifiedAt: r.LastModified };
    }, signal);
  } catch (e) {
    if (storageMissing(e)) return null;
    throw e;
  }
}
export async function readStorageBytes(
  area: StorageArea,
  key: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  validate(area, key);
  if (storageDriver() === "local") {
    const h =
      area === "tmp"
        ? await open(
            await storagePath(area, key),
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
          )
        : await openLocalPrivate(area, key);
    try {
      const s = await h.stat();
      if (!s.isFile() || s.nlink !== 1 || s.size > MAX_FILE_SIZE)
        throw Error("STORAGE_OBJECT_INVALID");
      return await h.readFile();
    } finally {
      await h.close();
    }
  }
  return withS3(async (c, bounded) => {
    const r = await c.send(
      new (sdk().GetObjectCommand)({
        Bucket: s3Configuration().bucket,
        Key: objectKey(area, key),
      }),
      { abortSignal: bounded },
    );
    if (
      !r.Body ||
      !Number.isSafeInteger(r.ContentLength) ||
      r.ContentLength! < 0 ||
      r.ContentLength! > MAX_FILE_SIZE
    ) {
      (r.Body as any)?.destroy?.();
      throw Error("STORAGE_OBJECT_INVALID");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    // The SDK may resolve headers before the response body finishes. Keep a bound
    // on a silent/stalled body as well as the initial HTTP request.
    const canceled = () => (r.Body as any)?.destroy?.(Error("S3_TIMEOUT"));
    bounded.addEventListener("abort", canceled, { once: true });
    if (bounded.aborted) canceled();

    try {
      for await (const chunk of r.Body as AsyncIterable<Uint8Array>) {
        bounded.throwIfAborted();
        size += chunk.length;
        if (size > MAX_FILE_SIZE || size > r.ContentLength!)
          throw Error("STORAGE_OBJECT_INVALID");
        chunks.push(Buffer.from(chunk));
      }
    } finally {
      bounded.removeEventListener("abort", canceled);
      (r.Body as any)?.destroy?.();
    }
    if (size !== r.ContentLength) throw Error("STORAGE_OBJECT_INVALID");
    return Buffer.concat(chunks, size);
  }, signal);
}
export const bytesChecksum = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export async function putStorageBytes(
  area: StorageArea,
  key: string,
  bytes: Buffer,
  signal?: AbortSignal,
) {
  validate(area, key);
  if (bytes.length > MAX_FILE_SIZE) throw Error("STORAGE_OBJECT_INVALID");
  const before = await storageHead(area, key, signal);
  if (before) {
    const actual = await readStorageBytes(area, key, signal);
    if (!actual.equals(bytes)) throw Error("S3_OBJECT_CONFLICT");
    return;
  }
  if (storageDriver() === "local") {
    const h = await open(await storagePath(area, key), "wx", 0o600);
    try {
      await h.writeFile(bytes);
      await h.sync();
    } finally {
      await h.close();
    }
  } else {
    try {
      await withS3(async (c, signal) => {
        await c.send(
          new (sdk().PutObjectCommand)({
            Bucket: s3Configuration().bucket,
            Key: objectKey(area, key),
            Body: bytes,
            ContentLength: bytes.length,
            ContentType: "application/octet-stream",
            Metadata: { sha256: bytesChecksum(bytes) },
            IfNoneMatch: "*",
          }),
          { abortSignal: signal },
        );
      }, signal);
    } catch (error) {
      if ((error as Error).message !== "S3_OBJECT_CONFLICT") throw error;
    }
    const after = await readStorageBytes(area, key, signal);
    if (!after.equals(bytes)) throw Error("S3_OBJECT_CONFLICT");
  }
}
export async function publishStorageFile(
  from: StorageArea,
  to: StorageArea,
  key: string,
  expected?: { size: number | null; checksum: string | null },
) {
  validate(from, key);
  validate(to, key);
  if (storageDriver() === "local") {
    await rename(await storagePath(from, key), await storagePath(to, key));
    return;
  }
  // Bounded Get+Put works on providers without CopyObject. Keep source for recovery.
  const bytes = await readStorageBytes(from, key);
  if (
    expected &&
    (bytes.length !== expected.size ||
      bytesChecksum(bytes) !== expected.checksum)
  )
    throw Error("STORAGE_INTEGRITY_MISMATCH");
  await putStorageBytes(to, key, bytes);
}
async function s3Send<T>(signal: AbortSignal, work: (bounded: AbortSignal) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return work(AbortSignal.any([signal,AbortSignal.timeout(30000)]));
}
async function checkUnversioned(c: S3Client, bucket: string, signal: AbortSignal, context: CheckContext = {}) {
  const v=await checkStep(context,'storage.versioning',()=>s3Send(signal,s=>c.send(new (sdk().GetBucketVersioningCommand)({Bucket:bucket}),{abortSignal:s})));
  if(v.Status)throw Error('S3_VERSIONED_BUCKET_UNSUPPORTED');
  await checkStep(context,'storage.lock',async()=>{
    try {
      const lock=await s3Send(signal,s=>c.send(new (sdk().GetObjectLockConfigurationCommand)({Bucket:bucket}),{abortSignal:s}));
      if(lock.ObjectLockConfiguration?.ObjectLockEnabled==='Enabled')throw Error('S3_OBJECT_LOCK_UNSUPPORTED');
    } catch(e) {
      if((e as {name?:string}).name!=='ObjectLockConfigurationNotFoundError' && (e as {name?:string}).name!=='NoSuchObjectLockConfiguration')throw e;
    }
  });
}
export async function assertUnversionedStorage() {
  if(storageDriver()==='local')return;
  await withS3((c,signal)=>checkUnversioned(c,s3Configuration().bucket,signal));
}
export async function deleteStorageObject(area: StorageArea, key: string) {
  validate(area, key);
  if (storageDriver() === "local") {
    try {
      const h = await storageHead(area, key);
      if (h) await unlink(await storagePath(area, key));
    } catch (e) {
      if (!storageMissing(e)) throw e;
    }
    return;
  }
  await assertUnversionedStorage();
  await withS3(async (c, signal) => {
    await c.send(
      new (sdk().DeleteObjectCommand)({
        Bucket: s3Configuration().bucket,
        Key: objectKey(area, key),
      }),
      { abortSignal: signal },
    );
  });
  // Versioning can be enabled between the first check and deletion. Suspended
  // buckets remain versioned, so a second check prevents a delete marker proving erasure.
  await assertUnversionedStorage();
  if (await storageHead(area, key)) throw Error("S3_DELETE_UNCONFIRMED");
}
export async function listStorage(area: StorageArea): Promise<StorageEntry[]> {
  if (!STORAGE_AREAS.includes(area)) throw Error("STORAGE_KEY_INVALID");
  if (storageDriver() === "local") {
    const root = await storageRoot();
    const rows: StorageEntry[] = [];
    for (const e of await readdir(path.join(root, area), {
      withFileTypes: true,
    })) {
      if (!e.isFile() || !STORAGE_KEY.test(e.name))
        throw Error("STORAGE_UNKNOWN_ENTRY");
      const info = await storageHead(area, e.name);
      if (info) rows.push(info);
    }
    return rows.sort((a, b) => a.key.localeCompare(b.key));
  }
  return withS3((c,signal)=>listS3Storage(c,s3Configuration(),area,signal));
}
async function listS3Storage(c: S3Client, conf: ReturnType<typeof s3Configuration>, area: StorageArea, signal: AbortSignal, context: CheckContext = {}): Promise<StorageEntry[]> {
    const prefix = `${conf.prefix}/${area}/`,
      rows: StorageEntry[] = [];
    let token: string | undefined;
    const seen = new Set<string>();
    do {
      const r = await checkStep(context,'storage.list-'+area,()=>s3Send(signal,s=>c.send(
        new (sdk().ListObjectsV2Command)({
          Bucket: conf.bucket,
          Prefix: prefix,
          ContinuationToken: token,
          MaxKeys: 1000,
        }),
        {abortSignal:s},
      )));
      for (const o of r.Contents ?? []) {
        // Some S3-compatible providers materialize the area directory itself.
        if (o.Key === prefix && o.Size === 0) continue;
        const key = o.Key?.slice(prefix.length) ?? "";
        if (
          !o.Key?.startsWith(prefix) ||
          !STORAGE_KEY.test(key) ||
          !Number.isSafeInteger(o.Size) ||
          o.Size! < 0 ||
          o.Size! > MAX_FILE_SIZE ||
          !o.LastModified ||
          !Number.isFinite(o.LastModified.getTime()) ||
          seen.has(key)
        )
          throw Error("STORAGE_INVENTORY_INVALID");
        seen.add(key);
        rows.push({ key, size: o.Size!, modifiedAt: o.LastModified });
        if (rows.length > 10000) throw Error("STORAGE_INVENTORY_LIMIT");
      }
      if (r.IsTruncated) {
        if (!r.NextContinuationToken || r.NextContinuationToken === token)
          throw Error("STORAGE_INVENTORY_INCOMPLETE");
        token = r.NextContinuationToken;
      } else token = undefined;
    } while (token);
    return rows.sort((a, b) => a.key.localeCompare(b.key));
}
let activeMaterializations = 0;
export function reserveSpool() {
  if (storageDriver() !== "s3") return () => {};
  if (activeMaterializations >= 4) throw Error("STORAGE_SPOOL_BUSY");
  activeMaterializations++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      activeMaterializations--;
    }
  };
}
export interface MaterializedFile {
  handle: FileHandle;
  filename: string;
  dispose: () => Promise<void>;
}
export async function materializeStorage(
  area: StorageArea,
  key: string,
  signal?: AbortSignal,
): Promise<MaterializedFile> {
  validate(area, key);
  if (storageDriver() === "local") {
    const filename = await storagePath(area, key);
    const handle =
      area === "tmp"
        ? await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        : await openLocalPrivate(area, key);
    return { handle, filename, dispose: () => handle.close() };
  }
  if (activeMaterializations >= 4) throw Error("STORAGE_SPOOL_BUSY");
  activeMaterializations++;
  let handle: FileHandle | undefined, filename: string | undefined;
  try {
    await assertUploadCapacity(MAX_FILE_SIZE);
    const root = await storageRoot();
    filename = await storagePath("tmp", randomUUID(), root);
    handle = await open(filename, "wx+", 0o600);
    const bytes = await readStorageBytes(area, key, signal);
    let offset = 0;
    while (offset < bytes.length) {
      const written = await handle.write(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!written.bytesWritten) throw Error("STORAGE_SPOOL_WRITE_FAILED");
      offset += written.bytesWritten;
    }
    await handle.sync();
    const opened = handle,
      target = filename;
    let closed = false;
    const dispose = async () => {
      if (closed) return;
      closed = true;
      try {
        await opened.close();
      } finally {
        try {
          await unlink(target);
        } finally {
          activeMaterializations--;
        }
      }
    };
    return { handle: opened, filename: target, dispose };
  } catch (e) {
    await handle?.close().catch(() => {});
    if (filename) await unlink(filename).catch(() => {});
    activeMaterializations--;
    throw e;
  }
}
export async function openStoredPrivate(
  area: "quarantine" | "ready",
  key: string,
  signal?: AbortSignal,
): Promise<FileHandle> {
  if (storageDriver() === "local") return openLocalPrivate(area, key);
  const file = await materializeStorage(area, key, signal);
  const close = file.handle.close.bind(file.handle);
  let closed = false;
  // Preserve the exact descriptor contract; close also removes this request's private spool.
  file.handle.close = async () => {
    if (closed) return;
    closed = true;
    try {
      await close();
    } finally {
      try {
        await unlink(file.filename);
      } finally {
        activeMaterializations--;
      }
    }
  };
  return file.handle;
}
export async function assertStorageBackendReady(context: CheckContext = {}) {
  await checkStep(context,'storage.local',()=>assertLocalStorageReady());
  if(storageDriver()==='local')return;
  const config=s3Configuration();
  await withS3(async(c,signal)=>{
    await checkStep(context,'storage.bucket',()=>s3Send(signal,s=>c.send(new (sdk().HeadBucketCommand)({Bucket:config.bucket}),{abortSignal:s})));
    await checkUnversioned(c,config.bucket,signal,context);
    for(const area of STORAGE_AREAS)await listS3Storage(c,config,area,signal,context);
  },context.signal,false);
}
export async function storageHealthDetails() {
  const root = await assertLocalStorageReady(),
    disk = await statfs(root, { bigint: true });
  return {
    backend: storageDriver(),
    total_bytes:
      storageDriver() === "local"
        ? (disk.blocks * disk.bsize).toString()
        : null,
    available_bytes:
      storageDriver() === "local"
        ? (disk.bavail * disk.bsize).toString()
        : null,
    spool_available_bytes: (disk.bavail * disk.bsize).toString(),
  };
}
