#!/bin/bash

# 环境变量现在通过 getServerSideProps 在运行时从 k8s 环境变量获取
# 不再需要在构建后替换环境变量
# 确保 k8s 部署时设置了所有必要的环境变量：
# - NEXT_PUBLIC_ENV
# - NEXT_PUBLIC_BASE_URL
# - NEXT_PUBLIC_COLLEGE_BASE_URL
# - NEXT_PUBLIC_BOSS_URL
# - NEXT_PUBLIC_YDDOC_API_URL
# - NEXT_PUBLIC_AI_SEARCH_SOURCE
# - NEXT_PUBLIC_SERVER_URL
# - NEXT_PUBLIC_BOARD_URL

# 启动 Next.js 服务器
pnpm start