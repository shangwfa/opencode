# Dockerfile
FROM node:20-slim AS base

# 设置 Corepack 使用的 npm 镜像源
ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# 使用淘宝的 npm 镜像源
RUN npm config set registry https://registry.npmmirror.com

# 设置国内源
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources && \
    sed -i 's/security.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources
# 更新包列表并安装 curl
RUN apt-get update && apt-get install -y curl



# 启用 corepack 并安装 pnpm
RUN corepack enable \
    && corepack prepare pnpm@9.1.0 --activate


# 创建工作目录并复制项目文件
WORKDIR /app

# 声明构建参数，用于传递 NEXT_PUBLIC_ENV
# 默认值为空字符串，这样 next.config.js 会使用 "/yddoc" 作为 basePath
ARG NEXT_PUBLIC_ENV=""
# 将构建参数转换为环境变量，供构建过程使用
ENV NEXT_PUBLIC_ENV=$NEXT_PUBLIC_ENV

RUN echo "NEXT_PUBLIC_ENV--->>>", $NEXT_PUBLIC_ENV

COPY . .

RUN rm -rf node_modules
# RUN rm -rf pnpm-lock.yaml

# 安装依赖并构建项目
RUN pnpm install && pnpm build

# 复制 setup.sh 脚本到容器中
# COPY setup.sh /app/

# 确保 setup.sh 可执行
# RUN chmod +x /app/setup.sh

EXPOSE 3000

# 使用 setup.sh 作为启动命令
# CMD ["/app/setup.sh"]

# 启动 Next.js 服务器
CMD ["pnpm", "start"]
