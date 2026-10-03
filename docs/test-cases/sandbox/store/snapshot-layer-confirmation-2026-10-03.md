# 远端快照层增量核验（2026-10-03，权限阻塞）

## 已确认

通过 Docker SaaS API 创建专用会话 `ses_eff137778ffeMofzh3oWGIOQrr`，写入 8MiB 随机文件和小文本，再执行三个真实快照和两次恢复。PG 与 shell 校验均通过。

| 快照 | ID | 源沙箱 |
|---|---|---|
| S1：8MiB 内容 | `69558461-7595-4d50-b039-c31392a21513` | `25a168b4-e5ae-4c8c-a26c-7b42e9ccc02a` |
| S2：同一活跃沙箱，小改文本 | `4569e894-f486-409d-8595-6f29e2f1d680` | `25a168b4-e5ae-4c8c-a26c-7b42e9ccc02a` |
| S3：从 S2 恢复后，小改文本 | `fa12f7de-5427-43af-b143-82c630f90ca2` | `e5b5fc2f-2034-481e-b7db-d65a50b69161` |

- 三个快照 PG state=ready，source_sandbox_id 分别符合预期。
- S1/S2 确实同一活跃沙箱；快照后平台 GET 的 image.uri 都仍是 `session-terminal-20261003` 启动镜像，没有切换成 S1。
- 从 S2 恢复后平台 snapshotId 符合 S2，从 S3 恢复后符合 S3。
- 两次恢复均通过 8MiB 文件 SHA-256 校验，文本新增内容也保留。
- 诊断接口实际返回 text/plain（不是 JSON），因此最初在 S1 后解析失败。修复后复用同一沙箱和已保存 S1 继续执行，没有偷换 S1/S2 的“同沙箱”条件。
- 从 S3 恢复后的 Pod 诊断文本明确列出实际镜像：
  `registry.shadow-rpa.net/infra/sandbox:e5b5fc2f-2034-481e-b7db-d65a50b69161-sandbox-snap-fa12f7de542743afb14382c630f90ca2`。

## 未确认及阻塞证据

**不能据上面事实断言 S2 新层一定重包含 8MiB 文件，或直接断言远端 committer 与本地源码相同。** 不切换活跃沙箱的启动镜像不排除平台另有检查点增量算法。

计划读取三个 OCI manifest，核对 S1/S2 基础层是否相同、S3 是否继承 S2 层，再读取各最后一层检查 payload 是否重包含。只下载最后一层，并验证 descriptor 的 SHA-256；不拉完整数 GB 镜像、不解包其他文件。

实际访问结果：
- 当前 kubeconfig 只有 orbstack 上下文，没有远端集群访问配置。
- 没有找到与远端 IP 对应的 SSH 配置；没有猜账号或尝试读取 Kubernetes Secret。
- 宿主访问 Registry 失败，SaaS 容器也无法访问 Registry。
- 专用远端沙箱能访问该 Registry，但对上述实际镜像的匿名只读请求返回 HTTP 401。
- 当前 Docker 配置没有该 Registry 的 inline auth 或 credential helper。
- OpenSandbox OpenAPI 的 `info.version=0.1.0` 是 API 合约版本，不能作为 committer 的部署源码版本。

没有权限就不能给出确定的层粒度结论。下一步需要 Registry 对 `infra/sandbox` 的只读 pull 权限、远端集群的相关只读访问，或已导出的三个 manifest/config 与末层归档。凭据应通过安全配置/环境注入，不放入报告或聊天正文。

## 资源与记录

- 只创建这一专用测试会话，暂保留以继续核验；没有修改平台配置、用户沙箱或删除其他资源。
- 测试脚本：`docs/test-cases/scripts/snapshot-layer-confirmation-e2e.mjs`。
- 原始阶段记录：`evidence/snapshot-layer-confirmation.json`、`evidence/snapshot-layer-confirmation.log`。
- 仅保留指定诊断镜像字段：`evidence/remote-diagnostics-images.json`。
- 匿名 Registry 读取失败记录：`evidence/sandbox-registry-probe.log`。
- 本次报告与证据纳入2026-10-04快照优化补提交；未推送。Registry层内容核验仍未完成，不随提交改变结论。
