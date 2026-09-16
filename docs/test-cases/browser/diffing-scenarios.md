# Diffing 应用场景用例集

> 沉淀 [Diffing 官方文档](https://agent-browser.dev/diffing) 的最佳应用场景为可执行用例。三种模式：快照结构 diff（可访问性树逐行）、截图像素 diff（变更标红）、URL 对比。
>
> ⚠️ **0.36.0 前提**：`diff snapshot` 自动基线与 `diff url` 失效（bug B7，见 [`agent-browser-commands.md`](./agent-browser-commands.md)），本集统一使用 **基线文件三段式**（更显式、可存档）：
>
> ```bash
> snapshot -i > /tmp/base.txt      # ① 基线
> <操作>                            # ② 动作
> diff snapshot --baseline /tmp/base.txt   # ③ 验证
> ```

## T53.1 AI 操作回执（执行-验证闭环）★最核心

**痛点**：命令成功 ≠ 页面变了。点"提交"返回 ✓，可能被校验拦截、被弹窗挡住、点到遮罩上。AI 从"盲执行"升级为"执行-验证"闭环。

```bash
agent-browser --session s1 snapshot -i > /tmp/base.txt
agent-browser --session s1 fill @e2 "test@example.com"
agent-browser --session s1 click @e5
agent-browser --session s1 diff snapshot --baseline /tmp/base.txt | tail -1
```

**期望**：
- 操作生效 → diff 输出含 `+` 行（如 `+ status "Sending..."`、值变化行）与统计 `N additions`
- 操作无效 → `0 additions, 0 removals` → AI 识别失败并重试

**实测**（2026-09-15）：fill 前后 diff 精确抓到 `textbox [ref=e2]: DiffTest` 值变化 ✅

**进阶**：结合 ref 生命周期规则（页面变化后旧 ref 失效），diff 结果同时验证"AI 用的是新鲜 ref"——ref 重排会体现为 diff 行变化。

## T53.2 视觉回归（发版前后找不同）

**痛点**：改 CSS/升级组件库/发版，怕碰坏看不出的小地方。像素级捕捉人眼忽略的变化。

```bash
# 发版前
agent-browser open https://staging.example.com && agent-browser screenshot /tmp/before.png
# 发版后
agent-browser open https://staging.example.com
agent-browser diff screenshot --baseline /tmp/before.png
# 可选：聚焦区域 + 容差 + diff 图落指定路径
agent-browser diff screenshot --baseline /tmp/before.png --selector "#hero" --threshold 0.2 --output /tmp/diff.png
```

**期望**：输出 mismatch 百分比 + 差异像素数 + diff 图路径（变更像素标红、未变像素压暗）。维度不一致时报 dimension mismatch 而非强行对比。

**实测**（2026-09-15）：输入框文字变化被精准捕捉：`✗ 0.02% pixels differ（149 / 738560 px）` ✅

**判读参考**：`<0.1%` 通常是文本/微渲染差异；`>1%` 大概率布局损坏。`--threshold 0.1`（默认）可对抗 JPEG 压缩噪声，抗抖动告警调 0.2-0.3。

## T53.3 页面变化监控（定时巡检）

**痛点**：盯价格/库存/新订单/内容变更，人肉看或写一堆断言都太重。

```bash
# 一次性基线（PVC 持久）
agent-browser open https://shop.yingdao.com/list/table-list && agent-browser snapshot -i > /workspace/orders.base
# 巡检（cron/定时任务）
agent-browser open https://shop.yingdao.com/list/table-list && agent-browser diff snapshot --baseline /workspace/orders.base
```

**期望**：diff 非零 = 页面有变化（新订单、价格调整、或页面改版导致自动化脚本将要失效——提前预警）。

**实测**：机制与 T53.1 相同已验证 ✅；定时执行属运维层（沙箱内 cron 或外部调度）。

**优势**：可访问性树 diff 天然过滤视觉噪声（时间戳、随机数、轮播位次），`-i` 只看交互元素，`-s "#main"` 聚焦业务区。

## T53.4 环境对比（staging vs 生产 parity）

**痛点**："为什么生产行为和测试环境不一样"——配置漂移、版本偏差排查。

```bash
# 0.36.0 下 diff url 失效（B7），用双快照落文件替代：
agent-browser open https://staging.example.com && agent-browser snapshot -c > /tmp/staging.txt
agent-browser open https://prod.example.com && agent-browser diff snapshot --baseline /tmp/staging.txt
# 视觉对比同理：各自 screenshot 后 diff screenshot --baseline
```

**期望**：差异列表即答案——结构 diff 找功能差异（按钮/表单/文案），截图 diff 找样式差异。

**实测**：`--baseline` 形式验证通过 ✅；`diff url` 原生形式待 0.36.0 修复后复测（`--wait-until` 仅支持 load/domcontentloaded/networkidle，SPA 复杂场景官方也建议拆开手写）。

## T53.5 SaaS 特色：操作审计 diff 存档（设计级，待实现）

**场景**：AI 在沙箱的每次关键操作，把"操作前基线 + diff 结果"随命令记录存 PG——事后审计看到的不是"执行了 click @e5"，而是"页面因此发生了什么变化"。出问题回溯价值巨大。

**形态建议**：exec 包装脚本把 base.txt/diff 输出写 `/workspace/audit/<ts>/`（PVC 留证），元数据进 part/exec_log；多 agent 操作同一后台时，各自 diff 发现"我没做的变化出现了"→ 并发干扰预警。

**状态**：⏳ 设计级，随 attach 模式方案（见 2026-09 方案讨论）一并评估。

## 实施注意

1. **B7 坑**：`diff snapshot` 自动基线 / `diff url` 在 0.36.0 失效，一律用基线文件三段式
2. 基线与 diff 结果建议落 `/workspace`（PVC），既留证又可跨会话复用
3. 像素 diff 对 headless 渲染抖动敏感时调 `--threshold`；结构 diff 用 `-c`/`-d` 控制输出体积
4. 基线文件含快照 ref（e1/e2…），页面结构一变 ref 就重排——对比粒度是"行级文本"，元素位置变化会表现为删+增，判读时关注语义而非 ref 编号

## 复测记录

| 用例 | 日期 | 结果 | 备注 |
|---|---|---|---|
| T53.1 操作回执 | 2026-09-15 | ✅ | fill 值变化被精确捕获 |
| T53.2 视觉回归 | 2026-09-15 | ✅ | 0.02% pixel diff 精准；diff 图输出正常 |
| T53.3 变化监控 | 2026-09-15 | ✅（机制） | 定时调度属运维层 |
| T53.4 环境对比 | 2026-09-15 | ⚠️ | 替代写法可用；diff url 原生形式待修复复测 |
| T53.5 审计存档 | - | ⏳ | 设计级，随 attach 方案评估 |
