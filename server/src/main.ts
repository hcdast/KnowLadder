import { createApp } from "./app";
import { loadConfig } from "./config";
import { Database } from "./database/database";
async function main() {
  const config = loadConfig();
  const app = await createApp();
  let closing = false;
  let timer: NodeJS.Timeout | undefined;
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    await app.close();
  };
  process.once("SIGINT", () => { void close().catch(() => { process.exitCode = 1; }); });
  process.once("SIGTERM", () => { void close().catch(() => { process.exitCode = 1; }); });
  try {
    await app.listen(config.port, config.production ? "0.0.0.0" : "127.0.0.1");
    const database = app.get(Database);
    let checking = false;
    timer = setInterval(() => {
      if (checking || closing) return;
      checking = true;
      void database.writerStopRequested().then(stop => stop ? close() : undefined)
        .catch(() => close()).finally(() => { checking = false; });
    }, 1000);
    timer.unref();
    process.stdout.write(`KnowLadder API 已启动，端口 ${config.port}\n`);
  } catch (error) {
    await close();
    throw error;
  }
}
main().catch((error: unknown) => {
  if (error instanceof Error && error.message === 'FILE_SCAN_ENABLED 必须为 true 或 false') {
    process.stderr.write('API 启动失败：FILE_SCAN_ENABLED 必须为 true 或 false。\n');
    process.exitCode = 1;
    return;
  }
  process.stderr.write(
    "API 启动失败：请检查运行配置、数据库副本集与迁移状态。\n",
  );
  process.exitCode = 1;
});
