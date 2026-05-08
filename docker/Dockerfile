FROM oven/bun:1.3.11-alpine AS base
RUN apk add --no-cache git ripgrep

FROM base AS deps
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
RUN bun install --ignore-scripts

FROM base AS runtime
WORKDIR /app/packages/opencode

COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/packages/opencode/node_modules /app/packages/opencode/node_modules
COPY --from=deps /app/packages/sdk/js/node_modules /app/packages/sdk/js/node_modules
COPY --from=deps /app/packages/server/node_modules /app/packages/server/node_modules
COPY --from=deps /app/packages/plugin/node_modules /app/packages/plugin/node_modules
COPY --from=deps /app/packages/script/node_modules /app/packages/script/node_modules
COPY --from=deps /app/packages/shared/node_modules /app/packages/shared/node_modules

COPY packages/opencode/src packages/opencode/src
COPY packages/opencode/package.json packages/opencode/package.json
COPY packages/opencode/tsconfig.json packages/opencode/tsconfig.json
COPY packages/opencode/drizzle.pg.config.ts packages/opencode/drizzle.pg.config.ts
COPY packages/opencode/migration packages/opencode/migration
COPY packages/opencode/migration-pg packages/opencode/migration-pg
COPY packages/sdk /app/packages/sdk
COPY packages/server /app/packages/server
COPY packages/plugin /app/packages/plugin
COPY packages/script /app/packages/script
COPY packages/shared /app/packages/shared
COPY package.json bun.lock bunfig.toml /app/
COPY patches/ /app/patches/

RUN adduser -D -H opencode

ENV OPENCODE_SERVER_HOSTNAME=0.0.0.0
ENV OPENCODE_SERVER_PORT=4096
ENV OPENCODE_DISABLE_EMBEDDED_WEB_UI=1
ENV OPENCODE_DISABLE_AUTOUPDATE=1

EXPOSE 4096

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${OPENCODE_SERVER_PORT:-4096}/ || exit 1

USER opencode

ENTRYPOINT ["bun", "run", "--bun", "src/index.ts", "serve"]
