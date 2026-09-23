# 沙箱前端项目启动失败排查指南

> 基于会话 `ses_107ba5b7affeXhB2fPWKTGhqQA` 的实际排查过程总结，适用于远程沙箱环境。

## ⚠️ 铁律（必须遵守）

1. **必须杀进程 + 清缓存 + 重启 dev server + 监听 SSE 日志**，即使 dev server 已经在运行也不能跳过。只看进程是否存活无法发现启动时的 resolve/预构建错误，必须看 SSE stream。
2. **不要去排查 Proxy 层问题**（Content-Type 错误、路由错误等）。Proxy 返回 `text/html` 而非 `text/javascript` 是 Proxy 层的已知问题，不在沙箱内修复范畴。用 Pod IP 直连验证即可。
3. **不要跳步**：严格按"杀进程 → 重启 → 看 SSE → 定位错误类型 → 修复"的顺序执行，不要因为 dev server 在跑就去直接验证页面。

## 一、环境信息

| 项目 | 值 |
|------|------|
| 远程 API | `https://test-opencode.shadow-rpa.net` |
| 沙箱 ID | `917143a2-c160-48e1-b734-c94a2c34a82c` |
| 前端框架 | Vite 5 + React + pnpm |
| 启动命令 | `pnpm run dev --host -- --port 5174 --strictPort` |
| 访问方式 | 集群内网直连（`http://<pod-ip>:5174`）或 Proxy（`/session/:id/proxy/5174/`） |

**注意**：不能用 `localhost` 访问，只能用 `http://<pod-ip>:<port>` 形式验证。

## 二、排查工具链

### 2.1 远程 API 调用模板

```bash
BASE="https://test-opencode.shadow-rpa.net"
SID="ses_xxxxxxxxxxxxxxxxxxxx"

# 同步执行短命令
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo hello"}'

# 异步执行长驻进程（dev server）
curl -s --max-time 10 -X POST "$BASE/session/$SID/exec/async" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && pnpm run dev --host -- --port 5174 --strictPort","timeoutSeconds":0}'

# 监听 async exec 的 SSE 输出（关键！能看到启动错误）
curl -s -N --max-time 60 "$BASE/session/$SID/exec/<execId>/stream"

# 查询 exec 状态
curl -s "$BASE/session/$SID/exec/<execId>"

# 获取直连 endpoint
curl -s "$BASE/session/$SID/endpoint/5174"

# Proxy 访问验证
curl -s -o /dev/null -w "%{http_code}" "$BASE/session/$SID/proxy/5174/"

# 查看所有 exec 历史
curl -s "$BASE/session/$SID/execs"
```

### 2.2 核心排查流程（必须从头执行，不能跳步）

> **即使 dev server 已经在运行，也必须执行第 1 步**。跳过重启+监听会导致你错过启动时的 resolve 错误，然后去排查不相关的 Proxy/网络问题，浪费时间。

```
1. 杀掉所有 vite/xybot 进程 + 清除 .vite 缓存 → exec/async 启动 dev server → 监听 /stream 获取启动日志
2. 启动无报错 → 用 endpoint API 获取 Pod IP → curl http://<pod-ip>:<port> 验证（不要用 Proxy 验证）
3. 启动报错 → 根据错误类型进入第三章对应排查分支（3.1/3.2/3.3/3.4）
```

## 三、常见错误类型与排查思路

### 3.1 Node 版本不兼容

**表现**：Vite 启动后立即退出，或 `npx vite` 拉取最新版本后报 Node 版本不满足。

**排查**：
```bash
# 检查 Node 版本
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"node -v && npm -v"}'
```

**解决**：使用项目本地二进制 `./node_modules/.bin/vite`，不用 `npx vite`。

### 3.2 pnpm 虚拟存储依赖解析失败（本次核心问题）

**表现**：
- esbuild 预构建报 `Could not resolve "@ant-design/icons"`
- 或 esbuild 报 `The service was stopped` / `write EPIPE`
- 或浏览器报 `does not provide an export named 'xxx'`

**根因**：pnpm 严格模式下，第三方包在虚拟存储（`/tmp/pnpm-vs/`）下只能访问自己声明的依赖。如果第三方包代码里 `import` 了未在 `dependencies`/`peerDependencies` 中声明的包，pnpm 的 `packageExtensions` 本地开发能补上，但在沙箱虚拟存储目录下不生效，导致 resolve 失败。

**前置条件——项目已有的 pnpm 依赖补全方式**：

项目只改了 `package.json` 一个文件，在 `pnpm` 字段加了 `packageExtensions`，`.npmrc` 和所有 `.ts/.tsx` 源码没有改动，pnpm 保持默认严格模式：

```json
"pnpm": {
  "overrides": { ... },
  "packageExtensions": {
    "@handsontable/react": { "peerDependencies": { "react": "*", "react-dom": "*" } },
    "swiper": { "peerDependencies": { "react": "*", "react-dom": "*" } },
    "react-papaparse": { "peerDependencies": { "react": "*", "react-dom": "*" } },
    "@micro-zoe/micro-app": { "peerDependencies": { "react": "*", "react-dom": "*" } },
    "tiptap-markdown": { "peerDependencies": { "@tiptap/core": "*", "@tiptap/pm": "*" } },
    "@hookform/resolvers": { "peerDependencies": { "zod": "*" } }
  }
}
```

**这种方式的局限性**：`packageExtensions` 在本地 pnpm install 时会正确在虚拟存储目录下建立链接，但沙箱环境由于以下原因可能失效：
- 沙箱重建后 `/tmp/pnpm-vs/` 是全新目录，`pnpm install` 行为可能不一致
- 虚拟存储路径下 peer dependency 链接可能不完整

**排查步骤**：

```bash
# 1. 找到报错包的虚拟存储路径
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"find /tmp/pnpm-vs -maxdepth 1 -type d -name \"@xbot-fe+Design*\""}'

# 2. 检查虚拟存储目录下是否有缺失依赖的链接
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"ls /tmp/pnpm-vs/@xbot-fe+Design*/node_modules/@ant-design/icons 2>/dev/null || echo NO_LINK"}'

# 3. 确认宿主项目 node_modules 里依赖存在
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"ls /workspace/node_modules/@ant-design/icons"}'

# 4. 确认第三方包是否声明了该依赖（重点：对比 packageExtensions 里补的是否真的缺失）
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"python3 -c \"import json; d=json.load(open(\\\"/workspace/node_modules/@xbot-fe/Design/package.json\\\")); print(\\\"deps:\\\", json.dumps(d.get(\\\"dependencies\\\",{}))); print(\\\"peerDeps:\\\", json.dumps(d.get(\\\"peerDependencies\\\",{})))\""}'

# 5. 找到哪些文件引用了缺失依赖
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"find /tmp/pnpm-vs/@xbot-fe+Design*/node_modules/@xbot-fe/Design/dist -name \"*.js\" -exec grep -l \"@ant-design/icons\" {} \\;"}'

# 6. 对比 packageExtensions 中补全的依赖 vs 实际还缺失的依赖
# 如果 packageExtensions 已覆盖则不应出问题，出问题说明沙箱环境下 packageExtensions 未生效
```

**解决方案（按优先级）**：

**方案 A：补全 `packageExtensions`（首选）**

如果 `packageExtensions` 缺少某个未声明依赖的补全，加上它。这是 pnpm 官方推荐方式，本地和沙箱都应该生效：

```json
"pnpm": {
  "packageExtensions": {
    "@xbot-fe/Design": {
      "dependencies": { "@ant-design/icons": "*" },
      "peerDependencies": { "@ant-design/icons": "*" }
    }
  }
}
```

**方案 B：Vite `resolve.alias` + `optimizeDeps.include`（兜底）**

> ⚠️ **务必先用方案 A 修复并验证，只有方案 A 确认无效后才用方案 B。** 不要同时使用两个方案，否则无法判断哪个方案真正生效。

当 `packageExtensions` 在沙箱虚拟存储下不生效时，在 `vite.config.ts` 中添加：

```ts
resolve: {
  alias: [
    { find: '@ant-design/icons', replacement: path.resolve(__dirname, 'node_modules/@ant-design/icons') },
    // ... 其他原有 alias
  ],
},
optimizeDeps: {
  include: ['@ant-design/icons'],
},
```

**原理**：
- `resolve.alias`：让 esbuild 和 Vite 运行时从项目 `node_modules` 解析，绕过虚拟存储路径
- `optimizeDeps.include`：确保预构建该包，CJS 依赖（如 `qs`）会被正确内联转换，避免浏览器 `does not provide an export named 'xxx'` 错误

**不要用**：
- ~~`optimizeDeps.exclude: ['@xbot-fe/Design']`~~ — 跳过预构建会导致 CJS 依赖（如 `qs`）未转换，浏览器报 `does not provide an export named 'parse'`
- ~~手动在虚拟存储目录创建符号链接~~ — 沙箱重建后丢失

### 3.3 esbuild 服务崩溃

**表现**：`The service was stopped` / `write EPIPE`

**根因**：通常是 3.2 的连带问题——esbuild 预构建时遇到 resolve 失败导致服务崩溃。修复 resolve 问题后此错误消失。

**额外检查**：
```bash
# 检查是否有大量僵尸 esbuild 进程（反复 kill vite 导致）
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"ps aux | grep defunct"}'

# 清理方式：kill-sandbox 重建
curl -s -X POST "$BASE/session/$SID/kill-sandbox"
curl -s -X POST "$BASE/session/$SID/keep-alive" -H 'Content-Type: application/json' \
  -d '{"enabled":true,"boot":true}'
```

### 3.4 端口占用

**表现**：`Error: Port 5174 is already in use`

**排查**：
```bash
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"ps aux | grep -E \"vite|xybot\" | grep -v grep"}'
```

**解决**：
```bash
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"pkill -9 -f vite; pkill -9 -f xybot; sleep 2; echo done"}'
```

### 3.5 Proxy Content-Type 错误（不要修，直接跳过）

> **⚠️ 这个问题不在沙箱内修复范畴，不要花时间排查。** 如果你发现 Proxy 返回 JS 文件的 Content-Type 为 `text/html`，这不是你要修的问题——用 Pod IP 直连验证服务是否正常即可。

**表现**：Proxy 返回 JS 文件的 Content-Type 为 `text/html` 而非 `text/javascript`

**排查**：
```bash
# 直连验证 Content-Type（应该正确）
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"curl -s -o /dev/null -w \"%{content_type}\" http://<pod-ip>:5174/src/.xybot/main.tsx"}'

# Proxy 验证 Content-Type（可能不正确，但这不是你的问题）
curl -s -o /dev/null -w "%{content_type}" "$BASE/session/$SID/proxy/5174/src/.xybot/main.tsx"
```

**结论**：直连正确就说明沙箱内服务正常，Proxy Content-Type 错误是 Proxy 层的 bug，不要去读 opencode proxy 源码或尝试修复。

## 四、完整重启流程

```bash
BASE="https://test-opencode.shadow-rpa.net"
SID="ses_xxxxxxxxxxxxxxxxxxxx"

# 1. 杀掉所有相关进程
curl -s --max-time 10 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"pkill -9 -f vite; pkill -9 -f xybot; sleep 2; rm -rf /workspace/node_modules/.vite; echo cleaned"}'

# 2. 确保 keepAlive 开启
curl -s -X POST "$BASE/session/$SID/keep-alive" \
  -H 'Content-Type: application/json' -d '{"enabled":true}'

# 3. 异步启动 dev server
EXEC_RESULT=$(curl -s --max-time 10 -X POST "$BASE/session/$SID/exec/async" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && pnpm run dev --host -- --port 5174 --strictPort","timeoutSeconds":0}')
EXEC_ID=$(echo "$EXEC_RESULT" | python3 -c "import json,sys;print(json.load(sys.stdin)['execId'])")

# 4. 等待 20 秒后监听 SSE 日志
sleep 20
curl -s -N --max-time 30 "$BASE/session/$SID/exec/$EXEC_ID/stream"

# 5. 获取直连地址并验证
ENDPOINT=$(curl -s "$BASE/session/$SID/endpoint/5174")
echo "$ENDPOINT"  # 查看 url 字段
POD_IP_URL=$(echo "$ENDPOINT" | python3 -c "import json,sys;print(json.load(sys.stdin)['url'])")

# 6. 从沙箱内部验证（必须用 Pod IP，不能用 localhost）
curl -s --max-time 10 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d "{\"command\":\"curl -s -o /dev/null -w '%{http_code}' $POD_IP_URL/\"}"
```

## 五、常见走偏及纠正

| 走偏行为 | 纠正 |
|---------|------|
| 看到 dev server 在跑就跳过重启，直接验证页面 | 必须杀进程+重启+看 SSE，启动时错误只在 stream 里能看到 |
| 发现 Proxy 返回 `text/html` 就去读 proxy 源码 | Proxy Content-Type 是已知问题，不在沙箱内修，用 Pod IP 直连验证 |
| 页面 200 但白屏，去查 Proxy 路由 | 先看 SSE 有没有 `Could not resolve` 报错，大概率是 3.2 依赖解析问题 |
| 直接去改 `vite.config.ts` 加 resolve.alias | 先用方案 A（packageExtensions），确认无效再用方案 B |
| 花时间检查虚拟存储目录结构 | SSE 日志已经告诉你哪个包缺哪个依赖了，直接补 packageExtensions |

## 六、通用方法论

1. **先用 SSE 监听看启动日志**，不要只看 exec 状态。很多错误（resolve 失败、esbuild 崩溃）只在 stream 里能看到。
2. **区分启动时错误 vs 运行时错误**：启动时错误出现在 `/stream` 里；运行时错误需要浏览器控制台或 headless 检测。
3. **验证用 Pod IP 不用 localhost**：集群模式下浏览器通过 Pod IP 直连，排查时也要用同样方式。
4. **沙箱重建后 `/tmp/pnpm-vs/` 会丢失**：不要在临时目录做修复，改项目配置文件（`vite.config.ts`、`package.json`）才是持久的。
5. **`pnpm.packageExtensions` 在沙箱虚拟存储下可能不生效**：项目本身用 `packageExtensions` 补全第三方包未声明的依赖（peer deps 等），本地开发正常，但沙箱虚拟存储目录下链接可能不完整。排查时先确认 `packageExtensions` 是否已覆盖缺失依赖，如果已覆盖但仍报错，再兜底用 Vite 的 `resolve.alias` + `optimizeDeps.include`。
