export type BookOpenErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_ERROR"
  | "UPSTREAM_ERROR"
  | "CONFIG_ERROR"
  | "NOT_IMPLEMENTED"
  | "PARTIAL_SUCCESS";

const HTTP_STATUS_BY_CODE: Record<BookOpenErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION_ERROR: 422,
  UPSTREAM_ERROR: 502,
  CONFIG_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  PARTIAL_SUCCESS: 502,
};

export class BookOpenError extends Error {
  readonly code: BookOpenErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: BookOpenErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BookOpenError";
    this.code = code;
    this.status = HTTP_STATUS_BY_CODE[code];
    this.details = details;
  }
}

export function asBookOpenError(error: unknown): BookOpenError {
  if (error instanceof BookOpenError) return error;
  return new BookOpenError("UPSTREAM_ERROR", "上游服务调用失败");
}
