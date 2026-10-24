// Disposable loopback validation; never reads the actual environment or database.
const { fork } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const root = path.resolve(__dirname, "../..");
const artifact = (name) => path.join(root, "ops/artifacts", name);
(async () => {
  let api, vite;
  const counts = {},
    responses = [];
  let loggedOut = false;
  try {
    fs.mkdirSync(path.dirname(artifact("site-refresh-control.json")), {
      recursive: true,
    });
    fs.writeFileSync(artifact("site-refresh-control.json"), "{}");
    api = fork(
      path.join(root, "server/test/training-browser-runtime.cjs"),
      [],
      { silent: true },
    );
    api.stdout.on("data", () => {});
    api.stderr.on("data", () => {});
    const ready = await new Promise((resolve, reject) => {
      api.on("message", (m) => {
        if (m.ready) resolve(m);
      });
      api.once("exit", (code) =>
        reject(Error("ISOLATED_FIXTURE_EXIT_" + code)),
      );
    });
    fs.writeFileSync(
      artifact("site-refresh-private.json"),
      JSON.stringify(ready),
    );
    const { createServer } = await import(
      pathToFileURL(path.join(root, "web/node_modules/vite/dist/node/index.js"))
    );
    const vue = (
      await import(
        pathToFileURL(
          path.join(root, "web/node_modules/@vitejs/plugin-vue/dist/index.mjs"),
        )
      )
    ).default;
    vite = await createServer({
      configFile: false,
      root: path.join(root, "web"),
      plugins: [
        vue(),
        {
          name: "isolated-real-api",
          configureServer(server) {
            server.middlewares.use((req, res, next) => {
              const url = req.url.split("?")[0];
              let control = {};
              try {
                control = JSON.parse(
                  fs.readFileSync(artifact("site-refresh-control.json")),
                );
              } catch {}
              if (
                (control.mediaFailure && url === "/visuals/product-tour.mp4") ||
                (control.posterFailure &&
                  url === "/visuals/product-tour-poster.webp")
              ) {
                res.statusCode = control.mediaFailure === "html" ? 200 : 404;
                res.setHeader("Content-Type", "text/html");
                res.end(
                  "<!doctype html><title>Disposable media failure</title>",
                );
                return;
              }
              if (!url.startsWith("/api/")) return next();
              const key = req.method + " " + url;
              counts[key] = (counts[key] || 0) + 1;
              const record = (status) => {
                responses.push({ key, status });
                fs.writeFileSync(
                  artifact("site-refresh-transport.json"),
                  JSON.stringify({ counts, responses }),
                );
              };
              if (
                (control.csrfFailure ||
                  (control.csrfAfterLogout && loggedOut)) &&
                url === "/api/v1/auth/csrf"
              ) {
                record(503);
                res.statusCode = 503;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: { message: "测试连接故障" } }));
                return;
              }
              const forward = () => {
                const headers = {
                  ...req.headers,
                  host: new URL(ready.base).host,
                };
                const target = http.request(
                  new URL(req.url, ready.base),
                  { method: req.method, headers },
                  (upstream) => {
                    if (
                      url === "/api/v1/auth/logout" &&
                      upstream.statusCode === 204
                    )
                      loggedOut = true;
                    if (
                      url === "/api/v1/auth/login" &&
                      upstream.statusCode === 200
                    )
                      loggedOut = false;
                    record(upstream.statusCode);
                    if (control.loseLogout && url === "/api/v1/auth/logout") {
                      upstream.resume();
                      res.destroy();
                      return;
                    }
                    res.writeHead(upstream.statusCode, upstream.headers);
                    upstream.pipe(res);
                  },
                );
                target.on("error", () => {
                  record(502);
                  if (!res.headersSent) res.writeHead(502);
                  res.end();
                });
                req.pipe(target);
              };
              if (control.delayCsrf && url === "/api/v1/auth/csrf")
                setTimeout(forward, control.delayCsrf);
              else if (control.delayLogin && url === "/api/v1/auth/login")
                setTimeout(forward, control.delayLogin);
              else forward();
            });
          },
        },
      ],
      server: { host: "127.0.0.1", port: 5184, strictPort: true },
      clearScreen: false,
    });
    await vite.listen();
    console.log("ISOLATED_SITE_READY http://127.0.0.1:5184");
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        try {
          if (
            JSON.parse(fs.readFileSync(artifact("site-refresh-control.json")))
              .stop === true
          )
            finish();
        } catch {
          /* Only this disposable runtime's local control file is observed. */
        }
      }, 250);
      function finish() {
        clearInterval(timer);
        resolve();
      }
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
      process.on("message", (m) => {
        if (m.stop) finish();
      });
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await vite?.close();
    if (api?.exitCode === null) {
      const stopped = new Promise((resolve) => api.once("exit", resolve));
      api.send({ stop: true });
      await stopped;
    }
    fs.rmSync(artifact("site-refresh-private.json"), { force: true });
  }
})();
