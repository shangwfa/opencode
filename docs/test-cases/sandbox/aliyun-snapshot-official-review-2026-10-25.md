# 阿里云独立快照：官方文档复核

## 结论

二代 MicroVM + 独立 Snapshot 适合本 SaaS 的短期断点续跑，不需要为阿里云实现 OpenSandbox PVC。现有实现的关键安全路径与官方约束一致，但不能据此宣称支持永久工作区或已覆盖全部生产故障。以下区分已实现、实测和待补项。

## 官方依据与实现对照

| 官方要求 | 当前实现 / 判断 |
| --- | --- |
| 仅二代、邀测账号支持 Snapshot | `base-5wa5` 已真实验证；一代失败不降级为临时存储 |
| 保存文件系统和内存；独立于源实例 | 停止时先创建快照并持久化 PG，再 kill；下次 boot 创建新云实例、新 SaaS 代次 |
| 创建仅接受运行中源；snapshotting 时不可 kill | 先验证源状态；PG CAS + 门禁关闭 + 心跳防并发；云确认成功后回收；不通过 connect 偷偷恢复暂停实例 |
| 请求超时至少 300 秒；超时可能已成功 | 创建请求 300 秒，源实例续期至少 360 秒；唯一名称和请求 intent 先落 PG；租约过期后按来源分页、精确名称核对，不盲目重放 |
| 列表可能有索引延迟 | 列表未查到不能证明失败；保持来源与门禁，不创建替代工作区 |
| 恢复允许用户 metadata、生命周期与网络覆盖 | 写入新的 `opencode_session/opencode_intent`，支持丢失响应后的查找认领。早先“metadata 不能覆盖”的说法已纠正 |
| 恢复禁止环境变量、挂载、镜像与 fc.* metadata | 不传上述参数；模板参数直接使用云端 Snapshot ID |
| 静态 Snapshot SDK 接口不公开支持 apiUrl | 不依赖偷偷透传 apiUrl；使用 SDK 的 E2B_API_URL/domain 寻址；自定义端点不一致时明确拒绝，不修改全局环境 |
| 用户端口默认公开；关闭公网匿名访问需配合 secure | 创建/恢复均 secure=true、allowPublicTraffic=false；流量令牌只经内部请求头传递，不返回浏览器 |
| 恢复实例占用快照时不能删除 | 先 kill，再针对自有快照有限重试删除；清理失败保留会话及 PG 台账 |
| 不用的快照及时删除 | 删除会话时清理所有记录的快照；未删除会话的历史快照暂未主动轮换清理，需补保留策略 |
| Snapshot 默认七天过期 | 已明确文档边界；未实现过期前续存、长期归档或自动刷新。不能当永久存储 |
| 单实例单次活跃最长 86400 秒 | 目前保活不能替代平台运行上限；未实现到期前的安全轮转 |

## 测试与不能混同的结论

- 原生 Snapshot：`artifacts/aliyun-sandbox/independent-snapshot-v2-verified/result.json`，已验证删除源后文本及二进制 SHA-256 一致。
- SaaS 公共 API：`artifacts/aliyun-sandbox/auto-snapshot/result.json`，已验证显式快照、停止自动保存最新文件、另一 Docker 实例恢复不同沙箱 ID、PG 恢复次数及删除清理。
- Code Mode 恢复前后真实模型调用已通过：`artifacts/aliyun-sandbox/auto-snapshot-final/result.json`，两轮均有 execute 成功事件并返回 1024；跨 Docker 恢复、文本/二进制校验、PG 及清理同时通过。云端只读核验本轮自有实例和快照均为零。MCP/Tool Host 的快照恢复链路未单独实测，不能由 Runner 成功推导。
- 扩大 MCP 回归时 `MCP connection over the modern protocol > exposes every connection operation` 超时，单独重跑仍超时；尚未确认原因，不将其宣称为通过或武断归为环境问题。
- 两个 SaaS 首次同时启动时实测一个进程因 PG `pg_type_typname_nsp_index` 冲突退出，顺序启动后可用；尚未修复全局迁移并发，不把该问题归因于阿里云 API。

## 生产化待补项

1. 七天过期与 24 小时实例运行上限：需确定业务保留承诺，并据此增加告警、刷新/轮转，或把长期代码/文件归档到 Git/OSS。用户已明确暂不考虑 PVC。
2. 快照 API 目前同步等待云端完成，尚未对齐通用接口“立即返回、后台完成”的语义，也未发布标准快照生命周期 SSE。应在正式开放前补后台操作状态与事件。
3. 历史快照主动保留策略、Team 无名时的兼容策略尚未实现；当前唯一命名方式要求 Team 有名称，默认测试 Team 已满足。
4. 节点故障/网络分区的多 Pod 故障注入、临近云端生命周期上限和真实过期恢复尚未验收，不能用 mock 成功替代。

## 官方来源（2026-10-25 逐页读取）

- [Snapshot](https://help.aliyun.com/zh/agent-sandbox/snapshot-invited-test)
- [运行时一代与二代差异](https://help.aliyun.com/zh/agent-sandbox/runtime-gen1-vs-gen2)
- [E2B 兼容说明](https://help.aliyun.com/zh/agent-sandbox/e2b-compatibility-explanation)
- [网络](https://help.aliyun.com/zh/agent-sandbox/network/)
- [生命周期](https://help.aliyun.com/zh/agent-sandbox/lifecycle)
- [创建沙箱](https://help.aliyun.com/zh/agent-sandbox/create-a-sandbox)
- [超时](https://help.aliyun.com/zh/agent-sandbox/timeout)
- [使用约束](https://help.aliyun.com/zh/agent-sandbox/usage-constraints-of-fc-agent-sandbox)
