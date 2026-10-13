import { describe, expect, it } from 'bun:test'
import { operationToText, parseOpenApiSpec } from './openapi-parser.js'

describe('OpenAPI 3 parser', () => {
  it('按接口拆分并读取参数、请求体、响应模型', () => {
    const operations = parseOpenApiSpec({
      openapi: '3.0.1',
      paths: {
        '/oapi/job/start': {
          post: {
            operationId: 'startJob',
            summary: '启动应用',
            parameters: [{ name: 'Authorization', in: 'header', required: true, schema: { type: 'string' } }],
            requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/StartReq' } } } },
            responses: {
              '200': { description: '成功', content: { 'application/json': { schema: { $ref: '#/components/schemas/StartResp' } } } },
            },
          },
        },
      },
      components: {
        schemas: {
          StartReq: { type: 'object', required: ['robotUuid'], properties: { robotUuid: { type: 'string', description: '应用 uuid' } } },
          StartResp: { type: 'object', properties: { jobUuid: { type: 'string' } } },
        },
      },
    })
    expect(operations).toHaveLength(1)
    expect(operations[0]).toMatchObject({
      method: 'POST', path: '/oapi/job/start', operationId: 'startJob',
      parameters: [{ name: 'Authorization', location: 'header', required: true }],
      schemas: ['StartReq', 'StartResp'],
    })
    const text = operationToText(operations[0])
    expect(text).toContain('robotUuid（string，必填）')
    expect(text).toContain('jobUuid')
  })
})
