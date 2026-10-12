"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { resolvePm2Entry } = require("../../ops/pm2-backend.cjs");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kl_pm2_locator_"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "server"));
  function pkg(base, name = "pm2") {
    fs.mkdirSync(path.join(base, "bin"), { recursive: true });
    fs.writeFileSync(path.join(base, "package.json"), JSON.stringify({ name }));
    const file = path.join(base, "bin", "pm2");
    fs.writeFileSync(file, "#!/usr/bin/env node\n// fixture; never executed\n");
    return fs.realpathSync(file);
  }
  return {
    root,
    pkg,
    options: {
      projectRoot: root,
      env: {},
      platform: "linux",
      execPath: path.join(root, "missing/node"),
      locate: () => ({ stdout: "" }),
      resolve: () => {
        throw Error("not installed");
      },
    },
  };
}
test("Linux PATH symlink resolves the global package entry", (t) => {
  const f = fixture(t),
    target = f.pkg(path.join(f.root, "prefix/lib/node_modules/pm2"));
  const bin = path.join(f.root, "prefix/bin");
  fs.mkdirSync(bin);
  const link = path.join(bin, "pm2");
  fs.symlinkSync(target, link, "file");
  assert.equal(
    resolvePm2Entry({
      ...f.options,
      locate: (command, args) => {
        assert.equal(command, "which");
        assert.deepEqual(args, ["pm2"]);
        return { stdout: link + "\n" };
      },
    }),
    target,
  );
});
test("Linux global lib layout works with a shell shim", (t) => {
  const f = fixture(t),
    target = f.pkg(path.join(f.root, "prefix/lib/node_modules/pm2"));
  const shim = path.join(f.root, "prefix/bin/pm2");
  fs.mkdirSync(path.dirname(shim));
  fs.writeFileSync(shim, "#!/bin/sh\nexit 99\n");
  assert.equal(
    resolvePm2Entry({ ...f.options, locate: () => ({ stdout: shim + "\n" }) }),
    target,
  );
});
test("Windows cmd shim selects its neighbouring package JS", (t) => {
  const f = fixture(t),
    target = f.pkg(path.join(f.root, "global/node_modules/pm2"));
  const shim = path.join(f.root, "global/pm2.cmd");
  fs.writeFileSync(shim, "@echo off");
  assert.equal(
    resolvePm2Entry({
      ...f.options,
      platform: "win32",
      locate: (command, args) => {
        assert.equal(command, "where.exe");
        assert.deepEqual(args, ["pm2.cmd"]);
        return { stdout: shim + "\r\n" };
      },
    }),
    target,
  );
});
test("env file works before discovery; shell configuration has priority", (t) => {
  const f = fixture(t),
    first = f.pkg(path.join(f.root, "first")),
    second = f.pkg(path.join(f.root, "second"));
  fs.writeFileSync(
    path.join(f.root, "server/.env"),
    'KL_PM2_BIN="' + first.replaceAll("\\", "/") + '"\n',
  );
  const locate = () => {
    throw Error("discovery must not run");
  };
  assert.equal(resolvePm2Entry({ ...f.options, locate }), first);
  assert.equal(
    resolvePm2Entry({ ...f.options, locate, env: { KL_PM2_BIN: second } }),
    second,
  );
});
test("relative configured paths are resolved from repository root, not caller cwd", (t) => {
  const f = fixture(t),
    target = f.pkg(path.join(f.root, "custom"));
  assert.equal(
    resolvePm2Entry({ ...f.options, env: { KL_PM2_BIN: "custom/bin/pm2" } }),
    target,
  );
});
test("invalid explicit entry refuses fallback and does not echo private paths", (t) => {
  const f = fixture(t);
  for (const name of [
    "secret-missing",
    "private.cmd",
    "private.bat",
    "private.exe",
    "directory",
  ]) {
    const file = path.join(f.root, name);
    if (name === "directory") fs.mkdirSync(file);
    else if (name !== "secret-missing") fs.writeFileSync(file, "fixture");
    assert.throws(
      () =>
        resolvePm2Entry({
          ...f.options,
          env: { KL_PM2_BIN: file },
          locate: () => {
            throw Error("fallback must not run");
          },
        }),
      (e) =>
        e.safeCode === "PM2_JAVASCRIPT_ENTRY_REQUIRED" &&
        e.message === e.safeCode,
    );
  }
});
test("local server package resolves without a usable which command", (t) => {
  const f = fixture(t),
    target = f.pkg(path.join(f.root, "server/node_modules/pm2"));
  const seen = [];
  assert.equal(
    resolvePm2Entry({
      ...f.options,
      locate: () => ({ error: Error("ENOENT") }),
      resolve: (name, options) => {
        assert.equal(name, "pm2/bin/pm2");
        seen.push(options.paths[0]);
        if (options.paths[0] !== path.join(f.root, "server"))
          throw Error("missing");
        return target;
      },
    }),
    target,
  );
  assert.deepEqual(seen, [f.root, path.join(f.root, "server")]);
});
test("active Node prefix finds nvm-style global PM2 without PATH discovery", (t) => {
  const f = fixture(t),
    target = f.pkg(path.join(f.root, "node-version/lib/node_modules/pm2"));
  assert.equal(
    resolvePm2Entry({
      ...f.options,
      execPath: path.join(f.root, "node-version/bin/node"),
    }),
    target,
  );
});
test("broken PATH links and unrelated packages cannot become PM2", (t) => {
  const f = fixture(t),
    wrong = f.pkg(path.join(f.root, "unrelated"), "another-package");
  const link = path.join(f.root, "broken-pm2");
  fs.symlinkSync(path.join(f.root, "missing"), link, "file");
  assert.throws(
    () =>
      resolvePm2Entry({
        ...f.options,
        locate: () => ({ stdout: link + "\n" + wrong }),
      }),
    (e) => e.safeCode === "PM2_NOT_FOUND" && e.message === e.safeCode,
  );
});
