import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { reactive } from "vue";

const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL("../src/session.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const identity = {
  user: { id: "test-actor", display_name: "示例账号" },
  organizations: [],
  context: null,
  must_change_password: false,
};
function harness(t, initiallyRequired = true) {
  const mounts = [],
    cleanup = [],
    channels = [],
    calls = [];
  const window = new EventTarget(),
    document = new EventTarget();
  Object.assign(window, { setTimeout, clearTimeout, setInterval, clearInterval });
  document.visibilityState = "visible";
  let signedIn = false,
    logoutFailure = false,
    logoutRejected = false,
    csrfFailure = false,
    releaseLogin,
    blockLogin = false,
    postedLogout = false;
  class Channel extends EventTarget {
    constructor() {
      super();
      channels.push(this);
    }
    postMessage() {}
    close() {}
  }
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    require: (name) =>
      name === "vue"
        ? { reactive, onMounted: (fn) => mounts.push(fn), onBeforeUnmount: (fn) => cleanup.push(fn) }
        : require(name),
    window,
    document,
    AbortController,
    DOMException,
    performance,
    Headers,
    Blob,
    BroadcastChannel: Channel,
    Date,
    JSON,
    fetch: async (path, options) => {
      calls.push({ path, method: options.method, signal: options.signal });
      if (path.endsWith("/csrf"))
        return new Response(
          JSON.stringify(
            csrfFailure && postedLogout
              ? { error: { message: "connection failed" } }
              : { data: { csrf_token: "fixture-csrf" } },
          ),
          { status: csrfFailure && postedLogout ? 503 : 200 },
        );
      if (path.endsWith("/login")) {
        if (blockLogin)
          await new Promise((resolve) => {
            releaseLogin = resolve;
          });
        signedIn = true;
        return new Response(JSON.stringify({ data: {} }));
      }
      if (path.endsWith("/logout")) {
        if (logoutRejected)
          return new Response(JSON.stringify({ error: { message: "not revoked" } }), { status: 403 });
        signedIn = false;
        postedLogout = true;
        if (logoutFailure) throw new TypeError("response lost");
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/me"))
        return new Response(
          JSON.stringify(signedIn ? { data: identity } : { error: { message: "anonymous" } }),
          { status: signedIn ? 200 : 401 },
        );
      throw Error("Unexpected endpoint " + path);
    },
  });
  const session = exports.useSession({ identityRequired: () => initiallyRequired });
  t.after(() => cleanup.forEach((fn) => fn()));
  return {
    session,
    calls,
    mounts,
    channels,
    set blockLogin(value) {
      blockLogin = value;
    },
    release: () => releaseLogin(),
    set logoutFailure(value) {
      logoutFailure = value;
    },
    set logoutRejected(value) {
      logoutRejected = value;
    },
    set csrfFailure(value) {
      csrfFailure = value;
    },
  };
}
async function login(h) {
  await h.session.synchronize();
  await h.session.mutate("login", { login_name: "fixture", password: "test-only" });
  assert.equal(h.session.state.phase, "authenticated");
}
test("退出被拒后只读确认仍有效，必须由用户再次退出", async (t) => {
  const h = harness(t);
  await login(h);
  h.session.setIdentityRequired(false);
  h.logoutRejected = true;
  await h.session.mutate("logout");
  assert.equal(h.session.state.phase, "unknown");
  await h.session.confirmAuthentication();
  assert.equal(h.session.state.phase, "authenticated");
  assert.equal(h.session.state.logoutResult, "unconfirmed");
  assert.equal(h.calls.filter((c) => c.path.endsWith("/logout")).length, 1);
  h.logoutRejected = false;
  await h.session.mutate("logout");
  assert.equal(h.session.state.logoutResult, "confirmed");
});
test("关闭在途弹窗后收到身份广播，完成单次写入再强制只读核对", async (t) => {
  const h = harness(t);
  h.mounts.forEach((fn) => fn());
  await new Promise((resolve) => setImmediate(resolve));
  await h.session.synchronize();
  h.blockLogin = true;
  const pending = h.session.mutate("login", { login_name: "fixture", password: "test-only" });
  await new Promise((resolve) => setImmediate(resolve));
  h.session.setIdentityRequired(false);
  h.channels[0].dispatchEvent(new MessageEvent("message", { data: "identity-changed" }));
  h.release();
  await pending;
  assert.equal(h.session.state.phase, "authenticated");
  assert.equal(h.session.state.busy, false);
  assert.equal(h.calls.filter((c) => c.path.endsWith("/login")).length, 1);
});
test("公开首页首次加载与普通同步不探测私人会话", async (t) => {
  const h = harness(t, false);
  h.mounts.forEach((fn) => fn());
  await h.session.synchronize();
  assert.equal(h.calls.length, 0);
});
test("关闭提交中的官网弹窗仍完成唯一登录写入，公开页不轮询", async (t) => {
  const h = harness(t);
  await h.session.synchronize();
  h.blockLogin = true;
  const pending = h.session.mutate("login", { login_name: "fixture", password: "test-only" });
  await new Promise((resolve) => setImmediate(resolve));
  h.session.setIdentityRequired(false);
  h.release();
  await pending;
  assert.equal(h.session.state.phase, "authenticated");
  assert.equal(h.calls.filter((c) => c.path.endsWith("/login")).length, 1);
  assert.equal(h.calls.find((c) => c.path.endsWith("/login")).signal.aborted, false);
  const count = h.calls.length;
  await h.session.synchronize();
  assert.equal(h.calls.length, count);
});
test("已确认身份可在公开页退出，服务端响应后才报告已退出", async (t) => {
  const h = harness(t);
  await login(h);
  h.session.setIdentityRequired(false);
  assert.equal(h.session.state.phase, "authenticated");
  await h.session.mutate("logout");
  assert.equal(h.session.state.phase, "anonymous");
  assert.equal(h.session.state.identity, null);
  assert.equal(h.session.state.logoutResult, "confirmed");
  assert.equal(h.calls.filter((c) => c.path.endsWith("/logout")).length, 1);
});
test("退出204后预认证失败仍是已退出，单独报告登录连接不可用", async (t) => {
  const h = harness(t);
  await login(h);
  h.csrfFailure = true;
  await h.session.mutate("logout");
  assert.equal(h.session.state.phase, "anonymous");
  assert.equal(h.session.state.logoutResult, "connection-unavailable");
  assert.equal(h.session.state.identity, null);
  h.csrfFailure = false;
  await h.session.confirmAuthentication();
  assert.equal(h.session.state.logoutResult, "confirmed");
});
test("退出响应丢失先隐藏身份，显式只读核对不会重放退出", async (t) => {
  const h = harness(t);
  await login(h);
  h.session.setIdentityRequired(false);
  h.logoutFailure = true;
  await h.session.mutate("logout");
  assert.equal(h.session.state.phase, "unknown");
  assert.equal(h.session.state.logoutResult, "unconfirmed");
  assert.equal(h.session.state.identity, null);
  await h.session.confirmAuthentication();
  assert.equal(h.session.state.phase, "anonymous");
  assert.equal(h.session.state.logoutResult, "confirmed");
  assert.equal(h.calls.filter((c) => c.path.endsWith("/logout")).length, 1);
});
test("公开页跨标签身份变更隐藏旧账号，不读取私人接口", async (t) => {
  const h = harness(t);
  h.mounts.forEach((fn) => fn());
  await new Promise((resolve) => setImmediate(resolve));
  await login(h);
  h.session.setIdentityRequired(false);
  const count = h.calls.length;
  h.channels[0].dispatchEvent(new MessageEvent("message", { data: "identity-changed" }));
  assert.equal(h.session.state.identity, null);
  assert.equal(h.session.state.phase, "unknown");
  assert.equal(h.calls.length, count);
});
