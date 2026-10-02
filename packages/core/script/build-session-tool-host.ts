import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"

// Compile trusted runtime assets at build time; SaaS never compiles/imports user tool source.
const root = path.resolve(import.meta.dirname, "..")
const output = path.resolve(process.argv[2] ?? path.join(root, "src/session/tool-host/artifacts"))
try {
  await fs.mkdir(output, { recursive: true })
  const files = []
  for (const name of ["host", "worker", "runtime"]) {
    const filename = `session-tool-${name}.mjs`
    const result = spawnSync(
      "bun",
      [
        "build",
        path.join(root, `src/session/tool-host/${name}.ts`),
        "--target=node",
        "--format=esm",
        `--outfile=${path.join(output, filename)}`,
      ],
      { encoding: "utf8" },
    )
    if (result.status !== 0) throw new Error(result.stderr || `Sandbox runtime build failed: ${name}`)
    const content = await fs.readFile(path.join(output, filename))
    files.push({ name: filename, hash: createHash("sha256").update(content).digest("hex"), bytes: content.length })
  }
  const hash = createHash("sha256").update(JSON.stringify(files)).digest("hex")
  await fs.writeFile(path.join(output, "manifest.json"), JSON.stringify({ hash, files }))
  console.log(`Session Tool runtime: ${files.length} files, artifact ${hash}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
