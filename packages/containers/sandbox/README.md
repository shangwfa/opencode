# opencode sandbox image

沙箱容器镜像 — 从 `feat/opencode-1.18.31`（v1 沙箱体系）迁移，作为 v2
OpenSandbox WorkspaceDriver（`packages/sandbox/src/opensandbox.ts`）的执行镜像。

## 构建与推送

镜像构建后推送到 OpenSandbox 平台可引用的镜像仓库（默认指向团队阿里云 CR
的 `opencode-sandbox:browser-cdp`）：

```bash
docker build -t crpi-hlpnu8kiweghie0r.cn-hangzhou.personal.cr.aliyuncs.com/shangwfa/opencode-sandbox:browser-cdp .
docker push crpi-hlpnu8kiweghie0r.cn-hangzhou.personal.cr.aliyuncs.com/shangwfa/opencode-sandbox:browser-cdp
```

本地开发也可以配合 `@opencode/sandbox/docker`（本地 docker provider）使用，
driver 支持 `installAgent` 参数向未内置 agent 的基础镜像引导安装 fs-agent。

## fs-agent 协议

`fs-agent.mjs` 在容器内运行，宿主侧通过
`docker exec -i <container> node /opt/opencode/sandbox/fs-agent.mjs` 调用，
stdin 传入一个 JSON 请求，stdout 返回一个 JSON 响应。语义与宿主侧
`Environment FilesImpl` 契约（`packages/core/src/environment/files.ts`）对齐：

```jsonc
// 请求
{ "op": "stat" | "read" | "list" | "write" | "remove" | "move" | "mkdir",
  "path": "/workspace/x", "offset": 0, "length": 16, "bytes": "<base64>" }

// 响应
{ "ok": true, "result": { "type": "file", "size": 3, "mtimeMs": 1.0 } }
{ "ok": false, "error": { "kind": "NotFound", "path": "/x" } }
```

## 预装内容（沿袭 v1）

- Node LTS（升级基础镜像版本）+ ripgrep（glob/grep/ls 沙箱分支依赖）
- corepack（pnpm/yarn）+ bun + uv（Python）
- TypeScript LSP、pyright、supergateway（MCP stdio bridge）
- tsserver 预热（V8 JIT 编译完成，冷启动更快）
- 国内镜像源（apt 阿里云 / npm 淘宝 / pip 清华）
