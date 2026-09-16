# CSV 基准场景执行日志与流程自进化

> 环境：本地 PG + 远端 K8s Sandbox（`opencode-saas-sandbox-test:rpa-e2e`），模型 `Yd-DeepSeek/deepseek-v4-flash`。
> 任务源：`魔法流程测试场景_网页自动化基准场景_表格.csv`（96 条）。可达性以**沙箱内**探测为准。

## 沙箱可达性（探测结论）

- **可达**（HTTP 200 且沙箱内可达）：`shop.yingdao.com`、`www.yingdao.com`、`dewu.com`、`12306.cn`、`ssr1.scrape.center`、`book.douban.com`、`dji.com`、`weather.com`、`dell.com`、`36kr.com`、`tesla.cn`、`xiaomiev.com`、`boc.cn`、`sse.com.cn`、`gaode.com`、`pypi.org`、`imdb.com`(202)、`ctrip/trip`(需登录) 等
- **不可达**：`google.com`、`x.com`、`wikipedia.org`、`coinmarketcap.com`、`polymarket.com`、`bloomberg.com`、`patents.google.com`、`godaddy.com`、`goodreads.com`、`bang.dangdang.com`(超时)、`cn.tradingview.com`
- 注：容器出口与沙箱出口不同，**必须在沙箱内探测**（同一域名结果可能相反）。

## 执行记录

| # | 场景 | 结果 | 应用 / 回放 |
|---|---|---|---|
| 22 | scrape.center 前5页评分>8.8 电影（分页+过滤） | ✅ 29 条 | `rpa_b83903393edc4404821f` / `rparun_67496953ae204a329dc2`（0 修复 0 token） |
| 40 | 豆瓣 Top250 首页书籍（书名/作者/评分） | ✅ 25 条 | `rpa_02b479bbf33043088c82` / `rparun_d4b2ca820a384babb48d`（0/0） |
| 2 | 影刀应用列表（名称/描述/发布者/点赞数，2页） | ✅ 40 条 | `rpa_3bd689a0b18741c8a179` / `rparun_ac4af64db1ae4a38a27b`（0/0） |
| 49 | PyPI requests 最新版本号/发布日期 | ✅ 4 字段 | `rpa_58caa3a3fd494824a42e` / `rparun_ff196b9b3f2245f4a621`（0/0；requests 2.34.2 / 2026-05-14） |
| 41 | 豆瓣图书信息 + 评分分布 | ✅ 5 字段（含 5 星分布） | `rpa_cd58361b6da14aa186f2` / `rparun_94d731db9a874bee982c`（0/0） |
| 12 | F1 2026 车手积分榜（排名/车手/车队/积分） | ✅ 23 行 | `rpa_5e9d98f3d0114f81af94` / `rparun_d854e31f094d43d5b3c2`（0/0） |
| 50 | Dell 笔记本型号与起售价 | ✅ 10 款 | `rpa_d97fae9bff2847178f43` / `rparun_53d00d45cb6b4188a3a3`（0/0） |
| 44 | 大疆产品技术参数 | ⚠️ 成功但高代价 | `rpa_9d325d48ddc54221952e` / `rparun_2ac11523c48f4b348ea1`（**repair 2 / 611,531 tokens**：v1 慢站 open 超时 → v2 修复脚本运行时错误 → v3 成功） |
| 54/16 | 12306 北京→上海高铁（车次/时间/历时/余票，含表单交互） | ✅ 34 班次 | `rpa_02b79b78089447088228` / `rparun_f92a4ebd84db41378577`（0/0；参数化含站点码/日期） |
| 57 | FlightAware 航班详情 | ✅ 通过 | `rpa_6b91a0ab5e33422cbf3d` / `rparun_5082cc55340c4abd9cc0`（0/0） |
| 58 | ShipFinder AIS 查询 | 待执行 | — |
| 6 | 影刀商城表单填写（复选/单选/下拉/非标下拉/数据表） | ✅ 通过 | `rpa_13473ad583f648539418` / `rparun_90eba72fbcba4a1589ff`（0/0；注意 `form-demo` 实际重定向登录页，AI 自适应到组件练习页完成） |
| 63 | 故宫"正在展出"展览列表 | ✅ 6 展 | 重跑通过（`s1 6.3min`，0/0）——首跑因漏写 exploration.md 被闸门拦截，修复后通过 |
| 64 | 上交所 601318 公告 | ✅ 5 条 | `s1 10.3min`，0/0 |
| 80 | 中行今日汇率 | ✅ 45 行 | `s1 4.1min`，0/0 |
| 61 | 天天基金 161725 净值 | ✅ 5 字段 | `s1 9.6min`，0/0 |
| 62 | 有道词典查词（释义/音标/柯林斯例句） | ✅ 5 字段 | 首轮回放触发修复循环失控（repair 2 / **2,129,901 tokens**，产物报废）；修复代码后重沉淀通过（`s1 8.1min`，0/0） |
| 65 | 36氪快讯前 20 条 | ✅ 20 条 | `s1 9.1min`，0/0 |
| 69 | 飞常准到达航班 | ⛔ 强人机验证 | "Press & Hold Human Challenge"——止损规则已写入 skill（该会话用旧版未生效） |
| 59 | 淘宝司法拍卖（杭州住宅） | ⛔ 强反爬 | 130 轮无效尝试超时；止损规则已写入 skill |
| 93 | watcha.cn 口碑飙升榜 | ⏱ 超时（任务接近完成） | 站点可达（200/209ms），81 轮后超预算——属"已通、提取慢"型，见优化 #23 |
| 58 | ShipFinder AIS | ⏱ 超时（任务已走通） | 搜索已执行、AIS 页已开（快照含 MMSI/YUN CHI 001），AI 反复 snapshot+grep 提取超预算 |
| 87 | tradingview 经济热图 | ⛔ 沙箱不可达 | 沙箱内 ETIMEDOUT（容器出口 200 但沙箱出口不通——再次验证必须沙箱内探测） |
| 51 | weather.com 每小时天气 | ⛔ 站点不适配 | `curl -sI` 可达但 `agent-browser open` 反复超时（对照 httpbin 正常）→ 判定站点拒绝无头渲染 |
| 15 | 得物首页商品（名称/价格） | ⛔ 阻塞 | 首页无商品列表；AI 正确拒答未编造 |

## 流程自进化记录（每轮取证后最小改动）

| 轮次 | 观测（证据） | 优化 | 效果 |
|---|---|---|---|
| 1 | `prompt_async` 后立即查状态得到 idle，导致提前进入阶段二并 503 | 驱动改为「先等启动（busy/消息增长）再等 idle」+ 503 重试 | 503 消失，阶段顺序正确 |
| 2 | 不可行任务（得物）无产物仍硬跑阶段二 | 阶段一**闸门**：缺 runner/数据文件即判定 blocked 并停止 | 不再对不可行任务空跑 |
| 3 | 「所有应用」导致翻 9+ 页、113 次 bash、20 分钟超时 | browser-explorer 增**规模有界铁律**（pages/limit 参数化+有界默认，自测用最小参数）；驱动阶段一超时即 abort 并标记 blocked | 同任务 9.8 分钟完成（有界） |
| 4 | 闸门误判：Agent 产出 `runner.mjs`、数据在 `data/` 下 | 闸门容错（`runner.js\|runner.mjs` + 任意 `.data.json`）+ 驱动增加续跑模式（`SID` 跳过阶段一） | 误判消除，可断点续跑 |
| 5 | 4/4 回放 stdout 带 `[agent-browser]` 前缀与多行 JSON，消费方解析脆弱 | 契约要求**结果为 stdout 最后一行单行 JSON**；解析器按"去前缀取末行"实现 | 解析稳定（本轮 40 条正确解析） |
| 6 | 沙箱无法访问境外站点（HN 60s 超时）→ 反复重试 churn | browser-explorer 增**步骤 0 可达性预检**，失败即停不重试 | 不再为不可达目标空转 |
| 7 | 闸门对**单值任务**误判（无 `.data.json` 属正常，PyPI 任务被阻塞） | 闸门放宽为硬条件 `runner(js\|mjs) + exploration.md`，数据文件仅信息项 | #49 正常进入阶段二 |
| 8 | 闸门 `ls a b` 要求两者同时存在 → 只产出 `runner.js` 时误判 | 改为 `(test -f runner.mjs \|\| test -f runner.js)` | #41 正常通过闸门 |
| 9 | Agent 为兼容后缀创建 **symlink** `runner.mjs -> runner.js`，churn（PyPI 15.8 分钟/75 次 bash） | 契约明确：优先 `runner.mjs`；用 `.js` 则加 `package.json {"type":"module"}`；**禁止 symlink** | 后续任务直接用 `.mjs`（F1 任务 9.3 分钟） |
| 10 | 回放失败 `agent-browser open undefined`：`params_schema` **无 default** → 驱动传空参；并触发自修复消耗 **113,929 tokens** | ① app-builder 契约：params_schema 每个 property **必须带 default**（真实值）；② 驱动兜底：缺 default 时从任务文本推导 url/数值 | #41 重出产物后回放 0 修复 0 token |
| 11 | 驱动无法续跑（每次从阶段一重来） | 驱动增加**续跑模式**（`SID`）与 `SKIP_STAGE2` 开关 | 单任务可断点续跑，节省 ~10 分钟/次 |
| 12 | 慢站回放触发 2 次自修复、**611,531 tokens**（DJI：v1 open 超时；v2 修复脚本运行时错误） | browser-explorer 增**稳健性铁律**：显式 `--timeout`；以目标选择器为准等待；open 超时仅允许 1 次换策略重试；自测要求 **fresh ×2**（稳定性）而非仅 fresh+resume | 12306（重型交互）回放 **0 修复 0 token** |
| 13 | 站点可达但拒绝无头渲染（weather.com）→ 试 4+ 种写法白耗 15 分钟 | 步骤 0 增**有界重试**：最多 2 次不同策略，仍失败即报告"站点不适配无头自动化"并停止 | 不再无限试错 |
| 14 | 驱动阶段一超时分支引用未赋值字段导致崩溃；对象型输出 count 解析错（Dell 实为 10 却报 3） | 修复超时分支取 stats；count 解析优先 `parsed.count` → 首个数组字段 → 键数 | 报告准确，异常不再中断 |
| 15 | 目标 URL 重定向登录页（CSV 标 login=0 与实际不符）且 AI 全站盲搜，20 分钟超预算（#6） | 步骤 0 增**登录/重定向规则**：确需登录且无凭据时最多尝试 1 个等价页面，否则报告"需要登录"并停止 | 避免盲搜空耗 |
| 16 | 探索耗时构成（证据：12306 `eval 73 / open 11`；weather `open 21`；每条命令都 `session id` 重算） | browser-explorer 增**效率最佳实践**：固定 `--session`（禁重算）、每页 ≤2 次 eval、一次取回本地解析、选择器等待替代 networkidle、不重建会话、8-10 分钟预算降级、自测最小参数 | F1 复跑（按"写 runner 前=探索期"分期统计）：探索期 **eval 8→5、session 重算 10→0、agent-browser 10→7**；自测期 open 6→0；阶段一 9.3→**7.3 min**（-21%）；回放 0/0。注：早期把自测期计入导致"eval 未降"的误判，分期后确认下降 |
| 17 | 固定 session 后 eval 仍为最大开销（F1 复跑 eval=12 未降） | 增**首步一次性抓取配方**（`open + wait + get html` 落盘 → 全本地解析） | 探索期 eval 8→5→**3** |
| 18 | **自测期怪象**：探索通过后提取逻辑 0 次失败，但自测期 78 事件、31 次在修补 verify 夹具——取证发现失败全是**夹具自身的错**（checkpoint 路径拼接重复、verify↔runner 路径约定不齐、`--args` 写法冲突） | browser-explorer 增**夹具零编写原则**：标准 `selftest.sh`+`verify.mjs` 原样落盘只改占位（EXPECT/FIELDS），之后禁止重写夹具、迭代只改 runner；路径约定固定（checkpoints/、params.json、runner.mjs）；修正 `--args` 单字符串写法与冲突退避 | F1 第四轮：自测期 **78→9 事件**（0 次夹具修补、0 次 open），阶段一 **12.8→3.3 min**；全链路总轮次 94→20；回放仍 0/0 |
| 19 | AI 全部做完却漏写 `exploration.md` → 闸门误判 blocked（#63 故宫） | 产物表改为"`exploration.md` **写 runner 之前先落盘初版**"；夹具/文件名统一为 `runner.mjs`/`selftest.sh`/`verify.mjs` | #63 重跑通过（s1 6.3min） |
| 20 | **修复提取器不剥 markdown 围栏**：AI 回复 `<FIXED_SCRIPT>\`\`\`js...` 被原样存库，回放 `TypeError: "" is not a function`（DJI v2、有道 v2 两次命中同一 bug）——语法检查也没拦住（`node --check` 对该形态意外通过） | rpa-runner.ts：提取后**剥首尾围栏** + `startsWith("```")` 拒绝；语法失败时把错误回填 run.error（不再静默） | 有道词典按新镜像重沉淀后回放 0/0 |
| 21 | 强反爬站点（#59 淘宝司法拍卖 130 轮、#69 飞常准 Press&Hold 挑战）无限试错 | 步骤 0 增**强反爬止损**：出现滑块/验证码/空壳内容即判定不可行并停止，禁止换 session/UA/等待重试 | 待新 skill 生效后验证 |
| 22 | 交互序列类任务（搜索→切tab→取内容）无法本地 dry-run，自测 5 轮浏览器往返（#62 首跑） | 自测铁律增：**探索已验证的命令序列逐字搬进 runner**（不换新写法）；自测仅 fresh+resume 两遍 | #62 重跑 s1 8.1min 0/0（含完整搜索交互） |
| 23 | **"已通、提取慢"型超时**（#58 ShipFinder：搜索/AIS 页全走通，AI 反复 snapshot+grep 提取字段超预算废弃） | ① 驱动：超时前检查产物（runner+data 存在→标 partial 续跑，不废弃）；② skill：交互任务数据在快照验证后**立即转固化**，禁止反复 snapshot+grep 精简；大快照必须 eval 定向取字段而非全文 grep | 待验证 |

## 待续

按 CSV 继续执行沙箱可达且 login=0 的场景；每条执行后复核（产物契约 + 回放四要素：status/exit/repair/tokens + 字段与数量）。
