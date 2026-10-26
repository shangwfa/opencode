# 阿里云 Agent Sandbox 极速版

## 接入范围

新增 `aliyun` provider，支持会话根绑定、PG 创建租约、命令执行/超时/取消、文件接口、Code Mode Runner、Session MCP、Session Tool Host 及 SaaS 预览代理。不迁移已有 OpenSandbox/Vercel 绑定。

使用官方 E2B SDK `2.31.0`。阿里云模板决定 CPU、内存和基础环境；会话指定资源时验证是否与模板实际规格一致，不静默忽略。会话 `sandbox.image` 在该后端表示模板名称/ID，不是 Docker 镜像地址。

## 部署配置

通过容器环境或 Secret 注入，API Key 不写入代码、镜像或 PG：

| 环境变量 | 值或说明 |
| --- | --- |
| `OPENCODE_SANDBOX_ENABLED` | `true` |
| `OPENCODE_SANDBOX_PROVIDER` | `aliyun` |
| `OPENCODE_ALIYUN_API_KEY` | Agent Sandbox API Key，非阿里云 AccessKey |
| `OPENCODE_ALIYUN_API_URL` | `https://api.cn-hangzhou.sandbox.aliyuncs.com`，按地域修改 |
| `OPENCODE_ALIYUN_DOMAIN` | `cn-hangzhou.sandbox.aliyuncs.com`，与 API URL 匹配 |
| `E2B_API_URL` | 静态 Snapshot 接口使用；应与 `OPENCODE_ALIYUN_API_URL` 相同；未设置时 SDK 按 domain 推导，非标准端点必须显式配置 |
| `OPENCODE_ALIYUN_TEMPLATE` | 默认 `code-interpreter-v1`；生产建议固定自定义模板 |
| `OPENCODE_ALIYUN_PAUSE_ENABLED` | 兼容旧配置；独立快照路径不使用暂停/恢复，无需开启 |
| `OPENCODE_ALIYUN_RUNNER_ASSET` | gzip Runner bundle 的 SaaS 本地路径；标准 Dockerfile 自动构建并配置 |
| `OPENCODE_ALIYUN_INSTALL_RIPGREP` | 默认 `true`，缺失时用 apt 安装；自定义模板预置后可关闭 |

与其它后端共用创建超时、命令超时、文件超时、保活和 idle reap 部署参数。不使用 OpenSandbox PVC、命令会话、OOM 或快照实现。

本地生成 Runner：在 `packages/core` 执行 `bun script/build-sandbox-runner.ts`，输出 `dist/sandbox-runner.mjs.gz`。自定义模板也可预置 `/opt/opencode-codemode-runner.mjs`、Node、bash、flock、git、ripgrep，省去首次安装。

## 工作区与鉴权

- 工作目录 `/workspace`；子会话共享根绑定。无进程内会话亲和性要求。
- 未指定持久化模式或 `persistMode=none`：默认临时沙箱，超时/停止销毁，数据不保留，不调用暂停/恢复。正常多轮使用默认会话保活，直到停止或删除沙箱。
- 显式 `persistMode=snapshot` 使用二代 MicroVM 独立快照；建议固定已验证模板 `base-5wa5`。停止、释放和 idle reap 先保存快照，PG 确认后才 kill；下次 boot 从最新快照创建新实例。不使用 PVC、pause/resume，也不改变默认临时模式。
- 阿里云恢复生成不同云端沙箱 ID 和新的 SaaS fencing identity。Session MCP 按代次丢弃旧连接，不向恢复实例发送旧桥的清理命令。
- 快照 intent、云 ID、来源代次及恢复次数保存在 PG `aliyun_snapshot`；支持快照创建、最新状态和统计接口。显式创建目前等待云端确认（最长 300 秒），不同于 OpenSandbox 的立即返回后台创建语义。
- 快照创建失败或结果不确定时不 kill，保持执行门禁关闭；后台过期租约回收仅按唯一名称核对，不重放 create。未查到唯一快照时需人工核对，不能用空工作区覆盖。执行中的命令必须先完成或取消。
- 从快照创建允许用户 metadata 和生命周期覆盖，禁止 envs、挂载、镜像和 `fc.*` 系统 metadata。恢复响应丢失时保留创建 intent，下次按 metadata 查找并认领，无法唯一确认则停止，不盲目再创建。过期快照恢复失败也不会回退模板。
- 云端快照默认保留七天，不是永久存储。没有持续备份/自动延长快照有效期；运行中最新改动仍依赖保活及正常停止保存，意外 TTL kill 不保证保存最后改动。生产长时间归档仍需独立代码仓库/对象存储。
- 官方单实例单次活跃上限 86400 秒；当前未实现临近上限自动轮转，不能把 keep-alive 当无限运行保证。完整官方对照与待补项见 `aliyun-snapshot-official-review-2026-10-25.md`。
- 删除会话先停止实例，再有限重试删除其快照；失败保留会话和 PG 台账，不把 kill 成功视为快照也已释放。
- 创建固定 `secure=true`、`allowPublicTraffic=false`。流量令牌只存入沙箱绑定，供任意 SaaS Pod 连接；API Key 不入库。Runner WS、MCP、Tool Host、插件 HTTP 和预览代理传递原生鉴权头。
- 浏览器通过已鉴权的 SaaS 代理访问。endpoint API 不返回流量令牌或不可直接访问的公网地址，不强行套用 Vercel token-path 网关。
- 创建结果不确定时保留 intent，按 metadata 查找并恢复；无法唯一确认则停止，不盲目重放 create。缺失的持久工作区不自动替换成空目录。

## 验收用例

| 用例 | 断言 |
| --- | --- |
| 配置 | 未知 provider、缺凭据、地域不匹配、不安全 URL、PVC 均拒绝 |
| 单测/PG | 根归属、并发创建/停止、独立快照恢复 fencing、丢响应核对不重放、快照失败不 kill、规格不匹配 |
| 命令 | 非零退出、超时、定向取消、取消未确认保留 PG 记录、输出截断 |
| 文件 | UTF-8、二进制范围、缺失 null、读上限、列表/搜索/删除 |
| 公网鉴权 | 匿名 403，携带原生流量令牌成功 |
| Docker API | 公共 SSE 先订阅；执行 shell 和文件接口；核对 PG provider/资源清理 |
| 模型链路 | Code Mode execute、Session 自定义工具、Session local MCP 均需真实工具事件，不只检查模型文本 |
| 预览 | SaaS 代理 HTTP、根路径资源和 WS；令牌不返回浏览器 |

复用 API 执行器：`docs/test-cases/scripts/sandbox-vercel-t19.mjs` 支持 `EXPECT_PROVIDER=aliyun` 和 `SESSION_SANDBOX` 测试会话默认资源配置，原 Vercel 默认行为不变。执行期间订阅公共 SSE，遇到普通表单自动代答。

## 2026-10-25 实测基础条件

杭州鉴权有效。内置 `code-interpreter-v1` 实测规格 **2 CPU / 2048 MiB**，有 Node/flock，缺 ripgrep。SDK 命令、文件和端口鉴权通过，匿名端口返回 403。一代暂停接口拒绝，提示 `pauseSession is not enabled for this function`，一代也不支持独立快照；不代表二代 MicroVM 独立快照不可用。SDK 初始探测证据见 `artifacts/aliyun-sandbox/spike.json`。

官方依据：
- https://help.aliyun.com/zh/agent-sandbox/pause-and-resume
- https://help.aliyun.com/zh/agent-sandbox/using-the-cloud-sandbox-via-the-sdk
- https://help.aliyun.com/zh/agent-sandbox/e2b-sdk-compatible-api-list
- https://help.aliyun.com/zh/agent-sandbox/e2b-sdk-integration-parameter-description
- https://help.aliyun.com/zh/agent-sandbox/network/
- https://help.aliyun.com/zh/agent-sandbox/snapshot-invited-test

## MCP 502 排查结论更正

此前归因为阿里云平台波动、Bun DNS 或连接池，均缺乏证据，不应据此部署运行时升级、固定 IP 或全局关闭连接池。

已确认的本地触发条件：测试设置 `OPENCODE_SESSION_AUTO_KEEPALIVE=0`，会话又是 `persistMode=none`。`session/execution.ts` 的 `destroyUnkeptSandbox` 在预热轮结束后销毁沙箱；随后调用可能仍持有原 MCP 网关地址。对照实验显式开启 keep-alive 后，同一真实沙箱的 MCP 调用成功，桥进程与监听端口前后均可核对。详见 `aliyun-gateway-investigation-2026-10-25.md`。

502/503/504 空响应体不能证明工具未执行，禁止据此自动重放有副作用的调用。此前加入的自动重试、错误包装、全局 Connection: close 及桥 keep-alive 猜测性修改已撤回。

复用执行器时可用 `SESSION_KEEPALIVE=1` 显式保留跨轮工作区；它只设置测试会话的 keep-alive，不改变部署默认值。独立快照要求二代模板及账号对应能力，与暂停权限无关。

运行中的云实例不能仅凭 metadata 被认定为孤儿；清理前核对 PG 绑定和测试任务状态。

## 二代原生独立快照验证

`base-5wa5`（二代 MicroVM）已通过真实 Docker/API 验证：文本与二进制文件写入后创建独立 Snapshot，删除原沙箱，从快照创建新沙箱并校验文件与 SHA-256 一致。全程不使用暂停/恢复；测试资源均已清理。

原生证据：`artifacts/aliyun-sandbox/independent-snapshot-v2-verified/result.json`。SaaS 自动生命周期使用 `docs/test-cases/scripts/aliyun-snapshot-api.mjs` 单独验收，默认临时沙箱配置未改变。

SaaS 双 Docker 验收已通过：停止自动保存最新文件、另一实例恢复不同云 ID、文本/二进制 SHA-256、恢复次数和会话删除清理均符合预期。恢复前后真实 Code Mode execute 均返回 1024。证据：`artifacts/aliyun-sandbox/auto-snapshot-final/result.json`。
