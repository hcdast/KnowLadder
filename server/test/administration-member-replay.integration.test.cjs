"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { administrationFixture, consoleRequest, PASSWORD, status } = require("./administration-helpers.cjs");

// Transport fault only: the real API finishes its write before its response is lost.
// Neither proxy observations nor assertions expose cookies, passwords or keys.
async function responseLossProxy(t, base, targetPath) {
  let armed = true;
  const observed = [];
  const server = http.createServer((req, res) => {
    const outgoing = http.request(base + req.url, { method: req.method, headers: req.headers }, upstream => {
      const chunks = [];
      upstream.on("data", chunk => chunks.push(chunk));
      upstream.on("end", () => {
        const bytes = Buffer.concat(chunks);
        if (req.method === "PUT" && req.url === `/api/v1/console${targetPath}`) {
          const body = JSON.parse(bytes.toString());
          const drop = armed && upstream.statusCode === 200;
          if (drop) armed = false;
          observed.push({ status: upstream.statusCode, dropped: drop, key: req.headers["idempotency-key"], operationId: body.data?.operation_id });
          if (drop) { res.destroy(); return; }
        }
        res.writeHead(upstream.statusCode, upstream.headers);
        res.end(bytes);
      });
      upstream.on("error", () => res.destroy());
    });
    outgoing.on("error", () => { res.statusCode = 502; res.end(); });
    req.pipe(outgoing);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { base: `http://127.0.0.1:${server.address().port}`, observed };
}

// Native HTTP makes precisely one attempt; browser/Fetch retry behavior is not assumed.
function oneAttempt(actor, path, key, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${actor.browser.base}/api/v1/console${path}`, {
      method: "PUT", headers: {
        Origin: "http://127.0.0.1:5174", "X-Org-Id": actor.org,
        "Idempotency-Key": key, "X-CSRF-Token": actor.browser.csrf,
        "Content-Type": "application/json",
        Cookie: [...actor.browser.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      },
    }, res => { res.resume(); res.on("end", resolve); });
    req.setTimeout(15000, () => req.destroy(new Error("TEST_TRANSPORT_TIMEOUT")));
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

for (const topology of ["replicaSet", "standalone"]) {
  test(`IAM ${topology}：成员丢响应原回执、幂等重放与失效版本`, { timeout: 240000, concurrency: false }, async t => {
    const f = await administrationFixture(t, topology);
    const path = `/members/${f.studentA.memberId}`;
    const proxy = await responseLossProxy(t, f.browser.base, path);
    const actor = { ...f.accounts, browser: f.accounts.browser.clone(proxy.base) };
    const member = () => f.db.collection("organization_members").findOne({ _id: f.studentA.memberId });
    const operationFilter = { action: "member.update", "targets.member_ids": f.studentA.memberId };
    const before = await member();
    const baseline = await f.db.collection("administration_operations").countDocuments(operationFilter);
    const key = randomUUID();
    const body = { roles: ["student"], status: "disabled", expected_revision: before.authorization_revision,
      reason: "原创合成成员丢响应与原编号验收", current_password: PASSWORD };
    let original, afterWrite, auditCount;

    await t.test("成功响应确实丢失；原编号查询只读返回已生效", async () => {
      await assert.rejects(oneAttempt(actor, path, key, body), error => error.code === "ECONNRESET");
      assert.equal(proxy.observed.length, 1);
      assert.equal(proxy.observed[0].dropped, true);
      assert.equal(proxy.observed[0].status, 200);
      original = proxy.observed[0].operationId;
      assert.match(original, /^[a-f0-9]{24}$/);
      afterWrite = await member();
      assert.equal(afterWrite.status, "disabled");
      assert.equal((await f.db.collection("users").findOne({ _id: f.studentA.user.user_id })).status, "active");
      assert.equal(await f.db.collection("administration_operations").countDocuments(operationFilter), baseline + 1);
      auditCount = await f.db.collection("audit_events").countDocuments({ operation_id: original });
      assert.ok(auditCount > 0);
      const queried = await consoleRequest(actor, `/operations?${new URLSearchParams({ key })}`);
      status(queried, 200);
      assert.equal(queried.data.data.items.length, 1);
      assert.equal(queried.data.data.items[0].operation_id, original);
      assert.equal(queried.data.data.items[0].status, "applied");
      assert.deepEqual(await member(), afterWrite);
    });

    await t.test("原key重放同一回执，不重复操作、审计或成员变更", async () => {
      const replay = await consoleRequest(actor, path, { method: "PUT", key, body });
      status(replay, 200);
      assert.equal(replay.data.data.operation_id, original);
      assert.equal(replay.data.data.status, "applied");
      assert.equal(proxy.observed.length, 2);
      assert.equal(proxy.observed[1].key === proxy.observed[0].key, true);
      assert.equal(proxy.observed[1].operationId, original);
      assert.deepEqual(await member(), afterWrite);
      assert.equal(await f.db.collection("administration_operations").countDocuments(operationFilter), baseline + 1);
      assert.equal(await f.db.collection("audit_events").countDocuments({ operation_id: original }), auditCount);
    });

    await t.test("同key改正文拒绝；新key旧版本冲突且不覆盖", async () => {
      const changed = await consoleRequest(actor, path, { method: "PUT", key, body: { ...body, status: "active" } });
      status(changed, 409);
      assert.equal(changed.data.error.code, "IDEMPOTENCY_CONFLICT");
      const stale = await consoleRequest(actor, path, { method: "PUT", body: { ...body, status: "active" } });
      status(stale, 409);
      assert.equal(stale.data.error.code, "REVISION_CONFLICT");
      assert.deepEqual(await member(), afterWrite);
      assert.equal(await f.db.collection("administration_operations").countDocuments(operationFilter), baseline + 1);
      assert.equal(await f.db.collection("audit_events").countDocuments({ operation_id: original }), auditCount);
    });

    await t.test("重读当前版本后新操作可生效，保留原操作", async () => {
      const current = await member();
      const next = await consoleRequest(actor, path, { method: "PUT", body: { ...body, status: "active",
        expected_revision: current.authorization_revision, reason: "原创合成成员重新核对当前版本后启用" } });
      status(next, 200);
      assert.equal(next.data.data.status, "applied");
      assert.notEqual(next.data.data.operation_id, original);
      assert.equal((await member()).status, "active");
      assert.equal(await f.db.collection("administration_operations").countDocuments(operationFilter), baseline + 2);
      assert.equal((await f.db.collection("administration_operations").findOne({ _id: original })).status, "applied");
    });
  });
}
