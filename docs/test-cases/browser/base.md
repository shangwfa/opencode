# agent-browser Quick Start 用例集

> 沉淀自官方 [Quick Start](https://agent-browser.dev/quick-start)，作为 browser 域的基础命令参考。架构与机制说明见 [`agent-browser-architecture.md`](./agent-browser-architecture.md)，skills 体系用例见 [`agent-browser-skills.md`](./agent-browser-skills.md)，**命令全量覆盖见 [`agent-browser-commands.md`](./agent-browser-commands.md)**，MCP / Skill 接入验证见 [`../mcps/agent-browser-mcp.md`](../mcps/agent-browser-mcp.md) / [`../skills/agent-browser-skill.md`](../skills/agent-browser-skill.md)。
>
> 环境约定：以下命令均在 SaaS 沙箱内通过 `exec` 接口执行（`POST /session/:id/exec`），沙箱预装 agent-browser + chromium（headless）。

## T46.1 核心工作流

所有浏览器自动化遵循同一模式：**导航 → 快照拿 ref → 用 ref 交互 → 页面变化后重新快照**。

```bash
# 1. 导航
agent-browser open example.com

# 2. 快照，获取元素 ref
agent-browser snapshot -i
# Output:
# @e1 [heading] "Example Domain"
# @e2 [link] "More information..."

# 3. 用 ref 交互
agent-browser click @e2

# 4. 页面变化后必须重新快照（旧 ref 失效）
agent-browser snapshot -i
```

## T46.2 常用命令

```bash
agent-browser open example.com
agent-browser snapshot -i                  # 获取带 ref 的可交互元素
agent-browser click @e2                   # 按 ref 点击
agent-browser fill @e3 "test@example.com" # 按 ref 填表
agent-browser get text @e1                # 取元素文本
agent-browser screenshot                  # 截图存临时目录
agent-browser screenshot page.png         # 截图存指定路径
agent-browser close
```

## T46.3 传统选择器（ref 的备选）

CSS 选择器与语义定位器同样支持：

```bash
agent-browser click "#submit"
agent-browser fill "#email" "test@example.com"
agent-browser find role button click --name "Submit"
```

## T46.4 Headed 模式（调试用）

显示浏览器窗口：

```bash
agent-browser open example.com --headed
```

> 沙箱为无显示器的 headless 环境，`--headed` 不适用；沙箱内调试用 `screenshot` / `screenshot --annotate` 替代。

## T46.5 等待策略

```bash
agent-browser wait @e1                   # 等元素出现（⚠️ 沙箱实测有坑，见下）
agent-browser wait --text "Welcome"      # 等指定文本出现
agent-browser wait --url "**/dashboard"  # 等 URL 匹配模式
agent-browser wait --fn "window.appReady === true" # 等 JS 条件为真
agent-browser wait --load domcontentloaded # 等 DOM 生命周期事件
```

> **沙箱实测坑（0.36.0）**：`wait @e1`（ref 形式）即使元素刚由 `snapshot -i` 产出且就在页面上，仍固定超时 25s 失败。等待元素请用 CSS 选择器（`agent-browser wait "h1"` 实测通过）或 `--text` 替代。

**官方建议**：页面变化后，优先选择"代表你所需结果"的条件（元素/文本/URL/JS 条件）；仅当生命周期事件本身是里程碑时才用 `load` / `domcontentloaded`。`networkidle` 仍可用于确定会变安静的页面，但 **SSE、WebSocket、轮询、长轮询会让 `networkidle` 永不满足**——SPA 常驻连接场景勿用。

## T46.6 命令链式

用 `&&` 在单次 shell 调用中串联命令。浏览器状态由后台 daemon 持有，链式安全且高效：

```bash
# open + wait + snapshot 一次完成
agent-browser open example.com && agent-browser wait --load domcontentloaded && agent-browser snapshot -i

# 串联多个交互
agent-browser fill @e1 "user@example.com" && agent-browser fill @e2 "pass" && agent-browser click @e3

# 导航并截图
agent-browser open example.com && agent-browser wait --load load && agent-browser screenshot page.png
```

**链式 vs 分开**：不需要中间输出时用 `&&`；需要先解析输出再决定下一步时分开跑（典型：先 `snapshot -i` 发现 ref，再用 ref 交互）。

## T46.7 JSON 输出（脚本化解析用）

```bash
agent-browser snapshot --json
agent-browser get text @e1 --json
```

> 默认文本输出更紧凑，AI agent 场景优先用文本输出。

---

## 沙箱实测记录

| 用例 | 日期 | 结果 | 备注 |
|---|---|---|---|
| T46.1 核心工作流 | 2026-09-15 | ✅ | session `ses_f5d5eebf`，open → snapshot -i（e1 heading / e2 link "Learn more"）→ click @e2 跳转 iana.org → screenshot page.png（86KB）→ close |
| T46.2 常用命令 | 2026-09-15 | ✅ | open / snapshot -i / click / get text / screenshot / close 全通过 |
| T46.3 传统选择器 | 2026-09-15 | ✅ | `find role link click --name "Learn more"` 等效 click @e2，跳转 https://www.iana.org/help/example-domains |
| T46.4 Headed 模式 | - | ⏭️ | 沙箱无显示器，不适用；用 screenshot 替代 |
| T46.5 等待策略 | 2026-09-15 | ⚠️ | `--text` / `--url` / `--fn` / `--load domcontentloaded` / CSS 选择器 `wait "h1"` 全通过；**`wait @e1`（ref 形式）超时失败**——元素已在页面仍超时 25s，为 0.36.0 实测坑，勿用 ref 等元素 |
| T46.6 命令链式 | 2026-09-15 | ✅ | `open && wait --load domcontentloaded && snapshot -i` 单次 exec 完成 |
| T46.7 JSON 输出 | 2026-09-15 | ✅ | `get text @e1 --json` 返回 `{"success":true,"data":{"text":"Example Domain",...}}`；`snapshot --json` 合法 JSON |

> **exec 接口转义坑（非 agent-browser 问题）**：命令含嵌套引号（如 `--fn "document.readyState === 'complete'"`）时，直接拼 JSON 请求体会破坏 JSON 导致响应为空。用 python `json.dumps` 构造 payload 或 `eval --stdin`/`-b`（base64）规避。
