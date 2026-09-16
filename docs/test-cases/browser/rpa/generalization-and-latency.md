# 泛化验证与慢因分析（国内站点）

> 环境：本地 PG + 远端 K8s Sandbox，镜像 `opencode-saas-sandbox-test:rpa-e2e`，模型 `Yd-DeepSeek/deepseek-v4-flash`。

## T56.1 慢因分析（证据）

| 观测 | 数据 | 结论 |
|---|---|---|
| 单条命令排队等待 | `command queue wait waitedMs=65049` | **沙箱命令串行**，长命令会阻塞后续所有命令（最主要的等待来源） |
| 每条 agent-browser 命令耗时 | `open`+`wait --load networkidle` 各 3–25s | 20+ 条命令串行 → 分钟级总耗时 |
| 上下文压缩 | CCR `tookMs≈10`，`savedPct 96.9%` | **不是瓶颈** |
| 外网可达性 | `news.ycombinator.com` → fetch failed (296ms)；`yingdao.com` → 200 (236ms) | 沙箱网络仅放行部分站点，**境外站点不可达** |
| 境外目标表现 | `agent-browser open` 60s 超时 → AI 反复杀浏览器/重建 session 重试 | 无效 churn 的主要来源 |

国内站点可达性实测（均 200）：`36kr` / `oschina` / `cnblogs` / `sspai` / `news.qq.com` / `zhihu`。

## T56.2 基于证据的优化（最小改动）

针对「目标不可达导致重试 churn」，在 `browser-explorer` 增加 **步骤 0：可达性预检**：

- 先做有界探测（`fetch` 15s 上限 / `timeout 30 agent-browser open`），失败即报告"目标不可达"，**禁止**反复重试、杀浏览器或重建 session。
- 只有预检通过才进入探索。

其余内容**未改动**（避免无依据的调整）。

### 反例：不要瞎改

自动检查曾报 `runner.js` 含 6 个 `$`（似违反"eval 代码内禁 `$`"契约），取证发现全部是 AI **自己加的运行时防护**：

```js
if (code.indexOf('$') !== -1) process.stderr.write('FATAL: eval code must not contain $ character')
```

属契约内化的正面信号，**不应修改**。此例说明：优化必须先取证（读原文/跑验证），不能只凭指标表象改契约。

## T56.3 泛化复测：博客园（非影刀站点）

任务：`获取博客园推荐页 https://www.cnblogs.com/pick/ 最新5篇文章(标题,作者,链接,发布时间)`。

| 阶段 | 结果 |
|---|---|
| 阶段一（用户原话，含可达性预检） | 约 7 分钟自主完成探索+固化+两遍自测（`bash:29`、`write:4`），零打回；产物 `runner.js`(5970B)、`exploration.md`、`checkpoints/.data.json`(5 条) |
| runner 契约验收 | ESM ✓ / 无 require ✓ / argv2 ✓ / RPA_CHECKPOINT ✓ / eval --stdin ✓ / 数据 5 条字段完整 ✓ |
| 阶段二（"生成应用"） | 六件套恰好；script 3030B（ESM/无 require/argv2/stdin eval）、`timeout_seconds=120`、params `{url,count}` |
| 阶段三（系统侧） | 应用 `rpa_9907050d496345428a76`（博客园精华区文章提取）v1 active |
| 回放 `rparun_e888df34a962425d9e6d` | **succeeded / exit 0 / repair 0 / tokens 0**；5 篇含 title/link/author/time，示例：`Agent Memory 到底应该是什么？` — 杜文龙 |

结论：agent + 3 skills 契约**跨站点泛化有效**（无影刀专用 hack）；主要耗时来自沙箱命令串行与站点加载，非契约问题。
