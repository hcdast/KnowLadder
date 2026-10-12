"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { parseEnv } = require("node:util");
function startupMode(root, env = process.env) {
  const parsed = parseEnv(
    fs.readFileSync(path.join(root, "server/.env"), "utf8"),
  );
  const mode = env.KL_PM2_START_MODE ?? parsed.KL_PM2_START_MODE ?? "serial";
  if (!["serial", "parallel"].includes(mode))
    throw Error("INVALID_CONFIG_KL_PM2_START_MODE");
  return mode;
}
function deploymentIdentity(
  root,
  env = process.env,
  node = env.KL_NODE_BIN || process.execPath,
) {
  const hash = crypto.createHash("sha256");
  const add = (name, bytes) => {
    hash.update(name);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  };
  const envBytes = fs.readFileSync(path.join(root, "server/.env"));
  add("env-file", envBytes);
  // Scheduling is effective configuration, unlike generated PM2 identities.
  add("start-mode", startupMode(root, env));
  add(
    "startup-options",
    JSON.stringify(require("./startup-options.cjs").startupOptions(root, env)),
  );
  const parsed = parseEnv(envBytes.toString());
  const names = new Set(Object.keys(parsed));
  for (const key of Object.keys(env))
    if (
      /^(KL_|S3_|FILE_|CLAM|SCAN_|APP_|ALLOW_|AUTH_|SESSION_|TEMPORARY_|TRUST_|PORT$|MONGODB_|NODE_)/.test(
        key,
      )
    )
      names.add(key);
  for (const name of [...names].sort()) {
    if (/^KL_(PM2_|WRITER_|MANAGED_)/.test(name)) continue;
    add("env:" + name, env[name] ?? parsed[name] ?? "");
  }
  add("node", path.resolve(node));
  add("node-version", process.version);
  function tree(dir) {
    for (const item of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, item.name);
      if (item.isSymbolicLink())
        throw Error("OPERATIONS_BUILD_LINK_UNSUPPORTED");
      if (item.isDirectory()) tree(file);
      else if (/\.(js|json)$/.test(item.name))
        add(path.relative(root, file), fs.readFileSync(file));
    }
  }
  tree(path.join(root, "server/dist"));
  for (const file of [
    "server/package-lock.json",
    "ecosystem.config.js",
    "ops/pm2-backend.cjs",
    "ops/backend-preflight.cjs",
    "ops/deployment-identity.cjs",
    "ops/startup-timing.cjs",
    "ops/preflight-budget.cjs",
    "ops/startup-options.cjs",
    "ops/startup-supervisor.cjs",
    "ops/process-tree.cjs",
    "ops/startup-stop-proof.cjs",
  ])
    add(file, fs.readFileSync(path.join(root, file)));
  return hash.digest("hex");
}
module.exports = { deploymentIdentity, startupMode };
