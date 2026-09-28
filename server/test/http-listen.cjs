"use strict";
const { randomInt } = require("node:crypto");

async function listenTestHttp(app) {
  await app.init();
  const server = app.getHttpServer();
  // Dynamic/private ports avoid Fetch's forbidden ports without OS configuration.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = randomInt(49152, 65536);
    try {
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          server.removeListener("error", onError);
          server.removeListener("listening", onListening);
        };
        const onError = (error) => {
          cleanup();
          reject(error);
        };
        const onListening = () => {
          cleanup();
          resolve();
        };
        // Nest's listen callback survives a failed bind. Own these listeners so
        // repeated collisions cannot accumulate stale callbacks or close the app.
        server.once("error", onError);
        server.once("listening", onListening);
        try {
          server.listen(port, "127.0.0.1");
        } catch (error) {
          onError(error);
        }
      });
    } catch (error) {
      if (error.code === "EADDRINUSE" && attempt < 19) continue;
      throw error;
    }
    return `http://127.0.0.1:${server.address().port}`;
  }
}

module.exports = { listenTestHttp };
