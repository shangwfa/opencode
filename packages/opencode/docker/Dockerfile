# syntax=docker/dockerfile:1
# OpenSandbox 沙箱镜像 —— 极简版（路线 1）
#
# 基于 ubuntu:24.04 + 单版本 Node 构建，剥离 code-interpreter 自带的多语言运行时
# （Python/Go/JVM）与预装依赖缓存，rootfs 从 ~9.8G 压到 ~1.7G。
# 快照（docker commit）耗时与 rootfs 体积近似线性：9.8G→86s，1.7G→~15-20s。
#
# 依赖 OpenSandbox server 注入 bootstrap.sh（entrypoint 被其接管，见调研结论），
# 镜像自身 ENTRYPOINT 不参与 execd 启动，仅提供运行环境（bash/node/pnpm/git 等）。
FROM ubuntu:24.04

USER root

# ── 1. 基础工具 ──
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl wget git unzip zip tar bash xz-utils ripgrep util-linux \
    && rm -rf /var/lib/apt/lists/*

# ── 2. Node.js 24（官方二进制，单版本）──
ENV NODE_ROOT=/opt/node
RUN mkdir -p $NODE_ROOT \
    && curl -fsSL https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-arm64.tar.xz | tar -xJ -C $NODE_ROOT \
    && mv $NODE_ROOT/node-v24.19.0-linux-arm64 $NODE_ROOT/24
ENV PATH="$NODE_ROOT/24/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"

# ── 3. pnpm@10 ──
RUN npm config set registry https://registry.npmmirror.com --global \
    && npm install -g pnpm@10 \
    && pnpm config set registry https://registry.npmmirror.com --global

# ── 4. 全局 npm 工具（MCP / agent-browser / LSP 相关）──
RUN npm install -g supergateway agent-browser bun typescript pyright

# ── 5. Chromium via Playwright（agent-browser 需要）──
RUN npx playwright install --with-deps chromium \
    && ln -sf /root/.cache/ms-playwright/chromium-*/chrome-linux*/chrome /usr/local/bin/chromium
ENV CHROME_PATH=/usr/local/bin/chromium

# ── 6. codegraph（自包含 Node bundle）──
ENV CODEGRAPH_VERSION=v1.4.1
ENV CODEGRAPH_INSTALL_DIR=/opt/codegraph
RUN curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh \
    | CODEGRAPH_BIN_DIR=/usr/local/bin sh \
  && codegraph --version \
  && which codegraph

# ── 7. opencode LSP daemon + TypeScript/pyright ──
COPY docker/opt/opencode-lsp-daemon/ /opt/opencode-lsp-daemon/
RUN chmod +x /opt/opencode-lsp-daemon/index.js \
    && ln -sf /opt/opencode-lsp-daemon/index.js /usr/local/bin/opencode-lsp-agent

# ── 8. 沙箱 session 插件 agent（V2 sandbox 执行）──
COPY docker/opt/sandbox-plugin-agent.ts /opt/sandbox-plugin-agent.ts
COPY docker/opt/sandbox-plugin-npm.ts /opt/sandbox-plugin-npm.ts

# ── 9. 交互式 PTY agent ──
RUN mkdir -p /opt/opencode-pty-agent \
    && cd /opt/opencode-pty-agent \
    && bun add bun-pty@0.4.8
COPY docker/opt/opencode-pty-agent.ts /opt/opencode-pty-agent/index.ts

# ── 10. 瘦身清理（快照提速：commit 全量导出 rootfs）──
# 保留 Chromium（功能必需）；清 npm/playwright 之外的可再生缓存。
RUN rm -rf /root/.npm /root/.cache/pip \
    && rm -rf /usr/local/lib/node_modules/.cache

ENTRYPOINT ["/bin/bash"]
WORKDIR /workspace
