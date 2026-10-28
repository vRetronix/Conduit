import type { ApiErrorBody, ApiErrorCode } from '@conduit/shared';

export const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  bad_request: 400,
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  password_change_required: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  not_implemented: 501,
  not_configured: 503,
  internal_error: 500,
  service_unavailable: 503,
};

/** An error whose message is safe to show to API clients. Anything else becomes a generic 500. */
export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly options: { issues?: ApiErrorBody['issues']; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'AppError';
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }

  toBody(): ApiErrorBody {
    return { code: this.code, message: this.message, ...(this.options.issues ? { issues: this.options.issues } : {}) };
  }
}

export const unauthorized = () => new AppError('unauthorized', 'Authentication required');
/** Used for anything the caller may not know exists, so "missing" and "not yours" look identical. */
export const notFound = (what = 'Resource') => new AppError('not_found', `${what} not found`);
export const forbidden = (message = 'You do not have permission to do that') => new AppError('forbidden', message);
export const conflict = (message: string) => new AppError('conflict', message);
