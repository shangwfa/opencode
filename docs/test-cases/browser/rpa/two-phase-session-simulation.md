# RPA 两阶段交互模拟：用户任务 → 探索 → 引导修正 → 生成应用 → 回放

> 环境：本地 PG + 远端 K8s Sandbox，镜像 `opencode-saas-sandbox-test:rpa-e2e`，API `http://127.0.0.1:14096`，模型 `Yd-DeepSeek/deepseek-v4-flash`。

## 流程框架

```
创建会话（permission: deny webfetch/websearch）→ 注入全部 3 个 skills
  ├─ agent-browser（官方工具手册，沙箱内 skills get core --full 取回）
  ├─ browser-explorer（探索流程引导 + 固化产物契约）
  └─ app-builder（精简 + 执行验证 + 六件套入参；description 声明"仅响应用户明确要求"）
阶段一：prompt_async 用户原话 → AI 探索+固化 → 系统验收（工具审计+产物审计）→ 不符打回（循环）
阶段二：prompt_async「生成应用」→ app-builder 触发 → 精简 runner.min.mjs + 两遍验证 + pending-app.json → 验收打回（循环）
阶段三：系统侧提取 → POST /rpa/app → POST run 回放 → 核对 → 失败回喂修正
```

## T54.1 机制层禁用 webfetch（会话 permission）

### 场景

AI 连续多轮用 webfetch 抓静态页面/直连站点后端 API 走捷径，导致：提取逻辑不可迁移（回放环境只有 agent-browser）、排序语义错（API 推荐排序 ≠ 页面最新排序）。skill 文本禁令无效。

### 命令

```bash
curl -s -X POST $BASE/session -H 'content-type: application/json' -d '{
  "permission": [
    {"permission": "webfetch", "pattern": "*", "action": "deny"},
    {"permission": "websearch", "pattern": "*", "action": "deny"}
  ]}'
```

### 原理

`session/llm/request.ts` 的 `resolveTools` 每次请求用 `Permission.disabled(工具名, merge(agent.permission, session.permission))` 从 LLM 工具列表**直接移除** deny 工具（pattern="*"）——工具不进列表，AI 想用也没有。**零代码**，不需要恢复 webfetch 的 ctx.ask（避免偏离上游）。

### 复测记录

| 日期 | 结果 |
|---|---|
| 2026-09-15 | 通过：禁用后会话工具分布 `bash:28, skill:1, webfetch:0`；此前同任务 webfetch 高达 17-18 次。 |

## T54.2 模型契约遵循度实证（flash 模型）

多轮实测结论（对沉淀链路设计的约束）：

| 问题 | 实证 | 对策 |
|---|---|---|
| skill 尾部契约被跳过 | browser-explorer 写明「自测是回复数据结果前的必要条件」，AI 连续 4 轮只交付数据表格不固化 | 系统侧验收打回（产物存在性硬检查），不能依赖 skill 自觉 |
| JSON 结构自造字段 | pending-app.json 两轮分别产出 `setup/steps/teardown` 分段、`runner/verify/paramsSchema/env` 自造键 | 打回时**逐字段列出**目标键名；或系统侧做结构归一转换 |
| prompt 指令 > skill 契约 | 任务 prompt 内联详细契约时固化成功率高（近因效应） | 关键契约可同时出现在任务 prompt 与 skill |
| 打回循环收敛 | 固化补做 1 轮通过、字段归一 1 轮通过 | 每轮打回带明确逐条清单，避免模糊引导 |

## T54.3 全流程复测（2026-09-15，会话 `ses_f5ae9a8c4ffeZCKtgdWFnM1DuZ`）

| 步骤 | 结果 |
|---|---|
| 创建会话（deny webfetch/websearch）+ 注入 3 skills | ✓ skills: agent-browser / app-builder / browser-explorer |
| 阶段一用户原话「获取影刀社区最新10篇文章(标题,简介,作者,链接)」 | AI 交付 10 篇（bash:28 零 webfetch），未固化 → 打回 |
| 打回后补做固化 | ✓ runner.js(4202B ESM/argv2/RPA_CHECKPOINT 派生/eval stdin/零$/DOM 发现/checkpoint skip 恢复) + verify.js + checkpoints/ + exploration.md |
| 阶段二「生成应用」 | 精简 runner.min.mjs(3482B) + 自称两遍验证通过；pending-app.json 自造键 → 打回 |
| 打回后字段归一 | ✓ 六件套恰好：name/description/script/params_schema/manifest/exploration |
| 系统侧 POST /rpa/app | ✓ `rpa_94ca1fe70ea0473d80bf`（影刀社区文章采集）v1 active，source=exploration |
| 回放 `rparun_219b20ff92034dd1a2bb` | ✓ succeeded / exit 0 / repair 0 / tokens 0；10 篇四字段完整、ID 降序（首篇「抖音直播开播检测」/末篇「标签下载」），与探索一致 |

### 遗留观察

- AI 估的 `timeout_seconds: 30` 偏小（本轮回放恰好快未超时）；慢站场景回放超时会触发自修复闭环，属可接受行为。
- verify.js 为 stdin 校验器（数量/字段/data 存在），未校验 desc 与 ID 降序——由系统侧回放核对兜底。
- params 名为 `url`（非 communityUrl）——schema 自由度，app-builder 按实际参数推导 params_schema，一致即可。
