# 跨会话读取对方沙箱代码

> 场景：会话 A 想了解会话 B 的代码情况。不需要 B 的 LLM 参与转发，A 直接经 B 的 sessionID 复用 B 的沙箱读取文件（session 模式），或经共享 PVC 直读文件系统（app 模式）。
>
> 运行前先 `source test-env.sh [1|2|3] && source test-lib.sh`。以下用例直接使用 `$BASE`/`$PG_URL`。
>
> 相关文档：[`sandbox-proxy-endpoint.md`](../../sandbox/sandbox-proxy-endpoint.md)（代理机制）、[`../../sandbox/files-api.md`](../../sandbox/files-api.md)（文件 API）、[`../../../docs/session-pvc-mode-guide.md`](../../../docs/session-pvc-mode-guide.md)（PVC 双模式）

## 概述：两条路径与一个误区

| 路径 | 模式 | 机制 | 适用 |
|------|------|------|------|
| **按 sessionID 远程读** | session（默认） | `POST /session/:B_id/exec`、`GET /session/:B_id/files/download` 按 sessionID 路由到 B 的**现有沙箱**（懒复用，不新建） | 临时探查、任意两个会话 |
| **共享卷直读** | app（`pvcMode=app` + 同 `appId`） | 同 app 会话共享 PVC，B 的代码在 `/workspace/worktrees/{SID_B}`，A 沙箱内直接 `cat` | 同项目长期协作、文件系统直达 |

**误区澄清**：「直接创建一个新沙箱」在 session 模式下**读不到** B 的代码——卷按会话隔离，沙箱创建参数无跨会话挂卷能力。snapshot 部署下可用 `sandbox.snapshotId` 派生环境，但拿到的是**时点副本**而非 B 的实时代码（且与 app 模式互斥）。

**A 沙箱内访问 server 的地址**（路径一的 exec 嵌套调用需要）：组合 1/3（远端沙箱）用 `$BASE` 展开后的公网地址；组合 2（本地沙箱）用 `http://host.docker.internal:4096` 或宿主映射地址。宿主机上执行的部分不受影响，始终用 `$BASE`。

---

## 前置：创建 A/B 两个会话（session 模式）

```bash
source docs/test-cases/test-env.sh 3 && source docs/test-cases/test-lib.sh

SID_A=$(new_sid -kb)   # A：发起读取的一方
SID_B=$(new_sid -kb)   # B：被读取的一方
echo "A=$SID_A B=$SID_B"

# B 沙箱内造代码
curl -s --max-time 30 -X POST "$BASE/session/$SID_B/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/src && printf \"export const api = \\\"v1\\\"\\n\" > /workspace/src/index.ts && printf \"console.log(42)\\n\" > /workspace/src/main.ts && echo ok"}' \
  | jexec "d['stdout'].strip()"
```

**期望**：两个不同 sessionID；最后输出 `ok`

---

### T22.1 A 经 exec 复用 B 沙箱：列文件 + 统计

> 验证：对 B 的 sessionID 调 exec，命令在 B 的沙箱执行（懒复用、不新建沙箱），A 拿到 B 的代码清单

```bash
# 宿主机视角：直接对 B 的 sessionID 执行只读命令
curl -s --max-time 30 -X POST "$BASE/session/$SID_B/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"find /workspace/src -type f -name \"*.ts\" | sort && echo --- && wc -l /workspace/src/*.ts"}' \
  | jexec "d['stdout'].strip()"

# A 沙箱内视角：A 的 LLM 用 bash 工具嵌套调用（地址按「概述」节替换）
SERVER=http://host.docker.internal:4096   # 组合 2；组合 1/3 用 $BASE
curl -s --max-time 30 -X POST "$BASE/session/$SID_A/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"curl -s --max-time 15 -X POST '"$SERVER"'/session/'"$SID_B"'/exec -H '\''Content-Type: application/json'\'' -d '\''{\"command\":\"find /workspace/src -type f | sort\"}'\''"}' \
  | jexec "d['stdout'].strip()"
```

**期望**：两处均输出 `index.ts`、`main.ts` 清单；PG 确认 B 的沙箱未被重建：`pgval "SELECT COUNT(*) FROM sandbox WHERE session_id='$SID_B'"` 为 `1`

### T22.2 A 经 files/download 读取 B 的文件内容

> 验证：`GET /session/:B_id/files/download` 返回 B 沙箱内文件原样内容

```bash
curl -s --max-time 15 --noproxy '*' "$BASE/session/$SID_B/files/download?path=/workspace/src/index.ts"
echo
curl -s --max-time 15 --noproxy '*' -o /dev/null -w "%{http_code}" \
  "$BASE/session/$SID_B/files/download?path=/workspace/src/not-exist.ts"
```

**期望**：第一处输出 `export const api = "v1"`；不存在路径返回非 200（404/502）

### T22.3 隔离性对照：A 沙箱直接读不到 B 的文件（session 模式）

> 验证：路径一的「远程读」必须显式指定 B 的 sessionID；A 沙箱的本地文件系统看不到 B 的代码（卷隔离）。与 `concurrency-isolation.md` T6.2 同源，此处聚焦「误以为创建沙箱/本地路径可读」的误区

```bash
curl -s --max-time 30 -X POST "$BASE/session/$SID_A/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/src/index.ts 2>&1; ls /workspace/src 2>&1"}' \
  | jexec "d['stdout'].strip()"
```

**期望**：`No such file or directory`（或空列表）——A 沙箱内没有 B 的代码；读 B 代码必须走 T22.1/T22.2 的显式 sessionID 路径



## 选型建议

| 需求 | 选择 |
|------|------|
| 临时看一眼 B 的代码 / 任意两会话 | T22.1/T22.2（session 模式默认即可） |
| 前后端同项目长期协作，B 的提交 A 要实时可见 | T22.4（app 模式，共享 `/workspace/repo` + 包缓存） |
| 需要一份 B 环境的独立副本继续开发 | snapshot 部署下 `sandbox.snapshotId` 派生（时点副本，非实时） |

## 已知坑

- **A 沙箱内嵌套调 server 的地址因组合而异**（见概述节）；宿主机执行不受影响
- **B 沙箱被回收后远程读会触发懒重建**：读到的代码是重建后的初始状态而非 B 的原代码——重要读取前对 B `keep-alive`，或先查 `GET /session/status`
- **files API 相对路径**会映射到 `/workspace/` 下（`toSandboxPath` 语义），传绝对路径最稳妥

## 复测记录

| 日期 | 组合 | 用例 | 结果 | 备注 |
|------|------|------|------|------|
| | | | | |
