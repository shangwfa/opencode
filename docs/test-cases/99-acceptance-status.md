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
| T8.1 | ✅ | provider 列表与 connected 状态 |
| T8.2 | ✅ | 同 session 切换模型 |
| T9.1 | ✅ | SSE 事件流可收到 session/message 事件 |
| T10.1 | | 完整开发流程 + PVC 持久化 |
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
| T12.3 | ✅ | background:true 触发 keepAlive（T19.7 验证 keepAlive API 生效） |
| T12.4 | ✅ | 无 keepAlive 时 idle 后 sandbox 被销毁（释放 keepAlive 后 sandbox 回收） |
| T12.5 | ✅ | keepAlive 阻止 idle 销毁（T19.8: 5s 后 server 仍运行 HTTP 200） |
| T12.6 | | instance/dispose 强制销毁所有 sandbox |
| T12.7 | | dispose 后再次发消息自动重建 sandbox |
| T12.8 | | 容器重启后 PVC 数据恢复 |
| T12.9 | | 多 session PVC 子目录隔离 |
| T12.10 | | 不同 session 进程隔离 |
| T12.12 | | proxy 访问不触发 keepAlive |
| T17.1 | ✅ | 无沙箱时 endpoint API 返回 502 |
| T17.2 | | endpoint API 端口参数校验 |
| T17.3 | ✅ | Vite 项目 endpoint API 返回直连 IP |
| T17.4 | ✅ | 通过直连 IP 访问 Vite 页面 HTTP 200 |
| T17.5 | ✅ | Proxy 模式有注入，直连模式无注入 |
| T17.6 | | 沙箱销毁后 endpoint API 返回 502 |
| T18.1 | ✅ | 7 种工具调用场景全部验证通过 |
| T18.2 | ✅ | 消息流结构正确（prompt → tool → summary） |
| T19.1 | ✅ | exec API：简单命令执行（exitCode=0, stdout=hello-from-exec） |
| T19.2 | ✅ | exec API：多行输出（stdout 含 line1/line2）。⚠️ NOTE：stderr 被合并到 stdout，stderr 字段为空 |
| T19.3 | ✅ | exec API：指定工作目录（pwd=/tmp） |
| T19.4 | ✅ | exec API：命令执行失败（exitCode=42） |
| T19.5 | ✅ | exec API：缺少 command 参数（HTTP 400） |
| T19.6 | ✅ | exec API：不存在的 session（HTTP 404，非 502） |
| T19.7 | ✅ | exec API + keepAlive：设置 keepAlive + 后台启动 http.server，HTTP 200 |
| T19.8 | ✅ | keepAlive 阻止 idle 销毁（5s 后 server 仍运行 HTTP 200） |
| T19.9 | ✅ | 释放 keepAlive 后 sandbox 回收（keepAlive=false 生效） |
| T19.10 | ✅ | exec API 超时控制（sleep 30 在 8s 内被 curl --max-time 截断） |
| T19.11 | ✅ | exec API：环境信息（HOME=/home/coder, USER=root, PWD=/workspace） |
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

### P1 SaaS 稳定性

| 用例 | 状态 | 备注 |
|---|---|---|
| T7.1 | ⚠️ NOTE | 未配置 provider 返回 200（非 4xx），错误体现在 AI 回复内容中；不卡死 |
| T7.2 | ✅ | 不存在 session 返回 404 |
| T7.3 | ✅ | 无效 JSON 返回 400 |
| T7.4 | ⚠️ NOTE | 缺失必填字段（空 parts）返回 200（非 400），服务端宽松处理 |
| T7.5 | ✅ | 超长消息不 hang |
| T12.11 | | OPENCODE_SANDBOX_IDLE_KILL_SEC 当前不参与实际回收逻辑 |
| T13.1 | | `/session/:sessionID/kill-sandbox` 单 session 销毁 |
| T13.2 | | kill-sandbox 后 PVC 保留并自动重建 sandbox |
| T13.3 | | 同一 session 并发首条消息只创建一个 sandbox |
| T13.4 | | dispose/kill 与正在执行的 prompt 并发时行为明确 |
| T13.5 | | Vite HMR/WebSocket proxy 连通 |
| T13.6 | | proxy 302 Location 路径重写 |
| T13.7 | | proxy 二进制资源代理 |
| T13.8 | | `__error_report` POST 后可在 `__errors` 和 `/proxy-errors` 聚合中查询 |
| T13.9 | | 服务重启后 session/message/part 仍可查询 |
| T13.10 | | prompt_async 最终落库，abort 后 finish 状态正确落库 |
| T13.11 | | PG FK 完整性：无 orphan message/part，session 删除级联 |
| T13.12 | | 订阅额度月度 reset、rate-limited、Retry-After、usagePercent cap |
| T13.13 | | rate limit 命中后不继续执行工具或创建 sandbox |
| T13.14 | | sandbox 安全：禁止访问宿主路径和 session 外 workspace |
| T13.15 | | sandbox 安全：禁止通过相对路径、软链、绝对路径逃逸 `/workspace` |
| T13.16 | | sandbox 安全：敏感环境变量不应出现在 AI 回复、tool 输出、proxy 页面 |
| T13.17 | | 幂等性：重复 `/instance/dispose` 返回稳定结果且无残留 sandbox |
| T13.18 | | 幂等性：重复 `/session/:sessionID/kill-sandbox` 返回稳定结果或明确 404/已销毁语义 |
| T13.19 | | 幂等性：重复删除同一 session、重复删除 provider 凭据行为明确 |
| T13.20 | | 观测性：sandbox created/destroyed/keepAlive 日志或事件包含 sessionID、sandboxID |
| T13.21 | | 观测性：provider error、sandbox error、proxy error 可定位到 sessionID |
| T13.22 | | 观测性：usage/计费相关记录可关联 sessionID、model、token/成本 |
| T13.23 | | 恢复语义：服务重启时 running session 最终变为 idle/abort/error 中的明确状态 |
| T13.24 | | 恢复语义：服务重启后旧 sandbox 不应成为无法管理的孤儿资源 |

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
| T14.1 | | session 列表过滤：directory、roots、start、search、limit |
| T14.2 | | `/session/status` active/idle/busy 状态 |
| T14.3 | | session fork + children 父子关系 |
| T14.4 | | session message 分页：limit、before、Link、X-Next-Cursor |
| T14.5 | | session share/unshare |
| T14.6 | | session diff/revert/unrevert |
| T14.7 | | `/file`、`/file/content`、`/file/status` 直接 API |
| T14.8 | | `/find`、`/find/file`、`/find/symbol` |
| T14.9 | | `/vcs`、`/vcs/diff` |
| T14.10 | | `/agent`、`/skill`、`/command` 列表 |

---

