# Session Skills 与 upstream/v2 执行语义审查

## 基线与结论

- 当前：`2380551c2e846772c0a30f7423b8f3ae49a06ee6`，包含session overlay与沙箱执行适配。
- 比较对象：本地`upstream/v2`固定为`a5b3802ca3fcb95331fb56f3532c2b28b293b7ca`，提交时间2026-09-17。未fetch，不将其称为远端当前最新分支。
- 仅审查、确定性探针与相关单测；未修改业务源码，未提交或推送。

**核心模型/工具执行边界沿用upstream；Session Skills是额外的数据来源扩展，不是另一套技能执行引擎。但发现定义发现、资源物化及输入失败语义的缺口，不能认定为完整无差异适配。**

## 沿用upstream的部分

| 环节 | 本地与upstream对照 |
|---|---|
| 工具注册 | 同为`Tool.Service.transform`中的完整工具对象，`codemode:false`（本地tool/plugin/skill.ts:47，上游:42）。skill加载留在native工具列表；加载后模型选择的其他工具仍按各自CodeMode配置执行。 |
| 执行权限 | 同为leaf内`Permission.assert`，action=`skill`、resources/save=[id]、source含messageID/id；非把授权塞进registry。 |
| 核心执行 | `SessionModelRequest.executeTool`继续调用捕获的`tools.execute`。权限Declined/问题Cancelled defect的转换仍在这一核心边界（本地model-request.ts:428，上游:351），没有把模型调用改成裸shell。 |
| 摘要 | `SkillInstructions`继续按Agent权限、description与autoinvoke过滤，沿用原Instructions key与增量渲染。autoinvoke不是自动执行代码的开关。 |
| 显式附件 | upstream本来就有prompt.skills→Skill.prepare→Prompt.payload路径，未在这里调用Permission.assert；本地不是新引入的“附件绕过工具权限”。但“用户行为即授权”是产品解释，不能替代接口权限审查。 |
| Location | overlay节点进入Location图，SessionSkill.get保留Plugin.awaitActivation与instances.provide；未新增进程全局可执行registry。 |

新增的合理适配：PG持久定义、资源属主解析（内部子任务共享根、显式fork独立）、三源覆盖、真实沙箱路径与无资源session技能省略虚拟base directory。upstream无同等session_skills表，不能把这些新增机制说成upstream既有行为。

## 已复现问题

### S1：完成标记早于资源写入（P1）

`session/skills.ts:182–192`先写SKILL.md与resources.json，再并发写资源。`rematerialize:209–212`只检查resources.json存在就跳过，没有检查内容、digest或资源文件齐全。

精确提取实际materialize/rematerialize函数体，以Effect沙箱I/O桩注入scripts/run.sh失败：初次Failure、marker存在、资源不存在；解除故障后rematerialize新增写入次数为0，资源仍缺失。**失败可留下永久的“已完成”假象**。未模拟真实PG/远端文件系统。

建议：全部资源成功后才发布完成marker；复用时至少校验marker版本与资源完整性。先补正式失败用例，不只改写入顺序而忽视已有坏marker。

### S2：资源路径可覆盖内部保留文件（P1）

`validateResources:64–90`拒绝穿越与重复，但接受SKILL.md、resources.json及它们的子路径。materialize写内部文件后又将用户资源写入同一路径。

直接调用实际validator：四种路径均被接受。实际函数体物化resources=[{path:SKILL.md,content:OVERWRITTEN}]后，SKILL.md内容为OVERWRITTEN，不是skill正文。resources.json也可被覆盖；`SKILL.md/nested`等可与内部普通文件产生目录冲突。

建议：禁止内部文件名及其路径前缀，或将资源收敛到独立目录，同时明确相对路径契约。不是路径穿越漏洞，但确实破坏物化包完整性。

### S3：沙箱发现规则与upstream不一致（P1）

- upstream `config/plugin/skill.ts:121`：`{*.md,**/SKILL.md}`，根目录平铺md或递归SKILL.md。
- 本地 `session/scan.ts:221`：递归所有`*.md`；`skills.ts:128`还将file的dirname当作parse的source root。

将`/workspace/.opencode/skills/deploy/references/guide.md`交给实际decodeSandbox后，得到id=guide、正文=REFERENCE ONLY的可用skill，而upstream的发现模式不包含这个文件。附属参考文档会被提升为skill；同名guide可相互覆盖，甚至遮蔽durable/global定义。scan的200文件上限也可能被大量参考文档消耗。

建议：技能发现规则与Agent/Command扫描分开配置；只按上游的技能布局发现，并将正确source root传入SkillFile.parse。不能把所有markdown都当定义。

### S4：正文与资源不是同一版本（P1）

skill工具先`get`得到resolved.skill，随后materialize再从PG读当前行。工具输出使用旧resolved.skill.content，物化路径、SKILL.md和resources使用新row。

在get与materialize之间切换I/O桩的row：显示正文=OLD INSTRUCTIONS，物化正文=NEW INSTRUCTIONS，脚本=NEW RESOURCE。探针复现的是实际函数体，不是整个并发API流程。

建议：同一不可变版本快照同时提供正文与资源，或者materialize返回对应版本的完整定义并由工具一致消费；不能只靠目录内容hash解决混合版本输出。

## 静态确认的额外语义差异

1. **权限断言前的I/O与初始化**：upstream工具先内存get→assert→prepare；本地`skills.get→collect→sandbox.run`在assert之前执行，run可进入getOrCreate创建/重连箱并读取定义。context.select还在技能选择前rematerialize所有持久资源。不是已经证实的越权内容泄漏，但与上游纯解析前置、授权后prepare的副作用边界不同，应增加deny场景验证。
2. **显式附件物化失败被静默吞掉**：prompt.ts:83将typed物化错误变undefined，正文仍进入输入且不提供资源目录；上游prepare文件系统失败走orDie，未按成功处理。session资源确实必需时，模型会接到缺依赖的成功输入。缺陷与中断并不被这里的Effect.catch吞掉。
3. **global资源仍是宿主路径（条件风险）**：tool/plugin/skill.ts:70–71仍用宿主FSUtil.prepare；沙箱启用时read改走SandboxTools，path.ts:26对workspace外绝对路径原样返回。若宿主技能目录未同时映射进沙箱，正文能加载但模型读取/运行宿主附属文件会失败。本轮未核验部署挂载，不声称所有global技能必然失败。
4. **扫描降级不等于无等待**：collect同步等待sandbox.run完成/失败后才合并；best-effort仅控制错误传播。10s是传给provider的命令预算，不是整条解析链严格总超时（还包含boot/reconnect、排队等）。
5. **缓存不证明重建必然新鲜**：scan.ts按session/path、mtime:size缓存，没有sandbox generation；同指纹不同内容会复用旧解析。force refresh可重读，但不能把“指纹自然失效”当任何恢复场景下的内容保证。此为设计风险，未做远端重建复现。

## 对前述流程说明的纠正

- skill执行是加载指令/资源，不会自动执行技能脚本或创建专用技能任务状态机。
- “best-effort不阻塞”不准确：只是错误后降级，仍会等待。
- “权限拒绝都作为typed ToolFailure返回”不完整：Permission.Declined等defect保留到核心executor再转换，上游和本地一致。
- “摘要与执行权限完全一致”过强：Skill.available过滤的是agent.permissions，而执行assert含session上下文；上游本来就是不同职责，不应称完整同一策略快照。
- “物化内容寻址天然保证完整幂等”过强：S1/S2/S4说明目录hash不能替代完成协议、保留路径与版本一致性。

## 验证与边界

相关8文件回归：**38 pass、0 fail、100 expect，2.36秒**。tool-skill主要用global源和mock overlay；session-skills现有3项主要覆盖合并与validator，没有完整物化失败恢复。全绿不能否定本轮缺口。

确定性探针与输出位于本机批准临时目录，文件前缀`session-skills-upstream-*`；[摘要证据](./store/evidence/session-skills-upstream-review-2026-10-04.json)。本轮不宣称通过Docker API/真实模型/default CodeMode验收，也未运行干净upstream完整服务：对比的是固定提交源码与当前相关测试。

建议修复顺序：S1/S2的包完整性→S3发现规则→S4版本一致性，再讨论授权前初始化和global资源映射。先正式失败用例、再最小改动，不改核心executor和依赖包。
