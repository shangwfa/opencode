export const USER_ID_HEADER = "x-user-id"

export const PUBLIC_USER_ID = ""

const MAX_USER_ID_LENGTH = 128

export function normalizeUserId(input: unknown) {
  if (typeof input !== "string") return PUBLIC_USER_ID
  const trimmed = input.trim()
  if (!trimmed) return PUBLIC_USER_ID
  return trimmed.slice(0, MAX_USER_ID_LENGTH)
}

export function getRequestUserId(headers: Record<string, string | string[] | undefined>) {
  const raw = headers[USER_ID_HEADER]
  const first = Array.isArray(raw) ? raw[0] : raw
  return normalizeUserId(first)
}

export * as RequestUser from "./request-user"
