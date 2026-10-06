# Session 临时问答：/btw 对应 REST API（V2）

> 状态：用例设计，尚未执行 Docker / API / PG 验证，不代表测试通过。
>
> 功能：基于现有会话上下文做一次临时生成，返回文本，不把此次问题和答案加入会话历史，不创建子会话。
> 本机安装的 OpenCode v2.0.21 TUI 通过 `opencode.btw` 插件调用此能力；当前仓库没有该 TUI 插件注册代码，但已有后端接口。

## 1. 接口与实现依据

| 项目 | 契约 |
| --- | --- |
| 方法和路径 | `POST /api/session/{sessionID}/generate` |
| 请求 | `{"prompt":"临时问题"}`，`prompt` 为必填字符串 |
| 成功响应 | HTTP `200`，`{"data":{"text":"回答文本"}}` |
| 模型与上下文 | 使用当前会话的模型、agent、instructions 和可回放历史 |
| 返回方式 | 等待此次生成完成后返回 JSON，不是流式 SSE 回答 |
| 持久化 | 此次问题、回答不进入主会话消息、inbox、pending 或 durable event |
| 插件钩子 | 走 `session.generate`，不是主循环的 `session.context` |

代码依据：

- `packages/protocol/src/groups/session.ts`：`session.generate` 接口契约。
- `packages/server/src/handlers/session.ts`：返回 `data.text`；会话不存在映射为未找到错误，其他生成失败映射为服务不可用错误。
- `packages/core/src/session/generate.ts`：读取上下文和 `SessionHistory.preview()`，追加临时 user 消息，调用 `llm.generate()`。
- `packages/core/src/session/model-request.ts`：generate 请求准备及钩子。
- `packages/core/test/session-generate.test.ts`：已有上下文读取、持久化状态不变和 generate 钩子的单测。

**边界说明**：

- API 不自动添加 TUI 的 `/btw` 提示词。模拟 TUI 时，应在 `prompt` 前加入“基于已有对话简洁回答，不调用工具、不执行操作”的要求。
- 请求仍可携带工具定义；不能断言 `tools` 为空或 `toolChoice` 为 `none`。此生成路径没有执行工具调用的 agent 循环。
- “会话历史不变”不等于没有模型费用、没有请求日志，或整个数据库绝对零写入。日志和请求诊断应单独审计。
- 本接口不同于无会话上下文的 `POST /api/experimental/generate`，也不走 `/command`。

## 2. 测试环境与证据

1. SaaS 服务在 OrbStack Docker 中运行，配置 OpenSandbox，PG 使用 `127.0.0.1:5432/opencode-v2-up`。
2. 所有业务操作通过 V2 API 发起，附加当前测试环境实际认证信息，不在证据中保存口令。
3. 使用独立测试会话，仓库工作目录为 `/workspace`；不修改现有业务会话。
4. Code Mode 保持默认开启。记录实际模型请求或测试探针，确认工具目录及请求准备未被意外绕过；不能仅以配置值证明生效。
5. 为上下文断言生成每次运行唯一的代号，例如 `BTWF-<随机串>`，避免模型凭常识猜中。
6. 正常 prompt 返回接受结果不代表主任务完成。取基线前，等待其生成完成、会话 idle，确认没有后台标题生成、主任务或其他写入。
7. 保存镜像版本、请求与响应、脱敏模型请求、会话消息列表、事件游标、PG 前后快照和沙箱哨兵文件状态。

请求示例：在 API 客户端选择 POST 和上述路径，设置 `Content-Type: application/json`，body 为：

```json
{
  "prompt": "用户正在询问此前对话的一个临时问题。请仅根据已有上下文，用 Markdown 简洁回答，不调用工具，不执行操作。\n\n此前约定的项目代号是什么？只返回代号。"
}
```

### PG 基线与对比

使用只读查询采集完整记录，而非只比较消息数量。通过 `psql -v sid='<测试会话ID>'` 提供变量，前后各执行一次以下查询并保存结果；将 JSON 解码后做结构比较。

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT jsonb_build_object(
  'session', (SELECT to_jsonb(s) FROM session_v2 s WHERE s.id = :'sid'),
  'messages', (SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.seq), '[]'::jsonb)
               FROM session_message m WHERE m.session_id = :'sid'),
  'inbox', (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.enqueued_seq), '[]'::jsonb)
            FROM session_inbox i WHERE i.session_id = :'sid'),
  'pending', (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.admitted_seq), '[]'::jsonb)
              FROM session_pending p WHERE p.session_id = :'sid'),
  'sequence', (SELECT to_jsonb(q) FROM event_sequence q WHERE q.aggregate_id = :'sid'),
  'events', (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.seq), '[]'::jsonb)
             FROM event e WHERE e.aggregate_id = :'sid'),
  'instructions', (SELECT to_jsonb(i) FROM instruction_state i WHERE i.session_id = :'sid'),
  'children', (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.id), '[]'::jsonb)
               FROM session_v2 c WHERE c.parent_id = :'sid')
);
COMMIT;
```

**idle、无并发写入的用例期望**：前后快照相同，包括会话的模型、agent、时间戳、cost/tokens；不能只比较行数而遗漏已有记录被修改。
全局 `instruction_blob` 仅在独占测试数据库或单测中比较，避免其他会话写入造成误报。
若上下文初始化或后台活动导致差异，应记录具体差异并分析来源，不直接忽略或宣称通过。

## 3. 功能与隔离用例

### BTW-01：读取已有会话上下文

步骤：
1. 通过 `POST /api/session` 创建会话 A，用普通 `POST /api/session/{id}/prompt` 约定唯一项目代号，等待完成。
2. 读取 `GET /api/session/{id}/message?order=asc` 并保存 PG 基线。
3. 调用 generate 询问此前的项目代号，不在此次请求中重复代号。

期望：HTTP 200，`data.text` 为字符串并准确包含代号；模型请求包含已有对话和临时问题，使用 A 的模型；PG 快照与消息列表不变。

### BTW-02：临时问题与答案不进入后续对话

步骤：
1. 在 generate 中加入只在本次出现的临时代号 `BTWT-<随机串>`，要求原样回答。
2. 保存响应，读取消息、事件与 PG 快照，确认没有临时代号对应的新消息。
3. 再次 generate，询问“之前的临时问答中给出的临时代号是什么”，本次不重复该代号。
4. 最后发送普通 prompt，捕获其模型输入。

期望：首次回答可返回临时代号，但后续两次模型输入均不含该临时代号及首次临时答案；普通 prompt 仍走正常消息持久化流程。
是否隔离以捕获的模型输入为准，不能仅以模型回答“我不知道”判定通过。

### BTW-03：只有 JSON 回答，不产生主任务事件或子会话

步骤：在 idle 会话上先记录事件游标并订阅该会话事件，再调用 generate。

期望：得到完整 JSON 响应；不因该请求新增 inbox/pending、user/assistant 消息、工具执行事件或子会话。
无其他活动时，durable event 和 sequence 不变；连接心跳等传输事件不算业务写入。请求期间不将主会话切换为一次新的主任务。

### BTW-04：工具及 Code Mode 不执行

步骤：
1. 通过沙箱接口准备 `/workspace/btw-sentinel.txt`，保存内容和哈希。
2. 保持 Code Mode 开启，generate 要求创建 `/workspace/btw-created.txt` 并修改哨兵文件，同时添加“不调用工具、不执行操作”的提示。
3. 记录模型请求、工具执行探针、相关事件与沙箱文件状态。
4. 在确定性单测中让模型返回工具调用，确认 generate 不调用工具执行器。

期望：没有工具执行，哨兵不变、新文件不存在；Code Mode 目录在请求准备中可被验证，但没有执行动作。
若模型声称“已修改”，文件断言仍必须通过，并单独记录回答质量问题。禁止把模型遵守提示词等同于执行层禁止工具。

### BTW-05：空历史会话

步骤：创建没有消息的会话，配置可用模型，generate 询问一个不依赖历史的问题。

期望：正常返回回答，消息列表仍为空，没有初始化 user/assistant 消息或子会话；初始化前后的指令状态变化如有发生，需单独定位并记录。

### BTW-06：最新上下文、模型及 agent 选择

步骤：
1. 普通对话把项目代号由 F1 更新为 F2，等待完成，generate 询问当前代号。
2. 通过现有 V2 API 切换会话模型/agent，并设置会话指令，再生成。
3. 捕获模型请求；单测另行验证 instruction update 的拼接。

期望：回答 F2；请求使用最新模型/agent，包含适用指令；generate 自身不持久化指令状态，也不改变模型/agent。
不假设 generate body 支持 `model` 或 `agent` 覆盖，接口只声明 `prompt`。

### BTW-07：多会话并发隔离

步骤：创建 A/B 两个会话，各自记录不同唯一代号；同时调用两个会话的 generate，并对 A 并发发送两条不同问题。

期望：每个响应关联正确请求和会话上下文，不串入另一个会话的代号；两个会话的 PG 快照不变，无子会话或额外消息。
验证请求头/上下文中的 sessionID 与目标一致，不只检查最终文本。

### BTW-08：主任务运行期间的临时问答

步骤：在受控慢模型下启动普通 prompt；主任务运行时调用 generate，记录两类请求、事件与响应。

期望：临时请求不被作为 steer 输入入队，不主动中断或重启主任务；主任务后续可完成；generate 读取当时可回放的上下文，不要求看到尚未持久化的增量。
主任务会合法写 PG，本用例不能要求全量快照相等；应凭唯一临时标记及事件来源确认没有 generate 引起的消息/工具/队列写入，并与无 generate 的控制运行对照。

### BTW-09：压缩后的会话上下文

步骤：构造含唯一事实的历史，通过现有压缩 API 完成 compaction，再追加新事实并等待完成，随后 generate 询问新旧事实。

期望：按当前历史回放边界读取摘要及之后消息，能回答摘要保留的事实与新事实；不把已截断原文全量重新注入，不新增 compaction 或修改其状态。
旧事实必须已保存在压缩摘要中，否则不能把遗忘判为 generate 故障。

## 4. 错误与恢复用例

| 编号 | 操作 | 期望与证据 |
| --- | --- | --- |
| BTW-10 | 对合法格式、但不存在的 sessionID 调用 generate | HTTP 404；不创建会话、不调用模型、不写消息。另测无效 ID 的请求校验，勿混淆两种错误 |
| BTW-11 | body 缺少 `prompt`，或传 `null`、数字 | 在 HTTP schema 层返回 4xx；不调用模型、不污染会话。记录实际状态码和响应；空字符串是合法 String，不预设必然被拒绝 |
| BTW-12 | 受控注入 provider 失败或模型不可用 | 生成层错误映射为 HTTP 503（前提是已通过身份及请求校验）；保存错误响应，PG 历史不变；恢复 provider 后再次 generate 成功，普通 prompt 仍可执行 |
| BTW-13 | 使用缺失/无效认证调用已配置认证的服务 | 被实际认证策略拒绝，不执行模型请求。多租户跨会话测试按服务现有授权策略另行断言，不能从此接口推断已实现租户隔离 |

## 5. 单测与验收要求

- Core 确定性测试：临时 prompt 仅加入当次模型输入，持久化快照不变，历史包含 settled 消息及指令更新；`session.generate` 钩子可变换请求，`session.context` 不触发；不启用主循环 stateful WebSocket。
- 工具测试：模型返回工具调用时，执行器调用次数为 0；保留携带工具定义的现有行为，不将其误写为 `tools=[]`。
- Server 接口测试：覆盖真实路由/middleware、200 响应结构、404、body 校验与 503；服务测试不可用无会话的 `experimental.generate` 用例代替。
- Docker E2E：必须验证回答结果、模型/工具执行过程及 PG 状态三层；SQLite/mock 单测不能替代 SaaS PG 验证。
- 发现不符合预期时保存复现证据并提出问题；修复后重跑失败用例及上下文/历史隔离回归。不在本文预填“已通过”。
- 测试结束只通过 API 清理本次创建的会话和沙箱测试文件，不直接删改业务数据库记录。
