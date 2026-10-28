import type { ApiMethod } from '@conduit/shared/app/desktop-bridge';
import type { ApiErrorBody } from '@conduit/shared/app/protocol';
import { bridge } from './bridge';

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: ApiErrorBody['code'];
  readonly issues: NonNullable<ApiErrorBody['issues']>;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = body.code;
    this.issues = body.issues ?? [];
  }

  /** Message for one field, keyed by the first path segment. */
  fieldError(field: string): string | undefined {
    return this.issues.find((i) => i.path === field || i.path.startsWith(`${field}.`))?.message;
  }
}

/** Authenticated call to the backend through the main process. Throws ApiClientError on failure. */
export async function api<T>(method: ApiMethod, path: string, body?: unknown): Promise<T> {
  if (!bridge) throw new ApiClientError(0, { code: 'service_unavailable', message: 'Desktop bridge unavailable' });
  const result = await bridge.api.request<T>({ method, path, ...(body !== undefined ? { body } : {}) });
  if (!result.ok) throw new ApiClientError(result.status, result.error);
  return result.data;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  return err instanceof Error ? err.message : 'Something went wrong';
}
