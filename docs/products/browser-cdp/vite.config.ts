import { defineConfig } from "vite"
import path from "node:path"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { browserCdp } from "./server/plugin.ts"

export default defineConfig({
  plugins: [react(), tailwindcss(), browserCdp()],
  server: {
    // 双栈监听：默认仅 ::1，IPv4 解析（127.0.0.1）会 ECONNREFUSED 导致浏览器 WS 异常
    host: true,
    port: 5174,
    allowedHosts: ["host.docker.internal", "localhost", "127.0.0.1"],
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
})
