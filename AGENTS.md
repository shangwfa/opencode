我们是opencode saas 服务，基于PG数据库，对外提供接口，提供服务的

功能环境：

- opencode saas服务运行在docker中
  - 密码固定:ab123456
- 要在docker中启动服务（orbstack）
- 连接本地PG数据库：127.0.0.1:5432/opencode-v2-up （我们只考虑PG数据库）
- 通过接口进行测试
- 有两个镜像
  - 一个是opencode saas服务镜像
  - 另一个是opensandbox镜像

opencode sass 作为一个code-agent ,主要负责跟AI打交道，通过各种工具，驱动任务的执行

- AI相关的工作由opencode saas服务承担
- 文件读写相关的，通过opensandbox 提供的沙箱支撑
- 是以会话为中心，每个会话对应一个代码仓库，每个会话对应一个沙箱
- 所有会话工作目录都是/workspace, 每个会话的代码仓库都在/workspace
- 项目中的worktree的概念对我们没有意义
- skills mcps agent agent-md commands plugins等功能相关逻辑部分是类似的，如何可以服用且是最佳实践，尽量一起考虑下
- opencode saas 是一个无状态的服务，线上部署(k8s 多pods）

沙箱:(支持多沙箱opensandbox vercel sandbox 阿里沙箱等)

- 为opencode saas 服务执行涉及文件操作相关工具执行脚本等
- 为opencode saas 服务提供 local mcp ，skills中脚本执行, code-mode,tools等
- 访问 opencode saas 访问沙箱中的各种能力,预览，各种服务
- 沙箱的使用是昂贵的资源，要思考如何高效利用沙箱能力，不仅能提供产品需要的各种能力，还要能低成本高效的使用沙箱

主要流程：

- 用户创建会话
- 通过在沙箱中拉取代码仓库
- 用户完成需求开发
- 执行任务过程中，主会话创建的子会话，使用的沙箱同主会话一样
- 代码持久有两种模式(opensandbox)
  - pvc模式：代码持久化到PVC中
  - snapshot模式：代码持久化到快照中

测试要求：

- 通过接口进行测试
- 要求对修改的内容，进行全面的单测
- e2e用例测试
  - 判断结果是否符合预期
  - 判断执行过程是否符合预期
  - 判断PG数据是否符合预期
- 测试过程中发现问题，要主动提出，讨论解决下
- 注意你的任何结论，必须要有依据,绝对不能瞎猜（！！!重要）
- code-mode模式默认开下，测试过程注意该模式是否生效
- 如何用例有问题修复后重新测试
- 用例跑的过程中，遇到提问，模拟自动回答，保证继续执行
- 用例执行期间，订阅会话流式接口（GET /api/session/:sessionID/event SSE）实时输出执行过程（思考过程、工具调用、表单问答、文本、执行状态），不要只读执行器日志或等整轮结束再汇报；完整规范见 docs/test-cases/skills/streaming-output-spec.md

代码修改原则：

- 高内聚，最小改动
- 功能实现要符合V2的最佳实践
- 不要修改npm依赖包的代码

问题发现如何处理

- 功能实现有问题话，可以参考feat/opencode-1.18.31分支（V1的逻辑是是在线上环境经过验证过的），实现还是要按照当前项目的最佳实践来
- 发现优化问题，先沉淀为测试用例，测试是否可以重新，可以重新，修复再测试

opencode(v2)官方文档：https://opencode.ai/v2/docs

## SaaS 与会话沙箱的通信机制（关键架构）

SaaS **不直连沙箱容器网络**。所有通信经 OpenSandbox 控制面，分两类通道 + 生命周期 API（实现：`packages/core/src/sandbox/provider.ts`）：

### 通道一：命令/文件通道（execd，默认端口 44772）

`provider.run()`（isolated / detached / keepalive 命令会话三种形态）与 `provider.fileRead/Write/Stat/List/Delete`（底层同为命令输出）。承载功能：

- 全部文件类内置工具（read/write/edit/patch/glob/grep，统一封装于 `sandbox/tools.ts`）
- shell 工具（前台 + nohup 后台）与控制面 shell API（`POST /api/session/:id/shell`）
- Session MCP：`run` 拉起 supergateway bridge daemon（stdio→HTTP）
- Session 自定义命令 / Agents / Skills 的沙箱发现（`session/scan.ts`，best-effort 降级）
- Code Mode Runner 拉起与回收（`run(startCommand/stopCommand)`）
- Compaction 历史文件落盘（`fileWrite` 写 `tool_history_*.md`）
- Session Skills 物化（SKILL.md + 资源写入沙箱）
- HTTP fs / vcs 路由（`session-fs.ts`、`session-vcs.ts`）

### 通道二：端口网关（`provider.endpoint(sessionID, port, serverOnly)`）

控制面把沙箱内任意端口映射为 SaaS 可达的代理地址（`use_server_proxy=true` 时路径为 SaaS → OpenSandbox 服务 → 沙箱端口）。承载功能：

- Code Mode Runner WebSocket（9911，SaaS 作客户端；沙箱侧源码 `packages/containers/sandbox/opt/codemode-runner.ts`）
- Session MCP HTTP 端点（`http://<endpoint>/mcp`——任意 pod 可访问其它 pod 创建的会话 MCP）
- Session 自定义工具执行宿主（`session/tool-sandbox.ts` Tool Host endpoint）
- 浏览器 preview/代理路由（`server/handlers/session-proxy.ts`，TTL endpoint 缓存）

### 生命周期 API（控制面 REST，非代理）

惰性 boot、destroy、keep-alive、快照创建/恢复/删除、OOM 采样（`session.sandbox.oom`）、重启恢复 sweep。

### 必须遵守的约定

1. **网关地址 ≠ 就绪**（addressability ≠ readiness）：代理地址在目标端口监听前即可解析成功。凡「SaaS 主动连沙箱内常驻服务」，固定次序：**先经命令通道幂等拉起（含就绪探测）→ 再解析端点 → 连接失败小重试**（参照 `core/codemode/runner.ts`）。
2. **沙箱内常驻 daemon 统一三段式**：命令通道拉起（flock + pid 文件幂等）+ 端口网关寻址 + SaaS 作客户端连接。现有使用者：Code Mode Runner、Session MCP（supergateway）、Session Tool Host。新增沙箱内服务必须复用该模式，不得发明新的连接方式。
3. **无状态多 pod 的支撑**：会话→沙箱绑定在 PG `sandbox` 表，不在进程内存。任意 pod 处理任意会话都是「PG 查沙箱 ID → 控制面通信」。不要引入 pod 与沙箱的亲和性（如直连沙箱容器 IP）。
4. **网络隔离边界**：沙箱端口不对外暴露；SaaS 部署唯一网络前提是可达 OpenSandbox 服务。数据面（Code Mode fetch 等）从沙箱直出，与控制面代理路径分离（`OPENCODE_CODEMODE_NETWORK=sandbox|server` 的物理基础）。

opensandbox 服务（根据测试需要进行切换）

- 本地
- 远端

沙箱镜像

- 构建dockerfile位置（packages/containers/sandbox）
- 镜像格式
  - arm（本地）
  - amd64（远端）
- 远端上传地址
  - docker login --username=245046239@qq.com crpi-hlpnu8kiweghie0r.cn-hangzhou.personal.cr.aliyuncs.com 密码：shanga2450
  - docker tag [ImageId] crpi-hlpnu8kiweghie0r.cn-hangzhou.personal.cr.aliyuncs.com/shangwfa/opencode-sandbox:[镜像版本号]
  - docker push crpi-hlpnu8kiweghie0r.cn-hangzhou.personal.cr.aliyuncs.com/shangwfa/opencode-sandbox:[镜像版本号]

使用中文
