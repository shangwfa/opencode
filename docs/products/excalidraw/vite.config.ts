import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { excalidrawServer } from "./server/plugin.ts"

// https://vite.dev/config/
export default defineConfig({
  plugins: [excalidrawServer(), react(), tailwindcss()],
  server: { host: true, port: 5190, strictPort: true },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
