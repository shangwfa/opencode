# Session 资源统一解析方案

状态：修订技术规格；首批资源 owner 共享与 Skills 优先级已实施，其余阶段进行中。日期：2026-10-01。具体范围、待补齐事项和测试证据见 `docs/design/session-resource-unification-progress.md`。本文区分目标合同、现有兼容语义与实施前验证门槛；不以设计文字代替运行证据。

## 1. 目标与核心决策

Agents、Skills、MCP、AGENTS.md、Tools、Commands 共享同一套来源模型、发现协议、快照生命周期、诊断与管理规则，保留各自的领域解析和执行行为。

统一优先级为：Sandbox 项目来源 > 主会话资源域的 Session API 来源 > SaaS 配置/Location 来源（含 builtin）。“全局”在这里指部署配置及 Location 已完成解析的结果，不表示再创建一个 process-global 注册表。子会话是主会话内部执行分支，对用户不可见，共享主会话资源域与物理 Sandbox。

统一的是输入与解析流程，不是把六种资源塞入同一张表或强行采用同一种 merge。

SaaS 不扫描其 `/workspace` 来代替用户仓库，不导入 Sandbox 用户源码。用户项目文件只通过 SandboxProvider 获取；服务端承担 AI、权限、解析和协议，用户代码及 local MCP 进程在 Session Sandbox 中执行。

## 2. 当前实现依据与缺口

| 类型      | 当前依据                                                                      | 缺口                                                                                   |
| --------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Agent     | `packages/core/src/session/agents.ts` 的 `mergeAgents`                        | 已有三层字段叠加；扫描失败会退回低层；disabled 后选择路径需验证不会重新选回全局        |
| Skill     | `packages/core/src/session/skills.ts` 的 `merge`                              | 当前 Session 覆盖 Sandbox，方向相反；资源目录和有效定义应一起解析                      |
| MCP       | `packages/core/src/session/mcps.ts` 的 `stored/reconcile`                     | 无项目配置发现；目前只在工具名字冲突时覆盖，不能替代服务级覆盖                         |
| AGENTS.md | `session/agents-md.ts`、`config/plugin/instruction.ts`、`tool/plugin/read.ts` | Session PG 指令已接入；项目发现使用 host FS，Sandbox read 提前返回，未形成统一项目来源 |
| Tool      | `session/tools.ts`、`session/tool-scan.ts`、`tool.ts`                         | 三层执行 E2E 已通过；管理列表仍只列 PG；扫描、刷新与诊断和其他类型不统一               |
| Command   | `session/commands.ts`                                                         | 已有三层整定义覆盖；扫描失败行为与 Agent/Skill 不同                                    |

上述是源码审核及既有测试依据，不代表六类资源的 API E2E 已全部通过。AGENTS.md 是标准文件名，不将 Agent 定义 markdown 和 AGENTS.md 指令混为一类。

## 3. 分层架构

### 3.1 四个共享职责

1. **ProjectResourceDiscovery**：按物理 Sandbox 实例扫描项目资源，输出有界 manifest 和内容摘要，不负责领域 merge。
2. **领域 Adapter**：Agent/Skill/MCP/Instruction/Tool/Command 分别完成 decode、校验、身份生成、合并和运行时准备。
3. **SessionResourceSnapshot**：读取主会话资源 owner 的 PG 记录及 Location 来源，绑定项目 manifest，为当前执行 Session 构造本步骤的不可变有效资源视图。
4. **领域 Runtime**：继续使用现有 Agent、SkillInstructions、SessionMcps、SessionToolSandbox、Tool.snapshot、SessionCommands、Instructions；不创建第二套 executor 或 registry。

Core 持有这些运行时服务，通过 `makeLocationNode` 加入现有 Location graph。Schema 只放浏览器安全的来源、诊断、API 合同。Protocol 定义 HTTP，Server 做 Session 存在性及请求映射。

### 3.2 资源来源描述

共享描述包含：kind、logicalKey、source（global/session/sandbox）、sourcePath、revision、status、diagnostics。

- logicalKey 是领域身份：agent ID、skill ID、MCP server name、tool effective name、command name；Instruction 采用有作用域的文档身份。
- revision 使用规范化定义的内容 hash，不能仅以 PG 更新时间或文件 mtime 作为执行版本。
- resolved 来源可保留 contributions，解释继承字段来自何处；不得只返回一个 `source=sandbox` 就丢失 Agent 低层字段来源。
- 定义 status 区分 ready、disabled、invalid、unavailable；后两者不等于 absent。观测状态另用 not-observed/observed，运行准备状态另用 not-prepared/prepared，避免混成一个多义枚举。
- provenance 与可执行定义分离，不为 Tool registry 引入第二种 executable entry。

## 4. 各领域解析语义

### 4.1 Agent：字段叠加

按 global → session → sandbox 叠加已提供字段；headers/body 合并，permissions 通过既有 Permission 领域规则组合，不自行发明 allow/deny 算法。

disabled 是当前层的显式遮蔽标记，阻止直接使用该 ID 的低层定义。为保留现有 `mergeAgents` 和测试语义：更高层存在一个有效、未禁用的定义时，可以重新建立该 Agent（即使未声明 `disabled:false`），其起点采用现有 `Agent.Info.default`，不偷偷恢复已被禁用的低层字段。解析输出保留禁用/恢复链路；最终仍被遮蔽的 ID 不能通过全局 fallback 重新选回。

Agent.select、显式切换、title 和 subagent 选择必须使用同一有效视图。显式选择被禁用 ID 返回领域错误，不能再走全局 select 复活该 ID。

### 4.2 Skill：完整定义及资源整体替换

按 ID 选择最高优先级的完整 Skill，正文、description、autoinvoke、资源根目录一起替换，不从低层拼接资源。

Session 私有 Skill 及其资源快照存 PG，在 Sandbox 的非发现目录中按 content hash 物化；项目 Skill 使用自身 Sandbox 文件目录。目录、执行、手动激活、自动指导均使用同一有效版本。移除高层后下一步骤回退；更新已激活正文是否需要撤销/重载，需显式 instruction delta，不能靠目录变更假定旧正文已消失。

### 4.3 MCP：服务级整体替换

按 server name 选出最高优先级完整配置，再连接有效服务；不在连接之后通过同名 tool overlay 假装服务覆盖。

若 Session 同名服务只提供 `new_tool`，全局该服务的 `old_tool` 不应继续泄漏。disabled 同样遮蔽整个服务。工具、提示词、资源及 MCP instructions 必须由同一有效服务产生。

local MCP 在 Sandbox 启动，remote MCP 由 SaaS 连接；二者继续复用 McpClient 和 canonical McpTool。必须让已有 Location MCP 工具变换支持请求级按 server 排除被遮蔽来源，保留其前后 plugin registration 的次序，不能粗暴删除所有同 namespace 的最终工具。

定义缓存可以共享，连接不能据此共享。remote MCP 连接键包含 Session ID、server、config revision、credential identity/revision；local MCP 还包含物理 Sandbox ID/incarnation。Session 之间默认不共享连接、协议 session 或进程状态。凭据 revision 是内部不透明版本，不能向客户端输出密钥或其摘要。

有每资源锁、scope cleanup、连接失败关闭完整作用域。新版本有效配置不可达时标记该服务 unavailable，不继续调用低层或旧连接；无关可用能力仍可继续。Catalog notifications 更新工具目录；不能永久复用首次连接的 tools 数组。端口与进程隔离、跨实例连接生命周期见 §12。

### 4.4 Tool：完整 ToolDefinition 替换

逻辑身份使用现有 registry effective name。global/Location 有效注册先保留，Session 定义再覆盖，项目定义最后覆盖。

解析后仍只调用现有 `Tool.snapshot` 和 `SessionToolSandbox`；不变更 canonical Tool executor。高层损坏模块不能静默执行同名低层模块；高层无效时遮蔽该逻辑身份并记录 invalid，不阻断无关工具。既有“坏模块隔离，其他工具可用”的行为保持；修复后下一次成功发现重新纳入目录。

初期支持当前 default-export 模块；named exports、helper import 与项目依赖是否兼容必须有独立验收。将源码复制到物化目录并不能自动保证相对 import 的行为等价于项目原目录，不能在方案中默认已支持。

### 4.5 Command：完整定义替换

按 name 整体替换 template、agent、model、subagent、hints；不拼接模板。解析后复用既有 command executable 和参数插值。command 指向的 Agent/Skill 等从同一 snapshot 解析，避免各自重新扫描看到不同版本。

### 4.6 AGENTS.md：指令组合，不是 Map 覆盖

保留各来源，按 global → Session → Sandbox 项目 → 适用子目录指令组合。明确提示冲突时更具体作用域优先；Instructions.combine 的文本顺序本身不等于模型保证执行的优先级。

启动步骤读取 `/workspace/AGENTS.md`；对成功读取的目标文件，获取其适用祖先目录中的 AGENTS.md，全部通过 SandboxProvider。只注入适用路径，兄弟目录互不影响。是否支持 `.opencode/AGENTS.md` 应作为单独产品约定，本方案默认标准 `/workspace/AGENTS.md` 及其子目录文件，不声称上游有该路径约定。

使用稳定 instruction key + content hash；变更/移除产生 changed/removed delta。必须处理已写入历史正文的撤销提示，不能删除 PG 行后假定模型忘记旧指令。主会话 AGENTS.md 对内部子会话同样适用：共享当前正文，独立维护各执行分支的消费状态；共享项目指令按相同 Sandbox 从文件重新发现。当前非继承实现是需要显式迁移的差异，不是目标合同。

## 5. 项目发现与缓存

### 5.1 支持的路径

- Agent：`.opencode/agents/**/*.md`，兼容 `agent/`。
- Skill：`.opencode/skills/**/SKILL.md`，兼容 `skill/`；不要把资源目录下任意 markdown 当作 Skill 主定义。
- Command：`.opencode/commands/**/*.md`，兼容 `command/`。
- Tool：`.opencode/tools/*.{ts,js}`，兼容 `tool/`；首阶段保持现有直层发现范围。
- MCP：项目 `opencode.json(c)` 与 `.opencode/opencode.json(c)` 的 `mcp.servers`。使用当前 Config 的 JSONC decode/normalize 及既有发现顺序，禁止借用 V1 schema 推测字段。
- Instruction：`/workspace/AGENTS.md` 及按访问路径发现的子目录 AGENTS.md。

复用 Config 解析库，不激活整个 Sandbox 配置或插件执行；仅提取本阶段支持字段。direct 与 `.opencode` 的发现顺序必须通过现有 V2 Config 的兼容测试再接入。

同层别名冲突：plural 目录优先于 singular，同目录 Tool `.ts` 优先 `.js`；所有类型采用确定顺序并暴露冲突诊断。不要依赖 find 的输出顺序。

### 5.2 增量扫描与一致性

每个步骤共用一次项目 manifest；按 kind 设文件数、文件字节数、累计内容及 shell 输出上限。超限返回明确错误，不返回“部分成功有效目录”。符号链接、越界路径和重名候选采用明确校验。

轻量 listing 采用 mtime/size，仅是优化；读入后计算内容 hash。显式 refresh 强制重新读内容，覆盖同 mtime/size 内容改变。读取前后 stat 不一致或文件消失时进行有限重试，仍不稳定则返回 unavailable，不把瞬时读取失败解释为删除。

manifest 是逻辑 generation，并非文件系统事务快照；解析步骤冻结一次读到的版本。要提供物理原子批量更新需要仓库侧原子 rename/发布协议，不由缓存虚构。

发现状态的稳定缓存键采用物理 Sandbox ID + incarnation + workspace revision；manifest generation 是缓存值中的版本，不作为每次 miss 都会变化的查找键。相同父子 Sandbox 共享项目发现缓存和主会话 PG overlay；每个执行分支独立捕获步骤快照。Sandbox 重建、仓库重新拉取或切换绑定必定失效。单 key single-flight；旧扫描完成不能覆盖新扫描；bounded LRU、错误不缓存为空目录。

## 6. 步骤快照与失败规则

准备顺序：确认 Sandbox 绑定 → 读取项目 manifest → 读取 Session overlays 和 Location 来源 → 领域解析 → 选择 Agent/Model → 准备 MCP/Tool/Skill 资源 → 生成 instructions 与 Tool snapshot → 发模型请求。

在 PG 只读 REPEATABLE READ 短事务中读取六类 Session overlay，返回物化数据后立即提交；禁止把 Sandbox 扫描、MCP 连接或模块准备放入事务。PG、Sandbox 和 Location 无分布式事务，快照是可追踪的输入版本组合，不承诺原子跨源写入。执行阶段沿用已有 Session ownership/gate；不能以解析事务替代执行准入。

一个步骤 advertised definition 与 captured executor 属于同一版本。已有 Tool snapshot 语义继续保留。MCP executor 也要绑定连接版本并计数借用，不能执行时 reconcile 到另一配置；刷新不关闭仍被运行中步骤借用的连接，结束后释放。

错误统一分类：absent 才允许回退；disabled 遮蔽；invalid/unavailable 不允许自动切换同身份低层。错误粒度按 §12.1 执行：局部坏定义隔离，未知来源范围或必要选择失败才阻断。UI inspection 返回完整性及诊断，不能将部分结果标为完整目录。

## 7. API 与持久化

保留现有六类 PG 表及 CRUD：资源记录关联 canonical 主会话 resource owner，API 编辑该资源域的数据，删除 Session override 不删除 Sandbox 文件。内部以子会话 ID 访问资源时先解析 owner，禁止产生第二份 child overlay；对用户只暴露主会话管理入口。

保留现有 list 的历史含义，避免直接破坏 Tool/MCP 客户端。新增统一只读 inspection 与 refresh：

- `GET /api/session/:id/resources`：返回 kinds、effective、shadowed、disabled、diagnostics、版本、完整性状态；默认不包含源码、指令正文或凭据。
- `POST /api/session/:id/resources/refresh`：可指定 kinds；强制项目内容刷新并返回 inspection。与运行中步骤区分 generation，不承诺更改其快照。

旧 Agent/Skill/Command refresh 委托共享协调层。存在性检查、typed errors、API 来源元数据由 Schema/Protocol 统一；effective 和 stored 的区别写入 OpenAPI。

不持久化 Sandbox 定义到 Session 表：否则删除、重建及父子共享会混淆。可在审计中记录来源摘要、winner、版本和失败阶段，不记录 MCP credentials。

## 8. 父子会话与生命周期

目标合同：主会话与全部内部子会话共享一个资源域和物理 Sandbox。用户只有主会话这一管理对象，子会话不是独立的用户可配置项目。六类资源统一从主会话 resource owner 读取，不在创建子会话时复制记录，也不逐层 merge 任意 parent overlay。

区分 `executionSessionID`、`resourceOwnerSessionID` 和物理 `sandboxID/incarnation`：前者关联消息、任务、权限交互和取消；第二者关联六类资源定义与统一 revision；第三者关联文件、项目发现和受控进程。

嵌套子会话最终解析到同一主会话 owner。owner 绑定在创建内部子会话时固定，服务端从持久关系验证；客户端不能指定任意 owner。主会话更新/删除资源后，所有分支下一次步骤准备读取新版本；进行中的步骤保留原快照。资源共享不等于所有分支选择同一 Agent/Model：执行任务的选择仍由分支自身控制。

owner 解析必须区分“内部任务子会话”和“用户显式 fork 的独立会话”，不能只根据 `parentID` 推导共享权限。前者采用本文共享合同；后者若仍是产品能力，则有自己的资源域及生命周期，沿其明确 fork 合同处理。创建时持久化可信的分支类型/owner 关系，读取时校验同租户和主会话有效状态，禁止任意父链跨资源域。

删除子会话只释放其任务、连接借用和 instruction state；不能删除主会话资源记录、停掉其他分支仍使用的进程或销毁共享 Sandbox。删除主会话按现有执行 gate 取消并收束全部分支，然后释放共享资源和 Sandbox；关系建立与关闭需通过持久状态阻止关闭期间创建新子会话。物理生命周期复用 ownership/gate，不由 discovery 重新管理。

共享的是定义和工作区，不自动共享 MCP 协议 session、Tool 模块可变内存、执行取消或指令已消费标记。这些运行状态默认按 executionSessionID 隔离；若工具明确通过工作区文件共享状态，则属于既有共享 Sandbox 行为。

用户的 Session 列表、资源管理和删除入口不展示内部子会话。分支进度、错误和结果归集到主会话任务视图；内部身份仍用于审计、取消及故障定位。用户可见性必须在服务端列表/详情授权和订阅投影实现，不能仅由前端隐藏；查询具体哪些现有内部 API 需要保留按产品接口合同处理。

既有 child 私有定义或 AGENTS.md 非继承状态须在迁移时明确处理：不自动把 child 定义提升到主会话以免同名覆盖主配置，先检查是否存在这类数据，形成兼容迁移决策与测试证据。

## 9. 实施次序

1. 固化来源合同和失败语义；把 Skills 反向优先级、Agent disabled 选择、MCP 服务级遮蔽、Sandbox AGENTS.md 缺口沉淀为失败测试。
2. 提取共享 discovery、manifest、缓存和 inspection；迁移 Agent/Skill/Command/Tool，继续使用既有领域服务，不重写 registry。
3. 引入步骤快照，替换多次扫描、独立 resolver；保留版本审计及 typed failure。
4. 完成 MCP 项目配置发现、服务级来源解析、连接快照和 instructions/catalog 对齐。
5. 完成 Sandbox AGENTS.md 根及嵌套发现、稳定 key/delta、fork 与 compaction 回归。
6. Docker API 全量验收，再更新旧文档/API 描述与架构说明。每阶段最小改动，失败测试修复后重跑。

## 10. 验收矩阵

对六类资源分别通过 API 创建 Session 定义、通过 Sandbox 文件操作创建项目定义，使用唯一标记验证：global → session → sandbox → 删除 sandbox 回到 session → 删除 session 回到 global。

- Agent：字段继承、disabled 遮蔽/恢复、显式选择、title/subagent 使用有效版本。
- Skill：自动目录、主动调用、附件激活、正文和资源目录一致；同 ID 优先级与资源重建。
- MCP：同名服务不同工具集合，低层独有工具也被遮蔽；local/remote、禁用、通知更新、配置热切换和运行中旧连接。
- AGENTS.md：冲突指导顺序、真实模型 request 正文、嵌套适用范围、修改/移除 delta、内部子会话读取主会话当前正文、独立消费状态、compaction 后正确恢复。用请求审计验证输入，不以模型输出单独证明优先级。
- Tool：真实触发、执行内容、文件副作用、schema、缓存更新、import 能力明确验证；Code Mode 默认开启时目录正确。
- Command：展开结果、Agent/Model 切换、shell 插值、subagent 和共享 Sandbox。

通用：同层别名冲突、扫描超限/失败/读取竞态、强制 refresh、父子并发、物理 Sandbox 重建、服务重启、权限、跨 Session 零泄漏；核对 API、模型请求审计、执行终态、Sandbox 副作用和 PG 数据。测试在 Docker 与隔离 PG 上执行，清理仅针对本轮资源并保留证据。

## 11. 交付定义

六类资源均有可解释来源、确定解析语义、可观察刷新/回退、步骤内版本一致、API/模型/执行/PG 闭环证据，才可宣称统一完成。单独的 Map merge 或 T32.29 通过不能代替整体交付。

## 12. 运行时实施规格

### 12.1 错误决策表

| 情况                                    | 解析/运行行为                                    | 是否可调用模型                                          |
| --------------------------------------- | ------------------------------------------------ | ------------------------------------------------------- |
| 某身份在高层不存在且发现完整            | 使用下一层                                       | 是                                                      |
| 明确 disabled                           | 遮蔽身份或整个 MCP 服务                          | 是；选中的必要 Agent 被禁用则失败                       |
| 已知身份的单个文件无效/读取失败         | 遮蔽该身份，输出诊断；不执行低层                 | 是，其他有效能力继续                                    |
| Skill/MCP/Tool 准备失败                 | 遮蔽该资源；不使用旧版或低层                     | 是；显式 Skill 激活则返回对应领域错误                   |
| manifest 全部失败、超限或未知范围       | 有限重试后标记该 kind 不完整，不能提供其低层目录 | 依赖该 kind 的普通执行准备失败；inspection 可读部分诊断 |
| 显式 Agent/Command 不存在或不可用       | 返回领域错误，不改选另一身份                     | 否                                                      |
| 用户拒绝权限、取消、Effect interruption | 沿 canonical 错误/中断路径传播                   | 不转换为来源缺失，也不自动重试副作用                    |

首次接入采用依赖声明，明确某操作需要哪些 kinds，禁止“任何一个 MCP 掉线导致所有普通对话失败”。显式 refresh 可以返回 diagnostics + `complete:false`；旧 refresh 路由保留既有失败响应合同。

未知身份的解码错误必须携带可定位文件诊断；若不能确定会遮蔽哪些逻辑身份，标记该 kind 不完整，不把文件直接跳过当作完整成功。

### 12.2 快照合同及可变边界

快照绑定：executionSessionID、resourceOwnerSessionID、Sandbox incarnation、workspace revision、项目 manifest revision、主会话六类 overlay digest、Location revision、Agent/Model selection、领域有效定义和 catalog revision。内部租约/连接句柄不进入 Schema wire contract。

保证的是一次模型调用及其 tool calls 的**定义与执行分派版本一致**；不默认保证整个 Sandbox 文件系统不变。

- Session Tool 单文件源码按 code hash 物化；项目 Tool 必须在接入前选择并验证依赖策略。不能边广告旧 schema、边重新 import 新代码。
- Session Skill 资源快照按 bundle hash 物化；项目 Skill 外部资源仍是可变工作区文件，其内容读取时效明确记入输出。需要不可变 bundle 时再实现资源闭包，不作隐含承诺。
- local MCP 的配置、入口和连接固定；服务读取的用户仓库内容可以变化。
- Instruction 正文固定于当前快照；文件变化通过下一次 delta 生效。
- 同一模型请求内工具并行执行的工作区副作用遵循现有执行模型；资源快照不提供文件事务隔离。

Session 创建、prompt admission、command 展开、手动 Skill 激活、title 和主模型调用不能强行共用一个长寿命快照。每个操作获取其短期 resolution context；主步骤在模型请求前重新解析。Command 显式 Agent/Model 选择落为既有 Session 输入后再准备主步骤，必要选择在新视图不可用时返回错误而非悄悄变更。

### 12.3 MCP 来源过滤与唯一注册路径

在 canonical Tool registry 内增加**内部注册贡献的来源元数据**：标明 Location MCP producer/server identity。元数据属于 registration transform，不改变 `Tool.Info` 的执行表示或 plugin 作者入口。

请求快照支持按 producer/server 排除贡献：按原 transform 次序重新派生请求 editor；排除被 Session/项目同名服务覆盖的 Location MCP contribution，然后应用 Session/项目 MCP 和 custom tools。不得从最终 effective Map 按 namespace 删除，因为那会误伤后注册的 plugin 工具。

实现应复用现有 State 的 transform replay 能力；若当前 State 无带来源重放接口，只扩展 canonical State/Tool 内部机制，禁止旁建 registry。update/remove/namespace 的重放行为、dispose 幂等和前后 plugin 次序须有测试；只过滤 MCP 生产者，不改既有 plugin overlay 顺序。

MCP runtime owner 按 Session 隔离。local 进程端口通过 Sandbox 内原子分配/绑定协议获得，不再由各进程各自从 9100 搜索；进程命名包含 Session、server、版本，不与兄弟会话冲突。资源销毁只停止对应身份的进程。

remote OAuth 复用现有 Credential/McpOAuth 领域服务，认证状态独立于 config。local 环境变量仅使用显式配置和明确 Sandbox 环境，不透传 SaaS PG/部署凭据。任何 Location 来源 local MCP 在 SaaS 模式也必须经过 Session Sandbox 执行；原 Location MCP 本地连接不得提前启动作为项目后备。remote Location 连接能否共享只在身份与现有全局合同成立时使用，默认 Session 私有配置不共享。

一个 MCP catalog revision 是冻结的 tools/prompts/resources/instructions 视图。通知仅生成新 revision，运行中的步骤保留旧 catalog 和连接借用；旧连接保持到最后一个借用结束。删除/刷新不是强制撤销已广告调用；Session cancel/delete 可以中断借用，完成终态清理后关闭。

### 12.4 多实例与 Sandbox ownership

发现内容缓存是进程内优化，其他实例必须从共享 Sandbox 独立读取并验证 generation；不依赖某实例发失效事件才能正确运行。项目重新拉取操作更新持久 workspace revision，外部 shell 修改仍由下一次扫描发现。

连接所有权采用现有 Session 执行 gate 身份：只允许当前有效执行 owner 建立 local MCP runtime，创建/准备前后均检查 ownership fencing token。不同实例准备同一 Session 时失败者释放自己的连接，不关闭胜者。不要持有 PG 行锁等待网络 I/O。

对“启动后进程崩溃”的 local MCP，Sandbox 内保存带 Session/server/runtime ID 的 owner marker。新 owner 只清理已确定失效的同身份进程，不能依据单个 heartbeat 超时杀掉仍有有效 gate 的 owner。fencing 在 Sandbox 侧无法强制原子检查时，应明确实现能力限制，并先用原子启动锁及重入恢复测试闭环，不能声称已获得分布式 exactly-once。

remote MCP 无法撤回已发送请求；按调用可重试性处理，非幂等 call 不在 failover 时自动重放。副作用 exactly-once 不属于本方案承诺。

### 12.5 AGENTS.md 的适用范围与更新

根 AGENTS.md 在主模型步骤准备时扫描。成功 read 文件/目录后，将其适用祖先链加入当前 Session 的 instruction scope ledger，供下一次步骤准备重新检查内容、缺失和 digest；不能只做一次合成消息而不再跟踪。

从 `/workspace` 到目标目录确定顺序；根去重，兄弟目录不因已发现就对所有文件产生强约束。当前正文需包含作用域路径和冲突说明；无需使用某一兄弟目录的步骤可停用其指令并输出 removed delta。读文件后是否立即驱动新模型请求沿用现有 runner 规则，不额外生成独立循环。

instruction key 带来源 owner 或 Sandbox incarnation + 相对路径；内部分支启动时重新建立消费状态并读取主会话当前正文，不复制主会话的“已消费”标记而漏掉正文。对子会话当前访问路径重新发现项目源。compaction 后通过当前 snapshot 重建，不把历史 removed 通知当作当前正文。API 改 Session AGENTS.md 不直接写项目文件。

Instruction 优先级只限定这些资源间的冲突解释，不改变模型 system/developer/user 角色优先级。不同来源正文作为标明来源和作用域的内容渲染，不能通过任意文件内容伪造真实消息角色。

### 12.6 inspection/refresh API 明细

`GET resources` 不新建 Sandbox、不连接 MCP、不启动用户代码。无 Sandbox/无已观测结果时返回 `status:not-observed` 和 `complete:false`，不能称 absent。已观测缓存标明 revision、observedAt、stale；GET 不声称该缓存是即时执行事实。

`POST resources/refresh` 显式执行只读发现，允许按现有 Session 生命周期获取 Sandbox；不连接 MCP或启动 Tool 模块。返回配置解析/来源诊断，运行准备状态标为 not-prepared，实际 catalog 以模型步骤准备为准。删除资源 CRUD 不触发远程扫描。

请求 fields：kinds 可选且去重，未知 kind 返回 400；响应包含 request ID、Session ID、source revisions、complete、diagnostics 和每 kind 的有效/遮蔽摘要。较大候选列表采用 cursor/limit，固定 cursor 所属 inspection revision，过期返回 409 并要求重取。

诊断包含稳定 code、kind、logicalKey/sourcePath（可用时）、retryable、phase；不返回源码和 credential。Session 不存在 404，body 非法 400，Session 执行冲突 409，单项容量限制 413，底层短暂不可用 503；取消保留请求中断语义。局部解析错误以 200 + diagnostics 返回，不能混同运输失败。

同进程相同 kind 的 refresh single-flight，可重复调用，无用户代码副作用；跨实例允许独立只读扫描。响应写明“强制观测后的定义版本”，不承诺全局单调整数 generation。

### 12.7 配置兼容与明确边界

项目配置按现有 V2 Config 的 direct 和 `.opencode` 顺序读取，至少纳入 `/workspace/opencode.json(c)` 与 `/workspace/.opencode/opencode.json(c)`；实现前用当前 Config 测试固化 json/jsonc 冲突规则，不能仅支持后者就宣称项目配置兼容。

第一阶段只提取 MCP 配置，Agent/Skill/Command/Tool 的项目 markdown/源码按 §5 接入；其他项目 config 字段不是自动生效范围。后续如支持 config 中 agents/commands，必须并入同一来源内的确定次序，不能重复注册。

项目配置中的文件替换在 Sandbox 读取，环境替换通过显式 Sandbox 环境解析；部署/global 配置沿现有部署解析合同。禁止把 SaaS 任意环境变量提供给项目配置。OAuth credential 在 SaaS 认证域解析，不作为 Sandbox 环境输出。

plural 优先、Tool `.ts` 优先是本 SaaS 的明确规则，非已证明的上游兼容结论。迁移前比对现有 aliases 行为并回归。helper imports/依赖闭包仅在通过项目 import 测试后纳入支持合同。

## 13. 实施门槛、回归与迁移

### 13.1 分阶段交付

- A：来源合同、领域纯解析函数、诊断和失败测试；修正 Skill 顺序，保留 Agent 恢复语义。通过纯解析/真实 PG 测试后交付。
- B：共享 Sandbox discovery、缓存和只读 inspection；先替换 Agent/Skill/Command/Tool 现有 scanner，路径范围不额外扩张。证明扫描次数下降且结果等价。
- C：短期 resolution context、PG 一致读取及步骤快照；解决多次扫描，不引入长时间事务。
- D：MCP 服务级解析与 canonical registry contribution filtering；接入 local 隔离端口、连接租约、OAuth、catalog 通知和 ownership。
- E：Sandbox 根/嵌套 AGENTS.md ledger/delta，以及主会话资源共享、分支消费状态、fork/compaction 回归。
- F：Docker API 六类矩阵、故障/并发/重建矩阵与源码镜像一致性核验。全部通过后宣布统一完成。

旧 CRUD 形状保留；新 inspection 使用新增 Schema leaf 合同及当前 API manifest，按仓库生成流程更新 SDK。Session schema 无必要不加字段；workspace revision 若现有模型无法表达，再引入一项有独立 migration 的持久字段，不为了统一抽象迁移六张定义表。

Agent/Skill/Command/Tool 纯 source resolver 与 runtime prepare 分开测试，不能通过运行用户代码实现 inspection。启用阶段必须明确版本/配置开关；同一步骤仅用一个解析路径，禁止新旧路径同时注册。回退到旧代码不能撤销 PG 写入；本次不进行破坏性数据迁移。

### 13.2 必测反例

1. 高层坏 Tool 遮蔽低层同名 Tool，但其他有效 Tool 能调用。
2. Session disabled Agent 被有效 Sandbox Agent 恢复，字段不泄漏；最终 disabled ID 不被选择 fallback 复活。
3. Session MCP 替换全局同名服务，低层独有工具消失，后注册 plugin 同名工具仍按既定次序工作。
4. 主、子及嵌套子会话读取同一主会话六类定义；更新后各分支下一步骤生效。同 MCP server name 的连接不发生端口/进程/协议状态混用。
5. 刷新 MCP 时旧步骤调用仍使用旧连接，下一步骤使用新连接；删除 Session 中断旧借用并清理。
6. 相同 mtime/size 不同内容：普通扫描边界明确，force refresh 必须发现。
7. 扫描返回一半失败/超限：complete=false，不把未扫描高层视为不存在。
8. 两 SaaS 实例竞争同 Session prepare，只有有效 gate owner 建立受控 local runtime；重启恢复不误杀另一个 Session 的进程。
9. PG overlay 并发更新：同次 snapshot 多表来自同一事务视图，下一次 snapshot 读取新版本。
10. AGENTS.md 更新、删除、目录范围切换及 compaction：真实请求正文和 delta 正确，模型输出只作为辅助证据。
11. GET inspection 零 boot/零 MCP connect；refresh 不 import/execute 用户模块；runtime prepare 才启动执行宿主。
12. Code Mode 默认启用；原生工具与 Code Mode catalog 的可见性及权限过滤没有来源泄漏。

13. 子会话资源 API 解析到主会话 owner，无 child overlay 新行；删除子会话不影响主会话定义/共享 Sandbox。删除主会话取消全部分支，关闭中不得再创建分支。
14. 用户列表和事件投影不暴露独立子会话管理对象；内部审计保留分支 ID，结果和错误可在主会话观察，不依赖 UI 隐藏实现授权。

测试结果需记录 API 调用、请求 audit、tool 终态、物理 Sandbox ID/incarnation、目标 PG 行和资源清理结果。通过构建的新镜像验证源码 hash；挂载源码验证与标准镜像构建验证分别记录，不混为一次通过。
