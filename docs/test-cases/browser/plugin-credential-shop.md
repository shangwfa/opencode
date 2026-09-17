# credential 插件实测：AI 帮登录，密码不经过 AI

> 模拟 Plugins 文档（https://agent-browser.dev/plugins）的场景 1：让 AI 自动登录站点，但密码不进 AI 的命令、对话或日志。目标站：`https://shop.yingdao.com/`（影刀商城 Playground，账号 `admin`）。
>
> 工具链：agent-browser 0.36.0 + Chrome for Testing 153（headless），沙箱内执行（session `ses_f5d466dd`，keepAlive）。用例编号 T51.x。

## 原理

agent-browser 的 `credential.read` 插件协议：daemon 在执行 `auth login --credential-provider` 时，把 `credential.resolve` 请求（stdin JSON）发给插件进程，插件从**外部凭据源**（本例：本地文件；生产：Keychain/Vault/SSO）读取用户名密码，以 stdout JSON 返回。凭据**不进模型上下文、不进命令行参数、不进配置文件**。

```
AI ──auth login(无密码)──▶ agent-browser daemon ──stdin JSON──▶ 插件进程 ──读文件──▶ 凭据文件
        ▲                              │◀──────────stdout JSON（凭据）──────────┘
        └────────── 填表登录 ◀─────────┘
```

## T51.1 准备：插件 + 凭据文件

**插件**（`/workspace/shopcred-plugin.mjs`，Node 内置模块零依赖）：

```javascript
#!/usr/bin/env node
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const reply = (body) => process.stdout.write(JSON.stringify({ protocol: 'agent-browser.plugin.v1', success: true, ...body }));
if (input.type === 'plugin.manifest') {
  reply({ manifest: { name: 'shopcred', capabilities: ['credential.read'], description: 'Read shop credentials from local file' } });
  process.exit(0);
}
if (input.type === 'credential.resolve') {
  const fs = await import('fs');
  const cred = JSON.parse(fs.readFileSync('/workspace/.shopcred.json', 'utf8'));
  reply({ credential: { username: cred.username, password: cred.password } });
  process.exit(0);
}
process.stdout.write(JSON.stringify({ protocol: 'agent-browser.plugin.v1', success: false, error: 'unsupported: ' + input.type }));
```

**凭据文件**（`/workspace/.shopcred.json`，`chmod 600`；真实场景此步由**用户本人**执行，AI 不接触）：

```json
{"username": "admin", "password": "<密码>"}
```

## T51.2 注册插件

`/workspace/agent-browser.json`（daemon 工作目录 = exec cwd = /workspace）：

```json
{
  "plugins": [
    { "name": "shopcred", "command": "/workspace/shopcred-plugin.mjs", "capabilities": ["credential.read"] }
  ]
}
```

```bash
agent-browser --session shop plugin list    # → shopcred  credential.read
agent-browser --session shop plugin show shopcred
```

## T51.3 登录（命令中零密码）

```bash
agent-browser --session shop auth login shopcred \
  --credential-provider shopcred --item admin \
  --url https://shop.yingdao.com/user/login
```

**实测**：`✓ Logged in as 'shopcred'` → 页面跳转 `/list/table-list`，标题「订单管理 -」，后台菜单（工作台/订单管理）可见——**登录态完整生效**。

## T51.4 泄漏审计

| 检查项 | 结果 |
|---|---|
| 登录命令含密码 | ❌ 无（仅 provider 名 + item + url） |
| `agent-browser.json` 配置含密码 | ❌ `grep -c` = 0 |
| 凭据文件权限 | ✅ `-rw-------`（600） |
| AI 对话/日志含密码 | ❌ 除"写入凭据文件"那一条外全流程无密码（真实场景该步归用户） |

## 与裸奔方式的对比

```bash
# 传统方式：密码进命令历史/对话/日志/模型上下文
agent-browser fill @e6 '<明文密码>' && click 登录
# 插件方式：换密码只改凭据文件，所有自动化零改动
agent-browser auth login shopcred --credential-provider shopcred --item admin --url ...
```

## 实测备注

- `auth login --credential-provider` 无需先 `auth save`：profile 名（shopcred）+ `--url` 直接工作，登录前自动等用户名/密码/提交选择器出现（SPA 友好，本站表单自动发现成功）
- 密码含特殊字符（`$!` 等）：走 JSON 文件 + stdin 协议天然免 shell 转义，无引号地狱
- 插件协议要点：stdin 读**一个**请求、stdout 写**一个** JSON 响应（日志禁止上 stdout）、`plugin.manifest` 请求返回能力声明可免去 `--capability` 手工注册

## 复测记录

| 日期 | 结果 | 备注 |
|---|---|---|
| 2026-09-15 | ✅ | manifest 自动发现 → credential.resolve → 自动填表登录 → 后台可达；全程命令零密码；泄漏审计 4/4 通过 |
