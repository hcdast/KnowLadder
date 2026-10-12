"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  { parseEnv } = require("node:util");
function startupOptions(root, env = process.env) {
  const file = path.join(root, "server/.env");
  const values = {
    ...(fs.existsSync(file) ? parseEnv(fs.readFileSync(file, "utf8")) : {}),
    ...env,
  };
  function integer(key, fallback, min, max) {
    const raw = values[key];
    if (raw === undefined) return fallback;
    if (
      !/^[0-9]+$/.test(raw) ||
      !Number.isSafeInteger(Number(raw)) ||
      Number(raw) < min ||
      Number(raw) > max
    )
      throw Error("INVALID_CONFIG_" + key);
    return Number(raw);
  }
  return {
    timeoutMs: integer("KL_PM2_STARTUP_TIMEOUT_MS", 180000, 30000, 1800000),
    graceMs: integer("KL_PM2_TIMEOUT_STOP_GRACE_MS", 30000, 1000, 120000),
  };
}
module.exports = { startupOptions };
