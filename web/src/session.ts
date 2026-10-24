import { onBeforeUnmount, onMounted, reactive } from "vue";
import type { paths } from "./api/schema";

export type Identity = paths["/api/v1/me"]["get"]["responses"][200]["content"]["application/json"]["data"];
type Csrf = paths["/api/v1/auth/csrf"]["get"]["responses"][200]["content"]["application/json"]["data"];
export type Phase = "loading" | "anonymous" | "authenticated" | "unknown";
export type LogoutResult = "none" | "pending" | "confirmed" | "connection-unavailable" | "unconfirmed";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public fields: Record<string, string> = {},
    public retryAfter = "",
    public requestId = "",
    public code = "",
    public operationId = "",
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
  /** Only form-local lookups opt out of route-terminal 404; 401/403 are never suppressed. */
  notFound?: "lookup";
}
export type BusinessRequest = <T>(path: string, options?: BusinessOptions) => Promise<T>;
export type GlobalRequest = BusinessRequest;

export interface SessionOptions {
  preferredOrganization?: (userId: string) => string | undefined;
  onAccessDenied?: (status: 403 | 404) => void;
  identityRequired?: () => boolean;
}

export function useSession(options: SessionOptions = {}) {
  const onAccessDenied = options.onAccessDenied;
  let identityEnabled = options.identityRequired?.() ?? true;
  const state = reactive({
    phase: "loading" as Phase,
    identity: null as Identity | null,
    busy: false,
    message: "",
    fields: {} as Record<string, string>,
    requestId: "",
    retryAfter: "",
    formEpoch: 0,
    authAction: "" as "" | "login" | "change-password" | "logout" | "refresh",
    logoutResult: "none" as LogoutResult,
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
  let externalAuthenticationActive = false;
  let identityTimer = 0;

  function begin(budget = 15000) {
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
    const operationController = controller;
    const timer = window.setTimeout(
      () => operationController.abort(new DOMException("认证确认超时", "TimeoutError")),
      budget,
    );
    if (budget <= 0) operationController.abort(new DOMException("认证确认超时", "TimeoutError"));
    return {
      id: generation,
      signal: operationController.signal,
      timer,
      deadline: performance.now() + budget,
    };
  }
  function clearIdentity() {
    state.identity = null;
    state.formEpoch += 1;
  }
  function identityChanged(previous: Identity, next: Identity) {
    return (
      previous.user.id !== next.user.id ||
      previous.context?.org_id !== next.context?.org_id ||
      previous.must_change_password !== next.must_change_password ||
      previous.context?.student_conflict !== next.context?.student_conflict ||
      JSON.stringify([...(previous.context?.capabilities || [])].sort()) !==
        JSON.stringify([...(next.context?.capabilities || [])].sort())
    );
  }
  function broadcast() {
    channel?.postMessage("identity-changed");
  }
  function report(error: unknown) {
    if (error instanceof ApiError) {
      state.message = error.operationId ? `${error.message} · 操作编号 ${error.operationId}` : error.message;
      state.fields = error.fields;
      state.requestId = error.requestId;
      state.retryAfter = error.retryAfter;
    } else {
      state.fields = {};
      state.requestId = "";
      state.retryAfter = "";
      state.message =
        error instanceof DOMException && error.name === "TimeoutError"
          ? "会话确认超时，暂时无法确认结果。请重新查询会话；不会自动重试密码操作。"
          : "网络连接中断，暂时无法确认会话状态。请检查网络后重新查询；不会自动重试密码操作。";
    }
  }
  async function request<T>(path: string, signal: AbortSignal, body?: unknown, org = ""): Promise<T> {
    const timeout = new AbortController();
    const cancel = () => timeout.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const timer = window.setTimeout(
      () => timeout.abort(new DOMException("认证请求超时", "TimeoutError")),
      15000,
    );
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
          payload?.error?.operation_id || "",
        );
      return payload?.data as T;
    } catch (error) {
      if (timeout.signal.aborted) throw timeout.signal.reason;
      throw error;
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
    if (Date.now() < businessRetryAt)
      throw new ApiError(
        429,
        "请求较频繁，请在等待期结束后重试。",
        {},
        String(Math.ceil((businessRetryAt - Date.now()) / 1000)),
      );
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
    const current = () =>
      !abort.signal.aborted &&
      epoch === generation &&
      state.identity?.user.id === userId &&
      state.identity?.context?.org_id === org;
    try {
      const method = options.method || "GET";
      const headers = new Headers(options.headers);
      if (global) headers.delete("X-Org-Id");
      else headers.set("X-Org-Id", org!);
      headers.set(
        "Accept",
        options.responseType === "blob" ? "application/octet-stream" : "application/json",
      );
      if (method !== "GET") {
        if (!csrf) await getCsrf(abort.signal);
        headers.set("X-CSRF-Token", csrf);
      }
      if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
      const raw = options.body instanceof Blob;
      if (options.body !== undefined && !raw) headers.set("Content-Type", "application/json");
      if (!current()) throw new DOMException("组织或会话已变更", "AbortError");
      const response = await fetch(`/api/v1${path}`, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers,
        signal: abort.signal,
        body:
          options.body === undefined
            ? undefined
            : raw
              ? (options.body as Blob)
              : JSON.stringify(options.body),
      });
      let payload: {
        data?: unknown;
        error?: { code?: string; message?: string; fields?: Record<string, string>; operation_id?: string };
        request_id?: string;
      } | null = null;
      let blob: Blob | undefined;
      try {
        if (response.ok && options.responseType === "blob") blob = await response.blob();
        else if (response.status !== 204) payload = await response.json();
      } catch (cause) {
        if (response.ok) throw cause;
      }
      if (!current()) throw new DOMException("组织或会话已变更", "AbortError");
      if (!response.ok) {
        if (response.status === 429) {
          const retry = response.headers.get("Retry-After") || "";
          const seconds = /^\d+$/.test(retry) ? Number(retry) : NaN;
          businessRetryAt = Number.isFinite(seconds)
            ? Date.now() + seconds * 1000
            : Math.max(Date.now(), Date.parse(retry) || Date.now());
        }
        if (response.status === 403 || (response.status === 404 && !isWrite && options.notFound !== "lookup"))
          onAccessDenied?.(response.status as 403 | 404);
        if (response.status === 401 || response.status === 403) {
          quietController?.abort();
          quietController = undefined;
          pendingQuietCheck = false;
          generation += 1;
          csrf = "";
          businessRetryAt = 0;
          clearIdentity();
          state.phase = "unknown";
          controller.abort();
          state.message = "账号或权限需要重新确认，已清除内容视图。请重新查询会话。";
        }
        throw new ApiError(
          response.status,
          payload?.error?.message || "请求失败",
          payload?.error?.fields,
          response.headers.get("Retry-After") || "",
          payload?.request_id || "",
          payload?.error?.code || "",
          payload?.error?.operation_id || "",
        );
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
  async function fetchIdentity(signal: AbortSignal, org: string, recoverOrganization = true) {
    let identity: Identity;
    let organizationRemoved = false;
    try {
      identity = await request<Identity>("/me", signal, undefined, org);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 403 || !org || !recoverOrganization) throw error;
      organizationRemoved = true;
      onAccessDenied?.(403);
      identity = await request<Identity>("/me", signal);
    }
    if (!identity.must_change_password && !identity.context) {
      const preferred = options.preferredOrganization?.(identity.user.id);
      const selected =
        identity.organizations.find((item) => item.id === preferred)?.id ||
        (identity.organizations.length === 1 ? identity.organizations[0]!.id : "");
      if (selected && (!organizationRemoved || selected !== org)) {
        try {
          identity = await request<Identity>("/me", signal, undefined, selected);
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 403 || !recoverOrganization) throw error;
          // Membership can change between the unscoped and scoped reads.
          // Confirm the remaining organizations without retrying the selection.
          organizationRemoved = true;
          onAccessDenied?.(403);
          identity = await request<Identity>("/me", signal);
        }
      }
    }
    return { identity, organizationRemoved };
  }
  async function readIdentity(signal: AbortSignal) {
    const { identity, organizationRemoved } = await fetchIdentity(signal, organization);
    if (signal.aborted || pendingResync) return;
    if (state.identity && identityChanged(state.identity, identity)) {
      // Invalidate mounted content before publishing the new identity.
      controller.abort();
      controller = new AbortController();
      clearIdentity();
    }
    state.identity = identity;
    state.phase = "authenticated";
    organization = identity.must_change_password ? "" : identity.context?.org_id || "";
    if (organizationRemoved) state.message = "原组织已不可访问，已清除组织上下文。请选择仍可访问的组织。";
  }
  async function synchronizeRound(org: string, budget: number, confirmExternal = false) {
    if (!identityEnabled && !confirmExternal) return;
    if (externalAuthenticationActive && !confirmExternal) {
      clearIdentity();
      csrf = "";
      state.phase = "unknown";
      state.message = "邮箱认证操作尚在进行。请等待结果后只读查询会话，不会重放操作。";
      return;
    }
    if (writeInFlight) {
      pendingResync = true;
      clearIdentity();
      state.phase = "unknown";
      return;
    }
    // This real read round consumes any deferred identity check left by an interrupted write.
    pendingResync = false;
    organization = org;
    const previousPhase = state.phase;
    const operation = begin(budget);
    clearIdentity();
    state.phase = "loading";
    try {
      if (!csrf) await getCsrf(operation.signal);
      await readIdentity(operation.signal);
      if (["unconfirmed", "confirmed", "connection-unavailable"].includes(state.logoutResult)) {
        state.logoutResult = "unconfirmed";
        state.message = "当前浏览器仍有登录账号，请再次退出。";
      }
    } catch (error) {
      if (operation.id !== generation) return;
      clearIdentity();
      if (previousPhase === "authenticated" || !(error instanceof ApiError && error.status === 401))
        csrf = "";
      if (error instanceof ApiError && error.status === 401) {
        organization = "";
        state.phase = "anonymous";
        if (["unconfirmed", "confirmed", "connection-unavailable"].includes(state.logoutResult)) {
          state.logoutResult = "confirmed";
          state.message = "已退出登录。";
        }
      } else {
        state.phase = "unknown";
        report(error);
      }
    } finally {
      window.clearTimeout(operation.timer);
      if (operation.id === generation) {
        state.busy = false;
        lastChecked = Date.now();
        if (pendingQuietCheck && !disposed) void quietIdentityCheck();
      }
    }
  }
  const synchronize = (org = organization) => synchronizeRound(org, 15000);
  function setIdentityRequired(required: boolean) {
    if (disposed || identityEnabled === required) return;
    identityEnabled = required;
    if (!required) {
      quietController?.abort();
      quietController = undefined;
      // A closed public login dialog does not cancel or replay an already sent
      // authentication write. Its one shared owner settles the result off-page.
      if (writeInFlight && ["login", "logout"].includes(state.authAction)) return;
      const keepKnownIdentity =
        !state.busy &&
        !businessWrites &&
        !externalAuthenticationActive &&
        ["authenticated", "anonymous"].includes(state.phase);
      generation++;
      controller.abort();
      controller = new AbortController();
      lastChecked = 0;
      pendingQuietCheck = false;
      if (keepKnownIdentity) return;
      csrf = "";
      organization = "";
      clearIdentity();
      state.phase = "unknown";
      state.busy = false;
      if (writeInFlight || businessWrites || externalAuthenticationActive)
        state.message = "原认证或业务请求结果仍待确认。已隐藏私有视图；不会撤销服务端写入或更换原请求编号。";
    } else if (!state.busy) void synchronize();
  }
  function authenticationActionActive(active: boolean) {
    externalAuthenticationActive = active;
    if (active) {
      quietController?.abort();
      quietController = undefined;
      pendingQuietCheck = false;
    }
  }
  async function confirmAuthentication(budget = 15000) {
    csrf = "";
    organization = "";
    await synchronizeRound("", Math.min(15000, Math.max(0, budget)), true);
    if (!disposed) broadcast();
    return state.phase === "authenticated" || state.phase === "anonymous";
  }
  function authenticationUncertain() {
    generation++;
    controller.abort();
    quietController?.abort();
    quietController = undefined;
    csrf = "";
    organization = "";
    clearIdentity();
    state.phase = "unknown";
    state.busy = false;
    state.message = "邮箱认证请求结果尚未确认。请只读重新查询会话，不会重放邮件确认或密码重置。";
    if (!disposed) broadcast();
  }
  async function quietIdentityCheck() {
    if (!identityEnabled || disposed || quietController || document.visibilityState !== "visible") return;
    if (!state.identity || state.phase !== "authenticated") {
      pendingQuietCheck = false;
      return;
    }
    if (externalAuthenticationActive || writeInFlight || businessWrites || state.busy) {
      pendingQuietCheck = true;
      return;
    }
    pendingQuietCheck = false;
    const previous = state.identity;
    const check = new AbortController();
    quietController = check;
    const epoch = generation;
    const org = organization;
    const timer = window.setTimeout(
      () => check.abort(new DOMException("认证确认超时", "TimeoutError")),
      15000,
    );
    try {
      const { identity, organizationRemoved } = await fetchIdentity(check.signal, org, false);
      if (check.signal.aborted || disposed || generation !== epoch) return;
      const changed = identityChanged(previous, identity);
      if (changed) {
        controller.abort();
        controller = new AbortController();
        generation += 1;
        clearIdentity();
        csrf = "";
        organization = identity.must_change_password ? "" : identity.context?.org_id || "";
        if (!state.message)
          state.message = organizationRemoved
            ? "原组织已不可访问，已清除组织上下文。请选择仍可访问的组织。"
            : "身份或组织权限已更新，已清除原内容视图。";
      }
      state.identity = identity;
      state.phase = "authenticated";
    } catch (error) {
      if (
        disposed ||
        generation !== epoch ||
        (check.signal.aborted && check.signal.reason?.name !== "TimeoutError")
      )
        return;
      if (error instanceof ApiError && error.status === 403) onAccessDenied?.(403);
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
        const previousMessage = state.message;
        report(error);
        if (previousMessage && previousMessage !== state.message)
          state.message = `${previousMessage}\n${state.message}`;
      }
    } finally {
      window.clearTimeout(timer);
      if (quietController === check) {
        quietController = undefined;
        lastChecked = Date.now();
      }
    }
  }
  async function mutate(action: "login" | "change-password" | "logout" | "refresh", body: unknown = {}) {
    if (
      (!identityEnabled && !(action === "logout" && state.phase === "authenticated")) ||
      state.busy ||
      writeInFlight ||
      externalAuthenticationActive
    )
      return;
    const operation = begin(action === "login" ? 30000 : 15000);
    const previousPhase = state.phase;
    writeInFlight = true;
    state.authAction = action;
    if (action === "logout") state.logoutResult = "pending";
    else if (action === "login") state.logoutResult = "none";
    let notifyPeers = false;
    let recoveryMessage = "";
    let confirmed = false;
    if (action === "logout" || action === "refresh") {
      clearIdentity();
      state.phase = "loading";
    }
    try {
      if (!csrf) await getCsrf(operation.signal);
      await request(`/auth/${action}`, operation.signal, body);
      confirmed = true;
      if (operation.id !== generation) return;
      if (action === "logout") state.logoutResult = "confirmed";
      notifyPeers = action !== "refresh";
      if (pendingResync) return;
      if (action === "logout" || action === "change-password") {
        clearIdentity();
        organization = "";
        csrf = "";
        state.phase = "anonymous";
        await getCsrf(operation.signal);
        state.message =
          action === "logout" ? "已安全退出。" : "密码已更新，所有旧会话已失效。请使用新密码登录。";
      } else {
        if (action === "login") organization = "";
        csrf = "";
        await getCsrf(operation.signal);
        await readIdentity(operation.signal);
        if (action === "refresh") state.message = "会话已续期，账号信息已更新。";
      }
    } catch (error) {
      if (operation.id !== generation) return;
      report(error);
      if (action === "logout" || !(error instanceof ApiError) || error.status >= 500 || confirmed) {
        notifyPeers = action !== "refresh";
        clearIdentity();
        csrf = "";
        state.phase = "unknown";
        if (action === "logout") {
          state.logoutResult = confirmed ? "connection-unavailable" : "unconfirmed";
          state.phase = confirmed ? "anonymous" : "unknown";
          state.message = confirmed
            ? "已退出登录。登录连接暂不可用，请稍后重新连接。"
            : "退出状态待确认。账号内容已隐藏，请核对退出状态。";
        } else if (action === "change-password" && confirmed)
          state.message =
            "密码已更新，所有旧会话已失效，但新的安全凭据暂未确认。请重新查询后使用新密码登录。";
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
        state.phase = action === "refresh" ? "unknown" : previousPhase;
      }
    } finally {
      window.clearTimeout(operation.timer);
      writeInFlight = false;
      state.authAction = "";
      if (operation.id === generation) {
        if (pendingResync) {
          pendingResync = false;
          csrf = "";
          organization = "";
          await synchronizeRound("", Math.min(15000, operation.deadline - performance.now()), true);
          if (recoveryMessage && state.phase !== "unknown") state.message = recoveryMessage;
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
      state.phase === "authenticated" &&
      !!state.identity &&
      Date.now() - lastChecked > 30000
    )
      void quietIdentityCheck();
  }
  function onPageShow(event: PageTransitionEvent) {
    if (event.persisted && !disposed && identityEnabled) void synchronize();
  }
  function onPageHide() {
    if (state.logoutResult === "pending") state.logoutResult = "unconfirmed";
    quietController?.abort();
    quietController = undefined;
    generation += 1;
    controller.abort();
    controller = new AbortController();
    csrf = "";
    lastChecked = 0;
    pendingResync = false;
    pendingQuietCheck = false;
    clearIdentity();
    state.phase = "unknown";
    state.busy = false;
  }
  function onBroadcast(event: MessageEvent) {
    if (event.data !== "identity-changed" || disposed) return;
    if (writeInFlight) {
      pendingResync = true;
      clearIdentity();
      state.phase = "unknown";
      state.message = "其他标签页的身份已变更。正在等待当前操作完成，再重新确认会话。";
      return;
    }
    csrf = "";
    organization = "";
    state.logoutResult = "none";
    if (!identityEnabled) {
      clearIdentity();
      state.phase = "unknown";
      return;
    }
    void synchronize();
  }
  onMounted(() => {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel("knowladder-session");
      channel.addEventListener("message", onBroadcast);
    }
    window.addEventListener("focus", onWake);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("pagehide", onPageHide);
    identityTimer = window.setInterval(onWake, 30000);
    document.addEventListener("visibilitychange", onWake);
    if (identityEnabled && !state.busy) void synchronize();
  });
  onBeforeUnmount(() => {
    disposed = true;
    quietController?.abort();
    generation += 1;
    controller.abort();
    channel?.close();
    window.removeEventListener("focus", onWake);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("pagehide", onPageHide);
    window.clearInterval(identityTimer);
    document.removeEventListener("visibilitychange", onWake);
  });
  return {
    state,
    synchronize,
    mutate,
    businessRequest,
    globalRequest,
    setIdentityRequired,
    authenticationActionActive,
    confirmAuthentication,
    authenticationUncertain,
  };
}
