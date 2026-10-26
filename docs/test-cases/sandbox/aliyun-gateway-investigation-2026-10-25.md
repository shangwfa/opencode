# 阿里云 MCP 502 排查更正

## 已验证的触发条件

此前测试容器关闭 `OPENCODE_SESSION_AUTO_KEEPALIVE`，测试会话为 `persistMode=none`。预热轮结束后，`packages/core/src/session/execution.ts` 的 `destroyUnkeptSandbox` 按设计销毁沙箱。后续调用可能仍持有旧 MCP 连接，不能把此时的网关 502 归因为阿里云平台波动。

关键对照：

| 测试 | 真实结果 | 证据 |
| --- | --- | --- |
| 无保活的预热轮后继续访问 | PG 进入 snapshotting；shell 报 Sandbox identity is no longer current | `artifacts/aliyun-sandbox/diagnose-corrected-2/diagnose.json` |
| 显式保活，预热后单次 MCP 调用 | everything.echo completed，无错误；桥 PID 130 前后不变；会话删除 204 | `artifacts/aliyun-sandbox/diagnose-kept/diagnose.json` |
| 显式保活，连续三轮模型调用 | 三次真实 echo completed，0 次嵌套工具错误；PG provider=aliyun，清理后 destroyed、remote_name=null | `artifacts/aliyun-sandbox/mcp-kept-three-rounds/` |

所有对照都使用真实阿里云沙箱和 Docker SaaS；模型测试订阅公共会话 SSE。成功对照未升级 Bun、未固定 DNS/IP、未关闭连接池，也未自动重放 MCP 调用。

## 排查中的错误假设

- 原生探针在多个空闲时长、GET SSE 共存、不同 IP/URL 形态下成功，不支持此前关于平台时段性故障或 Bun DNS 故障的断言。
- 旧尸检脚本遗漏 `persistMode=none`，会落到未开放的持久化路径；这些超时不能证明网络故障。
- PG 返回包含 sbx ID 的结果，只证明查询返回了历史绑定，不能证明当前 SDK 卡在数据面就绪阶段。
- 502/503/504 空响应体不能证明工具没有执行。已撤回基于此推断的自动重放、throw 型诊断包装、全局 Connection: close 与桥 keepAliveTimeout 修改。

新增 `mcp.test.ts` 回归用例：服务端先记一次副作用，再返回空 502/503/504，客户端不得自动重放。

## 测试修正与剩余范围

跨轮测试使用执行器参数 `SESSION_KEEPALIVE=1`，通过 SaaS keep-alive API 设置对应会话，不改变部署默认值。临时模式不承诺轮间保存文件；需要跨轮使用同一沙箱时必须保活。

旧 MCP runtime 在沙箱销毁或代次变化后的失效处理值得另行验证。本次未声称已修复非保活临时模式的所有重建竞态，也未证明阿里云永不发生网关故障。

## snapshot 持久化复测

证据：`artifacts/aliyun-sandbox/persistence-20261025/spike.json`。

真实实例完成创建、文件写读和鉴权端口验证；暂停被云端拒绝：`400: code: 403, Pause session operation is forbidden, pauseSession is not enabled for this function`。因此未进入暂停，无法校验恢复后的文件保留，也没有完成 SaaS snapshot 模式 E2E。

探测 finally 已终止该实例，随后 getInfo 确认不存在。需先开通模板/函数的暂停恢复能力，再测试完整的 SaaS 创建、停止、恢复、文件校验和 PG 代次链路；独立 Snapshot API 是另一项能力，不与暂停混同。

## 独立 Snapshot 文件存储实测

脚本：`packages/core/script/aliyun-snapshot-files.ts`。证据：`artifacts/aliyun-sandbox/independent-snapshot-files/result.json`。

在 Docker 内通过 E2B API 创建真实源沙箱，中文文本和二进制文件均写入 `/workspace/snapshot-files`，完成文本比对与 SHA-256 校验。随后调用 `createSnapshot`（未调用 pause）被云端拒绝：`400: sandbox runtime does not support snapshot`。

只读模板列表返回一个模板 `code-interpreter-v1`，与控制台显示的一代运行时一致。当前未生成快照、未执行恢复，不能声称快照文件存储通过。源沙箱已终止，专用测试容器已删除。

需新建或提供二代 MicroVM 模板后重跑；脚本通过 `OPENCODE_ALIYUN_TEMPLATE` 指定测试模板，不修改原有模板或 SaaS 临时沙箱默认配置。

### 二代 MicroVM 复测通过

用户提供 `base-5wa5`（模板 ID `a9frlxkz1mmkay6y11b1`），控制台确认二代 MicroVM。Docker 内通过真实阿里云 API 连续两次完成：

1. 创建源沙箱，写入中文文本与含零字节的二进制文件，验证内容及 SHA-256。
2. 调用独立 `createSnapshot`，未调用 pause/resume。
3. 删除源沙箱，确认其 getInfo 返回不存在。
4. 从快照创建不同 ID 的新沙箱，文本与二进制 SHA-256 均一致。

最终轮快照创建约 8.3 秒，新沙箱创建约 1.8 秒。源沙箱、新沙箱及测试快照均已删除；最终轮快照删除第二次成功。删除仅针对本轮已记录的快照 ID 进行有限幂等重试，不重试创建快照或工具调用。

最终证据：`artifacts/aliyun-sandbox/independent-snapshot-v2-verified/result.json`。这是阿里云原生快照文件存储验证，不表示已经实现 SaaS provider 的自动快照保存/恢复；SaaS 默认仍为临时沙箱。
