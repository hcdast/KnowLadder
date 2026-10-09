import { resolveFeatureFlags } from './runtime/feature-flags';
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  resolveFeatureFlags(env);
  const production = env.NODE_ENV === "production";
  const mongoUri = env.MONGODB_URI;
  if (!mongoUri || !/^mongodb(?:\+srv)?:\/\//.test(mongoUri))
    throw new Error("必须配置 MONGODB_URI");
  const origin = env.APP_ORIGIN;
  if (!origin) throw new Error("必须配置 APP_ORIGIN");
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("APP_ORIGIN 必须是完整同源地址且不含路径");
  if (
    production &&
    (url.protocol !== "https:" || env.ALLOW_INSECURE_HTTP === "true")
  )
    throw new Error("生产环境必须使用 HTTPS");
  if (
    !production &&
    url.protocol === "http:" &&
    env.ALLOW_INSECURE_HTTP !== "true"
  )
    throw new Error("本机 HTTP 必须显式允许");
  const rateLimitKey = env.AUTH_RATE_LIMIT_KEY;
  if (!rateLimitKey || Buffer.byteLength(rateLimitKey) < 32)
    throw new Error("AUTH_RATE_LIMIT_KEY 至少32字节");
  const number = (
    name: string,
    fallback: number,
    min = 1,
    max = 2147483647,
  ) => {
    const raw = env[name];
    if (raw !== undefined && !/^\d+$/.test(raw))
      throw new Error(`${name} 必须是整数`);
    const n = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(n) || n < min || n > max)
      throw new Error(`${name} 超出范围`);
    return n;
  };
  const idleMs = number("SESSION_IDLE_MS", 1800000);
  const absoluteMs = number("SESSION_ABSOLUTE_MS", 28800000);
  const touchMs = number("SESSION_TOUCH_MS", 60000);
  if (idleMs > absoluteMs || touchMs >= idleMs)
    throw new Error("会话时间必须满足 touch < idle <= absolute");
  const topologyRaw = env.KL_MONGO_TOPOLOGY ?? "replicaSet";
  if (!["replicaSet", "standalone", "auto"].includes(topologyRaw)) {
    throw new Error("KL_MONGO_TOPOLOGY 必须是 replicaSet、standalone 或 auto");
  }
  const mongoAllowStandalone = env.KL_MONGO_ALLOW_STANDALONE === "true";
  if (production && mongoAllowStandalone) {
    throw new Error("生产环境禁止 KL_MONGO_ALLOW_STANDALONE");
  }
  if (production && topologyRaw !== "replicaSet") {
    throw new Error("生产环境 KL_MONGO_TOPOLOGY 必须为 replicaSet");
  }
  return {
    mongoUri,
    mongoTopology: topologyRaw as "replicaSet" | "standalone" | "auto",
    mongoAllowStandalone,
    origin,
    port: number("PORT", 3000, 1, 65535),
    production,
    rateLimitKey,
    preauthMs: number("SESSION_PREAUTH_MS", 600000),
    idleMs,
    absoluteMs,
    touchMs,
    temporaryPasswordMs: number("TEMPORARY_PASSWORD_MS", 86400000),
    trustProxy: number("TRUST_PROXY", 0, 0, 10),
    secureCookie: url.protocol === "https:",
  };
}
export type AppConfig = ReturnType<typeof loadConfig>;
