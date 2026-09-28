"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { fixture, Browser, status, PASSWORD, ORIGIN } = require("./helpers.cjs");
const options = { concurrency: false, timeout: 120000 };
const path = "/privacy/deletion-requests";
const input = (changes = {}) => ({ scope: "account", policy_revision: "local_privacy_v1", current_password: PASSWORD, ...changes });
const submit = (browser, key = randomUUID(), body = input(), extra = {}) => browser.request(path, { method: "POST", body, headers: { "Idempotency-Key": key }, ...extra });
const safeFields = ["id", "scope", "policy_revision", "status", "revision", "created_at", "updated_at", "deleted_categories", "retained_categories", "retention_basis", "remaining_actions"].sort();

test("隐私真实HTTP：无组织本人申请、持久幂等、最小安全视图及冻结后拒绝", options, async t => {
  const f = await fixture(t);
  const user = await f.authenticated();
  assert.equal(await f.db.collection("organization_members").countDocuments({ user_id: user.user_id }), 0);
  const key = randomUUID();
  const first = await submit(f.browser, key); status(first, 202);
  assert.equal(first.data.data.status, "requested");
  assert.deepEqual(Object.keys(first.data.data).sort(), safeFields);
  assert.match(first.headers.get("cache-control"), /no-store/);
  const replay = await submit(f.browser, key, input({ current_password: "not-the-password" })); status(replay, 202);
  assert.deepEqual(replay.data.data, first.data.data, "已登记重放不再次验证密码，但仍验证当前身份");
  status(await submit(f.browser), 409);
  const rows = await f.db.collection("privacy_deletion_requests").find({ user_id: user.user_id }).toArray();
  const receipts = await f.db.collection("privacy_operation_receipts").find({ user_id: user.user_id }).toArray();
  assert.equal(rows.length, 1); assert.equal(receipts.length, 1);
  assert.deepEqual(Object.keys(receipts[0]).sort(), ["_id", "user_id", "key_hash", "request_hash", "request_id", "created_at"].sort());
  assert.equal(JSON.stringify([...rows, ...receipts]).includes(PASSWORD), false);
  const { canonical } = require("../dist/content/dto.js");
  assert.equal(receipts[0].request_hash, createHash("sha256").update(canonical({ scope: "account", policy_revision: "local_privacy_v1" })).digest("hex"));
  const list = await f.browser.request(path); status(list, 200);
  assert.deepEqual(list.data.data, { items: [first.data.data], next_cursor: null });
  const detail = await f.browser.request(`${path}/${first.data.data.id}`); status(detail, 200); assert.deepEqual(detail.data.data, first.data.data);
  const stranger = new Browser(f.browser.base); await f.authenticated(stranger);
  status(await stranger.request(`${path}/${first.data.data.id}`), 404);
  assert.deepEqual((await stranger.request(path)).data.data.items, []);
  await f.db.collection("users").updateOne({ _id: user.user_id }, { $set: { privacy_state: "erasing" }, $inc: { identity_revision: 1, credential_version: 1 } });
  status(await f.browser.request(path), 401);
  status(await submit(f.browser, key), 401);
});

test("隐私HTTP：严格字段、Origin/CSRF、真实2KiB限制和持久再认证限流", options, async t => {
  const f = await fixture(t); await f.authenticated();
  for (const changes of [{ user_id: randomUUID() }, { org_id: randomUUID() }, { scope: "organization" }, { policy_revision: "other" }, { current_password: "" }, { current_password: 123 }]) status(await submit(f.browser, randomUUID(), input(changes)), 422);
  status(await submit(f.browser, "bad"), 422);
  status(await submit(f.browser, randomUUID(), input(), { origin: "https://untrusted.invalid" }), 403);
  status(await submit(f.browser, randomUUID(), input(), { csrf: "invalid" }), 403);
  status(await new Browser(f.browser.base).request(path), 401);
  const oversized = await fetch(`${f.browser.base}/api/v1${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "X-CSRF-Token": f.browser.csrf, "Idempotency-Key": randomUUID(), Cookie: [...f.browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ") }, body: JSON.stringify(input()) + " ".repeat(2048) });
  assert.equal(oversized.status, 413); await oversized.arrayBuffer();
  for (let attempt = 0; attempt < 10; attempt++) status(await submit(f.browser, randomUUID(), input({ current_password: "incorrect-password" })), 401);
  const throttled = await submit(f.browser); status(throttled, 429); assert.equal(throttled.headers.get("retry-after"), "300");
  assert.equal(await f.db.collection("privacy_deletion_requests").countDocuments(), 0);
  assert.equal(await f.db.collection("privacy_operation_receipts").countDocuments(), 0);
});

test("隐私HTTP：并发原key仅登记一次、异key进行中冲突及事务回滚", options, async t => {
  const f = await fixture(t); const user = await f.authenticated();
  const key = randomUUID();
  const pair = await Promise.all([submit(f.browser, key), submit(f.browser.clone(), key)]);
  pair.forEach(result => status(result, 202)); assert.equal(pair[0].data.data.id, pair[1].data.data.id);
  assert.equal(await f.db.collection("privacy_deletion_requests").countDocuments(), 1);
  await f.db.collection("privacy_deletion_requests").updateOne({ _id: pair[0].data.data.id }, { $set: { status: "rejected" }, $inc: { revision: 1 } });
  const { Collection } = require("mongoose").mongo;
  const original = Collection.prototype.insertOne;
  let injected = false;
  Collection.prototype.insertOne = async function (...args) {
    if (this.namespace === `${f.db.databaseName}.privacy_operation_receipts` && !injected) { injected = true; throw new Error("isolated-privacy-receipt-rollback"); }
    return original.apply(this, args);
  };
  const retryKey = randomUUID();
  try { status(await submit(f.browser, retryKey), 503); } finally { Collection.prototype.insertOne = original; }
  assert.ok(injected);
  assert.equal(await f.db.collection("privacy_deletion_requests").countDocuments({ user_id: user.user_id }), 1);
  assert.equal(await f.db.collection("privacy_operation_receipts").countDocuments(), 1);
  status(await submit(f.browser, retryKey), 202);
  assert.equal(await f.db.collection("privacy_deletion_requests").countDocuments(), 2);
});

test("隐私HTTP：签名分页绑定本人和limit，私有执行字段不出站", options, async t => {
  const f = await fixture(t); await f.authenticated();
  const first = await submit(f.browser); status(first, 202);
  await f.db.collection("privacy_deletion_requests").updateOne({ _id: first.data.data.id }, { $set: { status: "rejected", actor: "private-operator", reason_code: "internal-only", plan_hash: "a".repeat(64) }, $inc: { revision: 1 } });
  status(await submit(f.browser), 202);
  const page = await f.browser.request(`${path}?limit=1`); status(page, 200); assert.ok(page.data.data.next_cursor);
  assert.deepEqual(Object.keys(page.data.data.items[0]).sort(), safeFields);
  assert.equal(JSON.stringify(page.data).includes("private-operator"), false);
  const cursor = encodeURIComponent(page.data.data.next_cursor);
  const next = await f.browser.request(`${path}?limit=1&cursor=${cursor}`); status(next, 200);
  assert.equal(next.data.data.next_cursor, null); assert.notEqual(next.data.data.items[0].id, page.data.data.items[0].id);
  status(await f.browser.request(`${path}?limit=2&cursor=${cursor}`), 422);
  status(await f.browser.request(`${path}?limit=1&cursor=${cursor}x`), 422);
  const stranger = new Browser(f.browser.base); await f.authenticated(stranger);
  status(await stranger.request(`${path}?limit=1&cursor=${cursor}`), 422);
  for (const query of ["limit=51", "limit=0", "limit=1.5", "org_id=anything", "limit=1&limit=2"]) status(await f.browser.request(`${path}?${query}`), 422);
});

test("隐私OpenAPI：三条全局路由和安全生成类型契约", options, async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.browser.base}/api/openapi.json`); assert.equal(response.status, 200);
  const document = await response.json();
  for (const [route, method, success] of [[path, "post", "202"], [path, "get", "200"], [`${path}/{id}`, "get", "200"]]) {
    const operation = document.paths[`/api/v1${route}`][method];
    assert.ok(operation.responses[success]);
    assert.equal(operation.parameters.some(parameter => parameter.name === "X-Org-Id"), false);
    assert.deepEqual(operation.security, [{ session: [] }]);
  }
  const schemas = document.components.schemas;
  assert.deepEqual(Object.keys(schemas.PrivacyRequestView.properties).sort(), safeFields);
  assert.equal(schemas.PrivacyDeletionInput.additionalProperties, false);
  assert.equal(schemas.PrivacyDeletionInput.properties.current_password.writeOnly, true);
  assert.ok(schemas.PrivacyRequestPage.properties.next_cursor.nullable);
});

test("隐私HTTP：本地环境边界在身份之后且业务写之前，非本地名称与production拒绝", options, async t => {
  const f = await fixture(t); await f.authenticated();
  const accepted = await submit(f.browser); status(accepted, 202);
  const { PrivacyService } = require("../dist/privacy/privacy.service.js");
  const privacy = f.app.get(PrivacyService);
  const originalDatabase = privacy.database;
  const snapshot = async () => {
    const result = {};
    for (const name of ["privacy_deletion_requests", "privacy_operation_receipts", "auth_rate_limits", "users"])
      result[name] = await f.db.collection(name).find().sort({ _id: 1 }).toArray();
    return result;
  };
  const before = await snapshot();
  const denied = async () => {
    for (const result of [await submit(f.browser), await f.browser.request(path), await f.browser.request(`${path}/${accepted.data.data.id}`)]) {
      status(result, 503); assert.equal(result.data.error.code, "LOCAL_PRIVACY_UNAVAILABLE");
      assert.equal(JSON.stringify(result.data).includes("knowl_nonlocal_boundary"), false);
    }
    status(await new Browser(f.browser.base).request(path), 401, "环境边界不覆盖未认证401");
  };
  // API boundary injection only: identity and transactions still use the isolated real
  // fixture. This facade cannot connect to or read/write any non-local database.
  const nameOnly = new Proxy(Object.freeze({ databaseName: "knowl_nonlocal_boundary", client: originalDatabase.db.client }), {
    get(target, property) {
      if (property === "databaseName" || property === "client") return target[property];
      assert.fail("本地环境拒绝前不得访问任何privacy数据库方法");
    },
  });
  try {
    privacy.database = { db: nameOnly, transaction: originalDatabase.transaction.bind(originalDatabase) };
    await denied();
  } finally { privacy.database = originalDatabase; }
  assert.deepEqual(await snapshot(), before);
  const oldEnvironment = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    await denied();
  } finally {
    if (oldEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldEnvironment;
  }
  assert.deepEqual(await snapshot(), before, "环境拒绝不得写入申请、回执、限流或用户fence");
  status(await f.browser.request(path), 200, "恢复本地环境后仍可读取已登记申请");
});
