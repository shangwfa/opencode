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
| `ls.ts` | 通过 `SandboxProvider.Service` 直接走 sandbox 路径（`rg --files` 在沙箱内搜索） |
| `shell.ts` / `edit.ts` | 错误信息去除 "sandbox" 关键字（shell.ts:106 已修）。⚠️ **`read.ts:49` 与 `write.ts:46,49` 仍含 "Sandbox is not available"/"Sandbox initialization failed"**（2026-07-18 核对未修），T20.12 的 grep 会命中这两文件 |

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
| 1 | 空文件 | `writeFiles` + `readFile` | 读写 `""` 一致 |
| 2 | 大文件 100KB | `writeFiles` + `readFile` | 读写 100001 字节一致 |
| 3 | Unicode/中文内容 | `writeFiles` + `readFile` | 读写 `你好世界 🌍 café` 一致 |
| 4 | 文件名含空格 | `writeFiles` + `readFile` | `dir with spaces/file name.txt` 读写一致 |
| 5 | 深层嵌套 10 层 | `writeFiles` + `readFile` | `a/b/c/d/e/f/g/h/i/j/deep.txt` 读写一致 |
| 6 | 覆盖已存在文件 | 两次 `writeFiles` | 第二次写入覆盖第一次 |
| 7 | stat 存在性检测 | `readFile` .then/catch | 已存在 → true，不存在 → false |
| 8 | 删除文件 | `rm -f` + `readFile` | 删除前存在，删除后不存在 |
| 9 | 删除不存在的文件 | `rm -f` | exitCode=0，不报错 |
| 10 | 移动文件 | `mv` + `readFile` | 目标内容正确，源文件不存在 |
| 11 | 批量写入 20 文件 | `writeFiles` 批量 | 第 20 个文件内容正确 |
| 12 | 只含换行的文件 | `writeFiles` + `readFile` | `\n\n\n` 读写一致 |
| 13 | 路径转换后操作 | `toSandboxPath` + `writeFiles` | 转换后路径读写正确 |
| 14 | 无换行结尾 | `writeFiles` + `readFile` | `no newline` 读写一致 |
| 15 | 代码片段（引号/正则） | `writeFiles` + `readFile` | 含 `"` `/regex/g` `${x}` 的内容读写一致 |

---

## 五、ls 沙箱分支边界测试

模拟 `ls.ts` 沙箱分支的路径转换和结果处理逻辑。

| # | 测试场景 | 方法 | 期望结果 |
|---|---|---|---|
| 1 | 空目录 | `find` 空目录 | 返回 0 文件，不截断 |
| 2 | 超过 LIMIT (100) | 创建 110 个文件 | 返回 100 文件，truncated=true |
| 3 | 深层嵌套 | 10 层嵌套文件 | 找到全部文件，路径为宿主前缀 |
| 4 | 隐藏文件 | `.hidden` + `visible.txt` | 隐藏文件全部找到 |
| 5 | 项目根列表 | 根目录文件 | 返回所有根目录文件 |
| 6 | 不存在的目录 | `find` 不存在路径 | 返回空，不截断 |
| 7 | 带空格的目录 | `space dir/space file.txt` | 找到 1 文件，路径正确 |
| 8 | 混合文件类型 | ts/css/json/md/sh/binary | 找到全部 6 文件 |
| 9 | toHostPath + relative 逻辑 | `toHostPath` + `path.relative` | 相对路径不以 `/` 开头 |
| 10 | Unicode 文件名 | `中文.ts` / `日本語.ts` | 找到 2 文件，含中文文件名 |

---

## 六、并发与压力测试

| # | 测试场景 | 方法 | 期望结果 |
|---|---|---|---|
| 1 | 并发写入 10 个文件 | `Promise.all(writeFiles)` | 10 个文件全部内容正确 |
| 2 | 并发读取 | `Promise.all(readFile)` × 10 | 10 次读取结果一致 |
| 3 | 写入后立即删除 | `writeFiles` + `rm -f` | 删除成功 |
| 4 | 写-读-覆盖循环 5 次 | 循环 write → read → overwrite | 每次读回最新内容 |
| 5 | 批量写入 50 + 批量删除 | `writeFiles` × 50 + `rm -rf` | 批量删除后文件不存在 |
| 6 | 100 个路径转换一致性 | `toSandboxPath` × 100 | 全部与期望一致 |
| 7 | 命令执行 | `sleep 0.1 && echo done` | 正常完成 |
| 8 | 二进制内容 | 256 字节全字符 | 读写一致 |
| 9 | 同名文件不同目录 | `a/index.ts` / `b/index.ts` / `c/index.ts` | 各自内容独立正确 |
| 10 | 超长单行 50K | 50000 个 `a` | 读写一致 |

---

## 七、SaaS API 端到端与泄露检查（已归并）

> 2026-07-17 去重：原第七章（SaaS API 端到端 7 工具）、第八章（错误信息泄露检查）、第十章（2026-05-30 复测）与 [`20-saas-tool-sandbox-verify.md`](./20-saas-tool-sandbox-verify.md) 的 T20.2-T20.12 完全重复，已删除。AI 端到端三层验证（代码审查 + 运行时 + PG）统一以 20 文档为准；本文档保留 SDK/单元层（路径转换、apply_patch/ls 边界、并发压力）。

## 八、测试结果汇总

### 8.1 路径转换单元测试

| 类别 | 用例数 | 通过 | 失败 |
|---|---|---|---|
| toSandboxPath | 15 | 15 | 0 |
| toHostPath | 5 | 5 | 0 |
| 往返一致性 | 3 | 3 | 0 |
| **小计** | **23** | **23** | **0** |

### 8.2 apply_patch 边界测试

| 类别 | 用例数 | 通过 | 失败 |
|---|---|---|---|
| 文件读写操作 | 19 | 19 | 0 |

### 8.3 ls 边界测试

| 类别 | 用例数 | 通过 | 失败 |
|---|---|---|---|
| 目录列表操作 | 25 | 25 | 0 |

### 8.4 并发/压力测试

| 类别 | 用例数 | 通过 | 失败 |
|---|---|---|---|
| 并发与压力 | 10 | 10 | 0 |

### 8.5 SaaS API 端到端测试

> 已归并至 [`20-saas-tool-sandbox-verify.md`](./20-saas-tool-sandbox-verify.md)（T20.2-T20.12，63 次工具调用 0 泄露的实测记录保留在该文档）。

### 8.6 总计

| 测试类别 | 用例数 | 通过 | 失败 |
|---|---|---|---|
| 路径转换 | 23 | 23 | 0 |
| apply_patch 边界 | 19 | 19 | 0 |
| ls 边界 | 25 | 25 | 0 |
| 并发/压力 | 10 | 10 | 0 |
| **总计** | **77** | **77** | **0** |

> API 端到端（63 次工具调用）已归并至 20 文档，不计入本表。

---

