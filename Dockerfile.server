FROM oven/bun:1.3.11-alpine AS base
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories \
    && apk add --no-cache git ripgrep

FROM base AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY patches/ patches/
COPY packages/opencode/package.json packages/opencode/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/sdk/js/package.json packages/sdk/js/package.json
COPY packages/slack/package.json packages/slack/package.json
COPY packages/script/package.json packages/script/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/plugin/package.json packages/plugin/package.json
COPY packages/function/package.json packages/function/package.json
RUN bun install --ignore-scripts

FROM base AS runtime
WORKDIR /app/packages/opencode

COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/packages/opencode/node_modules /app/packages/opencode/node_modules
COPY --from=deps /app/packages/shared/node_modules /app/packages/shared/node_modules
COPY --from=deps /app/packages/sdk/js/node_modules /app/packages/sdk/js/node_modules
COPY --from=deps /app/packages/slack/node_modules /app/packages/slack/node_modules
COPY --from=deps /app/packages/script/node_modules /app/packages/script/node_modules
COPY --from=deps /app/packages/server/node_modules /app/packages/server/node_modules
COPY --from=deps /app/packages/plugin/node_modules /app/packages/plugin/node_modules
COPY --from=deps /app/packages/function/node_modules /app/packages/function/node_modules

COPY packages/opencode .
COPY packages/shared /app/packages/shared
COPY packages/sdk /app/packages/sdk
COPY packages/slack /app/packages/slack
COPY packages/script /app/packages/script
COPY packages/server /app/packages/server
COPY packages/plugin /app/packages/plugin
COPY packages/function /app/packages/function
COPY package.json bun.lock bunfig.toml /app/
COPY patches/ /app/patches/

ENV OPENCODE_SERVER_HOSTNAME=0.0.0.0
ENV OPENCODE_SERVER_PORT=4096
ENV OPENCODE_DISABLE_EMBEDDED_WEB_UI=1
ENV OPENCODE_DISABLE_AUTOUPDATE=1

EXPOSE 4096

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${OPENCODE_SERVER_PORT:-4096}/ || exit 1

ENTRYPOINT ["bun", "run", "--bun", "src/index.ts", "serve", "--port", "4096", "--hostname", "0.0.0.0"]
