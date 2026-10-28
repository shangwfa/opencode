/**
 * 云效（Yunxiao）流水线客户端：沿用原 @alicloud/devops20210625 SDK（行为零风险迁移），
 * 凭据全部走环境变量：GATEWAY_YUNXIAO_ORG_ID / GATEWAY_YUNXIAO_TOKEN /
 * GATEWAY_YUNXIAO_ACCESS_KEY_ID / GATEWAY_YUNXIAO_ACCESS_KEY_SECRET。
 */
import devops20210625, * as $devops20210625 from "@alicloud/devops20210625"
import * as $OpenApi from "@alicloud/openapi-client"
import * as $Util from "@alicloud/tea-util"

export function yunxiaoConfig(): { orgId: string; token: string; domain: string } {
  return {
    orgId: process.env["GATEWAY_YUNXIAO_ORG_ID"] || "",
    token: process.env["GATEWAY_YUNXIAO_TOKEN"] || "",
    domain: process.env["GATEWAY_YUNXIAO_DOMAIN"] || "openapi-rdc.aliyuncs.com",
  }
}

export function isYunxiaoConfigured(): boolean {
  const { orgId, token } = yunxiaoConfig()
  return Boolean(orgId && token)
}

function createClient(): devops20210625 {
  const config = new $OpenApi.Config({
    accessKeyId: process.env["GATEWAY_YUNXIAO_ACCESS_KEY_ID"],
    accessKeySecret: process.env["GATEWAY_YUNXIAO_ACCESS_KEY_SECRET"],
  })
  config.endpoint = "devops.cn-hangzhou.aliyuncs.com"
  return new devops20210625(config)
}

const runtime = new $Util.RuntimeOptions({})
const headers: Record<string, string> = {}

export async function listPipelines(pipelineName?: string) {
  const client = createClient()
  const request = new $devops20210625.ListPipelinesRequest({ pipelineName, maxResults: 10, nextToken: "aaaaaaaaaa" })
  const resp = await client.listPipelinesWithOptions(yunxiaoConfig().orgId, request, headers, runtime)
  return resp.body!.pipelines
}

export async function getPipeline(pipelineId: string) {
  const client = createClient()
  const resp = await client.getPipelineWithOptions(yunxiaoConfig().orgId, pipelineId, headers, runtime)
  return resp.body!.pipeline
}

export async function startPipeline(pipelineId: string, params: Record<string, unknown>): Promise<number> {
  const client = createClient()
  const request = new $devops20210625.StartPipelineRunRequest({ params: JSON.stringify({ envs: params }) })
  const resp = await client.startPipelineRunWithOptions(yunxiaoConfig().orgId, pipelineId, request, headers, runtime)
  return Number(resp.body!.pipelineRunId)
}

export async function getPipelineRun(pipelineId: string, runId: string) {
  const client = createClient()
  const resp = await client.getPipelineRunWithOptions(yunxiaoConfig().orgId, pipelineId, runId, headers, runtime)
  return resp.body!.pipelineRun
}

export async function getPipelineJobLog(pipelineId: string, runId: string, jobId: string) {
  const client = createClient()
  const resp = await client.logPipelineJobRunWithOptions(yunxiaoConfig().orgId, pipelineId, jobId, runId, headers, runtime)
  return resp.body!.log
}

export async function retryPipelineJob(pipelineId: string, runId: string, jobId: string) {
  const client = createClient()
  const resp = await client.retryPipelineJobRun(yunxiaoConfig().orgId, pipelineId, runId, jobId)
  return resp.body!.log
}
