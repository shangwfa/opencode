# V2 Sandbox Grep 截断

## 用例范围

自动化用例 T-GTR.1 在 Sandbox 中写入 120 条匹配行，再用 grep `limit=100`。通过条件：tool part `name=grep`、`state.status=completed`、`state.metadata.matches=100`、`state.metadata.truncated=true`。断言从真实 V2 assistant tool part 读取，而不是模型总结文本。

## 执行

```bash
bun docs/test-cases/scripts/tools-v2-e2e.mjs
```

环境变量、V2 API/PG 证据和清理方式见 [`tool-calls.md`](./tool-calls.md)。该脚本覆盖语义正确性，不以固定耗时作为 E2E 门槛；性能比较需独立基准环境，避免共享 CI/Sandbox 负载造成不稳定判定。

## 已有记录与适用范围

2026-09-24 的历史 V2 记录：300 条匹配截断为 100 条（485ms）；5 万条匹配截断为 100 条（737ms）；窄匹配返回 1 条且未截断（276ms）。这些是历史性能观测，不是当前脚本每次运行的断言。V1 `/session`、`/exec` 与 PG `part` 查询步骤已移除。
