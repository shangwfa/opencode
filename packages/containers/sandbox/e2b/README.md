# E2B 自定义模板（浏览器运行时）

E2B 官方 `base` 模板不含 Chromium / CDP 网关，Browser Use 需要本模板。

## 构建

模板 Dockerfile 复用仓库的 `opt/cdp-browser`（Chromium + CDP 网关 + 幂等启动脚本），基础镜像是 E2B 的 Debian 12：

```sh
# 需要 E2B_API_KEY 与本地 Docker
cp -R ../opt/cdp-browser ./cdp-browser
E2B_API_KEY=<key> npx @e2b/cli template create opencode-browser-use \
  -d Dockerfile --cpu-count 2 --memory-mb 2048
```

`cdp-browser/` 是构建时复制进来的运行产物，不要提交（已在 `.gitignore`）。

## SaaS 配置

```sh
OPENCODE_SANDBOX_ENABLED=true
OPENCODE_SANDBOX_PROVIDER=e2b
E2B_API_KEY=<secret>
OPENCODE_E2B_TEMPLATE=opencode-browser-use
OPENCODE_E2B_RUNNER_ASSET=/app/packages/core/dist/sandbox-runner.mjs.gz
OPENCODE_CODEMODE_EXECUTOR=sandbox
```

CPU/内存是模板属性：模板按 2 vCPU / 2048 MiB 构建，会话若显式指定资源必须与模板一致，否则创建失败（见 `core/src/sandbox/e2b-shared/provider.ts`）。

## 已验证

2026-10-28，Chromium 156.0.8078.47、agent-browser 0.39.4、CDP 网关 `/json/version` 正常；Browser Use 全链路（创建、实时画面、中文输入接管、脚本发布/版本、真实模型 + Code Mode）通过。证据与命令见 `docs/test-cases/browser-use-migration.md`。

## 其他后端

| 后端            | 浏览器运行时来源                                                                         |
| --------------- | ---------------------------------------------------------------------------------------- |
| opensandbox     | 仓库镜像 `packages/containers/sandbox/Dockerfile` 自带                                   |
| e2b             | 本模板                                                                                   |
| aliyun / vercel | 官方模板不含，需自建模板，或设置 `OPENCODE_BROWSER_START_COMMAND` 让沙箱先装运行时再启动 |

服务端启动前会探测沙箱：优先 `/opt/cdp-browser/cdp-browser.sh`，其次 Chromium + 网关；都不满足时返回明确错误，而不是启动失败无提示。
