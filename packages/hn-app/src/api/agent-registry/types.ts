/**
 * Agent Registry API 类型定义
 *
 * 对应后端: @xybot-front-requirementCode-node/docs/apifox/agent-registry.openapi.json
 */

export interface AgentRegistryItem {
  /** 服务端生成的唯一标识（主键） */
  id?: string;
  /** agent 名称 */
  name: string;
  /** 原始 md 文件完整内容 */
  md_raw: string;
  /** md_raw 的 sha256 哈希 */
  md_hash: string;
  /** agent 来源：market=市场，project=项目自建 */
  source: string;
  /** 是否公开：1=公开，0=非公开（仅创建者可见） */
  is_public: number;
  /** 创建者 UUID */
  creator_uuid: string;
  /** 创建者昵称 */
  creator_nick_name: string;
  /** agent 一句话描述 */
  description: string;
  /** 创建时间 */
  created_at: string;
  /** 更新时间 */
  updated_at: string;
}

export interface CreateAgentRegistryBody {
  /** agent 唯一标识（主键） */
  name: string;
  /** 原始 md 文件完整内容 */
  md_raw: string;
  /** agent 来源：market=市场（默认），project=项目自建 */
  source?: string;
  /** 是否公开：true=公开（默认），false=非公开（仅创建者可见） */
  is_public?: boolean;
  /** 创建者 UUID */
  creator_uuid?: string;
  /** 创建者昵称 */
  creator_nick_name?: string;
  /** agent 一句话描述，用于列表页展示 */
  description?: string;
}

export interface UpdateAgentRegistryBody {
  /** 原始 md 文件完整内容 */
  md_raw: string;
  /** 是否公开 */
  is_public?: boolean;
  /** 创建者 UUID */
  creator_uuid?: string;
  /** 创建者昵称 */
  creator_nick_name?: string;
  /** agent 一句话描述 */
  description?: string;
}

export interface ListAgentRegistryParams {
  /** 关键词模糊匹配（name 或 md_raw） */
  keyword?: string;
  /** 创建者 UUID。传入后返回公开 agent + 该创建者的私有 agent */
  creator_uuid?: string;
  /** 按可见性过滤：true 仅返回公开，false 仅返回非公开 */
  is_public?: boolean;
  /** 按来源过滤：market / project */
  source?: string;
  /** 页码，从 1 开始，默认 1 */
  page?: number;
  /** 每页条数，默认 20，最大 100 */
  pageSize?: number;
}

/** 分页结果 */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type AgentRegistryListResult = PaginatedResult<AgentRegistryItem>;
