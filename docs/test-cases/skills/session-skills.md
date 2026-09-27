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

| 项目 | 当前 V2 行为 |
|---|---|
| 创建 | `POST /api/session/:sessionID/skills`，请求必填 `id`、`content`，可选 `name`、`description`、`autoinvoke`、`resources`。 |
| 列表 | `GET /api/session/:sessionID/skills` 返回 `{data: SessionSkill.Info[]}`；每项为 `{skill, source, sourcePath?, resources}`。这是**有效 overlay**，包含全局 Skill、Sandbox Skill 和 Session 私有 Skill。 |
| 优先级 | `session > sandbox > global`，按 `skill.id` 覆盖。 |
| 删除 | `DELETE /api/session/:sessionID/skills/:skillID` 只删除该 Session 的同 ID 快照；`DELETE /api/session/:sessionID/skills` 清空该 Session 的全部私有快照。全局/Sandbox 项仍可出现在有效列表中。 |
| 扫描 | `POST /api/session/:sessionID/skills/refresh` 强制扫描 Sandbox 的 `/workspace/.opencode/skill/` 与 `/workspace/.opencode/skills/`。普通 list 是 best-effort，扫描失败时仍返回全局与 Session 定义。 |
| Prompt | `POST /api/session/:sessionID/prompt_stream`。模型引用为 `{ "providerID": "…", "id": "…" }`；`skills` 为 `[{"id":"…"}]`。 |
| 持久化 | 私有快照保存在 PostgreSQL `session_skills`；`resources` 原文保存在该表 JSON 字段，API 只返回 metadata。 |

### 1.2 数据模型与限制

`SessionSkill.Payload` 的 `resources` 每项为 `{path,type,content}`，`type` 为 `doc`、`script`、`template` 或 `asset`。响应中的 resource 只包含：

```json
{"path":"references/check.md","type":"doc","size":18,"digest":"<sha256>"}
```

当前限制（以 `packages/schema/src/session-skill.ts` 为准）：

| 规则 | 值 |
|---|---:|
| 单 resource | 262144 bytes（256 KiB） |
| 单 Skill resources 总量 | 1048576 bytes（1 MiB） |
| resource 数量 | 64 |
| resource 路径 | 相对 POSIX 路径；拒绝绝对路径、反斜杠、空段、`.`、`..`、重复路径和 NUL。 |
| Skill `id` | 当前为任意字符串 Schema；不实施旧版小写/kebab/64 字符限制。该行为必须被回归测试锁定，直到产品另行收紧契约。 |

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

**断言**：前三个请求均为 400 且没有部分写入；Unicode resource 的 metadata 正常；当前实现会**保留**带 NUL 的 content，不应沿用“跳过二进制 resource”的旧断言。另以空 ID、Unicode、空格、斜杠和超长 ID 建立回归：当前均可创建，这是已记录的当前契约而非校验成功。

## 3. Sandbox 定义扫描与 Overlay

### T15.6 Sandbox Skill 的发现、刷新和优先级

fixture 必须由模型在 `prompt_stream` 内调用 shell 写入，不可用 `docker exec` 绕过产品路径。通过现有 `docs/test-cases/scripts/sandbox-definition-scan-v2.mjs` 的 SSE helper 发送：

```text
mkdir -p /workspace/.opencode/skills/sandbox-demo
cat > /workspace/.opencode/skills/sandbox-demo/SKILL.md <<'EOF'
---
name: Sandbox Demo
description: Sandbox source
---
# Sandbox Demo
EOF
```

随后：

```bash
api -X POST "$BASE/api/session/$SID/skills/refresh" | python3 -c '
import json,sys
x=next(x for x in json.load(sys.stdin)["data"] if x["skill"]["id"]=="sandbox-demo")
assert x["source"]=="sandbox" and x["sourcePath"]=="sandbox-demo/SKILL.md"
print("sandbox discovery OK")'
```

再以 `POST /skills` 创建同 ID 的私有版本；list 中该 ID 必须变为 `source="session"`。删除该私有版本后，Sandbox 版本应恢复。若存在同 ID global Skill，也应被 Sandbox 版本覆盖。

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
  "id":"resource-check",
  "description":"必须先加载后回答",
  "content":"# Resource Check\n先调用 skill 工具，然后回复 RESOURCE_SKILL_OK。",
  "resources":[{"path":"checklist.md","type":"doc","content":"SECRET_RESOURCE_TEXT_123"}]
}
```

提示模型“使用 resource-check skill tool 后回复标记”。SSE 必须出现：

```text
session.tool.input.ended  {"id":"resource-check"}
session.tool.success
session.text.ended        RESOURCE_SKILL_OK
```

**断言**：tool 输入字段为 `id`；tool content 有 Skill 指令和 `<resource_directory>`；不含 `SECRET_RESOURCE_TEXT_123`。模型自主选择 tool 受模型行为影响，测试提示必须明确要求调用，不能把“模型未选择 tool”当成接口失败。

### T15.11 资源物化、读取和重建

对 T15.9 的 tool success 中的 `resource_directory`：

1. 路径必须是 `/workspace/.opencode/.session-skills/<sessionID>/<content-digest>`；
2. 通过 V2 sandbox 文件 API 读取时传相对 workspace 的 `.opencode/.../checklist.md`，正文必须为 `SECRET_RESOURCE_TEXT_123`；
3. 同一目录还必须有 `SKILL.md` 与 `resources.json`；后者仅有 id 和 metadata，不能含 resource 正文；
4. `GET /skills` 与 tool success 不得泄漏 resource 正文；
5. `POST /api/session/:sessionID/kill-sandbox` 后，模型再次调用该 Skill；同一内容快照须可重新物化并读取。

大型脚本回归使用 120000 字节的 `scripts/large.mjs`（低于 256KiB 限制），内容输出 `LARGE_SCRIPT_OK`。第一次执行、kill-sandbox、第二次执行均应得到该标记。

泄漏判定必须区分工具：`skill` tool 的输出不能含资源正文；但模型随后用 `read`/`bash` 读取物化文件时，这些工具的输出本就会回显资源正文，不属泄漏。

**当前边界**：仅 `source="session"` 且有 resources 的 Skill 会物化；Sandbox Skill 自己拥有其 Sandbox 文件，global Skill 走 host-side `Skill.prepare`。`resource_directory` 当前位于 workspace 下，因此不应断言旧版隐藏 home 路径。Session 私有 Skill 的 `skill` tool 输出不再声明虚拟 `/session/...` 基目录：有物化目录时声明该目录，无 resources 时不声明基目录。

### T15.12 guidance、权限与 tool 失败

1. 模型上下文中的 Skill guidance 应由有效 overlay 生成，具有 description 且 `autoinvoke !== false` 的 Skill 才会出现；
2. Skill tool 仍经过当前 Session 的 Permission 服务授权；拒绝行为应通过当前 Permission API/策略建立，不使用旧 Session-create 内嵌 permission payload；
3. tool 未找到 ID 时应返回 Skill 未找到错误；
4. Skill tool 只对成功授权后的 Session 私有 resource 进行物化。

## 5. 覆盖矩阵与非目标

| 实现点 | 覆盖用例 |
|---|---|
| Schema、response metadata、PG 原文 | T15.1、T15.2、T15.5 |
| session/global/sandbox overlay 与 source | T15.3、T15.4、T15.6 |
| 扫描缓存、refresh、故障降级 | T15.6、T15.7 |
| Prompt attachment、显式激活与模型选择 | T15.8、T15.9、T15.10 |
| tool 授权、物化、无正文泄漏 | T15.10、T15.11、T15.12 |
| Sandbox 重建恢复 | T15.11 |
| upsert、并发、隔离、级联 | T15.3、T15.4 |
| 输入边界与现有 ID 兼容性 | T15.5 |

当前非目标，若要支持必须先新增产品需求与实现：

- 从服务容器目录导入 bundle；
- SkillsMP/GitHub 拉取、解析和导入；
- `/home/sandbox/.local/share/opencode/session-skills` 隐藏目录；
- resource metadata 出现在 `skill` tool output；
- 二进制 resource 自动跳过；
- 旧 Session API 的 `name` Skill 标识、名称正则和 `skills[]` 不存在项降级；
- 特定 Sandbox 镜像预装 agent-browser/Chromium 的验收。

## 6. 已执行依据（2026-09-27）

环境：Docker `opencode-saas-compose-e2e:local`、PostgreSQL `opencode-v2-up`、本地 OpenSandbox、`Yd-DeepSeek/deepseek-v4-flash`。执行脚本按本规范逐条断言，Sandbox fixture 全部由模型经 shell 工具写入，未使用 `docker exec`。

结果：**T15.1–T15.12 全部通过（13/13，含 T15.7 故障注入）**。

| 用例 | 结果 | 关键依据 |
|---|---|---|
| T15.1 | ✅ | 创建 200、`source=session`、未传 `name` 时回落为 `id`、`resources=[]`、PG 有行 |
| T15.2 | ✅ | 两个资源只返回 `path/type/size/digest`（digest 64 位），PG 保存 content 原文 |
| T15.3 | ✅ | 同 ID upsert 后 PG 仅 1 行、description 为 `v2`、resources 为 2；删除与 clear 均 204，clear 后 PG 0 行 |
| T15.4 | ✅ | 5 并发后 PG 1 行；私有 Skill 不跨 Session；删除 Session 后 2 行→0 行 |
| T15.5 | ✅ | 262145B/65 个/总量超 1MiB 与 5 类非法路径均 400 且无部分写入；262144B 与 64 个为 200；Unicode 正常；NUL 资源被保留；空/路径/空格/中文/大小写/300 字符 ID 当前均 200 |
| T15.6 | ✅ | `.opencode/skills` 与 `.opencode/skill` 均发现为 `sandbox`；同名 session 覆盖为 `session`，删除后回落 `sandbox`；改内容 refresh 更新名称；删除文件 refresh 移除 |
| T15.7 | ✅ | Sandbox 域名不可达时 list 仍 200 且保留 Session 项，refresh 返回 500；恢复连接后由模型写入 `SKILL.md`，refresh 200 并发现 `recovered: sandbox`，Session 项仍在 |
| T15.8 | ✅ | attachment 200 且模型输出 `REVIEWER_OK`；不存在 ID 与混合 ID 均 400 |
| T15.9 | ✅ | 激活 204、不存在 404 `SkillNotFoundError`、context 出现激活消息、global 同名可被 session 覆盖后激活 204 |
| T15.10 | ✅ | tool 输入 `{"id":"resource-check"}`、tool content 含 `<resource_directory>`、不含资源正文 |
| T15.11 | ✅ | 目录为 `/workspace/.opencode/.session-skills/<sid>/<digest>`；`SKILL.md`/`resources.json`/资源均可读；`resources.json` 与 list 均无正文；kill-sandbox 后 120KiB 脚本两次执行均 `LARGE_SCRIPT_OK` |
| T15.11r | ✅ | `skill` tool 输出不含 120KB 正文；`read` 工具回显属读取行为，不计为泄漏 |
| T15.12 | ✅ | guidance 正常发出；`autoinvoke:false` 的 Skill 仍可显式加载且不声明虚拟 `/session/` 基目录；未知 ID 由 tool 报告无法加载 |

### 本轮修复的缺陷

T15.12 曾暴露一个真实缺陷：Session 私有 Skill 的 `path` 是虚拟路径 `/session/<sid>/skills/<id>`，`Skill.toModelOutput` 把它当作基目录输出，模型因此认为技能内容为空。修复后：

- `packages/core/src/skill.ts`：`toModelOutput` 增加 `directory` 覆盖参数，传 `null` 时不输出 Base directory。
- `packages/core/src/tool/plugin/skill.ts`：Session 私有 Skill 有物化目录时声明该目录，无 resources 时不声明；`Output.directory` 变为可选。
- `packages/core/src/session/prompt.ts`：非 global Skill 在 prompt 阶段物化 Session 私有资源并把基目录指向物化目录。

T15.7 通过把 `OPENCODE_SANDBOX_DOMAIN` 指向不可达域名构造端点故障，确认 list 降级为 200 且不丢 Session 项，refresh 显式失败为 500；恢复为可达域名后 refresh 重新发现 Sandbox Skill。四个断言全部覆盖。

### 环境清理

执行后已删除各测试容器；本轮故障注入用例产生的 2 条 `session_skills` 记录因 Session 未删除而残留，后续复跑前应按 Session 清理，避免历史数据影响隔离类断言。
