# Tools 测试用例（V2）

本目录仅将 V2 API、V2 PG 投影和 Sandbox 语义作为当前验收标准。通用前置环境见 [`../local-test-env.md`](../../local-test-env.md)。测试时使用隔离数据库、已启动的 V2 SaaS 服务和可用 Sandbox；所有结论依据 API 响应、tool part、PG 行或 Sandbox 文件状态。

## 推荐执行顺序

```bash
bun docs/test-cases/scripts/tools-v2-e2e.mjs
bun docs/test-cases/scripts/session-tools-full-v2-e2e.mjs
```

设置 `BASE`、`PG_URL`、`OPENCODE_PASSWORD`、`MODEL` 以指定测试环境。两脚本均通过 API 触发流程；结束时先 kill 每个测试 Session 的 Sandbox，断言 PG 中无该 Session 的 running Sandbox，再删除 Session。任何断言或清理失败都返回非零状态。Session Tools 脚本默认使用 `opencode-v2-test`，应确保其为隔离测试库。完整 Session Tools 测试还需开启服务端 Model Request Audit，并设置宿主机 `MODEL_REQUEST_LOG_FILE`，详见 [`session-tools.md`](./session-tools.md)。

### 容器分工（重要）

常规 tools 用例（含 Session Tool / Code Mode）必须走**直连 OpenSandbox** 的 SaaS 容器（`OPENCODE_SANDBOX_DOMAIN` 指向 OpenSandbox 控制面，如 `host.docker.internal:8080`）。

仅在验证 files API timeout 时，才把 `OPENCODE_SANDBOX_DOMAIN` 指向故障代理（`opensandbox-files-fault-proxy.mjs`）。故障代理**不能**用于常规用例：它按 files 路径改写 endpoint，会破坏 Session Tool Host / Code Mode 的动态端口链路，导致 `Session Tool Host capability/identity mismatch` 或 `Failed to start Code Mode Runner`，属于测试夹具副作用而非产品缺陷。建议两类运行使用不同容器与端口。

## 用例目录

| 文档                                                       | 当前 V2 范围                                                               | 自动化证据                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------- |
| [`tool-calls.md`](./tool-calls.md)                         | 工具调用 E2E 主入口、覆盖矩阵及明确排除项                                  | `scripts/tools-v2-e2e.mjs`              |
| [`lazy-sandbox-context.md`](./lazy-sandbox-context.md)     | 冷会话首次调用和 Sandbox 活跃时间刷新                                      | API tool part + PG `sandbox`            |
| [`grep-sandbox-truncate.md`](./grep-sandbox-truncate.md)   | Sandbox grep 超 limit 截断                                                 | tool part metadata `matches/truncated`  |
| [`write-exists-semantics.md`](./write-exists-semantics.md) | 新建、覆盖空文件/已有文件及内容验证                                        | write metadata + PG + Sandbox 文件      |
| [`read-error-no-destroy.md`](./read-error-no-destroy.md)   | read 错误分类（单测）及正常文件 E2E                                        | Core 单测 + `tools-v2-e2e.mjs`          |
| [`read-fast-timeout.md`](./read-fast-timeout.md)           | 正常 read、真实 files API timeout/取消/重试的单测与服务级 E2E               | API E2E + 单测 + 源码边界说明           |
| [`session-tools.md`](./session-tools.md)                   | Session Tool API、PG、Sandbox 优先级                                       | `scripts/session-tools-full-v2-e2e.mjs` |

## 版本与证据规则

- V2 API 前缀为 `/api`；模型 prompt 经 `/api/session/:sessionID/prompt_stream` 或 prompt/wait 流程。Sandbox shell 入口为 `/api/session/:sessionID/shell`。
- V2 tool part 位于 `session_message.data.content[]`，字段使用 `name`、`state.status`、`state.metadata`；不能使用 V1 `part` 表或 `data->>'tool'` 查询。
- `shell` 是当前内置命令工具名。提示模型调用某工具不等于实际调用；应检查 tool part 的名称、状态、输入和输出。
- 历史运行记录标注日期/环境，仅证明当时环境。没有本次重跑记录时不得表述为当前通过。
- 已删除依赖 V1 路由、不可达断言或模型不稳定行为的旧用例；已知未实现行为明确记录为 gap，不把观察结果伪装成通过。

## 验证记录

记录规则：只登记**确实执行过**的运行，并标注日期、执行方式与实际结果。未执行的用例在此明确标为「未执行」，不得沿用历史数字充当当前结论。

### 2026-10-01（SaaS 容器 + 本地 PG `opencode-v2-up` + 本地 OpenSandbox）

环境：服务镜像 `opencode-saas-sandbox-test:9d86bde786-files-timeout`（含当前工作区未提交改动），容器 `opencode-saas-test`，仅通过 HTTP API 与 PG 核对。测试机开启了 HTTP 代理，`curl`/脚本必须走 `NO_PROXY=localhost,127.0.0.1`。

| 用例 | 执行方式 | 结果 |
|---|---|---|
| `read-fast-timeout.md` T-RFT.3 | `read-files-timeout-v2-e2e.mjs` + `opensandbox-files-fault-proxy.mjs` | ✅ 连续 2 次 `0 failed`（9 项断言全过） |
| `tool-calls.md` T32/T-LZY/T-WEX/T-RDX/T18/T-GTR | `tools-v2-e2e.mjs` | ✅ 29/29 `0 failed`（prompt 严格化修正后的运行；此前 4 次运行中 T18.2 glob 因 prompt 缺陷失败 2 次，见下方说明） |
| `lazy-sandbox-context.md` T-LZY.1/1b/2 | 含在 `tools-v2-e2e.mjs` | ✅ 通过 |
| `grep-sandbox-truncate.md` T-GTR.1 | 含在 `tools-v2-e2e.mjs` | ✅ 通过 |
| `write-exists-semantics.md` T-WEX.1/2/3 | 含在 `tools-v2-e2e.mjs` | ✅ 通过（含 PG 校验） |
| `read-error-no-destroy.md` | Core 单测 `tool-read.test.ts` + `tool-read-filesystem.test.ts` | ✅ 56 pass / 0 fail |
| `session-tools.md` T32.1–T32.29 | `session-tools-full-v2-e2e.mjs` | ✅ 全部通过（分轮次，见下方说明） |
| `read-fast-timeout.md` 单测 | `sandbox-files-timeout.test.ts` 等 3 个文件 | ✅ 37 pass / 0 fail |

`session-tools.md` 全量需要 Model Request Audit（T32.27 断言要求审计记录非空）。本轮分两次运行合并取证：

- 容器 `opencode-saas-direct:14097`（未开审计）：26 passed / 1 failed，失败项为 T32.27（无审计记录，环境未满足，非功能缺陷）。
- 容器 `opencode-saas-audit:14098`（`OPENCODE_MODEL_REQUEST_LOG=/audit`）：T32.27 通过；T32.29 因模型响应偶发超时。
- T32.29 单独重跑（`ONLY=T32.29`）：通过。

两次运行的偶发失败项互不相同且各自重跑通过，判定为模型响应时序问题，不是产品缺陷。

`tools-v2-e2e.mjs` 的 `T18.2 glob lists both fixture files` 在当天 4 次运行中失败 2 次（`No files found`）。独立复现确认 glob 工具本身正常（规范输入 `pattern=**/*.ts, path=/workspace/tools-check/src` 稳定返回两个文件），根因是**该用例 prompt 未严格指定 path/pattern 拆分**（写的是"列出 /workspace/tools-check/src/**/*.ts"，把参数形态留给模型自由发挥），而全部稳定用例均使用"严格"措辞分别指定两个参数。已按仓库规则（不依赖模型不稳定行为）把 prompt 改为严格指定 path 与 pattern，并在断言证据中输出 glob input 便于诊断。修正后重跑结果见上表。

### 历史记录（环境不同，不作为当前结论）

以下为更早的运行结果，执行环境与本轮不同，仅作参考：

- `session-tools-full-v2-e2e.mjs`：27 项通过、0 项失败。测试服务启用 Model Request Audit，T32.27 依据 provider request 记录验证无效导出未进入工具目录。
- Read 单测：56 项通过、0 项失败。
- `tools-v2-e2e.mjs`：曾在隔离 PG `opencode-v2-tools-e2e` 上通过，不等价于本轮结果。
