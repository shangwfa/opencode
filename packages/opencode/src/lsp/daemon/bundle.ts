import esbuild from "esbuild"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const production = !process.argv.includes("--watch")

async function main() {
  const ctx = await esbuild.context({
    entryPoints: [path.join(__dirname, "index.ts")],
    bundle: true,
    format: "cjs",
    target: "node18",
    platform: "node",
    outfile: path.join(__dirname, "../../../docker/opt/opencode-lsp-daemon/index.js"),
    minify: production,
    sourcemap: !production,
    external: [],
    banner: {
      js: "// opencode-lsp-daemon — bundled sandbox LSP agent\n",
    },
    logLevel: "info",
  })

  if (process.argv.includes("--watch")) {
    await ctx.watch()
    console.log("[watch] watching for changes...")
  } else {
    await ctx.rebuild()
    await ctx.dispose()
    console.log("[build] daemon bundled successfully")
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
