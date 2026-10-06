# CodeMode Runner 冷启动就绪验证

## 已证实的缺口

`packages/core/src/codemode/runner.ts:32-59` 启动守护进程后，当前只等 endpoint 返回 resolved。该状态表示地址存在，不保证后台Runner已经可执行。新增本地特征测试证实 start 可以在目标尚未就绪时返回，立即 execute 会断连，目标就绪后相同纯计算可以成功。此测试是现状刻画，不是假称已修复。

`packages/core/test/codemode-runner.test.ts`：8 pass / 0 fail / 22 expect。

## 真实平台确定性探针

脚本 `docs/test-cases/scripts/codemode-runner-readiness-v2.mjs` 通过真实SDK连接专用SaaS会话沙箱，使用持久command session；调用当前源码 CodeModeRunner.start/execute。provider适配器仅桥接SDK命令/端点，不等于完整SaaS provider服务。此前模型E2E另有完整服务链路中的首次断连证据。

无模型、无工具回调、执行代码固定 `return 7`，失败后只对这个幂等纯计算做重复探测，不重放任何用户任务。自然冷启动5次；控制组把daemon启动延迟2秒、3次。每次先停止本用例Runner，SDK session在最终关闭，沙箱由SaaS DELETE清理。

### PVC

证据：`store/evidence/session-skills-pvc-1791112355801-3ac35c1f/result.json`。

| 场景 | 次数 | 首次连接失败 | start返回 | 首次纯计算成功 |
| --- | --- | --- | --- | --- |
| 自然冷启动 | 5 | 5 | 37.6～53.5 ms | 587.9～606.2 ms |
| daemon延迟2秒 | 3 | 3 | 37.5～44.3 ms | 2610.7～2698.4 ms |

同一端点在目标冷态收到gateway WebSocket close 1011，目标就绪后正常close 1000。人为延迟导致首次成功窗口同步后移，直接支持“daemon启动期间start过早返回”的因果链，而不依赖模型行为。

计时是host侧从start调用开始到实际execute成功，包括传输、Runner加载和纯计算。没有独立测量远端TCP监听精确时刻，不将首次执行成功时间冒充端口监听时间，也未取得gateway错误日志解释每次1011内部原因。

### Snapshot

重测证据：`store/evidence/session-skills-snapshot-1791112775777-ed151483/result.json`，15点正确性检查与8次确定性探针完成。

| 场景 | 次数 | 首次连接失败 | start返回 | 首次纯计算成功 |
| --- | --- | --- | --- | --- |
| 自然冷启动 | 5 | 5 | 37.4～58.4 ms | 602.0～734.4 ms |
| daemon延迟2秒 | 3 | 3 | 39.3～52.2 ms | 2606.7～2675.4 ms |

双模式自然冷启动共10/10次、延迟控制共6/6次首次连接失败。重测成功不等于已定位前一次SaaS就绪超时根因。探针通过是指预期缺口被复现且最终纯计算成功，不是业务就绪问题已修复。

首次Snapshot尝试 `session-skills-snapshot-1791112428448-54b360b3` 在 `/api/info` 请求阶段超时（TimeoutError），零会话、零平台请求、零Runner样本。该失败不归因于Runner，也未确认SaaS就绪超时根因。已将就绪请求单次超时从通用300秒改为5秒，避免60秒总等待窗口被单次长请求突破，独立重测。

## 测试设施修正

初次SDK探针CreateSession response shape错误，发生在模型以外的宿主探针连接；测试代理此前始终返回host.docker.internal端点。现在根据请求来源为宿主SDK返回127.0.0.1，为Docker SaaS保留host.docker.internal。修正后PVC整段探针通过。没有修改SDK依赖包。

失败尝试证据 `session-skills-pvc-1791112259608-25392982` 保留；通过独立DELETE探针清理该测试会话，不用新成功库代替旧库数据检查。

PVC成功探针与旧失败用例的清理均已独立核对PG：session/inbox/session_skills为0，sandbox仅destroyed行。清理证据 `session-skills-pvc-1791112481551-ad4976b8/pg-postcheck.json`；core类型检查及diff检查通过。

## 已实施修复（最小方案）

`packages/core/src/codemode/runner.ts`：launcher 在原有 flock 启动之后新增本地就绪探测——`node -e` 脚本先确认 PID 存活（退出即失败 `Code Mode Runner exited before readiness`），再以 250ms 连接超时、25ms 间隔探测 127.0.0.1:9911，总预算 7.5 秒（超时失败 `Code Mode Runner readiness timed out`），留在现有 10 秒命令预算内并持锁等待，热启动路径不变。不发送用户代码、不自动重放 execute frame。

### 回归与静态检查

新增 `packages/core/test/codemode-runner.test.ts` 三个 live 用例：延迟 150ms 监听的守护进程会被等到就绪且二次启动复用同一 PID；600ms 不监听时在预算内以 `readiness timed out` 失败；立即退出的守护进程报 exited before readiness。修复前 3 项失败（8 pass / 3 fail），修复后 11 pass / 0 fail / 33 expect。相关回归 16 文件 156 pass / 0 fail / 437 expect；core 类型检查、涉及文件 oxlint、diff 检查通过。

macOS 无 flock，本地 fixture 用 shim 只执行被锁命令；真实锁行为由 Linux 沙箱探针覆盖。

### 修复后真实复测

`PROBE_EXPECT_RUNNER_READY=true` 探针要求 start 返回后首次执行必须成功，不得依赖重试：

- PVC `session-skills-pvc-1791113978089-78a4b28c`：自然冷启动 5/5、延迟 2 秒 3/3 首次成功；start 等待 502～612ms（延迟组 2515～2611ms）。
- Snapshot `session-skills-snapshot-1791114049520-1f87c075`：自然冷启动 5/5、延迟 3/3 首次成功；start 等待 579～854ms（延迟组 2621～2838ms）。
- 修复前同口径为 16/16 首次失败；两库各含 15 点正确性检查与 pg-postcheck（session/inbox/skills 为 0，仅 destroyed 源行）。

### 修复后真实模型复测（每档单样本）

要求 execute 成功、无任何工具失败、产物与 PG 正确：

| 场景 | PVC 端到端 | Snapshot 端到端 | 模型轮次 PVC/Snapshot |
| --- | --- | --- | --- |
| 纯指令 | 7.94 s | 7.09 s | 4/3 |
| 5 资源1脚本 | 20.40 s | 13.31 s | 7/5 |
| 50 资源10脚本 | 33.87 s | 17.13 s | 8/5 |

PVC 证据 `session-skills-pvc-1791114053169-6c70fd5e`，Snapshot 证据 `session-skills-snapshot-1791114157941-4d689932`，均三档零工具失败。skill 加载 294~1540ms 随资源数上升；模型轮次差异主导端到端差异，单样本不能作模式排名。

## 遗留

- 复测没有覆盖 interrupt/取消与并发启动竞态的专项真实场景，本地单测也未包含真实 flock。
- 修复后 start 首次等待增加约 0.5~0.9 秒（此前把失败转嫁给首次执行并引发模型重试）。
- 模型复测仍为每档单样本；后续需无错误执行重复采样后才能报告稳定分布。
