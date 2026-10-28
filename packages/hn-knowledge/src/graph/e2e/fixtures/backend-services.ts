import type { CombinedExtraction } from '../../types.js'

export interface GraphAcceptanceFixture {
  id: string
  extraction: CombinedExtraction
}

/** 固定后端服务图谱：用于迁移验收，不调用 LLM。 */
export const BACKEND_SERVICE_FIXTURES: GraphAcceptanceFixture[] = [
  {
    id: 'doc-order-service',
    extraction: {
      entities: [
        { name: '订单服务', type: 'service', description: '处理订单创建和查询' },
        { name: '库存服务', type: 'service', description: '管理库存' },
        { name: '订单数据库', type: 'database', description: '存储订单数据' },
      ],
      triplets: [
        { source: '订单服务', relation: '调用', target: '库存服务', confidence: 0.95 },
        { source: '订单服务', relation: '使用', target: '订单数据库', confidence: 0.9 },
      ],
    },
  },
  {
    id: 'doc-inventory-service',
    extraction: {
      entities: [
        { name: '库存服务', type: 'service', description: '管理库存和库存变更' },
        { name: '库存数据库', type: 'database', description: '存储库存数据' },
        { name: '库存队列', type: 'message_queue', description: '传递库存变更消息' },
      ],
      triplets: [
        { source: '库存服务', relation: '使用', target: '库存数据库', confidence: 0.9 },
        { source: '库存服务', relation: '发布', target: '库存队列', confidence: 0.85 },
      ],
    },
  },
]

export const CONFLICT_FIXTURE: CombinedExtraction = {
  entities: [
    { name: '订单服务', type: 'service' },
    { name: '生产集群A', type: 'deployment' },
    { name: '生产集群B', type: 'deployment' },
  ],
  triplets: [
    {
      source: '订单服务',
      relation: '部署于',
      target: '生产集群A',
      confidence: 0.6,
      effectiveDate: '2024-01-01',
    },
    {
      source: '订单服务',
      relation: '部署于',
      target: '生产集群B',
      confidence: 0.95,
      effectiveDate: '2025-01-01',
    },
  ],
}
