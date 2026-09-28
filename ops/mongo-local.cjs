/* Local verification only: downloads and runs real MongoDB WiredTiger processes.
 * Database files live outside the repository and survive process restarts. */
const {
  MongoBinary,
} = require("../server/node_modules/mongodb-memory-server-core");
const { MongoClient } = require("../server/node_modules/mongodb");
const { spawn } = require("node:child_process");
const { mkdir, realpath } = require("node:fs/promises");
const path = require("node:path");

async function main() {
  const root = process.env.KL_MONGO_DATA;
  if (!root || !path.isAbsolute(root))
    throw new Error("KL_MONGO_DATA 必须为仓库外的绝对路径");
  await mkdir(root, { recursive: true });
  const resolved = await realpath(root);
  const repository = await realpath(path.resolve(__dirname, ".."));
  const relative = path.relative(repository, resolved);
  if (!(
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ))
    throw new Error("数据库目录不能位于仓库内");
  const basePort = Number(process.env.KL_MONGO_PORT || 27117);
  if (!Number.isInteger(basePort) || basePort < 1024 || basePort > 65533)
    throw new Error("非法MongoDB端口");
  const count = process.env.KL_MONGO_STANDALONE === "true" ? 1 : 3;
  const testCommands = process.env.KL_MONGO_TEST_COMMANDS === "true";
  if (process.env.KL_MONGO_TEST_COMMANDS !== undefined &&
      !["true", "false"].includes(process.env.KL_MONGO_TEST_COMMANDS))
    throw new Error("KL_MONGO_TEST_COMMANDS 仅允许 true 或 false");
  if (testCommands && (count !== 3 || !/^kl_test_[a-zA-Z0-9_-]+$/.test(path.basename(resolved))))
    throw new Error("故障测试必须使用三节点及仓库外独立 kl_test_ 数据目录");
  const replicaSet = testCommands ? "kl-test-faults" : "kl-local";
  const binary = await MongoBinary.getPath({
    version: process.env.KL_MONGO_VERSION || "8.0.17",
  });
  const children = [];
  let stopping = false;
  const stop = () => {
    stopping = true;
    for (const child of children) child.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    for (let i = 0; i < count; i++) {
      const dbPath = path.join(resolved, String(basePort + i));
      await mkdir(dbPath, { recursive: true });
      const args = [
        "--dbpath",
        dbPath,
        "--port",
        String(basePort + i),
        "--bind_ip",
        "127.0.0.1",
        "--wiredTigerCacheSizeGB",
        "0.25",
        "--logpath",
        path.join(dbPath, "mongod.log"),
        "--logappend",
      ];
      if (count > 1) args.push("--replSet", replicaSet);
      if (testCommands) args.push("--setParameter", "enableTestCommands=1");
      const child = spawn(binary, args, {
        stdio: ["ignore", "inherit", "inherit"],
        windowsHide: true,
      });
      children.push(child);
      child.on("error", () => {
        console.error("MongoDB进程启动失败");
        stop();
        process.exitCode = 1;
      });
      child.on("exit", (code) => {
        if (!stopping) {
          console.error(`MongoDB成员 ${i} 退出 ${code}`);
          stop();
          process.exitCode = 1;
        }
      });
    }
    for (let i = 0; i < count; i++) {
      let ready = false;
      for (let attempt = 0; attempt < 90 && !stopping; attempt++) {
        const client = new MongoClient(
          `mongodb://127.0.0.1:${basePort + i}/?directConnection=true`,
          { serverSelectionTimeoutMS: 1000 },
        );
        try {
          await client.db("admin").command({ ping: 1 });
          ready = true;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 500));
        } finally {
          await client.close();
        }
      }
      if (!ready) throw new Error("MongoDB成员未就绪");
    }
    if (count > 1) {
      const direct = new MongoClient(
        `mongodb://127.0.0.1:${basePort}/?directConnection=true`,
        { serverSelectionTimeoutMS: 3000 },
      );
      try {
        try {
          await direct.db("admin").command({ replSetGetStatus: 1 });
        } catch (error) {
          if (error.code !== 94) throw error;
          await direct
            .db("admin")
            .command({
              replSetInitiate: {
                _id: replicaSet,
                members: Array.from({ length: count }, (_, i) => ({
                  _id: i,
                  host: `127.0.0.1:${basePort + i}`,
                })),
              },
            });
        }
      } finally {
        await direct.close();
      }
    }
    const hosts = Array.from(
      { length: count },
      (_, i) => `127.0.0.1:${basePort + i}`,
    ).join(",");
    const database = testCommands ? "kl_test_faults" : "kl_development";
    const uri = `mongodb://${hosts}/${database}${count > 1 ? `?replicaSet=${replicaSet}` : ""}`;
    const primary = new MongoClient(uri, { serverSelectionTimeoutMS: 90000 });
    try {
      await primary.db().command({ ping: 1 });
    } finally {
      await primary.close();
    }
    console.log(
      `MongoDB READY (${count} real WiredTiger process${count > 1 ? "es" : ""}): ${uri}`,
    );
    await Promise.all(
      children.map(
        (child) => new Promise((resolve) => child.once("exit", resolve)),
      ),
    );
  } catch (error) {
    stop();
    throw error;
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
