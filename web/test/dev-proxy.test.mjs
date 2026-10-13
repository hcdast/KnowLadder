import assert from "node:assert/strict";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer, loadConfigFromFile } from "vite";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));

test("开发代理仅转换本地同源请求，保留 Cookie/CSRF 并拒绝其他来源", async () => {
  const seen = [];
  const upstream = createHttpServer((req, res) => {
    seen.push({ host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie, csrf: req.headers["x-csrf-token"] });
    if (req.method === "POST" && req.headers["x-csrf-token"] !== "fixture-csrf") {
      res.writeHead(403);
    } else {
      res.setHeader("Set-Cookie", "fixture_session=opaque; HttpOnly; SameSite=Lax; Path=/");
    }
    res.end("fixture-response");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const previous = { target: process.env.KL_WEB_API_TARGET, origin: process.env.KL_WEB_API_ORIGIN };
  process.env.KL_WEB_API_TARGET = target;
  process.env.KL_WEB_API_ORIGIN = "https://upstream.example";
  let vite;
  try {
    vite = await createServer({ server: { port: 0 }, logLevel: "silent" });
    await vite.listen();
    const port = vite.httpServer.address().port;
    const local = `http://127.0.0.1:${port}`;
    const request = (headers, method = "GET") => new Promise((resolve, reject) => {
      const req = httpRequest(`${local}/api/probe`, { method, headers, signal: AbortSignal.timeout(5000) }, res => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode, headers: { get: name => res.headers[name]?.toString() } }));
      });
      req.on("error", reject);
      req.end();
    });
    const success = await request({ Origin: local, Cookie: "fixture_session=opaque", "X-CSRF-Token": "fixture-csrf" }, "POST");
    assert.equal(success.status, 200);
    assert.match(success.headers.get("set-cookie"), /HttpOnly; SameSite=Lax; Path=\//);
    assert.deepEqual(seen[0], { host: new URL(target).host, origin: "https://upstream.example", cookie: "fixture_session=opaque", csrf: "fixture-csrf" });
    assert.equal((await request({ Origin: local, Cookie: "fixture_session=opaque" }, "POST")).status, 403);
    const forwarded = seen.length;
    for (const headers of [
      { Origin: "https://other.example" },
      { Origin: "https://upstream.example" },
      { Origin: `http://localhost:${port}` },
      { Origin: local, "Sec-Fetch-Site": "cross-site" },
      { Host: "other.example" },
    ]) {
      assert.equal((await request(headers)).status, 403, JSON.stringify(headers));
    }
    assert.equal(seen.length, forwarded, "拒绝的请求不应触达上游");
    assert.equal((await request({})).status, 200);
    assert.equal(seen.at(-1).origin, undefined, "无 Origin 的读取不自动补造 Origin");
    // Exercise localhost with its own matching Host, without changing the TCP destination.
    assert.equal((await request({ Host: `localhost:${port}`, Origin: `http://localhost:${port}` })).status, 200);
    assert.equal(seen.at(-1).origin, "https://upstream.example");
    for (const env of [
      { command: "build", mode: "development" },
      { command: "serve", mode: "development", isPreview: true },
      { command: "serve", mode: "test" },
    ]) {
      const config = (await loadConfigFromFile(env)).config;
      assert.equal(config.server.proxy["/api"].configure, undefined);
      assert.equal(config.plugins.some(plugin => plugin.name === "local-api-origin-guard"), false);
    }
    process.env.KL_WEB_API_ORIGIN = "https://upstream.example/path";
    await assert.rejects(() => createServer({ logLevel: "silent" }), /KL_WEB_API_ORIGIN/);
    // An empty explicit opt-in disables translation even if the ignored file enables it.
    process.env.KL_WEB_API_ORIGIN = "";
    assert.equal((await loadConfigFromFile({ command: "serve", mode: "development" })).config.server.proxy["/api"].configure, undefined);
  } finally {
    if (vite) await vite.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    for (const [key, value] of [["KL_WEB_API_TARGET", previous.target], ["KL_WEB_API_ORIGIN", previous.origin]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
