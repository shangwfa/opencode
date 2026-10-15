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
    return [
      {
        // basePath:false:浏览器相对路径 /api/doc-platform/**(无 /yddoc 前缀)直达 knowledge
        source: "/api/doc-platform/:path*",
        destination: `${KNOWLEDGE_INTERNAL_URL}/api/doc-platform/:path*`,
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
