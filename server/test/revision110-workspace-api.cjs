"use strict";
const { MongoMemoryReplSet } = require("mongodb-memory-server-core");
const { assessmentFixture } = require("./assessment-helpers.cjs");
const { administrativeGrant } = require("./administration-helpers.cjs");
const { Browser, PASSWORD } = require("./helpers.cjs");
(async () => {
  const cleanup = [];
  let rs;
  try {
    rs = await MongoMemoryReplSet.create({ binary: { version: "8.0.17" }, replSet: { count: 1, storageEngine: "wiredTiger" }, instanceOpts: [{ args: ["--wiredTigerCacheSizeGB", "0.25"] }] });
    process.env.TEST_MONGODB_URI = rs.getUri("kl_test_workspace_110");
    const origin = "http://127.0.0.1:5198";
    const original = Browser.prototype.request;
    Browser.prototype.request = function (path, options = {}) { return original.call(this, path, { ...options, origin }); };
    const f = await assessmentFixture({ after: cb => cleanup.push(cb) }, { env: { APP_ORIGIN: origin, FILE_SCAN_ENABLED: "false" } });
    const admin = await f.actor(["org_admin"]);
    await administrativeGrant(f, admin, "account:manage");
    const actors = Object.fromEntries(Object.entries({ editor: f.editor, student: f.student, admin }).map(([role, actor]) => [role, { login: actor.user.login_name, password: PASSWORD }]));
    process.send?.({ ready: true, base: f.browser.base, actors });
    await new Promise(resolve => {
      process.on("message", message => { if (message.stop) resolve(); });
      process.once("disconnect", resolve);
      process.once("SIGTERM", resolve);
    });
  } catch (error) { console.error(error.code || error.name, error.message?.slice(0, 100)); process.exitCode = 1; }
  finally {
    for (const cb of cleanup.reverse()) await cb();
    await rs?.stop();
    if (process.connected) process.disconnect();
  }
})();
