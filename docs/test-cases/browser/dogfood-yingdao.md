# dogfood 实测报告：yingdao.com

> 使用 agent-browser `dogfood` 技能工作流（Initialize → Orient → Explore → Document → Wrap up）对影刀官网做探索性测试。目标：`https://yingdao.com/`，全程默认参数（无认证、全站范围）。
>
> 工具链：agent-browser 0.36.0 + Chrome for Testing 153（headless），沙箱内执行（session `ses_f5d466dd`，keepAlive）。用例编号 T48.x。

## 探索覆盖（T48.1）

| # | 步骤 | 结果 | 证据 |
|---|---|---|---|
| 1 | 首页打开 + 全页截图 + 快照 | ✅ 标题 `影刀RPA - 影刀官网`，跳转 `www.yingdao.com` | `01-home.png` |
| 2 | 客户案例页（导航点击） | ✅ `/case/list/`，行业筛选 tab（全部/电商/医疗/跨境/金融/零售/制造/物流/餐饮）+ 案例卡片 | `02-cases.png` |
| 3 | 案例列表"电商"筛选 | ✅ 点击生效 | `03-cases-ecom-filter.png` |
| 4 | 留言表单——空提交 | ✅ 原生 required 校验拦截（4 个必填：姓名/公司/场景/手机号） | `04-form-empty-submit.png` |
| 5 | 留言表单——非法手机号（`12345`）提交 | ✅ ant-form 内联错误：**"请输入正确的手机号"** | `05-form-bad-phone.png` |
| 6 | 表单场景下拉（antd Select） | ✅ 展开/选择"个人使用"/收起正常 | 快照记录 |
| 7 | 导航"免费下载" | ✅ → `/client-download/`（下载页），标题正常 | URL 记录 |
| 8 | 移动端视口 375×812 | ✅ `scrollWidth=375` 无横向溢出，汉堡菜单布局切换正常 | `06-mobile-375.png` |

**截图位置**：沙箱 `/workspace/dogfood-yingdao/screenshots/`（PVC 持久）。

## 发现汇总（T48.2）

### 功能缺陷

**无**。八项核心流程（导航/筛选/表单校验/下载入口/响应式）均正常。

### UX / 可访问性观察（非阻断）

| # | 位置 | 观察 | 建议 |
|---|---|---|---|
| O1 | 首页导航/底部 | 多个**无名称可交互元素**：空名称 link（×5+）、可点击 image 无 alt、移动端汉堡菜单按钮无 accessible name | 补 aria-label / alt，屏幕阅读器当前不可用 |
| O2 | 案例列表卡片 | 卡片为 `div+onclick`（非语义 `<a>`），快照语义降级为 generic；标题与"行业/详情"文案粘连（如 `…效率翻了4倍制造详情`） | 用 `<a>` + 文案分离 |
| O3 | 首页案例轮播 | 引用文案与数据指标拼成超长单节点（`"…5000小时平均每月50%数据工作提效24倍千牛批量发消息提速"`） | 结构化分节点 |
| O4 | 表单空提交 | 仅浏览器原生气泡提示，DOM 内无可读错误文案（无障碍/自动化场景不可见） | 自定义 inline error（手机号已有，空值缺失） |

### 测试过程教训（工具侧，适用后续 dogfood 用例）

| # | 教训 | 详情 |
|---|---|---|
| L1 | **ref 失效误点** | 表单交互后未重新 `snapshot -i`，沿用旧 ref 点"免费下载"实际命中"伙伴计划"（`/partner/`），一度误判为站点链接错配；干净快照复核后确认"免费下载"行为正常。**每次页面变化后必须重新快照**（`agent-browser-architecture.md` ref 生命周期规则的实测踩坑） |
| L2 | antd Select 双层渲染 | 快照的 `option` ref 指向原生 option，实际可点的是覆盖层 `.ant-select-item`（点击报 covered 错误）；用 `find text 个人使用 click` 语义定位绕过 |
| L3 | `close --all` 后同 session 复用异常 | 同名 session `close --all` 后 re-open 出现 `about:blank` 残留 tab；建议换 session 名或避免混用 |

## 复测记录

| 日期 | 结果 | 备注 |
|---|---|---|
| 2026-09-15 | ✅ | 8 项流程全过；功能缺陷 0；UX/可访问性观察 4 项；工具侧教训 3 项（L1 为经典 ref 失效案例，建议纳入 skill 接入培训示例） |
