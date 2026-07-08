# 沙箱文件操作工具测试文档

针对 `apply_patch` 和 `ls` 工具新增沙箱支持的回归与边界测试。同时覆盖所有工具的错误信息泄露检查。

---

## 一、背景

### 1.1 问题描述

opencode 的沙箱模式（`OPENCODE_SANDBOX_ENABLED=true`）下，所有文件操作应在远程沙箱容器中执行。但 `apply_patch.ts`（写/删/移动文件）和 `ls.ts`（目录列表）缺少沙箱分支，直接操作本地文件系统，绕过了沙箱隔离。

### 1.2 修复内容

| 文件 | 改动 |
|---|---|
| `apply_patch.ts` | 新增 `readFile`/`writeFile`/`removeFile`/`statFile` 四个 helper 函数，根据 `ctx.sandbox` 分发到沙箱或本地 |
| `ls.ts` | 新增 `ctx.sandbox !== null` 分支，通过 `sandboxProvider.runInSession` + `rg --files` 在沙箱内搜索 |
| `bash.ts` / `edit.ts` / `read.ts` / `write.ts` | 错误信息去除 "sandbox" 关键字，防止内部实现泄露给用户/agent |

### 1.3 设计原则

- **最小改动**：用 helper 函数抽象文件操作，不重写整个工具函数
- **信息隔离**：错误信息不暴露沙箱内部细节（"sandbox" 字样全部去除）
- **路径透明**：`toSandboxPath`/`toHostPath` 自动转换，工具层只操作宿主路径

---

## 二、测试环境

```bash
# Docker 容器运行 opencode-saas
# PG: 172.18.32.14:5432
# Sandbox: 172.18.32.15:30040
# 无认证模式（不设置 OPENCODE_SERVER_PASSWORD）

# 容器内环境变量
OPENCODE_SANDBOX_ENABLED=true
OPENCODE_SANDBOX_VOLUME_TYPE=pvc
OPENCODE_SANDBOX_PVC_CLAIM=sandbox-test
OPENCODE_SANDBOX_DOMAIN=172.18.32.15:30040
OPENCODE_SANDBOX_API_KEY=H68idVYzjadx
OPENCODE_SANDBOX_IDLE_KILL_SEC=30
OPENCODE_SANDBOX_MAX_TTL_SEC=3600
```

---

## 三、路径转换单元测试

验证 `toSandboxPath` / `toHostPath` 在各种边界条件下的正确性。

**宿主工作目录**：`/app/packages/opencode`  
**沙箱工作目录**：`/workspace`

### 3.1 toSandboxPath 测试用例

| 输入 | 期望输出 | 说明 |
|---|---|---|
| `""` | `/workspace` | 空字符串 |
| `"."` | `/workspace` | 当前目录 |
| `"./"` | `/workspace/` | 当前目录带斜杠 |
| `/app/packages/opencode` | `/workspace` | 工作目录本身 |
| `/app/packages/opencode/` | `/workspace/` | 工作目录带斜杠 |
| `/app/packages/opencode/src/main.ts` | `/workspace/src/main.ts` | 正常子路径 |
| `src/main.ts` | `/workspace/src/main.ts` | 相对路径 |
| `./src/main.ts` | `/workspace/src/main.ts` | ./ 相对路径 |
| `/tmp/other` | `/tmp/other` | 工作目录外的绝对路径 |
| `/etc/passwd` | `/etc/passwd` | 系统路径 |
| `/app/packages/opencode/a/b/c/d/e/f/g.txt` | `/workspace/a/b/c/d/e/f/g.txt` | 深层嵌套 |
| `/app/packages/opencode/.hidden` | `/workspace/.hidden` | 隐藏文件 |
| `/app/packages/opencode/dir with space/file.ts` | `/workspace/dir with space/file.ts` | 空格路径 |
| `file.ts` | `/workspace/file.ts` | 裸文件名 |

### 3.2 toHostPath 测试用例

| 输入 | 期望输出 | 说明 |
|---|---|---|
| `""` | `/app/packages/opencode` | 空字符串 |
| `/workspace` | `/app/packages/opencode` | 沙箱根 |
| `/workspace/src/a.ts` | `/app/packages/opencode/src/a.ts` | 正常路径 |
| `/tmp/outside` | `/tmp/outside` | 沙箱外路径 |
| `/workspace/a/b/c` | `/app/packages/opencode/a/b/c` | 深层路径 |

### 3.3 往返一致性

```
/app/packages/opencode/src/tool/apply_patch.ts
  → /workspace/src/tool/apply_patch.ts
  → /app/packages/opencode/src/tool/apply_patch.ts  ✅
```

### 3.4 运行方式

```bash
# 在 opencode-saas 容器内执行
docker exec -i opencode-saas bun run -e '<测试脚本>'
```

---

## 四、apply_patch 沙箱操作边界测试

通过沙箱 SDK 直接测试文件操作 helper 函数覆盖的场景。

| # | 测试场景 | 方法 | 期望结果 |
|---|---|---|---|
| T1 | 空文件 | `writeFiles` + `readFile` | 读写 `""` 一致 |
| T2 | 大文件 100KB | `writeFiles` + `readFile` | 读写 100001 字节一致 |
| T3 | Unicode/中文内容 | `writeFiles` + `readFile` | 读写 `你好世界 🌍 café` 一致 |
| T4 | 文件名含空格 | `writeFiles` + `readFile` | `dir with spaces/file name.txt` 读写一致 |
| T5 | 深层嵌套 10 层 | `writeFiles` + `readFile` | `a/b/c/d/e/f/g/h/i/j/deep.txt` 读写一致 |
| T6 | 覆盖已存在文件 | 两次 `writeFiles` | 第二次写入覆盖第一次 |
| T7 | stat 存在性检测 | `readFile` .then/catch | 已存在 → true，不存在 → false |
| T8 | 删除文件 | `rm -f` + `readFile` | 删除前存在，删除后不存在 |
| T9 | 删除不存在的文件 | `rm -f` | exitCode=0，不报错 |
| T10 | 移动文件 | `mv` + `readFile` | 目标内容正确，源文件不存在 |
| T11 | 批量写入 20 文件 | `writeFiles` 批量 | 第 20 个文件内容正确 |
| T12 | 只含换行的文件 | `writeFiles` + `readFile` | `\n\n\n` 读写一致 |
| T13 | 路径转换后操作 | `toSandboxPath` + `writeFiles` | 转换后路径读写正确 |
| T14 | 无换行结尾 | `writeFiles` + `readFile` | `no newline` 读写一致 |
| T15 | 代码片段（引号/正则） | `writeFiles` + `readFile` | 含 `"` `/regex/g` `${x}` 的内容读写一致 |

---

## 五、ls 沙箱分支边界测试

模拟 `ls.ts` 沙箱分支的路径转换和结果处理逻辑。

| # | 测试场景 | 方法 | 期望结果 |
|---|---|---|---|
| T1 | 空目录 | `find` 空目录 | 返回 0 文件，不截断 |
| T2 | 超过 LIMIT (100) | 创建 110 个文件 | 返回 100 文件，truncated=true |
| T3 | 深层嵌套 | 10 层嵌套文件 | 找到全部文件，路径为宿主前缀 |
| T4 | 隐藏文件 | `.hidden` + `visible.txt` | 隐藏文件全部找到 |
| T5 | 项目根列表 | 根目录文件 | 返回所有根目录文件 |
| T6 | 不存在的目录 | `find` 不存在路径 | 返回空，不截断 |
| T7 | 带空格的目录 | `space dir/space file.txt` | 找到 1 文件，路径正确 |
| T8 | 混合文件类型 | ts/css/json/md/sh/binary | 找到全部 6 文件 |
| T9 | toHostPath + relative 逻辑 | `toHostPath` + `path.relative` | 相对路径不以 `/` 开头 |
| T10 | Unicode 文件名 | `中文.ts` / `日本語.ts` | 找到 2 文件，含中文文件名 |

---

## 六、并发与压力测试

| # | 测试场景 | 方法 | 期望结果 |
|---|---|---|---|
| T1 | 并发写入 10 个文件 | `Promise.all(writeFiles)` | 10 个文件全部内容正确 |
| T2 | 并发读取 | `Promise.all(readFile)` × 10 | 10 次读取结果一致 |
| T3 | 写入后立即删除 | `writeFiles` + `rm -f` | 删除成功 |
| T4 | 写-读-覆盖循环 5 次 | 循环 write → read → overwrite | 每次读回最新内容 |
| T5 | 批量写入 50 + 批量删除 | `writeFiles` × 50 + `rm -rf` | 批量删除后文件不存在 |
| T6 | 100 个路径转换一致性 | `toSandboxPath` × 100 | 全部与期望一致 |
| T7 | 命令执行 | `sleep 0.1 && echo done` | 正常完成 |
| T8 | 二进制内容 | 256 字节全字符 | 读写一致 |
| T9 | 同名文件不同目录 | `a/index.ts` / `b/index.ts` / `c/index.ts` | 各自内容独立正确 |
| T10 | 超长单行 50K | 50000 个 `a` | 读写一致 |

---

## 七、SaaS API 端到端测试

通过 HTTP API 创建 session，让 AI agent 自主调用工具，验证：

1. 工具操作确实在沙箱中执行
2. 错误信息不泄露 "sandbox" 关键字
3. 各工具类型均正常工作

### 7.1 测试流程

```bash
BASE="http://localhost:4096"

# 1. 健康检查
curl $BASE/global/health

# 2. 创建 session
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' \
  -d '{}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

# 3. 发送消息（触发工具调用）
curl -s -X POST $BASE/session/$SID/message \
  -H 'Content-Type: application/json' \
  -d '{
    "parts": [{"type":"text","text":"使用 bash 克隆仓库并查看项目结构"}],
    "model": {"providerID":"deepseek","modelID":"deepseek-chat"}
  }'

# 4. 检查所有消息中工具输出的 sandbox 泄露
curl -s $BASE/session/$SID/message | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
leaks = []
total = 0
for m in msgs:
    for p in m.get('parts', []):
        if p.get('type') == 'tool':
            total += 1
            out = p.get('state',{}).get('output','') or ''
            if 'sandbox' in out.lower():
                leaks.append((p.get('tool'), out[:100]))
        elif p.get('type') == 'text':
            t = p.get('text','')
            if 'sandbox' in t.lower():
                leaks.append(('text', t[:100]))
print(f'工具调用: {total}, 泄露: {len(leaks)}')
"
```

### 7.2 环境隔离验证

让 agent 通过 bash 工具检查自身运行环境：

```bash
curl -s -X POST $BASE/session/$SID/message \
  -H 'Content-Type: application/json' \
  -d '{
    "parts": [{"type":"text","text":"使用 bash 工具依次执行：hostname、ls /app、env | grep OPENCODE、ps aux | grep opencode"}],
    "model": {"providerID":"deepseek","modelID":"deepseek-chat"}
  }'
```

**验证点**：

| 检查项 | opencode-saas 服务器 | 沙箱容器 | 期望结果 |
|---|---|---|---|
| hostname | 容器名 | UUID 格式 | UUID 格式 ✅ |
| `/app` 目录 | 存在（含代码） | 不存在 | `NO_APP_DIR` ✅ |
| `OPENCODE_*` 环境变量 | 大量 | 无 | `NO_OPENCODE_ENV` ✅ |
| opencode 进程 | 存在 | 无 | `NO_OPENCODE_PROCESS` ✅ |
| `/workspace` 目录 | 不存在 | 存在 | 存在 ✅ |

### 7.3 测试覆盖的工具类型

| 工具 | 测试场景 | 验证点 |
|---|---|---|
| `bash` | apt 安装 git、git clone | 沙箱内命令执行正常 |
| `read` | 读取 package.json、tsconfig、less | 沙箱文件读取正常 |
| `write` | 创建新文件 | 沙箱文件写入正常 |
| `edit` | 修改文件内容 | 沙箱文件编辑正常 |
| `list` | 列出目录结构 | 沙箱目录列表正常 |
| `glob` | 搜索 .tsx 文件 | 沙箱文件搜索正常 |
| `grep` | 搜索 import 语句 | 沙箱内容搜索正常 |

---

## 八、错误信息泄露检查

### 8.1 改动清单

| 文件 | 原错误信息 | 新错误信息 |
|---|---|---|
| `apply_patch.ts` | `File not found in sandbox: xxx` | `File not found: xxx` |
| `apply_patch.ts` | `Sandbox write failed: ...` | `Failed to write file: xxx` |
| `read.ts` | `File not found in sandbox: xxx` | `File not found: xxx` |
| `read.ts` | `Timeout reading file in sandbox: xxx` | `Timeout reading file: xxx` |
| `read.ts` | `Failed to check path type in sandbox: ...` | `Failed to check path type: ...` |
| `edit.ts` (×2) | `Sandbox write failed: ...` | `Failed to write file: xxx` |
| `write.ts` | `Sandbox write failed: ...` | `Failed to write file: xxx` |
| `bash.ts` | `sandbox init failed: ...` | `Initialization failed: ...` |

### 8.2 验证方法

```bash
# 搜索所有工具文件中暴露给用户的错误信息
grep -rn "new Error.*[Ss]andbox" packages/opencode/src/tool/{bash,edit,write,read,grep,ls,apply_patch,glob}.ts

# 期望输出为空（无匹配）
```

---

## 九、测试结果汇总

### 9.1 路径转换单元测试

| 类别 | 用例数 | 通过 | 失败 |
|---|---|---|---|
| toSandboxPath | 15 | 15 | 0 |
| toHostPath | 5 | 5 | 0 |
| 往返一致性 | 3 | 3 | 0 |
| **小计** | **23** | **23** | **0** |

### 9.2 apply_patch 边界测试

| 类别 | 用例数 | 通过 | 失败 |
|---|---|---|---|
| 文件读写操作 | 19 | 19 | 0 |

### 9.3 ls 边界测试

| 类别 | 用例数 | 通过 | 失败 |
|---|---|---|---|
| 目录列表操作 | 25 | 25 | 0 |

### 9.4 并发/压力测试

| 类别 | 用例数 | 通过 | 失败 |
|---|---|---|---|
| 并发与压力 | 10 | 10 | 0 |

### 9.5 SaaS API 端到端测试

| Session | 工具调用 | 工具分布 | sandbox 泄露 |
|---|---|---|---|
| 主测试 | 36 | bash:7, read:20, glob:5, write:1, edit:1, grep:2 | 0 |
| 补充测试 | 23 | read:12, bash:6, write:1, edit:1, grep:3 | 0 |
| patch 测试 | 4 | bash:2, read:1, edit:1 | 0 |
| **总计** | **63** | **6 种工具** | **0** |

### 9.6 总计

| 测试类别 | 用例数 | 通过 | 失败 |
|---|---|---|---|
| 路径转换 | 23 | 23 | 0 |
| apply_patch 边界 | 19 | 19 | 0 |
| ls 边界 | 25 | 25 | 0 |
| 并发/压力 | 10 | 10 | 0 |
| API 端到端 | 63 次工具调用 | 63 | 0 |
| **总计** | **140+** | **140+** | **0** |

---

## 十、复测验证（2026-05-30）

> 本次复测重点验证错误信息泄露和沙箱隔离的当前状态。

### 10.1 错误信息泄露静态检查

```bash
grep -rn "new Error.*[Ss]andbox" packages/opencode/src/tool/{bash,edit,write,read,grep,ls,apply_patch,glob}.ts
```

| 文件 | 发现 | 处理 |
|------|------|------|
| read.ts:61 | `Failed to get sandbox: ...` | ✅ 已修复为 `Initialization failed: ...` |
| edit.ts:67 | `new Error(String(e))` | ✅ 不含 sandbox 文本（`Sandbox` 仅类型注解/变量名） |
| 其余工具文件 | 无 | ✅ clean |

> **注**：`sandbox-provider.ts:171/627` 的 `Sandbox.create failed` 属基础设施层（非文档 8.2 工具文件范围），仅在 sandbox 完全不可达时出现，不算正常工具操作泄露。

### 10.2 沙箱隔离验证（7.2）

通过 AI bash 工具执行 `hostname; ls /app; env|grep OPENCODE; ls /workspace`：

| 检查项 | 实际结果 | 期望 | 状态 |
|--------|---------|------|------|
| hostname | `9e2df9f6-d3ae-...`（UUID） | UUID 格式 | ✅ |
| `/app` | `No such file or directory` → NO_APP_DIR | 不存在 | ✅ |
| `/workspace` | 存在 | 存在 | ✅ |

### 10.3 运行时泄露检查（7.1，PG 验证）

```sql
SELECT COUNT(*) FILTER (WHERE lower(output||error) LIKE '%sandbox%') as leaks
FROM part WHERE type='tool';
```
结果：**0 泄露 / 1 tool 调用**（bash completed, clean）

### 10.4 环境问题记录

复测期间发现 sandbox 转发（宿主机 :30040 → 172.18.32.15:30040）断开，导致首次 bash 报 `Sandbox.create failed: Unable to connect`。重启转发后恢复正常。转发命令见 `local-test-env.md`。

---

## 十一、Shell 执行性能优化测试（2026-06-23）

> 对应提交 `fix(tool): unblock concurrent bash commands and harden sandbox shell execution`

### 11.0 背景

`sandbox-provider.ts` 的 `runInSession` 存在三个性能/稳定性问题：

| 问题 | 根因 | 影响 |
|---|---|---|
| **P0** 锁范围过大 | `commandSemaphores` permits=1 包裹了 `dbGet + createSession + runInSession` | 同一 session 的所有 bash 命令**完全串行**；LLM 一轮回复中并发提交的多个 bash 调用排队等待 |
| **P1** 无超时保护 | `runInSession` 内部调用 `getOrCreateUnlocked` 绕过了外层 `getOrCreate` 的 90s 超时 | 缓存过期后 reconnect 网络挂起时**无限期阻塞**，sem permits=1 导致后续所有命令被永久排队 |
| **P2** 缓存 TTL 过短 | `SB_CACHE_TTL_MS = 30_000`（30 秒） | 持续执行 bash 时每分钟至少触发 2 次完整 reconnect（`Sandbox.connect` + `isHealthy`），无谓网络开销 |

### 11.1 通用变量

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

# 启动容器时务必加 --print-logs 才能看到 log.info 输出
# docker run ... opencode-saas-sandbox-test:v2fix serve --hostname 0.0.0.0 --port 4096 --print-logs --pure
```

---

### T18.S1 并发 bash 命令不再串行化（P0 核心验证）

**验证点**：`runInSession` 的 `commandSemaphores` 锁范围缩小到只保护 `createSession`（带双重检查），`runInSession` 命令执行移到锁外。同一 session 的多个 bash 命令可以并发执行，不再因 permits=1 排队。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# warmup 沙箱（确保后续 exec 不含建沙箱时间）
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo warmup"}' >/dev/null
echo "warmup 完成"

# 3 个并发 exec 命令（每个 sleep 2s）
START=$(date +%s%N)
for i in 1 2 3; do
  curl -s -X POST "$BASE/session/$SID/exec" \
    -H 'Content-Type: application/json' \
    -d "{\"command\":\"sleep 2 && echo cmd-$i-done\"}" >/dev/null &
done
wait
END=$(date +%s%N)
TOTAL_MS=$(( (END - START) / 1000000 ))
echo "3 个并发（各 sleep 2s）总耗时: ${TOTAL_MS}ms"

# 判定
if [ "$TOTAL_MS" -lt 5000 ]; then
  echo "✅ T18.S1 PASS: 并发执行（${TOTAL_MS}ms ≈ 单命令耗时）"
elif [ "$TOTAL_MS" -lt 8000 ]; then
  echo "⚠️ T18.S1 WARN: 部分串行"
else
  echo "❌ T18.S1 FAIL: 仍然串行（${TOTAL_MS}ms ≈ 3x 单命令）"
fi
```

**期望**：
- 修复前：~6000ms（3 × 2s 串行）
- 修复后：< 5000ms（3 个并发 ≈ 2s + 少量 overhead）
- 容器日志只有 1 次 createSession（复用 command session）

---

### T18.S2 createSession 双重检查（P0 并发安全）

**验证点**：并发请求发现 `command_session_id=null` 时，只有一个请求执行 `createSession`，其余通过双重检查（sem 内二次查 DB）复用已创建的 session。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# warmup 建 sandbox 但不建 command session（用 file API 而非 bash）
curl -s -o /dev/null "$BASE/file/content?path=/workspace&sessionID=$SID&directory=/workspace"
echo "warmup（file API，未触发 createSession）"

# 并发发 3 个 bash 命令 — 都会发现 command_session_id=null，竞争 createSession
for i in 1 2 3; do
  curl -s -X POST "$BASE/session/$SID/exec" \
    -H 'Content-Type: application/json' \
    -d "{\"command\":\"echo concurrent-$i\"}" &
done
wait
echo "3 个并发 bash 完成"

# 验证日志只有 1 次 createSession
echo "--- 容器日志 ---"
docker logs opencode-saas-test 2>&1 | grep "createSession\|createSession done\|commands.createSession" | grep "$SID" | tail -5

# 验证 DB 中只有 1 个 command_session_id
COUNT=$(psql "$PG_URL" -t -c "SELECT count(*) FROM sandbox WHERE session_id='$SID' AND command_session_id IS NOT NULL" | tr -d '[:space:]')
echo "DB command_session_id 记录数: $COUNT"
if [ "$COUNT" = "1" ]; then
  echo "✅ T18.S2 PASS: 只创建了 1 个 command session"
else
  echo "❌ T18.S2 FAIL: command session 数量异常 ($COUNT)"
fi
```

**期望**：
- 容器日志只出现 1 次 `createSession`
- DB 中 `command_session_id` 只有 1 条非空记录
- 3 个 bash 命令全部成功（exitCode=0）

---

### T18.S3 runInSession getOrCreate 超时保护（P1）

**验证点**：缓存过期后 `getOrCreateUnlocked` 挂起时，30s 超时生效，不会无限阻塞后续命令。

```bash
# 此用例需要模拟"沙箱不可达 + 缓存过期"场景
docker rm -f opencode-saas-test-timeout 2>/dev/null
docker run -d --name opencode-saas-test-timeout \
  -p 14097:4096 \
  -e OPENCODE_DATABASE_URL=postgresql://ruomu@host.docker.internal:5432/opencode \
  -e OPENCODE_AUTH_PROVIDER=pg \
  -e OPENCODE_SANDBOX_DOMAIN=host.docker.internal:39999 \
  -e OPENCODE_SANDBOX_USE_SERVER_PROXY=true \
  opencode-saas-sandbox-test:v2fix \
  serve --hostname 0.0.0.0 --port 4096 --print-logs --pure
sleep 10

SID=$(curl -s -X POST "http://localhost:14097/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

START=$(date +%s)
RESP=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 60 \
  "http://localhost:14097/file/content?path=/workspace&sessionID=$SID&directory=/workspace")
END=$(date +%s)
ELAPSED=$((END - START))
echo "首次 file API: $RESP, 耗时: ${ELAPSED}s"

# 缓存已写入但沙箱不可达 → 触发 runInSession 内部的 getOrCreateUnlocked
START2=$(date +%s)
RESP2=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 60 \
  "http://localhost:14097/session/$SID/exec" \
  -H 'Content-Type: application/json' -d '{"command":"echo test"}')
END2=$(date +%s)
ELAPSED2=$((END2 - START2))
echo "exec（缓存 miss，getOrCreateUnlocked）: $RESP2, 耗时: ${ELAPSED2}s"

if [ "$ELAPSED2" -lt 45 ]; then
  echo "✅ T18.S3 PASS: 在 30s 超时内返回（${ELAPSED2}s）"
else
  echo "❌ T18.S3 FAIL: 超时未生效（${ELAPSED2}s）"
fi

docker logs opencode-saas-test-timeout 2>&1 | grep -iE "getOrCreate|timeout" | tail -5
docker rm -f opencode-saas-test-timeout >/dev/null
```

**期望**：
- exec 请求在 30-35s 内返回错误（非 200）
- 容器日志含 `getOrCreate timeout after 30s` 或连接失败错误
- 修复前：无限期阻塞（TCP 默认超时可达 300s+）

---

### T18.S4 sbCache TTL 延长 — 5 分钟内无 reconnect（P2）

**验证点**：缓存 TTL 从 30s 延长到 300s（5 分钟），持续执行命令时不再每 30s 触发 reconnect。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 首次建沙箱 + 命令 session
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo initial"}' >/dev/null
echo "首次 exec 完成"

# 在 5 分钟内每 20s 执行一次命令，观察是否有 reconnect
for i in $(seq 1 6); do
  sleep 20
  curl -s -X POST "$BASE/session/$SID/exec" \
    -H 'Content-Type: application/json' \
    -d "{\"command\":\"echo tick-$i\"}" >/dev/null
  echo "  [${i}00s] exec 完成"
done

echo "--- reconnect 日志（期望为空或仅首次）---"
docker logs opencode-saas-test 2>&1 | grep "reconnect done" | grep "$SID" | tail -5

# 统计 getOrCreate 调用次数（期望 1 次 — 首次建沙箱）
RECONNECT_COUNT=$(docker logs opencode-saas-test 2>&1 | grep "getOrCreate done" | grep -c "$SID")
echo "getOrCreate done 次数: $RECONNECT_COUNT"

if [ "$RECONNECT_COUNT" -le 1 ]; then
  echo "✅ T18.S4 PASS: 2 分钟内无多余 reconnect（TTL=300s 生效）"
else
  echo "❌ T18.S4 FAIL: 出现 $RECONNECT_COUNT 次 getOrCreate（TTL 可能未生效）"
fi
```

**期望**：
- 2 分钟内 7 次 exec，`getOrCreate done` 日志只有 1 次（首次建沙箱）
- `reconnect done` 日志为空
- 修复前（TTL=30s）：2 分钟内至少触发 4 次 getOrCreate（每 30s 过期一次）

---

### T18.S5 交叉对比 — read（无锁）vs bash（优化后）延迟

**验证点**：bash 工具经过 `runInSession` 路径优化后，延迟应接近 read 工具（直接文件 API），不再因锁排队导致数量级差异。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# warmup
curl -s -o /dev/null "$BASE/file/content?path=/workspace&sessionID=$SID&directory=/workspace"

# read 延迟（file API，无锁）
T_READ=0
for i in 1 2 3; do
  T=$(curl -s -o /dev/null -w '%{time_total}' --max-time 10 \
    "$BASE/file/content?path=/workspace&sessionID=$SID&directory=/workspace")
  T_READ=$(python3 -c "print(round($T_READ + $T, 3))")
done
AVG_READ=$(python3 -c "print(round($T_READ / 3, 3))")
echo "read 平均延迟: ${AVG_READ}s"

# bash 延迟（runInSession，优化后无锁 on runInSession）
T_BASH=0
for i in 1 2 3; do
  T=$(curl -s -o /dev/null -w '%{time_total}' --max-time 10 \
    -X POST "$BASE/session/$SID/exec" \
    -H 'Content-Type: application/json' -d '{"command":"ls /workspace/"}')
  T_BASH=$(python3 -c "print(round($T_BASH + $T, 3))")
done
AVG_BASH=$(python3 -c "print(round($T_BASH / 3, 3))")
echo "bash 平均延迟: ${AVG_BASH}s"

RATIO=$(python3 -c "print(round($AVG_BASH / $AVG_READ, 1)) if $AVG_READ > 0 else print('N/A')")
echo "bash/read 比值: ${RATIO}x"

if python3 -c "exit(0 if $AVG_BASH < 2.0 else 1)"; then
  echo "✅ T18.S5 PASS: bash 延迟正常（${AVG_BASH}s）"
else
  echo "❌ T18.S5 FAIL: bash 延迟过高（${AVG_BASH}s）"
fi
```

**期望**：
- read 平均延迟 < 0.3s（文件 API，无 SSE 开销）
- bash 平均延迟 < 2.0s（含 SSE 流建立 + 命令执行 + 流关闭）
- bash/read 比值 < 10x（修复前因锁排队可达 100x+）

---

### 11.x 排查对照表

| 现象 | 可能原因 | 验证用例 | 日志关键字 |
|---|---|---|---|
| 并发 bash 命令排队等待 | sem permits=1 锁范围过大 | T18.S1 | `getOrCreate start` 多次出现（应只有 1 次）|
| createSession 重复创建 | 双重检查未生效 | T18.S2 | `createSession` 出现多次 |
| bash 命令永久卡住 | getOrCreateUnlocked 无超时 | T18.S3 | `getOrCreate timeout after 30s` |
| 持续命令执行中频繁重连 | sbCache TTL 过短 | T18.S4 | `reconnect done` 频繁出现 |
| bash 比 read 慢 100x | 锁串行化 + SSE 延迟叠加 | T18.S5 | 对比 read/bash 各自延迟 |

---

## 十二、SSE 早退优化测试（2026-06-23）

> 对应改动：`sandbox-provider.ts` 新增 `runCommandEarlyExit`，用 `runInSessionStream` 替代 `runInSession`

### 12.0 背景

SDK 的 `consumeExecutionStream` 在收到 `execution_complete` 事件后**继续 `reader.read()` 等 SSE 流关闭**。本地单层 proxy 环境下 gap ~1 秒，远端 K8s + `useServerProxy=true` 多层 proxy 下 gap 被放大到 **60-3539 秒**（ingress idle timeout）。

**根因链**：

```
execd 执行 ls (<1s) → 发送 execution_complete → SDK 不 break
  → reader.read() 等 HTTP 连接关闭
  → K8s ingress idle timeout (60-300s) 才关闭
  → Promise resolve → 总耗时 60-3539s
```

**修复**：新增 `runCommandEarlyExit` 函数，用 SDK 的 `runInSessionStream` 获取事件流，收到 `execution_complete` 或 `error` 后**立即返回**，不等待 SSE 流关闭。exitCode 按 SDK 原始逻辑推断（有 error → 解析 value 数字；有 complete 无 error → 0）。

### 12.1 通用变量

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
```

---

### T18.E1 bash 命令延迟大幅下降（SSE 早退核心验证）

**验证点**：所有通过 `runInSession` 执行的 bash 命令不再等待 SSE 流关闭，延迟降至命令本身执行时间。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# warmup
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -d '{"command":"echo warmup"}' >/dev/null

# 5 种不同命令的延迟
echo "--- bash 命令延迟 ---"
for cmd in "ls /workspace/" "echo hello" "cat /workspace/package.json | head -5" "pwd" "whoami"; do
  T=$(curl -s -o /dev/null -w '%{time_total}' --max-time 10 \
    -X POST "$BASE/session/$SID/exec" \
    -H 'Content-Type: application/json' -d "{\"command\":\"$cmd\"}")
  printf "  %-45s %ss\n" "$cmd" "$T"
done
```

**期望**：
- 本地环境（单层 proxy）：每条命令 < 0.2s（修复前 ~1s）
- 远端 K8s 环境（多层 proxy）：每条命令 < 1s（修复前 60-3539s）
- 速度提升 > 10x（本地）或 > 100x（远端）

---

### T18.E2 exitCode 推断正确性（成功/失败/命令不存在）

**验证点**：`runCommandEarlyExit` 在 `execution_complete` 或 `error` 事件时推断的 exitCode 与 SDK 原始行为完全一致。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# warmup
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -d '{"command":"echo warmup"}' >/dev/null

echo "--- exitCode 验证 ---"
# 成功 (exit 0)
R0=$(curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"ls /workspace/"}' | python3 -c "import json,sys;print(json.load(sys.stdin).get('exitCode'))")
echo "  ls /workspace/      exit=$R0  expect=0  $([ '$R0' = '0' ] && echo '✅' || echo '❌')"

# 失败 exit 42
R42=$(curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"exit 42"}' | python3 -c "import json,sys;print(json.load(sys.stdin).get('exitCode'))")
echo "  exit 42             exit=$R42  expect=42 $([ '$R42' = '42' ] && echo '✅' || echo '❌')"

# 命令不存在 exit 127
R127=$(curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"nonexistent-cmd-xyz"}' | python3 -c "import json,sys;print(json.load(sys.stdin).get('exitCode'))")
echo "  nonexistent-cmd     exit=$R127 expect=127 $([ '$R127' = '127' ] && echo '✅' || echo '❌')"
```

**期望**：
- `ls /workspace/` → exitCode=0 ✅
- `exit 42` → exitCode=42 ✅（从 error.value 解析）
- `nonexistent-cmd-xyz` → exitCode=127 ✅（command not found 的标准码）
- 推断逻辑：有 error → `/^-?\d+$/` 匹配 error.value；有 complete 无 error → 0

---

### T18.E3 stdout/stderr 输出完整性

**验证点**：早退不影响输出数据收集 —— 所有 stdout/stderr 事件在 `execution_complete` 之前发送。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# warmup
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -d '{"command":"echo warmup"}' >/dev/null

# 多行 stdout
echo "--- 多行 stdout ---"
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"echo line1 && echo line2 && echo line3"}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);lines=d.get('stdout','').strip().split('\n');print(f'  行数: {len(lines)} (期望 3)');[print(f'  {l}') for l in lines]"

# stderr 混合
echo "--- stderr 混合 ---"
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"echo to-stdout && echo to-stderr >&2"}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(f'  stdout: {d.get(\"stdout\",\"\").strip()}');print(f'  stderr: {d.get(\"stderr\",\"\").strip()}')"
```

**期望**：
- 多行 stdout：完整 3 行，无截断
- stderr 混合：stdout 含 "to-stdout"，stderr 含 "to-stderr"
- 输出内容与 SDK 原始 `runInSession` 完全一致

---

### T18.E4 并发 bash 命令不受 SSE 等待影响

**验证点**：多个并发 bash 命令各自独立早退，不因 SSE 流等待而串行排队。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# warmup
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -d '{"command":"echo warmup"}' >/dev/null

# 3 个并发 ls
echo "--- 3 个并发 bash ---"
START=$(date +%s%N)
for i in 1 2 3; do
  curl -s -o /dev/null -w "  #$i: %{time_total}s\n" --max-time 10 \
    -X POST "$BASE/session/$SID/exec" \
    -H 'Content-Type: application/json' -d '{"command":"ls /workspace/src/"}' &
done
wait
END=$(date +%s%N)
TOTAL_MS=$(( (END - START) / 1000000 ))
echo "  总耗时: ${TOTAL_MS}ms"

if [ "$TOTAL_MS" -lt 1000 ]; then
  echo "✅ T18.E4 PASS: 并发执行（${TOTAL_MS}ms）"
else
  echo "❌ T18.E4 FAIL: 可能仍串行（${TOTAL_MS}ms）"
fi
```

**期望**：
- 3 个并发 ls 总耗时 < 500ms（每个 ~50-150ms，并发执行）
- 不出现串行排队（修复前 + SSE gap 可达 180-900s）

---

### T18.E5 SDK 直接 A/B 对比（runInSession vs runInSessionStream 早退）

**验证点**：直接用 SDK 对比 `run()`（等 SSE 关闭）和 `runStream() + early exit`（收到 complete 立即返回），量化 SSE gap。

```typescript
// 在 packages/opencode 目录下运行：bun verify-sse-ab.ts
import { Sandbox, ConnectionConfig } from "@alibaba-group/opensandbox"

const cfg = new ConnectionConfig({
  domain: "localhost:8080",
  protocol: "http",
  useServerProxy: true,
})

const sb = await Sandbox.create({ connectionConfig: cfg, image: "opencode-opensandbox:local", timeoutSeconds: 120 })
console.log("sandbox:", sb.id)

const CMD = "ls /workspace/"

// A: SDK run()（等 SSE 流关闭）
console.log("\n=== A: run()（SDK 原始）===")
for (let i = 1; i <= 3; i++) {
  let completeAt = 0
  const t0 = Date.now()
  await sb.commands.run(CMD, { timeoutSeconds: 30 }, {
    onExecutionComplete: () => { completeAt = Date.now() - t0 },
  })
  const resolvedAt = Date.now() - t0
  console.log(`  #${i}: complete=${completeAt}ms  resolved=${resolvedAt}ms  gap=${resolvedAt - completeAt}ms`)
}

// B: runStream() + 早退
console.log("\n=== B: runStream() + early exit ===")
for (let i = 1; i <= 3; i++) {
  const t0 = Date.now()
  for await (const ev of sb.commands.runStream(CMD, { timeoutSeconds: 30 })) {
    if (ev.type === "execution_complete" || ev.type === "error") break
  }
  console.log(`  #${i}: returned=${Date.now() - t0}ms`)
}

await sb.kill().catch(() => {})
await sb.close().catch(() => {})
```

```bash
cd /Users/ruomu/code/opencode/packages/opencode
bun verify-sse-ab.ts
```

**期望**：
- A 组 `gap` > 500ms（SSE 流等待）
- B 组 `returned` ≈ A 组 `complete`（命令执行时间，无等待）
- 比值 A/B > 10x（本地单层 proxy）；远端 K8s 环境 > 100x

> **注**：本地环境 SSE gap ~1 秒，远端 K8s + `useServerProxy=true` 多层 proxy 环境 gap 60-300 秒。

---

### T18.E6 远端 K8s 环境验证（部署后回归）

**验证点**：部署新镜像到远端 SaaS 后，确认 `ls` 等快命令从 92-3539 秒降至 <1 秒。

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
BASE="http://<远端 SaaS 地址>"

# 1. 通过 AI 消息触发 ls 命令
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 执行 ls /workspace/src/"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  | python3 -c "import json,sys;[print(p['text'][:100]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"

# 2. 从 PG 查询该 bash part 的耗时
psql "$PG_URL" -c "
SELECT p.data->>'tool' as tool,
  p.data->'state'->>'status' as status,
  ((p.data->'state'->'time'->>'end')::bigint - (p.data->'state'->'time'->>'start')::bigint)/1000 as dur_s,
  substring(p.data->'state'->'input'->>'command',1,50) as cmd
FROM part p WHERE p.session_id='$SID' AND p.data->>'tool'='bash'
ORDER BY p.time_created DESC LIMIT 5;"

# 3. 判定
DUR=$(psql "$PG_URL" -t -c "
SELECT ((p.data->'state'->'time'->>'end')::bigint - (p.data->'state'->'time'->>'start')::bigint)/1000
FROM part p WHERE p.session_id='$SID' AND p.data->'state'->'input'->>'command' LIKE 'ls %'
ORDER BY p.time_created DESC LIMIT 1" | tr -d '[:space:]')

if [ "$DUR" -lt 5 ]; then
  echo "✅ T18.E6 PASS: ls 命令 ${DUR}s（< 5s，SSE 早退生效）"
else
  echo "❌ T18.E6 FAIL: ls 命令 ${DUR}s（仍然慢，SSE 早退可能未生效）"
fi
```

**期望**：
- 修复前：`ls` 命令 92-3539 秒
- 修复后：`ls` 命令 < 5 秒
- exitCode 正确（0 表示成功）
- stdout 完整（包含目录列表）

---

### 12.x 排查对照表（SSE 早退补充）

| 现象 | 可能原因 | 验证用例 | 日志关键字 |
|---|---|---|---|
| bash 命令 >60s 但 read 正常 | SSE 流不关闭（ingress idle timeout）| T18.E1, T18.E5 | 无错误日志，只是耗时长 |
| exitCode=null 导致误判超时 | 早退推断逻辑缺失 | T18.E2 | `metadata.exit=null` |
| stdout 截断或丢失 | 早退过早 break | T18.E3 | 输出行数少于预期 |
| 并发 bash 总耗时 = N × 单命令 | SSE 流串行化（未修复时）| T18.E4 | 3 个并发 ~3x 单命令耗时 |
| runInSessionStream 不存在 | SDK 版本过低 | T18.E5 | `runInSessionStream is not a function` |
