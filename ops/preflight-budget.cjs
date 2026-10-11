"use strict";
const fs = require("node:fs"),
  { parseEnv } = require("node:util");
function preflightBudget(proof = false, env = process.env) {
  const value = env.KL_PREFLIGHT_TIMEOUT_MS;
  if (value === undefined) return proof ? 90000 : 120000;
  if (
    !/^[0-9]+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 10000 ||
    Number(value) > 600000
  )
    throw Error("INVALID_CONFIG_KL_PREFLIGHT_TIMEOUT_MS");
  return Number(value);
}
function effectiveBudget(proof, envFile, env = process.env) {
  const parsed = fs.existsSync(envFile)
    ? parseEnv(fs.readFileSync(envFile, "utf8"))
    : {};
  return preflightBudget(proof, { ...parsed, ...env });
}
function bounded(work, ms, code = "PREFLIGHT_CLEANUP_TIMEOUT") {
  let timer;
  return Promise.race([
    Promise.resolve(work),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(code)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
function deadline(ms, external) {
  const controller = new AbortController(),
    pending = new Set();
  require("node:events").setMaxListeners(64, controller.signal);
  const cancel = () => controller.abort(Error("PREFLIGHT_CANCELLED"));
  if (external?.aborted) cancel();
  else external?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(
    () => controller.abort(Error("PREFLIGHT_TIMEOUT")),
    ms,
  );
  async function run(work) {
    const signal = controller.signal;
    signal.throwIfAborted();
    const task = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return work();
    });
    pending.add(task);
    task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    let abort;
    try {
      return await Promise.race([
        task,
        new Promise((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  function dispose() {
    clearTimeout(timer);
    external?.removeEventListener("abort", cancel);
  }
  return { signal: controller.signal, run, dispose, pending };
}
module.exports = { preflightBudget, effectiveBudget, bounded, deadline };
