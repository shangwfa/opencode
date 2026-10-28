/**
 * 运行时配置。
 * 约定与 hn-gateway 一致：数据库连接/模式由环境变量决定，本地开发回退到共享 PG。
 */
function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

export const env = {
  get databaseUrl(): string {
    return (
      readEnv("BASE_DATABASE_URL") ||
      readEnv("DATABASE_URL") ||
      readEnv("OPENCODE_DATABASE_URL") ||
      "postgres://postgres:ab123456@127.0.0.1:5432/opencode-v2-up"
    )
  },
  get databaseSchema(): string {
    return readEnv("BASE_DATABASE_SCHEMA") || "hn_base"
  },
  get port(): number {
    return Number(readEnv("BASE_PORT") || 3201)
  },
  get host(): string {
    return readEnv("BASE_HOST") || "0.0.0.0"
  },
  get authUrl(): string {
    return readEnv("BETTER_AUTH_URL") || `http://localhost:${Number(readEnv("BASE_PORT") || 3201)}`
  },
  /** 对外可达的基础服务地址；用于生成沙箱可访问的 Connector MCP URL。 */
  get publicBaseUrl(): string {
    return readEnv("BASE_PUBLIC_URL") || readEnv("PUBLIC_BASE_URL") || this.authUrl
  },
  get authSecret(): string {
    return readEnv("BETTER_AUTH_SECRET") || "dev-only-secret-change-me-in-production"
  },
  get webOrigin(): string {
    return readEnv("WEB_ORIGIN") || "http://localhost:3001"
  },
  get saasUrl(): string {
    return readEnv("OPENCODE_SAAS_URL") || "http://localhost:14096"
  },
  /** hn-knowledge 知识服务地址（知识库/检索/Wiki/图谱） */
  get knowledgeUrl(): string {
    return readEnv("KNOWLEDGE_URL") || "http://localhost:14200"
  },
  /** 文档前端的可信来源；与工作台共用基础服务登录态。 */
  get docsUrl(): string {
    return readEnv("HN_DOCS_URL") || "http://localhost:3004/yddoc"
  },
  get trustedOrigins(): string[] {
    return [...new Set([new URL(this.webOrigin).origin, new URL(this.docsUrl).origin])]
  },
  /** 仅服务间使用，不下发浏览器。 */
  get knowledgeServiceToken(): string {
    return readEnv("KNOWLEDGE_SERVICE_TOKEN") || ""
  },
  /** OAuth App 凭据；两者都配置才会启用对应 provider */
  get googleClientId(): string {
    return readEnv("GOOGLE_CLIENT_ID") ?? ""
  },
  get googleClientSecret(): string {
    return readEnv("GOOGLE_CLIENT_SECRET") ?? ""
  },
  get githubClientId(): string {
    return readEnv("GITHUB_CLIENT_ID") ?? ""
  },
  get githubClientSecret(): string {
    return readEnv("GITHUB_CLIENT_SECRET") ?? ""
  },
  /** Git 连接专用 OAuth 应用（与登录用的 OAuth App 分开，回调地址不同） */
  get gitGithubClientId(): string {
    return readEnv("GIT_GITHUB_CLIENT_ID") ?? ""
  },
  get gitGithubClientSecret(): string {
    return readEnv("GIT_GITHUB_CLIENT_SECRET") ?? ""
  },
  get gitGitlabClientId(): string {
    return readEnv("GIT_GITLAB_CLIENT_ID") ?? ""
  },
  get gitGitlabClientSecret(): string {
    return readEnv("GIT_GITLAB_CLIENT_SECRET") ?? ""
  },
  /** 测试用：覆盖 OAuth 端点（指向 mock 服务） */
  get gitOauthBase(): string {
    return readEnv("GIT_OAUTH_BASE") ?? ""
  },
  get saasPassword(): string {
    return readEnv("OPENCODE_PASSWORD") || ""
  },
}

export type Env = typeof env
