/* Local-only PM2 config for KnowLadder backend (参考 model-hub/ecosystem.config.js 结构).
 * 仅 API + 独立 worker；不含 Mongo、migrate、admin CLI、Vite。
 * 非生产拓扑；上线部署另行授权。
 *
 * 用法（仓库根目录）:
 *   pm2 start ecosystem.config.js
 *   pm2 status
 *   pm2 logs
 *   切换扫描开关前: node ops/pm2-backend.cjs stop
 *   停止/删除（含已不在配置中的旧 files）: node ops/pm2-backend.cjs stop
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const serverRoot = path.join(__dirname, "server");
const envFile = path.join(serverRoot, ".env");
/** 使用当前 Node.js 22.19.0 解释器；可用 KL_NODE_BIN 显式覆盖。 */
const interpreter = process.env.KL_NODE_BIN || process.execPath;

// Resolve every flag once with the exact interpreter/env precedence used by runtime.
const flags = spawnSync(
  interpreter,
  [
    "--env-file-if-exists=.env",
    "-e",
    'try { process.stdout.write(JSON.stringify({...require("./dist/runtime/feature-flags.js").resolveFeatureFlags(), KL_PM2_DEPLOYMENT_ID:require("../ops/deployment-identity.cjs").deploymentIdentity(require("node:path").resolve("..")), KL_PM2_SHUTDOWN_TIMEOUT_MS:Math.max(65000, process.env.FILE_SCAN_ENABLED === "false" ? 0 : require("./dist/files/config.js").fileConfig().timeout * 6 + 15000), KL_PM2_DATABASE_ID:require("node:crypto").createHash("sha256").update(require("./dist/config.js").loadConfig().mongoUri).digest("hex")})); } catch(e) { process.stderr.write(require("./dist/runtime/process-lifecycle.js").safeErrorCode(e)); process.exitCode=1; }',
  ],
  {
    cwd: serverRoot,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
  },
);
if (flags.error || flags.status !== 0)
  throw Error(
    /^(INVALID_FLAG_|INVALID_CONFIG_|FEATURE_)[A-Z0-9_]+$/.test(
      flags.stderr || "",
    )
      ? flags.stderr
      : "FEATURE_RESOLUTION_FAILED",
  );
const appEnv = { ...JSON.parse(flags.stdout), KL_PM2_PROTOCOL: "2" };
const scanEnabled = appEnv.FILE_SCAN_ENABLED === "true";

module.exports = {
  apps: [
    { name: "kl-api", script: "dist/main.js" },
    { name: "kl-files-worker", script: "dist/files/worker.js", args: "run" },
    {
      name: "kl-assessment-worker",
      script: "dist/assessment/worker.js",
      args: "run",
    },
    {
      name: "kl-learning-worker",
      script: "dist/learning/worker.js",
      args: "run",
    },
    {
      name: "kl-knowledge-worker",
      script: "dist/training/knowledge-worker.js",
      args: "run",
    },
    {
      name: "kl-import-worker",
      script: "dist/training/import-worker.js",
      args: "run",
    },
  ]
    .map((app) => ({
      ...app,
      cwd: serverRoot,
      instances: 1,
      exec_mode: "fork",
      interpreter,
      node_args: `--env-file-if-exists=${envFile}`,
      watch: false,
      time: true,
      kill_timeout: appEnv.KL_PM2_SHUTDOWN_TIMEOUT_MS,
      shutdown_with_message: true,
      wait_ready: true,
      listen_timeout: 60000,
      env: {
        ...appEnv,
        KL_WRITER_LAUNCH_TOKEN: require("node:crypto").randomUUID(),
      },
      min_uptime: 10000,
      max_restarts: 10,
      // Startup/safety failures are terminal; released transient runtime failures may retry.
      stop_exit_codes: [78],
      exp_backoff_restart_delay: 1000,
    }))
    .filter(
      (app) =>
        (appEnv.KL_STANDALONE_MANAGED_API_ENABLED !== "true" ||
          app.name === "kl-api") &&
        (scanEnabled || app.name !== "kl-files-worker") &&
        (appEnv.KL_KNOWLEDGE_ENABLED === "true" ||
          app.name !== "kl-knowledge-worker") &&
        (appEnv.KL_KNOWLEDGE_IMPORT_ENABLED === "true" ||
          app.name !== "kl-import-worker"),
    ),
};
