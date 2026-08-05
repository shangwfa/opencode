/// <reference types="node" />
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { appendFileSync } from "node:fs"

const LOG = "/tmp/session-team-ui-proxy.log"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3101,
    proxy: {
      "/opencode": {
        target: "http://127.0.0.1:14096",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/opencode/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (_proxyReq, req) => {
            appendFileSync(LOG, `${new Date().toISOString()} REQ ${req.method} ${req.url}\n`)
          })
          proxy.on("proxyRes", (proxyRes, req) => {
            appendFileSync(LOG, `${new Date().toISOString()} RES ${proxyRes.statusCode} ${req.method} ${req.url}\n`)
          })
          proxy.on("error", (err, req) => {
            appendFileSync(LOG, `${new Date().toISOString()} ERR ${req.method} ${req.url} ${err.message}\n`)
          })
        },
      },
    },
  },
})
