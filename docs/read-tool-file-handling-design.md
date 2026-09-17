# Read 工具多格式文件处理方案

## 1. 背景

当前 SaaS `read` 工具通过 OpenSandbox 的 `sandbox.files.readFile()` 读取所有文件。该接口返回字符串，适合 UTF-8 文本，不适合 PNG、PDF、DOCX 等二进制文件。

实际故障中，读取 `/workspace/.shot.png` 后，PNG 原始字节被解码成包含 `\u0000` 和替换字符的字符串，并进入工具结果 `part.data`。PostgreSQL `jsonb` 无法保存包含 Unicode null 的字符串，最终导致 `insert into "part"` 失败，工具调用被标记为中断。

这不是 PNG 特例，而是“未分类文件默认按字符串读取”的通用设计问题。

## 2. 目标与范围

### 2.1 目标

1. 文件读取前先按字节识别类型，不再默认按字符串处理。
2. 文本文件继续支持分页、行号、截断和指令加载。
3. 图片、PDF 等媒体返回结构化附件，不把原始二进制字符串写入数据库。
4. Word、Excel、PowerPoint 等文档返回可识别、可下载、可扩展解析的数据。
5. 返回的数据契约足以让前端按 MIME 类型展示或下载。
6. 对文件大小、畸形编码、压缩炸弹和不可信 SVG 提供明确保护。
7. 保持运行时权限检查、超时、Sandbox 生命周期和模型媒体能力判断不变。

### 2.2 本期范围

本期实现后端读取、分类、持久化和附件返回契约，不实现前端预览组件。前端只需能够在后续读取 `part.state.attachments` 并按 `mime` 展示。

### 2.3 非目标

1. 本期不实现完整 Office 在线预览器。
2. 本期不保证所有模型都能理解 PDF、Office、音视频。
3. 本期不在 `read` 工具内引入 OCR、LibreOffice、Pandoc 等重量级转换依赖。
4. 本期不把任意二进制文件转换成文本后强行发送给模型。

## 3. 相关上游能力与问题

### 3.1 OpenSandbox 官方文件 API

当前项目使用 `@alibaba-group/opensandbox@0.1.8`，官方 `SandboxFiles` 已提供：

```ts
readFile(path: string, opts?: { encoding?: string; range?: string }): Promise<string>
readBytes(path: string, opts?: { range?: string }): Promise<Uint8Array>
readBytesStream(path: string, opts?: { range?: string }): AsyncIterable<Uint8Array>
```

官方最新版本还为上述接口增加了 `offset` 和 `limit`。

`readFile()` 的官方实现是调用 `readBytes()` 后使用 `TextDecoder` 解码，因此二进制文件必须直接使用 `readBytes()` 或 `readBytesStream()`。

相关资料：

- [OpenSandbox 官网](https://open-sandbox.ai)
- [JavaScript SDK 文档](https://open-sandbox.ai/sdks/javascript)
- [SandboxFiles 接口](https://github.com/opensandbox-group/OpenSandbox/blob/main/sdks/sandbox/javascript/src/services/filesystem.ts)
- [FilesystemAdapter 下载实现](https://github.com/opensandbox-group/OpenSandbox/blob/main/sdks/sandbox/javascript/src/adapters/filesystemAdapter.ts)

### 3.2 OpenCode 相关 issue

- [#21227](https://github.com/anomalyco/opencode/issues/21227)：工具结果的图片附件已存在于 `part.state.attachments`，但 UI 尚未展示。其建议是在 ToolPart 层统一渲染，而不是给每个工具单独实现。
- [#36343](https://github.com/anomalyco/opencode/issues/36343)：大型图片结果中的 Base64 会扩大持久化事件和 SSE 负载，甚至断开所有订阅者。
- [#30648](https://github.com/anomalyco/opencode/issues/30648)：图片/二进制读取绕过 `read` 工具钩子，强调媒体读取仍应经过统一权限和审计链路。
- [#34840](https://github.com/anomalyco/opencode/issues/34840)：PDF 输入在部分多模态模型上读取失败，说明媒体类型与模型能力必须独立处理。
- [#27689](https://github.com/anomalyco/opencode/issues/27689)：DOCX/XLSX 支持需求，讨论了 Office 文件解析为文本或 CSV 的后续方向。
- [#38144](https://github.com/anomalyco/opencode/issues/38144)：图片字节被发给非视觉模型，说明附件返回后还必须经过模型媒体能力判断。

这些问题表明：二进制读取、附件持久化、模型投影和 UI 展示是四个不同边界，不能用“把文件转成 Base64 字符串塞进 output”一次性解决。

## 4. 当前链路与问题

### 4.1 当前链路

```text
read 工具
  -> sandbox.files.readFile(path)
  -> string
  -> 按行生成 output
  -> ToolResult.attachments（仅部分临时实现）
  -> Session processor
  -> ToolStateCompleted
  -> part.data (PostgreSQL jsonb)
  -> SSE / SDK / 前端
```

### 4.2 当前问题

1. `readFile()` 在类型识别前完成字符串解码，二进制数据已经不可逆损坏。
2. `Buffer.from(content, "binary")` 不能恢复被 UTF-8 `TextDecoder` 替换掉的字节。
3. 原始二进制字符串包含 `\u0000`，不能进入 PostgreSQL `jsonb`。
4. 未设置统一媒体大小限制，Base64 会显著放大数据库、事件和 SSE 负载。
5. 图片附件虽然可以进入 `ToolStateCompleted.attachments`，但当前前端未展示。
6. SVG 同时具备文本和图片属性，直接内联展示存在脚本和外部资源风险。
7. DOCX/XLSX/PPTX 本质是 ZIP 容器，不能按 UTF-8 文本读取。

## 5. 设计原则

1. **字节优先**：读取文件头字节后再决定是否解码。
2. **内容优先**：Magic bytes 优先，扩展名和声明 MIME 仅作辅助。
3. **文本严格解码**：使用 `TextDecoder("utf-8", { fatal: true })`，禁止静默替换非法字节。
4. **媒体结构化返回**：媒体放在 `attachments`，`output` 只包含短文本说明。
5. **数据库只保存 JSON 安全数据**：不保存原始二进制字符串。
6. **限制前置**：完整下载前读取文件信息和文件头，先做大小与类型判断。
7. **统一审计**：文本和媒体都经过相同的 read 权限、外部目录检查、超时和工具事件。
8. **渐进增强**：本期保证安全读取和可展示契约，Office 文本提取后续独立扩展。

## 6. 建议架构

### 6.1 总体流程

```text
参数规范化
  -> 外部目录权限检查
  -> read 权限检查
  -> getFileInfo
  -> 目录：分页列目录
  -> 文件：readBytes(range=bytes=0-65535)
  -> 类型识别
     -> UTF-8 文本：分页读取并严格解码
     -> 图片：完整字节读取，返回图片附件
     -> PDF：返回 PDF 附件
     -> SVG：按 UTF-8 文本返回；附件预览留给后续安全策略
     -> Office：返回文件附件和“不支持文本提取”的说明
     -> 未知二进制：返回文件附件或明确的 BinaryFileError
```

### 6.2 复用 Core 实现

`packages/core/src/tool/read-filesystem.ts` 已实现：

- 字节读取和文件头识别；
- PNG/JPEG/GIF/WebP magic bytes；
- UTF-8 fatal 解码；
- 二进制检测；
- 50KB 文本输出限制；
- 20MB 媒体读取限制；
- 文本分页和超长行截断。

推荐把其分类和限制规则复用于 SaaS Sandbox `read`，不要在 `packages/opencode/src/tool/read.ts` 中维护另一套不一致规则。由于 Core 实现依赖本地 `FSUtil`，应抽取纯同步分类函数与通用结果类型，Sandbox 适配器只负责提供字节流。

建议抽取：

```ts
type FileKind =
  | { type: "text"; mime: string }
  | { type: "image"; mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp" }
  | { type: "pdf"; mime: "application/pdf" }
  | { type: "svg"; mime: "image/svg+xml" }
  | { type: "office"; mime: string }
  | { type: "binary"; mime: string }
```

分类函数只接收文件名和 `Uint8Array` 文件头，不进行 I/O。

## 7. 文件类型处理策略

### 7.1 UTF-8 文本

适用：源码、TXT、Markdown、JSON、YAML、CSV、日志、HTML、CSS、JS/TS 等。

处理：

1. 读取最多 64KB 文件头。
2. 排除已识别二进制类型。
3. 使用 fatal UTF-8 解码验证。
4. 按当前 `offset`、`limit` 语义读取。
5. 维持 2,000 行、单行 2,000 字符和总输出字节限制。
6. 继续加载 `AGENTS.md` 等指令。

返回：

```ts
{
  title: "src/index.ts",
  output: "<path>...</path>\n<type>file</type>...",
  metadata: {
    kind: "text",
    mime: "text/typescript",
    truncated: false,
    loaded: [],
  },
}
```

### 7.2 图片

本期支持 PNG、JPEG、GIF、WebP。BMP 可以识别，但是否允许交给模型应沿用 `isImageAttachment()` 的统一能力策略。

处理：

1. 通过 magic bytes 识别，不能只相信扩展名。
2. 获取文件大小，超过上限直接返回 `MediaIngestLimitError`。
3. 使用 `readBytes()` 读取完整字节；大文件可用 `readBytesStream()` 聚合并在过程中检查上限。
4. 生成 JSON 安全附件。
5. `output` 只返回固定说明，不包含二进制或 Base64 副本。

推荐生产返回：

```ts
{
  title: ".shot.png",
  output: "Image read successfully",
  metadata: {
    kind: "image",
    mime: "image/png",
    size: 95533,
  },
  attachments: [
    {
      type: "file",
      mime: "image/png",
      url: "/session/{sessionID}/attachment/{attachmentID}",
      filename: ".shot.png",
    },
  ],
}
```

`filename` 是否可直接加入取决于现有 `FilePart` schema；如果不支持，应先放在 metadata，避免擅自修改公共协议。

附件 URL 指向受管附件服务。媒体字节不进入 part、PostgreSQL、事件或 SSE。附件服务设计见第 9 节。

### 7.3 SVG

SVG 是 XML 文本，模型读取时应走严格 UTF-8 文本路径，而不是普通二进制图片路径。

返回 `mime: image/svg+xml` 和文本内容。前端若后续展示，不能直接注入 DOM；只能：

- 作为 `<img src>` 的隔离资源；或
- 服务端清洗脚本、事件属性、外链和 `foreignObject` 后再展示。

本期不生成 SVG Data URL 附件，避免扩大攻击面。

### 7.4 PDF

PDF 通过 `%PDF-` 文件头识别。

本期：

- 返回 `application/pdf` 附件；
- `output` 返回 `PDF read successfully`；
- 受媒体大小限制；
- 由 `message-v2.ts` 根据模型能力决定作为工具结果附件还是独立媒体消息。

后续可增加可选文本提取层，例如 `pdftotext`，但提取文本与原文件附件应同时保留，不能用提取文本替代源文件。

### 7.5 Word、Excel、PowerPoint

识别范围：DOC/DOCX、XLS/XLSX、PPT/PPTX、ODT/ODS/ODP。

本期：

- 不调用 `readFile()`；
- 返回通用文件附件、MIME、大小和文件名；
- `output` 明确说明当前未提取文本；
- 未支持此类附件的模型不应收到原始文件字节。

后续解析建议使用独立转换服务或 Sandbox 内命令：

- DOCX：Mammoth 或 LibreOffice；
- XLSX：SheetJS、Python openpyxl，输出 Markdown/CSV；
- PPTX：LibreOffice、python-pptx，输出逐页文本；
- 旧版 DOC/XLS/PPT：LibreOffice headless。

解析必须设置 CPU、内存、时间、展开大小和页数/Sheet 数限制，防止 ZIP bomb。

### 7.6 未知二进制

默认不转成字符串。

本期可选择：

1. 对允许下载的普通文件返回 `application/octet-stream` 附件；
2. 对可执行文件、压缩包、对象文件等返回 `BinaryFileError`。

建议允许列表而不是全量允许，避免把密钥库、数据库、可执行文件等自动传给模型。

### 7.7 不同文件的标准工具结果

所有成功结果统一遵循 `Tool.ExecuteResult`：

```ts
type ReadToolResult = {
  title: string
  output: string
  metadata: Record<string, unknown>
  attachments?: Array<{
    type: "file"
    mime: string
    filename?: string
    url: string
  }>
}
```

工具完成后，上述内容进入 `ToolStateCompleted`：

```ts
{
  status: "completed",
  input: { filePath: "/workspace/example.png" },
  title: "example.png",
  output: "Image read successfully",
  metadata: { kind: "image", mime: "image/png", size: 95533 },
  attachments: [...],
  time: { start: 0, end: 1 },
}
```

约束：

1. `output` 必须是短文本或有边界的文本页，禁止放入原始二进制或 Base64。
2. `metadata` 只能保存 JSON 安全的小型描述信息。
3. 可展示或下载的文件通过 `attachments` 返回。
4. `url` 必须是受管附件 URL，生产环境禁止返回 Data URL。
5. `title` 使用相对工作区路径或安全文件名，不暴露宿主机路径。

#### 7.7.1 目录

```ts
{
  title: "src/assets",
  output: [
    "<path>/workspace/src/assets</path>",
    "<type>directory</type>",
    "<contents>",
    "- icons/",
    "- logo.svg",
    "- screenshot.png",
    "</contents>",
  ].join("\n"),
  metadata: {
    kind: "directory",
    count: 3,
    truncated: false,
  },
}
```

目录没有 `attachments`。如果分页，metadata 增加 `next`，output 明确提示下一页 offset。

#### 7.7.2 普通 UTF-8 文本、源码、JSON、Markdown

```ts
{
  title: "src/index.ts",
  output: [
    "<path>/workspace/src/index.ts</path>",
    "<type>file</type>",
    "<content>",
    "1: import { Effect } from \"effect\"",
    "2: ",
    "3: export const run = Effect.void",
    "",
    "(End of file - total 3 lines)",
    "</content>",
  ].join("\n"),
  metadata: {
    kind: "text",
    mime: "text/typescript",
    size: 86,
    truncated: false,
    loaded: [],
  },
}
```

分页文本：

```ts
{
  title: "large.log",
  output: "...\n\n(Showing lines 101-200 of 928. Use offset=201 to continue.)\n</content>",
  metadata: {
    kind: "text",
    mime: "text/plain",
    size: 184322,
    truncated: true,
    offset: 101,
    next: 201,
    loaded: [],
  },
}
```

文本不返回附件，避免同一内容同时出现在 `output` 和附件中。

#### 7.7.3 空文本文件

```ts
{
  title: "empty.txt",
  output: [
    "<path>/workspace/empty.txt</path>",
    "<type>file</type>",
    "<content>",
    "",
    "(End of file - total 0 lines)",
    "</content>",
  ].join("\n"),
  metadata: {
    kind: "text",
    mime: "text/plain",
    size: 0,
    truncated: false,
    loaded: [],
  },
}
```

空文件不能因为 JavaScript 空字符串为 falsy 而误判为“读取失败”。

#### 7.7.4 SVG

SVG 默认作为 XML 文本返回给模型：

```ts
{
  title: "diagram.svg",
  output: [
    "<path>/workspace/diagram.svg</path>",
    "<type>file</type>",
    "<content>",
    "1: <svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\">",
    "2:   <circle cx=\"50\" cy=\"50\" r=\"40\" />",
    "3: </svg>",
    "",
    "(End of file - total 3 lines)",
    "</content>",
  ].join("\n"),
  metadata: {
    kind: "svg",
    mime: "image/svg+xml",
    size: 142,
    truncated: false,
    loaded: [],
  },
}
```

本期不返回 SVG 附件。未来若允许预览，附件必须通过隔离 URL 或清洗后的内容生成。

#### 7.7.5 PNG、JPEG、GIF、WebP 图片

```ts
{
  title: ".shot.png",
  output: "Image read successfully",
  metadata: {
    kind: "image",
    mime: "image/png",
    size: 95533,
  },
  attachments: [
    {
      type: "file",
      mime: "image/png",
      filename: ".shot.png",
      url: "/session/ses_123/attachment/att_123",
    },
  ],
}
```

要求：

- 通过附件 URL 下载后的字节必须与 `readBytes()` 返回值完全一致。
- `output`、metadata、数据库、事件和日志不能包含 Base64。
- 图片类型来自 magic bytes；扩展名仅用于文件名和辅助判断。
- 超过限制时返回 `MediaIngestLimitError`，不返回部分图片附件。

#### 7.7.6 PDF

```ts
{
  title: "requirements.pdf",
  output: "PDF read successfully",
  metadata: {
    kind: "pdf",
    mime: "application/pdf",
    size: 482193,
    textExtracted: false,
  },
  attachments: [
    {
      type: "file",
      mime: "application/pdf",
      filename: "requirements.pdf",
      url: "/session/ses_123/attachment/att_124",
    },
  ],
}
```

本期不在 `output` 中返回 PDF 二进制或未经验证的文本。后续增加文本提取时，建议：

```ts
{
  output: "<path>...</path>\n<type>pdf-text</type>\n<content>...</content>",
  metadata: { kind: "pdf", mime: "application/pdf", textExtracted: true },
  attachments: [originalPdfAttachment],
}
```

即文本提取结果与原始 PDF 附件同时保留。

#### 7.7.7 DOC、DOCX

本期不做文本提取：

```ts
{
  title: "requirements.docx",
  output: "Document read successfully. Text extraction is not available for this format.",
  metadata: {
    kind: "office",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 127382,
    textExtracted: false,
  },
  attachments: [
    {
      type: "file",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: "requirements.docx",
      url: "/session/ses_123/attachment/att_125",
    },
  ],
}
```

旧版 `.doc` 使用 `application/msword`。Office 文件只返回受管附件 URL，不能把字节塞入 `output`。

#### 7.7.8 XLS、XLSX

```ts
{
  title: "report.xlsx",
  output: "Spreadsheet read successfully. Text extraction is not available for this format.",
  metadata: {
    kind: "office",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 92831,
    textExtracted: false,
  },
  attachments: [
    {
      type: "file",
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: "report.xlsx",
      url: "/session/ses_123/attachment/att_126",
    },
  ],
}
```

后续解析 XLSX 时，`output` 应返回受限的 Markdown 表格或 CSV 摘要，并在 metadata 中说明 Sheet、行列数量和截断情况。

#### 7.7.9 PPT、PPTX

```ts
{
  title: "roadmap.pptx",
  output: "Presentation read successfully. Text extraction is not available for this format.",
  metadata: {
    kind: "office",
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    size: 1182932,
    textExtracted: false,
  },
  attachments: [
    {
      type: "file",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      filename: "roadmap.pptx",
      url: "/session/ses_123/attachment/att_127",
    },
  ],
}
```

后续解析时，建议 output 按页返回标题、正文和备注，并设置最大页数。

#### 7.7.10 允许下载的未知二进制

如果策略允许以通用文件附件返回：

```ts
{
  title: "sample.bin",
  output: "Binary file read successfully. Content is available as an attachment.",
  metadata: {
    kind: "binary",
    mime: "application/octet-stream",
    size: 4096,
  },
  attachments: [
    {
      type: "file",
      mime: "application/octet-stream",
      filename: "sample.bin",
      url: "/api/session/{sessionID}/attachment/{attachmentID}",
    },
  ],
}
```

未知二进制只允许受管 URL，也不默认发送给模型。

#### 7.7.11 禁止读取的二进制

可执行文件、对象文件、压缩包或策略禁止类型返回工具错误，不返回成功结果：

```text
Cannot read binary file: /workspace/program.wasm
```

对应 ToolPart：

```ts
{
  status: "error",
  input: { filePath: "/workspace/program.wasm" },
  error: "Cannot read binary file: /workspace/program.wasm",
  metadata: {
    kind: "binary",
    mime: "application/wasm",
  },
  time: { start: 0, end: 1 },
}
```

错误中禁止包含文件字节、Base64 或数据库 payload。

#### 7.7.12 非法 UTF-8 伪文本

扩展名是 `.txt`，但内容不是合法 UTF-8：

```text
File is not valid UTF-8: /workspace/broken.txt
```

不能使用替换字符继续返回，否则可能破坏配置、源码或协议内容。

#### 7.7.13 文件不存在

```text
File not found: /workspace/missing.png
```

返回 `status: "error"`，不返回 attachments。

#### 7.7.14 文件过大

```text
Media exceeds 5242880 byte ingestion limit: /workspace/large.png
```

返回 `status: "error"`，metadata 可包含 `size`、`maximumBytes`、`mime`，但不返回部分附件。

#### 7.7.15 返回矩阵

| 输入 | `output` | `metadata.kind` | `attachments` | 状态 |
|---|---|---|---|---|
| 目录 | 分页条目 | `directory` | 无 | completed |
| UTF-8 文本/源码 | 带行号文本页 | `text` | 无 | completed |
| 空文本 | 0 行文本结果 | `text` | 无 | completed |
| SVG | XML 文本页 | `svg` | 本期无 | completed |
| PNG/JPEG/GIF/WebP | `Image read successfully` | `image` | 图片附件 | completed |
| PDF | `PDF read successfully` | `pdf` | PDF 附件 | completed |
| DOC/DOCX | 未提取文本说明 | `office` | 文档附件 | completed |
| XLS/XLSX | 未提取文本说明 | `office` | 表格附件 | completed |
| PPT/PPTX | 未提取文本说明 | `office` | 演示附件 | completed |
| 允许的未知二进制 | 附件说明 | `binary` | 受管文件附件 | completed |
| 禁止的二进制 | 错误信息 | `binary` | 无 | error |
| 非法 UTF-8 | 错误信息 | `text` | 无 | error |
| 文件不存在 | 错误信息 | 未知 | 无 | error |
| 文件过大 | 错误信息 | 已识别类型 | 无 | error |

## 8. OpenSandbox 读取策略

### 8.1 必须替换的调用

当前：

```ts
const content = await sandbox.files.readFile(path)
```

建议：

```ts
const info = await sandbox.files.getFileInfo([path])
const header = await sandbox.files.readBytes(path, { range: "bytes=0-65535" })
const kind = classifyFile(path, header)
```

分类后：

- 文本：调用 `readFile()` 或基于 `readBytesStream()` 分页解码；
- 小媒体：调用 `readBytes()`；
- 大媒体：调用 `readBytesStream()`，边读边检查上限；
- 目录：直接 `listDirectory()` 或现有目录列表逻辑。

### 8.2 版本兼容

当前 0.1.8 已支持 `range`。不要直接依赖最新版才有的 `offset`、`limit`，除非先升级锁文件和镜像内 SDK，并完成远端 Sandbox 兼容验证。

## 9. 附件存储与传输

生产方案不使用 Data URL。媒体字节写入 Session 对应的 Sandbox 持久卷，part 只保存稳定的受管引用：

```ts
{
  type: "file",
  mime: "image/png",
  filename: "screenshot.png",
  url: "/session/{sessionID}/attachment/{attachmentID}",
}
```

part 保存稳定的应用路由，服务端在每次请求时完成鉴权并代理 Sandbox 持久卷内容。前端不接触 Sandbox 文件路径。

### 9.1 ToolAttachment

新增独立的 `ToolAttachment` 模块，不复用现有 `ToolOutputStore`：

- `ToolOutputStore` 只处理文本截断；
- 其文件位于 SaaS Pod 本地目录，不能跨 Pod 访问；
- 返回的是宿主机内部路径；
- 没有 Session 所有权、HTTP 下载、Range 和 MIME 响应能力。

核心接口：

```ts
interface ToolAttachment {
  store(input: {
    sandbox: Sandbox
    sessionID: string
    sourcePath: string
    filename: string
    mime: string
    size?: number
    audience: "model-and-display" | "display-only"
  }): Effect.Effect<{
    metadata: AttachmentMetadata
    url: string
  }, AttachmentStorageError>

  open(input: {
    provider: SandboxProvider
    sessionID: string
    attachmentID: string
  }): Effect.Effect<AttachmentStream, AttachmentNotFoundError | AttachmentStorageError>
}
```

`store()` 必须边复制边计算 SHA-256 和实际大小，超过类型上限立即终止。不能先把大文件完整加载到进程内存。

### 9.2 存储模型

字节和小型 JSON metadata 都保存在 Sandbox 的持久化 home volume，不增加数据库表：

```text
/home/sandbox/.local/share/opencode/tool-attachments/{sessionID}/
  {attachmentID}.data
  {attachmentID}.json
```

文件路径只使用经过 Schema 校验的 Session ID 和 Attachment ID。原文件名只保存在经过清洗的 metadata 中，避免路径穿越、控制字符和响应头注入。

写入顺序：

1. 创建权限为 `0700` 的 Session 附件目录；
2. 从源文件流式复制到权限为 `0600` 的 `.data` 文件；
3. 校验大小、哈希和 MIME；
4. 写入相邻 JSON metadata；
5. 返回稳定 URL；

附件依赖 Session/app PVC。Sandbox 进程过期或重建后，`SandboxProvider.getOrCreate()` 必须重新挂载同一持久卷；未配置持久卷的部署不保证历史附件可用。

### 9.3 下载接口

```http
GET /session/:sessionID/attachment/:attachmentID
Range: bytes=0-1048575
```

接口必须：

- 权限校验和 Session 所有权校验；
- 正确的 `Content-Type`、`Content-Length` 和缓存头；
- Range 请求；
- 对图片和 PDF 使用安全的 `Content-Disposition: inline`；
- 对 Office 和未知二进制使用 `Content-Disposition: attachment`；
- 添加 `X-Content-Type-Options: nosniff`；
- 禁止从 filename 直接构造本地路径或对象 key。

### 9.4 生命周期

附件生命周期与 Session 数据一致：

- Session 存在时附件可访问；
- 删除 Session 时应异步删除对应附件目录；该清理尚未实现；
- compaction 可移除模型上下文中的附件，但不应默认破坏历史消息展示；
- metadata 写入或 ToolPart 持久化失败可能产生 orphan；后台清理尚未实现；
- 保留策略必须可配置，不能固定沿用文本 ToolOutputStore 的 7 天。

### 9.5 模型读取

模型投影不能把稳定的内部 HTTP URL直接交给外部 provider。服务端根据附件 ID 从 `ToolAttachment` 读取字节，再转换为 provider 所需的 Base64、Blob 或 SDK file part。该转换只存在于单次 provider 请求内，不持久化、不进入事件、不通过 SSE 广播。

这样 PostgreSQL、SSE 和浏览器状态中都不保存大块 Base64。

## 10. 模型投影

`packages/opencode/src/session/message-v2.ts` 已读取 `part.state.attachments`，并根据 `isMedia()` 和 provider 是否支持工具结果媒体进行投影：

- 支持工具结果媒体：附件随工具结果发送；
- 不支持：媒体提取为独立用户消息；
- `stripMedia` 或 compaction：移除媒体。

实现时应保留该链路，不在 `read` 工具里按具体模型做分支。模型能力判断属于消息投影层。

PDF、Office 是否被视为媒体需要独立确认：当前 `isMedia()` 包含图片和 PDF，不包含 Office。Office 本期只返回可下载附件，不默认传给模型。

## 11. 前端数据契约

本期不实现 UI，但后端应保证前端能够根据以下字段展示：

```ts
type DisplayableAttachment = {
  type: "file"
  mime: string
  filename?: string
  url: string
}
```

`url` 是相对于 SaaS API origin 的稳定路径，不是 Sandbox 文件地址，也不是前端可以直接读取的本地文件路径。

### 11.1 前端访问流程

Session message 返回：

```json
{
  "type": "file",
  "mime": "image/png",
  "filename": "screenshot.png",
  "url": "/session/ses_123/attachment/att_123"
}
```

前端可以直接使用稳定 URL：

```ts
const attachmentUrl = new URL(attachment.url, apiBase).href
image.src = attachmentUrl
```

需要读取 Blob、主动下载或处理请求错误时，也可以使用当前 API client 相同的 origin 和认证信息请求附件：

```ts
const response = await fetch(new URL(attachment.url, apiBase), {
  headers: authorizationHeaders,
})
if (!response.ok) throw new Error(`Attachment request failed: ${response.status}`)

const objectUrl = URL.createObjectURL(await response.blob())
```

展示方式：

```ts
// 图片
image.src = objectUrl

// PDF
pdfFrame.src = objectUrl

// Office 或其他文件
download.href = objectUrl
download.download = attachment.filename ?? "download"
```

组件卸载或附件变化时必须执行：

```ts
URL.revokeObjectURL(objectUrl)
```

不增加 ticket 接口，也不把 `auth_token` 拼入持久化 URL。附件路由直接使用 SaaS 的稳定 URL和现有认证策略：服务未启用密码时直接访问；启用认证时沿用浏览器现有 Basic 凭据或由 API client 发起鉴权 fetch。

### 11.2 服务端处理流程

```text
GET stable attachment URL
  -> Authorization middleware
  -> 校验 path.sessionID 与 attachment.session_id
  -> 校验当前用户/Workspace 可访问 Session
  -> 解析 Range
  -> ToolAttachment.open()
  -> 流式代理 Sandbox 持久卷内容
```

返回示例：

```http
HTTP/1.1 200 OK
Content-Type: image/png
Content-Length: 95533
Content-Disposition: inline; filename="screenshot.png"
X-Content-Type-Options: nosniff
ETag: "sha256-..."
```

前端无需了解 Sandbox 持久卷、内部文件路径或挂载机制，只消费稳定的附件契约。

前端未来可统一从 `part.state.attachments` 读取：

- `image/*`：缩略图和全屏预览；
- `application/pdf`：PDF 预览或打开；
- Office/未知文件：文件卡片和下载；
- `image/svg+xml`：隔离预览或文本查看。

不应只在 `read` 组件中实现，因为 webfetch、MCP 和其他工具也会返回附件。上游 #21227 已提出在 ToolPart 层统一展示。

## 12. 错误与降级

建议定义或复用以下错误：

- `FileNotFoundError`
- `PathKindError`
- `BinaryFileError`
- `MalformedUtf8Error`
- `MediaIngestLimitError`
- `UnsupportedFileTypeError`
- `ReadTimeoutError`

错误信息不能包含原始二进制内容。数据库更新失败时也不能把整个工具 payload 写进用户可见错误。

降级规则：

1. MIME 识别失败：不按文本读取，返回未知二进制结果。
2. 图片规范化失败：省略附件并在 output 中说明，沿用 processor 当前行为。
3. 模型不支持媒体：由消息投影层提取或省略，不影响工具结果持久化。
4. 前端不支持预览：仍可根据 URL 下载或打开。

## 13. 安全要求

1. 权限检查必须发生在任何 `getFileInfo`、`readBytes` 之前。
2. 外部目录检查不能因媒体分支绕过。
3. SVG 不允许直接注入 HTML。
4. Office/PDF 转换必须在 Sandbox 内隔离执行。
5. 限制原始大小、解压后大小、页数、Sheet 数和转换时间。
6. 不依据用户提供的 MIME 决定安全策略，必须检查 magic bytes。
7. 下载端点必须验证 Session、Workspace 和用户权限。
8. 日志只记录路径、MIME、大小和错误类型，不记录 Base64 或文件内容。

## 14. 实施步骤

### 阶段 A：建立受管附件能力

1. 实现 Sandbox PVC 上的 `ToolAttachment` 字节和 metadata 持久化。
2. 不增加数据库表，ToolPart 只保存稳定 URL、MIME 和文件名。
3. 增加带 Session 鉴权和 Range 支持的下载接口。
4. 后续增加 Session 删除和 orphan 清理。
5. 增加模型投影阶段的按需字节读取。

### 阶段 B：修复读取与分类

1. 在 Sandbox `read` 中将首次读取改为 `readBytes(range)`。
2. 抽取并复用文件类型识别函数。
3. 文本确认后才进入流式 UTF-8 解码。
4. PNG/JPEG/GIF/WebP 和 PDF 流式写入 `ToolAttachment`。
5. 未知二进制不进入文本 output。
6. 删除 `Buffer.from(decodedString, "binary")` 方案。

### 阶段 C：完善格式与契约

1. 增加 SVG 文本安全策略。
2. 增加 Office MIME 识别和通用附件返回。
3. 统一 ToolResult metadata：`kind`、`mime`、`size`。
4. 验证 provider 媒体投影和 compaction。

### 阶段 D：可选文档解析

1. PDF 文本提取。
2. DOCX/XLSX/PPTX 转换。
3. 结构化文本与原附件同时返回。
4. 为转换器增加资源限制和隔离测试。

## 15. 测试方案

### 15.1 单元测试

文件分类：

- PNG/JPEG/GIF/WebP 文件头；
- PDF 文件头；
- SVG UTF-8 文本；
- DOCX/XLSX/PPTX ZIP 容器加扩展名；
- UTF-8 文本；
- 非法 UTF-8；
- 包含 null byte 的伪文本；
- 扩展名和内容不一致。

Sandbox 适配：

- `readBytes()` 在文本分类前被调用；
- 图片不调用 `readFile()`；
- 文本确认后调用 `readFile()`；
- Range 请求正确；
- 超限媒体在完整读取前失败；
- `readBytesStream()` 超限后停止继续读取。

工具结果：

- 图片 `output` 不含原始内容和 `\u0000`；
- 图片附件 MIME、文件名和受管 URL 正确；
- 通过受管 URL 下载后的字节与原始字节完全一致；
- PDF/Office 返回正确附件类型；
- 文本分页行为不回归。

附件存储：

- 上传过程超过大小限制后立即停止；
- metadata/part 写入失败产生的 orphan 可被后续清理；
- 稳定 URL 不暴露 Sandbox 内部路径；
- 跨 Pod 请求可读取同一附件；
- 未授权用户、其他 Session 和错误 Workspace 均返回拒绝；
- Range、`Content-Type`、`Content-Length`、`Content-Disposition` 正确；
- part、数据库事件和 SSE 中不存在 Base64 内容。

现有 `packages/opencode/test/tool/read.test.ts` 使用的测试上下文没有提供 Sandbox，而当前 SaaS `read` 强制要求 Sandbox，导致该文件现状为全量失败。实现时应提供最小 fake `Sandbox.files`，不要用真实远端 Sandbox 跑单元测试。

### 15.2 数据库集成测试

使用 PostgreSQL 执行完整工具结果持久化：

1. 读取包含大量 null byte 的 PNG。
2. `part` insert/update 成功。
3. `data` 可由 JSON schema 解码。
4. `output` 中不存在 `\u0000`。
5. `attachments[].url` 是稳定的应用内 URL。
6. part、事件和 SSE payload 大小不随媒体文件大小线性增长。

### 15.3 端到端测试

在本地 SaaS + 远端 PG + 远端 Sandbox 环境：

1. 在 Sandbox 生成截图。
2. 调用 `read` 读取截图。
3. 会话不中断，工具状态为 `completed`。
4. 查询 Session message，确认 attachments 存在。
5. 请求附件 URL 并校验 PNG signature、长度和 SHA-256。
6. 读取 TXT、SVG、PDF、DOCX，确认各自分流正确。
7. 重启 SaaS Pod 后，历史 Session 附件仍可读取。
8. 删除 Session 后，附件目录最终被清理（后续生命周期阶段）。

本期不要求 UI 展示，但应确认返回契约足够支持后续展示。

## 16. 验收标准

1. PNG 读取不再触发 PostgreSQL `jsonb` 插入失败。
2. 图片结果为 `completed`，通过附件 URL 下载的字节与原文件一致。
3. 工具 `output`、metadata、数据库、事件、SSE 和日志均不包含原始二进制或 Base64。
4. 文本读取现有分页、行号、截断、权限和指令加载行为不回归。
5. PDF 和 Office 文件不会进入文本解码路径。
6. 超过限制的媒体明确失败，不导致进程内存持续增长。
7. 非视觉模型不会直接收到图片字节。
8. 返回的 `attachments` 具备 `type`、`mime`、`url`，前端可据此展示或下载。
9. SaaS Pod 重启或请求落到其他 Pod 后，附件仍可访问。

## 17. 推荐结论

优先实施阶段 A：先建立基于 Sandbox PVC 的受管附件、稳定鉴权 URL，再让 `read` 返回媒体附件。生产部署必须启用持久卷；没有受管附件能力时，不上线媒体读取。

随后使用 OpenSandbox 官方 `readBytes()` 进行字节级读取与类型识别，图片/PDF 写入 `ToolAttachment`，文本确认后才进行 UTF-8 解码。

不要保留“`readFile()` 后再用 `Buffer.from(string, "binary")` 恢复字节”的实现，因为损坏发生在 `TextDecoder` 阶段，无法恢复。

生产链路禁止使用 Data URL。Base64 只允许在单次 provider 请求的内存转换中短暂存在，不能持久化或广播，以避免 #36343 描述的数据库、事件和 SSE 负载放大。
