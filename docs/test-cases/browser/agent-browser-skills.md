# agent-browser Skills 用例集

> 验证 agent-browser 内置 Skills 体系（`agent-browser skills` CLI）在 SaaS 沙箱内的可用性，覆盖各技能的工作流核心链路。Skills 体系背景：官方把"怎么用好这个工具"做成随 CLI 分发、按版本匹配的 skill 文件，AI 运行时按需加载（发现层稳定 + CLI 动态服务内容，指令永不过期）。
>
> 官方文档：https://agent-browser.dev/skills ；架构见 [`agent-browser-architecture.md`](./agent-browser-architecture.md)，基础命令用例见 [`base.md`](./base.md)，MCP / Skill 接入见 [`../mcps/agent-browser-mcp.md`](../mcps/agent-browser-mcp.md) / [`../skills/agent-browser-skill.md`](../skills/agent-browser-skill.md)。

## 沙箱内可用 skills（0.36.0 实测 9 个）

| Skill | 用途 | 本文档用例 |
|---|---|---|
| core | 核心用法指南（任何浏览器任务前先读） | T47.2 |
| dogfood | 探索性测试：像真实用户逛应用，产出报告+截图+复现视频 | T47.3 |
| derive-client | 逆向站点 API：录 HAR → 识别端点 → 生成免浏览器 client | T47.4 |
| webmcp-gen | 为页面构建/验证实验性 WebMCP 工具 | T47.5 |
| electron | 自动化 Electron 应用（VS Code/Slack/Figma…）via 内置 CDP | T47.6（环境不满足） |
| slack | 浏览器版 Slack 自动化 | T47.6（环境不满足） |
| vercel-sandbox | 在 Vercel Sandbox microVM 里跑 agent-browser | T47.6（环境不满足） |
| protected-vercel-deployments | 用短时 OIDC token 访问 Vercel 认证保护的部署 | T47.6（环境不满足） |
| agentcore | AWS Bedrock AgentCore 云浏览器 | T47.6（环境不满足） |

> 官网 Skills 页列 8 个，沙箱 CLI 实有 9 个（多 `webmcp-gen`，官网略滞后）。

---

## T47.1 skills 体系 CLI 命令

```bash
exec_in_sandbox "$SID" 'agent-browser skills list'                 # 列出全部
exec_in_sandbox "$SID" 'agent-browser skills list --json | head -c 200'
exec_in_sandbox "$SID" 'agent-browser skills get core | head -3'   # 输出 frontmatter
exec_in_sandbox "$SID" 'agent-browser skills get core --full | wc -l'  # 含 references/templates
exec_in_sandbox "$SID" 'agent-browser skills path core'            # skill 目录路径
```

**期望**：`list` 列出 9 个 skill；`--json` 返回合法 JSON；`get core` 输出 YAML frontmatter（name/description/allowed-tools）；`--full` 含 references（实测 2907 行）；`path` 返回 `/opt/node/24/lib/node_modules/agent-browser/skill-data/<name>`。

## T47.2 core skill 内容完整性

```bash
exec_in_sandbox "$SID" 'agent-browser skills get core | head -8'
```

**期望**：frontmatter 含触发词（interact with a website / fill a form / take a screenshot 等）与 `allowed-tools: Bash(agent-browser:*)`；正文覆盖 snapshot-and-ref 工作流、表单、认证、多会话并行、故障排查。

## T47.3 dogfood 核心链路

dogfood 工作流：Initialize（输出目录）→ Authenticate → Orient（初始快照）→ Explore → Document（每问题截图+录屏）→ Wrap up。验证机制核心链路（命名会话 + 输出目录 + 截图存档）：

```bash
exec_in_sandbox "$SID" 'mkdir -p /workspace/dogfood-output/screenshots /workspace/dogfood-output/videos'
exec_in_sandbox "$SID" 'agent-browser --session dogfood-demo open https://example.com && agent-browser --session dogfood-demo wait --load networkidle && agent-browser --session dogfood-demo snapshot -i'
exec_in_sandbox "$SID" 'agent-browser --session dogfood-demo screenshot /workspace/dogfood-output/screenshots/01-initial.png && ls -la /workspace/dogfood-output/screenshots/'
exec_in_sandbox "$SID" 'agent-browser --session dogfood-demo close'
```

**期望**：命名会话 `--session` 正常工作；快照返回 ref；截图落盘（实测 15KB）；close 干净退出。报告模板位于 `$(agent-browser skills path dogfood)/templates/`。

> **完整实战**：对 `https://yingdao.com/` 的全流程 dogfood 报告见 [`dogfood-yingdao.md`](./dogfood-yingdao.md)（T48 系列：8 项探索 + 4 项 UX 观察 + 3 项工具侧教训，含 ref 失效误点经典案例）。

## T47.4 derive-client 核心链路

工作流：`network har start`（默认内嵌文本响应体）→ 驱动站点流程 → `network har stop` → 从 HAR 识别端点 → 生成 client。在沙箱内搭建带 fetch 的 JSON API 站点完整验证：

**前置**：沙箱内起本地 API 站点（页面按钮触发 `fetch('/api/items')`，返回 JSON）。**必须用 `/exec/async` 起服务**（见下方"exec 接口配合坑"）：

```bash
# 1. async 起服务（python http.server 托管 /workspace/api_srv.py 或静态页）
curl -X POST "$BASE/session/$SID/exec/async" -d '{"command":"cd /workspace && python3 api_srv.py"}'

# 2. 录制
curl -X POST "$BASE/session/$SID/exec" -d '{"command":"agent-browser open http://127.0.0.1:9096 && agent-browser wait --load networkidle && agent-browser snapshot -i && agent-browser network har start && agent-browser click @e2 && agent-browser wait --text foo && agent-browser network har stop /tmp/site.har","timeoutSeconds":60}'

# 3. 分析 HAR（沙箱无 jq，用 python 替代）
curl -X POST "$BASE/session/$SID/exec" -d '{"command":"python3 -c \"import json; har=json.load(open(chr(47)+chr(116)+chr(109)+chr(112)+chr(47)+chr(115)+chr(105)+chr(116)+chr(101)+chr(46)+chr(104)+chr(97)+chr(114)))...\""}'
```

**期望**：
- HAR 落盘（实测 /tmp/site.har 2571B，含 1 个请求）
- 端点提取成功：`GET 200 http://127.0.0.1:9096/api/items | mime: application/json`
- **响应体默认内嵌**（skill 文档宣称的 "embeds text response bodies by default" 得到验证：body 含 `[{"id": 1, "name": "foo"}, ...]`）

**坑**：
- **沙箱无 `jq`**——skill 文档的 HAR 分析命令全用 jq，镜像可考虑补装；当前用 python3 解析替代
- 快照 ref 要看清角色再点：heading 是 @e1、button 是 @e2，点错 ref 后 `wait --text` 超时导致链条断裂（HAR 保持录制，可补跑）

> **完整实战**：对 `https://test-console.yingdao.com/`（登录态企业控制台）的完整 derive-client 报告见 [`derive-client-ydc.md`](./derive-client-ydc.md)（T49 系列：录制 47 请求 → 识别 7 端点 → 参数 diff → 生成 7 函数 client → 免浏览器直调全部验证通过，含 OPTIONS 预检干扰认证识别的坑）。

## T47.5 webmcp-gen（受限验证）

WebMCP 为实验特性：**页面侧**通过 Chrome 实验性 WebMCP API 声明工具（W3C 提案，如声明式 `application/webmcp+json` script 块），agent-browser 经 CDP 订阅发现并暴露 `webmcp list/invoke/result/cancel` 子命令（默认对本地 Chrome 启用，`--no-webmcp` 关闭）。

```bash
exec_in_sandbox "$SID" 'agent-browser --help | grep -A5 -i webmcp'   # 子命令存在性
exec_in_sandbox "$SID" 'agent-browser webmcp list'                    # 无工具页面 → No WebMCP tools registered
exec_in_sandbox "$SID" 'agent-browser --init-script /dev/null open https://example.com'  # init-script 机制
# 声明式注册页（验证发现能力）：
cat > /workspace/webmcp-page.html <<'EOF'
<script type="application/webmcp+json">
{"tools":[{"name":"get_items","description":"Get the item list","inputSchema":{"type":"object","properties":{}}}]}
</script>
EOF
exec_in_sandbox "$SID" 'agent-browser open http://127.0.0.1:9097/webmcp-page.html && timeout 20 agent-browser webmcp list'
```

**期望/实测**：
- ✅ `webmcp list/invoke/result/cancel` 子命令存在（experimental 组）
- ✅ 无工具页面返回 `No WebMCP tools registered on the current page`，退出码 0
- ✅ `--init-script` 机制正常加载
- ⚠️ **声明式 `application/webmcp+json` 注册未被 Chrome for Testing 153 识别**（list 仍报无工具）——工具注册依赖 Chrome 侧实验特性开关/W3C 规范确切格式，待 Chrome 或 agent-browser 后续版本跟进后复测
- ⚠️ 一次 `webmcp list`（复合命令、无 timeout 保护）**挂死并阻塞整个 exec 队列**（详见下方坑），后续复跑正常——不稳定，使用时必须 `timeout` 包裹

## T47.6 环境不满足组（不适用）

| Skill | 不适用原因 | 需要的前置 |
|---|---|---|
| electron | 沙箱无图形栈，无 Electron 应用 | Electron 应用 + 其 `--remote-debugging-port` CDP |
| slack | 无 Slack workspace 凭据 | workspace 账号 + 登录态 |
| vercel-sandbox | 无 Vercel 环境 | Vercel Sandbox microVM |
| protected-vercel-deployments | 无 Vercel 认证环境 | Vercel Authentication/SSO + Trusted Sources OIDC token |
| agentcore | 无 AWS 环境 | AWS Bedrock AgentCore |

**验证方式**：`agent-browser skills get <name>` 确认 skill 内容可加载即止（内容分发层与 CLI 版本匹配，随 T47.1 一并覆盖）。

> **electron 沙箱缺失清单（2026-09-15 实测精查，T47.6b）**：已有 Xvfb/xvfb-run、chromium 及全部 .so 依赖（ldd 无 not found）、libnss3/libasound2/libgbm1/libcups2/libatk/cairo/pango/xkbcommon 等。**缺**：① electron 运行时（npm 未装）② `libgtk-3-0`、`libxss1`、`libatk-bridge2.0-0`（Electron 官方必需库）③ **dbus**（dbus-daemon/dbus-run-session 均无——实测 `Xvfb :99 + DISPLAY` 跑 headful chromium 因缺 dbus 挂死 EXIT=124）④ gsettings-desktop-schemas（glib schema 告警）⑤ xdpyinfo 等 x11-utils（诊断用）⑥ 目标 Electron 应用本身。若需沙箱支持：`apt-get install -y libgtk-3-0 libxss1 libatk-bridge2.0-0 dbus gsettings-desktop-schemas x11-utils` + `npm i -g electron` + `xvfb-run -a` 包装启动 + 目标应用带 `--remote-debugging-port`。

---

## exec 接口配合 skill 的坑（本次实测汇总）

1. **同步 exec 默认不限时**：请求体 `timeoutSeconds` 不传则无限等待。一条挂死的命令（如无保护的 `webmcp list`）会**阻塞整个 session 的 exec 命令队列**（sandbox lock 串行排队），后续所有 exec 跟着超时。**所有 exec 必带 `timeoutSeconds`**。
2. **恢复手段**：`POST /session/:id/kill-sandbox` 销毁沙箱（PVC 保留，`/workspace` 文件不丢），下次 exec 自动重建，通道即恢复（实测秒级恢复）。
3. **长驻进程必须 `/exec/async`**：同步 exec 里 `nohup ... </dev/null > log 2>&1 &` 甚至 `(... &)` 子壳后台化**仍会挂**（exec 等待整个进程组退出）——dogfood/derive-client 场景的本地测试站点一律走 async exec（`exec-api-reference.md:9` 的提示在实际沙箱上比文档描述更严格）。
4. **嵌套引号破坏 JSON 请求体**：`--fn "…'complete'"` 类命令手拼 JSON 会静默失败（响应为空）。用 python `json.dumps` 构造 payload；heredoc 写文件时避免命令以 `'` 结尾。

## 复测记录

| 用例 | 日期 | 结果 | 备注 |
|---|---|---|---|
| T47.1 skills CLI | 2026-09-15 | ✅ | list 9 个 / --json / get core --full 2907 行 / path 正常 |
| T47.2 core 内容 | 2026-09-15 | ✅ | frontmatter 触发词 + allowed-tools 完整 |
| T47.3 dogfood 链路 | 2026-09-15 | ✅ | `--session dogfood-demo` + 截图 15KB 落盘（session `ses_f5d5eebf`） |
| T47.4 derive-client 链路 | 2026-09-15 | ✅ | HAR 2571B / 端点提取 / **响应体内嵌验证**；坑：沙箱无 jq |
| T47.5 webmcp-gen | 2026-09-15 | ⚠️ | 子命令 + init-script + 空目录返回 ✅；声明式注册未被 Chrome 153 识别；一次 list 挂死（见坑 1） |
| T47.6 环境不满足组 | 2026-09-15 | ⏭️ | 5 个 skill 内容可加载，执行需外部环境 |

> 环境说明：T47.1/T47.5 后段在 session `ses_f5d466dd`（keepAlive + boot）完成。期间服务容器曾重启一次（`opencode-saas-test`），`kill-sandbox` 后 exec 队列恢复、PVC 文件保留均实测确认。
