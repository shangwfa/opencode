# MCP 阿里云验收清理复核

2026-10-25，专用数据库 `opencode-v2-aliyun-mcp-test`：

- session_v2：0
- session_mcps：0
- sandbox_command：0
- sandbox：5 行，均 provider=aliyun、state=destroyed、remote_name=null。

原生 E2B SDK `Sandbox.getInfo` 逐个返回 `SandboxNotFoundError`：

- sbx-17980b64-c322-43d8-a59b-e9141f54e173（B）
- sbx-742fa225-060a-4a6e-b36a-49d0cdaf35a4（C）
- sbx-11c27f09-9ee3-478a-84a8-017c3b108506（E）
- sbx-7b505b46-3ac8-4f23-b1d3-365ff57e3d68（D）
- sbx-491c3345-ef44-4e8b-a08f-a67190902768（D2）

本机 19105 端口的 PID 56423 经命令行核对为本轮 remote fixture 后发送 SIGTERM，收到退出通知。Docker `opencode-vercel-t19-mcp-aliyun` 已停止；日志保存在 `docker.log`。保留数据库、停止的容器和原始失败证据。

结果：A/C/E/D2 通过；B 在 T22.31 失败。D 首轮为包装器子会话沙箱行数量假设错误，D2 配置纠正后重跑通过。T22.22/23 单测覆盖，T22.23 无精确墙钟边界断言。产品恢复策略未修改。
