"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { MongoServerError } = require("mongodb");
const { SafeErrors } = require("../dist/errors");

test("结果接口事务异常日志保留固定路由、错误类别和标签，排除答卷与凭据", t => {
  const logs = [];
  t.mock.method(console, "error", value => logs.push(JSON.parse(value)));
  const secret = "private-answer-cookie-password";
  const request = { requestId: randomUUID(), route: { path: "/api/v1/submissions/:id/items" },
    originalUrl: "/api/v1/submissions/" + secret, body: { answer: secret }, headers: { cookie: secret } };
  let status, payload;
  const response = { hasHeader: () => false, status(value) { status = value; return this; }, json(value) { payload = value; } };
  const host = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) };
  const error = new MongoServerError({ message: secret, code: 251 });
  error.addErrorLabel("TransientTransactionError");
  new SafeErrors().catch(error, host);
  assert.equal(status, 503);
  assert.equal(payload.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(logs[0].route, "/api/v1/submissions/:id/items");
  assert.equal(logs[0].code, 251);
  assert.equal(logs[0].transient_transaction, true);
  assert.equal(logs[0].commit_outcome_unknown, false);
  request.route.path = "/api/v1/submissions/" + secret;
  new SafeErrors().catch(error, host);
  assert.equal(logs[1].route, "other");
  assert.ok(!JSON.stringify({ logs, payload }).includes(secret));
});
