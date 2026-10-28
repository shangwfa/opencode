# 图能力固定验收

## 目的

这套验收用例用于判断 TypeScript 图实现是否满足迁移后的核心业务语义，不依赖实时 LLM。

## 运行

```bash
DATABASE_URL="postgresql://test:test123@localhost:5433/graph_test" \
npx vitest run src/graph/e2e/graph-acceptance.test.ts
```

完整图测试：

```bash
DATABASE_URL="postgresql://test:test123@localhost:5433/graph_test" \
npx vitest run src/graph/
```

## P0 验收项

| 用例 | 验收内容 |
| --- | --- |
| P0-1 | 固定服务文档能生成正确节点、边、方向和来源信息 |
| P0-2 | 重复导入不会增加重复节点和边，实体频率可以累计 |
| P0-3 | 关系检索支持按关系和主体过滤，不返回无关邻域事实或 `is_a` |
| P0-4 | 删除文档时删除独占节点，保留共享节点和其他文档关系 |
| P0-5 | 同一 functional 关系的旧事实被标记 `superseded`，默认检索只返回新事实 |

## Fixture

固定输入位于 `fixtures/backend-services.ts`，使用订单服务、库存服务、数据库和消息队列构成最小后端架构图。

验收测试直接使用固定 `CombinedExtraction`，不经过 LLM。因此测试失败时可以定位为图存储、构建、删除、检索或冲突处理问题，而不是模型输出波动。

## 与 Cognee 对照

对照时使用同一份 fixture，在 Cognee 和当前实现中分别执行：

1. 写入节点和关系
2. 重复写入
3. 删除一个文档
4. 执行关系查询
5. 执行事实冲突处理

比较业务结果，不比较内部 UUID、SQL 和时间戳：

- 节点名称和类型集合一致
- 关系方向和关系名称一致
- 重复写入后的节点、边数量一致
- 删除后的共享节点状态一致
- active/superseded 事实一致
- 查询返回的业务三元组集合一致

## 通过标准

P0 用例全部通过，才能认为核心图能力满足迁移预期。实时 LLM 场景属于 smoke test，不作为底层图功能的唯一验收依据。
