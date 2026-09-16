---
name: app-builder
description: On explicit user request to "生成应用/沉淀为应用". Refines exploration artifacts (runner.js) into a minimal verified script and assembles the six-field app creation payload (pending-app.json). Executes verification before producing the payload.
---

# App Builder — 精简、验证、生成应用入参

## 职责

仅响应用户明确的"生成应用"指令。输入是探索阶段（browser-explorer）的中间产物，做三件事：

1. **精简**：从 runner.js 提炼最小可重放逻辑。
2. **验证**：执行精简版，确认仍满足原始需求。
3. **入参**：组装六件套 `pending-app.json`（创建应用的标准入参）。

## 输入

- `/workspace/.rpa/runner.js`（已通过两遍自测的探索期脚本）
- `/workspace/.rpa/exploration.md`（探索记录）
- 会话上文的任务需求与自测结果

## 第一步：精简

从 runner.js 中提炼应用脚本，去除探索期痕迹：

- 删除调试日志、试验性分支、verify 专用逻辑。
- 保留：参数读取、三段式主流程、数据提取与验证的核心逻辑、checkpoint/data 契约。
- 精简版仍必须满足 browser-explorer 定义的 runner.js 全部硬契约（ESM、argv[2]、RPA_CHECKPOINT 路径派生、eval --stdin 禁 $、DOM 发现、输出步骤永远执行、结果为 stdout 最后一行单行 JSON）。

## 第二步：执行验证

精简版写入独立文件，用全新 verify checkpoint 执行**两遍**：

- fresh：exitCode=0，结果完整（数量/字段/排序与探索结果一致）。
- resume：skip 恢复零重放，输出一致。

不满足则修正精简版重验，循环直到通过。**禁止跳过执行直接产出入参。**

## 第三步：生成入参

`/workspace/.rpa/pending-app.json`，顶层仅有六件套。**严格按此模板，不要增删顶层字段**：

```json
{
  "name": "简短应用名",
  "description": "一句话任务目标",
  "script": "#!/usr/bin/env node\nimport ...（精简并两遍验证通过的完整 ESM 脚本文本）",
  "params_schema": {
    "type": "object",
    "properties": { "url": { "type": "string", "description": "目标页面 URL" } },
    "required": ["url"]
  },
  "manifest": { "timeout_seconds": 180 },
  "exploration": "探索记录（exploration.md 内容，字符串或对象均可）"
}
```

字段来源：

| 字段 | 来源 |
|---|---|
| `name` | 稳定、简短的应用名 |
| `description` | 任务目标一句话 |
| `script` | **精简并通过两遍验证的最终脚本文本**（单一完整 Node.js ESM） |
| `params_schema` | 从脚本实际读取的参数推导 JSON Schema；**每个 property 必须提供 `default`**（用探索时验证过的真实值，如目标 URL），并列出 `required`。缺失 default 会导致回放按空参运行而失败 |
| `manifest` | `{ "timeout_seconds": N }`，浏览器类任务 N 不低于 120，取验证实测耗时 2-3 倍 |
| `exploration` | exploration.md 内容 |

写完后自检：`node -e 'const j=require("/workspace/.rpa/pending-app.json");console.log(Object.keys(j))'` 应恰好输出 `[ 'name', 'description', 'script', 'params_schema', 'manifest', 'exploration' ]`。

完成后回复：精简说明（删了什么、保留什么）、两遍验证结果、六件套字段清单与 script 字节数、pending-app.json 路径。
