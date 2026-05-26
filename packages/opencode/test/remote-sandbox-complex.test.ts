import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox"

const config = new ConnectionConfig({
  domain: process.env.OPENCODE_SANDBOX_DOMAIN!,
  protocol: "http",
  apiKey: process.env.OPENCODE_SANDBOX_API_KEY,
})

const image = process.env.OPENCODE_SANDBOX_IMAGE!

async function main() {
  console.log("=== Remote Sandbox: Complex Task Test ===\n")

  const sb = await Sandbox.create({
    connectionConfig: config,
    image,
    timeoutSeconds: 300,
  })
  console.log(`[1] Sandbox created, id=${sb.id}\n`)

  // Step 2: Write a Python project
  console.log("[2] Writing project files...")
  await sb.files.createDirectories([{ path: "/workspace/project", mode: 755 }])

  await sb.files.writeFiles([
    { path: "/workspace/project/main.py", data: `import json
import sys
from datetime import datetime

def fibonacci(n):
    if n <= 1:
        return n
    a, b = 0, 1
    for _ in range(2, n + 1):
        a, b = b, a + b
    return b

def generate_report(count):
    results = []
    for i in range(count):
        results.append({
            "index": i,
            "fibonacci": fibonacci(i),
        })
    report = {
        "title": "Fibonacci Sequence Report",
        "generated_at": datetime.now().isoformat(),
        "count": count,
        "results": results,
        "sum": sum(r["fibonacci"] for r in results),
    }
    return report

if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    report = generate_report(n)
    print(json.dumps(report, indent=2))
`, mode: 644 },
    { path: "/workspace/project/requirements.txt", data: "pytest==7.4.0\n", mode: 644 },
    { path: "/workspace/project/test_main.py", data: `import json
import subprocess

def test_fibonacci_output():
    result = subprocess.run(
        ["python3", "main.py", "10"],
        capture_output=True, text=True, cwd="/workspace/project"
    )
    assert result.returncode == 0
    data = json.loads(result.stdout)
    assert data["count"] == 10
    assert data["results"][0]["fibonacci"] == 0
    assert data["results"][1]["fibonacci"] == 1
    assert data["results"][9]["fibonacci"] == 34
    assert data["sum"] == 88
    print("PASS: fibonacci output correct")

def test_large_fibonacci():
    result = subprocess.run(
        ["python3", "main.py", "30"],
        capture_output=True, text=True, cwd="/workspace/project"
    )
    data = json.loads(result.stdout)
    assert data["results"][29]["fibonacci"] == 514229
    print("PASS: large fibonacci correct")

if __name__ == "__main__":
    test_fibonacci_output()
    test_large_fibonacci()
    print("\\nAll tests passed!")
`, mode: 644 },
  ])
  console.log("  ✓ Project files written\n")

  // Step 3: List files
  console.log("[3] Listing project files...")
  const files = await sb.files.search({ path: "/workspace/project", pattern: "*" })
  for (const f of files) {
    console.log(`  ${f.path} (${f.type})`)
  }
  console.log()

  // Step 4: Run the Python script
  console.log("[4] Running main.py 15...")
  const r1 = await sb.commands.run("cd /workspace/project && python3 main.py 15")
  const output1 = r1.logs.stdout.map((l: any) => l.text).join("")
  console.log(`  exitCode=${r1.exitCode}`)
  const report = JSON.parse(output1)
  console.log(`  title: ${report.title}`)
  console.log(`  count: ${report.count}`)
  console.log(`  sum:   ${report.sum}`)
  console.log(`  last fib: ${report.results[report.results.length - 1].fibonacci}`)
  console.log()

  // Step 5: Run tests
  console.log("[5] Running tests...")
  const r2 = await sb.commands.run("cd /workspace/project && python3 test_main.py")
  console.log(`  ${r2.logs.stdout.map((l: any) => l.text).join("")}`)
  console.log(`  exitCode=${r2.exitCode}`)
  console.log()

  // Step 6: Edit file and re-run
  console.log("[6] Editing main.py — adding caching...")
  const content = await sb.files.readFile("/workspace/project/main.py")
  const patched = content.replace(
    "def fibonacci(n):",
    `_cache = {}
def fibonacci(n):
    if n in _cache:
        return _cache[n]
`
  ).replace(
    "    return b\n",
    "    _cache[n] = b\n    return b\n"
  )
  await sb.files.writeFiles([{ path: "/workspace/project/main.py", data: patched }])
  console.log("  ✓ File patched")

  const r3 = await sb.commands.run("cd /workspace/project && python3 main.py 30")
  const output3 = JSON.parse(r3.logs.stdout.map((l: any) => l.text).join(""))
  console.log(`  count: ${output3.count}, last fib: ${output3.results[29].fibonacci}`)
  console.log()

  // Step 7: Install deps + system info
  console.log("[7] System info...")
  const r4 = await sb.commands.run("pip3 install pytest -q 2>/dev/null; python3 --version; df -h /workspace; free -h | head -2; nproc")
  console.log(`  ${r4.logs.stdout.map((l: any) => l.text).join("")}`)

  // Cleanup
  console.log("\n[8] Destroying sandbox...")
  await sb.files.deleteDirectories(["/workspace/project"])
  await sb.kill()
  await sb.close()
  console.log("  ✓ Cleaned up")
  console.log("\n=== All steps completed ===")
}

main().catch((err) => {
  console.error("Failed:", err?.message ?? err)
  if (err?.error) console.error("  code:", err.error.code)
  process.exit(1)
})
