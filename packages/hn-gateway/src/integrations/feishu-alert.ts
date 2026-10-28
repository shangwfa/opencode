/**
 * 飞书告警（原 services/alert 语义：msg_type=post 富文本，无节流，每次异常即发）。
 */
import { logger } from "../logger.js"

export interface FeishuAlertInput {
  webhook: string
  appName: string
  method: string
  targetUrl: string
  page: string
  traceId: string
  errorCode: string
  errorMsg: string
}

/** 原载荷结构：msg_type=post 富文本，title=`${appName}接口异常报告`，四行 text */
function buildPostPayload(input: FeishuAlertInput): unknown {
  return {
    msg_type: "post",
    content: {
      post: {
        zh_cn: {
          title: `${input.appName}接口异常报告`,
          content: [
            [
              { tag: "text", text: `异常信息:${input.errorCode}  ${input.errorMsg}\n` },
              { tag: "text", text: `接口地址:${input.method}-${input.targetUrl} \n` },
              { tag: "text", text: `接口发起页面:${input.page} \n` },
              { tag: "text", text: `traceId:${input.traceId} \n` },
            ],
          ],
        },
      },
    },
  }
}

export async function sendFeishuAlert(input: FeishuAlertInput): Promise<void> {
  try {
    const res = await fetch(input.webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPostPayload(input)),
      signal: AbortSignal.timeout(5_000),
    })
    logger.info({ span: "alert:feishu", msg: `飞书告警已发送: ${res.status}`, traceId: input.traceId })
  } catch (error) {
    logger.error({ span: "alert:feishu:error", msg: "飞书告警发送失败", error: String(error) })
  }
}
