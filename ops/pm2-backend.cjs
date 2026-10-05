/* Local PM2 wrapper for the four fixed KnowLadder application names.
 * The ecosystem config resolves FILE_SCAN_ENABLED with the backend's Node 22.19.0 parser.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const serverRoot = path.join(root, "server");
const ecosystem = path.join(root, "ecosystem.config.js");
const nodeBin = process.env.KL_NODE_BIN || process.execPath;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function requireReady() {
  if (!fs.existsSync(ecosystem)) fail("缺少根目录 ecosystem.config.js");
  if (!fs.existsSync(nodeBin)) {
    fail(`找不到 Node: ${nodeBin}。安装 Node 22.19.0 或设置 KL_NODE_BIN。`);
  }
  if (!fs.existsSync(path.join(serverRoot, ".env"))) {
    fail("缺少 server/.env。请从 .env.example 复制并填写。");
  }
  if (!fs.existsSync(path.join(serverRoot, "dist/files/config.js"))) {
    fail("缺少 server/dist/files/config.js。请先: npm --prefix server run build");
  }
  let apps;
  try {
    apps = require(ecosystem).apps;
  } catch {
    fail("无法解析 FILE_SCAN_ENABLED；请检查 Node 22.19.0、server 构建和配置");
  }
  for (const { script } of apps) {
    if (!fs.existsSync(path.join(serverRoot, script))) {
      fail(`缺少 server/${script}。请先: npm --prefix server run build`);
    }
  }
  return apps;
}

function resolvePm2Entry() {
  if (process.env.KL_PM2_BIN && fs.existsSync(process.env.KL_PM2_BIN)) {
    return process.env.KL_PM2_BIN;
  }
  const which = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    [process.platform === "win32" ? "pm2.cmd" : "pm2"],
    { encoding: "utf8" },
  );
  if (which.status === 0) {
    const candidate = which.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (candidate) {
      const nearby = path.join(
        path.dirname(candidate),
        "node_modules",
        "pm2",
        "bin",
        "pm2",
      );
      if (fs.existsSync(nearby)) return nearby;
    }
  }
  try {
    return require.resolve("pm2/bin/pm2");
  } catch {
    fail("找不到 pm2。请: npm install -g pm2，或设置 KL_PM2_BIN。");
  }
}

const pm2Entry = resolvePm2Entry();
const projectNames = [
  "kl-api",
  "kl-files-worker",
  "kl-assessment-worker",
  "kl-learning-worker",
];

function runPm2(args) {
  const result = spawnSync(nodeBin, [pm2Entry, ...args], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) {
    process.exit(result.status == null ? 1 : result.status);
  }
}

function projectProcesses() {
  const result = spawnSync(nodeBin, [pm2Entry, "jlist"], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) fail("无法读取 PM2 进程列表");
  let processes;
  try {
    processes = JSON.parse(result.stdout);
  } catch {
    fail("PM2 进程列表格式无效");
  }
  if (!Array.isArray(processes)) fail("PM2 进程列表格式无效");
  return processes.filter(({ name }) => projectNames.includes(name));
}

function stopProject(processes) {
  for (const name of projectNames) {
    if (processes.some((process) => process.name === name && process.pm2_env.status !== "stopped")) {
      runPm2(["stop", name]);
    }
  }
}

function deleteProject(processes, names) {
  for (const name of names) {
    if (processes.some((process) => process.name === name)) {
      runPm2(["delete", name]);
    }
  }
}

function start() {
  const apps = requireReady();
  const processes = projectProcesses();
  stopProject(processes);
  // Keep an old files worker registered but stopped when scanning is disabled.
  deleteProject(processes, apps.map(({ name }) => name));
  runPm2(["start", ecosystem]);
  runPm2(["status"]);
  console.log(
    [
      "",
      `已启动 ${apps.map(({ name }) => name).join("、")}（本地，非生产）。`,
      "直接使用 PM2 时，切换前须先停止本项目四个应用。",
      "Web: npm --prefix web run dev",
      "升级/migrate 前: node ops/pm2-backend.cjs stop",
    ].join("\n"),
  );
}

function stop() {
  const processes = projectProcesses();
  stopProject(processes);
  deleteProject(processes, projectNames);
  runPm2(["status"]);
}

const command = process.argv[2] || "start";
switch (command) {
  case "start":
    start();
    break;
  case "stop":
    stop();
    break;
  case "restart":
    start();
    break;
  case "status":
    runPm2(["status"]);
    break;
  case "logs":
    runPm2(["logs", "--lines", "80"]);
    break;
  default:
    fail(
      `未知命令: ${command}\n用法: node ops/pm2-backend.cjs <start|stop|restart|status|logs>\n或直接: pm2 start ecosystem.config.js`,
    );
}
