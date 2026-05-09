FROM oven/bun:1.3.11-alpine AS base
RUN apk add --no-cache git ripgrep

FROM base AS builder
WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY patches/ patches/
COPY packages/opencode/package.json packages/opencode/
COPY packages/shared/package.json packages/shared/
COPY packages/sdk/js/package.json packages/sdk/js/
COPY packages/slack/package.json packages/slack/
COPY packages/script/package.json packages/script/
COPY packages/server/package.json packages/server/
COPY packages/plugin/package.json packages/plugin/
COPY packages/function/package.json packages/function/
# First install: fast dependency fetch (patches may fail on some platforms, second install will fix)
RUN bun install --ignore-scripts || true

COPY packages/opencode packages/opencode
COPY packages/sdk packages/sdk
COPY packages/server packages/server
COPY packages/plugin packages/plugin
COPY packages/script packages/script
COPY packages/shared packages/shared

RUN bun install --ignore-scripts || true
RUN find /app -path "*/node-pty/prebuilds/*/spawn-helper" -exec chmod +x {} \;

FROM base AS runtime
WORKDIR /app

COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/packages packages
COPY --from=builder /app/package.json /app/bun.lock /app/bunfig.toml ./
COPY --from=builder /app/patches patches/

WORKDIR /app/packages/opencode

RUN adduser -D opencode && mkdir -p /workspace && chown opencode:opencode /workspace

ENV OPENCODE_DEFAULT_DIRECTORY=/workspace
ENV OPENCODE_SERVER_HOSTNAME=0.0.0.0
ENV OPENCODE_SERVER_PORT=4096
ENV OPENCODE_AUTH_PROVIDER=pg
ENV OPENCODE_SANDBOX_ENABLED=true
ENV OPENCODE_SANDBOX_VOLUME_TYPE=pvc
ENV OPENCODE_SANDBOX_PVC_CLAIM=sandbox-test
ENV OPENCODE_SANDBOX_MAX_TTL_SEC=3600
ENV OPENCODE_DISABLE_EMBEDDED_WEB_UI=1
ENV OPENCODE_DISABLE_AUTOUPDATE=1

EXPOSE 4096

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://0.0.0.0:${OPENCODE_SERVER_PORT:-4096}/global/health || exit 1

USER opencode

ENTRYPOINT ["bun", "run", "src/index.ts", "serve"]
