"use strict";
const http = require("node:http");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const child = spawn(process.execPath, ["test/training-browser-runtime.cjs"], {
  cwd: require("node:path").resolve(__dirname, ".."),
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  env: {
    ...process.env,
    KL_TEST_RECOVERY_FLOW: "true",
    KL_TEST_AI_RECOVERY: "false",
  },
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
let proxy,
  upstream,
  dropped = false;
const writes = [];
child.on("message", async (message) => {
  if (!message.ready) {
    process.send?.(message);
    return;
  }
  upstream = message.base;
  proxy = http.createServer(async (req, res) => {
    if (!req.url.startsWith("/api/")) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const headers = { ...req.headers };
      delete headers.host;
      delete headers.connection;
      delete headers["content-length"];
      const coursework =
        req.method === "POST" &&
        /^\/api\/v1\/training\/tasks\/[0-9a-f]{24}\/coursework$/.test(req.url);
      if (coursework)
        writes.push(
          createHash("sha256")
            .update(String(req.headers["idempotency-key"] || ""))
            .digest("hex"),
        );
      const response = await fetch(upstream + req.url, {
        method: req.method,
        headers,
        body: body.length ? body : undefined,
        redirect: "manual",
      });
      const payload = Buffer.from(await response.arrayBuffer());
      if (coursework && response.status === 200 && !dropped) {
        dropped = true;
        res.destroy();
        process.stdout.write("TEST_PROXY_RESPONSE_DROPPED_AFTER_HTTP_200\n");
        return;
      }
      for (const [key, value] of response.headers)
        if (
          ![
            "set-cookie",
            "transfer-encoding",
            "content-encoding",
            "content-length",
            "connection",
          ].includes(key)
        )
          res.setHeader(key, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader("Set-Cookie", cookies);
      res.writeHead(response.status);
      res.end(payload);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end(
          JSON.stringify({
            error: { code: "TEST_PROXY_FAILURE", message: "隔离代理失败" },
          }),
        );
      } else res.destroy();
    }
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  process.send?.({
    ...message,
    proxyBase: "http://127.0.0.1:" + proxy.address().port,
  });
});
process.on("message", (message) => {
  if (message.command === "proxy-stats")
    process.send?.({
      request_id: message.request_id,
      result: {
        dropped,
        writes: writes.length,
        unique_keys: new Set(writes).size,
      },
    });
  else if (message.stop) {
    proxy?.close();
    proxy?.closeAllConnections();
    child.send({ stop: true });
  } else child.send(message);
});
child.on("close", (code) => {
  proxy?.close();
  proxy?.closeAllConnections();
  process.exitCode = code;
  process.disconnect?.();
});
