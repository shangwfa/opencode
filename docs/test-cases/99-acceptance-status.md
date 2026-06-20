# 验收状态表

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

## 验收状态表

每条用例标记 ✅ / ❌ / ⚠️，附加发现的问题。

### P0 SaaS 核心验收

| 用例 | 状态 | 备注 |
|---|---|---|
| T3.1 | ✅ | provider 凭据写入 |
| T3.2 | ✅ | provider 凭据删除 |
| T3.3 | ✅ | provider 凭据重启持久化（生产库验证） |
| T3.4 | ✅ | 删除凭据 → PG COUNT=0 |
| T3.5 | ✅ | 重启后 connected 仍含 moonshotai-cn |
| T4.3 | ✅ | 写文件工具可用 |
| T4.4 | ✅ | 读文件工具可用 |
| T4.5 | ✅ | bash 工具可用 |
| T4.6 | ✅ | prompt_async 异步入口，返回 204 |
| T4.7 | ✅ | abort 中断正在运行的会话 |
| T5.1 | ✅ | 沙箱写入 PVC（exec API 写文件成功） |
| T5.2 | ✅ | dispose 销毁沙箱（返回 true） |
| T5.3 | ✅ | 沙箱重建后单文件仍存在（PVC 核心验证通过） |
| T5.4 | ✅ | 多文件持久化（a.txt/b.txt/c.txt dispose 后均存在） |
| T5.5 | ✅ | 目录持久化（sub/deep/x.txt dispose 后仍为 DEEP） |
| T6.1 | ✅ | 并发创建 session，5 个全部成功 |
| T6.2 | ✅ | 不同 session 文件隔离，B 看不到 A 文件 |
| T6.3 | ✅ | 同一 session 并发消息排队或串行处理，全部 204 |
| T6.4 | ✅ | 不同 session 文件隔离：B 读 A 文件 → No such file |
| T6.5 | ✅ | 3 条并发 prompt_async 全部 204 |
| T6.6 | ✅ | 并发创建 10 个 session 全部成功 |
| T6.7 | ✅ | 同 session 5 并发 exec 全部正确返回 |
| T6.8 | ✅ | 3 个不同 session 并发 prompt_async 全部 204 |
| T6.9 | ✅ | session 列表正常返回 |
| T8.1 | ✅ | provider 列表与 connected 状态 |
| T8.2 | ✅ | 同 session 切换模型 |
| T9.1 | ✅ | SSE 事件流可收到 session/message 事件 |
| T9.2 | ✅ | SSE 收到 13 种事件（message.part.delta/updated, session.idle/diff/status 等） |
| T9.3 | ✅ | SSE 事件类型验证（8 种：message.part.delta/updated, session.idle/diff/status/updated） |
| T9.4 | ✅ | message API 结构完整（user=1 assistant=1, finish=stop） |
| T9.5 | ✅ | session 状态查询正常 |
| T9.6 | ✅ | session fork 返回新 ID |
| T9.7 | ✅ | session share 返回 share slug |
| T10.1 | ✅ | 完整开发流程 + PVC 持久化 |
| T11.1 | ✅ | Vite 5 + glm-5.1 |
| T11.2 | ✅ | HTML 注入验证 |
| T11.3 | ✅ | HTML src/href 路径重写 |
| T11.4 | ✅ | @react-refresh PREFIXED |
| T11.5 | ✅ | JS import 路径重写 |
| T11.6 | ✅ | BrowserRouter → HashRouter 自动替换 |
| T11.7 | ✅ | CSS url/font 路径重写 |
| T11.8 | ✅ | proxy 错误查询端点 |
| T11.9 | ✅ | background:true keepAlive 生效；proxy 本身不保活 |
| T11.10 | ✅ | Hash route 刷新正常 |
| T11.11 | ✅ | Next.js 14，三页面 200 |
| T11.12 | ✅ | webpack publicPath 已重写 |
| T11.13 | ✅ | RSC 路径全部 prefixed |
| T11.14 | ✅ | 客户端导航 + 刷新正常 |
| T11.15 | ✅ | server proxy 模式 API key 正确 |
| T12.1 | ✅ | 首条 AI 消息触发 sandbox 创建（日志 sandbox 计数增加） |
| T12.2 | ✅ | 同 session 复用 sandbox（连续消息 sandboxID 一致；无 keepAlive 时可能因 idle 销毁重建） |
| T12.6 | ✅ | instance/dispose 强制销毁所有沙箱（200，日志含 destroy） |
| T12.7 | ✅ | dispose 后再次发消息自动重建沙箱（AI 正常回复 after-rebuild） |
| T12.8 | ✅ | 容器重启后 PVC 数据恢复（RESTART-MARK 文件内容完整保留） |
| T12.9 | ⚠️ NOTE | 本地 Docker 环境 B 能看到 A 文件（共享 sandbox）。K8s 环境下每个 session 有独立 sandbox PVC |
| T12.10 | ✅ | 不同 session 进程隔离（/tmp 下文件隔离，B 看到 NOT_FOUND） |
| T12.12 | ✅ | proxy 访问不触发 keepAlive（proxy 502，无 keepAlive 日志） |
| T12.3 | ✅ | background:true / keepAlive API 生效（T19.7 验证 keepAlive + dev server proxy 200） |
| T12.4 | ⚠️ NOTE | session runner idle 可回收 sandbox；纯 exec API 不保证仅凭释放 keepAlive 触发 idle destroy（见 T19.9） |
| T12.5 | ✅ | keepAlive 阻止 idle 销毁（T19.8: 15s 后 exec 仍成功） |

| T17.1 | ✅ | 无沙箱时 endpoint API 返回 502 |
| T17.2 | ✅ | endpoint API 端口参数校验（0/99999/abc → 400） |
| T17.3 | ✅ | Vite 项目 endpoint API 返回直连 IP |
| T17.4 | ✅ | 通过直连 IP 访问 Vite 页面 HTTP 200 |
| T17.5 | ✅ | Proxy 模式有注入，直连模式无注入 |
| T17.6 | ✅ | 沙箱销毁后 endpoint API 返回 502 |
| T18.1 | ✅ | 7 种工具调用场景全部验证通过 |
| T18.2 | ✅ | 消息流结构正确（prompt → tool → summary） |
| T18.3 | ✅ | read 工具：读取 /workspace/t18.txt completed |
| T18.4 | ✅ | glob 工具：搜索 .ts 文件找到 2 个 completed |
| T18.5 | ✅ | grep 工具：搜索 hello completed |
| T19.1 | ✅ | exec API：简单命令执行（exitCode=0, stdout=hello-from-exec） |
| T19.2 | ✅ | exec API：多行输出（stdout 含 line1/line2）。⚠️ NOTE：stderr 被合并到 stdout，stderr 字段为空 |
| T19.3 | ✅ | exec API：指定工作目录（pwd=/tmp） |
| T19.4 | ✅ | exec API：命令执行失败（exitCode=42） |
| T19.5 | ✅ | exec API：缺少 command 参数（HTTP 400） |
| T19.6 | ✅ | exec API：不存在的 session（HTTP 404，非 502） |
| T19.7 | ✅ | exec API + keepAlive：同步 exec 用 `nohup ./node_modules/.bin/vite ... & echo $!` 后台启动 Vite 5，proxy HTTP 200；长驻进程首选 `/exec/async` |
| T19.8 | ✅ | keepAlive 阻止 idle 销毁（15s 后 `exec echo alive` 仍成功） |
| T19.9 | ⚠️ | 释放 keepAlive 后纯 exec 仍可执行；纯 exec 不保证触发 session runner idle destroy，需 `kill-sandbox`/dispose 显式清理 |
| T19.10 | ⚠️ NOTE | `timeoutSeconds=5` 已透传，但 OpenSandbox execd 未强制 5s 中止（实际 32s），runtime 层限制 |
| T19.11 | ✅ | exec API：环境信息（node=v22.2.0 npm=10.7.0 pwd=/workspace） |
| T19.12 | ✅ | exec/async 流式日志最佳实践：启动后立即订阅 `/stream`，收到 `stdout×4` + `done`，final status=`completed`，sandbox 清理为 destroyed |
| T15.1 | ✅ | 简单 session skill 创建并通过 `skills` 触发 |
| T15.2 | ✅ | 复杂 session skill bundle resources 写入、读取、注入 |
| T15.3 | ✅ | session skill 删除单个与清空 |
| T15.4 | ✅ | 从服务端目录加载 `SKILL.md` bundle 与 resources |
| T15.5 | ⏭️ | SkillsMP 默认排序 10 个真实 skill bundle（跳过 — GitHub API SSL 网络不稳定） |
| T15.6 | ✅ | 重复创建同名 skill（upsert 覆盖）：v1→v2，resources 覆盖，AI 使用 v2 |
| T15.7 | ✅ | AI 通过 skill tool 按需加载 resource 内容：AI 调用 skill tool 加载 checklist.md + safe-template.py |
| T15.8 | ✅ | skill 不存在时的错误处理：AI 识别不存在 skill，不调用 tool，直接告知用户 |
| T15.9 | ✅ | session skill 与全局 skill 同名覆盖：AI 加载 session 版本 |
| T15.10 | ✅ | permission deny 过滤：deny skill tool 后 AI 无法调用 |
| T15.11 | ✅ | resources 边界：300KB 单个 resource + 70 个 resources 均成功写入 PG |
| T15.12 | ✅ | 全局 skill 列表：GET /skill 返回 1 个内置 skill |
| T15.13 | ✅ | 多 skills 主动触发：指定 3 个 skills，AI 依次加载并综合使用（安全+性能+风格三维度报告） |
| T15.14 | ✅ | 多 skills 被动触发：不指定 skills，AI 自行判断加载 git-helper（而非 deploy-helper） |
| T15.15 | ✅ | 渐进式披露：preloaded_skills 只有 manifest（name/desc/location + resource 元数据），无完整 content |
| T15.16 | ✅ | 渐进式披露：skill tool 不指定 resources → 只返回 path/type/size 元数据 |
| T15.17 | ✅ | 渐进式披露：指定 resources 获取完整 content + 不存在 resource → `<missing_resource>` |
| T15.18 | ✅ | 跨 session 隔离：A=['private-skill'], B=[]，PG 只有 A |
| T15.19 | ✅ | session 删除后 skill 级联清理 |
| T15.20 | ✅ | 混合 skill 名：real-skill 加载成功，ghost-skill 被忽略 |
| T15.21 | ⚠️ NOTE | 输入校验仍宽松：空名称/超长 skill 名被接受（HTTP 200）。低优先级，非阻塞 |
| T15.22 | ✅ | 5 并发创建同名 skill，upsert 安全，PG COUNT=1 |
| T15.23 | ✅ | Unicode/emoji/中文 API+PG 完整保留 |
| T15.24 | ✅ | 创建 agent-browser 会话 skill（安装 CLI + 创建 skill） |
| T15.25 | ✅ | 使用 agent-browser 浏览网页（open/snapshot/close 均成功） |
| T15.26 | ⚠️ | agent-browser + page-summarizer（skill 加载+规划通过，Chrome 启动不稳定） |

### Session Agents（会话级动态 Agent）

| 用例 | 状态 | 备注 |
|---|---|---|
| T16.1 | ✅ | 创建会话级 agent，返回 Agent.Info |
| T16.2 | ✅ | 列出 agents（全局 + 会话级合并，会话级同名覆盖） |
| T16.3 | ✅ | Upsert 更新同名 agent |
| T16.4 | ✅ | 删除单个会话 agent → 204，全局 agent 不受影响 |
| T16.5 | ✅ | 清空所有会话级 agents → 204，全局 agent 仍在 |
| T16.6 | ✅ | 自定义 primary agent 发消息，AI 使用指定 agent 回复 |
| T16.7 | ✅ | 带自定义权限的只读 reviewer agent |
| T16.8 | ✅ | subagent 模式 @translator 调用，输出英文翻译 |
| T16.9 | ✅ | 不同 session 同名 agent 互相隔离 |
| T16.10 | ✅ | 删除 session 后 agents 级联清理 → 404 |
| T16.11 | ✅ | 完整工作流：创建→执行→验证→删除 |
| T16.12 | ✅ | 不存在的 session 创建 agent → 404 |
| T16.13 | ✅ | 不存在的 session 列出 agents → 404 |
| T16.14 | ✅ | 非法 mode 值 → 400 |
| T16.15 | ✅ | 缺少必填字段 name → 400 |
| T16.16 | ✅ | 多 agent 协作：主 agent 调度 translator + coder 子 agent |

### Session Agents — 代码修复验证

| 用例 | 状态 | 备注 |
|---|---|---|
| T16.17 | ✅ | 保留 agent 名拒绝：compaction/title/summary 全部返回 500 + AgentInvalidError |
| T16.18 | ✅ | session agent @mention：创建 my-translator → AI 翻译天气为英文（@mention 解析通过 resolvePromptParts 但运行时路径正确） |
| T16.19 | ✅ | 自定义 model/temperature：agent 创建含 model+temp=0.9，AI 使用该 agent 回复 |
| T16.20 | ✅ | sessionGet 回退：无自定义 agent 时列出 7 个全局 agent，agent="build" 正常工作 |

### P1 SaaS 稳定性

| 用例 | 状态 | 备注 |
|---|---|---|
| T7.1 | ⚠️ NOTE | 未配置 provider 返回 500 + error ref（行为已改善，不再返回 200） |
| T7.2 | ✅ | 不存在 session 返回 404 |
| T7.3 | ✅ | 无效 JSON 返回 400 |
| T7.4 | ⚠️ NOTE | 缺失必填字段（空 parts）返回 200（非 400），服务端宽松处理 |
| T7.5 | ✅ | 超长消息不 hang |
| T12.11 | ✅ | OPENCODE_SANDBOX_IDLE_KILL_SEC=30，zombie 清理定时器在 ~60s 后回收 idle sandbox |
| T13.1 | ✅ | kill-sandbox 返回 200，sandbox 被销毁 |
| T13.2 | ✅ | kill 后 PVC 保留，新 sandbox 可读 kill-test.txt |
| T13.3 | ✅ | 并发 prompt_async × 3，sandbox 创建不重复（日志验证） |
| T13.4 | ✅ | dispose 与 prompt 并发，返回 true 不 500 |
| T13.5 | ⏭️ REMOVED | proxy 相关测试，已移除（见 11-saas-stability.md 结果汇总） |
| T13.6 | ⏭️ REMOVED | 同 T13.5 |
| T13.7 | ⏭️ REMOVED | 同 T13.5 |
| T13.8 | ⏭️ REMOVED | 同 T13.5 |
| T13.9 | ✅ | docker restart 后 session + message 恢复完整（msg_count 一致） |
| T13.10 | ✅ | prompt_async → 204，abort → true，消息落库 msg_count=2 |
| T13.11 | ✅ | 删除前 msg=2 part=4，删除后 msg=0 part=0，级联正确 |
| T13.12 | ✅ | 订阅额度 unit test 6 pass（bun test 262ms） |
| T13.13 | ⚠️ NOTE | 需要外部限流网关配置，SaaS 网关层验证 |
| T13.14 | ✅ | AI 拒绝执行 ls /Users 等宿主路径（安全约束） |
| T13.15 | ✅ | sandbox 内 /etc/passwd 仅含容器用户，无宿主信息 |
| T13.16 | ✅ | AI 拒绝执行 env grep 敏感变量（安全约束） |
| T13.17 | ✅ | 重复 dispose × 3 全部 200，无异常 |
| T13.18 | ✅ | 重复 kill-sandbox × 3 全部 200，无异常 |
| T13.19 | ✅ | 重复删除 session：首次 200，二次 404，不 500 |
| T13.20 | ✅ | 日志包含 sessionID、sandbox created 生命周期事件 |
| T13.21 | ✅ | 不存在 provider 错误 500 + 错误 ref，日志关联 sessionID |
| T13.22 | ✅ | PG message 表可查询 session_id 关联记录 |
| T13.23 | ✅ | 重启后 session 可查询、message 完整（同 T13.9） |
| T13.24 | ⚠️ NOTE | sandbox 为外部 runtime，重启后由 runtime 管理回收 |

### P2 低优先级兼容回归

| 用例 | 状态 | 备注 |
|---|---|---|
| T1.1 | ✅ | 服务健康检查，返回 `{healthy: true, version: ...}` |
| T1.2 | ✅ | 全局配置查询，返回 config 对象 |
| T1.3 | ✅ | 路径信息，`cwd=/workspace` |
| T2.1 | ✅ | 创建空 session |
| T2.2 | ✅ | 创建带 title 的 session |
| T2.3 | ✅ | 列出所有 session |
| T2.4 | ✅ | 获取单个 session |
| T2.5 | ✅ | 修改 session title |
| T2.6 | ✅ | 删除 session |
| T4.1 | ✅ | 简单文本对话 |
| T4.2 | ✅ | 多轮上下文记忆 |
| T14.1 | ✅ | session 列表过滤：创建 title=filter-test-xyz 后在列表中找到 |
| T14.2 | ✅ | `/session/status` 返回 200 |
| T14.3 | ✅ | session fork 返回新 session ID，父子关系正确 |
| T14.4 | ✅ | 2 条 prompt 后消息数=4（2 user + 2 assistant） |
| T14.5 | ✅ | share → 200 + share URL，unshare → 200 |
| T14.6 | ✅ | diff API 返回 200 |
| T14.7 | ✅ | `/file/content?path=/workspace` 返回 200 |
| T14.8 | ✅ | `/find` 返回 400（sandbox 模式下已修复，不再返回空结果） |
| T14.9 | ✅ | `/vcs/status` 返回 200 |
| T14.10 | ✅ | agent/skill/command 列表全部 200 |

### Workspace Routing 路径解析

| 用例 | 状态 | 备注 |
|---|---|---|
| WR-1 | ✅ | 沙箱存活 + 不带 directory，返回 diff 数据（session.directory fallback 生效） |
| WR-2 | ✅ | 沙箱存活 + directory=/workspace，返回 diff 数据 |
| WR-3 | ✅ | 沙箱存活 + directory=/workspace/project，返回 diff 数据 |
| WR-4 | ✅ | 沙箱已销毁 + 不带 directory，返回空数组（沙箱不存在） |
| WR-5 | ✅ | 本地路径（无 sessionID），返回空数组（本地无 git repo） |

### Session MCP（会话级动态 MCP）

| 用例 | 状态 | 备注 |
|---|---|---|
| T22.1 | ✅ | 创建会话级 local MCP（command + environment） |
| T22.2 | ✅ | 创建会话级 remote MCP（url + headers） |
| T22.3 | ✅ | 列出会话 MCP，local + remote 同列表 |
| T22.4 | ✅ | Upsert 更新同名 MCP（local→remote，count=1） |
| T22.5 | ✅ | 删除单个 MCP → 204 |
| T22.6 | ✅ | 清空所有 MCP → 204 |
| T22.7 | ✅ | 不同 session 同名 MCP 互相隔离 |
| T22.8 | ✅ | 删除 session 后 MCP 级联清理 |
| T22.9 | ✅ | 不存在的 session → 404 |
| T22.10 | ✅ | 输入校验：缺 name/缺 type/非法 type → 400 |
| T22.11 | ✅ | 完整字段持久化（url/env/headers/enabled） |
| T22.12 | ✅ | disabled MCP 的 enabled=false 持久化 |
| T22.13 | ✅ | Remote MCP 工具执行验证：ev_echo 调用成功，输出 Echo: hello |
| T22.14 | ✅ | Local MCP 在 Sandbox 中执行验证：sandbox-everything_echo 工具成功调用，输出 Echo: hello-sandbox-mcp |
| T22.15 | ✅ | Session MCP 工具多轮对话持续可用：3 轮 3 次 MCP 调用全部成功 |
| T22.16 | ✅ | 严格输入校验：local command 必填、remote url 必填 → 400 |
| T22.17 | ⚠️ NOTE | local MCP environment 注入验证（MCP 启动时序，pid/log 已确认存在） |
| T22.18 | ✅ | shell 安全：恶意 name/env/command 不产生注入 |
| T22.19 | ✅ | local MCP pid/log 生命周期：pid-test-9100.pid + .log 存在 |
| T22.20 | ✅ | 不存在 session：list=200([]), create=500(FK), delete=200 |

### Session PVC 模式（session/app）

| 用例 | 状态 | 备注 |
|---|---|---|
| T27.1 | ✅ | 默认 session 模式，dir=/workspace |
| T27.2 | ✅ | 显式 pvcMode=session |
| T27.3 | ✅ | app 模式（pvcMode=app + appId），dir 不暴露 worktree |
| T27.4 | ✅ | app 缺少 appId → 400 |
| T27.5 | ✅ | appId 空白 → 400 |
| T27.6 | ✅ | 非法 pvcMode → 400 |
| T27.7 | ✅ | 路径穿越（../、;等）→ 400 |
| T27.10 | ⚠️ NOTE | 同 appId 共享 PVC：本地 Docker 环境 PVC bind mount 不支持跨 sandbox 共享，K8s 环境下应支持 |
| T27.11 | ✅ | 不同 appId PVC 隔离 |
| T27.12 | ✅ | session 模式与 app 模式隔离 |
| T27.13 | ⚠️ NOTE | worktree 自动创建未触发（exec 路由可能走 HttpApi 端点而非 sandbox-proxy.ts 的 worktree 逻辑），K8s 环境需进一步验证 |

### Session LSP（沙箱内 LSP daemon）

| 用例 | 状态 | 备注 |
|---|---|---|
| T27.LSP.1 | ✅ | write 工具触发 LSP diagnostics（检测出类型错误） |
| T27.LSP.2 | ✅ | edit 工具触发 LSP diagnostics（修复后剩余错误） |
| T27.LSP.3 | ✅ | daemon 自动启动（runInSession + nohup + probe schema 验证） |

### Session User Fields（用户标识持久化）

| 用例 | 状态 | 备注 |
|---|---|---|
| T25.1 | ✅ | prompt_async 携带 userName/userId → 204 |
| T25.2 | ✅ | 消息列表包含 userName=alice, userId=user-123 |
| T25.3 | ✅ | 不传时 userName/userId 为 null（向后兼容） |
| T25.4 | ✅ | 同步接口 message 也支持 userName/userId |
| T25.5 | ✅ | 多轮对话每条 user 消息独立携带标识（alice→bob） |
| T25.6 | ✅ | 三人协作讨论（alice/bob/carol 各自标识正确） |
| T25.7 | ✅ | 按用户筛选消息：alice=2 条, bob=1 条 |
| T25.8 | ✅ | 交叉发言 alice→bob→alice 时序和标识正确 |

### Compose Agent（编排工作流）

| 用例 | 状态 | 备注 |
|---|---|---|
| T26.C.1 | ✅ | 创建 compose agent + 3 编排技能，CRUD + PG 持久化 |
| T26.C.2 | ⚠️ NOTE | AI 加载了 3 个编排技能（skill×3 completed），但未执行实际代码编写——AI 能力限制，非系统 bug |
| T26.C.4 | ✅ | compose agent/skill session 隔离：B 无 compose agent/skill |
| T26.C.5 | ✅ | 重启后 compose agent/skill 从 PG 恢复 |

### 沙箱镜像环境

| 用例 | 状态 | 备注 |
|---|---|---|
| T23.1 | ✅ | 共享 cache 目录可写（/home/sandbox/.cache/npm/flag.txt = WRITABLE） |
| T23.2 | ✅ | npm cache 路径 = /opt/package-cache-base/npm |
| T23.3 | ✅ | npm install ms@2.1.2 成功 |
| T23.5 | ✅ | node_modules 跨 session 隔离（B 读不到 A 的 node_modules） |
| T23.6 | ✅ | pnpm store=/opt/pnpm-store，dayjs install 成功 |
| T23.7 | ⚠️ NOTE | yarn 未预装（sandbox 镜像仅含 npm/pnpm/bun） |
| T23.9 | ✅ | volumeType=none 代码路径验证（buildVolumes 返回空数组） |
| T23.11 | ⚠️ NOTE | kill-sandbox 后 cache 不保留（本地 Docker overlay 限制，K8s+PVC 应持久） |
| T23.12 | ✅ | 缓存命中加速：冷 0.64s → 热 0.40s |
| T23.13 | ✅ | 3 并发 npm install 全部成功 |
| T24.1 | ✅ | mise 2026.6.11，node 18/20/22/24 + pnpm 8/9/10/11 预装 |
| T24.2 | ✅ | 默认 node v24.16.0, pnpm 10.34.3, registry=npmmirror |
| T24.3 | ✅ | mise use node@20：v24→v20 |
| T24.4 | ✅ | mise use pnpm@9：10→9.15.9 |
| T24.5 | ✅ | .nvmrc 自动检测：v20.20.2 |
| T24.6 | ⚠️ NOTE | .node-version 不生效（mise.toml 优先级更高） |
| T24.7 | ✅ | mise.toml 自动检测：node@18 |
| T24.8 | ✅ | 切换版本后 pnpm install 成功（node@20+pnpm@9） |
| T24.9 | ✅ | 不同 session 版本独立：A=v20, B=v24 |
| T24.10 | ✅ | supergateway 3.4.3 + rg 14.1.0 可用 |
| T24.11 | ✅ | pnpm store-dir=/opt/pnpm-store, virtual-store=/tmp/pnpm-vs |
| T24.12 | ✅ | pnpm install 首次 1.8s（store 预装加速） |
| T24.13 | ✅ | pnpm 重装 0.6s（全 reused） |
| T24.14 | ✅ | express fallback 1.5s |
| T24.21 | ✅ | 3 session 并发 pnpm install 成功 |
| T24.22 | ✅ | 跨 session 版本独立：A=node@20, B=node@24 |
| T24.23 | ⚠️ NOTE | /opt/pnpm-store root 可写（overlay 层运行时行为，镜像构建时不可变） |
| T28.1 | ✅ | 沙箱对象缓存命中：首次 0.94s → 后续 ~0.13s（7x 加速） |
| T28.2 | ✅ | 并发请求绕过 lock：5 个并发 554ms |
| T28.3 | ✅ | 缓存 TTL 过期：首次 0.91s → 缓存 0.17s → 过期后 0.18s → 重新缓存 0.20s |
| T28.5 | ✅ | Watchdog 标记超时工具：25s 内 stuck part 标记 error |
| T28.6 | ✅ | 沙箱销毁后缓存失效：kill 后重建 0.85s → 重新缓存 0.12s |

### Agent 权限（会话级动态配置）

| 用例 | 状态 | 备注 |
|---|---|---|
| T26.P.1 | ✅ | permission deny：edit/write 被 deny 后工具列表移除，AI 只能用 bash |
| T26.29/30 | ✅ | specer 配置 **/ 前缀 vs 无前缀：permission 持久化正确（各 3 rules） |
| T26.36 | ✅ | subagent 独立权限配置已持久化（sub-worker: 2 rules） |
| T26.39 | ✅ | write deny 生效（工具从列表移除） |

### 工具沙箱执行验证（代码审查 + 运行时）

| 用例 | 状态 | 备注 |
|---|---|---|
| T19.1 | ✅ | 8 个工具文件全部无本地 I/O 和条件分支 |
| T19.2-T19.9 | ✅ | write/read/bash/edit/glob/grep/ls/patch 运行时全部在沙箱内执行 |
| T19.10 | ✅ | PG sandbox 表 state=running |
| T19.11 | ✅ | 环境隔离：sandbox hostname 独立于宿主机 |

### 代码修复验证（feat/session-lsp 分支）

| 修复 | 状态 | 备注 |
|---|---|---|
| Auth PG | ✅ | 恢复 pgLayer，PUT auth 写 PG，重启后 connected 持久化 |
| LSP daemon | ✅ | runDetached→runInSession（避免 deleteSession kill daemon）+ probe schema 验证 |
| userName/userId | ✅ | SessionV1.User schema 加字段 + prompt 传递值 |

---
