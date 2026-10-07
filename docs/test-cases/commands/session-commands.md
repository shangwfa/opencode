# Session Commands（会话级自定义命令，V2）

> **范围**：仅 PG 模式（SaaS 必设 `OPENCODE_DATABASE_URL`，见根 `AGENTS.md`）。
>
> **V2 化说明（2026-10-08）**：正文全部为 V2 原生写法（`/api` 前缀 + Basic Auth + `{data}` 包装）。V1 时代的 `/commands/create`、`{command, arguments}`、同步返回 `parts`、DELETE 200 已全部移除，归档在文末历史记录。本轮同时并入两条新契约：**template 256KB 上限（413）** 与 **`time.updated` 同毫秒严格递增**（见契约表）。

## V2 契约

| 行为 | 请求/响应 | 断言要点 |
|---|---|---|
| 创建/替换 | `POST /api/session/:id/commands`，body `{name, template, description?, agent?, model?, subagent?\|subtask?, hints?}` | 200 返回 `Definition`（`source:"session"`，`sam` 无关——命令 id 是 `scmd_` 前缀仅 PG 可见）；同名 (session,name) 是 upsert |
| 列表 | `GET /api/session/:id/commands` | 200 `{data: Definition[]}`，为**合并视图**（builtin + config + sandbox 扫描 + session 覆盖），同名只出现最高优先级一条 |
| 删除单个 | `DELETE /api/session/:id/commands/:name` | 204；删除不存在的 name 同为 204（幂等）；删 session 级覆盖后 instance/sandbox 版本回退 |
| 清空 | `DELETE /api/session/:id/commands` | 204；只清 session 层（PG 行），builtin/sandbox 不受影响 |
| 刷新 | `POST /api/session/:id/commands/refresh` | 200 `{data: Definition[]}`（绕过指纹缓存重扫沙箱，与紧邻 GET list 深比较一致） |
| 执行 | `POST /api/session/:id/command`，body `{name, text, ...PromptInput}` | **204 接纳**（异步）；执行结果从 `GET /api/session/:id/context` / SSE 取——展开后的模板作为新 user message 入队 |
| 未知命令 | 同上 | 404 `CommandNotFoundError`（V1 曾为 500 UnknownError） |
| **template 上限（本轮新增）** | create/replace | 超 `256*1024` **UTF-8 字节** → 413 `SessionCommandTemplateTooLargeError`（`actualBytes`/`maxBytes`）；拒绝写入不改动已存行 |
| **时间戳（本轮加固）** | upsert | `time_created` 不变；`time_updated` 用 `max(now, time_updated+1)` **同毫秒也严格递增**（与其余五个资源服务一致） |
| 非法名/缺字段 | create | 名字经 trim 后按 `validName` 校验（拒绝 `../outside` 等）；缺 `name`/`template` → 400 |
| session 不存在 | 任一命令路由 | 404 `SessionNotFoundError`（middleware 统一判定） |
| owner 语义 | 内层子会话（`parentID`） | 与父共享同一份命令行（读写都落 owner 行）；历史 fork 独立（同 agents-md T36.16） |
| **per-request model** | `POST /command` | **payload 无 model 字段**（多传被丢弃）：执行用会话当前模型——先 `POST /api/session/:id/model` 切换，或命令定义携带 `model` |
| 插值失败 | `POST /command` | 模板 `` !`cmd` `` 在 admit 前同步展开，失败 → 500 `CommandExecutionError`（含 stderr），不静默 |

**优先级链**：`sandbox（/workspace/.opencode/commands/**.md，不落库）> session（PG）> builtin/config`；列表与执行用同一 resolver——**执行命中的必须是列表显示的那一层**。

> ⚠️ **仓库级来源的现状（2026-10-08 实证）**：markdown 目录扫描（`scan.ts`，走沙箱命令）在 SaaS **可用**（T33.30/31 实证）；项目 `AGENTS.md` 已由**会话级源** `core/project-agents-md` 修复（见 `session-agents-md.md` 发现 8）；**config 文件通道仍断**——沙箱 `.opencode/opencode.json` 的 `command`/`mcp` 等字段不会被加载（`Config` discovery 经 `FSUtil` 服务端 fs，读不到沙箱路径；实测 `command` 字段不进合并列表）。V1 的项目 config 字段在 SaaS 均失效，遗留待修。

**template 语义**：`$ARGUMENTS` 全量参数；`$1..$N` 位置参数（末位吸收剩余）；无占位符时参数以空行追加；`` !`cmd` `` 沙箱 shell 展开（仅模板内，**用户参数中的不展开**）；`@file` 文件引用（沙箱内展开）。

## 公共配置（组合 3）

```bash
cd docs/test-cases
source ./test-env.sh 3      # BASE=localhost:14096, PG_URL=opencode-v2-up, OPENCODE_PASSWORD 自动取容器
source ./test-lib.sh        # api_curl / new_session / run_shell / pgval / stream_prompt
```

模型统一 `Yd-GLM/glm-5.3-flash`（`$V2_MODEL`）。命令执行是**异步接纳**（204），判定必须从 context 取新增 user message 与 assistant 回复，不能假设同步返回文本：

```bash
# 执行命令并等待一轮（stream_prompt 的封装；命令版直接 POST /command 后用同一 SSE 等待）
watermark=$(message_watermark "$SID")
jq -nc --arg name demo --arg text "参数" '{name:$name, text:$text, model:$V2_MODEL}' \
  | api_curl -X POST "$BASE/api/session/$SID/command" -H 'Content-Type: application/json' --data-binary @- -w 'HTTP %{http_code}\n'
# 然后轮询 context / SSE 至 execution 终态，取水位之后的新 user message（模板展开结果）与 assistant 文本
```

---

## 一、API CRUD（T33.1–T33.9）

| 用例 | 操作（V2） | 特有期望 |
|---|---|---|
| T33.1 创建 | `POST .../commands` `{name:"pg-a", template:"A", description:"Alpha", agent:"build", subtask:true}` | 200，字段完整回显（`source:"session"`、`subagent:true`）；PG `session_commands` 一致 |
| T33.2 列表合并 | 创建后 `GET .../commands` | 与 builtin 合并；session 项追加，同名时 session 在前 |
| T33.3 同名更新 | 再 POST 同 name 改 template | 列表 count=1、template 已更新；`time_created` 不变 |
| T33.4 删单个 | `DELETE .../commands/:name` | **204**；列表/PG 移除 |
| T33.5 清空 | 建 2 个后 `DELETE .../commands` | **204**；session 项清空、builtin 保留 |
| T33.6 隔离 | A/B 各建同名 | 列表互不可见 |
| T33.7 删 session 级联 | `DELETE /api/session/:id` | `GET .../commands` → 404；PG 级联 count=0 |
| T33.8 缺字段 | 缺 name / 缺 template | 均 400 |
| T33.9 不存在 session | `ses_NOTEXIST` | create/list 均 404（统一 `SessionNotFoundError`，V1 早期 create 是 FK 500 已改进） |

```bash
S=$(new_session '{"title":"cmd-crud"}')
api_curl -X POST "$BASE/api/session/$S/commands" -H 'Content-Type: application/json' \
  -d '{"name":"pg-a","template":"A","description":"Alpha","agent":"build","subtask":true}' | jexec "d"
pgval "SELECT name, description, agent, subagent, hints::text FROM session_commands WHERE session_id='$S'"
```

## 二、覆盖与回退（T33.10–T33.11、T33.21）

### T33.10 session 覆盖同名 instance 命令（overlay）

```bash
api_curl -X POST "$BASE/api/session/$S/commands" -H 'Content-Type: application/json' \
  -d '{"name":"init","template":"SESSION OVERRIDE","description":"Overridden by session"}' >/dev/null
api_curl "$BASE/api/session/$S/commands" | jexec "
inits=[c for c in d['data'] if c['name']=='init']
print('count:', len(inits), 'desc:', inits[0]['description'] if inits else None, 'template:', inits[0].get('template') if inits else None)"
```

期望：`init` 恰 1 条（无重复），description/template 为 session 版本；PG 行 `template=SESSION OVERRIDE`。

### T33.11 删除覆盖后回退 instance

```bash
api_curl -X DELETE "$BASE/api/session/$S/commands/init" -w '%{http_code}\n'   # 204
api_curl "$BASE/api/session/$S/commands" | jexec "
i=[c for c in d['data'] if c['name']=='init']
print('restored source:', i[0]['source'] if i else 'gone')"
pgval "SELECT count(*) FROM session_commands WHERE session_id='$S' AND name='init'"   # 0
```

期望：删除后恢复 builtin/config 原版本（`source` 不再是 `session`）；PG count=0。

### T33.21 清空后 instance 级恢复

创建 `temp1` + 覆盖 `init` → `DELETE .../commands`（清空）→ 列表总数恢复初始、init 描述恢复原样、`temp1` 消失；PG count=0。

## 三、hints 与时间戳（T33.12–T33.13、T33.16）

### T33.12 hints 自动推导

```bash
for t in '"Process $ARGUMENTS"|"h-args"' '"Create $1 in $2"|"h-pos"' '"No placeholders here"|"h-none"'; do
  IFS='|' read -r tpl name <<< "$(echo "$t" | tr -d '"')"
  api_curl -X POST "$BASE/api/session/$S/commands" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$name\",\"template\":\"$tpl\"}" | jexec "print('$name', d.get('hints'))"
done
```

期望：`$ARGUMENTS`→`["$ARGUMENTS"]`；`$1 $2`→`["$1","$2"]`；无占位符→`[]`。

### T33.13 显式 hints 优先

`{name:"explicit-hints", template:"Uses $1 and $ARGUMENTS", hints:["custom"]}` → `hints=["custom"]`（不自动推导）。

### T33.16 时间戳行为（含本轮加固）

API 不返回时间戳，PG 断言：

```bash
api_curl -X POST "$BASE/api/session/$S/commands" -H 'Content-Type: application/json' -d '{"name":"ts-cmd","template":"v1"}' >/dev/null
pgval "SELECT time_created || '|' || time_updated FROM session_commands WHERE session_id='$S' AND name='ts-cmd'"
api_curl -X POST "$BASE/api/session/$S/commands" -H 'Content-Type: application/json' -d '{"name":"ts-cmd","template":"v2"}' >/dev/null
pgval "SELECT time_created || '|' || time_updated FROM session_commands WHERE session_id='$S' AND name='ts-cmd'"
```

期望：创建时 `time_created == time_updated`；upsert 后 `time_created` 不变、`time_updated` 严格递增。**同毫秒连续 upsert 也不重复/回退**（确定性断言在 `packages/core/test/session/commands-pg.test.ts` 的冻结时钟用例）。

## 四、幂等与 PG 直查（T33.17–T33.19）

- **T33.17**：`DELETE .../commands/nonexistent` → **204**（幂等，V1 为 200）。
- **T33.18**：空 session `DELETE .../commands` → **204**；内置命令仍在（只清 session 层）。
- **T33.19**：CRUD 每步配 PG 直查（name/description/agent/subtask/hints），API 与 DB 一致。

## 五、执行语义（T33.14–T33.15、T33.20、T33.22–T33.29）

> 命令执行 = 模板展开为新 user message + 模型一轮。判定取 context 中水位后的 user message（展开结果）与 assistant 文本。

### T33.14 模板替换（$1/$2/$ARGUMENTS）

```bash
api_curl -X POST "$BASE/api/session/$S/commands" -H 'Content-Type: application/json' \
  -d '{"name":"echo-cmd","template":"Respond with exactly this text and nothing else: FIRST=$1 REST=$2 ALL=$ARGUMENTS"}' >/dev/null
# 执行：POST /command {name:"echo-cmd", text:"alpha beta gamma"}，取 assistant 文本
```

期望：`$1`→alpha，`$2`→`beta gamma`（末位吸收剩余），`$ARGUMENTS`→`alpha beta gamma`。

### T33.15 不存在的命令

`POST /command {name:"no-such-cmd", text:""}` → **404 `CommandNotFoundError`**（V1 为 500）。

### T33.20 完整工作流

创建 greet（`Hello $ARGUMENTS!`）→ 执行得 `Hello World` → 列表存在 → 删除后列表消失 → 再执行 404。全程用 context 断言，不靠同步返回。

### T33.22 组件命令（$ARGUMENTS 场景）

`/component UserProfile` 官方场景：模板要求生成 React 组件；判定 assistant 文本含 `UserProfile` 且有 `export|function|const` 代码特征；`hints=["$ARGUMENTS"]`。

### T33.23 多位置参数

模板 `FILENAME=$1 DIRECTORY=$2 CONTENT=$3` + 参数 `config.json src {key:value}` → 逐字回显三段（$3 吸收 `{key:value}`）。

### T33.24 指定 agent

`{name:"plan-review", agent:"plan", ...}` → create/list 回显 `agent=plan`；执行时该轮 assistant 的 `agent` 字段为 `plan`（PG 断言）。

### T33.25 subtask/subagent

`{name:"analyze", subtask:true}` → 回显 `subagent=true`；执行派生子会话（`parentID` 指向父，PG 可查）并异步完成。**断言取子会话的 context**（父轮派生后即结束，标记不出现在父会话）。

### T33.26 model 覆盖

`model` 支持 String（`"Yd-GLM/glm-5.3-flash"`）与对象两种格式；create/list 回显一致；执行走 `switchModel` 后模型回复。

### T33.27 Shell 注入（!`cmd`，需沙箱）

模板含 `` !`git log --oneline -5` ``：原样持久化 PG；执行后新 user message 含**沙箱内真实命令输出**。

### T33.28 文件引用（@file，需沙箱）

模板含 `@README.md`：执行时沙箱读取该文件注入（模型能回显文件中的 marker）。

### T33.29 多命令编排

多次 `POST /command` 串行执行（`STEP1_OK`→`STEP2_OK`）；**单次 prompt 提交 `/cmd1\n/cmd2` 不触发命令**（服务端不解析命令前缀，已知限制，与 V1 一致）。

---

## 六、V2 沙箱与安全（T33.30–T33.36）

> 需真实沙箱。沙箱写文件用 `POST /api/session/:id/shell`；frontmatter 含 `---`/换行/`$` 必须 base64 落盘避免 shell 二次解释。

### T33.30 沙箱命令扫描

`/workspace/.opencode/commands/docs/write.md`（frontmatter：description/agent）与 `plain.md`（纯正文）：

- 列表出现 `docs/write`（嵌套目录映射为名）与 `plain`，均 `source=sandbox`、`sourcePath` 为相对路径；
- frontmatter 元数据正确、正文为 template；
- **PG 无 sandbox-source 行**（不落库）；
- 双 session 隔离：A 写 `a-only.md`、B 写 `b-only.md`，互不可见。

### T33.31 三来源优先级与回退链

同名 `init` 三层（模板各含 `SANDBOX_LAYER`/`SESSION_LAYER` 唯一标记）：

1. sandbox 文件在 → 列表 `source=sandbox` 恰 1 条；**执行**的 user message 含 `SANDBOX_LAYER` 不含 `SESSION_LAYER`（执行与列表同源）；
2. 删 sandbox 文件 + refresh → `source=session`；执行含 `SESSION_LAYER`；
3. 删 PG 行 + refresh → 恢复 builtin 原始 description，PG count=0。

### T33.32 非法名拒绝与坏文件容错

`good.md`（合法）+ `bad.md`（非法 frontmatter/空正文）：good 保留、bad 跳过互不影响；路径穿越/非法名被过滤；**扫描失败不得伪装成空列表**（报错而非静默空 `data`）。

### T33.33 refresh 端点

初始 list → 沙箱写 `refresh-before.md` → refresh 200 含新命令 → 删文件 → refresh 不再含、builtin/PG 仍在 → 与紧邻 GET list 深比较一致；重复 refresh 结果稳定且不产生 PG 行。session 不存在 404。

### T33.34 子会话复用父会话沙箱

父沙箱写 `parent-only.md`（`PARENT_SANDBOX_MARKER`）→ `POST /api/session` `{parentID}` 创建子 → 子列表可见该命令；子执行 `` !`printf SANDBOX_ROOT=%s "$PWD"` `` 得 `/workspace`；子写 marker 文件父可读（真实共享 fs）；删子不毁父沙箱；PG 无独立 child sandbox 行。

### T33.35 参数注入安全

参数 `` !`touch /tmp/cmd-arg-injection-<nonce>` `` 只作文本进 prompt（nonce 文件不出现）；对照模板内 `` !`printf TEMPLATE_SHELL_OK` `` 正常执行。

### T33.36 无占位符模板追加原文

`template="No placeholders here"` + 参数 `plain extra input` → user message 为 `No placeholders here\n\nplain extra input`；纯空白参数不追加。

---

## 覆盖矩阵（实现 → 测试位置）

| V2 行为/边界 | 断言 | 覆盖 |
|---|---|---|
| source 优先级与回退 | sandbox>session>builtin；list 与 execution 同源 | core merge 单测；T33.31 E2E |
| 嵌套扫描/不落库/隔离 | 嵌套名、sourcePath、PG 零行、双 session 隔离 | core scan 单测；T33.30 E2E |
| 插值边界 | `$ARGUMENTS`/`$N`/末位吸收/缺参空/无占位符追加/空白不追加 | core 单测；T33.14/22/23/36 |
| shell 插值安全 | 仅模板内 `` !`cmd` `` 执行；参数中的不执行 | core 单测；T33.27/35 |
| 元数据 | agent/model(String+对象)/subagent|subtask/显式 hints | API+PG 单测；T33.24–26 |
| template 256KB 上限（本轮新增） | 413/多字节字节计数/拒绝不动存储 | `server/test/session-commands.test.ts`；容器级 V1 |
| time.updated 严格递增（本轮加固） | 同毫秒 upsert 不重复/回退 | `core/test/session/commands-pg.test.ts`（冻结时钟）；容器级 V2 |
| 幂等删除/清空 | 204；只清 session 层 | T33.4/5/17/18 |
| session 生命周期 | 删 session 级联；clear 保 builtin/sandbox | T33.7/21 |
| 子会话沙箱复用 | child 解析到 root sandbox；共享 /workspace | `sandbox-provider.test.ts`；T33.34 E2E |
| owner 共享 | 内层子会话共享命令行；fork 独立 | `resources-pg.test.ts`（六资源） |

## 验收标准

- CRUD/overlay/回退/幂等/404/400/413 符合契约表；列表与执行命中同一优先级版本。
- 模板替换（$ARGUMENTS/$N/末位吸收）、agent/subtask/model/shell 注入/文件引用在真实沙箱生效。
- sandbox 扫描不落库、双 session 隔离、坏文件容错；refresh 与 list 一致。
- 参数中的 shell marker 不执行；模板内的正常执行。
- 时间戳严格递增；template 上限按 UTF-8 字节拒绝且不改存储。

---

## V2 执行记录 2026-10-08（当前代码全量重跑）

> **环境**：组合 3（本地 PG `opencode-v2-up` + 本地 OpenSandbox + 容器 `opencode-saas-mcp-t1025:local`（**重建后**，含 template 上限与时间戳加固），模型 `Yd-GLM/glm-5.3-flash`），Basic Auth + SSE/context 硬断言。

> **镜像口径**：T33 全量（Phase A/B/C）执行于含 template 上限 + 时间戳加固的重建镜像；其后为 AGENTS.md 会话级项目源（`core/project-agents-md`）做了第二次镜像重建——该改动只新增指令源、不触碰 commands 链路（`session-runner` 等 226 项单测全绿 + 容器冒烟佐证零回归），T33 未在第二次镜像上整体重跑。

（本节由本轮执行填写。）

### 执行结果（三批，2026-10-08）

| 用例 | 结果 | 关键证据 |
|---|---|---|
| T33.1 创建+PG | ✅ | `source=session`、`subagent=true`；PG 行一致（含 hints `["$ARGUMENTS"]`） |
| T33.2 列表合并 | ✅ | builtin 项 + session 项共存 |
| T33.3 同名 upsert | ✅ | count=1、template 更新 |
| T33.4 删单个 | ✅ | 204；列表/PG 移除 |
| T33.5 清空 | ✅ | 204；session 项清空、builtin 保留 |
| T33.6 隔离 | ✅ | A=`FROM_A` B=`FROM_B` |
| T33.7 删 session 级联 | ✅ | 列表 404；PG count=0 |
| T33.8 缺字段/非法名 | ✅ | 缺 name/缺 template/`../outside` 均 400 |
| T33.9 不存在 session | ✅ | create/list 均 404 `SessionNotFoundError` |
| T33.10 overlay | ✅ | `init` 恰 1 条，desc/template 为 session 版 |
| T33.11 删覆盖回退 | ✅ | 恢复 `source=builtin` 原描述；PG=0 |
| T33.12 hints 推导 | ✅ | `["$ARGUMENTS"]` / `["$1","$2"]` / `[]` |
| T33.13 显式 hints | ✅ | `["custom"]` |
| T33.14 模板替换 | ✅ | `FIRST=alpha REST=beta gamma ALL=alpha beta gamma` 逐字回显 |
| T33.15 未知命令 | ✅ | 404 `CommandNotFoundError` |
| T33.16 时间戳 | ✅ | `time_created` 不变、`time_updated` 严格递增（含本轮 `max(now,+1)` 加固） |
| T33.17 幂等删除 | ✅ | 204（V1 为 200） |
| T33.18 清空空 session | ✅ | 204；builtin 保留 |
| T33.19 PG 直查 | ✅ | API session 项与 PG 行名集合一致 |
| T33.20 完整工作流 | ✅ | 创建→执行 `Hello World`→列表→删除→再执行 404 |
| T33.21 清空恢复 | ✅ | 总集恢复初始（name+desc 深比较）、`temp1` 消失、PG=0 |
| T33.22 组件命令 | ✅ | `UserProfile` React 代码；`hints=["$ARGUMENTS"]` |
| T33.23 多位置参数 | ✅ | `FILENAME=config.json DIRECTORY=src CONTENT={key:value}` |
| T33.24 agent=plan | ✅ | create/list `agent=plan`；执行轮 assistant `agent=plan`（PG 证实） |
| T33.25 subtask | ✅ | `subagent=true`；派生子会话（`parent_id` 指向父）；**SUBTASK_DONE 出现在子会话**记录里 |
| T33.26 model 覆盖 | ✅ | String 与对象格式均 200 且落库；执行走 switchModel 回复 `MODEL_OK` |
| T33.27 shell 注入 | ✅ | 沙箱 git commit 后 `` !`git log --oneline -2` `` 输出注入 user message，hash 被回显 |
| T33.28 文件引用 | ✅ | `@README.md` 注入 nonce marker，模型逐字回显 |
| T33.29 多命令编排 | ✅ | 串行 `STEP1_OK`→`STEP2_OK`；prompt 轮 user 文本**原样** `/step-one\n/step-two`（未展开成模板=命令未被触发） |
| T33.30 沙箱扫描 | ✅ | 嵌套 `docs/write` + frontmatter（desc/agent）+ `sourcePath`；A/B 沙箱文件互不可见；PG 0 行（不落库） |
| T33.31 三来源回退 | ✅ | sandbox 覆盖 builtin→删文件回退 session→删 PG 回退 builtin；**执行轮 user message 含 `SESSION_LAYER_7c1`**（list 与 execution 同源） |
| T33.32 坏文件容错 | ✅ | `good` 保留、`bad`（非法 frontmatter）跳过 |
| T33.33 refresh | ✅ | 文件增删后 refresh 即可见/即消失；与 GET list 一致；重复 refresh 稳定；PG 0 行 |
| T33.34 子会话共享沙箱 | ✅ | 子列表见父沙箱命令；子写 marker 父可读（真实共享 fs）；删子 204 后父沙箱仍活；**child 无独立 sandbox 行** |
| T33.35 参数注入安全 | ✅ | 参数中的 `` !`touch /tmp/…` `` 只作文本（marker 文件 ABSENT）；对照模板内 shell block 正常执行 |
| T33.36 无占位符追加 | ✅ | `No placeholders here\n\nplain extra input`；纯空白参数不追加 |
| T33.cap template 上限 | ✅ | 262144B=200、262145B=413（拒绝后存储不变）、270000B 多字节=413 |

### 本轮契约发现（写断言前必读）

1. **`POST /command` 没有 per-request `model` 字段**：端点 payload = `{name, ...PromptInput}`（`PromptInput` 只有 text/files/agents/skills/format），请求体里多传的 `model` 被 schema 静默丢弃——命令轮用**会话当前模型**。两法择一：执行前 `POST /api/session/:id/model` 切换（test-lib `ensure_model` 语义），或命令**定义**带 `model`（执行走 `switchModel`，T33.26 即此路径）。本轮首轮 8/10 用例因此落到默认 provider 403，切换会话模型后全绿。**与 `POST /prompt`（有 model 字段）不对称——是否补齐属产品决策，待讨论**。
2. **模板插值在 admit 前同步执行**：`` !`cmd` `` 失败（如 git 无 commit）→ `POST /command` 直接 **500 `CommandExecutionError`**（message 含 stderr 摘要），不是入队后失败、不静默——「shell 失败不折叠」契约的 HTTP 层实证。
3. **subtask 的回复在子会话**：父轮派生子会话后即结束（父轮终态可能是 succeeded 或 interrupted，不构成断言）；`SUBTASK_DONE` 类标记要从子会话的 context 断言。
4. **「命令是否被触发」的判定**：看新增 **user message 是否为模板展开结果**。模型在 prose 里提及标记（它记得前几轮）≠ 命令被触发；prompt 轮 user 文本原样透传才是"未触发"的证据。
## 历史记录（归档）

> **2026-09-25（V2 协议首跑，镜像 `opencode-saas-sandbox-test:session-commands`，DeepSeek）**：T33.14、T33.22–T33.29 全 PASS（9/9）。要点：路由映射（`/commands/create`→`/api/.../commands`、`{command,arguments}`→`{name,text}`、同步 parts→204+轮询）；T33.27/28 真实沙箱验证（`!`git log`` 注入真实提交输出、`@README.md` 注入文件内容）；T33.26 model String/对象双格式可用；T33.29 单次 prompt 多命令不触发（已知限制）；参数 shell 注入安全加固 + 回归单测。
>
> **2026-09-15（V1，镜像 `hitl-cbf2276a-wip2`）**：T33.1–T33.26 核心用例（19/21）PASS；注意 V1 的 `commands/create` model 字段仅 String。
>
> **2026-09-06（V1，merge v1.18.29）**：T33.1–T33.14（CRUD/overlay/hints/执行）全过。
>
> **2026-08-01（V1 首测）**：T33.9 行为确认（create 也是 404 统一校验而非 FK 500）；T33.29 多命令编排限制确认（前端 split 取首词、服务端 message 不解析前缀）。
>
> V1 原始脚本（`/session/:id/commands/create`、`{command,arguments}`、同步 parts、DELETE 200、500 UnknownError）见 git 历史。