import type { ApiRequest, ApiResult } from '@conduit/shared/app/desktop-bridge';
import type { ApiErrorBody } from '@conduit/shared/app/protocol';

const REQUEST_TIMEOUT_MS = 15_000;
const UNAVAILABLE: ApiErrorBody = { code: 'service_unavailable', message: 'The CONDUIT backend is not reachable yet.' };

function errorBody(json: unknown, status: number): ApiErrorBody {
  const error = (json as { error?: Partial<ApiErrorBody> } | null)?.error;
  if (error && typeof error.code === 'string' && typeof error.message === 'string') {
    return { code: error.code, message: error.message, ...(Array.isArray(error.issues) ? { issues: error.issues } : {}) } as ApiErrorBody;
  }
  return { code: status >= 500 ? 'internal_error' : 'bad_request', message: `Request failed (HTTP ${status})` };
}

/**
 * Calls the local backend on the renderer's behalf, attaching the per-launch local access key. The key stays in
 * the main process; responses are passed back without it.
 */
export class LocalApiClient {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly localKey: string,
    private readonly userAgent: string,
  ) {}

  async request(req: ApiRequest): Promise<ApiResult> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept: 'application/json',
      'X-CONDUIT-Local-Key': this.localKey,
    };
    if (req.body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(`${this.apiBaseUrl}${req.path}`, {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch {
      return { ok: false, status: 0, error: UNAVAILABLE };
    }
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) return { ok: false, status: res.status, error: errorBody(json, res.status) };
    return { ok: true, status: res.status, data: json };
  }
}
