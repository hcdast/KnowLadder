"use strict";
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { MongoClient } = require("mongodb");
const { listenTestHttp } = require("./http-listen.cjs");
const ORIGIN = "http://127.0.0.1:5174";
const PASSWORD = "Integration-only-new-password!42";
function guardedUri(value, suffix = "") {
  const match = /^(mongodb(?:\+srv)?:\/\/[^/]+\/)([^?]+)(\?.*)?$/.exec(value);
  assert.ok(match, "测试必须使用显式数据库名的 MongoDB URI");
  const name = decodeURIComponent(match[2]);
  assert.match(
    name,
    /^kl_test_[a-zA-Z0-9_-]+$/,
    "拒绝访问或删除非 kl_test_ 测试数据库",
  );
  const database = suffix ? `${name.slice(0, 30)}_${suffix}` : name;
  return `${match[1]}${database}${match[3] || ""}`;
}
class Browser {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
    this.csrf = undefined;
  }
  clone(base = this.base) {
    const copy = new Browser(base);
    copy.cookies = new Map(this.cookies);
    copy.csrf = this.csrf;
    return copy;
  }
  async request(
    path,
    {
      method = "GET",
      body,
      headers = {},
      origin = ORIGIN,
      csrf = this.csrf,
    } = {},
  ) {
    const outgoing = { ...headers };
    if (this.cookies.size)
      outgoing.Cookie = [...this.cookies]
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    if (origin !== null) outgoing.Origin = origin;
    if (csrf) outgoing["X-CSRF-Token"] = csrf;
    if (body !== undefined) outgoing["Content-Type"] = "application/json";
    const response = await fetch(`${this.base}/api/v1${path}`, {
      method,
      headers: outgoing,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0];
      const at = pair.indexOf("=");
      const key = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (!value || /Max-Age=0(?:;|$)/i.test(cookie)) this.cookies.delete(key);
      else this.cookies.set(key, value);
    }
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      data: text ? JSON.parse(text) : null,
    };
  }
  async prepare() {
    const response = await this.request("/auth/csrf");
    status(response, 200);
    assert.equal(typeof response.data.data.csrf_token, "string");
    this.csrf = response.data.data.csrf_token;
    return response;
  }
  login(login_name, password) {
    return this.request("/auth/login", {
      method: "POST",
      body: { login_name, password },
    });
  }
}
function status(response, expected) {
  // Never attach response bodies, cookies, CSRF tokens or passwords to assertion output.
  const code = response.data?.error?.code;
  const safeCode = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? ` (${code})` : "";
  assert.equal(response.status, expected, `HTTP 状态应为 ${expected}${safeCode}`);
}
function error(response, expected) {
  status(response, expected);
  assert.equal(typeof response.data?.error?.code, "string");
  assert.equal(typeof response.data?.error?.message, "string");
  assert.equal(typeof response.data?.request_id, "string");
}
async function fixture(t, { migrated = true, app = true, env = {} } = {}) {
  const uri = guardedUri(
    process.env.TEST_MONGODB_URI,
    randomUUID().replaceAll("-", ""),
  );
  const restore = new Map();
  const settings = {
    NODE_ENV: "test",
    MONGODB_URI: uri,
    APP_ORIGIN: ORIGIN,
    ALLOW_INSECURE_HTTP: "true",
    AUTH_RATE_LIMIT_KEY: "integration-test-only-key-at-least-thirty-two-bytes",
    SESSION_PREAUTH_MS: "600000",
    SESSION_IDLE_MS: "1800000",
    SESSION_ABSOLUTE_MS: "28800000",
    SESSION_TOUCH_MS: "1000",
    TEMPORARY_PASSWORD_MS: "86400000",
    TRUST_PROXY: "0",
    PORT: "3000",
    ...env,
  };
  for (const [key, value] of Object.entries(settings)) {
    restore.set(key, process.env[key]);
    process.env[key] = value;
  }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  const apps = [];
  let connected = false;
  t.after(async () => {
    try {
      await Promise.allSettled(apps.map((instance) => instance.close()));
      if (connected) {
        guardedUri(uri);
        assert.match(client.db().databaseName, /^kl_test_/);
        await client.db().dropDatabase();
      }
    } finally {
      await client.close();
      for (const [key, value] of restore) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  await client.connect();
  connected = true;
  const hello = await client.db("admin").command({ hello: 1 });
  assert.ok(hello.setName, "TEST_MONGODB_URI 必须指向真实 MongoDB 副本集");
  const { migrate } = require("../dist/migrations/schema.js");
  const { createApp } = require("../dist/app.js");
  const ops = require("../dist/cli/admin-operations.js");
  if (migrated) await migrate(uri);
  const context = {
    client,
    db: client.db(),
    actor: "integration-test",
    reason: "阶段一真实Mongo集成验收",
  };
  const state = {
    uri,
    client,
    db: client.db(),
    ops,
    context,
    migrate,
    apps,
    createApp,
  };
  state.start = async () => {
    const instance = await createApp();
    apps.push(instance);
    const base = await listenTestHttp(instance);
    return { app: instance, browser: new Browser(base) };
  };
  state.user = async () => {
    const login_name = `u_${randomUUID().replaceAll("-", "")}`;
    return {
      ...(await ops.createUser(context, {
        login_name,
        display_name: "集成验收用户",
      })),
      login_name,
    };
  };
  state.authenticated = async (browser = state.browser) => {
    const user = await state.user();
    await browser.prepare();
    status(await browser.login(user.login_name, user.secret), 200);
    await browser.prepare();
    status(
      await browser.request("/auth/change-password", {
        method: "POST",
        body: { current_password: user.secret, new_password: PASSWORD },
      }),
      204,
    );
    await browser.prepare();
    status(await browser.login(user.login_name, PASSWORD), 200);
    await browser.prepare();
    return user;
  };
  state.session = (browser) => {
    const token = browser.cookies.get("kl_dev_session");
    assert.ok(token, "浏览器应持有开发会话 Cookie");
    return { token_hash: createHash("sha256").update(token).digest("hex") };
  };
  if (app) Object.assign(state, await state.start());
  return state;
}
module.exports = {
  fixture,
  Browser,
  status,
  error,
  guardedUri,
  PASSWORD,
  ORIGIN,
};
