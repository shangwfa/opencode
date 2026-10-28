/**
 * node 运行时构建：esbuild 打包为单文件 ESM。
 * banner 注入 createRequire —— 修复 CJS 依赖（prom-client 等）在 ESM 产物中的 dynamic require。
 * 用法：bun run scripts/build-node.mjs [entry] [outfile]
 */
import * as esbuild from "esbuild"

const entry = process.argv[2] ?? "src/server.ts"
const outfile = process.argv[3] ?? "dist/server.js"

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile,
  banner: {
    js: [
      "import { createRequire } from 'module';",
      "const require = createRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
})

console.log(`[build-node] ${entry} -> ${outfile}`)
