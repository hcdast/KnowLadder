"use strict";
// Isolated acceptance only. Both topology URIs point to disposable kl_test_ databases.
const { MongoMemoryServer, MongoMemoryReplSet } = require("mongodb-memory-server-core");
const { spawn } = require("node:child_process");
const path = require("node:path");
async function main() {
  let replica, standalone;
  try {
    replica = await MongoMemoryReplSet.create({ binary: { version: "8.0.17" }, replSet: { count: 1, storageEngine: "wiredTiger" }, instanceOpts: [{ args: ["--wiredTigerCacheSizeGB", "0.25"] }] });
    standalone = await MongoMemoryServer.create({ binary: { version: "8.0.17" }, instance: { args: ["--wiredTigerCacheSizeGB", "0.25"] } });
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1", ...process.argv.slice(2)], {
      cwd: path.resolve(__dirname, ".."), windowsHide: true, stdio: "inherit",
      env: { ...process.env, TEST_FILE_STORAGE_PARENT: require("node:os").homedir(),
        ...(process.platform === "win32" ? { PSModulePath: path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/Modules") } : {}),
        TEST_MONGODB_URI: replica.getUri("kl_test_acceptance_replica"),
        TEST_STANDALONE_MONGODB_URI: standalone.getUri("kl_test_acceptance_standalone") },
    });
    process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
  } finally {
    await standalone?.stop();
    await replica?.stop();
  }
}
main().catch(() => { console.error("ISOLATED_ACCEPTANCE_RUNNER_FAILED"); process.exitCode = 1; });
