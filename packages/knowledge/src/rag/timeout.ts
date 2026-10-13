import { SearchTimeoutError } from './errors.js'

/**
 * 超时不仅要让调用方尽快返回，还要通过 AbortSignal 终止 embedding 等上游请求。
 */
export async function runSearchWithTimeout<T>(
  branch: 'keyword' | 'vector',
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new SearchTimeoutError(branch))
    }, timeoutMs)
  })

  try {
    return await Promise.race([operation(controller.signal), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

