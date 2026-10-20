/**
 * GitLab / GitHub 客户端（P1）。
 * 认证：GitLab `PRIVATE-TOKEN`；GitHub `Authorization: Bearer`。
 * token 只在服务端使用，绝不返回前端。
 */
import { errors } from "../errors.js"
import {
  resolveRepo,
  type Branch,
  type ChangeInput,
  type ChangeResult,
  type CommitInput,
  type CreateRepoInput,
  type GitIdentity,
  type GitProviderClient,
  type GitProviderType,
  type RepoRef,
} from "./types.js"

type Options = { baseUrl: string; apiBaseUrl?: string | null; token: string }

async function request(url: string, headers: Record<string, string>, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init?.body ? { "content-type": "application/json" } : {}) } })
  if (res.status === 401 || res.status === 403) {
    throw errors.invalid("Git 凭据无效或权限不足", "token")
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw errors.internal(`Git 服务返回 ${res.status}: ${text.slice(0, 160)}`)
  }
  return res.json()
}

export class GitLabClient implements GitProviderClient {
  readonly type: GitProviderType = "gitlab"
  private readonly api: string
  constructor(private readonly options: Options) {
    const base = (options.apiBaseUrl || `${options.baseUrl.replace(/\/+$/, "")}/api/v4`).replace(/\/+$/, "")
    this.api = base
  }

  private headers(): Record<string, string> {
    return { "PRIVATE-TOKEN": this.options.token, accept: "application/json" }
  }

  async verify(): Promise<GitIdentity> {
    const user = (await request(`${this.api}/user`, this.headers())) as { username?: string; name?: string; email?: string }
    return { username: user.username ?? "", name: user.name, email: user.email }
  }

  async listBranches(repo: RepoRef): Promise<Branch[]> {
    const project = encodeURIComponent(repo.path)
    const rows = (await request(`${this.api}/projects/${project}/repository/branches?per_page=100`, this.headers())) as Array<{
      name: string
      default?: boolean
      protected?: boolean
      web_url?: string
      commit?: { short_id?: string; title?: string; committed_date?: string }
    }>
    return rows.map((b) => ({
      name: b.name,
      isDefault: Boolean(b.default),
      isProtected: Boolean(b.protected),
      url: b.web_url,
      lastCommit: b.commit
        ? { shortId: b.commit.short_id, title: b.commit.title, committedAt: b.commit.committed_date }
        : undefined,
    }))
  }

  async createBranch(repo: RepoRef, name: string, from: string): Promise<{ name: string }> {
    const project = encodeURIComponent(repo.path)
    const created = (await request(`${this.api}/projects/${project}/repository/branches`, this.headers(), {
      method: "POST",
      body: JSON.stringify({ branch: name, ref: from }),
    })) as { name?: string }
    return { name: created.name ?? name }
  }

  async listOwners(): Promise<Array<{ id: string; name: string }>> {
    // min_access_level=30（Developer）：只列有写权限的 group
    const rows = (await request(`${this.api}/groups?min_access_level=30&per_page=100`, this.headers())) as Array<{
      full_path?: string
      name?: string
    }>
    return rows
      .filter((g) => typeof g.full_path === "string")
      .map((g) => ({ id: g.full_path!, name: g.full_path! }))
  }

  async createRepo(input: CreateRepoInput): Promise<RepoRef> {
    const body: Record<string, unknown> = {
      name: input.name,
      path: input.name,
      visibility: input.visibility ?? "private",
      initialize_with_readme: input.initReadme ?? true,
      ...(input.description ? { description: input.description } : {}),
      // owner 作为 namespace：可由调用方传 group path，GitLab 支持 URL 编码的命名空间路径
      ...(input.owner ? { namespace_path: input.owner } : {}),
    }
    const created = (await request(`${this.api}/projects`, this.headers(), {
      method: "POST",
      body: JSON.stringify(body),
    })) as { path_with_namespace?: string; web_url?: string }
    if (!created.path_with_namespace) throw errors.internal("GitLab 建仓响应缺少 path_with_namespace")
    return { path: created.path_with_namespace, url: created.web_url ?? "" }
  }

  async commitFiles(repo: RepoRef, branch: string, input: CommitInput): Promise<{ commitId?: string }> {
    const project = encodeURIComponent(repo.path)
    const body = {
      branch,
      commit_message: input.message,
      actions: input.actions.map((a) => ({
        action: a.action,
        file_path: a.path,
        ...(a.action === "delete" ? {} : { content: a.content ?? "" }),
      })),
      ...(input.startBranch ? { start_branch: input.startBranch } : {}),
    }
    const created = (await request(`${this.api}/projects/${project}/repository/commits`, this.headers(), {
      method: "POST",
      body: JSON.stringify(body),
    })) as { id?: string }
    return { commitId: created.id }
  }

  async createChange(repo: RepoRef, source: string, target: string, input: ChangeInput): Promise<ChangeResult> {
    const project = encodeURIComponent(repo.path)
    const created = (await request(`${this.api}/projects/${project}/merge_requests`, this.headers(), {
      method: "POST",
      body: JSON.stringify({
        source_branch: source,
        target_branch: target,
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
      }),
    })) as { iid?: number; web_url?: string; state?: string }
    if (!created.iid) throw errors.internal("GitLab 创建 MR 响应缺少 iid")
    return { number: created.iid, url: created.web_url ?? "", state: created.state ?? "opened" }
  }
}

export class GitHubClient implements GitProviderClient {
  readonly type: GitProviderType = "github"
  private readonly api: string
  constructor(private readonly options: Options) {
    const base = options.apiBaseUrl || (options.baseUrl.includes("github.com") ? "https://api.github.com" : `${options.baseUrl.replace(/\/+$/, "")}/api/v3`)
    this.api = base.replace(/\/+$/, "")
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "hn-base-server",
    }
  }

  async verify(): Promise<GitIdentity> {
    const user = (await request(`${this.api}/user`, this.headers())) as { login?: string; name?: string; email?: string }
    return { username: user.login ?? "", name: user.name ?? undefined, email: user.email ?? undefined }
  }

  async listBranches(repo: RepoRef): Promise<Branch[]> {
    const [owner, name] = repo.path.split("/")
    if (!owner || !name) throw errors.invalid("仓库地址格式应为 owner/repo", "repo")
    const rows = (await request(`${this.api}/repos/${owner}/${name}/branches?per_page=100`, this.headers())) as Array<{
      name: string
      protected?: boolean
      commit?: { sha?: string; url?: string }
    }>
    // GitHub 的分支接口不返回 default 标记，默认分支需另查仓库信息
    let defaultBranch: string | undefined
    try {
      const info = (await request(`${this.api}/repos/${owner}/${name}`, this.headers())) as { default_branch?: string }
      defaultBranch = info.default_branch
    } catch {
      /* 忽略：无法确定默认分支 */
    }
    return rows.map((b) => ({
      name: b.name,
      isDefault: b.name === defaultBranch,
      isProtected: Boolean(b.protected),
      lastCommit: b.commit?.sha ? { shortId: b.commit.sha.slice(0, 7) } : undefined,
    }))
  }

  async createBranch(repo: RepoRef, name: string, from: string): Promise<{ name: string }> {
    const [owner, name_] = repo.path.split("/")
    if (!owner || !name_) throw errors.invalid("仓库地址格式应为 owner/repo", "repo")
    // 先取基准分支的 sha，再创建 ref
    const ref = (await request(
      `${this.api}/repos/${owner}/${name_}/git/ref/heads/${encodeURIComponent(from)}`,
      this.headers(),
    )) as { object?: { sha?: string } }
    const sha = ref.object?.sha
    if (!sha) throw errors.invalid(`基准分支不存在：${from}`, "from")
    await request(`${this.api}/repos/${owner}/${name_}/git/refs`, this.headers(), {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${name}`, sha }),
    })
    return { name }
  }

  async listOwners(): Promise<Array<{ id: string; name: string }>> {
    // 需要 read:org scope；无权限时返回空（前端仍可选「个人账号」）
    try {
      const rows = (await request(`${this.api}/user/orgs?per_page=100`, this.headers())) as Array<{
        login?: string
        name?: string
      }>
      return rows
        .filter((o) => typeof o.login === "string")
        .map((o) => ({ id: o.login!, name: o.login! }))
    } catch {
      return []
    }
  }

  async createRepo(input: CreateRepoInput): Promise<RepoRef> {
    const url = input.owner ? `${this.api}/orgs/${input.owner}/repos` : `${this.api}/user/repos`
    const created = (await request(url, this.headers(), {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        private: (input.visibility ?? "private") === "private",
        auto_init: input.initReadme ?? true,
        ...(input.description ? { description: input.description } : {}),
      }),
    })) as { full_name?: string; html_url?: string }
    if (!created.full_name) throw errors.internal("GitHub 建仓响应缺少 full_name")
    return { path: created.full_name, url: created.html_url ?? "" }
  }

  /**
   * GitHub contents API 一次只能提交一个文件，因此按顺序逐个提交（每个文件一个 commit）。
   * 与 GitLab 的「一次多文件」语义不同，调用方需知悉。
   */
  async commitFiles(repo: RepoRef, branch: string, input: CommitInput): Promise<{ commitId?: string }> {
    const [owner, name] = repo.path.split("/")
    if (!owner || !name) throw errors.invalid("仓库地址格式应为 owner/repo", "repo")
    let lastSha: string | undefined
    for (const action of input.actions) {
      const contentUrl = `${this.api}/repos/${owner}/${name}/contents/${encodeURIComponent(action.path)}`
      let sha: string | undefined
      try {
        const existing = (await request(`${contentUrl}?ref=${encodeURIComponent(branch)}`, this.headers())) as { sha?: string }
        sha = existing.sha
      } catch {
        // 文件不存在（create）
      }
      if (action.action === "delete") {
        if (!sha) continue
        const deleted = (await request(contentUrl, this.headers(), {
          method: "DELETE",
          body: JSON.stringify({ message: input.message, sha, branch }),
        })) as { commit?: { sha?: string } }
        lastSha = deleted.commit?.sha
        continue
      }
      const payload: Record<string, unknown> = {
        message: input.message,
        content: Buffer.from(action.content ?? "", "utf8").toString("base64"),
        branch,
        ...(sha ? { sha } : {}),
      }
      const written = (await request(contentUrl, this.headers(), {
        method: "PUT",
        body: JSON.stringify(payload),
      })) as { commit?: { sha?: string } }
      lastSha = written.commit?.sha
    }
    return { commitId: lastSha }
  }

  async createChange(repo: RepoRef, source: string, target: string, input: ChangeInput): Promise<ChangeResult> {
    const [owner, name] = repo.path.split("/")
    if (!owner || !name) throw errors.invalid("仓库地址格式应为 owner/repo", "repo")
    const created = (await request(`${this.api}/repos/${owner}/${name}/pulls`, this.headers(), {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        head: source,
        base: target,
        ...(input.description ? { body: input.description } : {}),
      }),
    })) as { number?: number; html_url?: string; state?: string }
    if (!created.number) throw errors.internal("GitHub 创建 PR 响应缺少 number")
    return { number: created.number, url: created.html_url ?? "", state: created.state ?? "open" }
  }
}

export function createGitClient(type: GitProviderType, options: Options): GitProviderClient {
  return type === "gitlab" ? new GitLabClient(options) : new GitHubClient(options)
}

export { resolveRepo }
