# SaaS V2 工具沙箱执行验证

验证 V2 Agent 工具是否通过当前 session 的 SandboxProvider 执行，以及其文件是否只存在于远端 session sandbox。V2 是 session-centered：每个 session 有自己的 `/workspace`，工具调用记录在 session message/log 中。

## 适用范围

PVC/snapshot两种持久化模式对真实Agent执行、code-mode、生命周期及故障恢复的共同验收见[持久化无负面影响用例](./persistence-code-agent-execution.md)。本文历史工具验证结果不能替代该双模式验收。

| 工具                      | 当前沙箱路径                                                             | 验证方式                                                                                |
| ------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `shell`                   | `packages/core/src/tool/plugin/shell.ts` 路由到 `SandboxProvider`        | Agent 工具调用，并以 `session.shell` 交叉验证命令执行环境                               |
| `write` / `read` / `edit` | `packages/core/src/tool/plugin/{write,read,edit}.ts` 调用 `SandboxTools` | Agent 工具调用后通过 `session.shell` 检查文件内容                                       |
| `glob` / `grep`           | `packages/core/src/tool/plugin/{glob,grep}.ts` 调用 `SandboxTools`       | Agent 工具调用后检查其 tool message 输出                                                |
| `patch`                   | `packages/core/src/tool/plugin/patch.ts` 经 `SandboxProvider` 读写/删除  | `packages/core/test/tool-patch.test.ts` 沙箱分支；Agent 验证需选用暴露 patch 工具的模型 |

V2 内置目录读取由 `read` 工具处理；不存在旧文档所称的 `bash`、`ls`、`apply_patch` 这组 V1 工具契约。`patch` 与 `edit`/`write` 按模型选择：当前仅向符合条件的 GPT 模型暴露 `patch`，其他模型仍使用 `edit`/`write`。`task` 的子 agent 是否运行在独立 session/sandbox，须分别检查 session 及 PG 记录，不能仅根据父 session 文件可见性下结论。

## 前置条件

启动连接 PG 和 OpenSandbox 的 SaaS Docker 服务。`BASE`、`PG_URL`、`MODEL`、`OPENCODE_PASSWORD` 按 [`local-test-env.md`](../../local-test-env.md) 配置；`MODEL` 格式为 JSON，例如：

```bash
export BASE=http://127.0.0.1:14101
export PG_URL='postgresql://local@127.0.0.1:5432/opencode-v2-up'
export MODEL='{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"}'
```

测试需要真实可用的模型和相应 provider 凭证。为减少权限交互，创建 session 时显式允许本组会用到的工具。测试 session 删除前，避免在其中放置需要保留的数据。

## 第一层：代码路径审查（T20.1）

从仓库根目录执行。此检查确认 V2 插件把适用工具交给 `SandboxTools`/`SandboxProvider`，而不是用旧 V1 文件路径检查 `AppFileSystem`、`Bun.file` 或 `ctx.sandbox` 分支：

```bash
for f in write read edit glob grep; do
  if grep -q "SandboxTools\\.$f" "packages/core/src/tool/plugin/$f.ts"; then
    echo "✅ $f -> SandboxTools"
  else
    echo "❌ $f 未路由到 SandboxTools"
    exit 1
  fi
done

grep -n "SandboxProvider.Service\|sandboxProvider.run" packages/core/src/tool/plugin/shell.ts
grep -n "provider.run\|fileStat\|fileRead\|fileWrite\|fileList\|fileFind" packages/core/src/sandbox/tools.ts
grep -n "SandboxProvider.Service\|fileRead\|fileWrite\|fileDelete" packages/core/src/tool/plugin/patch.ts
```

**判定**：五个文件工具均有 SandboxTools 路由；shell 与 patch 插件使用 SandboxProvider。patch 的读/写/删均走 session sandbox，路径必须在 `/workspace` 内。

## 第二层：Agent 工具运行时验证（T20.2–T20.7）

V2 接口均带 `/api` 前缀。创建一个 session 并设置模型与允许权限：

```bash
AUTH="$(printf 'opencode:%s' "$OPENCODE_PASSWORD" | base64)"
H=(-H "Authorization: Basic $AUTH" -H 'Content-Type: application/json')
MODEL_JSON="$MODEL"

SID=$(curl -fsS "${H[@]}" -X POST "$BASE/api/session" \
  -d "$(MODEL_JSON="$MODEL_JSON" python3 -c 'import json,os; print(json.dumps({"title":"sandbox-tool-verify-v2","model":json.loads(os.environ["MODEL_JSON"]),"location":{"directory":"/workspace"},"permissions":[{"action":a,"resource":"*","effect":"allow"} for a in ["shell","edit","write","read","glob","grep"]]}))')" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])')
echo "SID=$SID"

# 多轮 Agent 验证要复用同一 sandbox；显式开启保活并立即 boot。
curl -fsS "${H[@]}" -X POST "$BASE/api/experimental/session/$SID/keep-alive" \\
  -d '{"enabled":true,"boot":true}'
```

发送一次需求并等待 Agent 执行完成：

```bash
send_prompt() {
  local prompt=$1
  curl -fsS "${H[@]}" -X POST "$BASE/api/session/$SID/prompt" \
    -d "$(PROMPT="$prompt" python3 -c 'import json,os; print(json.dumps({"text":os.environ["PROMPT"],"resume":True}))')" >/dev/null
  curl -fsS "${H[@]}" -X POST "$BASE/api/experimental/session/$SID/wait" >/dev/null
}

send_prompt '必须调用 write 工具，在 /workspace/sandbox-tool-proof.txt 写入唯一内容 sandbox-write-v2-9f31。'
send_prompt '必须调用 read 工具读取 /workspace/sandbox-tool-proof.txt，并原样报告内容。'
send_prompt '必须调用 edit 工具，将 /workspace/sandbox-tool-proof.txt 中 sandbox-write-v2-9f31 替换为 sandbox-edit-v2-a812。'
send_prompt '必须调用 glob 工具，在 /workspace 搜索 sandbox-tool-proof.txt。'
send_prompt '必须调用 grep 工具，在 /workspace 搜索 sandbox-edit-v2-a812。'
send_prompt '必须调用 shell 工具执行 hostname、whoami 和 cat /workspace/sandbox-tool-proof.txt。'
# 只有在选择了会暴露 patch 工具的 GPT 模型时，再执行：
# send_prompt '必须调用 patch 工具，把 /workspace/sandbox-tool-proof.txt 中 sandbox-edit-v2-a812 替换为 sandbox-patch-v2-c603。'
```

查看 message 中实际工具调用（模型可能不遵从要求；缺少对应 tool 调用应判失败，不可仅凭最终自然语言答复判通过）：

```bash
curl -fsS "$BASE/api/session/$SID/message?order=asc" \
  -H "Authorization: Basic $AUTH" > /tmp/sandbox-tool-messages.json
python3 - <<'PY'
import json
data=json.load(open('/tmp/sandbox-tool-messages.json'))
messages=data.get('data', data)
for message in messages:
    for part in message.get('content', []):
        if part.get('type') == 'tool':
            state=part.get('state', {})
            print(f"{part.get('name')}({state.get('status', '?')}): {str(state.get('output', ''))[:240]}")
PY
```

检查沙箱执行结果和 PG 状态。`session.shell` 是 V2 的确定性 shell API，不能用旧 `/exec`：

```bash
curl -fsS "${H[@]}" -X POST "$BASE/api/session/$SID/shell" \
  -d '{"command":"hostname && whoami && cat /workspace/sandbox-tool-proof.txt"}' >/dev/null
curl -fsS "${H[@]}" -X POST "$BASE/api/experimental/session/$SID/wait" >/dev/null
curl -fsS "$BASE/api/session/$SID/message?order=asc" \\
  -H "Authorization: Basic $AUTH" | python3 -c '
import json,sys
data=json.load(sys.stdin); messages=data.get("data",data)
for message in messages:
    if message.get("type")=="shell":
        print(f"status={message.get('status')} exit={message.get('exit')}")
        print((message.get("output") or {}).get("output", ""))
'

psql "$PG_URL" -X -A -F '|' -c \
  "SELECT id,session_id,host,state,keep_alive FROM sandbox WHERE session_id='$SID' AND state='running' AND keep_alive <> 0"
```

**判定**：message 中分别出现 `write/read/edit/glob/grep/shell` 的成功 tool 调用；沙箱内文件内容为 `sandbox-edit-v2-a812`；`session.shell` 消息状态为 `exited` 且 exit code 为 `0`，输出含沙箱运行环境信息；PG 查询返回 `$SID` 对应行且 `state=running`、`keep_alive` 为真（psql 可能显示为 `t` 或 `1`）。如需进一步确认宿主机隔离，应在 SaaS 服务容器及宿主机分别检查 `/workspace/sandbox-tool-proof.txt`，确认它们不是远端 sandbox 文件的读写入口。

## 错误与隔离边界

- `session.fs.read/list/find` 是文件 API；它们不会启动或重建 sandbox。Agent 工具验证应先通过 Agent 执行或 `session.shell` boot sandbox。
- session sandbox 固定工作区为 `/workspace`。路径逃逸不应被静默路由到服务端本地文件系统。
- session shell 输出及 Agent 工具输入/输出通过 V2 session message 和 session log 检查；V1 `exec_log` 不适用。
- 沙箱模式的 `patch` 不调用服务端 `Environment.files` 或 host formatter；文件变更始终由 SandboxProvider 完成。远端 formatter 尚未接入，patch 的格式化需由 Agent 在 patch 后另行处理。
- `lsp`、skill 与子 agent 属于其他执行路径，分别按各自能力单独验证；不要沿用旧文档对它们的 V1 行号、skill 建档 API或“子 agent 必然独立 sandbox”的断言。

## 清理

测试完成后先 release 再删除 session，避免留下 keep-alive 偏好。session 删除会销毁其 sandbox；PG sandbox 行保留为 `destroyed`：

```bash
curl -fsS "${H[@]}" -X POST "$BASE/api/experimental/session/$SID/keep-alive" \\
  -d '{"enabled":false}'
curl -fsS "${H[@]}" -X DELETE "$BASE/api/session/$SID"
```

## 验收汇总

| 用例        | 验证内容                                              | 实测结论（2026-10-02）                                       |
| ----------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| T20.1       | V2 插件到 SandboxTools/Provider 的代码路径            | PASS（静态检查：write/read/edit/glob/grep 均路由 SandboxTools；shell.ts 引用 SandboxProvider） |
| T20.2       | write 工具写入沙箱                                    | PASS（文件证据：marker 落在 /workspace）                     |
| T20.3       | read 工具读取沙箱文件                                 | PASS（assistant 原样报告）                                   |
| T20.4       | edit 工具修改沙箱文件                                 | PASS（文件内容变为 edited-marker，经 shell 复核）            |
| T20.5       | glob 工具列目录                                       | PASS                                                         |
| T20.6       | grep 工具搜索                                         | PASS                                                         |
| T20.7       | shell 工具执行                                        | PASS                                                         |
| T20.8       | `patch` 工具沙箱新增/更新/移动/删除及越界拒绝         | 单测佐证：`packages/core/test/tool-patch.test.ts` 沙箱分支通过；Agent E2E 需支持 patch 的 GPT 模型，本环境（Yd-DeepSeek）不暴露 patch，未执行 |
| T20.9       | session 删除后的 sandbox 生命周期                     | PASS（HTTP 204；PG 行 `destroyed`）                          |

实测方式：T20.2–T20.7 走真实 Agent 多轮（`saas-tool-sandbox-verify-v2.mjs`，模型 Yd-DeepSeek，每轮 prompt + wait），文件级证据由会话内 shell `cat` 复核；T20.1 为静态 grep；T20.9 在删除后查 PG。全部断言 rc=0。

## Vercel 后端验收（2026-10-24）

独立 Docker 测试服务使用 `OPENCODE_SANDBOX_PROVIDER=vercel`，通过真实 Vercel Sandbox 执行同一组 T20 用例。执行器 `docs/test-cases/scripts/sandbox-vercel-tool-t20.mjs` 经 `sandbox-vercel-t19.mjs` 包装器运行：创建会话后先订阅公共 SSE，每轮以 `prompt_stream` 驱动模型，结束时先释放保活再删除会话，并核对 PG 与远端清理。

**结果：13/13 检查通过。**

| 用例 | Vercel 实测结论 |
| --- | --- |
| T20.1 | PASS（静态检查：write/read/edit/glob/grep → SandboxTools；shell → SandboxProvider） |
| T20.2 | PASS（write 工具调用 completed，仓库文件落点由后续 shell 复核） |
| T20.3 | PASS（read 返回写入的 marker） |
| T20.4 | PASS（edit 替换成功，文件内容变为 `edited-<marker>`） |
| T20.5 | PASS（glob 返回 `/workspace/sandbox-tool-proof.txt`） |
| T20.6 | PASS（grep 命中 1 行，内容为编辑后 marker） |
| T20.7 | PASS（hostname/whoami/cat 三个 shell 调用 exit=0，whoami=ubuntu） |
| T20.8 | 未执行：deepseek 模型不暴露 patch；patch 沙箱行为由 `packages/core/test/tool-patch.test.ts` 覆盖 |
| T20.9 | PASS（先释放 keep-alive 再删除；HTTP 204；PG `state=destroyed`、`remote_name=null`） |
| 文件证据 | PASS（`session.shell`：`pwd=/workspace`、exit=0、读到编辑后内容） |
| 隔离证据 | PASS（SaaS 容器与宿主机均不存在 `/workspace/sandbox-tool-proof.txt`） |
| 运行态 PG | PASS（`provider=vercel`、`state=running`、`keep_alive=1`） |
| 远端清理 | PASS（只读复核：沙箱不存在，无残留快照） |

### Vercel 镜像缺少 ripgrep（本轮发现并修复）

首次执行时 T20.5/T20.6 失败：`ripgrep (rg) is not available in the sandbox image`。Vercel 托管镜像 `vercel/sandbox/node:24` 不包含 `rg`，而 OpenSandbox 镜像 `packages/containers/sandbox/Dockerfile` 已安装。由于 `glob`/`grep` 依赖 `rg`，这两个内置工具在 Vercel 后端对所有会话不可用，属于真实功能缺口，不是执行器问题。

修复位于 `packages/core/src/sandbox/vercel/provider.ts` 的 `ensureAssets`：boot 时先执行 `command -v rg`，缺失则通过 `sudo apt-get install -y ripgrep` 幂等安装（实测约 11 秒），失败只记录 warning，不阻塞会话；snapshot 会保留已安装的二进制。可用 `OPENCODE_VERCEL_INSTALL_RIPGREP=false` 关闭。修复后同一脚本原样重跑，T20.5/T20.6 通过。

注意：这是运行时兜底，不是镜像治理的终点。生产上更稳妥的做法是构建带 `ripgrep` 的 VCR 自定义镜像并经 `OPENCODE_VERCEL_IMAGE` 指定；届时可关闭自动安装。

### 证据与复跑

证据目录：`artifacts/vercel-tool-t20-20261024/final5/`（`result.json`、`tool-sandbox-report.json`、每轮原始事件、`shell-evidence.json`、`events.json`、`cleanup-verification.json`）。首次失败证据在 `final3/`，保留用于说明缺陷复现。

```bash
BASE=http://127.0.0.1:15109 \
OPENCODE_PASSWORD=... \
PG_URL=postgresql://local@127.0.0.1:5432/<dedicated>-test \
STRESS_OUT="$PWD/artifacts/vercel-tool-t20-20261024/final5" \
HOST_CONTAINER=<test-container> \
REPO_ROOT="$PWD" \
bun docs/test-cases/scripts/sandbox-vercel-t19.mjs sandbox-vercel-tool-t20 \
  "$PWD/artifacts/vercel-tool-t20-20261024/final5"
```

单测与静态检查：`sandbox-config`/`sandbox-vercel-provider`/`sandbox-tools-*` 共 33 pass / 0 fail；Core typecheck 与相关文件 lint 通过。

## 历史记录说明

原文中的 `/session/:id/exec`、`/session/:id/message`、`bash`、`ls`、`apply_patch`、V1 `packages/opencode/src/tool` 路径及旧 Pod 名断言均属于旧版验收记录，不再作为 V2 的执行步骤或通过结论。历史结果可从 Git 历史查看。
