/**
 * Git Provider 抽象（P1：verify / listBranches；P2 再扩展建仓/PR/提交）。
 *
 * 术语中立：change（MR/PR）、number（iid）、url（web_url）、owner/repo。
 */
export type GitProviderType = "gitlab" | "github"

export type RepoRef = {
  /** owner/repo（GitLab 为 group/subgroup/repo） */
  path: string
  /** 规范化后的 web URL */
  url: string
}

export type Branch = {
  name: string
  isDefault: boolean
  isProtected: boolean
  url?: string
  lastCommit?: { shortId?: string; title?: string; committedAt?: string }
}

export type GitIdentity = {
  username: string
  name?: string
  email?: string
}

export type FileAction = {
  action: "create" | "update" | "delete"
  path: string
  content?: string
}

export type CreateRepoInput = {
  name: string
  /** GitHub org；GitLab 用作 namespace（可选） */
  owner?: string
  visibility?: "private" | "public"
  description?: string
  initReadme?: boolean
}

export type CommitInput = {
  message: string
  actions: FileAction[]
  /** GitLab：从该分支拉出新分支再提交 */
  startBranch?: string
}

export type ChangeInput = {
  title: string
  description?: string
}

export type ChangeResult = {
  number: number
  url: string
  state: string
}

export interface GitProviderClient {
  readonly type: GitProviderType
  verify(): Promise<GitIdentity>
  listBranches(repo: RepoRef): Promise<Branch[]>
  /** 基于 from 创建新分支 */
  createBranch(repo: RepoRef, name: string, from: string): Promise<{ name: string }>
  /** 可建仓的归属：GitHub org / GitLab group */
  listOwners(): Promise<Array<{ id: string; name: string }>>
  createRepo(input: CreateRepoInput): Promise<RepoRef>
  commitFiles(repo: RepoRef, branch: string, input: CommitInput): Promise<{ commitId?: string }>
  createChange(repo: RepoRef, source: string, target: string, input: ChangeInput): Promise<ChangeResult>
}

/**
 * 把各种形态的仓库地址归一为 owner/repo：
 *  - https://gitlab.com/group/sub/repo.git
 *  - git@gitlab.com:group/repo.git
 *  - https://gitlab.com/group/repo/-/tree/main
 *  - group/repo
 */
export function resolveRepo(input: string): { host?: string; path: string } {
  const value = input.trim()
  if (!value) return { path: "" }

  // scp 形式：git@host:path
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(value)
  let host: string | undefined
  let rest = value
  if (scp) {
    host = scp[1]
    rest = scp[2] ?? ""
  } else if (value.includes("://")) {
    try {
      const url = new URL(value)
      host = url.hostname
      rest = url.pathname.replace(/^\/+/, "")
    } catch {
      /* 交给下面处理 */
    }
  }

  // 去掉 GitLab 的 /-/... 段与 GitHub 的 /tree|blob|...
  rest = rest.split("/-/")[0] ?? rest
  rest = rest.replace(/\/(tree|blob|raw|commits)\/.*$/, "")
  rest = rest.replace(/\.git$/, "")
  rest = rest.replace(/^\/+|\/+$/g, "")

  return { host, path: rest }
}

export function repoWebUrl(providerType: GitProviderType, baseUrl: string, repo: RepoRef): string {
  return repo.url || `${baseUrl.replace(/\/+$/, "")}/${repo.path}`
}

/** 生成给沙箱用的 .netrc 行（token 不落前端） */
export function netrcLine(host: string, username: string, token: string): string {
  return `machine ${host} login ${username} password ${token}`
}

/** 两家的 git 凭据用户名约定 */
export function gitUsername(providerType: GitProviderType): string {
  return providerType === "github" ? "x-access-token" : "oauth2"
}
