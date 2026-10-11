"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  cp = require("node:child_process");
test(
  "official ClamAV complete load and cancelled child is actually closed",
  { timeout: 120000 },
  async (t) => {
    assert.ok(
      process.env.TEST_CLAMSCAN_PATH && process.env.TEST_CLAMAV_DATABASE,
      "real ClamAV required",
    );
    const before = { ...process.env };
    t.after(() => {
      for (const k of Object.keys(process.env))
        if (!(k in before)) delete process.env[k];
      Object.assign(process.env, before);
    });
    Object.assign(process.env, {
      FILE_STORAGE_DRIVER: "local",
      FILE_STORAGE_ROOT: require("node:os").homedir(),
      FILE_SCAN_ENABLED: "true",
      CLAMSCAN_PATH: process.env.TEST_CLAMSCAN_PATH,
      CLAMAV_DATABASE: process.env.TEST_CLAMAV_DATABASE,
      SCAN_DATABASE_MAX_AGE_HOURS: "48",
      SCAN_TIMEOUT_MS: "60000",
    });
    const original = cp.spawn,
      children = [];
    cp.spawn = (...args) => {
      const child = original(...args),
        row = { child, closed: false };
      children.push(row);
      child.once("close", () => (row.closed = true));
      return child;
    };
    const file = require.resolve("../dist/files/scanner");
    delete require.cache[file];
    const { assertScanner } = require(file);
    t.after(() => {
      cp.spawn = original;
      delete require.cache[file];
    });
    const stages = [];
    await assertScanner({
      run: async (stage, work) => {
        stages.push(stage);
        return work();
      },
    });
    assert.deepEqual(stages, [
      "scanner.version",
      "scanner.load",
      "scanner.recheck",
    ]);
    assert.ok(children.every((r) => r.closed));
    const controller = new AbortController();
    let timer;
    await assert.rejects(
      assertScanner({
        signal: controller.signal,
        run: async (stage, work) => {
          if (stage === "scanner.load")
            timer = setTimeout(
              () => controller.abort(Error("synthetic cancel")),
              50,
            );
          return work();
        },
      }),
      /synthetic cancel/,
    );
    clearTimeout(timer);
    assert.ok(children.length >= 5);
    assert.ok(children.every((r) => r.closed));
  },
);
