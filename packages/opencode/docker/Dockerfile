# syntax=docker/dockerfile:1
FROM registry.shadow-rpa.net/infra/opensandbox:2026-06-09

USER root

# ── 1. Install mise (runtime version manager) ──
ENV MISE_DATA_DIR="/root/.local/share/mise"
ENV MISE_CONFIG_DIR="/root/.config/mise"
ENV MISE_CACHE_DIR="/root/.cache/mise"
ENV MISE_INSTALL_PATH="/usr/local/bin/mise"
RUN curl https://mise.run | sh

# ── 2. Configure mise: trust all paths, enable idiomatic version files ──
RUN mkdir -p "$MISE_CONFIG_DIR" \
  && cat > "$MISE_CONFIG_DIR/config.toml" <<'EOF'
[tools]
node = "24"

[settings]
trusted_config_paths = ["/"]
idiomatic_version_file_enable_tools = ["node", "pnpm", "npm", "bun"]
status = { show_env = false, show_tools = false }
EOF

# ── 3. Install multiple Node.js versions ──
RUN mise install node@18 node@20 node@22 node@24

# ── 4. Set node@24 as default first (needed for npm registry config) ──
RUN mise use -g node@24
RUN mise reshim
ENV PATH="$MISE_DATA_DIR/shims:$MISE_DATA_DIR/installs/node/24/bin:/usr/local/bin:$PATH"

# ── 5. Configure npm registry (npmmirror) before installing pnpm via npm backend ──
RUN npm config set registry https://registry.npmmirror.com \
    && npm config set cache /opt/package-cache-base/npm

# ── 6. Install multiple pnpm versions (via npm backend, uses npmmirror) ──
# Default backend (aqua) downloads from GitHub which is slow/blocked in China.
# npm backend downloads from npm registry (npmmirror) instead.
RUN mise install npm:pnpm@8 npm:pnpm@9 npm:pnpm@10 npm:pnpm@11

# ── 7. Set default versions (node@24 + pnpm@10) and refresh shims ──
RUN mise use -g npm:pnpm@10 && mise reshim

# ── 8. Install global npm tools + ripgrep ──
RUN npm install -g supergateway
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
  && apt-get install -y --no-install-recommends ripgrep \
  && rm -rf /var/lib/apt/lists/*

# ── 9. Symlink mise-managed binaries to OpenSandbox's expected PATH ──
# OpenSandbox bootstrap may reset PATH; ensure node/pnpm/npm are always findable.
RUN OLD_NODE_BIN=$(dirname $(readlink -f $(which node) 2>/dev/null) 2>/dev/null || echo "/usr/local/bin") \
  && for bin in node npm npx pnpm pnpx supergateway; do \
       target=$(mise which "$bin" 2>/dev/null || echo ""); \
       [ -n "$target" ] && ln -sf "$target" "$OLD_NODE_BIN/$bin" 2>/dev/null || true; \
     done

# ── 10. Configure pnpm: store + virtual-store on overlay (fast) instead of NFS ──
# When /workspace is NFS-mounted (PVC), pnpm's default store lands on NFS (slow).
# By pointing store-dir to /opt/pnpm-store (overlay, image layer) and
# virtual-store-dir to /tmp/pnpm-vs (overlay, ephemeral), all heavy IO
# stays on fast local disk. NFS only receives lightweight symlinks.
# /opt and /tmp are both overlay → same filesystem → hardlink works.
RUN pnpm config set store-dir /opt/pnpm-store --global \
  && pnpm config set virtual-store-dir /tmp/pnpm-vs --global

# ── 11. Pre-populate pnpm store via workspace templates ──
# pnpm store pre-populated at /opt/pnpm-store (content-addressable).
# Only pnpm@10 (default version) store is pre-populated.
COPY . /tmp/preload/
RUN cd /tmp/preload \
    && mkdir -p /opt/pnpm-store \
    && for dir in packages/*/; do \
         (cd "$dir" && pnpm install --ignore-scripts 2>/dev/null || true); \
       done \
    && rm -rf /tmp/preload /tmp/pnpm-vs
