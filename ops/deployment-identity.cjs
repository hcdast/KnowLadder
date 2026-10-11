"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { parseEnv } = require("node:util");
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
  ])
    add(file, fs.readFileSync(path.join(root, file)));
  return hash.digest("hex");
}
module.exports = { deploymentIdentity };
