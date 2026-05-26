FROM opensandbox/code-interpreter:latest

USER root

# 全局安装 TypeScript LSP 和 Python LSP
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
