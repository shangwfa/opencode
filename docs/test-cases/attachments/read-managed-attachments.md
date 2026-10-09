# Read 工具多格式与受管附件测试（V2）

> 验证 `read` 工具的字节级文件分类、文本分页、受管附件持久化、稳定下载 URL、Range/ETag 响应、模型投影安全与 PostgreSQL payload 安全。V1 `/session/:id/exec`、`/message` 与 `part` 表已移除；本文件全部用例基于当前 V2 `/api/...` 路由，V1 命令与复测记录归档于文末。

## 1. V2 契约速查

- 触发 read：`POST /api/session/:sessionID/prompt_stream`（真实模型；fixture 经 `POST /api/session/:sessionID/shell` 写入 Sandbox）。
- 工具结果结构：`GET /api/session/:id/message` → assistant 消息 `content[]` 中 `type=tool, name=read` 的 part，`state.status`（completed/error）、`state.content`（文本输出）、`state.metadata`（`kind/mime/size/audience/textExtracted/attachments`）、`state.error.message`。
- 附件下载：`GET /api/session/:sessionID/attachment/:attachmentID`（原始字节；`attachments[].url` 为该相对路径，非 Data URL、不含 Sandbox 路径）；支持 `Range`（206/416）、`ETag`/`If-None-Match`（304）；`Content-Disposition` 由 audience 决定（image/pdf=inline，office=attachment）。
- 附件存储：服务端 `tool-attachments/{sessionID}`（`packages/core/src/tool/attachment.ts`），Sandbox 重建不失效；SaaS 容器 restart（非重建）保持持久。
- 分类与拒绝：text/svg 走文本（SVG 不附件化，防 HTML 注入）；image/pdf/office 附件化（office `textExtracted=false` 仅展示）；已知二进制拒绝（binary file）；媒体超 20MB 拒绝（ingestion limit）；非法 UTF-8 明确报错。
- 实现锚点：`packages/core/src/tool/plugin/read.ts`、`packages/core/src/tool/attachment.ts`、`packages/protocol/src/groups/session-attachment.ts`。

## 2. 环境与执行

```bash
source docs/test-cases/test-env.sh 3
export BASE=http://localhost:14106                     # 隔离 SaaS 容器
export OPENCODE_PASSWORD=ab123456
export PG_URL='postgresql://local@127.0.0.1:5432/opencode-v2-up'
export MODEL='{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"}'
export ATTACH_RESTART_CONTAINER=my-disposable-saas     # 覆盖 T-READ-16 时必填

node docs/test-cases/scripts/read-attachments-v2.mjs   # T-READ-01~16 + T-FE-01~04（API 层）

# T-READ-17 单测
cd packages/core && bun test test/attachment.test.ts test/tool-read-filesystem.test.ts test/tool-read.test.ts test/session-model-request.test.ts
cd ../server && OPENCODE_DATABASE_URL='postgresql://local@127.0.0.1:5432/opencode-v2-up' bun test test/session-attachment.test.ts
```

脚本用 3 个分组模型回合触发全部 read（文本组/附件组/拒绝组），结束清理 fixture 与 session（409 删除时序轮询）。未设置 `ATTACH_RESTART_CONTAINER` 时 T-READ-16 输出 SKIP，不得记为通过。

## 3. 用例

| 用例 | 验证点 |
|---|---|
| T-READ-01 | UTF-8 文本分页：completed、kind=text、mime=text/plain、输出含 1-based 行号与内容 |
| T-READ-02 | 空文件：completed，输出含 `total 0 lines`，不误判为不存在/目录 |
| T-READ-03 | SVG 走文本：kind=svg、mime=image/svg+xml、无 attachments（不产生可注入 HTML 的媒体附件） |
| T-READ-04 | 非法 UTF-8：error 含 `UTF-8`，不含原始字节/Base64 |
| T-READ-05 | PNG 附件化：kind=image、URL 为 `/api/session/{sid}/attachment/att_*`、metadata 无 Data URL/Sandbox 路径、下载保持 PNG signature |
| T-READ-06 | PDF 附件化：kind=pdf、下载以 `%PDF-` 开头 |
| T-READ-07 | Office 仅展示：kind=office、`textExtracted=false`、Content-Disposition=attachment |
| T-READ-08~10 | 下载协议：Range 206 + accept-ranges + content-range + 字节一致；非法 Range 416；ETag + If-None-Match 304 |
| T-READ-11 | SHA-256：Sandbox 源文件与下载字节一致 |
| T-READ-12 | 已知二进制（ELF）：error `binary file`、无附件 |
| T-READ-13 | 超 20MB：error `ingestion limit`、无部分附件 |
| T-READ-14 | PG 安全：本 session 的 `session_message.data` 无 `data:image/`、`base64,`、`\u0000` |
| T-READ-15 | PVC 持久化：kill-sandbox + keep-alive(boot) 重建后附件 URL 字节不变 |
| T-READ-16 | SaaS 重启持久化：容器 restart 后附件仍可下载且字节不变 |
| T-READ-17 | 单测：core 4 文件 + server `session-attachment.test.ts`（PG），不得减少既有断言 |
| T-FE-01~04 | API 层前端契约：content-type、PDF inline / Office attachment disposition、鉴权行为；浏览器 UI 渲染不在本脚本范围 |

## 4. 执行记录

**2026-10-09（V2 重写 + 全量执行）**：文档改为 V2 契约，新增 `read-attachments-v2.mjs`。隔离容器（`opencode-saas-audit-log:local` 镜像）+ 本地 PG + 本地 OpenSandbox，模型 **`Yd-GLM`/`glm-5.3`**：**T-READ-01~16 + T-FE-01~04 全部通过（36 项断言，含清理零残留）**——文本分页/空文件（V2 文案 `Read file ..., 0 lines`）/SVG 文本路径/PNG/PDF/Office 附件化与受管 URL/Range 206/416/ETag 304/SHA-256 一致/ELF 与超限拒绝/PG payload 安全/沙箱重建与 SaaS 容器 restart 后附件字节不变（T-READ-16 实跑 docker restart）。T-READ-17 单测：core 4 文件 **71 pass / 0 fail**（基线 ≥50）、server PG `session-attachment.test.ts` **2 pass / 0 fail**。

> 脚本适配说明：glm-5.3 在单回合内会先列目录再全量读取（含重复调用），脚本按文件路径取每文件最后一次 read 并要求所有调用限定在 fixture 目录内；这是对模型行为的鲁棒适配，各文件断言强度不变。

## 5. 前端集成指南（V2 数据契约）

附件引用位于 completed read part 的 `state.metadata.attachments[]`（示意）：

```jsonc
{
  "type": "tool",
  "name": "read",
  "state": {
    "status": "completed",
    "content": [{ "type": "text", "text": "Image read successfully" }],
    "metadata": {
      "kind": "image",            // text | svg | image | pdf | office
      "mime": "image/png",
      "size": 4096,
      "truncated": false,
      "audience": "model-and-display",
      "attachments": [
        { "type": "file", "mime": "image/png", "filename": "pixel.png", "url": "/api/session/ses_123/attachment/att_123" }
      ]
    }
  }
}
```

| 字段 | 说明 |
|---|---|
| `attachments[].url` | 相对路径 `/api/session/{sid}/attachment/{aid}`，永远不是 Data URL 或 Sandbox 路径；响应体为原始字节 |
| `metadata.kind` | `text`/`svg`/`image`/`pdf`/`office` |
| `metadata.audience` | 体现在 `Content-Disposition`：inline（image/pdf）或 attachment（office） |

渲染建议：图片直接 `img.src`（或鉴权环境 fetch→ObjectURL）；PDF `iframe`；Office 提供下载按钮；大文件用 Range 分段；首次响应保存 ETag 走 304；ObjectURL 用毕 `revokeObjectURL`。状态码语义：404 附件不存在、403 无权限、416 Range 越界。

## 6. 历史归档（V1，非当前契约证据）

- 旧文档的 V1 shell 命令（`/session/:id/exec`、`/message`、V1 `part` 表查询、`new_sid` 等）已随 V1 路由移除，不再维护。
- 2026-09-06（v1.18.29 镜像）：T-READ-01~17 全部 PASS（deepseek 触发稳定；ETag 提取用 grep 替代 gawk 特性；ELF/超限 fixture 需真实签名头）。
- 2026-09-14（hitl-cbf2276a-wip2）：T-READ-01~17 全部 PASS（含远端 K8s 沙箱 PVC 持久化与 SaaS 重启）。
- 2026-09-25（当前 V2 源码初验）：core 4 文件 71 pass / server PG 2 pass；sandbox read E2E、PVC/重启、浏览器 UI 未执行——由本 V2 版用例补齐。
