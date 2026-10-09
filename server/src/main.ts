import { managedApiEnabled } from "./training/managed-invocation";
import { startManagedApi } from "./training/managed-api-supervisor";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { Database } from "./database/database";
import {
  installShutdown,
  notifyReady,
  reportFailure,
} from "./runtime/process-lifecycle";
async function main() {
  const config = loadConfig();
  if (managedApiEnabled()) {
    const gateway = await startManagedApi(config.port);
    const dispose = installShutdown(async () => {
      try {
        await gateway.close();
      } finally {
        dispose();
      }
    });
    notifyReady();
    process.stdout.write("KnowLadder 受管 API 已启动\n");
    return;
  }
  const app = await createApp({ shutdownHooks: false });
  let closing: Promise<void> | undefined, timer: NodeJS.Timeout | undefined;
  const close = () =>
    (closing ??= (async () => {
      clearInterval(timer);
      try {
        await app.close();
      } finally {
        dispose();
      }
    })());
  const dispose = installShutdown(close);
  try {
    await app.listen(config.port, config.production ? "0.0.0.0" : "127.0.0.1");
    const database = app.get(Database);
    await database.ready();
    let checking = false;
    timer = setInterval(() => {
      if (checking || closing) return;
      checking = true;
      void database
        .writerStopRequested()
        .then((stop) => (stop ? close() : undefined))
        .catch(() => close())
        .finally(() => {
          checking = false;
        });
    }, 1000);
    timer.unref();
    notifyReady();
    process.stdout.write("KnowLadder API 已启动\n");
  } catch (error) {
    await close();
    throw error;
  }
}
main().catch((error) => {
  reportFailure("api", error);
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
