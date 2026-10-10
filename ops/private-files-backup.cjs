"use strict";
const storageAccess=require("./storage-access.cjs");
// Independent encrypted file archives. Atlas owns database snapshots and restores.
const { MongoClient, BSON } = require("../server/node_modules/mongodb");
const {
  decodeDocument,
  rawDatabase,
} = require("../server/dist/database/object-id");
const {
  fs,
  path,
  crypto,
  ensure,
  hash,
  privateDirectory,
  openFile,
  writeAll,
  createArchive,
  readArchive,
  CHUNK,
} = require("./system-backup-archive.cjs");
const { filesInventory } = require("./system-backup.cjs");
const KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AREAS = ["tmp", "quarantine", "ready"];
async function resourceSnapshot(db) {
  const documents = await rawDatabase(db)
    .collection("file_resources")
    .find({}, { readConcern: { level: "majority" }, maxTimeMS: 15000 })
    .sort({ _id: 1 })
    .limit(1001)
    .toArray();
  ensure(documents.length <= 1000, "BACKUP_LIMIT_EXCEEDED");
  const digest = crypto.createHash("sha256");
  for (const row of documents) digest.update(BSON.serialize(row));
  return {
    hash: digest.digest("hex"),
    resources: documents.map((row) => decodeDocument(row, "file_resources")),
  };
}
async function backup({ db, root, file, key, atlasSnapshotId = null }) {
  ensure(
    typeof (await db.admin().command({ hello: 1 })).setName === "string",
    "REPLICA_SET_REQUIRED",
  );
  root=await storageAccess.sourceRoot(root);
  ensure(
    atlasSnapshotId === null || /^[a-f0-9]{24}$/.test(atlasSnapshotId),
    "ATLAS_SNAPSHOT_ID_INVALID",
  );
  const snapshot = await resourceSnapshot(db),
    inventory = await filesInventory(root, snapshot.resources);
  const manifest = {
    format: "kl-private-files-1",
    backup_id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    source_database: db.databaseName,
    source_root_hash: hash(root),
    resource_hash: snapshot.hash,
    atlas_snapshot_id: atlasSnapshotId,
    atlas_snapshot_verified: false,
    consistency: "independent-file-inventory",
    files: inventory.descriptors,
    missing: inventory.missing,
    total_bytes: inventory.total,
  };
  const archive = await createArchive(file, key);
  try {
    await archive.frame({ kind: "private-files-header", manifest });
    for (const descriptor of manifest.files) {
      const handle=await storageAccess.openSource(root,descriptor.area,descriptor.key);
      try {
        const before = await handle.stat(),
          digest = crypto.createHash("sha256"),
          buffer = Buffer.alloc(CHUNK);
        let position = 0,
          part = 0;
        do {
          const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(CHUNK, descriptor.size - position),
            position,
          );
          ensure(
            bytesRead > 0 || descriptor.size === 0,
            "BACKUP_SOURCE_CHANGED",
          );
          const bytes = buffer.subarray(0, bytesRead);
          digest.update(bytes);
          position += bytesRead;
          await archive.frame({
            kind: "file",
            area: descriptor.area,
            key: descriptor.key,
            part: part++,
            last: position === descriptor.size,
            data: bytes.toString("base64"),
          });
        } while (position < descriptor.size);
        const after = await handle.stat();
        ensure(
          digest.digest("hex") === descriptor.checksum &&
            after.size === before.size &&
            after.mtimeMs === before.mtimeMs,
          "BACKUP_SOURCE_CHANGED",
        );
      } finally {
        await handle.close();
      }
    }
    const final = await resourceSnapshot(db),
      next = await filesInventory(root, final.resources);
    ensure(
      final.hash === snapshot.hash &&
        JSON.stringify(next) === JSON.stringify(inventory),
      "BACKUP_SOURCE_CHANGED",
    );
    await archive.publish(manifest);
    return summary({ manifest, manifestHash: hash(JSON.stringify(manifest)) });
  } catch (error) {
    await archive.abort();
    throw error;
  }
}
function exact(value, keys) {
  ensure(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join("|") === keys.slice().sort().join("|"),
  );
}
async function authenticate(handle, key, consume = async () => {}) {
  let manifest = null,
    active = null,
    index = 0,
    total = 0;
  const identities = new Set();
  const result = await readArchive(handle, key, async (record) => {
    if (!manifest) {
      exact(record, ["kind", "manifest"]);
      ensure(record.kind === "private-files-header");
      manifest = record.manifest;
      exact(manifest, [
        "format",
        "backup_id",
        "created_at",
        "source_database",
        "source_root_hash",
        "resource_hash",
        "atlas_snapshot_id",
        "atlas_snapshot_verified",
        "consistency",
        "files",
        "missing",
        "total_bytes",
      ]);
      ensure(
        manifest.format === "kl-private-files-1" &&
          manifest.atlas_snapshot_verified === false &&
          manifest.consistency === "independent-file-inventory" &&
          Array.isArray(manifest.files) &&
          manifest.files.length <= 1000 &&
          Array.isArray(manifest.missing) &&
          manifest.missing.length <= 1000,
      );
      return;
    }
    exact(record, ["kind", "area", "key", "part", "last", "data"]);
    ensure(
      record.kind === "file" &&
        AREAS.includes(record.area) &&
        KEY.test(record.key) &&
        Number.isSafeInteger(record.part) &&
        record.part >= 0 &&
        typeof record.last === "boolean" &&
        typeof record.data === "string" &&
        record.data.length <= Math.ceil(CHUNK / 3) * 4 &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(record.data),
    );
    const bytes = Buffer.from(record.data, "base64");
    ensure(bytes.length <= CHUNK && bytes.toString("base64") === record.data);
    if (!active) {
      const descriptor = manifest.files[index];
      ensure(
        descriptor &&
          record.part === 0 &&
          descriptor.area === record.area &&
          descriptor.key === record.key &&
          !identities.has(record.area + ":" + record.key),
      );
      identities.add(record.area + ":" + record.key);
      active = {
        part: 0,
        size: 0,
        hash: crypto.createHash("sha256"),
        descriptor,
      };
    }
    ensure(
      active.descriptor.area === record.area &&
        active.descriptor.key === record.key &&
        record.part === active.part++,
    );
    active.size += bytes.length;
    total += bytes.length;
    ensure(
      active.size <= 10 * 1024 ** 2 && total <= 1024 ** 3,
      "BACKUP_LIMIT_EXCEEDED",
    );
    active.hash.update(bytes);
    await consume(record, bytes);
    if (record.last) {
      ensure(
        active.size === active.descriptor.size &&
          active.hash.digest("hex") === active.descriptor.checksum,
      );
      active = null;
      index++;
    }
  });
  ensure(
    manifest &&
      !active &&
      index === manifest.files.length &&
      total === manifest.total_bytes &&
      JSON.stringify(result.manifest) === JSON.stringify(manifest),
  );
  return result;
}
function summary({ manifest, manifestHash }) {
  return {
    ok: true,
    backup_id: manifest.backup_id,
    manifest_hash: manifestHash,
    file_count: manifest.files.length,
    total_bytes: manifest.total_bytes,
    unresolved:
      manifest.missing.length +
      manifest.files.filter(
        (row) => !["ready", "quarantined"].includes(row.classification),
      ).length,
    atlas_snapshot_linked: manifest.atlas_snapshot_id !== null,
    atlas_snapshot_verified: false,
    database_backed_up: false,
  };
}
async function inspect({ file, key }) {
  const handle = await openFile(file);
  try {
    return summary(await authenticate(handle, key));
  } finally {
    await handle.close();
  }
}
async function stage({ file, key, target, storageRoot }) {
  target = await privateDirectory(target);
  ensure((await fs.readdir(target)).length === 0, "RESTORE_TARGET_NOT_EMPTY");
  if (storageRoot) {
    const live = path.resolve(storageRoot);
    for (const [a, b] of [
      [live, target],
      [target, live],
    ]) {
      const relative = path.relative(a, b);
      ensure(
        relative === ".." ||
          relative.startsWith(".." + path.sep) ||
          path.isAbsolute(relative),
        "RESTORE_PRIVATE_STAGING_REQUIRED",
      );
    }
  }
  const handle = await openFile(file),
    created = [];
  let current;
  try {
    const proof = await authenticate(handle, key); // Authenticate every byte before creating plaintext.
    for (const area of AREAS) {
      const dir = path.join(target, area);
      await fs.mkdir(dir, { mode: 0o700 });
      created.push(dir);
      await privateDirectory(dir, target);
    }
    const replay = await authenticate(handle, key, async (record, bytes) => {
      if (record.part === 0) {
        const filename = path.join(target, record.area, record.key);
        current = await fs.open(filename, "wx", 0o600);
        created.push(filename);
      }
      await writeAll(current, bytes);
      if (record.last) {
        await current.sync();
        await current.close();
        current = undefined;
      }
    });
    ensure(proof.manifestHash === replay.manifestHash);
    return {
      ...summary(proof),
      staged: true,
      delivery_enabled: false,
      requires_rescan: true,
      requires_database_reconciliation: true,
    };
  } catch (error) {
    if (current) await current.close();
    for (const filename of created.reverse()) {
      const stat = await fs.lstat(filename);
      if (stat.isDirectory()) await fs.rmdir(filename);
      else await fs.unlink(filename);
    }
    throw error;
  } finally {
    await handle.close();
  }
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || !command) {
    console.log(
      "backup|inspect|stage --file <absolute encrypted archive> --key-file <private 32-byte key>. backup optionally --atlas-snapshot-id <snapshot id>. stage --target <empty private offline directory>; never restores DB or enables delivery.",
    );
    return;
  }
  ensure(
    ["backup", "inspect", "stage"].includes(command),
    "INVALID_COMMAND_OPTIONS",
  );
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    ensure(
      args[i]?.startsWith("--") && args[i + 1] && !options[args[i]],
      "INVALID_COMMAND_OPTIONS",
    );
    options[args[i]] = args[i + 1];
  }
  const allowed = [
    "--file",
    "--key-file",
    ...(command === "backup"
      ? ["--atlas-snapshot-id"]
      : command === "stage"
        ? ["--target"]
        : []),
  ];
  ensure(
    Object.keys(options).every((key) => allowed.includes(key)) &&
      options["--file"] &&
      options["--key-file"] &&
      path.isAbsolute(options["--file"]) &&
      path.isAbsolute(options["--key-file"]),
    "INVALID_COMMAND_OPTIONS",
  );
  const keyHandle = await openFile(options["--key-file"]);
  let key, client;
  try {
    ensure((await keyHandle.stat()).size === 32, "BACKUP_KEY_REQUIRED");
    key = await keyHandle.readFile();
    const input = { file: options["--file"], key };
    let report;
    if (command === "backup") {
      const config = require("../server/dist/config").loadConfig();
      client = new MongoClient(config.mongoUri, {
        serverSelectionTimeoutMS: 10000,
      });
      await client.connect();
      report = await backup({
        ...input,
        db: client.db(),
        root: process.env.FILE_STORAGE_ROOT,
        atlasSnapshotId: options["--atlas-snapshot-id"] ?? null,
      });
    } else if (command === "stage")
      report = await stage({
        ...input,
        target: options["--target"],
        storageRoot: require('../server/dist/files/storage').storageDriver()==='s3' ? process.env.FILE_SPOOL_ROOT : process.env.FILE_STORAGE_ROOT,
      });
    else report = await inspect(input);
    console.log(JSON.stringify(report));
  } finally {
    key?.fill(0);
    await keyHandle.close();
    await client?.close();
  }
}
module.exports = { backup, inspect, stage, authenticate };
if (require.main === module)
  main().catch((error) => {
    console.error(error.safe ? error.message : "PRIVATE_FILES_BACKUP_FAILED");
    process.exitCode = 1;
  });
