# Back-end Java（会话级 Java 沙箱 + AI 开发 Spring Boot 应用 e2e）

> 全链路场景：启动 Java 沙箱镜像的 SaaS 实例 → 创建会话并 boot 沙箱 → 验证 Java 环境 → AI 开发 Spring Boot 项目与设备管理 CRUD → proxy 通道 e2e 验证。
>
> **V2 迁移说明（2026-09-29）**：本文已从 V1 端点迁移到当前 `/api` 协议。V1 的 `POST /session`、`POST /session/:id/exec`、`POST /session/:id/prompt_stream` 均已不存在或改路径；V1 的 `exec` 同步返回 `stdout` 的形态已改为「创建 shell → 读 Session Message 取终态」。迁移中同时发现两处能力缺口，见下方 T42.1 与 T42.2。
>
> 前置条件：SaaS 已启动、本地 PG 可用、Session 沙箱已启用。见 `docs/local-test-env.md`。

---

## 当前能力边界（迁移时核实）

| 文档原用例依赖的能力 | V2 现状 | 结论 |
|---|---|---|
| `POST /session` 传 `sandbox.image` 指定会话镜像 | **已实现**：`Session.SandboxResource.image`（optional），provider 按 session 优先、env 兜底 | 已支持，见 T42.1 |
| `POST /session/:id/exec` 同步返回 stdout | 改为 `POST /api/session/:sessionID/shell`（返回 204），结果从 `session_message` 中 `type='shell'` 的终态读回 | 已迁移，见 `run_shell` |
| `POST /session/:id/keep-alive` + `boot:true` | 沙箱在首次 shell/prompt 时按需 boot | 已迁移，见 T42.2 |
| `POST /session/:id/proxy/8080/...` | 保留在 `/api/session/:sessionID/proxy/:port/*`（全方法），**但需要 Basic Auth** | 已迁移，见 T42.6 |

### per-session image 语义

对齐 V1（`feat/opencode-1.18.31`：`src/session/sandbox-opts.ts` + `src/tool/sandbox-provider.ts`）：

- `sandbox.image` 可选。**未指定或为空白时使用部署默认** `OPENCODE_SANDBOX_IMAGE`。
- 空白串（`""` / 纯空格）视为未指定，而不是让 create 失败去拉一个名为空串的镜像。
- 仅接受字符串；非字符串（数字、对象、null）一律回退默认。
- 存储：`session_v2.sandbox` 是 JSON 列，**无需数据库迁移**。
- 不做镜像白名单（与 V1 一致）。调用方需自行确保 API 访问受控。

---

## 测试环境

```bash
source docs/test-cases/test-env.sh 3
export OPENCODE_PASSWORD='<服务口令>'   # test-env.sh 在无 opencode-saas-test 容器时不会自动取到
source docs/test-cases/test-lib.sh
test -n "$BASE" && test -n "$PG_URL" && test -n "$OPENCODE_PASSWORD"

# Java 沙箱镜像（Ubuntu 24.04 + OpenJDK 21 默认 / 8、11、17 多版本，无 JAVA_HOME）
export SB_IMAGE="crpi-hlpnu8kiweghie0r.cn-hangzhou.personal.cr.aliyuncs.com/shangwfa/opencode-sandbox:session-terminal"

# ⚠️ 迁移要求：V2 无 per-session image，镜像必须在 SaaS 实例启动时注入。
#     不设置时该实例的所有 Session 都会用默认镜像，T42.3 会失败。
#     OPENCODE_SANDBOX_ENABLED / OPENCODE_SANDBOX_PROTOCOL=http 同样必需，
#     否则沙箱不可用，表现为 "requires an enabled Session Sandbox"。
docker rm -f opencode-saas-java-e2e 2>/dev/null
docker run -d --name opencode-saas-java-e2e -p 14096:4096 \
  -e OPENCODE_PASSWORD="$OPENCODE_PASSWORD" \
  -e OPENCODE_DATABASE_URL=postgresql://local@host.docker.internal:15432/opencode-v2-up \
  -e OPENCODE_SANDBOX_ENABLED=true \
  -e OPENCODE_SANDBOX_PROTOCOL=http \
  -e OPENCODE_SANDBOX_DOMAIN=host.docker.internal:8080 \
  -e OPENCODE_SANDBOX_USE_SERVER_PROXY=true \
  -e OPENCODE_SANDBOX_IMAGE="$SB_IMAGE" \
  opencode-saas-codemode-current:local

until curl -s --noproxy '*' "$BASE/api/info" >/dev/null 2>&1; do sleep 2; done
echo "SaaS ready"
```

### 辅助函数（V2 语义）

V1 的 `exec` 同步返回 stdout 已不存在。当前语义是：提交命令返回 `204`，命令作为 `type='shell'` 的 Session Message 异步落库，**终态从 PG 读回**。不要用 prompt 接口返回的受理结果当作执行结果。

以下函数已在 `docs/test-cases/test-lib.sh` 中实现，source 后直接使用，**不要在用例里重复定义**：

| 函数 | 用途 |
|---|---|
| `api_curl` | V2 认证 HTTP 入口（Basic Auth + `/api` 前缀 + `--fail-with-body`）|
| `new_session '<json>'` | 创建 Session 并回显 ID，可传覆盖字段 |
| `message_watermark SID` | 取当前 `session_message` 水位，用于界定"本次新增" |
| `run_shell SID "cmd" [超时]` | 跑沙箱命令，输出 stdout/stderr 与 `--- exit=N` |
| `run_shell_status SID "cmd" [超时]` | 同上，只回显退出码 |
| `stream_prompt SID "msg" [超时]` | SSE 流水观察（V2 事件契约）|

关键语义提醒：

- shell 消息 `data.metadata.exit` 是退出码；`data.status` 取 `exited` 才代表终态，`running` 不可当作结果。
- `session_message.data` 在本地 PG 中是 `text`，查询前必须 `::jsonb`。
- V1 的 `new_sid` 已改为显式报错，避免旧用例静默走错协议。

---

## 一、会话与沙箱

### T42.1 创建会话指定 sandbox 资源（image 能力缺失）

```bash
# ⚠️ model 必须在创建 Session 时指定，或创建后立即调用 ensure_model 切换。
#    prompt 接口不接受 model 参数；不指定会落到服务默认 provider，实测返回
#    403 "OpenCode's free tier can only be used from within OpenCode"。
#    该错误只出现在 session.step.failed，只等 execution.failed 的消费者看不到原因。
SID=$(new_session_with_model "{\"title\":\"java-e2e\",\"sandbox\":{\"cpu\":\"2\",\"memory\":\"4Gi\",\"image\":\"$SB_IMAGE\"}}")
echo "SID=$SID"
api_curl "$BASE/api/session/$SID" | jq -c '.data | {sandbox, model}'

# 不指定 image：应回落到部署默认，且 sandbox 中不出现 image 键
SID_NODIMG=$(new_session_with_model '{"title":"java-e2e-default-img","sandbox":{"cpu":"2","memory":"4Gi"}}')
api_curl "$BASE/api/session/$SID_NODIMG" | jq -c '.data.sandbox'

# 空白 image：等价于未指定，不得让 create 去拉一个空串镜像
SID_BLANK=$(new_session_with_model '{"title":"java-e2e-blank-img","sandbox":{"cpu":"2","memory":"4Gi","image":"   "}}')
api_curl "$BASE/api/session/$SID_BLANK" | jq -c '.data.sandbox'
```

**期望**：

- 指定 `image` 时回读 `sandbox` 含该 image 值；`model.providerID` 与 `$MODEL` 一致。
- 不指定 image 时回读为 `{"cpu":"2","memory":"4Gi"}`，**不含** `image` 键。
- 空白 image 同样不含有效 image（`image` 键存在但为空白字符串，语义上等同未指定）。

**镜像真正生效的验证在 T42.3**：`sandbox` 列不存实际使用的镜像名，只存请求值。字段回读一致只证明"请求被接受并持久化"，**不能**证明控制面真的按此镜像创建了沙箱。必须用 T42.3 的沙箱内特征（`/usr/lib/jvm` 多版本）间接确认。

> `new_session_with_model` 内部是「创建 + `POST /api/session/:id/model` 切换」（实测 204 立即生效），所以不必为换模型而重建会话。已实测：不带 model 建会话时 `model.providerID` 为空，`ensure_model` 能正确切到目标模型。

**测试环境注意**：本用例需要实例默认镜像与 session 镜像都能被本地 OpenSandbox 拉取。若 `docker images` 里没有 `$SB_IMAGE`，先 `docker pull`；否则 T42.3 会失败并被误判为功能问题。

### T42.2 boot 沙箱 + PG 记录

V2 不再提供显式 `keep-alive {boot:true}`；沙箱在首次需要时按需启动。用一次真实 shell 触发 boot：

```bash
run_shell_status "$SID" 'echo booted' 300
pgval "SELECT state FROM sandbox WHERE session_id='$SID' ORDER BY time_created DESC LIMIT 1"
```

**期望**：shell 返回 `0`；PG `sandbox` 表该 session 有 `state=running` 记录。sandbox 表**不存镜像名**（镜像由 K8s/OpenSandbox 侧持有），镜像生效只能靠 T42.3 验证。

**补充核对**：`keepAlive` 行为影响沙箱 idle 回收时长（`OPENCODE_SANDBOX_TIMEOUT_SECONDS` / `IDLE_REAP_SEC`）。T42.4–T42.7 是长任务，跑测前确认 idle 回收不会中断正在构建的进程。

### T42.3 Java 环境验证（镜像特征）

```bash
run_shell "$SID" 'java -version 2>&1; javac -version 2>&1; ls /usr/lib/jvm'
```

**期望**：`exit=0`；OpenJDK 21.0.x（Ubuntu 24.04 build）；`/usr/lib/jvm` 含 8/11/17/21 多版本。

**失败判读**：若输出为默认镜像（如 `opencode-opensandbox:*`，无 `/usr/lib/jvm` 多版本），说明 `OPENCODE_SANDBOX_IMAGE` 未生效或本地 OpenSandbox 拉不到该镜像——先核对容器 env 与 `docker images | grep session-terminal`，**不要**误判为 T42.3 功能失败。

---

## 二、AI 开发（stream_prompt 流式观察）

### T42.4 AI 创建 Spring Boot 项目

```bash
stream_prompt "$SID" "在 /workspace/spring-boot-demo 创建 Spring Boot 3 项目（Java 21），实现 GET /api/hello 返回 JSON {\"message\":\"hello from spring boot\",\"time\":<时间戳>}，执行 mvn package 确认 BUILD SUCCESS。若 mvn 不可用先安装。"
```

**期望**：流水中可见 `[tool] bash -> pending/running/completed` 流转、命令与输出；结束后确认 jar 存在：

```bash
run_shell "$SID" 'ls /workspace/spring-boot-demo/target/*.jar'
```

**注意**：Maven 首次构建需下载依赖，可能远超默认超时。构建类命令要显式给足 `timeoutSeconds`，不要用默认预算。

### T42.5 AI 开发设备管理 CRUD 功能

> 长任务（改 pom、建实体/DTO/Service/Controller/异常处理、构建、重启、自测），建议分两条消息：先写代码再构建自测，避免单次流超时。流断开不影响服务端继续执行。

> ⚠️ **沙箱不支持 `background` 执行**（实测）。`packages/core/src/tool/plugin/shell.ts:205-212` 在
> `sandboxProvider.enabled` 时对 `background: true` 直接返回 `ToolFailure`：
> `Background execution is not supported for sandboxed sessions yet. Re-run without 'background'.`
> 代码注释标注为 "not supported **yet**"，但当前是硬失败而非降级。
> 因此启动应用必须用 `setsid nohup ... &` 脱离会话，**不要**让 AI 用 `background: true`。
> 这是产品待评估项：`background` 在 sandbox 场景是常见用法，硬失败且错误信息未给替代方案。

```bash
stream_prompt "$SID" "开发设备管理功能：JPA+H2(文件模式 ./data/devices.db)；Device 字段 id/name/type/status(ONLINE/OFFLINE)/createdAt/updatedAt；API：POST /api/devices、GET /api/devices(分页+?status=过滤)、GET/PUT/DELETE /api/devices/{id}、POST /api/devices/{id}/status?value=；name/type 必填校验，统一错误 JSON 结构。写完所有代码文件，不要构建。" 900

# 启动方式必须显式指定，否则 AI 可能先试 background=true 再自行绕过
stream_prompt "$SID" "mvn -B package（必须 BUILD SUCCESS，报错就修复）。然后启动应用：注意沙箱不支持 background 参数，请用 'cd /workspace/spring-boot-demo && setsid nohup java -jar target/spring-boot-demo-0.0.1-SNAPSHOT.jar > /tmp/app.log 2>&1 < /dev/null &' 方式，sleep 25 后用 curl 127.0.0.1:8080 自测完整 CRUD（创建2台→列表→改状态→更新→删除→再列表→空name应400→非法status应400→查999应404），最后保持应用运行不要停止。逐步汇报每项 HTTP 状态码。" 1200
```

**期望**：BUILD SUCCESS；AI 自测 10 项全过（201/200/204/400/404 均符合）。

**独立复核（不采信 AI 自述）**：AI 汇报的每项结果必须由外部请求复验，见 T42.6。AI 自报「全部通过」不构成通过依据。

---

## 三、proxy e2e 全链路

### T42.6 外部经 proxy 验证 CRUD

```bash
P="$BASE/api/session/$SID/proxy/8080"
curl -s --noproxy '*' "$P/api/devices" -o /dev/null -w "GET  列表: %{http_code}\n"          # 200
curl -s --noproxy '*' -X POST "$P/api/devices" -H 'Content-Type: application/json' \
  -d '{"name":"e2e-probe","type":"gateway"}' -o /dev/null -w "POST 创建: %{http_code}\n"  # 201
curl -s --noproxy '*' -X PUT "$P/api/devices/1" -H 'Content-Type: application/json' \
  -d '{"name":"probe-v2"}' -o /dev/null -w "PUT  更新: %{http_code}\n"        # 200
curl -s --noproxy '*' -X DELETE "$P/api/devices/1" -o /dev/null -w "DELETE: %{http_code}\n" # 204
```

**期望**：依次 `200 / 201 / 200 / 204`。

**注意**：设备 `id` 假定为 `1` 仅在库为空时成立。T42.5 的 AI 自测已创建并删除过数据，id 不保证为 1。应先查询实际 id：

```bash
DEV_ID=$(curl -s --noproxy '*' -X POST "$P/api/devices" -H 'Content-Type: application/json' \
  -d '{"name":"probe-id","type":"gateway"}' | jq -r '.id // .data.id')
echo "created id=$DEV_ID"
```

### T42.7 proxy POST body 转发（bug 回归项，必测）

> 2026-09-16 发现：proxy 转发 POST/PUT 时 body 为空（`sandbox-proxy.ts` 直接透传 `request.source.body` 流，该流已被 server 层消费），上游 Spring 报 `Required request body is missing` → 400；GET 无 body 故一直正常。修复：`request.arrayBuffer` 缓冲后转发。镜像 `4d0b4c62af-proxyfix` 及之后版本含修复，**测旧镜像此用例必 FAIL**。

```bash
# 沙箱内对照（应 201）：证明 app 本身接受 body，排除 app 侧故障
run_shell "$SID" 'curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:8080/api/devices -H "Content-Type: application/json" -d "{\"name\":\"inner\",\"type\":\"probe\"}"'

# proxy 外部（修复后应同为 201；未修复镜像返回 400 且响应为 Spring 默认错误结构）
curl -s --noproxy '*' -X POST "$P/api/devices" -H 'Content-Type: application/json' \
  -d '{"name":"outer","type":"probe"}' -o /dev/null -w "proxy POST: %{http_code}\n"
```

**期望**：两处均 201。诊断特征：proxy 返回 400 且 body 为 `{"timestamp":...,"status":400,"error":"Bad Request","path":...}`（Spring 默认结构、无 message）时，优先怀疑 body 未转发，查沙箱内 app 日志确认。

**这组对照是本用例的核心**：只测 proxy 侧无法区分「proxy 丢 body」与「app 拒收 body」。必须先确认沙箱内直连 201，才能把 400 归因到 proxy 转发层。

---

### per-session image 实测（2026-09-29）

实例默认镜像故意设为**非 Java** 的 `opencode-opensandbox:local`，用于区分 image 是否真的生效。字段回读只证明"请求被接受并持久化"，**沙箱内特征才是决定性证据**。

| 会话 | `sandbox.image` | 沙箱内实测 | 结论 |
|---|---|---|---|
| A | `...:session-terminal` | `openjdk version "21.0.11" 2026-04-21`，`jvm_count=11` | **per-session image 生效**（默认镜像无 JVM） |
| B | 不指定 | `NO_JAVA`，`jvm_dir=0` | 正确回落到部署默认 |
| C | `"   "`（纯空白） | `NO_JAVA`，`jvm_dir=0`，沙箱**正常创建** | 空白视为未指定；未尝试拉取空串镜像导致 create 失败 |

A 与 B/C 的差异证明优先级正确：session 显式指定 > env 默认，空白等价于未指定。

补充澄清：V2 沙箱按 **root session** 分配（`boot` 先 `resolveSandboxKey` 归一化再 `getOrCreate`），与 V1 `resolveSandboxOpts` 向上遍历父链的行为一致。因此子会话与父会话共享同一沙箱配置，image 继承也自然正确，无需额外处理。

## 清理

```bash
api_curl -X DELETE "$BASE/api/session/$SID" >/dev/null
pgval "SELECT count(*) FROM session_v2 WHERE id='$SID'"   # 期望 0
docker rm -f opencode-saas-java-e2e
```

---

## 复测记录

| 日期 | 环境 | 用例 | 结果 | 备注 |
|---|---|---|---|---|
| 2026-09-16 | 本地 PG + 远端 K8s 沙箱，镜像 `4d0b4c62af-proxyfix`（含 body 修复），模型 `Yd-DeepSeek/deepseek-v4-flash` | T42.1–T42.3 | ✅ | session-terminal 镜像：OpenJDK 21.0.11 + 8/11/17 多版本；boot 后 PG `state=running` |
| 同上 | 同上 | T42.4–T42.5 | ✅ | Spring Boot 3.3.5 + Java 21，mvn package BUILD SUCCESS；设备管理 CRUD 自测 10 项全过；发现 AI 偶发 write 漏 content 参数后自愈重试 |
| 同上 | 同上 | T42.6–T42.7 | ✅ | 修复后 proxy GET/POST/PUT/DELETE 全通（200/201/200/204）；修复前 proxy POST 400（body 丢失，见 T42.7 说明） |

### V2 迁移复测（2026-09-29）

环境：本地 PG `opencode-v2-up` + 本地 OpenSandbox（Docker runtime），SaaS 镜像 `opencode-saas-codemode-current:local`（当前工作树构建），沙箱镜像 `.../opencode-sandbox:session-terminal`（digest `sha256:2356f1be…`），模型 `Yd-DeepSeek/deepseek-v4-flash`。

| 用例 | 结果 | 证据 / 说明 |
|---|---|---|
| T42.1 cpu/memory | PASS | `POST /api/session` 传 `sandbox:{"cpu":"2","memory":"4Gi"}` 创建成功，`GET /api/session/:id` 回读一致 |
| T42.1 per-session image | PASS（本次实现） | 新增 `Session.SandboxResource.image`（optional）+ `resolveSessionImage`；session 优先、env 兜底、空白视为未指定、非字符串忽略。端到端验证见下方「per-session image 实测」 |
| T42.2 boot + PG | PASS | V2 无 `keep-alive{boot}`；首次 shell 按需 boot 成功，PG `sandbox.state=running` |
| T42.3 Java 环境 | PASS | `openjdk version "21.0.11" 2026-04-21`、`OpenJDK Runtime Environment (build 21.0.11+10-1-24.04.2-Ubuntu)`；`javac 21.0.11`；`/usr/lib/jvm` 含 8/11/17/21 共 11 个条目（`java-1.8.0`~`java-1.21.0` 与 `openjdk-11/17/21`）|
| 沙箱镜像可用性 | PASS | `mvn` 在 `/usr/local/bin/mvn`（无需安装），`gradle` 不存在 |

| T42.4 AI 建 Spring Boot | PASS | `mvn -B package` BUILD SUCCESS（14 源文件，一次通过）；独立复核 jar 20,054,375 字节、`<version>3.3.5</version>`、`<java.version>21</java.version>`、`HelloController.java` 存在 |
| T42.5 设备管理 CRUD | PASS | 14 个源文件编译通过；H2 文件库生成 `data/devices.db.mv.db`；应用经 `setsid nohup` 启动后 `Tomcat started on port 8080` |
| T42.6 proxy CRUD（外部复验） | PASS | 11 项外部请求全部符合预期：`201/201/200/200/200/200/204/200/400/400/404` |
| T42.7 proxy body 转发 | PASS | 沙箱内直连 `201`，proxy 外部同 `201`；body 未丢失 |

T42.6 独立复验明细（全部经 `$BASE/api/session/$SID/proxy/8080`，**不采信 AI 自述**）：

| 请求 | 期望 | 实测 |
|---|---|---|
| `POST /api/devices` ×2 | 201 | 201 / 201 |
| `GET /api/devices` | 200 | 200 |
| `POST /api/devices/1/status?value=ONLINE` | 200 | 200 |
| `PUT /api/devices/1` | 200 | 200 |
| `GET /api/devices?status=ONLINE` | 200 | 200 |
| `DELETE /api/devices/{id}` | 204 | 204 |
| `POST /api/devices`（name 为空）| 400 | 400 |
| `POST /api/devices/1/status?value=BOGUS` | 400 | 400 |
| `GET /api/devices/999` | 404 | 404 |

复验中发现并纠正的两点：

1. **proxy 需要 Basic Auth**。V1 复测记录里 proxy 请求不带凭证，V2 下不带凭证一律 `401`。必须带 `Authorization: Basic base64(opencode:$OPENCODE_PASSWORD)`。
2. **设备 id 不能假定为 1/2**。T42.5 的 AI 自测已创建并删除过数据，自增 id 已推进到 3/4/5。硬编码 `DELETE /api/devices/2` 会得到 404 并被误判为 DELETE 失败。**必须先查询实际 id**。

迁移中实测到并已修正的五处问题：

1. `sandbox.image` 曾在 V2 **不存在**（schema 仅有 cpu/memory，传 image 被静默丢弃）。已按 V1（`feat/opencode-1.18.31`）语义补齐：optional 字段 + session 优先 env 兜底。改动仅两处：`SessionSandboxResource.Info` 与 `provider.ts` 的 image 选择（抽为可测的 `resolveSessionImage`）。`session_v2.sandbox` 已是 JSON 列，**无需数据库迁移**。
2. shell 消息字段路径易错：实测 `exit` 在**顶层**，`output` 是**嵌套对象**（`output.output` / `output.size` / `output.cursor`），不是 `metadata.exit` / `metadata.output`。已写入 `test-lib.sh` 注释。另注意 PG 存的是**最终快照**（`cursor == size`），分页必须走 `GET /api/shell/:id/output?cursor=N`，对同一行反复查 PG 拿不到后续内容。
3. model 必须在创建 Session 时指定，或创建后调用 `POST /api/session/:id/model` 切换；否则落到默认 provider 并返回 `403 free tier`，且该错误只在 `session.step.failed`，表面现象是"秒退无输出"。已封装 `new_session_with_model`。
4. `stream_prompt` 的 SSE 解析器最初按 V1 事件写，V2 正文走 `session.text.delta`，导致**连续两次任务秒退且零输出**（看似任务失败，实为解析器未匹配任何事件）。已按 `session-event.ts` 重写并验证；另注意工具事件**不含工具名字段**，按名断言需查 PG。
5. **沙箱不支持 `background` 执行**：`shell.ts:205-212` 对 `background: true` 直接 `ToolFailure`（注释标注 "not supported yet"，当前是硬失败）。启动长驻应用必须用 `setsid nohup ... &`。AI 在 T42.4 中自行绕过，但会先撞一次错误。
