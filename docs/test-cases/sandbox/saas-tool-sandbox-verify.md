# SaaS 工具沙箱执行验证

> 验证 8 个工具（write/read/bash/edit/glob/grep/ls/apply_patch）确实在远端沙箱 Pod 中执行，无本地文件系统 fallback。

## 验证三层标准

| 层级 | 方法 | 判定标准 |
|------|------|---------|
| 1. 代码路径审查 | 静态检查源码无本地 I/O 和条件分支 | 8 个文件均无 `AppFileSystem`/`Bun.file`/`fs.*` 调用，无 `ctx.sandbox !== null` 分支 |
| 2. 运行时验证 | exec API 确认文件仅在沙箱内，容器和宿主机不存在 | 沙箱内文件存在 ✅，容器内不存在 ✅，宿主机不存在 ✅ |
| 3. PG 记录 | 查询 `sandbox` 表确认 session 对应记录 | `state=running`，`host` 指向 Sandbox API |

## 前置条件

> 运行前先全局加载环境：`source test-env.sh [1|2|3]`（见 [`00-preamble.md`](./00-preamble.md)）。以下用例直接用 `$BASE` `$PG_URL` `$MODEL`，不重复定义。

容器需通过 `local-test-env.md` 启动，连接远端 PG + Sandbox API。

---

## 第一层：代码路径审查（T20.1）

### T20.1 静态检查 10 个沙箱工具文件

```bash
cd packages/opencode/src/tool

for f in edit.ts glob.ts grep.ts read.ts write.ts shell.ts ls.ts apply_patch.ts lsp.ts skill.ts; do
  local_io=$(grep -n "yield\* fs\.\|yield\* afs\.\|Bun\.file\|readFileSync\|writeFileSync\|fs\.readFile\|fs\.writeFile\|fs\.stat\|fs\.open\|fs\.stream\|fs\.readDirectory\|fs\.existsSafe" "$f" 2>/dev/null | grep -v "^.*import\|^.*//\|^.*\*" || true)
  branch=$(grep -n "ctx\.sandbox !== null\|ctx\.sandbox !=" "$f" 2>/dev/null | grep -v "^.*//\|^.*\*" || true)
  if [ -z "$local_io" ] && [ -z "$branch" ]; then
    echo "✅ $f"
  else
    echo "❌ $f"
    [ -n "$local_io" ] && echo "$local_io" | sed 's/^/   本地IO: /'
    [ -n "$branch" ] && echo "$branch" | sed 's/^/   分支: /'
  fi
done
```

**期望**：10 个文件全部 `✅`。

---

## 第二层：运行时验证（T20.2 – T20.9）

### 通用函数

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

send_msg() {
  local sid=$1 prompt=$2
  curl -s --max-time 180 -X POST "$BASE/session/$sid/message" \
    -H 'Content-Type: application/json' \
    -d "{\"parts\":[{\"type\":\"text\",\"text\":\"$prompt\"}],\"model\":$MODEL}"
}

get_tools() {
  local sid=$1
  curl -s "$BASE/session/$sid/message" | python3 -c "
import json,sys
msgs=json.load(sys.stdin)
for m in msgs[-4:]:
    for p in m.get('parts',[]):
        if p.get('type')=='tool':
            t=p.get('tool','?')
            s=p.get('state',{})
            print(f\"  {t}({s.get('status','?')}): {(s.get('output','') or '')[:120]}\")
"
}

verify_sandbox() {
  local sid=$1 path=$2
  echo "  【沙箱内】"
  curl -s -X POST "$BASE/session/$sid/exec" \
    -H 'Content-Type: application/json' \
    -d "{\"command\":\"cat $path 2>&1 && echo '---EXISTS'\"}" | python3 -c "
import json,sys
d=json.load(sys.stdin)
out=d.get('stdout','')
print(f\"    exitCode={d.get('exitCode')}, output={out.strip()[:100]}\")
print('    ✅ 沙箱内存在' if '---EXISTS' in out else '    ❌ 沙箱内不存在')
"
  echo "  【容器内】"
  docker exec opencode-saas-test test -f "$path" 2>/dev/null && echo "    ❌ 容器内存在" || echo "    ✅ 容器内不存在"
  echo "  【宿主机】"
  test -f "$path" 2>/dev/null && echo "    ❌ 宿主机存在" || echo "    ✅ 宿主机不存在"
}
```

### T20.2 write 工具

```bash
echo "=== T20.2 write ==="
send_msg "$SID" "在 /workspace 创建 t19-write.txt 内容是 sandbox-write-proof" > /dev/null
get_tools "$SID"
verify_sandbox "$SID" "/workspace/t19-write.txt"
```

**期望**：工具 `write(completed)`，文件仅在沙箱内存在，内容含 `sandbox-write-proof`。

### T20.3 read 工具

```bash
echo "=== T20.3 read ==="
send_msg "$SID" "读取 /workspace/t19-write.txt 的内容" > /dev/null
get_tools "$SID"
```

**期望**：工具 `read(completed)`，output 含 `sandbox-write-proof`。

### T20.4 bash 工具

```bash
echo "=== T20.4 bash ==="
send_msg "$SID" "用 bash 执行: hostname && whoami && cat /workspace/t19-write.txt" > /dev/null
get_tools "$SID"
```

**期望**：工具 `bash(completed)`，hostname 为 UUID 格式（K8s Pod 名），whoami 为 `root`，文件内容正确。

### T20.5 edit 工具

```bash
echo "=== T20.5 edit ==="
send_msg "$SID" "把 /workspace/t19-write.txt 中的 sandbox-write-proof 替换为 sandbox-edit-proof" > /dev/null
get_tools "$SID"

echo "  验证编辑结果:"
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/t19-write.txt"}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
out=d.get('stdout','').strip()
print(f'    内容: {out}')
print('    ✅ 编辑成功' if 'sandbox-edit-proof' in out else '    ❌ 编辑失败')
"
```

**期望**：工具 `edit(completed)`，文件内容变为 `sandbox-edit-proof`。

### T20.6 glob 工具

```bash
echo "=== T20.6 glob ==="
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo aaa > /workspace/t19-glob-a.txt && echo bbb > /workspace/t19-glob-b.log"}' > /dev/null
send_msg "$SID" "用 glob 在 /workspace 搜索 *.txt 文件" > /dev/null
get_tools "$SID"
```

**期望**：工具 `glob(completed)`，output 含 `t19-write.txt` 和 `t19-glob-a.txt`，不含 `.log` 文件。

### T20.7 grep 工具

```bash
echo "=== T20.7 grep ==="
send_msg "$SID" "用 grep 在 /workspace 搜索包含 edit-proof 的文件" > /dev/null
get_tools "$SID"
```

**期望**：工具 `grep(completed)`，output 含 `t19-write.txt` 和 `edit-proof`。

### T20.8 ls 工具

```bash
echo "=== T20.8 ls ==="
send_msg "$SID" "列出 /workspace 目录下的所有文件" > /dev/null
get_tools "$SID"
```

**期望**：使用 `bash`/`read`/`glob` 中的某一个列出目录（AI 自行选择工具），输出包含之前创建的文件。

### T20.9 apply_patch 工具

```bash
echo "=== T20.9 apply_patch ==="
send_msg "$SID" "在 /workspace 创建 t19-patch.txt 内容是第一行和第二行，每行一个" > /dev/null
send_msg "$SID" "用 apply_patch 工具给 /workspace/t19-patch.txt 在末尾添加第三行" > /dev/null
get_tools "$SID"

echo "  验证 patch 结果:"
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/t19-patch.txt"}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
lines=d.get('stdout','').strip().split('\n')
print(f'    行数: {len(lines)}, 内容: {lines}')
print('    ✅ patch 成功' if len(lines) >= 3 else '    ❌ patch 失败')
"
```

**期望**：文件包含 3 行。

---

## 工具分类总览

> 系统注册 15 个工具（`GET /experimental/tool/ids`），按是否在沙箱内执行分三类：

| 分类 | 工具 | sandbox 引用 | 验证方式 |
|------|------|-------------|---------|
| **沙箱内执行** | write / read / bash / edit / glob / grep / apply_patch / ls | `ctx.sandbox` / `sandboxProvider.runDetached` | T20.2-T20.9（本文档） |
| **沙箱内执行** | `lsp` | `lsp.ts:67-71` SandboxProvider 分支 | [`27-session-lsp.md`](../27-session-lsp.md) T27.8-T27.9.3 |
| **沙箱内执行** | `skill` | `skill.ts:116-194` `ctx.sandbox` + `sandbox.commands.run` | T20.13（本文档） |
| **编排（间接触发沙箱）** | `task` | 本身无 sandbox 引用，子 agent 工具走沙箱 | T20.14（本文档） |
| **非沙箱** | webfetch / websearch / question / todowrite / plan | 无 sandbox 引用 | 不需沙箱验证 |
| **占位** | `invalid` | — | 不需验证 |

---

### T20.13 skill 工具沙箱分支

> 验证 `skill.ts` 在沙箱模式下通过 `sandbox.commands.run` 执行 `find`/`test -f` 检测 session 级 skill 资源。

```bash
echo "=== T20.13 skill sandbox ==="
# skill 工具的沙箱分支在加载 skill 时通过 sandbox 执行 find 检测文件
# 先通过 exec 在沙箱内创建一个 skill 文件
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/.opencode/skills && printf '\''{"description":"test skill","prompt":"test"}'\'' > /workspace/.opencode/skills/test-skill.md && echo skill-created"}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('stdout','').strip())"

# 让 AI 加载 skill（触发 skill.ts sandbox 分支的 find/test 检测）
send_msg "$SID" "Use the skill tool to load the test-skill skill" > /dev/null
get_tools "$SID"
```

**期望**：工具 `skill(completed)`，output 确认 skill 已加载。`skill.ts:155` 的 `sandbox.commands.run("find ... -exec chmod 644")` 和 `skill.ts:194` 的 `sandbox.commands.run("test -f ... && echo YES")` 在沙箱内执行，非本地文件系统。

---

### T20.14 task 工具子 agent 沙箱隔离

> 验证 `task` 工具创建的子 agent 在**独立沙箱**中执行工具，与父 session 隔离。

```bash
echo "=== T20.14 task sandbox isolation ==="
# 父 session 写一个标记文件
send_msg "$SID" "用 bash 执行: echo parent-marker > /workspace/parent-marker.txt" > /dev/null

# 用 task 创建子 agent，子 agent 在自己的沙箱中执行
send_msg "$SID" "Use the task tool with a general subagent to run: echo subagent-isolated > /workspace/subagent-marker.txt" > /dev/null
get_tools "$SID"

# 验证子 agent 写的文件不在父 session 的沙箱中（隔离）
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/subagent-marker.txt 2>&1"}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
out=d.get('stdout','').strip()
print(f'    父 session 沙箱: {out}')
print('    ✅ 隔离（父沙箱无子 agent 文件）' if 'subagent-isolated' not in out else '    ⚠️ 子 agent 复用父沙箱')
"
```

**期望**：`task(completed)`，子 agent 在自己的 session/sandbox 中执行（`task.ts` 本身无 sandbox 引用，但创建的子 agent session 有独立 sandbox）。父 session 沙箱内无子 agent 写入的文件（隔离）。

---

## 第三层：PG 记录验证（T20.10）

### T20.10 sandbox 表记录

```bash
echo "=== T20.10 PG 记录 ==="
psql "$PG_URL" -c \
  "SELECT id, session_id, host, state, keep_alive FROM sandbox WHERE session_id='$SID'"
```

**期望**：

| 字段 | 判定 |
|------|------|
| `state` | `running` |
| `host` | 指向 Sandbox API 地址 |
| `session_id` | 与测试 session 匹配 |

---

## 补充验证

### T20.11 环境隔离确认

```bash
echo "=== T20.11 环境隔离 ==="
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"hostname && echo --- && ls /app 2>&1 || echo NO_APP_DIR && echo --- && env | grep OPENCODE | wc -l && echo --- && ps aux | grep opencode | grep -v grep | wc -l"}' \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
parts=[p.strip() for p in d.get('stdout','').split('---')]
hostname=parts[0] if len(parts)>0 else ''
app_dir=parts[1] if len(parts)>1 else ''
env_count=parts[2] if len(parts)>2 else ''
proc_count=parts[3] if len(parts)>3 else ''
print(f'  hostname: {hostname} {\"✅ UUID\" if len(hostname) > 20 else \"❌ 非UUID\"}')
print(f'  /app目录: {app_dir[:50]} {\"✅ 不存在\" if \"NO_APP_DIR\" in app_dir or \"No such\" in app_dir else \"❌ 存在\"}')
print(f'  OPENCODE环境变量: {env_count}个 {\"✅ 无\" if env_count.strip() == \"0\" else \"⚠️ 有\"}')
print(f'  opencode进程: {proc_count}个 {\"✅ 无\" if proc_count.strip() == \"0\" else \"❌ 有\"}')
"
```

**期望**：沙箱 Pod 内无 opencode 代码、环境变量、进程，hostname 为 UUID。

### T20.12 错误信息无 sandbox 泄露

> ⚠️ **与代码核对**（2026-07-18）：`read.ts:49`（`"Sandbox is not available"`）与 `write.ts:46,49`（`"Sandbox initialization failed"` / `"Sandbox is not available"`）**仍含 "Sandbox" 关键字**。以下 grep 会命中这 3 行；shell.ts:106 已修。需修复 read.ts/write.ts 后本用例才全绿。

```bash
echo "=== T20.12 错误信息泄露检查 ==="
grep -rn "new Error.*[Ss]andbox" packages/opencode/src/tool/{edit,glob,grep,read,write,shell,ls,apply_patch}.ts
echo "期望: 无输出（当前会命中 read.ts:49 / write.ts:46,49）"
```

**期望**：无匹配，工具错误信息不含 `sandbox` 关键字。

---

## 验收汇总

| 用例 | 验证层 | 工具 | 判定 |
|------|--------|------|------|
| T20.1 | 代码审查 | 10 个沙箱工具 | 无本地 I/O 和条件分支 |
| T20.2 | 运行时 | write | 文件仅在沙箱内 |
| T20.3 | 运行时 | read | 从沙箱读取正确 |
| T20.4 | 运行时 | bash | 沙箱 Pod 执行 |
| T20.5 | 运行时 | edit | 沙箱内文件被修改 |
| T20.6 | 运行时 | glob | 搜索沙箱内文件 |
| T20.7 | 运行时 | grep | 搜索沙箱内内容 |
| T20.8 | 运行时 | ls/read | 列出沙箱目录 |
| T20.9 | 运行时 | apply_patch | 沙箱内 patch |
| T20.10 | PG 记录 | — | sandbox 表 state=running |
| T20.11 | 运行时 | — | 环境隔离 |
| T20.12 | 代码审查 | 全部 | 无 sandbox 泄露 |
| T20.13 | 运行时 | skill | skill.ts sandbox 分支（find/test 检测） |
| T20.14 | 运行时 | task | 子 agent 独立沙箱隔离 |
| — | 交叉引用 | lsp | 见 [`27-session-lsp.md`](../27-session-lsp.md) |

---

## 复测结果（2026-05-30）

### 通过的验证

| 用例 | 结果 | 说明 |
|------|------|------|
| T20.1 | ✅ | 8 个工具文件静态检查全通过（无本地 I/O fallback） |
| T20.2 | ✅ | write：沙箱内存在+内容正确，**容器内不存在，宿主机不存在**（三层验证） |
| T20.4 | ✅ | bash：hostname=UUID, whoami=root, 文件内容正确 |
| T20.5 | ✅ | edit：内容改为 sandbox-edit-proof |
| T20.10 | ✅ | PG sandbox 记录 state=running |
| T20.11 | ✅ | 环境隔离：UUID hostname, 无/app, 0 个 OPENCODE env, 0 个 opencode 进程 |
| T20.12 | ✅ | 修复 shell.ts:106 泄露（见下） |

### 发现的问题

#### 🔴 P1：glob/grep/ls 工具在沙箱内失效（缺 ripgrep）

**现象**：T20.6 glob、T20.7 grep 均返回 "No files found"，即使文件确实存在于沙箱内。

**根因**：glob.ts / grep.ts / ls.ts 的沙箱分支硬依赖 `rg`（ripgrep）命令：
- `glob.ts:48` → `rg --files --glob ...`
- `grep.ts:74` → `rg --json ...`
- `ls.ts:77` → `rg --files ...`

但远端沙箱镜像**未安装 ripgrep**：
```
rg MISSING / find OK / grep OK / ls OK
```
命令中的 `2>/dev/null` 吞掉了 "rg: command not found"，rg 失败 → 空 stdout → "No files found"。

**影响**：沙箱模式下 glob/grep/ls 三个工具完全不可用。

**修复方案 B（已采用）**：沙箱镜像安装 ripgrep。

沙箱镜像 Dockerfile 在本仓库 `packages/containers/sandbox/Dockerfile`（`FROM opensandbox/code-interpreter:latest`，Ubuntu 基础）。已添加：

```dockerfile
RUN apt-get update \
  && apt-get install -y --no-install-recommends ripgrep \
  && rm -rf /var/lib/apt/lists/*
```

**验证**：
- `docker build --check` 通过（无警告）
- 在运行沙箱中 `apt-get install ripgrep` 成功安装 ripgrep 14.1.0，确认 apt 源可用
- 临时安装的 rg 在 sandbox 回收重建后丢失，印证必须烤进镜像才能持久（方案 B 的必要性）

**已构建并推送**：`shangwfa/opencode-saas-sandbox:rg`（amd64/linux，含 ripgrep 14.1.0）。使用时将 `OPENCODE_SANDBOX_IMAGE` 指向该 tag；旧的 `shangwfa/opencode-saas-sandbox:latest` 仍不含 `rg`。

> **方案 A（未采用）**：opencode 代码层 rg fallback 到 find/grep。需改 3 个工具 + 适配输出解析，改动较大。

#### 🟡 P2：shell.ts 错误信息泄露 "sandbox"（已修复）

`shell.ts:106` 原 `throw new Error("No sandbox provider available")` 含 sandbox 关键字。
已修复为 `throw new Error("Execution environment not available")`。

> **注**：edit.ts:67 的 `new Error(String(e))` 中 `Sandbox` 仅为类型注解/变量名，错误文本不含 sandbox，非泄露。
