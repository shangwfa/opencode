import { createHash } from 'node:crypto'
import type { OntologyConfig } from './index.js'

export type OntologyVersionStatus = 'draft' | 'published' | 'deprecated'

export interface OntologyVersion {
  ontologyId: string
  version: number
  contentHash: string
  status: OntologyVersionStatus
  config: OntologyConfig
  createdAt: string
  publishedAt?: string
}

/**
 * 不可变 ontology 快照注册表。
 * 生产环境可将同一接口接到 PostgreSQL；核心约束是 published 快照不原地修改。
 */
export class OntologyRegistry {
  private versions = new Map<string, OntologyVersion[]>()

  create(ontologyId: string, config: OntologyConfig): OntologyVersion {
    const history = this.versions.get(ontologyId) || []
    const snapshot = clone(config)
    const version: OntologyVersion = {
      ontologyId,
      version: history.length + 1,
      contentHash: hash(snapshot),
      status: 'draft',
      config: snapshot,
      createdAt: new Date().toISOString(),
    }
    this.versions.set(ontologyId, [...history, version])
    return clone(version)
  }

  publish(ontologyId: string, version: number): OntologyVersion {
    const history = this.requireHistory(ontologyId)
    const target = history.find((item) => item.version === version)
    if (!target) throw new Error(`ontology 版本不存在: ${ontologyId}@${version}`)
    const now = new Date().toISOString()
    const updated = history.map((item) => ({
      ...item,
      status: item.version === version ? 'published' : item.status === 'published' ? 'deprecated' : item.status,
      publishedAt: item.version === version ? now : item.publishedAt,
    } as OntologyVersion))
    this.versions.set(ontologyId, updated)
    return clone(updated.find((item) => item.version === version)!)
  }

  get(ontologyId: string, version: number): OntologyVersion | null {
    return clone(this.versions.get(ontologyId)?.find((item) => item.version === version) || null)
  }

  getActive(ontologyId: string): OntologyVersion | null {
    const history = this.versions.get(ontologyId) || []
    return clone([...history].reverse().find((item) => item.status === 'published') || null)
  }

  list(ontologyId: string): OntologyVersion[] {
    return clone(this.versions.get(ontologyId) || [])
  }

  private requireHistory(ontologyId: string): OntologyVersion[] {
    const history = this.versions.get(ontologyId)
    if (!history?.length) throw new Error(`ontology 不存在: ${ontologyId}`)
    return history
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function clone<T>(value: T): T {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)) as T
}
