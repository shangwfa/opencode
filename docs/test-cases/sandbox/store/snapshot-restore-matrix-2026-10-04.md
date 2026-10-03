# OpenSandbox 快照恢复耗时矩阵

## 状态

2026-10-04三轮完整API测试已通过：21次恢复、18次显式快照、93条命令exit=0、24次模式/挂载/registry前置校验通过。只新增测试脚本及报告，未修改生产功能；工作区原有修改和删除保持不动。

首次运行在前置校验失败，0个恢复样本：脚本要求registry末尾斜杠，但全局有效源为`https://registry.npmmirror.com`。通过专用会话shell核验工作区和/tmp均为淘宝源，修正为接受带/不带尾斜杠两种等价URL后完整重跑。失败证据`evidence/snapshot-restore-matrix-preflight-failed-2026-10-04.json`，失败会话`ses_efd4e9ecbffeFRO1dOooAa4yS7`经DELETE API清理且PG剩余0。该轮不计有效样本。

重跑前Node语法检查、远端挂载JS独立编译、registry等价URL检查及PG排序列核验通过。无生产功能改动，不以这些检查代替E2E结果。

第二轮运行首轮六个场景的恢复与hash校验通过，但在重复恢复前被测试脚本误拦截：恢复后的快照按实现标记stale，仍可恢复；脚本只查询ready。PG记录六个快照均stale、reason=restored，七个snapshot_destroy均done且attempts=1，无证据表明平台快照丢失。修正为与生产restorable查询一致的session scope、ready/stale与time_created排序。

该失败轮证据`evidence/snapshot-restore-matrix-state-check-failed-2026-10-04.json`，专用会话`ses_efd4bcb56ffeR6oelaHPkrVeBm`经API清理，PG剩余0。六个已完成样本只作为排查记录，不混入最终三轮数据。

新增`snapshot-restore-matrix-preflight.test.mjs`，直接取真实脚本的registry片段和SQL测试；PG用CTE模拟状态，不写业务表。容器测试6 pass、0 fail，覆盖stale复用、最新状态排序、不可恢复状态/其他会话/scope隔离、空结果、URL等价与拒绝伪造域名、远端JS语法。第三次完整运行通过，以下结果只取本次有效样本。

## 有效三轮结果

执行窗口：2026-10-04 01:06:09–01:19:39（UTC+8），总计809.728秒。总时长包含安装、构建、拍照、销毁、诊断和恢复，不能作为累计恢复时间。

| 场景 | 三轮boot秒数 | boot中位数 | 恢复到首条命令完成中位数 | 恢复后构建中位数 |
|---|---|---:|---:|---:|
| 最小工作区 | 5.45 / 6.38 / 6.38 | 6.38 | 6.59 | — |
| 仅Next源码 | 5.73 / 5.44 / 6.36 | 5.73 | 5.92 | — |
| 安装依赖 | 12.42 / 6.54 / 13.70 | 12.42 | 12.72 | 9.65 |
| 含构建产物 | 6.58 / 6.52 / 4.31 | 6.52 | 6.76 | 2.90 |
| 多代快照小改 | 5.41 / 5.35 / 4.34 | 5.35 | 5.56 | 2.89 |
| 额外64MiB不可压缩文件 | 5.34 / 5.36 / 5.39 | 5.36 | 5.61 | — |
| 重复恢复64MiB快照 | 6.37 / 11.35 / 7.49 | 7.49 | 7.67 | — |

表中单位均为秒，每组3个样本。所有boot范围4.31–13.70秒，独立文件核验0.18–2.63秒。初次无快照boot基线5.34 / 4.47 / 5.41秒，未计入恢复样本。

21次均切换新沙箱代际，平台snapshotId匹配预期可恢复快照，kill未产生取代显式快照的新版本。三次重复恢复都确实使用同一份已消费的stale快照，文件验证通过。指定的9次恢复后构建均成功。

有效会话`ses_efd450a35ffeFPHWkCkqrh0p1T`、`ses_efd4131a5ffe6RMXLCa3VPMAyr`、`ses_efd3c7f87ffeSdUA0mI4jxTO6T`全部经API删除，最终PG剩余0；24条snapshot_destroy操作done、attempts=1（21次销毁及3次删除时产生的操作）。不能据此宣称平台内部无重试。

### 分析边界

- 大部分恢复boot约4–7秒；安装依赖组有12–14秒样本，重复恢复有11.35秒样本，因此数据量与恢复耗时不呈简单线性关系。
- 加64MiB后这三次boot约5.3秒，不证明增大镜像永远没有成本，也不证明按需加载；缺远端节点、拉镜像、解压与初始化分阶段数据。
- 重复恢复并没有稳定更快，不将其解释为缓存命中性能。
- 有构建产物后的build比首次build快，但已有.next缓存、顺序状态与平台缓存均可能影响，不能全归因恢复机制。
- 本轮没有测试损坏/过期快照、平台断网、SaaS重启或真正节点冷缓存，不能据此宣布“各种故障都通过”。

脚本：`docs/test-cases/scripts/snapshot-restore-matrix-e2e.mjs`，复用同目录`snapshot-layer-confirmation-e2e.mjs`的API/SSE/PG与只读平台诊断。

## 环境与范围

- SaaS：Docker中的`opencode-saas-test`，API容器内4096。
- 模式：snapshot；资源2CPU/4Gi；wait=900；命令预算600秒。
- 安装：pnpm、淘宝镜像，pnpm store在工作区内。
- 每个初始/恢复沙箱核对PG persistMode，以及/workspace、/resources、home及相关配置目录是否同根overlay挂载；拒绝PVC混挂。
- API `/api/info`返回200，但Docker health为unhealthy；只记录，不重启或修改健康检查。
- 本轮shell/API/PG测试，非AI或code-mode验收。远端节点调度和镜像缓存不可控，不能声称严格冷/暖缓存对照。

## 场景

每轮新建专用会话，顺序推进以下状态；后续基底继承前次恢复，因此这是同一项目开发路径，不是六个相互独立的镜像负载。

1. 最小工作区：测试标记、可执行权限、跨目录symlink；不是绝对空rootfs。
2. 仅Next.js源码：未安装依赖。
3. 安装依赖：依赖与pnpm store；恢复后首次构建。
4. 含构建产物：保存上一恢复后生成的.next，恢复后再构建。
5. 多代快照小改：已有依赖/构建产物与多次恢复的新基底，再改源码、恢复构建。
6. 额外64MiB不可压缩文件：保留全部前置项目状态。
7. 重复恢复64MiB状态：无有意文件修改；记录是否实际复用相同可恢复快照（ready/stale），不能预设CLEAN。

计划三轮、21次恢复。首次boot无恢复点作为基线另列，不混入恢复样本。

## 计时定义

- **destroyMs**：kill API调用至返回；可能包括创建/复用快照，独立列出，不计恢复时间。
- **bootMs**：显式keep-alive enabled=true,boot=true API调用至返回；含应用锁、平台创建、连接和初始化等，不称纯镜像加载。
- **firstExecMs**：已boot沙箱的首个极短shell命令至SSE结束；含SSE连接、接口往返和最多约100ms完成采样。
- **requestToFirstExecMs**：boot开始至首个shell结束。
- **verifyMs**：工作区所有清单文件及home/resources标记的SHA-256、symlink目标、执行权限核验；不混入boot。
- **buildMs**：依赖/构建/多代状态恢复后的pnpm build；独立列出。
- 快照创建、准备和安装均独立计时，不作为恢复耗时。

使用performance.now测时；平台inspect及PG检查位于首次exec计时之后。boot接口可能将错误转换为空sandboxId，因此必须核对非空ID和PG running，不仅判断HTTP 200。

## 正确性与失败处理

- kill确认destroyed，PG存在session scope最新可恢复快照（ready/stale）；恢复代际必须变化。
- 平台实际snapshotId必须匹配kill后PG最新可恢复快照；同时记录显式快照ID与最终选择是否相同，避免忽略destroy生成新检查点。
- hash检查覆盖清单内容，但不构成并发跨文件原子性证明；权限/链接仅覆盖专门标记，不宣称所有POSIX元数据全面验收。
- 每次恢复核对snapshot模式和挂载；有依赖的指定阶段必须真实构建成功。
- 销毁队列操作需done且attempts=1；这些指标不能推广为显式快照或平台内部重试次数。
- 任意失败非零退出，保留本轮专用会话/沙箱/快照；修复脚本后重跑，失败轮不得计入有效样本。
- 全轮成功后仅通过API删除本脚本会话，PG确认不存在，不清理历史专用资源。

## 未覆盖

本轮不主动修改Registry凭据、制造平台节点/存储故障、删除唯一恢复点、重启共享SaaS，或注入损坏快照。不测试历史版本指定回退，也不声称快照缺失时保源、跨节点恢复及服务重启恢复已验收；这些需另立受控场景。

三轮只报告原始样本、范围和中位数，不以小样本声明可靠P95。

## 证据

有效重跑输出容器`/tmp/snapshot-restore-matrix-2026-10-04-v3.json`，已归档：

- `evidence/snapshot-restore-matrix-2026-10-04-v3.json`：全部样本、命令、hash验证输出、平台来源及PG操作。
- `evidence/snapshot-restore-matrix-2026-10-04-v3.log`：执行过程。
- `evidence/snapshot-restore-matrix-final-pg-2026-10-04.json`：清理后会话0及24条队列操作状态。
- `evidence/snapshot-restore-matrix-environment-2026-10-04.json`：镜像、wait、健康状态、HEAD与三份脚本SHA-256。
