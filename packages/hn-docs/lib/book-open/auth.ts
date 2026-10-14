/**
 * Open API 鉴权(v2 后置,决策 #4)
 * 当前仅解析 Bearer 格式,不校验;鉴权接入后在此对接身份源。
 */
import type { NextApiRequest } from "next";
import { BookOpenError } from "./errors";
import type { BossIdentity } from "./types";

export function extractBearerToken(authorization?: string): string {
  if (!authorization) {
    throw new BookOpenError("UNAUTHORIZED", "缺少 Authorization Bearer Token");
  }
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]?.trim()) {
    throw new BookOpenError("UNAUTHORIZED", "Authorization 格式无效");
  }
  return match[1].trim();
}

export async function authenticateRequest(req: NextApiRequest): Promise<BossIdentity> {
  const header = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  // 决策 #4(鉴权后置):无 Token 放行(空身份);提供但格式错误才拒绝。
  // 鉴权接入后:此处校验 Token → 注入真实 caller 身份。
  if (!header) return { token: "", userUuid: "", roleCodeList: [] };
  return { token: extractBearerToken(header), userUuid: "", roleCodeList: [] };
}
