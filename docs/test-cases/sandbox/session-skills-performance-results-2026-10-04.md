# Session skills 首轮真实耗时测试

## 测试口径

Docker SaaS + 本地独立 PG + 远端 OpenSandbox `172.18.32.15:30040`，经本机 TCP 转发和测试 HTTP 代理。SaaS 使用既有镜像，只读挂载当前 core/server/protocol 源码，不表示已经发布新镜像。

显式附件以 `resume:false` 调用 prompt API，计时从发送请求到响应解析完成，包含技能发现、PG、物化/校验与持久入队；不包含模型与任务执行。HTTP、资源实物和 PG 内容均检查。cold-bundle 仅移除测试资源文件，不清除发现缓存；0资源不会物化。会话中同时存在正确性样本和逐档追加的技能，尚未隔离技能总数变量。

每档 cold-bundle 5 次、hot-bundle 30 次；冷态样本小，不报告稳定 P95。当前均为已有运行沙箱，不是首次建箱或恢复时间。

## PVC：附件加载

| 资源数 | 首次/缺资源加载中位数（5次） | 热加载中位数（30次） | 热加载P95 |
| --- | --- | --- | --- |
| 0 | 132 ms | 123 ms | 194 ms |
| 5（约5 KiB） | 551 ms | 347 ms | 508 ms |
| 50（约50 KiB） | 1228 ms | 830 ms | 1046 ms |

该轮正确性检查 15 点通过、105 个计时样本完成、通过 API 删除测试会话，独立库无 session 残留。

证据：`store/evidence/session-skills-pvc-1791110445231-62eeb3b4/result.json`，包含每个样本、统计、源码哈希和平台请求；同目录保存 SaaS 日志。

## 其余测试状态

- Snapshot：已完成105个加载样本与15点正确性检查，API清理会话后独立库session为0。
- 真实模型：双模式均已使用既有测试 provider `Yd-DeepSeek/deepseek-v4-flash` 完成三档探索；产物/PG正确，但首次execute失败，过程判定不通过。详见下方表格。每档单样本不能计算稳定 P95。
- 模型上下文自动恢复、首次建箱、恢复、全量技能数1/20/100、跨副本及真实子任务复杂度矩阵尚未完成。

## 环境与用例纠正

原本地 30040 入口无监听是转发进程缺失，并非远端平台不可达。本地 Kubernetes 不参与上述链路，临时核查启动后已停止。

初次真实 correctness 两模式各过13点后，PG断言因脚本没有 JSON.parse(text resources) 失败；持久内容已查询确认正确，现已修正重跑。失败会话/源需要单独清理，不能拿成功新库的清理证明旧库无残留。

后续已通过独立SaaS连接两个旧失败库，分别执行DELETE API清理；PVC清理证据 `session-skills-pvc-1791111196983-150eca55`，snapshot清理证据见 `session-skills-perf-cleanup-snapshot.log` 指向目录。各库独立 `pg-postcheck.json` 确认session/inbox/session_skills均为0，sandbox仅destroyed行。此结论不等于平台snapshot/PVC的全部物理资源回收。

## 当前可下的结论

PVC 下热加载随资源数增加明显变慢，与实现中每次读取资源核对摘要的机制一致；未通过内部 span 隔离成本，不能断言全部增量都来自摘要校验，也不能据此给出 PVC/snapshot 性能排名。

## Snapshot：附件加载

| 资源数 | 缺资源加载中位数（5次） | 热加载中位数（30次） | 热加载P95 |
| --- | --- | --- | --- |
| 0 | 130 ms | 119 ms | 152 ms |
| 5 | 486 ms | 343 ms | 428 ms |
| 50 | 1121 ms | 800 ms | 1000 ms |

证据：`store/evidence/session-skills-snapshot-1791110879418-aa24f36e/result.json`。本轮与PVC接近，不据单轮、小资源样本断言Snapshot更快；没有覆盖checkpoint创建/恢复成本。

前一Snapshot尝试 `session-skills-snapshot-1791110526016-eefb1f15` 在SaaS `/api/info` 就绪阶段超时，零技能样本，服务日志只有已监听，根因未确定；重测通过不证明此前故障根因已解决。

## 模型测试设施问题

第一轮PVC模型样本出现CodeMode Runner断连并回退原生shell，0/5资源任务虽然产物正确，总耗时约79/88秒，但不得作为正常code-mode性能样本。复查发现测试Bun代理只有HTTP转发，而 `packages/core/src/codemode/runner.ts:108` 通过WebSocket执行；已补测试代理的WebSocket桥接，独立重测。尚未证明所有断连均由这个缺口造成，不能将旧样本归因于业务代码。

再次核验注册规则发现 `tool/plugin/shell.ts:196` 明确 `codemode:false`，原生shell调用本身是正确行为，不应要求通过CodeMode catalog调用shell。用例已纠正为execute执行纯JavaScript计算，随后原生skill加载与原生shell脚本执行；任务过程判定要求execute成功且无工具失败，不把正常原生shell视为回退。

## PVC：纠正用例后的真实模型探索样本

模型固定 `Yd-DeepSeek/deepseek-v4-flash`，每档独立会话、资源目录冷态、人工权限等待为0。资源数50中含10个独立执行脚本，其余为参考文件；未测试子任务。每档1次，不代表稳定性能。

| 资源/脚本数 | 端到端 | skill调用边界到成功 | 模型轮次 | 产物 | 过程 |
| --- | --- | --- | --- | --- | --- |
| 0/0 | 12.34 s | 303 ms | 6 | 正确 | 首次execute断连，不通过 |
| 5/1 | 15.95 s | 472 ms | 6 | 正确 | 首次execute断连，不通过 |
| 50/10 | 44.54 s | 1423 ms | 15 | 正确 | 首次execute断连，不通过 |

证据：`store/evidence/session-skills-pvc-1791111111645-51584c6b/result.json`。skill计时从SSE工具input.started到success，包含输入流与工具加载，不是精准leaf内部span。所有样本产物和PG定义均验证正确，但存在 `Code Mode Runner connection closed before completion`，因此不计入正常无错误执行统计。补WebSocket桥接后首次断连仍复现，不能声称代理修复已解决全部问题。

`codemode/runner.ts:52-54` 目前等待endpoint resolved（地址可解析），并未检查Runner端口实际就绪。首次失败、后续成功与启动就绪窗口相符，但只是有依据的待验证假设，不是已确认根因；本次未改业务实现。

## Snapshot：纠正用例后的真实模型探索样本

| 资源/脚本数 | 端到端 | skill调用边界到成功 | 模型轮次 | 产物 | 过程 |
| --- | --- | --- | --- | --- | --- |
| 0/0 | 6.68 s | 272 ms | 3 | 正确 | 首次execute断连，不通过 |
| 5/1 | 16.59 s | 491 ms | 6 | 正确 | 首次execute断连，不通过 |
| 50/10 | 21.38 s | 1165 ms | 6 | 正确 | 首次execute断连，不通过 |

证据：`store/evidence/session-skills-snapshot-1791111212939-79ae528f/result.json`。每个会话首次WebSocket由远端关闭（code 1011），后续成功连接正常关闭（code 1000）；Runner诊断日志均显示 `codemode-runner:9911`。尚无远端gateway错误明细，不能以关闭码确认具体根因。

模型结果不得用于模式排名：每档仅1次，执行包含首次错误与重试，模型轮次不同，部分模型测试/清理窗口重叠；复杂档只是10个确定性脚本与资源文件，不代表任意复杂技能、子任务、MCP或浏览器工作流。

PVC和Snapshot最终模型用例各自的独立PG postcheck确认session/inbox/session_skills为0，sandbox均为destroyed（每库4行）；模型样本均经DELETE接口清理。加载和模型用例均已结束，本轮没有修改业务代码来掩盖首次Runner失败。

## 后续优先项

1. 用不经过模型的冷启动Runner确定性接口探针，验证endpoint已解析但端口未就绪的窗口；收集gateway连接失败明细，确认是否需要业务层就绪握手。
2. 问题明确并修复验证后，补无错误执行的重复样本、热Runner对照及真实冷建箱/快照恢复耗时。
3. 再扩大技能总数、资源总字节数、子任务和MCP/外部服务的矩阵，避免将当前首轮小样本泛化。
