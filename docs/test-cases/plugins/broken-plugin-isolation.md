# 坏插件不得中止整轮插件激活（回归）

## 缺陷

本地插件目录（`{plugin,plugins}/` 自动发现，或配置显式指定）若**解析不到 server 入口**，会让整轮插件激活失败，导致 `/api/provider`、`/api/model`、`/api/plugin`、`/api/agent` 等全部返回空——包括所有内置插件。

真实触发形态（本机 `~/.config/opencode/plugins/vision-proxy`）：

```json
{ "name": "vision-proxy", "version": "1.0.0", "type": "module", "main": "index.ts" }
```

目录里只有 `index.ts`，没有任何 `server.*` 入口。

### 根因

`packages/plugin/src/host.ts` 的 `resolve` probing `server`/`tui`/`rpc` 时，用 `error instanceof Error` 判断是否为「缺失但可忽略」的解析错误。Bun 的 `ResolveMessage` **不继承标准 `Error`**（实测 `instanceof Error === false`），于是该判断为假，把正常的探测失败当成意外错误重新抛出。

该异常逃出 `ConfigPluginSource.scan`（`source.ts` 的 `Host.resolve` 调用点没有 `catchCause`），经 `operations()` → `supervisor.activate()` 冒泡，最终被记为 `failed to reload plugins`，**整轮激活终止**。

```
ERROR "failed to reload plugins"
cause="Cause([Die(ResolveMessage: Cannot find module '.../plugins/vision-proxy/server' ...)])"
```

### 修复

- `packages/plugin/src/host.ts`：按**解析错误码**判定可忽略（`ENOENT`、`ENOTDIR`、`MODULE_NOT_FOUND`、`ERR_MODULE_NOT_FOUND`、`ERR_PACKAGE_PATH_NOT_EXPORTED`、`ERR_UNSUPPORTED_DIR_IMPORT`），不再依赖 `instanceof Error`。
- `packages/core/src/config/plugin/source.ts`：目录无 server 入口时跳过该插件并输出 `plugin directory has no server entrypoint` 警告，避免静默丢弃。

## 单测

```bash
cd packages/plugin && bun test test/host.test.ts
```

覆盖 `packages/plugin/test/host.test.ts` 中两个用例：

- `returns no entrypoints for a local directory whose package entrypoint is missing`
- `returns no entrypoints for a local directory with no eligible files`

修复前该文件 **1 pass / 10 fail**，修复后 **11 pass / 0 fail**。失败面远大于新增用例，说明同一根因还影响多个原本「看似正常」的解析路径。

## 服务级 E2E

在 Docker 中的 SaaS 服务上注入真实坏插件，核对 API 结果：

```bash
# 注入坏插件（目录有 package.json，但入口文件不存在）
docker exec -u root opencode-saas-test sh -c '
  mkdir -p /home/opencode/.config/opencode/plugins/broken
  printf "%s" "{\"name\":\"broken\",\"version\":\"1.0.0\",\"type\":\"module\",\"exports\":{\".\":\"./missing-entry.ts\"}}" \
    > /home/opencode/.config/opencode/plugins/broken/package.json'
docker restart opencode-saas-test

# 核对（location 预热后的稳定值）
curl -s --noproxy '*' -u "opencode:$PASSWORD" \
  "http://localhost:14096/api/model?location%5Bdirectory%5D=%2Fworkspace"
```

| 场景 | `/api/model` | `/api/plugin` |
|---|---|---|
| 坏插件存在 + 未修复 | **0** | 0 |
| 坏插件存在 + 已修复 | **11**（`opencode`×8、`Yd-DeepSeek`×1、`Yd-GLM`×2） | **85** 全部正常 |

坏插件自身被跳过（不再出现在插件列表），其他插件不受影响。

> 注意：首次请求处于 location 冷启动阶段，插件尚未激活完成，可能只返回部分 model。断言前应预热 location（连续查询直至稳定），不要用首次结果判定。

## 环境注意

本机测试若在宿主机直接运行服务，会读取 `~/.config/opencode`，坏插件会触发该缺陷。**所有测试必须在 Docker 中的 SaaS 服务上执行**，容器配置目录来自镜像内的 `opencode.jsonc`，不受宿主机影响。
