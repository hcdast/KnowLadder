import { onBeforeUnmount, onMounted, reactive } from "vue";
import type { paths } from "./api/schema";

export type Identity =
  paths["/api/v1/me"]["get"]["responses"][200]["content"]["application/json"]["data"];
type Csrf =
  paths["/api/v1/auth/csrf"]["get"]["responses"][200]["content"]["application/json"]["data"];
type Phase = "loading" | "anonymous" | "authenticated" | "unknown";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public fields: Record<string, string> = {},
    public retryAfter = "",
    public requestId = "",
    public code = "",
  ) {
    super(message);
  }
}

export interface BusinessOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT";
  body?: unknown;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  responseType?: "json" | "blob";
}
export type BusinessRequest = <T>(path: string, options?: BusinessOptions) => Promise<T>;
export type GlobalRequest = BusinessRequest;

export function useSession() {
  const state = reactive({
    phase: "loading" as Phase,
    identity: null as Identity | null,
    busy: false,
    message: "",
    fields: {} as Record<string, string>,
    requestId: "",
    retryAfter: "",
    formEpoch: 0,
  });
  let csrf = "";
  let organization = "";
  let generation = 0;
  let controller = new AbortController();
  let lastChecked = 0;
  let channel: BroadcastChannel | undefined;
  let disposed = false;
  let writeInFlight = false;
  let pendingResync = false;
  let businessWrites = 0;
  let pendingQuietCheck = false;
  let quietController: AbortController | undefined;
  let businessRetryAt = 0;

  function begin() {
    quietController?.abort();
    quietController = undefined;
    pendingQuietCheck = false;
    controller.abort();
    controller = new AbortController();
    generation += 1;
    businessRetryAt = 0;
    state.busy = true;
    state.message = "";
    state.fields = {};
    state.requestId = "";
    state.retryAfter = "";
    return { id: generation, signal: controller.signal };
  }
  function clearIdentity() {
    state.identity = null;
    state.formEpoch += 1;
  }
  function identityChanged(previous: Identity, next: Identity) {
    return previous.user.id !== next.user.id ||
      previous.context?.org_id !== next.context?.org_id ||
      previous.must_change_password !== next.must_change_password ||
      JSON.stringify([...(previous.context?.capabilities || [])].sort()) !== JSON.stringify([...(next.context?.capabilities || [])].sort());
  }
  function broadcast() {
    channel?.postMessage("identity-changed");
  }
  function report(error: unknown) {
    if (error instanceof ApiError) {
      state.message = error.message;
      state.fields = error.fields;
      state.requestId = error.requestId;
      state.retryAfter = error.retryAfter;
    } else {
      state.message =
        "连接中断，暂时无法确认会话状态。请检查网络后重新查询；不会自动重试密码操作。";
    }
  }
  async function request<T>(
    path: string,
    signal: AbortSignal,
    body?: unknown,
    org = "",
  ): Promise<T> {
    const timeout = new AbortController();
    const cancel = () => timeout.abort();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const timer = window.setTimeout(cancel, 15000);
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (org) headers["X-Org-Id"] = org;
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        headers["X-CSRF-Token"] = csrf;
      }
      const response = await fetch(`/api/v1${path}`, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers,
        signal: timeout.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = response.status === 204 ? null : await response.json();
      if (!response.ok)
        throw new ApiError(
          response.status,
          payload?.error?.message || "请求未完成，请稍后重试。",
          payload?.error?.fields,
          response.headers.get("Retry-After") || "",
          payload?.request_id || "",
          payload?.error?.code || "",
        );
      return payload?.data as T;
    } finally {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    }
  }
  const businessRequest: BusinessRequest = (path, options) => scopedRequest(path, options, false);
  const globalRequest: GlobalRequest = (path, options) => scopedRequest(path, options, true);
  async function scopedRequest<T>(path: string, options: BusinessOptions = {}, global = false): Promise<T> {
    const identity = state.identity;
    const org = identity?.context?.org_id;
    if (!identity || (!global && !org) || identity.must_change_password || state.phase !== "authenticated")
      throw new ApiError(401, global ? "请先确认账号。" : "请先确认账号与组织。");
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("无效业务路径");
    if (Date.now() < businessRetryAt) throw new ApiError(429, "请求较频繁，请在等待期结束后重试。", {}, String(Math.ceil((businessRetryAt - Date.now()) / 1000)));
    const isWrite = (options.method || "GET") !== "GET";
    if (isWrite) {
      businessWrites += 1;
      if (quietController) {
        quietController.abort();
        quietController = undefined;
        pendingQuietCheck = true;
      }
    }
    const epoch = generation;
    const userId = identity.user.id;
    const scopeSignal = controller.signal;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    scopeSignal.addEventListener("abort", cancel, { once: true });
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (scopeSignal.aborted || options.signal?.aborted) cancel();
    const timer = window.setTimeout(cancel, 60000);
    const current = () => !abort.signal.aborted && epoch === generation && state.identity?.user.id === userId && state.identity?.context?.org_id === org;
    try {
      const method = options.method || "GET";
      const headers = new Headers(options.headers);
      if (global) headers.delete("X-Org-Id"); else headers.set("X-Org-Id", org!);
      headers.set("Accept", options.responseType === "blob" ? "application/octet-stream" : "application/json");
      if (method !== "GET") {
        if (!csrf) await getCsrf(abort.signal);
        headers.set("X-CSRF-Token", csrf);
      }
      if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
      const raw = options.body instanceof Blob;
      if (options.body !== undefined && !raw) headers.set("Content-Type", "application/json");
      if (!current()) throw new DOMException("组织或会话已变更", "AbortError");
      const response = await fetch(`/api/v1${path}`, {
        method, credentials: "same-origin", cache: "no-store", headers, signal: abort.signal,
        body: options.body === undefined ? undefined : raw ? options.body as Blob : JSON.stringify(options.body),
      });
      let payload: { data?: unknown; error?: { code?: string; message?: string; fields?: Record<string, string> }; request_id?: string } | null = null;
      let blob: Blob | undefined;
      try { if (response.ok && options.responseType === "blob") blob = await response.blob(); else if (response.status !== 204) payload = await response.json(); }
      catch (cause) { if (response.ok) throw cause; }
      if (!current()) throw new DOMException("组织或会话已变更", "AbortError");
      if (!response.ok) {
        if (response.status === 429) {
          const retry = response.headers.get("Retry-After") || "";
          const seconds = /^\d+$/.test(retry) ? Number(retry) : NaN;
          businessRetryAt = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Math.max(Date.now(), Date.parse(retry) || Date.now());
        }
        if (response.status === 401 || response.status === 403) {
          quietController?.abort();
          quietController = undefined;
          pendingQuietCheck = false;
          generation += 1;
          csrf = ""; businessRetryAt = 0;
          clearIdentity();
          state.phase = "unknown";
          controller.abort();
          state.message = "账号或权限需要重新确认，已清除内容视图。请重新查询会话。";
        }
        throw new ApiError(response.status, payload?.error?.message || "请求失败", payload?.error?.fields, response.headers.get("Retry-After") || "", payload?.request_id || "", payload?.error?.code || "");
      }
      return (options.responseType === "blob" ? blob : payload?.data) as T;
    } finally {
      window.clearTimeout(timer);
      scopeSignal.removeEventListener("abort", cancel);
      options.signal?.removeEventListener("abort", cancel);
      if (isWrite) {
        businessWrites -= 1;
        if (!businessWrites && pendingQuietCheck && !disposed) void quietIdentityCheck();
      }
    }
  }
  async function getCsrf(signal: AbortSignal) {
    const result = await request<Csrf>("/auth/csrf", signal);
    if (!signal.aborted) csrf = result.csrf_token;
  }
  async function readIdentity(signal: AbortSignal) {
    let identity: Identity;
    try {
      identity = await request<Identity>(
        "/me",
        signal,
        undefined,
        organization,
      );
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 403 || !organization)
        throw error;
      organization = "";
      clearIdentity();
      identity = await request<Identity>("/me", signal);
      state.message =
        "原组织已不可访问，已清除组织上下文。请选择仍可访问的组织。";
    }
    if (signal.aborted || pendingResync) return;
    if (state.identity && identityChanged(state.identity, identity)) {
      // Explicit refresh must invalidate mounted content just like a quiet check.
      // Keep this auth operation's generation so its finally can release busy.
      controller.abort();
      controller = new AbortController();
      clearIdentity();
    }
    state.identity = identity;
    state.phase = "authenticated";
    organization = identity.must_change_password ? "" : identity.context?.org_id || "";
  }
  async function synchronize(org = organization) {
    if (writeInFlight) {
      pendingResync = true;
      clearIdentity();
      state.phase = "unknown";
      return;
    }
    organization = org;
    const operation = begin();
    clearIdentity();
    state.phase = "loading";
    try {
      await getCsrf(operation.signal);
      await readIdentity(operation.signal);
    } catch (error) {
      if (operation.id !== generation) return;
      clearIdentity();
      if (error instanceof ApiError && error.status === 401) {
        organization = "";
        state.phase = "anonymous";
      } else {
        state.phase = "unknown";
        report(error);
      }
    } finally {
      if (operation.id === generation) {
        state.busy = false;
        lastChecked = Date.now();
        if (pendingQuietCheck && !disposed) void quietIdentityCheck();
      }
    }
  }
  async function quietIdentityCheck() {
    if (disposed || quietController) return;
    if (writeInFlight || businessWrites || state.busy) {
      pendingQuietCheck = true;
      return;
    }
    pendingQuietCheck = false;
    const previous = state.identity;
    if (!previous || state.phase !== "authenticated") {
      await synchronize();
      return;
    }
    const check = new AbortController();
    quietController = check;
    const epoch = generation;
    const org = organization;
    try {
      const identity = await request<Identity>("/me", check.signal, undefined, org);
      if (check.signal.aborted || disposed || generation !== epoch) return;
      const changed = identityChanged(previous, identity);
      if (changed) {
        controller.abort();
        controller = new AbortController();
        generation += 1;
        clearIdentity();
        csrf = "";
        organization = identity.must_change_password ? "" : identity.context?.org_id || "";
        state.message = "身份或组织权限已更新，已清除原内容视图。";
      }
      state.identity = identity;
      state.phase = "authenticated";
    } catch (error) {
      if (check.signal.aborted || disposed || generation !== epoch) return;
      controller.abort();
      controller = new AbortController();
      generation += 1;
      clearIdentity();
      csrf = "";
      if (error instanceof ApiError && error.status === 401) {
        organization = "";
        state.phase = "anonymous";
      } else {
        state.phase = "unknown";
        report(error);
      }
    } finally {
      if (quietController === check) {
        quietController = undefined;
        lastChecked = Date.now();
      }
    }
  }
  async function mutate(
    action: "login" | "change-password" | "logout" | "refresh",
    body: unknown = {},
  ) {
    if (state.busy) return;
    const operation = begin();
    const previousPhase = state.phase;
    writeInFlight = true;
    let notifyPeers = false;
    let recoveryMessage = "";
    if (action === "logout") {
      clearIdentity();
      state.phase = "loading";
    }
    try {
      if (!csrf) await getCsrf(operation.signal);
      await request(`/auth/${action}`, operation.signal, body);
      if (operation.id !== generation) return;
      notifyPeers = action !== "refresh";
      if (pendingResync) return;
      if (action === "logout" || action === "change-password") {
        clearIdentity();
        organization = "";
        csrf = "";
        state.phase = "anonymous";
        await getCsrf(operation.signal);
        state.message =
          action === "logout"
            ? "已安全退出。"
            : "密码已更新，所有旧会话已失效。请使用新密码登录。";
      } else {
        if (action === "login") organization = "";
        await getCsrf(operation.signal);
        await readIdentity(operation.signal);
        if (action === "refresh")
          state.message = "会话已续期，账号信息已更新。";
      }
    } catch (error) {
      if (operation.id !== generation) return;
      report(error);
      if (
        action === "logout" ||
        !(error instanceof ApiError) ||
        error.status >= 500
      ) {
        notifyPeers = action !== "refresh";
        clearIdentity();
        csrf = "";
        state.phase = "unknown";
        if (action === "logout") {
          state.message =
            "本页已隐藏账号信息，但服务端尚未确认退出。请重新查询会话，确认后可再次退出。";
        }
      } else if (error.status === 401) {
        clearIdentity();
        organization = "";
        csrf = "";
        state.phase = action === "change-password" ? "unknown" : "anonymous";
        if (action === "change-password") {
          pendingResync = true;
          recoveryMessage = `${state.message} 已重新查询会话；如仍需修改密码，请重新输入。`;
        }
      } else if (error.status === 403) {
        clearIdentity();
        organization = "";
        csrf = "";
        state.phase = "unknown";
        state.message += " 请重新查询身份与安全凭证后再操作。";
      } else {
        state.phase = previousPhase;
      }
    } finally {
      writeInFlight = false;
      if (operation.id === generation) {
        if (pendingResync) {
          pendingResync = false;
          csrf = "";
          organization = "";
          await synchronize();
          if (recoveryMessage && state.phase !== "unknown")
            state.message = recoveryMessage;
        } else {
          state.busy = false;
          lastChecked = Date.now();
        }
        if (notifyPeers && !disposed) broadcast();
      }
      if (pendingQuietCheck && !disposed) void quietIdentityCheck();
    }
  }
  function onWake() {
    if (
      document.visibilityState === "visible" &&
      !disposed &&
      Date.now() - lastChecked > 30000
    )
      void quietIdentityCheck();
  }
  function onBroadcast(event: MessageEvent) {
    if (event.data !== "identity-changed" || disposed) return;
    if (writeInFlight) {
      pendingResync = true;
      clearIdentity();
      state.phase = "unknown";
      state.message =
        "其他标签页的身份已变更。正在等待当前操作完成，再重新确认会话。";
      return;
    }
    csrf = "";
    organization = "";
    void synchronize();
  }
  onMounted(() => {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel("knowladder-session");
      channel.addEventListener("message", onBroadcast);
    }
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    void synchronize();
  });
  onBeforeUnmount(() => {
    disposed = true;
    quietController?.abort();
    generation += 1;
    controller.abort();
    channel?.close();
    window.removeEventListener("focus", onWake);
    document.removeEventListener("visibilitychange", onWake);
  });
  return { state, synchronize, mutate, businessRequest, globalRequest };
}
