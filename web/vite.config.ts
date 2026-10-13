import { defineConfig, loadEnv, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig(({ command, mode, isPreview }) => {
  const env = loadEnv(mode, ".", "KL_WEB_");
  const target = env.KL_WEB_API_TARGET || "http://127.0.0.1:3000";
  // Explicitly opt in for local development; builds and preview do not translate Origin.
  const apiOrigin = command === "serve" && mode === "development" && !isPreview
    ? env.KL_WEB_API_ORIGIN
    : undefined;
  if (apiOrigin) {
    const url = new URL(apiOrigin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== apiOrigin) {
      throw new Error("KL_WEB_API_ORIGIN 必须是线上 APP_ORIGIN 对应的完整 Origin，不能包含路径或凭据");
    }
  }
  const localOriginGuard: Plugin = {
    name: "local-api-origin-guard",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!/^\/api(?:\/|$)/.test(req.url || "")) return next();
        const address = server.httpServer?.address();
        const port = typeof address === "object" && address ? address.port : server.config.server.port || 5174;
        const localHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
        const localOrigin = `${server.config.server.https ? "https" : "http"}://${req.headers.host}`;
        if (!localHosts.includes(req.headers.host || "") ||
            req.headers["sec-fetch-site"] === "cross-site" ||
            (req.headers.origin !== undefined && req.headers.origin !== localOrigin)) {
          res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ error: { code: "DEV_PROXY_ORIGIN_REJECTED", message: "开发代理只接受本地页面的同源请求" } }));
          return;
        }
        next();
      });
    },
  };
  return {
    plugins: [vue(), ...(apiOrigin ? [localOriginGuard] : [])],
    server: {
      host: "127.0.0.1",
      port: 5174,
      strictPort: true,
      proxy: {
        "/api": {
          target,
          changeOrigin: true,
          ...(apiOrigin ? {
            configure(proxy) {
              proxy.on("proxyReq", (proxyReq, req) => {
                if (req.headers.origin) proxyReq.setHeader("Origin", apiOrigin);
              });
            },
          } : {}),
        },
      },
    },
  };
});
