# agent-browser 架构说明

> [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) 是专为 AI agent 设计的浏览器自动化 CLI（Rust 原生实现）。本文档沉淀其核心架构与机制，作为沙箱内浏览器自动化测试的理论参考。
>
> 官方文档：https://agent-browser.dev/

## 相关文档

| 文档 | 内容 |
|---|---|
| [`../mcps/agent-browser-mcp.md`](../mcps/agent-browser-mcp.md) | MCP 模式接入验证（local MCP + `mcp --tools core`） |
| [`../skills/agent-browser-skill.md`](../skills/agent-browser-skill.md) | Skill 模式接入验证（bash 直调 CLI） |
| 本文档 | 架构与机制说明（非测试用例） |

## 沙箱内安装现状

安装定义在 `packages/opencode/docker/Dockerfile`：

| 项 | 值 | 来源 |
|---|---|---|
| agent-browser | npm 全局安装 | `Dockerfile:47`（`npm install -g supergateway agent-browser ...`） |
| Chromium | Playwright 安装 + 软链 `/usr/local/bin/chromium` | `Dockerfile:50-51` |
| 发现方式 | `CHROME_PATH=/usr/local/bin/chromium` | `Dockerfile:52` |

> **2026-09-15 实测**（组合 3，session 沙箱）：agent-browser **0.36.0** + Chrome for Testing **153.0.8010.12**，`open example.com → get title → close` 全链路正常。`mcps/agent-browser-mcp.md` 复测记录停留在 0.31.1 + chromium 151，以本节实测为准。

---

## 核心工作流

所有浏览器自动化任务遵循同一模式：

```
agent-browser open https://example.com      # 1. 导航
agent-browser snapshot -i                   # 2. 快照，拿到元素 ref（@e1、@e2）
agent-browser click @e2                     # 3. 用 ref 交互
agent-browser snapshot -i                   # 4. 页面变化后必须重新快照
agent-browser close                         # 5. 关闭
```

`snapshot -i` 实测输出（example.com，chromium 153）：

```
- heading "Example Domain" [level=1, ref=e1]
- link "Learn more" [ref=e2]
```

---

## 一、可访问性树（accessibility tree）

`snapshot` 不返回 HTML，而是通过 CDP 读取浏览器的**可访问性树**——浏览器为屏幕阅读器（NVDA、VoiceOver 等）维护的语义结构树，回答"这个页面对辅助技术是什么"。

### 生成规则

浏览器解析 HTML + CSS 后把 DOM 节点转换为辅助功能对象（role / name / state），过程中：

- 剔除无语义节点：纯布局的 `<div>`/`<span>` 被穿透或丢弃
- 剔除不可见节点：`display: none` 等不进树
- 剔除纯装饰内容：如 `alt=""` 的图片
- 合成语义：ARIA 属性、`<label>` 关联、heading 层级汇入节点

### 节点属性

| 属性 | 含义 | 例 |
|---|---|---|
| role | 这个元素"是"什么 | `button`、`link`、`textbox`、`heading` |
| name | 可访问名称 | 按钮文字、link 文本、`alt`、label |
| state | 状态 | `checked`、`disabled`、`expanded` |
| 其他 | 补充信息 | heading 的 `level` |

### 与 DOM 的对比

```html
<div class="card" style="padding:2rem">
  <h2 class="text-xl font-bold">文章标题</h2>
  <a href="/more" class="btn-primary px-4 py-2">了解更多</a>
  <img src="icon.png" alt="">
</div>
```

DOM 完整保留所有标签 + class/style（给渲染引擎用）；可访问性树只剩：

```
- heading "文章标题" [level=2]
- link "了解更多" [ref=e1]
```

浏览器已替调用方完成"语义降噪"。真实网页 HTML 动辄几百 KB，快照后通常仅几十~几百行。

---

## 二、Ref 机制

快照时 daemon 给每个元素分配递增编号（e1、e2…），存储在 daemon 内部的 **ref → CDP 节点映射表**中。

| 优点 | 说明 |
|---|---|
| 上下文高效 | 文本输出 ~200-400 tokens（完整 DOM ~3000-5000），省 API 成本、不撑爆上下文窗口 |
| 确定性 | ref 指向快照时刻 daemon 分配的稳定句柄，AI 看到的第 N 个元素就是 `@eN`，无选择器歧义（对比 AI 猜 CSS/XPath：`nth-child` 偏移、动态 class 一变就失效） |
| 速度快 | `click @e2` 直接查映射表拿 CDP 节点执行，不在页面里跑 `querySelector`，无多匹配/零匹配重试 |
| AI 友好 | 缩进树形文本匹配 LLM 训练分布（类 markdown/代码），无 JSON 括号引号噪声，引用元素只需 `@e2` 三个字符 |

### Ref 生命周期（重要）

ref 与快照时刻绑定，以下情况后**旧 ref 全部失效，必须重新 snapshot**：

- 点击触发导航的链接/按钮
- 表单提交
- 动态内容加载（下拉、弹窗、modal）

---

## 三、客户端-Daemon 架构

```
$ agent-browser click @e2          ← 每条 shell 命令 = 一个短命 CLI 进程
        │ (本地 IPC)
        ▼
  Rust Daemon（常驻后台）           ← 持有：CDP WebSocket 连接、tab 列表、
        │ (Chrome DevTools Protocol)    ref→节点映射表、网络跟踪、cookies
        ▼
     Chrome/Chromium
```

### 设计动机

AI 调用是逐条 shell 命令，每条命令都是新进程，进程退出状态即丢失。若每条命令都启停 Chrome，仅浏览器启动就要 1~3 秒，且 tab、登录态、ref 全丢。daemon 把"重状态"放在常驻进程里：CLI 只做参数解析与结果打印（微秒级），浏览器连接与会话状态由 daemon 长期持有。

### 直接调用 CDP

daemon 不经 Playwright/Puppeteer 这类 JS 中间层，直接说 Chrome DevTools Protocol（WebSocket 上的 JSON-RPC，与 DevTools 同一套协议），少一层抽象、无 Node 运行时，延迟与内存更低。CDP 现成接口如 `Accessibility.getFullAXTree` 即快照的数据来源。

---

## 四、Daemon 生命周期

| 阶段 | 行为 |
|---|---|
| 启动 | 首条命令自动拉起 daemon，无需手动 |
| 运行 | 命令间持续运行，浏览器状态跨命令保留 |
| 空闲回收 | 默认 **1 小时**无命令或 dashboard 输入 → 保存已配置的恢复状态，关闭浏览器，daemon 退出 |
| 无恢复键时 | 裸会话（无 `--session-name`/`--profile`/`--restore`）不保存：临时状态、打开的 tab 直接丢弃 |

### 1 小时超时的豁免规则

| 会话类型 | 豁免 | 原因 |
|---|---|---|
| headed 浏览器（`--headed`） | ✅ 豁免 | 有界面，可能是人在看/在用，不能自动杀 |
| Safari / iOS WebDriver 会话 | ✅ 豁免 | 关联真实用户环境 |
| 用户附加的浏览器（`--auto-connect`/`--cdp`） | ✅ 豁免 | 非 daemon 自己启动，无权关 |
| provider 云浏览器（Browserbase 等） | ❌ 不豁免 | 计费的临时资源，正常回收 |

### 超时调节

```bash
agent-browser --idle-timeout 30m open https://example.com
AGENT_BROWSER_IDLE_TIMEOUT_MS=60000 agent-browser open https://example.com
# 0 = 禁用空闲超时
```

---

## 五、在 SaaS 沙箱中的意义

- **跨 exec 共享浏览器**：沙箱 exec 每条命令独立进程，daemon 使浏览器在多次 exec 间存活——实测两次独立 exec 分别完成 `open→snapshot` 与 `click→screenshot→close`，靠的就是 daemon 持有状态。
- **双层回收协同**：daemon 1h 空闲超时先在容器内释放 Chrome（数百 MB 内存）；沙箱自身空闲回收（见 [`../sandbox/`](../sandbox/)）兜底整个容器。
- **状态边界**：会话沙箱被回收重建后，daemon 与浏览器状态随容器/PVC 而定，裸会话浏览器状态不跨沙箱存活；需持久登录态时用 `--session-name` 或 `--profile`（写入 `~/.agent-browser/sessions/`，是否落在 PVC 取决于路径与挂载）。

---

## 复测记录

| 日期 | 内容 | 结果 |
|---|---|---|
| 2026-09-15 | 沙箱实测 agent-browser 0.36.0 + Chrome for Testing 153，open/snapshot/click/screenshot/close 全流程 | ✅ |
