# 沙箱与 PVC 持久化

> 公共测试环境和配置请参考 [`00-preamble.md`](./00-preamble.md)。

### 通用变量

```bash
BASE="http://localhost:14096"
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
