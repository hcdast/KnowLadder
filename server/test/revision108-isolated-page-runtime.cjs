"use strict";
const cachePath=require("node:path");
const cacheOs=require("node:os");
const scanRoot=cachePath.join(cacheOs.homedir(),".cache/knowladder-clamav-104");
process.env.TEST_CLAMSCAN_PATH=cachePath.join(scanRoot,"engine/clamav-1.5.4.win.x64/clamscan.exe");
process.env.TEST_CLAMAV_DATABASE=cachePath.join(scanRoot,"database");
process.env.CVD_CERTS_DIR=cachePath.join(scanRoot,"engine/clamav-1.5.4.win.x64/certs");
process.env.SCAN_DATABASE_MAX_AGE_HOURS="168";

process.env.TEST_FILE_STORAGE_PARENT=require("node:os").homedir();
process.env.PSModulePath=require("node:path").join(process.env.SystemRoot,"System32/WindowsPowerShell/v1.0/Modules");
"use strict";
const { fork } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomBytes } = require("node:crypto");
(async () => {
  let api, vite, stopFixture;
  const nonce = randomBytes(24).toString("hex");
  let drop = false,
    dropped = 0,
    writeCount = 0,
    lastKey = null;
  try {
    api = fork(
      path.join(__dirname, "revision108-isolated-page-api.cjs"),
      [],
      {
        env: {
          ...process.env,
          KL_TEST_PHASE2: "true",
          KL_TEST_RECOVERY_FLOW: "true",
        },
        silent: true,
      },
    );
    api.stderr.on("data", d => process.stderr.write(d));
    api.stdout.on("data", () => {});
    const ready = await new Promise((resolve, reject) => {
      api.on("message", (m) => {
        if (m.ready) resolve(m);
      });
      api.once("exit", () => reject(Error("API_FIXTURE_EXIT")));
    });
    const { createServer } = await import(
      pathToFileURL(
        path.resolve(
          __dirname,
          "../../web/node_modules/vite/dist/node/index.js",
        ),
      ).href
    );
    const vue = (
      await import(
        pathToFileURL(
          path.resolve(
            __dirname,
            "../../web/node_modules/@vitejs/plugin-vue/dist/index.mjs",
          ),
        ).href
      )
    ).default;
    const plugin = {
      name: "isolated-recovery-proxy",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = req.url.split("?")[0];
          if (["/__test/revoke","/__test/stop"].includes(url) && req.url.includes(nonce)) {
 if(url==="/__test/stop"){res.end("stopping");stopFixture?.();return;}
 const request_id=randomBytes(12).toString("hex");const listener=m=>{if(m.request_id!==request_id)return;api.off("message",listener);res.setHeader("Content-Type","application/json");res.end(JSON.stringify(m.result||{error:m.error}));};api.on("message",listener);api.send({command:"revoke",request_id});return;
 }
 if (url === "/__test/bootstrap" && req.url.includes(nonce)) {
            try {
              const origin = "http://127.0.0.2:5192";
              const csrf = await fetch(ready.base + "/api/v1/auth/csrf", {
                headers: { Origin: origin },
              });
              const body = await csrf.json();
              const cookie = csrf.headers
                .getSetCookie()
                .map((x) => x.split(";")[0])
                .join("; ");
              const login = await fetch(ready.base + "/api/v1/auth/login", {
                method: "POST",
                headers: {
                  Origin: origin,
                  Cookie: cookie,
                  "X-CSRF-Token": body.data.csrf_token,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  login_name: ready.teacher.login,
                  password: ready.teacher.password,
                }),
              });
              if (login.status !== 200) throw Error("LOGIN_FAILED");
              res.setHeader("Set-Cookie", login.headers.getSetCookie());
              res.statusCode = 302;
              res.setHeader("Location", "/training");
              res.end();
            } catch {
              res.statusCode = 500;
              res.end("TEST_BOOTSTRAP_FAILED");
            }
            return;
          }
          if (!url.startsWith("/api/")) return next();
          const targeted =
            req.method === "POST" &&
            url === (process.env.KL_TEST_CERTIFICATE_RECOVERY === "true" ? "/api/v1/training/phase2/certificates" : "/api/v1/training/phase2/locations");
          if (targeted) {
            writeCount++;
            lastKey = req.headers["idempotency-key"];
          }
          const shouldDrop = targeted && drop;
          if (shouldDrop) drop = false;
          const upstream = http.request(
            ready.base + req.url,
            { method: req.method, headers: req.headers },
            (response) => {
              const chunks = [];
              response.on("data", (d) => chunks.push(d));
              response.on("end", () => {
                if (shouldDrop && response.statusCode === 200) {
                  dropped++;
                  res.destroy();
                  return;
                }
                res.writeHead(response.statusCode, response.headers);
                res.end(Buffer.concat(chunks));
              });
            },
          );
          upstream.on("error", () => {
            if (!res.destroyed) {
              res.statusCode = 502;
              res.end();
            }
          });
          req.pipe(upstream);
        });
      },
    };
    vite = await createServer({
      configFile: false,
      root: path.resolve(__dirname, "../../web"),
      plugins: [vue(), plugin],
      server: { host: "127.0.0.2", port: 5192, strictPort: true },
    });
    await vite.listen();
    console.log(
      JSON.stringify({
        ready: true,
        bootstrap: "http://127.0.0.2:5192/__test/bootstrap?nonce=" + nonce,
      }),
    );
    process.send?.({ready:true,bootstrap:"http://127.0.0.2:5192/__test/bootstrap?nonce="+nonce});
    await new Promise((resolve) => {
      stopFixture=resolve;
      process.once("SIGINT",resolve);
      process.on("message", (m) => {
        if (m.stop) return resolve();
        if (["revoke","inspect-media"].includes(m.command)) {
          api.send({...m,command:m.command==="inspect-media"?"inspect":"revoke"});
        } else if (m.command === "arm") {
          drop = true;
          process.send?.({ request_id: m.request_id, result: { armed: true } });
        } else if (m.command === "inspect") {
          api.send({ command: "phase2-inspect", request_id: m.request_id });
        } else if (m.command === "transport") {
          process.send?.({
            request_id: m.request_id,
            result: { dropped, writeCount, lastKey },
          });
        }
      });
      api.on("message", (m) => {
        if (m.request_id) process.send?.(m);
      });
      process.once("SIGTERM", resolve);
      process.once("disconnect", resolve);
    });
  } catch (e) {
    console.error(e.name + ":" + e.message);
    process.exitCode = 1;
  } finally {
    await vite?.close();
    if (api && api.exitCode === null) {
      const end = new Promise((r) => api.once("exit", r));
      api.send({ stop: true });
      await end;
    }
    if (process.connected) process.disconnect();
  }
})();
