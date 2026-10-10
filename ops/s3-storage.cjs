"use strict";
const storage = require("../server/dist/files/storage"),
  config = require("../server/dist/files/config");
const { safeErrorCode } = require("../server/dist/runtime/process-lifecycle");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises"),
  path = require("node:path");
async function check(write = false) {
  if (storage.storageDriver() !== "s3")
    throw Error("INVALID_CONFIG_FILE_STORAGE_DRIVER");
  await storage.assertStorageBackendReady();
  if (!write)
    return {
      ok: true,
      backend: "s3",
      read_only: true,
      versioning: "disabled",
      path_style: true,
    };
  const key = randomUUID(),
    bytes = Buffer.from("KnowLadder original synthetic S3 capability probe\n");
  try {
    await storage.putStorageBytes("quarantine", key, bytes);
    await storage.publishStorageFile("quarantine", "ready", key, {
      size: bytes.length,
      checksum: storage.bytesChecksum(bytes),
    });
    if (!(await storage.readStorageBytes("ready", key)).equals(bytes))
      throw Error("STORAGE_INTEGRITY_MISMATCH");
  } finally {
    for (const area of ["tmp", "quarantine", "ready"])
      await storage.deleteStorageObject(area, key);
  }
  return {
    ok: true,
    backend: "s3",
    read_only: false,
    copy_mode: "verified-get-put",
    objects_cleaned: true,
  };
}
async function spool(db, cleanup = false) {
  if (storage.storageDriver() !== "s3")
    throw Error("STORAGE_SPOOL_S3_REQUIRED");
  const root = await config.assertLocalStorageReady(),
    files = [];
  for (const area of ["tmp", "quarantine", "ready"])
    for (const entry of await fs.readdir(path.join(root, area), {
      withFileTypes: true,
    })) {
      if (!entry.isFile() || !storage.STORAGE_KEY.test(entry.name))
        throw Error("STORAGE_SPOOL_UNKNOWN_ENTRY");
      const filename = await config.storagePath(area, entry.name, root),
        info = await fs.lstat(filename);
      if (info.nlink !== 1 || info.isSymbolicLink())
        throw Error("STORAGE_OBJECT_UNSAFE");
      files.push({ filename, size: info.size });
    }
  if (cleanup) {
    if (!db) throw Error("OPERATIONS_MAINTENANCE_REQUIRED");
    const control = require("../server/dist/operations/control");
    const token = process.env.KL_MAINTENANCE_TOKEN;
    const gate = await control.assertMaintenance(db, token);
    if (
      await db
        .collection("operational_writers")
        .countDocuments({ state: "running" })
    )
      throw Error("OPERATIONS_WRITERS_RUNNING");
    for (const file of files) {
      const current = await control.assertMaintenance(db, token);
      if (current.revision !== gate.revision)
        throw Error("OPERATIONS_REVISION_CONFLICT");
      await fs.unlink(file.filename);
    }
  }
  return {
    ok: true,
    spool_files: files.length,
    spool_bytes: files.reduce((n, f) => n + f.size, 0),
    cleaned: cleanup,
  };
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (
    command === "check" &&
    args.every((x) => x === "--write") &&
    args.length <= 1
  ) {
    console.log(JSON.stringify(await check(args.includes("--write"))));
    return;
  }
  if (command === "spool" && args.length === 0) {
    console.log(JSON.stringify(await spool()));
    return;
  }
  if (command !== "spool" || args.join(" ") !== "--cleanup --all-hosts-stopped")
    throw Error("OPERATIONS_ARGUMENT_INVALID");
  const { MongoClient } = require("../server/node_modules/mongodb"),
    { objectIdDatabase } = require("../server/dist/database/object-id");
  const client = new MongoClient(
    require("../server/dist/config").loadConfig().mongoUri,
    { serverSelectionTimeoutMS: 10000 },
  );
  try {
    await client.connect();
    console.log(
      JSON.stringify(await spool(objectIdDatabase(client.db()), true)),
    );
  } finally {
    await client.close();
  }
}
module.exports = { check, spool };
if (require.main === module)
  main().catch((e) => {
    console.error(JSON.stringify({ ok: false, code: safeErrorCode(e) }));
    process.exitCode = 1;
  });
