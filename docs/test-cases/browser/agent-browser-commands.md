# agent-browser 命令全量覆盖用例

> 沉淀自官方 [Commands 参考](https://agent-browser.dev/commands)，按官方 30+ 命令组做**组级全覆盖**：每组至少一个代表命令在沙箱实测，同组兄弟命令标注覆盖状态。环境：agent-browser 0.36.0 + Chrome for Testing 153（headless），session `ses_f5d466dd`，本地测试页 `http://127.0.0.1:9098/cmdtest.html`（含表单/下拉/复选/拖拽/上传/对话框/iframe/长滚动，页面文件在沙箱 `/workspace/cmdtest.html`，经 `/exec/async` 起 `python3 -m http.server 9098`）。
>
> 相关文档：[`base.md`](./base.md)（Quick Start）｜[`agent-browser-skills.md`](./agent-browser-skills.md)（skills）｜[`agent-browser-mcp.md`](../mcps/agent-browser-mcp.md)（MCP）。

## 覆盖矩阵（T50.x）

状态：✅ 实测通过｜⚠️ 有坑/部分｜⏭️ 环境不适用｜🔗 已在其他用例覆盖

| # | 命令组 | 覆盖命令 | 状态 | 实测结果/坑 |
|---|---|---|---|---|
| T50.1 | **Core 导航/交互** | open / click --new-tab / dblclick / fill / type / press / keyboard type+inserttext / keydown+keyup / hover / select / check+uncheck / scroll / scrollintoview / drag / upload | ✅ | 全部生效：dblclick 计数=1、hover 出 "hovered"、drag 后 drop 区 "dropped"、upload 值=`C:\fakepath\up.txt` |
| T50.2 | **截图/PDF** | screenshot --full / --annotate / jpeg+quality / png / pdf | ✅ | annotate 输出 `[N] @eN` 图例；jpeg 60 质量 21KB；pdf 39KB |
| T50.3 | **snapshot/eval/read** | snapshot -i / eval / read（活动 tab + URL + --outline） | ✅ | read 无 Chrome 直接取 markdown；--outline 输出标题大纲 |
| T50.3b | **snapshot 选项矩阵**（官方 Snapshots 页） | -i / -u / -c / -d \<n\> / -s / --json | ✅ | `-u` link 带出完整 href（含锚点）；`-c` 18 行 vs 完整 31 行（剔除空结构元素）；`-d 2` 限深；`-s`/`--json`/`-i` 见 T46/T50 其他行。**最佳实践**：复杂页 `-i -c -d` 组合压输出 |
| T50.4 | **get 全系（10）** | text/html/value/attr/title/url/cdp-url/count/box/styles | ✅ | 全部返回正确（box 给 x/y/w/h；styles 计算样式） |
| T50.5 | **is 系列** | is visible / enabled / checked | ✅ | 布尔输出正常 |
| T50.6 | **find 语义定位（10 变体）** | label / testid / role --name / first / alt / text（T46.3） | ✅ | `find label Name fill Bob` 等全过；alt 定位 img 其 text 为空属正常（图片无文本） |
| T50.6b | **Selectors 四类定位**（官方 Selectors 页） | refs `@eN` / CSS / `text=` / `xpath=` | ⚠️ | refs 与 CSS 全流程主用 ✅；**`xpath=//h1` 实测 ✅**；**`text=xxx` 实测失效**——页面确定含该文本仍 `Element not found`，`get text 'text=…'` 甚至静默无输出（0.36.0 bug B6），语义文本定位用 `find text <t> <action>` 替代（实测正常） |
| T50.7 | **wait 系列** | selector / --text / --url / --fn / --load domcontentloaded / ms | ✅ | CSS 选择器形式正常（注意：**`wait @ref` 在 0.36.0 固定超时**，见 base.md T46.5） |
| T50.7b | wait --state hidden | ⚠️ | **0.36.0 bug**：`--state hidden` 报 `Failed to read state from hidden`（参数被误当文件路径），用 `--fn` 判隐代替 |
| T50.8 | **download 组** | download / wait --download | ⏭️ | 测试页无下载目标未实测；命令存在（--help 确认） |
| T50.9 | **mouse 组** | move / wheel | ✅ | down/up 同组未单测 |
| T50.10 | **clipboard 组** | read/write | ⏭️ | 沙箱 headless 无系统剪贴板（`navigator.clipboard` undefined），环境限制 |
| T50.11 | **set 模拟组** | viewport / media dark / geo / offline on+off / headers | ✅ | viewport 800x600 经 innerWidth 验证；dark 经 matchMedia 验证；offline 经 navigator.onLine 验证 |
| T50.11b | set device | ⚠️ | 命令成功但 UA 断言 inconclusive（大小写写错），待复测 |
| T50.12 | **cookies 组** | set --domain / list | ⚠️ | set 不带 `--domain` 报 `Invalid cookie fields`（需显式 domain）；https 域 list 正常；**http://127.0.0.1 上报 "Storage error: Uncaught"**（见 T50.13 坑） |
| T50.13 | **storage 组** | local/session set+get+list | ⚠️ | **大坑：Chrome 153 拒绝 `http://127.0.0.1` 文档的 localStorage**（SecurityError），agent-browser 未透传原始错误只报 "Storage error: Uncaught"；https 站（example.com）全部正常。本地 http 测试站 + storage 组合不可用，改 https 或 eval 兜底 |
| T50.14 | **network 组** | route --abort / unroute / requests --filter / har start+stop | ✅ | route 拦截生效；HAR 见 T47.4/T49（body 内嵌）；`network request <id>` 未单测 |
| T50.15 | **tabs 组** | tab list / new --label / t\<N\> 切换 / label 切换 / close / window new | ✅ | label 机制如文档（命名稳定）；window new 开 t2 |
| T50.16 | **frame 组** | iframe 自动内联（直接 fill 内部 ref）/ frame @ref 域快照 / frame main | ✅ | 无需切 frame 即可交互内部元素 |
| T50.17 | **dialog 组** | confirm 触发 / status / dismiss | ✅ | dialog 阻塞时**所有命令响应带 warning**；alert/beforeunload 默认自动 accept |
| T50.18 | **streaming 组** | stream status | ✅ | 默认启用（ws://127.0.0.1:36529）；enable/disable 未单测（status 已示启用态） |
| T50.19 | **debug 组** | console / errors / highlight / trace start+stop / profiler start+stop | ✅ | console 捕获 `[log] hi`；trace 365KB zip；profiler 953 events 187KB |
| T50.19b | record 录屏 | ⏭️ | 沙箱缺 `ffmpeg`（录制硬依赖），镜像可考虑补装 |
| T50.19c | inspect（DevTools） | ⏭️ | 无显示环境 |
| T50.20 | **auth vault 组** | auth save --password-stdin / list / show / delete | ✅ | 密码经 stdin 不进 shell 历史；show 不显示密码。`auth login` 未真跑（无真实登录目标，手动登录流程见 T49.1） |
| T50.20b | **plugin 组** | credential.read 插件 + auth login --credential-provider | 🔗 | 完整实战见 [`plugin-credential-shop.md`](./plugin-credential-shop.md)（T51：AI 登录商城后台，全程命令零密码） |
| T50.21 | **confirm/deny** | --confirm-actions eval | ⚠️ | **实测不符**：冷启动新 daemon（新 session 名）下 eval 仍直接执行、无 `confirmation_required` 响应，与官方文档不符（0.36.0），待版本跟进 |
| T50.22 | **state 组** | state save | ✅ | 650B JSON（含 cookies+storage，https 域）；load/list/clear/clean 同构未单测 |
| T50.22b | **Sessions 体系**（官方 Sessions 页） | --restore 自动持久化 / 加密 / 明文风险 | ✅ | **--restore 闭环实测**：首启 `restore: missing` → close 时 `save: saved` → 重启 `restore: loaded`，cookie 跨重启保留（登录一次永久免登录的机制）；**加密实测**：默认 state 文件是**明文 JSON**（cookie 值裸奔可见），设 `AGENT_BROWSER_ENCRYPTION_KEY`（64 hex）后文件加密变形——生产必开；restore key 非法字符（空格/斜杠/路径穿越）被拒 |
| T50.23 | **session 组** | session / session list | ✅ | 命名会话隔离如文档 |
| T50.24 | **profiles 组** | profiles | ⏭️ | headless 无 Chrome user data 目录（临时 profile），属预期 |
| T50.25 | **dashboard 组** | dashboard start / stop | ✅ | 沙箱内实测：start → `http://localhost:4848` HTTP 200 → stop 干净退出 |
| T50.26 | **doctor** | doctor --offline --quick | ✅ | `6 pass, 0 warn, 0 fail` |
| T50.27 | **chat** | — | ⏭️ | 需 `AI_GATEWAY_API_KEY` |
| T50.28 | **navigation 组** | back / forward / reload / pushstate（绝对 URL） | ✅ | pushstate 不刷新改 URL（/spa-route）；**相对路径 bug**：`pushstate /spa-route` 报 `Invalid URL`（0.36.0 内部 `new URL` 未传 base） |
| T50.29 | **react 组** | react tree/inspect/renders/suspense | ⏭️ | 测试页非 React 应用；需 `--enable react-devtools` 启动 |
| T50.29b | **vitals** | vitals | ✅ | 框架无关，输出 TTFB/FCP/LCP/CLS/INP 全指标 |
| T50.30 | **a11y 审计** | a11y | ✅ | 内嵌 axe-core 4.12.1（无需 CDN），实测揪出测试页 6 违规（含 iframe frame-title） |
| T50.31 | **init scripts** | --init-script | 🔗 | T47.5 已覆盖；addinitscript/removeinitscript 未单测 |
| T50.32 | **batch** | 参数模式 + stdin JSON 模式 | ✅ | `batch 'get title' 'get url'` 单次调用多命令；stdin 模式（heredoc 写 JSON 文件重定向）执行成功——注意文本输出为紧凑格式（非数组），要结构化结果加 `--json` |
| T50.33 | **mcp** | mcp --tools core | 🔗 | T44 全套（29 工具）；profiles：core/network/state/debug/tabs/react/mobile/all |
| T50.34 | **webmcp** | list/invoke | 🔗 | T47.5（受限验证：Chrome 153 未识别声明式注册） |
| T50.35 | **connect（CDP）** | get cdp-url | ✅ | URL 可取；`connect`/`--auto-connect` 未单测（本环境 daemon 自管 Chrome） |

## 命令规模

`agent-browser --help` 约 155 个命令/选项条目；本用例覆盖 30+ 命令组，实测 ✅ 24 组、⚠️ 5 组、⏭️ 8 组（环境/依赖缺失）、🔗 3 组（其他用例已覆盖）。

## 本轮新发现的 bug/坑汇总（0.36.0 @ 沙箱）

| # | 命令 | 现象 | 规避 |
|---|---|---|---|
| B1 | `wait <sel> --state hidden` | `Failed to read state from hidden: No such file or directory`（--state 值被当文件路径解析；已复核：flag 前置/后置两种顺序均失败） | 用 `wait --fn '!document.querySelector(...)'` 代替 |
| B2 | `pushstate /相对路径` | `Invalid URL`（内部 new URL 未传 base） | 用绝对 URL |
| B3 | `cookies set`（无 --domain） | `Invalid cookie fields` | 显式 `--domain` |
| B4 | storage/cookies on `http://127.0.0.1` | `Storage error: Uncaught`（Chrome 153 拒绝非 secure 文档 localStorage，CLI 未透传 SecurityError） | 本地测试站走 https，或接受 storage 组不可用 |
| B5 | `--confirm-actions` | 未触发 confirmation_required 直接执行 | 待查（疑需 daemon 启动期生效） |
| B6 | `text=` 前缀选择器 | 页面含该文本仍 `Element not found`；`get text 'text=…'` 静默无输出 | 用 `find text <文本> <动作>`（实测正常）或 CSS/xpath= |

## 复测记录

| 日期 | 结果 | 备注 |
|---|---|---|
| 2026-09-15 | ✅ 26 组 + ⚠️ 4 组 + ⏭️ 7 组 + 🔗 3 组 | 全交互测试页 `/workspace/cmdtest.html`；新 bug 5 个（B1-B5）；二轮补测 dashboard/batch stdin/confirm 坐实 |
