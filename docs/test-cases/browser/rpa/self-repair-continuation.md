# RPA 自修复与断点续跑

> 环境：本地 PG（`postgresql://local@host.docker.internal:15432/opencode`）+ 远端 K8s Sandbox（`host.docker.internal:30040`），服务镜像 `opencode-saas-sandbox-test:rpa-e2e`，API `http://127.0.0.1:14096`，模型 `Yd-DeepSeek/deepseek-v4-flash`。前置：`source docs/test-cases/test-env.sh`（导出 `$BASE=http://localhost:14096`）。

## T52.1 修复会话复用原运行沙箱

### 场景

创建两步 RPA 应用：step 0 向 `step0.log` 追加一行，step 1 故意用 `button` 正则读取 example.com 的标题，预期首次执行失败并由 AI 改为 `heading` 正则。

### 期望

- 首次失败后 run 状态为 `repairing`，不是终态 `failed`。
- `repair_count=1`，并记录 `repair_session_id`、`repair_tokens` 和 `time_started`。
- 修复会话的 `parentID` 等于 `run_session_id`，工具通过根会话使用原运行沙箱。
- 修复版本先保持 `candidate`；原运行沙箱续跑成功后才转为 `active`。

### 复测记录

| 日期 | run | 结果 |
|---|---|---|
| 2026-09-15 | `rparun_833524be9c04437586cf` | 通过：`repairing -> succeeded`，修复会话 `ses_f5b9eb51affeDCn7Wlnk52pnCv` 的 parent 为运行会话 `ses_f5b9ed27fffe0OfDzOc05Hm0Fc`；v2 在续跑成功后 active；`repair_tokens=28583`。 |
| 2026-09-15 | `rparun_b38ded70c85848b69cba` | 通过：加固权限后再次完成 `repairing -> succeeded`；修复会话 parent 为原运行会话；v5 在原沙箱续跑成功后 active；`repair_tokens=60453`。 |

## T52.2 从失败业务步骤继续

### 期望

- 修复前 checkpoint 为 `{ "step": 0 }`。
- 修复后仍在原 run workspace 执行，step 0 不重复。
- 完成后 `step0.log` 恰好 1 行，checkpoint 为 `{ "step": 1 }`。

### 复测记录

| 日期 | 结果 |
|---|---|
| 2026-09-15 | 通过：`wc -l step0.log` 返回 1，checkpoint 返回 `{"step":1}`。 |
| 2026-09-15 | 通过：加固权限后的第二次 run 仍为 1 行，checkpoint 仍从 step 0 推进到 step 1。 |

## T52.3 修复权限与版本审计

### 期望

- 修复会话禁止 write/edit/patch，bash 仅允许 agent-browser 的 `open/snapshot/get/wait/close`。
- shell 重定向、管道、命令拼接和命令替换均拒绝。
- 修复版本记录 `source=repair`、`repair_from_version`、`validate_run_id` 和 AI 摘要。

### 复测记录

| 日期 | 结果 |
|---|---|
| 2026-09-15 | 通过：v5 记录 `repair_from_version=4`、`validate_run_id=rparun_b38ded70c85848b69cba`；`which agent-browser 2>/dev/null` 因重定向被 deny，纯 `agent-browser open/snapshot/close` 放行，未发生 write/edit/patch。 |

## T52.4 真实站点全流程（索引）

探索 → 沉淀 → 零 token 回放的完整流程用例已独立维护在 [`exploration-to-app.md`](./exploration-to-app.md)（T53.1-T53.4），此处不重复。

### 复测记录

| 日期 | app / run | 结果 |
|---|---|---|
| 2026-09-15 | `rpa_5d5058336a6d4fc29577` / `rparun_f43fbc474c7a4784a83c` | 通过：探索约 8 分钟完成验证；沉淀 `yingdao-community-scraper` v1 active；回放 `succeeded`，`repair_tokens=0`，10 篇字段完整、ID 降序，与探索结果一致。注意：pending-app.json 的 `exploration` 为 JSON 对象时曾返回 400，已修复（复测见 `exploration-to-app.md` T53.3）。 |
