# V2 Read 错误分类

## 自动化边界

Read 的非法 offset、二进制内容和无效 UTF-8 都需要确定性输入；不依赖模型按 prompt 传入特定非法参数。当前由 Core 单测覆盖。仓库根 `bunfig.toml` 禁止从根跑测试，必须在 `packages/core` 下执行：

```bash
cd packages/core && bun test test/tool-read.test.ts test/tool-read-filesystem.test.ts
```

断言应检查错误类型/原始错误信息传播；这些是工具内部错误映射测试，不应通过“Sandbox 是否被 destroy”推断，因为 V2 当前 read 实现没有 V1 的 `SandboxReadTimeout` destroy 分支。

正常小文件 read 闭环见 [`scripts/tools-v2-e2e.mjs`](../scripts/tools-v2-e2e.mjs) 的 T-RDX.2。其 API/E2E 证据检查 tool part 和文件内容；环境运行方式见 [`tool-calls.md`](./tool-calls.md)。

## 删除的旧 E2E

依赖模型主动传 `offset=99999` 的旧用例已移除：模型可以忽略该参数，导致错误分支断言不可达。V1 `/session`、`/exec`、`part` 查询以及“非超时错误后 Sandbox ID 不变”断言也不适用于 V2 当前实现。
