# SaaS 测试公共配置

> 本文档包含所有测试用例共享的环境配置、结果摘要和验收分层。

## 测试环境

- **容器镜像**：`opencode-saas-sandbox-test:v11`
- **容器名**：`opencode-saas-test`
- **本地端口映射**：`localhost:14096 → 容器 4096`
- **本地 PG 数据库**：`postgresql://postgres:postgres@127.0.0.1:5432/opencode`（容器通过 `host.docker.internal:5432` 访问）
- **测试模型**：`zhipuai/glm-5.1`（`{"providerID":"zhipuai","modelID":"glm-5.1"}`）
- **Sandbox API**：`host.docker.internal:30040`（需外部 Sandbox 服务）


## 回归测试结果摘要

- **执行日期**：2026-05-26
- **镜像版本**：v11（基于 upstream/dev `748fcb7eb`）
- **已验证通过**：T1.1-T1.3, T2.1-T2.6, T3.1-T3.2, T4.1-T4.2, T4.6-T4.7, T6.1, T7.2-T7.3, T7.5, T8.1-T8.2, T9.1-T9.2, T10.1
- **待验证（需 Sandbox API）**：T5, T11-T13
- **关键修复**：`Flag.OPENCODE_DEFAULT_DIRECTORY` 需添加到 `packages/core/src/flag/flag.ts`（非 `packages/opencode`）
- **工具调用说明**：upstream 的 part type 为 `tool`（非 `tool-use`），响应结构含 `step-start`, `reasoning`, `tool`, `text`, `step-finish`

### 消息结构说明

`POST /session/:sessionID/message` 的返回值是 **AI 最后一条消息**（通常是文字总结），而工具调用在**前一条消息**中。完整的消息流为：

```
💬 [N]   用户 prompt
🔧 [N+1] AI 工具调用（bash/write/read/edit 等，可能多个）
💬 [N+2] AI 文字总结 ← POST /message 返回的是这条
```

因此，仅解析 `POST /message` 的返回值无法验证工具是否被调用。验证工具调用过程需要查询 `GET /session/:sessionID/message` 获取完整消息列表。

### 通用验证函数

以下 bash 函数可在测试脚本中复用：

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'

# send_and_verify: 发送消息并验证工具调用过程 + 最终结果
# 用法: send_and_verify $SID "prompt文本" "测试标签"
send_and_verify() {
  local sid=$1 prompt=$2 label=$3
  echo "=== $label ==="

  # 发送消息（返回值是最后一条文字总结）
  curl -s --max-time 120 -X POST "$BASE/session/$sid/message" \
    -H 'Content-Type: application/json' \
    -d "{\"parts\":[{\"type\":\"text\",\"text\":\"$prompt\"}],\"model\":$MODEL}" > /dev/null 2>&1

  # 从完整消息列表验证工具调用过程
  curl -s "$BASE/session/$sid/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
# 取最后3条消息（prompt + tool calls + summary）
recent = msgs[-3:] if len(msgs) >= 3 else msgs
tools, texts = [], []
for m in recent:
    for p in m.get('parts', []):
        if p.get('type') == 'tool':
            t = p.get('tool', '?')
            s = p.get('state', {})
            status = s.get('status', '?')
            output = s.get('output', '')[:80] if s.get('output') else ''
            tools.append(f'{t}({status})')
        elif p.get('type') == 'text':
            texts.append(p.get('text', '')[:100])
print(f'  工具调用: {\"✅ \" + str(tools) if tools else \"❌ 无工具调用\"}')
print(f'  AI回复: {texts[-1] if texts else \"(空)\"}')
"
}
```

### API 路径速查

| 功能 | 正确路径 |
|---|---|
| 同步消息 | `POST /session/:sessionID/message` |
| 异步消息 | `POST /session/:sessionID/prompt_async` |
| 中断会话 | `POST /session/:sessionID/abort` |
| Provider 列表 | `GET /provider` |
| 全局事件流 | `GET /global/event`（SSE） |
| Auth 凭据 | `PUT/DELETE /auth/:providerID` |
| Sandbox proxy | `/session/:sessionID/proxy/:port/*` |
| Sandbox 直连 endpoint | `GET /session/:sessionID/endpoint/:port` |
| 沙箱执行命令 | `POST /session/:sessionID/exec` |
| 异步执行命令 | `POST /session/:sessionID/exec/async` |
| 查询执行状态 | `GET /session/:sessionID/exec/:execId` |
| SSE 流式输出 | `GET /session/:sessionID/exec/:execId/stream` |
| 中断执行 | `POST /session/:sessionID/exec/:execId/kill` |
| 执行列表 | `GET /session/:sessionID/execs` |
| 设置 keepAlive | `POST /session/:sessionID/keep-alive` |
| 查询 keepAlive | `GET /session/:sessionID/keep-alive` |
| 销毁 sandbox | `POST /session/:sessionID/kill-sandbox` |
| 健康检查 | `GET /global/health` |
| 全局配置 | `GET /global/config` |


## 验收分层

SaaS 化验收按优先级分三层：

- **P0 SaaS 核心验收**：多 session 隔离、PVC 持久化、sandbox 生命周期、dev server proxy、PG 落库、provider 凭据、并发执行。
- **P1 SaaS 稳定性**：错误恢复、资源回收、重启恢复、限流/计费、proxy 错误上报。
- **P2 低优先级兼容回归**：原 OpenCode 基础 API smoke test，仅用于确认 SaaS 改造没有破坏基础能力，不作为 SaaS 主验收。

当前设计约束：

- 不同 session 必须隔离。Session B 不应看到 Session A 的 `/workspace` 文件或后台进程。
- keepAlive 由 bash 工具是否以 `background:true` 启动决定。直接访问 sandbox proxy 不触发 keepAlive。
- 用户/租户、API 鉴权、用户与 session 的绑定关系、跨用户端口访问控制由外部服务负责，本服务只验证 session 维度的隔离与资源行为。
- 资源配额沿用默认 sandbox/runtime 限制，不在本用例集中单独验收自定义 CPU/内存/磁盘配额。
- 不覆盖老版本/本地数据迁移场景。

```bash
# 通用：定义 SID 变量
SID="ses_xxxxxxxxxxxxxxxxxxxx"
```

---


