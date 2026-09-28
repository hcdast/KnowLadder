"use strict";
const { guardedUri } = require("./helpers.cjs");
const { listenTestHttp } = require("./http-listen.cjs");

// A real, independently restartable API process; IPC carries only its loopback URL.
(async () => {
  guardedUri(process.env.MONGODB_URI);
  if (!process.send) throw new Error("API helper requires IPC");
  const { createApp } = require("../dist/app.js");
  const app = await createApp();
  const base = await listenTestHttp(app);
  process.on("message", async message => {
    if (message !== "stop") return;
    await app.close();
    process.disconnect();
  });
  process.on("disconnect", () => { void app.close().finally(() => process.exit()); });
  process.send({ type: "ready", base });
})().catch(() => {
  // Do not leak database URIs or authentication material through child errors.
  if (process.connected) process.send({ type: "failed" });
  process.exit(1);
});
