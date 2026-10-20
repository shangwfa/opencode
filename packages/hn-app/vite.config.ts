import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"

// 与源项目对齐：dev 端口 3001；
// OpenCode SaaS 地址运行时读 window.YD.API_URL，需求 API base 读 window.YD.BOSS_API_URL，
// dev 下由 vite 注入 /local-requirement 代理（xybot-front-opencode-ui 同款约定）。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: 3001,
    proxy: {
      "/local-requirement": {
        target: process.env.HARNESS_API_TARGET ?? "http://localhost:4111",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/local-requirement/, ""),
      },
    },
  },
})
