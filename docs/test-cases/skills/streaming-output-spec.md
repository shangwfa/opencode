# 专项验收流式输出规范

验收执行期间必须让执行过程实时可见（思考、工具调用、表单问答、文本、执行状态），
不允许只读执行器日志、也不允许等整轮结束才汇报。本规范沉淀自 skills 专项验收
（2026-10-05/06）的实践与事故教训，适用于所有基于 V2 会话 API 的自动验收。

## 1. 为什么

- 自动验收单轮常需 10–30 分钟；静默等待无法区分「模型长推理」与「链路卡死」。
- 只读执行器日志会丢失 SSE 独有信息（思考过程、表单生命周期、中断原因）。
- 实时流可第一时间发现：表单无人应答、沙箱断连、工具失败、执行被中断。

## 2. 接口

- 端点：`GET /api/session/:sessionID/event`（SSE，`@opencode/protocol` 的 `session.event`）。
- 鉴权：与其它 API 相同的 Basic auth（`opencode:<OPENCODE_PASSWORD>`）。
- 语义：按 sessionID 过滤的公共事件流；以 `server.connected` 开始；断线期间事件不重放。
- 执行入口：模型轮次经 `POST /api/session/:sessionID/prompt_stream`（SSE）驱动；
  `session.execution.*` 是执行生命周期事件。

## 3. 事件到呈现的映射

| 事件 | 呈现 | 说明 |
| --- | --- | --- |
| `session.execution.started` | `exec ▶ 执行开始` | 一轮执行的起点 |
| `session.reasoning.ended` | `think · <思考摘要>` | 思考过程；高频 `reasoning.delta` 不逐条刷屏 |
| `session.tool.input.started` | `tool ◇ <name>` | 工具调用开始 |
| `session.tool.success` / `failed` | `tool ✓/✗ <内容/错误>` | 截断输出，失败暴露错误消息 |
| `form.created` / `replied` / `cancelled` | `form ◇/✓/✗` | 表单生命周期；`cancelled` 往往是卡死信号 |
| `session.text.ended` | `text · <回复摘要>` | 模型文本（截断） |
| `session.execution.succeeded` / `failed` | `exec ✔/✗` | 执行终止 |
| `session.execution.interrupted` | `exec ⏸ (reason)` | 被中断（user/watchdog/…） |

排掉高频噪声（`*.delta`、`step.streamed`、`usage.updated`），只呈现状态与内容要点。

## 4. 工具

`docs/test-cases/scripts/session-sse-watch.mjs`：

```bash
bun session-sse-watch.mjs <base> <password> <sessionID> [durationSec]
```

- 输出格式：`[+mm:ss] 类型 标记 内容`（对齐 TUI 的紧凑单行风格）。
- 每个观察窗口以 `durationSec` 结束（默认 90），把期间新增事件一次性带回，
  既保证实时可见，也避免长阻塞被环境中断。
- 每次失败/结束时打印 `exec ✗/⏸`，窗口结束打印 `exec · 观察窗口结束`。

## 5. 执行节奏与防中断

1. 执行器（含内嵌测试代理）与监视分开：执行器后台运行保证一轮跑完；监视用**短前台命令**滚动输出。
2. **禁止**在前台长跑执行器：命令被中断会连带杀死执行器与内嵌测试代理（进程组信号），
   已连续毁掉多轮进度（现象：`Sandbox reconnect failed`，其后用例必然失败）。
3. 单轮时长尽量控制在 30 分钟窗口内；超过则用 `PROBE_SKILL_CASE` / `PROBE_SKILL_FROM`
   缩小到目标用例（保留依赖链）。
4. 每个用例完成后立即落盘 `result.json` 并转述一行结果；失败附分诊（产品/执行器/模型/环境）。

## 6. 提问自动代答（配套硬要求）

执行期间模型可能调用 `question` 工具提问；自动验收没有真人，必须自动应答：

- 列表 API `GET /api/session/:sessionID/form` **只返回 pending 表单**，且 `Form.Info`
  **没有顶层 `status` 字段**（状态在 `Form.Detail.state`）——不要再按 `form.status` 过滤。
- 按字段类型生成合规答案：`string/select` 取首个选项、`boolean` 默认 `true`、
  `number/integer` 取 `default/minimum`、`multiselect` 返回数组；`external` 跳过。
- 连续 400 两次即跳过该表单并记录字段结构，避免无效重试把执行拖到超时。
- 参考实现：`docs/test-cases/scripts/session-skills-contract-v2.mjs` 的 `answerForms`。

## 7. 与证据落盘的关系

- 执行器保存原始 SSE 事件（`prompt-N.json`）、产物快照、PG 后检、`result.json`。
- 监视输出用于**过程可见**；结论必须以落盘证据为准（`cases[].passed`、`result.json` 字段）。
- 证据目录属于运行产物：确认是否需要入库，避免误删导致文档引用失效。

## 8. 常见现象与处置

| 现象 | 含义 | 处置 |
| --- | --- | --- |
| 窗口内无任何事件 | 模型长推理或执行启动后无产出 | 继续窗口观察；超过预算即超时 |
| `form ✗ cancelled` + `tool ✗ interrupted` | 表单无人应答被 watchdog/超时取消 | 检查自动代答是否命中 |
| `Sandbox reconnect failed` | 测试代理已死（多为前台中断所致） | 本轮报废，清理后重跑 |
| 执行成功但用例失败 | 断言与行为差异 | 分诊：产品缺陷 / 执行器缺陷 / 模型行为 |
| 顶层 `passed` 与 `cases` 不一致 | 以 `cases[].passed` 为准并核查清理错误 |

## 9. 参考实现

- 监视器：`docs/test-cases/scripts/session-sse-watch.mjs`
- 契约执行器：`docs/test-cases/scripts/session-skills-contract-v2.mjs`
- 专项执行器：`docs/test-cases/scripts/session-skills-specialized-v2.mjs`
- 事件工具：`docs/test-cases/scripts/session-skills-events.mjs`
