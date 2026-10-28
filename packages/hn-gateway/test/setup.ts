/**
 * 测试环境装配：显式设置 env 后再动态导入 db 模块（bun test 静态导入会被提升）。
 * 默认连本地开发库，schema 用 hn_gateway_dev（与 package.json 的 test script 一致）。
 */
process.env.GATEWAY_DATABASE_URL ||= "postgresql://postgres:ab123456@127.0.0.1:5432/opencode-v2-up"
process.env.GATEWAY_DATABASE_SCHEMA ||= "hn_gateway_dev"
