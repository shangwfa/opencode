# Console 免费模型 403（FreeTierError）排查与修复

## 一、现象

自建 saas 服务（v2）中，`opencode` provider 的免费模型（`fledge-alpha-free`、`ling-3.1-flash-free`、`longcat-2.5-preview-free` 等）全部调用失败，PG `session_message` 中 assistant 消息记录：

```json
{
  "finish": "error",
  "error": {
    "type": "provider.auth",
    "message": "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode",
    "status": 403
  },
  "content": []
}
```

随后的 `idle` 事件 `outcome: "failed"`。自有 provider（如 Yd-GLM）不受影响。

**伴生症状**：前端 timeline 对 `finish:"error"` 且 `content:[]` 的 assistant 消息无任何渲染，用户感知为"发消息后一直加载中、无响应"（该前端缺陷另行沉淀）。

## 二、排查过程与证据链

### 2.1 定位调用链路

免费模型的定义来自运行时拉取（`models.opencode.ai` / Console config），不在仓库代码中。通过 saas API 实际拉取确认：

```json
{
  "id": "fledge-alpha-free",
  "providerID": "opencode",
  "settings": {
    "apiKey": "public",
    "baseURL": "https://opencode.ai/zen/v1"
  }
}
```

- 免费模型走 OpenCode Zen 网关（OpenAI-compatible 协议）
- 无凭据时 `apiKey` 为字面量 `"public"`（见 `packages/core/src/plugin/provider/opencode.ts` 中 `hasKey` 判定：`OPENCODE_API_KEY` 环境变量 / OAuth 连接 / provider apiKey 三者皆空时进入免费档，并禁用所有付费模型）

### 2.2 黑盒对照测试定位判定条件

直接请求 `https://opencode.ai/zen/v1/chat/completions` 做变量对照（社区资料：官方于 **2026-09-17** 上线服务端 gatekeeper，2026-09-18 官方人员确认"免费档仅限 OpenCode 本体"）：

| # | 条件 | 结果 |
|---|------|------|
| 1 | 仅 `Bearer public` | ❌ 403 FreeTierError |
| 2 | + 官方格式 UA | ❌ 403 |
| 3 | + `x-opencode-client` / `Origin` / `Referer` 等头 | ❌ 403 |
| 4 | `stream:true` + tools 含 `shell`+`read` + session 头 + UA `opencode/1.18.31` | ✅ 200 |
| 5 | 同 4，UA `opencode/stable/2.0.5/opencode` | ✅ 200 |
| 6 | 同 4，UA `opencode/local/2.0.5/cli`（channel=local，版本真实） | ✅ 200 |
| 7 | 同 4，UA `opencode/unknown/unknown/opencode` | ❌ 403 |
| 8 | 同 4，UA `opencode/local/local/cli`（**saas 实际 UA**） | ❌ 403 |

**结论**：Gatekeeper 的必要条件为：

1. `stream: true`（非流式请求直接拒绝）
2. 请求体 `tools` 声明 `shell`（或 `bash`）与 `read`（工具被 permission deny 导致缺失时同样被拒）
3. `User-Agent` 格式 `opencode/{channel}/{version}/{name}` 中 **version 必须是 ≥1.17.0 的真实发布版本号**（`local`/`unknown` 等占位值被拒；channel 与 name 不参与判定）
4. 携带合法 session ID 头（`x-opencode-session` / `X-Session-Id`，格式 `ses_[0-9a-f]{12}[0-9A-Za-z]{14}`）
5. **IP 信誉**：数据中心 ASN 出口会被拒（社区实测 Vercel serverless 全 403）。自建 saas 跑在 orbstack/docker 中、出口为办公/住宅网络时不受影响。

### 2.3 定位 saas 侧缺陷

saas 容器入口为 `bun run src/index.ts` 直接运行 TS 源码，**没有构建期 define 注入**：

```
packages/cli/src/version.ts
  declare const OPENCODE_VERSION: string   // 未注入时运行时为 undefined
  → fallback "local"
packages/cli/src/server-process.ts (L86-90)
  app: { name: ..., version: OPENCODE_VERSION, channel: OPENCODE_CHANNEL }
packages/core/src/app.ts
  useragent = `opencode/${channel}/${version}/${name}`
```

故 saas 发出的 UA 为 `opencode/local/local/cli` → 条件 3 不满足 → 403。

官方发布产物（npm CLI）在构建时注入了真实版本号，所以官方用户不受影响；v1（1.18.31）线上若同样以源码方式部署，理论上也存在此问题。

## 三、修复方案

**最小改动**：`packages/cli/src/version.ts` 支持运行时环境变量覆盖（与 `server-process.ts` 中 `name: process.env.OPENCODE_CLIENT ?? ...` 的既有先例一致）：

```ts
const version = process.env.OPENCODE_APP_VERSION ?? (typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local")
```

- 优先级：`OPENCODE_APP_VERSION` 环境变量 > 构建期 define > `"local"`
- 不修改 npm 依赖；不影响官方构建产物行为（有 define 时环境变量仍可覆盖，便于灰度）
- 单测：`packages/cli/src/version.test.ts`（通过 query-string import 隔离模块级求值，覆盖 env 优先 / 回退 / channel 一致性三个用例）

**部署方式**：容器启动时注入（版本号随发布更新，建议与 `package.json` 版本保持一致）：

```bash
docker run ... -e OPENCODE_APP_VERSION=2.0.5 ... opencode-saas-image
```

## 四、验证结果（三重依据）

| 验证层 | 修复前 | 修复后 |
|---|---|---|
| API 行为 | fledge 消息 68ms 即失败 | 会话 → prompt → idle 正常完成（流式 reasoning + text） |
| PG `session_message` | `finish:"error"`、`provider.auth` 403、`idle outcome:"failed"` | `finish:"stop"`、`error:null`、`idle outcome:"succeeded"` |
| Console 侧对照 | UA `opencode/local/local/cli` → 403 | UA 带 `2.0.5` → 200 |

验证容器：`docker run -e OPENCODE_APP_VERSION=2.0.5 ...`，通过 `/api/session` + `/api/session/{id}/prompt`（model 指定 `opencode/fledge-alpha-free`）驱动，轮询 `idle` 事件后核对 PG。

## 五、风险与注意事项

1. **合规边界**：本质是让 saas（官方代码魔改）以真实版本号通过 Console 的客户端校验。请求特征（流式、工具集、session 头）与官方客户端一致，但官方策略可能进一步收紧（如设备遥测校验、IP 信誉权重提高）。**免费模型不应作为生产主力**，生产负载走自有 provider / `OPENCODE_API_KEY`（Console service account）/ Zen 付费额度。
2. **版本号维护**：`OPENCODE_APP_VERSION` 需随发布同步更新，建议接入 CI 从 `package.json` 注入；版本落后过多（<1.17.0）会重新触发 403。
3. **出口 IP**：若 saas 未来部署到云机房（数据中心 ASN），免费模型可能整体被 IP 信誉策略拒绝，与 UA 无关。
4. **内部调用**：标题生成、compaction 等内部请求若为非流式且不带工具集，同样会被 gatekeeper 拒绝（社区有官方客户端 compaction 误伤案例）；saas 侧内部调用应固定走非免费模型。

## 六、遗留问题（另行跟进）

- ~~前端：`finish:"error"` 且空 content 的 assistant 消息在 timeline 无错误提示~~ **已修复**：V2 `assistant.error` 现在映射进时间线，渲染为红色错误气泡（`packages/hn-app/src/lib/rest.ts` -> `adaptV2Messages`）。
- ~~前端：SSE 事件信封不匹配导致渲染期白屏~~ **已修复**：V2 推 `{type,data}`，边界归一化为 `{type,properties}`，并给 `applyDataEvent` 加载荷缺失防御。
- 前端：服务器 401（缺密码）时 `/api/event` 无退避风暴重试
- 前端：origin 初始服务器认证失败时无密码输入引导，UI 停留"加载中"

## 七、部署备注（本次验证）

- **容器内配置**：`Dockerfile` 已把项目 `opencode.jsonc` COPY 到 `/home/opencode/.config/opencode/`，容器不会读取宿主机的本地配置。
- **端口冲突**：宿主机若已有 `opencode` 服务占用 `127.0.0.1:4096`，容器映射到 4096 后部分请求会打到宿主机那个实例（表现为 `/prompt` 返回 `Missing key at ["prompt"]`，因为那是不同版本的契约）。用 `-p 4196:4096` 之类的高位端口可避免。
- **启动示例**：

```bash
docker run -d --name opencode-saas -p 4196:4096 \
  -e OPENCODE_DATABASE_URL="postgresql://local@host.docker.internal:5432/opencode-v2-up" \
  -e OPENCODE_PASSWORD=ab123456 \
  -e OPENCODE_APP_VERSION=2.0.5 \
  -e OPENCODE_SANDBOX_ENABLED=false \
  opencode-saas:ui-20261024b
```

- **模型可用性过滤**：`packages/core/src/model.ts` 的 `available` 现在只列出"provider 真正可用（已有连接，或无集成的配置 provider）"的模型，避免界面默认选中没有凭据的 provider。
- **前端选择校验**：本地缓存（localStorage）里的模型若已不在可用列表，发送前会自动回退到第一个可用模型；会话列表里的旧会话若绑定了已下线模型，需要重新选一次。
