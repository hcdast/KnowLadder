"use strict";
// Read-only proof: never retire or alter registrations after a forced exit.
const { MongoClient } = require("../server/node_modules/mongodb");
const { loadConfig } = require("../server/dist/config");
const { createHash } = require("node:crypto");
function knownDatabase(databaseIds, id) {
  return (
    Array.isArray(databaseIds) &&
    databaseIds.length > 0 &&
    /^[a-f0-9]{64}$/.test(id) &&
    databaseIds.every((v) => v === id)
  );
}
async function verifyStopped(databaseIds, budgetMs) {
  const config = loadConfig(),
    id = createHash("sha256").update(config.mongoUri).digest("hex");
  if (config.production || !knownDatabase(databaseIds, id))
    throw Error("STARTUP_WRITER_RELEASE_UNCONFIRMED");
  const client = new MongoClient(config.mongoUri, {
    serverSelectionTimeoutMS: Math.min(3000, budgetMs),
    connectTimeoutMS: Math.min(3000, budgetMs),
    socketTimeoutMS: Math.min(3000, budgetMs),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
    void client.close(true).catch(() => {});
  }, budgetMs);
  try {
    await client.connect();
    if (
      await client
        .db()
        .collection("operational_writers")
        .findOne(
          { state: "running" },
          {
            projection: { _id: 1 },
            maxTimeMS: Math.min(3000, budgetMs),
            signal: controller.signal,
          },
        )
    )
      throw Error("STARTUP_WRITER_RELEASE_UNCONFIRMED");
    return true;
  } finally {
    clearTimeout(timer);
    await client.close(Boolean(controller.signal.aborted));
  }
}
module.exports = { verifyStopped, knownDatabase };
if (require.main === module) {
  let data = "";
  process.stdin.on("data", (s) => {
    data += s;
    if (data.length > 8192) process.exit(1);
  });
  process.stdin.on("end", () => {
    Promise.resolve()
      .then(() => {
        const v = JSON.parse(data);
        if (
          !Number.isSafeInteger(v.budgetMs) ||
          v.budgetMs < 1 ||
          v.budgetMs > 15000
        )
          throw Error();
        return verifyStopped(v.databaseIds, v.budgetMs);
      })
      .then(() => process.stdout.write('{"ok":true}'))
      .catch(() => {
        process.stdout.write('{"ok":false}');
        process.exitCode = 1;
      });
  });
}
