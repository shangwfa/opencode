# derive-client 实测报告：test-console.yingdao.com

> 使用 agent-browser `derive-client` 技能工作流（Record → Identify → Extract → Generate → Verify）逆向影刀测试控制台的内部 API，生成免浏览器的独立 HTTP client 并真实验证。目标：`https://test-console.yingdao.com/`（登录账号 `admin@fckj`）。
>
> 工具链：agent-browser 0.36.0 + Chrome for Testing 153（headless），沙箱内执行（session `ses_f5d466dd`，keepAlive）。用例编号 T49.x。技能说明见 [`agent-browser-skills.md` T47.4](./agent-browser-skills.md)。

## 流程记录

### T49.1 Record（登录 → 录制 → 驱动流程）

按 skill 规范**先登录再开录**（凭据不进 HAR）：

| 步骤 | 命令/操作 | 结果 |
|---|---|---|
| 1. 登录 | fill 账号/密码 → click 登 录 | ✅ 跳转 `/home`「数据中心 - 控制台」 |
| 2. 开录 | `network har start` | ✅ |
| 3. 参数化录制 | 数据中心切「最近一月」→「最近一周」（同接口两次不同输入，skill 核心 diff 技巧） | ✅ |
| 4. 多菜单探索 | 机器人管理（`/dispatch/robot/list`）、账号管理（`/enterprise/account`） | ✅ |
| 5. 停录 | `network har stop /workspace/ydc.har` | ✅ **47 请求 / 289KB，文本响应体默认内嵌** |

### T49.2 Identify（端点识别）

python3 解析 HAR（沙箱无 jq，见 T47.4 坑），过滤 telemetry/静态资源后识别出 `test-api.yingdao.com` 四类真实端点：

| 域 | 端点 | 说明 |
|---|---|---|
| 统计 | `POST /api/console/statistic/data/tenant/days` | 数据中心趋势，body 参数 |
| 机器人 | `GET /api/dispatch/v2/client/statusCount` | 状态统计（running/idle/offline/total） |
| 机器人 | `GET /api/dispatch/v2/client/list?page=&size=&key=&status=…` | 机器人列表，分页 |
| 账号 | `GET /api/console-service/account/user/list?page=&size=` | 用户列表 |
| 账号 | `GET /api/console-service/account/tenant/detail` / `quota/info?tenantUuid=` | 租户详情/配额 |
| 审批 | `POST /api/console-service/account/approval/wait-count` | 待审批数 |

### T49.3 Extract（参数与认证）

- **参数 diff 成功**：`tenant/days` 两次调用 body 分别为 `{"days":30}` / `{"days":7}`（一月/一周），参数即 days 数值——skill「同一流程跑两次不同输入，diff 出参数」的标准案例
- **认证方式**：`Authorization: Bearer <uuid>` + `X-From: console`（注意 HAR 里同名 URL 的 OPTIONS 预检请求没有这些头，分析时要按 method=GET 过滤，否则误判为无认证）

### T49.4 Generate + Verify（生成 client 并真实验证）

产出物（沙箱 `/workspace/`）：

| 文件 | 内容 |
|---|---|
| `ydc.har` | 原始录制（289KB，含内嵌响应体，可离线研究） |
| `ydc_client.py` | 独立 client：`statistic_days/robot_status_count/robot_list/user_list/tenant_detail/quota_info/wait_approval_count` 7 个函数，token 走 `YDC_TOKEN` 环境变量（skill 安全要求：凭据不落代码） |
| `get_token.py` / `verify.py` | 从 HAR 提取 token / 真实调用验证 |

**验证结果**（免浏览器直调，与录制期响应一致）：

```
robot_status_count: {"runningCount": 0, "idleCount": 1, "offlineCount": 248, "total": 249}
statistic_days(7): []
robot_list items: 5
user_list first:   [{"uuid": "994060029237735424", "name": "1007", ...}]
quota:             {"seniorQuotaTotal": 2007, "seniorQuotaUsed": 999, "basicQuotaTotal": 1000, ...}
wait_approval_count: {'waitApprovalCount': 10}
```

## 发现与坑

| # | 类型 | 内容 |
|---|---|---|
| P1 | ✅ | 完整五步工作流在真实企业控制台（antd SPA + Bearer 认证 + CORS 预检）上全部跑通，HAR 内嵌响应体离线可用 |
| P2 | 坑 | HAR 中 **OPTIONS 预检请求**与真实请求同 URL，分析 headers 必须按 method 过滤，否则误判认证方式 |
| P3 | 坑 | exec 命令含 `$(...)` 会被本地 shell 展开破坏——复杂脚本一律 heredoc 写文件再执行，python 内联 `-c` 避免 |
| P4 | 观察 | token 从录制到验证（约 2 分钟内）仍有效；长期使用需研究刷新机制（skill 文档的 token refresh 环节） |

### T49.5 补录：机器人管理域（全交互）

第二批录制（`ydc2.har`，37 请求）：登录 → 机器人列表页 → 状态筛选（空闲/离线/全部）→ 搜索（无结果词 + 清空）→ 行编辑弹窗（开即取消）→ 机器人分组 tab → 分组"管理机器人"弹窗（Esc 关闭）。

**参数 diff 结果**（`client/list` 完整参数形状）：

| 参数 | 录制来源 | 值 |
|---|---|---|
| `status` | 状态筛选切换 | `idle` / `offline` / 空=全部 |
| `key` | 搜索框 | 机器人账号关键字 |
| `robotClientGroupUuid` | 分组过滤 | 分组 UUID |
| `simple` | 列表模式 | `true`（分组弹窗内为 `size=50` 无 simple） |
| `page` / `size` | 翻页 | 页码从 1 起（观察到一次 `page=0`，疑前端清空搜索时的边界值） |

**新端点**：`GET /api/dispatch/v2/client/group/detail?robotClientGroupUuid=`（点"管理机器人"触发，返回分组+成员 `robotClients`）；`group/list` 支持 `page/size/key`。

**client 扩充**（新增 3 函数，共 10 函数）+ 验证：

```
idle robots:          [{"uuid": "db59ec3d-…", …}]（对应 UI 空闲(1)）
search no-match:      0 条（key 参数生效）
groups:               [{"name": "w3", "clientCount": 2}, {"name": "w2", "clientCount": 7}, …]
group detail(w2):     {"name": "w2", "robotClients": [{…}, …]}
```

**写操作边界**：编辑机器人注释（PUT 类）、编辑/删除分组、保存分组-机器人关联等**写接口未触发**——弹窗一律开即取消（测试环境保守策略，derive-client skill 亦要求 consequential 操作走确认）。需要时可按同法录制（填写+确定）。

**补录中的坑（L1 第三次重演）**：筛选/搜索刷新表格后 edit ref 失效；`find text` 点击 tab 被覆盖层拦截（改为直接用 tab 区域稳定 ref）。搜索清空用输入框的 `close-circle` 按钮而非 `fill ''`（后者在部分 antd 受控组件上不触发重查）。

## 复测记录

| 日期 | 结果 | 备注 |
|---|---|---|
| 2026-09-15 | ✅ | 登录→录制 47 请求→识别 7 端点→参数 diff（days=30/7）→生成 7 函数 client→直调全部通过 |
| 2026-09-15 | ✅ | T49.5 机器人管理补录：37 请求→client/list 全参数形状（status/key/group_uuid/simple）+ group/detail→client 扩至 10 函数→直调全部通过 |
