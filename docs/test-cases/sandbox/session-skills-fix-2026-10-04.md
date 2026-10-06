# Session skills 修复与验证（2026-10-04）

## 修复范围

- S1：完成标记移到正文和所有资源写入成功之后；复用前核对版本、正文摘要和各资源摘要。缺文件、旧标记、同尺寸损坏均触发修复。
- S2：拒绝 `SKILL.md`、`resources.json` 及其子路径；拒绝同一资源列表的文件/目录前缀冲突。
- S3：发现布局对齐固定本地 upstream/v2 的 `{*.md,**/SKILL.md}`，参考 markdown 不提升为技能，也不占用读取额度；解析器接收技能来源根目录。
- S4：用私有 WeakMap 保存查找时的资源定义快照，物化不再次读取可变 PG 行；路径哈希包含技能 ID、正文和资源元数据，避免不同技能共享同一路径。
- 原生 skill 工具在远端发现前断言请求 ID 的权限，保留核心 registry、executor 和拒绝 defect 处理。
- 显式附件的物化失败返回 AttachmentError，拒绝 admission，不再吞掉错误后注入不完整指令。
- 没有已运行沙箱时，普通定义查找不触发扫描建箱；显式 refresh 保持主动扫描语义。
- 扫描缓存隔离物理沙箱 ID；自动恢复只写有效 agent/session 策略明确 allow 的技能，ask/deny 等显式加载再授权。

## 可复核验证

日志位于 `/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode/`。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 固定 HEAD `2380551c2e` 源码对照（Bun preload，不覆盖工作区） | 49 pass / 15 fail，失败涵盖四项缺陷、权限前解析和附件吞错 | session-skills-fix-red-head.log |
| Core 相关回归，15 文件 | 145 pass / 0 fail / 407 expect | session-skills-fix-regression.log |
| 专用 PG，4 文件 | 18 pass / 0 fail / 124 expect | session-skills-fix-pg.log |
| Server HTTP 路由，5 文件 | 6 pass / 0 fail / 101 expect | session-skills-fix-server-tests.log |
| Core / Server 类型检查 | 通过 | session-skills-fix-typecheck.log / session-skills-fix-server-typecheck.log |
| 涉及 10 文件 oxlint | 通过 | session-skills-fix-lint.log |
| git diff --check | 通过 | 本次工作区检查 |

PG 测试运行真实 SessionSkills 服务与持久化 CRUD，但沙箱 I/O 使用 Effect 桩。HTTP 测试使用实际 ServerFetch 路由、内存数据库和沙箱桩，覆盖非法路径 400、物化失败 400、恢复重试、损坏修复及 DELETE；不冒充 Docker E2E。

默认 code-mode 的 registry 测试确认 catalog 存在，skill 仍作为原生工具暴露、不进入 CodeMode catalog。这不是实际模型/沙箱 code-mode 执行验收。

## Docker 接口验收阻塞

脚本：`docs/test-cases/scripts/session-skills-safety-v2.mjs`。创建独立测试 PG 与 Docker SaaS，源码只读挂载；覆盖 PVC、snapshot 两模式的真实资源写入失败/重试及 PG admission 检查。

本次两轮、共四次运行均未进入技能验收：平台 `127.0.0.1:30040` 无监听，代理转发记录连接失败；OrbStack Kubernetes API `127.0.0.1:26443` 连接被拒绝。不得标 PASS。

证据目录（各含 result.json、saas.log、pg-blocker.json）：

- `store/evidence/session-skills-pvc-1791108325798-4680cfb7/`
- `store/evidence/session-skills-snapshot-1791108334403-bc62e466/`
- `store/evidence/session-skills-pvc-1791108778919-53c3bc6b/`
- `store/evidence/session-skills-snapshot-1791108778919-7cc534a2/`

四个独立数据库各保留 1 个失败建箱的测试会话，源为 destroyed 创建占位行，inbox 和 session_skills 均为 0；Docker 测试容器已退出并移除。未直接删除 PG 证据，也没有证明远端全部资源物理回收。

## 验收边界与剩余风险

- 四项确定性缺陷已修复；真实平台 E2E 必须恢复平台后重跑，真实模型/default code-mode、跨副本并发不在当前通过范围。
- global skill 的宿主目录到沙箱的资源映射仍是未解决的静态风险，保留 upstream prepare 语义；不能假定宿主文件在沙箱可访问。
- 同一物理沙箱内的扫描仍采用 mtime:size 指纹；本次修复隔离不同物理 ID，没有声称解决同代际等指纹内容变更。
- 本次未提交或推送代码，未修改既有用户工作。
