import { defineConfig } from 'vite'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudWindows } from './server/plugin.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudWindows()],
  server: {
    // AI 沙箱容器通过 host.docker.internal 访问本服务（浏览器操作 API）
    allowedHosts: ['host.docker.internal', 'localhost', '127.0.0.1'],
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
})
