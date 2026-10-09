"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { administrationFixture, consoleRequest } = require("./administration-helpers.cjs");
const { PASSWORD, status } = require("./helpers.cjs");

for (const topology of ["replicaSet", "standalone"]) {
  test(`成员恢复 ${topology}：丢成功响应后原操作重放及陈旧CAS拒绝`, { timeout: 120000, concurrency: false }, async t => {
    const f = await administrationFixture(t, topology);
    const before = await f.db.collection("organization_members").findOne({ _id: f.studentA.memberId });
    const path = `/members/${f.studentA.memberId}`;
    const key = randomUUID();
    const body = { roles: ["student"], status: "disabled", expected_revision: before.authorization_revision,
      reason: "原创合成丢响应原操作验收", current_password: PASSWORD };
    const countBefore = await f.db.collection("administration_operations").countDocuments({});
    let discarded = false, firstOperation;
    const observed = [];
    const proxy = http.createServer((req, res) => {
      const upstream = http.request(f.browser.base + req.url, { method: req.method, headers: req.headers }, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => {
          const bytes = Buffer.concat(chunks);
          if (req.method === "PUT") {
            const operation = JSON.parse(bytes.toString()).data?.operation_id;
            observed.push({ status: response.statusCode, sameKey: req.headers["idempotency-key"] === key, operation });
            if (!discarded && response.statusCode === 200) {
              discarded = true; firstOperation = operation; res.destroy(); return;
            }
          }
          res.writeHead(response.statusCode, response.headers); res.end(bytes);
        });
      });
      upstream.on("error", () => res.destroy());
      req.pipe(upstream);
    });
    t.after(() => new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); }));
    await new Promise((resolve, reject) => {
      proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve);
    });
    const actor = { ...f.accounts, browser: f.accounts.browser.clone(`http://127.0.0.1:${proxy.address().port}`) };
    // Native HTTP has no transport replay; fetch may transparently retry a PUT.
    await assert.rejects(new Promise((resolve, reject) => {
      const request = http.request(`${actor.browser.base}/api/v1/console${path}`, { method: "PUT", headers: {
        Origin: "http://127.0.0.1:5174", "X-Org-Id": actor.org,
        "Idempotency-Key": key, "X-CSRF-Token": actor.browser.csrf,
        "Content-Type": "application/json",
        Cookie: [...actor.browser.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      } }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      request.on("error", reject); request.end(JSON.stringify(body));
    }), cause => cause.code === "ECONNRESET");
    assert.equal(discarded, true);
    assert.equal(typeof firstOperation, "string");
    const replay = await consoleRequest(actor, path, { method: "PUT", key, body });
    status(replay, 200);
    assert.equal(replay.data.data.operation_id, firstOperation);
    assert.equal(replay.data.data.status, "applied");
    assert.equal(observed.length, 2);
    assert.ok(observed.every(row => row.sameKey && row.operation === firstOperation));
    assert.equal(await f.db.collection("administration_operations").countDocuments({}), countBefore + 1);
    const applied = await f.db.collection("organization_members").findOne({ _id: f.studentA.memberId });
    assert.equal(applied.status, "disabled");
    assert.equal(applied.authorization_revision, before.authorization_revision + 1);
    assert.equal((await f.db.collection("users").findOne({ _id: f.studentA.user.user_id })).status, "active");
    const stale = await consoleRequest(f.accounts, path, { method: "PUT", body: { ...body, status: "active", reason: "陈旧版本不得覆盖" } });
    status(stale, 409);
    assert.equal(stale.data.error.code, "REVISION_CONFLICT");
    const unchanged = await f.db.collection("organization_members").findOne({ _id: f.studentA.memberId });
    assert.equal(unchanged.status, "disabled");
    assert.equal(unchanged.authorization_revision, applied.authorization_revision);
    const again = await consoleRequest(actor, path, { method: "PUT", key, body });
    status(again, 200);
    assert.equal(again.data.data.operation_id, firstOperation);
  });
}
