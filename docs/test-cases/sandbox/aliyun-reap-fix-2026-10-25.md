# 阿里云回收正确性：首轮优化与验收

日期：2026-10-25。范围经确认：idle 候选 CAS 防误杀、过期 killed 收敛、keepalive 仅续期不阻止 idle 回收。不处理 MCP T22.31、多 Pod 端口竞争、长期快照保留或目录大规模重构。

## 修改

`packages/core/src/sandbox/aliyun/provider.ts`：

1. 后台扫描将原始候选的 `id/state/time_updated` 传入 capture。
2. capture 先拒绝已变化的候选，再以读取到的 generation/state/time_updated 做 SQL CAS；CAS 未命中时后台回收静默跳过，不关闭门禁、不创建快照、不 kill。
3. idle 判定不再排除 keep_alive=true。实际执行、文件访问和 scoped activity 仍更新活动水位；仅续期不是用户活动。
4. 过期 killed 与 snapshotting 纳入后台恢复候选，使用既有创建租约长度作为过期阈值；关闭 idle reap 不会关闭这类未决回收的恢复。
5. 保留现有快照确认后 kill、活动命令阻断、未决快照 intent 核对和不自动 resume 的保护。

正常手动 destroy/release 的入口保持原行为，不要求调用方提供扫描候选。

## 先复现，再修复

| 检查 | 修复前 | 修复后 |
| --- | --- | --- |
| stale running、不保活 | 通过 | 通过 |
| stale running、保活 | 仍 running，失败 | destroyed，保活偏好不变 |
| stale killed | 仍 killed，失败 | destroyed |
| 选中候选后通过文件 API 刷新水位 | 刷新后仍 destroyed，失败 | 保持 running，无 kill |

前三项来自新增单测的修复前执行（1 pass / 2 fail）。CAS 探针使用真实 PG、可控 fake cloud，不产生收费云实例；同一脚本修复后重跑。

证据：`artifacts/aliyun-reap-fix-20261025/aliyun-reap-before.log`、`cas-before/result.json`、`cas-after/result.json`。

## 单测和静态检查

- 专用 PG：`opencode-v2-aliyun-reap-unit-test`，未使用共享开发库。
- 五个相关测试文件合计 **63 pass / 0 fail**：sandbox-aliyun-provider、sandbox-aliyun-client、sandbox-create-lease、sandbox-generation、session-tool-gate。
- 之后补充两项：idle 关闭时 stale killed 仍收敛、未过期 killed 不抢占，**2 pass / 0 fail**。
- 本轮新增九项后台扫描测试：不保活 idle、保活 idle、killed、fresh、idle 关闭、killed 在 idle 关闭时的两种租约状态、快照失败、活动命令。均用真实定时器覆盖 15 秒扫描。
- `bun run typecheck` 通过；三个修改的代码/执行器文件 oxlint 为 0 warning / 0 error。

63 项与后补 2 项是两次执行，不描述为同一轮 65 项输出；修复前失败日志不计入通过数。

## 真实 Docker/API/PG/SSE 定向 E2E

环境：

- Docker：`opencode-vercel-t19-reap-aliyun`，端口 15129。
- 镜像：`opencode-saas:aliyun-reap-fixed-20261025`，基于此前已验收镜像，仅覆盖本轮 provider 文件；镜像内文件与工作树 SHA-256 相同。
- PG：`opencode-v2-aliyun-reap-lifecycle-test`。
- 阿里云二代模板：`base-5wa5`。
- 自动 boot/keepalive 关闭；idle=600 秒；TTL=1800 秒。仅对自有测试行将 time_updated 置 0，加速形成过期候选。
- `OPENCODE_CODEMODE_EXECUTOR=sandbox`；本组为 shell API 测试，没有模型轮次，不能声称重新验证了 execute。
- 执行器在 shell 前订阅公共 `GET /api/session/:id/event`，原始 SSE 写入结果；真实操作与 PG 后检联合断言。

执行器：`docs/test-cases/scripts/aliyun-lifecycle-idle-extra.mjs`。**5/5 检查通过**：

| 场景 | 结果 |
| --- | --- |
| 不保活 idle，会话显式 snapshot 模式 | 自动保存后 destroyed，remote_name=null，偏好不变 |
| 保活 idle，临时模式 | destroyed，keep_alive 保持 1 |
| 过期 killed，临时模式 | destroyed，remote_name=null |
| 新活动行 | 仍 running |
| idle 快照恢复 | 真实文件标记一致，新 generation，restoredCount=1 |

idle 回收前的文件与恢复后的文件通过公共 shell API 读写，没有用模型自述替代结果。CAS 窄窗口使用独立真 PG 探针，不能把正常 fresh 用例当成 CAS 证明。

复跑命令：

```bash
BASE=http://127.0.0.1:15129 OPENCODE_PASSWORD=... \
PG_URL=postgresql://local@127.0.0.1:5432/<dedicated>-lifecycle-test \
STRESS_OUT=artifacts/aliyun-reap-fix-20261025/api \
node docs/test-cases/scripts/aliyun-lifecycle-idle-extra.mjs
```

## 清理与边界

- 专用 PG：session_v2=0、sandbox_command=0、aliyun_snapshot=0；四个 sandbox 绑定均 aliyun/destroyed/remote_name=null。
- 四个初始云实例及一个恢复实例，原生 `Sandbox.getInfo` 逐个确认 `SandboxNotFoundError`；见 `cloud-cleanup.json`。
- 测试 Docker 已停止，日志保存为 `docker.log`。保留测试数据库、镜像、停止容器和原始失败证据，未操作其他会话或服务。
- 所有证据目录：`artifacts/aliyun-reap-fix-20261025/`。

本轮不是整份生命周期文档重跑，也未验证新一轮模型/Code Mode、多 Pod 或快照长期保留。云源已经丢失或快照结果仍不确定时，仍沿用阻断和保留台账策略，不能为追求 killed 清零而声称数据已保存。
