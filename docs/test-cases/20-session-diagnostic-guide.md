# 会话问题诊断指南

根据会话 ID，系统性排查 SaaS/PG 环境中会话执行过程中的问题。

## 1. 建立连接

```bash
# PG 连接参数（从容器环境变量获取）
# docker exec <container> env | grep OPENCODE_DATABASE_URL
PG="host=127.0.0.1 port=15432 dbname=opencode user=app password=<password> sslmode=disable"
```

## 2. 会话全貌

### 2.1 查询会话树（父 + 子会话）

```sql
SELECT id, parent_id, title, agent, model->>'id' as model, time_created,
  (SELECT count(*) FROM part p WHERE p.session_id = s.id) as part_count
FROM session s
WHERE id = '<SESSION_ID>' OR parent_id = '<SESSION_ID>'
ORDER BY time_created;
```

关注点：
- 父子会话层级是否正确（`parent_id` 指向父会话）
- 每个会话的 `part_count`，异常多或异常少都值得关注
- 子会话的 agent 类型（explore/build/通用）

### 2.2 费用与 token 统计

```sql
SELECT s.id, s.title,
  sum((m.data->>'cost')::numeric) as cost,
  sum((m.data->'tokens'->>'total')::int) as tokens,
  count(*) as assistant_msgs
FROM message m
JOIN session s ON m.session_id = s.id
WHERE s.id IN (<会话ID列表>)
  AND m.data->>'role' = 'assistant'
GROUP BY s.id, s.title
ORDER BY sum((m.data->>'cost')::numeric) DESC;
```

关注点：
- 单会话 token 消耗是否异常高（说明 LLM 在循环重试）
- 费用与任务复杂度是否匹配

## 3. 问题模式检测

### 3.1 工具调用成功率

```sql
SELECT
  p.data->>'tool' as tool,
  count(*) as total,
  count(*) FILTER (WHERE p.data->'state'->>'status' = 'error') as errors,
  count(*) FILTER (WHERE p.data->'state'->>'output' LIKE '%No files found%'
    OR p.data->'state'->>'output' LIKE '%No matches%'
    OR p.data->'state'->>'output' LIKE '%0 entries%') as empty_results,
  count(*) FILTER (WHERE p.data->'state'->'metadata'->>'matches' = '0') as zero_matches
FROM part p
WHERE p.session_id = '<SESSION_ID>'
  AND p.data->>'type' = 'tool'
  AND p.data->>'tool' IS NOT NULL
GROUP BY p.data->>'tool'
ORDER BY total DESC;
```

**高失败率模式**：

| 现象 | 可能原因 |
|------|----------|
| grep 100% 空结果 + read 正常 | sandbox 镜像缺少 `rg` 命令 |
| glob 100% 空结果 + read 正常 | 同上（glob 也依赖 `rg --files`） |
| read 也失败 | sandbox 未创建或已销毁 |
| 所有工具都失败 | sandbox 连接问题（502/execd 崩溃） |
| bash 成功但 grep/glob 失败 | `rg` 缺失，bash 用的是系统 `grep`/`find` |

### 3.2 工具调用不一致检测

```sql
-- 同一时间段内 read 成功但 grep/glob 失败 → 说明 rg 缺失
SELECT
  p.data->>'tool' as tool,
  p.data->'state'->>'title' as title,
  p.data->'state'->>'status' as status,
  substring(p.data->'state'->>'output', 1, 100) as output_preview,
  p.time_created
FROM part p
WHERE p.session_id = '<SESSION_ID>'
  AND p.data->>'tool' IN ('read', 'grep', 'glob')
ORDER BY p.time_created;
```

关注点：
- `read` 能列出目录内容，但 `grep` 在同一目录搜索返回空 → **rg 缺失**
- 时间线上的突然变化：某时刻前 read 正常，之后全部失败 → **sandbox 被重建/替换**

### 3.3 子会话 workspace 空目录检测

```sql
-- 子会话的 read /workspace 输出
SELECT p.data->>'tool', p.data->'state'->>'output'
FROM part p
WHERE p.session_id = '<子会话ID>'
  AND p.data->>'tool' = 'read'
  AND p.data->'state'->'input'->>'filePath' = '/workspace';
```

如果输出 `(0 entries)` → 子会话创建了独立 sandbox，没有复用父会话。

### 3.4 LLM 循环重试检测

```sql
-- 检测相同模式重复调用
SELECT
  p.data->>'tool' as tool,
  p.data->'state'->>'title' as title,
  count(*) as repeat_count
FROM part p
WHERE p.session_id = '<SESSION_ID>'
  AND p.data->>'type' = 'tool'
GROUP BY p.data->>'tool', p.data->'state'->>'title'
HAVING count(*) > 3
ORDER BY count(*) DESC;
```

同一搜索重复 3+ 次 → LLM 不相信工具结果（因为结果不符合预期），在无效循环中浪费 token。

## 4. Sandbox 诊断

### 4.1 Sandbox 实例检查

```sql
SELECT id, session_id, host, state, keep_alive, time_created, time_updated
FROM sandbox
WHERE session_id IN (<会话ID列表>)
ORDER BY time_created;
```

关注点：
- **每个会话是否各有独立 sandbox** → 如果子会话有独立 sandbox，说明未共享父会话 sandbox（sandboxSessionID 修复前的问题）
- `state` 为 `destroyed` 但会话仍在运行 → sandbox 过早销毁
- `host` 不同 → 不同 sandbox 服务实例，可能是配置不一致
- 多条记录同一 session_id → sandbox 被反复创建销毁

### 4.2 Sandbox 生命周期

```sql
-- sandbox 存活时间
SELECT id, session_id, state,
  (time_updated - time_created)/1000/60 as alive_minutes
FROM sandbox
WHERE session_id IN (<会话ID列表>)
ORDER BY time_created;
```

存活时间过短（< 1 分钟）→ sandbox 创建后很快被销毁，可能是健康检查失败或 execd 崩溃。

## 5. 用户意图与执行偏差

### 5.1 用户输入提取

```sql
SELECT p.id, substring(p.data->>'text', 1, 200) as user_input
FROM part p
JOIN message m ON p.message_id = m.id
WHERE m.session_id = '<SESSION_ID>'
  AND m.data->>'role' = 'user'
  AND p.data->>'type' = 'text'
ORDER BY p.time_created;
```

关注点：
- 用户是否有明确的反馈/纠正（如"你为什么没找到"、"用 grep 搜"）
- 用户是否有放弃/切换策略的信号（如"冻结吧"、"换个思路"）

### 5.2 事件时间线

```sql
SELECT
  p.time_created,
  p.data->>'type' as type,
  p.data->>'tool' as tool,
  p.data->'state'->>'title' as title,
  p.data->'state'->>'status' as status
FROM part p
WHERE p.session_id = '<SESSION_ID>'
ORDER BY p.time_created;
```

观察：
- step-start → tool → step-finish 的节奏是否正常
- 是否有长时间间隔（sandbox 创建等待）
- 工具调用密度是否异常（连续几十次无结果调用）

## 6. 常见问题速查表

| 症状 | SQL 证据 | 根因 | 修复方案 |
|------|----------|------|----------|
| grep/glob 全部空结果 | `grep 16/16 empty, read 正常` | 镜像无 `rg` | 构建含 ripgrep 的镜像 |
| 子会话 workspace 空 | 子会话 read `(0 entries)` | 子会话独立 sandbox | `sandboxSessionID` 复用父 sandbox |
| 所有工具报错 502 | tool status = error | execd 崩溃（QEMU 兼容性） | 使用原生架构镜像（arm64/amd64） |
| sandbox 反复创建销毁 | sandbox 表多条记录 | 健康检查失败 / keep_alive 未设置 | 检查 sandbox 服务端配置 |
| LLM 循环重试同一搜索 | 同一 title 出现 5+ 次 | 工具结果不可靠导致 LLM 不信任 | 修复工具本身的正确性 |
| 工具超时 | metadata exit=null | sandbox 命令执行超时 | 增大 timeout 或优化命令 |

## 7. 分析流程

```
1. 会话树 → 确认父子关系和会话数量
     ↓
2. 工具统计 → 定位哪个工具有问题（grep/glob/read/bash）
     ↓
3. 时间线对比 → read 成功 vs grep 失败的交叉对比
     ↓
4. Sandbox 记录 → 是否独立创建、存活时间、host 差异
     ↓
5. 用户反馈 → 用户是否表达了不满或给出纠正
     ↓
6. 根因定位 → 从上表匹配症状
     ↓
7. 验证修复 → 修复后在本地 sandbox 环境复测
```
