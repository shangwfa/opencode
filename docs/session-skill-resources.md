# Session Skill 资源物化技术方案

## 状态

提案阶段。

## 摘要

Session Skill 是存储在 PostgreSQL 中的持久快照。其中，`SKILL.md` 的指令内容应进入模型上下文，资源文件则应进入 code-agent 的文件系统。资源正文不应由 `skill` 工具返回，也不应出现在系统提示词中。

模型调用某个 Session Skill 时，opencode 从 PostgreSQL 中读取当前资源快照，将其物化到当前沙箱，并返回 skill 指令、资源清单及沙箱中的资源根目录。导入或更新 skill 时不启动沙箱。

## 目标

- 继续使用 PostgreSQL 作为 Session Skill 的持久化权威数据源。
- 原始导入目录被删除后，仍能恢复并使用 skill 资源。
- 支持较长的脚本和文档，且不消耗模型上下文。
- 让 code-agent 工具可以直接读取和执行资源文件。
- 保持沙箱惰性创建。
- 重复加载 skill 和沙箱重建后，资源物化仍然幂等可靠。
- 防止资源路径逃逸出物化目录。
- 无需破坏性迁移即可兼容现有 Session Skill 数据。

## 非目标

- 在 PostgreSQL 中存储任意大小的二进制制品。
- 在每次模型调用前预先物化所有可用 skill。
- 在无关 session 之间共享已物化的资源目录。
- 让数据库更新与沙箱写入组成分布式事务。
- 在本次改动中解决历史 PVC 数据清理问题。

## 当前实现

### 导入流程

当前有两个导入入口：

1. `Skill.sessionLoad` 扫描目录并调用 `attachResources`。
2. `.opencode` 加载流程调用 `collectSkillResources`。

两套实现都会把资源文件读取为字符串，然后将字符串存入 `session_skill.resources` JSONB 字段。但两者在路径校验和大小限制计算上并不一致。

### 系统提示词和 skill 工具

- 系统提示词只暴露资源的路径、类型和计算得到的大小。
- 不传 `resources` 参数调用 `skill` 时，只返回资源清单。
- 传入 `resources` 参数时，`skill` 工具会把匹配的 `resource.content` 嵌入工具输出。
- 通用工具输出默认超过 50 KiB 后会被截断。

### 沙箱

Session Skill 资源从未被复制到沙箱。模型必须先通过上下文取得资源文本，再调用 `write` 写入沙箱。资源较大时，内容会先被截断，因此这条链路无法工作。截断后的完整输出保存在服务端文件系统中，远端沙箱无法访问。

## 设计原则

### PostgreSQL 保存快照，而不是决定展示方式

资源正文仍需作为服务端持久数据保存，原因包括：

- 原始导入目录可能被删除；
- session 可能在另一个服务进程恢复；
- 沙箱可能被销毁后重新创建。

资源正文不属于面向模型的资源表示。

### `SKILL.md` 进入上下文，resources 进入文件系统

Skill 正文包含模型需要理解的操作指令，由 `skill` 工具返回。资源应作为文件物化到 code-agent 文件系统，工具输出只提供资源元数据和路径。

### 惰性物化

创建、导入、查询、更新或预加载 skill 时均不得创建沙箱。只有通过权限检查的 `skill` 工具调用才触发物化。

## 数据模型

### 内部持久化模型

第一阶段继续使用现有 JSONB 字段，但将当前单一 Resource 类型拆分为内部存储类型和公开描述类型：

```ts
type StoredResource = {
  path: string
  type: "doc" | "script" | "template" | "asset"
  content: string
  size: number
  digest: string
}

type ResourceInfo = {
  path: string
  type: "doc" | "script" | "template" | "asset"
  size: number
  digest: string
}
```

`size` 是 UTF-8 字节数，`digest` 是存储内容 UTF-8 字节的 SHA-256。两者随资源一起持久化，避免查询列表或构建系统提示词时反复计算大型内容。

### 兼容旧数据

现有 JSONB 行只有 `path`、`type` 和 `content`。解码逻辑同时支持新旧格式：

- 缺少 `size` 时，根据 `content` 计算；
- 缺少 `digest` 时，根据 `content` 计算；
- 新写入的数据始终包含这两个字段。

本阶段不需要 PostgreSQL migration，因为 `resources` 仍是 JSONB。后续即使改为 blob 存储，也可以保持物化协议不变。

### 对外 API 类型

将请求和响应类型拆开：

```ts
type ResourceInput = {
  path: string
  type: ResourceType
  content: string
}

type SessionSkillInfo = {
  name: string
  description?: string
  location: string
  content: string
  resources: ResourceInfo[]
}
```

创建或导入请求可以包含资源正文。查询、创建和导入响应只返回 `ResourceInfo[]`，不返回存储正文。这样可以避免大型 HTTP 响应，并防止数据库存储结构直接成为公开协议。

当前 Protocol `/api/skill` 属于另一套 V2 skill 接口，本方案不修改该接口。

## 导入流程

### 统一资源采集器

将重复的资源导入逻辑合并为一个 Session Skill 资源采集器，由 `Skill.sessionLoad` 和 `.opencode` 加载流程共同使用。

采集器接收文件系统抽象、允许访问的根目录和 skill 根目录，返回经过完整校验的 `StoredResource[]`。

### 路径校验

所有相对路径统一转换为 POSIX 格式。满足以下任意条件时拒绝：

- 路径为空；
- 路径是绝对路径；
- 包含 NUL 字节；
- 任意路径段为空、`.` 或 `..`；
- 包含反斜杠；
- realpath 不是允许根目录内的普通文件；
- 通过符号链接解析到允许根目录之外。

`skills/create` 也必须使用相同校验，禁止内联 API 绕过目录导入的安全限制。

### 大小限制

第一阶段只支持文本资源，默认限制如下：

- 最多 64 个资源；
- 单个资源最大 256 KiB；
- 所有资源合计最大 1 MiB；
- 为 `SKILL.md` 单独定义并执行大小限制；
- 加入资源前检查预计总大小，不能先加入再判断是否超限。

无效的内联请求返回有类型的 Bad Request。目录导入可以返回带明确原因的跳过记录，但不能静默保存不完整文件。

### 文本与二进制资源

当前 schema 存储字符串，采集器也使用文本读取接口。因此第一阶段只支持 UTF-8 文本，包括长脚本、模板和参考文档。在真正的二进制存储协议实现前，`asset` 仅表示文本辅助资源。

对于无效 UTF-8 或二进制文件，应明确拒绝，而不是损坏其内容。二进制支持应采用对象存储或 blob 存储及内容寻址引用，不能把 base64 内容放入模型输出。

### 原子性

调用 `SessionSkill.upsert` 前，先完整构建并校验整个 skill 快照。单个 skill 的 upsert 在 PostgreSQL 语句级别保持原子性。

一次导入多个 skill 时可以继续保持逐个 skill 原子，但 API 响应必须分别报告成功和失败，不能让部分失败不可见。

## 资源物化

### 触发时机

仅在 `SkillTool.execute` 中物化，并依次完成：

1. 解析 session 范围内的 skill；
2. 检查 `skill` 权限；
3. 从 `ctx.sandbox` 获取当前沙箱；
4. 将当前快照写入沙箱。

不得在以下位置物化：

- HTTP create/load handler；
- `SandboxProvider.getOrCreate`；
- 系统提示词生成；
- 工具注册或解析流程。

### 目录结构

使用不受用户输入影响的版本化目录：

```text
/home/sandbox/.local/share/opencode/session-skills/
  {logicalSessionID}/
    {sessionSkillID}/
      {snapshotDigest}/
        SKILL.md
        resources.json
        scripts/generate.mjs
        references/usage.md
```

- `logicalSessionID` 使用 `ctx.sessionID`，而不是 `ctx.sandboxSessionID`，因为父子 session 可能共享根沙箱；
- `sessionSkillID` 使用数据库 ID，不使用用户可控的 skill name；
- `snapshotDigest` 根据 skill 正文及按路径排序后的资源 path/digest 列表计算；
- 版本化目录不可变，可避免更新后遗留文件被误用。

工具将当前版本目录作为资源根目录返回。该目录位于沙箱已有的 `.local` 持久化挂载中，不会出现在用户项目 `/workspace`、Git 状态或项目文件索引里。

该根目录属于 opencode 管理路径。`read`、`grep`、`glob` 和 `bash` 可以直接访问，不额外触发 `external_directory` 权限；它不是用户工作区的一部分，也不能作为资源保密边界。

### 写入内容

- `SKILL.md`：规范化 frontmatter 和数据库中的指令正文；
- `resources.json`：skill name、description、快照摘要和资源元数据；
- 所有资源文件：写入经过校验的相对路径。

虽然模型已经收到 skill 正文，仍应写入 `SKILL.md`，方便 code-agent 和子进程使用。

### 写入协议

1. 写入前解析并校验全部目标路径；
2. await `ctx.sandbox`，初始化失败时返回明确工具错误；
3. 创建所有必要的父目录；
4. 使用 `writeFiles` 批量写入 `SKILL.md`、manifest 和资源；
5. 可选读取 `resources.json` 或哨兵文件确认写入成功；
6. 返回资源根目录和资源清单。

同一快照始终映射到同一不可变目录和相同内容，因此写入是幂等的。重复调用可以重写相同字节。

只有在性能数据证明重复写入成本明显时，才增加以 sandbox identity 和 snapshot digest 为 key 的进程内缓存。正确性不能依赖缓存，因为沙箱可能被其他进程重建。

### 脚本执行权限

通常应通过解释器执行脚本，例如：

```bash
node "$SKILL_DIR/scripts/generate.mjs"
```

不能仅根据 resource type 推断 executable bit。如果确实需要直接执行，应在存储元数据中增加显式 `executable` 字段，并在写入后通过沙箱命令执行 `chmod`。

### 无沙箱场景

Session Skill 资源物化依赖 code-agent 文件系统。如果 `ctx.sandbox` 不可用，工具返回 skill 指令、资源清单和明确的 `resources_unavailable` 标记，不能退化为把资源正文放进模型上下文。

未来可以实现本地 materializer，将文件写入 `Global.Path.data`。该实现应遵循同一物化接口，而不是继续在 skill 工具中堆积分支。

## Skill 工具协议

删除 `resources` 参数。加载一个 skill 时，自动将其所有受大小限制保护的资源物化到 code-agent 文件系统。

返回示例：

```xml
<skill_content name="figma-codegen-local">
  ...SKILL.md 指令正文...
  <resource_directory>/home/sandbox/.local/share/opencode/session-skills/ses_x/ssk_x/sha256_x</resource_directory>
  <resources>
    <resource path="scripts/generate.mjs" type="script" size="182321" digest="..." />
  </resources>
</skill_content>
```

所有 XML 属性和值都必须转义，资源正文不得出现在输出中。

对于文件型全局 skill，当 code-agent 工具与服务端共享文件系统时，可以继续返回服务端目录。如果工具运行在隔离沙箱中，则后续应复用相同 materializer，不能把服务端路径伪装成沙箱可访问路径。

## 系统提示词

预加载 skill 时继续只展示资源清单。提示词从：

```text
通过 resource paths 调用 skill 工具读取资源内容
```

修改为：

```text
调用 skill 工具加载指令，并将资源物化到 code-agent 文件系统
```

构建提示词时读取持久化的 `size`，不再通过 `content` 动态计算。

## 更新、移除和清理

更新 skill 时会产生新的 snapshot digest。后续工具调用返回并物化新目录。旧目录不会再从当前工具输出中暴露，因此不会污染当前执行。

卸载或清空 skill 时删除 PostgreSQL 行，但不能为了删除沙箱文件而启动沙箱。物理清理采用尽力而为策略：

- 如果沙箱已运行，可以删除旧快照目录；
- 否则交由后续 workspace/PVC 垃圾回收策略处理；
- 数据库删除不得依赖沙箱清理成功。

现有 PVC 生命周期本身会在沙箱销毁后保留 session 文件，因此完整 workspace 回收属于独立问题。

## 并发模型

- PostgreSQL 是选择当前快照的权威数据源；
- 版本化不可变目录避免新旧版本写入竞争；
- 并发调用写入同一快照时，写入内容完全一致；
- 调用 `writeFiles` 前必须验证完整写入集合；
- 不在 PostgreSQL 中保存持久化 `materialized=true` 标记，因为沙箱重建或调度位置变化后该标记会立即失效。

## 安全要求

- 物化前完成 `skill` 权限校验；
- 禁止物化未经校验的相对路径；
- 目录名使用数据库生成的不可控 ID；
- 转义面向模型的 XML；
- 查询接口不暴露资源正文；
- 日志不得包含资源正文、凭据或含敏感信息的完整 manifest；
- skill 脚本属于不受信任代码，执行仍受现有 bash/tool 权限约束；
- 物化后不得自动执行任何脚本。

## 代码组织

### `src/skill/resource.ts`

新增聚焦的资源模块，包含：

- stored/input/info schemas；
- resource type 判断；
- 相对路径校验；
- 资源大小和数量限制；
- resource digest 和 snapshot digest 计算；
- stored resource 到公开 metadata 的转换；
- 统一目录采集器。

删除 `skill/index.ts` 和 `config/session-load-dot-opencode.ts` 中重复的采集逻辑。

### `src/skill/session-skill.ts`

- 同时解码新旧 JSONB resource 格式；
- 新写入数据持久化 size 和 digest；
- domain service 内部返回 stored resources；
- 增加面向 API 和模型的 info 转换函数。

### `src/tool/skill.ts`

- 删除 `resources` 参数；
- 权限通过后物化 Session Skill 资源；
- 只返回指令、资源目录和 metadata；
- 异常大的 `SKILL.md` 仍可使用通用截断机制，不能通过资源正文绕过限制。

第一阶段可以将物化实现保留在 skill 工具附近。当文件型全局 skill 或本地执行也需要复用时，再抽取独立 materializer service。

### HTTP schema 和 handler

- create payload 使用 `ResourceInput`；
- list/create/load response 使用 `ResourceInfo`；
- handler 返回前将 stored row 转换为公开 info；
- 为非法路径和超限增加有类型的验证错误。

### 文档和提示词

更新所有要求模型读取 resource content 或将其写入 workspace 的文档。明确记录工具返回的资源根目录，以及推荐使用解释器执行脚本。

## 实施阶段

### 第一阶段：拆分内部数据模型

- 增加 stored/input/info resource schemas；
- 实现旧 JSONB 兼容解码；
- 合并资源采集和校验逻辑；
- 先补充测试，不改变运行行为。

### 第二阶段：资源物化

- 在 `skill` 工具中增加沙箱文件写入；
- 停止返回资源正文；
- 更新系统提示词指导语；
- 增加更新和沙箱重建集成测试。

### 第三阶段：API 收敛

- Session Skills API 只返回资源 metadata；
- 更新 endpoint schema、文档和调用方；
- 仅在修改生成的 Protocol/Client API 时运行 client generate；
- 当前 Legacy Session Skills endpoint 没有稳定出现在生成客户端中，应增加显式契约测试。

### 第四阶段：可扩展存储

如果资源需要突破当前文本 bundle 限制，将资源正文迁移到内容寻址的 blob 或对象存储。PostgreSQL 只保存 digest、size、type 和 blob key，materializer 协议保持不变。

## 测试方案

### 单元测试

- 相对路径合法场景和全部拒绝场景；
- 符号链接目录边界；
- UTF-8 字节大小计算；
- 单文件、数量和预计 bundle 总量限制；
- 旧 JSONB 自动补充 size 和 digest；
- snapshot digest 稳定，并随正文、路径或资源内容变化；
- XML 转义；
- resource type 判断支持 `.mjs`、`.cjs` 等脚本扩展名。

### Session Skill service 测试

- create/update/list 在内部保留完整持久正文；
- 公开转换结果不包含资源正文；
- update 保留数据库 ID 并改变 snapshot digest；
- 父子 session 隔离行为保持不变；
- PostgreSQL cascade 删除行为保持不变。

### Skill 工具测试

- 调用后物化全部资源并返回资源根目录；
- 大型脚本绝不出现在工具输出中；
- 重复调用保持幂等；
- 更新 skill 后使用新版本目录；
- 已删除资源不出现在新目录；
- 沙箱不可用时返回标记且不嵌入正文；
- 权限拒绝发生在任何沙箱写入之前；
- 恶意路径无法逃逸资源根目录。

### 集成测试

- 导入包含大于 50 KiB 脚本的 skill；
- 调用 skill 后，从返回目录执行该脚本；
- 销毁并重建沙箱后，再次调用并执行；
- 父子 session 共享沙箱时使用不同资源目录；
- 覆盖 PVC 和非 PVC 模式；
- 验证 list/create/load HTTP response 不包含资源正文；
- 验证 `.opencode` 和直接目录导入生成相同快照。

## 验收标准

- Session Skill 资源正文不出现在系统提示词或 skill 工具输出中；
- 在配置的资源限制内，长文本脚本可以导入、持久化到 PostgreSQL、物化并执行，无需模型中转复制；
- 沙箱销毁重建后，不依赖原始目录即可恢复资源；
- 导入或更新 skill 不会创建沙箱；
- 无需阻塞式 migration 即可读取现有 JSONB 行；
- 所有物化目标都位于对应 session 的 skill 根目录下；
- Session Skills 查询响应大小只取决于 metadata，不再取决于资源正文大小。
