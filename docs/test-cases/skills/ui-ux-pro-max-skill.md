# ui-ux-pro-max Skill 端到端验证

> 验证 `ui-ux-pro-max` 通过 Session Skill bundle 接入后，AI 能按技能规定的工作流完成 UI/UX 设计：先生成完整 design system，再按需查询 UX/技术栈建议，并能持久化 Master/页面级覆盖配置。

## Skill 信息

| 字段 | 值 |
|------|-----|
| 名称 | `ui-ux-pro-max` |
| 注册方式 | **Bundle**（`SKILL.md` + Python scripts + CSV data） |
| 本地来源 | `docs/test-cases/skills/ui-ux-pro-max/` |
| content | `SKILL.md`，包含工作流、命令格式和交付检查清单 |
| resources | `scripts/*.py`、`references/*.md`、核心 `data/*.csv`、`data/stacks/react.csv` |
| 覆盖能力 | design system / style / color / typography / UX / chart / React / stack 查询 |
| 运行位置 | 沙箱 `/workspace` |

> 本用例使用仓库内固定的技能 bundle，便于复测和版本追踪。

## 接入流程概览

| 步骤 | 动作 | 用例 |
|------|------|------|
| 1 | 创建 session 并启动沙箱 | T50.1 |
| 2 | 验证 Python 和技能脚本 | T50.2 |
| 3 | 注册 skill bundle 并校验 PG | T50.3 |
| 4 | AI 生成 design system 并补充查询 | T50.4 |
| 5 | AI 持久化 Master 与页面 override | T50.5 |

## 前置条件

```bash
source docs/test-cases/test-env.sh 3
source docs/test-cases/test-lib.sh

export SKILL_DIR="${SKILL_DIR:-$PWD/docs/test-cases/skills/ui-ux-pro-max}"
test -f "$SKILL_DIR/SKILL.md" || { echo "missing $SKILL_DIR/SKILL.md"; exit 1; }
```

以下用例默认使用 `$BASE`、`$PG_URL`、`$MODEL`、`new_sid`、`jexec` 和 `exec_in_sandbox`。若当前 `test-lib.sh` 没有 `exec_in_sandbox`，使用下面定义：

```bash
exec_in_sandbox() {
  local sid="$1"; shift
  curl -s -X POST "$BASE/session/$sid/exec" \
    -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"command":" ".join(sys.argv[1:])}))' "$@")" \
    | jexec "(d.get('stdout') or '') + (d.get('stderr') or '')"
}
```

### T50.1 创建 session 并启动沙箱

```bash
SID=$(new_sid -kb)
echo "SID: $SID"
```

**期望**：返回 `ses_xxx`，keep-alive boot 返回 200，沙箱已就绪。

### T50.2 验证 Python 环境

```bash
exec_in_sandbox "$SID" 'python3 --version'
```

**期望**：

- Python 3 可用。搜索脚本 smoke test 在 T50.4 中由 AI 加载 skill 后执行，避免混淆 SaaS 服务容器和独立 Sandbox 的文件系统。

### T50.3 注册 skill bundle 并校验 PG

```bash
python3 - "$SID" "$SKILL_DIR" <<'PY'
import json, os, pathlib, re, sys, urllib.request

sid, root = sys.argv[1:]
root = pathlib.Path(root)
content = (root / "SKILL.md").read_text()
match = re.search(r"^description:\s*(.+)$", content, re.MULTILINE)
description = match.group(1).strip() if match else "UI/UX design intelligence"
resources = []

for path in sorted(root.joinpath("scripts").glob("*.py")):
    resources.append({"path": str(path.relative_to(root)), "type": "script", "content": path.read_text()})
for path in sorted(root.joinpath("references").glob("*.md")):
    resources.append({"path": str(path.relative_to(root)), "type": "doc", "content": path.read_text()})
for path in sorted(root.joinpath("data").glob("*.csv")):
    if path.name == "google-fonts.csv":
        continue
    resources.append({"path": str(path.relative_to(root)), "type": "asset", "content": path.read_text()})
path = root / "data/stacks/react.csv"
resources.append({"path": str(path.relative_to(root)), "type": "asset", "content": path.read_text()})

body = json.dumps({
    "name": "ui-ux-pro-max",
    "description": description[:500],
    "content": content,
    "resources": resources,
}).encode()
request = urllib.request.Request(
    f"http://localhost:14096/session/{sid}/skills/create",
    data=body,
    headers={"Content-Type": "application/json"},
)
print(urllib.request.urlopen(request, timeout=30).read().decode())
PY

curl -s "$BASE/session/$SID/skills" | python3 -c '
import json,sys
skills=json.load(sys.stdin)
s=next(x for x in skills if x["name"]=="ui-ux-pro-max")
print({"name":s["name"],"resource_count":len(s["resources"]),"resources":[(r["path"],r["type"],r["size"],"content" in r) for r in s["resources"]]})
 '

psql "$PG_URL" -t -A -c "
SELECT name, length(content), jsonb_array_length(resources::jsonb)
FROM session_skill
WHERE session_id='$SID' AND name='ui-ux-pro-max';"
```

**期望**：

- 完整 bundle 包含约 745 KB 的 `google-fonts.csv`，超过 `skills/create` 请求上限；本用例注册不含该大文件的核心 bundle，并额外包含 `data/stacks/react.csv`，创建接口应返回 `sskill_xxx`。
- `GET /skills` 只返回 resource 的 `path/type/size/digest`，不包含 `content`。
- PG 保存完整 `content` 和 resources 正文，`length(content) > 5000`。

### T50.4 AI 生成 design system 并补充查询

```bash
BEFORE=$(curl -s "$BASE/session/$SID/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")

curl -s -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"使用 ui-ux-pro-max skill，为一个医疗 SaaS dashboard 设计 React 页面。先生成完整 design system，再查询 accessibility UX 指南和 React stack 指南，最后给出可执行的设计规范。\"}],\"skills\":[\"ui-ux-pro-max\"],\"model\":$MODEL}" \
  -w "HTTP %{http_code}\\n"

# 轮询并观察工具顺序；最长等待 180 秒。
bun -e '
const sid = "'$SID'"
const start = Date.now()
let last = '$BEFORE'
while (Date.now() - start < 180000) {
  const messages = await (await fetch("http://localhost:14096/session/" + sid + "/message")).json()
  for (let i = last; i < messages.length; i++) {
    for (const part of messages[i].parts || []) {
      if (part.type === "tool") console.log(part.tool, part.state?.status, JSON.stringify(part.state?.input || {}).slice(0, 240))
      if (part.type === "text" && part.text?.trim()) console.log("TEXT", part.text.slice(0, 600))
    }
  }
  last = messages.length
  if ((messages.at(-1)?.parts || []).some(p => p.type === "text" && p.text?.trim())) break
  await new Promise(resolve => setTimeout(resolve, 5000))
}
'
```

**期望**：

- `prompt_async` 返回 `HTTP 204`。
- 首个相关工具调用为 `skill`，输入包含 `name: "ui-ux-pro-max"`。
- AI 先执行或明确生成 `search.py ... --design-system`，不能只给泛化 UI 建议。
- 后续按需调用 `--domain ux` 和 `--stack react`，最终输出 pattern、颜色、字体、交互/无障碍和 anti-patterns。
- 回复不使用 emoji 作为 UI 图标建议，并包含响应式、focus、对比度或 reduced-motion 等检查项。

### T50.5 持久化 Master 与页面 override

```bash
BEFORE=$(curl -s "$BASE/session/$SID/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")

curl -s -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"继续使用 ui-ux-pro-max skill：为同一个医疗 SaaS 项目执行 --design-system --persist -p \"CareOps\" --page dashboard。执行完成后检查 design-system/MASTER.md 和 design-system/pages/dashboard.md，并说明页面 override 如何覆盖 Master。\"}],\"skills\":[\"ui-ux-pro-max\"],\"model\":$MODEL}" \
  -w "HTTP %{http_code}\\n"

# 轮询结束后确认沙箱文件。
sleep 20
exec_in_sandbox "$SID" 'find /workspace -path "*/design-system/*/MASTER.md" -o -path "*/design-system/*/pages/dashboard.md"'
exec_in_sandbox "$SID" 'test -s /workspace/design-system/careops/MASTER.md && test -s /workspace/design-system/careops/pages/dashboard.md && echo persist-ok'
```

**期望**：

- AI 调用 `search.py` 时包含 `--persist`、`-p CareOps` 和 `--page dashboard`。
- 生成 `design-system/MASTER.md` 与 `design-system/pages/dashboard.md`，两个文件均非空。
- AI 能说明 dashboard 页面规则优先于 Master，而不是把页面覆盖内容当成全局规则。

## 验收汇总

| 用例 | 结果 | 验收重点 |
|------|------|----------|
| T50.1 | ✅ | `ses_fc8477d1affe2s06pSTFeeh4BH`，boot 返回 200 |
| T50.2 | ✅ | 远程 Sandbox Python 3.12.3 |
| T50.3 | ✅ | 仓库核心 bundle 注册成功，排除约 745 KB 的 `google-fonts.csv`，包含 `data/stacks/react.csv`；PG `ui-ux-pro-max\|13532\|19` |
| T50.4 | ✅ | 首调 `skill`；design-system、UX、chart、React domain 和 `--stack react` 均成功 |
| T50.5 | ✅ | 生成并读取 `design-system/careops/MASTER.md` 与 `pages/dashboard.md`，AI 正确说明 override 继承关系 |

> 复测日期：2026-08-25。完整资源包包含 `google-fonts.csv` 时超过 `skills/create` 请求上限，因此测试注册核心资源子集；仓库内 bundle 已包含 React stack 数据。
