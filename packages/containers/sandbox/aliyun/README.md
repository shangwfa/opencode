# 阿里云沙箱自定义模板（浏览器运行时）

阿里云沙箱 API 是 E2B 兼容的：模板用 Dockerfile 构建后以别名引用（`OPENCODE_ALIYUN_TEMPLATE`）。
官方 `base-5wa5` / `code-interpreter-v1` 不含 Chromium 与 CDP 网关，Browser Use 需要本模板。

## 基础镜像

`FROM fc-e2b-registry.cn-hangzhou.cr.aliyuncs.com/runtime-v2/base:v0.0.53`（Debian 13）。

该镜像自带 E2B 兼容执行代理 `/.fce2b/envd` 与入口 `/.fce2b/entrypoint`，**不要覆盖入口**，否则沙箱无法执行命令。
仓库早期的 `FROM e2bdev/base` 已替换；平台 `runtime-v2/all-in-one` 虽然自带 Chrome，但它监听 9222 且经沙箱域名访问被 Host 校验拒绝，
也不能被我们的网关接管，因此不作为基础镜像。

推送标签示例：`crpi-hlpnu8kiweghie0r.cn-hangzhou.personal.cr.aliyuncs.com/shangwfa/opencode-sandbox:runtime-v2-browser-v1`。
构建时用 `--provenance=false --sbom=false`，否则 ACR 会拒绝（`unknown manifest class for application/vnd.oci.empty.v1+json`）。

## 构建

模板里必须保留 E2B 兼容 agent（`e2bdev/base` 自带），否则沙箱无法执行命令。

```sh
cp -R ../opt/cdp-browser ./cdp-browser
# 在阿里云沙箱控制台用本 Dockerfile 创建模板，别名例如 opencode-browser-use
```

2026-10-29 专项排查确认官方构建接口不可用：正确 Dockerfile、带 `startCmd/readyCmd`、最小 `FROM e2bdev/base`、
`FROM ubuntu:24.04`、本账号 ACR 基础镜像，以及**故意非法**的 Dockerfile，全部 202 后 0.5s 转 `error`；
构建日志端点存在但恒为空（构建从未启动）；参数校验本身正常（数组 400、缺 dockerfile 400）；
`PATCH /templates/{alias}` 接受 dockerfile 但不触发重建。属平台调度/权限问题。

因此改用控制台构建：

1. 控制台新建模板，基础镜像/构建方式选 Dockerfile；
2. 上传本目录（含 `cdp-browser/`）作为构建上下文；
3. 构建完成后把别名写入 SaaS：`OPENCODE_ALIYUN_TEMPLATE=<别名>`；
4. 用 `docs/test-cases/browser-use-migration.md` 的 E2E 复验（`EXPECT_SANDBOX_PROVIDER=aliyun PAGE_MODE=sandbox`）。

## 不要用运行时自举

`OPENCODE_BROWSER_AUTO_INSTALL=1` 虽然能在沙箱里用 Playwright 装 Chromium 并下发网关，
但 2026-10-29 在阿里云 `base-5wa5` 实测：安装 8 分钟仍未完成（Playwright 下载 + apt 依赖），
超过创建接口与前端请求的合理等待，最终被判失败。云端后端应使用预装镜像/模板。

## 已验证的部分（2026-10-29，base-5wa5 + 运行时自举的一次成功运行）

创建会话、沙箱内测试页、控制面代理实时 JPEG（16132 B）、真实页面中文输入与点击、
脚本发布/版本/PG 归属、删除与沙箱回收均通过；模型轮次因缺少 `agent-browser` 绕路超时。
这证明阿里云链路的代理/输入/画面/权限都可用，唯一缺口是浏览器运行时的模板。

清理：测试库 13 条 sandbox 全部 `destroyed`，会话已删除；探针模板已删除，
账号只剩原有 `base-5wa5` 与 `code-interpreter-v1`。
