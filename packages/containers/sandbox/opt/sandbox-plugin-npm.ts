import { mkdir } from "node:fs/promises"
import path from "node:path"

const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i

export function packageName(spec: string) {
  const value = spec.trim()
  const split = value.startsWith("@") ? value.indexOf("@", value.indexOf("/") + 1) : value.indexOf("@")
  const name = split === -1 ? value : value.slice(0, split)
  if (!PACKAGE.test(name)) throw new Error(`Unsupported npm plugin spec: ${spec}`)
  return name
}

export async function installNpmPlugin(spec: string, directory: string) {
  const name = packageName(spec)
  await mkdir(directory, { recursive: true })
  const manifest = Bun.file(path.join(directory, "package.json"))
  if (!(await manifest.exists())) await Bun.write(manifest, JSON.stringify({ private: true }))

  const process = Bun.spawn(["bun", "add", "--cwd", directory, "--exact", spec], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => process.kill(), 120_000)
  const [stdout, stderr, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]).finally(() => clearTimeout(timer))
  if (exit !== 0) throw new Error(`Failed to install ${spec}: ${(stderr || stdout).trim().slice(-2000)}`)

  return Bun.resolveSync(name, path.join(directory, "index.ts"))
}
