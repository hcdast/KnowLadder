import { shallowRef } from "vue";
import { ApiError } from "../session";
import type { paths } from "../api/schema";

export type EmailPurpose = "register" | "bind" | "reset" | "invite";
export type EmailCapabilities = paths["/api/v1/auth/capabilities"]["get"]["responses"][200]["content"]["application/json"]["data"];
export type ActivationResult = paths["/api/v1/auth/activate-email"]["post"]["responses"][200]["content"]["application/json"]["data"];
export type InvitationInspection = paths["/api/v1/auth/invitations/inspect"]["post"]["responses"][200]["content"]["application/json"]["data"];
export type EmailAction =
  | "/auth/register-email" | "/auth/activate-email"
  | "/auth/password-reset/request" | "/auth/password-reset/confirm"
  | "/auth/email-binding/request" | "/auth/email-binding/confirm" | "/auth/email-binding/remove"
  | "/auth/invitations/inspect" | "/auth/invitations/accept" | "/auth/invitations/activate";
const actions: Record<EmailAction, true> = {
  "/auth/register-email": true, "/auth/activate-email": true, "/auth/password-reset/request": true, "/auth/password-reset/confirm": true,
  "/auth/email-binding/request": true, "/auth/email-binding/confirm": true, "/auth/email-binding/remove": true,
  "/auth/invitations/inspect": true, "/auth/invitations/accept": true, "/auth/invitations/activate": true,
};
/** Same-origin, bounded requests only. CSRF is obtained for the browser's actual current cookie, never cached here. */
export function createEmailClient(): EmailClient {
  async function round<T>(action: EmailAction | "/auth/capabilities", body: unknown, signal?: AbortSignal, budget = 15000): Promise<T> {
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = window.setTimeout(() => controller.abort(new DOMException("邮件操作超时", "TimeoutError")), Math.max(0, budget));
    async function fetchData<R>(path: string, data?: unknown, csrf?: string): Promise<R> {
      const response = await fetch(`/api/v1${path}`, {
        method: data === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: controller.signal,
        headers: { Accept: "application/json", ...(data === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrf || "" }) },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      const payload = response.status === 204 ? undefined : await response.json();
      if (!response.ok) throw new ApiError(response.status, payload?.error?.message || "邮件操作未完成。", payload?.error?.fields,
        response.headers.get("Retry-After") || "", payload?.request_id || "", payload?.error?.code || "", payload?.error?.operation_id || "");
      return payload?.data as R;
    }
    try {
      if (budget <= 0) controller.abort(new DOMException("邮件操作超时", "TimeoutError"));
      if (action === "/auth/capabilities") return await fetchData<T>(action);
      if (!Object.hasOwn(actions, action)) throw new Error("无效邮箱动作");
      const csrf = await fetchData<{ csrf_token: string }>("/auth/csrf");
      if (!csrf?.csrf_token) throw new Error("无法确认当前安全凭据，请重新查询会话。");
      return await fetchData<T>(action, body, csrf.csrf_token);
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      window.clearTimeout(timer); signal?.removeEventListener("abort", cancel);
    }
  }
  return {
    capabilities: (signal?: AbortSignal) => round<EmailCapabilities>("/auth/capabilities", undefined, signal),
    post: <T = void>(action: EmailAction, body: unknown, signal?: AbortSignal, budget?: number) => round<T>(action, body, signal, budget),
  };
}
export interface EmailClient {
  capabilities(signal?: AbortSignal): Promise<EmailCapabilities>;
  post<T = void>(action: EmailAction, body: unknown, signal?: AbortSignal, budget?: number): Promise<T>;
}
export function hasEmailTokenFragment(hash: string): boolean {
  return new URLSearchParams(hash.replace(/^#/, "")).has("token");
}
/** App owns this single in-memory holder so an explicit login/logout does not lose a mail intent. */
export function createEmailFlow(): EmailFlow {
  let sequence = 0;
  const secret = shallowRef<{ purpose: EmailPurpose; token: string; expiresAt: number; scope: number }>();
  return {
    capture(path: string, hash: string): boolean {
      const purpose: EmailPurpose | undefined = path === "/reset-password" ? "reset" : path === "/accept-invitation" ? "invite" : path === "/verify-email" ? "register" : undefined;
      if (!purpose || !hash) return false;
      const fields = new URLSearchParams(hash.replace(/^#/, ""));
      const token = fields.get("token");
      const claimed = fields.get("purpose");
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token) || [...fields.keys()].some(key => key !== "token" && key !== "purpose") || fields.getAll("token").length !== 1 || fields.getAll("purpose").length > 1) return false;
      const actual = path === "/verify-email" && claimed === "bind" ? "bind" : purpose;
      if (claimed && claimed !== actual) return false;
      secret.value = { purpose: actual, token, scope: ++sequence, expiresAt: Date.now() + (actual === "invite" ? 7 * 86400000 : 15 * 60000) };
      return true;
    },
    read(purpose: EmailPurpose): string | undefined {
      if (secret.value && secret.value.expiresAt <= Date.now()) secret.value = undefined;
      return secret.value?.purpose === purpose ? secret.value.token : undefined;
    },
    get purpose() { if (secret.value && secret.value.expiresAt <= Date.now()) secret.value = undefined; return secret.value?.purpose; },
    get scope() { return secret.value?.scope ?? 0; },
    expireAt(value: string) { const at = Date.parse(value); if (secret.value && Number.isFinite(at)) secret.value.expiresAt = Math.min(secret.value.expiresAt, at); },
    clear() { secret.value = undefined; },
  };
}
export interface EmailFlow {
  capture(path: string, hash: string): boolean;
  read(purpose: EmailPurpose): string | undefined;
  readonly purpose: EmailPurpose | undefined;
  readonly scope: number;
  expireAt(value: string): void;
  clear(): void;
}

export function policyUrl(value: string | null | undefined): string | undefined {
  if (!value) return;
  try { const url = new URL(value, window.location.origin); if ((url.protocol === "https:" || url.origin === window.location.origin && url.protocol === "http:") && !url.username && !url.password && !url.hash) return url.href; } catch { /* Missing or unsafe policy URLs keep activation unavailable. */ }
}
export function retryAt(value: string): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Date.now() + seconds * 1000 : Math.max(Date.now(), Date.parse(value) || 0);
}
