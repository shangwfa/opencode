# 管理模型 → 连接提供商：交互与接口分析

适用页面：requirement-chat（`/requirement-chat/...`）等复用 session composer 的页面。

## 1. 入口

| 入口 | 位置 | 行为 |
| --- | --- | --- |
| 模型选择 Popover 的 `+` 图标（"连接提供商"） | `src/components/prompt-input.tsx:1966` 内 `ModelSelectorPopover`，定义于 `src/components/dialog-select-model.tsx:120` | 打开 `DialogSelectProvider` |
| Popover 的 `sliders` 图标（"管理模型"） | `src/components/dialog-select-model.tsx:113` | 打开 `DialogManageModels` |
| "管理模型"弹窗右上角"连接提供商"按钮 | `src/components/dialog-manage-models.tsx:18` | 打开 `DialogSelectProvider` |
| 命令面板 `command.provider.connect` | `src/pages/layout.tsx:1059` | 打开 `DialogSelectProvider` |

弹窗均通过 `useDialog().show()` 动态 import 并挂载。

## 2. 绑定提供商的交互种类

### 2.1 选择提供商 — `src/components/dialog-select-provider.tsx`

- 可搜索 List（按 `id`/`name` 过滤），按「热门 / 其他」分组：
  - 热门列表 `popularProviders`：`opencode`、`opencode-go`、`anthropic`、`github-copilot`、`openai`、`google`、`openrouter`、`vercel`（`src/hooks/use-providers.ts:6`）。
  - `opencode` / `opencode-go` 带「推荐」Tag；`anthropic` / `openai` / `github-copilot*` 有提示文案。
- 列表首项固定为「自定义提供商」（`_custom`，带 Tag）。
- 点选后：
  - 普通提供商 → `DialogConnectProvider provider={id}`
  - 自定义 → `DialogCustomProvider back="providers"`

### 2.2 连接弹窗 — `src/components/dialog-connect-provider.tsx`

内部为状态机（`createStore`）：

```
methodIndex: undefined | number     // 选中的认证方式索引
authorization: undefined | { url, method: "auto"|"code", instructions }
state: "pending" | "complete" | "error" | "prompt"
```

打开流程：

1. 认证方式来源：`globalSync.data.provider_auth` 缓存 → 无缓存则 `GET /provider/auth` 并写回缓存；请求失败回退为仅「API Key」方式（`dialog-connect-provider.tsx:48`）。
2. **只有 1 种方式时自动选中**（`dialog-connect-provider.tsx:325`）。
3. 多种方式时展示 `MethodSelection` 列表（键盘上下导航，Enter 选中；输入框内 Enter 不触发）。

#### 交互种类 A：API Key（`ApiAuthView`，method.type === "api"）

- 表单：`apiKey` TextField（自动聚焦，必填校验）。
  - 提供商为 `opencode` 时展示 opencode Zen 专属文案与 https://opencode.ai/zen 链接。
- 提交：`auth.set`（`PUT /auth/{providerID}`，body `{ type: "api", key }`）。
- 成功后 `complete()`：`global.dispose()`（`POST /global/dispose`）刷新实例 → 关闭弹窗 → 成功 toast。

#### 交互种类 B：OAuth（method.type === "oauth"）

B1. **前置动态表单**（`OAuthPromptsView`，`dialog-connect-provider.tsx:195`）

- 由服务端返回的 `prompts` 驱动，逐项展示：
  - `text`：TextField + 「继续」按钮（非空才可提交）；
  - `select`：选项列表，点选即进入下一项；
  - 支持 `when: { key, op: "eq"|"neq", value }` 条件显示（基于已填值判断）。
- 全部填完后携带 `inputs` 调用 `selectMethod(index, inputs)`。

B2. **发起授权**

- `POST /provider/{providerID}/oauth/authorize`，body `{ method: <索引>, inputs }`。
- 返回 `ProviderAuthAuthorization = { url, method: "auto"|"code", instructions }`。
- 至少展示 1s 的 pending 态（补足 delay 后再切 complete），失败进入 error 态并展示格式化后的错误信息（`formatError` 递归解 `data.message` / `error` / `message`）。

B3. **code 模式**（`OAuthCodeView`，`dialog-connect-provider.tsx:464`）

- 展示授权链接（`authorization.url`），用户在提供商页面完成授权后手动粘贴 code。
- 提交：`POST /provider/{providerID}/oauth/callback`，body `{ method, code }`。
- 成功 → `complete()`；失败 → 表单错误提示（默认「无效代码」）。

B4. **auto 模式**（`OAuthAutoView`，`dialog-connect-provider.tsx:525`）

- 展示授权链接 + 只读可复制的「确认码」（从 `authorization.instructions` 按 `:` 分割解析）。
- 挂载时自动调用 `oauth.callback`（不带 code），Spinner 显示「等待授权」。
- 成功 → `complete()`；失败 → error 态。

#### 返回逻辑（`goBack`，`dialog-connect-provider.tsx:345`）

- 仅 1 种方式 → 回提供商选择列表；
- 已有 `authorization` 或已选方式 → `method.reset` 回方式选择；
- 否则 → 回提供商选择列表。

### 2.3 自定义提供商 — `src/components/dialog-custom-provider.tsx` + `dialog-custom-provider-form.ts`

表单字段（全部前端校验，`validateCustomProvider`）：

| 字段 | 校验规则 |
| --- | --- |
| providerID | 必填；`/^[a-z0-9][a-z0-9-_]*$/`；不得与现有提供商 ID 重复（除非在 `disabled_providers` 中） |
| name | 必填 |
| baseURL | 必填；必须 `http(s)://` 开头 |
| apiKey | 可选；支持 `{env:VAR}` 语法（提取后走 env，不落库 key） |
| models 行（id/name） | 必填、id 去重；至少 1 行，可增删 |
| headers 行（key/value） | 整行为空则跳过；否则必填、key（小写）去重；可增删 |

保存流程（`useMutation`）：

1. 有明文 key 时先 `auth.set`（`PUT /auth/{providerID}`）。
2. `globalSync.updateConfig`：`PUT /config` 写入 `provider: { [id]: config }`（npm 固定 `@ai-sdk/openai-compatible`，含 `options.baseURL`、`options.headers`、`models`、可选 `env`），同时从 `disabled_providers` 移除该 ID；随后重新 bootstrap 全局数据。
3. 成功 → 关闭弹窗 + toast；失败 → toast 错误。

### 2.4 模型可见性管理 — `src/components/dialog-manage-models.tsx`

- 列表按提供商分组（热门优先），每行 Switch 控制单模型在模型选择器中的可见性。
- 分组头 Switch 一键切换该提供商全部模型（全选语义：`every(visible)`）。
- 仅写本地 `local.model.setVisibility`，不调用后端接口。

## 3. 涉及的接口（`@opencode-ai/sdk` v2）

| SDK 调用 | HTTP | 用途 | 调用位置 |
| --- | --- | --- | --- |
| `provider.auth()` | `GET /provider/auth` | 获取全部提供商认证方式 | `dialog-connect-provider.tsx:59` |
| `provider.oauth.authorize()` | `POST /provider/{providerID}/oauth/authorize` | 发起 OAuth（body: method 索引 + inputs） | `dialog-connect-provider.tsx:163` |
| `provider.oauth.callback()` | `POST /provider/{providerID}/oauth/callback` | 完成 OAuth（body: method + 可选 code） | `dialog-connect-provider.tsx:483`、`:536` |
| `auth.set()` | `PUT /auth/{providerID}` | 写入 API Key（`{ type: "api", key }`） | `dialog-connect-provider.tsx:412`、`dialog-custom-provider.tsx:125` |
| `auth.remove()` | `DELETE /auth/{providerID}` | 移除凭证（设置页使用） | `src/components/settings-providers.tsx` |
| `global.dispose()` | `POST /global/dispose` | 连接成功后刷新实例使凭证生效 | `dialog-connect-provider.tsx:335` |
| `globalSync.updateConfig` → `global.config.update()` | `PUT /config` | 自定义提供商配置写入后重新 bootstrap | `src/context/global-sync.tsx:432` |
| `provider.list()`（bootstrap） | `GET /provider` | 提供商列表（含 connected 状态） | `src/context/global-sync/bootstrap.ts` |

### 关键数据结构（SDK v2 types）

```ts
type ProviderAuthMethod = {
  type: "oauth" | "api"
  label: string
  prompts?: Array<
    | { type: "text"; key: string; message: string; placeholder?: string; when?: { key: string; op: "eq" | "neq"; value: string } }
    | { type: "select"; key: string; message: string; options: Array<{ label: string; value: string; hint?: string }>; when?: { ... } }
  >
}

type ProviderAuthAuthorization = {
  url: string
  method: "auto" | "code"
  instructions: string
}
```

### OAuth `code` / `auto` 模式区分

#### 模式从哪来（关键结论）

`code` / `auto` **不是静态配置**，任何列表接口里都查不到：

- `GET /provider`（即 `all / default / connected` 的响应，如本地的 `provider.json`）只含模型目录数据，无任何 OAuth 字段 —— **无法**从中判断模式。
- `GET /provider/auth` 只能告诉哪些提供商支持 OAuth（`type: "oauth"`）及前置 `prompts`，同样不含 `code/auto`。
- 唯一来源：`POST /provider/{providerID}/oauth/authorize` 的**运行时响应**字段 `authorization.method`，由后端按"提供商 × 认证方式"在发起授权时决定。

#### 两种模式的定义与交互差异

前端在 `dialog-connect-provider.tsx:640-645` 按 `store.authorization.method` 分支渲染：

| 维度 | `code` 模式（`OAuthCodeView`，`:464`） | `auto` 模式（`OAuthAutoView`，`:525`） |
| --- | --- | --- |
| 本质 | 授权码回贴式（Authorization Code） | 设备码 / 轮询式（Device Flow） |
| UI | 提示"访问链接获取授权码"，用户到提供商页面复制 code 后**手动粘贴**回表单提交 | 提示"访问链接并输入以下代码"，展示只读**确认码**（从 `instructions` 按 `:` 分割解析）+ Spinner 等待 |
| callback 调用 | `POST /oauth/callback { method, code }` — 必须带 code，由用户输入触发 | `POST /oauth/callback { method }` — 组件挂载时自动发起，无 code，前端轮询等待授权完成 |
| 适用场景 | 提供商回调地址不可控（CLI/本地应用拿不到 redirect），只能让用户转贴授权码 | 提供商原生支持设备流，用户在另一台设备/浏览器完成授权后后端自动感知 |
| 失败提示 | 表单错误"授权码无效"（`provider.connect.oauth.code.invalid`） | error 态展示格式化后的错误信息 |

判别口诀：**用户要把提供商页面上的字符复制回 opencode = `code`；opencode 把确认码展示给用户、然后自己等结果 = `auto`**。

#### 典型示例

| 提供商 | 模式 | 交互形态 |
| --- | --- | --- |
| Google | `code` | 打开 Google OAuth 授权页 → 复制授权码 → 粘贴回表单 → `oauth.callback` 交换凭证 |
| GitHub Copilot | `auto` | 设备流：打开 `github.com/login/device`，页面展示设备确认码，前端自动轮询 `oauth.callback` 直至用户在 GitHub 侧确认 |

注意：自建 SaaS 后端（`window.YD.API_URL`）可能注册额外 OAuth 提供商，需实测确认。

#### 如何枚举后端的完整 code/auto 清单

在已登录页面控制台执行（注意第 2 步会真的发起一次授权流程，产生一次性授权码）：

```js
// 1. 找出所有支持 oauth 的提供商
const auth = await (await fetch("/provider/auth")).json()
const oauthProviders = Object.entries(auth).filter(([_, v]) => v.some(m => m.type === "oauth"))

// 2. 逐个发起 authorize 看 method
for (const [id, methods] of oauthProviders) {
  for (const [i] of methods.filter(m => m.type === "oauth").entries()) {
    const res = await fetch(`/provider/${id}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: i }),
    })
    console.log(id, (await res.json())?.method) // "code" | "auto"
  }
}
```

另外：`GET /provider` 返回中所有 `source: "custom"` 的提供商（如 `tokengo`、`qiniu-ai`、`nano-gpt` 等）认证方式均为 `env` API Key（如 `TOKENGO_API_KEY`），不走 OAuth，也不存在 code/auto 之分。

## 4. 数据流与缓存

- 提供商列表：`useProviders()`（`src/hooks/use-providers.ts`）— 项目级（`globalSync.child(dir).provider_ready` 时取项目 store）否则取全局 `globalSync.data.provider`；提供 `all / default / popular / connected / paid` 派生集合。
- 认证方式缓存：`globalSync.data.provider_auth`（`GET /provider/auth` 全量结果按 providerID 索引），连接弹窗优先读缓存。
- 连接成功后的生效链路：`auth.set` / `oauth.callback` → `global.dispose()` → 服务端重建实例 → 全局同步刷新 `provider.connected` → 模型选择器/管理模型列表出现新提供商与模型。

## 5. SaaS 个人模型适配（2026-09-16，feat/opencode-1.18.31）

> 后端已按 `x-user-id` 做个人模型隔离（公共优先、无公共用个人；匿名只见公共），并收紧 `GET /provider` 语义、增加响应脱敏。前端连接提供商流程需按下表取数。
>
> 原 §4 生效链路在 SaaS 下的修正：个人 key 无需 `global.dispose()`（模型缓存按 user+key 哈希，新 key 天然新实例）；公共 key 变更仍需 dispose（`PUT /auth` 不再自动触发实例重建）。

### 5.1 接口映射（前端按用途选择）

| 用途 | 接口 | 说明 |
| --- | --- | --- |
| **连接向导目录**（发现未配置 provider） | `GET /provider?scope=connect` | **新增**。返回全量 enabled 目录（含未配置的 100+），`connected` 数组标记当前身份已连接的子集；响应经脱敏，绝无 key/apiKey |
| 模型选择器（能用什么） | `GET /provider`（默认 scope=visible） | 只返回公共运行态 + 本人凭证对应 provider；`all/default/connected` 同源同集合 |
| 认证方式（api/oauth + prompts） | `GET /provider/auth` | 不变。注意仅覆盖有 plugin 声明的 provider（本地实测 ~10 个），**不能**当目录用 |
| 已连接标记 | `GET /provider` 的 `connected`（带 x-user-id） | visible 与 connect 两种视图均按请求身份计算 |
| 写入/删除凭证 | `PUT /auth/{id}`、`DELETE /auth/{id}` | 按 header 身份写个人行；未传 header 写公共行 |
| OAuth | `POST /provider/{id}/oauth/authorize` + `/callback` | pending 按 `(userId, providerID)` 隔离；authorize 与 callback **必须同身份**，否则 `OauthMissing` |
| 凭证生效 | `POST /global/dispose` | 个人 key 无需 dispose（按 user+key 哈希建缓存，新 key 天然新实例）；**公共 key 变更必须 dispose**（`PUT /auth` 不再自动触发实例重建） |

### 5.2 前端必须适配的行为变化

1. **`GET /provider` 默认视图不再返回全量目录**：`useProviders()` 的数据源若用于「连接提供商」弹窗/「管理模型」列表，需改拉 `?scope=connect`；模型选择器可继续用默认视图（响应更小）。
2. **所有请求携带同一 `x-user-id`**（由接入网关统一注入）：连接成功后刷新 `provider.list()` 需同身份才能看到个人新 provider；同浏览器切换用户需清 `globalSync` 缓存（provider / provider_auth 缓存无用户维度）。
3. **`connected` 语义**：现在 `connected` 与默认视图 `all` 同集合（= 当前身份可用）；向导中「已连接」判断用 `?scope=connect` 响应的 `connected` 数组。
4. **响应脱敏**：`/provider`、`/config/providers` 不再返回 `key`/`apiKey`（含任意嵌套）。前端只输入不展示 key 则无影响；若有展示 key 尾号的功能需移除。
5. **自定义提供商的公共/私有混合**：`PUT /config` 写入的 provider 定义是**全局公共**（所有用户可见），而 `PUT /auth/{id}` 在网关注入下写**个人行**——其他用户会看到「已定义但自己无 key」的 custom provider（选用即失败）。且 `PUT /config` 会触发实例重建，影响共享实例上的其他用户请求。多租户下建议自定义提供商仅管理员入口开放。

### 5.3 验证情况

- 单测：`test/server/httpapi-provider.test.ts`「scope=connect returns the full catalog with connected flags per identity」——connect 视图目录数 > visible 视图、user-a 含 openai 而 user-b 不含、脱敏断言通过。
- 测试环境实测（本地 PG + 远端沙箱，镜像 `person-model+connect`）：`GET /provider?scope=connect` 返回 159 个 provider；`GET /provider` 默认视图仅 2 个公共；同一 key 在响应中不可见。
- 测试基建注意：`test/server/httpapi-layer.ts` 的 `request()` helper 会双写 query（`fromWeb` + `setUrl`），带枚举 query 参数的请求须用 `requestDirect()`。

## 6. 前端接入 SaaS 接口指南（HTTP 直调）

> 前端不依赖新 SDK 封装，直接调用 opencode SaaS 提供的 HTTP 接口完成「连接提供商」全流程。以下 `$BASE` 为 SaaS 服务地址（测试环境 `https://test-opencode.shadow-rpa.net`，本地 `http://localhost:14096`）。

### 6.0 前置约定

| 约定 | 说明 |
| --- | --- |
| 身份 header | 每个请求携带 `x-user-id: <用户唯一ID>`。**生产由接入网关统一注入**，前端业务代码无需设置；本地联调时前端自行在 fetch headers 带上 |
| 空白/缺失 `x-user-id` | 视为公共身份：只见公共 provider、读写公共凭证行。**不会**返回任何个人模型 |
| 同一流程同身份 | OAuth 的 authorize 与 callback、连接与刷新列表，必须同一 `x-user-id`，否则 pending 对不上（`OauthMissing`）或看不到刚连的 provider |
| 响应脱敏 | 所有查询接口不返回 key/apiKey/token；前端不存在展示密钥的合法途径 |

### 6.1 场景化调用序列

#### 场景 A：打开「连接提供商」向导（拉目录 + 已连接标记）

```bash
# 目录（219 个 provider，含未配置的）+ 当前身份已连接子集
curl -s "$BASE/provider?scope=connect" -H 'x-user-id: u1'
# → { "all": [ {id, name, models...}, ... ], "default": {...}, "connected": ["Yd-DeepSeek", ...] }

# 认证方式（哪些 provider 支持哪种连接方式；仅覆盖有 plugin 声明的 ~10 个）
curl -s "$BASE/provider/auth" -H 'x-user-id: u1'
# → { "openai": [ {type:"api",...}, {type:"oauth",...} ], "github-copilot": [...] }
```

前端渲染：`all` 做搜索/分组列表；`connected` 数组给列表项打「已连接」标记；点选某 provider 后从 `/provider/auth` 取它的认证方式（无声明则兜底 API Key 表单）。

#### 场景 B：API Key 连接

```bash
curl -s -X PUT "$BASE/auth/deepseek" \
  -H 'Content-Type: application/json' -H 'x-user-id: u1' \
  -d '{"type":"api","key":"sk-xxx"}'
# → true（写入个人行 u1/deepseek；网关不注入时写公共行）
```

连接后刷新：重新 `GET /provider?scope=connect`，`connected` 应出现该 provider。

#### 场景 C：OAuth 连接

```bash
# 1. 发起授权（prompts 有值时先收集 inputs）
curl -s -X POST "$BASE/provider/openai/oauth/authorize" \
  -H 'Content-Type: application/json' -H 'x-user-id: u1' \
  -d '{"method":1}'
# → { "url": "https://auth.openai.com/...", "method": "auto"|"code", "instructions": "..." }

# 2a. code 模式：用户访问 url 复制授权码回贴
curl -s -X POST "$BASE/provider/openai/oauth/callback" \
  -H 'Content-Type: application/json' -H 'x-user-id: u1' \
  -d '{"method":1,"code":"用户粘贴的授权码"}'
# → true

# 2b. auto 模式（设备流）：前端展示 instructions 中的确认码，轮询不带 code 的 callback
curl -s -X POST "$BASE/provider/openai/oauth/callback" \
  -H 'Content-Type: application/json' -H 'x-user-id: u1' \
  -d '{"method":1}'
# 授权完成 → true；未完成 → 轮询中；身份不一致 → OauthMissing
```

`code`/`auto` 的判定只来自 authorize 响应的 `method` 字段（见 §3「模式从哪来」）。

#### 场景 D：断开连接（删除凭证）

```bash
curl -s -X DELETE "$BASE/auth/deepseek" -H 'x-user-id: u1'
# → true（只删本人行；公共凭证不受影响；本人之后回退使用公共凭证）
```

#### 场景 E：连接生效与实例刷新

```bash
# 个人凭证（网关注入 x-user-id 的场景）：无需 dispose，直接刷新即可
curl -s "$BASE/provider" -H 'x-user-id: u1'

# 公共凭证变更（管理端场景）：需要 dispose 重建实例后新 key 才对聊天生效
curl -s -X POST "$BASE/global/dispose"
```

#### 场景 F：模型选择器 / 发消息

```bash
# 模型选择器（只列当前身份可用的，响应小）
curl -s "$BASE/provider" -H 'x-user-id: u1'
# → { "all": [公共 + 本人已连接], "default": {...}, "connected": [...] }

# 发消息（model 写法不变，后端按 header 身份取 key）
curl -s -X POST "$BASE/session/<SID>/message" \
  -H 'Content-Type: application/json' -H 'x-user-id: u1' \
  -d '{"parts":[{"type":"text","text":"hi"}],"model":{"providerID":"deepseek","modelID":"deepseek-v4-flash"}}'
```

### 6.2 错误处理

| 错误 | 触发条件 | 前端处理 |
| --- | --- | --- |
| `ProviderAuthOauthMissing`（400） | callback 与 authorize 的 `x-user-id` 不一致，或 pending 已过期/实例重启 | 重新走 authorize |
| `ProviderAuthOauthCodeMissing`（400） | code 模式 callback 未带 code | 检查表单 |
| `ProviderAuthValidationFailed`（400） | prompts 输入未通过校验（含 field/message） | 表单内联提示 |
| 凭证无效（聊天时 401/上游错误） | key 本身错误 | 向导内提供「测试连接」引导用户重连 |
| `BadRequest`（400，query kind） | `scope` 参数值非法 | 仅允许 `visible`/`connect` |

### 6.3 缓存与多用户注意

- 前端对 `/provider`、`/provider/auth` 的内存缓存**必须按用户维度隔离**（key 含 userId），否则同浏览器切换用户会串目录。
- `connected` 依赖请求身份，缓存有效期内在连接/断开后应主动失效重拉。
- auto 模式的 callback 轮询期间不要切换用户上下文（pending 按身份隔离）。

## 7. 交互流程图（简）

```
模型选择 Popover / 命令面板 / 管理模型弹窗
        │
        ▼
DialogSelectProvider（搜索 + 分组列表 + 自定义入口）
        │
   ┌────┴─────────────────────────┐
   ▼                              ▼
普通提供商                自定义（_custom）
DialogConnectProvider          DialogCustomProvider
   │                              │
   │ GET /provider/auth           │ (可选) PUT /auth/{id}
   ▼                              │ PUT /config（updateConfig）
选认证方式（1 种自动选）            ▼
   │                           toast 成功
   ├─ api ──► ApiAuthView ── PUT /auth/{id} ─┐
   │                                         │
   └─ oauth ─► [prompts 动态表单]             │
              POST .../oauth/authorize       │
                ├─ code ─► OAuthCodeView ─┐  │
                └─ auto ─► OAuthAutoView ─┤  │
                         POST .../oauth/callback
                                          │  │
                        POST /global/dispose ◄┘
                                          │
                                     toast 成功
```
