import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox"

const config = new ConnectionConfig({
  domain: process.env.OPENCODE_SANDBOX_DOMAIN!,
  protocol: "http",
  apiKey: process.env.OPENCODE_SANDBOX_API_KEY,
  useServerProxy: true,
  requestTimeoutSeconds: 60,
})
const image = process.env.OPENCODE_SANDBOX_IMAGE!

type Result = {
  id: number
  name: string
  sandboxId: string
  durationMs: number
  checks: { label: string; pass: boolean; detail?: string }[]
  error?: string
}

const tasks: ((sb: Sandbox, id: number) => Promise<Result["checks"]>)[] = [
  // #1 最简单：echo
  async (sb, id) => {
    const r = await sb.commands.run("echo hello")
    const out = r.logs.stdout.map((l: any) => l.text).join("").trim()
    return [{ label: "echo", pass: out === "hello", detail: out }]
  },

  // #2 环境探测
  async (sb) => {
    const r = await sb.commands.run("uname -s && whoami && pwd")
    const out = r.logs.stdout.map((l: any) => l.text).join("")
    const parts = out.trim().split("\n")
    return [
      { label: "os", pass: parts[0] === "Linux" },
      { label: "user", pass: parts[1] === "root" },
      { label: "pwd", pass: parts[2] === "/workspace" },
    ]
  },

  // #3 算术运算
  async (sb) => {
    const r = await sb.commands.run("python3 -c 'print(2**20)'")
    const out = r.logs.stdout.map((l: any) => l.text).join("").trim()
    return [{ label: "2^20", pass: out === "1048576", detail: out }]
  },

  // #4 字符串处理
  async (sb) => {
    const r = await sb.commands.run("echo 'hello world foo bar' | tr ' ' '\\n' | sort | head -2 | tr '\\n' ' '")
    const out = r.logs.stdout.map((l: any) => l.text).join("").trim()
    return [{ label: "sort", pass: out === "bar foo", detail: out }]
  },

  // #5 文件写入+读取
  async (sb) => {
    const content = "test-content-" + Date.now()
    await sb.files.writeFiles([{ path: "/workspace/t5.txt", data: content }])
    const read = await sb.files.readFile("/workspace/t5.txt")
    return [{ label: "file-roundtrip", pass: read === content }]
  },

  // #6 多文件操作
  async (sb) => {
    for (let i = 0; i < 5; i++) {
      await sb.files.writeFiles([{ path: `/workspace/t6_${i}.txt`, data: `file-${i}` }])
    }
    const files = await sb.files.search({ path: "/workspace", pattern: "t6_*.txt" })
    return [{ label: "5-files", pass: files.length === 5, detail: `found ${files.length}` }]
  },

  // #7 目录创建+遍历
  async (sb) => {
    await sb.files.createDirectories([
      { path: "/workspace/t7/a/b/c", mode: 755 },
    ])
    await sb.files.writeFiles([{ path: "/workspace/t7/a/b/c/d.txt", data: "deep" }])
    const r = await sb.commands.run("find /workspace/t7 -type f")
    const count = r.logs.stdout.map((l: any) => l.text).join("").trim().split("\n").length
    return [{ label: "deep-dir", pass: count === 1, detail: `${count} files` }]
  },

  // #8 Python fibonacci(30)
  async (sb) => {
    const r = await sb.commands.run(
      `python3 -c "
def fib(n):
    a, b = 0, 1
    for _ in range(n): a, b = b, a + b
    return a
print(fib(30))
"`
    )
    const out = r.logs.stdout.map((l: any) => l.text).join("").trim()
    return [{ label: "fib30", pass: out === "832040", detail: out }]
  },

  // #9 Python JSON 生成+解析
  async (sb) => {
    const r = await sb.commands.run(
      `python3 -c "
import json
data = {'items': [{'id': i, 'val': i*i} for i in range(10)]}
print(json.dumps(data))
"`
    )
    const parsed = JSON.parse(r.logs.stdout.map((l: any) => l.text).join(""))
    return [
      { label: "json-parse", pass: parsed.items.length === 10 },
      { label: "json-val", pass: parsed.items[5].val === 25 },
    ]
  },

  // #10 Node.js 脚本执行
  async (sb) => {
    await sb.files.writeFiles([{
      path: "/workspace/t10.js",
      data: `const sum = Array.from({length: 100}, (_, i) => i + 1).reduce((a, b) => a + b, 0); console.log(sum)`,
    }])
    const r = await sb.commands.run("node /workspace/t10.js")
    const out = r.logs.stdout.map((l: any) => l.text).join("").trim()
    return [{ label: "node-sum-1to100", pass: out === "5050", detail: out }]
  },

  // #11 Python 写CSV + bash分析
  async (sb) => {
    await sb.commands.run(
      `python3 -c "
import csv, random
random.seed(42)
with open('/workspace/t11.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['name','score'])
    for i in range(100):
        w.writerow([f'student_{i}', random.randint(0, 100)])
"`
    )
    const r = await sb.commands.run("awk -F, 'NR>1{sum+=$2; n++} END{print sum/n}' /workspace/t11.csv")
    const avg = parseFloat(r.logs.stdout.map((l: any) => l.text).join("").trim())
    return [{ label: "csv-avg", pass: !isNaN(avg) && avg > 0 && avg < 100, detail: `avg=${avg.toFixed(1)}` }]
  },

  // #12 压缩+解压
  async (sb) => {
    await sb.commands.run(
      "mkdir -p /workspace/t12 && for i in $(seq 1 20); do echo \"line $i\" > /workspace/t12/file_$i.txt; done"
    )
    await sb.commands.run("cd /workspace && tar czf t12.tar.gz t12/")
    await sb.commands.run("rm -rf /workspace/t12")
    await sb.commands.run("cd /workspace && tar xzf t12.tar.gz")
    const r = await sb.commands.run("ls /workspace/t12/*.txt | wc -l")
    const count = parseInt(r.logs.stdout.map((l: any) => l.text).join("").trim())
    return [{ label: "tar-roundtrip", pass: count === 20, detail: `${count} files` }]
  },

  // #13 grep + 排序 + 去重
  async (sb) => {
    await sb.commands.run(
      "for i in $(seq 1 500); do echo \"log line $i error=$(($i % 3))\" >> /workspace/t13.log; done"
    )
    const r = await sb.commands.run("grep 'error=0' /workspace/t13.log | wc -l")
    const count = parseInt(r.logs.stdout.map((l: any) => l.text).join("").trim())
    return [{ label: "grep-count", pass: count === 167, detail: `${count} matches` }]
  },

  // #14 并发子进程
  async (sb) => {
    const r = await sb.commands.run(
      `python3 -c "
import concurrent.futures, math
def is_prime(n):
    if n < 2: return False
    for i in range(2, int(math.sqrt(n)) + 1):
        if n % i == 0: return False
    return True
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
    results = list(ex.map(is_prime, range(2, 1000)))
primes = [i for i, p in zip(range(2, 1000), results) if p]
print(len(primes))
"`
    )
    const out = r.logs.stdout.map((l: any) => l.text).join("").trim()
    return [{ label: "primes-to-1000", pass: out === "168", detail: out }]
  },

  // #15 HTTP请求（如果网络可用）
  async (sb) => {
    const r = await sb.commands.run("curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 https://httpbin.org/get 2>/dev/null || echo 'no-network'")
    const out = r.logs.stdout.map((l: any) => l.text).join("").trim()
    const ok = out === "200" || out === "'200'"
    return [{ label: "http-request", pass: ok, detail: out }]
  },

  // #16 Node.js 包安装+使用
  async (sb) => {
    await sb.commands.run("cd /workspace && mkdir -p t16 && cd t16 && npm init -y >/dev/null 2>&1 && npm install lodash --save >/dev/null 2>&1")
    await sb.files.writeFiles([{
      path: "/workspace/t16/index.js",
      data: `const _ = require('lodash'); console.log(_.chunk(['a','b','c','d'], 2).length)`,
    }])
    const r = await sb.commands.run("cd /workspace/t16 && node index.js")
    const out = r.logs.stdout.map((l: any) => l.text).join("").trim()
    return [{ label: "npm-install", pass: out === "2", detail: out }]
  },

  // #17 大文件生成+校验
  async (sb) => {
    await sb.commands.run("dd if=/dev/urandom of=/workspace/t17.bin bs=1M count=10 2>/dev/null")
    const r1 = await sb.commands.run("md5sum /workspace/t17.bin | awk '{print $1}'")
    const hash1 = r1.logs.stdout.map((l: any) => l.text).join("").trim()
    const r2 = await sb.commands.run("md5sum /workspace/t17.bin | awk '{print $1}'")
    const hash2 = r2.logs.stdout.map((l: any) => l.text).join("").trim()
    return [
      { label: "10mb-file", pass: hash1.length === 32 },
      { label: "md5-stable", pass: hash1 === hash2 },
    ]
  },

  // #18 Python multiprocessing 密集计算
  async (sb) => {
    await sb.files.writeFiles([{
      path: "/workspace/t18.py",
      data: `import math, time
def mandelbrot(c, max_iter=100):
    z = 0
    for i in range(max_iter):
        z = z*z + c
        if abs(z) > 2: return i
    return max_iter
t0 = time.time()
results = []
for x in [i/100 for i in range(-200, 100)]:
    for y in [i/100 for i in range(-150, 150)]:
        results.append(mandelbrot(complex(x, y)))
elapsed = time.time() - t0
print(f"{len(results)} points in {elapsed:.2f}s")
`,
    }])
    const r = await sb.commands.run("python3 /workspace/t18.py")
    const out = r.logs.stdout.map((l: any) => l.text).join("").trim()
    const pts = parseInt(out)
    return [{ label: "mandelbrot", pass: pts === 90000, detail: out }]
  },

  // #19 git 操作
  async (sb) => {
    await sb.commands.run(
      "cd /workspace && git init t19 && cd t19 && git config user.email 'test@test.com' && git config user.name 'test'"
    )
    await sb.commands.run("cd /workspace/t19 && for i in $(seq 1 10); do echo \"v$i\" >> file.txt; git add . && git commit -m \"commit $i\" >/dev/null 2>&1; done")
    const r = await sb.commands.run("cd /workspace/t19 && git log --oneline | wc -l")
    const count = parseInt(r.logs.stdout.map((l: any) => l.text).join("").trim())
    return [{ label: "git-10-commits", pass: count === 10, detail: `${count} commits` }]
  },

  // #20 综合全栈：Python后端 + Node前端 + 文件IO + 进程管理
  async (sb) => {
    await sb.files.writeFiles([
      {
        path: "/workspace/t20/server.py",
        data: `import http.server, json, threading

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        data = json.dumps({"status": "ok", "items": list(range(10))})
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(data.encode())
    def log_message(self, *args): pass

server = http.server.HTTPServer(("127.0.0.1", 18720), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
import time; time.sleep(999999)
`,
      },
    ])
    // Start server in background
    await sb.commands.run("python3 /workspace/t20/server.py &", undefined, {
      onStdout: () => {},
      onStderr: () => {},
    })
    await sb.commands.run("sleep 1")
    // Fetch from Node
    await sb.files.writeFiles([{
      path: "/workspace/t20/client.js",
      data: `const http = require('http');
http.get('http://127.0.0.1:18720/', (res) => {
  let data = '';
  res.on('data', (c) => data += c);
  res.on('end', () => {
    const j = JSON.parse(data);
    console.log(j.items.length);
  });
});`,
    }])
    const r = await sb.commands.run("node /workspace/t20/client.js")
    const out = r.logs.stdout.map((l: any) => l.text).join("").trim()
    return [{ label: "py-server+node-client", pass: out === "10", detail: out }]
  },
]

const taskNames = [
  "echo", "env-probe", "arithmetic", "string-sort", "file-rw",
  "multi-file", "deep-dir", "fibonacci", "json-gen", "node-exec",
  "csv-analysis", "tar-compress", "grep-count", "primes", "http-req",
  "npm-install", "10mb-file", "mandelbrot", "git-ops", "fullstack",
]

async function runTask(id: number): Promise<Result> {
  const start = Date.now()
  try {
    const sb = await Sandbox.create({
      connectionConfig: config,
      image,
      timeoutSeconds: 300,
      readyTimeoutSeconds: 60,
    })
    const checks = await tasks[id - 1](sb, id)
    await sb.kill()
    await sb.close()
    return {
      id,
      name: taskNames[id - 1],
      sandboxId: sb.id,
      durationMs: Date.now() - start,
      checks,
    }
  } catch (err: any) {
    return {
      id,
      name: taskNames[id - 1],
      sandboxId: "",
      durationMs: Date.now() - start,
      checks: [],
      error: err?.message ?? String(err),
    }
  }
}

async function main() {
  console.log(`=== 20 Concurrent Tasks (Simple → Complex) ===\n`)

  const start = Date.now()
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => runTask(i + 1))
  )
  const totalMs = Date.now() - start

  console.log("── Results ──────────────────────────────────────────────\n")
  for (const r of results) {
    if (r.error) {
      console.log(`  #${String(r.id).padStart(2)} ${r.name.padEnd(14)} ✗ ${r.error.slice(0, 80)}  (${r.durationMs}ms)`)
    } else {
      const all = r.checks.every((c) => c.pass)
      const icon = all ? "✓" : "△"
      const details = r.checks.map((c) =>
        c.pass ? c.label : `${c.label}✗${c.detail ? "(" + c.detail + ")" : ""}`
      ).join(" ")
      console.log(`  #${String(r.id).padStart(2)} ${r.name.padEnd(14)} ${icon} ${details}  (${r.durationMs}ms)`)
    }
  }

  const ok = results.filter((r) => !r.error && r.checks.every((c) => c.pass))
  const partial = results.filter((r) => !r.error && !r.checks.every((c) => c.pass))
  const fail = results.filter((r) => r.error)
  const totalChecks = results.reduce((s, r) => s + r.checks.length, 0)
  const passChecks = results.reduce((s, r) => s + r.checks.filter((c) => c.pass).length, 0)

  console.log("\n── Summary ──────────────────────────────────────────────")
  console.log(`  Tasks:     ${ok.length} pass, ${partial.length} partial, ${fail.length} fail / 20`)
  console.log(`  Checks:    ${passChecks}/${totalChecks}`)
  console.log(`  Wall time: ${(totalMs / 1000).toFixed(1)}s`)
  if (ok.length > 0) {
    const avg = Math.round(ok.concat(partial).reduce((s, r) => s + r.durationMs, 0) / (ok.length + partial.length))
    console.log(`  Avg/task:  ${avg}ms`)
  }

  process.exit(fail.length > 0 ? 1 : 0)
}

main()
