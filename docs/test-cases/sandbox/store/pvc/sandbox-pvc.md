# 沙箱与 PVC 持久化（V2）

> 前置条件：V2 SaaS 服务已启动（`docs/local-test-env.md`），OpenSandbox + PVC 可用。
> 公共环境变量 `$BASE` `$PG_URL` 由 [`test-env.sh`](../../test-env.sh) 提供（`source test-env.sh [1|2|3]`）。
> 本文档正文为 V2 API 用例。自动执行入口：[`scripts/session-pvc-mode-v2.mjs`](../../scripts/session-pvc-mode-v2.mjs) 的 T5 组。

### T5.0 部署前置检查（volumeType 语义）

PVC 是代码持久化的默认方式。`OPENCODE_SANDBOX_VOLUME_TYPE` 只有两个合法值：`pvc`（默认）与 `snapshot`。

```bash
docker exec <saas容器名> env | grep OPENCODE_SANDBOX_VOLUME_TYPE
# 期望：OPENCODE_SANDBOX_VOLUME_TYPE=pvc
```

**期望**：值为 `pvc`。

**语义**（见 `packages/core/src/sandbox/config.ts` 与 `sandbox-config.test.ts`）：

- 未设置、空值、`none`、`host`、非法值 → 服务回落 `pvc`，不会静默丢失持久化。
- 仅显式 `snapshot` 选择快照后端（本组用例不覆盖快照）。

### 通用变量（V2）

```bash
# V2 API 需要 Basic 认证；<password> 与部署配置一致
AUTH="opencode:<password>"

SID=$(curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
curl -s -u "$AUTH" -X POST "$BASE/api/experimental/session/$SID/keep-alive" \
  -H 'Content-Type: application/json' -d '{"enabled":true}' >/dev/null
echo "SID: $SID"
```

### V2 执行命令 helper

`POST /api/session/:id/shell` 是异步接口：成功返回 204，命令输出从 session log（SSE）的 `session.shell.ended` 事件读取。定义两个 helper，后续用例复用：

```bash
# 从 log SSE 中提取当前最大事件序号（durable.seq）
lastseq() { python3 -c '
import json,sys
seq=0
for line in sys.stdin:
    if not line.startswith("data:"): continue
    try: ev=json.loads(line[5:])
    except Exception: continue
    s=(ev.get("durable") or {}).get("seq")
    if isinstance(s,int) and s>seq: seq=s
print(seq)'; }

# 从 log SSE 中提取 shell.ended 事件的命令输出
shellout() { python3 -c '
import json,sys
last=""
for line in sys.stdin:
    if not line.startswith("data:"): continue
    try: ev=json.loads(line[5:])
    except Exception: continue
    if ev.get("type")=="session.shell.ended":
        out=ev.get("data",{}).get("output",{}).get("output","")
        if out: last=out
print(last)'; }

# 在会话沙箱内执行命令并打印输出
v2exec() {
  local seq out i
  seq=$(curl -s -u "$AUTH" -N "$BASE/api/experimental/session/$SID/log?after=0" | lastseq)
  curl -s -u "$AUTH" -X POST "$BASE/api/session/$SID/shell" \
    -H 'Content-Type: application/json' \
    -d "{\"command\": $(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$1")}" >/dev/null
  for i in $(seq 1 30); do
    sleep 2
    out=$(curl -s -u "$AUTH" -N "$BASE/api/experimental/session/$SID/log?after=$seq" | shellout)
    if [ -n "$out" ]; then printf '%s' "$out"; return 0; fi
  done
  echo "(shell timeout)" >&2; return 1
}
```

## 五、沙箱与 PVC 持久化

### T5.1 创建沙箱写入文件

```bash
v2exec 'echo 12345 > /workspace/pvc-test.txt && cat /workspace/pvc-test.txt'
```

**期望**：输出含 `12345`

### T5.2 销毁沙箱

```bash
curl -s -u "$AUTH" -X POST "$BASE/api/session/$SID/kill-sandbox"
```

**期望**：HTTP 200，响应 `destroyed=true`，沙箱容器被删除

### T5.3 重建沙箱后文件仍存在（核心 PVC 测试）

```bash
# kill-sandbox 后，下次 shell 会自动重建沙箱（挂同一 PVC subPath）
sleep 3
v2exec 'cat /workspace/pvc-test.txt'
```

**期望**：输出含 `12345`，证明 PVC 跨沙箱实例持久化

### T5.4 多文件批量持久化

```bash
v2exec 'echo A > /workspace/a.txt && echo B > /workspace/b.txt && echo C > /workspace/c.txt'
curl -s -u "$AUTH" -X POST "$BASE/api/session/$SID/kill-sandbox" >/dev/null
sleep 3
v2exec 'for f in a.txt b.txt c.txt; do echo "$f: $(cat /workspace/$f)"; done'
```

**期望**：输出含 `a.txt: A`、`b.txt: B`、`c.txt: C` 三行，证明 PVC 批量持久化

### T5.5 目录持久化

```bash
v2exec 'mkdir -p /workspace/sub/deep && echo DEEP > /workspace/sub/deep/x.txt'
curl -s -u "$AUTH" -X POST "$BASE/api/session/$SID/kill-sandbox" >/dev/null
sleep 3
v2exec 'cat /workspace/sub/deep/x.txt'
```

**期望**：输出含 `DEEP`，证明 PVC 目录结构持久化

---

## 复测记录

### 2026-09-24（V2 feat/opencode-saas-2.0，PVC 功能 V2 实现合入）

环境：SaaS 容器（本地 PG `opencode-v2-up` + 本地 OpenSandbox Docker runtime，`OPENCODE_SANDBOX_VOLUME_TYPE=pvc`、claim `sandbox-test` 即 Docker named volume，subPath 语义与 K8s PVC 一致），镜像 `opencode-saas-sandbox-test:pvc-e2e`。

V2 API 适配：`exec` → `POST /api/session/:id/shell`（输出读 session log）；`kill-sandbox` → `POST /api/session/:id/kill-sandbox`。用例由 [`scripts/session-pvc-mode-v2.mjs`](../../scripts/session-pvc-mode-v2.mjs) 的 T5 组执行。

| 用例 | 结果 | 备注 |
|---|---|---|
| T5.1 写入文件 | PASS | stdout `12345` |
| T5.2 销毁沙箱 | PASS | `destroyed=true` |
| T5.3 重建后文件存在 | PASS | stdout `12345`，PVC 跨沙箱实例持久化正常 |
| T5.4 多文件批量 | PASS | a/b/c 三文件内容均在 |
| T5.5 目录持久化 | PASS | 深层目录 `DEEP` 完整 |

> 2026-10-02：正文由 V1 API 改写为 V2 API，并新增 T5.0 部署前置检查（volumeType 收窄为 `pvc`/`snapshot` 两值、默认 `pvc`，与 V1 对齐）。复测记录为改写前实测数据。

### 2026-08-21（commit 13b750953b，快照功能合入后回归）

环境：SaaS 容器（本地 PG `opencode` 库 + 远端 K8s Sandbox），默认 `VOLUME_TYPE=pvc`、无快照开关，镜像 `opencode-saas-sandbox-test:13b750953b`。

| 用例 | 结果 | 备注 |
|---|---|---|
| T5.1 写入文件 | PASS | exitCode 0，stdout `12345` |
| T5.2 销毁沙箱 | PASS | `{"destroyed":true}` |
| T5.3 重建后文件存在 | PASS | stdout `12345`，PVC 跨沙箱实例持久化正常 |
| T5.4 多文件批量 | PASS | a/b/c 三文件内容均在 |
| T5.5 目录持久化 | PASS | 深层目录 `DEEP` 完整 |

附带验证：全程 `session_snapshot` 表 0 新增记录——快照代码路径不影响默认 PVC 模式。结论：**默认模式不受快照功能影响**。
