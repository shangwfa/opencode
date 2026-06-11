import { Sandbox, ConnectionConfig } from "@alibaba-group/opensandbox"

const DOMAIN = "172.18.32.15:30040"
const API_KEY = "H68idVYzjadx"
const IMAGE = "crpi-hlpnu8kiweghie0r.cn-hangzhou.personal.cr.aliyuncs.com/shangwfa/opencode-sandbox:latest"

const cfg = new ConnectionConfig({
  domain: DOMAIN,
  protocol: "http",
  apiKey: API_KEY,
  useServerProxy: false,
  requestTimeoutSeconds: 300,
})

async function exec(sb: Sandbox, command: string, label: string) {
  console.log(`\n========== ${label} ==========`)
  const result = await sb.commands.run(command, { timeoutSeconds: 180 })
  console.log(result.logs.stdout)
  if (result.logs.stderr) console.log("[stderr]", result.logs.stderr)
  return result
}

async function waitReady(sb: Sandbox, maxRetries = 30) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await sb.commands.run("echo ready", { timeoutSeconds: 10 })
      return
    } catch {
      console.log(`Waiting for sandbox to be ready... (${i + 1}/${maxRetries})`)
      await new Promise(r => setTimeout(r, 10000))
    }
  }
  throw new Error("Sandbox not ready after max retries")
}

async function main() {
  console.log("Creating sandbox with image:", IMAGE)
  const sb = await Sandbox.create({
    connectionConfig: cfg,
    image: IMAGE,
    timeoutSeconds: 3600,
  })
  console.log("Sandbox created:", sb.id)

  try {
    console.log("Waiting for sandbox to be ready (image pull may take a while)...")
    await waitReady(sb)
    console.log("Sandbox is ready!")

    // ── 一、环境切换 ──

    await exec(sb, "mise --version && echo --- && mise ls", "T24.1 mise 安装与预装版本")

    await exec(sb, "node --version && pnpm --version && npm --version && npm config get registry", "T24.2 默认版本验证")

    await exec(sb, "mkdir -p /workspace/t3 && cd /workspace/t3 && mise use node@20 2>&1 && node --version", "T24.3 mise use 切换 Node")

    await exec(sb, "mkdir -p /workspace/t4 && cd /workspace/t4 && mise use npm:pnpm@9 2>&1 && pnpm --version", "T24.4 mise use 切换 pnpm")

    await exec(sb, "mkdir -p /workspace/nvmrc-test && echo 20 > /workspace/nvmrc-test/.nvmrc && cd /workspace/nvmrc-test && node --version", "T24.5 .nvmrc 自动检测")

    await exec(sb, "mkdir -p /workspace/nv-test && echo 22 > /workspace/nv-test/.node-version && cd /workspace/nv-test && node --version", "T24.6 .node-version 自动检测")

    await exec(sb, 'mkdir -p /workspace/mise-test && printf \'[tools]\\nnode = "18"\\n"npm:pnpm" = "8"\\n\' > /workspace/mise-test/mise.toml && cd /workspace/mise-test && node --version && pnpm --version', "T24.7 mise.toml 自动检测")

    await exec(sb, "cd /workspace && mise use node@20 npm:pnpm@9 2>&1 && echo node=$(node --version) pnpm=$(pnpm --version) && npm create vite@5 switch-test -- --template react-ts 2>&1 | tail -1 && cd switch-test && pnpm install 2>&1 | grep -E 'Packages:|done'", "T24.8 切换版本后 pnpm install")

    await exec(sb, 'mkdir -p /workspace/proj-a && cd /workspace/proj-a && mise use node@18 2>&1 && echo "proj-a: $(node --version)" && mkdir -p /workspace/proj-b && cd /workspace/proj-b && echo "proj-b: $(node --version)"', "T24.9 不同目录版本独立")

    // ── 二、预装依赖缓存 ──

    await exec(sb, "npm config get cache && du -sh /opt/package-cache-base/npm && ls /opt/package-cache-base/npm/_cacache/content-v2/sha512/ | wc -l", "T24.10 npm cache 预装内容")

    await exec(sb, 'for d in /opt/preload/*/; do name=$(basename $d); mods=$(ls $d/node_modules 2>/dev/null | wc -l); size=$(du -sh $d/node_modules 2>/dev/null | cut -f1); echo "$name: $mods packages, $size"; done', "T24.11 预装 node_modules")

    await exec(sb, "cd /workspace && npm create vite@5 pnpm-test -- --template react-ts 2>&1 | tail -1 && cd pnpm-test && time pnpm install 2>&1 | grep -E 'Packages:|done|real'", "T24.12 pnpm install（Vite 5 首次）")

    await exec(sb, "cd /workspace/pnpm-test && rm -rf node_modules && time pnpm install 2>&1 | grep -E 'reused|downloaded|Packages|real'", "T24.13 pnpm 重装")

    await exec(sb, "cd /workspace && npm create vite@5 npm-test -- --template react-ts 2>&1 | tail -1 && cd npm-test && cp -a /opt/preload/vite5/node_modules . && time npm install --prefer-offline 2>&1 | tail -5", "T24.14 npm cp + install")

    await exec(sb, "cd /workspace/npm-test && rm -rf node_modules && time npm install --prefer-offline 2>&1 | tail -5", "T24.15 npm 重装")

    await exec(sb, "cd /workspace && mkdir -p cross-ver && cd cross-ver && mise use node@20 2>&1 && echo node=$(node --version) && npm create vite@5 cache-share -- --template react-ts 2>&1 | tail -1 && cd cache-share && cp -a /opt/preload/vite5/node_modules . && time npm install --prefer-offline 2>&1 | tail -5", "T24.16 npm cache 跨版本共享")

    // ── 三、对照组 ──

    await exec(sb, "cd /workspace && npm create vite@5 with-cache -- --template react-ts 2>&1 | tail -1 && cd with-cache && time npm install --prefer-offline 2>&1 | tail -5", "对照A：有 cache 无 node_modules")

    await exec(sb, "rm -rf /opt/package-cache-base/npm/* && cd /workspace && npm create vite@5 no-cache -- --template react-ts 2>&1 | tail -1 && cd no-cache && time npm install 2>&1 | tail -5", "对照B：无 cache 无 node_modules（裸装）")

    // ── 四、隔离性 ──

    await exec(sb, 'mkdir -p /workspace/express-test && cd /workspace/express-test && echo \'{"name":"express-test","dependencies":{"express":"^4.21.0"}}\' > package.json && pnpm install 2>&1 | grep -E "Packages:|done|ERR"', "T24.20 不匹配项目 fallback")

    await exec(sb, 'mkdir -p /workspace/bin-test && cd /workspace/bin-test && cp -a /opt/preload/vite5/node_modules . && echo \'{"name":"bin-test"}\' > package.json && node_modules/.bin/vite --version 2>&1', "T24.22 cp -a .bin 软链接")

    await exec(sb, "df -h / && echo --- && du -sh /opt/preload /opt/package-cache-base/npm /root/.local/share/mise 2>/dev/null", "T24.23 容器磁盘空间")

    console.log("\n========== 全部测试完成 ==========")
  } finally {
    console.log("\nCleaning up sandbox:", sb.id)
    await sb.kill()
    await sb.close()
    console.log("Done")
  }
}

main().catch((e) => {
  console.error("Fatal:", e)
  process.exit(1)
})
