FROM opensandbox/code-interpreter:latest AS base

USER root

ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}
RUN apt-get update \
  && apt-get install -y --no-install-recommends ripgrep \
  && rm -rf /var/lib/apt/lists/*

ARG NODE_VERSION=24
ARG COREPACK_VERSION=0.35.0
ARG PNPM_VERSION=11.5.2
ARG YARN_VERSION=4.16.0
ARG BUN_VERSION=1.3.14
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /opt/node/v18.20.3 /opt/node/v20.14.0 \
  && for bin in node npm npx corepack; do ln -sf /usr/bin/$bin /opt/node/v22.2.0/bin/$bin; done \
  && rm -f /opt/node/v22.2.0/bin/pnpm /opt/node/v22.2.0/bin/yarn /opt/node/v22.2.0/bin/pnpx \
  && npm install -g corepack@${COREPACK_VERSION} supergateway \
  && corepack enable \
  && corepack prepare pnpm@${PNPM_VERSION} --activate \
  && corepack prepare yarn@${YARN_VERSION} --activate \
  && for bin in pnpm yarn pnpx; do ln -sf /usr/local/bin/$bin /opt/node/v22.2.0/bin/$bin 2>/dev/null || true; done \
  && ln -sf /usr/local/lib/node_modules/.bin/supergateway /usr/local/bin/supergateway \
  && curl -fsSL https://bun.sh/install | bash -s -- bun-v${BUN_VERSION} \
  && ln -s /root/.bun/bin/bun /usr/local/bin/bun

FROM base AS build-amd64
COPY dist/opencode-linux-x64-baseline/bin/opencode /usr/local/bin/opencode

FROM base AS build-arm64
COPY dist/opencode-linux-arm64/bin/opencode /usr/local/bin/opencode

ARG TARGETARCH
FROM build-${TARGETARCH}
RUN opencode --version
