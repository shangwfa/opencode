# syntax=docker/dockerfile:1
FROM opensandbox/code-interpreter:latest

USER root

ARG NODE_VERSION=24
ARG COREPACK_VERSION=0.35.0
ARG PNPM_VERSION=10.12.1
RUN npm config set registry https://registry.npmmirror.com \
  && npm config set cache /opt/package-cache-base/npm \
  && echo "confirm-modules-purge=false" >> /etc/npmrc \
  && echo "confirm-modules-purge=false" >> /root/.npmrc \
  && apt-get update \
  && apt-get install -y --no-install-recommends ripgrep \
  && OLD_NODE_BIN=$(dirname $(readlink -f $(which node))) \
  && curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
  && apt-get install -y nodejs \
  && for bin in node npm npx corepack; do ln -sf /usr/bin/$bin $OLD_NODE_BIN/$bin; done \
  && rm -f $OLD_NODE_BIN/pnpm $OLD_NODE_BIN/yarn $OLD_NODE_BIN/pnpx \
  && npm install -g corepack@${COREPACK_VERSION} supergateway \
  && corepack enable \
  && corepack prepare pnpm@${PNPM_VERSION} --activate \
  && for bin in pnpm pnpx supergateway; do ln -sf $(which $bin) $OLD_NODE_BIN/$bin 2>/dev/null || true; done \
  && mkdir -p /root/.config/pnpm \
  && echo "storeDir: /root/.local/share/pnpm/store" > /root/.config/pnpm/config.yaml

# ── Pre-populate npm node_modules + pnpm store via workspace template ──
# npm:  pre-installed node_modules saved to /opt/preload/<template>/node_modules
# pnpm: store populated at /root/.local/share/pnpm/store (global config.yaml sets storeDir)
# npm cache: tarball cache at /opt/package-cache-base/npm
COPY docker/ /tmp/preload/
RUN cd /tmp/preload \
    && mkdir -p /opt/package-cache-base/npm /opt/preload \
    && for dir in packages/*/; do \
         name=$(basename "$dir"); \
         (cd "$dir" && npm install --ignore-scripts); \
         mkdir -p "/opt/preload/$name"; \
         cp -a "$dir/node_modules" "/opt/preload/$name/node_modules"; \
         cp "$dir/package.json" "/opt/preload/$name/package.json"; \
         cp "$dir/package-lock.json" "/opt/preload/$name/package-lock.json" 2>/dev/null || true; \
       done \
    && rm -rf packages/*/node_modules \
    && pnpm install --ignore-scripts \
    && rm -rf /tmp/preload
