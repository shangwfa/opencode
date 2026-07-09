# 共享 Package Cache（pnpm）

> 公共测试环境和配置请参考 [`00-preamble.md`](./00-preamble.md)。
> 技术方案详见 [`../shared-package-cache-design.md`](../shared-package-cache-design.md)。

## 二十三、共享 Package Cache（pnpm）

> 前置条件：`OPENCODE_SANDBOX_VOLUME_TYPE=pvc`，沙箱镜像基于 Node v24 LTS，预装 `pnpm`（通过 mise 管理，默认 pnpm@10）。
>
> ```bash
> # 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
> ```

### pnpm store 使用说明

pnpm 使用 content-addressable store（`/opt/pnpm-store`，镜像层 overlay），virtual-store 在 `/tmp/pnpm-vs`（临时 overlay）。两个目录在同一 overlay 文件系统，hardlink 可用。不同 session 共享同一个 store，但各自 `/workspace/node_modules` 独立。

```bash
# 1. 创建 session + keepAlive
SID=$(new_sid -k)

# 2. pnpm install（自动使用 /opt/pnpm-store）
curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && echo {\"name\":\"test\",\"dependencies\":{\"dayjs\":\"^1.11.0\"}} > package.json && pnpm install"}'
```

---

### T23.1 pnpm store 配置验证

```bash
SID=$(new_sid -k)

curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"pnpm config get store-dir && pnpm config get virtual-store-dir && du -sh $(pnpm config get store-dir)"}'
```

**期望**：
- store-dir = `/opt/pnpm-store`
- virtual-store-dir = `/tmp/pnpm-vs`
- store 目录存在且有预装内容

---

### T23.2 首次 pnpm install

```bash
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/t2 && cd /workspace/t2 && echo {\"name\":\"t2\",\"dependencies\":{\"dayjs\":\"^1.11.0\",\"ms\":\"^2.1.0\"}} > package.json && pnpm install 2>&1 | tail -3"}'
```

**期望**：exitCode=0，dayjs 和 ms 安装成功

---

### T23.3 重装 store 命中（加速验证）

```bash
# 清空 node_modules 后重装（store 已有缓存）
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/t2 && rm -rf node_modules && pnpm install 2>&1 | tail -3"}'
```

**期望**：重装耗时应明显低于首次（store 命中，无网络下载）

---

### T23.4 跨 session 共享 store（核心验证）

```bash
SID_A=$(new_sid -k)
# Session A 安装
curl -s --max-time 60 -X POST "$BASE/session/$SID_A/exec" -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/t4 && cd /workspace/t4 && echo {\"name\":\"t4\",\"dependencies\":{\"lodash\":\"^4.17.0\"}} > package.json && pnpm install 2>&1 | tail -1"}'

SID_B=$(new_sid -k)
# Session B 安装同一包（应从共享 store 命中）
curl -s --max-time 60 -X POST "$BASE/session/$SID_B/exec" -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/t4 && cd /workspace/t4 && echo {\"name\":\"t4\",\"dependencies\":{\"lodash\":\"^4.17.0\"}} > package.json && pnpm install 2>&1 | tail -1"}'
```

**期望**：Session B install 成功，且耗时应低于 Session A（共享 store 命中）

---

### T23.5 不同 session 的 node_modules 独立

```bash
# Session A 写入标记
curl -s -X POST "$BASE/session/$SID_A/exec" -H 'Content-Type: application/json' \
  -d '{"command":"echo MARK_A > /workspace/t4/node_modules/.mark"}'

# Session B 检查无 A 的标记
curl -s -X POST "$BASE/session/$SID_B/exec" -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/t4/node_modules/.mark 2>&1"}'
```

**期望**：Session B 报 `No such file`，证明 node_modules 独立

---

### T23.6 共享 store 不被 session 销毁清理

```bash
# Session A 写入标记
curl -s -X POST "$BASE/session/$SID_A/exec" -H 'Content-Type: application/json' \
  -d '{"command":"du -sh /opt/pnpm-store"}'

# 销毁 Session A 沙箱
curl -s -X POST "$BASE/session/$SID_A/kill-sandbox"
sleep 3

# Session B 验证 store 仍在
curl -s -X POST "$BASE/session/$SID_B/exec" -H 'Content-Type: application/json' \
  -d '{"command":"du -sh /opt/pnpm-store && echo STORE_PERSISTED"}'
```

**期望**：Session B 输出 `STORE_PERSISTED`，store 大小不因 kill-sandbox 而清零

---

### T23.7 缓存命中加速对比

```bash
# 首次 install（可能从网络下载）
SID_COLD=$(new_sid -k)
START=$(python3 -c "import time;print(time.time())")
curl -s --max-time 120 -X POST "$BASE/session/$SID_COLD/exec" -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/t7 && cd /workspace/t7 && echo {\"name\":\"t7\",\"dependencies\":{\"dayjs\":\"^1.11.0\",\"ms\":\"^2.1.0\",\"lodash\":\"^4.17.0\"}} > package.json && pnpm install 2>&1 | tail -1"}'
END=$(python3 -c "import time;print(time.time())")
echo "首次: $(python3 -c "print(f'{$END-$START:.1f}s')")"

# 重装（store 命中）
START=$(python3 -c "import time;print(time.time())")
curl -s --max-time 30 -X POST "$BASE/session/$SID_COLD/exec" -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/t7 && rm -rf node_modules && pnpm install 2>&1 | tail -1"}'
END=$(python3 -c "import time;print(time.time())")
echo "重装: $(python3 -c "print(f'{$END-$START:.1f}s')")"
```

**期望**：重装耗时应低于首次（store 命中加速）

---

### T23.8 并发 pnpm install 安全性

```bash
SID1=$(new_sid -k); SID2=$(new_sid -k); SID3=$(new_sid -k)

# 3 个 session 并发 install（不同包，共享 store）
for SID_X in $SID1 $SID2 $SID3; do
  curl -s --max-time 60 -X POST "$BASE/session/$SID_X/exec" -H 'Content-Type: application/json' \
    -d '{"command":"mkdir -p /workspace/concurrent && cd /workspace/concurrent && echo {\"name\":\"c\",\"dependencies\":{\"dayjs\":\"^1.11.0\"}} > package.json && pnpm install 2>&1 | tail -1"}' &
done
wait
```

**期望**：3 个并发 install 全部 exitCode=0，store 无损坏

---

### T23.9 安装后程序能正常运行

```bash
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/t2 && node -e \"const d=require('"'"'dayjs'"'"'); console.log(d().format('"'"'YYYY'"'"'))\""}'
```

**期望**：输出当前年份（如 `2026`），证明 node_modules 安装完整、pnpm hardlink 正确

---

## 单元测试覆盖

以下 case 在单元测试中覆盖，无需 sandbox 环境：

| Case | 验证点 |
|------|--------|
| PVC mode includes shared package-cache volume | PVC 模式挂载共享 cache volume |
| volumeType=none does not mount package-cache | none 模式不挂载 |
| custom packageCacheMount | 自定义 mountPath 生效 |
| invalid packageCacheMount is rejected | 非法路径 fail-fast |

---

## 测试结果汇总

| 用例 | 结果 | 备注 |
|------|------|------|
| T23.1 pnpm store 配置 | ✅ | store=/opt/pnpm-store, vs=/tmp/pnpm-vs |
| T23.2 首次 install | ✅ | dayjs+ms |
| T23.3 重装 store 命中 | ✅ | 加速明显 |
| T23.4 跨 session 共享 | ✅ | 共享 store 命中 |
| T23.5 node_modules 独立 | ✅ | 跨 session 不可见 |
| T23.6 store 不被清理 | ✅ | kill-sandbox 后持久 |
| T23.7 加速对比 | ✅ | 首次→重装加速 |
| T23.8 并发 install | ✅ | 3 并发安全 |
| T23.9 运行验证 | ✅ | dayjs 输出年份 |
