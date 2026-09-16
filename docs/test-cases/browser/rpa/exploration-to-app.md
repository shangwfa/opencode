# RPA 全流程：官方 Skill 探索 → 应用沉淀 → 零 Token 回放

> 环境：本地 PG（`postgresql://local@host.docker.internal:15432/opencode`）+ 远端 K8s Sandbox（`host.docker.internal:30040`），服务镜像 `opencode-saas-sandbox-test:rpa-e2e`，API `http://127.0.0.1:14096`，模型 `Yd-DeepSeek/deepseek-v4-flash`。前置：`source docs/test-cases/test-env.sh`。

## 背景

验证 RPA 闭环的完整生产路径：AI 探索会话（注入**官方版本匹配**的 agent-browser skill）完成真实站点数据提取 → app-builder skill 沉淀为参数化应用 → `POST /rpa/app` 入库 → 零 token 回放并核对结果。

关键约束：

- skill 必须取自**目标沙箱内** `agent-browser skills get core --full` 的输出（版本与沙箱 CLI 匹配），不从宿主机复制。
- 沉淀脚本每次执行实时抓取，不硬编码探索结果。
- 探索与回放结果必须逐项一致。

## T53.1 注入官方 agent-browser skill

### 场景

新建探索会话，在**目标沙箱内**执行 `agent-browser skills get core --full` 取回官方 skill，注入为会话 skill。

### 命令

```bash
SID=$(curl -s -X POST $BASE/session -H 'content-type: application/json' -d '{}' | jq -r .id)

# 1. 沙箱内取回官方 skill（注意经 /exec 在沙箱执行，不是宿主机）
SKILL_JSON=$(curl -s -X POST $BASE/session/$SID/exec \
  -H 'content-type: application/json' \
  -d '{"command":"agent-browser skills get core --full"}' | jq -r .stdout)

# 2. 注入（stdout 即完整 SKILL.md，frontmatter name 为 core）
curl -s -X POST $BASE/session/$SID/skills/create -H 'content-type: application/json' \
  -d "$(jq -Rs '{name:"agent-browser",description:"Official version-matched agent-browser core skill",content:.}' <<<"$SKILL_JSON")"

# 3. 核对
curl -s "$BASE/session/$SID/skills" -H 'content-type: application/json' | jq '.[].name'   # 期望含 agent-browser
```

### 期望

- 沙箱内命令 exitCode=0，输出约 124KB、以 `---\nname: core` 开头。
- 会话 skill 列表含 `agent-browser`，内容与沙箱 CLI 版本匹配。

### 复测记录

| 日期       | 会话                             | 结果                                                                                                                                                                             |
| ---------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-15 | `ses_f5b912862ffezAaFOSyBF7zC4Z` | 通过：exec stdout 124,540 字节（UTF-8 计），落库 skill content 124,384 字符，frontmatter `name: core`。skill 注册名 `agent-browser` 与 frontmatter `core` 不一致，实测加载正常。 |

## T53.2 探索影刀社区提取最新 10 篇文章

### 场景

同一探索会话注入 app-builder skill 后，`prompt_async` 下发任务：访问 `https://www.yingdao.com/community/homePage`，提取最新 10 篇文章（标题/简介/作者/绝对链接），验证后生成 `/workspace/.rpa/pending-app.json`。

### 命令

```bash
curl -s -X POST $BASE/session/$SID/prompt_async -H 'content-type: application/json' -d '{
  "model": {"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"},
  "parts": [{"type":"text","text":"<探索+沉淀任务描述：数量恰好10、四字段非空、链接HTTP 200、按最新排序；脚本参数化 communityUrl/limit；独立 verify checkpoint 验证 exitCode=0>"}]}
}'

# 轮询状态直至 idle
watch -n15 "curl -s $BASE/session/status | jq --arg s $SID '.[\$s]'"
```

### 期望

- 探索输出 10 篇，四字段非空，链接 HTTP 200，文章 ID 降序（新→旧）。
- 列表页简介/作者信息不全时，AI 进入详情页补齐（`detaildiscuss?id=` 页含 `creator-name` 类作者元素与 `发布于` 时间戳）。
- `pending-app.json` 含 name/description/script/params_schema/manifest/exploration 六件套，脚本通过 `node --check` 与独立 verify checkpoint 实测。

### 复测记录

| 日期       | 结果                                                                                                                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-15 | 通过：约 8 分钟完成。探索中发现默认「全部」tab 即按最新排序（官方资讯约 1 周前，经验分享数小时内）；首篇标题为单字 `a` 系页面真实内容非解析错误；作者名含头像装饰数字前缀（如 `22580影刀`），AI 通过详情页 `creator-name` 元素取到真实值 `2580影刀`。 |

## T53.3 沉淀为应用（exploration 兼容对象形态）

### 场景

提取 `pending-app.json` 后 `POST /rpa/app`。AI 生成的 `exploration` 常为结构化 JSON 对象而非字符串，API 必须兼容两种形态。

### 命令

```bash
curl -s -X POST $BASE/session/$SID/exec -H 'content-type: application/json' \
  -d '{"command":"cat /workspace/.rpa/pending-app.json"}' | jq -r .stdout > /tmp/pending.json

jq -n --slurpfile p /tmp/pending.json \
  '{name:$p[0].name, description:$p[0].description, script:$p[0].script,
    exploration:$p[0].exploration, params_schema:$p[0].params_schema,
    manifest:$p[0].manifest, source:"exploration"}' \
| curl -s -X POST $BASE/rpa/app -H 'content-type: application/json' -d @- | jq '.app.id,.version.version,.version.status'
```

### 期望

- `exploration` 为**对象**或字符串均返回 200（2026-09-15 修复前对象形态返回 400 `Expected string | null`）。
- 对象形态落库为格式化 JSON 字符串（`JSON.stringify(v, null, 2)`），版本 `source=exploration`、`status=active`。
- 修复位置：`groups/rpa.ts` 的 `CreatePayload`/`AddVersionPayload` 改为 `Union([Schema.String, JsonMap])`；`handlers/rpa.ts` 的 `explorationText()` 统一序列化，`create` 与 `addVersion` 均生效。

### 复测记录

| 日期       | 结果                                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-15 | 修复前：对象形态 400，需客户端手工 `JSON.stringify` 规避（见 T52.4 首次记录）。                                                                            |
| 2026-09-15 | 修复后：对象形态直接 200（`rpa_45312aee39654549a0c3` 冒烟后已删除），`exploration` 落库为字符串、以 `{\n  "commands": [...` 开头；typecheck 保持 58 基线。 |

## T53.4 零 token 回放并核对

### 场景

对沉淀应用触发 run（无 LLM 参与），核对结果与探索一致。

### 命令

```bash
APP=<上一步 app id>
RUN=$(curl -s -X POST $BASE/rpa/app/$APP/run -H 'content-type: application/json' \
  -d '{"params":{"communityUrl":"https://www.yingdao.com/community/homePage","limit":10}}' | jq -r .run.id)

# 轮询直至终态（影刀站点加载慢，勿用固定 sleep；repairing 表示自动修复中，仍非终态）
while true; do
  ST=$(curl -s $BASE/rpa/run/$RUN | jq -r .run.status)
  case $ST in pending|running|repairing) sleep 10 ;; *) break ;; esac
done
curl -s $BASE/rpa/run/$RUN | jq '.run.status,.run.exit_code,.run.repair_count,.run.repair_tokens'
```

### 期望

- `status=succeeded`、`exit_code=0`、`repair_count=0`、`repair_tokens=0`（纯零 token）。
- stdout JSON：`count=10`、每项 title/summary/author/url 非空、url 为 `detaildiscuss?id=` 绝对链接、文章 ID 降序。
- 10 篇列表与探索阶段逐项一致。

### 复测记录

| 日期       | app / run                                                  | 结果                                                                                                                                                                                                                                                                                           |
| ---------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-15 | `rpa_5d5058336a6d4fc29577` / `rparun_f43fbc474c7a4784a83c` | 通过：succeeded，exit 0，零修复零 token；10 篇字段完整、ID 降序，与探索结果一致（`a`/`修改 亚马逊邮编 90001-稳定版`/`设计器`×2/`【日期选择】`×2/`企业微信指令报错失效`/`AI 接龙`/`标签下载`/`个人常用自定义指令`）。注：stdout 中 JSON 后跟 `[rpa] teardown` 日志，核对时按 `{...}` 边界截取。 |

## T53.5 探索过程审计（事后核查）

### 审计方法

会话消息流（80 条：1 user + 79 assistant）+ PG `exec_log`（97 条）+ 入库脚本全文 + bash 命令 URL 提取，交叉核对。

### 通过项

- **工具分布**：skill×2（官方 agent-browser + app-builder）、bash×73、write×1、edit×1、read×2、todowrite×3，无异常工具。
- **写入范围**：write/edit 仅针对 `/workspace/.rpa/pending-app.json`；73 条 bash 中无 rm/mv/chmod/重定向写/git 等变更目标站点或环境的命令。
- **网络访问**：实际打开的 URL 去重后 5 个，全部 `yingdao.com` 域。命令文本中出现的 `fangguo.com`/`dldir1.qq.com` 系文章正文外链随数据编译命令携带，从未被打开。
- **exec_log**：95 completed / 2 failed / **0 denied**；2 条失败均良性（edit oldString 不匹配后改用重写、read offset 越界）。
- **方法论**：列表页解析 → 详情页补齐（`creator-name`/`发布于`）→ 三重验证（字段非空 + HTTP 200 + ID 降序）→ verify checkpoint 先 `limit=2` 冒烟再 `limit=10` 全量。
- **脚本无硬编码**：文章数据全部实时抓取；正确处理了 `agent-browser eval` 返回双重 JSON 编码的坑（`JSON.parse(JSON.parse(raw))`）。

### 发现的脚本缺陷（AI 生成质量，2026-09-15 已全部修复并入库 v2）

| 级别 | 问题                                                                                                                                                                        | 影响                                                                                                                          | 修复                                                                                                                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 中   | `main()` 续跑语义缺陷：`skip step 2` 分支实际仍执行 `steps[1].run()`（`articles` 局部变量依赖）；`startFrom>=4` 时 `skip step 4` 直接不输出                                 | 若自修复续跑发生在 step 4 前，run 可能 exit 0 成功但 stdout 无结果 JSON（假成功）；跨步骤中间产物仅存局部变量，未持久化到文件 | v2：中间产物持久化到 `<checkpoint>.data.json`，skip 分支从文件恢复零重放；输出步骤永远执行，data 缺失显式报错                                                                                |
| 中   | step 1 硬编码 `https://www.yingdao.com/community/article`，`communityUrl` 参数仅作用于 setup 的 open                                                                        | 换 `communityUrl` 值时列表页跳转不变，参数语义失效                                                                            | v2：从参数 URL 页面经 DOM 发现列表入口（`pathname.split('/').includes('article')`）                                                                                                          |
| 低   | 子进程输出 `[agent-browser] launched browser` 混入 stdout                                                                                                                   | 破坏「stdout 只输出机器可读 JSON」约定                                                                                        | v2：日志全走 stderr、teardown 静默；最终 JSON 为 stdout 末尾唯一顶层对象（收集层合并行为致无法完全纯净，消费方按边界截取）                                                                   |
| 中\* | eval 代码作为裸 shell 参数传递时被破坏（正则 `$)` 等）；后续发现更深层的 **agent-browser CLI→daemon 传输层破坏 `$` 字符**（`-b`/参数/`--stdin` 均受影响，沙箱 0.36.0 实测） | eval 表达式含 `$` 即报 `Unexpected token`                                                                                     | v2：`execSync('agent-browser eval --stdin', { input: code })` 直传 + **eval 代码内禁用 `$ 字符**（正则改 `split('/').includes()` 等写法）；stdin 模式返回标准 JSON 序列化，单次 `JSON.parse` |

\* 修复过程中新发现，非 T53.5 首次审计项。

### 修复验证（v2 = `rpaver_02683e116dae43d6ba4a`，2026-09-15）

| 验证                                               | 结果                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 沙箱全新执行（limit=3）                            | 通过：step1 发现列表 → step2 提取 20 链接取 3 → step3 补齐 → step4 输出；checkpoint `{"step":3}`，data 1425B |
| 同 checkpoint 复跑（skip 语义）                    | 通过：`skip step 1/2/3` 全部从 data 恢复零重放，**step 4 仍输出完整 JSON 且 3 篇一致**，exit 0               |
| 正式回放 `rparun_36c615b26be94159ba7a`（limit=10） | 通过：succeeded / exit 0 / repair 0 / tokens 0；10 篇字段完整、ID 降序，与 v1 回放逐项一致                   |

### 改进方向（app-builder 模板，已沉淀）

模板已更新至 [`skills/app-builder/SKILL.md`](./skills/app-builder/SKILL.md)（契约 9-13）：中间产物持久化、输出步骤永远执行、URL 参数派生、eval 用 stdin 且禁 `$`、stdout 纯净。
