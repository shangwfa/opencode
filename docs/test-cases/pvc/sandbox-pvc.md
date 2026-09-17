# 沙箱与 PVC 持久化

> 公共测试环境和配置请参考 [`00-preamble.md`](./00-preamble.md)。

### 通用变量

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s -X POST "$BASE/session/$SID/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":true}' >/dev/null
echo "SID: $SID"
```

## 五、沙箱与 PVC 持久化

### T5.1 创建沙箱写入文件

```bash
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo 12345 > /workspace/pvc-test.txt && cat /workspace/pvc-test.txt"}'
```

**期望**：exec 返回 `exitCode=0`，stdout 含 `12345`

### T5.2 销毁沙箱

```bash
curl -s -X POST "$BASE/session/$SID/kill-sandbox"
```

**期望**：返回 `{"destroyed":true}`，沙箱容器被删除

### T5.3 重建沙箱后文件仍存在（核心 PVC 测试）

```bash
# kill-sandbox 后，下次 exec 会自动重建沙箱（使用同一 PVC）
sleep 3
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/pvc-test.txt"}'
```

**期望**：stdout 含 `12345`，证明 PVC 跨沙箱实例持久化

### T5.4 多文件批量持久化

```bash
# 创建三个文件
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo A > /workspace/a.txt && echo B > /workspace/b.txt && echo C > /workspace/c.txt"}'

# 销毁沙箱
curl -s -X POST "$BASE/session/$SID/kill-sandbox"
sleep 3

# 验证三个文件都在
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"for f in a.txt b.txt c.txt; do echo \"$f: $(cat /workspace/$f)\"; done"}'
```

**期望**：三个文件内容均在（A、B、C），证明 PVC 批量持久化

### T5.5 目录持久化

```bash
# 创建深层目录
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/sub/deep && echo DEEP > /workspace/sub/deep/x.txt"}'

# 销毁沙箱
curl -s -X POST "$BASE/session/$SID/kill-sandbox"
sleep 3

# 验证
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/sub/deep/x.txt"}'
```

**期望**：stdout 含 `DEEP`，证明 PVC 目录结构持久化

---

## 复测记录

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
