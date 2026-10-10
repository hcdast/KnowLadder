"use strict";
// Read-only evidence. Never prints connection strings, keys, payloads or identities.
const { MongoClient } = require("../server/node_modules/mongodb");
const fs = require("node:fs");
async function main() {
  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });
  try {
    await client.connect();
    const db = client.db(),
      hello = await db.admin().command({ hello: 1 });
    const names = new Set(
      (await db.listCollections({}, { nameOnly: true }).toArray()).map(
        (row) => row.name,
      ),
    );
    const flags = Object.fromEntries(
      [
        "KL_TRAINING_ENABLED",
        "KL_TRAINING_PHASE2_ENABLED",
        "KL_KNOWLEDGE_ENABLED",
        "KL_KNOWLEDGE_IMPORT_ENABLED",
        "KL_TRAINING_SURVEYS_ENABLED",
        "KL_STANDALONE_RECOVERY_ENABLED",
        "KL_STANDALONE_MANAGED_API_ENABLED",
        "FILE_SCAN_ENABLED",
      ].map((key) => [key, process.env[key] === "true"]),
    );
    const completed = names.has("schema_migrations")
      ? (
          await db
            .collection("schema_migrations")
            .find(
              { status: "completed" },
              { projection: { version: 1, _id: 0 } },
            )
            .toArray()
        )
          .map((row) => row.version)
          .sort((a, b) => a - b)
      : [];
    const paths = Object.fromEntries(
      [
        require("../server/dist/files/storage").storageDriver()==="s3" ? "FILE_SPOOL_ROOT" : "FILE_STORAGE_ROOT",
        "CLAMSCAN_PATH",
        "CLAMAV_DATABASE",
        "KL_SAFETY_LEDGER_ROOT",
        "KL_SAFETY_LEDGER_MIRROR_ROOT",
      ].map((key) => [
        key,
        Boolean(process.env[key] && fs.existsSync(process.env[key])),
      ]),
    );
    const loopback = client.options.hosts?.every((host) =>
      ["localhost", "127.0.0.1", "::1"].includes(host.host),
    );
    const writers = names.has("operational_writers")
      ? await db
          .collection("operational_writers")
          .countDocuments({ state: "running" })
      : 0;
    const state = names.has("training_standalone_writer")
      ? await db
          .collection("training_standalone_writer")
          .findOne({ key: "global" }, { projection: { state: 1, _id: 0 } })
      : null;
    const pending = names.has("training_standalone_operations")
      ? await db
          .collection("training_standalone_operations")
          .countDocuments({ state: { $ne: "completed" } })
      : 0;
    console.log(
      JSON.stringify({
        checked_at: new Date().toISOString(),
        read_only: true,
        topology: hello.setName ? "replicaSet" : "standalone",
        remote: !loopback,
        completed_schema_versions: completed,
        flags,
        path_exists: paths,
        active_writer_count: writers,
        global_state: state?.state ?? "not_migrated",
        pending_operation_count: pending,
        private_file_record_count: names.has("file_resources")
          ? await db.collection("file_resources").countDocuments()
          : 0,
        existing_system_backup_supports_target: Boolean(
          loopback &&
          hello.setName &&
          /^kl_(test|restore)_/.test(db.databaseName),
        ),
        backup_key_configured: /^[0-9a-f]{64}$/i.test(
          process.env.SYSTEM_BACKUP_KEY ?? "",
        ),
        control_ledger_configured: Boolean(
          process.env.KL_CONTROL_MONGODB_URI &&
          process.env.KL_SAFETY_LEDGER_KEY &&
          process.env.KL_ENVIRONMENT_ID,
        ),
      }),
    );
  } finally {
    await client.close();
  }
}
if (require.main === module)
  main().catch(() => {
    console.error("STANDALONE_PREFLIGHT_FAILED");
    process.exitCode = 1;
  });
