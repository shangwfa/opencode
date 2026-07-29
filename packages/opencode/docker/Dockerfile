# syntax=docker/dockerfile:1
ARG OPENSANDBOX_BASE=opensandbox/code-interpreter:latest
FROM ${OPENSANDBOX_BASE}

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
RUN mise settings npm.shell_out=true \
  && mise install npm:pnpm@8 npm:pnpm@9 npm:pnpm@10 npm:pnpm@11

# ── 7. Set default versions (node@24 + pnpm@10) and refresh shims ──
RUN mise use -g npm:pnpm@10 && mise reshim

# ── 8. Install global npm tools + ripgrep ──
RUN npm install -g supergateway agent-browser bun
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
  && apt-get install -y --no-install-recommends ripgrep \
  && rm -rf /var/lib/apt/lists/*

# ── 8a. Install Chromium via Playwright (supports arm64 + x86_64) ──
# agent-browser requires Chrome; Playwright bundles a real Chromium binary
# that works in containers (unlike Ubuntu snap chromium).
RUN npx playwright install --with-deps chromium \
  && ln -sf /root/.cache/ms-playwright/chromium-*/chrome-linux*/chrome /usr/local/bin/chromium
ENV CHROME_PATH=/usr/local/bin/chromium

# ── 8b. Install codegraph (self-contained Node bundle, no extra runtime) ──
# Pre-installed to avoid per-session `curl install.sh | sh` (saves ~5s + network).
# Bundle ships its own Node runtime; installed to /opt/codegraph, symlinked to /usr/local/bin.
ENV CODEGRAPH_VERSION=v1.4.1
ENV CODEGRAPH_INSTALL_DIR=/opt/codegraph
RUN curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh \
    | CODEGRAPH_BIN_DIR=/usr/local/bin sh \
  && codegraph --version \
  && which codegraph

# ── 8c. Install context-mode (context window optimization for AI agents) ──
# Registered as session plugin with source: "code" wrapper (sets CONTEXT_MODE_PLATFORM=opencode).
# --allow-scripts: required for better-sqlite3 prebuild-install (FTS5 native module).
RUN npm install -g context-mode zod --allow-scripts

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
COPY docker/packages/ /tmp/preload/packages/
COPY docker/pnpm-workspace.yaml docker/package.json /tmp/preload/
RUN cd /tmp/preload \
    && mkdir -p /opt/pnpm-store \
    && for dir in packages/*/; do \
         echo "==> Pre-populating pnpm store: $dir" \
         && (cd "$dir" && pnpm install --ignore-scripts || true); \
       done \
    && rm -rf /tmp/preload /tmp/pnpm-vs

# ── 12. Install opencode LSP daemon + TypeScript + pyright ──
# TS 7.x native binary speaks LSP directly (--lsp --stdio); typescript-language-server no longer needed
COPY docker/opt/opencode-lsp-daemon/ /opt/opencode-lsp-daemon/
RUN npm install -g typescript pyright \
    && ln -sf /opt/opencode-lsp-daemon/index.js /usr/local/bin/opencode-lsp-agent

# ── 13. Pre-install sandbox-plugin-agent (session plugin daemon for V2 sandbox execution) ──
COPY docker/opt/sandbox-plugin-agent.ts /opt/sandbox-plugin-agent.ts
COPY docker/opt/sandbox-plugin-npm.ts /opt/sandbox-plugin-npm.ts
