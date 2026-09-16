# Network 应用场景用例集

> 沉淀 [Network 官方文档](https://agent-browser.dev/network) 的应用场景为可执行用例。Network 组把浏览器从"页面执行器"升级成"**可控的流量中间人**"：mock 上游、拦下游、留证据。
>
> 环境：agent-browser 0.36.0 + Chrome for Testing 153（headless），session `ses_f5d466dd`，本地页 `http://127.0.0.1:9098/cmdtest.html`（`/exec/async` 起 `python3 -m http.server 9098`）。相关：[`derive-client-ydc.md`](./derive-client-ydc.md)（HAR 深度实战）。

## T54.1 后端没好，前端先跑（`--body` mock）

**尴尬**：后端接口在开发/联调环境挂了/第三方接口收费，前端页面空转。

```bash
# mock 前确认：路径不存在 → REAL:404
agent-browser eval 'fetch("/api/orders").then(r => "REAL:" + r.status)'
# 一行 mock（本地服务器根本没有该路径）
agent-browser network route '**/api/orders' --body '{"orders":[{"id":1,"amount":99}]}'
agent-browser eval 'fetch("/api/orders").then(r => r.json()).then(d => "MOCK:" + JSON.stringify(d))'
agent-browser network unroute
```

**实测**：`"REAL:404"` → route 后 `"MOCK:{\"orders\":[{\"id\":1,\"amount\":99}]}"` ✅——页面完整可交互，不被后端进度卡住。

## T54.2 页面太重/有噪声，测试被干扰（resource-type 拦截）

**尴尬**：自动化时图片/字体/统计脚本全在跑——慢、偶发超时、弹客服窗、结果不可复现。

```bash
agent-browser network route '*' --abort --resource-type image,font
agent-browser reload      # 拦截在路由注册后的请求生效
agent-browser network unroute
```

**实测**：拦截后 reload，页面 DOM 正常（`PAGE_OK`），资源类请求被静默丢弃 ✅。爬数据场景同样适用（省带宽）。

## T54.3 "页面显示不对"——看接口说了什么（责任划分）

**尴尬**：用户报障"列表是空的"，前端后端互相甩锅。

```bash
agent-browser network requests --filter api --status 2xx   # 接口都返回了什么
agent-browser network request <id> --json                   # 单请求完整头+生命周期
```

**实测**：日志定位 `[7535.17] GET /api/orders 200`，`--json` 出完整 headers（含 UA/Referer）✅。**接口返回空 → 后端问题；接口有数据页面没显示 → 前端问题**，当场划分。

## T54.4 逆向 API / 留证录制（HAR）

**尴尬**：系统只有网页没有 API；或需要把"问题现场"打包给后端。

```bash
agent-browser network har start        # 默认内嵌文本响应体（≤2MB/个）
# … 驱动页面流程（同一流程 ≥2 次不同输入，diff 出参数）…
agent-browser network har stop /workspace/trace.har
```

**实测**：`har_entries=1`，`body_embedded=True`（响应体在 HAR 里离线可查）✅。完整 derive-client 工作流见 [`derive-client-ydc.md`](./derive-client-ydc.md)。**注意**：HAR 含 cookies/bearer/API key，视为敏感文件。

## T54.5 容灾/降级验证（故障注入）

**尴尬**：接口超时/500 时前端是白屏还是优雅兜底？平时测不到。

```bash
agent-browser network route '**/api/orders' --abort
agent-browser eval 'fetch("/api/orders").catch(e => "FAIL_HANDLED_GRACEFULLY")'
agent-browser network unroute
```

**实测**：abort 后 fetch 走 catch 分支（`FAIL_HANDLED_GRACEFULLY`）✅——**容灾测试一行命令**，无需真把后端打挂。

## T54.6 合规/隐私巡检

**尴尬**：页面向第三方发了什么（tracking/外发域名）？测试 SDK 有没有误上生产？

```bash
agent-browser network requests --filter google-analytics
agent-browser network requests --filter third-party.com
```

**实测**：过滤正常（本测试页无第三方请求，正确返回空）✅。发版前巡检"统计 SDK 误带"场景直接可用。

## T54.7 安全阀门（SaaS 特色：拦住真实世界后果）

**尴尬**：AI 在沙箱操作含支付/短信/工单的页面，prompt 层约束拦不住误操作。

```bash
agent-browser network route '**/pay/**' --abort
agent-browser network route '**/sms/**' --abort
# AI 随意操作，触发支付/短信的请求在浏览器层被拦
agent-browser eval 'fetch("/pay/create").catch(e => "BLOCKED_SAFE")'
```

**实测**：`BLOCKED_SAFE` ✅——**比 prompt 约束可靠得多的硬闸门**，推荐作为 AI 操作真实业务页面的标准前置。

## 实施注意

1. **路由时序**：route 只影响注册之后的请求——需要拦首屏加载时用 `open`（无 URL）→ route → navigate 时序（batch 一次完成，官方有示例）
2. **unroute 习惯**：route 是会话级持久，用完 `network unroute [url]` 清理，避免污染后续用例
3. mock 的 `--body` 是 JSON 字符串，含引号时注意 exec 接口转义（建议 heredoc 落文件或 python 构造 payload）
4. HAR 默认内嵌响应体 = 敏感数据默认落盘，共享/入库前先脱敏或 `--content none`

## 复测记录

| 用例 | 日期 | 结果 | 备注 |
|---|---|---|---|
| T54.1 mock | 2026-09-15 | ✅ | REAL:404 → MOCK:200，不存在的路径也能 mock |
| T54.2 资源拦截 | 2026-09-15 | ✅ | image/font 拦截后页面正常 |
| T54.3 接口排查 | 2026-09-15 | ✅ | --filter/--status/--json 全正常 |
| T54.4 HAR 留证 | 2026-09-15 | ✅ | har_entries=1，body_embedded=True |
| T54.5 容灾注入 | 2026-09-15 | ✅ | abort → catch 分支命中 |
| T54.6 合规巡检 | 2026-09-15 | ✅ | 过滤逻辑正常（空结果语义正确） |
| T54.7 安全阀门 | 2026-09-15 | ✅ | 支付路径硬拦截，AI 误操作无真实后果 |
