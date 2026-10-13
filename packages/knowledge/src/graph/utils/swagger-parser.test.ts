import { describe, expect, it } from 'bun:test'
import { parseSwaggerSpec } from './swagger-parser.js'

describe('parseSwaggerSpec', () => {
  it('解析 Swagger 2.0 的 body、参数和响应模型', () => {
    const operations = parseSwaggerSpec({
      swagger: '2.0',
      consumes: ['application/json'],
      produces: ['application/json'],
      definitions: {
        Request: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        Response: { type: 'object', properties: { ok: { type: 'boolean' } } },
      },
      paths: {
        '/tasks': {
          post: {
            operationId: 'createTask',
            summary: '创建任务',
            parameters: [
              { name: 'Authorization', in: 'header', required: true, type: 'string' },
              { name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/Request' } },
            ],
            responses: { '200': { description: '成功', schema: { $ref: '#/definitions/Response' } } },
          },
        },
      },
    })

    expect(operations).toHaveLength(1)
    expect(operations[0]).toMatchObject({
      method: 'POST',
      path: '/tasks',
      operationId: 'createTask',
      requestBody: expect.stringContaining('Request'),
      responses: [expect.stringContaining('Response')],
      schemas: ['Request', 'Response'],
    })
    expect(operations[0].parameters[0]).toMatchObject({ name: 'Authorization', location: 'header' })
  })
})
