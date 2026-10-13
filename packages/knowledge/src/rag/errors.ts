export class BaseKnowledgeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message)
    this.name = 'BaseKnowledgeError'
  }
}

export class SearchTimeoutError extends Error {
  constructor(readonly branch: 'keyword' | 'vector') {
    super(`${branch} search timed out`)
    this.name = 'SearchTimeoutError'
  }
}

export function toBaseKnowledgeError(error: unknown): BaseKnowledgeError {
  if (error instanceof BaseKnowledgeError) return error

  const message = error instanceof Error ? error.message : String(error)
  return new BaseKnowledgeError(message || 'Base knowledge operation failed', 500, 'BASE_KNOWLEDGE_ERROR')
}

