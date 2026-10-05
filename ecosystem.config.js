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

// Use the same Node/env-file precedence and parser as the backend, not PM2's Node.
const scanFlag = spawnSync(
  interpreter,
  [
    "--env-file-if-exists=.env",
    "-e",
    'process.stdout.write(require("./dist/files/config.js").fileScanEnabled() ? "true" : "false")',
  ],
  { cwd: serverRoot, env: process.env, encoding: "utf8", windowsHide: true },
);
if (scanFlag.error || scanFlag.status !== 0 || !["true", "false"].includes(scanFlag.stdout)) {
  throw new Error("无法解析 FILE_SCAN_ENABLED；请检查 Node 22.19.0、server 构建和配置");
}
const scanEnabled = scanFlag.stdout === "true";
const appEnv = { FILE_SCAN_ENABLED: scanFlag.stdout };

module.exports = {
  apps: [
    {
      name: "kl-api",
      cwd: serverRoot,
      script: "dist/main.js",
      instances: 1,
      exec_mode: "fork",
      interpreter,
      env: { ...appEnv },
      node_args: `--env-file-if-exists=${envFile}`,
      watch: false,
      time: true,
      kill_timeout: 10000,
    },
    {
      name: "kl-files-worker",
      cwd: serverRoot,
      script: "dist/files/worker.js",
      args: "run",
      instances: 1,
      exec_mode: "fork",
      interpreter,
      env: { ...appEnv },
      node_args: `--env-file-if-exists=${envFile}`,
      watch: false,
      time: true,
      kill_timeout: 10000,
    },
    {
      name: "kl-assessment-worker",
      cwd: serverRoot,
      script: "dist/assessment/worker.js",
      args: "run",
      instances: 1,
      exec_mode: "fork",
      interpreter,
      env: { ...appEnv },
      node_args: `--env-file-if-exists=${envFile}`,
      watch: false,
      time: true,
      kill_timeout: 10000,
    },
    {
      name: "kl-learning-worker",
      cwd: serverRoot,
      script: "dist/learning/worker.js",
      args: "run",
      instances: 1,
      exec_mode: "fork",
      interpreter,
      env: { ...appEnv },
      node_args: `--env-file-if-exists=${envFile}`,
      watch: false,
      time: true,
      kill_timeout: 10000,
    },
  ].filter((app) => scanEnabled || app.name !== "kl-files-worker"),
};
