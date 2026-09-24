# V2 session 沙箱文件 API 验收

本文档描述当前 V2 session-scoped 文件接口。服务端通过 session Location 访问该 session 的 sandbox 工作区；测试服务和本地 PG 配置见 [`docs/local-test-env.md`](../../local-test-env.md)。

## V2 接口

| 操作 | Endpoint | 请求/响应 |
| --- | --- | --- |
| 读取文件 | `GET /api/session/:sessionID/fs/read/*` | 返回原始文件字节，并按内容设置 `Content-Type` |
| 列目录 | `GET /api/session/:sessionID/fs/list?path=...` | 返回 `{ data: [{ path, type }] }`，path 相对 session workspace |
| 搜索文件 | `GET /api/session/:sessionID/fs/find?query=...&type=file\|directory&limit=...` | query 是文件名 glob pattern；返回 `{ data: [{ path, type }] }` |

V2 没有独立的 mkdir/create/upload/remove/download(zip) 文件 API。创建、覆盖和删除文件可通过 `POST /api/session/:sessionID/shell` 执行命令；随后用 `session.fs.read/list/find` 检查结果。文件浏览接口**不会启动或重建 sandbox**：sandbox 未在当前进程就绪时返回 404。`kill-sandbox` 后须先通过 shell/boot 重新启动，再浏览文件。当前 sandbox 没有持久卷，销毁后文件不会保留。

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
PG_URL='postgresql://local@127.0.0.1:5432/opencode-v2-up' \
node docs/test-cases/scripts/files-api-v2.mjs
```

脚本会断言 HTTP 响应、文件内容/MIME、workspace 路径边界及 PG sandbox 状态，结束时删除测试 session。

## 旧版用例迁移说明

旧版 `/session/:id/files/mkdir|create|upload|remove|download`、`/find/file`、`/file`、`exec_log` 和 PVC/app 共享卷用例不适用于 V2。V2 的目录枚举和搜索端点分别是 `session.fs.list`、`session.fs.find`；`session.fs.read` 只读单个文件，不打包目录。V2 暂无专用文件写入/删除接口与 PVC 持久化语义。
