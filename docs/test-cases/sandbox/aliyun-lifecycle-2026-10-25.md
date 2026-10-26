# 阿里云生命周期全用例复测（2026-10-25）

对应清单：[`sandbox-lifecycle.md`](sandbox-lifecycle.md)。本轮仅验收当前阿里云 provider，不把历史 OpenSandbox/Vercel 结果当成本轮结果，不包含该文档明确排除的 PVC/snapshot 路径。

## 后续修复复测：回收正确性

以下原始 FAIL 记录保留。首轮优化已修复 idle 候选时间戳/generation 校验、keepalive 阻止 idle 回收、过期 killed 不收敛三项；详见 [`aliyun-reap-fix-2026-10-25.md`](aliyun-reap-fix-2026-10-25.md)。

- 专用 PG 单测：63 项相关测试 + 2 项关闭 idle 策略的补充测试，全部通过。
- 真 PG / fake cloud CAS 探针：修复前新活动候选仍被销毁，修复后保持 running、无 kill。
- 独立 Docker + 真实阿里云 API：5 项检查通过；包括 idle 自动快照恢复真实文件标记，恢复后 generation 更新。
- keepalive 只控制续期，不代表新活动，不阻止 idle 回收；过期 killed 的收敛不依赖 idle 功能开关。
- 快照失败或活动命令仍阻止销毁，未放宽原有安全保护；不自动 resume。

下面章节是修复前基线，不代表修复后的当前状态。本次为定向复测，没有重新执行整份生命周期清单。

## 环境

- 当前工作区构建镜像 `opencode-saas:aliyun-lifecycle-20261025`，镜像 ID 记录于证据 summary。
- 真实阿里云杭州 API + 二代模板 `base-5wa5`；不设置 session 持久化模式，使用当前默认临时模式。
- 三个独立 Docker SaaS：15121 自动保活/idle=60 秒，15122 自动保活/idle=0，15123 关闭 root 自动保活/idle=0。三者共享专用 PG `opencode-v2-aliyun-lifecycle-test`。
- 使用 60 秒阈值和人工过期 PG 时间戳加速验收；阿里云实际扫描间隔 15 秒，不是文档中 OpenSandbox 的 300 秒。
- 生命周期测试不依赖 ripgrep，关闭可选首次安装；Code Mode executor 配置为 sandbox，但本轮仅 shell API，没有模型轮次，不能据此声称验证 execute。
- 原脚本经既有 SSE 包装器执行；SSE 在创建后、脚本继续前订阅，跨实例及重启会重连。只用公共 API 驱动业务，PG 用于断言和仅限自有行的过期模拟。

## 原文全部适用用例结果

| 项目 | 结果 | 依据 |
| --- | --- | --- |
| root 自动保活并 boot | PASS | PG running/true |
| 跨 SaaS 实例重连 | PASS | 第二实例 shell 成功，沿用同一 PG 代次 |
| keep-alive GET | PASS | API 返回持久偏好 true |
| release | PASS | API false、PG destroyed/false |
| 显式 boot、重复 boot 幂等 | PASS | 新代次与 PG 一致，重复请求返回同一 ID |
| kill-sandbox 保留偏好 | PASS | PG destroyed/true、API sandboxId=null |
| kill 后重建 | PASS | 新 ID、running/true |
| fork 不自动创建 | PASS | 无 sandbox 行，首次 shell 后创建 |
| fork/父 session 删除 | PASS | 各自实例 destroyed，父偏好保留 |
| boot:false 懒创建 | PASS | pending-<id>/destroyed/true，不创建云实例 |
| 首次 shell 继承偏好 | PASS | pending 被实际代次替换、running/true |
| SaaS 重启重连 | PASS | 原代次不变，shell 完成 |
| 过期 running、keep_alive=false | PASS | 45 秒观察窗内 destroyed/false |
| 过期 running、keep_alive=true | FAIL | 原脚本重启后等待 90 秒仍 running；补测再次复现 |
| 过期 killed 行继续回收 | FAIL | 45 秒后仍 killed，非 destroyed |
| 新活动行不回收 | PASS | 45 秒内仍 running/false；该项本身不证明窄窗口 CAS |
| 候选读取后刷新活动时间的 CAS 防误杀 | FAIL | 可控 fake 云端 + 真 PG 连续两次复现刷新后仍被销毁 |
| 文档列出单测 + 相关 PG 回归 | PASS | 7 文件、114 pass、0 fail |
| core typecheck | PASS | 退出码 0 |
| 清理 | PASS | 8 个测试 session 已删除，8 个绑定均 destroyed，云端自有实例/快照均无残留 |

单测文件：sandbox-provider、sandbox-config、sandbox-path、sandbox-aliyun-provider、sandbox-create-lease、sandbox-create-compensation、sandbox-generation。

## 三项差异与处理建议

### 1. 高优先级：活动时间刷新后仍误杀

`packages/core/src/sandbox/aliyun/provider.ts` 的 sweep 先读一批候选，随后仅按 session ID 调 destroy。capture 会重新读当前行，并用这次读取的最新 time_updated 做 CAS；它没有把扫描选中时的时间戳作为预期值传下去。因此中间发生的新活动不能使销毁 CAS 失败。

探针 `packages/core/script/aliyun-lifecycle-cas.ts`：先让扫描在 fake 信息查询屏障处停下，确认另一个候选仍为 running/时间戳 0，再通过真实 provider.fileWrite 刷新 PG，最后释放屏障。两次均观察到刷新后的行变为 destroyed、fake kill 被调用。该测试不调用云端、不创建收费资源，使用独立 `-cas-test` PG。

建议修复时把扫描选中的 generation/time_updated 传入回收 CAS，CAS 未命中就跳过，而不是读取最新行后无条件回收。

### 2. 中优先级：keep_alive=true 排除 idle reap

sweep 的回收条件明确包含 `!record.keep_alive`，与文档“keep_alive 只是偏好，不阻止 idle reap”不同。此项既有原脚本 90 秒失败，也有补测 45 秒再次失败。

需先确认是否保留文档中的统一契约；若确认，移除该豁免，并确保偏好不被清除。不能只改用例把当前行为算成通过。

### 3. 中优先级：killed 行不处理

sweep 只处理 snapshotting/running，文档要求的过期 killed 重试路径未覆盖。补测把已运行的自有测试行置为 killed/时间戳 0，等待后仍停在 killed。清理阶段通过公共 DELETE 正常销毁，未留下云实例。

建议将其纳入幂等回收，并用扫描候选的 CAS 条件防止并发活动误杀。

本轮只运行、补充复现脚本和报告，未修改产品生命周期逻辑。

## 证据与复跑

根目录：`artifacts/aliyun-lifecycle-20261025/`。

- `keepalive/`：原主脚本、跨实例 SSE、HTTP/PG 断言。
- `lazy/`：原懒创建脚本及 SSE。
- `idlereap/`：原重启/idle 脚本，exitCode=1；不要将最终 cleanup 的 destroyed 状态当作用例通过。
- `idle-extra/`：四项边界和公共 SSE。
- `cas/`、`cas-retest/`：两次可控竞态结果。
- `summary.json`、`cleanup-verification.json`：汇总及云端只读核验。

原三个脚本未修改；使用 `sandbox-vercel-t19.mjs` 包装，设置 EXPECT_PROVIDER=aliyun。跨实例用 BASE_SECONDARY；idle 重启用 RESTART_CONTAINER。包装器的容器名前缀仍要求 opencode-vercel-t19-，仅是复用测试工具，不代表服务使用 Vercel。

新增补测脚本：`docs/test-cases/scripts/aliyun-lifecycle-idle-extra.mjs`，BASE 指向关闭 root 自动保活的 15123 实例。CAS 探针从 packages/core 用 Bun 运行，OPENCODE_DATABASE_URL 必须指向独立 `-cas-test` 库。
