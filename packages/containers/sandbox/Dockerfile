FROM opensandbox/code-interpreter:latest

USER root

# 切换国内镜像源：apt 阿里云 / npm 淘宝 / pip 清华
RUN sed -i 's|http://ports.ubuntu.com/ubuntu-ports|https://mirrors.aliyun.com/ubuntu-ports|g' /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null \
  || sed -i 's|http://ports.ubuntu.com/ubuntu-ports|https://mirrors.aliyun.com/ubuntu-ports|g' /etc/apt/sources.list 2>/dev/null \
  || true
RUN npm config set registry https://registry.npmmirror.com
RUN mkdir -p /root/.pip && printf '[global]\nindex-url = https://pypi.tuna.tsinghua.edu.cn/simple\n' > /root/.pip/pip.conf

# 升级 Node 到 22 LTS 稳定版（基础镜像 v22.2.0 太旧，corepack 0.35+ 要求 ^22.22.2）
ARG NODE_VERSION=22
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
  && apt-get install -y nodejs \
  && for bin in node npm npx corepack; do ln -sf /usr/bin/$bin /opt/node/v22.2.0/bin/$bin; done \
  && rm -rf /var/lib/apt/lists/*

# 安装 ripgrep（glob/grep/ls 工具的沙箱分支依赖 rg 命令）
RUN apt-get update \
  && apt-get install -y --no-install-recommends ripgrep \
  && rm -rf /var/lib/apt/lists/*

# P0: 预装 pnpm + yarn + bun，避免 AI 运行时花 10-20s 安装包管理器
ARG COREPACK_VERSION=0.35.0
ARG PNPM_VERSION=11.5.2
ARG YARN_VERSION=4.16.0
ARG BUN_VERSION=1.3.14
RUN npm install -g corepack@${COREPACK_VERSION} \
  && corepack enable \
  && corepack prepare pnpm@${PNPM_VERSION} --activate \
  && corepack prepare yarn@${YARN_VERSION} --activate \
  && for bin in pnpm yarn pnpx; do ln -sf /usr/local/bin/$bin /opt/node/v22.2.0/bin/$bin 2>/dev/null || true; done \
  && curl -fsSL https://bun.sh/install | bash -s -- bun-v${BUN_VERSION} \
  && ln -s /root/.bun/bin/bun /usr/local/bin/bun

# P1: 预装 uv（Python 极速包管理器）
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
  && ln -sf /root/.local/bin/uv /usr/local/bin/uv \
  && ln -sf /root/.local/bin/uvx /usr/local/bin/uvx

# P2: 全局安装 TypeScript LSP 和 Python LSP
RUN npm install -g typescript typescript-language-server pyright 2>&1 \
  && ln -sf /usr/local/lib/node_modules/.bin/typescript-language-server /usr/local/bin/typescript-language-server \
  && ln -sf /usr/local/lib/node_modules/.bin/pyright-langserver /usr/local/bin/pyright-langserver \
  && ln -sf /usr/local/lib/node_modules/.bin/pyright /usr/local/bin/pyright

# 创建 workspace 目录（opencode 沙箱默认挂载点）
RUN mkdir -p /workspace

# 预热 tsserver：创建 dummy 项目并启动一次，让 V8 JIT 编译完成
COPY warmup-tsserver.mjs /tmp/warmup-tsserver.mjs
RUN mkdir -p /tmp/warmup \
  && echo '{"compilerOptions":{"target":"ES2020","module":"commonjs","strict":true}}' > /tmp/warmup/tsconfig.json \
  && echo 'const x: number = 1;' > /tmp/warmup/warmup.ts \
  && timeout 120 node /tmp/warmup-tsserver.mjs || true \
  && rm -rf /tmp/warmup /tmp/warmup-tsserver.mjs

WORKDIR /workspace
