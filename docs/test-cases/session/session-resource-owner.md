# 主/子会话共享资源域（V2）

## 目标

内部子会话与主会话共享 Agent、Skill、MCP、AGENTS.md、Tool、Command 定义及物理 Sandbox；当前分支保持执行身份。显式历史 fork 是独立资源域。

## 自动化入口

`docs/test-cases/scripts/session-resources-owner-v2-e2e.mjs`。使用 Docker SaaS、隔离 PG `opencode-v2-test`、本地 OpenSandbox 和真实模型，所有资源通过 API 创建。

参数：BASE、PG_URL、OPENCODE_PASSWORD、MODEL、MODEL_REQUEST_LOG_FILE、REPORT。开启服务侧 OPENCODE_MODEL_REQUEST_LOG 后，MODEL_REQUEST_LOG_FILE 指向该目录的 `model-requests.jsonl`；不能只查最终文本来证明模型指令注入或 Code Mode 生效。

## 步骤与断言

1. 创建主会话并注册六类资源；通过 subagent Command API 创建内部子会话，而非直接插 PG 子会话。
2. 子会话六类 API 查询均读到主会话定义；AGENTS.md 的 owner 为主会话。
3. Sandbox 同 ID Skill 胜过 Session Skill；删除项目文件并 refresh 后回退。
4. 主会话更新至 VERSION_2，子会话读取并调用新 Tool；主会话文件 API 读到子会话执行的 Sandbox 文件副作用。
5. 子会话更新至 VERSION_3，主会话看到更新；子会话 Skill 附件使用主 owner 的资源物化目录和最新 bundle。
6. 六资源表中 child session_id 行数全部为 0。
7. 子会话真实模型请求包含主会话 VERSION_3 AGENTS.md；目录同时存在 execute 和共享原生 Tool。
8. 删除子会话后，主会话六类定义和 Sandbox 仍可读；删除主会话后 Session 与资源表目标行均为 0。

## 验证记录

2026-10-01：API E2E **29 项断言通过，0 失败**。Core 定向单测 111 pass / 0 fail；真实 PG 测试 7 pass / 0 fail；Core typecheck 通过。T32.29 Tool 三层优先级 API 回归 1/1 通过。

PG 单测另覆盖 nested child、history fork 隔离、通过 child 删除/清空共享定义和级联清理。纯 resolver 单测覆盖循环、断链、最大深度、project/app/directory/workspace 跨域拒绝及删除 root 后空读合同。

本轮未验收用户不可见的列表/订阅投影、MCP 项目配置服务级覆盖或项目 AGENTS.md 自动发现。待补齐项见 `docs/design/session-resource-unification-progress.md`。
