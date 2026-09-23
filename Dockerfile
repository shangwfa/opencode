# v2 服务镜像 —— 基于 v1.18.31 服务 Dockerfile 调整为 v2 仓库结构。
# 与 v1 版本的差异：
#  - 基础镜像用 Debian(glibc) 而非 alpine(musl)：Bun 1.3.14 在 musl 上跑 core 的
#    PG bridge（Proxy 密集访问）会段错误。
#  - 保留上游 patches/ 与 patchedDependencies（bun.lock 依赖补丁），不做 sed 删除。
#  - 模型目录使用 packages/core 内置 snapshot（上游无根 models-dev.json，无需 COPY）。
#  - 注入磁盘转译缓存路径：禁用（=0）时位置实例冷启动单环节 CPU 满核 ~60s，
#    启用后仅首次预热慢、后续 0.2s 级；容器重建后缓存丢失属预期，可挂 volume 保留。
#  - DATABASE_URL / SANDBOX 等部署敏感配置不写入镜像层，部署时注入。
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS base
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/*

FROM base AS builder
WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY patches/ patches/
COPY packages packages
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked bun install --ignore-scripts

RUN find /app -path "*/node-pty/prebuilds/*/spawn-helper" -exec chmod +x {} \;

FROM base AS runtime
WORKDIR /app

COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/packages packages
COPY --from=builder /app/package.json /app/bun.lock /app/bunfig.toml ./

WORKDIR /app/packages/cli

RUN useradd -m -s /bin/bash opencode && mkdir -p /workspace && chown opencode:opencode /workspace

COPY opencode.jsonc /home/opencode/.config/opencode/opencode.jsonc
RUN chown -R opencode:opencode /home/opencode

ENV OPENCODE_SERVER_HOSTNAME=0.0.0.0
ENV OPENCODE_SERVER_PORT=4096
ENV OPENCODE_DEFAULT_DIRECTORY=/workspace
ENV OPENCODE_DISABLE_AUTOUPDATE=1
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=/tmp/bun-transpile
# 部署按需注入（不写入镜像层）：
#   OPENCODE_DATABASE_URL          PG 连接串
#   OPENCODE_SANDBOX_ENABLED       是否启用远程沙箱
#   OPENCODE_SANDBOX_DOMAIN        OpenSandbox 控制面地址
#   OPENCODE_SANDBOX_API_KEY       OpenSandbox 访问密钥
#   OPENCODE_SANDBOX_USE_SERVER_PROXY / OPENCODE_SANDBOX_VOLUME_TYPE / ...
#   OPENCODE_PASSWORD              服务访问口令（网关前置认证时无需）

EXPOSE 4096

# Debian 镜像无 wget；用 bun 探活。
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD bun -e "const password=process.env.OPENCODE_PASSWORD;const headers=password?{Authorization:'Basic '+Buffer.from('opencode:'+password).toString('base64')}:{};fetch('http://127.0.0.1:'+(process.env.OPENCODE_SERVER_PORT||4096)+'/api/info',{headers}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

USER opencode

ENTRYPOINT ["bun", "run", "src/index.ts"]
CMD ["serve", "--hostname", "0.0.0.0", "--port", "4096"]
