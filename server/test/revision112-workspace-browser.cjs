"use strict";
// Local browser validation only; child fixture owns database and service cleanup.
const { fork } = require("node:child_process");
const path = require("node:path");
const child = fork(path.join(__dirname, "revision112-workspace-proxy.cjs"), [], {
  env: { ...process.env, PSModulePath: `${process.env.SystemRoot}/System32/WindowsPowerShell/v1.0/Modules` },
  silent: true,
});
child.on("message", (message) => {
  if (message.ready) console.log(JSON.stringify({ bootstrap: message.bootstrap }));
});
child.stderr.on("data", (data) => process.stderr.write(data));
process.stdin.on("data", () => child.connected && child.send({ stop: true }));
child.on("exit", (code) => process.exit(code || 0));
