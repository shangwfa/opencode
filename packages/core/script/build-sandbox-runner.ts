import fs from "node:fs/promises"
import path from "node:path"
import { gzipSync } from "node:zlib"

const root = path.resolve(import.meta.dirname, "..")
const output = path.resolve(process.argv[2] ?? path.join(root, "dist/sandbox-runner.mjs.gz"))
const temporary = await fs.mkdtemp(path.join(root, ".sandbox-runner-build-"))
try {
  // Resolve dependencies from core, as the sandbox Dockerfile does for its build stage.
  const entry = path.join(temporary, "runner.ts")
  await fs.copyFile(path.join(root, "../containers/sandbox/opt/codemode-runner.ts"), entry)
  const result = await Bun.build({ entrypoints: [entry], target: "node", format: "esm", minify: true })
  if (!result.success || !result.outputs[0]) throw new Error(`Sandbox runner build failed: ${result.logs.join("\n")}`)
  const packed = gzipSync(await result.outputs[0].arrayBuffer())
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, packed)
  console.log(`Sandbox runner: ${output}, ${packed.length} compressed bytes`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  await fs.rm(path.join(temporary, "runner.ts"), { force: true })
  await fs.rmdir(temporary)
}
