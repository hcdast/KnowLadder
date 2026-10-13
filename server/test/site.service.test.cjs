"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { loadConfig } = require("../dist/config");
const { SafeErrors } = require("../dist/errors");
const { MongoServerError } = require("mongodb");


test("站点组织启动配置：非空非法拒绝且不回显输入", () => {
  const base = {
    MONGODB_URI: "mongodb://127.0.0.1/kl_test_site_config",
    APP_ORIGIN: "http://127.0.0.1:5174",
    ALLOW_INSECURE_HTTP: "true",
    AUTH_RATE_LIMIT_KEY: "test-only-key-at-least-thirty-two-bytes",
  };
  for (const value of ["not-an-id", "0123456789ABCDEF01234567", " 0123456789abcdef01234567", "private@example.invalid"])
    assert.throws(() => loadConfig({ ...base, KL_SITE_ORG_ID: value }), error =>
      error.message.startsWith("SITE_CONFIGURATION_INVALID:") && !error.message.includes(value));
});


test("未知依赖异常诊断不输出消息、堆栈、请求内容、可变URL和非允许code", t => {
  const lines = [];
  t.mock.method(console, "error", line => lines.push(line));
  const requestId = randomUUID();
  const secret = "private@example.invalid mongodb://credentials.invalid/db";
  const request = { requestId, route: { path: "/api/v1/site/pages/:key" }, originalUrl: "/site/" + secret, body: { contact: secret } };
  let status, body;
  const response = {
    hasHeader: () => false,
    status(value) { status = value; return this; },
    json(value) { body = value; return this; },
  };
  const host = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) };
  const error = new MongoServerError({ message: secret, code: 11000 });
  new SafeErrors().catch(error, host);
  assert.equal(status, 503);
  assert.equal(body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(body.request_id, requestId);
  const first = JSON.parse(lines[0]);
  assert.equal(first.request_id, requestId);
  assert.equal(first.error_category, "database");
  assert.equal(first.code, 11000);
  request.route.path = "/api/v1/site/consultations/" + secret;
  error.code = secret;
  new SafeErrors().catch(error, host);
  assert.equal(JSON.parse(lines[1]).route, "other");
  assert.equal(JSON.parse(lines[1]).code, "UNCLASSIFIED");
  for (const value of [...lines, JSON.stringify(body)]) assert.ok(!value.includes(secret));
});
