import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SKILLS_ROOT = path.resolve(__dirname, "..")

// ── skills catalog middleware ──────────────────────────────────────────────
// 扫描 docs/test-cases/skills 下的 SKILL.md，返回技能目录与 bundle 内容。
// 顶层 bundle: mastra, humanize-ppt, loop-engineering, ui-ux-pro-max
// 嵌套集合: mattpocock/* (每个子目录一个 skill)

const SKIP_FILES = new Set(["SKILL.md", ".DS_Store"])
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", "agents", "tests"])

type SkillResource = { path: string; type: "doc" | "script" | "template" | "asset"; content: string }

interface CatalogEntry {
  key: string
  name: string
  description: string
  resourceCount: number
  totalBytes: number
  bundle: string // 所属 bundle（嵌套集合的根目录），单 bundle 时与 key 相同
}

function parseFrontmatter(text: string): { name?: string; description?: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return {}
  const name = m[1].match(/^name:\s*(.+)$/m)?.[1]?.trim()
  const descBlock = m[1].match(/^description:\s*>-?\s*\n((?:\s+.+\n?)+)/m)?.[1]
  const descInline = m[1].match(/^description:\s*"?(.+?)"?\s*$/m)?.[1]
  const description = descBlock
    ? descBlock.split("\n").map((l) => l.trim()).filter(Boolean).join(" ")
    : descInline?.trim()
  return { name, description }
}

function resourceKind(rel: string): SkillResource["type"] {
  if (rel.startsWith("templates/")) return "template"
  if (rel.startsWith("references/")) return "doc"
  const ext = path.extname(rel)
  if ([".md", ".mdx", ".txt"].includes(ext)) return "doc"
  if ([".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].includes(ext)) return "script"
  return "asset"
}

function collectResources(skillDir: string): SkillResource[] {
  const out: SkillResource[] = []
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(full, rel)
        continue
      }
      if (SKIP_FILES.has(entry.name)) continue
      try {
        const content = fs.readFileSync(full, "utf8")
        out.push({ path: rel.split(path.sep).join("/"), type: resourceKind(rel.split(path.sep).join("/")), content })
      } catch {
        // 二进制或读取失败跳过
      }
    }
  }
  walk(skillDir, "")
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

function buildCatalog(): CatalogEntry[] {
  const entries: CatalogEntry[] = []
  for (const top of fs.readdirSync(SKILLS_ROOT, { withFileTypes: true })) {
    if (!top.isDirectory() || top.name === "ui-demo") continue
    const topDir = path.join(SKILLS_ROOT, top.name)
    const topSkillMd = path.join(topDir, "SKILL.md")

    // 顶层直接有 SKILL.md → 单 bundle
    if (fs.existsSync(topSkillMd)) {
      const fm = parseFrontmatter(fs.readFileSync(topSkillMd, "utf8"))
      const resources = collectResources(topDir)
      const totalBytes = resources.reduce((s, r) => s + Buffer.byteLength(r.content), 0)
      entries.push({
        key: top.name,
        name: fm.name ?? top.name,
        description: fm.description ?? "",
        resourceCount: resources.length,
        totalBytes,
        bundle: top.name,
      })
      continue
    }

    // 嵌套集合（如 mattpocock/*）
    for (const sub of fs.readdirSync(topDir, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue
      const subDir = path.join(topDir, sub.name)
      const subSkillMd = path.join(subDir, "SKILL.md")
      if (!fs.existsSync(subSkillMd)) continue
      const fm = parseFrontmatter(fs.readFileSync(subSkillMd, "utf8"))
      const resources = collectResources(subDir)
      const totalBytes = resources.reduce((s, r) => s + Buffer.byteLength(r.content), 0)
      entries.push({
        key: `${top.name}/${sub.name}`,
        name: fm.name ?? sub.name,
        description: fm.description ?? "",
        resourceCount: resources.length,
        totalBytes,
        bundle: top.name,
      })
    }
  }
  return entries.sort((a, b) => a.key.localeCompare(b.key))
}

function loadBundle(key: string) {
  const skillDir = path.join(SKILLS_ROOT, key)
  if (!skillDir.startsWith(SKILLS_ROOT)) return null
  const skillMd = path.join(skillDir, "SKILL.md")
  if (!fs.existsSync(skillMd)) return null
  const content = fs.readFileSync(skillMd, "utf8")
  const fm = parseFrontmatter(content)
  return {
    name: fm.name ?? path.basename(skillDir),
    description: fm.description ?? "",
    content,
    resources: collectResources(skillDir),
  }
}

function skillsApiPlugin(): Plugin {
  return {
    name: "skills-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next()

        if (req.url === "/api/skills/catalog") {
          try {
            const catalog = buildCatalog()
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify(catalog))
          } catch (e) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(e) }))
          }
          return
        }

        const bundleMatch = req.url.match(/^\/api\/skills\/bundle\/(.+)$/)
        if (bundleMatch) {
          const key = decodeURIComponent(bundleMatch[1])
          const bundle = loadBundle(key)
          if (!bundle) {
            res.statusCode = 404
            res.end(JSON.stringify({ error: `skill not found: ${key}` }))
            return
          }
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify(bundle))
          return
        }

        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), skillsApiPlugin()],
  server: {
    port: 3100,
    proxy: {
      "/opencode": {
        target: "http://localhost:14096",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/opencode/, ""),
      },
    },
  },
})
