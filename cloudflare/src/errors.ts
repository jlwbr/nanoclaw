export type AppErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'ENTITLEMENT_DENIED'
  | 'RUNTIME_FAILURE'
  | 'BILLING_FAILURE'
  | 'INTERNAL_ERROR'
  | 'CIRCUIT_OPEN';

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(params: {
    code: AppErrorCode;
    message: string;
    status: number;
    retryable: boolean;
    details?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = 'AppError';
    this.code = params.code;
    this.status = params.status;
    this.retryable = params.retryable;
    this.details = params.details;
  }
}

export function toErrorResponse(
  error: unknown,
  fallbackMessage = 'Internal server error',
): { status: number; body: Record<string, unknown> } {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          details: error.details ?? null,
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: fallbackMessage,
        retryable: true,
      },
    },
  };
}
