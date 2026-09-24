# Read 受管附件（Managed Attachments）V2 实现方案

> 基于 `feat/opencode-1.18.31` 的 V1 实现拆解 + V2 现状实测（2026-09-24，session 见 `read-managed-attachments.md` V2 记录）。

> **实现进度**：附件分类、sandbox/local 受管存储、下载 API（Range/ETag）、read 状态引用和 provider 请求时的临时模型投影已接入。Core 单测通过；server API 集成测试已连本地 PostgreSQL 执行。Docker sandbox PVC 重建 e2e 尚未执行。测试前 PG 已有 1 条 assistant `session_message` 命中 `data:image`/`base64,` 检查，该记录不是本次 HTTP 路由测试写入；尚未修改该既有数据，需后续确认来源。

## 1. 现状与目标

**V2 实测现状**（`probe-attachments.sh`）：

| 能力 | V2 现状 |
|---|---|
| 文本读取/分页 | ✅ 正常（metadata 仅 `{truncated}`，**无 kind/mime/size**） |
| 图片/PDF/Office | ❌ 一律 `binary file is not supported yet`（无 magic-bytes 分类） |
| 非法 UTF-8 | ⚠️ 静默 replacement 字符（V1 严格报错——`read-error-no-destroy.md` 的修复语义回退） |
| ELF 拒绝 | ⚠️ 仅 null-byte/非打印启发式，小 ELF（无 null）被当文本读出（V1 有 `7f454c46` 魔数） |
| attachments 字段 | ❌ 无 |
| 下载路由 | ❌ 无（`/api/session/:id/attachment/:aid` 不存在） |
| PG 安全（无 base64） | ✅ 当前通过（因媒体压根读不了，非特性生效） |
| 模型投影 | ⚠️ `toModelContent` 本地路径**直接生成 data URI file chunk 进 state.content（持久化）**——正是 T-READ-14 要拦的反模式；sandbox 路径无此分支 |

**目标**：V1 parity——字节级分类、PVC 附件化、稳定受管 URL、Range/ETag/416/304 下载协议、模型投影安全、PG 无 base64。

## 2. V1 实现拆解（7 组件）

1. **分类** `ToolAttachment.classify(filename, bytes)`（`tool/attachment.ts`）
   - magic bytes：PNG/JPEG/GIF/WEBP(BMP)/BMP/PDF → image|pdf
   - 扩展名白名单：office 9 种（doc/docx/xls/xlsx/ppt/pptx/odt/ods/odp）→ `audience=display-only`
   - 扩展名黑名单 + 魔数：ZIP/GZIP/WASM/MZ/ELF → `binary` 拒绝
   - 启发式：首 64KB 样本 30%+ 非打印字符（或 null byte）→ binary
   - SVG：扩展名或文本以 `<svg`/`<?xml...<svg` 开头 → `svg`（走文本路径，不附件化）
   - 兜底 → `text` + `textMime(extension)`（20+ 扩展名映射）
2. **存储** `ToolAttachment.store`
   - 沙箱 PVC 路径：`{ROOT}/{sessionID}/{attID}.data` + 旁路 `{attID}.json`（Metadata：id/sessionID/filename/sanitize 后名/mime/size/sha256/audience）
   - `readBytesStream` 流式边读边算 sha256，>20MB 抛 `TooLargeError`（`Media exceeds ... byte ingestion limit`）；写失败回滚删除
   - URL：`/session/{sid}/attachment/{attID}`（`att_` 前缀，attID 与文件名即主键——**无 DB 依赖**）
3. **read 工具接入**（sandbox 路径，`tool/read.ts:392+`）
   - header 嗅探（64KB）→ classify → binary 报 `Cannot read binary file`；image|pdf|office → store → 返回 state：`{output:"Image read successfully", metadata:{kind,mime,size,audience,...,textExtracted:false}, attachments:[{type,mime,filename,url}]}`
   - text/svg 继续分页路径，metadata 同样带 `kind/mime`
4. **下载 handler**（`handlers/session.ts:319`，`handleRaw`）
   - `ToolAttachment.open`：读 `.json` meta（缺失/不匹配 → 404），校验 sessionID+id
   - `parseByteRange`：合法 → 206 + `Content-Range`；非法/越界 → 416 + `bytes */size`；`bytes=-N` 后缀范围
   - `ETag = "sha256-{sha}"` + If-None-Match（逗号列表）→ 304
   - 流式响应：`Accept-Ranges: bytes`、`Cache-Control: private, max-age=31536000, immutable`、`Content-Disposition: inline|attachment; filename*=UTF-8''...`（按 audience）、`X-Content-Type-Options: nosniff`
   - **open 内部走 `resolveSandboxOpts`（root session 解析）**——子会话附件也到 root sandbox
5. **模型投影**（`processor.ts` tool-result + parts→LLM message 转换）
   - 持久化只含 managed URL；**provider 请求构建时**才把 `model-and-display` 附件读回字节转临时 data URI 注入本次请求
   - `display-only`（office）不进模型输入
   - 非 managed 的 image 附件过 `image.normalize`（resize 保底）
6. **安全约束**：ToolPart/事件/API 响应零 base64、零 Data URL、零 null byte（T-READ-14）
7. **单测**：`attachment.test.ts` + `message-v2.test.ts`（≥50 断言）：分类/上限/回滚/Range/投影三语义

## 3. V2 方案（组件映射 + 架构决策）

### 3.1 新模块 `packages/core/src/tool/attachment.ts`

移植 V1 classify/store/open/parseByteRange/sanitizeFilename，V2 化差异：

| 决策点 | V1 | V2 方案 | 理由 |
|---|---|---|---|
| D1 字节读取 | `readBytesStream` 流式 | **`provider.fileReadBytes(path, {range})`**：读取 64KB 头部分类；如 `fileStat` 提供 size，则先拒绝超过 20MB，否则整读并再次校验实际字节数 | 不新增 stream 方法；部分 sandbox files API 不提供 size，实际读取后还有硬上限校验 |
| D2 存储位置 | 沙箱 PVC `{ROOT}/{sid}/{att}.data/.json` | Sandbox 模式落 PVC（沿用 `OPENCODE_SANDBOX_ATTACHMENT_ROOT`）；非 sandbox 本地模式落 `Global.Path.data/tool-attachments` | 正常 SaaS 路径跨沙箱重建持久；两种模式均不把字节写入 PG |
| D3 root 解析 | open 时 `resolveSandboxOpts` | **不需要——今天的 `resolveSandboxKey` 边界修复直接复用**：open 走 `provider.fileReadBytes` 自动解析到 root sandbox | 本轮 subagent 修复的红利，V2 比 V1 少一处显式调用 |
| D4 分类错误类 | 独立文案 `Cannot read binary file` | **复用 V2 现有 `BinaryFileError`/`MediaIngestLimitError`**（read-filesystem.ts），补齐 classify 魔数 | 用例断言 `binary file`/`ingestion limit` 关键词两边文案均含；不引入第三套错误 |

`classify` 为**纯函数**（filename + headerBytes 入参）→ 直接单测。

### 3.2 read 工具接入（双路径统一）

- **sandbox 路径**（`SandboxTools.read`）：stat → `fileReadBytes(range 0-64K)` 嗅探 → classify：
  - `binary` → fail `BinaryFileError`；`office/image/pdf` 且 size>20MB → fail `MediaIngestLimitError`
  - `image|pdf|office` → `store` → 返回 `{output: "Image read successfully"|"PDF read successfully"|"Document", metadata:{kind,mime,size,audience,textExtracted?}, attachments:[...]}`
  - `text|svg` → 走现有分页，metadata 补 `kind/mime/size`
- **本地路径**（`read.ts` 主分支）：同逻辑，字节从 Environment 读
- **state schema 扩展**（`@opencode/schema` tool 定义处）：`metadata` 加 `kind/mime/size/audience/textExtracted`，新增 `attachments` 数组——**schema 所有权在 schema 包（wire contract），按 AGENTS.md 放 `packages/schema`**

### 3.3 模型投影（收敛单点）★ 关键改造

- **现状问题**：`read.ts toModelContent:176-186` 本地路径直接产出 `data:{mime};base64` file chunk → 进 `state.content` → **持久化到 session_message**（T-READ-14 违规）
- **方案**：
  1. read（双路径）不再生成 data URI content——media 走 attachments 引用 + 短文本 output
  2. 新投影点：**tool result → LLM message 转换处**（`runner/to-llm-message.ts` / publish-llm-event 的 tool-result 分支）：
     - attachments 中 audience=`model-and-display` 且 mime 为 image/pdf → 请求时 `provider.fileReadBytes` 读回 → 临时 data URI 注入**该次请求**的 tool result message
     - `display-only`（office）→ 跳过
     - **无 SandboxProvider / 读回失败 → 省略媒体并附文本说明**（T-READ-17 断言：不把内部 URL 交给 provider）
  3. 本地非 sandbox 模式：投影从本地文件读字节（`Environment`/fs）

### 3.4 下载路由

- `packages/protocol/src/groups/session-attachment.ts`（新）：
  ```ts
  HttpApiEndpoint.get("session.attachment", "/api/session/:sessionID/attachment/:attachmentID", {...})
  ```
  返回**原始字节流**——先例确认：V2 fs 路由若有 raw/handleRaw 用同款；否则按 V1 用 raw response（需确认 V2 HttpApi 的 `handleRaw` 对应物）
- `packages/server/src/handlers/session-attachment.ts`：V1 handler 逻辑移植（416/304/206/Disposition/ETag/nosniff 全保留）
- 认证：走现有 authorization middleware（Basic auth）——T-FE-04 语义天然满足

### 3.5 单测 `packages/core/test/attachment.test.ts`

V1 断言移植 + V2 新语义：
- classify：PNG/JPEG/PDF magic、office 扩展名、ELF `7f454c46`、null-byte、30% 启发式、SVG、textMime 映射
- store：20MB 拒绝、回滚、sha256/size 准确、sanitize（控制字符/引号）
- parseByteRange：普通/后缀/非法（416 分支）/size=0
- 投影：managed→临时 base64、无 provider 省略、office 不进模型、**PG state 无 data URI**（对 V2 现状的回归测试）

## 4. V1↔V2 行为差异（测试文档需标注/需决策）

| 用例 | 差异 | 处置建议 |
|---|---|---|
| T-READ-04 非法 UTF-8 | V2 静默 replacement（V1 严格 error） | **建议对齐 V1**：这是 `read-error-no-destroy.md` 修复语义（错误原样传播）的回退——`read-filesystem` 解码改 strict + `OffsetOutOfRangeError` 同款传播；属独立缺陷可先行修复 |
| T-READ-12 ELF | V2 无魔数（补 classify 即修复） | 随本特性闭环 |
| T-READ-13 超限 | V2 21MB PNG 先命中 binary（无媒体识别）→ 补 classify 后**先 stat 超限**即命中 `ingestion limit` | 随本特性闭环（stat-first 顺序保证） |
| T-READ-16 SaaS 重启 | 附件在沙箱 PVC——本地 docker 无挂载卷时随沙箱容器销毁 | 本地环境标注环境限制；PVC/快照部署（组合 K8s）语义完整 |

## 5. 实施顺序（每步可独立验收）

1. **schema 扩展**（`packages/schema` tool state：kind/mime/size/audience/attachments）+ protocol 路由声明 → 类型先行
2. **`tool/attachment.ts`**：classify/store/open/parseByteRange 移植 + 单测（纯函数/假 sandbox mock）
3. **read 双路径接入** + 本地/沙箱 e2e（T-READ-01~07、12、13 用例可过）
4. **下载 handler**（416/304/206/Disposition）+ curl 用例（T-READ-08~11、FE-01~03）
5. **投影收敛**（toModelContent 摘除 data URI + to-llm-message 注入）+ 投影单测（T-READ-17、T-READ-14）
6. **持久性 e2e**（kill-sandbox / docker restart）（T-READ-15/16，PVC 环境）
7. 文档：`read-managed-attachments.md` 补 V1→V2 映射 + V2 记录

## 6. 工作量预估

| 模块 | 规模 |
|---|---|
| schema + protocol | ~100 行（契约） |
| core/tool/attachment.ts | ~300 行（V1 移植 + provider 化） |
| read 双路径 + SandboxTools | ~120 行改动 |
| 投影（to-model + read 摘除） | ~80 行改动 |
| server handler | ~120 行 |
| 单测 | ~400 行 |
