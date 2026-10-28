# hn-gateway 用例索引（e2e）

> `packages/hn-gateway`（影刀前端网关 Hono + PG 迁移版）的全链路 e2e 用例。
> 覆盖依据：[../../DESIGN.md](../../DESIGN.md) 与对原 `xybot-front-gateway` 的两轮逐文件审计（18 项差异修复清单）。
> 用例编号全局唯一（`G*`），跨文件引用不断链；全部断言基于 2026-10 实测行为，执行不符记 `FAIL`。
> **测试脚本直接内嵌在各 md 文件中**（bash + curl + psql + python3 fake 上游），整块复制到终端即可执行，结尾输出 PASS/FAIL 汇总。

## 文件目录

| 文件 | 用例段 | 覆盖内容 | 实测 |
|---|---|---|
| [base.md](./base.md) | G01 | 服务与全局契约：/health 配置就绪语义（空配置 503 摘流）、响应包装 `{code,success,data,message}`、错误形态 `{statusCode,timestamp,url,message}`、/gw-api 域名白名单（front-gw/health/localhost）、尾斜杠归一、X-Trace-ID、/metrics、Nest 风格 404 | | 30 PASS |
| [config.md](./config.md) | G10 | 配置面（Nacos→PG）：apps CRUD/upsert、domain/baseRoute 匹配（精确+根回退+community 特例）、platform 聚合视图、`/nacos/*` 运维语义（status/refresh/resubscribe/cache/fix/app update 默认 incremental+乐观锁 409/subscribedConfigs）、configs KV、写后缓存失效（NOTIFY） | | 33 PASS |
| [hosting.md](./hosting.md) | G20 | hosting 责任链：api-proxy（转发/头过滤/业务码告警/oauth）、internal-proxy（正则前缀/404）、static-file（扩展名判定/version/mime/404）、SSO 中转页、redirect 规则、app-hosting 兜底（window.YD 注入快照/MICRO_APPS/favicon/指纹缓存/version 头覆盖/app.proxy 整机透传/ssg 路径/未知域名）、app-api-info（空对象语义） | | 37 PASS |
| [gray.md](./gray.md) | G30 | 灰度：请求头 version 最高优先、四策略矩阵（backend-gray：globalEnabled/白/黑名单/Java hashCode 分桶边界/时间窗；user-enterprise：企业/用户覆盖；network：IP 精确/CIDR/::ffff:；percent：cookie 复用/版本切换/回写）、策略优先级排序、ap 管理面（backend-gray 双模式、feature 规则 PUT/GET+外部服务开关、polling status/start-all/diagnose） | | 36 PASS |
| [publish.md](./publish.md) | G40 | 发布链路：apps publish（publishList 置顶/50 条截断/publishes 流水）、publishList、ap version 旋转、rollback（成功/不在历史）、webhook 审批回调（approval/step、非 approved 统一 success、缺参/未找到记录）、apps/project/:appId（GitLab 建项目+重复校验） | | 32 PASS |
| [multi-pod.md](./multi-pod.md) | G60 | 多 pod 实时同步（应用配置/HTML 指纹/灰度规则/微前端注册表秒级同步、直写+NOTIFY 通道）+ **PG 不可达兜底演练**（stale 降级/health 不摘流/恢复自愈，OrbStack 容器实测） | 14 PASS / 2 SKIP |
| [report-upload.md](./report-upload.md) | G50 | 上报与上传：report POST（明文/PG 事件/span=http 飞书告警/RSA+AES 加密上报）、/app/:appId/:version 视图、/log /search /customSearch（ELK 透传或未配置提示）、upload file（multipart/latin1 文件名）/text、gitlab namespace/branches/members | | 30 PASS |

> 已知覆盖缺口（未脚本化）：
> 1. socket.io ws 透传——Bun 运行时限制（upgrade 后裸写不可达），由 `test/ws-e2e.node.mjs`（node 子进程）覆盖，见包内 `bun run test`。
> 2. 多实例 NOTIFY 跨进程失效——需双实例编排，核心语义由 `test/notify.test.ts` 覆盖。
> 3. 云效 pipelines——需真实凭据，仅验"未配置 503"，实际调用不脚本化。

## 共享运行环境

脚本面向**已启动的网关**执行；`config.md`/`hosting.md`/`publish.md`/`report-upload.md` 需要配套 **fake 上游**（COS 静态/飞书/GitLab/媒体服务/ELK），由内嵌 python3 脚本启动。

```bash
# 1) 启动网关（本地 PG：127.0.0.1:5432/opencode-v2-up，schema hn_gateway_dev）
cd packages/hn-gateway
GATEWAY_PORT=3101 GATEWAY_DATABASE_SCHEMA=hn_gateway_dev \
GATEWAY_API_TARGET=http://127.0.0.1:18990 \
GATEWAY_CND_DOMAIN=127.0.0.1 \
GATEWAY_GITLAB_API_URL=http://127.0.0.1:18990/gitlab/api/v4 \
GATEWAY_GITLAB_TOKEN=uc-token \
GATEWAY_MEDIA_UPLOAD_URL=http://127.0.0.1:18990 \
GATEWAY_MEDIA_UPLOAD_TOKEN=uc-media \
GATEWAY_ELK_URL=http://127.0.0.1:18990 \
GATEWAY_ELK_NAME=uc GATEWAY_ELK_PASSWORD=uc \
bun run src/server.ts

# 2) 起依赖 PG（如未运行；本仓库标准本地库亦可）
# psql "postgresql://postgres:ab123456@127.0.0.1:5432/opencode-v2-up" -Atc 'select 1'
```

环境变量覆盖脚本默认值：`BASE`（默认 `http://127.0.0.1:3101`）、`PGURL`（默认 `postgresql://postgres:ab123456@127.0.0.1:5432/opencode-v2-up`）、`SCH`（默认 `hn_gateway_dev`）、`FAKE`（默认 `http://127.0.0.1:18990`）。

## 判定语义

- 每条用例输出 `PASS <编号> <描述>` / `FAIL <编号> <描述> expect=[..] got=[..]`，结尾汇总并以 fail 数作为退出码。
- 环境阻塞（网关未起、PG 未起、fake 上游未起）不计 FAIL：相应用例标注 SKIP，**不得伪造通过**。
- 用例对 `SCH` schema 写入的测试数据均以 `uc_` 前缀命名，脚本开头/结尾清理，保证幂等可重跑。

## 实测注意（踩过的坑，执行前先读）

1. **响应包装**：`/gw-api/*`、`/report-api/*` 的控制器响应统一被包成 `{code:200, success:true, data:<原值>, message:'Success'}`——断言一律解 `.data`；部分控制器自身返回 `{success,...}` 时是双层嵌套（与原网关一致）。
2. **/health 不走包装**（原实现 @Res 直写语义）；health 语义是**配置就绪检查**：apps 表为空 → 503。
3. **Host 头**：curl 直连时 Host 为 `127.0.0.1:port` 属 localhost 白名单，`/gw-api` 放行；要验证"无权访问"需显式 `-H 'Host: evil.example.com'`。
4. **静态回源 URL**：`{app.url}/{version}{baseUrl}`（baseUrl 含 baseRoute 前缀），fake COS 需按该路径应答。
5. **HTML 缓存指纹**：修改 app 配置（含 version）即换 key 重新回源；同配置 60s 内命中缓存不再回源（fake COS 命中计数可断言）。
6. **percent 灰度 cookie**：`gray_hash_{appId}={version}:{hash}`，版本不匹配即重算并回写 Set-Cookie。
7. **日期格式**：错误响应 timestamp 为本地时间 `yyyy-MM-dd HH:mm:ss`；publishList time 同格式。
