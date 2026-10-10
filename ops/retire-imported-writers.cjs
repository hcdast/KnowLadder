"use strict";
// Operator-attested retirement after all hosts have been stopped. No TTL/PID guessing.
const {
  MongoClient,
  BSON,
  ObjectId,
} = require("../server/node_modules/mongodb");
const { createHash, randomUUID } = require("node:crypto");
const { loadConfig } = require("../server/dist/config");
const { safeErrorCode } = require("../server/dist/runtime/process-lifecycle");
function fingerprint(rows) {
  const h = createHash("sha256");
  for (const row of rows) h.update(BSON.serialize(row));
  return h.digest("hex");
}
async function running(db, session) {
  return db
    .collection("operational_writers")
    .find({ state: "running" }, { session })
    .sort({ _id: 1 })
    .toArray();
}
async function inspect(db) {
  const state = await db
    .collection("operational_state")
    .findOne({ key: "environment" });
  if (!state || state.mode !== "unregistered")
    throw Error("OPERATIONS_UNREGISTERED_REQUIRED");
  const rows = await running(db);
  return {
    database: db.databaseName,
    writer_count: rows.length,
    writer_snapshot_hash: fingerprint(rows),
    environment_revision: state.revision,
  };
}
async function retire(db, input) {
  if (process.env.NODE_ENV === "production" || input.allHostsStopped !== true)
    throw Error("OPERATIONS_ALL_HOSTS_STOPPED_REQUIRED");
  if (
    input.database !== db.databaseName ||
    !Number.isSafeInteger(input.count) ||
    input.count < 1 ||
    input.count > 1000 ||
    !/^[a-f0-9]{64}$/.test(input.snapshotHash) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    !/^[a-f0-9]{24}$/.test(input.actor) ||
    typeof input.reason !== "string" ||
    input.reason.length < 10 ||
    input.reason.length > 300 ||
    /[\x00-\x1f]/.test(input.reason)
  )
    throw Error("OPERATIONS_ARGUMENT_INVALID");
  if (typeof (await db.admin().command({ hello: 1 })).setName !== "string")
    throw Error("OPERATIONS_REPLICA_SET_REQUIRED");
  const session = db.client.startSession();
  let count = 0;
  try {
    await session.withTransaction(
      async () => {
        const state = await db
          .collection("operational_state")
          .findOne(
            {
              key: "environment",
              mode: "unregistered",
              revision: input.revision,
            },
            { session },
          );
        if (!state) throw Error("OPERATIONS_REVISION_CONFLICT");
        const rows = await running(db, session);
        if (
          rows.length !== input.count ||
          fingerprint(rows) !== input.snapshotHash
        )
          throw Error("OPERATIONS_WRITER_SNAPSHOT_CHANGED");
        // Serialize against acquireWriter, whose transaction updates the same fence.
        const fenced = await db
          .collection("operational_state")
          .updateOne(
            { _id: state._id, revision: input.revision, mode: "unregistered" },
            {
              $inc: { revision: 1, access_fence: 1 },
              $set: { updated_at: new Date() },
            },
            { session },
          );
        if (fenced.modifiedCount !== 1)
          throw Error("OPERATIONS_REVISION_CONFLICT");
        const actor = await db
          .collection("users")
          .findOne(
            { _id: new ObjectId(input.actor), status: "active" },
            { session },
          );
        if (!actor) throw Error("OPERATIONS_ACTOR_REQUIRED");
        const now = new Date();
        const changed = await db
          .collection("operational_writers")
          .updateMany(
            { _id: { $in: rows.map((row) => row._id) }, state: "running" },
            { $set: { state: "stopped", stopped_at: now, heartbeat_at: now } },
            { session },
          );
        if (changed.modifiedCount !== input.count)
          throw Error("OPERATIONS_WRITER_SNAPSHOT_CHANGED");
        await db
          .collection("audit_events")
          .insertOne(
            {
              _id: new ObjectId(),
              actor_id: new ObjectId(input.actor),
              org_id: null,
              action: "operations.retire-imported-writers",
              resource_id: db.databaseName,
              reason:
                input.reason +
                "; operator all-host stop attestation; count=" +
                input.count +
                "; snapshot=" +
                input.snapshotHash,
              request_id: randomUUID(),
              created_at: now,
            },
            { session },
          );
        count = changed.modifiedCount;
      },
      {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
      },
    );
  } finally {
    await session.endSession();
  }
  return {
    ok: true,
    retired: count,
    deleted: 0,
    exit_proof: "operator-all-host-stop-attestation",
    snapshot_hash: input.snapshotHash,
  };
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!["inspect", "retire"].includes(command))
    throw Error("OPERATIONS_ARGUMENT_INVALID");
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !args[i]?.startsWith("--") ||
      !args[i + 1] ||
      Object.hasOwn(options, args[i])
    )
      throw Error("OPERATIONS_ARGUMENT_INVALID");
    options[args[i]] = args[i + 1];
  }
  const allowed =
    command === "inspect"
      ? ["--database"]
      : [
          "--database",
          "--snapshot-hash",
          "--count",
          "--revision",
          "--actor",
          "--reason",
          "--all-hosts-stopped",
        ];
  if (Object.keys(options).some((key) => !allowed.includes(key)))
    throw Error("OPERATIONS_ARGUMENT_INVALID");
  const config = loadConfig();
  if (config.production) throw Error("OPERATIONS_NONPRODUCTION_REQUIRED");
  const client = new MongoClient(config.mongoUri, {
    serverSelectionTimeoutMS: 10000,
  });
  try {
    await client.connect();
    const db = client.db();
    if (db.databaseName !== options["--database"])
      throw Error("OPERATIONS_DATABASE_MISMATCH");
    console.log(
      JSON.stringify(
        command === "inspect"
          ? await inspect(db)
          : await retire(db, {
              database: options["--database"],
              snapshotHash: options["--snapshot-hash"],
              count: Number(options["--count"]),
              revision: Number(options["--revision"]),
              actor: options["--actor"],
              reason: options["--reason"],
              allHostsStopped: options["--all-hosts-stopped"] === "true",
            }),
      ),
    );
  } finally {
    await client.close();
  }
}
module.exports = { inspect, retire };
if (require.main === module)
  main().catch((e) => {
    console.error(JSON.stringify({ ok: false, code: safeErrorCode(e) }));
    process.exitCode = 1;
  });
