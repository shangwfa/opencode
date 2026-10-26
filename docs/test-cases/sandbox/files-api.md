# V2 session 沙箱文件 API 验收

本文档描述当前 V2 session-scoped 文件接口。服务端通过 session Location 访问该 session 的 sandbox 工作区；测试服务和本地 PG 配置见 [`docs/local-test-env.md`](../../local-test-env.md)。

## V2 接口

| 操作 | Endpoint | 请求/响应 |
| --- | --- | --- |
| 读取文件 | `GET /api/session/:sessionID/fs/read/*` | 返回原始文件字节，并按内容设置 `Content-Type` |
| 列目录 | `GET /api/session/:sessionID/fs/list?path=...` | 返回 `{ data: [{ path, type }] }`，path 相对 session workspace |
| 搜索文件 | `GET /api/session/:sessionID/fs/find?query=...&type=file\|directory&limit=...` | query 是文件名 glob pattern；返回 `{ data: [{ path, type }] }` |

V2 没有独立的 mkdir/create/upload/remove/download(zip) 文件 API。创建、覆盖和删除文件可通过 `POST /api/session/:sessionID/shell` 执行命令；随后用 `session.fs.read/list/find` 检查结果。文件浏览接口**不会启动或重建 sandbox**：sandbox 未就绪时返回 404。`kill-sandbox` 后须先通过 shell/boot 重新启动，再浏览文件。文件是否保留取决于 provider 和持久化配置；Vercel snapshot 模式的 kill 是停止并保留工作区，不等于永久删除，本组原用例不验证恢复后的文件内容。

## T-FILE-V2.1 未启动 sandbox 时不触发创建

在 `OPENCODE_SESSION_AUTO_KEEPALIVE=0` 的服务上创建 session，调用 `fs/list` 应返回 404，PG `sandbox` 表不应出现该 session 的行。此时文件浏览是只读路径，不负责启动 sandbox。

## T-FILE-V2.2 shell 创建夹具与目录列表

通过 session shell 创建多级目录、文本/二进制/隐藏文件。验证 `fs/list` 返回 workspace 相对路径和 `file`/`directory` 类型；直接子项应正确列出。

## T-FILE-V2.3 文件读取

验证 `fs/read/*` 返回文本内容及 `text/plain`，二进制内容逐字节一致且 MIME 为 `application/octet-stream`，PNG magic bytes 内容 MIME 为 `image/png`（MIME 按内容而非扩展名推断）。

## T-FILE-V2.4 文件搜索

验证 `fs/find` 按 query 命中文件、`type=file` 过滤生效、没有匹配时返回空数组。

## T-FILE-V2.5 错误与 workspace 边界

不存在的文件返回 404；读取或列目录路径逃出 workspace 返回 404。sandbox 未就绪和文件不存在均为文件系统错误响应，不会隐式 boot。

## T-FILE-V2.6 销毁后的行为

`kill-sandbox` 后 PG 行变为 `destroyed`；再次调用 `fs/list` 返回 404，PG 不应因此被重建。删除 session 后 sandbox 状态仍为 `destroyed`。

## 执行脚本

脚本需要 Node.js、`psql`，并要求 `BASE` 服务和 `PG_URL` 指向同一 PG。测试服务需设置 `OPENCODE_SESSION_AUTO_KEEPALIVE=0`，避免 session 创建时自动 boot。

```bash
OPENCODE_PASSWORD="$OPENCODE_PASSWORD" \
BASE=http://localhost:14107 \
PG_URL='postgresql://local@127.0.0.1:5432/opencode-v2-test' \
node docs/test-cases/scripts/files-api-v2.mjs
```

脚本会断言 HTTP 响应、文件内容/MIME、workspace 路径边界及 PG sandbox 状态，结束时删除测试 session。

## 旧版用例迁移说明

旧版 `/session/:id/files/mkdir|create|upload|remove|download`、`/find/file`、`/file`、`exec_log` 和 PVC/app 共享卷用例不适用于本组 V2 文件接口验收。V2 的目录枚举和搜索端点分别是 `session.fs.list`、`session.fs.find`；`session.fs.read` 只读单个文件，不打包目录。本组不验收专用文件写入/删除接口或 PVC 持久化语义；Vercel provider 不支持 PVC。

## 实测记录（2026-10-02）

环境：本地 Docker 实例（`OPENCODE_SESSION_AUTO_KEEPALIVE=0`）+ 本地 PG + 本地 OpenSandbox。

> 前提：T-FILE-V2.1 的"未 boot 会话不创建沙箱"断言要求 lazy 实例。默认 auto keep-alive 实例在会话创建后异步 boot 沙箱；该实例上此断言会因竞态失败。本记录在 lazy 实例执行。

| 用例 | 结果 |
|---|---|
| T-FILE-V2.1 未启动 sandbox 时不触发创建 | PASS（fs/list 404；PG 无沙箱行） |
| T-FILE-V2.2 shell 夹具与目录列表 | PASS（workspace 相对路径与条目类型） |
| T-FILE-V2.3 文件读取 | PASS（文本/二进制与 MIME 含 PNG 魔数） |
| T-FILE-V2.4 文件搜索 | PASS（过滤与空结果） |
| T-FILE-V2.5 错误与边界 | PASS（缺失文件与路径逃逸 404） |
| T-FILE-V2.6 销毁后的行为 | PASS（kill-sandbox 后 fs/list 不重建，返回 404；PG 行保留 destroyed） |

脚本：`files-api-v2.mjs`（7 断言全部通过，rc=0）。

## Vercel 实测记录（2026-10-24）

环境：独立 Docker lazy-boot 实例，镜像 `opencode-saas:vercel-files-20261024`，端口 15107；专用 PG `opencode-v2-vercel-test`；Vercel SDK 3.8.0、snapshot 持久化。原有 `opencode-saas` 未改动。通过 `sandbox-vercel-t19.mjs` 包装执行原脚本，提前订阅公共会话 SSE；原脚本及断言未修改。

| 用例 | 结果 |
|---|---|
| T-FILE-V2.1 未启动 sandbox 不创建 | PASS（fs/list 404、PG 无绑定行） |
| T-FILE-V2.2 shell 夹具与目录列表 | PASS（相对路径、隐藏条目、file/directory 类型） |
| T-FILE-V2.3 文件读取 | PASS（文本、二进制及 PNG 字节与 MIME） |
| T-FILE-V2.4 文件搜索 | PASS（原脚本精确文件名、类型过滤和空结果；另补 glob 契约） |
| T-FILE-V2.5 错误与边界 | PASS（缺失文件、目录路径逃逸返回 404） |
| T-FILE-V2.6 销毁后行为 | PASS（kill 后浏览 404、不重建；删除后 PG 保留原 ID、destroyed） |

**发现并修复**：原脚本全部通过，但只查询完整文件名，不能证明 glob 契约。新增 `files-api-glob-v2.mjs` 先在旧镜像复现 `*.txt` 返回空数组；Vercel fileFind 错用了 `includes`。现复用 `@opencode/util/glob`，同时补 provider 单测；修复前 API 和单测均失败，修复后重建镜像，原脚本和补测均通过。补测覆盖 `*`、`?`、字符类、隐藏文件、带引号文件名、嵌套搜索、精确匹配不做子串匹配、directory 过滤、limit，以及搜索不改变 PG 绑定或代次。

证据：`artifacts/vercel-files-20261024/`。

- `initial/`：原脚本首次 PASS；`glob-before/`：补测失败现场。
- `final/original/`、`final/glob/`：最终脚本日志、公共 SSE 原始事件、结果及 PG 后检。两次 shell 均由 SSE 确认 exit=0；最终 PG 均为 `provider=vercel/state=destroyed/remote_name=NULL`。
- `cleanup-verification.json`：本次四个测试沙箱均已查询为 404，按其 name 枚举无未删除快照；不是仅检查删除请求响应。
- `checks/`：本地回归 128 pass、3 skip、0 fail（426 assertions）；独立 PG 回归 30 pass、0 fail（108 assertions）；Core typecheck、相关 oxlint 和 diff 空白检查通过。三个 skip 来自本地回归未设置 PG 的 gate 用例，PG 回归已执行。

最终执行方式：在上述 lazy Docker 实例上设置 `BASE`、`PG_URL`、`OPENCODE_PASSWORD`，分别调用 `node docs/test-cases/scripts/sandbox-vercel-t19.mjs files-api-v2 <证据目录>` 和 `files-api-glob-v2 <证据目录>`。包装器仅接受专用 `*-test` PG 库，并在失败时清理其创建的会话。

边界：这些是 shell/文件 API 测试，没有模型轮次；虽然保留 sandbox Code Mode 默认配置，不能证明 Code Mode runner 生效。未覆盖大文件压力、并发 kill/浏览竞态、符号链接逃逸和恢复后文件持久化。

## 边界补测（2026-10-24，同环境）

脚本 `files-api-edge-v2.mjs`（经同一 SSE 包装器），三次执行：`edge/`、`edge-rerun/`（前两次因补测脚本自身断言错误失败，现场保留）、`edge-final/` PASS。6 段 shell 全部经 SSE 确认 exit=0：

| 边界 | 结果 |
|---|---|
| 大文件读取 | PASS（8 MiB 随机文件 sha256 逐字节一致；40 MiB 按 32 MiB 读取上限返回 404，为文档化限制而非缺陷） |
| 符号链接语义 | PASS（`fs/read` 跟随目标返回内容、目录链接 `fs/list` 返回空列表；文件 API 与 shell 同容器权限，跟随语义不构成提权，词法路径逃逸仍 404） |
| 并发 kill/浏览 | PASS（kill 与浏览/读取并发无 5xx；kill 后浏览 404 不隐式重建，PG 保持原 sandboxID destroyed） |
| kill→resume 持久化 | PASS（恢复后 marker 与 8 MiB 文件经快照逐字节一致；运行代次更新且稳定远端身份 `remote_name` 保留，仅 purge 清空） |

远端复核：三次执行创建的 3 个沙箱均 404、无残留快照（`edge-final/cleanup-verification.json`，含前两次失败运行的资源）。本轮只改了补测脚本（前两次失败均为脚本断言错误：误断言 resume 后 remote_name 应为空、误把绑定对象写成 id 字符串），未改 core 代码，无需重跑单测回归。

补测后仍不覆盖：Code Mode 模型链路、MCP/Tool Host 端口与多 GB 级压力（见 `docs/test-cases/sandbox/vercel-exec-api-2026-10-24.md` 的 Agent 链路与端口补测记录）。
