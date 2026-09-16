# Agent + 3 Skills 方案：两阶段全链路（含持续优化记录）

> 环境：本地 PG + 远端 K8s Sandbox，镜像 `opencode-saas-sandbox-test:rpa-e2e`，模型 `Yd-DeepSeek/deepseek-v4-flash`。

## 方案结构

```
创建会话（会话级 permission: deny webfetch/websearch）
  ├─ 注入 3 skills：agent-browser（官方手册 / browser-explorer（探索流程+参考骨架）/ app-builder（精简+验证+六件套模板）
  └─ 注册 session-agent：rpa-workflow（frontmatter+prompt 正文，permission {"*":"allow"}）
阶段一 prompt_async(agent, skills:["browser-explorer"], 用户原话) → 探索+固化+两遍自测 → 系统验收
阶段二 prompt_async(agent, skills:["app-builder"], "生成应用") → 精简+重验+六件套 → 系统验收
阶段三 系统侧 POST /rpa/app → POST run 回放 → 核对
```

## T55.1 权限声明要点（两个必须避开的坑）

| 坑 | 现象 | 正确做法 |
|---|---|---|
| agent permission 缺少 `"*": "allow"` | bash/read/skill 全部落到默认 `ask` → HITL pending（API 场景无人应答）→ 会话挂起、沙箱闲置被回收，表现为「长时间 busy 无进展」 | agent permission 必须显式 `{"*": "allow"}` |
| 在 agent permission 里声明 `webfetch: deny` | 服务端转换后规则顺序为 `[webfetch deny, …, "*" allow]`，`evaluate`/`disabled` 用 **findLast** 语义 → `"*" allow` 覆盖 deny，禁用失效 | **deny 规则声明在会话级 permission**（merge 顺序在 agent 之后，deny 生效）；agent 只放 `"*": "allow"` |

验证证据：`session_agents.permission` 地面数据 `[{webfetch deny},{websearch deny},{* allow}]`；会话级 deny 后工具分布 `webfetch:0`。

## T55.2 持续优化记录（执行观察 → 资产迭代）

| 观察 | 优化动作 | 效果 |
|---|---|---|
| 无参考实现时 AI 反复试错：`bash:83 / edit:4 / 100+ 消息 / 25 分钟未完成` | browser-explorer 增加 **runner.js 参考骨架** + **selftest.sh 两遍自测夹具** | 同任务 `bash:32 / edit:1 / ~10 分钟完成` |
| 抽取把页面导航/评论链接全收进来（`Expected 10, got 2939`）反复失败 | browser-explorer 增加**抽取铁律**：容器范围限定、抽取后立即断言数量并打印样本、先验证数量再落盘 | 一次通过 |
| pending-app.json 结构自造键（两轮：`setup/steps` 分段、`runner/verify/paramsSchema/env`） | app-builder 增加**六件套 JSON 模板** + 自带键名自检命令；agent prompt 明确字段清单 | 本轮恰好六字段 |
| verify.js 只校验部分字段 | 契约要求 verify 校验**全部输出字段与排序** | 已写入契约 |
| `timeout_seconds` 估值过小（30） | 契约明确浏览器类任务不低于 120、取实测 2-3 倍 | 本轮 180 |
| 模型偶发提前停止（输出文本后未继续调用工具） | 流程侧「继续」引导一次即恢复 | 1 次 nudge |

## T55.3 全链路复测（2026-09-15，会话 `ses_f59739becffeCFfMP0AiEu06vk`）

| 阶段 | 结果 |
|---|---|
| 初始化 | 会话级 deny webfetch/websearch + 3 skills + rpa-workflow agent（frontmatter 解析注册） |
| 阶段一（用户原话） | **零打回**：探索→固化→两遍自测全部完成；产物 `runner.js`(4052B 全契约：ESM/argv2/路径派生/eval stdin/零$/无硬编码/纯 JSON)、`verify.js`、`exploration.md`、`checkpoints/` |
| 阶段二（"生成应用"） | 精简 runner.min（2793B，全契约复核通过）→ 六件套 `pending-app.json`（键恰好 6、timeout 180）；模型提前停止一次 → nudge 后完成 |
| 阶段三（系统侧） | `POST /rpa/app` → `rpa_e90641eb91ab4a7f8a59`（影刀社区最新文章提取）v1 active |
| 回放 `rparun_c0d94cd3910846509469` | **succeeded / exit 0 / repair 0 / tokens 0**；10 篇四字段完整、ID 降序（首「抖音直播开播检测」/末「标签下载」） |

## 遗留观察

- stdout 仍可能出现 `[agent-browser] launched browser` 前缀（daemon 启动消息），消费方按 `[{` 边界截取（见 `exploration-to-app.md` T53.4）。
- 阶段二模型提前停止属模型行为，产品侧可加「产物缺失自动续跑」兜底（系统验收已能检出）。
