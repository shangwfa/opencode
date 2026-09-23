# browser-cdp 测试台

vite + react + tailwind 前端，用于测试 `packages/opencode/docker/browser-cdp` 镜像：
在 opencode SaaS 上创建**指定沙箱镜像**的会话，自动拉起常驻 CDP 浏览器，并在页面里
实时显示浏览器画面（CDP `Page.startScreencast`）+ 鼠标/键盘控制。

> 深入文档（`docs/`）：
> [架构设计](docs/architecture.md) ·
> [实现过程与踩坑记录](docs/implementation-notes.md) ·
> [测试手册](docs/testing.md)

## 链路

```
本页面 (localhost:5174)
  └─ /api/*            server/plugin.ts → opencode SaaS (OPENCODE_SAAS_BASE_URL)
  │    POST /session {sandbox:{cpu,memory,image}}   会话级指定 browser-cdp 镜像
  │    POST /session/:sid/keep-alive {boot:true}    立即创建沙箱
  │    POST /session/:sid/exec                      拉起 /opt/cdp-browser/cdp-browser.sh
  └─ /cdp/:sid/*       HTTP+WS 代理 → SaaS sandbox-proxy (/session/:sid/proxy/9222/...)
       → 沙箱内 cdp-gateway(9222) → headless Chromium(127.0.0.1:9221)
```

前端全程同源访问，规避 CORS 与 Chrome 对 Host/Origin 的校验。

## 启动

前置：本地测试环境已就绪（见 `docs/local-test-env.md` 组合 3），且本机已构建
`opencode-saas-browser-cdp:test` 镜像：

```bash
cd packages/opencode
docker build -t opencode-saas-browser-cdp:test -f docker/browser-cdp/Dockerfile .
```

启动测试台：

```bash
cd docs/products/browser-cdp
npm install
OPENCODE_SAAS_BASE_URL=http://localhost:14096 npm run dev
```

打开 http://localhost:5174 ，点「新建会话」（镜像输入框可覆盖默认），等待沙箱创建 +
浏览器拉起（约 1-2 分钟，首次拉镜像更久），画面出现后即可：

- 画面上点击/滚动/输入 → 控制沙箱内浏览器
- 地址栏输入 URL → `Page.navigate`
- 「新标签 / 关闭 / 刷新」→ 管理 CDP target

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `OPENCODE_SAAS_BASE_URL` | `http://localhost:14096` | opencode SaaS 服务地址 |
| `BROWSER_CDP_IMAGE` | `opencode-saas-browser-cdp:test` | 新建会话默认沙箱镜像 |
| `BROWSER_CDP_CPU` / `BROWSER_CDP_MEMORY` | `1` / `2Gi` | 沙箱资源配置 |
