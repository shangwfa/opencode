# V2 Lazy Sandbox 与活跃 touch

## 用例范围

| 用例 | 断言 | 自动化位置 |
|---|---|---|
| T-LZY.1 冷会话首次工具创建 Sandbox | 新 Session 不预建 Sandbox；首条 glob tool part 为 `completed`；PG 中该会话对应 Sandbox 变为 `running` | [`scripts/tools-v2-e2e.mjs`](../scripts/tools-v2-e2e.mjs) |
| T-LZY.2 工具活动刷新时间 | shell 执行前后 PG `sandbox.time_updated` 严格增加 | 同上 |

## 执行

遵循 [`tool-calls.md`](./tool-calls.md) 的 V2 环境配置，执行：

```bash
bun docs/test-cases/scripts/tools-v2-e2e.mjs
```

用例通过要求脚本退出码为 0，且输出中 T-LZY.1、T-LZY.1b、T-LZY.2 均通过。脚本创建/删除测试 Session，PG 断言依据 V2 `sandbox` 表；不再使用 V1 `/session/:id/exec`、`part` 表或未绑定 Sandbox owner 的汇总查询。

## 历史 V2 实测

2026-09-24：冷会话首次 glob 完成；执行后 Sandbox 状态为 running；连续 shell 后 `time_updated` 从 `1790237126491` 增至 `1790237140286`；混合 shell/read/write 均完成。当前可重复自动化以脚本断言为准，历史记录只作为此前环境的结果，不替代本次执行。
