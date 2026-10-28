# hn-gateway 运行镜像：单文件 bundle（宿主机 esbuild 产物），运行时零依赖
# 构建前先执行：bun run build:node
FROM node:20-alpine

WORKDIR /app
COPY dist/server.js ./server.js

ENV GATEWAY_HOST=0.0.0.0 GATEWAY_PORT=3101 NODE_ENV=production
EXPOSE 3101

# socket.io ws 透传需 node 运行时（Bun 限制，见 README）；直接 node 启动
CMD ["node", "server.js"]
