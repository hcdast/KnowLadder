import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig(({ mode }) => ({
  plugins: [vue()],
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    proxy: { "/api": { target: loadEnv(mode, ".", "KL_WEB_").KL_WEB_API_TARGET || "http://127.0.0.1:3000", changeOrigin: false } },
  },
}));
