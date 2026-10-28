/**
 * /gw-api/pipelines：云效流水线（原 pipelines.controller/service 语义）。
 * GET /                列表（?pipelineName=）
 * GET /:pipelineId     详情
 * POST /:pipelineId    触发（body 作为 envs 参数）
 * GET /:pipelineId/run/:runId           运行详情
 * POST /:pipelineId/retry/:runId/:jobId 重试 job
 * GET /:pipelineId/log/:runId/:jobId    job 日志
 */
import { Hono } from "hono"
import {
  getPipeline,
  getPipelineJobLog,
  getPipelineRun,
  isYunxiaoConfigured,
  listPipelines,
  retryPipelineJob,
  startPipeline,
} from "../../integrations/yunxiao-client.js"

export const pipelinesApp = new Hono()

function notConfigured(c: { json: (body: unknown, status?: number) => Response }) {
  return c.json(
    { success: false, message: "云效未配置（GATEWAY_YUNXIAO_ORG_ID / GATEWAY_YUNXIAO_TOKEN / AK / SK）" },
    503,
  )
}

pipelinesApp.get("/", async (c) => {
  if (!isYunxiaoConfigured()) return notConfigured(c)
  const pipelineName = c.req.query("pipelineName") || undefined
  return c.json(await listPipelines(pipelineName))
})

pipelinesApp.get("/:pipelineId", async (c) => {
  if (!isYunxiaoConfigured()) return notConfigured(c)
  return c.json(await getPipeline(c.req.param("pipelineId")))
})

pipelinesApp.post("/:pipelineId", async (c) => {
  if (!isYunxiaoConfigured()) return notConfigured(c)
  const params = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const pipelineRunId = await startPipeline(c.req.param("pipelineId"), params)
  return c.json({ pipelineRunId })
})

pipelinesApp.get("/:pipelineId/run/:runId", async (c) => {
  if (!isYunxiaoConfigured()) return notConfigured(c)
  return c.json(await getPipelineRun(c.req.param("pipelineId"), c.req.param("runId")))
})

pipelinesApp.post("/:pipelineId/retry/:runId/:jobId", async (c) => {
  if (!isYunxiaoConfigured()) return notConfigured(c)
  return c.json(await retryPipelineJob(c.req.param("pipelineId"), c.req.param("runId"), c.req.param("jobId")))
})

pipelinesApp.get("/:pipelineId/log/:runId/:jobId", async (c) => {
  if (!isYunxiaoConfigured()) return notConfigured(c)
  return c.json(await getPipelineJobLog(c.req.param("pipelineId"), c.req.param("runId"), c.req.param("jobId")))
})
