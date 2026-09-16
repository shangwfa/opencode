# Stealth/反检测与 launch.mutate 插件实测

> 验证 agent-browser 的反检测（anti-detection）能力分层：init script 直注入（init scripts 场景 1）与 launch.mutate 插件自动应用（Plugins 官方场景）。目标：让自动化浏览器在网站检测脚本眼里像真人浏览器。
>
> 官方依据：Plugins 文档把 stealth/反检测划给 `launch.mutate` 插件——"这些技术变化快、进 core 有风险"。环境：agent-browser 0.36.0 + Chrome for Testing 153 headless。用例编号 T55.x。

## 原理：检测点 → 对抗手段 → 通道

| 网站检测什么 | 对抗手段 | 注入通道 |
|---|---|---|
| `navigator.webdriver === true`（自动化标志，CDP attach 时为 true） | init script 重定义 getter | initScripts |
| 启动特征（Blink `AutomationControlled`） | 启动参数 `--disable-blink-features=AutomationControlled` | args |
| UA 含 `HeadlessChrome` | UA 覆盖 | userAgent |
| 真人浏览器插件/字体指纹缺失 | 装伪装扩展 | extensions |

**时机决定成败**：检测脚本第一行就查 webdriver——对抗必须在页面任何 JS 之前生效（init script 的恰当时机）。

## T55.1 init script 直注入 + UA flag

```bash
printf 'Object.defineProperty(navigator,"webdriver",{get:function(){return undefined}})' > /workspace/stealth.js
agent-browser --session st1 --init-script /workspace/stealth.js --user-agent 'my-agent/1.0' open https://example.com
agent-browser --session st1 eval 'String(navigator.webdriver) + "|" + navigator.userAgent'
```

**实测**：`"undefined|my-agent/1.0"` ✅——webdriver getter 抹除 + UA 覆盖双双生效。

## T55.2 launch.mutate 插件（自动应用配方）

**插件**（`/workspace/stealth-plugin.mjs`，协议同 T51 的 credential 插件）：

```javascript
#!/usr/bin/env node
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const reply = (body) => process.stdout.write(JSON.stringify({ protocol: 'agent-browser.plugin.v1', success: true, ...body }));
if (input.type === 'plugin.manifest') {
  reply({ manifest: { name: 'stealth', capabilities: ['launch.mutate'], description: 'Anti-detection launch tweaks' } });
  process.exit(0);
}
if (input.type === 'launch.mutate') {
  reply({ launch: {
    args: ['--disable-blink-features=AutomationControlled'],
    initScripts: ['Object.defineProperty(navigator, "webdriver", { get: () => undefined });'],
    userAgent: 'stealth-agent/1.0'
  }});
  process.exit(0);
}
```

**配置**（`/workspace/agent-browser.json`）：

```json
{ "plugins": [ { "name": "stealth", "command": "/workspace/stealth-plugin.mjs", "capabilities": ["launch.mutate"] } ] }
```

**触发**：`launch.mutate` 插件**自动应用于本地启动**，无需任何 flag——直接 `agent-browser --session st3 open https://example.com`。

**实测**（st3 全新 session）：`"false|stealth-agent/1.0"` ✅——initScript（webdriver 抹除）与 userAgent 覆盖自动生效，启动参数链路成立。

## 坑与边界

| # | 类型 | 内容 |
|---|---|---|
| P1 | 坑 | 旧 session 名的 daemon 状态可能缓存失败结果（st2 反复报 `Plugin 'stealth' does not declare required capability 'browser.provider'`，换全新 session 名即成功）——launch.mutate 调试时用新 session 名排除状态污染 |
| P2 | 语义 | launch.mutate 插件 **不能** 通过 `--provider <name>` 触发（provider 入口要求 `browser.provider` capability，报错信息会误导） |
| P3 | 边界 | launch.mutate 只作用于**本地启动**；CDP 连接（`--cdp`/`connect`）、云 provider、Lightpanda 均不适用（浏览器已在跑，无法注入启动配方）——**attach 方案（browser-cdp）下 stealth 配方要直接放进镜像的浏览器启动参数/常驻 init script** |
| P4 | 边界 | headless 下 `navigator.webdriver` 原生即 true（CDP attach 场景），抹除后 eval 读到 false——真实站点还查 UA/字体/CDP 痕迹，配方需按目标站点检测面定制 |

## 复测记录

| 用例 | 日期 | 结果 | 备注 |
|---|---|---|---|
| T55.1 init script + UA flag | 2026-09-15 | ✅ | `undefined\|my-agent/1.0` |
| T55.2 launch.mutate 插件 | 2026-09-15 | ✅ | 新 session 自动应用：`false\|stealth-agent/1.0`；旧 session 状态污染坑 P1 |
