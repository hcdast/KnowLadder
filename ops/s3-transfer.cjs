"use strict";
const {
  fs,
  path,
  ensure,
  hash,
  privateDirectory,
  openFile,
} = require("./system-backup-archive.cjs");
const { filesInventory } = require("./system-backup.cjs");
const storage = require("../server/dist/files/storage");
const {
  rawDatabase,
  objectIdDatabase,
} = require("../server/dist/database/object-id");
const control = require("../server/dist/operations/control");
const { safeErrorCode } = require("../server/dist/runtime/process-lifecycle");
async function inspect(db, source) {
  ensure(storage.storageDriver() === "s3", "STORAGE_S3_REQUIRED");
  ensure(
    typeof source === "string" && path.isAbsolute(source),
    "PRIVATE_DIRECTORY_REQUIRED",
  );
  source = await privateDirectory(source);
  const spool =
    await require("../server/dist/files/config").assertLocalStorageReady();
  for (const [base, child] of [
    [source, spool],
    [spool, source],
  ]) {
    const relative = path.relative(base, child);
    ensure(
      relative === ".." ||
        relative.startsWith(".." + path.sep) ||
        path.isAbsolute(relative),
      "STORAGE_TRANSFER_SPOOL_COLLISION",
    );
  }

  const resources = await rawDatabase(db)
    .collection("file_resources")
    .find(
      {},
      {
        projection: {
          _id: 1,
          storage_key: 1,
          upload_storage_key: 1,
          upload_storage_keys: 1,
          size: 1,
          checksum: 1,
          status: 1,
          scan_status: 1,
          deleted_at: 1,
        },
      },
    )
    .sort({ _id: 1 })
    .limit(1001)
    .toArray();
  ensure(resources.length <= 1000, "BACKUP_LIMIT_EXCEEDED");
  const decoded = resources.map((row) =>
    require("../server/dist/database/object-id").decodeDocument(
      row,
      "file_resources",
    ),
  );
  const inventory = await filesInventory(source, decoded);
  const plan = {
    format: "kl-s3-transfer-1",
    source: hash(source),
    target: hash(storage.storageIdentity()),
    database: db.databaseName,
    resources: hash(JSON.stringify(resources)),
    inventory,
  };
  return { plan, hash: hash(JSON.stringify(plan)), source };
}
async function copy(db, input) {
  ensure(input.allHostsStopped === true, "OPERATIONS_ALL_HOSTS_STOP_REQUIRED");
  const token = process.env.KL_MAINTENANCE_TOKEN,
    gate = await control.assertMaintenance(db, token);
  const guard = async () => {
    const current = await control.assertMaintenance(db, token);
    ensure(current.revision === gate.revision, "OPERATIONS_REVISION_CONFLICT");
    ensure(
      !(await db
        .collection("operational_writers")
        .countDocuments({ state: "running" })),
      "OPERATIONS_WRITERS_RUNNING",
    );
  };
  await guard();
  await storage.assertStorageBackendReady();
  const before = await inspect(db, input.sourceRoot);
  ensure(before.hash === input.expectedHash, "STORAGE_TRANSFER_PLAN_CHANGED");
  ensure(
    before.plan.inventory.missing.length === 0,
    "STORAGE_TRANSFER_SOURCE_MISSING",
  );
  const journal = path.resolve(input.manifest);
  await privateDirectory(path.dirname(journal));
  let state;
  try {
    const handle = await openFile(journal);
    try {
      ensure(
        (await handle.stat()).size <= 2 * 1024 * 1024,
        "STORAGE_TRANSFER_MANIFEST_INVALID",
      );
      state = JSON.parse((await handle.readFile()).toString("utf8"));
    } finally {
      await handle.close();
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    state = { format: "kl-s3-transfer-1", hash: before.hash, completed: [] };
    await fs.writeFile(journal, JSON.stringify(state), {
      flag: "wx",
      mode: 0o600,
    });
  }
  ensure(
    state.format === "kl-s3-transfer-1" &&
      state.hash === before.hash &&
      Array.isArray(state.completed),
    "STORAGE_TRANSFER_MANIFEST_INVALID",
  );
  const planned = new Map(
    before.plan.inventory.descriptors.map((d) => [d.area + "/" + d.key, d]),
  );
  ensure(
    state.completed.every((x) => typeof x === "string" && planned.has(x)) &&
      new Set(state.completed).size === state.completed.length,
    "STORAGE_TRANSFER_MANIFEST_INVALID",
  );
  for (const area of storage.STORAGE_AREAS)
    for (const row of await storage.listStorage(area))
      ensure(
        planned.has(area + "/" + row.key),
        "STORAGE_TRANSFER_TARGET_CONFLICT",
      );
  for (const d of before.plan.inventory.descriptors) {
    await guard();
    const handle = await openFile(
      path.join(before.source, d.area, d.key),
      before.source,
    );
    let bytes;
    try {
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    ensure(
      bytes.length === d.size && storage.bytesChecksum(bytes) === d.checksum,
      "STORAGE_TRANSFER_SOURCE_CHANGED",
    );
    await storage.putStorageBytes(d.area, d.key, bytes);
    ensure(
      (await storage.readStorageBytes(d.area, d.key)).equals(bytes),
      "STORAGE_TRANSFER_TARGET_CHANGED",
    );
    if (!state.completed.includes(d.area + "/" + d.key))
      state.completed.push(d.area + "/" + d.key);
    const temporary = journal + "." + require("node:crypto").randomUUID();
    await fs.writeFile(temporary, JSON.stringify(state), {
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporary, journal);
  }
  await guard();
  const after = await inspect(db, input.sourceRoot);
  ensure(after.hash === before.hash, "STORAGE_TRANSFER_SOURCE_CHANGED");
  for (const area of storage.STORAGE_AREAS) {
    const actual = await storage.listStorage(area);
    const expected = before.plan.inventory.descriptors.filter(
      (d) => d.area === area,
    );
    ensure(
      actual.length === expected.length,
      "STORAGE_TRANSFER_TARGET_CHANGED",
    );
    for (const d of expected) {
      const bytes = await storage.readStorageBytes(area, d.key);
      ensure(
        bytes.length === d.size && storage.bytesChecksum(bytes) === d.checksum,
        "STORAGE_TRANSFER_TARGET_CHANGED",
      );
    }
  }
  await guard();
  return {
    ok: true,
    files: state.completed.length,
    plan_hash: before.hash,
    source_preserved: true,
    driver_switched: false,
  };
}
async function main() {
  const [command, ...args] = process.argv.slice(2),
    options = {};
  for (let i = 0; i < args.length; i += 2) {
    ensure(
      args[i]?.startsWith("--") &&
        args[i + 1] &&
        !Object.hasOwn(options, args[i]),
      "OPERATIONS_ARGUMENT_INVALID",
    );
    options[args[i]] = args[i + 1];
  }
  const allowed =
    command === "inspect"
      ? ["--source-root"]
      : command === "copy"
        ? [
            "--source-root",
            "--manifest",
            "--expected-hash",
            "--all-hosts-stopped",
          ]
        : [];
  ensure(
    allowed.length &&
      options["--source-root"] &&
      Object.keys(options).every((k) => allowed.includes(k)),
    "OPERATIONS_ARGUMENT_INVALID",
  );
  const { MongoClient } = require("../server/node_modules/mongodb"),
    config = require("../server/dist/config").loadConfig();
  ensure(!config.production, "OPERATIONS_NONPRODUCTION_REQUIRED");
  const client = new MongoClient(config.mongoUri, {
    serverSelectionTimeoutMS: 10000,
  });
  try {
    await client.connect();
    const db = objectIdDatabase(client.db());
    if (command === "inspect") {
      const result = await inspect(db, options["--source-root"]);
      console.log(
        JSON.stringify({
          ok: true,
          plan_hash: result.hash,
          files: result.plan.inventory.descriptors.length,
          bytes: result.plan.inventory.total,
          missing: result.plan.inventory.missing.length,
        }),
      );
    } else {
      ensure(
        options["--manifest"] &&
          path.isAbsolute(options["--manifest"]) &&
          /^[a-f0-9]{64}$/.test(options["--expected-hash"] ?? ""),
        "OPERATIONS_ARGUMENT_INVALID",
      );
      console.log(
        JSON.stringify(
          await copy(db, {
            sourceRoot: options["--source-root"],
            manifest: options["--manifest"],
            expectedHash: options["--expected-hash"],
            allHostsStopped: options["--all-hosts-stopped"] === "true",
          }),
        ),
      );
    }
  } finally {
    await client.close();
  }
}
module.exports = { inspect, copy };
if (require.main === module)
  main().catch((e) => {
    console.error(JSON.stringify({ ok: false, code: safeErrorCode(e) }));
    process.exitCode = 1;
  });
