# v2 SaaS 服务镜像 —— 容器内跑 v2 server（serve 命令，暴露 /api/* 的 v2 REST API 与 web UI）。
# 与 v1 镜像的差异：入口改为 packages/cli、PG 走 core 的 pg bridge
# （OPENCODE_DATABASE_URL）、provider 配置沿用 opencode.jsonc、模型目录使用
# packages/core 内置 snapshot（不再 COPY 根 models-dev.json）。
# glibc 基础镜像：Bun 在 musl 上对 core 的 PG bridge（Proxy 密集访问）存在
# 段错误（Bun 1.3.14 已知不稳），Debian 版更可靠。
FROM oven/bun:1.3.14 AS base
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/*

FROM base AS builder
WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY patches/ patches/
COPY packages packages
COPY services services
COPY sdks sdks
# 本镜像只构建 v2 运行时：去掉 v1 家族 workspace 与构建期不需要的 patch 声明
RUN rm -rf patches && sed -i '/"patchedDependencies"/,/^[[:space:]]*}/d' package.json \
    && sed -i '/"packages\/v1\/\*",/d' package.json
RUN for attempt in 1 2 3; do \
      if bun install --ignore-scripts --network-concurrency=16; then exit 0; fi; \
      echo "bun install attempt ${attempt} failed; retrying"; \
      sleep 5; \
    done; \
    echo "bun install failed after 3 attempts"; exit 1

RUN find /app -path "*/node-pty/prebuilds/*/spawn-helper" -exec chmod +x {} \;

FROM base AS runtime
WORKDIR /app

COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/packages packages
COPY --from=builder /app/services services
COPY --from=builder /app/sdks sdks
COPY --from=builder /app/package.json /app/bun.lock /app/bunfig.toml ./

WORKDIR /app/packages/cli

RUN useradd -m -s /bin/bash opencode && mkdir -p /workspace && chown opencode:opencode /workspace

COPY opencode.jsonc /home/opencode/.config/opencode/opencode.jsonc
RUN chown -R opencode:opencode /home/opencode

ENV OPENCODE_DISABLE_AUTOUPDATE=1
ENV OPENCODE_DEFAULT_DIRECTORY=/workspace
# 部署必须注入（不写入镜像层）：
#   OPENCODE_PASSWORD       服务访问口令，请求带 Basic auth（用户名 opencode）
#   OPENCODE_DATABASE_URL   PG 连接串（core pg bridge；多实例共享同一库）

EXPOSE 4096

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- --header="Authorization: Basic $(printf 'opencode:%s' "$OPENCODE_PASSWORD" | base64)" http://127.0.0.1:${OPENCODE_SERVER_PORT:-4096}/api/info || exit 1

USER opencode

ENTRYPOINT ["bun", "run", "src/index.ts"]
CMD ["serve", "--hostname", "0.0.0.0", "--port", "4096"]
