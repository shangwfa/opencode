---
name: boss-opendata
displayName: Boss 开放数据查询
description: 从 Boss 查询业务数据、飞书多维表格或 Analytics 数据。先走固定接口；当问题涉及时间线、跨业务域，或无法确认哪个接口能完整回答时，补查一次 Analytics 对象目录。
---

# Boss OpenData

统一前缀 `/boss/openapi`，经 OpenAPI 网关鉴权。**当前员工身份由服务端解析**——不要在参数里传 userUuid、飞书 token、员工账号等身份字段。
所有数据受调用人权限约束：**查不到 ≠ 不存在**。

## 1. 三条路径

| 路径 | 用于 | 入口 |
|---|---|---|
| 固定接口 | 边界明确的单一业务对象 | §2 |
| 飞书多维表格 | Boss 已登记、已开高级权限的表 | §3 |
| Analytics | 时间线、跨业务域、口径不明 | §4 |

### 1.1 走哪条：三个问题

先试固定接口。只要下面**任一为「是」**，就必须补查**一次** Analytics 对象目录：

1. 答案要的是**过程**，而不只是**时点状态**？（状态推进、事件序列、生命周期）
2. 答案要**跨两个以上业务域**拼接？（客户 + 合同 + 商机 + 跟进）
3. 你**说不出**哪个固定接口能完整回答？（口径抽象或模糊）

三问全为「否」 → 只用固定接口，**不要**查对象目录。
任一为「是」 → 先取固定接口的确定事实，再查对象目录；无论查得如何，**只查一次**。

判定依据是问题的结构，不是业务名词是否出现在示例里。需求本身模糊时，先问清四件事：业务对象、时间范围、筛选条件、要明细还是要汇总。

## 2. 固定接口

本 skill 不枚举固定接口。按接口契约判断它能否覆盖用户要的**对象、字段、时间范围、口径**。

- 契约匹配就直接用，即使该接口未在本文出现；不要因文档没列而改用 Analytics、追问批准或阻塞。
- 支持批量的接口，多个标识一次批量查，不要循环单条。
- Hologres 探测接口仅用于联调排障，不用于取业务数据。
- 日期参数默认 `yyyyMMdd`，除非契约另行要求。
- 数值字段已是十进制数字（无千分位、无无意义尾零），不要二次格式化。

## 3. 飞书多维表格

仅限 Boss 已登记的 base；新表不能凭飞书链接直接调用。

1. `GET /feishu/bitable/fields?baseId=&tableId=` → 拿 `fieldName`
2. `POST /feishu/bitable/query` → 用 `fieldName` 构造

- 不传 token / openId / employeeId / 用户 ID，身份由服务端解析。
- `fields` 只能取字段清单里的 `fieldName`；不传 = 返回当前可返回字段。
- 条件 ≤ 20，排序 ≤ 5 且不重复，`conjunction` ∈ {and, or}，默认 and。
- 操作符：文本 eq/contains；数字 eq/gt/gte/lt/lte；日期 eq/gt/gte/lt/lte/between；通用 empty/notEmpty。
- 复杂字段可返回，不能用于筛选或排序。
- `pageSize` 1–500，下一页用响应 `pageToken`。
- 请求体出现未知字段会被拒绝，不要加协议外参数。

## 4. Analytics

Analytics 是动态查询入口，不是「一个对象」；可查对象由对象目录与 capability 决定，**可能与固定接口完全不同**。

### 4.1 发现

1. `GET /query/objects?pageNo=1&pageSize=100`（单页上限即 100）
2. `total ≤ 100` → 该页就是完整目录；`total > 100` → 用 keyword / domain / mode 收窄，仍不明确时问用户业务域。
3. 用 `objectCode`、`name`、`description`、`domain`、`modes` 做语义匹配，得到候选集。

### 4.2 选一个对象（消歧阶梯）

按序比对，命中即停：

| 步 | 判据 |
|---|---|
| 1 | **必需字段命中数**最多——用户明确要的字段，该对象能提供几个 |
| 2 | modes 覆盖你要的模式（DETAIL / AGGREGATE） |
| 3 | 语义更广（主题宽表 / 全景 > 单事件明细） |
| 4 | name 与用户用词精确匹配 |

前两步仍无法区分时，`POST /query/objects/capabilities/batch` 批量取 capability 再比，不要逐个试查。

**默认只查一个对象。** 只有「必需字段分散在两个对象、且任一对象都不覆盖全部必需字段」才双查。字段重叠、粒度不同、摘要与明细并存、同步副本——都不构成双查理由；担心数据延迟属数据质量核验，用户明确提出时才做。

### 4.3 构造请求（capability 是唯一准绳）

`GET /query/objects/{objectCode}/capability?includeExamples=true`；批量 capability 已含完整信息时复用，不重复调。

**不要先发请求再按报错改参数。** 按下面五步组装，任一步无法确认就回 capability 收敛。

**① 定 mode**
明细 / 时间线 / 原始事件 → `DETAIL`；分组统计 / 汇总 / 漏斗 / 排行榜 → `AGGREGATE`。
不传会回退 schema 默认、最终兜底 `DETAIL`——所以**显式传**。

**② 按类别分桶**（字段只能进它允许的位置）

| 字段类别 | DETAIL | AGGREGATE | 前置条件 |
|---|---|---|---|
| 维度 | 不进请求 | 只能进 `dimensions` | `groupable=true` |
| 指标 | 不进请求 | 只能进 `measures`，至少一个 | 在 capability 指标列表中 |
| 任意字段 | 可进 `filters` / `sorts` | 同左 | `queryable=true`；排序另需 `sortable=true` |
| 已选指标 | — | 可进 `havingFilters` | 仅 AGGREGATE，且必须是本次已选指标 |

**③ 条件与操作符**
`filters` = WHERE（过滤底表记录）；`havingFilters` = HAVING（过滤聚合结果，仅 AGGREGATE）。
过滤树节点区分两类：GROUP 用 `logic` + `children`，LEAF 用 `field` + `operator` + `value`。
操作符只能取该字段 `filterOps` / `operators` 中出现的值；LIKE 的值不能为 null。

**④ 时间值**
直接复用 capability 的 `format` 或 example，不要自造格式。

**⑤ 收尾**
- `DETAIL`：重点是选对 `filters` 与 `sorts`；返回列**不由 `dimensions` 控制**（来自 `selectable=true` 的字段，未标注则全字段可返回）。没传 `sorts` 时用 schema 默认排序。
- `AGGREGATE`：排序字段必须是本次已选的维度或指标，不能带未分组字段。
- 分页：只传 `pageNo` 或 `pageSize` 时另一半由默认值补齐，不超过 capability 上限。
- capability 带 example 时，**以 example 为骨架改写**，不要从空白请求开始拼。

### 4.4 字段选择的默认偏好

- 时间字段：优先业务发生时间 > createTime / updateTime，以 capability example 出现的为准。
- 说明里写「适合检索、不建议高频分组」的字段：默认不分组。
- 长文本 / HTML / 备注 / 半结构化 JSON：默认不返回，只在用户明确要看原文时取。
- 仅用于 `LIKE` / contains 检索的字段：不排序、不分组。

## 5. 失败处理

先归类，**一次只改一处**，不要连改多个参数。

| 类型 | 表现 | 动作 |
|---|---|---|
| 字段不可用 | `not groupable`、`not queryable`、`sort field invalid` | 回 capability 换字段或换位置，不在同类字段上反复重试 |
| 操作符不匹配 | 过滤报错 | 换成该字段声明的操作符，不要沿用其他对象的经验 |
| 模式错配 | `having` 报错、聚合排序越界、AGGREGATE 无 measure、DETAIL 传 havingFilters | 改 mode 或补齐字段，不要绕过校验 |
| 值格式 | DATE / DATETIME 归一化失败 | 按该字段 `format` 或 example 重写 |
| 空结果 | 返回 0 行 | 先放宽条件，再用更基础的条件验证同一对象；结论里说明可能受权限影响 |
| 不可读 | 字段存在但结果异常 | 换核心展示字段；长文本仅在明确需要时取 |

## 6. 回答契约

每次查询后按此骨架回，不要自由发挥：

1. **结论**——一句话。
2. **数据**——表格，列顺序同响应 `columns`；`rows` 是动态字段映射，按列名取值；分页信息在 `ResultDTO.page`。
3. **口径**——数据来源（固定接口 `<path>` / Analytics `<objectCode>`）、时间范围、筛选条件、聚合方式。
4. **不确定项**——权限可能导致缺数据、对象语义可能不完全覆盖问题；如实写，不要补齐。

混合来源时逐项标注来源；未找到合适 Analytics 对象时，明确说明结论由固定接口拼接而成。

## 7. 不要做

- 不在参数里传身份字段（userUuid / 飞书 token / openId / employeeId / 员工账号）。
- 不凭固定接口的字段名去猜 `objectCode`。
- 不把 Analytics 当成固定业务对象，也不假设固定接口清单已覆盖全部可查对象。
- 不因为「多查一个更保险」同时查语义相近的对象。
- 不在请求体里加协议外字段。
