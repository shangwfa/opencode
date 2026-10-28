/**
 * GitLab API v4 客户端（原 gitlab.service 语义：PRIVATE-TOKEN 认证的 GET/POST 封装）。
 * GATEWAY_GITLAB_API_URL / GATEWAY_GITLAB_TOKEN 由环境配置，不再硬编码。
 */
import { logger } from "../logger.js"

export function gitlabApiUrl(): string {
  return process.env["GATEWAY_GITLAB_API_URL"] || "https://gitlab.shadow-rpa.net/api/v4"
}

export function gitlabToken(): string | null {
  return process.env["GATEWAY_GITLAB_TOKEN"] ?? null
}

async function gitlabGet<T>(path: string): Promise<T> {
  const token = gitlabToken()
  if (!token) throw new Error("GATEWAY_GITLAB_TOKEN 未配置")
  const res = await fetch(`${gitlabApiUrl()}/${path}`, { headers: { "PRIVATE-TOKEN": token } })
  if (!res.ok) throw new Error(`GitLab ${res.status}: ${path}`)
  return (await res.json()) as T
}

/** 原 getNamespace：列出 namespace（前 100 条，对齐原 size 参数语义） */
export async function getNamespaces(): Promise<unknown> {
  return gitlabGet("namespaces?per_page=100")
}

/** 原 getBranches：项目分支列表 */
export async function getBranches(namespaceWithPath: string): Promise<unknown> {
  return gitlabGet(`projects/${encodeURIComponent(namespaceWithPath)}/repository/branches`)
}

/** 原 getMembers：项目成员列表（原实现走 groups 接口） */
export async function getMembers(namespaceWithPath: string): Promise<unknown> {
  return gitlabGet(`groups/${encodeURIComponent(namespaceWithPath)}/members?per_page=100`)
}

/** 原 queryProjectForMultiple：项目名查重（存在返回 true） */
export async function queryProjectForMultiple(name: string): Promise<boolean> {
  const projects = await gitlabGet<unknown[]>(`projects?search=${encodeURIComponent(name)}`)
  return projects.length > 0
}

export interface CreateProjectInput {
  name: string
  namespace_id: number
  description?: string
  createType: "create" | "exist"
}

/** 原 createProject：exist 模式返回已有结果；create 模式查重后建项目（private、master、初始 readme） */
export async function createProject(input: CreateProjectInput): Promise<string> {
  const exist = await queryProjectForMultiple(input.name)
  if (input.createType === "exist") return `${exist || ""}`
  if (exist) return ""
  const token = gitlabToken()
  if (!token) throw new Error("GATEWAY_GITLAB_TOKEN 未配置")
  const res = await fetch(`${gitlabApiUrl()}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", "PRIVATE-TOKEN": token },
    body: JSON.stringify({
      name: input.name,
      path: input.name,
      namespace_id: input.namespace_id,
      description: input.description ?? "",
      visibility: "private",
      initialize_with_readme: true,
      default_branch: "master",
    }),
  })
  if (!res.ok) throw new Error(`GitLab 建项目失败: HTTP ${res.status}`)
  const project = (await res.json()) as { ssh_url_to_repo: string }
  return project.ssh_url_to_repo
}

/** 原 npmCliForProject：appType=empty 跳过；否则本地脚手架 + git 初始化推送（原网关机器上的本地行为） */
export async function npmCliForProject(input: { appType: string; name: string; gitlab?: string }): Promise<boolean | undefined> {
  const { execSync } = await import("node:child_process")
  try {
    if (input.appType === "empty") return true
    execSync(`create-xybot-app appType=${input.appType} name=${input.name}`)
    const gitCommand = [
      `cd /app/${input.name}/ &&`,
      "git init &&",
      `git remote add origin ${input.gitlab} &&`,
      "git branch -M main &&",
      "git add . &&",
      'git config user.name "ruomu" &&',
      'git config user.email "ruo.mu@yingdao.com" &&',
      'git commit -m "init" &&',
      "git push -u origin main",
    ].join(" ")
    execSync(gitCommand)
    return true
  } catch (error) {
    console.error(error)
    return undefined
  }
}

/** report /code 路由使用：项目路径 → projectId → 文件原始内容 */
export async function getProjectId(projectPath: string): Promise<number> {
  const project = await gitlabGet<{ id: number }>(`projects/${encodeURIComponent(projectPath)}`)
  return project.id
}

export async function getRawFile(projectId: number, filePath: string, ref: string): Promise<string> {
  const token = gitlabToken()
  if (!token) throw new Error("GATEWAY_GITLAB_TOKEN 未配置")
  const res = await fetch(
    `${gitlabApiUrl()}/projects/${projectId}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${encodeURIComponent(ref)}`,
    { headers: { "PRIVATE-TOKEN": token } },
  )
  if (!res.ok) {
    logger.error({ span: "gitlab:rawfile:error", msg: `GitLab ${res.status}: ${filePath}@${ref}` })
  }
  return res.text()
}
