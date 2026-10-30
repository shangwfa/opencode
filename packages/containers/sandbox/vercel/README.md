# Vercel Sandbox 自定义镜像（浏览器运行时）

Vercel 官方方案：从 Vercel Managed Image 派生 Dockerfile，推送 Vercel Container Registry（VCR），
再让沙箱从该镜像启动（`/docs/sandbox/concepts/images`）。镜像不执行 ENTRYPOINT/CMD，
进程由 `runCommand` 启动。

## 构建与推送

```sh
cp -R ../opt/cdp-browser ./cdp-browser
vercel vcr login docker --token "$VERCEL_TOKEN" --scope "$VERCEL_TEAM_ID" --project "$VERCEL_PROJECT_ID"
vercel vcr build docker . opencode-sandbox:<tag> --push \
  --platform linux/amd64 --token "$VERCEL_TOKEN" --scope "$VERCEL_TEAM_ID" --project "$VERCEL_PROJECT_ID"
```

基础镜像必须写完整 VCR 地址：`vcr.vercel.com/vercel/sandbox/universal:latest`（写成
`vercel/sandbox/...` 会被解析到 Docker Hub 并拉取失败）。

推送后等 `vercel vcr image ls opencode-sandbox` 显示 `Ready` / `amd64`。

## SaaS 配置

```sh
OPENCODE_SANDBOX_ENABLED=true
OPENCODE_SANDBOX_PROVIDER=vercel
VERCEL_TOKEN=... VERCEL_TEAM_ID=... VERCEL_PROJECT_ID=...
OPENCODE_VERCEL_IMAGE=opencode-sandbox:<tag>
OPENCODE_CODEMODE_EXECUTOR=sandbox
```

## 为什么装 Playwright Chromium

默认 `vercel/sandbox/universal` 是 Ubuntu 26.04，`apt-get install chromium` 没有候选包
（探测输出 `Candidate: (none)`）。镜像里改用 Playwright 的 Chromium，并固定
`PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`，避免安装到调用者家目录。

## 已验证

2026-10-29，镜像 `opencode-sandbox:20261029b`（amd64，1.3GB）：
Browser Use 8/8（创建、沙箱内测试页、实时 JPEG 16119B、中文输入接管、脚本版本/PG、
真实模型 + Code Mode、关闭标签页、回收）。

首次镜像 `20261029` 漏装 `agent-browser`，模型只能用 curl+CDP 完成任务；`20261029b` 已修正，
模型实际使用 `agent-browser --cdp http://127.0.0.1:9222`。
