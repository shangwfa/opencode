FROM opensandbox/code-interpreter:latest

USER root

ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}

RUN npm config set registry https://registry.npmmirror.com

RUN apt-get update \
  && apt-get install -y --no-install-recommends ripgrep \
  && rm -rf /var/lib/apt/lists/*

ARG NODE_VERSION=24
ARG COREPACK_VERSION=0.35.0
ARG PNPM_VERSION=11.5.2
ARG YARN_VERSION=4.16.0
ARG BUN_VERSION=1.3.14
RUN OLD_NODE_BIN=$(dirname $(readlink -f $(which node))) \
  && curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
  && apt-get install -y nodejs \
  && for bin in node npm npx corepack; do ln -sf /usr/bin/$bin $OLD_NODE_BIN/$bin; done \
  && rm -f $OLD_NODE_BIN/pnpm $OLD_NODE_BIN/yarn $OLD_NODE_BIN/pnpx \
  && npm install -g corepack@${COREPACK_VERSION} supergateway \
  && corepack enable \
  && corepack prepare pnpm@${PNPM_VERSION} --activate \
  && corepack prepare yarn@${YARN_VERSION} --activate \
  && for bin in pnpm yarn pnpx supergateway; do ln -sf $(which $bin) $OLD_NODE_BIN/$bin 2>/dev/null || true; done \
  && curl -fsSL https://bun.sh/install | bash -s -- bun-v${BUN_VERSION} \
  && ln -s /root/.bun/bin/bun /usr/local/bin/bun
