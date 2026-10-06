# V2 Session Skills

本文是当前 V2 Session Skill Overlay 的接口与端到端测试规范。它只描述当前实现，旧 V1 的 `/session/...`、`/skills/create`、`/skills/load`、`/message`、SkillsMP 导入和 `/home/sandbox/.local/share/opencode/session-skills` 资源目录均不在本规范内。

## 1. 范围与当前契约

### 1.1 API 与通用环境

```bash
export BASE=http://localhost:14097
export AUTH="Basic $(printf 'opencode:scan-e2e-pass' | base64)"
export PG_URL=postgresql://local@127.0.0.1:5432/opencode-v2-up
export MODEL_PROVIDER=Yd-DeepSeek
export MODEL_ID=deepseek-v4-flash

api() {
  curl -sS -H "Authorization: $AUTH" -H 'Content-Type: application/json' "$@"
}

new_session() {
  api -X POST "$BASE/api/session" \
    -d "{\"title\":\"$1\",\"location\":{\"directory\":\"/workspace\"}}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])'
}
```

| 项目   | 当前 V2 行为                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 创建   | `POST /api/session/:sessionID/skills`，请求必填 `id`、`content`，可选 `name`、`description`、`autoinvoke`、`resources`。                                                                                                                                                                                                                                                                                                                                                              |
| 列表   | `GET /api/session/:sessionID/skills` 返回 `{data: SessionSkill.Info[]}`；每项为 `{skill, source, sourcePath?, resources}`。这是**有效 overlay**，包含全局 Skill、Sandbox Skill 和 Session 私有 Skill。                                                                                                                                                                                                                                                                                |
| 优先级 | `sandbox > session > global`，按 `skill.id` 覆盖：workspace 的 `SKILL.md` 对执行是权威，session 私有快照只遮蔽全局定义；删除 sandbox 文件并 refresh 后 session 快照生效。                                                                                                                                                                                                                                                                                                             |
| 删除   | `DELETE /api/session/:sessionID/skills/:skillID` 只删除该 Session 的同 ID 快照；`DELETE /api/session/:sessionID/skills` 清空该 Session 的全部私有快照。全局/Sandbox 项仍可出现在有效列表中。                                                                                                                                                                                                                                                                                          |
| 扫描   | `POST /api/session/:sessionID/skills/refresh` 强制扫描 Sandbox 的 `/workspace/.opencode/skill/` 与 `/workspace/.opencode/skills/`。发现布局对齐 upstream `{*.md, **/SKILL.md}`：前缀下第一层的 `.md` 与第二层起的 `SKILL.md` 是 Skill，`references/guide.md` 等参考文档不是 Skill，也不占用 200 个定义的读取额度。普通 list 是 best-effort：扫描失败时仍返回全局与 Session 定义；没有已运行 Sandbox 时直接跳过扫描，不触发建箱。扫描缓存按 `sessionID + sandboxID` 隔离物理沙箱代际。 |
| Prompt | `POST /api/session/:sessionID/prompt_stream`。模型引用为 `{ "providerID": "…", "id": "…" }`；`skills` 为 `[{"id":"…"}]`。显式 attachment 的资源物化失败时整条 prompt 拒绝 admission（HTTP 400 `Session.AttachmentError`），不注入不完整指令，也不写 inbox。                                                                                                                                                                                                                           |
| 持久化 | 私有快照保存在 PostgreSQL `session_skills`；`resources` 原文保存在该表 JSON 字段（text 列，读取需 JSON.parse），API 只返回 metadata。                                                                                                                                                                                                                                                                                                                                                 |

### 1.2 数据模型与限制

`SessionSkill.Payload` 的 `resources` 每项为 `{path,type,content}`，`type` 为 `doc`、`script`、`template` 或 `asset`。响应中的 resource 只包含：

```json
{ "path": "references/check.md", "type": "doc", "size": 18, "digest": "<sha256>" }
```

当前限制（以 `packages/schema/src/session-skill.ts` 为准）：

| 规则                    |                                                                                                                                                                                                                     值 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: |
| 单 resource             |                                                                                                                                                                                                262144 bytes（256 KiB） |
| 单 Skill resources 总量 |                                                                                                                                                                                                 1048576 bytes（1 MiB） |
| resource 数量           |                                                                                                                                                                                                                     64 |
| resource 路径           |                                                                                                                                               相对 POSIX 路径；拒绝绝对路径、反斜杠、空段、`.`、`..`、重复路径和 NUL。 |
| 保留路径                | `SKILL.md`、`resources.json` 及其二者的子路径（如 `SKILL.md/nested`）被拒绝；同一 Skill 内文件与目录前缀冲突（`scripts/run.sh` 与 `scripts/run.sh/child`）被拒绝。均返回 400 `SessionSkillResourceError`，无部分写入。 |
| Skill `id`              |                                                                                                            当前为任意字符串 Schema；不实施旧版小写/kebab/64 字符限制。该行为必须被回归测试锁定，直到产品另行收紧契约。 |

### 1.3 资源物化协议（当前实现）

`source="session"` 且带 resources 的 Skill 在加载时物化到 `/home/sandbox/.local/share/opencode/session-skills/<ownerID>/<skillID>/<snapshot>`。目录根路径与层级对齐 V1。snapshot 覆盖正文及按路径排序的资源路径和内容摘要。不同技能由 skillID 层级隔离。不能安全作为路径段的技能 ID 使用 `~<ID 的 SHA-256>`，不改变 API 中的原始 ID。

1. 写入顺序是完成协议：先写 `SKILL.md` 与全部资源（并发 8），**全部成功后**才写 `resources.json` 完成标记；任何资源写失败则不发布标记，后续加载完整重建。
2. `resources.json` 为版本化完成记录：`{version: 2, id, contentDigest, resources: [path/type/size/digest]}`，不含资源正文。
3. 热加载先核对标记、正文摘要与每个资源的摘要；缺文件、旧版标记、同尺寸损坏都触发修复写回，不信任标记本身。
4. 物化消费查找（`get`/`create`）时捕获的定义快照；此后同 ID upsert 不会让旧正文配新资源。
5. 模型上下文准备阶段只自动恢复当前 agent/session 策略明确 `allow` 的资源型 Skill；`ask`/`deny` 等待显式加载时再授权物化。
6. Sandbox 重建（kill-sandbox 后）按上述协议重新物化；仅 `source="session"` 物化，Sandbox Skill 自有文件，global Skill 走 host-side `Skill.prepare`。

### 1.4 脚本执行契约

- 借鉴 V1：脚本资源先写入会话沙箱，加载技能不自动执行脚本。模型依据技能正文，通过 `shell` 按需执行。
- 对包含 `script` 资源且已物化的技能，`skill` tool 返回额外运行指引；纯文档技能不增加此指引。
- 脚本路径以 `resource_directory` 为基准，不以 shell 当前目录为基准；命令中的路径必须正确引用。
- 使用技能指定的解释器，例如 `python3`、`node` 或 `bash`。不假设资源具有可执行位，不为运行脚本擅自执行 `chmod`。
- 加载授权不等于执行授权：shell 仍独立检查权限。检查退出状态与要求的输出或产物后，才能报告成功。
- 本次不增加后台执行能力、不自动安装依赖、不改变物化文件权限，也不改变 `sandbox > session > global` 优先级。

## 2. API 与 PostgreSQL 用例

### T15.1 创建简单私有 Skill

```bash
SID=$(new_session session-skill-create)
api -X POST "$BASE/api/session/$SID/skills" -d '{
  "id":"reviewer","description":"检查除零问题", "content":"# Reviewer\n回复 REVIEWER_OK"
}' | python3 -m json.tool
```

**断言**：HTTP 200；`source="session"`；`skill.id="reviewer"`；`resources=[]`；未传 `name` 时返回的名称为 `reviewer`。

### T15.2 Bundle metadata 不泄漏正文

```bash
SID=$(new_session session-skill-bundle)
api -X POST "$BASE/api/session/$SID/skills" -d '{
  "id":"complex-reviewer", "description":"数据库审查", "content":"# Complex Reviewer",
  "resources":[
    {"path":"references/check.md","type":"doc","content":"SQL injection is HIGH"},
    {"path":"templates/safe.py","type":"template","content":"query = ?"}
  ]
}' >/dev/null
api "$BASE/api/session/$SID/skills" | python3 -c '
import json,sys
x=next(x for x in json.load(sys.stdin)["data"] if x["skill"]["id"]=="complex-reviewer")
assert [r["path"] for r in x["resources"]] == ["references/check.md","templates/safe.py"]
assert all(set(r)=={"path","type","size","digest"} for r in x["resources"])
print("metadata-only OK")'
psql "$PG_URL" -Atc "SELECT skill_id, jsonb_array_length(resources::jsonb) FROM session_skills WHERE session_id='$SID';"
```

**断言**：API 不含 `content`；digest 为 64 位 SHA-256；PG 保存两个 resources 的完整 JSON 原文。

### T15.3 Upsert、删除和 clear 的 overlay 语义

```bash
SID=$(new_session session-skill-mutate)
api -X POST "$BASE/api/session/$SID/skills" -d '{"id":"checker","description":"v1","content":"V1","resources":[{"path":"a.md","type":"doc","content":"a"}]}' >/dev/null
api -X POST "$BASE/api/session/$SID/skills" -d '{"id":"checker","description":"v2","content":"V2","resources":[{"path":"b.md","type":"doc","content":"b"},{"path":"c.md","type":"doc","content":"c"}]}' >/dev/null
api "$BASE/api/session/$SID/skills" | python3 -c '
import json,sys
x=next(x for x in json.load(sys.stdin)["data"] if x["skill"]["id"]=="checker")
assert x["skill"]["description"]=="v2" and len(x["resources"])==2
print("upsert OK")'
api -o /dev/null -w 'delete=%{http_code}\n' -X DELETE "$BASE/api/session/$SID/skills/checker"
api -o /dev/null -w 'clear=%{http_code}\n' -X DELETE "$BASE/api/session/$SID/skills"
```

**断言**：同 Session+ID 最终只有一条 `session_skills` 记录；两个 DELETE 都是 204。clear 后有效列表可能仍有 global/Sandbox 项，不能断言为 `[]`。

### T15.4 并发、隔离和级联删除

```bash
SID=$(new_session session-skill-race)
for i in 1 2 3 4 5; do
  api -X POST "$BASE/api/session/$SID/skills" -d "{\"id\":\"race-skill\",\"description\":\"v$i\",\"content\":\"# v$i\"}" >/dev/null &
done
wait
psql "$PG_URL" -Atc "SELECT count(*) FROM session_skills WHERE session_id='$SID' AND skill_id='race-skill';"

A=$(new_session session-skill-isolation-a)
B=$(new_session session-skill-isolation-b)
api -X POST "$BASE/api/session/$A/skills" -d '{"id":"private-skill","content":"# A only"}' >/dev/null
api "$BASE/api/session/$A/skills" | grep -q private-skill
! api "$BASE/api/session/$B/skills" | grep -q private-skill

C=$(new_session session-skill-cascade)
api -X POST "$BASE/api/session/$C/skills" -d '{"id":"a","content":"# A"}' >/dev/null
api -X POST "$BASE/api/session/$C/skills" -d '{"id":"b","content":"# B"}' >/dev/null
psql "$PG_URL" -Atc "SELECT count(*) FROM session_skills WHERE session_id='$C';" # 2
api -o /dev/null -w 'delete-session=%{http_code}\n' -X DELETE "$BASE/api/session/$C"
psql "$PG_URL" -Atc "SELECT count(*) FROM session_skills WHERE session_id='$C';" # 0
```

**断言**：并发后 count=1；私有定义不跨 Session 可见；删除 Session 后快照 count=0。

### T15.5 资源校验、编码与当前 ID 契约

```bash
SID=$(new_session session-skill-validation)
python3 - <<'PY' >/tmp/session-skill-large.json
import json
print(json.dumps({"id":"large","content":"# x","resources":[{"path":"big.md","type":"doc","content":"x"*262145}]}))
PY
api -o /tmp/large-response.json -w 'large=%{http_code}\n' -X POST "$BASE/api/session/$SID/skills" --data-binary @/tmp/session-skill-large.json

python3 - <<'PY' >/tmp/session-skill-many.json
import json
print(json.dumps({"id":"many","content":"# x","resources":[{"path":f"r/{i}.md","type":"doc","content":"x"} for i in range(65)]}))
PY
api -o /tmp/many-response.json -w 'many=%{http_code}\n' -X POST "$BASE/api/session/$SID/skills" --data-binary @/tmp/session-skill-many.json

api -o /tmp/path-response.json -w 'path=%{http_code}\n' -X POST "$BASE/api/session/$SID/skills" \
  -d '{"id":"bad-path","content":"# x","resources":[{"path":"../secret","type":"doc","content":"x"}]}'
api -X POST "$BASE/api/session/$SID/skills" -d '{
  "id":"encoding", "content":"# Encoding",
  "resources":[{"path":"unicode.md","type":"doc","content":"中文 🎉 日本語\\n<tag>"},{"path":"binary.bin","type":"asset","content":"\u0000\u0001binary"}]}' \
  | python3 -c 'import json,sys; print([r["path"] for r in json.load(sys.stdin)["resources"]])'
```

**断言**：前三个请求均为 400 且没有部分写入；保留路径 `SKILL.md`、`resources.json`、`SKILL.md/nested`、`resources.json/nested` 与文件/目录冲突（`scripts/run.sh` + `scripts/run.sh/child`）均 400 且无部分写入；Unicode resource 的 metadata 正常；当前实现会**保留**带 NUL 的 content，不应沿用“跳过二进制 resource”的旧断言。另以空 ID、Unicode、空格、斜杠和超长 ID 建立回归：当前均可创建，这是已记录的当前契约而非校验成功。

## 3. Sandbox 定义扫描与 Overlay

### T15.6 Sandbox Skill 的发现、刷新和优先级

fixture 通过 V2 Sandbox 命令路径（`/api/session/:sessionID/shell`）写入，不可用 `docker exec` 绕过产品路径：

```text
mkdir -p /workspace/.opencode/skills/sandbox-demo/references
cat > /workspace/.opencode/skills/sandbox-demo/SKILL.md <<'EOF'
---
name: Sandbox Demo
description: Sandbox source
---
# Sandbox Demo
EOF
cat > /workspace/.opencode/skills/sandbox-demo/references/guide.md <<'EOF'
---
description: reference only
---
REFERENCE
EOF
cat > /workspace/.opencode/skills/flat.md <<'EOF'
---
description: flat skill
---
# Flat
EOF
```

随后：

```bash
api -X POST "$BASE/api/session/$SID/skills/refresh" | python3 -c '
import json,sys
data=json.load(sys.stdin)["data"]
ids=[x["skill"]["id"] for x in data if x["source"]=="sandbox"]
assert "sandbox-demo" in ids and "flat" in ids and "guide" not in ids
x=next(x for x in data if x["skill"]["id"]=="sandbox-demo")
assert x["sourcePath"]=="sandbox-demo/SKILL.md"
print("sandbox discovery OK")'
```

**断言**：发现布局为 `{*.md, **/SKILL.md}`——第一层 `flat.md` 与 `sandbox-demo/SKILL.md` 被发现，`sandbox-demo/references/guide.md` 不提升为 Skill。再以 `POST /skills` 创建同 ID 的私有版本；按 `sandbox > session > global`，sandbox 文件存在时 list 中该 ID 仍为 `source="sandbox"`，session 快照被遮蔽。删除 sandbox 的 `SKILL.md` 并 refresh 后，该 ID 回落为 `source="session"`。若存在同 ID global Skill，也会被 Sandbox 版本覆盖。

### T15.7 list 降级与 refresh 失败

使用不可连接的 Sandbox endpoint 或临时失效的 Sandbox，分别验证：

1. `GET /skills` 不因 discovery 失败而失败，仍返回 global/Session 项；
2. `POST /skills/refresh` 返回显式错误；
3. Sandbox 恢复后 refresh 能重新返回 discovered 项；
4. 删除或修改 `SKILL.md` 后 refresh 移除或更新有效项。

这是扫描模块的错误语义；不要将 list 的 best-effort 行为误判为“没有 Sandbox Skill”。

## 4. Prompt、tool 与资源物化

### T15.8 显式 Skill attachment

```bash
SID=$(new_session session-skill-attachment)
api -X POST "$BASE/api/session/$SID/skills" -d '{"id":"reviewer","content":"# Reviewer\n只回复 REVIEWER_OK"}' >/dev/null
api --no-buffer -X POST "$BASE/api/session/$SID/prompt_stream" -d "{
  \"text\":\"使用 reviewer\",\"skills\":[{\"id\":\"reviewer\"}],\"metadata\":{},\"delivery\":\"queue\",
  \"model\":{\"providerID\":\"$MODEL_PROVIDER\",\"id\":\"$MODEL_ID\"}
}" | grep -q REVIEWER_OK
```

**断言**：显式 attachment 能解析 Session Overlay 的 Skill 并驱动模型。当前实现会将该 Skill 的完整指令附加到该 prompt；它不是旧版 `preloaded_skills` manifest，也不自动物化 resources。不存在的 attachment 返回 HTTP 400 `Skill not found`；真实 ID 与不存在 ID 混用也返回 400。

### T15.9 显式 Session Skill 激活

V2 另有不依赖 prompt attachment 的显式激活接口：

```bash
SID=$(new_session session-skill-activate)
api -X POST "$BASE/api/session/$SID/skills" -d '{"id":"activate-me","content":"# Activate\n回复 ACTIVATED"}' >/dev/null
api -o /dev/null -w 'activate=%{http_code}\n' \
  -X POST "$BASE/api/experimental/session/$SID/skill" \
  -d '{"id":"activate-me","resume":true}'
```

**断言**：成功为 204；不存在的 ID 为 `SkillNotFoundError`；Session 私有 Skill 与 Sandbox/global 同 ID 时解析到 overlay 的最高优先级版本。该路径写入 Session Skill 激活事件，与 `prompt_stream` attachment 和 tool 调用是三个不同的入口，应分别回归。

### T15.10 模型自主调用 `skill` tool

创建带 resource 的 Skill，且不要在 prompt 请求中传 `skills`：

```json
{
  "id": "resource-check",
  "description": "必须先加载后回答",
  "content": "# Resource Check\n先调用 skill 工具，然后回复 RESOURCE_SKILL_OK。",
  "resources": [{ "path": "checklist.md", "type": "doc", "content": "SECRET_RESOURCE_TEXT_123" }]
}
```

提示模型“使用 resource-check skill tool 后回复标记”。SSE 必须出现：

```text
session.tool.input.ended  {"id":"resource-check"}
session.tool.success
session.text.ended        RESOURCE_SKILL_OK
```

**断言**：tool 输入字段为 `id`；tool content 有 Skill 指令、`<resource_directory>`、`<file>checklist.md</file>` 和 `<resources>` 元数据（path/type/size/digest）；不含 `SECRET_RESOURCE_TEXT_123`。模型自主选择 tool 受模型行为影响，测试提示必须明确要求调用，不能把“模型未选择 tool”当成接口失败。

### T15.11 资源物化、读取和重建

对 T15.10 的 tool success 中的 `resource_directory`：

1. 路径必须是 `/home/sandbox/.local/share/opencode/session-skills/<ownerID>/<skillID>/<snapshot>`。snapshot 与 V1 算法一致：正文及按路径排序的资源路径和内容摘要。特殊 ID 使用安全摘要段；
2. 通过 V2 sandbox 文件 API 读取时传相对 workspace 的 `.opencode/.../checklist.md`，正文必须为 `SECRET_RESOURCE_TEXT_123`；
3. 同一目录还必须有 `SKILL.md` 与 `resources.json`；后者为 `{version:2, id, contentDigest, resources:[metadata]}`，不能含 resource 正文；
4. `GET /skills` 与 tool success 不得泄漏 resource 正文；
5. 将资源文件改为同尺寸损坏内容后再次加载，必须修复为原始正文，而不是信任已有标记；
6. `POST /api/session/:sessionID/kill-sandbox` 后，模型再次调用该 Skill；同一内容快照须可重新物化并读取。自动恢复只覆盖策略明确 allow 的 Skill；ask/deny Skill 等待显式加载。

大型脚本回归使用 120000 字节的 `scripts/large.mjs`（低于 256KiB 限制），内容输出 `LARGE_SCRIPT_OK`。第一次执行、kill-sandbox、第二次执行均应得到该标记。

泄漏判定必须区分工具：`skill` tool 的输出不能含资源正文；但模型随后用 `read`/`bash` 读取物化文件时，这些工具的输出本就会回显资源正文，不属泄漏。

**当前边界**：仅 `source="session"` 且有 resources 的 Skill 会物化；Sandbox Skill 自己拥有其 Sandbox 文件，global Skill 走 host-side `Skill.prepare`。`resource_directory` 当前位于 workspace 下，因此不应断言旧版隐藏 home 路径。Session 私有 Skill 的 `skill` tool 输出不再声明虚拟 `/session/...` 基目录：有物化目录时声明该目录，无 resources 时不声明基目录。

### T15.11r 物化失败拒绝 admission

制造资源写入冲突（如预先把资源路径占位为目录），随后以显式 attachment 发起 prompt：

**断言**：HTTP 400 `Session.AttachmentError`；`session_inbox` 无新增行；目标目录没有 `resources.json` 完成标记；解除冲突后同一请求成功，正文指向实际物化目录。失败不得被降级为“只注入指令不带资源”。

### T15.12 guidance、权限与 tool 失败

1. 模型上下文中的 Skill guidance 应由有效 overlay 生成，具有 description 且 `autoinvoke !== false` 的 Skill 才会出现；
2. Skill tool 仍经过当前 Session 的 Permission 服务授权，deny 是**目录级**语义：`skill` action 被 deny 时工具从模型工具目录整体移除（模型不可见、无法调用）；目录仍可见时的调用授权由 `Permission.assert` 在 overlay 解析与 Sandbox 扫描**之前**断言。拒绝行为通过当前 Permission API/策略建立，不使用旧 Session-create 内嵌 permission payload；
3. tool 未找到 ID 时应返回 Skill 未找到错误；
4. Skill tool 只对成功授权后的 Session 私有 resource 进行物化；
5. CodeMode 执行链路（默认 code-mode 下的 `execute`）在 Runner 冷启动时由启动方等待端口就绪，首次执行不得依赖失败重试。

### T15.13 沙箱技能文件清单

通过 Session shell API 在 `/workspace/.opencode/skills/sandbox-files/` 写入 `SKILL.md`、`references/guide.md` 和 `scripts/probe.mjs`，再提示模型必须调用 `skill` tool 加载 `sandbox-files`。

**断言**：成功 tool output 的 `<skill_files>` 含相对路径 `references/guide.md` 与 `scripts/probe.mjs`，不含 `SKILL.md`、目录项或其他技能目录文件；清单只列路径，不泄漏附属文件正文。该用例验证模型可发现 sandbox 技能文件，而不只验证它们物理存在。

## 5. 覆盖矩阵与非目标

| 实现点                                   | 覆盖用例               |
| ---------------------------------------- | ---------------------- |
| Schema、response metadata、PG 原文       | T15.1、T15.2、T15.5    |
| session/global/sandbox overlay 与 source | T15.3、T15.4、T15.6    |
| 扫描缓存、refresh、故障降级              | T15.6、T15.7           |
| Prompt attachment、显式激活与模型选择    | T15.8、T15.9、T15.10   |
| tool 授权、物化、无正文泄漏、资源清单      | T15.10、T15.11、T15.12、T15.13 |
| Sandbox 重建恢复                         | T15.11                 |
| upsert、并发、隔离、级联                 | T15.3、T15.4           |
| 输入边界与现有 ID 兼容性                 | T15.5                  |

当前非目标，若要支持必须先新增产品需求与实现：

- 从服务容器目录导入 bundle；
- SkillsMP/GitHub 拉取、解析和导入；
- `/home/sandbox/.local/share/opencode/session-skills` 隐藏目录；
- 二进制 resource 自动跳过；
- 旧 Session API 的 `name` Skill 标识、名称正则和 `skills[]` 不存在项降级；
- 特定 Sandbox 镜像预装 agent-browser/Chromium 的验收。

## 6. 历史执行依据（2026-09-27，不代表当前代码的全量验收）

环境：Docker `opencode-saas-compose-e2e:local`、PostgreSQL `opencode-v2-up`、本地 OpenSandbox、`Yd-DeepSeek/deepseek-v4-flash`。执行脚本按本规范逐条断言，Sandbox fixture 全部由模型经 shell 工具写入，未使用 `docker exec`。

结果：**T15.1–T15.12 全部通过（13/13，含 T15.7 故障注入）**。

该历史记录在 T15.10 只检查资源目录和正文不泄漏，未检查模型可见的资源/文件清单；不能作为 T15.10 新增断言或 T15.13 已通过的证据。

| 用例    | 结果 | 关键依据                                                                                                                                                                                         |
| ------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T15.1   | ✅   | 创建 200、`source=session`、未传 `name` 时回落为 `id`、`resources=[]`、PG 有行                                                                                                                   |
| T15.2   | ✅   | 两个资源只返回 `path/type/size/digest`（digest 64 位），PG 保存 content 原文                                                                                                                     |
| T15.3   | ✅   | 同 ID upsert 后 PG 仅 1 行、description 为 `v2`、resources 为 2；删除与 clear 均 204，clear 后 PG 0 行                                                                                           |
| T15.4   | ✅   | 5 并发后 PG 1 行；私有 Skill 不跨 Session；删除 Session 后 2 行→0 行                                                                                                                             |
| T15.5   | ✅   | 262145B/65 个/总量超 1MiB 与 5 类非法路径均 400 且无部分写入；262144B 与 64 个为 200；Unicode 正常；NUL 资源被保留；空/路径/空格/中文/大小写/300 字符 ID 当前均 200                              |
| T15.6   | ✅   | `.opencode/skills` 与 `.opencode/skill` 均发现为 `sandbox`；同名 session 覆盖为 `session`，删除后回落 `sandbox`；改内容 refresh 更新名称；删除文件 refresh 移除                                  |
| T15.7   | ✅   | Sandbox 域名不可达时 list 仍 200 且保留 Session 项，refresh 返回 500；恢复连接后由模型写入 `SKILL.md`，refresh 200 并发现 `recovered: sandbox`，Session 项仍在                                   |
| T15.8   | ✅   | attachment 200 且模型输出 `REVIEWER_OK`；不存在 ID 与混合 ID 均 400                                                                                                                              |
| T15.9   | ✅   | 激活 204、不存在 404 `SkillNotFoundError`、context 出现激活消息、global 同名可被 session 覆盖后激活 204                                                                                          |
| T15.10  | ✅   | tool 输入 `{"id":"resource-check"}`、tool content 含 `<resource_directory>`、不含资源正文                                                                                                        |
| T15.11  | ✅   | 目录为 `/workspace/.opencode/.session-skills/<sid>/<digest>`；`SKILL.md`/`resources.json`/资源均可读；`resources.json` 与 list 均无正文；kill-sandbox 后 120KiB 脚本两次执行均 `LARGE_SCRIPT_OK` |
| T15.11r | ✅   | `skill` tool 输出不含 120KB 正文；`read` 工具回显属读取行为，不计为泄漏                                                                                                                          |
| T15.12  | ✅   | guidance 正常发出；`autoinvoke:false` 的 Skill 仍可显式加载且不声明虚拟 `/session/` 基目录；未知 ID 由 tool 报告无法加载                                                                         |

### 本轮修复的缺陷

T15.12 曾暴露一个真实缺陷：Session 私有 Skill 的 `path` 是虚拟路径 `/session/<sid>/skills/<id>`，`Skill.toModelOutput` 把它当作基目录输出，模型因此认为技能内容为空。修复后：

- `packages/core/src/skill.ts`：`toModelOutput` 增加 `directory` 覆盖参数，传 `null` 时不输出 Base directory。
- `packages/core/src/tool/plugin/skill.ts`：Session 私有 Skill 有物化目录时声明该目录，无 resources 时不声明；`Output.directory` 变为可选。
- `packages/core/src/session/prompt.ts`：非 global Skill 在 prompt 阶段物化 Session 私有资源并把基目录指向物化目录。

T15.7 通过把 `OPENCODE_SANDBOX_DOMAIN` 指向不可达域名构造端点故障，确认 list 降级为 200 且不丢 Session 项，refresh 显式失败为 500；恢复为可达域名后 refresh 重新发现 Sandbox Skill。四个断言全部覆盖。

### 环境清理

执行后已删除各测试容器；本轮故障注入用例产生的 2 条 `session_skills` 记录因 Session 未删除而残留，后续复跑前应按 Session 清理，避免历史数据影响隔离类断言。

## 7. 目录对齐前的 API 验收（2026-10-04，历史记录）

执行器：`docs/test-cases/scripts/session-skills-contract-v2.mjs`。SaaS 服务在专用 Docker 容器运行。每轮使用独立 PostgreSQL 数据库。沙箱由远端 OpenSandbox 提供。

| 模式     | 用例结果                               | PG 清理结果                                                                 | 证据目录                                                                     |
| -------- | -------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| PVC      | T15.1–T15.12（含 T15.11r），13/13 通过 | Session、inbox、skills 均为 0；15 条 sandbox 记录均为 destroyed；无清理错误 | `../sandbox/store/evidence/skills-contract-pvc-1791121978799-49714959/`      |
| snapshot | T15.1–T15.12（含 T15.11r），13/13 通过 | Session、inbox、skills 均为 0；15 条 sandbox 记录均为 destroyed；无清理错误 | `../sandbox/store/evidence/skills-contract-snapshot-1791122333974-adcc97a4/` |

T15.11 不以模型回复标记作为唯一依据。执行器检查指定 skill 调用的成功输出、脚本运行指引、shell 工具输出和随机校验产物。执行器在 kill-sandbox 后重新触发物化，再执行脚本并检查新产物。

每个成功进入执行的 prompt 保存原始 SSE 事件。工具调用通过 `data.id` 关联。技能调用进一步按输入中的技能 ID 筛选，避免混淆同一次执行内的多个 skill 调用。

补充回归：core 隔离内存数据库 92 项通过；技能相关 PG 单测 21 项通过；server 测试 1 项通过；事件关联测试 2 项通过。这些数量来自不同运行，不汇总为同一套全量测试数量。

边界：本轮清理证据只覆盖对应执行器创建的会话与沙箱。它不证明历史失败轮次的资源全部清理。本轮技能脚本通过原生 `shell` 工具执行，不能据此宣称覆盖全部 CodeMode Runner 场景。

最终检查：两轮记录的源码 SHA-256 均匹配目录对齐前的验收文件。两轮 SaaS 测试容器均不再运行。各轮 PG 中非 `creating-` 的 7 条沙箱记录均有对应的 OpenSandbox DELETE 204 请求记录。该轮测试专用 TCP 转发进程已停止。

## 8. V1 资源目录对齐后的验收（2026-10-04）

- 根目录、普通技能 ID 层级和 snapshot 算法对齐 V1。资源顺序变化不改变目录。
- 保留 V2 的完成标记最后写入、全文摘要核验、损坏修复、资源快照绑定和权限前置。
- 原生 `read` 允许读取当前资源 owner 的技能目录。其他 owner、相似前缀和路径穿越仍被拒绝。读权限仍在实际文件访问前检查。
- 子会话使用主会话资源 owner。历史 fork 使用独立资源 owner。
- 不迁移或删除旧物化目录。下次加载在新目录物化，工具返回新 `resource_directory`。
- 本次不改 SKILL.md 格式、不统一 chmod、不新增后台执行。
- T15.11 新增原生 read 读取脚本正文断言，并在沙箱重建前后检查 shell 输出与随机产物。

| 模式              | 用例结果                                                            | PG 清理结果                                                                          | 证据目录                                                                     |
| ----------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| PVC               | 13/13 通过                                                          | Session、inbox、skills 均为 0；15 条 sandbox 记录均为 destroyed；无清理错误          | `../sandbox/store/evidence/skills-contract-pvc-1791124157038-ebd0a77c/`      |
| snapshot，第 2 轮 | T15.1–T15.10 通过；T15.11 脚本写入 `/workspace` 返回 ENOENT，不通过 | Session、inbox、skills 为 0；11 条 sandbox 记录 destroyed，1 条 creating；清理不通过 | `../sandbox/store/evidence/skills-contract-snapshot-1791124509862-00699db7/` |
| snapshot，第 3 轮 | 13/13 通过，包含 `/workspace` 写入预检                              | Session、inbox、skills 均为 0；15 条 sandbox 记录均为 destroyed；无清理错误          | `../sandbox/store/evidence/skills-contract-snapshot-1791124917774-f7beb2d6/` |

补充回归：core 隔离数据库 117 项通过，PG 技能相关单测 25 项通过，core 类型检查与修改文件 lint 通过。目录对齐前的第 7 节仅保留为历史依据。

第 2 轮 snapshot 的失败证据：V1 目录下的技能加载和原生 read 均成功。node 与 shell 均无法在 `/workspace` 新建文件，但能够列出该目录。完整平台请求记录包含 23 次建箱 POST 504；第 3 轮成功运行也包含 24 次建箱 POST 504，不能仅凭 504 将两者建立因果关系。第 2 轮残留 creating 记录的 Session 已不存在，不能将失败轮次算作清理成功。

第 3 轮增加脚本执行前的 `/workspace` 实际写入预检。验收仍要求产物写入 `/workspace`，不改为其他目录来绕过故障。

creating 残留的确定性诊断：`scripts/sandbox-create-delete-diagnostic-v2.mjs` 经 API 注入创建失败，DELETE 返回 204 后，后台重试再次创建租约。PG 中 Session 数为 0，sandbox 状态为 creating。诊断证据：`../sandbox/store/evidence/opencode-create-delete-diagnostic-1791125436995-d608c8b7/`。此为修复前记录，后续修复见第 9 节。详细分析见 `../sandbox/snapshot-workspace-create-delete-investigation-2026-10-04.md`。

## 9. 创建栅栏与工作目录就绪修复（2026-10-04）

用户确认后，claim、complete 和 booted 增加现有 Session 生命周期栅栏检查。工作目录在 running 发布前需要通过实际写入、读取、删除临时文件检查。恢复或挂载的目录不会被重新创建。就绪失败不自动冷启动，补偿路径保留已归属的代际及恢复点保护。

- 删除重试 API 回归：修复前失败，修复后通过。
- 真实沙箱就绪命令失败注入：通过，无 running 发布、无自动重建、补偿 DELETE 204、PG 清理通过。
- 第 8 节第 2 轮的 creating 残留已通过现有 GC 收敛，原始失败记录保留。
- 修复后 PVC 全量 API 13/13 通过：`../sandbox/store/evidence/skills-contract-pvc-1791126974713-d86e7a8a/`。Session、inbox、skills 均为 0，15 条 sandbox 均为 destroyed，清理错误为 0。
- 修复后 snapshot 全量 API 13/13 通过：`../sandbox/store/evidence/skills-contract-snapshot-1791127499021-da0e68b0/`。Session、inbox、skills 均为 0，15 条 sandbox 均为 destroyed，清理错误为 0；生产源码摘要与当前文件一致。

证据和边界见 `../sandbox/snapshot-workspace-create-delete-investigation-2026-10-04.md`。

## 10. 模型可见资源/文件清单修复后的验收（2026-10-05）

### 修复内容

此前 Session/sandbox 分支向 `Skill.toModelOutput` 传空文件列表且不传资源元数据，模型看到的 `<skill_files>` 恒为空、`<resources>` 缺失；本规范与 `docs/session-skill-resources.md` 对模型可见清单的要求不一致。修复：

- `packages/core/src/skill.ts`：`toModelOutput` 新增 `resources` 参数，渲染 `<resources>` 元数据（path/type/size/digest），`<file>` 与属性值做 XML 转义；不输出资源正文。
- `packages/core/src/session/skills.ts`：新增 `files` 服务。Session 技能取持久化资源路径（上限 10）；sandbox 技能经 `fileFind` 采样目录相对路径（排除 `SKILL.md`、排序、上限 10）。
- `packages/core/src/tool/plugin/skill.ts`、`packages/core/src/session/prompt.ts`：skill tool 输出与显式附件均注入清单。

物化目录规则不受影响：root、snapshot 算法、skillID 段与 V1（`feat/opencode-1.18.31`）逐字节一致，单测以 V1 原始算法为基准锁定（`ssk_`+base64url id、localeCompare 排序）；非法 id 的 `~sha256` 段与子会话 owner 目录为既有 V2 语义，见第 8 节。

### 用例更新

- T15.10 断言增加：tool content 含 `<file>checklist.md</file>` 与完整 `<resource path type size digest />` 元数据。
- 新增 T15.13：沙箱技能 `<skill_files>` 必须列出相对路径 `references/guide.md`、`scripts/probe.mjs`，不含 `SKILL.md`，不泄漏附属文件正文。
- `answer-me-with-html` T51.5 增加：显式附件 `<skill_files>` 列出 `scripts/am.mjs`。

### 验收结果（PVC，`Yd-GLM/glm-5.3-flash`）

| 用例结果 | PG 清理结果 | 证据目录 |
| --- | --- | --- |
| T15.1–T15.13（含 T15.11r），14/14 通过 | Session、inbox、skills 均为 0；15 条 sandbox 均为 destroyed；无清理错误 | `../sandbox/store/evidence/skills-contract-pvc-1791166704258-62fcade4/` |

- 源码 SHA-256 与验收时工作区一致（本轮未再改动 src）。T15.10 证据含真实物化路径 `/home/sandbox/.local/share/opencode/session-skills/<sid>/resource-check/<snapshot>`；T15.13 证据含采样的两个相对路径。
- 单测：core 技能相关定向 40 项通过（含 V1 目录 oracle 逐字节一致、非法 id 安全段）；类型检查、定向 lint 通过。
- 环境注记：上一轮（`skills-contract-pvc-1791166395411-5fa91fb1`）在 T15.6 超时，根因是测试代理 `PROBE_UPSTREAM` 指向需 API key 的平台端点导致 `/v1/sandboxes` 持续 401，属环境配置而非产品缺陷；本轮改用本机 OpenSandbox 端点后全通过。

### 执行器清理缺陷修复（2026-10-05）

三个 Docker/API 执行器（`session-skills-contract-v2.mjs`、`session-skills-safety-v2.mjs`、`sandbox-lifecycle-safety-v2.mjs`）的 finally 块均不 DROP 专用数据库，长期遗留 `opencode-v2-skills-contract-*`、`opencode-v2-skills-test-*`、`opencode-v2-lifecycle-test-*` 库。已补齐：contract/safety 无条件 DROP 并把失败计入清理结果；lifecycle 仅在通过时 DROP（失败保留 PG 取证为其既有设计）。历史遗留 72 个专用库与 1 个运行 10 小时的孤儿容器已一次性清理；`opencode-v2-lifecycle-test-20261004` 作为 admin 基库保留。`opencode-v2-create-delete-diagnostic-*` 3 个库非这三脚本所建，未动。
