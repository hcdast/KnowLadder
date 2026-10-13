import { isIP } from "node:net";

export interface EmailConfig {
  actionsEnabled: boolean;
  registrationEnabled: boolean;
  smtp: { host: string; port: number; secure: boolean; user: string; password: string; from: string } | null;
  mailEncryptionKey: Buffer | null;
  keyId: string;
  termsVersion: string;
  privacyVersion: string;
  termsUrl: string;
  privacyUrl: string;
}
const invalid = (name: string): never => { throw Error("AUTH_EMAIL_CONFIG_INVALID_" + name); };
function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  if (env[name] !== undefined && env[name] !== "true" && env[name] !== "false") invalid(name);
  return env[name] === "true";
}
export function loadEmailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  const actionsEnabled = flag(env, "KL_AUTH_EMAIL_ENABLED");
  const registrationEnabled = flag(env, "KL_PUBLIC_REGISTRATION_ENABLED");
  if (registrationEnabled && !actionsEnabled) invalid("REGISTRATION_DEPENDENCY");
  const config: EmailConfig = { actionsEnabled, registrationEnabled, smtp: null, mailEncryptionKey: null,
    keyId: "", termsVersion: "", privacyVersion: "", termsUrl: "", privacyUrl: "" };
  // Disabled email actions must not invalidate historical username/email-password login.
  if (!actionsEnabled) return config;
  const text = (name: string) => {
    const value = env[name]?.trim();
    if (!value || value.length > 512 || /[\r\n\x00]/.test(value)) invalid(name);
    return value!;
  };
  const host = text("SMTP_HOST");
  if (!isIP(host) && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) invalid("SMTP_HOST");
  const portText = text("SMTP_PORT"), port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== portText) invalid("SMTP_PORT");
  if (env.SMTP_SECURE !== undefined && env.SMTP_SECURE !== "true" && env.SMTP_SECURE !== "false") invalid("SMTP_SECURE");
  const secure = env.SMTP_SECURE === undefined ? port === 465 : env.SMTP_SECURE === "true";
  const user = text("SMTP_USER"), password = env.SMTP_PASSWORD;
  if (!password || password.length > 4096 || /[\r\n\x00]/.test(password)) invalid("SMTP_PASSWORD");
  const from = text("SMTP_FROM");
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(from)) invalid("SMTP_FROM");
  const key = text("AUTH_MAIL_ENCRYPTION_KEY");
  if (!/^[0-9a-fA-F]{64}$/.test(key)) invalid("AUTH_MAIL_ENCRYPTION_KEY");
  const keyId = text("AUTH_MAIL_ENCRYPTION_KEY_ID");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) invalid("AUTH_MAIL_ENCRYPTION_KEY_ID");
  const version = (name: string) => {
    const value = text(name);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) invalid(name);
    return value;
  };
  const url = (name: string) => {
    const value = text(name);
    let parsed: URL;
    try { parsed = new URL(value); } catch { return invalid(name); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) invalid(name);
    return parsed.href;
  };
  // The canonical application origin, never Host or request returnTo, supplies links.
  const origin = text("APP_ORIGIN");
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return invalid("APP_ORIGIN"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if ((parsed.protocol !== "https:" && !(env.NODE_ENV !== "production" && env.ALLOW_INSECURE_HTTP === "true" && loopback && parsed.protocol === "http:")) || parsed.origin !== origin || parsed.username || parsed.password) invalid("APP_ORIGIN");
  return { ...config, smtp: { host, port, secure, user, password: password!, from },
    mailEncryptionKey: Buffer.from(key, "hex"), keyId,
    termsVersion: version("AUTH_TERMS_VERSION"), privacyVersion: version("AUTH_PRIVACY_VERSION"),
    termsUrl: url("AUTH_TERMS_URL"), privacyUrl: url("AUTH_PRIVACY_URL") };
}
