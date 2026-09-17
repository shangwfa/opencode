# Back-end Java（会话级 Java 沙箱 + AI 开发 Spring Boot 应用 e2e）

> 全链路场景：创建会话时指定 Java 沙箱镜像 → boot 沙箱 → 验证 Java 环境 → AI 开发 Spring Boot 项目与设备管理 CRUD 功能 → proxy 通道 e2e 验证。
> 沉淀自 2026-09-16 实测，期间发现并修复 proxy POST body 丢失 bug（见 T42.8）。
>
> 前置条件：SaaS 服务已启动（本地 PG + 远端 K8s Sandbox，见 `docs/local-test-env.md`）；`test-lib.sh` 含 `stream_prompt`。

---

## 测试环境

```bash
source docs/test-cases/test-env.sh 3 && source docs/test-cases/test-lib.sh
# 镜像：session-terminal（Ubuntu 24.04 + OpenJDK 21 默认 / 8、11、17 多版本，无 JAVA_HOME）
SB_IMAGE="crpi-hlpnu8kiweghie0r.cn-hangzhou.personal.cr.aliyuncs.com/shangwfa/opencode-sandbox:session-terminal"
```

---

## 一、会话与沙箱

### T42.1 创建会话指定 sandbox.image

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d "{\"title\":\"java-e2e\",\"sandbox\":{\"cpu\":\"2\",\"memory\":\"4Gi\",\"image\":\"$SB_IMAGE\"}}" | jexec "d['id']")
echo "SID=$SID"
```
**期望**：返回会话 ID；`GET /session/:id` 中 `sandbox.image` 为 session-terminal。

### T42.2 boot 沙箱（远端拉镜像）+ PG 记录

```bash
curl -s -X POST "$BASE/session/$SID/keep-alive" -H 'Content-Type: application/json' \
  -d '{"enabled":true,"boot":true}'
pgval "SELECT state FROM sandbox WHERE session_id='$SID' ORDER BY time_created DESC LIMIT 1"
```
**期望**：boot 返回 `keepAlive:true` + 非空 `sandboxId`；PG sandbox 表 `state=running`。注意 sandbox 表**不存镜像名**（镜像在 K8s 侧），镜像生效只能通过沙箱内特征验证（T42.3）。

### T42.3 Java 环境验证（镜像特征）

```bash
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"java -version 2>&1; javac -version 2>&1; ls /usr/lib/jvm | head"}' | jexec "d['stdout']"
```
**期望**：`exitCode:0`；OpenJDK 21.0.x（Ubuntu 24.04 build）；`/usr/lib/jvm` 含 8/11/17/21 多版本。

---

## 二、AI 开发（stream_prompt 流式观察）

### T42.4 AI 创建 Spring Boot 项目

```bash
stream_prompt "$SID" "在 /workspace/spring-boot-demo 创建 Spring Boot 3 项目（Java 21），实现 GET /api/hello 返回 JSON {\"message\":\"hello from spring boot\",\"time\":<时间戳>}，执行 mvn package 确认 BUILD SUCCESS。若 mvn 不可用先安装。"
```
**期望**：流水可见 `[tool] bash -> pending/running/completed` 流转、命令与输出；结束后 `pgval` 查消息或 `ls` 确认 `target/*.jar` 存在。

### T42.5 AI 开发设备管理 CRUD 功能

> 长任务（改 pom、建实体/DTO/Service/Controller/异常处理、构建、重启、自测），建议分两条消息：先写代码再构建自测，避免单次流超时。流断开不影响服务端继续执行。

```bash
stream_prompt "$SID" "开发设备管理功能：JPA+H2(文件模式 ./data/devices.db)；Device 字段 id/name/type/status(ONLINE/OFFLINE)/createdAt/updatedAt；API：POST /api/devices、GET /api/devices(分页+?status=过滤)、GET/PUT/DELETE /api/devices/{id}、POST /api/devices/{id}/status?value=；name/type 必填校验，统一错误 JSON 结构。写完所有代码文件。" 600

stream_prompt "$SID" "mvn package（必须 BUILD SUCCESS，报错就修复），杀旧进程重启新 jar，sleep 10 后 curl 自测完整 CRUD（创建2台→列表→改状态→更新→删除→再列表→空name应400→非法status应400→查999应404），汇报每步结果。" 600
```
**期望**：BUILD SUCCESS；AI 自测 10 项全过（201/200/204/400/404 均符合）。

---

## 三、proxy e2e 全链路

### T42.6 外部经 proxy 验证 CRUD

```bash
P="$BASE/session/$SID/proxy/8080"
curl -s "$P/api/devices" -o /dev/null -w "GET  列表: %{http_code}\n"          # 200
curl -s -X POST "$P/api/devices" -H 'Content-Type: application/json' \
  -d '{"name":"e2e-probe","type":"gateway"}' -o /dev/null -w "POST 创建: %{http_code}\n"  # 201
curl -s -X PUT "$P/api/devices/1" -H 'Content-Type: application/json' \
  -d '{"name":"probe-v2"}' -o /dev/null -w "PUT  更新: %{http_code}\n"        # 200
curl -s -X DELETE "$P/api/devices/1" -o /dev/null -w "DELETE: %{http_code}\n" # 204
```

### T42.7 proxy POST body 转发（bug 回归项，必测）

> 2026-09-16 发现：proxy 转发 POST/PUT 时 body 为空（`sandbox-proxy.ts` 直接透传 `request.source.body` 流，该流已被 server 层消费），上游 Spring 报 `Required request body is missing` → 400；GET 无 body 故一直正常。修复：`request.arrayBuffer` 缓冲后转发。镜像 `4d0b4c62af-proxyfix` 及之后版本含修复，**测旧镜像此用例必 FAIL**。

```bash
# 沙箱内对照（应 201）
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"curl -s -o /dev/null -w \"%{http_code}\" -X POST http://127.0.0.1:8080/api/devices -H \"Content-Type: application/json\" -d \"{\\\"name\\\":\\\"inner\\\",\\\"type\\\":\\\"probe\\\"}\""}' | jexec "d['stdout']"
# proxy 外部（修复后应同为 201；未修复镜像返回 400 且响应为 Spring 默认错误结构）
curl -s -X POST "$BASE/session/$SID/proxy/8080/api/devices" -H 'Content-Type: application/json' \
  -d '{"name":"outer","type":"probe"}' -o /dev/null -w "proxy POST: %{http_code}\n"
```
**期望**：两处均 201。诊断特征：proxy 返回 400 且 body 为 `{"timestamp":...,"status":400,"error":"Bad Request","path":...}`（Spring 默认结构、无 message）时，优先怀疑 body 未转发，查沙箱内 app 日志确认。

---

## 复测记录

| 日期 | 环境 | 用例 | 结果 | 备注 |
|---|---|---|---|---|
| 2026-09-16 | 本地 PG + 远端 K8s 沙箱，镜像 `4d0b4c62af-proxyfix`（含 body 修复），模型 `Yd-DeepSeek/deepseek-v4-flash` | T42.1–T42.3 | ✅ | session-terminal 镜像：OpenJDK 21.0.11 + 8/11/17 多版本；boot 后 PG `state=running` |
| 同上 | 同上 | T42.4–T42.5 | ✅ | Spring Boot 3.3.5 + Java 21，mvn package BUILD SUCCESS；设备管理 CRUD 自测 10 项全过；发现 AI 偶发 write 漏 content 参数后自愈重试 |
| 同上 | 同上 | T42.6–T42.7 | ✅ | 修复后 proxy GET/POST/PUT/DELETE 全通（200/201/200/204）；修复前 proxy POST 400（body 丢失，见 T42.7 说明） |
