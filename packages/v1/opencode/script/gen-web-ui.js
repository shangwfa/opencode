const fs = require("fs")
const path = require("path")

const scriptDir = __dirname
const opencodeDir = path.resolve(scriptDir, "..")
const dist = path.resolve(opencodeDir, "../app/dist")
if (!fs.existsSync(dist)) {
  console.error("app/dist not found at", dist)
  process.exit(1)
}

const glob = (dir) => {
  let results = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) results = results.concat(glob(full))
    else results.push(full)
  }
  return results
}

const files = glob(dist)
  .map((f) => path.relative(dist, f).split(path.sep).join("/"))
  .filter((f) => !f.endsWith(".map"))
  .sort()

const imports = files.map((f, i) => {
  const spec = path.relative(opencodeDir, path.join(dist, f)).split(path.sep).join("/")
  return `import file_${i} from ${JSON.stringify("./" + spec)} with { type: "file" };`
})

const entries = files.map((f, i) => `  ${JSON.stringify(f)}: file_${i},`)

const content = [
  "// Import all files as file_$i with type: \"file\"",
  ...imports,
  "// Export with original mappings",
  "export default {",
  ...entries,
  "}",
].join("\n")

const outFile = path.join(opencodeDir, "opencode-web-ui.gen.ts")
fs.writeFileSync(outFile, content)
console.log(`Generated ${outFile} with ${files.length} files`)
