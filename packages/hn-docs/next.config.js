/** @type {import('next').NextConfig} */

// 文档平台(knowledge)内网地址:浏览器请求经此 rewrite 代理,knowledge 不暴露公网
const KNOWLEDGE_INTERNAL_URL =
  process.env.KNOWLEDGE_INTERNAL_URL || "http://127.0.0.1:8787";

const nextConfig = {
  productionBrowserSourceMaps: false,
  basePath: process.env.NEXT_PUBLIC_ENV === "international" ? "" : "/yddoc",
  typescript: {
    ignoreBuildErrors: true,
  },
  distDir: "dist",
  transpilePackages: ["antd", "@ant-design"],
  // 移除 env 配置，环境变量改为运行时从 k8s 获取（通过 getServerSideProps 注入）
  async rewrites() {
    const K = `${KNOWLEDGE_INTERNAL_URL}/api/doc-platform/compat`;
    return [
      {
        // basePath:false:浏览器相对路径 /api/doc-platform/**(无 /yddoc 前缀)直达 knowledge
        source: "/api/doc-platform/:path*",
        destination: `${KNOWLEDGE_INTERNAL_URL}/api/doc-platform/:path*`,
        basePath: false,
      },
      {
        // 兼容带 basePath 的绝对调用(/yddoc/api/doc-platform/**)
        source: "/api/doc-platform/:path*",
        destination: `${KNOWLEDGE_INTERNAL_URL}/api/doc-platform/:path*`,
      },
      // ── v1 兼容层:原 UI 组件的 yddoc/Boss 接口 → knowledge compat ──
      {
        source: "/api/noauth/v1/yddoc/:path*",
        destination: `${K}/yddoc/:path*`,
        basePath: false,
      },
      {
        source: "/api/v3/cornerstone/helpdoc/:path*",
        destination: `${K}/yddoc/cornerstone/helpdoc/:path*`,
        basePath: false,
      },
      {
        source: "/api/noauth/v1/ep/config/queryOem",
        destination: `${K}/oem/query`,
        basePath: false,
      },
      {
        source: "/boss/api/v3/cornerstone/helpdoc/:path*",
        destination: `${K}/boss/helpdoc/:path*`,
        basePath: false,
      },
      {
        source: "/api/v1/sys/:path*",
        destination: `${K}/sys/:path*`,
        basePath: false,
      },
      {
        // 原公开搜索 API 使用 noauth 前缀；映射到同一套 knowledge 兼容路由。
        source: "/api/noauth/v1/sys/:path*",
        destination: `${K}/sys/:path*`,
        basePath: false,
      },
      {
        source: "/api/v1/user/:path*",
        destination: `${K}/sys/:path*`,
        basePath: false,
      },
      {
        source: "/api/v1/proxy/:path*",
        destination: `${K}/sys/:path*`,
        basePath: false,
      },
      {
        source: "/knowledge-base/sync-from-doc-platform",
        destination: `${K}/knowledge-base/sync-from-doc-platform`,
        basePath: false,
      },
      {
        source: "/compat/oss/:path*",
        destination: `${K}/oss/:path*`,
        basePath: false,
      },
    ];
  },
  webpack(config) {
    config.module.rules.push({
      test: /\.svg$/,
      use: ["@svgr/webpack"],
    });
    return config;
  },
  swcMinify: false,
};

module.exports = nextConfig;
